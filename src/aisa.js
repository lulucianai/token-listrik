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
const { handleTurnstile } = require("./turnstile");
const { launchCamoufox, newFarmPage } = require("./camoufox");
const { STEPS, createProgressManager } = require("./progress");
const { printReport } = require("./reporter");

const AUTH_SIGNUP_URL =
  "https://auth.aisa.one/sign-up?redirect_url=https%3A%2F%2Fconsole.aisa.one%2F";
const CONSOLE_URL = "https://console.aisa.one";
const CONSOLE_API_KEYS_URL = "https://console.aisa.one/api-keys";
const TIMEOUT = 120000;
const AISA_PASSWORD = "AisaFarm2026!";

async function findInput(page, frames) {
  for (const frame of [page, ...frames]) {
    const loc = frame
      .locator(
        'input[name="identifier"], input[id="identifier-field"], input[type="email"]',
      )
      .first();
    if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
      return { input: loc, frame };
    }
  }
  return null;
}

async function findCodeInput(page, frames) {
  for (const frame of [page, ...frames]) {
    const loc = frame
      .locator('input[name="code"], input[autocomplete="one-time-code"]')
      .first();
    if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
      return { input: loc, frame };
    }
  }
  return null;
}

function saveApiKey(email, apiKey, log) {
  const resultFile = getResultFile("aisa");
  ensureFileExists(resultFile);
  fs.appendFileSync(resultFile, `${apiKey}\n`);
  log(`API key saved to ${resultFile}`);

  // Also keep legacy-compatible apikey.txt for drop-in scripts
  const keyFile = path.join(ROOT_DIR, "apikey.txt");
  fs.appendFileSync(keyFile, `${apiKey}\n`);

  const accountFile = path.join(ROOT_DIR, "aisa_account.json");
  let accounts = [];
  try {
    const raw = JSON.parse(fs.readFileSync(accountFile, "utf-8"));
    accounts = Array.isArray(raw) ? raw : [raw];
  } catch (_) {
    accounts = [];
  }
  accounts.push({ email, apiKey, createdAt: new Date().toISOString() });
  fs.writeFileSync(accountFile, JSON.stringify(accounts, null, 2));
  log("Account appended to aisa_account.json");
}

