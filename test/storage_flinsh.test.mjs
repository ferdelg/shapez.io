#!/usr/bin/env node
/**
 * Unit test for src/js/platform/browser/storage_flinsh.js against a mock flinsh.store that
 * enforces the documented limits (256 KB per value, 2 MB / 1,000 keys per user).
 *
 *   node test/storage_flinsh.test.mjs
 *
 * The module is loaded as-is, with its three imports swapped for stubs.
 */
import fs from "fs";
import os from "os";
import path from "path";
import assert from "assert/strict";
import { fileURLToPath, pathToFileURL } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs
    .readFileSync(path.join(root, "src/js/platform/browser/storage_flinsh.js"), "utf8")
    .replace(/^import .*$/gm, "")
    .replace(
        /^/,
        `const FILE_NOT_FOUND = "file_not_found";
class StorageInterface { constructor(app) { this.app = app; } }
const createLogger = () => ({ log() {}, warn() {}, error() {} });
const getFlinshBridge = () => globalThis.window.flinsh;
export { FILE_NOT_FOUND };
`
    );
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "storage-flinsh-")), "storage_flinsh.mjs");
fs.writeFileSync(tmp, src);

// ---- Mock browser + store
function mockStore({ total = 2 * 1024 * 1024, keys = 1000, value = 256 * 1024 } = {}) {
    const data = new Map();
    const calls = { get: 0, set: 0, delete: 0, list: 0 };
    const size = v => Buffer.byteLength(JSON.stringify(v));
    const usage = () => [...data].reduce((a, [k, v]) => a + k.length + size(v), 0);
    const tick = () => new Promise(r => setTimeout(r, 2));
    return {
        data,
        calls,
        usage,
        limits: { total, keys, value },
        async get(k) {
            calls.get++;
            await tick();
            return data.has(k) ? JSON.parse(JSON.stringify(data.get(k))) : null;
        },
        async set(k, v) {
            calls.set++;
            await tick();
            if (size(v) > value) throw new Error("413 value too big");
            const prev = data.has(k) ? k.length + size(data.get(k)) : 0;
            if (!data.has(k) && data.size + 1 > keys) throw new Error("413 over quota (keys)");
            if (usage() - prev + k.length + size(v) > total) throw new Error("413 over quota");
            data.set(k, v);
            return true;
        },
        async delete(k) {
            calls.delete++;
            await tick();
            return data.delete(k);
        },
        async list(prefix = "") {
            calls.list++;
            await tick();
            return [...data.keys()].filter(k => k.startsWith(prefix)).sort();
        },
    };
}
const listeners = {};
globalThis.window = { addEventListener: (n, f) => (listeners[n] = f) };
globalThis.document = { addEventListener() {}, visibilityState: "visible" };

const { StorageImplFlinsh } = await import(pathToFileURL(tmp).href);
const lz = n => {
    // Pseudo-random text in the LZ output alphabet, so nothing compresses away
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$";
    let s = "",
        x = n;
    for (let i = 0; i < n; ++i) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        s += alphabet[x % 64];
    }
    return "\u0001" + s;
};
const settle = () => new Promise(r => setTimeout(r, 600));

let failures = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log("ok   ", name);
    } catch (e) {
        failures++;
        console.log("FAIL ", name, "\n     ", e.message);
    }
}

await test("small file round-trips inline", async () => {
    const store = mockStore();
    window.flinsh = { store };
    const s = new StorageImplFlinsh({});
    await s.initialize();
    await s.writeFileAsync("app_settings.bin", "\u0001abc");
    assert.equal(store.data.get("shapez/app_settings.bin"), "\u0001abc");
    assert.equal(await new StorageImplFlinsh({}).readFileAsync("app_settings.bin"), "\u0001abc");
});

await test("missing file rejects with FILE_NOT_FOUND", async () => {
    window.flinsh = { store: mockStore() };
    const s = new StorageImplFlinsh({});
    await s.initialize();
    await assert.rejects(s.readFileAsync("nope.bin"), e => e === "file_not_found");
});

await test("600 KB save is chunked (manifest + 128 KB chunks) and reassembles", async () => {
    const store = mockStore();
    window.flinsh = { store };
    const s = new StorageImplFlinsh({});
    await s.initialize();
    const big = lz(600 * 1024);
    await s.writeFileAsync("savegame-a.bin", big);
    const manifest = store.data.get("shapez/savegame-a.bin");
    assert.equal(manifest.chunked, 1);
    assert.equal(manifest.count, 5);
    for (const [k, v] of store.data) assert.ok(Buffer.byteLength(JSON.stringify(v)) <= 256 * 1024, k);
    assert.equal(await new StorageImplFlinsh({}).readFileAsync("savegame-a.bin"), big);
});

await test("rewrite swaps generation and deletes the old chunks", async () => {
    const store = mockStore();
    window.flinsh = { store };
    const s = new StorageImplFlinsh({});
    await s.initialize();
    await s.writeFileAsync("savegame-a.bin", lz(400 * 1024));
    const gen1 = store.data.get("shapez/savegame-a.bin").gen;
    const second = lz(300 * 1024 + 7);
    await s.writeFileAsync("savegame-a.bin", second);
    const m = store.data.get("shapez/savegame-a.bin");
    assert.notEqual(m.gen, gen1);
    assert.equal([...store.data.keys()].filter(k => k.includes(gen1)).length, 0);
    assert.equal([...store.data.keys()].length, 1 + m.count);
    assert.equal(await new StorageImplFlinsh({}).readFileAsync("savegame-a.bin"), second);
});

