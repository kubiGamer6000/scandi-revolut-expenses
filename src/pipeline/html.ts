import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  Report,
  ReportCategory,
  ReportMerchant,
  ReportTransaction,
} from "./aggregator.js";

/**
 * Stage 4. Render the structured report as a self-contained HTML file with
 * inline CSS — no external assets, no font imports, ~3 lines of JS for the
 * theme toggle. Drops in any browser, prints fine.
 *
 * Design language: dark-by-default with a light toggle, premium-feeling
 * surfaces, one indigo accent, big tabular numbers, generous whitespace,
 * everything expandable to its full transaction list with timestamps.
 */
export async function writeHtmlReport(
  filePath: string,
  report: Report,
): Promise<string> {
  const html = renderHtml(report);
  const abs = resolve(filePath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, html, "utf8");
  return abs;
}

export function renderHtml(report: Report): string {
  const { report_meta, totals, outgoing_by_category, incoming_by_source, declined } =
    report;

  const periodLabel =
    report_meta.period_start === report_meta.period_end
      ? formatDay(report_meta.period_start)
      : `${formatDay(report_meta.period_start)} → ${formatDay(report_meta.period_end)}`;

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Revolut Expense Report — ${escapeHtml(periodLabel)}</title>
  <script>${THEME_PRELOAD}</script>
  <style>${STYLES}</style>
</head>
<body>
  <div class="page">
    <header class="head">
      <div class="head-left">
        <div class="eyebrow">
          <span class="dot"></span>
          Revolut Business · ${escapeHtml(report_meta.environment)}
        </div>
        <h1>Expense report</h1>
        <div class="period">
          <span>${escapeHtml(periodLabel)}</span>
          <span class="period-sep">·</span>
          <span class="tx-pill">${report_meta.transaction_count} transactions</span>
        </div>
      </div>
      <button class="theme-toggle" type="button" aria-label="Toggle theme" title="Toggle light/dark">
        <span class="theme-icon dark-only">☾</span>
        <span class="theme-icon light-only">☀</span>
      </button>
    </header>

    <section class="kpis">
      ${renderKpi("Outgoing", -totals.outgoing_eur, "out", currencyRows(totals.by_currency, "outgoing"))}
      ${renderKpi("Incoming", totals.incoming_eur, "in", currencyRows(totals.by_currency, "incoming"))}
      ${renderNetKpi(totals.net_eur, totals.fees_eur)}
    </section>

    <section class="block">
      <h2>Outgoing by category</h2>
      ${outgoing_by_category.map(renderCategory).join("\n")}
    </section>

    <section class="block">
      <h2>Incoming <span class="count">${incoming_by_source.length} source${incoming_by_source.length === 1 ? "" : "s"} · ${eur(totals.incoming_eur)}</span></h2>
      ${renderIncoming(incoming_by_source)}
    </section>

    <section class="block muted">
      <h2>Declined attempts <span class="count">${declined.tx_count} attempt${declined.tx_count === 1 ? "" : "s"} · ${eur(declined.attempted_total_eur)}</span></h2>
      ${renderDeclined(declined.by_merchant)}
    </section>

    <footer>
      Edit <code>data/merchants.json</code> to fix any miscategorisation and re-run.
    </footer>
  </div>

  <script>${THEME_SCRIPT}</script>
</body>
</html>`;
}

// ---------- KPI cards ----------

function renderKpi(
  label: string,
  amount: number,
  variant: "out" | "in",
  rows: CurrencyRow[],
): string {
  const cls = variant === "out" ? "kpi kpi-out" : "kpi kpi-in";
  const valCls = variant === "out" ? "kpi-value neg" : "kpi-value pos";
  const ccyCount = rows.length;
  const summary =
    ccyCount === 0
      ? "No movement"
      : ccyCount === 1
        ? `${ccyCount} currency`
        : `${ccyCount} currencies`;
  return `
    <div class="${cls}">
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="${valCls}">${eur(amount)}</div>
      ${
        ccyCount === 0
          ? `<div class="ccy-toggle disabled">${summary}</div>`
          : `<details class="ccy-details">
        <summary class="ccy-toggle">
          <span class="caret">▸</span>
          <span>${summary}</span>
        </summary>
        ${renderCurrencyRows(rows, variant)}
      </details>`
      }
    </div>`;
}

function renderNetKpi(net: number, fees: number): string {
  const valCls = `kpi-value ${net < 0 ? "neg" : "pos"}`;
  return `
    <div class="kpi kpi-net">
      <div class="kpi-label">Net</div>
      <div class="${valCls}">${eur(net)}</div>
      <div class="kpi-foot-inline">
        <span class="net-sub">Fees ${eur(fees)}</span>
      </div>
    </div>`;
}

interface CurrencyRow {
  currency: string;
  native: number;
  eurAmount: number;
  share: number;
}

function currencyRows(
  byCcy: Report["totals"]["by_currency"],
  direction: "outgoing" | "incoming",
): CurrencyRow[] {
  const rows: CurrencyRow[] = [];
  let total = 0;
  for (const [ccy, b] of Object.entries(byCcy)) {
    const native = direction === "outgoing" ? b.outgoing_native : b.incoming_native;
    const eurAmount = direction === "outgoing" ? b.outgoing_eur : b.incoming_eur;
    if (native === 0) continue;
    rows.push({ currency: ccy, native, eurAmount, share: 0 });
    total += eurAmount;
  }
  for (const r of rows) r.share = total === 0 ? 0 : (r.eurAmount / total) * 100;
  return rows.sort((a, b) => b.eurAmount - a.eurAmount);
}

function renderCurrencyRows(
  rows: CurrencyRow[],
  variant: "out" | "in",
): string {
  if (rows.length === 0) return `<div class="ccy-empty">No movement</div>`;
  const sign = variant === "out" ? "−" : "+";
  return `
    <div class="ccy-grid">
      ${rows
        .map(
          (r) => `
        <div class="ccy-row">
          <span class="ccy-code">${escapeHtml(r.currency)}</span>
          <span class="ccy-native">${formatNumber(r.native)}</span>
          <span class="ccy-eur">${sign}€${formatNumber(r.eurAmount)}</span>
          <span class="ccy-share">${r.share.toFixed(0)}%</span>
        </div>`,
        )
        .join("")}
    </div>`;
}

// ---------- Categories / merchants ----------

function renderCategory(cat: ReportCategory): string {
  if (cat.tx_count === 0) {
    return `
      <div class="cat empty">
        <div class="cat-head">
          <span class="cat-name">${escapeHtml(cat.display_name)}</span>
          <span class="dim">€0.00</span>
        </div>
      </div>`;
  }

  return `
    <details class="cat" open>
      <summary class="cat-head">
        <span class="caret">▸</span>
        <span class="cat-name">${escapeHtml(cat.display_name)}</span>
        <span class="cat-amount">−${eur(cat.total_eur).replace(/^-/, "")}</span>
        <span class="cat-share">${cat.share_pct.toFixed(1)}%</span>
        <span class="cat-count">${cat.tx_count} tx</span>
      </summary>
      <div class="cat-body">
        ${cat.merchants.map((m) => renderMerchantBlock(m, "out")).join("\n")}
      </div>
    </details>`;
}

function renderMerchantBlock(m: ReportMerchant, variant: "out" | "in"): string {
  const sign = variant === "out" ? "−" : "+";
  const aliases = m.aliases_seen
    .filter((a) => a !== m.canonical_name)
    .slice(0, 2);
  const aliasHint =
    aliases.length > 0
      ? ` <span class="alias-inline">${aliases.map((a) => `<code>${escapeHtml(a)}</code>`).join(" ")}</span>`
      : "";

  return `
    <details class="m-block">
      <summary class="m-head">
        <span class="caret">▸</span>
        <span class="m-name">${escapeHtml(m.canonical_name)}${aliasHint}</span>
        <span class="m-amt ${variant}">${sign}€${formatNumber(m.total_eur)}</span>
        <span class="m-tx">${m.tx_count} tx</span>
      </summary>
      <div class="m-body">
        ${renderTxTable(m.transactions, variant)}
      </div>
    </details>`;
}

function renderTxTable(
  txs: ReportTransaction[],
  variant: "out" | "in",
): string {
  if (txs.length === 0) return "";
  const sign = variant === "out" ? "−" : "+";
  return `
    <table class="tx-table">
      <tbody>
        ${txs
          .map(
            (t) => `
          <tr>
            <td class="tx-when">${escapeHtml(t.display_at)}</td>
            <td class="tx-eur ${variant}">${sign}€${formatNumber(t.amount_eur)}</td>
            <td class="tx-native">${
              t.currency === "EUR"
                ? `<span class="dim">EUR</span>`
                : `${formatNumber(t.amount_native)} ${escapeHtml(t.currency)}`
            }</td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

function renderIncoming(rows: ReportMerchant[]): string {
  if (rows.length === 0) {
    return `<p class="dim">No incoming transactions in this period.</p>`;
  }
  return `<div class="merchant-list">${rows
    .map((m) => renderMerchantBlock(m, "in"))
    .join("\n")}</div>`;
}

function renderDeclined(
  rows: {
    canonical_name: string;
    tx_count: number;
    attempted_total_eur: number;
    transactions: ReportTransaction[];
  }[],
): string {
  if (rows.length === 0) {
    return `<p class="dim">No declined transactions. Nice.</p>`;
  }
  return `<div class="merchant-list">${rows
    .map(
      (r) => `
    <details class="m-block declined">
      <summary class="m-head">
        <span class="caret">▸</span>
        <span class="m-name">${escapeHtml(r.canonical_name)}</span>
        <span class="m-amt dim">€${formatNumber(r.attempted_total_eur)}</span>
        <span class="m-tx">${r.tx_count} attempt${r.tx_count === 1 ? "" : "s"}</span>
      </summary>
      <div class="m-body">
        ${renderTxTable(r.transactions, "out")}
      </div>
    </details>`,
    )
    .join("\n")}</div>`;
}

// ---------- formatting helpers ----------

function eur(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  return `${sign}€${formatNumber(abs)}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Period-header dates come in already EU-formatted (DD/MM/YYYY) from index.ts,
 * so we just pass them through. Anything that *isn't* EU-formatted (e.g. a
 * weird back-compat ISO from an older saved report) falls back to a sensible
 * en-GB representation.
 */
function formatDay(s: string): string {
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- theme toggle ----------

/**
 * Tiny preload runs in <head> before any paint, so light-mode users never
 * see a flash of dark. Reads localStorage; falls back to OS preference;
 * otherwise stays on the dark default already on the <html> tag.
 */
const THEME_PRELOAD = `
(function(){
  try {
    var KEY='revolut-report-theme';
    var saved=localStorage.getItem(KEY);
    if(saved==='light'||saved==='dark'){document.documentElement.dataset.theme=saved;return;}
    if(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches){
      document.documentElement.dataset.theme='light';
    }
  } catch(e) {}
})();
`;

const THEME_SCRIPT = `
(function(){
  var KEY='revolut-report-theme';
  document.querySelector('.theme-toggle').addEventListener('click',function(){
    var cur=document.documentElement.dataset.theme==='light'?'light':'dark';
    var next=cur==='light'?'dark':'light';
    document.documentElement.dataset.theme=next;
    try { localStorage.setItem(KEY,next); } catch(e) {}
  });
})();
`;

// ---------- styles ----------

const STYLES = `
:root, [data-theme="dark"] {
  --bg: #0A0A0F;
  --bg-elev: #11111A;
  --surface: #15151F;
  --surface-2: #1C1C28;
  --surface-hover: #20202E;
  --border: #26263A;
  --border-strong: #353550;
  --text: #F4F4F5;
  --text-muted: #A1A1AA;
  --text-dim: #71717A;
  --accent: #818CF8;
  --accent-strong: #6366F1;
  --accent-soft: rgba(129, 140, 248, 0.12);
  --pos: #34D399;
  --pos-soft: rgba(52, 211, 153, 0.10);
  --neg: #F87171;
  --neg-soft: rgba(248, 113, 113, 0.10);
  --warn: #FBBF24;
  --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.02);
  --radius: 12px;
  --radius-sm: 8px;
}
[data-theme="light"] {
  --bg: #FAFAF9;
  --bg-elev: #FFFFFF;
  --surface: #FFFFFF;
  --surface-2: #F4F4F5;
  --surface-hover: #EFEFF1;
  --border: #E4E4E7;
  --border-strong: #D4D4D8;
  --text: #18181B;
  --text-muted: #52525B;
  --text-dim: #A1A1AA;
  --accent: #4F46E5;
  --accent-strong: #4338CA;
  --accent-soft: rgba(79, 70, 229, 0.10);
  --pos: #15803D;
  --pos-soft: rgba(21, 128, 61, 0.10);
  --neg: #B91C1C;
  --neg-soft: rgba(185, 28, 28, 0.08);
  --warn: #B45309;
  --shadow: 0 1px 2px rgba(15,23,42,0.05), 0 0 0 1px rgba(15,23,42,0.03);
}

* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: "Inter", -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  font-size: 14px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-feature-settings: "ss01", "cv11";
}

.page {
  max-width: 1100px;
  margin: 0 auto;
  padding: 56px 32px 96px;
}

/* Header */
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 24px;
  margin-bottom: 40px;
}
.head-left { flex: 1; min-width: 0; }
.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 0.1em;
  font-weight: 500;
  background: var(--accent-soft);
  color: var(--accent);
  padding: 4px 10px;
  border-radius: 999px;
}
.eyebrow .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
}
.head h1 {
  font-size: 32px;
  font-weight: 600;
  margin: 14px 0 6px;
  letter-spacing: -0.02em;
}
.period {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--text-muted);
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  flex-wrap: wrap;
}
.period-sep { color: var(--text-dim); }
.tx-pill {
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 500;
}

.theme-toggle {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  width: 36px;
  height: 36px;
  cursor: pointer;
  color: var(--text-muted);
  font-size: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.theme-toggle:hover {
  background: var(--surface-hover);
  color: var(--accent);
  border-color: var(--accent);
}
.theme-icon { line-height: 1; }
[data-theme="dark"] .light-only { display: none; }
[data-theme="light"] .dark-only { display: none; }

/* KPI cards */
.kpis {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-bottom: 32px;
}
.kpi {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 24px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
}
.kpi-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-muted);
  font-weight: 600;
}
.kpi-value {
  font-size: 36px;
  font-weight: 600;
  margin: 10px 0 18px;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.025em;
  line-height: 1.1;
}
.kpi-value.neg { color: var(--neg); }
.kpi-value.pos { color: var(--pos); }

/* Currency breakdown inside KPI cards (collapsed by default) */
.ccy-details {
  margin-top: auto;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.ccy-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  list-style: none;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  font-weight: 500;
  user-select: none;
  padding: 2px 0;
  transition: color 0.12s;
}
.ccy-toggle:hover { color: var(--accent); }
.ccy-toggle::-webkit-details-marker { display: none; }
.ccy-toggle.disabled {
  cursor: default;
  color: var(--text-dim);
  border-top: 1px solid var(--border);
  padding-top: 12px;
  margin-top: auto;
  display: block;
}
.ccy-details[open] .ccy-toggle .caret { transform: rotate(90deg); }
.ccy-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 10px;
}
.ccy-row {
  display: grid;
  grid-template-columns: 44px auto 1fr auto;
  gap: 12px;
  align-items: center;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  padding: 3px 0;
}
.ccy-code {
  font-weight: 600;
  font-size: 10px;
  letter-spacing: 0.04em;
  background: var(--surface-2);
  padding: 2px 6px;
  border-radius: 4px;
  text-align: center;
}
.ccy-native { color: var(--text-muted); }
.ccy-eur { color: var(--text); font-weight: 500; text-align: right; }
.ccy-share {
  color: var(--text-dim);
  text-align: right;
  font-size: 11px;
  min-width: 32px;
}

.kpi-foot-inline {
  margin-top: auto;
  border-top: 1px solid var(--border);
  padding-top: 12px;
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.net-sub { color: var(--text-muted); }

/* Blocks / sections */
.block { margin-bottom: 40px; }
.block h2 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-muted);
  font-weight: 600;
  margin: 0 0 16px;
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.block h2 .count {
  text-transform: none;
  letter-spacing: 0;
  font-weight: 400;
  color: var(--text-dim);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.block.muted h2 { color: var(--text-dim); }

/* Categories */
.cat {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 10px;
  box-shadow: var(--shadow);
  overflow: hidden;
}
.cat.empty {
  opacity: 0.45;
  padding: 14px 20px;
}
.cat.empty .cat-head {
  padding: 0;
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.cat-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 16px 20px;
  cursor: pointer;
  list-style: none;
  user-select: none;
}
.cat-head::-webkit-details-marker { display: none; }
.cat[open] .cat-head { border-bottom: 1px solid var(--border); }
.cat[open] .cat-head .caret { transform: rotate(90deg); }
.cat-name {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.005em;
  flex: 1;         /* pushes everything after it to the right */
  min-width: 0;
}
.cat-amount {
  font-size: 15px;
  font-weight: 600;
  color: var(--neg);
  font-variant-numeric: tabular-nums;
}
.cat-share {
  color: var(--accent);
  font-weight: 500;
  font-size: 12px;
  background: var(--accent-soft);
  padding: 2px 8px;
  border-radius: 4px;
  font-variant-numeric: tabular-nums;
}
.cat-count {
  color: var(--text-dim);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.caret {
  display: inline-block;
  color: var(--text-dim);
  transition: transform 0.15s ease;
  font-size: 11px;
  width: 10px;
  flex-shrink: 0;
}
.cat-body { padding: 4px 10px 10px; }

/* Merchants (used by category, incoming, declined) */
.merchant-list {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 4px 10px;
  box-shadow: var(--shadow);
}
.m-block {
  border-radius: var(--radius-sm);
  margin: 2px 0;
  transition: background 0.12s;
}
.m-block:hover { background: var(--surface-hover); }
.m-block[open] { background: var(--surface-2); }
.m-block[open] .caret { transform: rotate(90deg); }
.m-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 9px 12px;
  cursor: pointer;
  list-style: none;
}
.m-head::-webkit-details-marker { display: none; }
.m-name {
  font-weight: 500;
  font-size: 13.5px;
  color: var(--text);
  flex: 1;         /* pushes amount + count to the right */
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.m-amt {
  font-weight: 600;
  font-size: 13.5px;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.m-amt.out { color: var(--neg); }
.m-amt.in { color: var(--pos); }
.m-amt.dim { color: var(--text-muted); font-weight: 500; }
.m-tx {
  color: var(--text-dim);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.alias-inline {
  font-size: 10px;
  color: var(--text-dim);
  margin-left: 6px;
  font-weight: 400;
}
.alias-inline code {
  background: var(--surface-2);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  color: var(--text-muted);
  border: 1px solid var(--border);
  margin-left: 2px;
}
.m-body { padding: 4px 12px 12px 30px; }

/* Tx table */
.tx-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.tx-table td {
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  font-variant-numeric: tabular-nums;
}
.tx-table tr:last-child td { border-bottom: 0; }
.tx-table tr:hover { background: var(--surface-hover); }
.tx-when { color: var(--text-muted); }
.tx-eur { font-weight: 500; text-align: right; white-space: nowrap; }
.tx-eur.out { color: var(--neg); }
.tx-eur.in { color: var(--pos); }
.tx-native { color: var(--text-dim); text-align: right; white-space: nowrap; }

.dim { color: var(--text-dim); }

footer {
  margin-top: 56px;
  padding-top: 20px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-dim);
  text-align: center;
}
footer code {
  background: var(--surface);
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 10px;
}

/* Responsive */
@media (max-width: 720px) {
  .head { flex-direction: column-reverse; align-items: flex-start; gap: 16px; }
  .kpis { grid-template-columns: 1fr; }
  .page { padding: 32px 16px 64px; }
  .head h1 { font-size: 26px; }
  .kpi-value { font-size: 30px; }
  .m-body { padding-left: 14px; }
}

@media print {
  body { background: white; }
  .kpi, .cat, .merchant-list { box-shadow: none; }
  .theme-toggle { display: none; }
  details { open: ""; }
  details .cat-body, details .m-body { display: block !important; }
  .ccy-details { display: none; }
}
`;
