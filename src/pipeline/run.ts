import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, type Config } from "../config.js";
import { renderTransactionsCsv } from "../reporting/csv.js";
import { renderMarkdown } from "../reporting/markdown.js";
import { buildSummary, type ReportSummary } from "../reporting/summary.js";
import {
  StaticTokenProvider,
  TokenManager,
  type AccessTokenProvider,
} from "../revolut/auth.js";
import { RevolutClient } from "../revolut/client.js";
import type { Account, Transaction, TransactionType } from "../revolut/types.js";
import {
  customRange,
  formatTzDateEu,
  lastWeek,
  singleDay,
  thisWeek,
  toApiDate,
  today,
  yesterday,
  type Period,
} from "../utils/dates.js";
import { aggregate, type AggregateContext, type Report } from "./aggregator.js";
import { FxClient } from "./fx.js";
import { renderHtml } from "./html.js";
import { MerchantsCache } from "./merchantsCache.js";
import { preprocess } from "./preprocess.js";
import { resolveMerchants } from "./resolver.js";

/**
 * Single source of truth for "fetch transactions, optionally LLM-categorise,
 * render every format". Both the CLI (`src/index.ts`) and the HTTP API
 * (`src/server/app.ts`) call this so behaviour stays in sync.
 */
export interface RunReportOptions {
  /** Pre-resolved Period or one of the well-known shortcuts. */
  period: Period;
  /** Restrict to a single Revolut account ID. */
  account?: string;
  /** Filter to one transaction type (card_payment, transfer, …). */
  type?: TransactionType;
  /** Filter to legs in a single 3-letter currency, post-fetch. */
  currency?: string;
  /**
   * Include `pending` and `created` states in the simple summary numbers.
   * Default false (completed only) — matches what Revolut's own UI shows.
   */
  includePending?: boolean;
  /**
   * Run the LLM-categorised pipeline → produces the structured `report` field
   * and unlocks the rich HTML render. Off by default because it costs LLM
   * calls on cold caches.
   */
  smart?: boolean;
  /** Type label to embed in the smart report metadata ("daily" / "weekly" / "custom"). */
  reportType?: AggregateContext["type"];
  /** Optional pre-loaded config (reuses caches between requests in long-lived processes). */
  config?: Config;
}

export interface RunReportResult {
  config: Config;
  period: Period;
  /** Raw transactions (already date-clipped + currency-filtered). */
  transactions: Transaction[];
  accounts: Account[];
  /** Lightweight aggregations (totals by ccy, top counterparties, etc.). */
  summary: ReportSummary;
  /** Smart-mode structured report. Null when `smart: false`. */
  report: Report | null;
  /** Counts surfaced in the API response so callers can log/display them. */
  stats: {
    fetched: number;
    fxLookups: number;
    cacheHits: number;
    llmCalls: number;
  };
}

export async function runReport(
  opts: RunReportOptions,
): Promise<RunReportResult> {
  const config = opts.config ?? loadConfig();
  const period = opts.period;

  const tokens: AccessTokenProvider = config.staticAccessToken
    ? new StaticTokenProvider(config.staticAccessToken)
    : new TokenManager({
        baseUrl: config.baseUrl,
        clientId: config.clientId!,
        privateKey: config.privateKey!,
        jwtIssuer: config.jwtIssuer!,
        initialRefreshToken: config.initialRefreshToken,
        cachePath: config.cachePath,
      });

  const client = new RevolutClient({ baseUrl: config.baseUrl, tokens });

  const [accounts, rawTransactions] = await Promise.all([
    client.getAccounts(),
    client.getAllTransactions({
      from: toApiDate(period.from),
      to: toApiDate(period.to),
      account: opts.account,
      type: opts.type,
    }),
  ]);

  const transactions = applyClientFilters(rawTransactions, opts, period);
  const includeStates: Transaction["state"][] = opts.includePending
    ? ["completed", "pending", "created"]
    : ["completed"];

  const summary = buildSummary(transactions, accounts, { includeStates });

  let report: Report | null = null;
  let fxLookups = 0;
  let cacheHits = 0;
  let llmCalls = 0;

  if (opts.smart) {
    if (!config.anthropicApiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is required for smart mode (LLM-categorised pipeline).",
      );
    }

    const fx = new FxClient({ cachePath: config.fxCachePath });
    const merchantsCache = new MerchantsCache(config.merchantsCachePath);
    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

    const buckets = await preprocess(
      transactions,
      accounts,
      fx,
      config.reportTz,
    );
    await fx.flush();

    const resolution = await resolveMerchants(buckets, {
      cache: merchantsCache,
      anthropic,
    });

    const env: AggregateContext["environment"] = config.baseUrl.includes(
      "sandbox",
    )
      ? "sandbox"
      : "production";

    report = aggregate(buckets, resolution.map, {
      type: opts.reportType ?? "custom",
      period_start: formatTzDateEu(period.from, config.reportTz),
      period_end: formatTzDateEu(
        new Date(period.to.getTime() - 1),
        config.reportTz,
      ),
      environment: env,
      pipeline_stats: {
        fx_lookups: buckets.stats.fx_lookups,
        llm_calls: resolution.stats.llm_calls,
        cache_hits: resolution.stats.cache_hits,
      },
    });

    fxLookups = buckets.stats.fx_lookups;
    cacheHits = resolution.stats.cache_hits;
    llmCalls = resolution.stats.llm_calls;
  }

  return {
    config,
    period,
    transactions,
    accounts,
    summary,
    report,
    stats: {
      fetched: rawTransactions.length,
      fxLookups,
      cacheHits,
      llmCalls,
    },
  };
}

