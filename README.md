# AutoUpdateProto — electron-builder v27 / electron-updater v7 auto-update prototype

A barebones Electron app (the `electron/minimal-repro` quick start) wired to **electron-updater 7.0.0-alpha.x** and built with
**electron-builder 27.0.0-alpha.x**, plus a **zero-dependency local update server** so the whole check → download →
install cycle can be exercised on one machine (or against a VM) without any cloud provider.

What it exercises:

- the generic provider (`latest*.yml` + installer files on a plain HTTP server, Range / multipart Range for differential downloads),
- publishing from electron-builder into that server through a **custom publish provider** (`build/electron-publisher-custom.js`),
- the three v7 install flows: **update on quit**, **update on next launch**, **quit without updating**,
- channels (`latest` / `beta` / `alpha`) and `generateUpdatesFilesForAllChannels`,
- pointing the app at an **unreleased electron-builder checkout** via `pnpm.overrides` (`link:`),
- **signed update manifests** (electron-builder PR #9877, unreleased).

Only three npm packages are used: `electron`, `electron-builder`, `electron-updater`. Everything else is `node:*`.

## Prerequisites

- Node.js >= 22.12 (electron-builder v27 minimum) and pnpm 10 (`corepack enable` picks up `packageManager`).
- macOS: a Developer ID Application certificate in the default keychain (or `CSC_NAME`/`CSC_LINK`) — Squirrel.Mac refuses
  to install unsigned updates, so the macOS flow needs signed builds. Windows/Linux: nothing extra.
- For Windows/Linux testing from a VM: the VM must reach the host's LAN IP on port 8080.

```sh
pnpm install
# where the Electron binary cannot be downloaded (proxy sandboxes): ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install
```

## Quick start (one machine)

```sh
pnpm serve                                   # terminal 1: update server on http://127.0.0.1:8080/ serving server/updates/

pnpm release --version 1.0.0 --publish       # terminal 2: build the current platform, PUT artifacts + yml into the server
# install the produced app from dist/ (AutoUpdateProto Setup 1.0.0.exe / AutoUpdateProto-1.0.0.AppImage / .dmg or .zip)
# and launch it — it shows "Hello World!", the version, the channel and the feed URL.

pnpm release --version 1.0.1 --publish       # build + publish the next version
```

In the running 1.0.0 app press **Check for updates**: the status line shows `✅ update available: 1.0.1 (downloading...)`,
a progress line, then `✅ downloaded 1.0.1 -> <cached installer>` and the three flow buttons appear. Pick one:

| Button | What main.js does (electron-updater v7 API) | Result |
| --- | --- | --- |
| **Update on quit** | `autoUpdater.autoInstallEvent = "onQuit"; app.quit()` | quit handler spawns the installer silently while the app exits |
| **Update on next launch** | `autoUpdater.autoInstallEvent = "onNextLaunch"; autoUpdater.quitAndInstall({ waitUntilNextLaunch: true })` (quits by itself) | a pending marker is written to the updater cache; on the next launch `installPendingUpdateIfAvailable()` re-validates and installs |
| **Quit without updating** | `autoUpdater.autoInstallEvent = "manual"; app.quit()` | nothing is installed; the download stays cached and is reused (sha512 match) on the next check |

Relaunch the app: the version line now reads 1.0.1; **Check for updates** now reports `❌ no update (server has 1.0.1)`.

Without `--publish` the build only lands in `dist/` (`electron-builder --publish never`; v27 has no implicit publish). Use
`pnpm publish:copy` to copy `dist/*.{yml,exe,blockmap,zip,dmg,AppImage}` into `server/updates/` instead.

### v7 notes per platform

- `autoInstallOnAppQuit` is gone; `autoInstallEvent: "onQuit" | "onNextLaunch" | "manual"` replaces it.
  `quitAndInstall()` takes an options object `{ isSilent, isForceRunAfter, waitUntilNextLaunch }`.
- **Windows (NSIS, per-user, oneClick)**: on-quit runs `Setup.exe --updated /S`. Next-launch is installed automatically at
  startup only for per-user installs (per-machine would need UAC, so the updater keeps the pending marker for an explicit
  `installPendingUpdateIfAvailable()` call — main.js always makes that call). Unsigned builds are fine: the updater only
  verifies the installer signature when `publisherName` is in `app-update.yml`.
- **Linux (AppImage)**: the running AppImage file is replaced in place (`APPIMAGE` env must be set — i.e. run the AppImage
  itself, not an extracted dir); next-launch is supported automatically. The install path is where the AppImage lives.
- **macOS**: electron-updater proxies the zip to the native Squirrel.Mac updater; **the app must be code signed**
  (hardened runtime is enabled in `electron-builder.js`; identity comes from the keychain or `CSC_NAME`). "On quit" and
  "next launch" behave the same — Squirrel stages the update natively and applies it on relaunch; there is no pending
  marker (`installPendingUpdateIfAvailable()` resolves `false`). `latest-mac.yml` requires the `zip` target (dmg is for humans).
- Setting `autoUpdater.channel` also sets `allowDowngrade = true` (AppUpdater.ts), so switching latest → alpha → latest works.

## Channels

```sh
pnpm release --version 1.1.0-alpha.1 --channel alpha --publish
```

`--channel` sets `UPDATE_CHANNEL`, which `electron-builder.js` puts into `publish[].channel`. With
`generateUpdatesFilesForAllChannels: true` a `latest` release writes `latest*.yml` **and** `alpha*.yml` + `beta*.yml`; a
`beta` release writes `beta*.yml` + `alpha*.yml`; an `alpha` release only `alpha*.yml` (`updateInfoBuilder.computeChannelNames`).
File names are `<channel>.yml` (Windows), `<channel>-mac.yml`, `<channel>-linux.yml` / `<channel>-linux-arm64.yml`.
Since PR #9998 a suffixed channel such as `latest-foo` expands to `alpha-foo` / `beta-foo` as well.

In the app pick **alpha** in the channel dropdown and press **Check for updates**: the updater now requests
`alpha[-mac|-linux].yml` and offers 1.1.0-alpha.1. Switch back to **latest** and check again: because the channel setter
enabled `allowDowngrade`, it offers 1.0.1 again (a downgrade).

Note: if `publish[].channel` is omitted, electron-builder derives the channel from the app version's prerelease tag
(`detectUpdateChannel`, `appInfo.channel`: `1.1.0-alpha.1` → `alpha`). `release.mjs` always sets it explicitly.

## Dev mode (no packaging)

```sh
pnpm serve
pnpm start
```

Unpackaged, `main.js` sets `autoUpdater.forceDevUpdateConfig = true`, so electron-updater reads `./dev-app-update.yml`
(generic, `http://127.0.0.1:8080/`, channel `latest`) instead of `resources/app-update.yml`. Checking and downloading work
against whatever is in `server/updates/` (the version compared against is `package.json` `version`); installing does not
(there is no installer to run for an unpackaged app). All events are logged to the window and to stdout.

## Testing an unreleased electron-builder checkout

```sh
# in the electron-builder monorepo checkout (e.g. ../electron-builder on the branch under test)
pnpm install && pnpm compile

# here
pnpm link-builder ../electron-builder
pnpm exec electron-builder --help            # now the checkout's CLI (e.g. lists create-update-key on the PR #9877 branch)
pnpm release --version 1.0.2 --publish       # builds with the checkout's app-builder-lib / packages electron-updater from the checkout
pnpm unlink-builder                          # back to the registry versions in package.json
```

`scripts/link-local-builder.mjs` writes `pnpm.overrides` entries `link:<checkout>/packages/<pkg>` for
`electron-builder`, `app-builder-lib`, `builder-util`, `builder-util-runtime`, `electron-publish`, `dmg-builder`,
`electron-builder-squirrel-windows` and `electron-updater` (they depend on each other by exact version, so they must be
swapped as a set) and runs `pnpm install`. The linked packages resolve their own dependencies from the checkout's
`node_modules`, which is why the checkout must be installed and compiled first; re-run `pnpm compile` there after changes.

Known pnpm behaviour: `pnpm unlink-builder` (removing a `link:` override) makes pnpm delete `node_modules` **inside the
previously linked packages** (`packages/electron-builder/node_modules`, `packages/electron-updater/node_modules`) in the
checkout. The script prints a reminder; run `pnpm install` in the checkout afterwards.

`electron-builder --version` prints the *app's* version (yargs picks up this project's package.json), so use
`pnpm exec electron-builder --help` or the `• electron-builder version=...` line of a build to see which one is running.

