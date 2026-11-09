#!/usr/bin/env node
/**
 * Serves the repo for test/flinsh-harness.html (http://localhost:8130/test/flinsh-harness.html).
 *
 * For /dist-flinsh/index.html?flinsh=1 it plays the part of a Flinsh that serves a built
 * directory: it sends DIRECTORY_CSP as a header and injects the bridge at the top of the page,
 * so the multi-file build can be tested the way it would run. Everything is served with
 * Access-Control-Allow-Origin: * because the sandboxed frame has an opaque ("null") origin,
 * which makes its XHRs and font loads cross-origin even to the server it came from.
 */
import http from "http";
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = +(process.env.PORT || 8130);

/** What Flinsh would need for a directory build: today's policy plus 'self' for fetches */
export const DIRECTORY_CSP = [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
].join("; ");

// Reuse the harness's copy of the Flinsh bridge
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, "test/flinsh-sandbox.js"), "utf8"), sandbox);
const { bridgeSource } = sandbox.window.FlinshSandbox;

const PROBE = `(function(){function post(k,d){parent.postMessage({__harness:1,kind:k,detail:String(d)},"*")}
window.addEventListener("error",function(e){post("error",e.message+" @ "+(e.filename||"")+":"+(e.lineno||""))});
window.addEventListener("unhandledrejection",function(e){post("error","unhandledrejection: "+((e.reason&&e.reason.message)||e.reason))});
document.addEventListener("securitypolicyviolation",function(e){post("csp",e.effectiveDirective+" blocked "+e.blockedURI)});})();`;

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".mp3": "audio/mpeg",
    ".webm": "video/webm",
    ".woff2": "font/woff2",
};

/**
 * THROTTLE=fast3g emulates Chrome's "Fast 3G" preset at the server: 562.5 ms latency per request
 * and one shared 1.47 Mbit/s downlink. Done here rather than with DevTools because the
 * sandboxed iframe can run out of process, where page-level throttling doesn't reach it.
 */
const THROTTLE = process.env.THROTTLE === "fast3g" ? { latencyMs: 562.5, bytesPerSec: (1474.56 * 1000) / 8 } : null;
let linkFreeAt = 0; // when the shared downlink is next idle
function send(res, status, headers, body) {
    headers = { ...headers, "Content-Length": String(body.length) };
    if (!THROTTLE) {
        res.writeHead(status, headers);
        return res.end(body);
    }
    setTimeout(() => {
        res.writeHead(status, headers);
        const CHUNK = 16 * 1024;
        let offset = 0;
        let closed = false;
        res.on("close", () => (closed = true));
        const pump = () => {
            if (closed) return; // client went away: free the link
            if (offset >= body.length) return res.end();
            const piece = body.subarray(offset, offset + CHUNK);
            offset += piece.length;
            const now = Date.now();
            linkFreeAt = Math.max(linkFreeAt, now) + (piece.length / THROTTLE.bytesPerSec) * 1000;
            setTimeout(() => {
                res.write(piece);
                pump();
            }, linkFreeAt - now);
        };
        pump();
    }, THROTTLE.latencyMs);
}

http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return send(res, 404, { "Access-Control-Allow-Origin": "*" }, Buffer.from("not found"));
    }
    const headers = {
        "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
    };
    if (rel === "/dist-flinsh/index.html" && url.searchParams.get("flinsh") === "1") {
        headers["Content-Security-Policy"] = DIRECTORY_CSP;
        const bridge = url.searchParams.get("nobridge") ? "" : bridgeSource({}, ["user"]);
        const html = fs
            .readFileSync(file, "utf8")
            .replace("<head>", `<head>\n<script>${PROBE}</script><script>${bridge}</script>`);
        return send(res, 200, headers, Buffer.from(html));
    }
    send(res, 200, headers, fs.readFileSync(file));
}).listen(port, () =>
    console.log(`http://localhost:${port}/test/flinsh-harness.html` + (THROTTLE ? " (Fast 3G)" : ""))
);
