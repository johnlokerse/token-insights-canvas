import {
    METRICS, METRIC_KEYS, RANGE_KEYS, RANGE_LABELS,
    buildSeries, computeKpis, formatCompact, formatFull, normalizeView, parseDay,
} from "/metrics.mjs";

const TOKEN = document.querySelector('meta[name="canvas-token"]').content;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const SVG_NS = "http://www.w3.org/2000/svg";

const PALETTE = [
    "var(--true-color-blue, #0969da)", "var(--true-color-orange, #bc4c00)", "var(--true-color-green, #1a7f37)",
    "var(--true-color-purple, #8250df)", "var(--true-color-red, #cf222e)", "var(--true-color-yellow, #9a6700)",
    "var(--true-color-pink, #bf3989)", "var(--true-color-teal, #1b7c83)", "var(--true-color-gray, #6e7781)",
];
const METRIC_COLOR = Object.fromEntries(METRIC_KEYS.map((k, i) => [k, PALETTE[i % PALETTE.length]]));
const SOURCE_LABEL = { csv: "GitHub report", local: "Local request log", mixed: "Local + estimate", approx: "Estimated" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let state = { settings: null, dataset: null };
let view = normalizeView();
let lastSeries = null;

async function post(path, body) {
    const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Canvas-Token": TOKEN },
        body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
}

async function load(tz) {
    const res = await fetch(`/api/state${tz ? `?tz=${tz}` : ""}`, { cache: "no-store" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    state = await res.json();
    view = normalizeView(state.settings.view);
    render();
}

let saveTimer;
function updateView(patch, { reload = false } = {}) {
    view = normalizeView({ ...view, ...patch });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => post("/api/view", { view }).catch(showError), 250);
    if (reload) load(view.timezone).catch(showError);
    else render();
}

function showBanner(html, kind = "") {
    const b = $("banner");
    b.className = `banner ${kind}`;
    b.innerHTML = html;
    b.hidden = !html;
}
function showError(err) {
    showBanner(esc(err?.message ?? err), "error");
}

const fmtDay = (key, withYear = true) => {
    const [y, m, d] = key.split("-").map(Number);
    return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ""}`;
};
const weekday = (key) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(parseDay(key)).getUTCDay()];

// ---------------------------------------------------------------------------

function render() {
    const ds = state.dataset;
    if (!ds) return;
    renderControls();
    renderKpis(ds);
    renderChart(ds);
    renderMix(ds);
    renderModels(ds);
    renderCoverage(ds);
    const since = ds.coverage.earliest;
    $("subtitle").textContent = since
        ? `Tracked since ${fmtDay(since)} · days in ${ds.timezone === "local" ? "local time" : "UTC"} · updated ${new Date(ds.generatedAt).toLocaleTimeString()}`
        : "No usage data found yet.";
}

function renderControls() {
    const range = $("range");
    if (!range.options.length) range.innerHTML = RANGE_KEYS.map((k) => `<option value="${k}">${RANGE_LABELS[k]}</option>`).join("");
    range.value = view.range;
    $("custom-range").hidden = view.range !== "custom";
    const ds = state.dataset;
    $("from").value = view.from || ds.coverage.earliest || "";
    $("to").value = view.to || ds.today;
    for (const b of document.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === view.mode));
    $("split").checked = view.splitByModel;
    $("log").checked = view.logScale;
    $("zeros").checked = view.showZeroDays;
    $("tz").value = view.timezone;
    $("metrics").innerHTML = METRIC_KEYS.map((k) => {
        const on = view.metrics.includes(k);
        return `<button type="button" class="chip" data-metric="${k}" aria-pressed="${on}" style="--c:${METRIC_COLOR[k]}"><i></i>${esc(METRICS[k].label)}</button>`;
    }).join("");
    if (document.activeElement !== $("username")) $("username").value = state.settings.username || "";
}

function kpiCard(label, value, sub, { hero = false, title = "" } = {}) {
    return `<div class="kpi${hero ? " hero" : ""}" title="${esc(title)}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${sub}</div></div>`;
}

function renderKpis(ds) {
    const metric = view.metrics[0] ?? "total";
    const k = computeKpis(ds, metric);
    const unit = metric === "requests" ? "requests" : metric === "aiu" ? "AI units" : "tokens";
    const [y, m] = k.monthLabel.split("-").map(Number);
    const cards = [
        kpiCard(`Lifetime · ${k.metricLabel}`, formatCompact(k.lifetime), k.lifetimeSince ? `since ${esc(fmtDay(k.lifetimeSince))}` : "no data", { hero: true, title: `${formatFull(k.lifetime)} ${unit}` }),
        kpiCard(`This month · ${MONTHS[m - 1]} ${y}`, formatCompact(k.month), `${esc(formatFull(k.month))} ${unit}`, { hero: true, title: `${formatFull(k.month)} ${unit}` }),
        kpiCard("Today", formatCompact(k.today), esc(fmtDay(ds.today)), { title: `${formatFull(k.today)} ${unit}` }),
        kpiCard("Avg per active day", formatCompact(k.avgPerActiveDay), `${k.activeDays} active days`, { title: `${formatFull(k.avgPerActiveDay)} ${unit}` }),
        kpiCard("Peak day", k.peak ? formatCompact(k.peak.value) : "–", k.peak ? `${weekday(k.peak.day)} ${esc(fmtDay(k.peak.day))}` : "", { title: k.peak ? `${formatFull(k.peak.value)} ${unit}` : "" }),
        kpiCard("Top model", k.topModel ? k.topModel.model : "–", k.topModel ? `${formatCompact(k.topModel.value)} · ${Math.round((k.topModel.value / (k.lifetime || 1)) * 100)}%` : "", { title: k.topModel?.model ?? "" }),
    ];
    $("kpis").innerHTML = cards.join("");
}

// ---------------------------------------------------------------------------
// SVG line chart

function svg(tag, attrs = {}, parent) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    parent?.appendChild(el);
    return el;
}

