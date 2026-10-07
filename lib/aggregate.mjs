// Merges all sources into a per-day, per-model dataset.
// Priority per day: CSV import (all Copilot surfaces) > local per-request log > shutdown approximations.
import { addInto, emptyBucket, formatDayKey } from "./metrics.mjs";
import { listImports, readLocalUsage, readShutdownUsage } from "./sources.mjs";

function localDayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayKeyFn(timezone) {
    return timezone === "local" ? localDayKey : formatDayKey;
}

function addRecord(days, key, model, bucket, source) {
    const day = (days[key] ??= { models: {}, sources: new Set() });
    addInto((day.models[model] ??= emptyBucket()), bucket);
    day.sources.add(source);
}

let rawCache = null; // { at, local, shutdown, imports }

export async function loadRaw({ force = false, log } = {}) {
    if (rawCache && !force) return rawCache;
    const [local, shutdown, imports] = await Promise.all([readLocalUsage(log), readShutdownUsage(log), listImports()]);
    rawCache = { at: Date.now(), local, shutdown, imports };
    return rawCache;
}

export function invalidateRaw() {
    rawCache = null;
}

export function buildDataset(raw, { timezone = "utc" } = {}) {
    const keyOf = dayKeyFn(timezone);
    const days = {};

    // Local per-request log.
    const firstLocalTs = new Map();
    for (const r of raw.local.records) {
        const prev = firstLocalTs.get(r.sessionId);
        if (prev === undefined || r.ts < prev) firstLocalTs.set(r.sessionId, r.ts);
        addRecord(days, keyOf(r.ts), r.model, r.bucket, "local");
    }

    // Shutdown approximations, only for usage not already in the per-request log.
    for (const r of raw.shutdown.records) {
        const first = firstLocalTs.get(r.sessionId);
        if (first !== undefined && r.ts >= first) continue;
        addRecord(days, keyOf(r.ts), r.model, r.bucket, "approx");
    }

    // CSV imports replace whole days they cover (newest import wins per day).
    const csvDays = {};
    for (const imp of raw.imports) {
        const covered = new Set();
        for (let k = imp.coverage.from; k <= imp.coverage.to; k = formatDayKey(Date.parse(k) + 86400000)) covered.add(k);
        const perDay = {};
        for (const k of covered) perDay[k] = { models: {}, sources: new Set(["csv"]), importId: imp.id };
        for (const row of imp.rows) {
            const d = perDay[row.day];
            if (d) addInto((d.models[row.model] ??= emptyBucket()), row.bucket);
        }
        Object.assign(csvDays, perDay);
    }
    for (const [k, d] of Object.entries(csvDays)) {
        // Keep local-only metrics (reasoning / AI units) that the CSV does not report.
        const local = days[k];
        if (local) {
            for (const [model, b] of Object.entries(local.models)) {
                const target = (d.models[model] ??= emptyBucket());
                if (!target.reasoning) target.reasoning = b.reasoning;
                if (!target.aiu) target.aiu = b.aiu;
                if (!target.requests) target.requests = b.requests;
            }
        }
        days[k] = d;
    }

    const out = {};
    for (const [k, d] of Object.entries(days)) {
        const s = d.sources;
        const source = s.has("csv") ? "csv" : s.has("local") && s.has("approx") ? "mixed" : s.has("local") ? "local" : "approx";
        out[k] = { models: d.models, source };
    }

    const keys = Object.keys(out).sort();
    const localTs = raw.local.records.map((r) => r.ts);
    return {
        generatedAt: new Date().toISOString(),
        timezone,
        today: keyOf(Date.now()),
        days: out,
        coverage: {
            earliest: keys[0] ?? null,
            latest: keys.at(-1) ?? null,
            localFrom: localTs.length ? keyOf(Math.min(...localTs)) : null,
            localRequests: raw.local.records.length,
            sqliteBackend: raw.local.backend,
            sqliteError: raw.local.error ?? null,
            shutdownRecords: raw.shutdown.records.length,
            shutdownFiles: raw.shutdown.filesTotal ?? 0,
            imports: raw.imports.map((i) => ({
                id: i.id,
                fileName: i.fileName,
                importedAt: i.importedAt,
                username: i.username,
                from: i.coverage.from,
                to: i.coverage.to,
                rows: i.rows.length,
                warnings: i.warnings,
            })),
            daysBySource: keys.reduce((acc, k) => ((acc[out[k].source] = (acc[out[k].source] ?? 0) + 1), acc), {}),
        },
    };
}