async function farmOneAisa(idx, log, updateProgress) {
  const config = getConfig();
  const slog = (msg) => log(`[AISA #${idx}] ${msg}`);

  updateProgress({ step: "Creating tempmail", email: `farm#${idx}` });
  slog("Creating tempmail...");
  const { email, sessionId } = await createTempmail();
  slog(`Email: ${email}`);

  updateProgress({ step: STEPS.LAUNCHING, email });
  slog("Launching Camoufox...");
  const browser = await launchCamoufox({ headless: config.headless });
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
          `aisa_${idx}_${String(stepNum).padStart(2, "0")}_${label}.png`,
        ),
      })
      .catch(() => {});
  };

  try {
    updateProgress({ step: STEPS.NAVIGATING });
    slog("Navigating to sign-up page...");
    await page
      .goto(AUTH_SIGNUP_URL, {
        waitUntil: "networkidle",
        timeout: TIMEOUT,
      })
      .catch(() => {});
    await sleep(5000);
    await ss("signup_page");

    // Cookie consent
    for (const text of ["Accept All", "Accept all", "Allow All"]) {
      const btn = page.locator("button", {
        hasText: new RegExp(text, "i"),
      });
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click().catch(() => {});
        await sleep(500);
        break;
      }
    }

    // Open email form if needed
    for (const text of [
      "Sign up with email",
      "More sign-in options",
      "Continue with email",
      "Email",
    ]) {
      const btn = page.locator("button, a").filter({ hasText: text }).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        await sleep(3000);
        break;
      }
    }

    updateProgress({ step: "Fill email" });
    const frames = page.frames();
    let result = await findInput(page, frames);
    if (!result) {
      for (const frame of [page, ...frames]) {
        const loc = frame.locator('input[type="text"]').first();
        if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
          result = { input: loc, frame };
          break;
        }
      }
    }
    if (!result) {
      throw new Error("Cannot find email input");
    }

    slog("Filling email...");
    await result.input.fill(email);
    await sleep(1000);
    await ss("email_filled");

    const hasTurnstilePre = await page
      .evaluate(
        () => !!document.querySelector('input[name="cf-turnstile-response"]'),
      )
      .catch(() => false);
    if (hasTurnstilePre) {
      updateProgress({ step: "Turnstile" });
      await handleTurnstile(page, { log: slog, frames });
    }

    slog("Submitting...");
    const submitBtn = result.frame
      .locator('button[type="submit"]')
      .filter({ hasText: /continue|sign\s*up|verify|next/i })
      .first();
    if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submitBtn.click();
    } else {
      await result.input.press("Enter");
    }
    await sleep(5000);
    await ss("after_submit");

    const hasTurnstilePost = await page
      .evaluate(
        () => !!document.querySelector('input[name="cf-turnstile-response"]'),
      )
      .catch(() => false);
    if (hasTurnstilePost) {
      updateProgress({ step: "Turnstile" });
      await handleTurnstile(page, { log: slog, frames: page.frames() });
      const submitBtn2 = result.frame.locator('button[type="submit"]').first();
      if (await submitBtn2.isVisible({ timeout: 5000 }).catch(() => false)) {
        await submitBtn2.click();
        await sleep(5000);
      }
    }

    updateProgress({ step: "Waiting OTP" });
    slog("Waiting for verification code...");
    const code = await pollTempmail(email, sessionId, "digits6");
    if (!code) {
      throw new Error("No verification code received");
    }
    slog(`Verification code: ${code}`);

    updateProgress({ step: "Enter OTP" });
    let codeResult = await findCodeInput(page, page.frames());
    if (!codeResult) {
      for (const frame of [page, ...page.frames()]) {
        const loc = frame
          .locator('input[type="text"], input[type="tel"]')
          .first();
        if (await loc.isVisible({ timeout: 5000 }).catch(() => false)) {
          codeResult = { input: loc, frame };
          break;
        }
      }
    }
    if (!codeResult) {
      throw new Error("Cannot find code input");
    }
    await codeResult.input.fill(code);
    await sleep(1000);
    await ss("code_filled");

    try {
      await codeResult.frame.waitForFunction(
        () => {
          const b = document.querySelector('button[type="submit"]');
          return b && !b.disabled;
        },
        { timeout: 10000 },
      );
    } catch (_) {
      // continue
    }
    const verifyBtn = codeResult.frame.locator('button[type="submit"]').first();
    if (await verifyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await verifyBtn.click({ force: true });
    }
    await sleep(8000);
    await ss("after_verify");

    // Optional name / password step
    for (const frame of [page, ...page.frames()]) {
      const nameField = frame
        .locator('input[name="firstName"], input[name="givenName"]')
        .first();
      if (await nameField.isVisible({ timeout: 3000 }).catch(() => false)) {
        await nameField.fill("Alex");
        const ln = frame
          .locator('input[name="lastName"], input[name="familyName"]')
          .first();
        if (await ln.isVisible({ timeout: 2000 }).catch(() => false)) {
          await ln.fill("Smith");
        }
        const pw = frame.locator('input[type="password"]').first();
        if (await pw.isVisible({ timeout: 2000 }).catch(() => false)) {
          await pw.fill(AISA_PASSWORD);
        }
        const ts = await page
          .evaluate(
            () =>
              !!document.querySelector('input[name="cf-turnstile-response"]'),
          )
          .catch(() => false);
        if (ts) {
          await handleTurnstile(page, {
            log: slog,
            frames: page.frames(),
          });
        }
        const btn = frame.locator('button[type="submit"]').first();
        if (await btn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await btn.click();
        }
        await sleep(8000);
        break;
      }
    }

    updateProgress({ step: STEPS.WAITING });
    slog("Waiting for console...");
    try {
      await page.waitForURL("**/console.aisa.one/**", { timeout: 30000 });
    } catch (_) {
      // fall through
    }
    await sleep(3000);

    if (!page.url().includes("console.aisa.one")) {
      await page
        .goto(CONSOLE_URL, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        })
        .catch(() => {});
      await sleep(5000);
    }

    updateProgress({ step: STEPS.GETTING_TOKEN });
    slog("Fetching API keys...");
    await page
      .goto(CONSOLE_API_KEYS_URL, {
        waitUntil: "networkidle",
        timeout: 30000,
      })
      .catch(() => {});
    await sleep(5000);
    await ss("api_keys");

    const cookies = await context.cookies();
    const sessionCookie = cookies.find(
      (c) => c.name === "__session" || c.name.startsWith("__session"),
    );

    let apiRes = null;
    if (sessionCookie) {
      apiRes = await page.evaluate(async (token) => {
        try {
          const r = await fetch("/api/api-keys", {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
          });
          return await r.json();
        } catch (e) {
          return { error: e.message };
        }
      }, sessionCookie.value);
    }

    if (!apiRes?.api_keys) {
      apiRes = await page.evaluate(async () => {
        try {
          const r = await fetch("/api/api-keys", {
            headers: { "Content-Type": "application/json" },
            credentials: "include",
          });
          return await r.json();
        } catch (e) {
          return { error: e.message };
        }
      });
    }

    if (!apiRes?.api_keys) {
      const scraped = await page.evaluate(() => {
        const text = document.body.innerText || "";
        const m = text.match(/sk-aisa-[A-Za-z0-9_-]+/);
        if (m) {
          return m[0];
        }
        for (const inp of document.querySelectorAll(
          "input, code, pre, span, div",
        )) {
          const v = inp.value || inp.textContent || "";
          const m2 = v.match(/sk-aisa-[A-Za-z0-9_-]+/);
          if (m2) {
            return m2[0];
          }
        }
        return null;
      });
      if (scraped) {
        apiRes = { api_keys: [{ key_value: scraped }] };
      }
    }

    if (!apiRes?.api_keys?.length) {
      throw new Error("No API keys found");
    }

    const apiKey = apiRes.api_keys[0].key_value;
    saveApiKey(email, apiKey, slog);
    slog(`SUCCESS: ${apiKey}`);
    updateProgress({ step: STEPS.DONE });

    return { email, apiKey, success: true };
  } finally {
    await browser.close().catch(() => {});
    slog("Browser closed.");
  }
}

