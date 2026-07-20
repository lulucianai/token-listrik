const fs = require("fs");
const path = require("path");
const { getConfig, getResultFile, ROOT_DIR } = require("./config");
const {
  sleep,
  randomDelay,
  createFileLogger,
  ensureFileExists,
} = require("./utils");
const { createTempmail, pollTempmail } = require("./tempmail");
const { launchCamoufox, newFarmPage } = require("./camoufox");
const { STEPS, createProgressManager } = require("./progress");
const { printReport } = require("./reporter");
const { routerApiFetch } = require("./router-api");

const YUNWU_ORIGIN = "https://yunwu.ai";
const REGISTER_URL = `${YUNWU_ORIGIN}/register`;
const LOGIN_URL = `${YUNWU_ORIGIN}/login`;
const TOKEN_CONSOLE_URL = `${YUNWU_ORIGIN}/console/token`;
const YUNWU_BASE_URL = "https://yunwu.ai/v1";
const YUNWU_PASSWORD = "YunwuFarm2026!";
const YUNWU_DEFAULT_MODEL = "deepseek-v4-pro";
const YUNWU_PROVIDER_ALIAS_PREFIX = "yunwu";
const TIMEOUT = 120000;

/** Fallback model catalog when live /v1/models is empty / fails. */
const YUNWU_MODEL_CATALOG = [
  "glm-5.2",
  "glm-5.1",
  "glm-5",
  "glm-5-turbo",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-v3",
  "deepseek-r1",
  "MiniMax-M2.1",
  "MiniMax-M2",
  "kimi-k3",
  "kimi-k2.5",
  "kimi-k2",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "claude-opus-4-8",
  "claude-sonnet-4-5",
  "gemini-2.5-flash",
  "gemini-3-flash-preview",
];

function randomUsername() {
  const adj = ["swift", "quiet", "bright", "calm", "neon", "lunar", "amber", "coral"];
  const noun = ["fox", "kite", "wave", "node", "pixel", "orbit", "maple", "river"];
  const a = adj[Math.floor(Math.random() * adj.length)];
  const n = noun[Math.floor(Math.random() * noun.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  // NewAPI username usually alphanumeric; keep short
  return `${a}${n}${num}`.slice(0, 20);
}

function saveApiKey(email, apiKey, log, extra = {}) {
  const resultFile = getResultFile("yunwu");
  ensureFileExists(resultFile);
  fs.appendFileSync(resultFile, `${email}|${apiKey}\n`);
  log(`API key saved to ${resultFile}`);

  const keyFile = path.join(ROOT_DIR, "yunwu_keys.txt");
  fs.appendFileSync(keyFile, `${email}|${apiKey}\n`);

  const accountFile = path.join(ROOT_DIR, "yunwu_account.json");
  let accounts = [];
  try {
    const raw = JSON.parse(fs.readFileSync(accountFile, "utf-8"));
    accounts = Array.isArray(raw) ? raw : [raw];
  } catch (_) {
    accounts = [];
  }
  accounts.push({
    email,
    apiKey,
    createdAt: new Date().toISOString(),
    ...extra,
  });
  fs.writeFileSync(accountFile, JSON.stringify(accounts, null, 2));
  log("Account appended to yunwu_account.json");
}

/**
 * Ensure openai-compatible Yunwu provider node in 9Router.
 * @returns {Promise<string>} provider node id
 */
async function ensureYunwuProviderNode(log) {
  log("Checking Yunwu provider node in 9Router...");

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
        n.prefix === "yunwu" ||
          (n.name && String(n.name).toLowerCase() === "yunwu"),
    )
    : null;

  if (existingNode) {
    log(`Yunwu provider node exists: ${existingNode.id}`);
    return existingNode.id;
  }

  log("Creating Yunwu provider node...");

  const createResponse = await routerApiFetch(
    "/api/provider-nodes",
    {
      method: "POST",
      body: JSON.stringify({
        name: "Yunwu",
        prefix: "yunwu",
        apiType: "chat",
        baseUrl: YUNWU_BASE_URL,
        type: "openai-compatible",
      }),
    },
    log,
  );

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    throw new Error(
      `Failed to create Yunwu provider node: ${createResponse.status} ${errorText}`,
    );
  }

  const createData = await createResponse.json();
  const nodeId = createData.id || createData.node?.id;

  if (!nodeId) {
    throw new Error(
      `No ID returned from provider node creation: ${JSON.stringify(createData)}`,
    );
  }

  log(`Yunwu provider node created: ${nodeId}`);
  return nodeId;
}

