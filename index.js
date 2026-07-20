const path = require("path");
const ora = require("ora");
const colors = require("ansi-colors");
const { getConfig } = require("./src/config");
const { readAccounts, formatDuration, readProxyPool } = require("./src/utils");
const { runKiroAutomation } = require("./src/kiro");
const { runCloudflareAutomation } = require("./src/cloudflare");
const { runCodebuddyAutomation } = require("./src/codebuddy");
const { runTokenGoAutomation } = require("./src/tokengo");
const { runZylooAutomation } = require("./src/zyloo");
const { runAisaAutomation } = require("./src/aisa");
const { runYunwuAutomation } = require("./src/yunwu");
const { runGrokFarmAutomation, runGrokLoginAutomation } = require("./src/grok");
const { openSettings } = require("./src/settings");
const fs = require("fs");
const retryDir = "./retryAccounts";

async function waitForEnter() {
    const inquirer = (await import("inquirer")).default;
    await inquirer.prompt([
        {
            type: "input",
            name: "continue",
            message: "Press Enter to return to menu...",
        },
    ]);
}

async function retryFailedAccounts(failedAccountsList, automationType) {
    const inquirer = (await import("inquirer")).default;

    while (failedAccountsList.length > 0) {
        const { retry } = await inquirer.prompt([
            {
                type: "confirm",
                name: "retry",
                message: `${failedAccountsList.length} accounts failed. Retry failed accounts?`,
                default: true,
            },
        ]);

        if (!retry) {
            console.log(
                `Skipped retry for ${failedAccountsList.length} failed accounts.\n`,
            );
            break;
        }

        console.log(`\nRetrying ${failedAccountsList.length} failed accounts...\n`);

        if (!fs.existsSync(retryDir)) {
            fs.mkdirSync(retryDir, { recursive: true });
        }

        const tempAccountFile = require("path").join(
            retryDir,
            `retry-${Date.now()}.txt`,
        );

        fs.writeFileSync(
            tempAccountFile,
            failedAccountsList.map((a) => a.rawLine).join("\n"),
        );

        const originalConfig = getConfig();
        const { updateEnvValue, reloadConfig } = require("./src/config");
        updateEnvValue("ACCOUNT_FILE", tempAccountFile);
        reloadConfig();

        let result;
        if (automationType === "kiro") {
            result = await runKiroAutomation();
        } else if (automationType === "cloudflare") {
            result = await runCloudflareAutomation();
        } else if (automationType === "codebuddy") {
            result = await runCodebuddyAutomation();
        } else if (automationType === "tokengo") {
            result = await runTokenGoAutomation();
        } else if (automationType === "zyloo") {
            result = await runZylooAutomation();
        }

        updateEnvValue("ACCOUNT_FILE", originalConfig.accountFile);
        reloadConfig();

        try {
            fs.unlinkSync(tempAccountFile);
        } catch {
            // Ignore cleanup errors
        }

        if (!result || result.failedCount === 0) {
            console.log("✅ All accounts processed successfully!\n");
            break;
        }

        failedAccountsList = failedAccountsList.filter((acc) =>
            fs
                .readFileSync(originalConfig.errorAccountFile, "utf-8")
                .includes(acc.email),
        );

        if (failedAccountsList.length === 0) {
            console.log("✅ All retries succeeded!\n");
            break;
        }
    }
}

async function confirmAccountChanges(oldCount, newCount) {
    const inquirer = (await import("inquirer")).default;
    const { confirm } = await inquirer.prompt([
        {
            type: "confirm",
            name: "confirm",
            message: `Account file changed: ${oldCount} → ${newCount} accounts. Continue with automation?`,
            default: true,
        },
    ]);
    return confirm;
}

function getFailedAccounts(results) {
    const failed = [];
    if (results && Array.isArray(results)) {
        results.forEach((worker) => {
            if (worker.accounts) {
                worker.accounts
                    .filter((a) => !a.success)
                    .forEach((acc) => {
                        failed.push({
                            email: acc.email,
                            rawLine: acc.rawLine,
                            error: acc.error,
                        });
                    });
            }
        });
    }
    return failed;
}

async function askFarmCount(defaultCount = 1) {
    const inquirer = (await import("inquirer")).default;
    const { count } = await inquirer.prompt([
        {
            type: "number",
            name: "count",
            message: "How many accounts to farm?",
            default: defaultCount,
            validate: (input) => {
                const num = Number(input);
                if (!Number.isFinite(num) || num < 1) {
                    return "Must be a number >= 1";
                }
                return true;
            },
        },
    ]);
    return Math.max(1, Number(count) || defaultCount);
}

