// Readers for every usage source. Each reader returns normalized records:
//   { ts?: number (ms), day?: "YYYY-MM-DD" (UTC), model, sessionId?, bucket }
// where bucket follows the shape from metrics.mjs (fresh/cacheRead/cacheWrite/output/reasoning/aiu/requests).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), ".copilot");
export const SESSION_STORE_DB = join(COPILOT_HOME, "session-store.db");
export const SESSION_STATE_DIR = join(COPILOT_HOME, "session-state");
export const ARTIFACTS_DIR = join(COPILOT_HOME, "extensions", "token-insights", "artifacts");
export const IMPORTS_DIR = join(ARTIFACTS_DIR, "imports");
const SHUTDOWN_CACHE = join(ARTIFACTS_DIR, "shutdown-cache.json");
const SHUTDOWN_CACHE_VERSION = 2;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clamp0 = (v) => (v > 0 ? v : 0);

function execFileP(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024, timeout: 30000, ...opts }, (err, stdout, stderr) => {
            if (err) reject(Object.assign(err, { stderr }));
            else resolve(stdout);
        });
    });
}

// ---------------------------------------------------------------------------
// 1) Local per-request usage: ~/.copilot/session-store.db → assistant_usage_events
// ---------------------------------------------------------------------------

const USAGE_SQL = `SELECT session_id, model, input_tokens, output_tokens, cache_read_tokens,
    cache_write_tokens, reasoning_tokens, total_nano_aiu, created_at
    FROM assistant_usage_events`;

let sqliteBackend = null; // "node:sqlite" | "sqlite3-cli" | "unavailable"

async function queryNodeSqlite(sql) {
    const mod = await import("node:sqlite");
    const db = new mod.DatabaseSync(SESSION_STORE_DB, { readOnly: true });
    try {
        return db.prepare(sql).all();
    } finally {
        db.close();
    }
}

async function querySqliteCli(sql) {
    const bin = ["/usr/bin/sqlite3", "sqlite3"].find((p) => !p.startsWith("/") || existsSync(p));
    const out = await execFileP(bin, ["-readonly", "-json", SESSION_STORE_DB, sql]);
    return out.trim() ? JSON.parse(out) : [];
}

export async function readLocalUsage(log = () => {}) {
    if (!existsSync(SESSION_STORE_DB)) {
        sqliteBackend = "unavailable";
        return { records: [], backend: sqliteBackend, error: "session-store.db not found" };
    }
    let rows;
    const attempts = sqliteBackend === "sqlite3-cli" ? [querySqliteCli] : [queryNodeSqlite, querySqliteCli];
    let lastErr;
    for (const fn of attempts) {
        try {
            rows = await fn(USAGE_SQL);
            sqliteBackend = fn === queryNodeSqlite ? "node:sqlite" : "sqlite3-cli";
            break;
        } catch (err) {
            lastErr = err;
            log(`token-insights: ${fn.name} failed: ${err?.message ?? err}`);
        }
    }
    if (!rows) {
        sqliteBackend = "unavailable";
        return { records: [], backend: sqliteBackend, error: String(lastErr?.message ?? lastErr) };
    }

    const records = [];
    for (const r of rows) {
        const ts = Date.parse(r.created_at);
        if (!Number.isFinite(ts)) continue;
        const input = num(r.input_tokens);
        const cacheRead = num(r.cache_read_tokens);
        const cacheWrite = num(r.cache_write_tokens);
        records.push({
            ts,
            sessionId: r.session_id,
            model: r.model || "unknown",
            bucket: {
                // input_tokens already includes cache reads/writes.
                fresh: clamp0(input - cacheRead - cacheWrite),
                cacheRead,
                cacheWrite,
                output: num(r.output_tokens),
                reasoning: num(r.reasoning_tokens),
                aiu: num(r.total_nano_aiu) / 1e9,
                requests: 1,
            },
        });
    }
    return { records, backend: sqliteBackend };
}

// ---------------------------------------------------------------------------
// 2) Historical session.shutdown events: ~/.copilot/session-state/<id>/events.jsonl
// ---------------------------------------------------------------------------