/**
 * @param {number} [count] how many accounts to farm
 */
async function runAisaAutomation(count) {
  const config = getConfig();
  const logger = createFileLogger();
  const total = Math.max(1, Number(count) || config.farmCount || 1);

  const startedAt = Date.now();
  const progress = createProgressManager(
    `🤖 AISA Farm — ${total} accounts (Camoufox)`,
  );
  progress.addWorker("aisa-0", total, "AISA W1");

  let successCount = 0;
  let failedCount = 0;
  const accountStats = [];

  for (let i = 1; i <= total; i++) {
    const startTime = Date.now();
    let accountSuccess = false;
    let accountError = null;
    let email = `farm#${i}`;

    const updateProgress = (payload) => {
      progress.updateWorker("aisa-0", {
        ...payload,
        email: payload.email || email,
        success: successCount,
        failed: failedCount,
        current: i - 1,
      });
    };

    try {
      logger.log(`=== AISA Account ${i}/${total} ===`);
      const result = await farmOneAisa(i, logger.log, updateProgress);
      email = result.email;
      accountSuccess = true;
      successCount += 1;
      progress.updateWorker("aisa-0", {
        step: STEPS.DONE,
        email,
        success: successCount,
        failed: failedCount,
        current: i,
      });
    } catch (error) {
      accountError = error.message;
      failedCount += 1;
      logger.log(`[AISA #${i}] Error: ${error.message}`);
      progress.updateWorker("aisa-0", {
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
      progress.updateWorker("aisa-0", { step: STEPS.WAITING });
      await randomDelay(5000, 10000);
    }
  }

  progress.stop();
  const totalDuration = Date.now() - startedAt;

  printReport(
    "🤖 AISA FARM REPORT",
    [{ label: "AISA W1", accounts: accountStats }],
    totalDuration,
  );
  console.log(`📄 Log: ${logger.logFile}`);
  console.log(`🔑 Keys: ${getResultFile("aisa")} / apikey.txt`);
  console.log("");

  logger.close();

  return { successCount, failedCount, results: [{ accounts: accountStats }] };
}

module.exports = {
  runAisaAutomation,
};
