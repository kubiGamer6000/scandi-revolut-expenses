import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * Bearer / API-key middleware. Accepts either:
 *   Authorization: Bearer <key>
 *   X-API-Key: <key>
 *
 * Multiple valid keys can be configured (whitespace- or comma-separated in
 * the `API_KEYS` env var). This makes key rotation a no-downtime swap:
 * roll the new key into the env, redeploy, then drop the old one once all
 * clients have moved.
 *
 * The check is constant-time so we don't leak key length or content via
 * timing differences.
 */
export function bearerAuth(validKeys: string[]): MiddlewareHandler {
  if (validKeys.length === 0) {
    throw new Error(
      "API_KEYS must contain at least one key — refusing to expose Revolut data unauthenticated.",
    );
  }

  return async (c, next) => {
    const presented = readKey(c.req.header("authorization"), c.req.header("x-api-key"));
    if (!presented) {
      throw new HTTPException(401, {
        message: "Missing credentials. Send `Authorization: Bearer <key>` or `X-API-Key: <key>`.",
      });
    }
    if (!validKeys.some((k) => safeEqual(presented, k))) {
      throw new HTTPException(403, { message: "Invalid API key." });
    }
    await next();
  };
}

function readKey(
  authHeader: string | undefined,
  apiKeyHeader: string | undefined,
): string | null {
  if (apiKeyHeader && apiKeyHeader.trim().length > 0) return apiKeyHeader.trim();
  if (!authHeader) return null;
  const m = /^bearer\s+(.+)$/i.exec(authHeader.trim());
  return m && m[1] ? m[1].trim() : null;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
