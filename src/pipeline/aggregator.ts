import {
  CATEGORIES,
  CATEGORY_DISPLAY,
  type Category,
} from "./merchantsCache.js";
import type { PreprocessBuckets } from "./preprocess.js";
import { attachResolution, type ResolvedTx } from "./resolver.js";
import type { MerchantHit } from "./merchantsCache.js";

export interface ReportTransaction {
  /** ISO YYYY-MM-DD in reportTz. Kept for grouping / FX cache parity. */
  date: string;
  /** User-facing EU timestamp `DD/MM/YYYY HH:mm:ss` in reportTz. */
  display_at: string;
  /** Raw UTC ISO `created_at` — used purely for chronological sorting. */
  created_at: string;
  amount_eur: number;
  amount_native: number;
  currency: string;
}

export interface ReportMerchant {
  canonical_name: string;
  /** Distinct raw strings encountered — for "also seen as" UI hint. */
  aliases_seen: string[];
  tx_count: number;
  total_eur: number;
  transactions: ReportTransaction[];
}

export interface ReportCategory {
  category: Category;
  display_name: string;
  total_eur: number;
  share_pct: number;
  tx_count: number;
  merchants: ReportMerchant[];
}

export interface ReportCurrencyBreakdown {
  outgoing_native: number;
  outgoing_eur: number;
  incoming_native: number;
  incoming_eur: number;
}

export interface ReportTotals {
  outgoing_eur: number;
  incoming_eur: number;
  net_eur: number;
  fees_eur: number;
  by_currency: Record<string, ReportCurrencyBreakdown>;
}

export interface ReportDeclined {
  tx_count: number;
  attempted_total_eur: number;
  by_merchant: {
    canonical_name: string;
    tx_count: number;
    attempted_total_eur: number;
    transactions: ReportTransaction[];
  }[];
}

export interface ReportMeta {
  type: "daily" | "weekly" | "custom";
  period_start: string;
  period_end: string;
  display_currency: "EUR";
  generated_at: string;
  transaction_count: number;
  environment: "production" | "sandbox";
  fx_lookups: number;
  llm_calls: number;
  cache_hits: number;
}

export interface Report {
  report_meta: ReportMeta;
  totals: ReportTotals;
  outgoing_by_category: ReportCategory[];
  incoming_by_source: ReportMerchant[];
  declined: ReportDeclined;
}

export interface AggregateContext {
  type: ReportMeta["type"];
  period_start: string;
  period_end: string;
  environment: ReportMeta["environment"];
  pipeline_stats: {
    fx_lookups: number;
    llm_calls: number;
    cache_hits: number;
  };
}

/**
 * Stage 3. Pure deterministic. Joins the preprocessed buckets with the
 * resolved merchant map and produces the final structured report.
 *
 * No LLM calls, no network calls, no FX — those all happened upstream.
 */
export function aggregate(
  buckets: PreprocessBuckets,
  resolution: Map<string, MerchantHit>,
  ctx: AggregateContext,
): Report {
  const outgoing = attachResolution(buckets.outgoing, resolution);
  const incoming = attachResolution(buckets.incoming, resolution);
  const declined = attachResolution(buckets.declined, resolution);

  const totalsOut = sumEur(outgoing, "outgoing");
  const totalsIn = sumEur(incoming, "incoming");
  const fees = round2(
    [...outgoing, ...incoming].reduce((acc, t) => acc + (t.fee_eur ?? 0), 0),
  );

  return {
    report_meta: {
      type: ctx.type,
      period_start: ctx.period_start,
      period_end: ctx.period_end,
      display_currency: "EUR",
      generated_at: new Date().toISOString(),
      transaction_count:
        outgoing.length + incoming.length + declined.length,
      environment: ctx.environment,
      fx_lookups: ctx.pipeline_stats.fx_lookups,
      llm_calls: ctx.pipeline_stats.llm_calls,
      cache_hits: ctx.pipeline_stats.cache_hits,
    },
    totals: {
      outgoing_eur: totalsOut,
      incoming_eur: totalsIn,
      net_eur: round2(totalsIn - totalsOut),
      fees_eur: fees,
      by_currency: buildCurrencyBreakdown(outgoing, incoming),
    },
    outgoing_by_category: buildCategories(outgoing, totalsOut),
    incoming_by_source: buildIncoming(incoming),
    declined: buildDeclined(declined),
  };
}

