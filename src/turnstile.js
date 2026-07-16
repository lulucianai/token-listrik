const { getConfig } = require("./config");
const { sleep } = require("./utils");

/**
 * Click Cloudflare Turnstile checkbox and wait for token.
 * Works on main page; optional frames support for Clerk/AISA embeds.
 *
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {Function} [opts.log]
 * @param {import('playwright').Frame[]} [opts.frames]
 * @param {number} [opts.timeout]
 * @returns {Promise<boolean>}
 */
async function handleTurnstile(page, opts = {}) {
    const config = getConfig();
    const log = opts.log || (() => {});
    const frames = opts.frames || [];
    const timeout = opts.timeout || config.turnstileWaitTimeout;

    const hasWidget = await page
        .evaluate(() => {
            return (
                !!document.querySelector('[name="cf-turnstile-response"]') ||
                !!document.querySelector(".cf-turnstile") ||
                !!document.querySelector('iframe[src*="challenges.cloudflare"]')
            );
        })
        .catch(() => false);

    // Also check frames
    let inFrames = false;
    if (!hasWidget && frames.length > 0) {
        for (const frame of frames) {
            const found = await frame
                .evaluate(
                    () =>
                        !!document.querySelector(
                            'input[name="cf-turnstile-response"]',
                        ),
                )
                .catch(() => false);
            if (found) {
                inFrames = true;
                break;
            }
        }
    }

    if (!hasWidget && !inFrames) {
        log("No Turnstile widget found");
        return true;
    }

    log("Handling Turnstile...");
    await sleep(6000);

    let widgetRect = await page
        .evaluate(() => {
            const input = document.querySelector(
                'input[name="cf-turnstile-response"]',
            );
            if (!input) {
                return null;
            }
            let el = input;
            for (let i = 0; i < 8; i++) {
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
        })
        .catch(() => null);

    // Search frames if needed
    if (!widgetRect && frames.length > 0) {
        for (const frame of frames) {
            widgetRect = await frame
                .evaluate(() => {
                    const input = document.querySelector(
                        'input[name="cf-turnstile-response"]',
                    );
                    if (!input) {
                        return null;
                    }
                    let el = input;
                    for (let i = 0; i < 8; i++) {
                        el = el.parentElement;
                        if (!el) {
                            break;
                        }
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 100 && rect.height > 30) {
                            return rect.toJSON();
                        }
                    }
                    return (
                        input.parentElement?.getBoundingClientRect()?.toJSON() ||
                        null
                    );
                })
                .catch(() => null);

            if (widgetRect) {
                const frameUrl = frame.url();
                const iframeRect = await page
                    .evaluate((src) => {
                        for (const iframe of document.querySelectorAll("iframe")) {
                            if (
                                iframe.src &&
                                (src.includes(iframe.src) ||
                                    iframe.src.includes(src))
                            ) {
                                return iframe.getBoundingClientRect().toJSON();
                            }
                        }
                        for (const iframe of document.querySelectorAll("iframe")) {
                            if (iframe.src && src.includes("clerk")) {
                                return iframe.getBoundingClientRect().toJSON();
                            }
                        }
                        return null;
                    }, frameUrl)
                    .catch(() => null);

                if (iframeRect) {
                    widgetRect.x += iframeRect.x;
                    widgetRect.y += iframeRect.y;
                }
                break;
            }
        }
    }

    if (widgetRect) {
        const clickX = widgetRect.x + widgetRect.width * 0.05;
        const clickY = widgetRect.y + widgetRect.height * 0.5;
        log(
            `Clicking Turnstile at (${Math.round(clickX)}, ${Math.round(clickY)})`,
        );
        await page.mouse.click(clickX, clickY);
    } else {
        log("WARNING: Turnstile widget rect not found — continuing");
    }

    log("Waiting for Turnstile token...");
    const pollStart = Date.now();
    while (Date.now() - pollStart < timeout) {
        const targets = [page, ...frames];
        for (const target of targets) {
            const val = await target
                .evaluate(
                    () =>
                        document.querySelector(
                            'input[name="cf-turnstile-response"]',
                        )?.value || "",
                )
                .catch(() => "");
            if (val.length > 10) {
                log("Turnstile solved!");
                return true;
            }
        }
        await sleep(2000);
    }

    log("WARNING: Turnstile did not solve within timeout");
    return false;
}

module.exports = {
    handleTurnstile,
};
