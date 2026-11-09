#!/usr/bin/env node
/**
 * End-to-end check of the Flinsh build in Chrome, through test/flinsh-harness.html.
 *
 *   node test/flinsh-serve.mjs &
 *   PLAYWRIGHT=/path/to/node_modules/playwright-core node test/flinsh-e2e.mjs [options]
 *
 * Options: --mode=single|multi|full   --net=fast3g|none   --phone   --out=<dir for screenshots, default flinsh-e2e-output/>
 *          --menu-only (just time the menu)
 *
 * Flow: empty store -> menu (time to flinsh.ready()) -> new game -> place belts and
 * extractors -> pause menu stats -> "menu" (saves) -> brand-new page on the same store ->
 * continue -> pause menu stats must match.
 */
import fs from "fs";
import path from "path";

const arg = (name, dflt) => {
    const hit = process.argv.find(a => a === "--" + name || a.startsWith("--" + name + "="));
    if (!hit) return dflt;
    return hit.includes("=") ? hit.split("=")[1] : true;
};
const mode = arg("mode", "single");
const net = arg("net", "none");
const phone = arg("phone", false);
const out = arg("out", "flinsh-e2e-output");
fs.mkdirSync(out, { recursive: true });
const menuOnly = arg("menu-only", false);
const base = "http://localhost:" + (process.env.PORT || 8130) + "/test/flinsh-harness.html";

const { chromium } = await import(process.env.PLAYWRIGHT || "playwright-core");