// ---------- format helpers ----------

export function reportToCsv(result: RunReportResult): string {
  return renderTransactionsCsv(result.transactions, result.accounts);
}

export function reportToMarkdown(result: RunReportResult): string {
  return renderMarkdown(result.transactions, result.summary, {
    periodLabel: result.period.label,
    fetched: result.stats.fetched,
    fromIso: toApiDate(result.period.from),
    toIso: toApiDate(result.period.to),
    baseUrl: result.config.baseUrl,
    reportTz: result.config.reportTz,
  });
}

export function reportToHtml(result: RunReportResult): string {
  if (!result.report) {
    throw new Error(
      "HTML rendering requires smart mode. Call runReport with { smart: true }.",
    );
  }
  return renderHtml(result.report);
}

/**
 * The structured JSON view: smart-mode `report` if available, otherwise
 * the lightweight summary. Always serialisable.
 */
export function reportToJson(result: RunReportResult): unknown {
  return {
    period: {
      label: result.period.label,
      from: result.period.from.toISOString(),
      to: result.period.to.toISOString(),
    },
    timezone: result.config.reportTz,
    environment: result.config.baseUrl.includes("sandbox")
      ? "sandbox"
      : "production",
    stats: result.stats,
    summary: result.summary,
    accounts: result.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      currency: a.currency,
      balance: a.balance,
    })),
    smart_report: result.report,
  };
}

// ---------- Period parsing for both CLI and API ----------

export type PeriodKind =
  | "today"
  | "yesterday"
  | "this-week"
  | "last-week"
  | "on"
  | "range";

export interface PeriodInput {
  kind: PeriodKind;
  /** Required when kind === "on". */
  date?: string;
  /** Required when kind === "range". */
  from?: string;
  to?: string;
}

export function resolvePeriod(input: PeriodInput, reportTz: string): Period {
  switch (input.kind) {
    case "today":
      return today(reportTz);
    case "yesterday":
      return yesterday(reportTz);
    case "this-week":
      return thisWeek(reportTz);
    case "last-week":
      return lastWeek(reportTz);
    case "on":
      if (!input.date) {
        throw new Error("`date` is required when kind = 'on'");
      }
      return singleDay(input.date, reportTz);
    case "range":
      if (!input.from) {
        throw new Error("`from` is required when kind = 'range'");
      }
      return customRange(input.from, input.to, reportTz);
  }
}

function applyClientFilters(
  txs: Transaction[],
  opts: RunReportOptions,
  period: Period,
): Transaction[] {
  const fromMs = period.from.getTime();
  const toMs = period.to.getTime();
  const ccy = opts.currency?.toUpperCase();

  return txs
    .filter((tx) => {
      // Belt-and-braces: Revolut's API filters by created_at, but we double-
      // check on our side so a sloppy clock at the edge can't leak adjacent
      // days into the report.
      const t = new Date(tx.created_at).getTime();
      return t >= fromMs && t < toMs;
    })
    .filter((tx) => (ccy ? tx.legs.some((l) => l.currency === ccy) : true));
}
