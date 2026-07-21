/**
 * TokenRouter free GLM → 9Router
 *
 * Paths:
 *   A) Manual inject: TOKENROUTER_API_KEY → 9Router
 *   B) Farm email+tempmail: slide captcha + OTP + Cap widget + create key
 *   C) Farm Google: social login with Gmail → create key
 *
 * Site: https://www.tokenrouter.com
 * Auth: PaleBlueDot GraphQL (backend.palebluedot.ai)
 * Keys: NewAPI-style POST /api/token/ + /api/token/:id/key
 * Free model: z-ai/glm-5.2-free until 2026-07-25
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { getConfig, ROOT_DIR } = require("./config");
const { routerApiFetch } = require("./router-api");
const { sleep, createFileLogger, ensureFileExists } = require("./utils");
const { createTempmail, pollTempmail } = require("./tempmail");
const { launchCamoufox, newFarmPage } = require("./camoufox");


const TOKENROUTER_BASE_URL = "https://api.tokenrouter.com/v1";
const TOKENROUTER_SITE = "https://www.tokenrouter.com";
/**
 * NewAPI JSON backend used by the SPA axios client
 * (baseURL https://www.tokenrouter.com/backend-api/).
 * Note: https://api.tokenrouter.com is a separate public OpenAI-compatible host.
 */
const TOKENROUTER_API = "https://www.tokenrouter.com/backend-api";
const TOKENROUTER_PREFIX = "tokenrouter";
const TOKENROUTER_DEFAULT_MODEL = "z-ai/glm-5.2-free";
const FREE_GLM_UNTIL = "2026-07-25";
const PBD_GRAPHQL = "https://backend.palebluedot.ai/graphql";
const DEFAULT_FARM_PASSWORD = "TokenRouterFarm2026!";
const KEY_RE = /sk-[A-Za-z0-9]{16,}/g;

/** Static free catalog (extend if TokenRouter adds more free ids). */
const TOKENROUTER_FREE_CATALOG = [TOKENROUTER_DEFAULT_MODEL];

function getTokenRouterApiKey() {
  const config = getConfig();
  return (
    config.tokenrouterApiKey ||
    process.env.TOKENROUTER_API_KEY ||
    process.env.TOKENROUTER_KEY ||
    ""
  ).trim();
}

function freeGlmStillActive(now = new Date()) {
  const end = new Date(`${FREE_GLM_UNTIL}T23:59:59.999Z`);
  return now.getTime() <= end.getTime();
}

function getResultFile() {
  const config = getConfig();
  const tpl = config.resultFileTemplate || "{provider}_keys.txt";
  return path.resolve(ROOT_DIR, tpl.replace("{provider}", "tokenrouter"));
}

/**
 * Append key to tokenrouter_keys.txt for record.
 */
function saveTokenRouterKey(apiKey, log) {
  const file = getResultFile();
  const line = `${new Date().toISOString()}|${apiKey}\n`;
  fs.appendFileSync(file, line, "utf-8");
  if (log) log(`Saved key to ${path.basename(file)}`);
}

/**
 * Ensure openai-compatible TokenRouter provider node in 9Router.
 * @returns {Promise<string>} provider node id
 */
async function ensureTokenRouterProviderNode(log) {
  log("Checking TokenRouter provider node in 9Router...");

  const listResponse = await routerApiFetch(
    "/api/provider-nodes",
    { method: "GET" },
    log,
  );

  if (!listResponse.ok) {
    throw new Error(
      `Failed to list provider nodes: ${listResponse.status} ${await listResponse.text()}`,
    );
  }

  const listData = await listResponse.json();
  const nodes = listData.nodes || listData;

  const existingNode = Array.isArray(nodes)
    ? nodes.find(
        (n) =>
          n.prefix === TOKENROUTER_PREFIX ||
          (n.name && String(n.name).toLowerCase() === "tokenrouter"),
      )
    : null;

  if (existingNode) {
    log(`TokenRouter provider node exists: ${existingNode.id}`);
    return existingNode.id;
  }

  log("Creating TokenRouter provider node...");

  const createResponse = await routerApiFetch(
    "/api/provider-nodes",
    {
      method: "POST",
      body: JSON.stringify({
        name: "TokenRouter",
        prefix: TOKENROUTER_PREFIX,
        apiType: "chat",
        baseUrl: TOKENROUTER_BASE_URL,
        type: "openai-compatible",
      }),
    },
    log,
  );

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    throw new Error(
      `Failed to create TokenRouter provider node: ${createResponse.status} ${errorText}`,
    );
  }

  const createData = await createResponse.json();
  const nodeId = createData.id || createData.node?.id;

  if (!nodeId) {
    throw new Error(
      `No ID returned from provider node creation: ${JSON.stringify(createData)}`,
    );
  }

  log(`TokenRouter provider node created: ${nodeId}`);
  return nodeId;
}

