import axios, { AxiosError } from "axios";
import { SignJWT, importPKCS8, type KeyLike } from "jose";
import { createPrivateKey } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface AuthCredentials {
  baseUrl: string;
  clientId: string;
  /** PEM string. PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`) and PKCS#8 both work. */
  privateKey: string;
  /** Matches the domain of the OAuth redirect URI registered in Revolut. */
  jwtIssuer: string;
  /** Used only on the very first run; after that the cache file is the source of truth. */
  initialRefreshToken?: string;
  /** Where to persist the rotating tokens between runs. Recommended for servers. */
  cachePath?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // seconds
  refresh_token?: string;
}

interface TokenCache {
  access_token: string;
  /** Unix ms. */
  expires_at: number;
  refresh_token: string;
}

const JWT_TTL_SECONDS = 60 * 30; // Revolut allows up to 90 min; 30 is plenty.
const REFRESH_SKEW_MS = 60_000; // refresh if <60s of life left

/**
 * Sign a client-assertion JWT used to authenticate token requests against
 * Revolut's OAuth endpoint. Re-signed on every refresh because each one is
 * short-lived.
 */
export async function signClientAssertion(
  creds: Pick<AuthCredentials, "privateKey" | "clientId" | "jwtIssuer">,
): Promise<string> {
  const key = await loadPrivateKey(creds.privateKey);
  const now = Math.floor(Date.now() / 1000);

  return await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(creds.jwtIssuer)
    .setSubject(creds.clientId)
    .setAudience("https://revolut.com")
    .setIssuedAt(now)
    .setExpirationTime(now + JWT_TTL_SECONDS)
    .sign(key);
}

/**
 * One-time bootstrap: trade the `?code=...` from your OAuth redirect for an
 * access_token + refresh_token pair.
 */
export async function exchangeAuthCode(
  creds: AuthCredentials,
  code: string,
): Promise<TokenResponse> {
  const client_assertion = await signClientAssertion(creds);
  return await postToken(creds.baseUrl, {
    grant_type: "authorization_code",
    code,
    client_id: creds.clientId,
    client_assertion_type:
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion,
  });
}

/**
 * Trade a refresh_token for a fresh access_token. Revolut rotates the refresh
 * token on use, so always store whatever comes back.
 */
export async function refreshAccessToken(
  creds: AuthCredentials,
  refreshToken: string,
): Promise<TokenResponse> {
  const client_assertion = await signClientAssertion(creds);
  return await postToken(creds.baseUrl, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: creds.clientId,
    client_assertion_type:
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion,
  });
}

async function postToken(
  baseUrl: string,
  body: Record<string, string>,
): Promise<TokenResponse> {
  try {
    const { data } = await axios.post<TokenResponse>(
      `${baseUrl}/auth/token`,
      new URLSearchParams(body),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        timeout: 30_000,
      },
    );
    return data;
  } catch (err) {
    if (err instanceof AxiosError) {
      const status = err.response?.status;
      const payload = err.response?.data;
      const detail =
        typeof payload === "string"
          ? payload
          : payload
            ? JSON.stringify(payload)
            : err.message;
      throw new Error(`POST /auth/token failed (${status ?? "no status"}): ${detail}`);
    }
    throw err;
  }
}

/**
 * Caches the current access_token in memory + on disk and refreshes
 * automatically when it's about to expire. Concurrency-safe: parallel
 * `getAccessToken()` calls share a single in-flight refresh.
 */
export class TokenManager {
  private cache: TokenCache | null = null;
  private inflight: Promise<string> | null = null;
  private cacheLoaded = false;

  constructor(private readonly creds: AuthCredentials) {}

  async getAccessToken(): Promise<string> {
    await this.ensureCacheLoaded();

    if (this.cache && this.cache.expires_at - Date.now() > REFRESH_SKEW_MS) {
      return this.cache.access_token;
    }

    if (!this.inflight) {
      this.inflight = this.refreshAndStore().finally(() => {
        this.inflight = null;
      });
    }
    return await this.inflight;
  }

  /** Force a refresh, e.g. on a 401 from the API. */
  async forceRefresh(): Promise<string> {
    if (!this.inflight) {
      this.inflight = this.refreshAndStore().finally(() => {
        this.inflight = null;
      });
    }
    return await this.inflight;
  }

  /** Persist the result of an out-of-band exchange (e.g. authorization_code). */
  async storeFromResponse(resp: TokenResponse): Promise<void> {
    if (!resp.refresh_token) {
      throw new Error(
        "Token response did not include a refresh_token — cannot bootstrap.",
      );
    }
    this.cache = {
      access_token: resp.access_token,
      expires_at: Date.now() + resp.expires_in * 1000,
      refresh_token: resp.refresh_token,
    };
    this.cacheLoaded = true;
    await this.persist();
  }

  private async ensureCacheLoaded(): Promise<void> {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    const path = this.creds.cachePath;
    if (!path || !existsSync(path)) return;
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as TokenCache;
      if (parsed?.access_token && parsed?.refresh_token) {
        this.cache = parsed;
      }
    } catch {
      // Corrupt cache → ignore, we'll refresh from scratch.
    }
  }

  private async refreshAndStore(): Promise<string> {
    const refreshToken =
      this.cache?.refresh_token ?? this.creds.initialRefreshToken;
    if (!refreshToken) {
      throw new Error(
        "No refresh_token available. Run `npm run auth:exchange -- --code <auth_code>` once to bootstrap.",
      );
    }
    const resp = await refreshAccessToken(this.creds, refreshToken);
    this.cache = {
      access_token: resp.access_token,
      expires_at: Date.now() + resp.expires_in * 1000,
      refresh_token: resp.refresh_token ?? refreshToken,
    };
    await this.persist();
    return this.cache.access_token;
  }

  private async persist(): Promise<void> {
    if (!this.creds.cachePath || !this.cache) return;
    const abs = resolve(this.creds.cachePath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, JSON.stringify(this.cache, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

/** A trivial implementation that just returns a fixed token. */
export class StaticTokenProvider {
  constructor(private readonly token: string) {}
  async getAccessToken(): Promise<string> {
    return this.token;
  }
  async forceRefresh(): Promise<string> {
    throw new Error(
      "Static REVOLUT_ACCESS_TOKEN is set; cannot auto-refresh. Configure REVOLUT_CLIENT_ID + REVOLUT_PRIVATE_KEY_PATH instead.",
    );
  }
}

export type AccessTokenProvider = Pick<
  TokenManager,
  "getAccessToken" | "forceRefresh"
>;

async function loadPrivateKey(pem: string): Promise<KeyLike> {
  // jose's importPKCS8 only accepts PKCS#8 (`-----BEGIN PRIVATE KEY-----`).
  // `openssl genrsa` emits PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`), so we
  // route those through Node's crypto, which accepts both. jose's KeyLike
  // union includes Node's KeyObject, so SignJWT.sign() handles either.
  if (pem.includes("BEGIN PRIVATE KEY")) {
    return await importPKCS8(pem, "RS256");
  }
  return createPrivateKey({ key: pem, format: "pem" });
}
