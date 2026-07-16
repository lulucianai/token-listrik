const { getConfig } = require("./config");
const { sleep, randomString, randomDigits } = require("./utils");

async function createTempmail() {
    const config = getConfig();
    const api = config.tempmailApi;

    const res = await fetch(`${api}/session`);
    const { sessionId } = await res.json();

    if (!sessionId) {
        throw new Error("Tempmail session failed");
    }

    const local = randomString(8) + randomDigits(3);
    const domains = config.tempmailDomains;
    const domain = domains[Math.floor(Math.random() * domains.length)];

    const res2 = await fetch(`${api}/inboxes`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-session-id": sessionId,
        },
        body: JSON.stringify({ localPart: local, domain }),
    });

    const data = await res2.json();

    if (!data.address) {
        throw new Error(`Tempmail inbox create failed: ${JSON.stringify(data)}`);
    }

    return { email: data.address, sessionId, domain };
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

    while (Date.now() - start < timeout) {
        try {
            const res = await fetch(
                `${api}/inboxes/${encodeURIComponent(email)}/messages`,
                { headers: { "x-session-id": sessionId } },
            );

            if (res.ok) {
                const msgs = await res.json();

                if (msgs && msgs.length > 0) {
                    const subject = msgs[0].subject || "";
                    const body =
                        msgs[0].body || msgs[0].html || msgs[0].text || "";

                    if (mode === "grok") {
                        const m = subject.match(/^([A-Z0-9]{3}-?[A-Z0-9]{3})\s/);
                        if (m) {
                            return m[1].replace("-", "");
                        }
                        const bm = body.match(/([A-Z0-9]{3}-[A-Z0-9]{3})/);
                        if (bm) {
                            return bm[1].replace("-", "");
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
            }
        } catch (_) {
            // keep polling
        }

        await sleep(interval);
    }

    return null;
}

module.exports = {
    createTempmail,
    pollTempmail,
};
