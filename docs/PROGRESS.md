# Progress log — token-listrik

Living changelog of work done in-session / forks. Update this when shipping meaningful changes.

**Last updated:** 2026-07-20

---

## Snapshot

| Item | Status |
|------|--------|
| Base | Fork of bercocok-tanam + token-listrik features |
| 9Router auth helper | ✅ `src/router-api.js` (login → `auth_token` cookie) |
| AISA → 9Router | ✅ farm + inject + model sync |
| AISA default model | `deepseek-v4-pro` |
| Tempmail adrnode managed API | ✅ with `TEMPMAIL_API_KEY` (`tm_...`) — client updated to grok_farm API |
| CF tempmail worker scaffold | ✅ `workers/tempmail/` (optional if self-host later) |
| Zyloo automation | ✅ Google → `sk-zy-*` → 9Router |
| Yunwu farm | ✅ Camoufox + tempmail → NewAPI token → 9Router (`yunwu` / `https://yunwu.ai/v1`) |
| Upstream sync (bercocok-tanam) | Partial — Codebuddy API + TokenGo affiliate ported |

---

## Completed features

### From bercocok-tanam (ported)

- [x] TokenGo automation (+ later: affiliate chain, random token name, default group)
- [x] Checkbox multi-select + ora UI
- [x] Proxy pool confirmation + 60s cooldown on release
- [x] Codebuddy [BETA] → **API device-code + poll** (not only old tab OAuth)
- [x] Conditional proxy (Google domains bypass) in `browser.js`
- [x] README style closer to bercocok-tanam + **credits to @fzrilsh**

### token-listrik-only

- [x] AISA farm (Camoufox + tempmail)
- [x] Grok farm / login + 9Router browser inject (`router-inject.js`)
- [x] Zyloo Google harvest + openai-compatible inject
- [x] `router-api.js` for password-protected 9Router
- [x] AISA model catalog sync → 9Router `/api/models/custom`
- [x] Camoufox `geoip` default **off** (avoids corrupt MMDB crash)
- [x] Tempmail client supports `TEMPMAIL_API_KEY` (`x-api-key` / Bearer)
- [x] LICENSE (ISC), version notes, CI lint workflow (`.github/workflows/lint.yml`)
- [x] Workers scaffold: Cloudflare Email tempmail API
- [x] Yunwu farm (NewAPI register + go-captcha wait + token create + 9Router inject)

### Verified live (example)

- AISA x1 farm → inject to remote 9Router succeeded (provider node `aisa`, connection `aisa_*`, models imported).
- 9Router login: `POST /api/auth/login` + cookie required for `/api/provider-nodes`.

---

## In progress / blocked

| Item | Notes |
|------|--------|
| **Tempmail** | Working with managed `tm_` key in local `.env`. CF worker still available as backup. |
| **Grok farm full port** | Friend sent latest grok_farm.js (proxy per account + tempmail key + inject). Tempmail client done; optional: port proxy CLI flags into camoufox/grok. |
| **Yunwu captcha** | go-captcha **click-shape** on send-code — auto-solve not implemented; headed browser + human click. Optional future: vision solver. |
| **Local git cleanliness** | `~/codevibe/token-listrik` may have uncommitted mix vs GitHub; prefer commit after CF worker works. |

---

## Deferred / won't do (unless asked)

- [ ] Re-add Webshare **Proxy automation** (`proxy.js`) — removed upstream; pool still used
- [ ] Zyloo via tempmail — **impossible** (Google/GitHub OAuth only)
- [ ] 9Router-as-tempmail — **not a feature** of 9Router (AI router only)
- [ ] Grok parallel multi-worker farm (still serial)

---

## Upstream commits worth knowing

```
f2cb0fb feat(codebuddy): API-based flow + conditional proxy
fe83d8b / 006d221 TokenGo random name + affiliate aff_code chain
91a3e5b TokenGo debug cookie logging (optional / noisy)
… earlier: proxy confirm, 60s cooldown, checkbox UI, TokenGo base
```

Remote: `https://github.com/fzrilsh/bercocok-tanam.git`

---

## How to run (quick)

```bash
cd ~/codevibe/token-listrik
# .env: ROUTER_*, TEMPMAIL_*, PW_HEADLESS=1

npm start
# or
node -e 'require("./src/aisa").runAisaAutomation(500, { signupOnly: false })'
```

Outputs: `aisa_keys.txt`, `apikey.txt`, `aisa_account.json`, `logs/`.

---

## Next recommended steps

1. Deploy `workers/tempmail` on user domain (see `docs/TEMPMAIL.md`).
2. Point `.env` `TEMPMAIL_API` / `TEMPMAIL_DOMAINS` / `TEMPMAIL_API_KEY`.
3. Smoke: `createTempmail()` then AISA x1.
4. Commit/push clean tree (no secrets) when stable.
5. Optional: wire TokenGo/Zyloo model sync like AISA; Grok parallel workers.
6. Smoke Yunwu x1 headed: `node -e 'require("./src/yunwu").runYunwuAutomation(1,{signupOnly:false})'`.

---

## Session memory (for agents)

- User primary run path: **`/Users/ekydiza/codevibe/token-listrik`**
- Worktree may also exist under `~/.grok/worktrees/codevibe-token-listrik/...`
- Personal 9Router tunnel/password: **only in local `.env`**, never source/git
- Friend suggested CF Worker for tempmail — scaffolded, not deployed yet
