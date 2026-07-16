const path = require("path");
const fs = require("fs");
const { getConfig, ROOT_DIR } = require("./config");
const { sleep } = require("./utils");

/**
 * Login to 9Router dashboard without focusing the password field
 * (avoids Firefox "connection is not secure" autocomplete overlay on HTTP).
 */
async function loginTo9Router(routerPage, log) {
    const config = getConfig();
    const baseUrl = config.routerUrl.replace(/\/$/, "");

    log("Logging into 9Router...");
    await routerPage.goto(`${baseUrl}/login`, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });

    const pw = routerPage
        .locator('input[type="password"], [placeholder*="password" i]')
        .first();
    await pw.waitFor({ state: "visible", timeout: 10000 });

    await pw.evaluate((el, password) => {
        el.setAttribute("autocomplete", "off");
        el.setAttribute("data-lpignore", "true");
        const wasType = el.getAttribute("type") || "password";
        el.setAttribute("type", "text");
        el.value = password;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.setAttribute("type", wasType);
        el.blur();
    }, config.routerPassword);

    await routerPage.locator("button", { hasText: /login/i }).click();
    await sleep(3000);
}

/**
 * If the OAuth popup shows a Grok/x.ai login form, fill it.
 */
async function handleOAuthLogin(popup, account, log) {
    const emailField = popup.locator('[data-testid="email"]');
    if (!(await emailField.isVisible({ timeout: 3000 }).catch(() => false))) {
        return;
    }

    log("OAuth popup needs login...");

    const cookieBanner = popup.locator("#onetrust-accept-btn-handler");
    if (await cookieBanner.isVisible({ timeout: 2000 }).catch(() => false)) {
        await cookieBanner.click().catch(() => {});
        await sleep(500);
    }

    await popup
        .locator('[data-testid="continue-with-email"]')
        .click()
        .catch(() => {});
    await sleep(2000);

    await emailField.fill(account.email);
    await sleep(500);
    await popup.locator('[data-testid="sign-in-submit"]').click();
    await sleep(3000);

    const pw = popup.locator('[data-testid="password"]');
    if (await pw.isVisible({ timeout: 5000 }).catch(() => false)) {
        await pw.fill(account.password);
        await sleep(500);
        await popup.locator('[data-testid="sign-in-submit"]').click();
        await sleep(5000);
    }

    log("OAuth login submitted");
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
    const baseUrl = config.routerUrl.replace(/\/$/, "");
    const routerPage = await context.newPage();
    const ssDir = path.join(ROOT_DIR, "screenshots");

    if (!fs.existsSync(ssDir)) {
        fs.mkdirSync(ssDir, { recursive: true });
    }

    const tag = account.email?.replace(/[@.]/g, "_") || Date.now();

    try {
        await loginTo9Router(routerPage, log);

        log("Navigating to Grok CLI provider...");
        await routerPage.goto(`${baseUrl}/dashboard/providers/grok-cli`, {
            waitUntil: "domcontentloaded",
            timeout: 15000,
        });
        await sleep(3000);
        await routerPage
            .screenshot({ path: path.join(ssDir, `${tag}_grok_cli.png`) })
            .catch(() => {});

        log('Clicking "Add" button...');
        const popupPromise = routerPage.waitForEvent("popup", { timeout: 30000 });
        const addBtn = routerPage
            .locator("button")
            .filter({ hasText: /add/i })
            .first();
        await addBtn.click();
        const popup = await popupPromise;
        log("OAuth popup opened");

        await popup.waitForLoadState("domcontentloaded");
        await sleep(3000);
        await popup
            .screenshot({ path: path.join(ssDir, `${tag}_oauth_popup.png`) })
            .catch(() => {});

        await handleOAuthLogin(popup, account, log);

        log("Looking for Continue button...");
        try {
            const continueBtn = popup.locator("button", { hasText: "Continue" });
            await continueBtn.waitFor({ state: "visible", timeout: 15000 });
            log("Found Continue, clicking...");
            await continueBtn.click();
            await sleep(8000);
            log(`After Continue URL: ${popup.url()}`);
        } catch (_) {
            log("Continue button not found");
        }

        // Dismiss cookie consent
        try {
            const allowAllBtn = popup.locator("button", { hasText: "Allow All" });
            await allowAllBtn.waitFor({ state: "visible", timeout: 5000 });
            log("Dismissing cookie consent...");
            await allowAllBtn.click();
            await sleep(2000);
        } catch (_) {
            try {
                const rejectAll = popup.locator("button", {
                    hasText: "Reject All",
                });
                await rejectAll.waitFor({ state: "visible", timeout: 3000 });
                await rejectAll.click();
                await sleep(2000);
            } catch (__) {
                // no consent banner
            }
        }

        log("Looking for Allow button...");
        try {
            const allowBtn = popup.locator("button", { hasText: /^Allow$/ });
            await allowBtn.waitFor({ state: "visible", timeout: 15000 });
            log("Found Allow, clicking...");
            await allowBtn.click();
            await sleep(8000);
            log("Clicked Allow!");
        } catch (_) {
            log("Allow button not found");
        }

        await popup
            .screenshot({ path: path.join(ssDir, `${tag}_after_allow.png`) })
            .catch(() => {});

        log("Waiting for OAuth completion...");
        try {
            await popup.waitForEvent("close", { timeout: 30000 });
            log("OAuth popup closed — injection complete!");
        } catch (_) {
            const url = popup.url();
            log(`Popup still open at: ${url}`);
            if (url.includes("/done") || url.includes("authorized")) {
                log("Device authorized (popup not auto-closed)");
            }
            await popup
                .screenshot({
                    path: path.join(ssDir, `${tag}_popup_stuck.png`),
                })
                .catch(() => {});
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
    loginTo9Router,
    handleOAuthLogin,
    injectGrokTo9Router,
};