function* findEventLines(buf, type) {
    const marker = Buffer.from(`{"type":"${type}"`);
    let idx = 0;
    while ((idx = buf.indexOf(marker, idx)) !== -1) {
        if (idx === 0 || buf[idx - 1] === 0x0a) {
            let end = buf.indexOf(0x0a, idx);
            if (end === -1) end = buf.length;
            try {
                yield JSON.parse(buf.subarray(idx, end).toString("utf8"));
            } catch {
                // Truncated/partial line; skip.
            }
            idx = end;
        } else {
            idx += marker.length;
        }
    }
}

function snapshotFromMetrics(modelMetrics) {
    const out = {};
    for (const [model, m] of Object.entries(modelMetrics || {})) {
        const u = m?.usage || {};
        const input = num(u.inputTokens);
        const cacheRead = num(u.cacheReadTokens);
        const cacheWrite = num(u.cacheWriteTokens);
        out[model] = {
            fresh: clamp0(input - cacheRead - cacheWrite),
            cacheRead,
            cacheWrite,
            output: num(u.outputTokens),
            reasoning: num(u.reasoningTokens),
            aiu: num(m?.totalNanoAiu) / 1e9,
            requests: num(m?.requests?.count),
        };
    }
    return out;
}

function versionAtLeast(v, [a, b, c]) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v || "");
    if (!m) return false;
    const [x, y, z] = m.slice(1).map(Number);
    return x !== a ? x > a : y !== b ? y > b : z >= c;
}

// Older CLIs (<= 1.0.64) report per-run usage on each shutdown; newer ones report cumulative
// usage across resumes. Prefer observed evidence, fall back to the version threshold.
function isCumulative(shutdowns, version) {
    const sameSnap = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (let i = 1; i < shutdowns.length; i++) {
        const prev = shutdowns[i - 1].snap;
        const cur = shutdowns[i].snap;
        const prevHas = Object.keys(prev).length > 0;
        const curHas = Object.keys(cur).length > 0;
        if (prevHas && !curHas) return false;
        if (prevHas && curHas && sameSnap(prev, cur)) return true;
        for (const [model, p] of Object.entries(prev)) {
            const c = cur[model];
            if (!c || c.requests < p.requests || c.output < p.output) return false;
        }
    }
    return versionAtLeast(version, [1, 0, 65]);
}

function sessionContributions(sessionId, shutdowns, version) {
    const out = [];
    if (!shutdowns.length) return out;
    const cumulative = isCumulative(shutdowns, version);
    let prev = {};
    for (const s of shutdowns) {
        for (const [model, cur] of Object.entries(s.snap)) {
            let delta = cur;
            if (cumulative && prev[model]) {
                const p = prev[model];
                const d = {};
                let reset = false;
                for (const k of Object.keys(cur)) {
                    d[k] = cur[k] - (p[k] || 0);
                    if (d[k] < 0) reset = true;
                }
                delta = reset ? cur : d;
            }
            if (Object.values(delta).some((v) => v > 0)) out.push({ ts: s.ts, sessionId, model, bucket: delta });
        }
        if (cumulative) prev = { ...prev, ...s.snap };
    }
    return out;
}

async function parseEventsFile(file) {
    const buf = await fsp.readFile(file);
    let version = null;
    let sessionId = null;
    for (const ev of findEventLines(buf, "session.start")) {
        version = ev?.data?.copilotVersion ?? version;
        sessionId = ev?.data?.sessionId ?? sessionId;
        break;
    }
    const shutdowns = [];
    for (const ev of findEventLines(buf, "session.shutdown")) {
        const ts = Date.parse(ev.timestamp);
        if (!Number.isFinite(ts)) continue;
        shutdowns.push({ ts, snap: snapshotFromMetrics(ev?.data?.modelMetrics) });
    }
    shutdowns.sort((a, b) => a.ts - b.ts);
    return { sessionId, version, shutdowns };
}

