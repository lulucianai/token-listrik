const fs = require("fs");
const path = require("path");
const { getConfig, getResultFile, ROOT_DIR } = require("./config");
const {
    sleep,
    readAccounts,
    removeAccount,
    appendErrorAccount,
    chunkAccounts,
    createFileLogger,
    formatDuration,
    acquireAccountLock,
    releaseAccountLock,
    tryAcquireAccountLock,
    ensureFileExists,
    acquireProxy,
    releaseProxy,
} = require("./utils");
const { launchBrowser } = require("./browser");
const {
    completeGoogleLogin,
    clickSelector,
    clickFirstVisibleSelector,
} = require("./google-login");
const { STEPS, createProgressManager } = require("./progress");
const { printReport } = require("./reporter");

const QUEUE_RETRY_DELAY_MS = 500;
const SIGNIN_URL =
    "https://zyloo.io/signin?callbackUrl=" +
    encodeURIComponent("/dashboard/event");
const KEYS_URL = "https://zyloo.io/dashboard/keys";
const EVENT_URL = "https://zyloo.io/dashboard/event";
const DASHBOARD_URL = "https://zyloo.io/dashboard";
const ZYLOO_API_BASE = "https://api.zyloo.io/v1";
const ZYLOO_DEFAULT_MODEL = "zyloo/kimi-k3";
const KEY_RE = /sk-zy-[A-Za-z0-9_-]+/g;

/**
 * Collect sk-zy-* keys seen in network responses + page DOM.
 */
function attachKeySniffer(page, bag) {
    page.on("response", async (response) => {
        try {
            const url = response.url();
            const ct = (response.headers()["content-type"] || "").toLowerCase();
            if (response.status() >= 400) {
                return;
            }
            if (
                !ct.includes("json") &&
                !ct.includes("text") &&
                !/key|token|auth|api/i.test(url)
            ) {
                return;
            }
            const text = await response.text().catch(() => "");
            if (!text) {
                return;
            }
            const matches = text.match(KEY_RE) || [];
            for (const k of matches) {
                bag.add(k);
            }
        } catch {
            // ignore sniff errors
        }
    });
}

async function openZylooSignIn(page, log) {
    const config = getConfig();

    log(`Navigating to ${SIGNIN_URL}`);
    await page.goto(SIGNIN_URL, {
        waitUntil: "networkidle2",
        timeout: config.timeouts.navigation,
    });

    log('Clicking "Continue with Google"...');
    // Prefer exact marketing copy, fall back to shared Google selector
    try {
        await clickSelector(page, "::-p-text(Continue with Google)", {
            timeout: config.timeouts.default,
            delayBeforeClick: config.delays.beforeNextClick,
        });
    } catch {
        await clickSelector(page, "::-p-text(Google)", {
            timeout: config.timeouts.default,
            delayBeforeClick: config.delays.beforeNextClick,
        });
    }
}

async function handleGooglePostLogin(page, log) {
    const config = getConfig();

    // Account chooser: click the matching tile if Google shows one
    try {
        await page.waitForFunction(
            () =>
                location.hostname.includes("accounts.google.com") ||
                location.hostname.includes("zyloo.io"),
            { timeout: 15000 },
        );
    } catch {
        // continue
    }

    if (page.url().includes("accounts.google.com")) {
        try {
            log("Looking for Google consent / Continue...");
            await page.keyboard.press("End").catch(() => {});
            await clickFirstVisibleSelector(
                page,
                [
                    "::-p-text(Continue)",
                    "::-p-text(Allow)",
                    "::-p-text(I agree)",
                    "::-p-text(Lanjutkan)",
                    "#submit_approve_access",
                ],
                config.timeouts.short,
            );
        } catch {
            log("No Google consent button (maybe already trusted)");
        }
    }
}

async function waitForZylooDashboard(page, log) {
    const config = getConfig();

    log("Waiting for Zyloo dashboard...");
    await page.waitForFunction(
        () => {
            const url = window.location.href;
            return (
                url.includes("zyloo.io") &&
                (url.includes("/dashboard") || url.includes("/event"))
            );
        },
        { timeout: config.timeouts.navigation },
    );
    log(`On Zyloo: ${page.url()}`);
}

