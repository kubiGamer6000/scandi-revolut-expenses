# scandi-revolut-expenses

Revolut **Business API** transaction reports for our ecommerce ops, served
two ways:

- **CLI** (`npm run report`) — for ad-hoc local runs while you eyeball things.
- **HTTP API** (`npm run serve`) — for everything else: cron jobs, the
  WhatsApp bot, dashboards, Slack/email automations. Deployable to
  DigitalOcean App Platform straight from this repo. See
  [`docs/API.md`](docs/API.md) for the API contract and
  [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the bare-metal-on-droplet
  setup we run alongside `scandi-wa-bot` and `scandi-jarvis`.

Both share the same pipeline (`src/pipeline/run.ts`), so the numbers in your
WhatsApp message are exactly what you'd see in a local CLI dump.

## What it shows

- Money flow per currency (outgoing, incoming, net, fees) — internal
  own-account transfers and exchange legs are excluded from the directional
  totals so the numbers reflect actual external spend.
- Counts by transaction type and state.
- Top 10 outgoing recipients (Meta, Google, contractors, subscriptions, …)
  and top 10 incoming sources, grouped by merchant / counterparty.
- Most recent transactions for a quick eyeball check.
- A flat one-row-per-leg CSV with everything (merchant, card, counterparty,
  fees, balance, references) for downstream BI / spreadsheets / PDF.
- *(Smart mode)* an LLM-categorised, self-contained HTML report with
  expandable per-merchant transaction lists. See [Smart mode](#smart-mode---smart) below.

---

## Setup (one-time)

This is the proper Revolut Business OAuth flow with auto-refresh. Do it once,
then forget about it — the script will rotate tokens on its own from then on.

### 1. Generate your certificates

```bash
mkdir -p .secrets && cd .secrets
openssl genrsa -out privatecert.pem 2048
openssl req -new -x509 -key privatecert.pem -out publiccert.cer -days 1825
# Just enter a country code when prompted; rest can be blank.
cd ..
```

`.secrets/` is gitignored. The private key never leaves this machine.

### 2. Upload the public cert in the Revolut Business app

In the Revolut Business app: **Settings → APIs → Business API → Add API
certificate**, then in the dialog:

| Field             | Value                                              |
| ----------------- | -------------------------------------------------- |
| Certificate title | `scandi-revolut-expenses` (anything memorable)     |
| OAuth redirect URI| `https://example.com`                              |
| X509 public key   | `cat .secrets/publiccert.cer` — paste it whole     |

After **Continue**, copy the **ClientID** Revolut shows you.

> The redirect URI is just a return target for the consent flow. We don't host
> anything there; we read `?code=...` straight from the browser URL bar.
> Whatever you put here, the JWT issuer in `.env` must match its **domain**.

### 3. Fill in `.env`

```bash
cp .env.example .env
```

Edit `.env`:

```ini
REVOLUT_BASE_URL=https://sandbox-b2b.revolut.com/api/1.0   # sandbox first
REVOLUT_CLIENT_ID=<paste the ClientID from step 2>
REVOLUT_PRIVATE_KEY_PATH=./.secrets/privatecert.pem
REVOLUT_JWT_ISSUER=example.com                             # must match the redirect domain
REVOLUT_TOKEN_CACHE=./.secrets/token-cache.json
```

### 4. Install + bootstrap

```bash
npm install

# Print the consent URL, open it, authorise:
npm run auth:url

# After authorising, your browser lands on
#   https://example.com/?code=oa_sand_XXXXXXXX
# Copy that code, then exchange it for the initial refresh token:
npm run auth:exchange -- --code oa_sand_XXXXXXXX

# Sanity check the credentials by forcing a fresh refresh:
npm run auth:check
```

After `auth:exchange`, the rotating refresh token is cached at
`.secrets/token-cache.json` (mode 0600). From now on, every report run will
auto-refresh using your private key — no manual token pasting.

### 5. Production

When you're ready, flip `REVOLUT_BASE_URL` to `https://b2b.revolut.com/api/1.0`,
upload the same (or a separate) certificate in the production Business API
settings, and re-run the bootstrap (`auth:url` → `auth:exchange`) against
prod. Use a **separate** `REVOLUT_TOKEN_CACHE` path for prod.

---

## Usage

```bash
npm run report -- --day                   # today so far (default)
npm run report -- --yesterday             # full previous day
npm run report -- --on 05/05/2026         # single day (DD/MM/YYYY or YYYY-MM-DD)
npm run report -- --week                  # Mon → now
npm run report -- --last-week             # full previous week (Mon → Sun)
npm run report -- --from 05/05/2026 --to 06/05/2026   # inclusive of both days

# Filters
npm run report -- --week --type card_payment
npm run report -- --week --currency EUR
npm run report -- --week --account <account-uuid>
npm run report -- --week --include-pending

# Skip outputs
npm run report -- --week --no-csv
npm run report -- --week --no-md
npm run report -- --week --no-console

# Smart mode: LLM categorization + clean HTML report (see below)
npm run report -- --week --smart
```

Each run produces three artifacts (toggle off with the flags above):

- **Console**: colored, eyeballable summary.
- **CSV**: `./reports/revolut-<period>-<timestamp>.csv` — one row per transaction leg, every field, machine-readable.
- **Markdown**: `./reports/revolut-<period>-<timestamp>.md` — same shape as the console output, paste-ready for Slack / Notion / a PDF generator.

Override the output dir with `REPORT_OUT_DIR` in `.env`.

---

## HTTP API

The same report pipeline, exposed over HTTP behind a bearer token. This is
what you deploy when you want WhatsApp / cron / Slack / a teammate's
dashboard to grab reports on demand. Full reference in
[`docs/API.md`](docs/API.md).

```bash
# 1. Generate a key
openssl rand -hex 32

# 2. Add to .env
API_KEYS=<paste>
PORT=8080

# 3. Run
npm run serve         # tsx, dev mode
npm run dev           # tsx watch
npm run build && npm start    # compiled, what production runs
```

Then, from any client:

```bash
KEY=<your-key>

# Lightweight JSON summary for yesterday
curl -H "Authorization: Bearer $KEY" \
     "http://localhost:8080/v1/report?period=yesterday"

# Smart HTML dashboard for last week, downloadable
curl -OJ -H "Authorization: Bearer $KEY" \
     "http://localhost:8080/v1/report?period=last-week&format=html&smart=true&download=true"

# CSV for a custom range
curl -OJ -H "Authorization: Bearer $KEY" \
     "http://localhost:8080/v1/report?period=range&from=01/05/2026&to=06/05/2026&format=csv&download=true"
```

The single endpoint `GET /v1/report` accepts `period` (`today`, `yesterday`,
`this-week`, `last-week`, `on`, `range`), `format` (`json`, `csv`, `md`,
`html`), and `smart` (`true` for the LLM-categorised HTML). Other knobs:
`account`, `type`, `currency`, `include_pending`, `download`. See
[`docs/API.md`](docs/API.md) for the full table, response headers, and error
schema.

The server refuses to start with an empty `API_KEYS` — there is no
unauthenticated mode by design.

### Deploying to DigitalOcean App Platform

```bash
# Push to GitHub, then in DO App Platform:
#   1. Create App → connect repo
#   2. App Platform sees the Dockerfile and uses it
#   3. Add the env vars from .env.example as Encrypted secrets
#   4. Set API_KEYS (required)
```

A reference spec lives in [`.do/app.yaml`](.do/app.yaml) — you can also
deploy with `doctl apps create --spec .do/app.yaml`. Health check is wired
to `/health` (port 8080). For everything else (token persistence trade-offs,
volume mounting, alternate hosts) see the [Deployment](docs/API.md#deployment)
section in the API docs.

### Date format

All user-facing dates are rendered in **European day-first** style:

- Period labels: `Day (05/05/2026)`, `05/05/2026 → 06/05/2026`
- Transaction timestamps in console / Markdown: `05/05/2026 20:14:47`
- HTML transaction lists: `05/05/2026`

CLI date flags (`--from`, `--to`, `--on`) accept **either** `DD/MM/YYYY` (also
`DD-MM-YYYY` or `DD.MM.YYYY`) **or** ISO `YYYY-MM-DD`. Pick whichever feels
natural:

```bash
npm run report -- --on 05/05/2026
npm run report -- --on 2026-05-05
npm run report -- --from 04/05/2026 --to 06/05/2026
```

Filenames keep ISO `YYYY-MM-DD` so they sort chronologically in any file
browser (`revolut-2026-05-05-…csv`).

### Time zone

Every period boundary and every displayed transaction time is anchored to a
single IANA zone, set via `REPORT_TZ` (default `Europe/Stockholm`). This means:

- `--day` / `--week` snap to midnight in that zone, regardless of where the
  script runs (your laptop, a Frankfurt server, a us-east-1 cron).
- `--from 2026-05-05 --to 2026-05-06` includes **all of May 5 and May 6** in
  that zone (inclusive end-of-day on `--to`).
- All transaction timestamps in the console, Markdown, and HTML reports show
  wall-clock time in that zone — so a card payment at 20:14 in Stockholm
  shows as `20:14`, not the underlying UTC `18:14`.

If you want to override per-run: `REPORT_TZ=Europe/London npm run report -- --week`.

Transaction times always come from `created_at` (auth time / when you tapped),
not `completed_at` (settlement time, which can be hours later for online card
payments).

---

## Smart mode (`--smart`)

Runs every transaction through a 4-stage pipeline and emits a clean HTML report
grouped by category. Use it for owner-facing weekly/monthly reviews.

```bash
npm run report -- --week --smart
npm run report -- --from 2026-04-01 --to 2026-05-01 --smart
```

Adds a fourth artifact:

- **HTML**: `./reports/revolut-<period>-<timestamp>.html` — Linear/Stripe-styled,
  self-contained (inline CSS, no JS, no external assets), opens in any browser.
  Sections: KPI cards (Outgoing / Incoming / Net), outgoing-by-category,
  incoming, declined.

### How it works

```
Revolut /transactions
        │
        ▼
1. Preprocess        partition + EUR-normalize (FX via Frankfurter)
        │
        ▼
2. Resolve           cache hit OR one batched Claude Opus 4.7 call
        │
        ▼
3. Aggregate         deterministic TS — grouping, totals, share-of-spend %
        │
        ▼
4. Render HTML       template literals + inline CSS, one self-contained file
```

**Hard rules:**
- The LLM does zero math. It only labels merchants. All sums, percentages,
  and FX conversions are deterministic Node code.
- All amounts shown in EUR; native currency preserved alongside.
- Internal currency exchanges (`exchange` transactions) and own-account
  transfer legs are dropped — they're noise for spend reporting.
- Declined transactions are tracked in their own section; never folded
  into spend totals.
- Categories are a fixed enum: `ad_platforms`, `saas_subscriptions`,
  `suppliers`, `contractors_payroll`, `other`. Always emitted in that order.
  Enforced via Anthropic structured outputs — Claude literally cannot
  invent a new category.

### One-time setup for `--smart`

1. Get a Claude API key from <https://console.anthropic.com>.
2. Add to `.env`:
   ```ini
   ANTHROPIC_API_KEY=sk-ant-…
   ```
3. (Optional) Pre-seed `data/merchants.json` with merchants you already know.
   The repo ships with a seed entry for **Sourceinbox** (categorized as
   `suppliers` with `manual_override: true`).

That's it. First smart run on a cold cache may take 30-60s while the LLM
categorizes every distinct merchant; subsequent runs are near-instant
because everything is cached.

### Editing categorizations

`data/merchants.json` is the **source of truth**. To fix a miscategorization:

1. Open `data/merchants.json`.
2. Find the merchant, change its `category`, and set `manual_override: true`.
3. Re-run the report. The pipeline will never re-ask the LLM about a
   `manual_override` entry — your edit sticks forever.

If you want to merge two canonicals (the LLM created `Meta Ads` AND `Meta`),
delete the duplicate and move its `aliases` into the keeper.

### Caches (committed by default)

- `data/merchants.json` — merchant labels + aliases, owner-editable.
- `data/fx-cache.json` — ECB historical rates per `(date, from, to)` from
  [Frankfurter](https://api.frankfurter.dev). Public data, immutable, makes
  reruns instant.

Both are safe to commit (no secrets). If you'd rather keep them private,
move them to `.secrets/` and set `MERCHANTS_CACHE_PATH` and `FX_CACHE_PATH`
in `.env`.

### Running on a cron / server

Once bootstrap is done, just keep `.secrets/` (private key + token cache) on
the box and schedule:

```cron
# Daily report at 23:55 local
55 23 * * *  cd /opt/scandi-revolut-expenses && npm run report -- --day

# Weekly report Monday 08:00 covering the previous week
0  8  * * 1  cd /opt/scandi-revolut-expenses && npm run report -- --last-week
```

The TokenManager refreshes the access token only when it has <60s of life
left, persists the rotated refresh token back to the cache, and is
concurrency-safe (parallel calls share one in-flight refresh). On a 401, the
HTTP layer force-refreshes once and retries.

---

## Project layout

```
src/
  index.ts                       # report CLI (uses pipeline/run.ts)
  auth-cli.ts                    # `auth:url`, `auth:exchange`, `auth:check`
  config.ts                      # env loading (auth + reporting + API + smart-mode)
  server/                        # HTTP API
    index.ts                     # entrypoint (`npm run serve` / `npm start`)
    app.ts                       # Hono routes + format dispatch
    auth.ts                      # bearer / X-API-Key middleware
  revolut/
    auth.ts                      # TokenManager: signs JWT, refreshes, caches
    client.ts                    # axios + auto-bearer interceptor + 401-retry
    types.ts                     # subset of the Business API schema
  reporting/
    summary.ts                   # fast-path aggregates (CSV/MD/console)
    console.ts                   # colored tables
    csv.ts                       # one-row-per-leg CSV (renderer + writer)
    markdown.ts                  # markdown summary (renderer + writer)
  pipeline/                      # --smart mode (LLM-categorized HTML)
    run.ts                       # shared pipeline used by CLI and API
    fx.ts                        # Frankfurter FX client + per-date cache
    preprocess.ts                # Stage 1: partition + EUR-normalize
    merchantsCache.ts            # merchants.json reader/writer + reverse lookup
    resolver.ts                  # Stage 2: cache hit-or-LLM batch resolve
    aggregator.ts                # Stage 3: deterministic category math
    html.ts                      # Stage 4: clean HTML render
  prompts/
    merchantResolver.ts          # Claude Opus 4.7 call w/ structured outputs
  utils/
    dates.ts                     # day/week helpers, tz-aware
data/
  merchants.json                 # merchant cache (committed, owner-editable)
  fx-cache.json                  # ECB FX rate cache (committed)
docs/
  API.md                         # HTTP API reference + deployment guide
.do/
  app.yaml                       # DigitalOcean App Platform spec
Dockerfile                       # production container (`docker build .`)
```

## Notes on the Revolut data model

- A **transaction** is the ledger movement (transfer, card payment, exchange,
  fee, refund, …). One transaction has one or more **legs**, one leg per
  account touched. Internal transfers and FX between your own accounts have
  two legs that net to zero — we exclude them from the directional totals.
- The Revolut **Expenses** product is a layer on top of outbound transactions
  (receipts, approvals, categories). For "where did our money go" reporting
  the `/transactions` endpoint is the right primitive — it sees every payment
  whether or not someone has filed it as an expense in the UI.
- `/transactions` returns up to 1000 items sorted DESC by `created_at`.
  To page back you call again with `to` set to the `created_at` of the last
  item from the previous page. Done automatically here.
