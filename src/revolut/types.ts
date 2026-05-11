/**
 * Subset of the Revolut Business API schema we actually consume.
 * Source: https://developer.revolut.com/assets/revolut-openapi/yaml/business.yaml
 */

export type TransactionType =
  | "atm"
  | "card_payment"
  | "card_refund"
  | "card_chargeback"
  | "card_credit"
  | "charge"
  | "charge_refund"
  | "exchange"
  | "transfer"
  | "loan"
  | "fee"
  | "refund"
  | "topup"
  | "topup_return"
  | "tax"
  | "tax_refund";

export type TransactionState =
  | "created"
  | "pending"
  | "completed"
  | "declined"
  | "failed"
  | "reverted";

export type CounterpartyAccountType = "self" | "revolut" | "external";

export interface TransactionCounterparty {
  id?: string;
  account_id?: string;
  account_type: CounterpartyAccountType;
}

export interface TransactionLeg {
  leg_id: string;
  account_id: string;
  amount: number;
  fee?: number;
  currency: string;
  bill_amount?: number;
  bill_currency?: string;
  counterparty?: TransactionCounterparty;
  description?: string;
  balance?: number;
}

export interface TransactionMerchant {
  id?: string;
  name?: string;
  city?: string;
  category_code?: string;
  country?: string;
}

export interface TransactionCard {
  id?: string;
  card_number?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
}

export interface Transaction {
  id: string;
  type: TransactionType;
  state: TransactionState;
  request_id?: string;
  reason_code?: string;
  reference?: string;
  related_transaction_id?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  scheduled_for?: string;
  merchant?: TransactionMerchant;
  card?: TransactionCard;
  legs: TransactionLeg[];
}

export interface Account {
  id: string;
  name?: string;
  balance?: number;
  currency?: string;
  state?: string;
  public?: boolean;
  created_at?: string;
  updated_at?: string;
}
