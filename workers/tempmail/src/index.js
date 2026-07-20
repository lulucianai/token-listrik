/**
 * token-listrik tempmail — Cloudflare Email Worker + REST API
 *
 * Compatible with token-listrik src/tempmail.js:
 *   GET  /api/session                         → { sessionId }
 *   POST /api/inboxes  { localPart, domain }  → { address }
 *        header: x-session-id
 *   GET  /api/inboxes/:email/messages         → [{ subject, body, text, html, from, to, receivedAt }]
 *        header: x-session-id
 *
 * Optional auth (matches TEMPMAIL_API_KEY):
 *   header x-api-key  OR  Authorization: Bearer <key>
 *   Worker secret: API_KEY
 */

const encoder = new TextEncoder();

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type, x-api-key, Authorization, x-session-id",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      ...extraHeaders,
    },
  });
}

function randomId(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseAllowedDomains(env) {
  return String(env.ALLOWED_DOMAINS || "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function ttlSeconds(env, key, fallback) {
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function maxMessages(env) {
  const n = Number(env.MAX_MESSAGES_PER_INBOX);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function extractApiKey(request) {
  const x = request.headers.get("x-api-key");
  if (x) {
    return x.trim();
  }
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function requireApiKey(request, env) {
  const expected = env.API_KEY;
  if (!expected) {
    // No secret configured → open API (OK for private workers.dev + random URL)
    return null;
  }
  const got = extractApiKey(request);
  if (!got || got !== expected) {
    return json(
      {
        error: "API access requires an API key.",
        hint: "Send header x-api-key (or Authorization: Bearer).",
      },
      401,
    );
  }
  return null;
}

async function readBodyJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Very small MIME / header parser — enough for OTP subject + body text */
async function parseIncomingEmail(message) {
  const to = normalizeEmail(
    Array.isArray(message.to) ? message.to[0] : message.to,
  );
  const from = String(message.from || "");

  let raw = "";
  try {
    raw = await new Response(message.raw).text();
  } catch {
    raw = "";
  }

  const subject =
    message.headers?.get?.("subject") ||
    extractHeader(raw, "subject") ||
    "";

  const { text, html } = extractBodies(raw);
  const body = text || stripHtml(html) || raw.slice(0, 4000);

  return {
    to,
    from,
    subject: decodeMimeWords(subject),
    body,
    text: text || body,
    html: html || "",
    receivedAt: new Date().toISOString(),
  };
}

function extractHeader(raw, name) {
  const re = new RegExp(`^${name}:\\s*(.+)$`, "im");
  const m = raw.match(re);
  return m ? m[1].trim() : "";
}

function decodeMimeWords(str) {
  // =?UTF-8?B?...?= / =?UTF-8?Q?...?=
  return String(str).replace(
    /=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g,
    (_, cs, enc, data) => {
      try {
        if (enc.toUpperCase() === "B") {
          const bin = atob(data.replace(/\s/g, ""));
          const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
          return new TextDecoder(cs || "utf-8").decode(bytes);
        }
        // Q-encoding
        const q = data
          .replace(/_/g, " ")
          .replace(/=([0-9A-Fa-f]{2})/g, (__, h) =>
            String.fromCharCode(parseInt(h, 16)),
          );
        return q;
      } catch {
        return data;
      }
    },
  );
}

function extractBodies(raw) {
  if (!raw) {
    return { text: "", html: "" };
  }

  // Prefer text/plain part
  const textPart = raw.match(
    /Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\nContent-Type:|$)/i,
  );
  const htmlPart = raw.match(
    /Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\nContent-Type:|$)/i,
  );

  let text = textPart ? textPart[1].trim() : "";
  let html = htmlPart ? htmlPart[1].trim() : "";

  // Quoted-printable light decode
  text = decodeQuotedPrintable(text);
  html = decodeQuotedPrintable(html);

  // If no multipart, body after headers
  if (!text && !html) {
    const idx = raw.search(/\r?\n\r?\n/);
    if (idx !== -1) {
      text = decodeQuotedPrintable(raw.slice(idx).trim());
    }
  }

  // Cap size
  if (text.length > 20000) {
    text = text.slice(0, 20000);
  }
  if (html.length > 40000) {
    html = html.slice(0, 40000);
  }

  return { text, html };
}

function decodeQuotedPrintable(s) {
  return String(s)
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    );
}

function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function kvGetJson(kv, key) {
  const v = await kv.get(key);
  if (!v) {
    return null;
  }
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

async function kvPutJson(kv, key, value, expirationTtl) {
  await kv.put(key, JSON.stringify(value), { expirationTtl });
}

// ─── API handlers ─────────────────────────────────────────────

async function handleCreateSession(env) {
  const sessionId = randomId(16);
  const sessionTtl = ttlSeconds(env, "SESSION_TTL_SECONDS", 86400);
  await kvPutJson(
    env.MAIL_KV,
    `session:${sessionId}`,
    { createdAt: new Date().toISOString(), inboxes: [] },
    sessionTtl,
  );
  return json({ sessionId });
}

async function handleCreateInbox(request, env) {
  const sessionId = request.headers.get("x-session-id");
  if (!sessionId) {
    return json({ error: "Missing x-session-id header" }, 400);
  }

  const session = await kvGetJson(env.MAIL_KV, `session:${sessionId}`);
  if (!session) {
    return json({ error: "Invalid or expired session" }, 401);
  }

  const body = await readBodyJson(request);
  if (!body) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  let localPart = String(body.localPart || body.local || "")
    .trim()
    .toLowerCase();
  let domain = String(body.domain || "")
    .trim()
    .toLowerCase();

  const allowed = parseAllowedDomains(env);
  if (allowed.length === 0) {
    return json(
      {
        error: "ALLOWED_DOMAINS not configured on worker",
      },
      500,
    );
  }

  if (!domain) {
    domain = allowed[0];
  }
  if (!allowed.includes(domain)) {
    return json(
      {
        error: `Domain not allowed. Use one of: ${allowed.join(", ")}`,
      },
      400,
    );
  }

  if (!localPart) {
    localPart = randomId(5);
  }
  // Sanitize local part
  localPart = localPart.replace(/[^a-z0-9._+-]/g, "").slice(0, 64);
  if (!localPart) {
    return json({ error: "Invalid localPart" }, 400);
  }

  const address = `${localPart}@${domain}`;
  const sessionTtl = ttlSeconds(env, "SESSION_TTL_SECONDS", 86400);
  const msgTtl = ttlSeconds(env, "MESSAGE_TTL_SECONDS", 86400);

  // Bind inbox → session
  await kvPutJson(
    env.MAIL_KV,
    `inbox:${address}`,
    {
      sessionId,
      createdAt: new Date().toISOString(),
    },
    sessionTtl,
  );

  // Init empty message list
  const existing = await kvGetJson(env.MAIL_KV, `messages:${address}`);
  if (!existing) {
    await kvPutJson(env.MAIL_KV, `messages:${address}`, [], msgTtl);
  }

  session.inboxes = Array.isArray(session.inboxes) ? session.inboxes : [];
  if (!session.inboxes.includes(address)) {
    session.inboxes.push(address);
  }
  await kvPutJson(env.MAIL_KV, `session:${sessionId}`, session, sessionTtl);

  return json({ address, email: address, domain, localPart });
}

async function handleListMessages(emailRaw, request, env) {
  const sessionId = request.headers.get("x-session-id");
  if (!sessionId) {
    return json({ error: "Missing x-session-id header" }, 400);
  }

  const email = normalizeEmail(decodeURIComponent(emailRaw));
  const inbox = await kvGetJson(env.MAIL_KV, `inbox:${email}`);
  if (!inbox) {
    // Unknown inbox — return empty (poll-friendly) or 404
    return json([]);
  }
  if (inbox.sessionId !== sessionId) {
    return json({ error: "Session does not own this inbox" }, 403);
  }

  const messages = (await kvGetJson(env.MAIL_KV, `messages:${email}`)) || [];
  // Newest first for OTP polling
  const ordered = [...messages].reverse();
  return json(ordered);
}

async function handleHttp(request, env) {
  if (request.method === "OPTIONS") {
    return json({ ok: true });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/health" || path === "/api/health") {
    return json({
      ok: true,
      service: "token-listrik-tempmail",
      domains: parseAllowedDomains(env),
      auth: Boolean(env.API_KEY),
    });
  }

  // Auth for /api/*
  if (path.startsWith("/api")) {
    const denied = requireApiKey(request, env);
    if (denied) {
      return denied;
    }
  }

  if (path === "/api/session" && request.method === "GET") {
    return handleCreateSession(env);
  }

  // Some clients POST session — accept both
  if (path === "/api/session" && request.method === "POST") {
    return handleCreateSession(env);
  }

  if (path === "/api/inboxes" && request.method === "POST") {
    return handleCreateInbox(request, env);
  }

  const msgMatch = path.match(/^\/api\/inboxes\/([^/]+)\/messages$/);
  if (msgMatch && request.method === "GET") {
    return handleListMessages(msgMatch[1], request, env);
  }

  return json(
    {
      error: "Not found",
      endpoints: [
        "GET  /health",
        "GET  /api/session",
        "POST /api/inboxes",
        "GET  /api/inboxes/:email/messages",
      ],
    },
    404,
  );
}

// ─── Email event (Cloudflare Email Routing → Worker) ──────────

async function handleEmail(message, env) {
  try {
    const parsed = await parseIncomingEmail(message);
    const to = parsed.to;
    if (!to) {
      message.setReject("No recipient");
      return;
    }

    const allowed = parseAllowedDomains(env);
    const domain = to.split("@")[1] || "";
    if (allowed.length && !allowed.includes(domain)) {
      // Drop silently / reject
      message.setReject("Domain not allowed");
      return;
    }

    const msgTtl = ttlSeconds(env, "MESSAGE_TTL_SECONDS", 86400);
    const max = maxMessages(env);
    let list = (await kvGetJson(env.MAIL_KV, `messages:${to}`)) || [];
    if (!Array.isArray(list)) {
      list = [];
    }

    list.push({
      subject: parsed.subject,
      body: parsed.body,
      text: parsed.text,
      html: parsed.html,
      from: parsed.from,
      to,
      receivedAt: parsed.receivedAt,
    });

    if (list.length > max) {
      list = list.slice(list.length - max);
    }

    await kvPutJson(env.MAIL_KV, `messages:${to}`, list, msgTtl);

    // Ensure inbox key exists (catch-all may arrive before API create)
    const existingInbox = await kvGetJson(env.MAIL_KV, `inbox:${to}`);
    if (!existingInbox) {
      await kvPutJson(
        env.MAIL_KV,
        `inbox:${to}`,
        {
          sessionId: null,
          createdAt: new Date().toISOString(),
          orphan: true,
        },
        msgTtl,
      );
    }
  } catch (err) {
    // Don't crash the worker — reject so CF can retry/log
    try {
      message.setReject(`Worker error: ${err.message || "unknown"}`);
    } catch {
      // ignore
    }
  }
}

export default {
  async fetch(request, env) {
    try {
      return await handleHttp(request, env);
    } catch (err) {
      return json({ error: err.message || "Internal error" }, 500);
    }
  },

  async email(message, env, _ctx) {
    // Await so setReject / KV writes finish before CF finalizes the message
    await handleEmail(message, env);
  },
};