/**
 * Register models under yunwu provider (live /models preferred, else static catalog).
 */
async function syncYunwuModelsToRouter(providerNodeId, connectionId, log) {
  log("Syncing Yunwu models into 9Router custom model list...");

  let modelIds = [];

  if (connectionId) {
    try {
      const modelsRes = await routerApiFetch(
        `/api/providers/${connectionId}/models`,
        { method: "GET" },
        log,
      );
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        const models = modelsData.models || [];
        modelIds = models
          .map((m) => m.id || m.name || m.model)
          .filter(Boolean);
      }
    } catch (e) {
      log(`Live model list failed: ${e.message}`);
    }
  }

  if (modelIds.length === 0) {
    modelIds = [...YUNWU_MODEL_CATALOG];
    log(`Using static Yunwu catalog (${modelIds.length} models)`);
  }

  const aliases = [...new Set([providerNodeId, YUNWU_PROVIDER_ALIAS_PREFIX])];
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
          if (j.added) {
            added += 1;
          }
        } catch {
          // ignore parse
        }
      }
    }
  }

  const defaultModel = modelIds.includes(YUNWU_DEFAULT_MODEL)
    ? YUNWU_DEFAULT_MODEL
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
    `Yunwu models synced: ${modelIds.length} ids, ${added} new custom entries, default=${defaultModel}`,
  );
  return { added, total: modelIds.length, defaultModel };
}

/**
 * Import farmed Yunwu API key into 9Router.
 */
