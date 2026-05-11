import { serve } from "@hono/node-server";
import { loadConfig } from "../config.js";
import { createApp } from "./app.js";

const config = loadConfig();

if (config.apiKeys.length === 0) {
  console.error(
    "✗ API_KEYS env var is empty. Refusing to start an unauthenticated server.\n" +
      "  Generate one with:  openssl rand -hex 32\n" +
      "  Then set:           API_KEYS=<your-key>",
  );
  process.exit(1);
}

const app = createApp({ config });
const port = config.port;

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`▶ revolut-reports API listening on http://0.0.0.0:${info.port}`);
  console.log(
    `  env=${config.baseUrl.includes("sandbox") ? "sandbox" : "production"}` +
      ` · tz=${config.reportTz}` +
      ` · auth=${config.staticAccessToken ? "static" : "auto-refresh"}` +
      ` · keys=${config.apiKeys.length}` +
      ` · smart=${config.anthropicApiKey ? "enabled" : "disabled"}`,
  );
});

const shutdown = (signal: string) => {
  console.log(`\n${signal} received, shutting down…`);
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