function buildCategories(
  txs: ResolvedTx[],
  totalOutgoing: number,
): ReportCategory[] {
  const byCat = new Map<Category, ResolvedTx[]>();
  for (const cat of CATEGORIES) byCat.set(cat, []);
  for (const tx of txs) byCat.get(tx.category)!.push(tx);

  return CATEGORIES.map((cat) => {
    const items = byCat.get(cat)!;
    const total = sumEur(items, "outgoing");
    return {
      category: cat,
      display_name: CATEGORY_DISPLAY[cat],
      total_eur: total,
      share_pct:
        totalOutgoing === 0 ? 0 : round2((total / totalOutgoing) * 100),
      tx_count: items.length,
      merchants: groupByCanonical(items, "outgoing"),
    };
  });
}

function buildIncoming(txs: ResolvedTx[]): ReportMerchant[] {
  return groupByCanonical(txs, "incoming");
}

function buildDeclined(txs: ResolvedTx[]): ReportDeclined {
  const grouped = groupByCanonical(txs, "declined");
  return {
    tx_count: txs.length,
    attempted_total_eur: round2(
      txs.reduce((acc, t) => acc + Math.abs(t.amount_eur), 0),
    ),
    by_merchant: grouped.map((m) => ({
      canonical_name: m.canonical_name,
      tx_count: m.tx_count,
      attempted_total_eur: m.total_eur,
      transactions: m.transactions,
    })),
  };
}

function groupByCanonical(
  txs: ResolvedTx[],
  direction: "outgoing" | "incoming" | "declined",
): ReportMerchant[] {
  const map = new Map<
    string,
    { aliases: Set<string>; transactions: ReportTransaction[]; total: number }
  >();

  for (const tx of txs) {
    const entry = map.get(tx.canonical_name) ?? {
      aliases: new Set<string>(),
      transactions: [],
      total: 0,
    };
    entry.aliases.add(tx.raw_merchant);
    entry.transactions.push({
      date: tx.date,
      display_at: tx.display_at,
      created_at: tx.created_at,
      amount_eur: round2(Math.abs(tx.amount_eur)),
      amount_native: round2(Math.abs(tx.amount_native)),
      currency: tx.currency_native,
    });
    entry.total += Math.abs(tx.amount_eur);
    map.set(tx.canonical_name, entry);
  }

  return [...map.entries()]
    .map(([canonical, e]) => ({
      canonical_name: canonical,
      aliases_seen: [...e.aliases].sort(),
      tx_count: e.transactions.length,
      total_eur: round2(e.total),
      // `created_at` is UTC ISO → sortable lexically; gives precise chrono
      // order including time-of-day, unlike just-the-date sort.
      transactions: e.transactions.sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      ),
    }))
    .sort((a, b) => b.total_eur - a.total_eur);

  // direction is only used to make the call site explicit; logic is identical.
  void direction;
}

function buildCurrencyBreakdown(
  outgoing: ResolvedTx[],
  incoming: ResolvedTx[],
): Record<string, ReportCurrencyBreakdown> {
  const map: Record<string, ReportCurrencyBreakdown> = {};
  const ensure = (ccy: string): ReportCurrencyBreakdown => {
    if (!map[ccy]) {
      map[ccy] = {
        outgoing_native: 0,
        outgoing_eur: 0,
        incoming_native: 0,
        incoming_eur: 0,
      };
    }
    return map[ccy];
  };

  for (const tx of outgoing) {
    const e = ensure(tx.currency_native);
    e.outgoing_native += Math.abs(tx.amount_native);
    e.outgoing_eur += Math.abs(tx.amount_eur);
  }
  for (const tx of incoming) {
    const e = ensure(tx.currency_native);
    e.incoming_native += Math.abs(tx.amount_native);
    e.incoming_eur += Math.abs(tx.amount_eur);
  }

  for (const ccy of Object.keys(map)) {
    const e = map[ccy]!;
    e.outgoing_native = round2(e.outgoing_native);
    e.outgoing_eur = round2(e.outgoing_eur);
    e.incoming_native = round2(e.incoming_native);
    e.incoming_eur = round2(e.incoming_eur);
  }
  return map;
}

function sumEur(
  txs: ResolvedTx[],
  direction: "outgoing" | "incoming",
): number {
  void direction;
  return round2(
    txs.reduce((acc, t) => acc + Math.abs(t.amount_eur), 0),
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
