import axios, {
  AxiosError,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from "axios";
import type { AccessTokenProvider } from "./auth.js";
import type { Account, Transaction, TransactionType } from "./types.js";

export interface RevolutClientOptions {
  baseUrl: string;
  tokens: AccessTokenProvider;
}

export interface ListTransactionsParams {
  /** Inclusive lower bound, ISO 8601. */
  from?: string;
  /** Exclusive upper bound, ISO 8601. */
  to?: string;
  /** Restrict to a single account. */
  account?: string;
  /** Filter by transaction type. */
  type?: TransactionType;
  /** Page size (max 1000). */
  count?: number;
}

type RetriableConfig = InternalAxiosRequestConfig & { _retry?: boolean };

/**
 * Thin, typed wrapper over the Revolut Business API endpoints we need.
 *
 * Auth: every request goes through an interceptor that asks the
 * AccessTokenProvider for a (cached, auto-refreshing) bearer token. On a
 * single 401, we force-refresh and retry once.
 */
export class RevolutClient {
  private readonly http: AxiosInstance;

  constructor({ baseUrl, tokens }: RevolutClientOptions) {
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: 30_000,
      headers: { Accept: "application/json" },
    });

    this.http.interceptors.request.use(async (config) => {
      const token = await tokens.getAccessToken();
      config.headers.set("Authorization", `Bearer ${token}`);
      return config;
    });

    this.http.interceptors.response.use(
      (resp) => resp,
      async (err: AxiosError) => {
        const cfg = err.config as RetriableConfig | undefined;
        if (err.response?.status === 401 && cfg && !cfg._retry) {
          cfg._retry = true;
          await tokens.forceRefresh();
          return this.http.request(cfg);
        }
        return Promise.reject(err);
      },
    );
  }

  async getAccounts(): Promise<Account[]> {
    try {
      const { data } = await this.http.get<Account[]>("/accounts");
      return data;
    } catch (err) {
      throw wrapError(err, "GET /accounts");
    }
  }

  /**
   * Fetches a single page of transactions. Revolut returns up to 1000 items
   * per request, sorted by `created_at` DESC.
   */
  async getTransactionsPage(
    params: ListTransactionsParams,
  ): Promise<Transaction[]> {
    try {
      const { data } = await this.http.get<Transaction[]>("/transactions", {
        params: {
          from: params.from,
          to: params.to,
          account: params.account,
          type: params.type,
          count: params.count ?? 1000,
        },
      });
      return data;
    } catch (err) {
      throw wrapError(err, "GET /transactions");
    }
  }

  /**
   * Walks every page in `[from, to)` by repeatedly shrinking `to` to the
   * `created_at` of the last item on the previous page, as the docs prescribe.
   */
  async getAllTransactions(
    params: ListTransactionsParams,
  ): Promise<Transaction[]> {
    const pageSize = Math.min(params.count ?? 1000, 1000);
    const seen = new Set<string>();
    const out: Transaction[] = [];

    let cursor = params.to;
    let safety = 50; // 50 * 1000 = 50k txs cap per run, ample for day/week reports.

    while (safety-- > 0) {
      const page = await this.getTransactionsPage({
        ...params,
        to: cursor,
        count: pageSize,
      });

      if (page.length === 0) break;

      let added = 0;
      for (const tx of page) {
        if (!seen.has(tx.id)) {
          seen.add(tx.id);
          out.push(tx);
          added++;
        }
      }

      if (page.length < pageSize) break;

      const last = page[page.length - 1];
      if (!last) break;

      // If the cursor stops moving (shouldn't happen) or every item was a
      // duplicate, bail out instead of spinning.
      if (last.created_at === cursor || added === 0) break;
      cursor = last.created_at;
    }

    return out;
  }
}

function wrapError(err: unknown, label: string): Error {
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    const body = err.response?.data;
    const detail =
      typeof body === "string" ? body : body ? JSON.stringify(body) : err.message;
    return new Error(`${label} failed (${status ?? "no status"}): ${detail}`);
  }
  return err instanceof Error ? err : new Error(`${label}: ${String(err)}`);
}
