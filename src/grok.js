const fs = require("fs");
const path = require("path");
const { getConfig, getResultFile, ROOT_DIR } = require("./config");
const {
  sleep,
  randomDelay,
  randomName,
  createFileLogger,
  ensureFileExists,
  readLines,
} = require("./utils");
const { createTempmail, pollTempmail } = require("./tempmail");
const { handleTurnstile } = require("./turnstile");
const { launchCamoufox, newFarmPage } = require("./camoufox");
const { injectGrokTo9Router } = require("./router-inject");
const { STEPS, createProgressManager } = require("./progress");
const { printReport } = require("./reporter");

const SIGNUP_URL = "https://accounts.x.ai/sign-up";
const LOGIN_URL = "https://accounts.x.ai/sign-in";
const SIGNUP_TIMEOUT = 120000;
const GROK_PASSWORD = "GrokCLI2026!";
const ACCOUNTS_JSON = path.join(ROOT_DIR, "grok_accounts.json");
const RESULT_TXT = path.join(ROOT_DIR, "result.txt");
const LOGIN_RESULT_TXT = path.join(ROOT_DIR, "login_result.txt");

function loadGrokAccountsJson() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_JSON, "utf-8"));
  } catch (_) {
    return [];
  }
}

function saveGrokAccount(acc, log) {
  const accs = loadGrokAccountsJson();
  const existing = accs.findIndex((a) => a.email === acc.email);
  if (existing >= 0) {
    accs[existing] = { ...accs[existing], ...acc };
  } else {
    accs.push(acc);
  }
  fs.writeFileSync(ACCOUNTS_JSON, JSON.stringify(accs, null, 2));

  // Append email:password to result.txt once per new signup
  if (acc.status === "signed_up" || acc.status === "injected") {
    ensureFileExists(RESULT_TXT);
    const line = `${acc.email}:${acc.password}`;
    const existingLines = readLines(RESULT_TXT);
    if (!existingLines.some((l) => l.trim().startsWith(`${acc.email}:`))) {
      fs.appendFileSync(RESULT_TXT, `${line}\n`);
    }
  }

  // Also mirror into provider keys file
  const keysFile = getResultFile("grok");
  ensureFileExists(keysFile);
  fs.appendFileSync(
    keysFile,
    `${acc.email}|${acc.password}|${acc.status || "unknown"}\n`,
  );

  if (log) {
    log(`Saved account ${acc.email} (${acc.status})`);
  }
}

function saveLoginResult(acc) {
  ensureFileExists(LOGIN_RESULT_TXT);
  fs.appendFileSync(
    LOGIN_RESULT_TXT,
    `${acc.email}:${acc.password}:${acc.status}\n`,
  );

  // Update JSON if present
  try {
    const accs = loadGrokAccountsJson();
    const found = accs.find((a) => a.email === acc.email);
    if (found) {
      Object.assign(found, {
        status: acc.status,
        loginAt: acc.loginAt,
        injectedAt: acc.injectedAt,
        cookies: acc.cookies,
        loginError: acc.loginError,
        injectionError: acc.injectionError,
      });
      fs.writeFileSync(ACCOUNTS_JSON, JSON.stringify(accs, null, 2));
    }
  } catch (_) {
    // ignore
  }
}

/**
 * Load accounts from email:password lines (result.txt style) or email|password.
 */
function loadGrokLoginAccounts(filePath) {
  const target = filePath
    ? path.isAbsolute(filePath)
      ? filePath
      : path.join(ROOT_DIR, filePath)
    : RESULT_TXT;

  if (fs.existsSync(target)) {
    const fromFile = readLines(target)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        if (l.includes("|")) {
          const [email, password] = l.split("|");
          return {
            email: email?.trim(),
            password: password?.trim(),
          };
        }
        const idx = l.indexOf(":");
        if (idx === -1) {
          return null;
        }
        return {
          email: l.slice(0, idx).trim(),
          password: l.slice(idx + 1).trim(),
        };
      })
      .filter((a) => a && a.email && a.password);

    if (fromFile.length > 0) {
      return fromFile;
    }
  }

  return loadGrokAccountsJson()
    .filter((a) => a.email && a.password)
    .map((a) => ({
      email: a.email,
      password: a.password,
      status: a.status,
    }));
}

