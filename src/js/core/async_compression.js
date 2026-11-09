// @ts-ignore
import CompressionWorker from "../webworkers/compression.worker";

import { createLogger } from "./logging";
import { round2Digits } from "./utils";
import { globalConfig } from "./config";
import { compressX64 } from "./lzstring";
import { computeCrc } from "./sensitive_utils.encrypt";
import { compressObject } from "../savegame/savegame_compressor";

const logger = createLogger("async_compression");

export let compressionPrefix = String.fromCodePoint(1);

function checkCryptPrefix(prefix) {
    if (G_IS_FLINSH) {
        // No localStorage in the sandbox; the store keeps JSON strings, so any prefix works
        return true;
    }
    try {
        window.localStorage.setItem("prefix_test", prefix);
        window.localStorage.removeItem("prefix_test");
        return true;
    } catch (ex) {
        logger.warn("Prefix '" + prefix + "' not available");
        return false;
    }
}

if (!checkCryptPrefix(compressionPrefix)) {
    logger.warn("Switching to basic prefix");
    compressionPrefix = " ";
    if (!checkCryptPrefix(compressionPrefix)) {
        logger.warn("Prefix not available, ls seems to be unavailable");
    }
}

/**
 * @typedef {{
 *   errorHandler: function(any) : void,
 *   resolver: function(any) : void,
 *   startTime: number
 * }} JobEntry
 */

/**
 * Same job as webworkers/compression.worker.js, on the main thread. Used when workers
 * are unavailable: the Flinsh CSP (script-src 'unsafe-inline' only) blocks the blob: URL
 * the inlined worker is started from.
 */
function performJobOnMainThread(job, data) {
    switch (job) {
        case "compressX64": {
            return compressX64(data);
        }
        case "compressObject": {
            const salt = globalConfig.info.file;
            const stringified = JSON.stringify(compressObject(data.obj));
            const checksum = computeCrc(stringified + salt);
            return data.compressionPrefix + compressX64(checksum + stringified);
        }
        default:
            throw new Error("Unknown compression job: " + job);
    }
}

class AsynCompression {
    constructor() {
        /** Set once the worker is known to be unusable */
        this.useMainThread = false;
        this.worker = null;

        this.currentJobId = 1000;

        /** @type {Object.<number, JobEntry & { job: string, data: any }>} */
        this.currentJobs = {};

        // @ts-ignore
        if (G_IS_FLINSH && window.flinsh) {
            // Known to be blocked by the sandbox CSP; don't trigger a CSP violation report
            this.useMainThread = true;
            return;
        }

        try {
            this.worker = new CompressionWorker();
        } catch (ex) {
            logger.warn("Compression worker unavailable, compressing on the main thread:", ex);
            this.useMainThread = true;
            return;
        }

        this.worker.addEventListener("message", event => {
            const { jobId, result } = event.data;
            const jobData = this.currentJobs[jobId];
            if (!jobData) {
                logger.error("Failed to resolve job result, job id", jobId, "is not known");
                return;
            }

            const duration = performance.now() - jobData.startTime;
            logger.log(
                "Got job",
                jobId,
                "response within",
                round2Digits(duration),
                "ms: ",
                result.length,
                "bytes"
            );
            const resolver = jobData.resolver;
            delete this.currentJobs[jobId];
            resolver(result);
        });

        this.worker.addEventListener("error", err => {
            if (G_IS_FLINSH) {
                // e.g. the worker script was refused by a CSP: finish the jobs here instead
                logger.warn("Compression worker failed, switching to the main thread:", err);
                this.useMainThread = true;
                const pending = this.currentJobs;
                this.currentJobs = {};
                for (const jobId in pending) {
                    this.runOnMainThread(pending[jobId]);
                }
                return;
            }
            logger.error("Got error from webworker:", err, "aborting all jobs");
            const failureCalls = [];
            for (const jobId in this.currentJobs) {
                failureCalls.push(this.currentJobs[jobId].errorHandler);
            }
            this.currentJobs = {};
            for (let i = 0; i < failureCalls.length; ++i) {
                failureCalls[i](err);
            }
        });
    }

    /**
     * @param {JobEntry & { job: string, data: any }} entry
     */
    runOnMainThread(entry) {
        // Defer so callers still get an asynchronous result, like with the worker
        setTimeout(() => {
            try {
                const result = performJobOnMainThread(entry.job, entry.data);
                logger.log(
                    "Main-thread",
                    entry.job,
                    "took",
                    round2Digits(performance.now() - entry.startTime),
                    "ms"
                );
                entry.resolver(result);
            } catch (ex) {
                entry.errorHandler(ex);
            }
        }, 0);
    }

    /**
     * Compresses any object
     * @param {any} obj
     */
    compressObjectAsync(obj) {
        logger.log("Compressing object async (optimized)");
        return this.internalQueueJob("compressObject", {
            obj,
            compressionPrefix,
        });
    }

    /**
     * Queues a new job
     * @param {string} job
     * @param {any} data
     * @returns {Promise<any>}
     */
    internalQueueJob(job, data) {
        const jobId = ++this.currentJobId;
        return new Promise((resolve, reject) => {
            const errorHandler = err => {
                logger.error("Failed to compress job", jobId, ":", err);
                reject(err);
            };
            const entry = {
                errorHandler,
                resolver: resolve,
                startTime: performance.now(),
                job,
                data,
            };
            if (this.useMainThread) {
                this.runOnMainThread(entry);
                return;
            }
            this.currentJobs[jobId] = entry;

            logger.log("Posting job", job, "/", jobId);
            this.worker.postMessage({ jobId, job, data });
        });
    }
}

export const asyncCompressor = new AsynCompression();