function displayInfoPanel() {
    const config = getConfig();
    const accounts = readAccounts();
    const proxies = readProxyPool();

    const rows = [
        ["Router URL", config.routerUrl],
        ["Router Auth", config.routerPassword ? "password set" : "no password"],
        ["PW Headless", config.headless ? "true" : "false"],
        ["Chrome Path", config.chromeExecutablePath],
        [
            "Account File",
            `${path.basename(config.accountFile)} (${accounts.length} accounts)`,
        ],
        ["Browser Count", String(config.browserCount)],
        [
            "Proxy Pool",
            proxies.length > 0 ? `${proxies.length} proxies` : "not configured",
        ],
        ["Engine", "Puppeteer (Google) + Camoufox (AISA/Grok/Yunwu)"],
    ];

    const labelWidth = 15;
    const maxValueLen = Math.max(...rows.map(([, v]) => v.length));
    const innerWidth = labelWidth + 3 + maxValueLen;
    const boxWidth = innerWidth + 4;

    const title = "⚡ Token Listrik CLI";
    const titleDisplayLen = title.length + 2;
    const titlePadLeft = Math.floor((boxWidth - 2 - titleDisplayLen) / 2);
    const titlePadRight = boxWidth - titleDisplayLen - titlePadLeft;

    console.log("");
    console.log(`╔${"═".repeat(boxWidth - 2)}╗`);
    console.log(
        `║${" ".repeat(titlePadLeft)}${title}${" ".repeat(titlePadRight)}║`,
    );
    console.log(`╠${"═".repeat(boxWidth - 2)}╣`);

    for (const [label, value] of rows) {
        const line = `${label.padEnd(labelWidth)}: ${value}`;
        console.log(`║  ${line.padEnd(boxWidth - 4)}║`);
    }

    console.log(`╚${"═".repeat(boxWidth - 2)}╝`);
    console.log("");
}