// ========== SIGNUP ==========
async function signupGrok(page, idx, log) {
  log(`Creating tempmail...`);
  const { email, sessionId, domain } = await createTempmail();
  const password = GROK_PASSWORD;
  const name = randomName();
  log(`Email: ${email}`);
  log(`Name: ${name.first} ${name.last}`);

  log("Loading signup page...");
  await page.goto(SIGNUP_URL, {
    waitUntil: "domcontentloaded",
    timeout: SIGNUP_TIMEOUT,
  });
  await page
    .waitForLoadState("networkidle", { timeout: 20000 })
    .catch(() => {});
  await sleep(2000);

  const ssDir = path.join(ROOT_DIR, "screenshots");
  if (!fs.existsSync(ssDir)) {
    fs.mkdirSync(ssDir, { recursive: true });
  }
  await page
    .screenshot({ path: path.join(ssDir, `grok_${idx}_01_signup.png`) })
    .catch(() => {});

  // Diagnose blocked / challenge pages (common on VPS + headless + DC IP)
  const pageHint = await page
    .evaluate(() => {
      const t = (document.title || "").trim();
      const body = (document.body?.innerText || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 280);
      return { title: t, url: location.href, body };
    })
    .catch(() => ({ title: "", url: page.url(), body: "" }));
  log(`Signup page: title="${pageHint.title}" url=${pageHint.url}`);
  if (
    /just a moment|attention required|cloudflare|cf-browser|checking your browser|access denied|captcha/i.test(
      `${pageHint.title} ${pageHint.body}`,
    )
  ) {
    log(`BLOCKED/CHALLENGE page body: ${pageHint.body.slice(0, 160)}`);
    await page
      .screenshot({ path: path.join(ssDir, `grok_${idx}_01_blocked.png`) })
      .catch(() => {});
    throw new Error(
      `Signup page blocked/challenged (likely VPS IP or headless). title="${pageHint.title}". ` +
        "Try: visible browser (PW_HEADLESS=0), residential proxy, or check screenshots.",
    );
  }

  // Cookie banner (OneTrust / xAI variants)
  for (const re of [/accept all cookies/i, /accept all/i, /allow all/i]) {
    const cookieBtn = page.locator("button", { hasText: re }).first();
    if (await cookieBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      log("Accepting cookies...");
      await cookieBtn.click({ timeout: 5000 }).catch(() => {});
      await sleep(1000);
      break;
    }
  }

  log('Clicking "Sign up with email"...');
  const emailSignup = page
    .getByRole("button", { name: /sign up with email/i })
    .or(
      page
        .locator('button, [role="button"], a')
        .filter({ hasText: /sign up with email/i }),
    )
    .first();
  try {
    await emailSignup.waitFor({ state: "visible", timeout: 25000 });
    await emailSignup.click({ timeout: 10000 });
  } catch (e) {
    await page
      .screenshot({
        path: path.join(ssDir, `grok_${idx}_01_no_email_btn.png`),
      })
      .catch(() => {});
    const again = await page
      .evaluate(() => ({
        title: document.title,
        body: (document.body?.innerText || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 400),
        buttons: [...document.querySelectorAll('button, [role="button"], a')]
          .map((el) => (el.innerText || el.textContent || "").trim())
          .filter(Boolean)
          .slice(0, 20),
      }))
      .catch(() => ({}));
    log(
      `No email signup btn. title="${again.title}" buttons=${JSON.stringify(again.buttons || [])}`,
    );
    throw new Error(
      `Sign up with email not found. See screenshots/grok_${idx}_01_*.png — ${e.message?.slice(0, 80)}`,
    );
  }
  await sleep(2000);

  log("Filling email...");
  await page.locator('[data-testid="email"]').fill(email);
  await sleep(500);
  await page.locator('[data-testid="email"]').press("Enter");
  await sleep(3000);

  const cookieBtn2 = page.locator("button", { hasText: /accept all/i });
  if (await cookieBtn2.isVisible({ timeout: 2000 }).catch(() => false)) {
    await cookieBtn2.click({ timeout: 5000 }).catch(() => {});
    await sleep(1000);
  }

  log("Waiting for verification code...");
  const code = await pollTempmail(email, sessionId, "grok");
  if (!code) {
    throw new Error("No verification code received");
  }
  log(`Verification code: ${code}`);

  await page.locator('input[name="code"]').fill(code);
  await sleep(500);

  const confirmBtn = page.locator("button", { hasText: /confirm email/i });
  try {
    await page.waitForFunction(
      () => {
        const b = document.querySelector('button[type="submit"]');
        return b && !b.disabled && !b.getAttribute("aria-busy");
      },
      { timeout: 5000 },
    );
  } catch (_) {
    // continue
  }
  if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await confirmBtn.click({ force: true });
  }
  await sleep(8000);

  log("Filling name & password...");
  if (
    await page
      .locator('[data-testid="givenName"]')
      .isVisible({ timeout: 10000 })
      .catch(() => false)
  ) {
    await page.locator('[data-testid="givenName"]').fill(name.first);
    await page.locator('[data-testid="familyName"]').fill(name.last);
  } else {
    log("WARNING: name fields not visible");
  }
  await page.locator('[data-testid="password"]').fill(password);
  await sleep(3000);

  // Turnstile — click + wait for token
  log("Handling Turnstile...");
  await sleep(8000);

  let clicked = false;
  const widgetRect = await page.evaluate(() => {
    const input = document.querySelector('input[name="cf-turnstile-response"]');
    if (!input) {
      return null;
    }
    let el = input;
    for (let i = 0; i < 5; i++) {
      el = el.parentElement;
      if (!el) {
        break;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width > 100 && rect.height > 30) {
        return rect.toJSON();
      }
    }
    return input.parentElement?.getBoundingClientRect()?.toJSON() || null;
  });

  if (widgetRect) {
    const clickX = widgetRect.x + widgetRect.width * 0.05;
    const clickY = widgetRect.y + widgetRect.height * 0.5;
    log(`Clicking Turnstile at (${Math.round(clickX)}, ${Math.round(clickY)})`);
    await page.mouse.click(clickX, clickY);
    clicked = true;
  }

  if (!clicked) {
    // fallback between password and submit
    const passwordBox = await page
      .locator('[data-testid="password"]')
      .boundingBox({ timeout: 3000 })
      .catch(() => null);
    const submitBtnBox = await page
      .locator("button", { hasText: "Complete sign up" })
      .boundingBox({ timeout: 3000 })
      .catch(() => null);
    if (passwordBox && submitBtnBox) {
      const clickX = passwordBox.x + 20;
      const clickY =
        passwordBox.y +
        passwordBox.height +
        (submitBtnBox.y - (passwordBox.y + passwordBox.height)) / 2;
      await page.mouse.click(clickX, clickY);
      clicked = true;
    }
  }

  if (!clicked) {
    await handleTurnstile(page, { log });
  } else {
    // Wait for token after manual click
    log("Waiting for Turnstile token...");
    const pollStart = Date.now();
    const config = getConfig();
    let tokenValue = "";
    while (Date.now() - pollStart < config.turnstileWaitTimeout) {
      tokenValue = await page.evaluate(() => {
        const el = document.querySelector(
          'input[name="cf-turnstile-response"]',
        );
        return el?.value || "";
      });
      if (tokenValue.length > 10) {
        log(`Turnstile solved! token=${tokenValue.slice(0, 40)}...`);
        break;
      }
      await sleep(2000);
    }
    if (!tokenValue) {
      throw new Error("Turnstile token did not appear");
    }
  }

  log('Clicking "Complete sign up"...');
  const comp = page.locator("button", { hasText: "Complete sign up" });
  if (await comp.isVisible({ timeout: 5000 }).catch(() => false)) {
    await comp.click();
  }
  try {
    await page
      .waitForURL("**/!(sign-up)**", { timeout: 15000 })
      .catch(() => {});
  } catch (_) {
    // ignore
  }
  await sleep(5000);

  const currentUrl = page.url();
  log(`Post-signup URL: ${currentUrl}`);

  return {
    email,
    password,
    givenName: name.first,
    familyName: name.last,
    tempmailDomain: domain,
    tempmailSessionId: sessionId,
    verificationCode: code,
    signupUrl: currentUrl,
    status: "signed_up",
    createdAt: new Date().toISOString(),
  };
}

