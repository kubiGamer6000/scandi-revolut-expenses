import type { Account, Transaction } from "../revolut/types.js";
import { formatTzDate, formatTzTimestampEu } from "../utils/dates.js";
import type { FxClient } from "./fx.js";

export type Direction = "outgoing" | "incoming";

export interface PreprocessedTx {
  id: string;
  /**
   * ISO date (YYYY-MM-DD) in the report's tz — what we use for FX lookup,
   * grouping, and HTML display. NOT the UTC slice of `created_at`.
   */
  date: string;
  /**
   * User-facing timestamp `DD/MM/YYYY HH:mm:ss` formatted in the report's tz.
   * Shown in the HTML / Markdown reports so users see "when I tapped" in
   * their own time zone, not raw UTC.
   */
  display_at: string;
  /** Full ISO timestamp from `created_at` (UTC) for downstream sorting. */
  created_at: string;
  /** Original Revolut transaction type. */
  type: Transaction["type"];
  state: Transaction["state"];

  /** Best raw merchant string we could pull from the leg/tx. */
  raw_merchant: string;
  /** Normalized lookup key (lowercased, trailing IDs stripped). */
  merchant_key: string;

  amount_native: number;
  currency_native: string;
  amount_eur: number;

  fee_native: number;
  fee_eur: number;

  direction: Direction;
  /** Underlying leg id, useful for debugging back to the CSV. */
  leg_id: string;
  account_id: string;
  description?: string;
}

export interface PreprocessBuckets {
  outgoing: PreprocessedTx[];
  incoming: PreprocessedTx[];
  declined: PreprocessedTx[];
  /** Internal FX swaps — dropped from the report but kept here for transparency. */
  exchanges: PreprocessedTx[];
  stats: {
    total_input: number;
    skipped_internal_legs: number;
    fx_lookups: number;
  };
}

/**
 * Stage 1. Take raw Revolut transactions and produce four clean buckets,
 * with every amount normalized to EUR.
 *
 * Internal own-account legs (transfers between your own Revolut accounts) are
 * intentionally dropped — they're noise for spend reporting, the same money
 * just hopping pockets.
 */
export async function preprocess(
  transactions: Transaction[],
  accounts: Account[],
  fx: FxClient,
  reportTz: string,
): Promise<PreprocessBuckets> {
  const accountIds = new Set(accounts.map((a) => a.id));

  const outgoing: PreprocessedTx[] = [];
  const incoming: PreprocessedTx[] = [];
  const declined: PreprocessedTx[] = [];
  const exchanges: PreprocessedTx[] = [];

  let skippedInternal = 0;
  let fxLookups = 0;

  for (const tx of transactions) {
    // Any multi-leg transaction whose legs ALL land on accounts we own is
    // internal money movement (account-to-account, FX swap, etc.) — drop the
    // whole thing. Catches the case Revolut leaves `counterparty` empty on,
    // e.g. EUR Pp → EUR Main appearing as two separate-looking legs.
    const isInternalTx =
      tx.legs.length > 1 &&
      tx.legs.every((l) => accountIds.has(l.account_id));

    if (tx.type === "exchange") {
      // Spec: drop FX swaps before reporting. We still keep them on the
      // exchanges bucket for traceability.
      for (const leg of tx.legs) {
        const pre = await preprocessLeg(
          tx,
          leg,
          fx,
          reportTz,
          () => fxLookups++,
        );
        if (pre) exchanges.push(pre);
      }
      continue;
    }

    if (isInternalTx) {
      skippedInternal += tx.legs.length;
      continue;
    }

    for (const leg of tx.legs) {
      const pre = await preprocessLeg(
        tx,
        leg,
        fx,
        reportTz,
        () => fxLookups++,
      );
      if (!pre) continue;

      if (tx.state === "declined" || tx.state === "failed") {
        declined.push(pre);
      } else if (
        tx.state === "completed" ||
        tx.state === "pending" ||
        tx.state === "created"
      ) {
        // Include pending/created alongside completed — for a spending report
        // you want today's Uber and subscriptions even before they settle.
        // `reverted` is still excluded because it nets to zero.
        if (pre.direction === "outgoing") outgoing.push(pre);
        else incoming.push(pre);
      }
    }
  }

  return {
    outgoing,
    incoming,
    declined,
    exchanges,
    stats: {
      total_input: transactions.length,
      skipped_internal_legs: skippedInternal,
      fx_lookups: fxLookups,
    },
  };
}