async function scrapeKeysFromPage(page) {
    return page.evaluate((reSrc) => {
        const re = new RegExp(reSrc, "g");
        const found = new Set();
        const text = document.body?.innerText || "";
        for (const m of text.match(re) || []) {
            found.add(m);
        }
        for (const el of document.querySelectorAll(
            "input, code, pre, span, div, p, textarea",
        )) {
            const v = el.value || el.textContent || el.getAttribute?.("data-key") || "";
            for (const m of String(v).match(re) || []) {
                found.add(m);
            }
        }
        return [...found];
    }, KEY_RE.source);
}

async function clickButtonByText(page, pattern, timeout = 2000) {
    const handle = await page.evaluateHandle(
        (src) => {
            const re = new RegExp(src, "i");
            const nodes = [
                ...document.querySelectorAll("button, a, [role='button']"),
            ];
            return (
                nodes.find((el) => re.test((el.innerText || el.textContent || "").trim())) ||
                null
            );
        },
        pattern.source || String(pattern),
    );
    const el = handle.asElement();
    if (!el) {
        await handle.dispose().catch(() => {});
        return false;
    }
    try {
        await Promise.race([
            el.click(),
            sleep(timeout),
        ]);
        return true;
    } catch {
        return false;
    } finally {
        await handle.dispose().catch(() => {});
    }
}

async function tryClickCreateKey(page, log) {
    const patterns = [
        "^\\s*Create key\\s*$",
        "^\\s*Create API key\\s*$",
        "^\\s*New key\\s*$",
        "^\\s*Generate key\\s*$",
        "^\\s*Add key\\s*$",
        "create.*key|generate.*key|new key|add key",
    ];
    for (const src of patterns) {
        const ok = await clickButtonByText(page, new RegExp(src, "i"));
        if (ok) {
            log(`Clicked create/generate control (${src})`);
            await sleep(2000);
            return true;
        }
    }
    // Puppeteer text selector fallback
    for (const text of [
        "Create key",
        "Create API key",
        "New key",
        "Generate key",
    ]) {
        try {
            await clickSelector(page, `::-p-text(${text})`, { timeout: 1500 });
            log(`Clicked via p-text: ${text}`);
            await sleep(2000);
            return true;
        } catch {
            // next
        }
    }
    return false;
}

async function tryRevealOrCopyKey(page, log) {
    for (const src of ["reveal", "show key", "view key", "^\\s*copy\\s*$", "copy key"]) {
        const ok = await clickButtonByText(page, new RegExp(src, "i"), 1000);
        if (ok) {
            log(`Clicked ${src} control`);
            await sleep(1000);
        }
    }
}

/**
 * Visit event page (claim free Kimi K3 allowance) then harvest API key from /dashboard/keys.
 */