## Signed update manifests (PR #9877, unreleased — needs the linked checkout)

```sh
pnpm link-builder ../electron-builder        # branch with PR #9877
mkdir -p keys && pnpm exec electron-builder create-update-key --out keys/update-private-key.pem   # prints the public key
export ELECTRON_BUILDER_UPDATE_SIGN_KEY_FILE=$PWD/keys/update-private-key.pem
pnpm release --version 1.0.0 --publish       # every latest*.yml gets a `signature`; app-update.yml gets updateManifestPublicKey
# install 1.0.0, then
pnpm release --version 1.0.1 --publish
```

No `updateManifest` block is needed in `electron-builder.js` (the released alpha.8 schema would reject that key anyway);
the environment variable alone signs the manifests and embeds the derived public key.

Tamper test: edit one byte of `server/updates/latest*.yml` (e.g. the `version:` line or a `sha512`) and press
**Check for updates** in the installed 1.0.0 app → `❌ error ERR_UPDATER_MANIFEST_SIGNATURE_INVALID`. Remove the
`signature:` line instead → `ERR_UPDATER_MANIFEST_NOT_SIGNED`. Restore the file (or `pnpm publish:copy`) → `✅`.

Dev mode: paste the printed public key into the commented `updateManifestPublicKey:` block of `dev-app-update.yml` to get the
same verification with `pnpm start`. `create-update-key --out` expects a file path whose directory already exists.

