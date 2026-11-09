import { FILE_NOT_FOUND, StorageInterface } from "../storage";
import { createLogger } from "../../core/logging";
import { getFlinshBridge } from "../../core/flinsh";

const logger = createLogger("storage/flinsh");

/**
 * Storage backed by the Flinsh key-value store (window.flinsh.store, user scope).
 *
 * Layout. Every "file" lives under KEY_PREFIX + filename:
 *  - small file: the value is the file contents (a string) itself
 *  - large file: the value is a manifest
 *        { chunked: 1, gen: "<id>", count: n, length: total }
 *    and the contents are split over KEY_PREFIX + filename + "/" + gen + "/" + i
 *
 * Store values are capped at 256 KB of JSON. Savegames are LZ-compressed into a
 * 64-character alphabet (1 byte per char) so a chunk of CHUNK_SIZE chars stays well
 * below the cap even with JSON quoting.
 *
 * Crash safety. A chunked write puts the new chunks under a fresh generation id
 * first, then swaps the manifest, then deletes the previous generation. If the page
 * dies halfway, the old manifest still points at complete old chunks; leftover
 * chunks of an unfinished generation are swept on the next start.
 *
 * Coalescing. shapez writes the same file in bursts (settings sliders, autosave
 * right after a manual save). Writes to one file are debounced and serialized:
 * only the newest contents get sent, and every caller's promise resolves once
 * contents at least as new as theirs are stored. Reads see pending writes.
 */

const KEY_PREFIX = "shapez/";

/** Values up to this many chars are stored inline (well under the 256 KB value cap) */
const INLINE_LIMIT = 192 * 1024;

/** Chunk size in chars for large files */
const CHUNK_SIZE = 128 * 1024;

/**
 * The user scope holds 2 MB per person. A file this large can never be stored (the other keys
 * need room too), so it is refused before anything existing is touched.
 */
const MAX_FILE_SIZE = 2 * 1024 * 1024 - 64 * 1024;

/** How long to wait for more writes to the same file before sending */
const WRITE_DEBOUNCE_MS = 250;

/**
 * @typedef {{ chunked: 1, gen: string, count: number, length: number }} ChunkManifest
 *
 * @typedef {{
 *   contents: string|null,
 *   deleted: boolean,
 *   waiters: { resolve: () => void, reject: (err: any) => void }[],
 * }} PendingOp
 *
 * @typedef {{
 *   pending: PendingOp|null,
 *   inFlight: Promise<void>|null,
 *   latest: { contents: string|null, deleted: boolean }|null,
 *   timer: any,
 * }} FileState
 */

/**
 * Shared between all instances, so two StorageImplFlinsh objects can't race each other
 * on the same key.
 * @type {Map<string, FileState>}
 */
const fileStates = new Map();

let sweepPromise = null;

/**
 * @param {string} filename
 */
function fileKey(filename) {
    // Store keys allow letters, digits, . _ - / and spaces. shapez filenames
    // ("savegame-<uuid>.bin", "app_settings.bin") already fit; map anything else to "_".
    return KEY_PREFIX + String(filename).replace(/[^A-Za-z0-9._\- ]/g, "_");
}

/**
 * @param {any} value
 * @returns {value is ChunkManifest}
 */
function isManifest(value) {
    return Boolean(
        value && typeof value === "object" && value.chunked === 1 && typeof value.gen === "string"
    );
}

/**
 * @param {string} key
 * @param {ChunkManifest} manifest
 */
function chunkKeys(key, manifest) {
    const keys = [];
    for (let i = 0; i < manifest.count; ++i) {
        keys.push(key + "/" + manifest.gen + "/" + i);
    }
    return keys;
}