// Chrome DevTools "Fast 3G" preset
const FAST_3G = {
    offline: false,
    latency: 562.5,
    downloadThroughput: (1474.56 * 1000) / 8,
    uploadThroughput: (675 * 1000) / 8,
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const result = { mode, net, phone: Boolean(phone), runs: [] };

async function openHarness({ wipe }) {
    const context = await browser.newContext({
        viewport: phone ? { width: 700, height: 900 } : { width: 1400, height: 820 },
        ...(phone
            ? {
                  userAgent:
                      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
                  hasTouch: true,
              }
            : {}),
    });
    const page = await context.newPage();
    const logs = [];
    page.on("console", m => logs.push({ type: m.type(), text: m.text().slice(0, 400) }));
    page.on("pageerror", e => logs.push({ type: "pageerror", text: e.message }));
    const requests = [];
    page.on("request", r => requests.push(r.url().slice(0, 120)));
    if (net === "fast3g") {
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", FAST_3G);
    }
    const query = `mode=${mode}${wipe ? "&wipe=1" : ""}${phone ? "&phone=1" : ""}`;
    const t0 = Date.now();
    await page.goto(base + "?" + query, { waitUntil: "domcontentloaded", timeout: 120000 });
    return { context, page, logs, requests, t0 };
}

const appFrame = page => page.frames().find(f => f !== page.mainFrame());

async function waitReady(page) {
    await page.waitForFunction(() => window.harness.state.readyMs !== null, null, { timeout: 600000 });
    return page.evaluate(() => ({ ...window.harness.state }));
}

async function waitState(page, id, timeout = 600000) {
    const frame = appFrame(page);
    await frame.waitForFunction(id => document.body.id === "state_" + id, id, { timeout });
    if (id === "InGameState") {
        // The state switches before its assets finish loading; the toolbar means it's playable
        await frame.waitForSelector("#ingame_HUD_BuildingsToolbar", { state: "visible", timeout });
    }
    return frame;
}

async function pauseStats(page) {
    const frame = appFrame(page);
    // Escape first drops a selected building, then opens the pause menu
    for (let i = 0; i < 4; ++i) {
        if (await frame.locator(".beltsPlaced").isVisible()) break;
        await page.keyboard.press("Escape");
        await page.waitForTimeout(700);
    }
    await frame.waitForSelector(".beltsPlaced", { state: "visible", timeout: 10000 });
    await page.waitForTimeout(400);
    return frame.evaluate(() => ({
        belts: document.querySelector(".beltsPlaced").textContent.trim(),
        buildings: document.querySelector(".buildingsPlaced").textContent.trim(),
    }));
}

function storeSnapshot(page) {
    return page.evaluate(() => {
        const rows = [];
        for (const [k, v] of window.harness.store) rows.push([k, new TextEncoder().encode(JSON.stringify(v)).length]);
        return { rows, usage: window.harness.usage() };
    });
}

// ---- Run 1: fresh store
const run1 = await openHarness({ wipe: true });
let st = await waitReady(run1.page);
const menuRun = {
    run: "fresh",
    htmlFetchedMs: st.htmlFetchedMs,
    readyMs: st.readyMs,
    csp: st.csp,
    errors: st.errors,
};
result.runs.push(menuRun);
await run1.page.screenshot({ path: path.join(out, `${mode}-${net}${phone ? "-phone" : ""}-menu.png`) });

if (!menuOnly && !phone) {
    const frame = appFrame(run1.page);
    await frame.click(".playButton");
    await waitState(run1.page, "InGameState");
    await run1.page.waitForTimeout(4000);
    menuRun.ingameMs = Date.now() - run1.t0;

    // Belts: hotkey 1, drag along a few rows. Extractors: hotkey 4, clicks.
    const m = run1.page.mouse;
    await run1.page.keyboard.press("1");
    for (const y of [560, 600, 640]) {
        await m.move(340, y); // right of the tutorial panel
        await m.down();
        await m.move(620, y, { steps: 12 });
        await m.up();
    }
    await run1.page.keyboard.press("4");
    for (const x of [400, 480, 560]) {
        await m.click(x, 700);
    }
    await run1.page.waitForTimeout(500);
    await run1.page.screenshot({ path: path.join(out, `${mode}-${net}-ingame.png`) });

    const before = await pauseStats(run1.page);
    await run1.page.screenshot({ path: path.join(out, `${mode}-${net}-pause.png`) });
    await frame.click(".buttons .menu");
    await waitState(run1.page, "MainMenuState");
    await run1.page.waitForTimeout(1500); // debounced store writes
    const snap = await storeSnapshot(run1.page);
    menuRun.statsBeforeReload = before;
    menuRun.store = snap;

    // ---- Run 2: new page, same store (copied over from run 1's harness localStorage)
    const saved = await run1.page.evaluate(() => localStorage.getItem("flinsh-harness-store:shapez"));
    result.consoleRun1 = result.consoleRun1 || run1.logs.filter(l => !["log", "debug", "info"].includes(l.type));
    await run1.context.close(); // nothing from run 1 may keep the (throttled) link busy
    const run2 = await openHarness({ wipe: false });
    await run2.page.evaluate(s => {
        localStorage.setItem("flinsh-harness-store:shapez", s);
    }, saved);
    await run2.page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
    st = await waitReady(run2.page);
    const f2 = appFrame(run2.page);
    await f2.click(".continueButton");
    await waitState(run2.page, "InGameState");
    await run2.page.waitForTimeout(4000);
    const after = await pauseStats(run2.page);
    await run2.page.screenshot({ path: path.join(out, `${mode}-${net}-restored.png`) });
    result.runs.push({
        run: "reload",
        readyMs: st.readyMs,
        statsAfterReload: after,
        restored: JSON.stringify(after) === JSON.stringify(before),
        csp: st.csp,
        errors: st.errors,
    });
    result.consoleRun2 = run2.logs.filter(l => !["log", "debug", "info"].includes(l.type));
    result.externalRequestsRun2 = run2.requests.filter(u => !/^(http:\/\/localhost|data:|blob:)/.test(u));
}

result.consoleRun1 = result.consoleRun1 || run1.logs.filter(l => !["log", "debug", "info"].includes(l.type));
result.externalRequestsRun1 = run1.requests.filter(u => !/^(http:\/\/localhost|data:|blob:)/.test(u));
result.localRequestsRun1 = run1.requests.filter(u => u.startsWith("http://localhost")).length;
fs.writeFileSync(path.join(out, `result-${mode}-${net}${phone ? "-phone" : ""}.json`), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
await browser.close();