function niceTicks(max, count = 5) {
    if (max <= 0) return [0, 1];
    const raw = max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw);
    const ticks = [];
    for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
    if (ticks.at(-1) < max) ticks.push(ticks.at(-1) + step);
    return ticks;
}

function logTicks(min, max) {
    const ticks = [];
    for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) ticks.push(10 ** e);
    return ticks;
}

function renderChart(ds) {
    const el = $("chart");
    el.replaceChildren();
    const W = el.clientWidth || 800;
    const H = el.clientHeight || 340;
    el.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const s = buildSeries(ds, view);
    lastSeries = s;
    const pad = { l: 56, r: 14, t: 10, b: 38 };
    const iw = Math.max(10, W - pad.l - pad.r);
    const ih = Math.max(10, H - pad.t - pad.b);

    const colorFor = (ser, i) => (view.splitByModel ? PALETTE[i % PALETTE.length] : METRIC_COLOR[ser.metric]);
    $("legend").innerHTML = s.series.map((ser, i) => {
        const total = view.mode === "cumulative" ? ser.values.at(-1) ?? 0 : ser.values.reduce((a, b) => a + b, 0);
        return `<span style="--c:${colorFor(ser, i)}"><i></i>${esc(ser.label)} <span class="muted">${formatCompact(total)}</span></span>`;
    }).join("");

    if (!s.x.length || !s.series.length) {
        svg("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "empty" }, el).textContent = "No usage in this range";
        return;
    }

    const all = s.series.flatMap((x) => x.values);
    const maxV = Math.max(0, ...all);
    const positive = all.filter((v) => v > 0);
    const useLog = view.logScale && positive.length > 0;
    let yTicks, y;
    if (useLog) {
        const lo = 10 ** Math.floor(Math.log10(Math.min(...positive)));
        const hi = 10 ** Math.ceil(Math.log10(Math.max(...positive)));
        yTicks = logTicks(lo, hi);
        const a = Math.log10(lo), b = Math.log10(hi === lo ? hi * 10 : hi);
        y = (v) => pad.t + ih - ((Math.log10(Math.max(v, lo)) - a) / (b - a)) * ih;
    } else {
        yTicks = niceTicks(maxV);
        const top = yTicks.at(-1) || 1;
        y = (v) => pad.t + ih - (v / top) * ih;
    }
    const n = s.x.length;
    const x = (i) => pad.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);

    const grid = svg("g", { class: "grid axis" }, el);
    for (const t of yTicks) {
        const yy = y(t);
        svg("line", { x1: pad.l, x2: pad.l + iw, y1: yy, y2: yy }, grid);
        svg("text", { x: pad.l - 8, y: yy + 4, "text-anchor": "end" }, grid).textContent = formatCompact(t);
    }
    svg("line", { class: "baseline", x1: pad.l, x2: pad.l + iw, y1: pad.t + ih, y2: pad.t + ih }, el);

    // X labels: aim for ~1 label per 80px, prefer month starts when range is long.
    const xa = svg("g", { class: "axis" }, el);
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 80))));
    const spanYears = s.x[0].slice(0, 4) !== s.x.at(-1).slice(0, 4);
    s.x.forEach((key, i) => {
        if (i % every !== 0 && i !== n - 1) return;
        if (i === n - 1 && n > 1 && (n - 1) % every !== 0 && (n - 1) % every < every / 2) return;
        svg("text", { x: x(i), y: pad.t + ih + 16, "text-anchor": "middle" }, xa).textContent = fmtDay(key, spanYears);
    });

    // Coverage strip.
    const strip = svg("g", {}, el);
    const bw = n === 1 ? 8 : Math.max(1, iw / (n - 1));
    s.sources.forEach((src, i) => {
        if (!src) return;
        svg("rect", {
            x: x(i) - bw / 2, y: pad.t + ih + 24, width: Math.max(1, bw - (bw > 3 ? 1 : 0)), height: 5,
            fill: `var(--src-${src})`, opacity: 0.85,
        }, strip);
    });

    const g = svg("g", { class: "series" }, el);
    s.series.forEach((ser, si) => {
        const c = colorFor(ser, si);
        const pts = ser.values.map((v, i) => [x(i), y(v)]);
        const d = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
        if (s.series.length === 1) {
            svg("path", { class: "area", d: `${d}L${x(n - 1)},${pad.t + ih}L${x(0)},${pad.t + ih}Z`, fill: c }, g);
        }
        svg("path", { class: "line", d, stroke: c }, g);
        if (n <= 62) for (const [px, py] of pts) svg("circle", { cx: px, cy: py, r: n <= 31 ? 2.5 : 1.5, fill: c }, g);
    });

    // Hover.
    const hover = svg("g", { visibility: "hidden" }, el);
    const hl = svg("line", { class: "hover-line", y1: pad.t, y2: pad.t + ih }, hover);
    const dots = s.series.map((ser, si) => svg("circle", { r: 4, fill: colorFor(ser, si), stroke: "var(--bg)", "stroke-width": 2 }, hover));
    const hit = svg("rect", { x: pad.l, y: pad.t, width: iw, height: ih + 30, fill: "transparent" }, el);
    const tip = $("tooltip");
    const onMove = (ev) => {
        const rect = el.getBoundingClientRect();
        const mx = ((ev.clientX - rect.left) / rect.width) * W;
        const i = n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((mx - pad.l) / iw) * (n - 1))));
        hover.setAttribute("visibility", "visible");
        hl.setAttribute("x1", x(i));
        hl.setAttribute("x2", x(i));
        s.series.forEach((ser, si) => {
            dots[si].setAttribute("cx", x(i));
            dots[si].setAttribute("cy", y(ser.values[i]));
        });
        const key = s.x[i];
        const src = s.sources[i];
        const rows = s.series
            .map((ser, si) => ({ ser, si, v: ser.values[i] }))
            .sort((a, b) => b.v - a.v)
            .map(({ ser, si, v }) => `<div class="row"><span><i style="--c:${colorFor(ser, si)}"></i>${esc(ser.label)}</span><span title="${formatFull(v)}">${formatCompact(v, 2)}</span></div>`)
            .join("");
        tip.innerHTML = `<div class="t-head"><span>${weekday(key)} ${esc(fmtDay(key))}</span>${src ? `<span class="badge src-${src}">${SOURCE_LABEL[src]}</span>` : ""}</div>${rows}${view.mode === "cumulative" ? '<div class="muted">cumulative</div>' : ""}`;
        tip.hidden = false;
        const wrap = $("chart-wrap").getBoundingClientRect();
        const px = (x(i) / W) * rect.width;
        const tw = tip.offsetWidth;
        tip.style.left = `${px + 14 + tw > wrap.width ? px - tw - 14 : px + 14}px`;
        tip.style.top = `${Math.max(0, ev.clientY - wrap.top - 20)}px`;
    };
    hit.addEventListener("mousemove", onMove);
    hit.addEventListener("mouseleave", () => {
        hover.setAttribute("visibility", "hidden");
        tip.hidden = true;
    });
}

