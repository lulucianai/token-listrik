# 9Router integration

## Role in token-listrik

Harvest tokens → **import into 9Router** so CLI tools use one endpoint.

Dashboard default: `http://127.0.0.1:20128/`  
Remote: set `ROUTER_URL` (tunnel URL if used). **Never commit** tunnel + password.

## Auth

Many deployments have **Require Login** enabled.

```http
POST /api/auth/login
Content-Type: application/json

{"password":"<ROUTER_PASSWORD>"}
```

→ `Set-Cookie: auth_token=...`

All subsequent `/api/*` calls need:

```http
Cookie: auth_token=...
```

### Use this in code

```js
const { routerApiFetch } = require("./router-api");
const res = await routerApiFetch("/api/provider-nodes", { method: "GET" }, log);
```

Do **not** call bare `fetch(routerUrl + "/api/...")` without auth on locked instances.

Config:

```env
ROUTER_URL=https://your-router/
ROUTER_PASSWORD=...
```

## Import patterns by provider

| Provider | Method | Notes |
|----------|--------|--------|
| Kiro | `POST /api/oauth/kiro/import` | refresh token |
| Cloudflare | `POST /api/providers` | provider id `cloudflare-ai` |
| Codebuddy | device-code + poll APIs | `/api/oauth/codebuddy-int/*` |
| TokenGo | provider-nodes `tokengo` + `/api/providers` | openai-compatible |
| AISA | provider-nodes `aisa` + `/api/providers` | base `https://api.aisa.one/v1` |
| Yunwu | provider-nodes `yunwu` + `/api/providers` | base `https://yunwu.ai/v1` |
| Zyloo | provider-nodes `zyloo` + `/api/providers` | base `https://api.zyloo.io/v1` |
| Grok | **Browser** OAuth on Grok CLI page | `router-inject.js` (not simple REST key) |

## AISA models

After key import, `syncAisaModelsToRouter`:

1. `GET /api/providers/:connectionId/models` (proxied to AISA `/v1/models`)
2. `POST /api/models/custom` `{ id, type: "llm", providerAlias }` for each model
3. `PUT /api/providers/:id` set `defaultModel`

**Default model (code):** `deepseek-v4-pro`

## Yunwu models

Same inject pattern as AISA (`src/yunwu.js`):

1. Ensure provider-node `prefix=yunwu`, base `https://yunwu.ai/v1`
2. `POST /api/providers` with farmed API key
3. Sync custom models (live `/models` or static catalog in `YUNWU_MODEL_CATALOG`)
4. Default model: `deepseek-v4-pro`

Farm note: Yunwu (NewAPI) registration email-code requires **go-captcha click-shape** — headed Camoufox + human solve is the supported path.

## Grok inject

Uses Camoufox + dashboard login (password field filled without focus traps) + OAuth popup Continue/Allow polling. See `src/router-inject.js`.

## What 9Router is not

- Not tempmail / OTP inbox  
- Not a substitute for Cloudflare Email Worker  
- Tunnel feature only exposes the dashboard, does not receive email  