/**
 * Register free models under tokenrouter provider.
 */
async function syncTokenRouterModelsToRouter(providerNodeId, connectionId, log) {
  log("Syncing TokenRouter free models into 9Router...");

  let modelIds = [...TOKENROUTER_FREE_CATALOG];

  // Prefer live /models from the connection when available
  if (connectionId) {
    try {
      const modelsRes = await routerApiFetch(
        `/api/providers/${connectionId}/models`,
        { method: "GET" },
        log,
      );
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        const models = modelsData.models || modelsData.data || [];
        const live = models
          .map((m) => m.id || m.name || m.model)
          .filter(Boolean);
        if (live.length) {
          // keep free catalog first, then any live ids
          modelIds = [...new Set([...TOKENROUTER_FREE_CATALOG, ...live])];
          log(`Live model list: ${live.length} ids`);
        }
      }
    } catch (e) {
      log(`Live model list failed: ${e.message}`);
    }
  }

  const aliases = [...new Set([providerNodeId, TOKENROUTER_PREFIX])];
  let added = 0;

  for (const id of modelIds) {
    for (const providerAlias of aliases) {
      const r = await routerApiFetch(
        "/api/models/custom",
        {
          method: "POST",
          body: JSON.stringify({ id, type: "llm", providerAlias }),
        },
        log,
      );
      if (r.ok) {
        try {
          const j = await r.json();
          if (j.added) added += 1;
        } catch {
          /* ignore */
        }
      }
    }
  }

  const defaultModel = modelIds.includes(TOKENROUTER_DEFAULT_MODEL)
    ? TOKENROUTER_DEFAULT_MODEL
    : modelIds[0];

  if (connectionId) {
    try {
      await routerApiFetch(
        `/api/providers/${connectionId}`,
        {
          method: "PUT",
          body: JSON.stringify({
            defaultModel,
            isActive: true,
          }),
        },
        log,
      );
    } catch (e) {
      log(`Could not set defaultModel: ${e.message}`);
    }
  }

  log(
    `TokenRouter models synced: ${modelIds.length} ids, ${added} new custom entries, default=${defaultModel}`,
  );
  return { added, total: modelIds.length, defaultModel };
}

/**
 * Import TokenRouter API key into 9Router.
 */
async function importTokenRouterKeyToRouter(providerNodeId, apiKey, log) {
  log("Importing TokenRouter key to 9Router...");

  const connectionName = `tokenrouter_free`;

  // Avoid duplicate connection with same name if re-run
  try {
    const list = await routerApiFetch("/api/providers", { method: "GET" }, log);
    if (list.ok) {
      const data = await list.json();
      const connections = data.connections || data.providers || data || [];
      const existing = Array.isArray(connections)
        ? connections.find(
            (c) =>
              c.name === connectionName ||
              (c.apiKey && String(c.apiKey).slice(-6) === apiKey.slice(-6)),
          )
        : null;
      if (existing?.id) {
        log(`Updating existing connection ${existing.id}...`);
        const put = await routerApiFetch(
          `/api/providers/${existing.id}`,
          {
            method: "PUT",
            body: JSON.stringify({
              apiKey,
              defaultModel: TOKENROUTER_DEFAULT_MODEL,
              isActive: true,
              testStatus: "active",
            }),
          },
          log,
        );
        if (!put.ok) {
          throw new Error(
            `Failed to update provider: ${put.status} ${await put.text()}`,
          );
        }
        return existing.id;
      }
    }
  } catch (e) {
    log(`List providers note: ${e.message}`);
  }

  const response = await routerApiFetch(
    "/api/providers",
    {
      method: "POST",
      body: JSON.stringify({
        provider: providerNodeId,
        name: connectionName,
        apiKey,
        defaultModel: TOKENROUTER_DEFAULT_MODEL,
        priority: 1,
        proxyPoolId: null,
        testStatus: "active",
      }),
    },
    log,
  );

  if (!response.ok) {
    throw new Error(
      `Failed to import TokenRouter key: ${response.status} ${await response.text()}`,
    );
  }

  const data = await response.json();
  const connectionId = data.id || data.connection?.id || data.provider?.id;
  log(`TokenRouter connection: ${connectionId || "ok"}`);
  return connectionId;
}

/**
 * Smoke-test key against TokenRouter /v1/models (optional).
 */