// ---------------------------------------------------------------------------

function bars(items, fmt = formatCompact) {
    const max = Math.max(1, ...items.map((i) => i.value));
    return `<div class="bars">${items.map((i) => `
        <span class="name" title="${esc(i.label)}">${esc(i.label)}</span>
        <div class="track"><div class="fill" style="width:${((i.value / max) * 100).toFixed(1)}%;--c:${i.color ?? "var(--accent)"}"></div></div>
        <span class="num" title="${formatFull(i.value)}">${fmt(i.value)}${i.share != null ? ` · ${i.share}%` : ""}</span>`).join("")}</div>`;
}

function renderMix(ds) {
    const k = computeKpis(ds, "total");
    const mk = (b) => {
        const total = b.fresh + b.cacheRead + b.cacheWrite + b.output || 1;
        return ["cacheRead", "cacheWrite", "fresh", "output"].map((key) => ({
            label: METRICS[key].label, value: b[key], color: METRIC_COLOR[key], share: Math.round((b[key] / total) * 1000) / 10,
        }));
    };
    $("mix").innerHTML = `<p class="muted" style="margin-bottom:6px">Lifetime</p>${bars(mk(k.breakdown))}
        <p class="muted" style="margin:12px 0 6px">This month</p>${bars(mk(k.monthBreakdown))}
        <p class="muted" style="margin-top:10px;font-size:12px">Reasoning (part of output): ${formatCompact(k.breakdown.reasoning)} · Requests: ${formatFull(k.breakdown.requests)} · AI units (est.): ${formatCompact(k.breakdown.aiu)}</p>`;
}