async function runSelectedAutomations(selectedAutomations, proxySettings) {
    const { createProgressManager } = require("./src/progress");

    const automationMap = {
        kiro: { name: "Kiro", fn: runKiroAutomation },
        cloudflare: { name: "Cloudflare", fn: runCloudflareAutomation },
        codebuddy: { name: "Codebuddy", fn: runCodebuddyAutomation },
        tokengo: { name: "TokenGo", fn: runTokenGoAutomation },
        zyloo: { name: "Zyloo", fn: runZylooAutomation },
    };

    console.log("");
    const spinner = ora({
        text: colors.cyan(
            `Starting ${selectedAutomations.length} automation${selectedAutomations.length > 1 ? "s" : ""}...`,
        ),
        spinner: "dots",
    }).start();

    await new Promise((resolve) => setTimeout(resolve, 800));
    spinner.text = colors.cyan(
        `Running: ${selectedAutomations.map((a) => automationMap[a].name).join(", ")}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 800));

    if (selectedAutomations.includes("codebuddy")) {
        console.log("");
        spinner.warn(
            colors.yellow(
                "NOTE: Codebuddy (BETA) requires residential proxies to avoid account restrictions.",
            ),
        );
    }

    if (selectedAutomations.includes("tokengo")) {
        console.log("");
        spinner.warn(
            colors.yellow(
                "NOTE: TokenGo cooldown: 30-90s with proxy rotation, 5-10min without proxy.",
            ),
        );
    }

    if (selectedAutomations.includes("zyloo")) {
        console.log("");
        spinner.warn(
            colors.yellow(
                "NOTE: Zyloo free event is 1 account per IP — prefer proxy pool; model zyloo/kimi-k3.",
            ),
        );
    }

    spinner.succeed(colors.green("Automations starting..."));
    console.log("");

    const startedAt = Date.now();
    const sharedProgress = createProgressManager(
        selectedAutomations.length > 1
            ? "Running Multiple Automations"
            : `Running ${automationMap[selectedAutomations[0]].name}`,
    );

    const promises = selectedAutomations.map((type) =>
        automationMap[type].fn(sharedProgress, proxySettings[type]),
    );

    const results = await Promise.all(promises);
    sharedProgress.stop();

    const duration = formatDuration(Date.now() - startedAt);

    const resultParts = [];
    selectedAutomations.forEach((type, i) => {
        const result = results[i];
        if (result) {
            resultParts.push(
                `${automationMap[type].name}: ${colors.green(`${result.successCount} success`)} ${colors.red(`${result.failedCount} failed`)}`,
            );
        } else {
            resultParts.push(`${automationMap[type].name}: no accounts`);
        }
    });

    console.log("═".repeat(80));
    console.log(
        colors.bold.green(
            `Automation${selectedAutomations.length > 1 ? "s" : ""} Complete`,
        ),
    );
    console.log("");
    resultParts.forEach((part) => console.log(`  ${part}`));
    console.log("");
    console.log(`  ${colors.dim(`Duration: ${duration}`)}`);
    console.log("═".repeat(80));
    console.log("");

    for (let i = 0; i < selectedAutomations.length; i++) {
        const type = selectedAutomations[i];
        const result = results[i];

        if (result && result.failedCount > 0) {
            const failedAccounts = getFailedAccounts(result.results);
            if (failedAccounts.length > 0) {
                await retryFailedAccounts(failedAccounts, type);
            }
        }
    }

    await waitForEnter();
}

async function main() {
    const inquirer = (await import("inquirer")).default;
    let running = true;

    while (running) {
        console.clear();

        const initialAccounts = readAccounts();
        const initialCount = initialAccounts.length;

        displayInfoPanel();

        const { choice } = await inquirer.prompt([
            {
                type: "list",
                name: "choice",
                message: "Choose action:",
                choices: [
                    { name: "Run Automations", value: "run" },
                    { name: "AISA Farm (Camoufox + 9Router)", value: "aisa" },
                    { name: "Yunwu Farm (Camoufox + tempmail + 9Router)", value: "yunwu" },
                    { name: "Grok Farm (Camoufox + 9Router)", value: "grok_farm" },
                    { name: "Grok Login + 9Router Inject", value: "grok_login" },
                    { name: "Settings", value: "settings" },
                    { name: "Exit", value: "exit" },
                ],
            },
        ]);

        switch (choice) {
            case "run": {
                const currentAccounts = readAccounts();
                if (currentAccounts.length !== initialCount) {
                    const shouldContinue = await confirmAccountChanges(
                        initialCount,
                        currentAccounts.length,
                    );
                    if (!shouldContinue) {
                        continue;
                    }
                }

                const automationMap = {
                    kiro: { name: "Kiro" },
                    cloudflare: { name: "Cloudflare" },
                    codebuddy: { name: "Codebuddy" },
                    tokengo: { name: "TokenGo" },
                    zyloo: { name: "Zyloo" },
                };

                const { selected } = await inquirer.prompt([
                    {
                        type: "checkbox",
                        name: "selected",
                        message:
              "Select automations to run (press Enter without selecting to go back):",
                        choices: [
                            {
                                name: "Kiro Automation",
                                value: "kiro",
                                checked: true,
                            },
                            {
                                name: "Cloudflare Automation",
                                value: "cloudflare",
                                checked: true,
                            },
                            {
                                name: "Codebuddy Automation [BETA] (Requires Residential Proxy)",
                                value: "codebuddy",
                            },
                            {
                                name: "TokenGo Automation (30-90s cooldown with proxy rotation)",
                                value: "tokengo",
                                checked: true,
                            },
                            {
                                name: "Zyloo Automation (Google → sk-zy-* / Kimi K3 event)",
                                value: "zyloo",
                            },
                        ],
                    },
                ]);

                if (selected.length > 0) {
                    const proxies = readProxyPool();
                    const proxySettings = {};

                    if (proxies.length > 0) {
                        if (selected.length === 1) {
                            const { useProxy } = await inquirer.prompt([
                                {
                                    type: "confirm",
                                    name: "useProxy",
                                    message: `Use proxy pool (${proxies.length} proxies available)?`,
                                    default: true,
                                },
                            ]);
                            proxySettings[selected[0]] = useProxy;
                        } else {
                            const { withProxy } = await inquirer.prompt([
                                {
                                    type: "checkbox",
                                    name: "withProxy",
                                    message: `Select which automations should use proxy pool (${proxies.length} proxies):`,
                                    choices: selected.map((type) => ({
                                        name: automationMap[type].name,
                                        value: type,
                                        checked: true,
                                    })),
                                },
                            ]);
                            selected.forEach((type) => {
                                proxySettings[type] = withProxy.includes(type);
                            });
                        }
                    } else {
                        selected.forEach((type) => {
                            proxySettings[type] = false;
                        });
                    }

                    await runSelectedAutomations(selected, proxySettings);
                }
                break;
            }
            case "aisa": {
                const count = await askFarmCount(getConfig().farmCount || 1);
                const { signupOnly } = await inquirer.prompt([
                    {
                        type: "confirm",
                        name: "signupOnly",
                        message: "Signup only (skip 9Router import)?",
                        default: false,
                    },
                ]);
                await runAisaAutomation(count, { signupOnly });
                await waitForEnter();
                break;
            }
            case "yunwu": {
                const count = await askFarmCount(getConfig().farmCount || 1);
                const { signupOnly } = await inquirer.prompt([
                    {
                        type: "confirm",
                        name: "signupOnly",
                        message: "Signup only (skip 9Router import)?",
                        default: false,
                    },
                ]);
                await runYunwuAutomation(count, { signupOnly });
                await waitForEnter();
                break;
            }
            case "grok_farm": {
                const count = await askFarmCount(getConfig().farmCount || 1);
                const { signupOnly } = await inquirer.prompt([
                    {
                        type: "confirm",
                        name: "signupOnly",
                        message: "Signup only (skip 9Router injection)?",
                        default: false,
                    },
                ]);
                await runGrokFarmAutomation(count, { signupOnly });
                await waitForEnter();
                break;
            }
            case "grok_login": {
                const { limit } = await inquirer.prompt([
                    {
                        type: "number",
                        name: "limit",
                        message:
              "How many accounts to login+inject? (0 = all from result.txt)",
                        default: 0,
                    },
                ]);
                await runGrokLoginAutomation({
                    count: Number(limit) > 0 ? Number(limit) : null,
                });
                await waitForEnter();
                break;
            }
            case "settings":
                await openSettings();
                break;
            case "exit":
                running = false;
                console.log(colors.cyan("Bye!"));
                break;
        }
    }
}

main().catch((error) => {
    console.error(`Fatal error: ${error.message}`);
    process.exitCode = 1;
});
