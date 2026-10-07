import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { buildDataset, loadRaw } from "./lib/aggregate.mjs";
import { METRIC_KEYS, RANGE_KEYS, buildSeries, computeKpis, normalizeView } from "./lib/metrics.mjs";
import { importCsvFile } from "./lib/sources.mjs";
import { InsightsServer } from "./lib/server.mjs";

let session;
const log = (msg) => session?.log(msg, { level: "warning", ephemeral: true }).catch?.(() => {});
const server = new InsightsServer({ log: () => {} });
const openInstances = new Set();

const viewProps = {
    range: { type: "string", enum: RANGE_KEYS, description: "Date range shown in the chart." },
    from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Custom range start (YYYY-MM-DD); used when range is 'custom'." },
    to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Custom range end (YYYY-MM-DD); used when range is 'custom'." },
    metrics: { type: "array", items: { type: "string", enum: METRIC_KEYS }, minItems: 1, description: "Metrics to plot; the first also drives the KPI cards." },
    mode: { type: "string", enum: ["daily", "cumulative"], description: "Plot per-day values or a running total." },
    splitByModel: { type: "boolean", description: "Plot one line per model for the first metric." },
    logScale: { type: "boolean" },
    showZeroDays: { type: "boolean", description: "Include days without usage on the x-axis." },
    timezone: { type: "string", enum: ["utc", "local"], description: "Day boundary: UTC (matches GitHub billing) or local time." },
};
const viewSchema = { type: "object", properties: viewProps, additionalProperties: false };

async function summary(viewInput) {
    const settings = await server.getSettings();
    const view = normalizeView({ ...settings.view, ...(viewInput ?? {}) });
    const ds = buildDataset(await loadRaw(), { timezone: view.timezone });
    const k = computeKpis(ds, view.metrics[0]);
    const s = buildSeries(ds, { ...view, showZeroDays: true });
    const daily = s.x.map((day, i) => ({
        day,
        source: s.sources[i],
        ...Object.fromEntries(s.series.map((ser) => [ser.label, ser.values[i]])),
    }));
    return {
        view,
        today: ds.today,
        kpis: {
            metric: k.metric,
            lifetime: k.lifetime,
            lifetimeSince: k.lifetimeSince,
            thisMonth: k.month,
            today: k.today,
            activeDays: k.activeDays,
            avgPerActiveDay: Math.round(k.avgPerActiveDay),
            peak: k.peak,
            topModels: k.models.slice(0, 5),
            lifetimeTokenMix: k.breakdown,
        },
        range: { from: s.from, to: s.to },
        daily: daily.length > 120 ? daily.slice(-120) : daily,
        dailyTruncated: daily.length > 120,
        coverage: ds.coverage,
    };
}

const canvas = createCanvas({
    id: "token-insights",
    displayName: "Token Insights",
    description: "Dashboard of your Copilot token usage: lifetime and current-month totals plus a configurable per-day line chart.",
    inputSchema: viewSchema,
    actions: [
        {
            name: "get_summary",
            description: "Return KPIs (lifetime, this month, today, peak, top models), per-day values for the current view, and data coverage.",
            inputSchema: viewSchema,
            handler: async (ctx) => summary(ctx.input),
        },
        {
            name: "set_view",
            description: "Change the chart view (range, metrics, mode, split by model, scale, timezone). Persists and updates open panels.",
            inputSchema: viewSchema,
            handler: async (ctx) => ({ view: await server.setView(ctx.input ?? {}) }),
        },
        {
            name: "import_csv",
            description: "Import a GitHub AI usage report CSV (Billing → AI usage → Download report) from a local file path.",
            inputSchema: {
                type: "object",
                properties: { path: { type: "string", minLength: 1, description: "Absolute path to the CSV file." } },
                required: ["path"],
                additionalProperties: false,
            },
            handler: async (ctx) => {
                try {
                    const { username } = await server.getSettings();
                    const imp = await importCsvFile(ctx.input.path, { username });
                    await server.refresh();
                    return { id: imp.id, coverage: imp.coverage, rows: imp.rows.length, username: imp.username, warnings: imp.warnings };
                } catch (err) {
                    throw new CanvasError("import_failed", String(err?.message ?? err));
                }
            },
        },
        {
            name: "refresh",
            description: "Re-read all local usage sources and imported reports, then update open panels.",
            handler: async () => {
                await server.refresh();
                const ds = buildDataset(await loadRaw(), { timezone: (await server.getSettings()).view.timezone });
                return { refreshedAt: ds.generatedAt, coverage: ds.coverage };
            },
        },
    ],
    open: async (ctx) => {
        if (ctx.input && Object.keys(ctx.input).length) await server.setView(ctx.input);
        const url = await server.start();
        openInstances.add(ctx.instanceId);
        return { title: "Token Insights", url };
    },
    onClose: async (ctx) => {
        openInstances.delete(ctx.instanceId);
        if (!openInstances.size) await server.stop();
    },
});

session = await joinSession({ canvases: [canvas] });
server.log = log;