function renderModels(ds) {
    const metric = view.metrics[0] ?? "total";
    const s = lastSeries;
    const totals = new Map();
    for (const key of s?.x ?? []) {
        const d = ds.days[key];
        if (!d) continue;
        for (const [model, b] of Object.entries(d.models)) totals.set(model, (totals.get(model) ?? 0) + METRICS[metric].get(b));
    }
    const sum = [...totals.values()].reduce((a, b) => a + b, 0) || 1;
    const items = [...totals.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 12)
        .map(([label, value], i) => ({ label, value, color: PALETTE[i % PALETTE.length], share: Math.round((value / sum) * 1000) / 10 }));
    $("models").innerHTML = `<p class="muted" style="margin-bottom:6px">${esc(METRICS[metric].label)} · ${esc(RANGE_LABELS[view.range])}</p>${items.length ? bars(items) : '<p class="muted">No usage in this range.</p>'}`;
}

function renderCoverage(ds) {
    const c = ds.coverage;
    const src = c.daysBySource;
    const imports = c.imports.length
        ? `<table class="imports"><thead><tr><th>Report</th><th>Covers</th><th>User</th><th>Rows</th><th></th></tr></thead><tbody>${c.imports.map((i) => `
            <tr><td>${esc(i.fileName)}${i.warnings?.length ? ` <span class="warn" title="${esc(i.warnings.join(" "))}">⚠</span>` : ""}</td>
            <td>${esc(fmtDay(i.from))} – ${esc(fmtDay(i.to))}</td><td>${esc(i.username ?? "all")}</td><td>${i.rows}</td>
            <td><button type="button" data-delete-import="${esc(i.id)}">Remove</button></td></tr>`).join("")}</tbody></table>`
        : '<p class="muted">No GitHub usage reports imported yet.</p>';
    $("coverage").innerHTML = `
        <dl class="cov">
            <dt>Earliest data</dt><dd>${c.earliest ? esc(fmtDay(c.earliest)) : "–"}</dd>
            <dt>Local request log</dt><dd>${formatFull(c.localRequests)} requests since ${c.localFrom ? esc(fmtDay(c.localFrom)) : "–"} <span class="muted">(${esc(c.sqliteBackend)}${c.sqliteError ? `: ${esc(c.sqliteError)}` : ""})</span></dd>
            <dt>Session summaries</dt><dd>${formatFull(c.shutdownRecords)} estimates from ${formatFull(c.shutdownFiles)} session logs</dd>
            <dt>Days by source</dt><dd>${Object.entries(src).map(([k, v]) => `<span class="badge src-${k}">${SOURCE_LABEL[k]}</span> ${v}`).join(" &nbsp; ") || "–"}</dd>
        </dl>
        ${imports}
        <ul class="notes">
            <li>"Lifetime" means since the earliest data available on this machine or in imported reports — GitHub offers no API for usage since your subscription started.</li>
            <li>Local data only covers Copilot CLI / app sessions on this machine. IDE, github.com, and cloud agent usage appear only for days covered by an imported report.</li>
            <li>Days before ${c.localFrom ? esc(fmtDay(c.localFrom)) : "the request log"} are estimated from session shutdown summaries and are attributed to the day a session ended.</li>
        </ul>`;
}

