import axios, { AxiosError } from "axios";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Frankfurter is a free, no-key FX API backed by ECB reference rates.
 *
 * Endpoint: GET https://api.frankfurter.dev/v1/{YYYY-MM-DD}?from={CCY}&to={CCY}
 *
 * If the requested date is a weekend or ECB holiday, Frankfurter automatically
 * returns the most recent business day's rate. The response's `date` field
 * tells us which day was actually used; we cache by the *requested* date so
 * repeated lookups are O(1).
 */
const FRANKFURTER_BASE = "https://api.frankfurter.dev/v1";

interface FrankfurterResponse {
  amount: number;
  base: string;
  date: string;
  rates: Record<string, number>;
}

interface FxCacheFile {
  /** key = `${date}_${from}_${to}`, value = rate (units of `to` per 1 unit of `from`) */
  [key: string]: number;
}

export interface FxClientOptions {
  cachePath?: string;
}

export class FxClient {
  private readonly cachePath: string;
  private cache: FxCacheFile | null = null;
  private inflight = new Map<string, Promise<number>>();
  private dirty = false;

  constructor(opts: FxClientOptions = {}) {
    this.cachePath = opts.cachePath ?? "./data/fx-cache.json";
  }

  /**
   * Returns the rate to convert 1 unit of `from` into `to` on the given date.
   * `from === to` short-circuits to 1. Cache is read once per process and
   * persisted on `flush()`.
   */
  async getRate(date: string, from: string, to: string): Promise<number> {
    const fromU = from.toUpperCase();
    const toU = to.toUpperCase();
    if (fromU === toU) return 1;

    await this.ensureCacheLoaded();
    const key = `${date}_${fromU}_${toU}`;

    const cached = this.cache![key];
    if (typeof cached === "number") return cached;

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = this.fetchRate(date, fromU, toU)
      .then((rate) => {
        this.cache![key] = rate;
        this.dirty = true;
        return rate;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  /** Convert an amount on a given date. */
  async convert(
    amount: number,
    from: string,
    to: string,
    date: string,
  ): Promise<number> {
    const rate = await this.getRate(date, from, to);
    return amount * rate;
  }

  /** Persist the cache to disk if anything changed. */
  async flush(): Promise<void> {
    if (!this.dirty || !this.cache) return;
    const abs = resolve(this.cachePath);
    await mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp`;
    const sorted = Object.fromEntries(
      Object.entries(this.cache).sort(([a], [b]) => a.localeCompare(b)),
    );
    await writeFile(tmp, JSON.stringify(sorted, null, 2) + "\n", "utf8");
    await rename(tmp, abs);
    this.dirty = false;
  }

  private async ensureCacheLoaded(): Promise<void> {
    if (this.cache) return;
    const abs = resolve(this.cachePath);
    if (!existsSync(abs)) {
      this.cache = {};
      return;
    }
    try {
      const raw = await readFile(abs, "utf8");
      this.cache = raw.trim() === "" ? {} : (JSON.parse(raw) as FxCacheFile);
    } catch {
      this.cache = {};
    }
  }

  private async fetchRate(
    date: string,
    from: string,
    to: string,
  ): Promise<number> {
    try {
      const { data } = await axios.get<FrankfurterResponse>(
        `${FRANKFURTER_BASE}/${date}`,
        {
          params: { from, to },
          timeout: 15_000,
        },
      );
      const rate = data.rates[to];
      if (typeof rate !== "number") {
        throw new Error(
          `Frankfurter response missing rate for ${to}: ${JSON.stringify(data.rates)}`,
        );
      }
      return rate;
    } catch (err) {
      if (err instanceof AxiosError) {
        const status = err.response?.status;
        const body = err.response?.data;
        const detail =
          typeof body === "string"
            ? body
            : body
              ? JSON.stringify(body)
              : err.message;
        throw new Error(
          `Frankfurter ${date} ${from}→${to} failed (${status ?? "no status"}): ${detail}`,
        );
      }
      throw err;
    }
  }
}
