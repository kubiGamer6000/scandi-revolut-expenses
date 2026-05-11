# Deployment — DigitalOcean droplet (alongside `scandi-wa-bot` + `scandi-jarvis`)

End-to-end guide for running **`scandi-revolut-expenses`** on the same Ubuntu
droplet that already hosts `scandi-wa-bot` and `scandi-jarvis`. Production-ready:
systemd-supervised, journald logs, atomic deploys, helper shell function
(`revolut ...`) for daily ops.

The API is **stateful on disk in exactly one place** — the rotating Revolut
OAuth `token-cache.json` plus the FX + merchants caches. We mount that one
directory (`/opt/scandi-revolut-expenses/.secrets` + `data/`) on the droplet
and back it up nightly. Everything else (built `dist/`, `node_modules/`) is
disposable; rebuild from this guide and `git clone` and you're back in
minutes.

What runs in a single Node process (`dist/server/index.js`):

- Hono HTTP server on `127.0.0.1:8080`, routes:
  - `GET  /health` (public on loopback) — liveness + env summary.
  - `GET  /v1/info` (bearer-authed) — capability discovery.
  - `GET  /v1/report` (bearer-authed) — JSON / CSV / Markdown / HTML reports.
- An on-demand Revolut OAuth client that auto-refreshes its access token
  using the rotating refresh token in `.secrets/token-cache.json`.
- Optional Anthropic-backed "smart" merchant categorisation (only when
  `?smart=true` is requested).

systemd supervises the whole thing as one unit. No worker, no queue, no
background jobs — every report is generated synchronously per request.

**Assumptions:** you have already followed `scandi-wa-bot`'s
`docs/DEPLOYMENT.md` §§1-8 on this droplet (host hardening, `scandi` user,
Node 20, swap, fail2ban, ufw, the bot itself), and Jarvis is also installed
per `scandi-jarvis/docs/DEPLOYMENT.md`. This doc only covers what's new for
the Revolut API.

---

## 1. Prerequisites already on the droplet

| From the wa-bot / jarvis deployments | What we reuse                                                            |
| ------------------------------------ | ------------------------------------------------------------------------ |
| Ubuntu 24.04 + hardening             | Same host.                                                               |
| `scandi` user + ssh keys             | Same user runs all three services.                                       |
| Node 20 (NodeSource)                 | `/usr/bin/node` works for this too.                                      |
| ufw + DO Cloud Firewall              | No new inbound ports needed — Jarvis (and you, via `curl`) reach the API on `127.0.0.1`. |
| systemd + journald                   | Add one more unit; nothing else changes.                                 |
| journald retention                   | The `SystemMaxUse=500M`, `MaxRetentionSec=30day` already configured covers this service too. |

