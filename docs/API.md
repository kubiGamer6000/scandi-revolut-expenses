# API

HTTP wrapper around the same report pipeline the CLI uses. Designed to live
behind a bearer token, return reports in any of four formats, and be cheap to
deploy on DigitalOcean App Platform (or any container host).

The server is the only thing you need to run in production — the CLI is a
local convenience. Both share `src/pipeline/run.ts` so they always emit the
same numbers.

---

## Quickstart

```bash
# 1. Generate an API key (any random string works; use openssl for safety):
openssl rand -hex 32

# 2. Add it to .env (whitespace- or comma-separated for multiple):
API_KEYS=<paste-the-key>

# 3. Run the server:
npm run serve         # tsx, with stack traces (dev)
npm run dev           # same + auto-restart on file changes
npm run build && npm start   # compiled, what production runs

# 4. Hit it:
KEY=<paste-the-key>
curl -H "Authorization: Bearer $KEY" \
     "http://localhost:8080/v1/report?period=yesterday&format=html&smart=true" \
     -o report.html
open report.html
```

The server refuses to start if `API_KEYS` is empty — there is no
unauthenticated mode.

---

## Endpoints

### `GET /health`  *(public)*
Liveness probe. No auth. Used by the platform's health check.

```json
{
  "status": "ok",
  "timezone": "Europe/Stockholm",
  "environment": "production",
  "auth_mode": "auto-refresh"
}
```

### `GET /`  *(public)*
Tiny landing payload pointing at `/v1/info` and `/health`.

### `GET /v1/info`  *(auth)*
Echoes the active config so a client can discover what's available without
parsing the deploy spec.

```json
{
  "service": "revolut-expense-reports",
  "timezone": "Europe/Stockholm",
  "environment": "production",
  "smart_mode_available": true,
  "formats": ["json", "csv", "md", "html"],
  "periods": ["today", "yesterday", "this-week", "last-week", "on", "range"]
}
```

### `GET /v1/report`  *(auth)*
The whole point of this service. Generates a report for a chosen period in a
chosen format, in one round trip.

#### Query parameters

| Param             | Type    | Default   | Notes                                                              |
| ----------------- | ------- | --------- | ------------------------------------------------------------------ |
| `period`          | enum    | `today`   | `today`, `yesterday`, `this-week`, `last-week`, `on`, `range`      |
| `date`            | string  | —         | Required when `period=on`. `DD/MM/YYYY` or `YYYY-MM-DD`            |
| `from`            | string  | —         | Required when `period=range`                                       |
| `to`              | string  | now       | Optional when `period=range`. Inclusive end-of-day                 |
| `format`          | enum    | `json`    | `json`, `csv`, `md`, `html`                                        |
| `smart`           | bool    | `false`   | Required `true` for `format=html`. Enables LLM categorisation     |
| `download`        | bool    | `false`   | Sets `Content-Disposition: attachment` so browsers save the file   |
| `account`         | uuid    | all       | Restrict to a single Revolut account ID                            |
| `type`            | string  | all       | `card_payment`, `transfer`, `topup`, `exchange`, `fee`, `refund`   |
| `currency`        | 3-letter| all       | Filter to legs in one currency                                     |
| `include_pending` | bool    | `false`   | Include `pending` / `created` states in summary numbers            |

Booleans accept `true/false`, `1/0`, `yes/no`, `on/off`.

#### Response headers

| Header                | Notes                                          |
| --------------------- | ---------------------------------------------- |
| `Content-Type`        | `text/html`, `text/csv`, `text/markdown`, `application/json` |
| `Content-Disposition` | `inline; filename="…"` or `attachment; …` if `download=true` |
| `X-Tx-Count`          | Number of transactions in the response         |
| `X-Period`            | Resolved human period label (`Yesterday (06/05/2026)`) |

#### Examples

```bash
# Yesterday as JSON (lightweight summary, no LLM cost)
curl -H "Authorization: Bearer $KEY" \
     "https://reports.example.com/v1/report?period=yesterday"

# Last week as a downloadable CSV
curl -OJ -H "Authorization: Bearer $KEY" \
     "https://reports.example.com/v1/report?period=last-week&format=csv&download=true"

# A specific day rendered as the rich HTML dashboard
curl -o report.html -H "Authorization: Bearer $KEY" \
     "https://reports.example.com/v1/report?period=on&date=05/05/2026&format=html&smart=true"

# Custom range filtered to one currency, just the markdown summary
curl -H "Authorization: Bearer $KEY" \
     "https://reports.example.com/v1/report?period=range&from=01/04/2026&to=30/04/2026&currency=EUR&format=md"
```

---

## Auth

Two equivalent ways to present the key:

```http
Authorization: Bearer <key>
X-API-Key: <key>
```

- **Multiple keys**: `API_KEYS="key-a key-b"` (whitespace or comma).
  Lets you rotate without downtime — add the new key, redeploy, swap your
  client over, then drop the old key.
- **Constant-time comparison** in `src/server/auth.ts` so timing can't leak
  key length / content.
- **No rate limiting built in.** Put Cloudflare / DO's WAF in front of the
  app if you expect anyone to brute-force you.

---

## Errors

All errors come back as JSON:

```json
{ "error": "bad_request", "message": "period=on requires &date=DD/MM/YYYY (or YYYY-MM-DD)." }
```

| Status | `error`         | When                                                           |
| ------ | --------------- | -------------------------------------------------------------- |
| 400    | `bad_request`   | Invalid query (unknown period, bad date, missing `date`/`from`)|
| 401    | `unauthorized`  | No bearer / API-key header                                     |
| 403    | `forbidden`     | Bearer present but unrecognised                                |
| 404    | `not_found`     | Wrong path                                                     |
| 500    | `internal_error`| Anything else (Revolut down, FX API hiccup, etc.). Logged with stack on the server. |

