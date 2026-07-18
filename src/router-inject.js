const path = require("path");
const fs = require("fs");
const { getConfig, ROOT_DIR } = require("./config");
const { sleep } = require("./utils");

/**
 * Fill password without focusing (avoids Firefox "not secure" popup on http://).
 * Uses native value setter so React/Vue controlled inputs pick up the change.
 * Password always comes from config.routerPassword (never hardcode secrets).
 */
async function fill9RouterPassword(page, password) {
    const pw = page
        .locator(
            'input[type="password"], input[type="text"][placeholder*="password" i], [placeholder*="password" i]',
        )
        .first();
    await pw.waitFor({ state: "visible", timeout: 10000 });
    await pw.evaluate((el, value) => {
        el.setAttribute("autocomplete", "new-password");
        el.setAttribute("data-lpignore", "true");
        el.setAttribute("data-1p-ignore", "true");
        const wasType = el.getAttribute("type") || "password";
        if (wasType === "password") {
            el.setAttribute("type", "text");
        }
        const proto = window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) {
            desc.set.call(el, value);
        } else {
            el.value = value;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        if (wasType === "password") {
            el.setAttribute("type", wasType);
        }
        el.blur();
    }, password);
}

/**
 * Login to 9Router dashboard (Next.js SPA — wait for form hydrate).
 * Retries up to 3 times. Credentials from getConfig() only.
 */
async function loginTo9Router(routerPage, log) {
    const config = getConfig();
    const baseUrl = config.routerUrl.replace(/\/+$/, "");

    log("Logging into 9Router...");
    await routerPage.goto(`${baseUrl}/login`, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });
    await routerPage
        .waitForLoadState("networkidle", { timeout: 15000 })
        .catch(() => {});

    const loginForm = routerPage
        .locator(
            'input[type="password"], input[placeholder*="password" i], input[placeholder*="Password" i]',
        )
        .first();
    const loginBtn = routerPage.locator("button", { hasText: /login/i }).first();

    try {
        await loginForm.waitFor({ state: "visible", timeout: 20000 });
    } catch {
        if (
            /dashboard/i.test(routerPage.url()) &&
            !/\/login/i.test(routerPage.url())
        ) {
            log("Already on dashboard (no login form)");
            return;
        }
        throw new Error(
            `9Router login form not found after wait (url=${routerPage.url()}). SPA may have failed to hydrate.`,
        );
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
        if (
            !/\/login/i.test(routerPage.url()) &&
            /dashboard/i.test(routerPage.url())
        ) {
            log("Already on dashboard");
            return;
        }

        log(`9Router login attempt ${attempt}/3...`);
        await fill9RouterPassword(routerPage, config.routerPassword);
        await loginBtn.click();

        try {
            await routerPage.waitForURL(
                (url) =>
                    !/\/login/i.test(url.pathname) ||
                    /dashboard/i.test(url.href),
                { timeout: 12000 },
            );
        } catch {
            // fall through
        }

        await sleep(1500);

        if (!/\/login/i.test(routerPage.url())) {
            log(`9Router login OK → ${routerPage.url()}`);
            return;
        }

        log(`Still on login page (${routerPage.url()}), retrying...`);
        await loginForm
            .waitFor({ state: "visible", timeout: 10000 })
            .catch(() => {});
        await sleep(1000);
    }

    throw new Error(
        `9Router login failed after 3 attempts (still at ${routerPage.url()}). ` +
            "Check ROUTER_URL and ROUTER_PASSWORD in Settings / .env.",
    );
}

function isOAuthDone(url) {
    if (!url) {
        return false;
    }
    return /\/oauth2\/device\/done|\/device\/done|device\/authorized/i.test(url);
}

async function dismissOAuthCookies(popup, log) {
    const selectors = [
        "#onetrust-accept-btn-handler",
        "#onetrust-reject-all-handler",
        'button:has-text("Allow All")',
        'button:has-text("Accept All")',
        'button:has-text("Reject All")',
    ];
    for (const sel of selectors) {
        const el = popup.locator(sel).first();
        if (await el.isVisible({ timeout: 250 }).catch(() => false)) {
            log("Dismissing cookie banner...");
            await el.click({ timeout: 2000 }).catch(() => {});
            await sleep(400);
            return true;
        }
    }
    return false;
}

function oauthAllowButton(popup) {
    return popup
        .getByRole("button", { name: "Allow", exact: true })
        .or(
            popup
                .locator('button, [role="button"], a[role="button"]')
                .filter({ hasText: /^\s*Allow\s*$/i }),
        );
}

