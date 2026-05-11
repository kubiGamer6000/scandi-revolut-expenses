import chalk from "chalk";
import Table from "cli-table3";
import type { Transaction } from "../revolut/types.js";
import { formatTzTimestampEu } from "../utils/dates.js";
import type { ReportSummary } from "./summary.js";

interface PrintOptions {
  periodLabel: string;
  fetched: number;
  fromIso: string;
  toIso: string;
  reportTz: string;
}

export function printReport(
  transactions: Transaction[],
  summary: ReportSummary,
  opts: PrintOptions,
): void {
  console.log();
  console.log(chalk.bold.cyan("━━━ Revolut Business — Transaction Report ━━━"));
  console.log(chalk.dim(`Period:    ${opts.periodLabel}`));
  console.log(chalk.dim(`Window:    ${opts.fromIso}  →  ${opts.toIso}`));
  console.log(chalk.dim(`Time zone: ${opts.reportTz}`));
  console.log(
    chalk.dim(
      `Fetched ${opts.fetched} transactions · ${summary.count} after filters`,
    ),
  );
  console.log();

  printDirectionalTotals(summary);
  printBreakdownTables(summary);
  printTopParties(summary);
  printRecent(transactions, opts.reportTz);
}

function printDirectionalTotals(summary: ReportSummary): void {
  console.log(chalk.bold("Money flow by currency"));
  const t = new Table({
    head: ["Currency", "Outgoing", "Incoming", "Net", "Fees"].map((h) =>
      chalk.dim(h),
    ),
    colAligns: ["left", "right", "right", "right", "right"],
    style: { head: [], border: ["grey"] },
  });

  const currencies = new Set<string>([
    ...Object.keys(summary.outgoingByCurrency),
    ...Object.keys(summary.incomingByCurrency),
    ...Object.keys(summary.netByCurrency),
    ...Object.keys(summary.feesByCurrency),
  ]);

  for (const ccy of [...currencies].sort()) {
    const out = summary.outgoingByCurrency[ccy] ?? 0;
    const inc = summary.incomingByCurrency[ccy] ?? 0;
    const net = summary.netByCurrency[ccy] ?? 0;
    const fee = summary.feesByCurrency[ccy] ?? 0;

    t.push([
      chalk.bold(ccy),
      out > 0 ? chalk.red(`-${fmt(out)}`) : fmt(0),
      inc > 0 ? chalk.green(`+${fmt(inc)}`) : fmt(0),
      colorSigned(net),
      fee > 0 ? chalk.yellow(fmt(fee)) : fmt(0),
    ]);
  }

  console.log(t.toString());
  console.log();
}

function printBreakdownTables(summary: ReportSummary): void {
  const types = new Table({
    head: [chalk.dim("Type"), chalk.dim("Count")],
    colAligns: ["left", "right"],
    style: { head: [], border: ["grey"] },
  });
  for (const [type, count] of sortByValueDesc(summary.byType)) {
    types.push([type, String(count)]);
  }

  const states = new Table({
    head: [chalk.dim("State"), chalk.dim("Count")],
    colAligns: ["left", "right"],
    style: { head: [], border: ["grey"] },
  });
  for (const [state, count] of sortByValueDesc(summary.byState)) {
    states.push([state, String(count)]);
  }

  console.log(chalk.bold("By type"));
  console.log(types.toString());
  console.log();
  console.log(chalk.bold("By state"));
  console.log(states.toString());
  console.log();
}

function printTopParties(summary: ReportSummary): void {
  if (summary.topOutgoing.length > 0) {
    console.log(chalk.bold("Top outgoing recipients"));
    console.log(formatPartiesTable(summary.topOutgoing, "outgoing"));
    console.log();
  }
  if (summary.topIncoming.length > 0) {
    console.log(chalk.bold("Top incoming sources"));
    console.log(formatPartiesTable(summary.topIncoming, "incoming"));
    console.log();
  }
}

function formatPartiesTable(
  rows: ReportSummary["topOutgoing"],
  direction: "outgoing" | "incoming",
): string {
  const t = new Table({
    head: [chalk.dim("#"), chalk.dim("Party"), chalk.dim("Tx"), chalk.dim("Total")],
    colAligns: ["right", "left", "right", "right"],
    style: { head: [], border: ["grey"] },
    colWidths: [4, 50, 6, 30],
    wordWrap: true,
  });

  rows.forEach((row, i) => {
    const totals = Object.entries(row.totalsByCurrency)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ccy, amt]) => {
        const sign = direction === "outgoing" ? "-" : "+";
        const colored =
          direction === "outgoing"
            ? chalk.red(`${sign}${fmt(amt)} ${ccy}`)
            : chalk.green(`${sign}${fmt(amt)} ${ccy}`);
        return colored;
      })
      .join("\n");

    t.push([String(i + 1), row.name, String(row.txCount), totals]);
  });

  return t.toString();
}

function printRecent(transactions: Transaction[], reportTz: string): void {
  if (transactions.length === 0) return;
  const recent = transactions.slice(0, 20);

  console.log(chalk.bold(`Most recent (${recent.length} of ${transactions.length})`));
  const t = new Table({
    head: ["When", "Type", "State", "Party", "Amount"].map((h) => chalk.dim(h)),
    colAligns: ["left", "left", "left", "left", "right"],
    style: { head: [], border: ["grey"] },
    colWidths: [20, 14, 11, 40, 18],
    wordWrap: true,
  });

  for (const tx of recent) {
    const leg = tx.legs[0];
    if (!leg) continue;

    // `created_at` (auth time) formatted in reportTz — see markdown.ts comment.
    const when = formatTzTimestampEu(new Date(tx.created_at), reportTz);
    const party =
      tx.merchant?.name ??
      leg.description ??
      tx.reference ??
      tx.type;
    const amountStr = `${fmt(leg.amount)} ${leg.currency}`;
    const coloredAmount =
      leg.amount < 0
        ? chalk.red(amountStr)
        : leg.amount > 0
          ? chalk.green(amountStr)
          : amountStr;

    t.push([when, tx.type, tx.state, party, coloredAmount]);
  }

  console.log(t.toString());
  console.log();
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function colorSigned(n: number): string {
  if (n < 0) return chalk.red(fmt(n));
  if (n > 0) return chalk.green(`+${fmt(n)}`);
  return fmt(n);
}

function sortByValueDesc(rec: Record<string, number>): [string, number][] {
  return Object.entries(rec).sort(([, a], [, b]) => b - a);
}