async function importYunwuKeyToRouter(providerNodeId, email, apiKey, log) {
  log("Importing Yunwu key to 9Router...");

  const short = email.split("@")[0].slice(0, 12);
  const connectionName = `yunwu_${short}`;

  const response = await routerApiFetch(
    "/api/providers",
    {
      method: "POST",
      body: JSON.stringify({
        provider: providerNodeId,
        name: connectionName,
        apiKey,
        defaultModel: YUNWU_DEFAULT_MODEL,
        priority: 1,
        proxyPoolId: null,
        testStatus: "active",
      }),
    },
    log,
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Router registration failed: ${response.status} ${errorText}`,
    );
  }

  log(`Yunwu key for ${email} imported to 9Router as "${connectionName}"`);

  let connectionId =
    (await response
      .clone()
      .json()
      .catch(() => ({}))).id ||
    (await response
      .clone()
      .json()
      .catch(() => ({}))).connection?.id ||
    null;

  if (!connectionId) {
    const list = await routerApiFetch("/api/providers", { method: "GET" }, log);
    if (list.ok) {
      const data = await list.json();
      const conns = data.connections || data || [];
      const found = (Array.isArray(conns) ? conns : []).find(
        (c) => c.name === connectionName,
      );
      connectionId = found?.id || null;
    }
  }

  if (connectionId) {
    try {
      await syncYunwuModelsToRouter(providerNodeId, connectionId, log);
    } catch (e) {
      log(`Model sync failed (key still imported): ${e.message}`);
    }
  } else {
    log("Could not resolve connection id — skip model sync");
  }

  return { connectionName, connectionId };
}

/**
 * Fill Semi Design Input by field name / placeholder / label heuristics.
 */
async function fillField(page, candidates, value) {
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
      await loc.click({ timeout: 3000 }).catch(() => {});
      await loc.fill("");
      await loc.fill(value);
      return true;
    }
  }
  // Try label-adjacent inputs
  return false;
}

async function clickButtonByText(page, texts) {
  for (const text of texts) {
    // Prefer role-based name match (handles "Get Verification Code")
    try {
      const byRole = page.getByRole("button", {
        name: new RegExp(text, "i"),
      });
      if (await byRole.first().isVisible({ timeout: 800 }).catch(() => false)) {
        await byRole.first().click({ timeout: 5000 });
        return true;
      }
    } catch {
      // fall through
    }
    const btn = page
      .locator("button, a, [role='button']")
      .filter({ hasText: new RegExp(text, "i") })
      .first();
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.click({ timeout: 5000 });
      return true;
    }
  }
  return false;
}

/** Click Yunwu "Get Verification Code" (EN/CN) next to email field. */
async function clickGetVerificationCode(page, log) {
  const patterns = [
    /get\s*verification\s*code/i,
    /send\s*verification\s*code/i,
    /get\s*code/i,
    /send\s*code/i,
    /获取验证码/,
    /发送验证码/,
    /获取/,
    /发送/,
  ];

  for (const re of patterns) {
    try {
      const byRole = page.getByRole("button", { name: re });
      if (await byRole.first().isVisible({ timeout: 600 }).catch(() => false)) {
        log(`Clicking send-code button (role: ${re})`);
        await byRole.first().click({ timeout: 5000 });
        return true;
      }
    } catch {
      // continue
    }
    try {
      const btn = page.locator("button").filter({ hasText: re }).first();
      if (await btn.isVisible({ timeout: 600 }).catch(() => false)) {
        log(`Clicking send-code button (text: ${re})`);
        await btn.click({ timeout: 5000 });
        return true;
      }
    } catch {
      // continue
    }
  }

  // Semi Design input group: button sibling of email input
  const nearEmail = await page
    .evaluate(() => {
      const email =
        document.querySelector('input[type="email"]') ||
        document.querySelector('input[placeholder*="Email" i]') ||
        document.querySelector('input[placeholder*="邮箱"]');
      if (!email) {
        return null;
      }
      let root = email.parentElement;
      for (let i = 0; i < 5 && root; i++) {
        const btn = root.querySelector("button");
        if (btn && /code|验证|发送|获取|send|get/i.test(btn.innerText || "")) {
          btn.setAttribute("data-yunwu-send", "1");
          return true;
        }
        root = root.parentElement;
      }
      return false;
    })
    .catch(() => false);

  if (nearEmail) {
    const btn = page.locator("button[data-yunwu-send='1']").first();
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      log("Clicking send-code button (near email input)");
      await btn.click({ timeout: 5000 });
      return true;
    }
  }

  return false;
}

async function checkUserAgreement(page, log) {
  const checked = await page
    .evaluate(() => {
      const boxes = [
        ...document.querySelectorAll(
          'input[type="checkbox"], .semi-checkbox, [role="checkbox"]',
        ),
      ];
      for (const el of boxes) {
        const label = (el.closest("label") || el.parentElement)?.innerText || "";
        if (/agreement|协议|同意|user agreement/i.test(label) || boxes.length === 1) {
          if (el.getAttribute("aria-checked") === "true" || el.checked) {
            return "already";
          }
          if (el.tagName === "INPUT") {
            el.click();
            return "clicked-input";
          }
          el.click();
          return "clicked";
        }
      }
      // Fallback: first unchecked checkbox on form
      const first = document.querySelector(
        'input[type="checkbox"]:not(:checked)',
      );
      if (first) {
        first.click();
        return "clicked-first";
      }
      return "none";
    })
    .catch(() => "none");
  if (checked && checked !== "none" && checked !== "already") {
    log(`User agreement checkbox: ${checked}`);
  }
  return checked;
}

/**
 * Wait for go-captcha modal + optional human solve.
 * Watches network for captcha check success and /api/verification success.
 *
 * Yunwu uses go-captcha click-shape for send-code (captcha_send_code_enabled).
 * Auto-solving shapes is unreliable; headed browser + human click is supported.
 */
async function waitForCaptchaAndSendCode(page, log, timeoutMs = 180000, opts = {}) {
  const start = Date.now();
  let captchaSeen = false;
  let codeSent = false;
  let captchaToken = null;
  let lastResend = 0;
  const headless = !!opts.headless;

  const onResponse = async (response) => {
    try {
      const url = response.url();
      if (
        (url.includes("/api/go-captcha-check-data/") ||
          url.includes("go-captcha") ||
          url.includes("captcha")) &&
        response.status() === 200
      ) {
        const data = await response.json().catch(() => null);
        if (data && (data.code === 0 || data.success) && (data.token || data.data?.token)) {
          captchaToken = data.token || data.data?.token;
          log("Captcha check passed (token captured)");
        }
      }
      if (
        (url.includes("/api/verification") ||
          url.includes("/api/user/verification") ||
          url.includes("send_email") ||
          url.includes("send_code")) &&
        response.status() === 200
      ) {
        const data = await response.json().catch(() => null);
        if (
          data &&
          (data.success === true ||
            data.code === 0 ||
            data.message === "success" ||
            /success|发送成功|已发送/i.test(String(data.message || "")))
        ) {
          codeSent = true;
          log("Verification email requested successfully");
        } else if (data && data.message) {
          log(`Verification API: ${JSON.stringify(data).slice(0, 160)}`);
        }
      }
    } catch {
      // ignore listener errors
    }
  };

  page.on("response", onResponse);

  try {
    while (Date.now() - start < timeoutMs) {
      if (codeSent) {
        return { ok: true, captchaToken };
      }

      const captchaVisible = await page
        .evaluate(() => {
          const text = document.body?.innerText || "";
          const hasShape =
            !!document.querySelector("canvas") ||
            !!document.querySelector('img[src^="data:image"]') ||
            /点击|click|验证|captcha|换一张|点选/i.test(text);
          const modal =
            document.querySelector(".semi-modal") ||
            document.querySelector(".semi-modal-wrap") ||
            document.querySelector("[class*='captcha']") ||
            document.querySelector("[class*='Captcha']") ||
            document.querySelector("[class*='go-captcha']");
          return (
            !!(hasShape && modal) ||
            /人机验证|完成验证|slide|点选|click the|select all/i.test(text)
          );
        })
        .catch(() => false);

      if (captchaVisible && !captchaSeen) {
        captchaSeen = true;
        if (headless) {
          log(
            "⚠️  go-captcha opened in HEADLESS mode — cannot solve click-shape automatically.",
          );
          log(
            "   Re-run headed: node -e 'require(\"./src/yunwu\").runYunwuAutomation(1)'",
          );
          log("   (do NOT pass headless:true / YUNWU_HEADLESS=1)");
          // Fail fast instead of waiting full timeout
          return {
            ok: false,
            captchaToken,
            error:
              "go-captcha requires headed browser — run without headless (default)",
          };
        }
        log(
          "⚠️  go-captcha (click-shape) is open — solve it in the browser window, then wait…",
        );
      }

      // Re-click send-code periodically if no captcha / no success yet
      const now = Date.now();
      if (!codeSent && now - lastResend > 8000) {
        lastResend = now;
        if (captchaToken || !captchaSeen) {
          await clickGetVerificationCode(page, log).catch(() => {});
        }
      }

      await sleep(1500);
    }
  } finally {
    page.off("response", onResponse);
  }

  if (codeSent) {
    return { ok: true, captchaToken };
  }
  return {
    ok: false,
    captchaToken,
    error: captchaSeen
      ? "Captcha not completed in time (click-shape) — solve manually in headed window"
      : "Verification email was not sent (send-code/captcha timeout)",
  };
}

/**
 * After session is live in the page, create an API token via NewAPI REST.
 * Auth: session cookie (withCredentials) + New-API-User header from localStorage.user.id
 * Key format: often sk-... or bare key string in token.key
 */
async function createYunwuApiToken(page, log, name) {
  const result = await page.evaluate(async (tokenName) => {
    try {
      let user = null;
      try {
        user = JSON.parse(localStorage.getItem("user") || "null");
      } catch {
        user = null;
      }
      if (!user || !user.id) {
        return { error: "No user in localStorage (not logged in)" };
      }

      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "New-API-User": String(user.id),
        "Cache-Control": "no-store",
      };
      // Some deployments also accept Authorization: Bearer session token
      if (user.token) {
        headers.Authorization = `Bearer ${user.token}`;
      }

      // Prefer create new token
      const createBody = {
        name: tokenName || `farm_${Date.now()}`,
        remain_quota: 500000,
        expired_time: -1,
        unlimited_quota: true,
        model_limits_enabled: false,
        model_limits: "",
        allow_ips: "",
        group: "",
      };

      const createRes = await fetch("/api/token/", {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify(createBody),
      });
      const createJson = await createRes.json().catch(() => ({}));

      // List tokens
      const listRes = await fetch("/api/token/?p=1&size=20", {
        method: "GET",
        headers,
        credentials: "include",
      });
      const listJson = await listRes.json().catch(() => ({}));

      let items = [];
      if (listJson && listJson.success) {
        const d = listJson.data;
        if (Array.isArray(d)) {
          items = d;
        } else if (d && Array.isArray(d.items)) {
          items = d.items;
        } else if (d && Array.isArray(d.data)) {
          items = d.data;
        }
      }

      // Prefer newest enabled token with a key
      const withKey = items.filter((t) => t && (t.key || t.token));
      const pick =
        withKey.find((t) => t.name === tokenName) ||
        withKey.find((t) => t.status === 1) ||
        withKey[0] ||
        null;

      let key = pick?.key || pick?.token || null;
      if (key && !String(key).startsWith("sk-") && String(key).length > 8) {
        // NewAPI sometimes stores raw key; clients use sk- prefix optionally
        // keep raw — 9Router / openai-compatible accept either depending on gateway
      }

      // Some create responses return key directly
      if (!key && createJson) {
        key =
          createJson.data?.key ||
          createJson.key ||
          createJson.data?.token ||
          null;
      }

      return {
        success: !!(key || createJson.success),
        key,
        createJson,
        listCount: items.length,
        userId: user.id,
        username: user.username,
      };
    } catch (e) {
      return { error: e.message };
    }
  }, name);

  if (result?.error) {
    throw new Error(result.error);
  }
  if (!result?.key) {
    log(
      `Token create/list response: ${JSON.stringify(result?.createJson || {}).slice(0, 300)}`,
    );
    // Fallback: scrape console token page DOM
    await page.goto(TOKEN_CONSOLE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    }).catch(() => {});
    await sleep(4000);
    const scraped = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const m =
        text.match(/sk-[A-Za-z0-9]{16,}/) ||
        text.match(/\b[a-f0-9]{48,}\b/i);
      return m ? m[0] : null;
    });
    if (scraped) {
      log("Scraped API key from console DOM");
      return scraped;
    }
    throw new Error(
      `Could not create/read Yunwu API token (listCount=${result?.listCount || 0})`,
    );
  }

  log(`API token created/listed (user #${result.userId})`);
  return result.key;
}

async function farmOneYunwu(idx, log, updateProgress, opts = {}) {
  const config = getConfig();
  const signupOnly = !!opts.signupOnly;
  // Click-shape captcha cannot be auto-solved; default HEADED.
  // Only force headless if explicitly requested (will usually fail at captcha).
  const headless =
    opts.headless === true || process.env.YUNWU_HEADLESS === "1";
  const slog = (msg) => log(`[Yunwu #${idx}] ${msg}`);

  updateProgress({ step: "Creating tempmail", email: `farm#${idx}` });
  slog("Creating tempmail...");
  const { email, sessionId } = await createTempmail();
  slog(`Email: ${email}`);

  const username = randomUsername();
  const password = YUNWU_PASSWORD;
  slog(`Username: ${username}`);

  updateProgress({ step: STEPS.LAUNCHING, email });
  slog(
    `Launching Camoufox (headless=${headless}${headless ? " — captcha may fail" : ""})...`,
  );
  const browser = await launchCamoufox({ headless });
  const { context, page } = await newFarmPage(browser);

  const ssDir = path.join(ROOT_DIR, "screenshots");
  if (!fs.existsSync(ssDir)) {
    fs.mkdirSync(ssDir, { recursive: true });
  }
  let stepNum = 0;
  const ss = async (label) => {
    stepNum += 1;
    await page
      .screenshot({
        path: path.join(
          ssDir,
          `yunwu_${idx}_${String(stepNum).padStart(2, "0")}_${label}.png`,
        ),
      })
      .catch(() => {});
  };

  try {
    updateProgress({ step: STEPS.NAVIGATING });
    slog("Navigating to register page...");
    await page
      .goto(REGISTER_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT })
      .catch(() => {});
    await sleep(4000);
    await ss("register_page");

    // Ensure email registration tab if tabs exist
    await clickButtonByText(page, [
      "账号注册",
      "邮箱",
      "Email",
      "Register",
      "注册",
    ]);
    await sleep(1000);

    updateProgress({ step: "Fill form" });
    slog("Filling registration form...");

    const filledUser = await fillField(page, [
      'input[name="username"]',
      'input[autocomplete="username"]',
      'input[placeholder*="用户名"]',
      'input[placeholder*="username" i]',
    ], username);
    if (!filledUser) {
      // Semi Design: first text input
      const inputs = page.locator('input[type="text"], input:not([type])');
      const count = await inputs.count();
      if (count > 0) {
        await inputs.nth(0).fill(username);
      } else {
        throw new Error("Cannot find username input");
      }
    }

    // Passwords (two fields)
    const pwInputs = page.locator('input[type="password"]');
    const pwCount = await pwInputs.count();
    if (pwCount >= 1) {
      await pwInputs.nth(0).fill(password);
    }
    if (pwCount >= 2) {
      await pwInputs.nth(1).fill(password);
    } else {
      await fillField(page, [
        'input[name="password"]',
        'input[name="password2"]',
      ], password);
    }

    const filledEmail = await fillField(page, [
      'input[name="email"]',
      'input[type="email"]',
      'input[placeholder*="邮箱"]',
      'input[placeholder*="email" i]',
    ], email);
    if (!filledEmail) {
      // last non-password text-ish input
      const allText = page.locator(
        'input[type="email"], input[type="text"], input:not([type="password"])',
      );
      const n = await allText.count();
      if (n > 0) {
        await allText.nth(n - 1).fill(email);
      } else {
        throw new Error("Cannot find email input");
      }
    }

    await sleep(800);
    await ss("form_filled");

    updateProgress({ step: "Send code / captcha" });
    slog("Requesting email verification code...");
    const sendClicked = await clickGetVerificationCode(page, slog);
    if (!sendClicked) {
      slog(
        "Send-code button not found — dumping buttons for debug…",
      );
      const btnTexts = await page
        .evaluate(() =>
          [...document.querySelectorAll("button")]
            .map((b) => (b.innerText || "").trim())
            .filter(Boolean)
            .slice(0, 20),
        )
        .catch(() => []);
      slog(`Buttons on page: ${JSON.stringify(btnTexts)}`);
      await ss("no_send_button");
      throw new Error(
        'Cannot find "Get Verification Code" button on register form',
      );
    }

    const captchaWaitMs =
      Number(process.env.YUNWU_CAPTCHA_TIMEOUT_MS) || 180000;
    const sendResult = await waitForCaptchaAndSendCode(
      page,
      slog,
      captchaWaitMs,
      { headless },
    );
    if (!sendResult.ok) {
      await ss("captcha_timeout");
      throw new Error(sendResult.error || "Failed to send verification email");
    }
    await ss("code_sent");

    updateProgress({ step: "Waiting OTP" });
    slog("Waiting for verification code in tempmail...");
    const code = await pollTempmail(email, sessionId, "digits6");
    if (!code) {
      throw new Error("No verification code received");
    }
    slog(`Verification code: ${code}`);

    updateProgress({ step: "Enter OTP" });
    const filledCode = await fillField(page, [
      'input[name="verification_code"]',
      'input[placeholder*="验证码"]',
      'input[placeholder*="code" i]',
      'input[autocomplete="one-time-code"]',
    ], code);
    if (!filledCode) {
      // common: last empty-ish input
      const candidates = page.locator("input:not([type='password'])");
      const n = await candidates.count();
      let done = false;
      for (let i = n - 1; i >= 0; i--) {
        const el = candidates.nth(i);
        const val = await el.inputValue().catch(() => "");
        if (!val || val.length < 4) {
          await el.fill(code);
          done = true;
          break;
        }
      }
      if (!done) {
        throw new Error("Cannot find verification_code input");
      }
    }
    await sleep(800);
    await ss("code_filled");

    updateProgress({ step: "Submit register" });
    slog("Checking user agreement + submitting registration...");
    await checkUserAgreement(page, slog);
    await sleep(400);
    const regSubmitted = await clickButtonByText(page, [
      "Sign up",
      "Register",
      "注册",
      "立即注册",
      "提交",
      "Confirm",
    ]);
    if (!regSubmitted) {
      await page.locator('button[type="submit"]').first().click().catch(() => {});
    }
    await sleep(5000);
    await ss("after_register");

    // Register success usually redirects to /login — do explicit login
    updateProgress({ step: "Login" });
    slog("Logging in...");
    if (!page.url().includes("/login") && !page.url().includes("/console")) {
      await page
        .goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 })
        .catch(() => {});
      await sleep(3000);
    }

    // If already on console with user session, skip login form
    let hasUser = await page
      .evaluate(() => {
        try {
          return !!JSON.parse(localStorage.getItem("user") || "null")?.id;
        } catch {
          return false;
        }
      })
      .catch(() => false);

    if (!hasUser) {
      if (!page.url().includes("/login")) {
        await page
          .goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 })
          .catch(() => {});
        await sleep(3000);
      }

      await fillField(page, [
        'input[name="username"]',
        'input[autocomplete="username"]',
        'input[placeholder*="用户"]',
        'input[placeholder*="账号"]',
        'input[type="text"]',
      ], username);

      const loginPw = page.locator('input[type="password"]').first();
      if (await loginPw.isVisible({ timeout: 3000 }).catch(() => false)) {
        await loginPw.fill(password);
      }

      await clickButtonByText(page, ["登录", "Login", "Sign in", "登 录"]);
      await sleep(5000);
      await ss("after_login");

      hasUser = await page
        .evaluate(() => {
          try {
            return !!JSON.parse(localStorage.getItem("user") || "null")?.id;
          } catch {
            return false;
          }
        })
        .catch(() => false);

      if (!hasUser) {
        // Login captcha may appear (captcha_login_enabled)
        slog(
          "Login may require captcha — solve in browser if a challenge is shown…",
        );
        const loginStart = Date.now();
        while (Date.now() - loginStart < 120000) {
          hasUser = await page
            .evaluate(() => {
              try {
                return !!JSON.parse(localStorage.getItem("user") || "null")?.id;
              } catch {
                return false;
              }
            })
            .catch(() => false);
          if (hasUser) {
            break;
          }
          await sleep(2000);
        }
      }
    }

    if (!hasUser) {
      throw new Error("Login failed — no user session in localStorage");
    }
    slog("Logged in (session present)");

    updateProgress({ step: STEPS.GETTING_TOKEN });
    slog("Creating API token...");
    const tokenName = `farm_${username}`.slice(0, 24);
    const apiKey = await createYunwuApiToken(page, slog, tokenName);
    await ss("token_ready");

    let routerStatus = "file_only";
    if (!signupOnly) {
      updateProgress({ step: STEPS.IMPORTING, email });
      try {
        const providerNodeId = await ensureYunwuProviderNode(slog);
        await importYunwuKeyToRouter(providerNodeId, email, apiKey, slog);
        routerStatus = "injected";
      } catch (importErr) {
        routerStatus = "injection_failed";
        slog(
          `9Router import failed (key still saved to file): ${importErr.message}`,
        );
      }
    }

    saveApiKey(email, apiKey, slog, {
      status: routerStatus,
      username,
      password,
    });
    slog(`SUCCESS: ${apiKey} (${routerStatus})`);
    updateProgress({ step: STEPS.DONE });

    return {
      email,
      username,
      password,
      apiKey,
      success: true,
      status: routerStatus,
    };
  } finally {
    await browser.close().catch(() => {});
    slog("Browser closed.");
  }
}

