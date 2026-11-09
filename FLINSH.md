# shapez on Flinsh: build notes and packaging report

This fork packages the free web version of shapez (upstream
[tobspr-games/shapez.io](https://github.com/tobspr-games/shapez.io), GPL-3.0) as a Flinsh `app`.
It is the largest app tried on Flinsh so far, so this also answers whether a single HTML file is the
right way to ship something this size.

**Short answer:** it works today as one 7.1 MB file (`dist-flinsh-single/index.html`, the manifest's
entrypoint), but only by leaving out the music and the tutorial animations, and it takes
44 s to reach the menu on Fast 3G because the whole file has to arrive first. The same
game as a built directory reaches the menu in 22 s and has everything. **Flinsh should
serve built directories for apps like this.** The single-file build is a stopgap that works under
the current platform.

## Build

```
yarn                  # root deps (Node 16, ffmpeg and Java on PATH, as upstream's README says)
cd gulp && yarn && cd ..
yarn build:flinsh     # gulp build.web-flinsh, then scripts/build-flinsh.mjs
```

- `gulp build.web-flinsh` is a new build variant (`gulp/build_variants.js`): the free web build
  plus a compile-time flag `G_IS_FLINSH`. All Flinsh behaviour hangs off that flag, so the other
  variants (web, Steam, etc.) compile exactly as before. Note: a prod build needs
  `src/js/core/config.local.js`; run `yarn gulp localConfig.findOrCreate` once (the dev task does
  this for you; the prod tasks don't).
- `scripts/build-flinsh.mjs` packages `build/` two ways:
  - `dist-flinsh-single/index.html`: everything inlined, runs on Flinsh today. The manifest's entrypoint.
  - `dist-flinsh/`: `index.html` + `bundle.js` + `main.css` + `res/…` with relative URLs.
  - `--full-single` also writes `index.full.html` with music and GIFs inlined, for measurement only
    (not committed).

Test: `yarn serve:flinsh`, then open `http://localhost:8130/test/flinsh-harness.html`
(`?mode=single|multi|full`, `&phone=1`, `&wipe=1`, `&late=150`). The harness composes the frame
exactly like Flinsh's `buildMiniAppDocument` (a copy of the bridge from
`web/src/lib/miniAppSandbox.ts` is in `test/flinsh-sandbox.js`) and mocks the store with the documented
limits. `test/flinsh-e2e.mjs` drives it in Chrome with Playwright.

## What was stripped, and how

Nothing was deleted. Each item is turned off at compile time by `G_IS_FLINSH`, or replaced by a
no-op implementation of the existing platform interface. Terser then drops the dead branches.

| What | Where | How |
|---|---|---|
| Game analytics (`analytics.shapez.io` campaign pings, A/B variant, time points, player key) | `platform/browser/game_analytics.js` | `application.js` uses the new `NoGameAnalytics` (`platform/no_analytics.js`). `ShapezGameAnalytics` is no longer in the bundle. |
| Google Analytics (`gtag`) | `platform/browser/google_analytics.js` | Replaced by `NoAnalytics`. The HTML never loaded gtag anyway (`googleAnalytics && false`). |
| Player-count poll (`analytics.shapez.io/v1/player-count`, every 10 s) | `states/main_menu.js` | Returns early, and the interval is not started. |
| Steam discount fetch (`analytics.shapez.io/v1/discounts`) | `states/preload.js` | Returns early. |
| Campaign / embed beacons | `states/preload.js` | Returns early. |
| Ads (adinplay, gamedistribution, crazygames) and the adblock probe (`googleads.g.doubleclick.net`) | `platform/browser/wrapper.js` | New `flinsh` embed provider: `NoAdProvider`, and `initializeAdProvider()` returns before the probe. |
| Steam SSO (`api.shapez.io/v1/sso/refresh`, localStorage token, sign-in link) | `core/steam_sso.js`, `states/main_menu.js` | SSO returns immediately. The "Sign in with Steam" block is hidden. |
| Puzzle API (`api.shapez.io`) | `platform/api.js` | `_request()` rejects with `"offline"` before any `fetch`. Puzzle mode was already hidden on web (it needs SSO). |
| Tutorial videos (`static.shapez.io/tutorial_videos/*.webm`) | `game/modes/regular.js` | The `tutorialHints` HUD part is not added. The interactive tutorial (text plus GIFs) stays. |
| External links (Discord, Steam, Reddit, the shapez 2/puzzlez banners, "Play on Steam" upsell) | `wrapper.js`, `restriction_manager.js` | `embedProvider.externalLinks = false` hides the menu links and banners. `openExternalLink` logs instead of calling `window.open`, which the sandbox blocks anyway (no `allow-popups`). The demo's "Buy on Steam" upsell HUD is off, because its button would do nothing. |
| Preloader (bundle downloaded by XHR, Steam-version link) | `gulp/preloader/preloader.js` | Not used. `scripts/build-flinsh.mjs` inlines or links the bundle directly and keeps the loading screen. |
| Favicon, canonical and og: links | `src/html/index.html` | Not used. The Flinsh `index.html` is generated without them. |
| Fonts / CDN | | None were external. GameFont is inlined as a `data:` URI (single file) or served next to the page (directory). |

Other things the sandbox breaks, fixed the same way:

- **Web workers.** Savegame compression and the background tick each run in an inline `blob:`
  worker. `script-src 'unsafe-inline'` doesn't cover `blob:`, so both are refused. Compression
  falls back to the main thread (`core/async_compression.js`; a fresh save takes under 1 ms, a big
  one tens of ms). The background tick falls back to `setInterval`, which browsers throttle in
  hidden tabs, so the factory simulates slower while the tab is in the background
  (`core/animation_frame.js`).
- **Ajv.** Save validation compiles JSON schemas with `new Function()`, and there is no
  `'unsafe-eval'`. This broke saving outright: "SCHEMA FOR 1010 IS INVALID", and the game never
  left the pause menu. Every schema in `savegame/schemas/*.json` is just
  `{type: "object", required: [], additionalProperties: true}`, so the Flinsh build checks exactly
  that by hand, and refuses loudly if a future schema needs more (`savegame/savegame_interface.js`).
- **localStorage.** Probes for it in the preload state and the compression module throw
  `SecurityError` in an opaque origin. They are skipped.
- **Stylesheets.** In-game CSS was loaded as an XHR `blob:` `<link>`, which `style-src` refuses.
  It is now injected as a `<style>` (`core/background_resources_loader.js`).
- **Assets.** `cachebust()` and `preloadWithProgress()` resolve paths through
  `window.__FLINSH_ASSETS__` (single file) or as relative URLs (directory), instead of
  `/v/<hash>/…`.

### Grep of the built output

No http(s) URL is requested at runtime. In the e2e runs, the only requests the app made were to
the harness server (directory build) or none at all (single file), and no CSP violation was
reported. URL strings left in `bundle.js`, none of them fetched:

- Link targets that `openExternalLink` no longer opens: `discord.gg/HN7EVzV`,
  `discord.com/invite/HN7EVzV`, `github.com/tobspr-games/shapez.io`, `reddit.com/r/shapezio`,
  `twitter.com/tobspr`, `patreon.com/tobsprgames`, `shapez.mod.io(/)`, `viewer.shapez.io`,
  `tobspr.io`, `tobspr.io/privacy.html`, `tobspr.io/shapez-2?…` (×2 variants),
  `get.shapez.io/bundle/`, `get.shapez.io/mm_puzzle_dlc?…`,
  `store.steampowered.com/app/4783760/…` (puzzlez), 3 YouTube videos (`config.js`).
- Changelog text: `steam.shapez.io` ×3, `shapez.io/wires/`, `store.steampowered.com/…` ×4,
  `soundcloud.com/pettersumelius`, `github.com/tobspr/shapez.io/tree/master/translations`,
  `youtube.com/watch?v=KyorY1uIqiQ`.
- Inside an `<a href>` in the resource-error dialog: `get.shapez.io/resource_timeout`.
- Unreachable code: `googleads.g.doubleclick.net/pagead/id` (`detectAdblock()`, whose only caller
  returns first), `api.shapez.io` and `api-staging.shapez.io` (`getEndpoint()` strings; `_request()`
  rejects first).
- Library identifiers: ajv's `json-schema.org/schema`, `json-schema.org/draft-07/schema`,
  `raw.githubusercontent.com/epoberezkin/ajv/…/data.json#`, a `github.com/epoberezkin/ajv/…` comment,
  `github.com/crypto-browserify/crypto-browserify` (an error message).
- CSS: `http://www.w3.org/2000/svg` (SVG namespace inside inlined images, 39×).

## Saves: `platform/browser/storage_flinsh.js`

Same interface as `storage.js` / `storage_indexed_db.js` (`initialize`, `writeFileAsync`,
`readFileAsync`, `deleteFileAsync`), backed by `window.flinsh.store`, user scope. The browser
wrapper picks it when `window.flinsh.store` exists. Without the bridge, it still detects IndexedDB
or localStorage as before. If neither works (the Flinsh build opened sandboxed with no bridge),
`storage_memory.js` keeps files in memory, so the game still runs, but nothing is saved.

- Each shapez "file" (`app_settings.bin`, `savegames.bin`, `savegame-<id>.bin`, …) is one key
  under `shapez/`. Values are the LZ-compressed strings shapez already produces (a 64-character
  alphabet, so 1 byte per char).
- Up to 192 KB, the string is stored as-is. Above that, the value becomes a manifest
  `{chunked: 1, gen, count, length}`, and the data goes in 128 KB chunk keys
  `shapez/<file>/<gen>/<i>`.
- Writes are crash-safe: new chunks go under a fresh generation, then the manifest is swapped,
  then the old generation is deleted. Chunks left by an interrupted write are swept at startup.
  Writes wait for that sweep. If old and new copies together exceed the 2 MB quota, and only on a
  quota/size error, it falls back to deleting the old copy first. That path is not crash-safe;
  it is logged.
- Coalescing: writes to one file are debounced by 250 ms and serialized. Only the newest contents
  are sent, and every caller's promise resolves when contents at least that new are stored. Reads
  see pending writes. `pagehide` and hidden visibility flush right away.

## Packaging: single file vs. directory

### The standard web build (`gulp build.web-shapezio`), for reference

49 MB in 51 files:

| | Size |
|---|---|
| `bundle.js` | 2.33 MB |
| `main.css` (UI sprites already inlined) | 0.52 MB |
| `async-resources.css` (in-game sprites, inlined) | 2.03 MB |
| Atlases `atlas0_hq/mq/lq.png` (all three load) | 0.43 + 0.21 + 0.10 = 0.74 MB |
| Sound effects `sfx.mp3` (one sprite) | 0.28 MB |
| Music: `theme-full` 14.9, `puzzle-full` 7.2, `theme-short` 7.0, `menu` 0.57 | 29.7 MB |
| Interactive tutorial GIFs (+ an identical-size `.cn` set) | 7.25 MB (+ 7.27 MB) |
| Menu background video `bg_render.webm` | 0.86 MB |
| GameFont, logos, banners | ~0.4 MB |

The web game only ever loads `theme-short` (19 minutes, already 48 kbps mono, so re-encoding
doesn't buy much). `theme-full`, `menu` and `puzzle-full` are Steam-only, and the `.cn` GIFs are
WeGame-only. All four are dropped from both Flinsh builds.

### The Flinsh builds

| Build | What's in it | Size | gzip -9 |
|---|---|---|---|
| `dist-flinsh-single/index.html` (**entrypoint**) | Everything except music and tutorial GIFs | **7.11 MB** | 4.6 MB |
| `index.full.html` (measurement only, not committed) | Everything, inlined | 25.2 MB | 18.8 MB |
| `dist-flinsh/` (directory, 25 files) | Everything | 20.1 MB total. 3.0 MB before the menu, the rest on demand. | bundle 2.3 → 1.06 MB |

Base64 adds a third to every binary asset, and gzip wins almost none of it back on PNG/MP3/GIF.
The single file can't compress well, and it can't stream either: nothing renders until the last
byte of the srcdoc has arrived.

### Load times

Chrome 142 (headless), the harness composing the frame exactly like Flinsh, on Chrome's "Fast 3G"
profile: 562.5 ms latency per request and a 1.47 Mbit/s downlink. I applied the throttle at the
test server rather than in DevTools, because the sandboxed iframe can run in its own process, out
of reach of page-level throttling. My first DevTools-throttled run of the directory build reported
2.7 s, which was clearly unthrottled. No compression is applied in either case.

| | Time to menu (`flinsh.ready()`) | Menu → playable after "Play" | Reopen |
|---|---|---|---|
| Single file, 7.1 MB | **43.6 s** (41.3 s of it is the download) | ~2 s (assets already in memory) | 43.0 s: the whole file again |
| Directory | **21.6 s** | ~26 s (2 MB in-game CSS + atlases, competing with the music stream) | 22.0 s with `no-store`. Near-instant with HTTP caching. |
| Single file with everything, 25.2 MB | **153.9 s** | — | — |

Unthrottled, from localhost: 2.4–5.4 s to the menu for the single file (one outlier run at 10.8 s)
and 3.3–4.7 s for the directory.

Estimated with gzip on the wire (not measured): ~26 s for the single file, ~12 s for the directory
menu.

**Verdict:** the single file is under the ~15 MB line, but on Fast 3G it "loads badly": three
quarters of a minute of a blank card on every open, with no caching or progress. Its only fit is
leaving content out: no music and no tutorial animations. Shipping the full game as one file is
25 MB and 2.5 minutes. So I also produced the directory build, and recommend Flinsh learn to serve
it.

### Why the single file is still the entrypoint

Today Flinsh puts the entrypoint's HTML into `srcdoc` (`buildMiniAppDocument`). A directory build
cannot run that way. Relative URLs resolve against the Flinsh page, and the CSP allows nothing
but `data:`/`blob:`. The single file is the only build that runs on Flinsh now, so `flinsh.json`
points at `dist-flinsh-single/index.html`. When Flinsh can serve a directory, switch the
entrypoint to `dist-flinsh/index.html`; it is committed and tested (below) so the platform work has
a target.

## What Flinsh needs to serve this

A built directory, served as files rather than inlined:

1. **Serve the repo's entrypoint directory from one origin, with relative URLs working.** E.g. the
   frame's `src` is `https://<app-id>.apps.flinsh-usercontent.example/<commit>/dist-flinsh/index.html`,
   not `srcdoc`, so `bundle.js`, `main.css` and `res/…` resolve next to it. Use a separate
   registrable domain for user content (never the Flinsh origin), and ideally one subdomain per
   app, so `'self'` means "this app" and nothing else.
2. **Keep the sandbox.** Same `sandbox="allow-scripts"` and no `allow-same-origin`, so the
   document still gets an opaque origin: no cookies, no storage, no parent access.
3. **The same CSP, with `'self'` added for fetching the app's own files**, sent as an HTTP header
   (tested in `test/flinsh-serve.mjs`):
   ```
   default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
   img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:;
   connect-src 'self'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'
   ```
   `connect-src 'self'` is needed because the game XHRs its atlases, in-game CSS and sound sprite.
   If apps share an origin, scope `'self'` down to the app's path
   (`https://host/<app-id>/<commit>/`), or an app could read another app's files. In Chrome, `'self'`
   in a sandboxed frame matches the URL's origin, which is what the test relied on.
4. **CORS on those files** (`Access-Control-Allow-Origin: *`). The opaque origin makes every XHR
   and font load cross-origin, even to the server the page came from. Without it, the atlases and
   GameFont fail to load. Fine to allow, since the files are public build output.
5. **Cache them.** Commit-pinned URLs make the files immutable
   (`Cache-Control: public, max-age=31536000, immutable`), so a second open is near-instant.
   Serve them compressed (brotli/gzip): the bundle and CSS shrink by half.
6. **Inject the bridge the same way, after the doctype.** Insert the bridge `<script>` as the
   first child of `<head>`, before any app script, and keep `<!DOCTYPE html>` first. (The
   single-file path gets away with putting the CSP `<meta>` before the doctype only because srcdoc
   documents are exempt from quirks mode. A served page would render in quirks mode.) Same
   `flinsh:ready` event, same postMessage protocol, same frame-identity check in the parent.
7. **Recommended: `worker-src blob:`.** Today shapez compresses saves on the main thread, because
   the CSP refuses its inline `blob:` workers. That is invisible for a normal base (under 0.2 s at
   10k buildings), but a big base freezes the game for 1.5–1.8 s on every autosave (see Saves
   below). Allowing blob workers removes that freeze, and it adds no network reach.

With that, `dist-flinsh/` runs as-is: `test/flinsh-harness.html?mode=multi` does exactly this
(server-side CSP header, injected bridge, opaque-origin frame), and the e2e flow passes.

Packaging note for the platform: committing build output costs repo size (this commit adds ~27 MB,
and every rebuild that changes the bundle adds ~2–9 MB more to history). Longer term, Flinsh could
build from source or take a release artifact instead.

## Verification in a Flinsh-shaped harness

`test/flinsh-harness.html` builds the frame the way Flinsh does. It uses `test/flinsh-sandbox.js`,
a line-for-line JS copy of `miniAppSandbox.ts`: `sandbox="allow-scripts"`, the strict CSP meta,
the bridge script, then the app HTML, all in `srcdoc`. Behind it sits a mock store that enforces
the documented limits (256 KB per value, 2 MB and 1,000 keys per user, the key format). The mock
store persists in the harness page's own localStorage, so a reload sees the same data. To run it:
`yarn serve:flinsh`, then open `http://localhost:8130/test/flinsh-harness.html?mode=single`
(also `mode=multi`, `phone=1`, `late=<ms>`, `nobridge=1`, `wipe=1`).

`test/flinsh-e2e.mjs` drives it in Chrome. A fresh store, the menu, Play, 21 belts and 2
extractors placed by mouse drags, then the pause menu, then back to the menu, which saves. Next it
throws away the whole browser context, opens a new one with the same store contents, presses
Continue, and compares the counts from the statistics panel.

Final build, both packagings:

| | Menu | Placed | After reload | CSP violations | Errors | External requests |
|---|---|---|---|---|---|---|
| single | 2.6 s | 21 belts, 2 buildings | 21 belts, 2 buildings | 0 | 0 | 0 |
| directory | 2.3 s | 21 belts, 2 buildings | 21 belts, 2 buildings | 0 | 0 | 0 |

Also checked:
- **Bridge timing.** A bridge that arrives 150 ms after the script is parsed boots on
  `flinsh:ready` and uses the store. With no bridge, or one that arrives after the 400 ms fallback,
  the game starts standalone. The sandbox blocks IndexedDB and localStorage, so it runs on memory
  storage: it reaches the menu and plays, but doesn't save. Before I added the memory fallback,
  this case hung on the loading screen. A bridge that arrives after the fallback is ignored. If
  Flinsh can be that late, the 400 ms timeout should be longer.
- **Opaque origin.** Inside the frame, `localStorage` throws `SecurityError`, and so does
  `indexedDB.open`.
- **Saving through autosave.** Autosave also reaches the store, roughly every 50–60 s in play.
- **Big saves end to end.** Bases of 25k, 50k and 100k buildings were loaded in the harness, saved
  by the game, chunked, reloaded and restored. A 160k-building base was refused cleanly (see
  Saves below).
- **Storage logic.** `node test/storage_flinsh.test.mjs` runs 13 unit tests: chunking,
  generation swap, shrink, coalescing, writes during an in-flight write, delete, orphan sweep,
  the quota fallback, refusal over 2 MB, failure cleanup, and transient errors. All pass.

### Console messages, classified

None are errors from this port. Every run had zero CSP violations and zero uncaught errors.

| Message | Class |
|---|---|
| `input_distributor: Popping reciever state-InGameState which is not on top of the stack` | Upstream warning. The same thing happens on shapez.io when you leave the game from the pause menu. Harmless. |
| `belt: Restored N belt paths` / `Recomputing belt paths` | Upstream info, logged as a warning, on every load. |
| `HTML5 Audio pool exhausted` | Howler warning: the music is one `data:` URI played through an `<audio>` element. Harmless. |
| `The AudioContext was not allowed to start` | Chrome autoplay policy before the first click. Sound starts on the first interaction, same as on the web. |
| `sound: Sound ui_click not found, probably not loaded yet` | Phone only: the "Try anyway" button clicks before sounds have loaded. Harmless. |
| `Error while opening indexed db: SecurityError` | Only with no bridge: storage detection, expected in the sandbox. It then falls back to memory. |
| `Progress not computable` (directory build) | Fixed: the server must send `Content-Length` for the loading bar. Point 5 above covers it. |

## Saves: how big they get

shapez saves are LZ-compressed JSON, and the store holds them as strings.

| | Save file | Everything shapez stores |
|---|---|---|
| Fresh game | 1.9 KB | 3.2 KB in 3 keys (`app_settings` 0.9 KB, `savegames` index 0.3 KB) |
| The e2e base (21 belts, 2 extractors) | ~2 KB | ~3.3 KB |
| ~490 belts placed by script | 8.9 KB | |

A real 30-minute session was too unreliable to script with mouse automation. I tried it, and
zooming, panning and the map overview kept derailing the bot. So I built larger bases with
`test/flinsh-make-save.mjs`. It decodes a real save with the game's own LZ and key-compression
code, fills it with a belt-heavy mix of buildings, re-encodes and checksums it, then lets the game
load and save it again. The sizes below are what the game itself wrote.

| Buildings | Save the game wrote | Compression on the main thread | Store |
|---|---|---|---|
| 2,000 | 37 KB | 72 ms | inline |
| 10,000 | 156 KB | 162 ms | inline |
| 25,000 | 377 KB | 0.4–0.7 s | 3 chunks, restored |
| 50,000 | 731 KB | 1.5–1.8 s | 6 chunks, restored |
| 100,000 | 1.41 MB | ~1.7 s | over quota with two copies; in-place fallback; restored |
| 160,000 | 2.13 MB | | **refused**; old save kept; "Not saved" dialog shown |

That works out to ~14–15 bytes per building, because belts compress well. For scale, an
experienced player's base after 30 minutes typically has a few hundred to ~2,000 buildings, so it
is under 40 KB. Late-game bases in the full game reach 10k–50k+, which is 0.15–0.75 MB. Items on
belts aren't in my synthetic bases, so real bases of the same size save somewhat larger.

**The 2 MB per-person quota allows one save of up to roughly 140k buildings.** Above about 1 MB,
an old and a new copy no longer fit side by side, and the safe write gives way to delete-then-write.
This build is the demo (see below), which caps you at one savegame and the first 8 levels with no freeplay, so in practice
it stays in the first rows of the table.

## Mobile

On a phone viewport (iPhone 13 user agent, touch), shapez shows its own "not available on mobile"
screen. In the Flinsh build, that screen says the game is built for mouse and keyboard, and that the
factory is saved in Flinsh and waiting on a computer. It also offers "Try anyway", and it calls
`flinsh.ready()` so the card doesn't hang. "Try anyway" works: it reaches the menu, and Play starts
a game.

Plainly: **it is not playable on a phone.** The UI renders at desktop scale. Toolbar buttons are
about 25–40 CSS px, and the tutorial panel covers part of the toolbar. Tapping a building and then
the map placed nothing in my test. Building is drag-to-place, rotate is the R key, delete is
right-click, and there's no pinch zoom wired to the build tools. shapez has never supported touch,
and making it do so would be a port of its own. Treat this as a desktop app on Flinsh.

## Unsure, or not measured

- **Late-game save sizes are synthetic** (see above), not from a real 30-minute session. Items on
  belts and wires/signals are missing, so real saves are somewhat larger at the same building count.
- **Memory.** I didn't measure it. The single file holds ~7 MB of HTML plus the decoded data URIs
  in memory, likely 100–200 MB per frame. That may matter on low-end phones, but the game isn't
  playable there anyway.
- **The gzip load estimates** for the directory build are arithmetic, not measured.
- **Real Flinsh.** Everything ran in a harness that copies `miniAppSandbox.ts`, not in Flinsh
  itself. Differences in the parent (frame size, theme CSS, bridge latency) could show up.
- **This is the demo.** The `web` build keeps shapez.io's demo limits: one savegame, the first 8
  levels and no freeplay, and a "DEMO" badge. Lifting them is one flag (`restrictionMgr.isLimitedVersion`), but the
  full game is sold on Steam, so whether to do that is a decision for the fork owner, not a
  technical one.
- **Hidden tabs.** With workers blocked, the background simulation ticks via `setInterval`, which
  browsers throttle in hidden frames. The factory produces less while the tab is hidden than on
  shapez.io.
- **Bridge arriving after 400 ms.** That case runs unsaved, as described above. I don't know how
  late the real bridge can be.