await test("shrinking back under the inline limit removes chunks", async () => {
    const store = mockStore();
    window.flinsh = { store };
    const s = new StorageImplFlinsh({});
    await s.initialize();
    await s.writeFileAsync("savegame-a.bin", lz(400 * 1024));
    await s.writeFileAsync("savegame-a.bin", "\u0001small");
    assert.deepEqual([...store.data.keys()], ["shapez/savegame-a.bin"]);
});

await test("rapid writes coalesce; every caller resolves; reads see the newest", async () => {
    const store = mockStore();
    window.flinsh = { store };
    const s = new StorageImplFlinsh({});
    await s.initialize();
    await settle();
    const before = store.calls.set;
    const writes = [];
    for (let i = 0; i < 20; ++i) writes.push(s.writeFileAsync("app_settings.bin", "\u0001v" + i));
    assert.equal(await s.readFileAsync("app_settings.bin"), "\u0001v19"); // pending write visible
    await Promise.all(writes);
    assert.equal(store.calls.set - before, 1, "20 writes -> 1 store.set");
    assert.equal(store.data.get("shapez/app_settings.bin"), "\u0001v19");
});

await test("writes during an in-flight write are sent once afterwards, newest wins", async () => {
    const store = mockStore();
    window.flinsh = { store };
    const s = new StorageImplFlinsh({});
    await s.initialize();
    await settle();
    const p1 = s.writeFileAsync("savegames.bin", "\u0001a");
    await new Promise(r => setTimeout(r, 260)); // debounce elapsed, write in flight
    const p2 = s.writeFileAsync("savegames.bin", "\u0001b");
    const p3 = s.writeFileAsync("savegames.bin", "\u0001c");
    await Promise.all([p1, p2, p3]);
    assert.equal(store.data.get("shapez/savegames.bin"), "\u0001c");
});

await test("delete removes manifest and chunks", async () => {
    const store = mockStore();
    window.flinsh = { store };
    const s = new StorageImplFlinsh({});
    await s.initialize();
    await s.writeFileAsync("savegame-a.bin", lz(300 * 1024));
    await s.deleteFileAsync("savegame-a.bin");
    assert.equal(store.data.size, 0);
    await assert.rejects(s.readFileAsync("savegame-a.bin"), e => e === "file_not_found");
});

await test("startup sweeps chunks no manifest points to", async () => {
    // The sweep runs once per page load (module state), so load a fresh copy
    const { StorageImplFlinsh } = await import(pathToFileURL(tmp).href + "?fresh");
    const store = mockStore();
    store.data.set("shapez/savegame-a.bin/deadgen/0", "x");
    store.data.set("shapez/savegame-a.bin/deadgen/1", "y");
    store.data.set("shapez/other.bin", "z");
    window.flinsh = { store };
    const s = new StorageImplFlinsh({});
    await s.initialize();
    await s.writeFileAsync("savegame-b.bin", lz(10)); // waits for the sweep
    assert.deepEqual([...store.data.keys()].sort(), ["shapez/other.bin", "shapez/savegame-b.bin"]);
});

await test("1.1 MB save near the 2 MB quota: falls back to in-place and still saves", async () => {
    const store = mockStore();
    window.flinsh = { store };
    const s = new StorageImplFlinsh({});
    await s.initialize();
    await s.writeFileAsync("savegame-a.bin", lz(1100 * 1024));
    const next = lz(1150 * 1024);
    await s.writeFileAsync("savegame-a.bin", next); // old+new > 2 MB
    assert.equal(await new StorageImplFlinsh({}).readFileAsync("savegame-a.bin"), next);
    assert.ok(store.usage() <= 2 * 1024 * 1024);
});

await test("a save that can't fit in 2 MB is refused and the old one survives", async () => {
    const store = mockStore();
    window.flinsh = { store };
    const s = new StorageImplFlinsh({});
    await s.initialize();
    const old = lz(500 * 1024);
    await s.writeFileAsync("savegame-a.bin", old);
    await assert.rejects(s.writeFileAsync("savegame-a.bin", lz(2200 * 1024)), /over the 2 MB/);
    assert.equal(await new StorageImplFlinsh({}).readFileAsync("savegame-a.bin"), old);
});

await test("in-place fallback that still fails leaves the file missing, not corrupt", async () => {
    const store = mockStore();
    window.flinsh = { store };
    const s = new StorageImplFlinsh({});
    await s.initialize();
    store.data.set("shapez/other.bin", lz(700 * 1024 - 100)); // another file eats the room
    await s.writeFileAsync("savegame-a.bin", lz(600 * 1024));
    await assert.rejects(s.writeFileAsync("savegame-a.bin", lz(1400 * 1024)), /quota/);
    assert.deepEqual([...store.data.keys()], ["shapez/other.bin"]);
    await assert.rejects(new StorageImplFlinsh({}).readFileAsync("savegame-a.bin"), e => e === "file_not_found");
});

await test("transient (non-quota) errors keep the old save intact", async () => {
    const store = mockStore();
    window.flinsh = { store };
    const s = new StorageImplFlinsh({});
    await s.initialize();
    const old = lz(300 * 1024);
    await s.writeFileAsync("savegame-a.bin", old);
    const realSet = store.set;
    let n = 0;
    store.set = async (k, v) => {
        if (++n === 2) throw new Error("timed out");
        return realSet.call(store, k, v);
    };
    await assert.rejects(s.writeFileAsync("savegame-a.bin", lz(310 * 1024)), /timed out/);
    store.set = realSet;
    assert.equal(await new StorageImplFlinsh({}).readFileAsync("savegame-a.bin"), old);
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