/**
 * @param {number} [count] how many accounts to farm
 * @param {object} [opts]
 * @param {boolean} [opts.signupOnly] skip 9Router import (file only)
 * @param {boolean} [opts.headless] force headless (not recommended for captcha)
 */
async function runYunwuAutomation(count, opts = {}) {
  const config = getConfig();
  const logger = createFileLogger();
  const total = Math.max(1, Number(count) || config.farmCount || 1);
  const signupOnly = !!opts.signupOnly;

  const startedAt = Date.now();
  const progress = createProgressManager(
    `☁️ Yunwu Farm — ${total} accounts (Camoufox${signupOnly ? ", signup-only" : " + 9Router"})`,
  );
  progress.addWorker("yunwu-0", total, "Yunwu W1");

  let successCount = 0;
  let failedCount = 0;
  const accountStats = [];

  console.log("");
  console.log(
    "Note: Yunwu uses go-captcha click-shape on Get Verification Code.",
  );
  console.log(
    "      Default = HEADED browser. Solve captcha manually when the popup opens.",
  );
  console.log(
    "      Do not use YUNWU_HEADLESS=1 for full farm. Extend wait: YUNWU_CAPTCHA_TIMEOUT_MS=300000",
  );
  console.log("");

  for (let i = 1; i <= total; i++) {
    const startTime = Date.now();
    let accountSuccess = false;
    let accountError = null;
    let email = `farm#${i}`;

    const updateProgress = (payload) => {
      progress.updateWorker("yunwu-0", {
        ...payload,
        email: payload.email || email,
        success: successCount,
        failed: failedCount,
        current: i - 1,
      });
    };

    try {
      logger.log(`=== Yunwu Account ${i}/${total} ===`);
      const result = await farmOneYunwu(i, logger.log, updateProgress, {
        signupOnly,
        headless: opts.headless,
      });
      email = result.email;
      accountSuccess = true;
      successCount += 1;
      progress.updateWorker("yunwu-0", {
        step: STEPS.DONE,
        email,
        success: successCount,
        failed: failedCount,
        current: i,
      });
    } catch (error) {
      accountError = error.message;
      failedCount += 1;
      logger.log(`[Yunwu #${i}] Error: ${error.message}`);
      progress.updateWorker("yunwu-0", {
        step: STEPS.ERROR,
        email,
        success: successCount,
        failed: failedCount,
        current: i,
      });
    }

    accountStats.push({
      email,
      rawLine: email,
      success: accountSuccess,
      duration: Date.now() - startTime,
      error: accountError,
    });

    if (i < total) {
      progress.updateWorker("yunwu-0", { step: STEPS.WAITING });
      await randomDelay(5000, 10000);
    }
  }

  progress.stop();
  const totalDuration = Date.now() - startedAt;

  printReport(
    "☁️ YUNWU FARM REPORT",
    [{ label: "Yunwu W1", accounts: accountStats }],
    totalDuration,
  );
  console.log(`📄 Log: ${logger.logFile}`);
  console.log(`🔑 Keys: ${getResultFile("yunwu")} / yunwu_keys.txt`);
  if (!signupOnly) {
    console.log(
      "🔌 9Router: openai-compatible node prefix=yunwu → https://yunwu.ai/v1",
    );
  }
  console.log("");

  logger.close();

  return { successCount, failedCount, results: [{ accounts: accountStats }] };
}

module.exports = {
  runYunwuAutomation,
  ensureYunwuProviderNode,
  importYunwuKeyToRouter,
  syncYunwuModelsToRouter,
  YUNWU_BASE_URL,
  YUNWU_DEFAULT_MODEL,
  YUNWU_MODEL_CATALOG,
};
