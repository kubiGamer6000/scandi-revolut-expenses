import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AuthConfig {
  baseUrl: string;
  /** If set, we skip the JWT refresh flow and just use this verbatim. */
  staticAccessToken?: string;
  clientId?: string;
  privateKey?: string;
  jwtIssuer?: string;
  /** Initial refresh token from `auth:exchange`; cache wins after first run. */
  initialRefreshToken?: string;
  cachePath?: string;
}

export interface Config extends AuthConfig {
  outDir: string;
  anthropicApiKey?: string;
  merchantsCachePath: string;
  fxCachePath: string;
  /**
   * IANA time zone the report is anchored to (period boundaries, displayed
   * timestamps, FX-lookup dates). Defaults to Europe/Stockholm because that's
   * the account's home market — keeps reports consistent regardless of where
   * the script runs (laptop, cron, container).
   */
  reportTz: string;
  /** HTTP port for the API server. */
  port: number;
  /**
   * Accepted bearer keys for the API. Set via `API_KEYS` env var (comma- or
   * whitespace-separated, allows rotation: e.g. "old-key new-key"). Empty
   * means the API server refuses to start — never run unauthenticated.
   */
  apiKeys: string[];
}

export function loadConfig(): Config {
  const auth = loadAuthConfig();
  // Single DATA_DIR override (handy for containers: mount one volume at /data).
  // Individual *_PATH vars still win if set explicitly.
  const dataDir = process.env.DATA_DIR?.trim() || "./data";
  // outDir is CLI-only artefact dumping ground (CSV / MD / HTML files). The
  // API server doesn't write files at all, it streams everything in-memory.
  const outDir = process.env.REPORT_OUT_DIR?.trim() || "./reports";
  const anthropicApiKey =
    process.env.ANTHROPIC_API_KEY?.trim() || undefined;
  const merchantsCachePath =
    process.env.MERCHANTS_CACHE_PATH?.trim() ||
    joinDir(dataDir, "merchants.json");
  const fxCachePath =
    process.env.FX_CACHE_PATH?.trim() || joinDir(dataDir, "fx-cache.json");
  const reportTz =
    process.env.REPORT_TZ?.trim() || "Europe/Stockholm";

  const port = Number.parseInt(process.env.PORT ?? "8080", 10) || 8080;
  const apiKeys = (process.env.API_KEYS ?? "")
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  return {
    ...auth,
    outDir,
    anthropicApiKey,
    merchantsCachePath,
    fxCachePath,
    reportTz,
    port,
    apiKeys,
  };
}

function joinDir(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

export function loadAuthConfig(): AuthConfig {
  const baseUrl = (
    process.env.REVOLUT_BASE_URL ?? "https://sandbox-b2b.revolut.com/api/1.0"
  ).replace(/\/+$/, "");

  const staticAccessToken = process.env.REVOLUT_ACCESS_TOKEN?.trim() || undefined;

  const clientId = process.env.REVOLUT_CLIENT_ID?.trim() || undefined;
  const privateKeyPath = process.env.REVOLUT_PRIVATE_KEY_PATH?.trim();
  const privateKeyInline = process.env.REVOLUT_PRIVATE_KEY?.trim();
  const jwtIssuer = process.env.REVOLUT_JWT_ISSUER?.trim() || undefined;
  const initialRefreshToken =
    process.env.REVOLUT_REFRESH_TOKEN?.trim() || undefined;
  const cachePath = process.env.REVOLUT_TOKEN_CACHE?.trim() || undefined;

  let privateKey: string | undefined;
  if (privateKeyInline) {
    privateKey = privateKeyInline.replace(/\\n/g, "\n");
  } else if (privateKeyPath) {
    try {
      privateKey = readFileSync(resolve(privateKeyPath), "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not read REVOLUT_PRIVATE_KEY_PATH (${privateKeyPath}): ${msg}`,
      );
    }
  }

  if (!staticAccessToken) {
    const missing: string[] = [];
    if (!clientId) missing.push("REVOLUT_CLIENT_ID");
    if (!privateKey)
      missing.push("REVOLUT_PRIVATE_KEY_PATH (or REVOLUT_PRIVATE_KEY)");
    if (!jwtIssuer) missing.push("REVOLUT_JWT_ISSUER");
    if (missing.length > 0) {
      throw new Error(
        `Missing auth env vars: ${missing.join(", ")}. ` +
          `Either set these for the auto-refresh flow, or set REVOLUT_ACCESS_TOKEN for a one-off manual token. ` +
          `See .env.example.`,
      );
    }
  }

  return {
    baseUrl,
    staticAccessToken,
    clientId,
    privateKey,
    jwtIssuer,
    initialRefreshToken,
    cachePath,
  };
}
