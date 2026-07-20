const { getConfig } = require("./config");

/** @type {string|null} */
let cachedAuthToken = null;
/** @type {string|null} */
let cachedBaseUrl = null;

function getBaseUrl() {
    const config = getConfig();
    return config.routerUrl.replace(/\/+$/, "");
}

function extractAuthToken(response) {
    // Node 18+ / undici
    if (typeof response.headers.getSetCookie === "function") {
        const cookies = response.headers.getSetCookie();
        for (const c of cookies) {
            const m = String(c).match(/(?:^|;\s*)auth_token=([^;]+)/i);
            if (m) {
                return decodeURIComponent(m[1]);
            }
        }
    }
    const raw = response.headers.get("set-cookie") || "";
    const m = raw.match(/(?:^|,\s*)auth_token=([^;]+)/i);
    if (m) {
        return decodeURIComponent(m[1]);
    }
    return null;
}

/**
 * Login to 9Router dashboard API and cache JWT cookie value.
 * @param {Function} [log]
 */
async function loginToRouterApi(log) {
    const config = getConfig();
    const baseUrl = getBaseUrl();

    if (!config.routerPassword) {
        throw new Error(
            "ROUTER_PASSWORD is empty — set it in .env or Settings",
        );
    }

    if (log) {
        log(`9Router API login → ${baseUrl}`);
    }

    const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify({ password: config.routerPassword }),
    });

    const text = await response.text();
    let data = {};
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { raw: text.slice(0, 200) };
    }

    if (!response.ok || data.error) {
        throw new Error(
            `9Router login failed (${response.status}): ${data.error || text.slice(0, 150)}`,
        );
    }

    const token = extractAuthToken(response);
    if (!token) {
        throw new Error(
            "9Router login OK but no auth_token cookie returned",
        );
    }

    cachedAuthToken = token;
    cachedBaseUrl = baseUrl;
    if (log) {
        log("9Router API login OK");
    }
    return token;
}

/**
 * Authenticated fetch against 9Router REST API.
 * Auto-login once; retry once on 401.
 *
 * @param {string} path - e.g. /api/provider-nodes
 * @param {object} [options] - fetch options (method, body, headers, ...)
 * @param {Function} [log]
 */
async function routerApiFetch(path, options = {}, log) {
    const baseUrl = getBaseUrl();
    const url = path.startsWith("http")
        ? path
        : `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

    if (!cachedAuthToken || cachedBaseUrl !== baseUrl) {
        await loginToRouterApi(log);
    }

    const headers = {
        Accept: "application/json",
        ...(options.headers || {}),
        Cookie: `auth_token=${cachedAuthToken}`,
    };

    if (options.body && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
    }

    let response = await fetch(url, { ...options, headers });

    if (response.status === 401) {
        if (log) {
            log("9Router API 401 — re-login...");
        }
        cachedAuthToken = null;
        await loginToRouterApi(log);
        headers.Cookie = `auth_token=${cachedAuthToken}`;
        response = await fetch(url, { ...options, headers });
    }

    return response;
}

function clearRouterApiSession() {
    cachedAuthToken = null;
    cachedBaseUrl = null;
}

module.exports = {
    loginToRouterApi,
    routerApiFetch,
    clearRouterApiSession,
    getBaseUrl,
};