async function harvestZylooKey(page, bag, log) {
    const config = getConfig();

    log("Opening event page (Kimi K3 free pool)...");
    await page
        .goto(EVENT_URL, {
            waitUntil: "networkidle2",
            timeout: config.timeouts.navigation,
        })
        .catch(() => {});
    await sleep(3000);

    // Optional claim / CTA buttons
    for (const src of ["claim", "10m", "start using", "activate"]) {
        const ok = await clickButtonByText(page, new RegExp(src, "i"));
        if (ok) {
            log(`Clicked event CTA (${src})`);
            await sleep(2000);
        }
    }

    log("Opening API keys page...");
    await page.goto(KEYS_URL, {
        waitUntil: "networkidle2",
        timeout: config.timeouts.navigation,
    });
    await sleep(config.delays.beforeReadingCookies || 5000);

    await tryClickCreateKey(page, log);
    await tryRevealOrCopyKey(page, log);
    await sleep(2000);

    // Name modal? fill generic name if present
    try {
        const filled = await page.evaluate((name) => {
            const inputs = [
                ...document.querySelectorAll(
                    'input[name*="name" i], input[placeholder*="name" i], input[type="text"]',
                ),
            ];
            const el = inputs.find((i) => {
                const ph = (i.getAttribute("placeholder") || "").toLowerCase();
                const nm = (i.getAttribute("name") || "").toLowerCase();
                return (
                    ph.includes("name") ||
                    nm.includes("name") ||
                    i.offsetParent !== null
                );
            });
            if (!el || !el.offsetParent) {
                return false;
            }
            el.focus();
            el.value = name;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        }, `token-listrik-${Date.now()}`);
        if (filled) {
            await clickButtonByText(page, /create|save|confirm|generate/i);
            await sleep(2500);
        }
    } catch {
        // no modal
    }

    await tryRevealOrCopyKey(page, log);

    const fromDom = await scrapeKeysFromPage(page);
    for (const k of fromDom) {
        bag.add(k);
    }

    if (bag.size === 0) {
        // last resort: dashboard overview
        log("No key yet — checking overview...");
        await page
            .goto(DASHBOARD_URL, {
                waitUntil: "networkidle2",
                timeout: config.timeouts.navigation,
            })
            .catch(() => {});
        await sleep(3000);
        for (const k of await scrapeKeysFromPage(page)) {
            bag.add(k);
        }
    }

    const keys = [...bag];
    if (keys.length === 0) {
        const ssDir = path.join(ROOT_DIR, "screenshots");
        if (!fs.existsSync(ssDir)) {
            fs.mkdirSync(ssDir, { recursive: true });
        }
        await page
            .screenshot({
                path: path.join(ssDir, `zyloo_no_key_${Date.now()}.png`),
                fullPage: true,
            })
            .catch(() => {});
        throw new Error(
            "No sk-zy-* API key found on dashboard. See screenshots/zyloo_no_key_*.png",
        );
    }

    // Prefer longest / most recent looking key
    keys.sort((a, b) => b.length - a.length);
    const apiKey = keys[0];
    log(`Got Zyloo key: ${apiKey.slice(0, 12)}... (${keys.length} candidate(s))`);
    return apiKey;
}

function saveZylooKey(email, apiKey, log, extra = {}) {
    const resultFile = getResultFile("zyloo");
    ensureFileExists(resultFile);
    fs.appendFileSync(resultFile, `${email}|${apiKey}\n`);
    log(`Key saved to ${resultFile}`);

    const accountFile = path.join(ROOT_DIR, "zyloo_account.json");
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
        createdAt: new Date().toISOString(),
        model: ZYLOO_DEFAULT_MODEL,
        ...extra,
    });
    fs.writeFileSync(accountFile, JSON.stringify(accounts, null, 2));
}

async function ensureZylooProviderNode(log) {
    log("Checking Zyloo provider node in 9Router...");
    const config = getConfig();
    const baseUrl = config.routerUrl.replace(/\/$/, "");

    const listResponse = await fetch(`${baseUrl}/api/provider-nodes`, {
        method: "GET",
        headers: { Accept: "application/json" },
    });
    if (!listResponse.ok) {
        throw new Error(
            `Failed to list provider nodes: ${listResponse.status}`,
        );
    }

    const listData = await listResponse.json();
    const nodes = listData.nodes || listData;
    const existing = Array.isArray(nodes)
        ? nodes.find(
            (n) =>
                n.prefix === "zyloo" ||
                  (n.name && String(n.name).toLowerCase() === "zyloo"),
        )
        : null;
    if (existing) {
        log(`Zyloo provider node exists: ${existing.id}`);
        return existing.id;
    }

    log("Creating Zyloo provider node...");
    const createResponse = await fetch(`${baseUrl}/api/provider-nodes`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify({
            name: "Zyloo",
            prefix: "zyloo",
            apiType: "chat",
            baseUrl: ZYLOO_API_BASE,
            type: "openai-compatible",
        }),
    });
    if (!createResponse.ok) {
        const errorText = await createResponse.text();
        throw new Error(
            `Failed to create Zyloo provider node: ${createResponse.status} ${errorText}`,
        );
    }
    const createData = await createResponse.json();
    const nodeId = createData.id || createData.node?.id;
    if (!nodeId) {
        throw new Error(
            `No ID from provider node creation: ${JSON.stringify(createData)}`,
        );
    }
    log(`Zyloo provider node created: ${nodeId}`);
    return nodeId;
}

