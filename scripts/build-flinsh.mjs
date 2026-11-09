#!/usr/bin/env node
/**
 * Packages the "web-flinsh" gulp build (build/) for Flinsh.
 *
 *   cd gulp && yarn gulp build.web-flinsh     # compiles into ../build
 *   node scripts/build-flinsh.mjs             # writes dist-flinsh/ and dist-flinsh-single/
 *
 * Two outputs:
 *
 *  dist-flinsh-single/index.html  One self-contained file: bundle, CSS, font, atlases,
 *                                 sfx and the menu video inlined (data: URIs, CSS as text in
 *                                 window.__FLINSH_ASSETS__). Runs under today's Flinsh CSP
 *                                 (srcdoc, no network). Leaves out the 19-minute music track
 *                                 and the interactive-tutorial GIFs to keep the size sane.
 *
 *  dist-flinsh/                   index.html + bundle.js + main.css + res/ with relative URLs.
 *                                 Everything the web build has, loaded on demand. Needs Flinsh
 *                                 to serve a directory (see FLINSH.md).
 *
 * Options: --full-single  also inline music + tutorial GIFs into
 *                         dist-flinsh-single/index.full.html (to measure; not committed).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(root, "build");
const preloaderDir = path.join(root, "gulp", "preloader");
const multiDir = path.join(root, "dist-flinsh");
const singleDir = path.join(root, "dist-flinsh-single");
const fullSingle = process.argv.includes("--full-single");

const read = rel => fs.readFileSync(path.join(buildDir, rel));
const exists = rel => fs.existsSync(path.join(buildDir, rel));

if (!exists("bundle.js")) {
    console.error("build/bundle.js missing. Run `cd gulp && yarn gulp build.web-flinsh` first.");
    process.exit(1);
}
const bundleSrc = read("bundle.js").toString();
if (!bundleSrc.includes("flinsh:ready")) {
    console.error("build/bundle.js is not a web-flinsh build (no flinsh boot guard found).");
    process.exit(1);
}

// ---- Asset selection
// Only what the free web variant actually loads. Left out on purpose:
//  - theme-full / menu / puzzle-full music: standalone (Steam) only, MUSIC.theme is theme-short on web
//  - interactive_tutorial.cn.noinline: WeGame only
//  - logo_cn/logo_wegame, puzzle_dlc_logo*: other variants / puzzle DLC (needs the API)
//  - res/ui/*shapez2*, *puzzlez*: main menu ads, hidden in Flinsh (no external links)
const CORE = [
    "async-resources.css",
    "res/atlas0_hq.png",
    "res/atlas0_mq.png",
    "res/atlas0_lq.png",
    "res/logo_demo.png", // main menu + loading screen logo on web (getLogoSprite)
    "res/logo.png", // phone notice (mobile_warning.js)
    "res/logo-tobspr-games.svg",
    "res/sounds/sfx.mp3",
    "res/bg_render.webm",
];
const tutorialGifs = fs
    .readdirSync(path.join(buildDir, "res/ui/interactive_tutorial.noinline"))
    .filter(f => f.endsWith(".gif"))
    .map(f => "res/ui/interactive_tutorial.noinline/" + f);
const EXTRA = ["res/sounds/music/theme-short.mp3", ...tutorialGifs];
const FONT = "res/fonts/GameFont.woff2";

const MIME = {
    ".png": "image/png",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".mp3": "audio/mpeg",
    ".webm": "video/webm",
    ".woff2": "font/woff2",
};
const dataUri = rel => `data:${MIME[path.extname(rel)]};base64,${read(rel).toString("base64")}`;

// ---- Shared HTML pieces

/** Escape text so it can't end the <script>/<style> element it is inlined into */
const scriptSafe = s => s.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
const styleSafe = s => s.replace(/<\/(style)/gi, "<\\/$1");

// Main menu banners are hidden in Flinsh; drop their (unbundled) images
const mainCss = read("main.css")
    .toString()
    .replace(/url\(res\/ui\/[a-z0-9_]+_banner_bg\.noinline\.png\)/gi, "none");

// Preloader markup without the "try the Steam version" link (dead in the sandbox)
const preloaderHtml = fs
    .readFileSync(path.join(preloaderDir, "preloader.html"), "utf8")
    .replace(/<div id="ll_standalone">[\s\S]*?<\/div>/, "");
const preloaderCss = fs.readFileSync(path.join(preloaderDir, "preloader.css"), "utf8");

