import { AnalyticsInterface } from "./analytics";
import { GameAnalyticsInterface } from "./game_analytics";

/**
 * Analytics that record nothing and send nothing. Used by the Flinsh build, where
 * the sandbox forbids network requests and there is no consent to track anyway.
 */
export class NoAnalytics extends AnalyticsInterface {
    initialize() {
        return Promise.resolve();
    }
}

export class NoGameAnalytics extends GameAnalyticsInterface {
    initialize() {
        return Promise.resolve();
    }

    note(action) {}

    noteMinor(action, payload = "") {}

    activateDlc(dlc) {
        return Promise.resolve();
    }
}
