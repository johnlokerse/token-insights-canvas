# Token Insights canvas

<img width="2806" height="2018" alt="token-insights-preview" src="https://github.com/user-attachments/assets/0a265ab8-44ff-42aa-8faf-7b5b26994983" />

A canvas extension for the GitHub Copilot app that shows a dashboard of your Copilot token usage:

- **Totals**: lifetime (since the earliest data available), current month, today, average per active day, peak day and top model.
- **Per-day line chart**: choose the date range (this month, 7/30/90 days, year to date, all, custom), the metrics to plot, per-day or cumulative values, a split by model, log scale, idle days, and UTC or local day boundaries.
- **Breakdowns**: token mix (uncached input, cache read, cache write, output) and usage per model.

Everything runs locally. Your usage data never leaves your machine.

## Install

Pick one of the following:

- **Copilot app**: run *Install extension* (or ask the agent to use `install_extension`) with
  `https://github.com/johnlokerse/token-insights-canvas/tree/main` and the name `token-insights`.
- **Manual**: clone into your user extensions folder, then reload extensions:

  ```sh
  git clone https://github.com/johnlokerse/token-insights-canvas ~/.copilot/extensions/token-insights
  ```

Then ask Copilot to open the **Token Insights** canvas.

## Data sources

| Source | Location | Covers | Accuracy |
| --- | --- | --- | --- |
| Per-request log | `~/.copilot/session-store.db` (`assistant_usage_events`) | Copilot CLI / app requests on this machine | Exact, per request |
| Session shutdown summaries | `~/.copilot/session-state/*/events.jsonl` | Older sessions on this machine | Approximate: a session's tokens land on the day it ended |
| GitHub AI usage report (optional) | CSV imported from the canvas or the `import_csv` action | All Copilot surfaces (IDE, web, CLI, …) | As reported by GitHub billing |

Days covered by an imported CSV replace local data for those days. The coverage strip under the chart shows which source each day came from.

### Importing the GitHub usage report

1. On GitHub, go to **Settings → Billing and licensing → AI usage** (or your org's billing page) and download the usage report as CSV. Each export covers at most 31 days.
2. In the canvas, click **Import CSV…** and select one or more CSV files.
3. If the report contains several users, set your GitHub username in the canvas so only your rows are counted. The extension also tries `gh api user`.

## Limitations

- GitHub provides no API for a person's lifetime token usage. "Lifetime" means since the earliest data the canvas can find.
- Local data only covers clients that write to `~/.copilot` on this machine. On a new machine the local history starts empty; copy `~/.copilot/session-store.db` and `~/.copilot/session-state/` to keep it.
- The CSV gives daily totals per model. It won't match local numbers exactly, especially for cache tokens.

## Agent actions

| Action | Purpose |
| --- | --- |
| `get_summary` | KPIs, per-day values for a view, and data coverage |
| `set_view` | Change range, metrics, mode, split by model, scale or timezone; open panels update live |
| `import_csv` | Import a usage report CSV from a local path |
| `refresh` | Re-read all sources |