async function loadShutdownCache() {
    try {
        const c = JSON.parse(await fsp.readFile(SHUTDOWN_CACHE, "utf8"));
        if (c.version === SHUTDOWN_CACHE_VERSION) return c.files || {};
    } catch {
        // Missing or corrupt cache → rebuild.
    }
    return {};
}

export async function readShutdownUsage(log = () => {}) {
    let entries = [];
    try {
        entries = await fsp.readdir(SESSION_STATE_DIR, { withFileTypes: true });
    } catch {
        return { records: [], filesScanned: 0 };
    }
    const cache = await loadShutdownCache();
    const next = {};
    const records = [];
    let changed = false;
    let scanned = 0;

    const dirs = entries.filter((e) => e.isDirectory());
    const CONCURRENCY = 8;
    let i = 0;
    async function worker() {
        while (i < dirs.length) {
            const dir = dirs[i++];
            const file = join(SESSION_STATE_DIR, dir.name, "events.jsonl");
            let st;
            try {
                st = await fsp.stat(file);
            } catch {
                continue;
            }
            const key = `${st.size}:${Math.floor(st.mtimeMs)}`;
            let entry = cache[file];
            if (!entry || entry.key !== key) {
                try {
                    const parsed = await parseEventsFile(file);
                    const sid = parsed.sessionId || dir.name;
                    entry = { key, sessionId: sid, contributions: sessionContributions(sid, parsed.shutdowns, parsed.version) };
                    changed = true;
                    scanned++;
                } catch (err) {
                    log(`token-insights: failed to parse ${file}: ${err?.message ?? err}`);
                    continue;
                }
            }
            next[file] = entry;
            records.push(...entry.contributions);
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    if (changed || Object.keys(next).length !== Object.keys(cache).length) {
        await fsp.mkdir(ARTIFACTS_DIR, { recursive: true });
        await fsp.writeFile(SHUTDOWN_CACHE, JSON.stringify({ version: SHUTDOWN_CACHE_VERSION, files: next }));
    }
    return { records, filesScanned: scanned, filesTotal: Object.keys(next).length };
}

// ---------------------------------------------------------------------------
// 3) GitHub "AI usage report" CSV imports (Billing → AI usage → Download report)
// ---------------------------------------------------------------------------

export function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let q = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (q) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else q = false;
            } else field += ch;
        } else if (ch === '"') q = true;
        else if (ch === ",") {
            row.push(field);
            field = "";
        } else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && text[i + 1] === "\n") i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else field += ch;
    }
    if (field !== "" || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const HEADER_ALIASES = {
    date: ["date", "usage_date", "day"],
    model: ["model", "model_name"],
    username: ["username", "user", "user_login", "login"],
    input: ["input", "input_tokens"],
    output: ["output", "output_tokens"],
    cacheRead: ["cache_read", "cache_read_tokens"],
    cacheWrite: ["cache_write", "cache_write_tokens", "cache_creation"],
    quantity: ["quantity"],
    unitType: ["unit_type", "unit"],
    product: ["product"],
    sku: ["sku"],
};

function toDayKey(s) {
    const t = String(s || "").trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
    if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

let cachedGhLogin;
export async function detectGitHubLogin() {
    if (cachedGhLogin !== undefined) return cachedGhLogin;
    try {
        cachedGhLogin = (await execFileP("gh", ["api", "user", "--jq", ".login"], { timeout: 8000 })).trim() || null;
    } catch {
        cachedGhLogin = null;
    }
    return cachedGhLogin;
}

// Parses an AI usage report and returns a normalized import (not yet persisted).
export async function parseUsageReport(text, { fileName, username } = {}) {
    const table = parseCsv(text.replace(/^\uFEFF/, ""));
    if (table.length < 2) throw new Error("CSV has no data rows");
    const header = table[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
    const col = {};
    for (const [k, aliases] of Object.entries(HEADER_ALIASES)) col[k] = header.findIndex((h) => aliases.includes(h));
    if (col.date < 0) throw new Error("CSV is missing a 'date' column");
    if ([col.input, col.output, col.cacheRead, col.cacheWrite].every((i) => i < 0)) {
        throw new Error("CSV has no token columns (input/output/cache_read/cache_write). Token columns were added to the AI usage report on 2026-08-11.");
    }
    const get = (r, k) => (col[k] >= 0 ? r[col[k]] : undefined);
    const rows = table.slice(1);

    const usernames = [...new Set(rows.map((r) => (get(r, "username") || "").trim()).filter(Boolean))];
    let chosenUser = null;
    const warnings = [];
    if (usernames.length === 1) chosenUser = usernames[0];
    else if (usernames.length > 1) {
        const candidates = [username, await detectGitHubLogin()].filter(Boolean).map((u) => u.toLowerCase());
        chosenUser = usernames.find((u) => candidates.includes(u.toLowerCase())) ?? null;
        if (!chosenUser) warnings.push(`Report contains ${usernames.length} users and none matched your login; all rows were included.`);
    }

    // Some reports put all input (incl. cache) in "input"; others only the uncached portion.
    let inclusive = rows.length > 0;
    let sawCache = false;
    for (const r of rows) {
        const inp = num(get(r, "input"));
        const cr = num(get(r, "cacheRead"));
        const cw = num(get(r, "cacheWrite"));
        if (cr + cw > 0) {
            sawCache = true;
            if (inp < cr + cw) inclusive = false;
        }
    }
    inclusive = inclusive && sawCache;

    const out = [];
    let minDay = null;
    let maxDay = null;
    for (const r of rows) {
        const day = toDayKey(get(r, "date"));
        if (!day) continue;
        if (!minDay || day < minDay) minDay = day;
        if (!maxDay || day > maxDay) maxDay = day;
        if (chosenUser && (get(r, "username") || "").trim().toLowerCase() !== chosenUser.toLowerCase()) continue;
        const input = num(get(r, "input"));
        const cacheRead = num(get(r, "cacheRead"));
        const cacheWrite = num(get(r, "cacheWrite"));
        const unit = String(get(r, "unitType") || "").toLowerCase();
        const bucket = {
            fresh: inclusive ? clamp0(input - cacheRead - cacheWrite) : input,
            cacheRead,
            cacheWrite,
            output: num(get(r, "output")),
            reasoning: 0,
            aiu: 0,
            requests: unit.includes("request") ? num(get(r, "quantity")) : 0,
        };
        if (!Object.values(bucket).some((v) => v > 0)) continue;
        out.push({ day, model: (get(r, "model") || "unknown").trim() || "unknown", bucket });
    }
    if (!minDay) throw new Error("CSV contains no parseable dates");

    const id = createHash("sha256").update(text).digest("hex").slice(0, 16);
    return {
        id,
        fileName: fileName || "report.csv",
        importedAt: new Date().toISOString(),
        username: chosenUser,
        coverage: { from: minDay, to: maxDay },
        inputIncludesCache: inclusive,
        warnings,
        rows: out,
    };
}

export async function importCsvFile(path, opts = {}) {
    const text = await fsp.readFile(path, "utf8");
    return saveImport(await parseUsageReport(text, { ...opts, fileName: basename(path) }));
}

export async function saveImport(imp) {
    await fsp.mkdir(IMPORTS_DIR, { recursive: true });
    await fsp.writeFile(join(IMPORTS_DIR, `${imp.id}.json`), JSON.stringify(imp));
    return imp;
}

export async function listImports() {
    let files = [];
    try {
        files = (await fsp.readdir(IMPORTS_DIR)).filter((f) => f.endsWith(".json"));
    } catch {
        return [];
    }
    const out = [];
    for (const f of files) {
        try {
            out.push(JSON.parse(await fsp.readFile(join(IMPORTS_DIR, f), "utf8")));
        } catch {
            // Ignore unreadable import.
        }
    }
    return out.sort((a, b) => a.importedAt.localeCompare(b.importedAt));
}

export async function deleteImport(id) {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("invalid import id");
    await fsp.rm(join(IMPORTS_DIR, `${id}.json`), { force: true });
}
