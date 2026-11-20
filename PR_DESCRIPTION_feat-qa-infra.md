### Summary

This branch turns the harness into a QA rig for electron-updater 7.0.0-alpha.14 and electron-builder 27.0.0-alpha.15. The release is tested from the linked electron-builder checkout, release commit `a483c9a74` (`changeset-release/master` on master `10f6f710a`, after the QA-findings fixes).
- `QA_TEST_PLAN.md` is the test plan: about 35 checks in 6 sessions, a coverage table for every PR in range, and the findings.
- `qa/run/` runs those checks without clicks, on the Mac and in the Parallels VMs.
- `QA_MANUAL.md` covers the one-time setup, the run order, and the few steps that need a person.

**`package.json`** (first commit, linking the local checkout):
- `pnpm.overrides` link every builder package to `../electron-builder-5/packages/*`.
- The version is 1.0.1.

**`main.js`**
- `autoUpdater.crossOriginHeaders` now defaults to `() => []` instead of `(headers) => headers`. The old line sent `Authorization` and custom headers to every origin, and it hid the alpha.14 "property is required" error.
- `QA_*` environment toggles, all applied synchronously before `ready`:
  - cross-origin policy variants: `unset`, `array`, `none`, `tenant`, `all`, `throw`, `bad`; each hop is logged with the offered header names
  - `QA_AUTH` (an auth header plus a custom header)
  - `QA_FEED` (`setFeedURL`), `QA_CHANNEL`, `QA_FORCE_DEV`
  - `QA_ALLOW_INSECURE` (`dev` or `force`)
  - `login` handler variants: `origin` answers only the feed's origin, plus `none`, `legacy`, `throw` and `hang`
  - `QA_MAX_UPDATE_INFO_SIZE`. The setter's validation error is logged and ends the run, instead of crashing the app at load.
  - Windows: `QA_PUBLISHER_NAME`, `QA_INSTALL_DIR`, `QA_CUSTOM_VERIFIER`
  - `QA_ALLOW_UNVERIFIED_LINUX`
  - install modes: `QA_AUTO_INSTALL_EVENT`, `QA_NEXT_LAUNCH_EVENT=keep`, and `QA_EXPLICIT_PENDING=0`, which skips the startup `installPendingUpdateIfAvailable()` so #10525's install at launch can be observed
  - `QA_CANCEL_AFTER_MS`, which cancels the download through the `cancellationToken` that `checkForUpdates()` returns
  - `QA_AUTO_CHECK=1`, which checks once the window has loaded
- Unattended runs:
  - `QA_AFTER_DOWNLOAD=skip|on-quit|next-launch` runs the matching install button's code on `update-downloaded`. The `updater:install` IPC handler became `install(mode)`, which both use. On a packaged Mac it waits for Squirrel.Mac's own `update-downloaded`: MacUpdater emits its event before Squirrel has fetched the update.
  - `QA_EXIT_WHEN_DONE=1` quits once the check settles: error, not available, cancelled, downloaded, or updater inactive. It logs `[qa] done: <reason>` first. `QA_EXIT_AFTER_MS` is the safety exit.
- An unpackaged run defaults `autoInstallEvent` to `"manual"`, so dev runs no longer hand downloads to Squirrel.Mac.
- Every log line and `error` event is also appended to `<userData>/updater-qa.log`. The `error` event forwards the error itself, and the info line shows the active toggles and the log path.

**`server/update-server.mjs`**
- The log line shows the Host, the request header and query parameter names (never values), the body bytes sent, and `ABORTED` when the client hangs up.
- New flags:
  - `--redirect-match/--redirect-to/--redirect-status`
  - `--auth <regex>`: Basic `qa:secret`, otherwise 401 with `WWW-Authenticate`
  - `--throttle-kbps`
  - `--extra-bytes <file>:<n>`
- Each response body is a single stream piped once. Before, the multipart branch stacked listeners past 10 ranges. The framing is byte-identical across 200 ranges.

