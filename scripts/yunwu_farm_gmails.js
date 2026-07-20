#!/usr/bin/env node
/**
 * One-shot: farm N Gmail accounts → Yunwu register → API key → 9Router.
 * Usage: node scripts/yunwu_farm_gmails.js
 * Accounts via env YUNWU_GMAIL_ACCOUNTS as JSON: [{"email":"...","password":"..."},...]
 * Or pass as first argv JSON string.
 *
 * Do NOT commit real passwords.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { launchCamoufox, newFarmPage } = require("../src/camoufox");
const {
  ensureYunwuProviderNode,
  importYunwuKeyToRouter,
} = require("../src/yunwu");

const ROOT = path.join(__dirname, "..");
const YUNWU_PW = process.env.YUNWU_PASSWORD || "YunwuFarm2026!";
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function solveCaptcha(tries = 12) {
  const r = spawnSync(
    "python3",
    [path.join(ROOT, "scripts/yunwu_slide_captcha.py"), String(tries)],
    { encoding: "utf8", timeout: 180000 },
  );
  const out = (r.stdout || "").trim().split("\n").pop();
  try {
    return JSON.parse(out);
  } catch {
    return { ok: false, error: out || r.stderr };
  }
}

async function fillFirst(page, selectors, value) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 2500 }).catch(() => false)) {
      await loc.click({ timeout: 3000 }).catch(() => {});
      await loc.fill("");
      await loc.fill(value);
      return sel;
    }
  }
  return null;
}

async function clickNext(page) {
  for (const s of [
    "#identifierNext",
    "#passwordNext",
    'button:has-text("Next")',
    'button:has-text("Berikutnya")',
    'div[role="button"]:has-text("Next")',
  ]) {
    const b = page.locator(s).first();
    if (await b.isVisible({ timeout: 1200 }).catch(() => false)) {
      await b.click({ timeout: 5000 }).catch(() => {});
      return s;
    }
  }
  await page.keyboard.press("Enter");
  return "enter";
}

/** Extract Yunwu OTP (often 6 hex/alphanumeric chars). */
function extractOtp(text) {
  const patterns = [
    /验证码为[:：\s]*([A-Za-z0-9]{4,8})/,
    /验证码[为是]?[:：\s]*([A-Za-z0-9]{4,8})/,
    /verification code[:\s]*([A-Za-z0-9]{4,8})/i,
    /code[:\s]*([A-Za-z0-9]{6})/i,
    /您的验证码为:\s*([A-Za-z0-9]{4,8})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  // fallback: 6-char hex-like near 云雾/yunwu
  const near = text.match(/云雾[\s\S]{0,80}?([a-f0-9]{6})/i);
  if (near) return near[1];
  return null;
}

async function gmailGetOtp(page, email, gmailPassword) {
  await page.goto(
    "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F&service=mail&flowName=GlifWebSignIn&flowEntry=ServiceLogin",
    { waitUntil: "domcontentloaded", timeout: 120000 },
  ).catch(() => {});
  await sleep(3500);

  const filled = await fillFirst(
    page,
    [
      "#identifierId",
      'input[type="email"]',
      'input[name="identifier"]',
      'input[autocomplete="username"]',
    ],
    email,
  );
  if (!filled) throw new Error("Gmail: no email field");
  await sleep(400);
  await clickNext(page);
  await sleep(4500);

  const midBody = await page.evaluate(() => (document.body?.innerText || "").slice(0, 600));
  if (/Couldn.?t find this account|couldn.?t find your google account/i.test(midBody)) {
    throw new Error("Gmail: Couldn't find this account");
  }
  if (/not a robot|Verify it.?s you|Confirm you.?re not a robot/i.test(midBody)) {
    throw new Error("Gmail: Verify it's you / not a robot — " + midBody.replace(/\n/g, " ").slice(0, 180));
  }

  const filledPw = await fillFirst(
    page,
    [
      'input[type="password"]',
      'input[name="Passwd"]',
      'input[autocomplete="current-password"]',
    ],
    gmailPassword,
  );
  if (!filledPw) {
    const snip = await page.evaluate(() => (document.body?.innerText || "").slice(0, 400));
    throw new Error("Gmail: no password field — " + snip.replace(/\n/g, " "));
  }
  await sleep(400);
  await clickNext(page);
  await sleep(9000);

  if (!page.url().includes("mail.google.com")) {
    await page
      .goto("https://mail.google.com/mail/u/0/#inbox", {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      })
      .catch(() => {});
    await sleep(7000);
  }

  if (!page.url().includes("mail.google.com")) {
    throw new Error("Gmail: not in inbox after login — url=" + page.url());
  }

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const body = await page.evaluate(() => document.body?.innerText || "");
    let code = extractOtp(body);
    if (code && !/^202\d/.test(code)) {
      log(`  OTP found in list: ${code}`);
      return code;
    }

    // open 云雾 / yunwu row
    const rows = page.locator("tr.zA");
    const n = await rows.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 8); i++) {
      const t = await rows.nth(i).innerText().catch(() => "");
      if (/云雾|yunwu|验证|verification/i.test(t)) {
        await rows.nth(i).click().catch(() => {});
        await sleep(2500);
        const open = await page.evaluate(() => document.body?.innerText || "");
        code = extractOtp(open);
        if (code) {
          log(`  OTP from message: ${code}`);
          return code;
        }
      }
    }

    await page
      .goto("https://mail.google.com/mail/u/0/#inbox", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      })
      .catch(() => {});
    await sleep(5000);
  }
  throw new Error("Gmail: OTP timeout");
}

