const { getConfig } = require("./config");
const { sleep } = require("./utils");

/**
 * Managed tempmail API (tempmail.adrnode.com) — aligned with grok_farm latest.
 *
 * Auth: x-api-key (tm_...) and/or Authorization: Bearer
 * Session: x-session-id on inbox + messages
 * Create inbox: prefer server-generated address; optional { domain } only
 */

function tempmailHeaders(config, sessionId, extra = {}) {
    const key = config.tempmailApiKey;
    const headers = {
        Accept: "application/json",
        ...extra,
    };
    if (key) {
        headers["x-api-key"] = key;
        // Friend's script uses x-api-key; some gateways also accept Bearer tm_...
        headers.Authorization = `Bearer ${key}`;
    }
    if (sessionId) {
        headers["x-session-id"] = sessionId;
    }
    return headers;
}

function normalizeMessages(payload) {
    if (Array.isArray(payload)) {
        return payload;
    }
    if (payload && Array.isArray(payload.messages)) {
        return payload.messages;
    }
    if (payload && Array.isArray(payload.data)) {
        return payload.data;
    }
    return [];
}

async function createTempmail() {
    const config = getConfig();
    const api = config.tempmailApi;

    if (!config.tempmailApiKey) {
        throw new Error(
            "TEMPMAIL_API_KEY is not set. Put managed key (tm_...) in .env — Admin → Settings on tempmail.",
        );
    }

    const res = await fetch(`${api}/session`, {
        headers: tempmailHeaders(config),
    });
    const errText = await res.text().catch(() => "");
    let sessionData = {};
    try {
        sessionData = errText ? JSON.parse(errText) : {};
    } catch {
        sessionData = {};
    }

    if (!res.ok) {
        throw new Error(
            `Tempmail session failed: HTTP ${res.status} ${errText.slice(0, 200)}`,
        );
    }

    const sessionId = sessionData.sessionId;
    if (!sessionId) {
        throw new Error(
            `Tempmail session failed: ${JSON.stringify(sessionData).slice(0, 200)}`,
        );
    }

    const domains = config.tempmailDomains || [];
    const domain =
        domains.length > 0
            ? domains[Math.floor(Math.random() * domains.length)]
            : undefined;

    // Prefer server-generated address; optionally pin a domain
    const inboxBody = domain ? { domain } : {};
    const res2 = await fetch(`${api}/inboxes`, {
        method: "POST",
        headers: tempmailHeaders(config, sessionId, {
            "Content-Type": "application/json",
        }),
        body: JSON.stringify(inboxBody),
    });

    const errText2 = await res2.text().catch(() => "");
    let data = {};
    try {
        data = errText2 ? JSON.parse(errText2) : {};
    } catch {
        data = {};
    }

    if (!res2.ok) {
        throw new Error(
            `Tempmail create inbox failed: HTTP ${res2.status} ${errText2.slice(0, 200)}`,
        );
    }
    if (!data.address) {
        throw new Error(
            `Tempmail create inbox failed: ${JSON.stringify(data).slice(0, 200)}`,
        );
    }

    const addressDomain = String(data.address).split("@")[1] || domain || "";
    return {
        email: data.address,
        sessionId,
        domain: addressDomain,
    };
}

/**
 * Poll tempmail for a verification code.
 * @param {"digits6"|"grok"} mode
 *   - digits6: 6-digit OTP (AISA / Clerk)
 *   - grok: alphanumeric "376KDC" / "376-KDC" style codes
 */
async function pollTempmail(email, sessionId, mode = "digits6", timeoutMs) {
    const config = getConfig();
    const api = config.tempmailApi;
    const timeout = timeoutMs || config.emailPollTimeout;
    const interval = config.emailPollInterval;
    const start = Date.now();
    const encoded = encodeURIComponent(email);

    while (Date.now() - start < timeout) {
        try {
            const res = await fetch(`${api}/inboxes/${encoded}/messages`, {
                headers: tempmailHeaders(config, sessionId),
            });

            if (res.ok) {
                const payload = await res.json();
                const msgs = normalizeMessages(payload);

                if (msgs.length > 0) {
                    const subject = msgs[0].subject || "";
                    const body =
                        msgs[0].body || msgs[0].html || msgs[0].text || "";

                    if (mode === "grok") {
                        // Match patterns like: "376KDC" or "376-KDC" (optional dash)
                        const m = subject.match(/^([A-Z0-9]{3}-?[A-Z0-9]{3})\s/);
                        if (m) {
                            return m[1].replace("-", "");
                        }
                        const bm = body.match(/([A-Z0-9]{3}-[A-Z0-9]{3})/);
                        if (bm) {
                            return bm[1].replace("-", "");
                        }
                        // Also bare 6-char code in subject
                        const m2 = subject.match(/\b([A-Z0-9]{6})\b/);
                        if (m2) {
                            return m2[1];
                        }
                    } else {
                        let m = subject.match(/(\d{6})/);
                        if (m) {
                            return m[1];
                        }
                        m = body.match(/(\d{6})/);
                        if (m) {
                            return m[1];
                        }
                    }
                }
            } else if (res.status === 401) {
                throw new Error(
                    "Tempmail poll 401: check TEMPMAIL_API_KEY in .env",
                );
            }
        } catch (e) {
            if (e.message && e.message.includes("TEMPMAIL_API_KEY")) {
                throw e;
            }
            // keep polling on transient errors
        }

        await sleep(interval);
    }

    return null;
}

module.exports = {
    createTempmail,
    pollTempmail,
    tempmailHeaders,
};
