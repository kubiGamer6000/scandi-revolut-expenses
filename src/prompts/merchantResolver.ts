import Anthropic from "@anthropic-ai/sdk";
import { CATEGORIES, type Category } from "../pipeline/merchantsCache.js";

export interface ExistingMerchantSummary {
  canonical_name: string;
  category: Category;
  aliases: string[];
}

export interface ResolverItem {
  raw: string;
  canonical_name: string;
  category: Category;
  is_alias_of_existing: boolean;
}

export interface ResolverResponse {
  results: ResolverItem[];
}

/**
 * JSON schema enforced via Anthropic structured outputs. Constrains the
 * model to:
 *   - Return an array of objects, one per input merchant.
 *   - Pick `category` from a fixed enum (model can never invent a new one).
 *   - Always include the original `raw` string so we can match by index OR key.
 *
 * Per the docs you pasted, this gets compiled into a grammar and the model
 * literally cannot deviate from it. No JSON.parse retries.
 */
const RESOLVER_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          raw: { type: "string" },
          canonical_name: { type: "string" },
          category: {
            type: "string",
            enum: [...CATEGORIES],
          },
          is_alias_of_existing: { type: "boolean" },
        },
        required: ["raw", "canonical_name", "category", "is_alias_of_existing"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You categorize merchants for an e-commerce business's expense report.

BUSINESS CONTEXT:
- E-commerce company, ~€100k+/month outgoing
- Runs ads on Meta, Google, TikTok, Snapchat, Reddit
- Sourceinbox is our supplier AND 3PL — categorize as "suppliers"
- Pays contractors and a small team
- Many recurring SaaS subscriptions (Adobe, Klaviyo, Shopify apps, hosting, email)
- Multi-currency (EUR primary, SEK secondary)

CATEGORIES (pick exactly one):
- ad_platforms: Meta, Google, TikTok, Snapchat, Reddit, etc.
- saas_subscriptions: Recurring software/tools (Adobe, Klaviyo, Zoom, hosting, email, Shopify apps)
- suppliers: Product suppliers, manufacturers, 3PLs, fulfillment, customs/duties
- contractors_payroll: People being paid (freelancers, employees, owner draws)
- other: Anything that doesn't clearly fit above (small one-offs, fees, unclear)

INSTRUCTIONS:
1. If the new merchant is clearly an alias of an existing canonical (see list below), return that EXACT canonical_name and set is_alias_of_existing: true.
2. If genuinely new, create a clean canonical_name and pick a category. Set is_alias_of_existing: false.
3. Use clean brand names: "FACEBOOK *ADS 8473" → "Meta", "ADOBE.COM" → "Adobe", "GOOGLE*ADS123" → "Google".
4. For people being paid, use "FirstName LastName" format (best guess from the description).
5. Unclear small merchants → category "other".
6. The "raw" field in each result must echo the input string verbatim.
7. Return one entry per input, in the same order.`;

/**
 * Calls Claude Opus 4.7 with structured outputs. The grammar guarantees
 * a valid array of {raw, canonical_name, category, is_alias_of_existing}.
 *
 * Retries up to MAX_RETRIES times on transient server errors (5xx) and
 * overload errors, with exponential back-off + jitter.
 */
export async function callMerchantResolver(
  client: Anthropic,
  unknowns: string[],
  existing: ExistingMerchantSummary[],
): Promise<ResolverResponse> {
  if (unknowns.length === 0) return { results: [] };

  const existingBlock = existing
    .map(
      (m) =>
        `- ${m.canonical_name} (${m.category})${
          m.aliases.length ? ` — known aliases: ${m.aliases.slice(0, 8).join(", ")}` : ""
        }`,
    )
    .join("\n");

  const userMessage =
    `EXISTING CANONICAL MERCHANTS (prefer matching to these when applicable):\n` +
    (existingBlock || "(none yet)") +
    `\n\nNEW MERCHANT STRINGS TO CATEGORIZE (return one entry per input, in order):\n` +
    JSON.stringify(unknowns, null, 2);

  // Allow ~150 tokens per merchant + 200 overhead. Cap at 16k.
  const maxTokens = Math.min(16_000, 200 + unknowns.length * 150);

  const MAX_RETRIES = 3;
  // Base delay 1 s, doubles each attempt, ±30 % jitter.
  const BASE_DELAY_MS = 1_000;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      const jitter = delay * 0.3 * (Math.random() * 2 - 1);
      const wait = Math.round(delay + jitter);
      console.error(
        `  Anthropic error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${wait} ms…`,
      );
      await sleep(wait);
    }

    try {
      // The SDK type for `output_config.format` accepts the JSON schema variant
      // but isn't fully typed for the `enum` shape we use; cast the request.
      const response = await client.messages.create({
        model: "claude-opus-4-7",
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        output_config: {
          format: {
            type: "json_schema",
            schema: RESOLVER_SCHEMA,
          },
        },
      } as Anthropic.MessageCreateParamsNonStreaming & Record<string, unknown>);

      if (response.stop_reason === "refusal") {
        throw new Error(
          "Claude refused to categorize merchants. This shouldn't happen for benign business names — investigate the input.",
        );
      }
      if (response.stop_reason === "max_tokens") {
        throw new Error(
          `Claude hit max_tokens (${maxTokens}) while categorizing merchants. Reduce batch size or raise the cap.`,
        );
      }

      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error("Claude response had no text block");
      }

      return JSON.parse(textBlock.text) as ResolverResponse;
    } catch (err) {
      lastErr = err;
      // Only retry on transient errors: 5xx status codes or Anthropic's
      // InternalServerError / OverloadedError types.
      if (!isRetryable(err) || attempt === MAX_RETRIES) throw err;
    }
  }

  // Unreachable, but keeps TypeScript happy.
  throw lastErr;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.InternalServerError) return true;
  // APIError carries a numeric `status`; 5xx are all retryable server-side issues.
  if (err instanceof Anthropic.APIError && (err.status ?? 0) >= 500) return true;
  // Belt-and-braces: catch overload / 529 by message for future SDK versions.
  if (err instanceof Error && /overload|529|internal.server/i.test(err.message)) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
