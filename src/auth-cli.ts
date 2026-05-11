import chalk from "chalk";
import { Command } from "commander";
import { loadAuthConfig } from "./config.js";
import {
  TokenManager,
  exchangeAuthCode,
  type AuthCredentials,
} from "./revolut/auth.js";

function requireFullAuthConfig(): AuthCredentials {
  const cfg = loadAuthConfig();
  const missing: string[] = [];
  if (!cfg.clientId) missing.push("REVOLUT_CLIENT_ID");
  if (!cfg.privateKey) missing.push("REVOLUT_PRIVATE_KEY_PATH");
  if (!cfg.jwtIssuer) missing.push("REVOLUT_JWT_ISSUER");
  if (missing.length > 0) {
    throw new Error(`Missing for JWT auth: ${missing.join(", ")}`);
  }
  return {
    baseUrl: cfg.baseUrl,
    clientId: cfg.clientId!,
    privateKey: cfg.privateKey!,
    jwtIssuer: cfg.jwtIssuer!,
    initialRefreshToken: cfg.initialRefreshToken,
    cachePath: cfg.cachePath,
  };
}

const program = new Command()
  .name("revolut-auth")
  .description("Bootstrap and inspect Revolut Business OAuth credentials.");

program
  .command("url")
  .description(
    "Print the consent URL. Open it in a browser, authorise, then read ?code= from the redirect.",
  )
  .option(
    "--redirect <uri>",
    "OAuth redirect URI registered with Revolut",
    "https://example.com",
  )
  .option(
    "--scope <scope>",
    "Comma-separated scopes (READ,WRITE,PAY,READ_SENSITIVE_CARD_DATA)",
    "READ",
  )
  .action(async (opts: { redirect: string; scope: string }) => {
    const cfg = requireFullAuthConfig();
    const consentBase = cfg.baseUrl.includes("sandbox")
      ? "https://sandbox-business.revolut.com/app-confirm"
      : "https://business.revolut.com/app-confirm";
    const url = new URL(consentBase);
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("redirect_uri", opts.redirect);
    url.searchParams.set("response_type", "code");
    if (opts.scope) url.searchParams.set("scope", opts.scope);

    console.log(chalk.bold("Open this URL, authorise, copy ?code= from the redirect:"));
    console.log();
    console.log(chalk.cyan(url.toString()));
    console.log();
    console.log(
      chalk.dim(
        "Then run: npm run auth:exchange -- --code <the-code-from-the-redirect>",
      ),
    );
  });

program
  .command("exchange")
  .description(
    "Exchange the one-time authorization code for the initial refresh + access tokens.",
  )
  .requiredOption("--code <code>", "Authorization code from the redirect URI")
  .action(async (opts: { code: string }) => {
    const cfg = requireFullAuthConfig();
    const resp = await exchangeAuthCode(cfg, opts.code);

    if (cfg.cachePath) {
      const tm = new TokenManager(cfg);
      await tm.storeFromResponse(resp);
      console.log(chalk.green(`✓ Tokens cached to ${cfg.cachePath}`));
    }

    console.log();
    console.log(chalk.bold("Save this in .env so a fresh checkout can re-bootstrap:"));
    console.log(`REVOLUT_REFRESH_TOKEN=${resp.refresh_token ?? ""}`);
    console.log();
    console.log(
      chalk.dim(
        `Access token (${resp.expires_in}s): ${resp.access_token.slice(0, 12)}…`,
      ),
    );
  });

program
  .command("check")
  .description(
    "Force a refresh and verify the credentials work end-to-end.",
  )
  .action(async () => {
    const cfg = requireFullAuthConfig();
    const tm = new TokenManager(cfg);
    const token = await tm.forceRefresh();
    console.log(
      chalk.green(`✓ Refresh OK. New access token: ${token.slice(0, 12)}…`),
    );
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`✗ ${msg}`));
  process.exitCode = 1;
});