**`electron-builder.js`**
- `QA_WIN_TARGETS` defaults to `nsis,portable`. `squirrel` writes no `app-update.yml`, but it can still be built.
- `QA_WEB=1` adds `nsis-web`.
- `QA_NSIS_LOG=1` sets `nsis.installerDebugLogging`.
- `QA_BLOCKMAP` sets the blockmap format.
- `QA_SCAN_PROBE=1` builds only `qa/probe-main.js` into `dist-probe/`.
- Linux builds AppImage + deb (with a placeholder maintainer), and portable gets `unpackDirName: "QA Portable"`.

**`scripts/`**
- `release.mjs` passes `--x64/--arm64/--ia32/--universal` through.
- `publish-copy.mjs` also copies `.deb` and `.rpm`.
- `scripts/qa.mjs`:
  - `archive`, `version`, `stash/serve`, `stash-dist`
  - `manifests` (generated qa channel files, forged Windows manifests)
  - `stash` leaves out the `qa-*.yml` channel files. They are derived from the v1.0.1 stash, so a stashed copy went stale after a rebuild, and every `serve v1.0.1` then put the stale copy back (D2, D4 and D8 failed with `ERR_UPDATER_DOWNLOAD_SIZE_EXCEEDED`).
  - `shrink-size`, `dev-key on|off`, `public-key`
  - `cache clear|seed|corrupt-v2|path`
  - `pending` (exits 1 on a leftover `temp-*`)
  - `scratch`

**`qa/run/`: the regression runners** (zero dependencies). Each takes `--list` and `--only <ids>`. Each prints PASS/FAIL/SKIP/MANUAL per check, keeps every launch's output in `qa-logs/<session>/`, and writes `qa-logs/results-<session>-<time>.json`.
- `lib.mjs`:
  - update servers with a parsed request log;
  - app launches with the unattended toggles, using the Electron binary itself so a timeout cannot leave the app running;
  - checks with evidence, and the report;
  - preflight (compiled dist markers, free ports on both 127.0.0.1 and 0.0.0.0, packaged builds newer than `main.js`). On macOS a probe on 127.0.0.1 still binds while another server holds 0.0.0.0, so that case slipped through and the server then crashed with `EADDRINUSE`;
  - a harness restore after every session: v1.0.1 served, the dev key off, the cache empty, the version back.
- `vm.mjs`: drives the Parallels VMs with `prlctl exec`.
  - prlctl joins its arguments into one command line, so PowerShell goes as `-EncodedCommand` and bash as base64.
  - It runs in the user's session or as SYSTEM/root, adds the Ubuntu desktop's display and Xauthority, and retries prlctl's occasional `PrlJob_GetResult` failure once.
  - It forwards loopback ports to the Mac (`netsh portproxy`, `socat`), so the baked-in `http://127.0.0.1:8080/` feed stays loopback.
- `setup.mjs` (S1–S5):
  - compile + markers;
  - the CI gate, which names Apple timestamp outages and prints the rerun command;
  - `--fresh` archive;
  - the Windows signing input;
  - the VM port-forwards and reachability.
