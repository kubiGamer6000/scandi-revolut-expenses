import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { loadConfig, type Config } from "../config.js";
import {
  reportToCsv,
  reportToHtml,
  reportToJson,
  reportToMarkdown,
  resolvePeriod,
  runReport,
  type PeriodInput,
} from "../pipeline/run.js";
import { formatTzDate } from "../utils/dates.js";
import { bearerAuth } from "./auth.js";

export interface AppDeps {
  config?: Config;
}

/**
 * Hono app factory. Built so tests can inject a custom Config; production
 * just calls `createApp()` with no arg and gets the env-loaded singleton.
 */
export function createApp(deps: AppDeps = {}): Hono {
  const config = deps.config ?? loadConfig();
  const app = new Hono();

  app.use("*", logger());

  app.notFound((c) =>
    c.json(
      {
        error: "not_found",
        message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}`,
      },
      404,
    ),
  );

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json(
        { error: statusToCode(err.status), message: err.message },
        err.status,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api] unhandled:", err);
    return c.json({ error: "internal_error", message }, 500);
  });

  // ---- Public routes ----
  app.get("/", (c) =>
    c.json({
      service: "revolut-expense-reports",
      version: 1,
      docs: "/v1/info",
      health: "/health",
    }),
  );

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      timezone: config.reportTz,
      environment: config.baseUrl.includes("sandbox") ? "sandbox" : "production",
      auth_mode: config.staticAccessToken ? "static" : "auto-refresh",
    }),
  );

  // ---- Authenticated routes ----
  const v1 = new Hono();
  v1.use("*", bearerAuth(config.apiKeys));

  v1.get("/info", (c) =>
    c.json({
      service: "revolut-expense-reports",
      version: 1,
      timezone: config.reportTz,
      environment: config.baseUrl.includes("sandbox") ? "sandbox" : "production",
      smart_mode_available: Boolean(config.anthropicApiKey),
      formats: ["json", "csv", "md", "html"],
      periods: ["today", "yesterday", "this-week", "last-week", "on", "range"],
      example: {
        url: "/v1/report?period=last-week&format=html&smart=true",
        download: "?download=true forces an attachment Content-Disposition",
      },
    }),
  );

  v1.get("/report", async (c) => {
    const q = c.req.query();
    const period = parsePeriodFromQuery(q);
    const format = (q.format ?? "json").toLowerCase();
    const smart = parseBool(q.smart, false);
    const includePending = parseBool(q.include_pending, false);
    const download = parseBool(q.download, false);

    if (!["json", "csv", "md", "markdown", "html"].includes(format)) {
      throw new HTTPException(400, {
        message: `Unsupported format '${format}'. Use one of: json, csv, md, html.`,
      });
    }
    if (format === "html" && !smart) {
      throw new HTTPException(400, {
        message:
          "HTML output requires smart=true (the LLM-categorised report). Add &smart=true.",
      });
    }

    const resolvedPeriod = resolvePeriod(period, config.reportTz);
    const reportType: "daily" | "weekly" | "custom" =
      period.kind === "today" || period.kind === "yesterday" || period.kind === "on"
        ? "daily"
        : period.kind === "this-week" || period.kind === "last-week"
          ? "weekly"
          : "custom";

    const result = await runReport({
      period: resolvedPeriod,
      account: q.account,
      type: q.type as never,
      currency: q.currency,
      includePending,
      smart,
      reportType,
      config,
    });

    const filename = buildFilename(
      resolvedPeriod.from,
      new Date(resolvedPeriod.to.getTime() - 1),
      config.reportTz,
      format === "markdown" ? "md" : format,
    );

    if (download) {
      c.header("Content-Disposition", `attachment; filename="${filename}"`);
    } else {
      c.header("Content-Disposition", `inline; filename="${filename}"`);
    }
    c.header("X-Tx-Count", String(result.transactions.length));
    c.header("X-Period", resolvedPeriod.label);

    if (format === "csv") {
      c.header("Content-Type", "text/csv; charset=utf-8");
      return c.body(reportToCsv(result));
    }
    if (format === "md" || format === "markdown") {
      c.header("Content-Type", "text/markdown; charset=utf-8");
      return c.body(reportToMarkdown(result));
    }
    if (format === "html") {
      c.header("Content-Type", "text/html; charset=utf-8");
      return c.body(reportToHtml(result));
    }
    return c.json(reportToJson(result));
  });

  app.route("/v1", v1);

  return app;
}

// ---------- Query helpers ----------

function parsePeriodFromQuery(q: Record<string, string>): PeriodInput {
  const kind = (q.period ?? "today").toLowerCase();
  switch (kind) {
    case "today":
    case "yesterday":
    case "this-week":
    case "last-week":
      return { kind };
    case "on":
      if (!q.date) {
        throw new HTTPException(400, {
          message: "period=on requires &date=DD/MM/YYYY (or YYYY-MM-DD).",
        });
      }
      return { kind: "on", date: q.date };
    case "range":
      if (!q.from) {
        throw new HTTPException(400, {
          message: "period=range requires &from=DD/MM/YYYY (and optional &to=...).",
        });
      }
      return { kind: "range", from: q.from, to: q.to };
    default:
      throw new HTTPException(400, {
        message: `Unknown period '${kind}'. Use one of: today, yesterday, this-week, last-week, on, range.`,
      });
  }
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return fallback;
}

function buildFilename(
  from: Date,
  to: Date,
  tz: string,
  ext: string,
): string {
  const fromIso = formatTzDate(from, tz);
  const toIso = formatTzDate(to, tz);
  const slug = fromIso === toIso ? fromIso : `${fromIso}_${toIso}`;
  return `revolut-${slug}.${ext}`;
}

function statusToCode(status: number): string {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "error";
}
