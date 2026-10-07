// Pure, dependency-free helpers shared by the extension (Node) and the canvas UI (browser).
// Token model per usage bucket (all sources are normalized to this shape):
//   fresh      = uncached input tokens
//   cacheRead  = input tokens served from the prompt cache
//   cacheWrite = input tokens written to the prompt cache
//   output     = generated tokens (includes reasoning)
// "input" = fresh + cacheRead + cacheWrite, "total" = input + output.

export const METRICS = {
    total: { label: "Total tokens", get: (m) => m.fresh + m.cacheRead + m.cacheWrite + m.output },
    input: { label: "Input (all)", get: (m) => m.fresh + m.cacheRead + m.cacheWrite },
    fresh: { label: "Input (uncached)", get: (m) => m.fresh },
    cacheRead: { label: "Cache read", get: (m) => m.cacheRead },
    cacheWrite: { label: "Cache write", get: (m) => m.cacheWrite },
    output: { label: "Output", get: (m) => m.output },
    reasoning: { label: "Reasoning", get: (m) => m.reasoning },
    aiu: { label: "AI units (est.)", get: (m) => m.aiu },
    requests: { label: "Requests", get: (m) => m.requests },
};

export const METRIC_KEYS = Object.keys(METRICS);
export const RANGE_KEYS = ["month", "7d", "30d", "90d", "ytd", "all", "custom"];
export const RANGE_LABELS = {
    month: "This month",
    "7d": "Last 7 days",
    "30d": "Last 30 days",
    "90d": "Last 90 days",
    ytd: "Year to date",
    all: "All time",
    custom: "Custom",
};

export const DEFAULT_VIEW = {
    range: "all",
    from: null,
    to: null,
    metrics: ["total"],
    mode: "daily",
    splitByModel: false,
    logScale: false,
    showZeroDays: true,
    timezone: "utc",
};

export function emptyBucket() {
    return { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, aiu: 0, requests: 0 };
}

export function addInto(target, src) {
    for (const k of Object.keys(target)) target[k] += Number(src?.[k]) || 0;
    return target;
}

export function dayTotal(day) {
    const sum = emptyBucket();
    if (day) for (const m of Object.values(day.models)) addInto(sum, m);
    return sum;
}

export function metricValue(bucket, metric) {
    return (METRICS[metric] ?? METRICS.total).get(bucket);
}

export function normalizeView(v = {}) {
    const out = { ...DEFAULT_VIEW, ...v };
    if (!RANGE_KEYS.includes(out.range)) out.range = DEFAULT_VIEW.range;
    out.metrics = (Array.isArray(out.metrics) ? out.metrics : [out.metrics]).filter((m) => METRIC_KEYS.includes(m));
    if (!out.metrics.length) out.metrics = ["total"];
    if (out.mode !== "cumulative") out.mode = "daily";
    if (out.timezone !== "local") out.timezone = "utc";
    for (const k of ["splitByModel", "logScale", "showZeroDays"]) out[k] = Boolean(out[k]);
    const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
    out.from = isDay(out.from) ? out.from : null;
    out.to = isDay(out.to) ? out.to : null;
    return out;
}

// --- date helpers (YYYY-MM-DD keys; calendar arithmetic done in UTC to avoid DST drift) ---

export function parseDay(key) {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
}

