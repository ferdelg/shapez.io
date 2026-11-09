import { cachebust } from "../core/cachebust";
import { GameState } from "../core/game_state";
import { signalFlinshReady } from "../core/flinsh";

export class MobileWarningState extends GameState {
    constructor() {
        super("MobileWarningState");
    }

    getInnerHTML() {
        if (G_IS_FLINSH) {
            // No dead Steam link inside the sandbox; say what works and let people try anyway
            return `
            <img class="logo" src="${cachebust("res/logo.png")}" alt="shapez Logo">

            <p>shapez is built for a mouse and keyboard, so it is hard to play on a phone.</p>
            <p>Open this app on a computer to play. Your factory is saved in Flinsh, so it will be waiting there.</p>

            <button class="styledButton flinshPlayAnyway">Try anyway</button>
        `;
        }
        return `

            <img class="logo" src="${cachebust("res/logo.png")}" alt="shapez.io Logo">

            <p>I'm sorry, but shapez.io is not available on mobile devices yet!</p>
            <p>If you have a desktop device, you can get shapez on Steam:</p>


            <a href="https://get.shapez.io/shapez_mobile" class="standaloneLink" target="_blank">Play on Steam!</a>
        `;
    }

    getThemeMusic() {
        return null;
    }

    getHasFadeIn() {
        return false;
    }

    onEnter() {
        if (G_IS_FLINSH) {
            const button = this.htmlElement.querySelector(".flinshPlayAnyway");
            if (button) {
                this.trackClicks(button, () => {
                    // PreloadState keeps the body and expects the index.html loading screen in it
                    document.body.innerHTML = window["__flinshPreloaderHtml"] || "";
                    this.moveToState("PreloadState");
                });
            }
            signalFlinshReady();
            return;
        }
        try {
            if (window.gtag) {
                window.gtag("event", "click", {
                    event_category: "ui",
                    event_label: "mobile_warning",
                });
            }
        } catch (ex) {
            console.warn("Failed to track mobile click:", ex);
        }
    }
    onLeave() {
        // this.dialogs.cleanup();
    }
}