// ---------------------------------------------------------------------------
// Events

$("range").addEventListener("change", (e) => updateView({ range: e.target.value }));
$("from").addEventListener("change", (e) => updateView({ from: e.target.value || null }));
$("to").addEventListener("change", (e) => updateView({ to: e.target.value || null }));
$("split").addEventListener("change", (e) => updateView({ splitByModel: e.target.checked }));
$("log").addEventListener("change", (e) => updateView({ logScale: e.target.checked }));
$("zeros").addEventListener("change", (e) => updateView({ showZeroDays: e.target.checked }));
$("tz").addEventListener("change", (e) => updateView({ timezone: e.target.value }, { reload: true }));
document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => updateView({ mode: b.dataset.mode })));
$("metrics").addEventListener("click", (e) => {
    const b = e.target.closest("[data-metric]");
    if (!b) return;
    const m = b.dataset.metric;
    let metrics;
    if (view.splitByModel || e.altKey) metrics = [m];
    else metrics = view.metrics.includes(m) ? view.metrics.filter((x) => x !== m) : [...view.metrics, m];
    updateView({ metrics: metrics.length ? metrics : [m] });
});
$("coverage").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-delete-import]");
    if (!b) return;
    b.disabled = true;
    try {
        await post("/api/imports/delete", { id: b.dataset.deleteImport });
    } catch (err) {
        showError(err);
    }
});
$("username").addEventListener("change", (e) => post("/api/settings", { username: e.target.value }).catch(showError));
$("btn-refresh").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
        await post("/api/refresh");
    } catch (err) {
        showError(err);
    } finally {
        e.target.disabled = false;
    }
});
$("btn-import").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    const msgs = [];
    for (const f of files) {
        try {
            const r = await post("/api/import", { fileName: f.name, text: await f.text() });
            msgs.push(`Imported <strong>${esc(f.name)}</strong>: ${esc(fmtDay(r.coverage.from))} – ${esc(fmtDay(r.coverage.to))}, ${r.rows} rows${r.username ? ` for ${esc(r.username)}` : ""}.${r.warnings.length ? ` <span class="warn">${esc(r.warnings.join(" "))}</span>` : ""}`);
        } catch (err) {
            msgs.push(`<span class="warn">Could not import ${esc(f.name)}: ${esc(err.message)}</span>`);
        }
    }
    showBanner(msgs.join("<br>"));
});

new ResizeObserver(() => state.dataset && renderChart(state.dataset)).observe($("chart-wrap"));

function connect() {
    const es = new EventSource("/events");
    es.addEventListener("data", () => load(view.timezone).catch(showError));
    es.addEventListener("view", (e) => {
        const next = normalizeView(JSON.parse(e.data));
        const tzChanged = next.timezone !== view.timezone;
        view = next;
        if (tzChanged) load(view.timezone).catch(showError);
        else render();
    });
    es.onerror = () => {
        es.close();
        setTimeout(connect, 3000);
    };
}

load().then(connect).catch(showError);