async function farmOne(account, idx, providerNodeId) {
  const email = account.email.trim();
  const passwords = Array.isArray(account.passwords)
    ? account.passwords
    : [account.password].filter(Boolean);
  const username =
    "eky" + Math.floor(1000 + Math.random() * 9000) + "yw" + idx;
  log(`\n======== [${idx}] ${email} / user=${username} ========`);

  // 1) captcha + send code
  log("  captcha…");
  let cap = solveCaptcha();
  if (!cap.ok) {
    for (let i = 0; i < 4 && !cap.ok; i++) cap = solveCaptcha();
  }
  if (!cap.ok) throw new Error("captcha failed: " + (cap.error || ""));
  log("  captcha ok");

  const verUrl = `https://yunwu.ai/api/verification?email=${encodeURIComponent(email)}&turnstile=&captcha_token=${encodeURIComponent(cap.token)}`;
  const verJson = await (
    await fetch(verUrl, { headers: { Accept: "application/json" } })
  ).json();
  log("  verification", verJson.success ? "sent" : JSON.stringify(verJson));
  if (!verJson.success) throw new Error("verification send failed");

  const browser = await launchCamoufox({ headless: true });
  const { context, page } = await newFarmPage(browser);
  let apiKey = null;

  try {
    // 2) Gmail OTP — try each password
    log("  gmail login + OTP…");
    const gmailPage = page;
    let code = null;
    let lastErr = null;
    for (let pi = 0; pi < passwords.length; pi++) {
      try {
        if (pi > 0) {
          // fresh sign-in page for next password
          await gmailPage
            .goto(
              "https://accounts.google.com/Logout",
              { waitUntil: "domcontentloaded", timeout: 30000 },
            )
            .catch(() => {});
          await sleep(2000);
        }
        code = await gmailGetOtp(gmailPage, email, passwords[pi]);
        log("  code", code, `(pw#${pi + 1})`);
        break;
      } catch (e) {
        lastErr = e;
        log(`  gmail pw#${pi + 1} fail: ${String(e.message).slice(0, 120)}`);
        // account missing / robot — no point retrying other passwords for robot? still try alt pw if wrong password
        if (/Couldn.?t find this account|could not find/i.test(e.message)) {
          throw e;
        }
        if (/not a robot|Verify it.?s you/i.test(e.message) && pi === passwords.length - 1) {
          throw e;
        }
      }
    }
    if (!code) throw lastErr || new Error("Gmail OTP failed");

    // 3) register on yunwu (fresh page, same browser)
    const ypage = await context.newPage();
    await ypage.goto("https://yunwu.ai/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await sleep(2000);

    const reg = await ypage.evaluate(
      async (p) => {
        const res = await fetch("/api/user/register?turnstile=", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          credentials: "include",
          body: JSON.stringify({
            username: p.username,
            password: p.password,
            password2: p.password,
            email: p.email,
            verification_code: p.code,
          }),
        });
        return {
          status: res.status,
          json: await res.json().catch(() => ({})),
        };
      },
      { username, password: YUNWU_PW, email, code },
    );
    log("  register", reg.json?.success, reg.json?.message || "");

    // 4) login (register often doesn't leave session)
    let loggedIn = false;
    for (const uname of [username, email]) {
      const cap2 = solveCaptcha();
      if (!cap2.ok) continue;
      const login = await ypage.evaluate(
        async (p) => {
          const body = {
            username: p.username,
            password: p.password,
            captcha_token: p.captcha_token,
          };
          const res = await fetch("/api/user/login?turnstile=", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            credentials: "include",
            body: JSON.stringify(body),
          });
          const json = await res.json().catch(() => ({}));
          if (json.success && json.data) {
            localStorage.setItem("user", JSON.stringify(json.data));
          }
          return json;
        },
        { username: uname, password: YUNWU_PW, captcha_token: cap2.token },
      );
      log("  login", uname, login.success ? "ok id=" + login.data?.id : login.message);
      if (login.success) {
        loggedIn = true;
        break;
      }
    }
    if (!loggedIn) throw new Error("login failed after register");

    await ypage
      .goto("https://yunwu.ai/console/token", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      })
      .catch(() => {});
    await sleep(2500);

    await ypage.evaluate(async () => {
      const res = await fetch("/api/user/self", { credentials: "include" });
      const json = await res.json().catch(() => ({}));
      if (json.success && json.data) {
        localStorage.setItem("user", JSON.stringify(json.data));
      }
      return json;
    });

    const tokenName = `farm_${Date.now()}_${idx}`;
    const tok = await ypage.evaluate(async (tokenName) => {
      let user = null;
      try {
        user = JSON.parse(localStorage.getItem("user") || "null");
      } catch {
        /* ignore */
      }
      if (!user?.id) return { error: "no user" };
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "New-API-User": String(user.id),
      };
      if (user.access_token || user.token) {
        headers.Authorization = `Bearer ${user.access_token || user.token}`;
      }
      const createRes = await fetch("/api/token/", {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({
          name: tokenName,
          remain_quota: 500000,
          expired_time: -1,
          unlimited_quota: true,
          model_limits_enabled: false,
          model_limits: "",
          allow_ips: "",
          group: "",
        }),
      });
      const createJson = await createRes.json().catch(() => ({}));
      let key =
        (typeof createJson.data === "string" && createJson.data) ||
        createJson.data?.key ||
        createJson.key ||
        null;
      if (!key) {
        const listRes = await fetch("/api/token/?p=0&page_size=20", {
          headers,
          credentials: "include",
        });
        const listJson = await listRes.json().catch(() => ({}));
        let items = [];
        const d = listJson.data;
        if (Array.isArray(d)) items = d;
        else if (d?.items) items = d.items;
        else if (d?.data) items = d.data;
        const withKey = items.filter((t) => t && (t.key || t.token));
        const pick =
          withKey.find((t) => t.name === tokenName) || withKey[0];
        key = pick?.key || pick?.token || null;
      }
      if (key && !String(key).startsWith("sk-")) key = "sk-" + key;
      return { key, createJson, userId: user.id };
    }, tokenName);

    apiKey = tok?.key;
    if (!apiKey) throw new Error("no api key: " + JSON.stringify(tok).slice(0, 200));
    log("  key", apiKey.slice(0, 16) + "…");

    // persist
    fs.appendFileSync(
      path.join(ROOT, "yunwu_keys.txt"),
      `${email}|${apiKey}\n`,
    );
    const accPath = path.join(ROOT, "yunwu_account.json");
    let accs = [];
    try {
      accs = JSON.parse(fs.readFileSync(accPath, "utf8"));
      if (!Array.isArray(accs)) accs = [accs];
    } catch {
      accs = [];
    }
    accs.push({
      email,
      username,
      password: YUNWU_PW,
      apiKey,
      createdAt: new Date().toISOString(),
    });
    fs.writeFileSync(accPath, JSON.stringify(accs, null, 2));

    log("  inject 9Router…");
    await importYunwuKeyToRouter(providerNodeId, email, apiKey, log);
    log(`  ✅ [${idx}] done ${email}`);
    return { email, username, apiKey, ok: true };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  let accounts;
  if (process.argv[2]) {
    accounts = JSON.parse(process.argv[2]);
  } else if (process.env.YUNWU_GMAIL_ACCOUNTS) {
    accounts = JSON.parse(process.env.YUNWU_GMAIL_ACCOUNTS);
  } else {
    throw new Error("Provide accounts JSON via argv or YUNWU_GMAIL_ACCOUNTS");
  }
  accounts = accounts.slice(0, Number(process.env.YUNWU_FARM_LIMIT || 3));
  log(`Farming ${accounts.length} Gmail → Yunwu → 9Router`);

  const providerNodeId = await ensureYunwuProviderNode(log);
  const results = [];
  for (let i = 0; i < accounts.length; i++) {
    try {
      results.push(await farmOne(accounts[i], i + 1, providerNodeId));
    } catch (e) {
      log(`  ❌ [${i + 1}] ${accounts[i].email}: ${e.message}`);
      results.push({ email: accounts[i].email, ok: false, error: e.message });
    }
    if (i < accounts.length - 1) await sleep(3000);
  }

  log("\n=== SUMMARY ===");
  for (const r of results) {
    log(
      r.ok
        ? `OK  ${r.email} user=${r.username} key=${String(r.apiKey).slice(0, 14)}…`
        : `FAIL ${r.email} — ${r.error}`,
    );
  }
  const ok = results.filter((r) => r.ok).length;
  log(`Done: ${ok}/${results.length}`);
  process.exit(ok === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
