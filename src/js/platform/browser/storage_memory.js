import { createLogger } from "../../core/logging";
import { FILE_NOT_FOUND, StorageInterface } from "../storage";

const logger = createLogger("storage/memory");

/**
 * Last-resort storage for the Flinsh build when it runs sandboxed without the Flinsh bridge
 * (opened outside Flinsh, or the bridge never arrived): the sandbox blocks IndexedDB and
 * localStorage, so without this the game can't get past the loading screen. Nothing persists.
 */
export class StorageImplMemory extends StorageInterface {
    constructor(app) {
        super(app);
        /** @type {Map<string, string>} */
        this.files = new Map();
    }

    initialize() {
        logger.warn("No persistent storage available: progress is kept in memory only");
        return Promise.resolve();
    }

    writeFileAsync(filename, contents) {
        this.files.set(filename, contents);
        return Promise.resolve();
    }

    readFileAsync(filename) {
        return this.files.has(filename)
            ? Promise.resolve(this.files.get(filename))
            : Promise.reject(FILE_NOT_FOUND);
    }

    deleteFileAsync(filename) {
        this.files.delete(filename);
        return Promise.resolve();
    }
}