async function preprocessLeg(
  tx: Transaction,
  leg: Transaction["legs"][number],
  fx: FxClient,
  reportTz: string,
  onFxLookup: () => void,
): Promise<PreprocessedTx | null> {
  if (leg.amount === 0) return null;

  // `created_at` is UTC. We anchor the displayed date and the FX lookup to
  // the report's tz — otherwise a 22:30 UTC tx that happened at 00:30 the
  // next day in Stockholm would (a) show up under the wrong day, and (b) use
  // the wrong day's FX rate.
  const createdAtInstant = new Date(tx.created_at);
  const date = formatTzDate(createdAtInstant, reportTz);
  const displayAt = formatTzTimestampEu(createdAtInstant, reportTz);
  const currency = leg.currency.toUpperCase();
  const fee = leg.fee ?? 0;

  let amountEur: number;
  let feeEur: number;

  if (currency === "EUR") {
    amountEur = leg.amount;
    feeEur = fee;
  } else if (
    leg.bill_currency?.toUpperCase() === "EUR" &&
    typeof leg.bill_amount === "number"
  ) {
    // Revolut already gave us the EUR equivalent in the bill_amount.
    amountEur = leg.bill_amount;
    // No fee equivalent on bill_amount; convert separately if needed.
    if (fee !== 0) {
      onFxLookup();
      feeEur = await fx.convert(fee, currency, "EUR", date);
    } else {
      feeEur = 0;
    }
  } else {
    onFxLookup();
    amountEur = await fx.convert(leg.amount, currency, "EUR", date);
    feeEur =
      fee === 0 ? 0 : await fx.convert(fee, currency, "EUR", date);
  }

  const rawMerchant = pickRawMerchant(tx, leg);

  return {
    id: tx.id,
    date,
    display_at: displayAt,
    created_at: tx.created_at,
    type: tx.type,
    state: tx.state,
    raw_merchant: rawMerchant,
    merchant_key: normalizeMerchantKey(rawMerchant),
    amount_native: leg.amount,
    currency_native: currency,
    amount_eur: round2(amountEur),
    fee_native: fee,
    fee_eur: round2(feeEur),
    direction: leg.amount < 0 ? "outgoing" : "incoming",
    leg_id: leg.leg_id,
    account_id: leg.account_id,
    description: leg.description,
  };
}

function pickRawMerchant(
  tx: Transaction,
  leg: Transaction["legs"][number],
): string {
  if (tx.merchant?.name) return tx.merchant.name;
  if (leg.description) return leg.description;
  if (tx.reference) return tx.reference;
  return `(${tx.type})`;
}

/**
 * Normalize a raw merchant string into a stable cache lookup key.
 *
 * Goal: collapse minor formatting differences (case, trailing IDs, asterisks)
 * but keep enough signal that two different merchants don't collide.
 *
 * Examples:
 *   "FACEBOOK *ADS 8473"        → "facebook *ads"
 *   "Adobe.com 8472342"         → "adobe.com"
 *   "PAYMENT FROM JOHN SMITH"   → "payment from john smith"
 *   "Klaviyo*Inc 9472"          → "klaviyo*inc"
 *   "  Google  Cloud  "         → "google cloud"
 */
export function normalizeMerchantKey(raw: string): string {
  let s = raw.toLowerCase().trim();

  // Strip trailing numeric IDs (4+ digits, possibly preceded by space, dash,
  // hash, or asterisk). Repeat to handle `"Foo 12345 67890"`.
  while (/[\s\-#*]\d{4,}\s*$/.test(s)) {
    s = s.replace(/[\s\-#*]\d{4,}\s*$/, "").trim();
  }

  // Collapse runs of whitespace.
  s = s.replace(/\s+/g, " ");

  return s;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
