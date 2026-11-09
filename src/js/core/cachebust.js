import { getFlinshAsset } from "./flinsh";

/**
 * Generates a cachebuster string. This only modifies the path in the browser version
 * @param {string} path
 */
export function cachebust(path) {
    if (G_IS_FLINSH) {
        // Single-file build: the asset is inlined as a data: URI.
        // Multi-file build: a relative URL next to index.html (no absolute /v/<hash>/ prefix).
        return getFlinshAsset(path) || path;
    }
    if (G_IS_BROWSER && !G_IS_STANDALONE && !G_IS_DEV) {
        return "/v/" + G_BUILD_COMMIT_HASH + "/" + path;
    }
    return path;
}
