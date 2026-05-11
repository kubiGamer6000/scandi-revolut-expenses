import chalk from "chalk";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { loadConfig } from "./config.js";
import {
  reportToCsv,
  reportToHtml,
  reportToMarkdown,
  resolvePeriod,
  runReport,
  type PeriodInput,
} from "./pipeline/run.js";
import { printReport } from "./reporting/console.js";
import { formatTzDate, toApiDate } from "./utils/dates.js";

interface CliOptions {
  day?: boolean;
  yesterday?: boolean;
  on?: string;
  week?: boolean;
  lastWeek?: boolean;
  from?: string;
  to?: string;
  account?: string;
  type?: string;
  currency?: string;
  /** Commander maps `--no-csv` to `csv: false` (defaults to true). */
  csv?: boolean;
  /** Commander maps `--no-console` to `console: false` (defaults to true). */
  console?: boolean;
  /** Commander maps `--no-md` to `md: false` (defaults to true). */
  md?: boolean;
  /** Run the LLM-categorized HTML pipeline. Off by default. */
  smart?: boolean;
  includePending?: boolean;
}

async function main(): Promise<void> {
  const program = new Command()
    .name("revolut-report")
    .description(
      "Daily/weekly Revolut Business transaction report (console + CSV + Markdown + smart HTML).",
    )
    .option("--day", "Today (00:00 → now)")
    .option("--yesterday", "Yesterday (full day)")
    .option(
      "--on <date>",
      "Single day (DD/MM/YYYY or YYYY-MM-DD), e.g. --on 05/05/2026",
    )
    .option("--week", "This week so far (Mon → now)")
    .option("--last-week", "Previous full week (Mon → Sun)")
    .option(
      "--from <iso>",
      "Custom start. YYYY-MM-DD = midnight in REPORT_TZ; full ISO timestamps used verbatim",
    )
    .option(
      "--to <iso>",
      "Custom end. YYYY-MM-DD = inclusive end-of-day in REPORT_TZ (defaults to now)",
    )
    .option("--account <uuid>", "Restrict to a single account ID")
    .option(
      "--type <type>",
      "Filter by transaction type (e.g. card_payment, transfer, exchange, fee, refund)",
    )
    .option(
      "--currency <CCY>",
      "Filter to legs in a single currency (post-fetch)",
    )
    .option(
      "--include-pending",
      "Include pending/created transactions in totals (default: completed only)",
    )
    .option("--no-csv", "Skip writing the CSV file")
    .option("--no-md", "Skip writing the Markdown report")
    .option("--no-console", "Skip printing the console summary")
    .option(
      "--smart",
      "Run the LLM-categorized pipeline and emit a clean HTML report (requires ANTHROPIC_API_KEY)",
    )
    .parse(process.argv);

  const opts = program.opts<CliOptions>();
  const config = loadConfig();
  const periodInput = pickPeriodInput(opts);
  const period = resolvePeriod(periodInput, config.reportTz);
  const reportType = periodInput.kind === "on" || opts.day
    ? "daily"
    : opts.week || opts.lastWeek
      ? "weekly"
      : "custom";

  console.log(chalk.dim(`→ Using ${config.baseUrl}`));
  console.log(
    chalk.dim(
      `→ Auth: ${config.staticAccessToken ? "static token" : "auto-refresh (JWT)"}`,
    ),
  );
  console.log(chalk.dim(`→ Time zone: ${config.reportTz}`));
  console.log(chalk.dim(`→ Period: ${period.label}`));
  if (opts.smart) {
    console.log(chalk.dim("→ Smart pipeline: preprocessing + EUR-normalize + LLM categorisation"));
  }

  const result = await runReport({
    period,
    account: opts.account,
    type: opts.type as never,
    currency: opts.currency,
    includePending: opts.includePending,
    smart: opts.smart,
    reportType,
    config,
  });

  if (opts.console !== false) {
    printReport(result.transactions, result.summary, {
      periodLabel: period.label,
      fetched: result.stats.fetched,
      fromIso: toApiDate(period.from),
      toIso: toApiDate(period.to),
      reportTz: config.reportTz,
    });
  }

  // Filenames use ISO YYYY-MM-DD so they sort chronologically in any file
  // browser, regardless of the user-facing display format inside the report.
  const fromIsoDay = formatTzDate(period.from, config.reportTz);
  const toIsoDay = formatTzDate(
    new Date(period.to.getTime() - 1),
    config.reportTz,
  );
  const periodSlug =
    fromIsoDay === toIsoDay ? fromIsoDay : `${fromIsoDay}_${toIsoDay}`;
  const baseName = `revolut-${periodSlug}-${stamp()}`;

  if (opts.csv !== false) {
    const filePath = join(config.outDir, `${baseName}.csv`);
    const written = await writeText(filePath, reportToCsv(result));
    console.log(chalk.green(`✓ CSV written:      ${written}`));
  }

  if (opts.md !== false) {
    const filePath = join(config.outDir, `${baseName}.md`);
    const written = await writeText(filePath, reportToMarkdown(result));
    console.log(chalk.green(`✓ Markdown written: ${written}`));
  }

  if (opts.smart && result.report) {
    const filePath = join(config.outDir, `${baseName}.html`);
    const written = await writeText(filePath, reportToHtml(result));
    console.log(
      chalk.dim(
        `  partitioned: fx lookups ${result.stats.fxLookups} · cache hits ${result.stats.cacheHits} · LLM calls ${result.stats.llmCalls}`,
      ),
    );
    console.log(chalk.green(`✓ HTML written:     ${written}`));
  }
}

function pickPeriodInput(opts: CliOptions): PeriodInput {
  if (opts.on) return { kind: "on", date: opts.on };
  if (opts.from) return { kind: "range", from: opts.from, to: opts.to };
  if (opts.day) return { kind: "today" };
  if (opts.yesterday) return { kind: "yesterday" };
  if (opts.lastWeek) return { kind: "last-week" };
  if (opts.week) return { kind: "this-week" };
  return { kind: "today" };
}

async function writeText(filePath: string, contents: string): Promise<string> {
  const absolute = resolve(filePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, "utf8");
  return absolute;
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`✗ ${msg}`));
  process.exitCode = 1;
});