function oauthContinueButton(popup) {
    return popup
        .getByRole("button", { name: "Continue", exact: true })
        .or(
            popup
                .locator('button, [role="button"]')
                .filter({ hasText: /^\s*Continue\s*$/i }),
        );
}

/**
 * If the OAuth popup shows a Grok/x.ai login form, fill it.
 */
async function handleOAuthLogin(popup, account, log) {
    const emailField = popup.locator('[data-testid="email"]');
    if (!(await emailField.isVisible({ timeout: 800 }).catch(() => false))) {
        return;
    }

    log("OAuth popup needs login...");

    const cookieBanner = popup.locator("#onetrust-accept-btn-handler");
    if (await cookieBanner.isVisible({ timeout: 1000 }).catch(() => false)) {
        await cookieBanner.click().catch(() => {});
        await sleep(500);
    }

    await popup
        .locator('[data-testid="continue-with-email"]')
        .click()
        .catch(() => {});
    await sleep(1500);

    await emailField.fill(account.email);
    await sleep(400);
    await popup.locator('[data-testid="sign-in-submit"]').click();
    await sleep(2500);

    const pw = popup.locator('[data-testid="password"]');
    if (await pw.isVisible({ timeout: 5000 }).catch(() => false)) {
        await pw.fill(account.password);
        await sleep(400);
        await popup.locator('[data-testid="sign-in-submit"]').click();
        await sleep(4000);
    }

    log("OAuth login submitted");
}

/**
 * Poll Continue → Allow until /done (more reliable than one-shot clicks).
 */
async function completeDeviceOAuth(popup, account, log, ssDir, tag) {
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(1500);
    await popup
        .screenshot({ path: path.join(ssDir, `${tag}_oauth_popup.png`) })
        .catch(() => {});

    await handleOAuthLogin(popup, account, log);

    const deadline = Date.now() + 60000;
    let clickedContinue = false;
    let clickedAllow = false;

    while (Date.now() < deadline) {
        if (popup.isClosed()) {
            log("OAuth popup closed");
            return true;
        }

        let url = "";
        try {
            url = popup.url();
        } catch {
            return true;
        }

        if (isOAuthDone(url)) {
            log(`OAuth done: ${url}`);
            await popup
                .screenshot({
                    path: path.join(ssDir, `${tag}_after_allow.png`),
                })
                .catch(() => {});
            return true;
        }

        try {
            const body = await popup.locator("body").innerText({ timeout: 1000 });
            if (/device authorized/i.test(body)) {
                log("OAuth done (page text: Device Authorized)");
                await popup
                    .screenshot({
                        path: path.join(ssDir, `${tag}_after_allow.png`),
                    })
                    .catch(() => {});
                return true;
            }
        } catch {
            // ignore
        }

        await dismissOAuthCookies(popup, log);

        if (!clickedContinue) {
            const cont = oauthContinueButton(popup).first();
            if (await cont.isVisible({ timeout: 400 }).catch(() => false)) {
                log(`Clicking Continue... (${url})`);
                await cont
                    .click({ timeout: 5000 })
                    .catch(() =>
                        cont.click({ force: true }).catch(() => {}),
                    );
                clickedContinue = true;
                await sleep(1200);
                continue;
            }
        }

        if (!clickedAllow) {
            const allow = oauthAllowButton(popup).first();
            if (await allow.isVisible({ timeout: 400 }).catch(() => false)) {
                log(`Clicking Allow (consent)... (${url})`);
                try {
                    await allow.click({ timeout: 5000 });
                } catch {
                    await allow.click({ force: true }).catch(async () => {
                        await allow
                            .evaluate((el) => el.click())
                            .catch(() => {});
                    });
                }
                clickedAllow = true;
                log("Clicked Allow!");
                await sleep(1500);
                continue;
            }

            const alt = popup
                .locator('button, [role="button"]')
                .filter({
                    hasText: /^\s*(Authorize|Approve|Allow access|Confirm)\s*$/i,
                })
                .first();
            if (await alt.isVisible({ timeout: 300 }).catch(() => false)) {
                log("Clicking alternate authorize button...");
                await alt.click({ force: true }).catch(() => {});
                clickedAllow = true;
                await sleep(1500);
                continue;
            }
        }

        if (
            clickedContinue &&
            !clickedAllow &&
            /device|user_code|code/i.test(url)
        ) {
            const cont = oauthContinueButton(popup).first();
            if (await cont.isVisible({ timeout: 300 }).catch(() => false)) {
                log("Re-clicking Continue...");
                await cont.click({ force: true }).catch(() => {});
                await sleep(1000);
            }
        }

        await handleOAuthLogin(popup, account, log);
        await sleep(400);
    }

    await popup
        .screenshot({ path: path.join(ssDir, `${tag}_after_allow.png`) })
        .catch(() => {});
    const finalUrl = popup.isClosed()
        ? "(closed)"
        : (() => {
            try {
                return popup.url();
            } catch {
                return "?";
            }
        })();
    log(
        `OAuth timeout (url=${finalUrl}, continue=${clickedContinue}, allow=${clickedAllow})`,
    );
    return isOAuthDone(finalUrl) || popup.isClosed();
}

