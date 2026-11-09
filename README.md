> **This fork is a Flinsh build of shapez.** It packages the free web version of the game as a
> [Flinsh](flinsh.json) app: it runs in Flinsh's sandboxed iframe with no network access, and saves
> go to the Flinsh store instead of the browser. Upstream is
> [tobspr-games/shapez.io](https://github.com/tobspr-games/shapez.io); the code stays under the
> GPL-3.0 [LICENSE](LICENSE). See [FLINSH.md](FLINSH.md) for what changed, how to build it, and the
> packaging report.

## shapez 2 out now!

Shapez 2 is now available on Steam, adding multi-layer factories, better performance, trains, fluids, and much more!

<a href="https://store.steampowered.com/app/2162800/shapez_2/?utm_medium=github&amp;utm_source=s1_github" title="shapez 2 on Steam">
    <img src="https://i.imgur.com/QBOGSib.jpeg" alt="shapez 2 Announcement">
</a>

<br>

# shapez

<a href="https://get.shapez.io/ghi" title="shapez on Steam">
    <img src="https://i.imgur.com/ihW2bUE.png" alt="shapez Logo">
</a>

## Contributing

This repository is no longer actively maintained, we have moved over to [shapez 2](https://store.steampowered.com/app/2162800/shapez_2/?utm_medium=github&utm_source=s1_github) development.

Please consider contributing to the [Community Edition](https://github.com/tobspr-games/shapez-community-edition) for ongoing development.

## About

This is the source code for shapez, an open source base building game inspired by Factorio.
Your goal is to produce shapes by cutting, rotating, merging and painting parts of shapes.

-   [Play on Steam](https://get.shapez.io/ghr)
-   [Online Demo](https://shapez.io)
-   [Official Discord](https://discord.com/invite/HN7EVzV) <- _Highly recommended to join!_

## Building

-   Make sure `ffmpeg` is on your path
-   Install Node.js 16 and Yarn
-   Install Java (required for texture packer)
-   Run `yarn` in the root folder
-   `cd` into `gulp` folder
-   Run `yarn` and then `yarn gulp` - it should now open in your browser

**Notice**: This will produce a debug build with several debugging flags enabled. If you want to disable them, modify [`src/js/core/config.js`](src/js/core/config.js).

### Flinsh build

-   `yarn build:flinsh` builds the `web-flinsh` variant (`G_IS_FLINSH`) and packages it into
    `dist-flinsh-single/index.html` (one self-contained file, the manifest's entrypoint) and
    `dist-flinsh/` (a directory with relative asset URLs).
-   `yarn serve:flinsh` and open `http://localhost:8130/test/flinsh-harness.html` to run it inside the
    same sandbox and CSP Flinsh uses, with a mock `window.flinsh.store`.

## Creating Mods

Mods can be found [here](https://shapez.mod.io). The documentation for creating mods can be found [here](mod_examples/), including a bunch of sample mods.

## Helping translate

Please checkout the [Translations readme](translations/README.md).
However, currently we are not reviewing new translations.

### Code

The game is based on a custom engine which itself is based on the YORG.io 3 game engine (Actually it shares almost the same core).
The code within the engine is relatively clean with some code for the actual game on top being hacky.

This project is based on ES5 (If I would develop it again, I would definitely use TypeScript). Some ES2015 features are used but most of them are too slow, especially when polyfilled. For example, `Array.prototype.forEach` is only used within non-critical loops since its slower than a plain for loop.

### Assets

You can find most assets <a href="//github.com/tobspr-games/shapez.io-artwork" target="_blank">here</a>.

All assets will be automatically rebuilt into the atlas once changed (Thanks to dengr1065!)

<img src="https://i.imgur.com/W25Fkl0.png" alt="shapez Screenshot">

<br>

## Check out our other games!

<a href="https://tobspr.io" title="tobspr Games">
<img src="https://i.imgur.com/uA2wcUy.png" alt="tobspr Games">
</a>