## Testing from a VM / another machine

```sh
pnpm serve --host 0.0.0.0                    # prints http://<lan-ip>:8080/ for every interface
UPDATE_SERVER_URL=http://<host-ip>:8080/ pnpm release --version 1.0.0 --win --publish
```

`UPDATE_SERVER_URL` is written into the app's `app-update.yml` (generic provider) and used by the custom publisher, so the
installed app polls the host from inside the VM. Cross-building Windows NSIS from macOS/Linux works (electron-builder
downloads its NSIS toolchain); build Linux AppImages on Linux or in the VM itself.

## How publishing is wired

```js
publish: [
  { provider: "generic", url, channel },   // [0] -> embedded into resources/app-update.yml; never uploads
  { provider: "custom",  url, channel },   // [1] -> build/electron-publisher-custom.js PUTs everything to the server
]
```

- `PublishManager.getAppUpdatePublishConfiguration` embeds `publishConfigs[0]` into `app-update.yml`, so generic comes first.
- The generic provider never uploads (`PublishManager.scheduleUpload` returns early for it); the update-info yml for it is
  written to `dist/`.
- For the second publish config the yml files are written to `dist/custom/` and emitted as artifacts of that config, so the
  custom publisher uploads them (with `--publish always`). `publishAutoUpdate: false` would suppress that upload, and the
  channel must match entry [0] because `computeChannelNames` uses each config's own `channel`.
- The only provider name the schema accepts for a user publisher is `custom`; electron-builder loads
  `build/electron-publisher-custom.{mjs,js,cjs}` from `directories.buildResources` and calls `new clazz(context, publishConfig)`,
  then `upload({ file, fileContent?, arch, safeArtifactName?, timeout? })` per artifact.

`server/update-server.mjs` answers `GET/HEAD` with `Accept-Ranges`, single `Range` → 206, multiple ranges →
`206 multipart/byteranges` (the framing electron-updater's `DataSplitter` expects), `PUT/POST /<file>` → atomic write → 201,
`GET /` → listing, and logs every request. Options: `--port`, `--host`, `--dir`.

## Troubleshooting

- `❌ error ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` — no `<channel>[-mac|-linux].yml` on the server: publish a release for that
  channel/platform or check `pnpm serve` logs (it prints every request with the status).
- `ECONNREFUSED` — server not running / wrong `UPDATE_SERVER_URL` baked into `app-update.yml`
  (`resources/app-update.yml` next to the installed app shows what the build embedded).
- `❌ no update (server has X)` — the server version is not newer; downgrades only happen after a channel switch.
- Cached installer reused without progress events — expected: `DownloadedUpdateHelper` validates the cached file by sha512.
- macOS `update-downloaded` never arrives / `Could not get code signature for running application` — the build is not
  signed; Squirrel.Mac requires a valid signature (whether an ad-hoc `sign.identity: "-"` build can update itself is untested).
- Nothing published — check `--publish` was passed (v27 never publishes implicitly) and that the server log shows `PUT`s.
- Electron download 403/blocked — `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install` gets dependencies in; packaging itself
  needs the Electron zip (mirror via `ELECTRON_MIRROR` / `electronDist`).
