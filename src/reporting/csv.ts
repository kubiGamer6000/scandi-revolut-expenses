import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Account, Transaction } from "../revolut/types.js";

const HEADERS = [
  "transaction_id",
  "leg_id",
  "type",
  "state",
  "created_at",
  "completed_at",
  "account_id",
  "account_name",
  "amount",
  "currency",
  "fee",
  "bill_amount",
  "bill_currency",
  "direction",
  "counterparty_type",
  "counterparty_id",
  "merchant_name",
  "merchant_city",
  "merchant_country",
  "merchant_category_code",
  "card_id",
  "card_number_masked",
  "cardholder",
  "description",
  "reference",
  "balance_after",
] as const;

/**
 * Pure: renders the full per-leg CSV as a string. Used by both the file
 * writer below and the HTTP API (which streams directly to the response).
 */
export function renderTransactionsCsv(
  transactions: Transaction[],
  accounts: Account[],
): string {
  const accountsById = new Map(accounts.map((a) => [a.id, a] as const));
  const rows: string[] = [HEADERS.join(",")];

  for (const tx of transactions) {
    for (const leg of tx.legs) {
      const cardholder =
        [tx.card?.first_name, tx.card?.last_name].filter(Boolean).join(" ") ||
        "";

      rows.push(
        [
          tx.id,
          leg.leg_id,
          tx.type,
          tx.state,
          tx.created_at,
          tx.completed_at ?? "",
          leg.account_id,
          accountsById.get(leg.account_id)?.name ?? "",
          formatNumber(leg.amount),
          leg.currency,
          formatNumber(leg.fee),
          formatNumber(leg.bill_amount),
          leg.bill_currency ?? "",
          leg.amount < 0 ? "out" : leg.amount > 0 ? "in" : "zero",
          leg.counterparty?.account_type ?? "",
          leg.counterparty?.id ?? leg.counterparty?.account_id ?? "",
          tx.merchant?.name ?? "",
          tx.merchant?.city ?? "",
          tx.merchant?.country ?? "",
          tx.merchant?.category_code ?? "",
          tx.card?.id ?? "",
          tx.card?.card_number ?? "",
          cardholder,
          leg.description ?? "",
          tx.reference ?? "",
          formatNumber(leg.balance),
        ]
          .map(csvEscape)
          .join(","),
      );
    }
  }

  return rows.join("\n") + "\n";
}

export async function writeTransactionsCsv(
  filePath: string,
  transactions: Transaction[],
  accounts: Account[],
): Promise<string> {
  const csv = renderTransactionsCsv(transactions, accounts);
  const absolute = resolve(filePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, csv, "utf8");
  return absolute;
}

function csvEscape(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatNumber(n: number | undefined | null): string {
  if (n === undefined || n === null) return "";
  return Number.isFinite(n) ? n.toString() : "";
}