function newGeneration() {
    return Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

export class StorageImplFlinsh extends StorageInterface {
    constructor(app) {
        super(app);
        const bridge = getFlinshBridge();
        this.store = bridge && bridge.store;

        this.onPageHide = () => this.flushAll();
    }

    initialize() {
        if (!this.store) {
            return Promise.reject("Flinsh store is not available");
        }
        logger.log("Using the Flinsh store (user scope)");

        // Send debounced writes right away when the page is going away
        window.addEventListener("pagehide", this.onPageHide);
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "hidden") {
                this.flushAll();
            }
        });

        // Clean up chunks from interrupted writes. Not awaited: it doesn't affect reads.
        if (!sweepPromise) {
            sweepPromise = this.sweepOrphanChunks().catch(err =>
                logger.warn("Could not sweep orphaned chunks:", err)
            );
        }
        return Promise.resolve();
    }

    /**
     * @param {string} filename
     * @returns {FileState}
     */
    getState(filename) {
        let state = fileStates.get(filename);
        if (!state) {
            state = { pending: null, inFlight: null, latest: null, timer: null };
            fileStates.set(filename, state);
        }
        return state;
    }

    /**
     * @param {string} filename
     * @param {string} contents
     * @returns {Promise<void>}
     */
    writeFileAsync(filename, contents) {
        return this.queueOp(filename, String(contents), false);
    }

    /**
     * @param {string} filename
     * @returns {Promise<void>}
     */
    deleteFileAsync(filename) {
        return this.queueOp(filename, null, true);
    }

    /**
     * @param {string} filename
     * @returns {Promise<string>}
     */
    readFileAsync(filename) {
        const state = fileStates.get(filename);
        if (state && state.latest) {
            // Read-your-writes: a write may still be debounced or in flight
            return state.latest.deleted
                ? Promise.reject(FILE_NOT_FOUND)
                : Promise.resolve(state.latest.contents);
        }
        return this.readFromStore(filename);
    }

    // ---- Write queue

    /**
     * @param {string} filename
     * @param {string|null} contents
     * @param {boolean} deleted
     * @returns {Promise<void>}
     */
    queueOp(filename, contents, deleted) {
        const state = this.getState(filename);
        state.latest = { contents, deleted };

        return new Promise((resolve, reject) => {
            if (state.pending) {
                // Coalesce: the newer contents replace the queued ones; everyone waits for them
                state.pending.contents = contents;
                state.pending.deleted = deleted;
                state.pending.waiters.push({ resolve, reject });
            } else {
                state.pending = { contents, deleted, waiters: [{ resolve, reject }] };
            }
            this.scheduleFlush(filename, state);
        });
    }

    /**
     * @param {string} filename
     * @param {FileState} state
     */
    scheduleFlush(filename, state) {
        if (state.timer) {
            clearTimeout(state.timer);
        }
        state.timer = setTimeout(() => {
            state.timer = null;
            this.flush(filename, state);
        }, WRITE_DEBOUNCE_MS);
    }

    flushAll() {
        fileStates.forEach((state, filename) => {
            if (state.timer) {
                clearTimeout(state.timer);
                state.timer = null;
                this.flush(filename, state);
            }
        });
    }

    /**
     * @param {string} filename
     * @param {FileState} state
     */
    flush(filename, state) {
        if (state.inFlight || !state.pending) {
            // Runs again when the current write finishes
            return;
        }
        const op = state.pending;
        state.pending = null;

        const promise = op.deleted
            ? this.deleteFromStore(filename)
            : this.writeToStore(filename, op.contents);

        state.inFlight = promise.then(
            () => {
                op.waiters.forEach(w => w.resolve());
            },
            err => {
                logger.error("Failed to", op.deleted ? "delete" : "write", filename, ":", err);
                op.waiters.forEach(w => w.reject(err));
            }
        );
        state.inFlight.then(() => {
            state.inFlight = null;
            if (state.pending) {
                this.flush(filename, state);
            } else {
                // Everything is stored; reads can go to the store again
                state.latest = null;
            }
        });
    }

    // ---- Store access

    /**
     * @param {string} filename
     * @returns {Promise<string>}
     */
    async readFromStore(filename) {
        const key = fileKey(filename);
        const value = await this.store.get(key);
        if (value === null || value === undefined) {
            throw FILE_NOT_FOUND;
        }
        if (typeof value === "string") {
            return value;
        }
        if (!isManifest(value)) {
            throw new Error("Unexpected value stored for " + filename);
        }
        const parts = await Promise.all(chunkKeys(key, value).map(k => this.store.get(k)));
        for (let i = 0; i < parts.length; ++i) {
            if (typeof parts[i] !== "string") {
                throw new Error("Missing chunk " + i + "/" + value.count + " of " + filename);
            }
        }
        const contents = parts.join("");
        if (contents.length !== value.length) {
            throw new Error(
                "Corrupt " + filename + ": expected " + value.length + " chars, got " + contents.length
            );
        }
        return contents;
    }

    /**
     * @param {string} filename
     * @param {string} contents
     */
    async writeToStore(filename, contents) {
        // Never race the startup sweep: it could take a new generation for an orphan
        await sweepPromise;
        if (contents.length > MAX_FILE_SIZE) {
            const mb = (contents.length / 1024 / 1024).toFixed(2);
            throw new Error("it is " + mb + " MB, over the 2 MB the Flinsh store keeps per person");
        }
        const key = fileKey(filename);
        const previous = await this.store.get(key).catch(() => null);
        const oldChunks = isManifest(previous) ? chunkKeys(key, previous) : [];

        if (contents.length <= INLINE_LIMIT) {
            await this.store.set(key, contents);
        } else {
            const gen = newGeneration();
            const count = Math.ceil(contents.length / CHUNK_SIZE);
            /** @type {ChunkManifest} */
            const manifest = { chunked: 1, gen, count, length: contents.length };
            const parts = [];
            for (let i = 0; i < count; ++i) {
                parts.push(contents.substr(i * CHUNK_SIZE, CHUNK_SIZE));
            }
            const newKeys = chunkKeys(key, manifest);
            try {
                await Promise.all(newKeys.map((k, i) => this.store.set(k, parts[i])));
            } catch (err) {
                // Drop the partial new copy; the manifest still points at the old one.
                if (
                    !/quota|413|too big|too large|limit/i.test(String(err && err.message ? err.message : err))
                ) {
                    await Promise.all(newKeys.map(k => this.store.delete(k).catch(() => false)));
                    throw err;
                }
                // The 2 MB quota: old and new copy don't both fit. Drop the old one too and
                // write in place. Not crash-safe, but the alternative is not saving at all.
                logger.warn("Double-buffered write of", filename, "failed, retrying in place:", err);
                await Promise.all(newKeys.map(k => this.store.delete(k).catch(() => false)));
                // Manifest first, so the file reads as missing rather than corrupt if this fails
                await this.store.delete(key).catch(() => false);
                await Promise.all(oldChunks.map(k => this.store.delete(k).catch(() => false)));
                oldChunks.length = 0;
                try {
                    await Promise.all(newKeys.map((k, i) => this.store.set(k, parts[i])));
                } catch (err2) {
                    await Promise.all(newKeys.map(k => this.store.delete(k).catch(() => false)));
                    throw err2;
                }
            }
            await this.store.set(key, manifest);
        }

        logger.log("Stored", filename, "(" + contents.length + " chars)");

        // The manifest no longer points at the previous generation
        await Promise.all(oldChunks.map(k => this.store.delete(k).catch(() => false)));
    }

    /**
     * @param {string} filename
     */
    async deleteFromStore(filename) {
        await sweepPromise;
        const key = fileKey(filename);
        const previous = await this.store.get(key).catch(() => null);
        if (isManifest(previous)) {
            // Manifest first, so a half-finished delete never leaves a manifest without chunks
            await this.store.delete(key);
            await Promise.all(chunkKeys(key, previous).map(k => this.store.delete(k).catch(() => false)));
        } else {
            await this.store.delete(key);
        }
    }

    /**
     * Deletes chunk keys no manifest points to (left behind by an interrupted write).
     */
    async sweepOrphanChunks() {
        const keys = await this.store.list(KEY_PREFIX);
        /** @type {Map<string, string[]>} chunk keys by their file key */
        const chunksByFile = new Map();
        for (const k of keys) {
            const match = /^(.*)\/[^/]+\/\d+$/.exec(k);
            if (match && match[1].startsWith(KEY_PREFIX)) {
                const list = chunksByFile.get(match[1]) || [];
                list.push(k);
                chunksByFile.set(match[1], list);
            }
        }
        for (const [key, chunks] of chunksByFile) {
            const filename = key.substr(KEY_PREFIX.length);
            // Writes wait for this sweep to finish, so no chunk here belongs to a write in progress
            const manifest = await this.store.get(key);
            const live = new Set(isManifest(manifest) ? chunkKeys(key, manifest) : []);
            const orphans = chunks.filter(k => !live.has(k));
            if (orphans.length > 0) {
                logger.log("Removing", orphans.length, "orphaned chunks of", filename);
                await Promise.all(orphans.map(k => this.store.delete(k).catch(() => false)));
            }
        }
    }
}