// ========== LOGIN ==========
async function loginGrok(page, account, log) {
  const ssDir = path.join(ROOT_DIR, "screenshots");
  if (!fs.existsSync(ssDir)) {
    fs.mkdirSync(ssDir, { recursive: true });
  }

  log(`Logging in: ${account.email}`);
  await page.goto(LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await sleep(3000);

  for (const text of [/accept all cookies/i, /accept all/i, /allow all/i]) {
    const cookieBtn = page.locator("button", { hasText: text });
    if (await cookieBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await cookieBtn.click({ timeout: 5000 }).catch(() => {});
      await sleep(1000);
      break;
    }
  }

  const emailBtn = page.locator('[data-testid="continue-with-email"]');
  if (await emailBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    log('Clicking "Continue with email"...');
    await emailBtn.click();
    await sleep(2000);
  }

  log("Filling email...");
  const emailField = page.locator('[data-testid="email"]');
  await emailField.waitFor({ state: "visible", timeout: 15000 });
  await emailField.fill(account.email);
  await sleep(500);

  const emailSubmit = page.locator('[data-testid="sign-in-submit"]');
  if (await emailSubmit.isVisible({ timeout: 3000 }).catch(() => false)) {
    await emailSubmit.click();
  } else {
    await emailField.press("Enter");
  }
  await sleep(4000);

  log("Filling password...");
  const pwField = page.locator('[data-testid="password"]');
  await pwField.waitFor({ state: "visible", timeout: 15000 });
  await pwField.fill(account.password);
  await sleep(800);

  await handleTurnstile(page, { log });
  await sleep(1000);

  log("Submitting login...");
  const loginBtn = page
    .locator('[data-testid="sign-in-submit"], button:has-text("Login")')
    .first();
  await loginBtn.click();
  await sleep(8000);

  for (let i = 0; i < 15; i++) {
    const url = page.url();
    if (!url.includes("/sign-in")) {
      break;
    }
    await sleep(1000);
  }

  const currentUrl = page.url();
  log(`Post-login URL: ${currentUrl}`);

  const ok =
    currentUrl.includes("/account") ||
    currentUrl.includes("console.x.ai") ||
    currentUrl.includes("grok.com") ||
    currentUrl.includes("/oauth2") ||
    (!currentUrl.includes("/sign-in") && !currentUrl.includes("/sign-up"));

  if (!ok) {
    const errText = await page
      .locator('[role="alert"], .error, [class*="error"]')
      .first()
      .textContent()
      .catch(() => "");
    const bodySnippet = await page
      .evaluate(() => document.body?.innerText?.slice(0, 200) || "")
      .catch(() => "");
    throw new Error(
      `Login failed — still on: ${currentUrl}. ${errText || bodySnippet}`.trim(),
    );
  }

  log(`Login OK: ${account.email}`);
  return {
    ...account,
    status: "logged_in",
    loginAt: new Date().toISOString(),
    loginUrl: currentUrl,
  };
}

// ========== FARM ONE ==========
async function farmOneGrok(idx, log, updateProgress, signupOnly) {
  const config = getConfig();
  const slog = (msg) => log(`[Grok Farm #${idx}] ${msg}`);

  updateProgress({ step: STEPS.LAUNCHING, email: `farm#${idx}` });
  const browser = await launchCamoufox({
    headless: config.headless,
    withRouterPrefs: true,
  });
  const { context, page } = await newFarmPage(browser);

  let account = null;
  try {
    updateProgress({ step: STEPS.NAVIGATING });
    account = await signupGrok(page, idx, slog);
    updateProgress({ step: STEPS.DONE, email: account.email });
    slog(`Signup OK: ${account.email}`);

    if (!signupOnly) {
      updateProgress({ step: STEPS.IMPORTING, email: account.email });
      account = await injectGrokTo9Router(context, account, slog);
    }

    saveGrokAccount(account, slog);
    return account;
  } finally {
    await browser.close().catch(() => {});
    slog("Browser closed.");
  }
}

// ========== LOGIN + INJECT ONE ==========
async function loginInjectOne(account, idx, log, updateProgress) {
  const config = getConfig();
  const slog = (msg) => log(`[Grok Login #${idx}] ${msg}`);

  updateProgress({ step: STEPS.LAUNCHING, email: account.email });
  const browser = await launchCamoufox({
    headless: config.headless,
    withRouterPrefs: true,
  });
  const { context, page } = await newFarmPage(browser);

  let result = { ...account };
  try {
    updateProgress({ step: STEPS.GOOGLE_LOGIN, email: account.email });
    result = await loginGrok(page, account, slog);

    updateProgress({ step: STEPS.IMPORTING, email: account.email });
    result = await injectGrokTo9Router(context, result, slog);
  } catch (e) {
    slog(`Error: ${e.message?.slice(0, 150)}`);
    result.status = "login_failed";
    result.loginError = e.message;
    throw e;
  } finally {
    await browser.close().catch(() => {});
    saveLoginResult(result);
    slog(`Saved status: ${result.status}`);
  }

  return result;
}

/**
 * Grok Farm — signup with tempmail (+ optional 9Router inject)
 * @param {number} count
 * @param {object} [opts]
 * @param {boolean} [opts.signupOnly]
 */
async function runGrokFarmAutomation(count, opts = {}) {
  const config = getConfig();
  const logger = createFileLogger();
  const total = Math.max(1, Number(count) || config.farmCount || 1);
  const signupOnly = !!opts.signupOnly;

  const startedAt = Date.now();
  const progress = createProgressManager(
    `⚡ Grok Farm — ${total} accounts (Camoufox${signupOnly ? ", signup-only" : " + 9Router"})`,
  );
  progress.addWorker("grok-farm-0", total, "Grok Farm W1");

  let successCount = 0;
  let failedCount = 0;
  const accountStats = [];

  for (let i = 1; i <= total; i++) {
    const startTime = Date.now();
    let accountSuccess = false;
    let accountError = null;
    let email = `farm#${i}`;

    const updateProgress = (payload) => {
      progress.updateWorker("grok-farm-0", {
        ...payload,
        email: payload.email || email,
        success: successCount,
        failed: failedCount,
        current: i - 1,
      });
    };

    try {
      logger.log(`=== Grok Farm ${i}/${total} ===`);
      const result = await farmOneGrok(
        i,
        logger.log,
        updateProgress,
        signupOnly,
      );
      email = result.email;
      accountSuccess =
        result.status === "injected" || result.status === "signed_up";
      if (accountSuccess) {
        successCount += 1;
      } else {
        failedCount += 1;
        accountError = result.injectionError || result.status;
      }
      progress.updateWorker("grok-farm-0", {
        step: accountSuccess ? STEPS.DONE : STEPS.ERROR,
        email,
        success: successCount,
        failed: failedCount,
        current: i,
      });
    } catch (error) {
      accountError = error.message;
      failedCount += 1;
      logger.log(`[Grok Farm #${i}] Error: ${error.message}`);
      progress.updateWorker("grok-farm-0", {
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
      progress.updateWorker("grok-farm-0", { step: STEPS.WAITING });
      await randomDelay(5000, 10000);
    }
  }

  progress.stop();
  printReport(
    "⚡ GROK FARM REPORT",
    [{ label: "Grok Farm W1", accounts: accountStats }],
    Date.now() - startedAt,
  );
  console.log(`📄 Log: ${logger.logFile}`);
  console.log(`📁 Accounts: ${ACCOUNTS_JSON}`);
  console.log(`📁 Credentials: ${RESULT_TXT}`);
  console.log("");

  logger.close();
  return { successCount, failedCount, results: [{ accounts: accountStats }] };
}

/**
 * Grok Login + 9Router inject for existing accounts
 * @param {object} [opts]
 * @param {number} [opts.count]
 * @param {string} [opts.file]
 */
async function runGrokLoginAutomation(opts = {}) {
  const config = getConfig();
  const logger = createFileLogger();
  let accounts = loadGrokLoginAccounts(opts.file);

  if (accounts.length === 0) {
    console.log(
      "No Grok accounts found. Run Grok Farm first, or put email:password in result.txt",
    );
    logger.close();
    return null;
  }

  const total =
    opts.count && opts.count > 0
      ? Math.min(opts.count, accounts.length)
      : accounts.length;
  accounts = accounts.slice(0, total);

  const startedAt = Date.now();
  const progress = createProgressManager(
    `🔐 Grok Login + 9Router — ${total} accounts (Camoufox)`,
  );
  progress.addWorker("grok-login-0", total, "Grok Login W1");

  let successCount = 0;
  let failedCount = 0;
  const accountStats = [];

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const startTime = Date.now();
    let accountSuccess = false;
    let accountError = null;
    const n = i + 1;

    const updateProgress = (payload) => {
      progress.updateWorker("grok-login-0", {
        ...payload,
        email: payload.email || account.email,
        success: successCount,
        failed: failedCount,
        current: i,
      });
    };

    try {
      logger.log(`=== Grok Login ${n}/${total}: ${account.email} ===`);
      const result = await loginInjectOne(
        account,
        n,
        logger.log,
        updateProgress,
      );
      accountSuccess = result.status === "injected";
      if (accountSuccess) {
        successCount += 1;
      } else {
        failedCount += 1;
        accountError =
          result.injectionError || result.loginError || result.status;
      }
      progress.updateWorker("grok-login-0", {
        step: accountSuccess ? STEPS.DONE : STEPS.ERROR,
        email: account.email,
        success: successCount,
        failed: failedCount,
        current: n,
      });
    } catch (error) {
      accountError = error.message;
      failedCount += 1;
      logger.log(`[Grok Login #${n}] Error: ${error.message}`);
      progress.updateWorker("grok-login-0", {
        step: STEPS.ERROR,
        email: account.email,
        success: successCount,
        failed: failedCount,
        current: n,
      });
    }

    accountStats.push({
      email: account.email,
      rawLine: `${account.email}:${account.password}`,
      success: accountSuccess,
      duration: Date.now() - startTime,
      error: accountError,
    });

    if (i < accounts.length - 1) {
      progress.updateWorker("grok-login-0", { step: STEPS.WAITING });
      await randomDelay(3000, 6000);
    }
  }

  progress.stop();
  printReport(
    "🔐 GROK LOGIN + 9ROUTER REPORT",
    [{ label: "Grok Login W1", accounts: accountStats }],
    Date.now() - startedAt,
  );
  console.log(`📄 Log: ${logger.logFile}`);
  console.log(`📁 Results: ${LOGIN_RESULT_TXT}`);
  console.log("");

  logger.close();
  return { successCount, failedCount, results: [{ accounts: accountStats }] };
}

module.exports = {
  runGrokFarmAutomation,
  runGrokLoginAutomation,
  loadGrokLoginAccounts,
};