async function importZylooKeyToRouter(providerNodeId, email, apiKey, log) {
    log("Importing Zyloo key to 9Router...");
    const config = getConfig();
    const baseUrl = config.routerUrl.replace(/\/$/, "");
    const short = email.split("@")[0].slice(0, 12);
    const connectionName = `zyloo_${short}`;

    const response = await fetch(`${baseUrl}/api/providers`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify({
            provider: providerNodeId,
            name: connectionName,
            apiKey,
            defaultModel: ZYLOO_DEFAULT_MODEL,
            priority: 1,
            proxyPoolId: null,
            testStatus: "active",
        }),
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
            `Router registration failed: ${response.status} ${errorText}`,
        );
    }
    log(`Zyloo key for ${email} imported as "${connectionName}"`);
}

async function processZylooAccount(
    account,
    browserArgsIndex,
    workerIndex,
    log,
    updateProgress,
    useProxy = true,
) {
    const config = getConfig();
    let poolProxy = null;
    let proxy = account.proxy || null;

    if (!proxy && config.proxyPoolFile && useProxy) {
        poolProxy = await acquireProxy(log, updateProgress);
        proxy = poolProxy;
    }

    updateProgress({ step: STEPS.LAUNCHING, email: account.email });
    log(`Launching browser for ${account.email}`);

    const { browser, page } = await launchBrowser(
        browserArgsIndex,
        workerIndex,
        proxy,
    );
    const keyBag = new Set();
    attachKeySniffer(page, keyBag);

    try {
        updateProgress({ step: STEPS.NAVIGATING });
        await openZylooSignIn(page, log);

        updateProgress({ step: STEPS.GOOGLE_LOGIN });
        // Wait for Google host after OAuth redirect
        await page
            .waitForFunction(
                () => location.hostname.includes("accounts.google.com"),
                { timeout: 30000 },
            )
            .catch(() => {});
        await completeGoogleLogin(page, account, log);
        await handleGooglePostLogin(page, log);

        updateProgress({ step: STEPS.WAITING });
        await waitForZylooDashboard(page, log);

        updateProgress({ step: STEPS.GETTING_TOKEN });
        const apiKey = await harvestZylooKey(page, keyBag, log);

        let routerStatus = "file_only";
        updateProgress({ step: STEPS.IMPORTING });
        try {
            const nodeId = await ensureZylooProviderNode(log);
            await importZylooKeyToRouter(nodeId, account.email, apiKey, log);
            routerStatus = "injected";
        } catch (importErr) {
            routerStatus = "injection_failed";
            log(
                `Router import failed (key still saved): ${importErr.message}`,
            );
        }

        saveZylooKey(account.email, apiKey, log, { status: routerStatus });
        removeAccount(account.rawLine);
        log(`Done ${account.email} (${routerStatus}) — removed from accounts.txt`);

        await sleep(config.delays.beforeBrowserClose);
    } finally {
        await browser.close();
        log("Browser closed.");
        if (poolProxy) {
            releaseProxy(poolProxy);
            log(`[Proxy] Released`);
        }
    }
}