---

## What the pipeline does on every request

```
        client GET /v1/report?period=last-week&format=html&smart=true
                                  │
                       bearer auth (src/server/auth.ts)
                                  │
                       resolvePeriod()  ← parses period+tz into UTC instants
                                  │
                       runReport()      ← src/pipeline/run.ts
                                  ├─► Revolut /accounts            (parallel)
                                  └─► Revolut /transactions (paged, parallel)
                                  │
                  client-side date / currency / type filter
                                  │
                       buildSummary()      (always — cheap)
                                  │
                  ┌───────── if smart=true ─────────┐
                  ▼                                  ▼
            preprocess()                   resolveMerchants()
            partition + EUR-normalize      cache hit OR Claude Opus 4.7
                  └────────────► aggregate() ──────────────┘
                                  │
                       reportToJson / reportToCsv / reportToMarkdown / reportToHtml
                                  │
                       Hono streams the body back to the caller
```

Every request is **stateless from the HTTP perspective**: nothing is written
to disk during the request, the response is the report. The on-disk caches
(`data/merchants.json`, `data/fx-cache.json`, refresh-token cache) are only
used to *avoid* paying LLM/FX/auth costs on subsequent requests.

A typical "yesterday, smart=true" request against a warm cache completes in
500–800 ms. Cold cache + a brand-new merchant adds ~2 s for one Claude call.

---

## Deployment

The same server runs anywhere that can run a Node Docker image: a Droplet,
DO App Platform, Railway, Fly.io, ECS, Cloud Run, your home NAS.

### Container basics

```bash
docker build -t revolut-reports .
docker run --rm -p 8080:8080 \
  --env-file .env \
  -v $(pwd)/data:/data \
  revolut-reports
```

The volume mount is the important part — see [Persistence](#persistence) below.

### DigitalOcean App Platform (recommended)

1. Push this repo to GitHub.
2. In App Platform → **Create App** → connect the repo. App Platform sees
   the `Dockerfile` and uses it instead of the Node buildpack.
3. Add the env vars from `.env.example` as **Encrypted secrets** in the UI
   (or import `.do/app.yaml` via `doctl apps create --spec .do/app.yaml`).
4. Make sure `API_KEYS` is set, otherwise the container will exit 1 on boot
   with a clear error.
5. Health check is already configured on `/health` (port 8080).

A reference spec lives in [`.do/app.yaml`](../.do/app.yaml).

### Persistence

The app keeps three files under `DATA_DIR` (default `/data` in Docker, `./data`
locally):

| File                        | What                                                                 | Stale impact                              |
| --------------------------- | -------------------------------------------------------------------- | ----------------------------------------- |
| `merchants.json`            | LLM-resolved merchant categories + manual overrides                  | Cold restart → re-asks Claude (LLM cost)  |
| `fx-cache.json`             | ECB FX rates from Frankfurter, keyed by `(date, from, to)`           | Cold restart → re-fetches (free, just slower) |
| `token-cache.json` *(via `REVOLUT_TOKEN_CACHE`)* | Rotated Revolut refresh + access tokens                | Cold restart → falls back to `REVOLUT_REFRESH_TOKEN` env, which goes stale once Revolut rotates it |

The token cache is the only one that *really* needs persistence. Two options:

1. **Persistent volume** (preferred). On DO App Platform Pro, uncomment the
   `data_volume` block in `.do/app.yaml`. On a Droplet, just `docker run -v
   /var/lib/revolut-reports:/data`.
2. **Ephemeral filesystem with bootstrap env**. Set `REVOLUT_REFRESH_TOKEN`
   in the env. The app will reuse it on every restart. The risk: Revolut
   rotates refresh tokens on every refresh — if the container restarts after
   the in-memory token has rotated, the env value will be stale, and you'll
   need to re-run `npm run auth:exchange` locally to get a fresh one. Fine
   for a low-traffic service that restarts daily; painful for one that
   restarts hourly.

`reports/` is **not** used by the API — it only exists for CLI runs.

---

## Using it from another service

Treat the API as a synchronous report generator. From a WhatsApp bot,
weekly cron, Slack slash command, etc., just `fetch()` it.

### Node / TypeScript

```ts
const res = await fetch(
  "https://reports.example.com/v1/report?period=last-week&format=html&smart=true",
  { headers: { Authorization: `Bearer ${process.env.REPORTS_API_KEY}` } },
);
if (!res.ok) throw new Error(`reports api ${res.status}: ${await res.text()}`);
const html = await res.text();   // ready to attach / upload / inline
```

### WhatsApp Business API (sketch)

```ts
const csv = await fetch(`${BASE}/v1/report?period=yesterday&format=csv&download=true`, {
  headers: { Authorization: `Bearer ${KEY}` },
}).then((r) => r.arrayBuffer());

await whatsapp.sendDocument({
  to: OWNER_PHONE,
  filename: "revolut-yesterday.csv",
  mediaBuffer: Buffer.from(csv),
});
```

### Cron / GitHub Action

```yaml
# .github/workflows/weekly.yml
on: { schedule: [{ cron: "0 7 * * 1" }] }   # Mon 07:00 UTC
jobs:
  email-report:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -fsSL -H "Authorization: Bearer ${{ secrets.REPORTS_KEY }}" \
            "${{ secrets.REPORTS_URL }}/v1/report?period=last-week&format=html&smart=true" \
            -o report.html
      # ...attach report.html to your email/slack/whatever step
```

The endpoint is idempotent and side-effect-free (other than warming caches),
so retrying on transient failure is always safe.