async function validateTokenRouterKey(apiKey, log) {
  log("Validating TokenRouter API key...");
  const res = await fetch(`${TOKENROUTER_BASE_URL}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`TokenRouter /models failed (${res.status}): ${text.slice(0, 200)}`);
  }
  let n = 0;
  try {
    const j = JSON.parse(text);
    n = Array.isArray(j.data) ? j.data.length : 0;
  } catch {
    /* ignore */
  }
  log(`TokenRouter key OK · ${n} models visible`);
  return true;
}

/**
 * Main: inject TOKENROUTER_API_KEY into 9Router + free GLM model.
 * @param {{ apiKey?: string, skipValidate?: boolean }} [opts]
 */
async function runTokenRouterInject(opts = {}) {
  const log = (msg) => console.log(`[tokenrouter] ${msg}`);

  if (!freeGlmStillActive()) {
    log(
      `Note: free GLM window (${FREE_GLM_UNTIL}) may have ended — still injects key if provided.`,
    );
  } else {
    log(`Free GLM 5.2 promo active until ${FREE_GLM_UNTIL}`);
  }

  const apiKey = (opts.apiKey || getTokenRouterApiKey()).trim();
  if (!apiKey) {
    throw new Error(
      "TOKENROUTER_API_KEY empty. Sign up at https://www.tokenrouter.com → create key → set in .env",
    );
  }

  if (!opts.skipValidate) {
    await validateTokenRouterKey(apiKey, log);
  }

  saveTokenRouterKey(apiKey, log);

  const providerNodeId = await ensureTokenRouterProviderNode(log);
  const connectionId = await importTokenRouterKeyToRouter(
    providerNodeId,
    apiKey,
    log,
  );
  await syncTokenRouterModelsToRouter(providerNodeId, connectionId, log);

  log("Done.");
  log(`  Use model: ${TOKENROUTER_DEFAULT_MODEL}`);
  log(`  (or prefix form if 9Router requires: tokenrouter/${TOKENROUTER_DEFAULT_MODEL})`);
  log(`  Free until: ${FREE_GLM_UNTIL}`);

  return {
    providerNodeId,
    connectionId,
    defaultModel: TOKENROUTER_DEFAULT_MODEL,
    freeUntil: FREE_GLM_UNTIL,
  };
}

// ─── Farm helpers (GraphQL + captcha + browser) ─────────────────────────────

async function pbdGraphql(query, variables = {}, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
    Origin: TOKENROUTER_SITE,
    Referer: `${TOKENROUTER_SITE}/`,
    Accept: "application/json",
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    ...(opts.userId ? { userid: String(opts.userId) } : {}),
  };
  const op = String(query).match(/\b(?:query|mutation)\s+([A-Za-z0-9_]+)/);
  const body = {
    query,
    variables,
    ...(op ? { operationName: op[1] } : {}),
  };
  const res = await fetch(PBD_GRAPHQL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `PBD GraphQL HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  if (json.errors?.length) {
    throw new Error(json.errors[0].message || "PBD GraphQL error");
  }
  return json.data;
}

function solvePbdSlideCaptcha(log) {
  const script = path.join(ROOT_DIR, "scripts", "pbd_slide_captcha.py");
  const py = process.env.PYTHON || "python3";
  const r = spawnSync(py, [script, "8"], {
    encoding: "utf-8",
    timeout: 60000,
  });
  const out = (r.stdout || "").trim();
  if (!out) {
    throw new Error(
      `slide captcha empty (stderr=${(r.stderr || "").slice(0, 200)})`,
    );
  }
  let data;
  try {
    data = JSON.parse(out.split("\n").filter(Boolean).pop());
  } catch {
    throw new Error(`slide captcha bad JSON: ${out.slice(0, 200)}`);
  }
  if (!data.ok) {
    throw new Error(`slide captcha failed: ${data.error || "unknown"}`);
  }
  if (log) {
    log(
      `Slide captcha OK score=${(data.score || 0).toFixed(3)} point=${data.point}`,
    );
  }
  return { captchaKey: data.captcha_key, captchaPoint: data.point };
}

const MUTATION_SEND_EMAIL_CODE = `
mutation MutationSendEmailVerificationCode($email: String!, $captchaKey: String!, $captchaPoint: String!) {
  mutationSendEmailVerificationCode(email: $email, captchaKey: $captchaKey, captchaPoint: $captchaPoint) {
    result
    data
  }
}`;

const MUTATION_EMAIL_REGISTER = `
mutation EmailRegister($email: String!, $password: String!, $verificationCode: String!, $captchaToken: String!) {
  emailRegister(email: $email, password: $password, verificationCode: $verificationCode, captchaToken: $captchaToken) {
    result
    status
    data
  }
}`;

const MUTATION_BUILDER_LOGIN = `
mutation builderLogin(
  $account: String
  $password: String
  $verificationCode: String
  $loginMethod: LoginMethod
  $oauthCode: String
  $acceptPromotion: Boolean
) {
  builderLogin(
    account: $account
    password: $password
    verificationCode: $verificationCode
    loginMethod: $loginMethod
    oauthCode: $oauthCode
    acceptPromotion: $acceptPromotion
  ) {
    result
    status
    data
  }
}`;

const MUTATION_AUTH_CODE = `
mutation AuthCode {
  mutationAuthCode {
    result
    data
  }
}`;

async function sendTokenRouterEmailCode(email, log) {
  const { captchaKey, captchaPoint } = solvePbdSlideCaptcha(log);
  const data = await pbdGraphql(MUTATION_SEND_EMAIL_CODE, {
    email,
    captchaKey,
    captchaPoint,
  });
  const r = data?.mutationSendEmailVerificationCode;
  if (!r || String(r.result).toLowerCase() !== "success") {
    throw new Error(
      `Send email code failed: ${JSON.stringify(r || data).slice(0, 200)}`,
    );
  }
  if (log) log("Verification email sent");
  return true;
}

/**
 * Solve Cap.js PoW via the site's native <cap-widget> (instrumentation runs in browser).
 * @returns {Promise<string>} captchaToken
 */
async function solveCapTokenInBrowser(page, log) {
  if (log) log("Solving Cap widget in browser...");

  // Wait for widget from Sign Up modal
  await page
    .locator("cap-widget")
    .first()
    .waitFor({ state: "visible", timeout: 20000 })
    .catch(() => {});

  const cap = page.locator("cap-widget").first();
  if (await cap.count()) {
    await cap.click({ force: true }).catch(() => {});
  }

  // Also poke shadow-root trigger (checkbox)
  await page.evaluate(() => {
    const w = document.querySelector("cap-widget");
    if (!w) return;
    try {
      w.click();
    } catch {
      /* ignore */
    }
    const sr = w.shadowRoot;
    if (sr) {
      const t = sr.querySelector(
        ".captcha, .captcha-trigger, button, [part='captcha']",
      );
      if (t) t.click();
    }
  });

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const tok = await page.evaluate(() => {
      const w = document.querySelector("cap-widget");
      const hidden = document.querySelector('input[name="cap-token"]');
      return (
        (w && w.token && String(w.token)) ||
        (hidden && hidden.value) ||
        ""
      );
    });
    if (tok && tok.length > 20) {
      if (log) log(`Cap token OK (${tok.slice(0, 18)}…)`);
      return tok;
    }
    await sleep(500);
  }
  throw new Error("Cap token not ready (timeout)");
}

