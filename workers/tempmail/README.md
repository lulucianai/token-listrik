# Cloudflare Tempmail Worker (token-listrik)

Self-hosted disposable mail for **AISA / Grok farm** when `tempmail.adrnode.com` is locked.

Compatible with `src/tempmail.js`:

| Method | Path | Headers | Body / result |
|--------|------|---------|----------------|
| `GET` | `/api/session` | `x-api-key` (optional) | → `{ sessionId }` |
| `POST` | `/api/inboxes` | `x-session-id`, `x-api-key` | `{ localPart, domain }` → `{ address }` |
| `GET` | `/api/inboxes/:email/messages` | `x-session-id`, `x-api-key` | → `[{ subject, body, text, ... }]` |

Plus `GET /health`.

---

## Prerequisites

1. Domain on **Cloudflare** (nameservers = CF)
2. Node 18+ / npm
3. Cloudflare account (free OK)

---

## 1) Enable Email Routing

Cloudflare Dashboard → your zone → **Email** → **Email Routing** → Enable

Add **Destination** only if you also forward; for Worker-only you mainly need routing **enabled**.

### MX records

CF will show required MX — leave them as Email Routing instructs.

### Catch-all → Worker

**Email Routing** → **Routing rules** → **Catch-all** (or custom `*@yourdomain.com`):

- Action: **Send to a Worker**
- Worker: `token-listrik-tempmail` (after deploy)

> You can create the rule after first deploy when the worker exists.

---

## 2) Create KV + deploy Worker

```bash
cd workers/tempmail
npm install

# Login once
npx wrangler login

# Create KV
npx wrangler kv namespace create TEMPMAIL_KV
# Copy the id → paste into wrangler.toml → [[kv_namespaces]].id
```

Edit `wrangler.toml`:

```toml
[vars]
ALLOWED_DOMAINS = "yourdomain.com"   # comma-separated if many

[[kv_namespaces]]
binding = "MAIL_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Optional API key (recommended):

```bash
npx wrangler secret put API_KEY
# enter a long random string — same value as TEMPMAIL_API_KEY in token-listrik .env
```

Deploy:

```bash
npx wrangler deploy
```

Note the URL, e.g. `https://token-listrik-tempmail.<subdomain>.workers.dev`

---

## 3) Point token-listrik at the Worker

In project root `.env`:

```env
TEMPMAIL_API=https://token-listrik-tempmail.<subdomain>.workers.dev/api
TEMPMAIL_API_KEY=same_as_worker_API_KEY
TEMPMAIL_DOMAINS=yourdomain.com
```

> `TEMPMAIL_API` must end with `/api` (same as adrnode).

Test:

```bash
# health
curl -s https://token-listrik-tempmail.<subdomain>.workers.dev/health

# session (add -H "x-api-key: ..." if you set API_KEY)
curl -s https://token-listrik-tempmail.<subdomain>.workers.dev/api/session

# full client path
cd ../..   # token-listrik root
node -e 'require("./src/tempmail").createTempmail().then(console.log).catch(e=>console.error(e.message))'
```

Send a test mail to the returned address, then poll:

```bash
# use sessionId + email from createTempmail
curl -s -H "x-session-id: SESSION" -H "x-api-key: KEY" \
  "https://.../api/inboxes/user%40yourdomain.com/messages"
```

Then farm:

```bash
node -e 'require("./src/aisa").runAisaAutomation(5, { signupOnly: false })'
```

---

## Custom domain for the API (optional)

Workers & Pages → your worker → **Triggers** → **Custom Domains**  
e.g. `tempmail-api.yourdomain.com`

```env
TEMPMAIL_API=https://tempmail-api.yourdomain.com/api
```

---

## How mail flows

```
Sender → MX (Cloudflare Email Routing)
      → Worker email() handler
      → KV messages:you@domain.com
      → AISA poll GET /api/inboxes/.../messages
      → OTP extracted (6 digit / grok code)
```

---

## Limits (Free)

- Worker requests / CPU: CF free tier is usually enough for personal farm
- Email Routing: check CF current free limits
- KV: fine for short-lived OTP storage (TTL default 24h)

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `401 API key` | Match `API_KEY` secret ↔ `TEMPMAIL_API_KEY` |
| `Domain not allowed` | `ALLOWED_DOMAINS` must include your domain |
| Session OK, never get OTP | Catch-all not pointed to Worker; check Email Routing logs |
| Inbox create OK, messages empty | Wait for mail; check Worker **Logs** (`npx wrangler tail`) |
| Mail rejected | Domain not in `ALLOWED_DOMAINS` |

```bash
npx wrangler tail
```

---

## Security notes

- Set **`API_KEY`** so random people can’t create inboxes on your domain
- Don’t commit secrets / `.env`
- OTP mail is stored briefly in KV — TTL keeps it short
