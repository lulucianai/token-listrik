# ⚡ token-listrik

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16-brightgreen)](https://nodejs.org/)
[![Code Style: ESLint](https://img.shields.io/badge/code_style-ESLint-5e5ce6.svg)](https://eslint.org/)

CLI toolkit that harvests AI provider credentials and wires them into **[9Router](https://github.com/9router/9router)** so your stack stays powered — Kiro, Cloudflare Workers AI, Codebuddy, AISA, and Grok in one menu.

```
╔══════════════════════════════════════════════════════════╗
║                  ⚡ Token Listrik CLI                    ║
╠══════════════════════════════════════════════════════════╣
║  Router URL    : http://127.0.0.1:20128/                  ║
║  Engine        : Puppeteer (Google) + Camoufox (AISA/Grok)║
╚══════════════════════════════════════════════════════════╝

? Choose menu:
  1. 🔑 Kiro Automation
  2. ☁️  Cloudflare Automation
  3. 🤖 Codebuddy Automation [BETA]
  4. 🤖 AISA Farm (Camoufox)
  5. ⚡ Grok Farm (Camoufox + 9Router)
  6. 🔐 Grok Login + 9Router Inject
  7. 🚀 All-in-One (Kiro + CF + Codebuddy)
  8. ⚙️  Settings
  9. 🚪 Exit
```

## ✨ Features

| Mode | Engine | Account source | 9Router inject |
|------|--------|----------------|----------------|
| 🔑 **Kiro** | Puppeteer + Chrome | `accounts.txt` (Google) | API `POST /api/oauth/kiro/import` |
| ☁️ **Cloudflare** | Puppeteer + Chrome | `accounts.txt` (Google) | API `POST /api/providers` |
| 🤖 **Codebuddy** [BETA] | Puppeteer + Chrome | `accounts.txt` (Google) | Browser OAuth → CodeBuddy INT (residential proxy recommended) |
| 🤖 **AISA Farm** | Camoufox | Auto tempmail | File only for now (API hook coming) |
| ⚡ **Grok Farm** | Camoufox | Auto tempmail | Browser OAuth → Grok CLI provider |
| 🔐 **Grok Login** | Camoufox | `result.txt` / farmed accounts | Browser OAuth → Grok CLI provider |
| 🚀 **All-in-One** | Puppeteer | `accounts.txt` | Kiro + Cloudflare + Codebuddy in parallel |

Also included:

- Multi-worker parallel processing (Puppeteer modes via `BROWSER_COUNT`)
- Shared proxy pool with lock + 30-minute IP cooldown
- Per-worker progress bars and detailed run reports
- Account queue locking (safe Kiro + Cloudflare all-in-one)
- Interactive settings menu (router URL/password, headless, farm count, …)
- Failed-account log + optional retry for Google-based automations

## 📋 Requirements

- Node.js 16+
- **Chrome / Chromium** — for Kiro, Cloudflare, Codebuddy
- **Camoufox** (via `camoufox-js`) — for AISA / Grok (better Turnstile / WAF resistance)
- **9Router** running and reachable at `ROUTER_URL` (default `http://127.0.0.1:20128/`)
- Google accounts for Kiro / Cloudflare / Codebuddy (`email|password` in `accounts.txt`)

## 🚀 Installation

```bash
git clone https://github.com/lulucianai/token-listrik
cd token-listrik

npm install

# Google-based modes only
echo "email@example.com|password123" > accounts.txt

# Optional config
cp .env.example .env   # if present; or use Settings in the CLI
```

Start the unified menu:

```bash
npm start
```

```
1. 🔑 Kiro Automation
2. ☁️  Cloudflare Automation
3. 🤖 Codebuddy Automation [BETA]
4. 🤖 AISA Farm (Camoufox)
5. ⚡ Grok Farm (Camoufox + 9Router)
6. 🔐 Grok Login + 9Router Inject
7. 🚀 All-in-One (Kiro + CF + Codebuddy)
8. ⚙️  Settings
9. 🚪 Exit
```

## ⚙️ Configuration

Create a `.env` in the project root (or use **Settings** in the CLI):

```env
ROUTER_URL=http://127.0.0.1:20128/
ROUTER_PASSWORD=123456
PW_HEADLESS=1
BROWSER_COUNT=4
FARM_COUNT=1
BROWSER_SLOW_MO=2
CHROME_EXECUTABLE_PATH=
ACCOUNT_FILE=accounts.txt
RESULT_FILE={provider}_keys.txt
ERROR_ACCOUNT_FILE=errorAccounts.txt
PROXY_POOL_FILE=proxy_keys.txt
TEMPMAIL_API=https://tempmail.adrnode.com/api
TEMPMAIL_DOMAINS=adrnode.com,adrnode.web.id,aanyantok.my.id,foxsight.xyz,shitoors.fun
TURNSTILE_WAIT_TIMEOUT_MS=45000
EMAIL_POLL_TIMEOUT_MS=120000
EMAIL_POLL_INTERVAL_MS=5000
DELAY_BEFORE_NEXT_CLICK_MS=1000
DELAY_BETWEEN_ACCOUNTS_MS=3000
DELAY_BEFORE_BROWSER_CLOSE_MS=3000
DELAY_BEFORE_READING_COOKIES_MS=5000
TIMEOUT_NAVIGATION_MS=60000
TIMEOUT_DEFAULT_MS=15000
TIMEOUT_SHORT_MS=10000
```

| Variable | Description | Default |
|---|---|---|
| `ROUTER_URL` | 9Router base URL | `http://127.0.0.1:20128/` |
| `ROUTER_PASSWORD` | 9Router login password (Grok browser inject) | `123456` |
| `PW_HEADLESS` | `1` headless, `0` visible browser | `1` |
| `BROWSER_COUNT` | Parallel Puppeteer workers | `1` |
| `FARM_COUNT` | Default count for AISA / Grok farm prompts | `1` |
| `CHROME_EXECUTABLE_PATH` | Chrome/Chromium path (Puppeteer modes) | Auto / custom |
| `ACCOUNT_FILE` | Google accounts list | `accounts.txt` |
| `RESULT_FILE` | Output template; `{provider}` → `kiro`, `cloudflare`, `proxy`, `aisa`, `grok` | `{provider}_keys.txt` |
| `PROXY_POOL_FILE` | Shared proxy pool for Kiro/CF (optional) | `proxy_keys.txt` |
| `TEMPMAIL_API` | Tempmail API for AISA / Grok signup | `https://tempmail.adrnode.com/api` |

## 📝 Account formats

### Google modes (Kiro / Cloudflare / Codebuddy)

`accounts.txt` — one account per line:

```
user1@gmail.com|password123
user2@gmail.com|password456|http://user:pass@proxy:8080
# comments are ignored
```

These modes **log into existing Google accounts**. They do **not** auto-generate emails (unlike AISA / Grok farm).

**Codebuddy [BETA]** runs through 9Router CodeBuddy INT OAuth and works best with **residential proxies** (datacenter IPs often get account restrictions).

### AISA / Grok Farm

No email file needed. Each run:

1. Creates a tempmail inbox  
2. Signs up via Camoufox (Turnstile-aware)  
3. Saves keys / credentials  
4. Grok: optionally injects into 9Router Grok CLI (default on)

### Grok Login

Uses farmed credentials from `result.txt` (`email:password`) or `grok_accounts.json`.

### Proxy pool (optional, Kiro/CF)

```
191.96.254.138:6185:username:password
```

- Workers lock proxies while in use  
- **30-minute cooldown** per proxy IP after release  
- Priority: account proxy → pool → no proxy  
- Codebuddy benefits most from **residential** IPs in the pool

## 📊 Reports

After each run:

```
════════════════════════════════════════════════════════════════════════════════
  🔑 KIRO AUTOMATION REPORT
════════════════════════════════════════════════════════════════════════════════

📊 OVERALL SUMMARY
────────────────────────────────────────────────────────────────────────────────
  Total Accounts       : 10
  ✅ Success           : 8 accounts
  ❌ Failed            : 2 accounts
  Success Rate         : 80.0%
  Total Duration       : 5m 23s
  Average per Account  : 32.3s
```

## 📁 Output files

| File | Content |
|------|---------|
| `kiro_keys.txt` | `email\|refreshToken` |
| `cloudflare_keys.txt` | `name\|baseUrl\|token\|models` |
| `aisa_keys.txt` / `apikey.txt` | AISA API keys |
| `aisa_account.json` | AISA email + key log |
| `result.txt` | Grok `email:password` |
| `grok_accounts.json` | Grok account metadata |
| `grok_keys.txt` | Grok status lines |
| `login_result.txt` | Grok login/inject status |
| `errorAccounts.txt` | Failures with type + timestamp |
| `logs/` | Run logs |
| `screenshots/` | Debug screenshots (Camoufox flows) |
| `cookies/` | Grok session cookies after inject |

## 🏗️ Project structure

```
token-listrik/
├── index.js                 # Unified CLI menu
├── src/
│   ├── browser.js           # Puppeteer launch (Chrome, stealth)
│   ├── camoufox.js          # Camoufox launch (AISA / Grok)
│   ├── kiro.js              # Kiro OAuth harvest + 9Router API import
│   ├── cloudflare.js        # CF Workers AI token + 9Router API import
│   ├── codebuddy.js         # Codebuddy INT OAuth harvest [BETA]
│   ├── aisa.js              # AISA signup farm (Camoufox + tempmail)
│   ├── grok.js              # Grok farm + login + 9Router OAuth inject
│   ├── router-inject.js     # Shared 9Router browser inject (Grok CLI)
│   ├── tempmail.js          # Tempmail create + OTP poll
│   ├── turnstile.js         # Cloudflare Turnstile click helper
│   ├── google-login.js      # Google email/password helpers (Puppeteer)
│   ├── config.js            # .env + defaults
│   ├── settings.js          # Interactive settings
│   ├── progress.js          # Multi-bar progress UI
│   ├── reporter.js          # End-of-run reports
│   └── utils.js             # Accounts, locks, proxy pool, logging
├── package.json
└── README.md
```

## 🛠️ Tech stack

- **Node.js** — runtime  
- **Puppeteer** + **puppeteer-extra-plugin-stealth** — Google-based automations  
- **Camoufox** (`camoufox-js` / Playwright) — AISA & Grok anti-bot flows  
- **Inquirer** — interactive menu  
- **cli-progress** / **ansi-colors** — terminal UX  
- **9Router** — token / provider backend  

## 🔧 Troubleshooting

### "No accounts found" (Kiro / CF / Codebuddy)
- Format: `email|password` or `email|password|proxy`
- No extra spaces; use `#` for comments

### Camoufox / AISA / Grok fails to launch
- Run `npm install` so `camoufox-js` and Playwright deps are present
- On Linux VPS you may need OS packages for Firefox-based browsers
- Try `PW_HEADLESS=0` once to watch the flow

### Turnstile not solving
- Prefer Camoufox (not plain Chrome) for Grok/AISA
- Lower concurrency; keep farm serial if flaky
- Residential proxies help more than free datacenter IPs

### 9Router import / inject errors
- Confirm 9Router is up: `curl http://127.0.0.1:20128/`
- Match `ROUTER_URL` and `ROUTER_PASSWORD` with 9Router settings
- Disable **Require Login** on 9Router API if import API returns auth errors
- Grok inject uses **browser OAuth** (login UI + Allow); API modes use REST

### Browser won't launch (Puppeteer)
- Set a valid `CHROME_EXECUTABLE_PATH` on Windows/Linux/Mac
- On Mac, path must point to the binary inside the `.app` bundle, not the bundle root

### CAPTCHA on Google login
- Reduce `BROWSER_COUNT`
- Use proxy pool with cooldown or per-account residential proxies
- For Codebuddy, prefer residential proxies to avoid account restrictions

## 📄 License

ISC

## 👤 Author

**lulucianai**
- GitHub: [@lulucianai](https://github.com/lulucianai)

## 🙏 Acknowledgements

- **[9Router](https://github.com/9router/9router)** — provider/token backend  
- **[Puppeteer](https://pptr.dev/)** & **[puppeteer-extra-plugin-stealth](https://github.com/berstend/puppeteer-extra)**  
- **[Camoufox](https://camoufox.com/)** / **camoufox-js** — anti-detect Firefox automation  
- **[Inquirer.js](https://github.com/SBoudrias/Inquirer.js)**, **[cli-progress](https://github.com/npkgz/cli-progress)**, **[ansi-colors](https://github.com/doowb/ansi-colors)**  

## 🤝 Contributing

- Follow ESLint config (4-space indent)
- User-facing CLI strings in English
- Prefer small, tested changes per provider module

## 💬 Support

- Issues: [GitHub Issues](https://github.com/lulucianai/token-listrik/issues)
- Discussions: [GitHub Discussions](https://github.com/lulucianai/token-listrik/discussions)

---

**Keep the stack powered.**