async function runZylooWorker(
    workerAccounts,
    workerId,
    browserArgsIndex,
    workerIndex,
    total,
    progress,
    log,
    useProxy = true,
) {
    const config = getConfig();
    let successCount = 0;
    let failedCount = 0;
    let processedCount = 0;
    const accountStats = [];
    const queue = [...workerAccounts];

    while (queue.length > 0) {
        const account = queue[0];
        let hasLock = false;

        if (queue.length > 1) {
            if (!tryAcquireAccountLock(account.email)) {
                log(
                    `[${workerId}] ${account.email} is locked, moving to back of queue.`,
                );
                queue.push(queue.shift());
                await sleep(QUEUE_RETRY_DELAY_MS);
                continue;
            }
            hasLock = true;
        }

        const updateProgress = (payload) => {
            progress.updateWorker(workerId, {
                ...payload,
                email: account.email,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        };

        const startTime = Date.now();
        let accountSuccess = false;
        let accountError = null;

        try {
            if (!hasLock) {
                await acquireAccountLock(account.email, log, updateProgress);
                hasLock = true;
            }
            queue.shift();

            await processZylooAccount(
                account,
                browserArgsIndex,
                workerIndex,
                log,
                updateProgress,
                useProxy,
            );

            accountSuccess = true;
            successCount += 1;
            processedCount += 1;
            progress.updateWorker(workerId, {
                step: STEPS.DONE,
                email: account.email,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        } catch (error) {
            accountSuccess = false;
            accountError = error.message;
            failedCount += 1;
            processedCount += 1;
            appendErrorAccount(account, error.message, "Zyloo");
            browserArgsIndex =
                (browserArgsIndex + 1) % config.browserArgsSets.length;
            log(`[${workerId}] Error: ${error.message}`);
            progress.updateWorker(workerId, {
                step: STEPS.ERROR,
                email: account.email,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        } finally {
            accountStats.push({
                email: account.email,
                rawLine: account.rawLine,
                success: accountSuccess,
                duration: Date.now() - startTime,
                error: accountError,
            });
            if (hasLock) {
                releaseAccountLock(account.email);
            }
        }

        if (queue.length > 0) {
            progress.updateWorker(workerId, { step: STEPS.WAITING });
            await sleep(config.delays.betweenAccounts);
        }
    }

    progress.updateWorker(workerId, {
        step: STEPS.DONE,
        email: "Done",
        success: successCount,
        failed: failedCount,
        current: workerAccounts.length,
    });

    return {
        successCount,
        failedCount,
        accounts: accountStats,
        label: `Zyloo W${workerIndex + 1}`,
    };
}

async function runZylooAutomation(sharedProgress = null, useProxy = true) {
    const config = getConfig();
    const logger = createFileLogger();
    const accounts = readAccounts();

    if (accounts.length === 0) {
        if (!sharedProgress) {
            console.log("No accounts found. Format: email|password");
        }
        logger.close();
        return null;
    }

    if (!sharedProgress) {
        console.log("");
        console.log("⚡ Zyloo Automation (Kimi K3 event-ready)");
        console.log("   Sign in with Google → /dashboard/event → harvest sk-zy-* key");
        console.log("   Import to 9Router as openai-compatible (api.zyloo.io/v1)");
        console.log(
            "   Note: Zyloo free event is 1 account per IP — use proxy pool / BROWSER_COUNT carefully.",
        );
        console.log("");
    }

    const startedAt = Date.now();
    const chunks = chunkAccounts(accounts, config.browserCount);
    const progress =
        sharedProgress ||
        createProgressManager(
            `⚡ Zyloo Automation — ${accounts.length} accounts, ${chunks.length} workers`,
        );

    chunks.forEach((chunk, i) => {
        progress.addWorker(`zyloo-${i}`, chunk.length, `Zyloo W${i + 1}`);
    });

    const results = await Promise.all(
        chunks.map((chunk, i) => {
            const browserArgsIndex = i % config.browserArgsSets.length;
            return runZylooWorker(
                chunk,
                `zyloo-${i}`,
                browserArgsIndex,
                i,
                accounts.length,
                progress,
                logger.log,
                useProxy,
            );
        }),
    );

    if (!sharedProgress) {
        progress.stop();
    }

    const successCount = results.reduce((sum, r) => sum + r.successCount, 0);
    const failedCount = results.reduce((sum, r) => sum + r.failedCount, 0);
    const totalDuration = Date.now() - startedAt;

    if (!sharedProgress) {
        printReport("⚡ ZYLOO AUTOMATION REPORT", results, totalDuration);
        console.log(`📄 Log: ${logger.logFile}`);
        console.log(`🔑 Keys: ${getResultFile("zyloo")}`);
        console.log(
            `🔌 Model: ${ZYLOO_DEFAULT_MODEL} @ ${ZYLOO_API_BASE}`,
        );
        console.log("");
    } else {
        logger.log(
            `Zyloo finished. Success: ${successCount}, Failed: ${failedCount}, Duration: ${formatDuration(totalDuration)}`,
        );
    }

    logger.close();
    return { successCount, failedCount, results };
}

module.exports = {
    runZylooAutomation,
    ensureZylooProviderNode,
    importZylooKeyToRouter,
};