- `session-b.mjs` (B1–B6):
  - B1–B3 builds for mac and arm64 Windows/Linux, with their log checks. `QA_PLATFORMS` builds a subset; `--skip-builds` re-checks earlier logs.
  - B3 also checks that the 1.0.2 nsis and nsis-web installers carry the log-enabled NSIS stub (the UTF-16 `install.log` name) and that 1.0.1 does not (#10483).
  - B2 also checks that each `latest*.yml` lists every file once (F13).
  - B4 build warnings.
  - B5 the 7 `sign-update-manifest` steps.
  - B6 `verify`, `sign-update-manifest --verify` (must fail the aliased manifest with verify's message: F5), `publish -f` to a throwaway server (fails until F15's fix merges), and `migrate-schema`.
- `session-d.mjs` (D1–D15): dev mode against two local origins. It asserts on the app's output and both servers' request logs: headers by name, query names, status, bytes, aborts.
  - D7 checks that the three `login` warnings link `v27-runtime-changes#update-credentials-stay-on-the-feeds-origin` (F7).
  - D9 expects `ERR_UPDATER_RESPONSE_TOO_LARGE` (F10), with a 256-byte limit: `latest-mac.yml` is about 700 bytes now that F13's fix lists the dmg once, so 1024 no longer trips.
- `session-m.mjs` (M1–M2): installs the dmg into /Applications, then:
  - M1: the packaged `allowInsecureFeed` warning, which links `v27-runtime-changes#update-requests-require-https` (F7);
  - M2: a Squirrel.Mac update through the authenticated proxy, then a relaunch at 1.0.1.
- `session-w.mjs` (W0–W10), in the Windows VM:
  - Authenticode of the installer, a plain uninstall of any earlier install, and a silent per-user install;
  - `app-update.yml` edits for unsigned-manifest mode and the publisherName variants;
  - the forged-version paths at download, cache and next launch;
  - install at next launch (#10525);
  - the signed hop into a folder with a space (registry, `install.log`);
  - the web installer's exit code 2, and the portable launcher;
  - W10: a reinstall over the log-enabled 1.0.2 install. It asserts that W7's install wrote `install.log` in the install folder (F19) and that the reinstall exits 0 (F18).
  - Installed versions are compared without the fourth part of the Windows `ProductVersion` (`1.0.1.0`).
- `session-l.mjs` (L1–L3), in the Ubuntu VM:
  - L1: AppImage install at next launch;
  - L2: deb through pkexec, where the person answers polkit;
  - L3: the gksudo unsafe-path refusal, with pkexec restored afterwards. It stops early when the VM's dpkg lock is held. The stub gets `chmod 755`: root's umask under `prlctl exec` is 077, so `chmod +x` left it unusable for the app's user.
  - L1 also ends the extracted AppImage the updater restarted, so it can't log into the next check's output.
- `e2e.mjs` (E1–E6), the #10620 e2e cases:
  - E1/E2 read the GitHub Actions job logs of master's #10620 merge and of the checkout's commit: each new file ran, on which job, and did not fail. E2 also expects `blackboxNsisDebugLogging` (F18's e2e case). The jobs list is read in pages of 50: `per_page=100` answers 502 for #10620's 64-job run.
  - E3–E6 run locally: the harness/generator unit tests, the mac case (no longer skipped with a Windows VM registered, now that F17 is fixed), the NSIS cases including `blackboxNsisDebugLogging` in Parallels VM mode, and the AppImage case in Docker. Nothing is left in the checkout.
- `all.mjs`: setup → B → D → M → W → L → e2e. It stops at the first FAIL unless `--keep-going`.

**Docs**
- `QA_TEST_PLAN.md` is retargeted to `a483c9a74`, the release commit after the QA-findings fixes:
  - Each finding names the PR that fixed it. F15 (#10630) is still open.
  - Test the release commit, not master: master's electron-updater is still `7.0.0-alpha.13`, below the version gate of B4's missing-crossOriginHeaders warning.
  - New finding F20: on macOS, Windows signing with a password-protected pfx always fails. electron-builder starts osslsigncode with a socketpair stdin, and OpenSSL's console UI aborts on `tcgetattr` (`EOPNOTSUPP`, errno 102). It is pre-existing since win-codesign 1.3.1.
  - D9 uses a 256-byte limit.
- Earlier, at `f4df97d1c`:
  - F1 is fixed by #10605; F3 and F4 by #10620.
  - New findings:
    - F15: `publish -f` breaks on a `publish` list.
    - F17: a registered Windows VM hijacks local mac e2e cases.
    - F18: with `installerDebugLogging`, every update over a log-enabled install fails. The old uninstaller holds `$INSTDIR\install.log` open while it moves `$INSTDIR` aside.
    - F19: the installer turns on logging before `$INSTDIR` is set, so it writes no `install.log`.
  - W7 no longer expects `install.log`; W10 is added.
  - The B1 toolset check reads the download labels and the cold cache: there is no "using toolset" log line.
- `QA_MANUAL.md` (new). It covers what W10's notes mean, what to do when a hand-started installer hangs in the VM's app-running check, and that Windows signing on macOS needs an empty-password pfx (F20).
- `README.md`: the VM recipe uses a loopback port-forward; the "unsigned builds" note is corrected; QA toggles and "Running the QA scripts" sections are added.
- `.gitignore`: `dist-probe/`, `qa-scratch/`, `qa-logs/`.

### Commits

1. Link builder packages to the local electron-builder-5 checkout
2. Add QA toggles and a file log to the app
3. Add QA flags to the update server
4. Add QA build knobs
5. Add scripts/qa.mjs QA helper
6. Add the alpha.14/alpha.15 QA test plan and fix the README VM recipe
7. Add unattended-run toggles to the app
8. Add the QA runner library and Parallels VM driver
9. Report an invalid QA_MAX_UPDATE_INFO_SIZE instead of crashing at load
10. Add the setup, session B and session D runners
11. Add the e2e runner for the #10620 cases and the run-all script
12. Add the session M, W and L runners
13. Wait for Squirrel.Mac before an unattended mac install; fix runner checks
14. Add the QA manual and retarget the test plan to f4df97d1c

### Verification (macOS arm64, release commit `a483c9a74`, 2026-11-20)

- **Setup:** S1 compiles the checkout; S2 finds CI green for `a483c9a74` (and for master `10f6f710a`); S4 and S5 pass.
- **Session B:** B1–B5 pass for mac and arm64 Windows/Linux. That includes F13 (each file listed once) and F5 (`sign-update-manifest --verify` now fails the aliased manifest). B6 fails only on F15: `publish -f` still crashes with "Converting circular structure to JSON" until #10630 merges.
  - With the password-protected `qa-pw.pfx`, every Windows build failed at osslsigncode (F20). The run above signs with `qa.pfx`: the same certificate, with an empty password.
  - On master `10f6f710a` itself, B4 fails because master's electron-updater version is below the warning's gate, so the run uses the release commit.
- **Session D:** 14 PASS, 1 SKIP (D15, the stray `~/Development/.pnp.cjs`). D7 (F7 links) and D9 (`ERR_UPDATER_RESPONSE_TOO_LARGE`, F10) pass.
- **Session M:** M2 passes (a real Squirrel.Mac update to 1.0.1). M1's checks, including its F7 link, pass; the Gatekeeper-dialog check is left to a person.
- **Session W:** W0–W5 and W9 pass, and W8 leaves its message-box check to a person. W6 failed: the 1.0.1 installer that the updater started at launch hung in its app-running check (`Get-CimInstance Win32_Process`), next to the powershell that has been stuck there since 2026-11-18 (44 CPU-hours). WMI in the VM is wedged, and the template's check is unchanged since `f4df97d1c`. W7 and W10 (F18, F19) were skipped because they depend on W6. They need a VM restart and a rerun.
- **Session L:** L1 passes; L3's checks pass. L2 needs a person for polkit.
- **e2e:**
  - E1 and E2: every new file ran on its intended CI job and passed, both on #10620's merge and on `a483c9a74`, including `blackboxNsisAuthenticode` and `blackboxNsisDebugLogging` on test-windows.
  - E3: 55 passed.
  - E4 passes with the Windows VM registered (F17 fixed).
  - E5 not run (the wedged VM would hang its installers); E6 not run (Docker is not running).

### Design notes

- **Toggles over rebuilds:** one packaged build per platform and version covers every variant through environment variables, server flags and manifest swaps.
- **The runners assert on evidence, not on screenshots:**
  - the app's own log lines, ended by `[qa] done: <reason>`;
  - the server's request lines (header and query names, status, bytes, aborts);
  - files on disk (pending dir, installed versions, registry).
- **Relaunches that test the install at launch run with `QA_AUTO_CHECK=0`.** Otherwise the launch's own check finds the cached download and quits before the updater installs it.
- **Exact texts come from the compiled updater,** for example `Staging percentage: 0.5,`, the ASCII `EBB3` magic of a v3 blockmap, and the v2 format-change message.
- **No changeset:** this repo has no changesets setup.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
