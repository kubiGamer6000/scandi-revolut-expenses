import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const CATEGORIES = [
  "ad_platforms",
  "saas_subscriptions",
  "suppliers",
  "contractors_payroll",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_DISPLAY: Record<Category, string> = {
  ad_platforms: "Ad Platforms",
  saas_subscriptions: "SaaS & Subscriptions",
  suppliers: "Suppliers",
  contractors_payroll: "Contractors & Payroll",
  other: "Other",
};

export interface MerchantEntry {
  category: Category;
  /** Lowercase merchant_key strings (the exact normalized cache lookup keys). */
  aliases: string[];
  first_seen: string;
  last_seen: string;
  /** When true, this entry is owner-curated; pipeline never re-asks the LLM about it. */
  manual_override: boolean;
}

export interface MerchantsCacheFile {
  version: 1;
  updated_at: string;
  merchants: Record<string, MerchantEntry>;
}

export interface MerchantHit {
  canonical_name: string;
  category: Category;
}

const DEFAULT_PATH = "./data/merchants.json";

const SEED: MerchantsCacheFile = {
  version: 1,
  updated_at: new Date(0).toISOString(),
  merchants: {
    Sourceinbox: {
      category: "suppliers",
      aliases: ["sourceinbox", "sourceinbox ltd"],
      first_seen: new Date(0).toISOString().slice(0, 10),
      last_seen: new Date(0).toISOString().slice(0, 10),
      manual_override: true,
    },
  },
};

/**
 * In-memory wrapper over `merchants.json`. Loads once, mutates in place,
 * persists atomically on `flush()`.
 */
export class MerchantsCache {
  private file: MerchantsCacheFile | null = null;

  constructor(private readonly path: string = DEFAULT_PATH) {}

  /** Read the cache file; create a seeded one on disk if missing. */
  async load(): Promise<MerchantsCacheFile> {
    if (this.file) return this.file;

    const abs = resolve(this.path);
    if (!existsSync(abs)) {
      this.file = structuredClone(SEED);
      await this.persist();
      return this.file;
    }

    const raw = await readFile(abs, "utf8");
    const parsed = JSON.parse(raw) as MerchantsCacheFile;
    if (parsed.version !== 1 || typeof parsed.merchants !== "object") {
      throw new Error(
        `Unexpected merchants.json shape at ${abs}; refusing to overwrite. Inspect manually.`,
      );
    }
    this.file = parsed;
    return parsed;
  }

  /**
   * Build a reverse lookup: every alias → its canonical entry.
   * Aliases are matched by exact normalized key (already lowercased).
   */
  reverseLookup(): Map<string, MerchantHit> {
    if (!this.file) {
      throw new Error("MerchantsCache.reverseLookup() called before load()");
    }
    const map = new Map<string, MerchantHit>();
    for (const [canonical, entry] of Object.entries(this.file.merchants)) {
      for (const alias of entry.aliases) {
        map.set(alias, { canonical_name: canonical, category: entry.category });
      }
    }
    return map;
  }

  /** True if a canonical name already exists (case-sensitive). */
  hasCanonical(name: string): boolean {
    return !!this.file?.merchants[name];
  }

  /**
   * Add a brand-new canonical merchant. Throws if it already exists — call
   * `addAlias` instead.
   */
  createMerchant(
    canonical: string,
    category: Category,
    aliases: string[],
    today: string,
  ): MerchantEntry {
    if (!this.file) throw new Error("cache not loaded");
    if (this.file.merchants[canonical]) {
      throw new Error(`Merchant ${canonical} already exists`);
    }
    const entry: MerchantEntry = {
      category,
      aliases: dedupeLower(aliases),
      first_seen: today,
      last_seen: today,
      manual_override: false,
    };
    this.file.merchants[canonical] = entry;
    return entry;
  }

  /** Append an alias to an existing canonical, dedup-aware. */
  addAlias(canonical: string, alias: string, today: string): void {
    if (!this.file) throw new Error("cache not loaded");
    const entry = this.file.merchants[canonical];
    if (!entry) throw new Error(`Unknown merchant ${canonical}`);
    const normalized = alias.toLowerCase().trim();
    if (!entry.aliases.includes(normalized)) {
      entry.aliases.push(normalized);
    }
    entry.last_seen = today;
  }

  /** Bump `last_seen` only — for cache hits during a run. */
  touch(canonical: string, today: string): void {
    if (!this.file) throw new Error("cache not loaded");
    const entry = this.file.merchants[canonical];
    if (!entry) return;
    if (today > entry.last_seen) entry.last_seen = today;
  }

  /** Snapshot the current canonical list — used to inject into LLM prompt. */
  listCanonicals(): { canonical_name: string; category: Category; aliases: string[] }[] {
    if (!this.file) return [];
    return Object.entries(this.file.merchants).map(([name, entry]) => ({
      canonical_name: name,
      category: entry.category,
      aliases: entry.aliases,
    }));
  }

  async flush(): Promise<void> {
    if (!this.file) return;
    this.file.updated_at = new Date().toISOString();
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.file) return;
    const abs = resolve(this.path);
    await mkdir(dirname(abs), { recursive: true });
    const sorted: MerchantsCacheFile = {
      version: this.file.version,
      updated_at: this.file.updated_at,
      merchants: Object.fromEntries(
        Object.entries(this.file.merchants).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
    };
    const tmp = `${abs}.tmp`;
    await writeFile(tmp, JSON.stringify(sorted, null, 2) + "\n", "utf8");
    await rename(tmp, abs);
  }
}

function dedupeLower(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of items) {
    const k = i.toLowerCase().trim();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}
