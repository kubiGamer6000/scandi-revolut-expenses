import Anthropic from "@anthropic-ai/sdk";
import {
  CATEGORIES,
  MerchantsCache,
  type Category,
  type MerchantHit,
} from "./merchantsCache.js";
import type { PreprocessBuckets, PreprocessedTx } from "./preprocess.js";
import { callMerchantResolver } from "../prompts/merchantResolver.js";

export interface ResolverResult {
  /** merchant_key → resolved canonical + category */
  map: Map<string, MerchantHit>;
  stats: {
    unique_keys: number;
    cache_hits: number;
    llm_calls: number;
    llm_resolved: number;
    new_canonicals: number;
    new_aliases: number;
  };
}

const BATCH_SIZE = 200;

export interface ResolveOptions {
  cache: MerchantsCache;
  anthropic: Anthropic;
  /** Today, ISO yyyy-mm-dd. Used for first_seen / last_seen timestamps. */
  today?: string;
}

/**
 * Stage 2. Resolve every distinct merchant_key in the preprocessed buckets
 * to a `{ canonical_name, category }`. Cache hits are free; misses are
 * batched into a single Claude call (or chunked into batches of 200).
 *
 * Defensive merging: if Claude returns a canonical_name that already exists
 * in the cache, we treat the input as a new alias regardless of the
 * `is_alias_of_existing` flag.
 */
export async function resolveMerchants(
  buckets: PreprocessBuckets,
  opts: ResolveOptions,
): Promise<ResolverResult> {
  const { cache, anthropic } = opts;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  await cache.load();

  // Collect every distinct merchant_key from outgoing/incoming/declined.
  // (Exchanges are dropped from the report, no need to categorize.)
  const allKeys = new Set<string>();
  const rawByKey = new Map<string, string>();
  for (const bucket of [buckets.outgoing, buckets.incoming, buckets.declined]) {
    for (const tx of bucket) {
      if (!tx.merchant_key) continue;
      allKeys.add(tx.merchant_key);
      // Keep the first raw form we saw, so the LLM has a human-readable input.
      if (!rawByKey.has(tx.merchant_key)) {
        rawByKey.set(tx.merchant_key, tx.raw_merchant);
      }
    }
  }

  const reverse = cache.reverseLookup();
  const result = new Map<string, MerchantHit>();
  const unknowns: string[] = [];

  let cacheHits = 0;
  for (const key of allKeys) {
    const hit = reverse.get(key);
    if (hit) {
      result.set(key, hit);
      cache.touch(hit.canonical_name, today);
      cacheHits++;
    } else {
      unknowns.push(key);
    }
  }

  let llmCalls = 0;
  let llmResolved = 0;
  let newCanonicals = 0;
  let newAliases = 0;

  if (unknowns.length > 0) {
    for (let i = 0; i < unknowns.length; i += BATCH_SIZE) {
      const chunk = unknowns.slice(i, i + BATCH_SIZE);
      const inputs = chunk.map((k) => rawByKey.get(k) ?? k);

      llmCalls++;
      const { results } = await callMerchantResolver(
        anthropic,
        inputs,
        cache.listCanonicals(),
      );

      // Map LLM output back to input keys by index. The schema requires the
      // model to echo `raw` and we asked for same-order results, but we
      // index-match as the primary path.
      results.forEach((r, idx) => {
        const key = chunk[idx];
        if (!key) return;
        llmResolved++;

        const category = isCategory(r.category) ? r.category : "other";
        const canonical = (r.canonical_name || "").trim() || rawByKey.get(key) || key;

        if (cache.hasCanonical(canonical)) {
          // Treat as alias regardless of the flag — this is the defensive
          // merge step from the spec.
          cache.addAlias(canonical, key, today);
          newAliases++;
        } else {
          // Brand-new canonical. Seed with the lookup key as the first alias.
          cache.createMerchant(canonical, category, [key], today);
          newCanonicals++;
        }

        result.set(key, { canonical_name: canonical, category });
      });
    }

    await cache.flush();
  }

  return {
    map: result,
    stats: {
      unique_keys: allKeys.size,
      cache_hits: cacheHits,
      llm_calls: llmCalls,
      llm_resolved: llmResolved,
      new_canonicals: newCanonicals,
      new_aliases: newAliases,
    },
  };
}

function isCategory(s: string): s is Category {
  return (CATEGORIES as readonly string[]).includes(s);
}

/**
 * Convenience for tests and the CLI: attach a resolved hit onto a
 * preprocessed transaction.
 */
export interface ResolvedTx extends PreprocessedTx {
  canonical_name: string;
  category: Category;
}

export function attachResolution(
  txs: PreprocessedTx[],
  map: Map<string, MerchantHit>,
): ResolvedTx[] {
  return txs.map((tx) => {
    const hit = map.get(tx.merchant_key);
    return {
      ...tx,
      canonical_name: hit?.canonical_name ?? tx.raw_merchant,
      category: hit?.category ?? "other",
    };
  });
}
