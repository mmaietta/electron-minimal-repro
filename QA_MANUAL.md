# QA manual: running the regression scripts

This is how to run the QA for electron-updater 7.0.0-alpha.14 and electron-builder 27.0.0-alpha.15. The scripts in `qa/run/` run every check in `QA_TEST_PLAN.md` without clicks, and the #10620 e2e cases as well. This manual lists what you set up once, the commands in order, and the few steps that need you.

**Under test:** the release commit checked out in `../electron-builder-5` (`changeset-release/master`, `a483c9a74` on 2026-11-20, after the QA-findings fixes; `f4df97d1c` before). Test the release commit, not master: master's versions are not bumped, and B4 depends on electron-updater's version. The scripts print the commit they run against.

## What runs by itself and what needs you

| Session | Command | Time | Needs you |
|---|---|---|---|
| Setup S1–S5 | `node qa/run/setup.mjs` | 3–5 min | P2 (Windows certificate), P3 (firewall prompt), S2 when CI is red |
| B: builds + CLI | `node qa/run/session-b.mjs` | 45–60 min | Keychain prompts on the first mac signing (P2) |
| D: dev mode | `node qa/run/session-d.mjs` | about 12 min | Nothing |
| M: packaged mac | `node qa/run/session-m.mjs` | about 5 min | M: watch for a Gatekeeper or keychain dialog |
| W: Windows VM | `node qa/run/session-w.mjs` | 30–45 min | W8: look at one message box. Afterwards, the W cleanup |
| L: Linux VM | `node qa/run/session-l.mjs` | 15–20 min | L2: type the VM password twice. L3: optional |
| E: e2e (#10620) | `node qa/run/e2e.mjs` | 1 h+ | E6: start Docker. E-auth: only if CI skipped it |

`node qa/run/all.mjs` runs them all in this order and stops at the first session with a FAIL. `--keep-going` keeps going, and `--from W` starts at W.

Every runner takes these flags:
- `--list` shows its checks.
- `--only D2,D5` runs some of them.

Each runner prints PASS / FAIL / SKIP / MANUAL per check and writes `qa-logs/results-<session>-<time>.json`. The app and server output of every launch is saved in `qa-logs/<session>/<check>-<n>-<label>.log`.

## P. Prerequisites (once)

**P1. Shell.**
- Run everything from this repo's root, in a terminal outside the IDE. The scripts remove `ELECTRON_RUN_AS_NODE` themselves.
- `gh auth status` must be logged in: S2, E1 and E2 read GitHub Actions.

**P2. Signing.** Set these in the shell that runs session B:
```sh
export ELECTRON_BUILDER_UPDATE_SIGN_KEY_FILE=$PWD/keys/update-private-key.pem   # every published manifest is signed with it
export WIN_CSC_LINK=<path to .pfx> WIN_CSC_KEY_PASSWORD=<password>               # Windows; WIN_CSC_LINK, not CSC_LINK
```
- **macOS:** a "Developer ID Application" identity in the login keychain signs the mac build. `security find-identity -v -p codesigning` lists what is there. On 2026-11-17 it showed only "Apple Development: …", so install the Developer ID certificate first, or M2 (Squirrel.Mac) can fail on the signature.
- **First mac signing:** click "Always Allow" on the keychain prompt for `codesign`. Otherwise B1 waits on it.
- **Use a pfx with an empty password on macOS** (`WIN_CSC_KEY_PASSWORD=`, for example `~/qa-cert/qa.pfx`). With a password, every osslsigncode run fails with `UI routines:open_console:unknown ttyget errno value … errno=102` (finding F20, QA_TEST_PLAN.md).
- **The Windows certificate is required.** electron-builder 27 refuses to build an updatable Windows app without one ("Cannot write app-update.yml without publisherName: no code signing certificate is configured", #10600). Without it, B1–B3 fail for Windows and session W has nothing to install.
- **No Windows certificate:** make a self-signed one with the recipe in QA_TEST_PLAN.md S4. Then also set `export QA_WIN_CER=$HOME/qa-cert/qa.cer`: session W imports it into the VM's `LocalMachine\Root`, and W-cleanup removes it.
- **Rebuilding one platform:** `QA_PLATFORMS=win node qa/run/session-b.mjs --only B1,B2,B3` rebuilds only that platform. The others' checks are skipped.

**P3. Firewall.** Sessions W and L run the update server on all interfaces. The first time, macOS may ask whether node may accept incoming connections: click **Allow**. If you missed it, go to System Settings › Network › Firewall › Options and allow `node`. `node qa/run/setup.mjs --only S5` checks that both VMs reach the Mac.

**P4. VMs.**
- "Windows 11 (1)" and "Ubuntu 24.04 ARM64" are running, each with a user logged in to the desktop.
- Other VM names: set `QA_WIN_VM` and `QA_LINUX_VM`.
- The scripts drive the VMs with `prlctl exec`, so Parallels Tools must be running in both. Run every command on the Mac, including sessions W and L: a clone of the harness inside a VM has no `../electron-builder-5` and no `prlctl`.
- You need the Ubuntu user's password (`parallels`) for L2.

**P5. Docker Desktop**, only for E6 (AppImage e2e). Start it before `node qa/run/e2e.mjs --only E6`.

## Run order

1. `node qa/run/setup.mjs --fresh`. Use `--fresh` only the first time: it moves the old `dist/` and `server/updates/*` to `~/qa-backup/`.
   - **S2 FAIL:** read the failed jobs it lists. If they are all "Apple timestamp outage (infrastructure)", re-run them with the `gh run rerun <id> --failed` command it prints, then re-run S2.
2. `node qa/run/session-b.mjs`. It builds mac, Windows (arm64) and Linux (arm64) 1.0.0, 1.0.1 and the extras, and runs B4–B6.
   - Use `QA_ARCH=x64` for x64 VMs.
   - `--skip-builds` re-checks the logs of the last build run.
3. `node qa/run/session-d.mjs`.
4. `node qa/run/session-m.mjs`. Then do step M below.
5. `node qa/run/session-w.mjs`. Then do steps W8 and W-cleanup below.
6. `node qa/run/session-l.mjs`. Do step L2 below while it runs.
7. `node qa/run/e2e.mjs`. Then do E6 and E-auth below if they report MANUAL.

## Steps that need you

### M — packaged mac

While `session-m.mjs` runs, nothing should appear on screen except the app's window, opening and closing.
1. If a Gatekeeper dialog appears ("…cannot be opened", "…downloaded from the Internet"), note it and click Cancel: that's a FAIL of the signing, not of the updater.
2. If a keychain dialog appears, note what asked.
3. The runner removes `/Applications/AutoUpdateProto.app` at the end. `--keep-app` keeps it.

### W8 — the web installer's message box

1. In the Windows VM, open PowerShell and run:
   ```powershell
   Start-Process 'C:\qa\AutoUpdateProto Web Setup 1.0.2.exe' -ArgumentList '--updated' -Wait -PassThru | Select-Object ExitCode
   ```
2. A message box appears. **Pass:** it says the installer was started as an update without a package file, and it links `…#an-nsis-web-installer-started-as-an-update-needs-a-package-file`.
3. Click OK. **Pass:** `ExitCode` is `2`, and the installed app is untouched.

### W-cleanup — after session W

1. If `QA_WIN_CER` was set, remove the certificate. In an elevated PowerShell in the VM:
   ```powershell
   Get-ChildItem Cert:\LocalMachine\Root | Where-Object Subject -eq 'CN=AutoUpdateProto QA' | Remove-Item
   ```
2. Optionally remove the port-forwards: `netsh interface portproxy reset`.
3. Optionally uninstall AutoUpdateProto: Settings › Apps. The W7 install lives in `%LOCALAPPDATA%\QA Apps\AutoUpdateProto`.

### L2 — the polkit password

Run `session-l.mjs` on the Mac. It prints `>>> L2 default: a polkit password dialog will appear …` twice, and the dialog appears in the VM.
1. Switch to the Ubuntu VM window. A polkit dialog asks for authentication to run `apt`/`dpkg`. **Pass:** the dialog shows the command it runs.
2. Type the password of user `parallels` and click Authenticate. The runner waits up to 5 minutes for 1.0.1 to be installed.
3. Repeat for the second run (`unverified-0`).

The runner checks the apt log line and the installed version itself.

### L3 — optional second half

After L3 passes (gksudo refused the unsafe path), you can check that the same path installs with pkexec:
1. Launch the app in the VM with the path:
   ```sh
   XDG_CACHE_HOME="/tmp/qa o'brien" QA_AUTO_CHECK=1 QA_AFTER_DOWNLOAD=on-quit /opt/AutoUpdateProto/autoupdate-proto
   ```
2. Answer the polkit dialog.
3. **Pass:** `dpkg-query -W autoupdate-proto` shows 1.0.1.

### E6 — AppImage e2e in Docker

1. Start Docker Desktop and wait until `docker info` answers.
2. Run `node qa/run/e2e.mjs --only E6`. It builds the `appimage-updater-test` image for this Mac's arch (arm64) and runs the case.
3. It then restores the snapshot file that the arm64 run writes into, so electron-builder-5 stays clean.
4. CI runs this case on x64; see E1/E2.

### E-auth — the elevated Authenticode case

E1/E2 show whether CI ran `blackboxNsisAuthenticode` or skipped it. On 2026-11-17 it ran on test-windows (shards 5 and 6) and passed. You only need this when E1/E2 report it as MANUAL (skipped):
1. In the Windows VM, open PowerShell **as Administrator**.
2. Run:
   ```powershell
   git clone https://github.com/electron-userland/electron-builder.git C:\eb; cd C:\eb; git checkout <release commit>
   corepack enable; pnpm install --frozen-lockfile; pnpm compile
   $env:TEST_FILES = "blackboxNsisAuthenticode"; pnpm ci:test
   ```
   Do not set `CSC_LINK` or `WIN_CSC_LINK`: the case skips with a provided certificate.
3. **Pass:** `1 passed`. It adds the test certificate to `LocalMachine\Root` and removes it again, and fails if the removal does not work.

## Reading a FAIL

1. **Find the failure.** The runner prints each failed assertion with up to 5 evidence lines. The JSON report has all of them.
2. **Open the launch log.** `qa-logs/<session>/<check>-*.log` holds the app's stdout (or, for the VMs, the new part of `updater-qa.log`) and the update server's request log. Request lines show `hdr=[…]` and `q=[…]` names, never values.
3. **Rerun the check alone:** `node qa/run/session-d.mjs --only D7`. The harness is restored after every run: v1.0.1 served, the dev key off, the cache empty, and the package.json version as it was.

**What a FAIL means for the findings in QA_TEST_PLAN.md:**
- A leftover `temp-*` in D13/W2 means F1 is back (#10605 should have fixed it).
- W5 shows the real error code; the migration doc still says `ERR_UPDATER_INVALID_SIGNATURE` (F2).
- B6 notes "sign-update-manifest --verify … reports verified" for the aliased manifest: F5 is still open.
- B6 "publish -f runs at all" fails with "Converting circular structure to JSON": F15, already in alpha.14.
- W10 notes "fails (finding F18 still open)": an update over an install built with `installerDebugLogging` exits with code 2. It also notes F19 (no installer `install.log`). Both are pre-existing.

**Known local limits (not failures of the release):**
- D15 is skipped while `~/Development/.pnp.cjs`, a stray Yarn Plug'n'Play manifest, sits above this repo: esbuild resolves through it. Move it aside to run D15; `autoUpdaterBundleTest` covers it in CI anyway.
- E4 (mac e2e) adds untracked entitlements files that turn off library validation for the self-signed test app, because this Mac refuses to launch it otherwise. It deletes them afterwards.
- Session L stops before L2/L3 when something in the VM holds the dpkg lock. On 2026-11-17 two `aptd` processes (a stuck background software update) had held it for over 3 hours. The runner prints the processes. Finish or cancel that update in the VM's Software app, or run `sudo systemctl stop aptd`, then re-run L.
- E4 (the mac e2e case) is skipped while a Windows VM is registered in Parallels. The e2e helper would launch the mac app inside it (finding F17). CI covers the case (E1); `--force-mac-e2e` runs it anyway.
- On 2026-11-18 a `/S` installer started in the Windows VM by hand hung for over 20 minutes in its "is the app running" check. Its child `powershell.exe … Get-CimInstance Win32_Process …` spun the CPU and could not be ended, even as SYSTEM. The same query takes 0.06 s from a normal shell, and the installs the updater started in W6/W7 did not hang. If W0, W7 or W10 times out like that, restart the Windows VM and re-run W.
- E5 first checks that the Windows VM reaches the address the e2e helper serves the feed on (the first `prl*`/`bridge*` interface). If it stops there, give the VM the Mac's shared network, or remove the extra Parallels networks.
