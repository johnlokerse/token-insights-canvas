// Single loopback HTTP server shared by all open Token Insights panels.
import { randomBytes } from "node:crypto";
import { promises as fsp, watch } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDataset, invalidateRaw, loadRaw } from "./aggregate.mjs";
import { normalizeView } from "./metrics.mjs";
import { ARTIFACTS_DIR, COPILOT_HOME, deleteImport, parseUsageReport, saveImport } from "./sources.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SETTINGS_FILE = join(ARTIFACTS_DIR, "settings.json");
const STATIC = {
    "/app.js": [join(ROOT, "web", "app.js"), "text/javascript"],
    "/styles.css": [join(ROOT, "web", "styles.css"), "text/css"],
    "/metrics.mjs": [join(ROOT, "lib", "metrics.mjs"), "text/javascript"],
};
const MAX_BODY = 50 * 1024 * 1024;

export class InsightsServer {
    constructor({ log }) {
        this.log = log;
        this.token = randomBytes(24).toString("hex");
        this.clients = new Set();
        this.server = null;
        this.url = null;
        this.watcher = null;
        this.debounce = null;
    }

    async start() {
        if (this.server) return this.url;
        this.server = createServer((req, res) => this.handle(req, res).catch((err) => this.fail(res, 500, err)));
        await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
        this.url = `http://127.0.0.1:${this.server.address().port}/`;
        this.watchStore();
        return this.url;
    }

    async stop() {
        this.watcher?.close();
        this.watcher = null;
        clearTimeout(this.debounce);
        for (const c of this.clients) c.end();
        this.clients.clear();
        if (this.server) await new Promise((r) => this.server.close(() => r()));
        this.server = null;
        this.url = null;
    }

    watchStore() {
        try {
            this.watcher = watch(COPILOT_HOME, (_evt, name) => {
                if (!name || !String(name).startsWith("session-store.db")) return;
                clearTimeout(this.debounce);
                this.debounce = setTimeout(() => this.refresh().catch(() => {}), 4000);
            });
        } catch (err) {
            this.log(`token-insights: file watch unavailable: ${err?.message ?? err}`);
        }
    }

    // --- settings / data ---

    async getSettings() {
        try {
            const s = JSON.parse(await fsp.readFile(SETTINGS_FILE, "utf8"));
            return { username: s.username ?? null, view: normalizeView(s.view) };
        } catch {
            return { username: null, view: normalizeView() };
        }
    }

    async saveSettings(patch) {
        const cur = await this.getSettings();
        const next = { ...cur, ...patch, view: normalizeView({ ...cur.view, ...(patch.view ?? {}) }) };
        await fsp.mkdir(ARTIFACTS_DIR, { recursive: true });
        await fsp.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2));
        return next;
    }

    async setView(partial) {
        const s = await this.saveSettings({ view: partial });
        this.broadcast("view", s.view);
        return s.view;
    }

    async dataset(timezone) {
        return buildDataset(await loadRaw({ log: this.log }), { timezone });
    }

    async refresh() {
        invalidateRaw();
        await loadRaw({ force: true, log: this.log });
        this.broadcast("data", { at: Date.now() });
    }

    async importCsvText(text, fileName) {
        const { username } = await this.getSettings();
        const imp = await saveImport(await parseUsageReport(text, { fileName, username }));
        await this.refresh();
        return imp;
    }

    broadcast(event, data) {
        const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const c of this.clients) c.write(msg);
    }

    // --- HTTP ---

    fail(res, code, err) {
        if (res.headersSent) return res.end();
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }

    json(res, data) {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(data));
    }

    async body(req) {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
            size += c.length;
            if (size > MAX_BODY) throw new Error("request body too large");
            chunks.push(c);
        }
        return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    }

    async handle(req, res) {
        const host = (req.headers.host || "").split(":")[0];
        if (host !== "127.0.0.1" && host !== "localhost") return this.fail(res, 403, "forbidden host");
        const url = new URL(req.url, "http://127.0.0.1");
        const path = url.pathname;

        if (req.method === "GET") {
            if (path === "/") {
                const html = (await fsp.readFile(join(ROOT, "web", "index.html"), "utf8")).replace("__TOKEN__", this.token);
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
                return res.end(html);
            }
            if (STATIC[path]) {
                const [file, type] = STATIC[path];
                res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
                return res.end(await fsp.readFile(file));
            }
            if (path === "/api/state") {
                const settings = await this.getSettings();
                const tz = url.searchParams.get("tz") || settings.view.timezone;
                return this.json(res, { settings, dataset: await this.dataset(tz === "local" ? "local" : "utc") });
            }
            if (path === "/events") {
                res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
                res.write(": connected\n\n");
                this.clients.add(res);
                const ping = setInterval(() => res.write(": ping\n\n"), 25000);
                req.on("close", () => {
                    clearInterval(ping);
                    this.clients.delete(res);
                });
                return;
            }
            return this.fail(res, 404, "not found");
        }

        if (req.method === "POST") {
            if (req.headers["x-canvas-token"] !== this.token) return this.fail(res, 403, "bad token");
            const body = await this.body(req);
            if (path === "/api/view") return this.json(res, await this.setView(body.view ?? {}));
            if (path === "/api/settings") {
                const username = typeof body.username === "string" && body.username.trim() ? body.username.trim() : null;
                return this.json(res, await this.saveSettings({ username }));
            }
            if (path === "/api/refresh") {
                await this.refresh();
                return this.json(res, { ok: true });
            }
            if (path === "/api/import") {
                if (typeof body.text !== "string") return this.fail(res, 400, "missing text");
                try {
                    const imp = await this.importCsvText(body.text, String(body.fileName || "report.csv"));
                    return this.json(res, { id: imp.id, coverage: imp.coverage, rows: imp.rows.length, username: imp.username, warnings: imp.warnings });
                } catch (err) {
                    return this.fail(res, 400, err);
                }
            }
            if (path === "/api/imports/delete") {
                await deleteImport(String(body.id || ""));
                await this.refresh();
                return this.json(res, { ok: true });
            }
            return this.fail(res, 404, "not found");
        }
        return this.fail(res, 405, "method not allowed");
    }
}
