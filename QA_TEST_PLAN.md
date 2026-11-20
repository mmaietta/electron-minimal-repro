# QA test plan: electron-updater 7.0.0-alpha.14 + electron-builder 27.0.0-alpha.15

**Under test:** release commit `a483c9a74` (`changeset-release/master` in `../electron-builder-5`, regenerated on 2026-11-20 on master `10f6f710a`, after the QA-findings fixes), linked into this app through `pnpm.overrides`. These versions are not on npm yet.

The audit started on `09e5e383d`, and the release PR has been regenerated twice since:
- **`8a9b848f8`, after #10603.** The only shipped-code changes: the `ERR_HTTP_RESPONSE_TOO_LARGE` message now links `#channel-files-are-limited-to-10-mib`, and `migrate-schema` rewrites a `toolsets.appimage: "1.2.0"` pin to `"1.2.1"`.
- **`f4df97d1c`, after #10605 and #10620.**
  - #10605 fixes F1: a failed download is now reported only once its destination file is closed.
  - #10620 adds the v27 runtime e2e cases, which also cover F3 and F4.
- **`a483c9a74` (master `10f6f710a` + version bumps), after the QA-findings fixes (#10627–#10641).** Test the release commit, not master: master's electron-updater is still `7.0.0-alpha.13`, below the version gate of the missing-crossOriginHeaders build warning, so B4 fails there. F2, F5–F10, F12–F14 and F17–F19 are fixed; F15 (#10630) is still open. The runners now assert the fixed behavior where a check reaches it: D9 (F10), D7 and M1 (F7), B2 (F13), B6 (F5; F15 fails until #10630 merges), W10 (F18, F19), E4 (F17), and E5 runs the new `blackboxNsisDebugLogging` case.

**Running it:** `qa/run/*.mjs` automates these checks and QA_MANUAL.md has the steps. This file stays the reference for what each check proves.

**Time:** about 35 checks in 6 sessions, roughly 5.5 h. Builds happen once, in session B, all on the Mac.

**Order:** B → D → M → W → L. Session R is only needed if the release PR is regenerated.

**Notation:** each check is a checkbox. "A" is the update server on `:8080`; "B" is the second server on `:8081` (a second origin).

## Toggles at a glance

**App (`main.js`), set as environment variables at launch.** The active ones show in the window's info line. Every log line also goes to `<userData>/updater-qa.log`: on macOS `~/Library/Application Support/AutoUpdateProto/`, on Windows `%APPDATA%\AutoUpdateProto\`, on Linux `~/.config/AutoUpdateProto/`.

| Variable | Values | Effect |
|---|---|---|
| `QA_AUTO_CHECK` | `1` | Check for updates once the window has loaded; logs `[qa] QA_AUTO_CHECK -> {…}` |
| `QA_CROSS_ORIGIN` | `none` (default) · `unset` · `array` · `tenant` · `all` · `throw` · `bad` | `autoUpdater.crossOriginHeaders`. Values: `() => []` (none); not set (unset); `[]` (array); keep `x-qa-tenant` for `http://localhost:8081` only (tenant); forward everything (all); throw (throw); return a string (bad). Every hop is logged as `[qa] cross-origin hop A -> B offered [names]`. |
| `QA_AUTH` | `1` | `requestHeaders = { "x-qa-tenant": "t1" }` + `addAuthHeader("Bearer QA-SECRET-TOKEN")` |
| `QA_FEED` | URL | `setFeedURL({ provider: "generic", url })` |
| `QA_CHANNEL` | name | `autoUpdater.channel`; this also sets allowDowngrade. On mac, `qa-xo` requests `qa-xo-mac.yml`. |
| `QA_FORCE_DEV` | `0` | `forceDevUpdateConfig = false` |
| `QA_ALLOW_INSECURE` | `dev` · `force` | `allowInsecureFeed = !app.isPackaged` / `true` |
| `QA_LOGIN` | `origin` (default) · `none` · `legacy` · `throw` · `hang` | `login` handler. **origin:** answers `qa:secret` only for the feed's own origin and cancels everything else. **none:** no listener. **legacy:** a handler without the `url` argument that answers every challenge. **throw:** the handler throws. **hang:** never answers. |
| `QA_MAX_UPDATE_INFO_SIZE` | bytes | `autoUpdater.maxUpdateInfoSize` |
| `QA_AUTO_INSTALL_EVENT` | `onQuit` · `onNextLaunch` · `manual` | Startup `autoInstallEvent`. The default is `onQuit` packaged and `manual` unpackaged, so dev runs never hand downloads to Squirrel.Mac. |
| `QA_NEXT_LAUNCH_EVENT` | `keep` | The "Update on next launch" button leaves `autoInstallEvent` unchanged |
| `QA_EXPLICIT_PENDING` | `0` | Skip the startup `installPendingUpdateIfAvailable()` call, so only the updater's own install-at-launch can run |
| `QA_CANCEL_AFTER_MS` | ms | Cancel the auto-download through the `cancellationToken` that `checkForUpdates()` returns |
| `QA_PUBLISHER_NAME` | DN | `autoUpdater.publisherName` (Windows) |
| `QA_INSTALL_DIR` | path | `autoUpdater.installDirectory` (Windows) |
| `QA_CUSTOM_VERIFIER` | `accept` | A custom `verifyUpdateFileAuthenticodeSignature` that accepts and logs its arguments |
| `QA_ALLOW_UNVERIFIED_LINUX` | `0` | `allowUnverifiedLinuxPackages = false` |

**Server (`server/update-server.mjs`).** Its log line shows `host=`, `hdr=[header names]` and `q=[query names]`, never values. `ABORTED` means the client hung up.

| Flag | Effect |
|---|---|
| `--redirect-match <regex> --redirect-to <base> [--redirect-status 302]` | Redirect matching GET/HEAD paths to `<base><path><query>` |
| `--auth <regex>` | Matching paths need Basic `qa:secret`; otherwise 401 + `WWW-Authenticate` |
| `--throttle-kbps <n>` | Send bodies at about n KiB/s |
| `--extra-bytes <file>:<n>` | A full GET of `<file>` gets n zero bytes more than the file |

**Build (`electron-builder.js`).**

| Variable | Effect |
|---|---|
| `QA_WIN_TARGETS` | Comma-separated Windows targets; default `nsis,portable`. `squirrel` stays possible, but writes no app-update.yml. |
| `QA_WEB=1` | Adds `nsis-web` |
| `QA_NSIS_LOG=1` | `nsis.installerDebugLogging` |
| `QA_BLOCKMAP` | `v2` · `v3` · `latest` |
| `QA_SCAN_PROBE=1` | Builds only `qa/probe-main.js` into `dist-probe/` |

**Helper:** `node scripts/qa.mjs` lists its commands: `status`, `archive`, `version`, `stash`, `serve`, `stash-dist`, `manifests`, `shrink-size`, `dev-key`, `public-key`, `cache`, `pending` and `scratch`.

---

## Setup (once)

- [ ] **S1. Fresh checkout build.** Recompile, then check the fresh-dist markers. Every command must print something:
  ```sh
  (cd ../electron-builder-5 && git rev-parse --short HEAD && pnpm compile)
  grep -c ERR_UPDATER_DOWNLOAD_SIZE_EXCEEDED ../electron-builder-5/packages/builder-util-runtime/dist/httpExecutor.js   # >= 1
  test -f ../electron-builder-5/packages/electron-updater/dist/windowsExecutableVersion.js && echo ok
  pnpm exec electron-builder sign-update-manifest --help | head -1
  ```
  - Don't trust `electron-builder --version`: it prints this app's version.
  - If `pnpm start` fails with `Cannot read properties of undefined (reading 'getPath')`, unset `ELECTRON_RUN_AS_NODE` (some IDE shells set it).
  - If `node_modules/electron/dist` is missing, run `node node_modules/electron/install.js` (pnpm 10 skips postinstall scripts).
- [ ] **S2. CI gate.** If the release commit's run is red, triage first. Master `c8c7cafaa` already failed once in `downloadSizeLimitTest` (see Findings F1).
  ```sh
  gh run list -R electron-userland/electron-builder --workflow test.yaml --branch changeset-release/master --limit 3
  ```
- [ ] **S3. Fresh harness state.** `node scripts/qa.mjs archive` moves the old `dist/` and `server/updates/*` (built by the stale Nov 7 toolchain) to `~/qa-backup/`. Then `mkdir -p qa-logs`.
- [ ] **S4. Windows signing.** Export `WIN_CSC_LINK=<pfx>` and `WIN_CSC_KEY_PASSWORD=<password>`. Use `WIN_CSC_LINK`, not `CSC_LINK`: it keeps macOS signing on the keychain Developer ID.
  - **Real certificate:** nothing else to do.
  - **Self-signed certificate:** do the following on the Mac. It needs brew `openssl@3`, because LibreSSL's legacy PKCS#12 may be rejected by osslsigncode.
    ```sh
    mkdir -p ~/qa-cert && cd ~/qa-cert && cat > qa.cnf <<'EOF'
    [req]
    distinguished_name = dn
    prompt = no
    x509_extensions = ext
    [dn]
    CN = AutoUpdateProto QA
    [ext]
    basicConstraints = critical, CA:false
    keyUsage = critical, digitalSignature
    extendedKeyUsage = critical, codeSigning
    EOF
    O=$(brew --prefix openssl@3)/bin/openssl
    $O req -x509 -newkey rsa:2048 -nodes -days 3650 -config qa.cnf -keyout qa.key -out qa.crt
    $O pkcs12 -export -inkey qa.key -in qa.crt -out qa.pfx -passout pass: -name "AutoUpdateProto QA"
    $O x509 -in qa.crt -outform der -out qa.cer && cd -
    ```
  - Then, in the elevated Windows VM: `Import-Certificate -FilePath <share>\qa.cer -CertStoreLocation Cert:\LocalMachine\Root`. Remove it after QA.
  - `electron-builder create-self-signed-cert` does not work here: it imports into TrustedPeople, which is not a trust anchor.
- [ ] **S5. VM networking.** Keep the baked-in feed `http://127.0.0.1:8080/`, because a LAN http URL now fails with `ERR_UPDATER_INSECURE_FEED`. Run the server on all interfaces and forward each VM's loopback port to the Mac:
  - **Mac:** `pnpm serve --host 0.0.0.0` (allow node in the macOS firewall).
  - **Windows (elevated):** `netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=8080 connectaddress=10.211.55.2 connectport=8080`. 10.211.55.2 is the Mac on Parallels shared networking.
  - **Linux:** `socat TCP-LISTEN:8080,bind=127.0.0.1,reuseaddr,fork TCP:<mac-ip>:8080 &`
  - **Check from each VM:** `curl http://127.0.0.1:8080/` prints the listing.

## Session B — builds and build-time / CLI checks (Mac)

Keep `pnpm serve --host 0.0.0.0` running in terminal A. Use terminal B for the build shell:

```sh
export ELECTRON_BUILDER_UPDATE_SIGN_KEY_FILE=$PWD/keys/update-private-key.pem   # --publish refuses to publish unsigned manifests
```

- [ ] **B1. Cold-cache 1.0.0 builds** (#10478 #10477 #10483 #10482 #10490 #10481 #10475 #10595 #10487 #10586, release banner)
  ```sh
  export ELECTRON_BUILDER_CACHE=$(mktemp -d)        # cold toolset cache: downloads + checksums + extraction run
  pnpm release --version 1.0.0 --mac --publish   2>&1 | tee qa-logs/b1-mac.log
  pnpm release --version 1.0.0 --win --publish   2>&1 | tee qa-logs/b1-win.log     # add --x64 for an x64 VM
  pnpm release --version 1.0.0 --linux --publish 2>&1 | tee qa-logs/b1-linux.log   # AppImage + deb
  unset ELECTRON_BUILDER_CACHE && node scripts/qa.mjs stash v1.0.0
  grep -hoE "downloading.*label=[^ ]+" qa-logs/b1-*.log | sort -u; find "$ELECTRON_BUILDER_CACHE" -maxdepth 3   # toolset downloads and the cold cache
  grep -hiE "crossOriginHeaders|plain http" qa-logs/b1-*.log      # expect nothing
  grep -A3 updateManifestPublicKey dist/mac-*/AutoUpdateProto.app/Contents/Resources/app-update.yml
  grep -A1 publisherName dist/win-*unpacked/resources/app-update.yml
  codesign --verify --deep --strict --verbose=2 dist/mac-*/AutoUpdateProto.app
  ```
  Pass when all of these hold:
  - The banner shows `version=27.0.0-alpha.15`.
  - Toolsets downloaded into the cold cache, as shown by the download labels and cache paths (there is no "using toolset" log line): `7zip@1.1.0`, `dmg-builder@1.2.7`, `nsis@2.0.4`, `win-codesign@1.3.3`, `appimage@1.2.1`, `fpm@2.3.1`, `archive@1.0.0`.
  - No cross-origin or plain-http warning.
  - The public key is in the mac `app-update.yml`, and `publisherName: - CN=…` is in the win one.
  - codesign is OK.
- [ ] **B2. 1.0.1 builds.** Same three commands with `--version 1.0.1` and no cold cache, then `node scripts/qa.mjs stash v1.0.1`.
  - Pass: `node scripts/qa.mjs status` shows every served manifest at 1.0.1 (signed).
- [ ] **B3. Extra builds** (#10483 log stubs, #10588 offline signing). These are not published: they go to `server/updates` without replacing what's served.
  ```sh
  ELECTRON_BUILDER_OFFLINE=1 QA_WEB=1 QA_NSIS_LOG=1 pnpm release --version 1.0.2 --win 2>&1 | tee qa-logs/b3-win.log
  node scripts/qa.mjs stash-dist win-1.0.2 --web
  QA_BLOCKMAP=v2 pnpm release --version 1.1.0 --mac 2>&1 | tee qa-logs/b3-mac.log
  node scripts/qa.mjs stash-dist mac-1.1.0
  node scripts/qa.mjs manifests && node scripts/qa.mjs serve v1.0.1 && node scripts/qa.mjs status
  xxd -l 2 server/updates/AutoUpdateProto-1.1.0-*mac.zip.blockmap; xxd -l 4 server/updates/AutoUpdateProto-1.0.1-*mac.zip.blockmap
  ```
  Pass:
  - The win log warns once that it signs without a timestamp.
  - The 1.1.0 map starts with `1f8b` (v2, gzip) and the 1.0.1 map with `EBB3` (v3).
  - `status` lists the stashes `v1.0.0`, `v1.0.1`, `win-1.0.2`, `win-1.0.2-web`, `mac-1.1.0`, `win-forged-1.0.2` and `win-web-wrong-arch`.
- [ ] **B4. Build warnings** (#10584 #10566 #10568)
  ```sh
  QA_SCAN_PROBE=1 CSC_IDENTITY_AUTO_DISCOVERY=false UPDATE_SERVER_URL='http://qa.example.com:8080/?token=abc' \
    pnpm exec electron-builder --mac zip --publish never 2>&1 | tee qa-logs/b4.log
  ```
  Pass:
  - One warning that no app file mentions `crossOriginHeaders`.
  - One warning that the app-update.yml feed uses plain http to a host that is not loopback.
  - One warning that the generic `url` has a query: it names `token`, never `abc`.
  - Each warning carries its `migration/v27-runtime-changes#…` link.
- [ ] **B5. `sign-update-manifest`** (#10423). Run `node scripts/qa.mjs scratch` (APFS clones in `qa-scratch/`), then:
  ```sh
  printf 'stagingPercentage: 50\n' >> qa-scratch/latest-mac.yml
  pnpm exec electron-builder sign-update-manifest qa-scratch/latest-mac.yml                   # 1 re-signs, keeps the field
  pnpm exec electron-builder sign-update-manifest --verify qa-scratch/latest-mac.yml \
    -c.updateManifest.publicKey="$(node scripts/qa.mjs public-key)"                           # 2 verified
  ln -s latest-mac.yml qa-scratch/link.yml && pnpm exec electron-builder sign-update-manifest qa-scratch/link.yml   # 3 refused
  sed -i '' 's/AutoUpdateProto-1.0.1-arm64.dmg/AutoUpdateProto-1.0.1-missing.dmg/' qa-scratch/latest-mac.yml   # (dist/ still has the real dmg)
  pnpm exec electron-builder sign-update-manifest qa-scratch/latest-mac.yml                   # 4 refused: listed file missing
  node scripts/qa.mjs scratch && printf x >> qa-scratch/AutoUpdateProto-1.0.1-arm64-mac.zip  # fresh scratch, then change the zip clone
  pnpm exec electron-builder sign-update-manifest qa-scratch/latest-mac.yml                   # 5 refused: size/sha512 mismatch
  pnpm exec electron-builder sign-update-manifest --rehash qa-scratch/latest-mac.yml          # 6 re-signs with size 125513717
  ELECTRON_BUILDER_UPDATE_SIGN_KEY_FILE=/nonexistent pnpm exec electron-builder sign-update-manifest qa-scratch/latest-mac.yml   # 7
  ```
  Pass:
  - Steps 1, 2 and 6 succeed, and step 6 sets size 125513717.
  - Steps 3–5 are refused, each with a clear reason.
  - Step 7 is an `InvalidConfigurationError` naming its source.
  - No key material is printed.
- [ ] **B6. `verify`, `publish -f` and `migrate-schema`** (#10582 #10566 #10568 #10475 #10490)
  ```sh
  node scripts/qa.mjs scratch && printf 'releaseName: &n QA\nreleaseNotes: *n\n' >> qa-scratch/latest-mac.yml && printf x >> qa-scratch/AutoUpdateProto-1.0.1-arm64-mac.zip
  pnpm exec electron-builder verify qa-scratch -c.updateManifest.publicKey="$(node scripts/qa.mjs public-key)" 2>&1 | tee qa-logs/b6-verify.log
  pnpm exec electron-builder sign-update-manifest --verify qa-scratch/latest-mac.yml -c.updateManifest.publicKey="$(node scripts/qa.mjs public-key)"
  mkdir -p /tmp/qa-publish && node server/update-server.mjs --port 8082 --dir /tmp/qa-publish &      # a throwaway upload target
  UPDATE_SERVER_URL=http://127.0.0.1:8082/ pnpm exec electron-builder publish -f qa-scratch/latest-mac.yml -f qa-scratch/AutoUpdateProto-1.0.1-arm64-mac.zip
  kill %1
  pnpm exec electron-builder migrate-schema -c qa/migrate.json -n
  ```
  Pass:
  - `verify` fails on the YAML aliases and reports the zip's stale size/sha512.
  - `sign-update-manifest --verify` reports **verified** for the same aliased file. That is finding F5: record it.
  - `publish -f` prints the rules banner once and names the aliases and the stale zip.
  - `migrate-schema` prints the http-feed and feed-query advisories, and (since #10603) rewrites `toolsets.appimage: "1.2.0"` to `"1.2.1"`. Record how it reports the leftover `toolsets.linuxToolsMac` key, which no longer exists in the schema.

## Session D — dev mode on the Mac (no packaging)

**Terminals:**
- A: `pnpm serve` (restart it with flags when a check says so).
- B: `node server/update-server.mjs --port 8081`.
- App: `<env> QA_AUTO_CHECK=1 pnpm start 2>&1 | tee -a qa-logs/dev.log`. Quit with Cmd+Q after each run.

**Once, before D1:** `node scripts/qa.mjs version 1.0.0 && node scripts/qa.mjs serve v1.0.1`. The app is then 1.0.0 and 1.0.1 is served.

**Before any run that downloads,** clear the cache with `node scripts/qa.mjs cache clear`. Otherwise a cached download is reused and nothing reaches the servers.

- [ ] **D1. `crossOriginHeaders` is required** (#10563). Launch with `QA_CROSS_ORIGIN=unset`, then with `QA_CROSS_ORIGIN=unset QA_FORCE_DEV=0`, then with `QA_CROSS_ORIGIN=array`.
  - Pass: each run gives `ERR_UPDATER_CROSS_ORIGIN_HEADERS_NOT_CONFIGURED` ("checkForUpdates requires autoUpdater.crossOriginHeaders … #cross-origin-headers"), with no `checking-for-update` event and no request in A's log.
- [ ] **D2. Credentials stay on the feed's origin** (#10563 #10520 #10568). Clear the cache before each of the three runs: `QA_AUTH=1 QA_CHANNEL=qa-xo`, then `… QA_CROSS_ORIGIN=tenant`, then `… QA_CROSS_ORIGIN=all`.
  - **Default:** A's `GET /qa-xo-mac.yml` has `authorization`, `x-qa-tenant` and `x-user-staging-id` in `hdr=`. B's `GET /AutoUpdateProto-1.0.1-arm64-mac.zip` has none of them, plus `q=[sig]`. The app logs exactly one "autoUpdater.crossOriginHeaders left out authorization, x-qa-tenant for the request from http://127.0.0.1:8080 to http://localhost:8081 …", and its URLs never show `?sig=`.
  - **tenant:** B's `hdr=` has `x-qa-tenant` but not `authorization`.
  - **all:** B gets `authorization` too, with no warning. This is the leak the property prevents.
- [ ] **D3. A broken callback** (#10563). Launch with `QA_AUTH=1 QA_CHANNEL=qa-xo QA_CROSS_ORIGIN=throw`, then with `=bad`.
  - Pass: `ERR_UPDATER_INVALID_CROSS_ORIGIN_HEADERS`, either "…threw for the request from http://127.0.0.1:8080 to http://localhost:8081, which is not sent" or "…must return an array … got string". B logs nothing, and `grep '\[updater:' qa-logs/dev.log | grep -c QA-SECRET-THROW` prints 0.
- [ ] **D4. A real Electron redirect** (#10563 #10520). Restart A with `--redirect-match '\.zip$' --redirect-to http://localhost:8081`. Clear the cache, then launch with `QA_AUTH=1 QA_CHANNEL=qa`.
  - Pass: A logs a 302, and B logs **exactly one** zip GET with neither `authorization` nor `x-qa-tenant`. The download completes.
  - **FAIL** if B logs two GETs, or one with `authorization`: Electron followed the redirect itself.
  - Then restart A with `--redirect-match '\.yml$' --redirect-to http://localhost:8081` and launch with `QA_CHANNEL=qa`. Expect one warning "left out x-user-staging-id …".
- [ ] **D5. HTTPS-only feeds** (#10566). With A plain, run three launches:
  - `QA_FEED=http://qa.localhost:8080/` → `ERR_UPDATER_INSECURE_FEED` ("…except to a loopback host (localhost, 127.0.0.0/8, ::1)"), and A logs nothing.
  - `QA_FEED=http://localhost:8080/` → works.
  - `QA_FEED=http://qa.localhost:8080/ QA_ALLOW_INSECURE=dev` → works, with no "packaged app" warning.
- [ ] **D6. Redirect rules** (#10566).
  - (a) A with `--redirect-match '\.zip$' --redirect-to http://qa.localhost:8081`; clear the cache, then launch with `QA_CHANNEL=qa`. Expect `ERR_UPDATER_INSECURE_FEED` at the redirect hop, and B logs nothing.
  - (b) A with `--redirect-match '\.yml$' --redirect-to http://localhost:8081`; launch with `QA_FEED=http://qa.localhost:8080/ QA_ALLOW_INSECURE=dev`. Expect `ERR_UPDATER_LOOPBACK_REDIRECT`, and B logs nothing.
- [ ] **D7. `login` gets the request URL** (#10565 #10549 #10566). Relaunch for every variant: Chromium caches answered credentials per process.
  - **A with `--auth '\.yml$'`:**
    - `QA_LOGIN=none` → one no-listener warning, then `HTTP_ERROR_401` at once (not after 60 s).
    - `QA_LOGIN=origin` → a `[qa] login event … url=http://127.0.0.1:8080/latest-mac.yml`; A logs a 401, then a 200 with `authorization`.
    - `QA_LOGIN=throw` → "A login listener threw…", then 401, and `QA-SECRET-LOGIN` appears in no `[updater:` line.
  - **A with `--redirect-match '\.zip$' --redirect-to http://localhost:8081`, B with `--port 8081 --auth '\.zip$'`.** Clear the cache before each run; `QA_CHANNEL=qa`.
    - `QA_LOGIN=legacy` → one "…without the url argument" warning, and B gets a 200 with `authorization` (a legacy handler answers every origin).
    - `QA_LOGIN=origin` → a login event for `localhost:8081` that is cancelled, then `HttpError` / `HTTP_ERROR_401`. The message has no query.
  - **A with `--auth '\.yml$'`,** launched with `QA_FEED=http://qa.localhost:8080/ QA_ALLOW_INSECURE=dev` → no login event at all; the challenge is cancelled.
- [ ] **D8. YAML alias budget** (#10514 #10536 #10575 #10522). Launch with `QA_CHANNEL=qa-alias-ok`, then with `QA_CHANNEL=qa-alias-bomb`.
  - Pass: ok loads normally. bomb gives `ERR_UPDATER_INVALID_UPDATE_INFO` in milliseconds ("YAML aliases expand to more than 100000 …", `#update-manifest-yaml-aliases-are-limited`), and the window stays responsive.
- [ ] **D9. Channel-file size limit** (#10508). Launch with `QA_MAX_UPDATE_INFO_SIZE=256` (below the about 700-byte `latest-mac.yml`; 1024 was enough while F13 listed the dmg 6 times), then `-1`, then `0`.
  - Pass: `ERR_UPDATER_RESPONSE_TOO_LARGE` (F10, #10633) with "raise the limit with maxUpdateInfoSize … See …#channel-files-are-limited-to-10-mib", then `ERR_UPDATER_INVALID_MAX_UPDATE_INFO_SIZE` (and A logs no request), then a normal check.
- [ ] **D10. A signed manifest with a staged rollout** (#10530 #10423).
  ```sh
  node scripts/qa.mjs dev-key on && printf 'stagingPercentage: 50\n' >> server/updates/latest-mac.yml   # launch + check: (1)
  pnpm exec electron-builder sign-update-manifest server/updates/latest-mac.yml                       # launch + check: (2)
  node scripts/qa.mjs serve v1.0.1 && node scripts/qa.mjs dev-key off
  ```
  Pass:
  - **(1)** `ERR_UPDATER_MANIFEST_SIGNATURE_INVALID`; the message says `stagingPercentage` is covered by the signature, and links the staged-rollout docs.
  - **(2)** "Update manifest signature verified…", plus a `Staging percentage:` line.
- [ ] **D11. Differential download with v3 maps** (the v3 default; no false positives from #10511 #10512 #10513 #10515 #10517 #10579)
  - **P1:** `node scripts/qa.mjs cache seed 1.0.0`, then launch. Expect "No cached blockmap for the old installer, downloading it…", "Block map v3", "File has N changed blocks" and "Differential download succeeded", while A logs `206 range="bytes=…, …"` multipart requests.
  - **P2:** `node scripts/qa.mjs cache seed 1.0.0 --blockmap`, then launch. Expect "Block map v3: … reused from the old map".
  - In both, `xxd -l 4 "$(node scripts/qa.mjs cache path)/current.blockmap"` afterwards shows `EBB3`.
- [ ] **D12. Switching blockmap format** (#10497)
  - **v3 → v2:** `node scripts/qa.mjs serve mac-1.1.0 && node scripts/qa.mjs version 1.0.1 && node scripts/qa.mjs cache seed 1.0.1 --blockmap`, then launch.
  - **v2 → v3:** `node scripts/qa.mjs serve v1.0.1 && node scripts/qa.mjs version 1.1.0 && node scripts/qa.mjs cache seed 1.1.0 --blockmap`, then launch with `QA_CHANNEL=latest` (allows the downgrade).
  - **Negative:** the v2 → v3 setup, plus `node scripts/qa.mjs cache corrupt-v2`.
  - **Finally:** `node scripts/qa.mjs version 1.0.0`.
  - Pass: both switches stay differential, with "Block map format changed (old: …, new: …)". The negative logs `ERR_UPDATER_BLOCKMAP_FORMAT_CHANGED` once at info, then downloads in full.
- [ ] **D13. Full downloads stop at the declared size** (#10580, and the CI failure F1)
  - **Unsigned, 3 times:** `node scripts/qa.mjs cache clear && node scripts/qa.mjs shrink-size`, then launch, then `node scripts/qa.mjs pending`.
  - **Signed:** `node scripts/qa.mjs serve v1.0.1 && node scripts/qa.mjs dev-key on && node scripts/qa.mjs cache clear`. Restart A with `--extra-bytes AutoUpdateProto-1.0.1-arm64-mac.zip:20000000`, launch, then `node scripts/qa.mjs pending`.
  - **Restore:** A without the flag, `node scripts/qa.mjs cache clear`, launch; then `node scripts/qa.mjs dev-key off`.
  - Pass:
    - Every run before the restore gives `ERR_UPDATER_DOWNLOAD_SIZE_EXCEEDED` with `#full-downloads-stop-at-the-declared-size`.
    - The signed run logs "signature verified" first.
    - `pending` exits 0 (no `temp-*` file left).
    - The restored run completes.
  - **A leftover `temp-*` file is F1:** note how often it happens.
- [ ] **D14. Cancelling a download** (#10506). Restart A with `--throttle-kbps 2048`, clear the cache, and launch with `QA_CANCEL_AFTER_MS=5000`. Then relaunch without the variable.
  - Pass: "[qa] cancelling the download after 5000 ms", then "cancelled" and `update-cancelled`, with no `error` event. A logs the zip GET with `ABORTED` and `bytes≈10000000`, and nothing after it. The relaunch downloads in full.
- [ ] **D15. Optional: electron-updater bundled into main** (#10531). This is AUTO via `autoUpdaterBundleTest`.
  ```sh
  npx --yes esbuild main.js --bundle --platform=node --external:electron --outfile=main.bundle.js
  QA_AUTO_CHECK=1 node_modules/.bin/electron main.bundle.js
  rm main.bundle.js
  ```
  Pass: the check runs (update-available 1.0.1).

## Session M — packaged macOS (one install, one hop)

- [ ] **M1. Packaged `allowInsecureFeed` warning** (#10566)
  - First run `node scripts/qa.mjs cache clear`; dev runs share the cache.
  - Install `server/updates/AutoUpdateProto-1.0.0-arm64.dmg` into /Applications, then run `QA_ALLOW_INSECURE=force QA_AUTO_INSTALL_EVENT=manual QA_AUTO_CHECK=1 /Applications/AutoUpdateProto.app/Contents/MacOS/AutoUpdateProto` and quit.
  - Pass: exactly one "autoUpdater.allowInsecureFeed is true in a packaged app" warning. With manual, nothing is staged.
- [ ] **M2. A real Squirrel.Mac update through the authenticated proxy** (#10581 #10477 #10478 #10595, Electron 44)
  - Run `node scripts/qa.mjs cache clear`, then launch normally and click Check.
  - Wait for `[updater:debug] nativeUpdater.update-downloaded`, click **Update on quit**, then relaunch.
  - Pass: the version line reads 1.0.1. In order, the debug log shows:
    - `Proxy server for native Squirrel.Mac: request without valid credentials rejected`
    - `Proxy server for native Squirrel.Mac: serving …`, after Squirrel retried with credentials
    - `nativeUpdater.update-downloaded`

    The first packaged mac update is a full download, as expected.

## Session W — Windows NSIS (Parallels VM; one install, two hops)

**Prep.** In an elevated PowerShell:
- `Get-AuthenticodeSignature "<share>\AutoUpdateProto Setup 1.0.1.exe" | fl Status,SignerCertificate` must show `Valid`. If it doesn't, report it: macOS osslsigncode signatures aren't covered by CI.
- Install 1.0.0 (per-user).
- Close the app, then delete the 3-line `updateManifestPublicKey: |-` block from `%LOCALAPPDATA%\Programs\autoupdate-proto\resources\app-update.yml`. This is unsigned-manifest mode, needed for W1–W6.

**Rules.**
- Launch from `cmd`: `set QA_…` then `"%LOCALAPPDATA%\Programs\autoupdate-proto\AutoUpdateProto.exe"`.
- Read results in `%APPDATA%\AutoUpdateProto\updater-qa.log` and the server log.
- After any download, click **Quit without updating**; never close the window, which would install on quit.
- Empty `%LOCALAPPDATA%\autoupdate-proto-updater\pending` between variants.
- Edit `app-update.yml` only while the app is closed.
- Swap manifests on the Mac with `node scripts/qa.mjs serve <name>`.

- [ ] **W1. nsis-web manifests** (#10601 #10576)
  - Serve `win-1.0.2-web` → expect `ERR_UPDATER_WEB_INSTALLER_DISABLED` ("Web Installers are disabled…", `#disablewebinstaller-defaults-to-true`).
  - Serve `win-web-wrong-arch` → expect `ERR_UPDATER_NO_WEB_PACKAGE_FOR_ARCH` ("…no app package for the arch …").
  - Both times the server logs only `GET /latest.yml`, and `pending` stays empty.
- [ ] **W2. Forged version, download path** (#10601). Serve `win-forged-1.0.2`: the 1.0.1 manifest with only `version:` changed.
  - Pass: a full download, "Verifying signature", then `ERR_UPDATER_INSTALLER_VERSION_MISMATCH` ("The installer of version 1.0.2 is rejected: its ProductVersion is "1.0.1"…"). There is no update-downloaded event, `pending` holds no `temp-*`, and the app is still 1.0.0.
- [ ] **W3. `autoUpdater.publisherName`** (#10600). Keep serving `win-forged-1.0.2` and check once per step:
  - (a) Delete the `publisherName:` lines → `ERR_UPDATER_INVALID_SIGNATURE` "…has no publisherName… autoUpdater.publisherName…", with no "Verifying signature".
  - (b) `set QA_PUBLISHER_NAME=CN=<your cert CN>` → "Verifying signature", then MISMATCH.
  - (c) `set QA_PUBLISHER_NAME=CN=Somebody Else` → "…signed with incorrect certificate…", `ERR_UPDATER_INVALID_SIGNATURE`.
  - (d) Restore the lines, keeping the wrong CN → MISMATCH (app-update.yml wins).
  - (e) Replace the lines with `verifyUpdateCodeSignature: false` and set the right CN → verified, then MISMATCH, with no "disabled" warning (the property wins over the opt-out).
  - (f) `set QA_PUBLISHER_NAME=` → a one-time "Signature verification … disabled" warning, and the forged update is accepted. This documents that no publisherName means no version check either.
  - Finally restore the original `publisherName` lines.
- [ ] **W4. Cache path** (#10601). Serve `v1.0.1`, check, and Quit without updating. Then serve `win-forged-1.0.2` and relaunch.
  - Pass: "Update has already been downloaded…", then MISMATCH, and the server logs no `.exe` GET.
- [ ] **W5. Next-launch path** (#10601 + doc). Serve `v1.0.1`, check, click **Update on next launch**. Then serve `win-forged-1.0.2` and relaunch.
  - Pass: "…marked for install on next launch, validating…", then `ERR_UPDATER_INSTALLER_VERSION_MISMATCH`, and the pending update is discarded.
  - The migration doc says `ERR_UPDATER_INVALID_SIGNATURE` instead (finding F2).
- [ ] **W6. Install at next launch with the default `autoInstallEvent`** (#10525), and the first genuine hop.
  1. Serve `v1.0.1`. Launch with `set QA_EXPLICIT_PENDING=0` and `set QA_NEXT_LAUNCH_EVENT=keep`, check, and click **Update on next launch**.
  2. Relaunch with `set QA_AUTO_INSTALL_EVENT=manual`.
  3. Relaunch with `set QA_AUTO_INSTALL_EVENT=`.
  - Pass:
    - After 1, `pending\update-info.json` has `"installOnNextLaunch":true`.
    - After 2, nothing is installed and the marker stays.
    - After 3, the update installs at launch with no `installPendingUpdateIfAvailable() on launch` line, and 1.0.1 starts. On alpha.13 it would have stayed pending.
- [ ] **W7. Signed hop to 1.0.2 into a folder with a space** (#10527 #10529 #10483; optional #10423 control)
  - The app is now 1.0.1 with a fresh, signed `app-update.yml`.
  - Serve `win-1.0.2`, set `QA_INSTALL_DIR=%LOCALAPPDATA%\QA Apps\AutoUpdateProto`, check, then **Update on quit**.
  - Pass:
    - "Update manifest signature verified…".
    - 1.0.2 runs from `QA Apps\AutoUpdateProto`.
    - `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall /s /f AutoUpdateProto` shows `InstallLocation` with no stray `"`.
    - The log-enabled stub (#10483) is checked in B3. The installer writes no `install.log` here (F19).
  - Optional control: on the Mac, re-sign the forged manifest and serve it:
    ```sh
    node scripts/qa.mjs serve win-forged-1.0.2
    pnpm exec electron-builder sign-update-manifest server/updates/latest.yml
    ```
    It is then accepted: a verified manifest skips the version check.
- [ ] **W8. Web installer started as an update without a package** (#10601). Copy `server/updates/AutoUpdateProto Web Setup 1.0.2.exe` into `C:\qa`.
  - `(Start-Process 'C:\qa\AutoUpdateProto Web Setup 1.0.2.exe' -ArgumentList '/S','--updated' -Wait -PassThru).ExitCode` → `2`, with no server request and the installed app untouched.
  - The same without `'/S'` → a message box linking `#an-nsis-web-installer-started-as-an-update-needs-a-package-file`, then `2`.
- [ ] **W9. Optional: portable launcher quoting** (#10591). The portable exe unpacks to `%TEMP%\QA Portable\`.
  - Copy any harmless exe to `%TEMP%\QA.exe` as a decoy.
  - Run `AutoUpdateProto 1.0.2.exe` (portable) and confirm the app starts, not the decoy.
  - Delete the decoy.
- [ ] **W10. Reinstall over the log-enabled 1.0.2 install** (#10483; findings F18, F19)
  - After W7, check that the QA Apps install dir has no `install.log` (F19).
  - Run `AutoUpdateProto Setup 1.0.2.exe /S` over the 1.0.2 install.
  - Record the exit code and the `Can't rename` line in `install.log`: exit 2 means F18 is still open, exit 0 means it is fixed. 1.0.2 stays installed either way.
  - The next W0 uninstalls this install plainly (without `--updated`, which works) before it installs 1.0.0.

## Session L — Linux VM

Before starting: socat forwarding is up (S5), and the Mac's `server/updates` holds the 1.0.0 and 1.0.1 AppImage and deb from B1/B2. Download them with `curl -O http://127.0.0.1:8080/<file>`.

- [ ] **L1. AppImage: install at next launch with the default event** (#10525 #10490)
  - `chmod +x AutoUpdateProto-1.0.0*.AppImage`
  - `QA_EXPLICIT_PENDING=0 QA_NEXT_LAUNCH_EVENT=keep QA_AUTO_CHECK=1 ./AutoUpdateProto-1.0.0*.AppImage`, then click **Update on next launch**.
  - Relaunch with `QA_EXPLICIT_PENDING=0`.
  - Pass: the AppImage is replaced in place at launch, and 1.0.1 runs.
- [ ] **L2. deb through pkexec** (#10577)
  - `sudo apt install ./autoupdate-proto_1.0.0_*.deb`
  - Run `/opt/AutoUpdateProto/autoupdate-proto` with `QA_AUTO_CHECK=1`, then **Update on quit**. Repeat once with `QA_ALLOW_UNVERIFIED_LINUX=0` after reinstalling 1.0.0.
  - Pass: the polkit dialog shows the command, and 1.0.1 runs afterwards.
  - The log says "Installing a local .deb with apt; apt verifies no signature on a local .deb file…". With `=0` it says "allowUnverifiedLinuxPackages=false does not verify the .deb itself…". Never the old claim that it verifies.
- [ ] **L3. Optional: unsafe installer path with gksudo** (#10524)
  1. `sudo mv /usr/bin/pkexec /usr/bin/pkexec.off`
  2. `printf '#!/bin/sh\ntouch /tmp/gksudo-ran\nexit 1\n' | sudo tee /usr/local/bin/gksudo >/dev/null && sudo chmod +x /usr/local/bin/gksudo`
  3. With 1.0.0 installed, run `XDG_CACHE_HOME="/tmp/qa o'brien" /opt/AutoUpdateProto/autoupdate-proto`, then check and **Update on quit**.
  4. Afterwards: `sudo mv /usr/bin/pkexec.off /usr/bin/pkexec && sudo rm /usr/local/bin/gksudo`
  - Pass: `ERR_UPDATER_UNSAFE_INSTALLER_PATH` naming `/tmp/qa o'brien/…/pending/…deb`, no `/tmp/gksudo-ran`, and the app is still 1.0.0. With pkexec restored, the same path installs.

## Session R — the release PR was regenerated again

1. In `../electron-builder-5`: `git fetch && git reset --hard origin/changeset-release/master && git diff 8a9b848f8..HEAD --stat -- packages/*/src packages/app-builder-lib/templates`, then `pnpm compile`. This is the same reset you already did for `8a9b848f8`.
2. Rerun B1 (normal cache), B5, B6, D1, D5, D13 and M2.
3. Rerun W or L only if `electron-updater/src`, `builder-util-runtime/src` or the NSIS templates changed.

## Coverage (every user-facing PR in range)

| Area | PR → check |
|---|---|
| Network trust | #10563 D1–D4 · #10566 D5 D6 D7 M1 B4 B6 · #10565 D7 · #10520 D2 D4 · #10568 D2 B4 B6 · #10584 B4 (B1 negative) · #10549 D7 · #10562 AUTO (httpExecutorTest, electronHttpExecutorRedirectTest) |
| Manifest | #10514 D8 · #10536 D8 + AUTO (yamlAliasBudgetErrorTest) · #10575 D8 · #10522 AUTO (providerTest) · #10508 D9 · #10530 D10 · #10484 AUTO (downloadedUpdateHelperTest) · #10423 B5 D10 W7 · #10582 B6 |
| Windows | #10601 W1 W2 W4 W5 W8 · #10600 W3 · #10576 W1 · #10527 W7 · #10529 W7 · #10483 B3 W7 · #10482 B1 · #10588 B3 · #10586 B1 + AUTO · #10591 W9 · #10590 #10526 #10479 #10587 #10592 AUTO |
| Download | #10580 D13 · #10497 D12 · #10506 D14 · #10579 #10511 #10512 #10513 #10515 #10517 D11 + AUTO · #10505 #10510 #10509 #10578 AUTO |
| Lifecycle / mac / Linux | #10525 W6 L1 · #10581 M2 · #10531 D15 + AUTO · #10524 L3 + AUTO (linuxUpdaterUnitTest) · #10577 L2 · #10585 AUTO · #10477 B1 M2 · #10475 #10490 #10481 B1 B6 L1 · #10480 n/a (superseded, #10603) · #10571 #10532 #10593 #10594 #10596 AUTO |
| Builder | release commit S1 B1 · #10478 #10595 B1 M2 · #10487 #10488 #10569 B1 + AUTO · #10504 #10534 #10597 #10598 AUTO · #10494 docs · 14 CI/test-only commits n/a |

## Findings (draft issue texts)

These came from the audit of the source at `09e5e383d`, re-checked against `8a9b848f8`. "Fixed by #10603" means it was fixed by the now-merged PR.

- **F1 — #10580 can leave `temp-*` in `pending/` after the size-cap abort** (high; **fixed by #10605**, in `f4df97d1c`)
  - Seen on master `c8c7cafaa`: `downloadSizeLimitTest.ts:196 › the installer` failed with `expected [ 'temp-TestApp-Setup-1.1.0.exe' ] to deeply equal []`, while the previous run passed.
  - Suspected cause: `configurePipes` opens the `createWriteStream` asynchronously. When the limit trips on the first chunk, the callback runs before the file exists, so `removeFileIfAny()` empties `pending/` and the late open then creates the temp file.
  - On Windows, unlinking a file that is still open can fail as well.
  - D13 checks for it. A fix is on branch `fix/download-size-cap-temp-file`.
- **F2 — doc: next-launch version mismatch error code** (medium; **fixed by #10636**). `v27-runtime-changes.md#nsis-update-installers-must-carry-the-updates-version` says a mismatch at the next launch fails with `ERR_UPDATER_INVALID_SIGNATURE`. `BaseUpdater.installPendingUpdate` dispatches `ERR_UPDATER_INSTALLER_VERSION_MISMATCH`, which nsisInstallerVersionTest and the commit message also expect.
- **F3 — blackbox e2e: Parallels VM mode is broken by #10566** (medium; **fixed by #10620**). `runTestWithinServer` serves `http://<parallels-host-ip>`, which is not loopback, and the fixture sets no `allowInsecureFeed`, so every VM update launch fails with `ERR_UPDATER_INSECURE_FEED`. Fixed on the e2e branch.
- **F4 — blackbox e2e never reaches Authenticode, `publisherName` or the ProductVersion check** (medium; **fixed by #10620**). Every served config is `{ verifyUpdateCodeSignature: false }`. Covered by the new NSIS e2e cases.
- **F5 — `sign-update-manifest` has no YAML-alias check** (medium; **fixed by #10631**)
  - `--verify` reports "verified" for a manifest that `electron-builder verify` fails for aliases.
  - Re-signing expands aliases silently (js-yaml dump with `noRefs`).
  - Yet cli.md and signed-update-manifests.md say it runs the same check as `electron-builder verify`.
- **F6 — URLs with their query still printed** (low; **fixed by #10632**). `ERR_UPDATER_ZIP_FILE_NOT_FOUND` (MacUpdater), `ERR_UPDATER_NO_CHECKSUM` and `ERR_UPDATER_NO_FILES_PROVIDED` (Provider) print file URLs including the query. That goes against #10568, though its list did not claim them.
- **F7 — migration links** (low; **fixed by #10634**). The packaged `allowInsecureFeed` warning and the three `login` warnings link `features/auto-update#…`, not a `migration/v27-*` page, as the project rule asks for behavior changes.
- **F8 — #10525 shipped as a patch with no runtime warning** (low; **documented by #10641**). An app that calls `installPendingUpdateIfAvailable()` after an `await` or a dialog is now pre-empted by the automatic install at launch, which quits the app.
- **F9 — changelog consistency** (low; the stray heading is **fixed by #10640**, the rest was withdrawn)
  - #10566 is Major in electron-updater, Minor in builder-util-runtime and in the root electron-builder section, and Patch in app-builder-lib.
  - The root CHANGELOG alpha.15 section re-lists #10036, #10270 and #10419, which shipped earlier.
  - `packages/electron-updater/CHANGELOG.md` starts with a stray `## 4.3.0` heading.
- **F10 — #10508 error code and changeset** (low; **fixed by #10633**: `ERR_UPDATER_RESPONSE_TOO_LARGE`, minor changeset). The error code is `ERR_HTTP_RESPONSE_TOO_LARGE`, not `ERR_UPDATER_*`, and the patch changeset adds API (`maxUpdateInfoSize`). The docs and the migration link are fixed by #10603.
- **F11 — #10480 vs #10475** (fixed by #10603). The contradictory linuxToolsMac 1.1.1 entry is gone from the regenerated changelog, and migrate-schema rewrites the appimage `1.2.0` pin. Only B6's report on a leftover `toolsets.linuxToolsMac` key is left to record.
- **F12 — #10600 docs** (low; **fixed by #10637**). `ERR_UPDATER_NO_PUBLISHER_NAME` is practically unreachable, because reading `app-update.yml` fails with `ENOENT` first. Also, the v27-build-changes "only opt-out" wording ignores `autoUpdater.publisherName`.
- **F13 — pre-existing: `latest*.yml` lists the dmg 6 times** (low; **fixed by #10639**). `writeUpdateInfoFiles` pushes into one `files` array that 3 channels × 2 publish configs share, and all of it is inside the signed payload. Harmless to MacUpdater.
- **F14 — docs** (low; **fixed by #10638**)
  - `auto-update.md#local-update-server` says an installed test build needs https, but a loopback port-forward also satisfies the code.
  - `migrate-schema` reads only literal `url` values in JS configs, so an env-driven URL gets no advisory.
- **F15 — `electron-builder publish -f` fails for any config with a `publish` list** (medium; already in alpha.14, not a regression; fix in **#10630, still open** on 2026-11-20)
  - `publishArtifactsWithOptions` loads the config, and `Packager.loadAndValidateConfig` loads the same file again with the first result as `configFromOptions`. The merge then breaks:
    - a JS config is the same `require`d object both times, so `publish` ends up containing itself, and `getSafeEffectiveConfig` throws "Converting circular structure to JSON";
    - JSON/YAML configs fail validation with "configuration.publish should be one of these: array | null | string".
  - Repro: an empty project with `publish: [{ provider: "generic", url }]` and `electron-builder publish -f any.txt`. It fails on published 27.0.0-alpha.14 and on `f4df97d1c` alike.
  - It also means the #10582 pre-upload warnings of `publish -f` (B6) cannot be seen for such projects.
- **F17 — e2e: a registered Windows Parallels VM hijacks every local mac blackbox case** (low, pre-existing, test-only; **fixed by #10635**)
  - `runUpdateScenario` (`test/src/updater/blackboxUpdateHelpers.ts`) passes the detected Windows VM to `handleInitialInstallPerOS`, `runTestWithinServer` and the scenario for every target, not only `nsis`.
  - `getWindowsVm` also starts a stopped or suspended VM.
  - So with any Windows VM in Parallels, the mac cases launch `TestApp.app` inside Windows through `prlctl exec … powershell` and fail. Seen locally for "arm64 - update request rules"; CI has no VM and is unaffected.
  - Fix: `const vm = target === "nsis" ? await windowsVmPromise : undefined`.
- **F18 — with `installerDebugLogging`, every update over a log-enabled install fails** (high for apps that turn it on; pre-existing since #6551 in 2022, made easy to reach by #10483; **fixed by #10627**)
  - `un.onInit` (uninstaller.nsh) runs `SetOutPath $INSTDIR` and `${LogSet} on`, so the old version's uninstaller keeps `$INSTDIR\install.log` open.
  - The installer always runs the old uninstaller with `--updated` (installUtil.nsh). On `--updated`, `un.atomicRMDir` renames every file in `$INSTDIR` into `$PLUGINSDIR\old-install`, including the open log. The rename fails, the files are restored, and the uninstaller aborts: `Can't rename "…\AutoUpdateProto" to "…\old-install".`
  - The installer exits with code 2 and the update is not installed. The first update into a log-enabled build works, because the old uninstaller is not log-enabled yet; every later one fails.
  - Seen in the Windows VM (W10): `AutoUpdateProto Setup 1.0.2.exe /S` over the 1.0.2 install, twice.
  - Fix idea: log to a file outside `$INSTDIR` in the uninstaller (for example `$TEMP` or `$PLUGINSDIR`), or `LogSet off` before `un.atomicRMDir`.
- **F19 — `installerDebugLogging` writes no installer log on a per-user one-click install** (medium; pre-existing since #6024; **fixed by #10628**)
  - `.onInit` (installer.nsi) runs `SetOutPath $INSTDIR` and `${LogSet} on` before `initMultiUser` sets `$INSTDIR`, and the template has no `InstallDir`. NSIS fixes the log path at that first `LogSet`, so (reading the NSIS source) it points at `\install.log` on the drive root, which a per-user installer cannot write; no such file appeared.
  - Only an unquoted `/D=` without spaces sets `$INSTDIR` before `.onInit`. electron-updater quotes `/D=` for a path with a space, so updates never get one.
  - Seen in the Windows VM: a fresh `/S` install and W7's updater install wrote no `install.log`. The only `install.log` comes from the uninstaller (F18).
  - Fix idea: call `${LogSet} on` after `initMultiUser`, once `$INSTDIR` is final.
- **F20 — on macOS, Windows signing with a password-protected pfx always fails** (high for anyone signing Windows builds on a Mac with a password; pre-existing since win-codesign 1.3.1, #10414; still in 1.3.3)
  - Every osslsigncode run fails with `Failed to read key or certificates` and `UI routines:open_console:unknown ttyget errno value … errno=102`, then the build fails.
  - Cause: electron-builder starts osslsigncode with `execFile`, whose stdin on macOS is a socketpair (libuv). With a password, OpenSSL's PKCS#12 loading opens its console UI, whose `tcgetattr` on a socket fails with `EOPNOTSUPP` (102), an errno `ui_openssl.c` does not tolerate (it does for a pipe's `ENOTTY`). The right `-pass` never gets used.
  - Repro with the bundled binary: from Node, `spawnSync(osslsigncode, ["sign", …, "-pkcs12", pfx, "-pass", pw], { stdio: ["pipe", …] })` fails; with stdin `"ignore"`, `"inherit"` or a shell pipe it succeeds. An empty-password pfx works either way.
  - Seen in session B (B1–B3) with `~/qa-cert/qa-pw.pfx`; it also explains the earlier "signing fails in my shell" runs.
  - Fix idea: spawn osslsigncode with stdin `/dev/null` (`stdio: ["ignore", "pipe", "pipe"]`) in `SigntoolBaseSignManager.doSign` (and the other osslsigncode calls), or pass the password with `-readpass` from a temp file.
  - Harness workaround: sign with `~/qa-cert/qa.pfx` (same certificate, empty password).