function extractBuilderToken(payload) {
  if (!payload) return null;
  if (typeof payload === "string" && payload.length > 20) return payload;
  if (payload.token) return payload.token;
  if (payload.data?.token) return payload.data.token;
  return null;
}

async function emailRegisterTokenRouter(
  { email, password, verificationCode, captchaToken },
  log,
) {
  const data = await pbdGraphql(MUTATION_EMAIL_REGISTER, {
    email,
    password,
    verificationCode,
    captchaToken,
  });
  const r = data?.emailRegister;
  if (!r) throw new Error(`emailRegister empty: ${JSON.stringify(data)}`);
  if (String(r.result).toUpperCase() !== "SUCCESS" && !r.data?.token) {
    throw new Error(
      `emailRegister failed: ${JSON.stringify(r).slice(0, 300)}`,
    );
  }
  const pbdToken = extractBuilderToken(r.data) || extractBuilderToken(r);
  if (!pbdToken) {
    throw new Error(
      `emailRegister no token: ${JSON.stringify(r).slice(0, 300)}`,
    );
  }
  if (log) log("Email register OK (PBD token)");
  return { pbdToken, raw: r };
}

/**
 * Parse Set-Cookie headers into a cookie jar map.
 */
function mergeSetCookies(jar, setCookieHeaders) {
  const headers = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
      ? [setCookieHeaders]
      : [];
  for (const raw of headers) {
    const part = String(raw).split(";")[0];
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) jar[name] = value;
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .filter(([k]) => k && !k.startsWith("__"))
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/**
 * Bridge PaleBlueDot token → TokenRouter NewAPI session (Node cookie jar).
 * @returns {Promise<{ user: object, jar: Record<string,string> }>}
 */
function decodeJwtPayload(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return {};
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(pad, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

async function bridgePbdSession(pbdToken, log) {
  if (log) log("Bridging PBD → TokenRouter session (Node)...");

  const jwt = decodeJwtPayload(pbdToken);
  const pbdUserId = String(jwt.userId || jwt.pbdUserId || jwt.memberId || "");

  const data = await pbdGraphql(
    MUTATION_AUTH_CODE,
    {},
    { token: pbdToken, userId: pbdUserId },
  );
  const auth = data?.mutationAuthCode;
  const code =
    auth?.data?.code ||
    (typeof auth?.data === "string" ? auth.data : null) ||
    auth?.data;
  if (!code) {
    throw new Error(
      `AuthCode failed: ${JSON.stringify(data).slice(0, 300)}`,
    );
  }
  if (log) {
    log(
      `Auth code OK (${String(code).slice(0, 8)}…) pbdUser=${pbdUserId || "?"}`,
    );
  }

  const jar = {};
  // Match SPA: { token:"", userId:"", code } — field order as in minified client
  const loginBody = { token: "", userId: "", code: String(code) };
  const loginRes = await fetch(`${TOKENROUTER_API}/api/user/pbd-login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: TOKENROUTER_SITE,
      Referer: `${TOKENROUTER_SITE}/`,
      "TokenRouter-User": "-1",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(loginBody),
    redirect: "manual",
  });
  // Node fetch may expose getSetCookie
  const setCookies =
    typeof loginRes.headers.getSetCookie === "function"
      ? loginRes.headers.getSetCookie()
      : loginRes.headers.get("set-cookie")
        ? [loginRes.headers.get("set-cookie")]
        : [];
  mergeSetCookies(jar, setCookies);

  const loginJson = await loginRes.json().catch(() => ({}));
  if (!loginJson.success) {
    throw new Error(
      `pbd-login failed HTTP ${loginRes.status}: ${JSON.stringify(loginJson).slice(0, 300)}`,
    );
  }
  const user = loginJson.data || {};
  // Stash auth helpers for NewAPI headers
  if (user.id) jar.__userId = String(user.id);
  // SPA uses localStorage token (PBD JWT) as Authorization Bearer
  jar.__accessToken = String(
    user.token || user.access_token || pbdToken || "",
  );
  jar.__pbdToken = pbdToken;
  jar.__cliToken = user.cliToken || "";
  if (log) {
    log(
      `Session bridged user=${user.id || user.username || "?"} cookies=${Object.keys(jar)
        .filter((k) => !k.startsWith("__"))
        .join(",") || "none"}`,
    );
  }
  return { user, jar };
}

/**
 * Create + reveal NewAPI token key using cookie jar (Node).
 */
async function createTokenRouterApiKey(jar, log, namePrefix = "farm") {
  if (log) log("Creating API key via /api/token/ ...");
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Origin: TOKENROUTER_SITE,
    Referer: `${TOKENROUTER_SITE}/console/token`,
    Cookie: cookieHeader(jar),
    "TokenRouter-User": String(jar.__userId || "-1"),
    "Cache-Control": "no-store",
  };
  // SPA: Authorization Bearer = PBD JWT from localStorage "token"
  if (jar.__accessToken) {
    headers.Authorization = `Bearer ${jar.__accessToken}`;
  } else if (jar.__pbdToken) {
    headers.Authorization = `Bearer ${jar.__pbdToken}`;
  }

  const body = {
    name: `${namePrefix}-${Date.now().toString(36)}`,
    remain_quota: 500000000,
    expired_time: -1,
    unlimited_quota: true,
    model_limits_enabled: false,
    model_limits: "",
    allow_ips: "",
    group: "",
  };

  if (log) {
    log(
      `Auth cookie keys=${Object.keys(jar)
        .filter((k) => !k.startsWith("__"))
        .join(",") || "none"} user=${jar.__userId || "?"}`,
    );
  }

  const createRes = await fetch(`${TOKENROUTER_API}/api/token/`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  mergeSetCookies(
    jar,
    typeof createRes.headers.getSetCookie === "function"
      ? createRes.headers.getSetCookie()
      : [],
  );
  headers.Cookie = cookieHeader(jar);
  const createJson = await createRes.json().catch(() => ({}));
  if (!createJson.success) {
    throw new Error(
      `create token failed HTTP ${createRes.status}: ${JSON.stringify(createJson).slice(0, 300)}`,
    );
  }

  const listRes = await fetch(`${TOKENROUTER_API}/api/token/?p=1&size=100`, {
    headers: { ...headers, Cookie: cookieHeader(jar) },
  });
  const listJson = await listRes.json().catch(() => ({}));
  let items = listJson.data;
  if (items && !Array.isArray(items)) {
    items = items.items || items.data || items.records || [];
  }
  if (!Array.isArray(items) || !items.length) {
    throw new Error(
      `list tokens failed: ${JSON.stringify(listJson).slice(0, 300)}`,
    );
  }
  const match =
    items.find((t) => String(t.name || "").includes(namePrefix)) || items[0];
  const id = match.id;

  // Prefer direct key fields
  let apiKey = match.key || match.token || null;
  if (!apiKey || !String(apiKey).startsWith("sk-")) {
    const keyRes = await fetch(`${TOKENROUTER_API}/api/token/${id}/key`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Cookie: cookieHeader(jar),
        Origin: TOKENROUTER_SITE,
        "TokenRouter-User": String(jar.__userId || "-1"),
        ...(jar.__accessToken
          ? { Authorization: `Bearer ${jar.__accessToken}` }
          : {}),
      },
      body: "{}",
    });
    const keyJson = await keyRes.json().catch(() => ({}));
    apiKey =
      keyJson?.data?.key ||
      (typeof keyJson?.data === "string" ? keyJson.data : null) ||
      keyJson?.key ||
      null;
  }

  if (!apiKey || typeof apiKey !== "string") {
    throw new Error(
      `reveal key failed for id=${id}: ${JSON.stringify(match).slice(0, 200)}`,
    );
  }
  if (log) log(`API key created id=${id} …${apiKey.slice(-6)}`);
  return apiKey;
}

/**
 * Inject session cookies + localStorage into browser (optional UI path).
 */
async function applySessionToBrowser(page, { pbdToken, user, jar }, log) {
  if (log) log("Applying session to browser...");
  await page.goto(TOKENROUTER_SITE, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  const cookies = Object.entries(jar).map(([name, value]) => ({
    name,
    value,
    domain: ".tokenrouter.com",
    path: "/",
  }));
  if (cookies.length) {
    await page.context().addCookies(cookies).catch(() => {});
  }
  await page.evaluate(
    ({ pbdToken: t, user: u }) => {
      try {
        if (t) localStorage.setItem("token", t);
        if (u) {
          localStorage.setItem("user", JSON.stringify(u));
          localStorage.setItem("pbdUser", JSON.stringify(u));
        }
      } catch {
        /* ignore */
      }
    },
    { pbdToken, user },
  );
}

function saveFarmResult(email, apiKey, method, log) {
  const file = getResultFile();
  ensureFileExists(file);
  fs.appendFileSync(
    file,
    `${new Date().toISOString()}|${email}|${apiKey}|${method}\n`,
    "utf-8",
  );
  const accountFile = path.join(ROOT_DIR, "tokenrouter_account.json");
  let accounts = [];
  try {
    const raw = JSON.parse(fs.readFileSync(accountFile, "utf-8"));
    accounts = Array.isArray(raw) ? raw : [raw];
  } catch {
    accounts = [];
  }
  accounts.push({
    email,
    apiKey,
    method,
    createdAt: new Date().toISOString(),
  });
  fs.writeFileSync(accountFile, JSON.stringify(accounts, null, 2));
  if (log) log(`Saved → ${path.basename(file)} + tokenrouter_account.json`);
}

async function dismissOverlays(page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll(
      ".fixed.inset-0 button, [class*=cookie] button, [class*=promo] button, .tr-auth-close-button",
    )) {
      try {
        el.click();
      } catch {
        /* ignore */
      }
    }
  }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(400);
}

/**
 * Farm one account via tempmail (email verification).
 */
async function farmTokenRouterTempmail(opts = {}) {
  const log = opts.log || ((m) => console.log(`[tokenrouter:tempmail] ${m}`));
  const password = opts.password || DEFAULT_FARM_PASSWORD;
  const signupOnly = !!opts.signupOnly;
  const config = getConfig();

  log("Creating tempmail...");
  const { email, sessionId } = await createTempmail();
  log(`Email: ${email}`);

  log("Sending verification code (slide captcha + GraphQL)...");
  await sendTokenRouterEmailCode(email, log);

  log("Polling tempmail for code...");
  const code = await pollTempmail(email, sessionId, "digits6");
  if (!code) throw new Error("No verification code from tempmail");
  log(`Code: ${code}`);

  log("Launching browser for Cap + session...");
  const browser = await launchCamoufox({ headless: config.headless });
  const { page } = await newFarmPage(browser);
  page.setDefaultTimeout(90000);

  try {
    await page.goto(`${TOKENROUTER_SITE}/models`, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    await sleep(2500);
    await dismissOverlays(page);

    // Open Sign Up so Cap/context is same-origin as production
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) =>
        /^Sign Up$/i.test((x.innerText || "").trim()),
      );
      if (b) b.click();
    });
    await sleep(2000);

    const captchaToken = await solveCapTokenInBrowser(page, log);
    // Cap done — browser no longer needed for register/bridge/key
    await browser.close().catch(() => {});

    const { pbdToken } = await emailRegisterTokenRouter(
      {
        email,
        password,
        verificationCode: code,
        captchaToken,
      },
      log,
    );

    const { user, jar } = await bridgePbdSession(pbdToken, log);
    const apiKey = await createTokenRouterApiKey(jar, log, "tm");
    saveFarmResult(email, apiKey, "tempmail", log);

    if (!signupOnly) {
      log("Injecting into 9Router...");
      await runTokenRouterInject({ apiKey, skipValidate: false });
    }

    return { email, password, apiKey, method: "tempmail", user };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Farm / login via Google OAuth social button.
 * @param {{ email: string, password: string }} account
 */
async function farmTokenRouterGoogle(account, opts = {}) {
  const log = opts.log || ((m) => console.log(`[tokenrouter:google] ${m}`));
  const signupOnly = !!opts.signupOnly;
  const config = getConfig();

  if (!account?.email || !account?.password) {
    throw new Error("Google farm needs account.email + account.password");
  }

  log(`Launching browser for Google login: ${account.email}`);
  const browser = await launchCamoufox({ headless: config.headless });
  const { page } = await newFarmPage(browser);
  page.setDefaultTimeout(120000);

  const bag = new Set();
  page.on("response", async (response) => {
    try {
      const ct = (response.headers()["content-type"] || "").toLowerCase();
      const url = response.url();
      if (response.status() >= 400) return;
      if (
        !ct.includes("json") &&
        !/token|key|auth|pbd-login|api\/token/i.test(url)
      ) {
        return;
      }
      const text = await response.text().catch(() => "");
      for (const m of text.match(KEY_RE) || []) bag.add(m);
    } catch {
      /* ignore */
    }
  });

  try {
    await page.goto(`${TOKENROUTER_SITE}/models`, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    await sleep(2500);
    await dismissOverlays(page);

    // Open Sign In (or Sign Up) then Google social
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const b =
        btns.find((x) => /^Sign In$/i.test((x.innerText || "").trim())) ||
        btns.find((x) => /^Sign Up$/i.test((x.innerText || "").trim()));
      if (b) b.click();
    });
    await sleep(2000);

    log("Clicking Google social button...");
    const context = page.context();
    const popupPromise = context
      .waitForEvent("page", { timeout: 25000 })
      .catch(() => null);

    const googleClicked = await page.evaluate(() => {
      const googleIcon = document.querySelector(
        ".tr-auth-social-icon--google, [class*=tr-auth-social-icon--google]",
      );
      if (googleIcon) {
        const btn =
          googleIcon.closest(
            "button, a, [role=button], .tr-auth-social-button",
          ) || googleIcon;
        btn.click();
        return "icon";
      }
      const social = [...document.querySelectorAll(".tr-auth-social-button")];
      if (social[0]) {
        social[0].click();
        return "first-social";
      }
      return null;
    });
    if (!googleClicked) {
      throw new Error("Google social button not found");
    }
    log(`Google button: ${googleClicked}`);

    let googlePage = page;
    const popup = await popupPromise;
    if (popup) {
      googlePage = popup;
      await googlePage.waitForLoadState("domcontentloaded").catch(() => {});
      log(`Google popup: ${googlePage.url().slice(0, 80)}`);
    } else {
      // same-tab redirect
      await page
        .waitForURL(/accounts\.google\.com/, { timeout: 20000 })
        .catch(() => {});
      log(`Google same-tab: ${page.url().slice(0, 80)}`);
    }

    if (!/accounts\.google\.com/i.test(googlePage.url())) {
      await sleep(2500);
    }

    if (/accounts\.google\.com/i.test(googlePage.url())) {
      log("Completing Google login (Playwright)...");
      // account chooser tile
      const chose = await googlePage
        .evaluate((email) => {
          const nodes = [
            ...document.querySelectorAll(
              `[data-identifier], [data-email], li, div[role=link]`,
            ),
          ];
          const hit = nodes.find((el) =>
            (el.getAttribute("data-identifier") ||
              el.getAttribute("data-email") ||
              el.innerText ||
              ""
            ).includes(email),
          );
          if (hit) {
            hit.click();
            return true;
          }
          return false;
        }, account.email)
        .catch(() => false);

      if (chose) {
        log("Clicked account chooser tile");
        await sleep(2000);
      } else {
        const emailInput = googlePage.locator("#identifierId").first();
        if (await emailInput.isVisible({ timeout: 15000 }).catch(() => false)) {
          log(`Typing email: ${account.email}`);
          await emailInput.fill(account.email);
          await sleep(500);
          await googlePage.locator("#identifierNext").click().catch(() => {});
          await sleep(2000);
        }
      }

      const pw = googlePage.locator('input[type="password"]').first();
      if (await pw.isVisible({ timeout: 20000 }).catch(() => false)) {
        log("Typing password...");
        await pw.fill(account.password);
        await sleep(500);
        await googlePage
          .locator("#passwordNext")
          .click()
          .catch(async () => {
            await googlePage.keyboard.press("Enter");
          });
        await sleep(3000);
      }

      // consent / continue
      for (const text of ["Continue", "Allow", "I agree", "Lanjutkan"]) {
        const btn = googlePage.getByRole("button", { name: text }).first();
        if (await btn.isVisible({ timeout: 2500 }).catch(() => false)) {
          log(`Click consent: ${text}`);
          await btn.click().catch(() => {});
          await sleep(1500);
          break;
        }
      }
    }

    // Wait back on tokenrouter logged in
    log("Waiting for TokenRouter session...");
    await page
      .waitForFunction(
        () => {
          try {
            const u = localStorage.getItem("user") || localStorage.getItem("token");
            return !!u && location.hostname.includes("tokenrouter.com");
          } catch {
            return location.hostname.includes("tokenrouter.com") &&
              !location.href.includes("accounts.google");
          }
        },
        { timeout: 120000 },
      )
      .catch(() => {});
    await sleep(3000);

    // Prefer PBD token sniffed from network / localStorage
    let pbdToken = await page.evaluate(() => {
      try {
        return localStorage.getItem("token") || "";
      } catch {
        return "";
      }
    });

    // Also try reading from bag of sk- is wrong — look for JWT-like tokens in responses via localStorage user
    if (!pbdToken || pbdToken.length < 20) {
      log("Google session unclear — trying password builderLogin...");
      try {
        const data = await pbdGraphql(MUTATION_BUILDER_LOGIN, {
          account: account.email,
          password: account.password,
          loginMethod: "PASSWORD",
          acceptPromotion: true,
        });
        const r = data?.builderLogin;
        pbdToken = extractBuilderToken(r?.data) || extractBuilderToken(r) || "";
        if (!pbdToken) {
          log(`Password login no token: ${JSON.stringify(r).slice(0, 200)}`);
        }
      } catch (e) {
        log(`Password login fallback: ${e.message}`);
      }
    }

    if (!pbdToken) {
      // last resort: sniffed sk keys only useful after session
      if (bag.size) {
        const apiKey = [...bag][0];
        saveFarmResult(account.email, apiKey, "google-sniff", log);
        if (!signupOnly) {
          await runTokenRouterInject({ apiKey, skipValidate: false });
        }
        return { email: account.email, apiKey, method: "google-sniff" };
      }
      throw new Error(
        "Google OAuth did not establish a session (popup blocked / 2FA / wrong password). Try headed mode: PW_HEADLESS=0",
      );
    }

    const { jar } = await bridgePbdSession(pbdToken, log);
    const apiKey = await createTokenRouterApiKey(jar, log, "gg");
    saveFarmResult(account.email, apiKey, "google", log);

    if (!signupOnly) {
      log("Injecting into 9Router...");
      await runTokenRouterInject({ apiKey, skipValidate: false });
    }

    return { email: account.email, apiKey, method: "google" };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Run TokenRouter farm: tempmail and/or Google.
 * @param {{ count?: number, methods?: ('tempmail'|'google')[], googleAccount?: {email,password}, signupOnly?: boolean }} opts
 */
async function runTokenRouterFarm(opts = {}) {
  const log = (msg) => console.log(`[tokenrouter:farm] ${msg}`);
  const methods = opts.methods?.length
    ? opts.methods
    : ["tempmail", "google"];
  const count = Math.max(1, opts.count || 1);
  const results = [];
  const errors = [];

  log(
    `Starting farm methods=${methods.join(",")} count=${count} freeUntil=${FREE_GLM_UNTIL}`,
  );

  if (methods.includes("tempmail")) {
    for (let i = 0; i < count; i++) {
      try {
        log(`── tempmail #${i + 1}/${count} ──`);
        const r = await farmTokenRouterTempmail({
          signupOnly: opts.signupOnly,
          password: opts.password,
        });
        results.push(r);
        log(`tempmail OK ${r.email} key=…${r.apiKey.slice(-6)}`);
      } catch (e) {
        log(`tempmail FAIL: ${e.message}`);
        errors.push({ method: "tempmail", error: e.message });
      }
    }
  }

  if (methods.includes("google")) {
    const acc =
      opts.googleAccount ||
      (opts.email && opts.password
        ? { email: opts.email, password: opts.password }
        : null);
    if (!acc) {
      log("Google skipped: no googleAccount provided");
      errors.push({ method: "google", error: "no account" });
    } else {
      try {
        log(`── google ${acc.email} ──`);
        const r = await farmTokenRouterGoogle(acc, {
          signupOnly: opts.signupOnly,
        });
        results.push(r);
        log(`google OK key=…${r.apiKey.slice(-6)}`);
      } catch (e) {
        log(`google FAIL: ${e.message}`);
        errors.push({ method: "google", error: e.message, email: acc.email });
      }
    }
  }

  log(
    `Done. success=${results.length} failed=${errors.length}`,
  );
  return { results, errors };
}

module.exports = {
  runTokenRouterInject,
  runTokenRouterFarm,
  farmTokenRouterTempmail,
  farmTokenRouterGoogle,
  sendTokenRouterEmailCode,
  ensureTokenRouterProviderNode,
  importTokenRouterKeyToRouter,
  syncTokenRouterModelsToRouter,
  validateTokenRouterKey,
  TOKENROUTER_BASE_URL,
  TOKENROUTER_DEFAULT_MODEL,
  FREE_GLM_UNTIL,
  freeGlmStillActive,
};