/**
 * Upstream's preloader.js downloads the bundle by XHR and filters errors by the
 * "shapez.io" origin; neither works in the sandbox. This keeps its error screen.
 */
const bootShim = `
(function () {
    function showError(message, source) {
        if (window.APP_ERROR_OCCURED) return;
        window.APP_ERROR_OCCURED = true;
        console.error("shapez fatal error:", message, source || "");
        var el = document.createElement("div");
        el.id = "ll_preload_error";
        var inner = document.createElement("div");
        inner.className = "inner";
        var h = document.createElement("h3");
        h.className = "heading";
        h.innerText = "Fatal Error";
        var p = document.createElement("p");
        p.className = "content";
        p.innerText = String(message);
        inner.appendChild(h);
        inner.appendChild(p);
        if (source) {
            var s = document.createElement("p");
            s.className = "source";
            s.innerText = source;
            inner.appendChild(s);
        }
        el.appendChild(inner);
        document.documentElement.appendChild(el);
    }
    window.onerror = function (event, source, line, col, error) {
        if (String(event).indexOf("ResizeObserver loop") >= 0) return;
        showError((error && error.message) || event, source ? source + ":" + line + ":" + col : "");
    };
    window.coreThreadLoadedCb = function () {
        console.log("shapez core parsed at", Math.floor(performance.now()), "ms");
    };
})();
`;

function page({ head, body }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5, viewport-fit=cover">
<meta name="theme-color" content="#393747">
<title>shapez</title>
${head}
</head>
<body oncontextmenu="return false" style="background: #393747;">
${preloaderHtml}
${body}
</body>
</html>
`;
}

const fontFace = src => `@font-face {
    font-family: "GameFont";
    font-style: normal;
    font-weight: normal;
    font-display: swap;
    src: url("${src}") format("woff2");
}`;

const kb = n => (n / 1024).toFixed(0) + " KB";
const mb = n => (n / 1024 / 1024).toFixed(2) + " MB";

// ---- Single file

function buildSingle(assetList, outFile) {
    const assets = {};
    for (const rel of assetList) {
        assets[rel] = rel.endsWith(".css") ? read(rel).toString() : dataUri(rel);
    }
    const html = page({
        head: `<style>${fontFace(dataUri(FONT))}\n${preloaderCss}</style>
<style>${styleSafe(mainCss)}</style>`,
        body: `<script>${bootShim}</script>
<script>window.__FLINSH_ASSETS__ = ${scriptSafe(JSON.stringify(assets))};</script>
<script>${scriptSafe(bundleSrc)}</script>`,
    });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, html);
    return Buffer.byteLength(html);
}

// ---- Multi file

function buildMulti() {
    fs.rmSync(multiDir, { recursive: true, force: true });
    const files = ["bundle.js", FONT, ...CORE, ...EXTRA];
    for (const rel of files) {
        const out = path.join(multiDir, rel);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.copyFileSync(path.join(buildDir, rel), out);
    }
    fs.writeFileSync(path.join(multiDir, "main.css"), mainCss);
    const html = page({
        head: `<style>${fontFace(FONT)}\n${preloaderCss}</style>
<link rel="stylesheet" href="main.css">`,
        body: `<script>${bootShim}</script>
<script src="bundle.js"></script>`,
    });
    fs.writeFileSync(path.join(multiDir, "index.html"), html);
    files.push("main.css", "index.html");
    return files.map(rel => [rel, fs.statSync(path.join(multiDir, rel)).size]);
}

// ---- Run

const singleSize = buildSingle(CORE, path.join(singleDir, "index.html"));
console.log("dist-flinsh-single/index.html", mb(singleSize));

if (fullSingle) {
    const fullSize = buildSingle([...CORE, ...EXTRA], path.join(singleDir, "index.full.html"));
    console.log("dist-flinsh-single/index.full.html", mb(fullSize), "(measurement only)");
}

const multi = buildMulti();
const total = multi.reduce((a, [, s]) => a + s, 0);
console.log("dist-flinsh/", multi.length, "files,", mb(total));
const firstPaint = ["index.html", "bundle.js", "main.css", FONT, "res/logo_demo.png", "res/sounds/sfx.mp3"];
console.log(
    "  needed for the main menu:",
    mb(multi.filter(([rel]) => firstPaint.includes(rel)).reduce((a, [, s]) => a + s, 0))
);
for (const [rel, size] of multi.sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log("  " + kb(size).padStart(9), rel);
}
