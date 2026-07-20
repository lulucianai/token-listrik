# AGENTS.md — token-listrik

Guidance for AI coding agents (Grok / Claude / Cursor / etc.) working in this repo.

## What this project is

**token-listrik** — CLI to automate AI API credential setup and import into a local OpenAI-compatible router.

Fork / extension of **[bercocok-tanam](https://github.com/fzrilsh/bercocok-tanam)** by [@fzrilsh](https://github.com/fzrilsh) (credit required; do not remove attribution).

| Layer | Tech |
|-------|------|
| Browser OAuth flows | Puppeteer + stealth (`src/browser.js`) |
| Hardened signup automation | Camoufox / Playwright (`src/camoufox.js`) |
| CLI menu | Inquirer + ora (`index.js`) |
| Local router backend | REST API (auth cookie) |

## Repo layout (important paths)

```
token-listrik/
├── index.js                 # Interactive menu (npm start)
├── src/
│   ├── aisa.js              # AISA farm (Camoufox + tempmail → 9Router)
│   ├── yunwu.js             # Yunwu farm (NewAPI + tempmail + go-captcha → 9Router)
│   ├── grok.js              # Grok farm / login + 9Router inject
│   ├── kiro.js / cloudflare.js / codebuddy.js / tokengo.js / zyloo.js
│   ├── tempmail.js          # Tempmail client (session / inbox / poll OTP)
│   ├── router-api.js        # 9Router login + authenticated fetch
│   ├── router-inject.js     # Grok browser OAuth inject into 9Router
│   ├── camoufox.js          # Camoufox launch (geoip default OFF)
│   ├── browser.js           # Puppeteer + conditional proxy (Codebuddy)
│   └── config.js            # .env loader
├── workers/tempmail/        # Self-hosted CF Email Worker (see README there)
├── AGENTS.md                # This file
├── docs/PROGRESS.md         # Session / feature progress log
└── .env                     # LOCAL ONLY — never commit secrets
```

## Hard rules

1. **Never commit** `.env`, passwords, 9Router tunnels, API keys, `*_keys.txt`, `accounts.txt`, cookies, screenshots of live sessions.
2. **9Router API** on require-login deployments needs `POST /api/auth/login` → cookie `auth_token`. Use `src/router-api.js` (`routerApiFetch`), not bare `fetch` to `/api/*`.
3. **Do not hardcode** user `ROUTER_URL` / `ROUTER_PASSWORD` / personal tunnels in source. Defaults: `http://127.0.0.1:20128/` + env.
4. **Tempmail**: use managed `tempmail.adrnode.com` with `TEMPMAIL_API_KEY=tm_...` in `.env` only (never hardcode keys in source). Client matches friend `grok_farm.js`: `x-api-key`, create inbox with `{ domain }` only, messages array or `{ messages }`. Fallback self-host: `workers/tempmail`.
5. **Camoufox `geoip`**: keep default **false** unless a valid MaxMind MMDB is installed (broken DB → `Invalid Extended Type at offset 0 val 7`).
6. **Preserve** AISA / Yunwu / Grok / Zyloo / Camoufox features when syncing from upstream bercocok-tanam.
7. **Upstream sync**: `git fetch upstream` from `https://github.com/fzrilsh/bercocok-tanam.git` — port only shared modules (kiro, cf, codebuddy, tokengo, browser, utils); re-apply token-listrik patches (router-api auth, etc.).

## Config (.env)

```env
ROUTER_URL=http://127.0.0.1:20128/
ROUTER_PASSWORD=...
PW_HEADLESS=1
BROWSER_COUNT=1
FARM_COUNT=1

# Tempmail — adrnode OR CF worker
TEMPMAIL_API=https://.../api
TEMPMAIL_API_KEY=
TEMPMAIL_DOMAINS=yourdomain.com
```

See `.env.example` and `docs/PROGRESS.md`.

## Common commands

```bash
# Menu (bercocok-tanam style)
npm start

# AISA farm N accounts → file + 9Router inject
node -e 'require("./src/aisa").runAisaAutomation(N, { signupOnly: false })'

# Test tempmail only
node -e 'require("./src/tempmail").createTempmail().then(console.log).catch(e=>console.error(e.message))'

# Install (AISA/Grok only need Camoufox; skip Chrome download if flaky)
PUPPETEER_SKIP_DOWNLOAD=1 npm install
npx camoufox-js fetch
```

## Provider notes

| Mode | Engine | Accounts | 9Router |
|------|--------|----------|---------|
| Kiro / CF / Codebuddy / TokenGo / Zyloo | Puppeteer | `accounts.txt` `email\|password` | API / OAuth |
| AISA Farm | Camoufox | tempmail auto | openai-compatible `aisa` → `api.aisa.one/v1` |
| Yunwu Farm | Camoufox | tempmail auto | openai-compatible `yunwu` → `yunwu.ai/v1` (go-captcha click-shape on send-code) |
| Grok Farm / Login | Camoufox | tempmail / `result.txt` | Browser Grok CLI OAuth |

- **Codebuddy**: device-code API + Google login; **conditional proxy** (Google domains bypass proxy).
- **TokenGo**: affiliate chain (`aff_code`), random token name, `group: default`.
- **Zyloo**: Google OAuth only (no tempmail); free event often **1 account / IP**.
- **AISA default model** (code): `deepseek-v4-pro` (syncs models into 9Router custom list after inject).
- **Yunwu default model** (code): `deepseek-v4-pro`; base `https://yunwu.ai/v1`. Captcha is **go-captcha click-shape** (headed solve).

## Outputs (do not commit)

| File | Content |
|------|---------|
| `aisa_keys.txt` | `email\|sk-aisa-...` |
| `apikey.txt` | key only (legacy) |
| `aisa_account.json` | metadata + status |
| `yunwu_keys.txt` | `email\|api-key` |
| `yunwu_account.json` | username/password + status |
| `zyloo_keys.txt` | `email\|sk-zy-...` |
| `result.txt` | Grok `email:password` |
| `logs/` | run logs |

## Upstream bercocok-tanam

- Remote: `https://github.com/fzrilsh/bercocok-tanam.git`
- Last notable ports: TokenGo affiliate, Codebuddy API device-code, conditional proxy, UI checkbox, proxy cooldown 60s, TokenGo random name.
- **Not** re-adding Webshare `proxy.js` automation (removed upstream from menu; orphan file may remain upstream).

## Docs map

| Doc | Purpose |
|-----|---------|
| `AGENTS.md` | Agent rules (this file) |
| `docs/PROGRESS.md` | Feature/session progress |
| `docs/TEMPMAIL.md` | Tempmail status + CF worker setup pointer |
| `docs/9ROUTER.md` | Auth, inject patterns, AISA models |
| `workers/tempmail/README.md` | Deploy CF Email Worker |
| `README.md` | User-facing product README |

## When unsure

- Prefer reading `docs/PROGRESS.md` before large refactors.
- Keep ESLint 4-space indent for new code where practical.
- User-facing CLI strings in **English**.
