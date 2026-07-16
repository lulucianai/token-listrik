const { Camoufox } = require("camoufox-js");
const { getConfig } = require("./config");

/** Firefox prefs that suppress insecure-password autocomplete warnings on HTTP 9Router. */
const FIREFOX_USER_PREFS = {
    "signon.rememberSignons": false,
    "signon.autofillForms": false,
    "signon.autofillForms.http": false,
    "signon.capture.inputChanges.enabled": false,
    "signon.generation.enabled": false,
    "signon.management.page.breach-alerts.enabled": false,
    "signon.showAutoCompleteFooter": false,
    "security.insecure_field_warning.ignore_local_ip_address": true,
    "security.warn_viewing_mixed": false,
    "security.warn_submit_insecure": false,
    "security.insecure_connection_text.enabled": false,
    "security.insecure_connection_text.pbmode.enabled": false,
    "security.insecure_connection_icon.enabled": false,
    "security.insecure_connection_icon.pbmode.enabled": false,
    "browser.urlbar.display.usage": 0,
};

/**
 * Launch a Camoufox browser configured for farming / 9Router injection.
 * @param {object} [options]
 * @param {boolean} [options.headless]
 * @param {boolean} [options.withRouterPrefs] - include Firefox prefs for 9Router HTTP login
 * @returns {Promise<import('playwright').Browser>}
 */
async function launchCamoufox(options = {}) {
    const config = getConfig();
    const headless =
        options.headless !== undefined ? options.headless : config.headless;

    const launchOpts = {
        headless,
        humanize: true,
        os: "windows",
        locale: "en-US",
        geoip: true,
        args: ["--no-sandbox"],
    };

    if (options.withRouterPrefs !== false) {
        launchOpts.firefox_user_prefs = FIREFOX_USER_PREFS;
    }

    return Camoufox(launchOpts);
}

/**
 * Create a fresh context + page from a Camoufox browser.
 * @param {import('playwright').Browser} browser
 */
async function newFarmPage(browser) {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    page.on("pageerror", (err) => {
        const msg = err?.message || "";
        if (msg.includes("Cannot read properties of undefined")) {
            return;
        }
        // Soft log — don't crash farming on page script noise
        if (msg) {
            // eslint-disable-next-line no-console
            console.log(`[pageerror] ${msg}`);
        }
    });

    return { context, page };
}

module.exports = {
    FIREFOX_USER_PREFS,
    launchCamoufox,
    newFarmPage,
};
