import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Transaction } from "../revolut/types.js";
import { formatTzTimestampEu } from "../utils/dates.js";
import type { CounterpartyTotal, ReportSummary } from "./summary.js";

export interface MarkdownOptions {
  periodLabel: string;
  fetched: number;
  fromIso: string;
  toIso: string;
  baseUrl: string;
  reportTz: string;
}

const RECENT_LIMIT = 30;

export async function writeMarkdownReport(
  filePath: string,
  transactions: Transaction[],
  summary: ReportSummary,
  opts: MarkdownOptions,
): Promise<string> {
  const md = renderMarkdown(transactions, summary, opts);
  const absolute = resolve(filePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, md, "utf8");
  return absolute;
}

export function renderMarkdown(
  transactions: Transaction[],
  summary: ReportSummary,
  opts: MarkdownOptions,
): string {
  const env = opts.baseUrl.includes("sandbox") ? "Sandbox" : "Production";

  const sections = [
    renderHeader(summary, opts, env),
    renderMoneyFlow(summary),
    renderBreakdowns(summary),
    renderTopParties(summary),
    renderRecent(transactions, opts.reportTz),
  ];

  return sections.filter(Boolean).join("\n\n") + "\n";
}

function renderHeader(
  summary: ReportSummary,
  opts: MarkdownOptions,
  env: string,
): string {
  return [
    "# Revolut Business — Transaction Report",
    "",
    `- **Period:** ${opts.periodLabel}`,
    `- **Window:** \`${opts.fromIso}\` → \`${opts.toIso}\``,
    `- **Environment:** ${env}`,
    `- **Time zone:** ${opts.reportTz} (all transaction times below)`,
    `- **Fetched:** ${opts.fetched} transactions · ${summary.count} after filters`,
    `- **Generated:** ${new Date().toISOString()}`,
  ].join("\n");
}

function renderMoneyFlow(summary: ReportSummary): string {
  const currencies = new Set<string>([
    ...Object.keys(summary.outgoingByCurrency),
    ...Object.keys(summary.incomingByCurrency),
    ...Object.keys(summary.netByCurrency),
    ...Object.keys(summary.feesByCurrency),
  ]);

  if (currencies.size === 0) return "## Money flow by currency\n\n_No completed transactions in this window._";

  const rows = [...currencies].sort().map((ccy) => {
    const out = summary.outgoingByCurrency[ccy] ?? 0;
    const inc = summary.incomingByCurrency[ccy] ?? 0;
    const net = summary.netByCurrency[ccy] ?? 0;
    const fee = summary.feesByCurrency[ccy] ?? 0;

    return `| **${ccy}** | ${out > 0 ? `-${fmt(out)}` : fmt(0)} | ${inc > 0 ? `+${fmt(inc)}` : fmt(0)} | ${signed(net)} | ${fee > 0 ? fmt(fee) : fmt(0)} |`;
  });

  return [
    "## Money flow by currency",
    "",
    "| Currency | Outgoing | Incoming | Net | Fees |",
    "|---|---:|---:|---:|---:|",
    ...rows,
  ].join("\n");
}

function renderBreakdowns(summary: ReportSummary): string {
  const types = sortByValueDesc(summary.byType)
    .map(([k, v]) => `| \`${k}\` | ${v} |`)
    .join("\n");
  const states = sortByValueDesc(summary.byState)
    .map(([k, v]) => `| \`${k}\` | ${v} |`)
    .join("\n");

  const typesBlock = types
    ? ["## By type", "", "| Type | Count |", "|---|---:|", types].join("\n")
    : "";
  const statesBlock = states
    ? ["## By state", "", "| State | Count |", "|---|---:|", states].join("\n")
    : "";

  return [typesBlock, statesBlock].filter(Boolean).join("\n\n");
}

function renderTopParties(summary: ReportSummary): string {
  const out = summary.topOutgoing.length
    ? renderPartyTable("## Top outgoing recipients", summary.topOutgoing, "out")
    : "";
  const inc = summary.topIncoming.length
    ? renderPartyTable("## Top incoming sources", summary.topIncoming, "in")
    : "";
  return [out, inc].filter(Boolean).join("\n\n");
}

function renderPartyTable(
  heading: string,
  rows: CounterpartyTotal[],
  direction: "out" | "in",
): string {
  const sign = direction === "out" ? "-" : "+";
  const body = rows
    .map((r, i) => {
      const totals = Object.entries(r.totalsByCurrency)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([ccy, amt]) => `${sign}${fmt(amt)} ${ccy}`)
        .join("<br>");
      return `| ${i + 1} | ${escape(r.name)} | ${r.txCount} | ${totals} |`;
    })
    .join("\n");

  return [heading, "", "| # | Party | Tx | Total |", "|---:|---|---:|---:|", body].join("\n");
}

function renderRecent(
  transactions: Transaction[],
  reportTz: string,
): string {
  if (transactions.length === 0) return "";

  const recent = transactions.slice(0, RECENT_LIMIT);
  const heading =
    transactions.length > RECENT_LIMIT
      ? `## Most recent (${RECENT_LIMIT} of ${transactions.length})`
      : `## Most recent (${recent.length})`;

  const rows = recent.map((tx) => {
    const leg = tx.legs[0];
    if (!leg) return "";
    // Always use `created_at` (auth time / when you tapped) and format it
    // in the report's tz. `completed_at` is the *settlement* timestamp on
    // card payments, which can be hours after the actual purchase and is
    // confusing to see in a daily report.
    const when = formatTzTimestampEu(new Date(tx.created_at), reportTz);
    const party =
      tx.merchant?.name ?? leg.description ?? tx.reference ?? `(${tx.type})`;
    const amount = `${signed(leg.amount)} ${leg.currency}`;
    return `| \`${when}\` | \`${tx.type}\` | \`${tx.state}\` | ${escape(party)} | ${amount} |`;
  });

  return [
    heading,
    "",
    "| When | Type | State | Party | Amount |",
    "|---|---|---|---|---:|",
    ...rows,
  ].join("\n");
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function signed(n: number): string {
  if (n > 0) return `+${fmt(n)}`;
  if (n < 0) return fmt(n); // already has the minus sign
  return fmt(0);
}

function sortByValueDesc(rec: Record<string, number>): [string, number][] {
  return Object.entries(rec).sort(([, a], [, b]) => b - a);
}

function escape(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
