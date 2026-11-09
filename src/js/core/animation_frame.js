import { Signal } from "./signal";

// @ts-ignore
import BackgroundAnimationFrameEmitterWorker from "../webworkers/background_animation_frame_emittter.worker";

import { createLogger } from "./logging";
const logger = createLogger("animation_frame");

const maxDtMs = 1000;
const resetDtMs = 16;

export class AnimationFrame {
    constructor() {
        this.frameEmitted = new Signal();
        this.bgFrameEmitted = new Signal();

        this.lastTime = performance.now();
        this.bgLastTime = performance.now();

        this.boundMethod = this.handleAnimationFrame.bind(this);

        this.backgroundWorker = null;
        this.backgroundInterval = null;

        // @ts-ignore
        if (G_IS_FLINSH && window.flinsh) {
            // The sandbox CSP blocks the blob: worker; tick from the main thread instead.
            // Browsers throttle this while the tab is hidden, so the factory runs slower then.
            this.startMainThreadBackgroundTicks();
            return;
        }

        try {
            this.backgroundWorker = new BackgroundAnimationFrameEmitterWorker();
        } catch (ex) {
            logger.warn("Background fps worker unavailable, using a timer:", ex);
            this.startMainThreadBackgroundTicks();
            return;
        }
        this.backgroundWorker.addEventListener("error", err => {
            logger.error("Error in background fps worker:", err);
            if (G_IS_FLINSH) {
                this.startMainThreadBackgroundTicks();
            }
        });
        this.backgroundWorker.addEventListener("message", this.handleBackgroundTick.bind(this));
    }

    startMainThreadBackgroundTicks() {
        if (this.backgroundInterval === null) {
            this.backgroundInterval = setInterval(() => this.handleBackgroundTick(), 1000 / 30);
        }
    }

    handleBackgroundTick() {
        const time = performance.now();

        let dt = time - this.bgLastTime;

        if (dt > maxDtMs) {
            dt = resetDtMs;
        }

        this.bgFrameEmitted.dispatch(dt);
        this.bgLastTime = time;
    }

    start() {
        assertAlways(window.requestAnimationFrame, "requestAnimationFrame is not supported!");
        this.handleAnimationFrame();
    }

    handleAnimationFrame(time) {
        let dt = time - this.lastTime;

        if (dt > maxDtMs) {
            dt = resetDtMs;
        }

        try {
            this.frameEmitted.dispatch(dt);
        } catch (ex) {
            console.error(ex);
        }
        this.lastTime = time;
        window.requestAnimationFrame(this.boundMethod);
    }
}
