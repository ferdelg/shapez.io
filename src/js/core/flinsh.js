/**
 * Flinsh integration helpers.
 *
 * The Flinsh build (variant "web-flinsh", G_IS_FLINSH) runs inside a sandboxed
 * iframe with an opaque origin and a CSP that forbids every network request.
 * Two things make it work there:
 *
 *  - window.flinsh: the bridge Flinsh injects. It carries the key-value store
 *    used for saves (see platform/browser/storage_flinsh.js) and ready().
 *  - window.__FLINSH_ASSETS__: in the single-file build, scripts/build-flinsh.mjs
 *    inlines every resource the game loads as a data: URI (or, for stylesheets,
 *    as plain CSS text) keyed by its relative path ("res/atlas0_hq.png").
 *    In the multi-file build the map is absent and resources are loaded from
 *    relative URLs next to index.html.
 */

/**
 * @typedef {{
 *   get(key: string): Promise<any>,
 *   set(key: string, value: any): Promise<any>,
 *   delete(key: string): Promise<boolean>,
 *   list(prefix?: string): Promise<string[]>,
 * }} FlinshStore
 *
 * @typedef {{
 *   store?: FlinshStore,
 *   ready?: () => void,
 * }} FlinshBridge
 */

/**
 * @returns {FlinshBridge|null} The injected bridge, or null when running standalone
 */
export function getFlinshBridge() {
    if (!G_IS_FLINSH) {
        return null;
    }
    // @ts-ignore
    const bridge = window.flinsh;
    return bridge && typeof bridge === "object" ? bridge : null;
}

/**
 * @returns {boolean} Whether the Flinsh store is reachable
 */
export function hasFlinshStore() {
    const bridge = getFlinshBridge();
    return Boolean(bridge && bridge.store && typeof bridge.store.get === "function");
}

/**
 * @returns {Object<string, string>|null} The inlined asset map (single-file build only)
 */
function getAssetMap() {
    // @ts-ignore
    const map = window.__FLINSH_ASSETS__;
    return map && typeof map === "object" ? map : null;
}

/**
 * @returns {boolean} Whether this is the single-file build, where every asset is inlined
 */
export function isFlinshSingleFile() {
    return G_IS_FLINSH && getAssetMap() !== null;
}

/**
 * Looks up an inlined asset
 * @param {string} path Relative resource path, e.g. "res/atlas0_hq.png"
 * @returns {string|null} A data: URI (or CSS text for .css), or null if not inlined
 */
export function getFlinshAsset(path) {
    const map = getAssetMap();
    if (!map) {
        return null;
    }
    const value = map[path];
    return typeof value === "string" ? value : null;
}

/**
 * Whether an asset can be loaded in this build. In the multi-file build every asset
 * is served next to index.html. In the single-file build only inlined ones exist;
 * anything else would be a blocked request, so callers skip it.
 * @param {string} path
 */
export function isFlinshAssetAvailable(path) {
    if (!G_IS_FLINSH) {
        return true;
    }
    return !isFlinshSingleFile() || getFlinshAsset(path) !== null;
}

let readySent = false;

/**
 * Tells Flinsh the UI is usable. Called once, when the main menu has rendered.
 */
export function signalFlinshReady() {
    if (readySent) {
        return;
    }
    const bridge = getFlinshBridge();
    if (bridge && typeof bridge.ready === "function") {
        readySent = true;
        try {
            bridge.ready();
        } catch (ex) {
            console.warn("flinsh.ready() failed:", ex);
        }
    }
}