/**
 * Inject a logged-in Grok session into 9Router Grok CLI provider via OAuth popup.
 * Expects the Camoufox context already authenticated to accounts.x.ai.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {object} account - { email, password, ... }
 * @param {Function} log
 * @returns {Promise<object>} updated account with status
 */
async function injectGrokTo9Router(context, account, log) {
    const config = getConfig();
    const baseUrl = config.routerUrl.replace(/\/+$/, "");
    const routerPage = await context.newPage();
    const ssDir = path.join(ROOT_DIR, "screenshots");

    if (!fs.existsSync(ssDir)) {
        fs.mkdirSync(ssDir, { recursive: true });
    }

    const tag = account.email?.replace(/[@.]/g, "_") || String(Date.now());

    try {
        await loginTo9Router(routerPage, log);

        log("Navigating to Grok CLI provider...");
        await routerPage.goto(`${baseUrl}/dashboard/providers/grok-cli`, {
            waitUntil: "domcontentloaded",
            timeout: 15000,
        });
        await sleep(2000);

        // Guard: redirected back to login?
        if (/\/login/i.test(routerPage.url())) {
            log("Redirected to login after dashboard nav — re-login once...");
            await loginTo9Router(routerPage, log);
            await routerPage.goto(`${baseUrl}/dashboard/providers/grok-cli`, {
                waitUntil: "domcontentloaded",
                timeout: 15000,
            });
            await sleep(2000);
        }

        await routerPage
            .screenshot({ path: path.join(ssDir, `${tag}_grok_cli.png`) })
            .catch(() => {});

        if (/\/login/i.test(routerPage.url())) {
            throw new Error(
                `Still on 9Router login after navigate (url=${routerPage.url()}). Session not established.`,
            );
        }

        log('Clicking "Add" button...');
        const addBtn = routerPage
            .locator("button")
            .filter({ hasText: /^(add|\+?\s*add)/i })
            .or(routerPage.locator("button").filter({ hasText: /add/i }))
            .first();
        await addBtn.waitFor({ state: "visible", timeout: 15000 });
        const popupPromise = routerPage.waitForEvent("popup", {
            timeout: 30000,
        });
        await addBtn.click();
        const popup = await popupPromise;
        log("OAuth popup opened");

        const oauthOk = await completeDeviceOAuth(
            popup,
            account,
            log,
            ssDir,
            tag,
        );
        if (!oauthOk) {
            await popup
                .screenshot({
                    path: path.join(ssDir, `${tag}_popup_stuck.png`),
                })
                .catch(() => {});
            throw new Error(
                `OAuth not completed (url=${popup.isClosed() ? "closed" : popup.url()})`,
            );
        }

        account.status = "injected";
        account.injectedAt = new Date().toISOString();

        try {
            const cookies = await context.cookies("https://accounts.x.ai");
            account.cookies = cookies;
            const cookieDir = path.join(ROOT_DIR, "cookies");
            if (!fs.existsSync(cookieDir)) {
                fs.mkdirSync(cookieDir, { recursive: true });
            }
            const cookieFile = path.join(
                cookieDir,
                `${account.email.replace(/[@.]/g, "_")}.json`,
            );
            fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));
            log(`Cookies saved to ${cookieFile}`);
        } catch (e) {
            log(`Cookie capture failed: ${e.message?.slice(0, 80)}`);
        }

        log(`[OK] Account ${account.email} injected to 9Router`);
    } catch (e) {
        log(`9Router injection error: ${e.message?.slice(0, 150)}`);
        account.status = "injection_failed";
        account.injectionError = e.message;
    } finally {
        await routerPage.close().catch(() => {});
    }

    return account;
}

module.exports = {
    fill9RouterPassword,
    loginTo9Router,
    handleOAuthLogin,
    completeDeviceOAuth,
    injectGrokTo9Router,
};
