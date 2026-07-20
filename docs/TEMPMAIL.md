# Tempmail — status & self-host

## Why this doc exists

AISA and Grok signup need **disposable email + OTP poll**. Originally:

```
TEMPMAIL_API=https://tempmail.adrnode.com/api
```

### Current status (2026-07)

| Backend | Status |
|---------|--------|
| `tempmail.adrnode.com` managed API | ✅ Works with **`TEMPMAIL_API_KEY`** (`tm_...`) — Admin → Settings |
| Client | Aligned with latest `grok_farm.js` from friend (x-api-key + server-generated address) |
| **Cloudflare Email Worker** | Scaffold in `workers/tempmail/` — optional self-host if adrnode unavailable |

Without a key:

```text
TEMPMAIL_API_KEY is not set
# or
Tempmail session failed: HTTP 401 ...
```

### Managed API usage (preferred when you have a key)

```env
TEMPMAIL_API=https://tempmail.adrnode.com/api
TEMPMAIL_API_KEY=tm_xxxxxxxx   # from Admin → Settings — NEVER commit
TEMPMAIL_DOMAINS=adrnode.com,adrnode.web.id,aanyantok.my.id,foxsight.xyz,shitoors.fun
```

Client behavior (matches grok_farm):

1. `GET /api/session` + header `x-api-key: tm_...`
2. `POST /api/inboxes` body `{ domain }` only (server generates local part) + `x-session-id`
3. `GET /api/inboxes/:email/messages` — accepts array **or** `{ messages: [] }`

---

## Client contract (`src/tempmail.js`)

Any backend must implement:

1. **`GET /api/session`**  
   Headers: optional `x-api-key` / `Authorization: Bearer`  
   Response: `{ "sessionId": "..." }`

2. **`POST /api/inboxes`**  
   Headers: `x-session-id`, optional API key  
   Body: `{ "localPart": "abc123", "domain": "yourdomain.com" }`  
   Response: `{ "address": "abc123@yourdomain.com" }` (also accepts `email`)

3. **`GET /api/inboxes/:email/messages`**  
   Headers: `x-session-id`  
   Response: array of messages, newest usable first:

   ```json
   [{ "subject": "...", "body": "...", "text": "...", "html": "..." }]
   ```

OTP modes in client:

- AISA: 6-digit (`digits6`)
- Grok: alphanumeric e.g. `376KDC` (`grok`)

---

## Option A — Admin key on adrnode

If you still have admin access:

1. Admin → Settings → create API key  
2. `.env`:

```env
TEMPMAIL_API=https://tempmail.adrnode.com/api
TEMPMAIL_API_KEY=your_key
TEMPMAIL_DOMAINS=adrnode.com,adrnode.web.id,aanyantok.my.id,foxsight.xyz,shitoors.fun
```

---

## Option B — Cloudflare Worker (recommended)

Full steps: **[`workers/tempmail/README.md`](../workers/tempmail/README.md)**

Summary:

1. Domain on Cloudflare  
2. **Email Routing** enabled + **catch-all → Worker**  
3. Deploy `workers/tempmail` (KV + optional `API_KEY` secret)  
4. `.env`:

```env
TEMPMAIL_API=https://token-listrik-tempmail.<subdomain>.workers.dev/api
TEMPMAIL_API_KEY=<same as wrangler secret API_KEY>
TEMPMAIL_DOMAINS=yourdomain.com
```

5. Test:

```bash
node -e 'require("./src/tempmail").createTempmail().then(console.log).catch(e=>console.error(e.message))'
```

### Not 9Router

**9Router does not provide tempmail.** It is only an AI token router.  
Cloudflare **Tunnel** (9Router dashboard URL) ≠ Cloudflare **Email Routing** (receive mail).

---

## Option C — VPS SMTP

Only if port **25** inbound works on the VPS. Heavier (docker-mailserver / Mailu + small API). Prefer CF Worker if port 25 is blocked.

---

## Troubleshooting

| Symptom | Cause |
|---------|--------|
| `401` / API key required | adrnode locked or missing `TEMPMAIL_API_KEY` |
| Domain not allowed | Worker `ALLOWED_DOMAINS` mismatch |
| Session OK, no OTP | Catch-all not routed to Worker; check `wrangler tail` |
| Wrong API path | `TEMPMAIL_API` must end with `/api` |
