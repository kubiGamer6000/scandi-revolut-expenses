import type { Account, Transaction } from "../revolut/types.js";

export interface MoneyByCurrency {
  [currency: string]: number;
}

export interface CounterpartyTotal {
  name: string;
  totalsByCurrency: MoneyByCurrency;
  txCount: number;
}

export interface ReportSummary {
  count: number;
  byState: Record<string, number>;
  byType: Record<string, number>;
  /** Net (incoming + outgoing) per currency, signed. */
  netByCurrency: MoneyByCurrency;
  /** Sum of negative leg amounts per currency, as positive numbers. */
  outgoingByCurrency: MoneyByCurrency;
  /** Sum of positive leg amounts per currency. */
  incomingByCurrency: MoneyByCurrency;
  /** Fees paid per currency (always positive). */
  feesByCurrency: MoneyByCurrency;
  /** Top outgoing recipients (merchants + counterparties), grouped. */
  topOutgoing: CounterpartyTotal[];
  /** Top incoming sources. */
  topIncoming: CounterpartyTotal[];
}

export function buildSummary(
  transactions: Transaction[],
  accounts: Account[],
  options: { includeStates?: Transaction["state"][] } = {},
): ReportSummary {
  const includeStates = new Set(options.includeStates ?? ["completed"]);
  const accountsById = new Map(accounts.map((a) => [a.id, a] as const));

  const summary: ReportSummary = {
    count: transactions.length,
    byState: {},
    byType: {},
    netByCurrency: {},
    outgoingByCurrency: {},
    incomingByCurrency: {},
    feesByCurrency: {},
    topOutgoing: [],
    topIncoming: [],
  };

  const outgoingMap = new Map<string, CounterpartyTotal>();
  const incomingMap = new Map<string, CounterpartyTotal>();

  for (const tx of transactions) {
    summary.byState[tx.state] = (summary.byState[tx.state] ?? 0) + 1;
    summary.byType[tx.type] = (summary.byType[tx.type] ?? 0) + 1;

    if (!includeStates.has(tx.state)) continue;

    for (const leg of tx.legs) {
      const currency = leg.currency;
      const amount = leg.amount;
      const fee = leg.fee ?? 0;

      summary.netByCurrency[currency] =
        (summary.netByCurrency[currency] ?? 0) + amount;

      // Internal transfers between own accounts have one outgoing + one
      // incoming leg in the same transaction; we keep them in netByCurrency
      // (they cancel out) but skip them from the directional rollups so the
      // "money out" / "money in" totals reflect actual external flow.
      const isInternalLeg =
        tx.type === "exchange" ||
        (tx.type === "transfer" &&
          (leg.counterparty?.account_type === "self" ||
            (leg.counterparty === undefined &&
              accountsById.has(leg.account_id) &&
              tx.legs.length > 1)));

      if (!isInternalLeg) {
        if (amount < 0) {
          const abs = -amount;
          summary.outgoingByCurrency[currency] =
            (summary.outgoingByCurrency[currency] ?? 0) + abs;

          const key = describeParty(tx, leg, accountsById);
          bumpParty(outgoingMap, key, currency, abs);
        } else if (amount > 0) {
          summary.incomingByCurrency[currency] =
            (summary.incomingByCurrency[currency] ?? 0) + amount;

          const key = describeParty(tx, leg, accountsById);
          bumpParty(incomingMap, key, currency, amount);
        }
      }

      if (fee > 0) {
        summary.feesByCurrency[currency] =
          (summary.feesByCurrency[currency] ?? 0) + fee;
      }
    }
  }

  summary.topOutgoing = rankParties(outgoingMap, 10);
  summary.topIncoming = rankParties(incomingMap, 10);

  return summary;
}

function describeParty(
  tx: Transaction,
  leg: Transaction["legs"][number],
  accountsById: Map<string, Account>,
): string {
  if (tx.merchant?.name) {
    const city = tx.merchant.city ? ` (${tx.merchant.city})` : "";
    return `${tx.merchant.name}${city}`;
  }
  if (leg.counterparty?.account_type === "self" && leg.counterparty.account_id) {
    const acc = accountsById.get(leg.counterparty.account_id);
    return acc?.name ? `Internal: ${acc.name}` : "Internal account";
  }
  if (leg.description) return leg.description;
  if (tx.reference) return tx.reference;
  return `(${tx.type})`;
}

function bumpParty(
  map: Map<string, CounterpartyTotal>,
  name: string,
  currency: string,
  amount: number,
): void {
  const existing = map.get(name) ?? {
    name,
    totalsByCurrency: {},
    txCount: 0,
  };
  existing.totalsByCurrency[currency] =
    (existing.totalsByCurrency[currency] ?? 0) + amount;
  existing.txCount += 1;
  map.set(name, existing);
}

function rankParties(
  map: Map<string, CounterpartyTotal>,
  limit: number,
): CounterpartyTotal[] {
  return [...map.values()]
    .sort((a, b) => totalAcrossCurrencies(b) - totalAcrossCurrencies(a))
    .slice(0, limit);
}

/**
 * Treats every currency 1:1 — purely for ranking. We never mix currencies in
 * displayed totals. Good enough for a "top spend" list.
 */
function totalAcrossCurrencies(t: CounterpartyTotal): number {
  return Object.values(t.totalsByCurrency).reduce((a, b) => a + b, 0);
}