Nothing new in the firewall: the API binds to `127.0.0.1:8080` (see
[§3.1](#31-clone)). `scandi-jarvis` calls it via
`REVOLUT_EXPENSES_API_BASE_URL=http://127.0.0.1:8080` over the loopback
interface, exactly the same shape as Jarvis ↔ wa-bot.

---

## 2. Outbound network requirements

Outbound 443 to:

- `b2b.revolut.com` (production) **or** `sandbox-b2b.revolut.com` (sandbox) —
  Revolut Business API + OAuth token endpoint.
- `api.frankfurter.dev` — FX rate lookups (free, no auth).
- `api.anthropic.com` — model calls for smart-mode categorisation (only
  when reports are requested with `?smart=true`).

All already allowed by the bot's outbound-any rule.

---

## 3. Install the app

### 3.1 Clone

```bash
sudo mkdir -p /opt/scandi-revolut-expenses
sudo chown scandi:scandi /opt/scandi-revolut-expenses

# As scandi:
cd /opt
sudo -u scandi git clone https://github.com/<you>/scandi-revolut-expenses.git
cd scandi-revolut-expenses

# Full deps (devDeps are needed for tsc).
sudo -u scandi npm ci

# TS → JS into ./dist
sudo -u scandi npm run build
```

> Don't run `npm prune --omit=dev`. The total `node_modules` footprint is
> ~120 MB (no Baileys, no Genkit, no LangGraph) — not worth trimming, and
> we use `tsx` for the auth CLI when you eventually need to rotate keys.

The patched `src/server/index.ts` reads `HOST` from env (defaulting to
`127.0.0.1`), so the API is **never** publicly reachable on the droplet
unless you explicitly set `HOST=0.0.0.0`.

### 3.2 Provision secrets + caches (one-time)

The Revolut auth setup is interactive (cert upload + browser auth-code
exchange) and was already done locally. Just **scp the working artifacts**
to the droplet — don't redo the OAuth flow there.

From your laptop:

```bash
# Replace <droplet> with your droplet host / Tailscale name / etc.
ssh scandi@<droplet> 'mkdir -p /opt/scandi-revolut-expenses/.secrets /opt/scandi-revolut-expenses/data && chmod 700 /opt/scandi-revolut-expenses/.secrets'

# The private key paired with the cert you uploaded to Revolut.
scp .secrets/privatecert.pem  scandi@<droplet>:/opt/scandi-revolut-expenses/.secrets/

# The rotating token cache (initial refresh + access tokens).
# IMPORTANT: pick the LATEST one — Revolut rotates the refresh token on
# every refresh, so an outdated cache file = invalid_grant on first call.
scp .secrets/token-cache.json scandi@<droplet>:/opt/scandi-revolut-expenses/.secrets/
```

Then on the droplet:

```bash
sudo chown -R scandi:scandi /opt/scandi-revolut-expenses/.secrets /opt/scandi-revolut-expenses/data
sudo chmod 700 /opt/scandi-revolut-expenses/.secrets
sudo chmod 600 /opt/scandi-revolut-expenses/.secrets/*
```

Existing FX / merchants caches are *optional* — they'll regenerate on first
use. Copy them too if you want to skip the cold-start hit:

```bash
scp data/fx-cache.json   scandi@<droplet>:/opt/scandi-revolut-expenses/data/
scp data/merchants.json  scandi@<droplet>:/opt/scandi-revolut-expenses/data/
```

### 3.3 `.env`

```bash
cd /opt/scandi-revolut-expenses
sudo -u scandi cp .env.example .env
sudo -u scandi nano .env
sudo chmod 600 .env
sudo chown scandi:scandi .env
```

Required vars for production:

| Var                          | Notes                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `REVOLUT_BASE_URL`           | `https://b2b.revolut.com/api/1.0` for production. Default in `.env.example` is **sandbox** — change it. |
| `REVOLUT_CLIENT_ID`          | Shown in the Revolut Business app under **Settings → APIs → Business API**.                             |
| `REVOLUT_PRIVATE_KEY_PATH`   | `/opt/scandi-revolut-expenses/.secrets/privatecert.pem` (absolute path).                                |
| `REVOLUT_JWT_ISSUER`         | The OAuth redirect domain you registered in the Revolut dashboard.                                      |
| `REVOLUT_TOKEN_CACHE`        | `/opt/scandi-revolut-expenses/.secrets/token-cache.json` (absolute, writable by `scandi`).              |
| `API_KEYS`                   | One or more bearer tokens. **The server refuses to start if empty.** Generate one with `openssl rand -hex 32`. Comma- or whitespace-separated for rotation. |
| `HOST`                       | `127.0.0.1` (default — see §3.1). Leave unset on the droplet.                                           |
| `PORT`                       | `8080` (default). Leave unset unless something else on the droplet has claimed 8080.                    |

Recommended optional vars:

| Var                          | Why                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`          | Required for `?smart=true` reports (i.e. the HTML format used by the Jarvis Revolut workflow).       |
| `REPORT_TZ`                  | `Europe/Stockholm` (default). Anchors `today` / `yesterday` / `this-week` boundaries to wall-clock.  |
| `DATA_DIR`                   | If you want to relocate FX + merchants caches outside the repo (e.g. `/var/lib/scandi`).             |

> **Initial refresh-token seeding.** You don't need
> `REVOLUT_REFRESH_TOKEN` if `token-cache.json` is already present — the
> auth client reads the cache first and only falls back to the env var to
> seed an empty cache. Leave the env var blank in production.

### 3.4 systemd unit

Create `/etc/systemd/system/scandi-revolut-expenses.service`:

```ini
[Unit]
Description=scandi-revolut-expenses — Revolut Business reports HTTP API (Hono)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=scandi
Group=scandi
WorkingDirectory=/opt/scandi-revolut-expenses
EnvironmentFile=/opt/scandi-revolut-expenses/.env
ExecStart=/usr/bin/node dist/server/index.js

# Auto-restart on any exit. We exit non-zero on missing API_KEYS / bad
# auth config so a restart loop here either self-heals or is loud enough
# to investigate quickly.
Restart=always
RestartSec=5

# Don't restart-storm if something's catastrophically broken.
StartLimitIntervalSec=300
StartLimitBurst=10

# Run unprivileged + sandboxed.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
# .secrets/token-cache.json is rotated on every refresh, and data/ holds
# the FX + merchants caches — both must be writable.
ReadWritePaths=/opt/scandi-revolut-expenses
ProtectKernelTunables=true
ProtectKernelLogs=true
ProtectControlGroups=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true

# Reports for a year of weekly data fit comfortably under 256 MB; smart
# mode briefly spikes during LLM calls. 768 MB is generous headroom.
MemoryMax=768M
TasksMax=256

# Logs go to journald.
StandardOutput=journal
StandardError=journal
SyslogIdentifier=scandi-revolut-expenses

[Install]
WantedBy=multi-user.target
```

Enable + start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable scandi-revolut-expenses
sudo systemctl start  scandi-revolut-expenses
sudo systemctl status scandi-revolut-expenses --no-pager
```

You should see:

```
▶ revolut-reports API listening on http://127.0.0.1:8080
  env=production · tz=Europe/Stockholm · auth=auto-refresh · keys=1 · smart=enabled
```

### 3.5 Passwordless restart / status / logs

**Edit (don't replace) the existing file** so all three services share one
sudoers entry:

```bash
sudo visudo -f /etc/sudoers.d/scandi-deploy
```

Append the new lines (the `scandi-wa-bot` and `scandi-jarvis` rules are
already there from previous deployments):

```
scandi ALL=(root) NOPASSWD: /bin/systemctl start scandi-wa-bot, \
                            /bin/systemctl stop scandi-wa-bot, \
                            /bin/systemctl restart scandi-wa-bot, \
                            /bin/systemctl status scandi-wa-bot, \
                            /bin/systemctl start scandi-jarvis, \
                            /bin/systemctl stop scandi-jarvis, \
                            /bin/systemctl restart scandi-jarvis, \
                            /bin/systemctl status scandi-jarvis, \
                            /bin/systemctl start scandi-jarvis-cron.timer, \
                            /bin/systemctl stop scandi-jarvis-cron.timer, \
                            /bin/systemctl restart scandi-jarvis-cron.timer, \
                            /bin/systemctl status scandi-jarvis-cron.timer, \
                            /bin/systemctl start scandi-jarvis-workflow*, \
                            /bin/systemctl stop scandi-jarvis-workflow*, \
                            /bin/systemctl restart scandi-jarvis-workflow*, \
                            /bin/systemctl status scandi-jarvis-workflow*, \
                            /bin/systemctl enable scandi-jarvis-workflow*, \
                            /bin/systemctl disable scandi-jarvis-workflow*, \
                            /bin/systemctl start scandi-revolut-expenses, \
                            /bin/systemctl stop scandi-revolut-expenses, \
                            /bin/systemctl restart scandi-revolut-expenses, \
                            /bin/systemctl status scandi-revolut-expenses, \
                            /bin/systemctl reload caddy, \
                            /bin/systemctl restart caddy, \
                            /bin/systemctl status caddy, \
                            /bin/journalctl -u scandi-wa-bot *, \
                            /bin/journalctl -u scandi-jarvis *, \
                            /bin/journalctl -u scandi-jarvis-cron *, \
                            /bin/journalctl -u scandi-jarvis-workflow*, \
                            /bin/journalctl -u scandi-revolut-expenses *, \
                            /bin/journalctl -u caddy *
```

Save and exit. Now every `revolut ...` / `jarvis ...` / `bot ...` command
runs without a sudo prompt.

---

## 4. The `revolut` helper (paste into `~/.bashrc`)

Mirrors the `bot` and `jarvis` helpers.

```bash
nano ~/.bashrc
```

Add at the bottom:

```bash
# ───── scandi-revolut-expenses helpers ─────
revolut() {
  case "$1" in
    logs)    sudo journalctl -u scandi-revolut-expenses -f -o cat ;;
    raw)     sudo journalctl -u scandi-revolut-expenses -f ;;
    tail)    sudo journalctl -u scandi-revolut-expenses -n "${2:-100}" --no-pager -o cat ;;
    errors)  sudo journalctl -u scandi-revolut-expenses -p warning -n "${2:-50}" --no-pager ;;
    since)   sudo journalctl -u scandi-revolut-expenses --since "$2" -o cat ;;
    boot)    sudo journalctl -u scandi-revolut-expenses -b -o cat ;;
    grep)    sudo journalctl -u scandi-revolut-expenses -f -o cat | grep --color=auto -i "$2" ;;

    status)  sudo systemctl status scandi-revolut-expenses --no-pager ;;
    start)   sudo systemctl start scandi-revolut-expenses ;;
    stop)    sudo systemctl stop scandi-revolut-expenses ;;
    restart) sudo systemctl restart scandi-revolut-expenses ;;
    deploy)  /opt/scandi-revolut-expenses/scripts/deploy.sh ;;

    health)  curl -fsS http://127.0.0.1:8080/health | jq . ;;
    info)
      local key
      key=$(grep ^API_KEYS= /opt/scandi-revolut-expenses/.env | cut -d= -f2- | awk '{print $1}')
      curl -fsS -H "Authorization: Bearer $key" http://127.0.0.1:8080/v1/info | jq .
      ;;

    report)
      # Convenience: hit /v1/report with sane defaults. Pass extra query
      # params like:  revolut report 'period=last-week&format=md&smart=true'
      local key qs
      key=$(grep ^API_KEYS= /opt/scandi-revolut-expenses/.env | cut -d= -f2- | awk '{print $1}')
      qs="${2:-period=yesterday&format=md&smart=true}"
      curl -fsS -H "Authorization: Bearer $key" "http://127.0.0.1:8080/v1/report?${qs}"
      ;;

    *)
      cat <<EOF
usage: revolut <command>

logs / raw           live tail (pretty / plain)
tail [N]             last N lines (default 100)
errors [N]           warnings + errors only
since "<time>"       e.g. revolut since "10 min ago"
boot                 everything since last service start
grep "<pattern>"     live tail filtered (case-insensitive)

status               systemctl status
start | stop | restart
deploy               git pull → npm ci → build → restart

health               GET /health           (no auth)
info                 GET /v1/info          (auto-uses first API key)
report [QUERY]       GET /v1/report?QUERY  (default: yesterday, MD, smart)
EOF
      ;;
  esac
}
```

Reload your shell:

```bash
source ~/.bashrc
```

---

## 5. Wire Jarvis up to use it

The Jarvis-side env vars for the Revolut workflow point at this loopback
API. In `/opt/scandi-jarvis/.env`:

```bash
REVOLUT_EXPENSES_API_BASE_URL=http://127.0.0.1:8080
REVOLUT_EXPENSES_API_KEY=<one-of-the-API_KEYS-from-revolut-.env>
WORKFLOW_REVOLUT_CHAT_JID=<groupchat-or-DM-jid>
# OR fall back to the catch-all default:
JARVIS_WORKFLOWS_DEFAULT_CHAT_JID=<chat-jid>
```

Then restart Jarvis (so the env loader re-reads):

```bash
jarvis restart
```

Sanity check end-to-end without waiting for midnight:

```bash
# 1. The API itself is healthy and the bearer key works.
revolut health
revolut info

# 2. Jarvis can reach + authenticate against it, generate the report,
#    and ship it via the bot.
jarvis workflow run revolut-daily-expenses
jarvis workflow tail revolut-daily-expenses 80
```

You should see the WhatsApp message + HTML attachment land in the
configured chat.

---

## 6. Deploying updates

Same flow as the others:

```bash
revolut deploy
```

Under the hood (`/opt/scandi-revolut-expenses/scripts/deploy.sh`):

1. `git fetch origin main` — bail out if nothing changed.
2. `git pull --ff-only`.
3. `npm ci` — **only** if `package-lock.json` changed (saves 30-60s on
   code-only deploys).
4. `npm run build`.
5. `sudo systemctl restart scandi-revolut-expenses`.
6. Quick `/health` ping, then tail the journal.

The Hono server binds in `<200ms`, so the only externally-visible blip is
a brief `connection refused` window for any in-flight call. Jarvis's
workflow runner (the only real consumer) treats this as a transient and
retries — but if you want zero-downtime, stagger `revolut deploy` and
`jarvis workflow run revolut-daily-expenses`.

---

## 7. Healthchecks

### `GET /health` (loopback, no auth)

```bash
revolut health
# {
#   "status": "ok",
#   "timezone": "Europe/Stockholm",
#   "environment": "production",
#   "auth_mode": "auto-refresh"
# }
```

`environment` reflects which `REVOLUT_BASE_URL` is set.
`auth_mode:auto-refresh` confirms the OAuth client is initialised (i.e.
`token-cache.json` was loaded successfully). `static` means
`REVOLUT_ACCESS_TOKEN` is set — fine for local dev, **wrong** in prod
(token expires every 40 min).

### Real-call check

```bash
revolut info
# {"service":"revolut-expense-reports","version":1,…}

# An actual report call exercises the full auth + Revolut + FX path.
revolut report 'period=yesterday&format=json'
```

If you see `401 Unauthorized` from Revolut buried in the response, the
refresh token in `.secrets/token-cache.json` is stale (e.g. someone
revoked it in the dashboard). Re-run `npm run auth:exchange` locally,
re-scp the resulting cache, restart.

### Off-host monitoring

We deliberately don't expose this API over Caddy (no public route). If
you want UptimeRobot / Healthchecks.io coverage:

- Add a `cron` job on the droplet that hits `revolut health` every 5
  min and pushes to a Healthchecks.io ping URL on success, **OR**
- Add a Caddy route under `revolut.example.com` that proxies **only**
  `/health` from a hostname you own:

```caddyfile
revolut.example.com {
    @health path /health
    reverse_proxy @health 127.0.0.1:8080
    handle {
        respond "Not found" 404
    }
}
```

Most teams skip both — the Jarvis workflow's nightly run is the de-facto
canary; if it fails, you get a journald alert (and no expense report in
WhatsApp) within 24h.

---

## 8. Logs

Everything goes through journald, same as the bot + Jarvis:

```bash
revolut logs                   # live tail
revolut tail 200               # last 200 lines
revolut grep "Bearer"          # live filter (case-insensitive)
revolut since "5 min ago"      # window
revolut errors                 # warn + error only
revolut boot                   # since last restart
```

### What you'll actually see

Per request (Hono's built-in logger):

```
▶ revolut-reports API listening on http://127.0.0.1:8080
  env=production · tz=Europe/Stockholm · auth=auto-refresh · keys=1 · smart=enabled
  --> GET /health
  <-- GET /health 200 0ms
  --> GET /v1/report?period=yesterday&format=html&smart=true
[auth] refreshed access_token (expires_in=2400s)
  <-- GET /v1/report?period=yesterday&format=html&smart=true 200 543ms
```

Failed Revolut calls show up as `[revolut] http 401 …` followed by Hono's
`<-- ... 500` line — in practice this is almost always a stale refresh
token (see [§7](#real-call-check)).

---

## 9. Troubleshooting

| Symptom                                                                                | Likely cause                                                                                       | Fix                                                                                                                       |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Service refuses to start: `✗ API_KEYS env var is empty`.                               | You forgot `API_KEYS=` in `.env`.                                                                  | `openssl rand -hex 32 >> /tmp/k && cat /tmp/k` then paste into `.env` and `revolut restart`.                              |
| Service refuses to start: `Could not read REVOLUT_PRIVATE_KEY_PATH`.                   | The key file isn't there or `scandi` can't read it.                                                | Check `ls -l /opt/scandi-revolut-expenses/.secrets/` — must be `scandi:scandi` and 0600 / 0700 on the dir.                |
| Service starts but every call returns `500 invalid_grant` from Revolut.                | The refresh token in `.secrets/token-cache.json` is older than the latest one Revolut issued.      | On your laptop, run `npm run auth:check`; if needed `npm run auth:exchange`; scp the new `token-cache.json`; restart.     |
| Reports always return `0 transactions`.                                                | You're pointed at sandbox by accident — `REVOLUT_BASE_URL=https://sandbox-b2b.revolut.com/api/1.0`. | Switch to `https://b2b.revolut.com/api/1.0`, restart.                                                                     |
| `?smart=true` returns 400 even though you set `ANTHROPIC_API_KEY`.                     | Env var didn't load (e.g. typo in `.env` line, or you set it after the unit started).              | `revolut info` — `smart_mode_available:true` confirms the key is live. If `false`, fix `.env` and `revolut restart`.      |
| `?format=html` returns 400 `HTML output requires smart=true`.                          | The HTML renderer reuses the smart-categorised output.                                             | Add `&smart=true` to the URL (the Jarvis workflow already does).                                                          |
| Caddy / port 80 is open but `revolut health` fails from another host.                  | Working as designed — `HOST=127.0.0.1` means loopback only.                                        | If you really want public access, add a Caddy route as in [§7](#off-host-monitoring) and protect with `basic_auth` / IP ACL. |
| `MemoryMax=768M` killed the service mid-call.                                          | Smart mode on a very long period (months of data) blew the cap.                                    | Edit the unit, bump to `1500M`, `daemon-reload`, restart.                                                                 |
| Jarvis workflow logs `RevolutExpensesHttpError: 401 unauthorized`.                     | `REVOLUT_EXPENSES_API_KEY` in Jarvis's `.env` doesn't match any of the keys in this service's `API_KEYS`. | Copy a real key from `/opt/scandi-revolut-expenses/.env`, paste into `/opt/scandi-jarvis/.env`, `jarvis restart`.    |

---

## 10. Backups

Same pattern as the bot and Jarvis — most state is reproducible. The one
piece that *isn't* lives on the droplet:

| Data                                | Where                                                                | Backed up by                            |
| ----------------------------------- | -------------------------------------------------------------------- | --------------------------------------- |
| Revolut OAuth refresh token (rotating) | `/opt/scandi-revolut-expenses/.secrets/token-cache.json`            | **You** — daily snapshot to off-droplet (S3 / restic).  |
| Private key                         | `/opt/scandi-revolut-expenses/.secrets/privatecert.pem`              | **You** — keep a copy in your password manager.         |
| FX cache                            | `/opt/scandi-revolut-expenses/data/fx-cache.json`                    | (regenerable — no backup needed)        |
| Merchants cache (LLM categorisation) | `/opt/scandi-revolut-expenses/data/merchants.json`                  | (regenerable, but slow + costs money — back up if smart mode is hot path) |
| `.env`                              | `/opt/scandi-revolut-expenses/.env`                                  | **You** — password manager copy.        |

A rough nightly backup using the existing droplet `scandi` user:

```bash
# Add to scandi's crontab (`crontab -u scandi -e`):
30 2 * * * tar -C /opt/scandi-revolut-expenses -czf - .secrets data .env \
  | aws s3 cp - s3://scandi-droplet-backups/revolut-$(date +\%F).tar.gz
```

(Use whichever object store you already use for the bot's nightly DB
dumps — same credentials, same bucket.)

> **Why no `wa.*`-style migrations?** This service has no database of
> its own. Reports are computed on-the-fly from the Revolut API; the
> only persistence is the three JSON files above.

---

## 11. (Optional) GitHub Actions deploy

The wa-bot and jarvis Actions workflows already target this droplet.
Mirror the pattern in this repo at `.github/workflows/deploy.yml`:

```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1
        with:
          host:     ${{ secrets.DROPLET_HOST }}
          username: scandi
          key:      ${{ secrets.DROPLET_SSH_KEY }}
          script:   /opt/scandi-revolut-expenses/scripts/deploy.sh
```

Reuse the same `DROPLET_HOST` and `DROPLET_SSH_KEY` secrets.

---

## TL;DR — copy/paste path

```bash
# ── 1. install (as scandi) ─────────────────────────────────────────────
sudo mkdir -p /opt/scandi-revolut-expenses && sudo chown scandi:scandi /opt/scandi-revolut-expenses
cd /opt && git clone https://github.com/<you>/scandi-revolut-expenses.git
cd scandi-revolut-expenses && npm ci && npm run build

# ── 2. secrets + caches (from your laptop) ─────────────────────────────
ssh scandi@<droplet> 'mkdir -p /opt/scandi-revolut-expenses/.secrets /opt/scandi-revolut-expenses/data && chmod 700 /opt/scandi-revolut-expenses/.secrets'
scp .secrets/privatecert.pem  scandi@<droplet>:/opt/scandi-revolut-expenses/.secrets/
scp .secrets/token-cache.json scandi@<droplet>:/opt/scandi-revolut-expenses/.secrets/

# Then on the droplet:
sudo chown -R scandi:scandi /opt/scandi-revolut-expenses/.secrets /opt/scandi-revolut-expenses/data
sudo chmod 600 /opt/scandi-revolut-expenses/.secrets/*

# ── 3. .env ────────────────────────────────────────────────────────────
cp .env.example .env && nano .env
#  Required:
#    REVOLUT_BASE_URL=https://b2b.revolut.com/api/1.0      # production!
#    REVOLUT_CLIENT_ID=…
#    REVOLUT_PRIVATE_KEY_PATH=/opt/scandi-revolut-expenses/.secrets/privatecert.pem
#    REVOLUT_JWT_ISSUER=…
#    REVOLUT_TOKEN_CACHE=/opt/scandi-revolut-expenses/.secrets/token-cache.json
#    API_KEYS=$(openssl rand -hex 32)
#  Recommended:
#    ANTHROPIC_API_KEY=…   # required for smart=true / HTML reports
chmod 600 .env

# ── 4. systemd ─────────────────────────────────────────────────────────
sudo nano /etc/systemd/system/scandi-revolut-expenses.service     # paste §3.4
sudo systemctl daemon-reload
sudo systemctl enable --now scandi-revolut-expenses

# ── 5. sudoers entry (extend §3.5) + helper function in ~/.bashrc ──────
sudo visudo -f /etc/sudoers.d/scandi-deploy                       # see §3.5
nano ~/.bashrc                                                    # paste `revolut()` from §4
source ~/.bashrc

# ── 6. wire Jarvis up ──────────────────────────────────────────────────
nano /opt/scandi-jarvis/.env
#   REVOLUT_EXPENSES_API_BASE_URL=http://127.0.0.1:8080
#   REVOLUT_EXPENSES_API_KEY=<one of API_KEYS>
#   WORKFLOW_REVOLUT_CHAT_JID=<chat-jid>
jarvis restart

# ── 7. smoke test ──────────────────────────────────────────────────────
revolut health
revolut info
revolut report 'period=yesterday&format=json'
jarvis workflow run revolut-daily-expenses
```

After this, the API is steady-state — restart-on-fail, journald-logged,
upgrade with `revolut deploy`. The nightly Jarvis workflow keeps you
honest about whether it actually works.