export function formatDayKey(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(key, n) {
    return formatDayKey(parseDay(key) + n * 86400000);
}

export function dayRange(from, to) {
    const out = [];
    if (!from || !to || from > to) return out;
    for (let k = from; k <= to && out.length < 20000; k = addDays(k, 1)) out.push(k);
    return out;
}

export function resolveRange(view, dataset) {
    const today = dataset.today;
    const keys = Object.keys(dataset.days).sort();
    const first = keys[0] ?? today;
    switch (view.range) {
        case "month":
            return { from: today.slice(0, 8) + "01", to: today };
        case "7d":
            return { from: addDays(today, -6), to: today };
        case "30d":
            return { from: addDays(today, -29), to: today };
        case "90d":
            return { from: addDays(today, -89), to: today };
        case "ytd":
            return { from: today.slice(0, 4) + "-01-01", to: today };
        case "custom":
            return { from: view.from || first, to: view.to || today };
        case "all":
        default:
            return { from: first < today ? first : today, to: today };
    }
}

// --- KPIs ---

export function computeKpis(dataset, metric = "total") {
    const today = dataset.today;
    const monthPrefix = today.slice(0, 7);
    const keys = Object.keys(dataset.days).sort();
    let lifetime = 0;
    let month = 0;
    let todayValue = 0;
    let active = 0;
    let peak = null;
    const byModel = new Map();
    const breakdown = emptyBucket();
    const monthBreakdown = emptyBucket();

    for (const key of keys) {
        const day = dataset.days[key];
        const tot = dayTotal(day);
        const v = metricValue(tot, metric);
        lifetime += v;
        addInto(breakdown, tot);
        if (key.startsWith(monthPrefix)) {
            month += v;
            addInto(monthBreakdown, tot);
        }
        if (key === today) todayValue = v;
        if (v > 0) active++;
        if (!peak || v > peak.value) peak = { day: key, value: v };
        for (const [model, b] of Object.entries(day.models)) {
            byModel.set(model, (byModel.get(model) ?? 0) + metricValue(b, metric));
        }
    }

    const models = [...byModel.entries()]
        .filter(([, value]) => value > 0)
        .map(([model, value]) => ({ model, value }))
        .sort((a, b) => b.value - a.value);

    return {
        metric,
        metricLabel: (METRICS[metric] ?? METRICS.total).label,
        lifetime,
        lifetimeSince: keys[0] ?? null,
        month,
        monthLabel: monthPrefix,
        today: todayValue,
        activeDays: active,
        avgPerActiveDay: active ? lifetime / active : 0,
        peak: peak && peak.value > 0 ? peak : null,
        topModel: models[0] ?? null,
        models,
        breakdown,
        monthBreakdown,
    };
}

// --- chart series ---

const MAX_MODEL_SERIES = 8;

export function buildSeries(dataset, view) {
    const { from, to } = resolveRange(view, dataset);
    let x = dayRange(from, to);
    if (!view.showZeroDays) {
        x = x.filter((k) => {
            const d = dataset.days[k];
            return d && view.metrics.some((m) => metricValue(dayTotal(d), m) > 0);
        });
    }

    let series;
    if (view.splitByModel) {
        const metric = view.metrics[0] ?? "total";
        const totals = new Map();
        for (const k of x) {
            const d = dataset.days[k];
            if (!d) continue;
            for (const [model, b] of Object.entries(d.models)) {
                totals.set(model, (totals.get(model) ?? 0) + metricValue(b, metric));
            }
        }
        const ranked = [...totals.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
        const top = ranked.slice(0, MAX_MODEL_SERIES).map(([m]) => m);
        series = top.map((model) => ({
            key: `model:${model}`,
            label: model,
            metric,
            values: x.map((k) => {
                const b = dataset.days[k]?.models[model];
                return b ? metricValue(b, metric) : 0;
            }),
        }));
        if (ranked.length > MAX_MODEL_SERIES) {
            const topSet = new Set(top);
            series.push({
                key: "model:__other",
                label: "Other models",
                metric,
                values: x.map((k) => {
                    const d = dataset.days[k];
                    let s = 0;
                    if (d) for (const [model, b] of Object.entries(d.models)) if (!topSet.has(model)) s += metricValue(b, metric);
                    return s;
                }),
            });
        }
    } else {
        series = view.metrics.map((metric) => ({
            key: metric,
            label: (METRICS[metric] ?? METRICS.total).label,
            metric,
            values: x.map((k) => metricValue(dayTotal(dataset.days[k]), metric)),
        }));
    }

    if (view.mode === "cumulative") {
        for (const s of series) {
            let run = 0;
            s.values = s.values.map((v) => (run += v));
        }
    }

    return { from, to, x, sources: x.map((k) => dataset.days[k]?.source ?? null), series };
}

// --- formatting ---

export function formatCompact(n, digits = 1) {
    const abs = Math.abs(n);
    for (const [size, suffix] of [
        [1e12, "T"],
        [1e9, "B"],
        [1e6, "M"],
        [1e3, "K"],
    ]) {
        if (abs >= size) {
            const v = n / size;
            return `${v.toFixed(Math.abs(v) >= 100 ? 0 : digits).replace(/\.0+$/, "")}${suffix}`;
        }
    }
    return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

export function formatFull(n) {
    return Math.round(n).toLocaleString("en-US");
}
