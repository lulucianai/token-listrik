# ⚡ token-listrik

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16-brightgreen)](https://nodejs.org/)
[![GitHub Stars](https://img.shields.io/github/stars/lulucianai/token-listrik?style=social)](https://github.com/lulucianai/token-listrik/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/lulucianai/token-listrik?style=social)](https://github.com/lulucianai/token-listrik/network/members)
[![GitHub Issues](https://img.shields.io/github/issues/lulucianai/token-listrik)](https://github.com/lulucianai/token-listrik/issues)
[![Last Commit](https://img.shields.io/github/last-commit/lulucianai/token-listrik)](https://github.com/lulucianai/token-listrik/commits/main)
[![Code Style: ESLint](https://img.shields.io/badge/code_style-ESLint-5e5ce6.svg)](https://eslint.org/)

Automated CLI tool for harvesting Kiro refresh tokens, Cloudflare Workers AI API tokens, Codebuddy AI OAuth tokens, TokenGo API keys, plus AISA / Grok signup farms via Camoufox. Features multi-worker parallel processing, intelligent proxy rotation, detailed per-account reporting, and comprehensive error tracking. Tokens are imported into **[9Router](https://github.com/9router/9router)**.

## ✨ Features

- 🔑 **Kiro Automation** - Automated Kiro OAuth refresh token extraction
- ☁️ **Cloudflare Automation** - Cloudflare Workers AI API token generation
- 🤖 **Codebuddy Automation [BETA]** - Codebuddy AI OAuth token extraction (⚠️ requires residential proxies)
- 🎫 **TokenGo Automation** - TokenGo API key harvesting with intelligent proxy rotation
  - Hybrid HTTP + Puppeteer approach (Google OAuth via Puppeteer, API calls via HTTP)
  - Automatic proxy rotation on 429 rate limits (up to 5 proxies per account)
  - Cookie persistence between phases to prevent state mismatch errors
  - 30-90s cooldown with proxy rotation, 5-10min without proxy
- ⚡ **Zyloo Automation** - Google sign-in → harvest `sk-zy-*` key (Kimi K3 event-ready) → 9Router openai-compatible (`api.zyloo.io/v1`, default model `zyloo/kimi-k3`)
  - Visits `/dashboard/event` then `/dashboard/keys`
  - Network + DOM key sniffing for `sk-zy-*`
  - Free event is **1 account per IP** — use proxy pool
- 🤖 **AISA Farm** - Auto signup via Camoufox + tempmail, then import API key to 9Router (openai-compatible `api.aisa.one/v1`)
- ⚡ **Grok Farm** - Auto signup on accounts.x.ai + optional 9Router Grok CLI inject
- 🔐 **Grok Login** - Login existing Grok accounts + 9Router OAuth inject
- 🚀 **Multi-select Automations** - Checkbox to run any combination of Google-based automations in parallel
- 🌐 **Proxy Pool System** - Shared proxy pool with automatic worker assignment and locking
- 👷 **Multi-Worker Parallel Processing** - Configure multiple browser instances for faster processing
- 📊 **Detailed Reporting** - Per-worker and per-account statistics with timing breakdown
- 🎯 **Smart Account Queue Management** - Automatic account locking prevents duplicate processing
- ❌ **Comprehensive Error Tracking** - All failed accounts logged with timestamps and automation type
- 🔄 **Account Change Detection** - Confirmation prompt when account count changes before automation
- 🔌 **Flexible Proxy Support** - Per-account proxies or shared proxy pool; confirm per-automation before run
- ⚙️ **Interactive Settings** - Easy configuration management through CLI interface

## 📋 Requirements

- Node.js 16+
- Google Chrome or Chromium browser (Kiro / Cloudflare / Codebuddy / TokenGo)
- **Camoufox** via `camoufox-js` (AISA / Grok — better Turnstile / WAF resistance)
- Valid Google accounts (email|password format) for Google-based modes
- **9Router** - Backend service for token management
  - This tool harvests tokens and imports them to 9Router
  - Must be running and accessible at configured `ROUTER_URL`
  - Default: `http://127.0.0.1:20128/`

## 🚀 Installation

```bash
# Clone the repository
git clone https://github.com/lulucianai/token-listrik
cd token-listrik

# Install dependencies
npm install

# Camoufox browser (AISA / Grok)
npx camoufox-js fetch

# Create accounts file (Google-based modes)
echo "email@example.com|password123" > accounts.txt

# (Optional) Configure settings
cp .env.example .env
# Edit .env with your settings
```

## ⚙️ Configuration

Create a `.env` file in the project root:

```env
ROUTER_URL=http://127.0.0.1:20128/
ROUTER_PASSWORD=123456
PW_HEADLESS=1
BROWSER_COUNT=4
BROWSER_SLOW_MO=2
FARM_COUNT=1
CHROME_EXECUTABLE_PATH=/path/to/chrome
ACCOUNT_FILE=accounts.txt
RESULT_FILE={provider}_keys.txt
ERROR_ACCOUNT_FILE=errorAccounts.txt
PROXY_POOL_FILE=proxy_keys.txt
DELAY_BEFORE_NEXT_CLICK_MS=1000
DELAY_BETWEEN_ACCOUNTS_MS=3000
DELAY_BEFORE_BROWSER_CLOSE_MS=3000
DELAY_BEFORE_READING_COOKIES_MS=5000
TIMEOUT_NAVIGATION_MS=60000
TIMEOUT_DEFAULT_MS=15000
TIMEOUT_SHORT_MS=10000
TEMPMAIL_API=https://tempmail.adrnode.com/api
TEMPMAIL_DOMAINS=adrnode.com,adrnode.web.id,aanyantok.my.id,foxsight.xyz,shitoors.fun
TURNSTILE_WAIT_TIMEOUT_MS=45000
EMAIL_POLL_TIMEOUT_MS=120000
EMAIL_POLL_INTERVAL_MS=5000
```

| Variable | Description | Default |
|---|---|---|
| `ROUTER_URL` | 9Router endpoint for token import | `http://127.0.0.1:20128/` |
| `ROUTER_PASSWORD` | 9Router login password (Grok browser inject) | `123456` |
| `PW_HEADLESS` | `1` = headless, `0` = visible browser | `1` |
| `BROWSER_COUNT` | Number of parallel browser instances | `1` |
| `BROWSER_SLOW_MO` | Delay between browser actions (ms) | `2` |
| `FARM_COUNT` | Default account count for AISA / Grok farm prompts | `1` |
| `CHROME_EXECUTABLE_PATH` | Path to Chrome/Chromium executable | Auto-detect |
| `ACCOUNT_FILE` | Path to accounts file | `accounts.txt` |
| `RESULT_FILE` | Auto-replaces `{provider}` with automation name (`kiro`, `cloudflare`, `tokengo`, `aisa`, `grok`) | `{provider}_keys.txt` |
| `ERROR_ACCOUNT_FILE` | Log file for failed accounts | `errorAccounts.txt` |
| `PROXY_POOL_FILE` | Shared proxy pool file (optional) - workers auto-pick available proxies | `proxy_keys.txt` |
| `DELAY_BEFORE_NEXT_CLICK_MS` | Delay before next click action | `1000` |
| `DELAY_BETWEEN_ACCOUNTS_MS` | Delay between processing accounts | `3000` |
| `DELAY_BEFORE_BROWSER_CLOSE_MS` | Delay before closing browser | `3000` |
| `DELAY_BEFORE_READING_COOKIES_MS` | Delay before reading cookies | `5000` |
| `TIMEOUT_NAVIGATION_MS` | Page navigation timeout | `60000` |
| `TIMEOUT_DEFAULT_MS` | Default element wait timeout | `15000` |
| `TIMEOUT_SHORT_MS` | Short element wait timeout | `10000` |
| `TEMPMAIL_API` | Tempmail API for AISA / Grok signup | `https://tempmail.adrnode.com/api` |

## 📝 Account File Format

Create `accounts.txt` with one account per line:

```
user1@gmail.com|password123
user2@gmail.com|password456
user3@gmail.com|password789|http://proxy-server:8080
user4@gmail.com|password321|http://user:pass@proxy:8080
```

**Format Rules:**
- One account per line
- Fields separated by `|` (pipe)
- Lines starting with `#` are comments
- Proxy is optional (supported by all Google-based automations)

### Proxy Pool (Optional)

Instead of specifying proxies per account, you can use a shared proxy pool. Create a proxy pool file (e.g., `proxy_keys.txt`):

```
191.96.254.138:6185:username:password
45.38.107.97:6014:username:password
198.105.121.200:6462:username:password
```

**Format:** `ip:port:username:password` (one proxy per line)
- System automatically converts to `http://user:pass@host:port` format

**How it works:**
- Workers automatically pick available proxies from the pool
- Proxies are locked while in use (other workers wait)
- **60-second cooldown per proxy IP** after release
- Proxy is released after browser closes
- **Priority:** Account proxy > Pool proxy > No proxy
- Before each run you can confirm which automations use the pool

**Important:**
- **⚠️ Codebuddy Automation:** Requires **residential proxies only**. Datacenter proxies will result in "Account Access Restricted" errors due to Tencent Cloud's security policies. If you don't have residential proxies, Codebuddy automation will likely fail.
- **🎫 TokenGo Automation:** Benefits greatly from proxy pool for 429 rate limit avoidance. Without proxy pool, accounts may encounter rate limits requiring 5-10 minute cooldowns between operations.
- Proxy pool is used for Kiro, Cloudflare, Codebuddy, and TokenGo automations.

Enable by setting `PROXY_POOL_FILE=proxy_keys.txt` in `.env`

### AISA / Grok Farm

No `accounts.txt` needed. Each run:

1. Creates a tempmail inbox
2. Signs up via Camoufox (Turnstile-aware)
3. Saves keys / credentials to disk
4. **AISA (default):** ensures 9Router provider node `aisa` (`https://api.aisa.one/v1`, openai-compatible) and `POST /api/providers` with the farmed key. Choose “Signup only” to skip import.
5. **Grok (default):** injects into 9Router Grok CLI via browser OAuth. Choose “Signup only” to skip inject.

### Grok Login

Uses farmed credentials from `result.txt` (`email:password`) or `grok_accounts.json`.

## 🎮 Usage

```bash
# Start the CLI
npm start

# Choose from menu:
# › Run Automations          (checkbox: Kiro / CF / Codebuddy / TokenGo)
#   AISA Farm (Camoufox + 9Router)
#   Grok Farm (Camoufox + 9Router)
#   Grok Login + 9Router Inject
#   Settings
#   Exit
```

**Run Automations** opens a checkbox menu:

```
◉ Kiro Automation
◉ Cloudflare Automation
◯ Codebuddy Automation [BETA] (Requires Residential Proxy)
◉ TokenGo Automation (30-90s cooldown with proxy rotation)
◯ Zyloo Automation (Google → sk-zy-* / Kimi K3 event)
```

If a proxy pool is configured, you can choose which automations use it.

**Zyloo tip:** event free Kimi K3 = model `zyloo/kimi-k3`, base URL `https://api.zyloo.io/v1`. Zyloo documents **1 free account per network (IP)** — set `PROXY_POOL_FILE` and keep `BROWSER_COUNT` modest.

### Account Change Confirmation

If you modify `accounts.txt` while at the menu, the system will detect changes when you start an automation:

```
? Account file changed: 5 → 3 accounts. Continue with automation? (Y/n)
```

- Select `Y` to proceed with the new account list
- Select `n` to return to menu and review changes

## 📊 Reports

After each automation run, you'll see a detailed report:

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

👷 WORKER DETAILS
────────────────────────────────────────────────────────────────────────────────

  Kiro W1
    Processed: 5 accounts | ✅ 4 | ❌ 1
    Average: 31.2s/account
    Accounts:
      ✅ user1@gmail.com 28.5s
      ✅ user2@gmail.com 35.1s
      ❌ user3@gmail.com 29.8s
      ✅ user4@gmail.com 30.2s
      ✅ user5@gmail.com 32.4s

❌ FAILED ACCOUNTS
────────────────────────────────────────────────────────────────────────────────
  • user3@gmail.com
    Error: RefreshToken cookie not found

  💡 Check errorAccounts.txt for complete details

════════════════════════════════════════════════════════════════════════════════
```

## 📁 Output Files

- **`{provider}_keys.txt`** - Token output files, generated per automation:
  - `kiro_keys.txt` — Kiro refresh tokens (format: `email|refreshToken`)
  - `cloudflare_keys.txt` — Cloudflare Workers AI API tokens
  - `codebuddy_keys.txt` — Codebuddy OAuth tokens (auto-imported to 9Router)
  - `tokengo_keys.txt` — TokenGo API keys (format: `email|userId|apiKey`, auto-imported to 9Router)
  - `zyloo_keys.txt` — Zyloo keys (`email|sk-zy-...`)
  - `aisa_keys.txt` — AISA keys (`email|apiKey`)
  - `apikey.txt` — AISA keys (legacy one-key-per-line)
  - `grok_keys.txt` — Grok status lines
- **`aisa_account.json`** - AISA email + key + import status
- **`result.txt`** - Grok `email:password` lines from farm
- **`grok_accounts.json`** - Grok account metadata
- **`login_result.txt`** - Grok login/inject status
- **`errorAccounts.txt`** - Failed accounts with error messages, timestamps, and automation type
- **`logs/`** - Detailed execution logs with timestamps
- **`screenshots/`** - Debug screenshots (Camoufox flows)
- **`cookies/`** - Grok session cookies after inject

### Error Accounts Format

```
email|password | Kiro | 2026-07-10T14:23:45.123Z | RefreshToken cookie not found
email|password | Cloudflare | 2026-07-10T14:25:12.456Z | Account ID not found
```

## 🏗️ Project Structure

```
token-listrik/
├── index.js              # Main entry point with menu system
├── src/
│   ├── browser.js        # Browser launching with stealth mode
│   ├── camoufox.js       # Camoufox launch (AISA / Grok)
│   ├── cloudflare.js     # Cloudflare token harvesting logic
│   ├── codebuddy.js      # Codebuddy OAuth token harvesting logic
│   ├── config.js         # Configuration management
│   ├── google-login.js   # Google authentication helpers
│   ├── kiro.js           # Kiro token harvesting logic
│   ├── tokengo.js        # TokenGo API key harvesting with proxy rotation
│   ├── zyloo.js          # Zyloo Google login + sk-zy key harvest (Kimi K3)
│   ├── aisa.js           # AISA signup farm (Camoufox + tempmail)
│   ├── grok.js           # Grok farm + login + 9Router inject
│   ├── router-inject.js  # 9Router browser inject (Grok CLI OAuth)
│   ├── tempmail.js       # Tempmail create + OTP poll
│   ├── turnstile.js      # Cloudflare Turnstile click helper
│   ├── progress.js       # Progress bar and status display
│   ├── reporter.js       # Report generation and formatting
│   ├── settings.js       # Interactive settings menu
│   └── utils.js          # Utility functions and helpers
├── accounts.txt          # Account list (user-created)
├── kiro_keys.txt         # Kiro tokens output (auto-generated)
├── cloudflare_keys.txt   # Cloudflare tokens output (auto-generated)
├── tokengo_keys.txt      # TokenGo API keys output (auto-generated)
├── errorAccounts.txt     # Failed accounts log
├── logs/                 # Execution logs
├── .env                  # Configuration (user-created)
├── eslint.config.js      # ESLint configuration
└── package.json          # Dependencies and scripts
```

## 🛠️ Tech Stack

- **Node.js** - Runtime environment
- **Puppeteer** - Browser automation
- **Puppeteer-Stealth** - Anti-detection plugin
- **Camoufox** (`camoufox-js` / Playwright) - Anti-detect Firefox for AISA / Grok
- **Axios** - HTTP client for API calls with proxy support
- **HTTPS-Proxy-Agent** - Proxy agent for HTTPS requests
- **Inquirer** - Interactive CLI prompts
- **Ora** - Terminal spinners
- **CLI-Progress** - Progress bars
- **ANSI-Colors** - Terminal colors
- **9Router** - Token management backend service

## 🔧 Troubleshooting

### "No accounts found" error
- Check `accounts.txt` format: `email|password` or `email|password|proxy`
- Ensure no extra spaces around the `|` separator
- Remove empty lines or add `#` for comments

### "RefreshToken cookie not found"
- Google may require additional verification
- Check if account credentials are correct
- Wait a few minutes and retry (rate limiting)

### Browser won't launch
- Verify Chrome path in settings or `.env`
- Check Chrome is installed and executable
- Try default Chrome path (remove custom setting)

### "spawn /Applications/Google Chrome.app EACCE" (Mac)
Permission error when launching Chrome. Common causes:
- **Wrong path**: `/Applications/Google Chrome.app` is the app bundle, not the executable
- **Solution**: Use correct executable path:
  ```bash
  CHROME_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ```
- If using Chromium: `/Applications/Chromium.app/Contents/MacOS/Chromium`
- If using Brave: `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`
- **Alternative**: Leave `CHROME_EXECUTABLE_PATH` empty — Puppeteer auto-detects bundled Chromium
- **Check permissions**: Ensure Chrome has execute permission:
  ```bash
  ls -l "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  # Should show: -rwxr-xr-x (x = executable bit)
  ```
- **Security settings**: If downloaded manually, remove quarantine attribute:
  ```bash
  xattr -d com.apple.quarantine "/Applications/Google Chrome.app"
  ```

### Camoufox / AISA / Grok fails to launch
- Run `npm install` and `npx camoufox-js fetch`
- On Linux VPS you may need OS packages for Firefox-based browsers
- Try `PW_HEADLESS=0` once to watch the flow
- Signup blocked by Cloudflare? Prefer visible browser + residential IP

### 9Router connection errors
- Verify 9Router is running and accessible
- Check `ROUTER_URL` and `ROUTER_PASSWORD` in `.env` or settings
- Test connection: `curl http://127.0.0.1:20128/`
- Ensure firewall allows connections to router port
- Check router logs for import errors
- Disable **Require Login** in 9Router (**Settings → Security**) — the import API will be rejected if authentication is enabled
- Grok inject uses **browser OAuth** (login UI + Allow); other modes use REST import APIs

### Proxy errors
- Verify proxy format: `http://host:port` or `http://user:pass@host:port`
- Test proxy connection separately
- Try without proxy first to isolate issue

### CAPTCHA challenges and security restrictions
- **Kiro/Cloudflare**: Proxy pool includes 60s cooldown per IP after release
- **Codebuddy**: Requires **residential proxies only**. Datacenter proxies will trigger "Account Access Restricted" errors from Tencent Cloud's security system. This is not a CAPTCHA but an account-level restriction that cannot be bypassed without residential IPs.
- **TokenGo**: 429 rate limits are common. System automatically rotates proxies (up to 5 per account) when rate limited. Without proxy pool, cooldown increases from 30-90s to 5-10min per account.
- Reduce `BROWSER_COUNT` (fewer parallel instances)
- Increase delays between actions
- Ensure browser profile is clean (no previous bot flags)
- Free datacenter proxies are more likely to trigger CAPTCHAs than residential proxies

### TokenGo 429 rate limits
- **Symptom**: "Got HTTP 429, retry X/100 after 100ms..."
- **Cause**: TokenGo API rate limits requests per IP address
- **Automatic fix**: System rotates to new proxy after 100 failed attempts
- **Manual fix**:
  - Add more proxies to proxy pool for better rotation
  - Reduce `BROWSER_COUNT` to avoid parallel rate limit hits
  - If no proxy pool: expect 5-10 minute cooldowns between accounts
- **Best practice**: Use proxy pool with 5+ proxies for smooth operation

## 📄 License

ISC — see [LICENSE](./LICENSE).

## 👤 Author

**lulucianai**

- GitHub: [@lulucianai](https://github.com/lulucianai)

## 🙏 Credits & Acknowledgements

### Original project

This project is based on and extends **[bercocok-tanam](https://github.com/fzrilsh/bercocok-tanam)** by **Fazril Syaveral Hillaby** ([@fzrilsh](https://github.com/fzrilsh)).

Core automation architecture, multi-worker pipeline, proxy pool, reporting, Kiro / Cloudflare / Codebuddy / TokenGo flows, and much of the CLI UX come from that work. Thank you for open-sourcing it.

- Upstream: [github.com/fzrilsh/bercocok-tanam](https://github.com/fzrilsh/bercocok-tanam)
- Patreon: [patreon.com/fazrilsh](https://patreon.com/fazrilsh)

### Libraries & services

- **[9Router](https://github.com/9router/9router)** - Backend token management service that powers the import functionality
- **[Puppeteer](https://pptr.dev/)** & **[puppeteer-extra-plugin-stealth](https://github.com/berstend/puppeteer-extra)** - Browser automation framework and anti-detection capabilities
- **[Camoufox](https://camoufox.com/)** / **camoufox-js** - Anti-detect Firefox automation (AISA / Grok)
- **[Inquirer.js](https://github.com/SBoudrias/Inquirer.js)** - Interactive CLI prompts
- **[node-cli-progress](https://github.com/npkgz/cli-progress)** - Terminal progress bars
- **[ansi-colors](https://github.com/doowb/ansi-colors)** - Terminal color styling
- **[ora](https://github.com/sindresorhus/ora)** - Terminal spinners

Special thanks to the open-source community for making automation tools accessible.

## 🤝 Contributing

Contributions welcome! Please ensure:

- Code follows ESLint configuration (4-space indent)
- All user-facing text is in English
- Comprehensive error handling
- Test changes with multiple accounts before submitting PR
- **Never commit personal 9Router URLs, passwords, accounts, cookies, or proxy credentials**

## 💬 Support & Community

- **Issues**: [GitHub Issues](https://github.com/lulucianai/token-listrik/issues)
- **Discussions**: [GitHub Discussions](https://github.com/lulucianai/token-listrik/discussions)

For security vulnerabilities, please email/contact maintainers privately instead of opening a public issue.

## 📜 Changelog

See [commit history](https://github.com/lulucianai/token-listrik/commits/main) for detailed changes.

---

**Built with ❤️ for automation efficiency**
