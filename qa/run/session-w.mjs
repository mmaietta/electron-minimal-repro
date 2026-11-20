#!/usr/bin/env node
// Session W (QA_TEST_PLAN.md): Windows NSIS in the Parallels VM, driven from the Mac with prlctl exec. The Mac serves
// the updates; the VM reaches them on its own 127.0.0.1:8080 through a portproxy (setup S5), so the baked-in feed stays
// loopback. One install of 1.0.0, then two genuine hops (1.0.0 → 1.0.1 in W6, 1.0.1 → 1.0.2 in W7).
//
//   node qa/run/session-w.mjs [--list] [--only W1,W2]
//
// Needs from session B: the signed arm64 (QA_ARCH) Windows 1.0.0/1.0.1 builds, stashes v1.0.1, win-1.0.2,
// win-1.0.2-web, win-forged-1.0.2 and win-web-wrong-arch. A self-signed certificate must be trusted in the VM's
// LocalMachine\Root first (setup S4 / QA_MANUAL.md P2): the runner imports qa.cer when QA_WIN_CER points at it.
import fs from "node:fs"
import path from "node:path"
import { checkLinkedDist, createSession, harnessRestorer, qa, requireFreePorts, requireBuildsNewerThanMainJs, requirePreflight, startServer, stashExists, updatesDir } from "./lib.mjs"
import { forwardWindowsPorts, psq, vmState, win, WIN_VM, windowsReaches } from "./vm.mjs"

const session = createSession("W", "Windows NSIS in the Parallels VM")
const INSTALL_DIR = "$env:LOCALAPPDATA\\Programs\\autoupdate-proto"
const APP_EXE = `${INSTALL_DIR}\\AutoUpdateProto.exe`
const APP_YML = `${INSTALL_DIR}\\resources\\app-update.yml`
const PENDING = "$env:LOCALAPPDATA\\autoupdate-proto-updater\\pending"
const QA_LOG = "$env:APPDATA\\AutoUpdateProto\\updater-qa.log"
const WORK = "C:\\qa"
const QA_APPS_DIR = "$env:LOCALAPPDATA\\QA Apps\\AutoUpdateProto"
let server = null

// PowerShell snippet: download a file the Mac serves into C:\qa
const fetch = file => `New-Item -ItemType Directory -Force ${WORK} | Out-Null; Invoke-WebRequest -UseBasicParsing ("http://127.0.0.1:8080/" + [uri]::EscapeDataString(${psq(file)})) -OutFile (Join-Path ${WORK} ${psq(file)})`

function ps(t, label, script, options) {
  const result = win(script, options)
  if (label != null) t.save(result.out, label)
  return result
}

// Launches the installed app in the user's session with QA toggles and waits for it to quit. Returns the new part
// of updater-qa.log, plus the server's requests made during the launch.
function launch(t, label, env = {}, { exe = APP_EXE, timeoutMs = 300_000 } = {}) {
  server.clear()
  const envLines = Object.entries({ QA_AUTO_CHECK: "1", QA_EXIT_WHEN_DONE: "1", QA_EXIT_AFTER_MS: String(timeoutMs - 20_000), ...env })
    // a value with $env:… is expanded by PowerShell (paths under the user's profile), anything else is literal
    .map(([key, value]) => `$env:${key} = ${value.includes("$env:") ? `"${value}"` : psq(value)}`)
    .join("\n")
  const result = win(
    `Get-Process AutoUpdateProto -ErrorAction SilentlyContinue | Stop-Process -Force
$log = "${QA_LOG}"
$before = if (Test-Path $log) { (Get-Item $log).Length } else { 0 }
${envLines}
$p = Start-Process -FilePath "${exe}" -PassThru
$quit = $p.WaitForExit(${timeoutMs})
if (-not $quit) { Stop-Process -Id $p.Id -Force; "QA-RUN: timed out" }
Start-Sleep -Seconds 2
if (Test-Path $log) { $all = [IO.File]::ReadAllBytes($log); [Text.Encoding]::UTF8.GetString($all, [Math]::Min($before, $all.Length), $all.Length - [Math]::Min($before, $all.Length)) }`,
    { timeoutMs: timeoutMs + 60_000 },
  )
  t.save(`${result.out}\n--- Mac server\n${server.lines().join("\n")}`, label)
  t.ok(!result.out.includes("QA-RUN: timed out"), `${label}: the app quit by itself`)
  return { out: result.out, requests: server.requests() }
}

// ProductVersion is four-part on Windows (1.0.1.0): compare it as the three-part app version
const exeVersion = (exe = APP_EXE) =>
  win(`if (Test-Path "${exe}") { (Get-Item "${exe}").VersionInfo.ProductVersion } else { "missing" }`)
    .out.trim()
    .replace(/^(\d+\.\d+\.\d+)\.0$/, "$1")
const pendingFiles = () => win(`if (Test-Path "${PENDING}") { Get-ChildItem "${PENDING}" -Name } `).out.trim().split("\n").filter(Boolean)
const clearPending = () => win(`Remove-Item -Recurse -Force "${PENDING}" -ErrorAction SilentlyContinue`)
const readYml = () => win(`Get-Content -Raw "${APP_YML}"`).out
const writeYml = text => win(`[IO.File]::WriteAllText("${APP_YML}", ${psq(text)})`)

const winSetup = version => fs.readdirSync(updatesDir).find(it => new RegExp(`^AutoUpdateProto Setup ${version.replace(/\./g, "\\.")}\\.exe$`).test(it))

// app-update.yml without its updateManifestPublicKey block: unsigned-manifest mode, so the forged manifests load
function withoutManifestKey(text) {
  return text.replace(/^updateManifestPublicKey: \|-?\r?\n(?:[ \t]+.*\r?\n?)+/m, "")
}
const publisherLines = text => /^publisherName:\r?\n(?:[ \t]+- .*\r?\n?)+/m.exec(text)?.[0] ?? null

let originalYml = null
let certCn = null

// ---------------------------------------------------------------------------

session.check("W0", "prep: Authenticode of the 1.0.1 installer, install 1.0.0, unsigned-manifest mode", async t => {
  qa("serve", "v1.0.1")
  const setup101 = winSetup("1.0.1")
  const setup100 = winSetup("1.0.0")
  if (!t.ok(setup100 != null && setup101 != null, "server/updates has the 1.0.0 and 1.0.1 Windows installers (session B)")) return
  const sig = ps(t, "authenticode", `${fetch(setup101)}\n$s = Get-AuthenticodeSignature (Join-Path ${WORK} ${psq(setup101)}); "status=" + $s.Status; "subject=" + $s.SignerCertificate.Subject`)
  t.has(sig.out, "status=Valid", "Get-AuthenticodeSignature reports Valid for the osslsigncode signature made on the Mac")
  certCn = /subject=(CN=[^,\n]+)/.exec(sig.out)?.[1] ?? null
  t.note(`signer: ${certCn ?? "(none)"}`)
  // an install left by an earlier run: W7's 1.0.2 has a log-enabled uninstaller, and installing over it fails (F18).
  // A plain uninstall (without --updated) works.
  ps(
    t,
    "uninstall-earlier",
    `Get-Process AutoUpdateProto -ErrorAction SilentlyContinue | Stop-Process -Force
foreach ($d in "${INSTALL_DIR}", "${QA_APPS_DIR}") {
  $u = Join-Path $d "Uninstall AutoUpdateProto.exe"
  if (Test-Path $u) {
    Start-Process -FilePath $u -ArgumentList "/S" -Wait
    for ($i = 0; $i -lt 40 -and (Test-Path (Join-Path $d "AutoUpdateProto.exe")); $i++) { Start-Sleep -Seconds 2 }
    "uninstalled " + $d
  }
  Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
}`,
  )
  const install = ps(
    t,
    "install-1.0.0",
    `Get-Process AutoUpdateProto -ErrorAction SilentlyContinue | Stop-Process -Force
${fetch(setup100)}
$p = Start-Process -FilePath (Join-Path ${WORK} ${psq(setup100)}) -ArgumentList "/S" -PassThru -Wait
"exit=" + $p.ExitCode
Start-Sleep -Seconds 3
Get-Process AutoUpdateProto -ErrorAction SilentlyContinue | Stop-Process -Force`,
  )
  t.has(install.out, "exit=0", "the 1.0.0 installer runs silently (per user)")
  t.ok(exeVersion() === "1.0.0", `AutoUpdateProto.exe is 1.0.0 (${exeVersion()})`)
  originalYml = readYml()
  t.ok(publisherLines(originalYml) != null, "the installed app-update.yml lists publisherName", originalYml.split("\n").slice(0, 8))
  writeYml(withoutManifestKey(originalYml))
  t.ok(!readYml().includes("updateManifestPublicKey"), "updateManifestPublicKey removed (unsigned-manifest mode for W1–W6)")
  clearPending()
  win(`Remove-Item -Force "${QA_LOG}" -ErrorAction SilentlyContinue`)
})

session.check("W1", "nsis-web manifests (#10601 #10576)", async t => {
  for (const [stash, code, text] of [
    ["win-1.0.2-web", "ERR_UPDATER_WEB_INSTALLER_DISABLED", "#disablewebinstaller-defaults-to-true"],
    ["win-web-wrong-arch", "ERR_UPDATER_NO_WEB_PACKAGE_FOR_ARCH", "no app package for the arch"],
  ]) {
    qa("serve", stash)
    clearPending()
    const r = launch(t, stash, {})
    t.has(r.out, `[qa] done: error ${code}`, `${stash}: ${code}`)
    t.has(r.out, text, `${stash}: the message says "${text}"`)
    t.ok(r.requests.every(it => it.path === "/latest.yml"), `${stash}: only GET /latest.yml reached the server`, r.requests.map(it => it.line))
    t.ok(pendingFiles().length === 0, `${stash}: pending stays empty`, pendingFiles())
  }
})

session.check("W2", "forged version, download path (#10601)", async t => {
  qa("serve", "win-forged-1.0.2")
  clearPending()
  const r = launch(t, "forged", { QA_AFTER_DOWNLOAD: "skip" })
  t.has(r.out, "Verifying signature", "the installer's Authenticode signature is verified")
  t.has(r.out, "[qa] done: error ERR_UPDATER_INSTALLER_VERSION_MISMATCH", "ERR_UPDATER_INSTALLER_VERSION_MISMATCH")
  t.has(r.out, 'its ProductVersion is "1.0.1"', "the message names the installer's ProductVersion")
  t.none(r.out, "[qa] done: update-downloaded", "no update-downloaded")
  t.ok(!pendingFiles().some(it => it.startsWith("temp-")), "no temp-* file in pending (F1)", pendingFiles())
  t.ok(exeVersion() === "1.0.0", "the app is still 1.0.0")
})

session.check("W3", "autoUpdater.publisherName (#10600)", async t => {
  qa("serve", "win-forged-1.0.2")
  const base = readYml()
  const lines = publisherLines(base)
  if (!t.ok(lines != null && certCn != null, "publisherName lines and the signer CN are known (W0 ran)")) return
  const without = base.replace(lines, "")
  const steps = [
    ["a-no-publisher", without, {}, r => [t.has(r.out, "has no publisherName", "(a) rejected: app-update.yml has no publisherName"), t.has(r.out, "ERR_UPDATER_INVALID_SIGNATURE", "(a) ERR_UPDATER_INVALID_SIGNATURE"), t.none(r.out, "Verifying signature", "(a) PowerShell verification never runs")]],
    ["b-property", without, { QA_PUBLISHER_NAME: certCn }, r => [t.has(r.out, "Verifying signature", "(b) verified against autoUpdater.publisherName"), t.has(r.out, "ERR_UPDATER_INSTALLER_VERSION_MISMATCH", "(b) then the version mismatch")]],
    ["c-wrong-cn", without, { QA_PUBLISHER_NAME: "CN=Somebody Else" }, r => [t.has(r.out, "incorrect certificate", "(c) signed with incorrect certificate"), t.has(r.out, "ERR_UPDATER_INVALID_SIGNATURE", "(c) ERR_UPDATER_INVALID_SIGNATURE")]],
    ["d-yml-wins", base, { QA_PUBLISHER_NAME: "CN=Somebody Else" }, r => [t.has(r.out, "ERR_UPDATER_INSTALLER_VERSION_MISMATCH", "(d) app-update.yml wins over the property: verified, then the mismatch")]],
    ["e-property-over-opt-out", `${without.trimEnd()}\nverifyUpdateCodeSignature: false\n`, { QA_PUBLISHER_NAME: certCn }, r => [t.has(r.out, "Verifying signature", "(e) the property wins over verifyUpdateCodeSignature: false"), t.has(r.out, "ERR_UPDATER_INSTALLER_VERSION_MISMATCH", "(e) then the mismatch"), t.none(r.out, "is disabled by configuration", "(e) no verification-disabled warning")]],
    ["f-opt-out", `${without.trimEnd()}\nverifyUpdateCodeSignature: false\n`, {}, r => [t.count(r.out, "Signature verification of downloaded updates is disabled by configuration", 1, "(f) one verification-disabled warning"), t.has(r.out, "[qa] done: update-downloaded", "(f) the forged update is accepted: no publisherName means no version check either")]],
  ]
  try {
    for (const [label, yml, env, assertions] of steps) {
      writeYml(yml)
      clearPending()
      assertions(launch(t, label, { QA_AFTER_DOWNLOAD: "skip", ...env }))
    }
  } finally {
    writeYml(base)
    clearPending()
  }
})

session.check("W4", "cache path: a downloaded update is checked again (#10601)", async t => {
  qa("serve", "v1.0.1")
  clearPending()
  const first = launch(t, "download", { QA_AFTER_DOWNLOAD: "skip" })
  t.has(first.out, "[qa] done: update-downloaded", "1.0.1 downloads and is kept (Quit without updating)")
  qa("serve", "win-forged-1.0.2")
  const r = launch(t, "cached", { QA_AFTER_DOWNLOAD: "skip" })
  t.has(r.out, "Update has already been downloaded", "the cached installer is reused")
  t.has(r.out, "ERR_UPDATER_INSTALLER_VERSION_MISMATCH", "and rejected for its ProductVersion")
  t.ok(!r.requests.some(it => it.path.endsWith(".exe")), "no installer download", r.requests.map(it => it.line))
  clearPending()
})

session.check("W5", "next-launch path (#10601, finding F2)", async t => {
  qa("serve", "v1.0.1")
  clearPending()
  const first = launch(t, "mark", { QA_AFTER_DOWNLOAD: "next-launch" })
  t.has(first.out, "[qa] done: update-downloaded -> next-launch", "1.0.1 is marked for install on next launch")
  qa("serve", "win-forged-1.0.2")
  // no check of its own: only the validation of the pending update at launch runs
  const r = launch(t, "relaunch", { QA_AUTO_CHECK: "0" }, { timeoutMs: 120_000 })
  t.has(r.out, "Update is marked for install on next launch, validating it against the latest update info", "validated at launch")
  t.has(r.out, "ERR_UPDATER_INSTALLER_VERSION_MISMATCH", "ERR_UPDATER_INSTALLER_VERSION_MISMATCH (the migration doc says ERR_UPDATER_INVALID_SIGNATURE: F2)")
  t.ok(!pendingFiles().some(it => /\.exe$/.test(it)), "the pending update is discarded", pendingFiles())
  t.ok(exeVersion() === "1.0.0", "the app is still 1.0.0")
  clearPending()
})

session.check("W6", "install at next launch with the default autoInstallEvent (#10525) — first genuine hop", async t => {
  qa("serve", "v1.0.1")
  clearPending()
  const mark = launch(t, "mark", { QA_EXPLICIT_PENDING: "0", QA_NEXT_LAUNCH_EVENT: "keep", QA_AFTER_DOWNLOAD: "next-launch" })
  t.has(mark.out, "[qa] done: update-downloaded -> next-launch", "downloaded and marked")
  t.has(win(`Get-Content -Raw "${PENDING}\\update-info.json"`).out, '"installOnNextLaunch":true', "pending\\update-info.json has installOnNextLaunch: true")
  // no check of their own at these launches: only the updater's install at launch may act
  const manual = launch(t, "manual", { QA_EXPLICIT_PENDING: "0", QA_AUTO_INSTALL_EVENT: "manual", QA_AUTO_CHECK: "0" }, { timeoutMs: 80_000 })
  t.ok(exeVersion() === "1.0.0", "manual: nothing is installed")
  t.has(win(`Get-Content -Raw "${PENDING}\\update-info.json"`).out, '"installOnNextLaunch":true', "manual: the marker stays")
  t.none(manual.out, "Executing:", "manual: no installer started")
  const auto = launch(t, "default", { QA_EXPLICIT_PENDING: "0", QA_AUTO_CHECK: "0" }, { timeoutMs: 120_000 })
  t.none(auto.out, "installPendingUpdateIfAvailable() on launch ->", "installed by the updater itself, not by the explicit call")
  t.has(auto.out, "Executing:", "the installer is started at launch")
  let version = exeVersion()
  for (let i = 0; i < 40 && version !== "1.0.1"; i++) {
    win("Start-Sleep -Seconds 3")
    version = exeVersion()
  }
  t.ok(version === "1.0.1", `1.0.1 is installed (alpha.13 would have left it pending) — now ${version}`)
  win("Start-Sleep -Seconds 10; Get-Process AutoUpdateProto -ErrorAction SilentlyContinue | Stop-Process -Force")
})

session.check("W7", "signed hop to 1.0.2 into a folder with a space (#10527 #10529 #10483)", async t => {
  if (exeVersion() !== "1.0.1") {
    t.skip("needs the app at 1.0.1 (W6)")
    return
  }
  t.ok(readYml().includes("updateManifestPublicKey"), "the 1.0.1 install has a fresh, signed app-update.yml")
  qa("serve", "win-1.0.2")
  clearPending()
  const r = launch(t, "hop", { QA_INSTALL_DIR: QA_APPS_DIR, QA_AFTER_DOWNLOAD: "on-quit" })
  t.has(r.out, "Update manifest signature verified for version 1.0.2", "the signed 1.0.2 manifest is verified")
  const newExe = `${QA_APPS_DIR}\\AutoUpdateProto.exe`
  let version = exeVersion(newExe)
  for (let i = 0; i < 40 && version !== "1.0.2"; i++) {
    win("Start-Sleep -Seconds 3")
    version = exeVersion(newExe)
  }
  t.ok(version === "1.0.2", `1.0.2 runs from QA Apps\\AutoUpdateProto (${version})`)
  const reg = win(`Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like "AutoUpdateProto*" } | ForEach-Object { "InstallLocation=[" + $_.InstallLocation + "]" }`).out
  t.has(reg, "InstallLocation=[", "the uninstall registry entry exists", reg.split("\n"))
  t.none(reg, /InstallLocation=\[[^\]\n]*"/, "InstallLocation has no stray quote (#10529)")
  win("Start-Sleep -Seconds 10; Get-Process AutoUpdateProto -ErrorAction SilentlyContinue | Stop-Process -Force")
})

session.check("W8", "a web installer started as an update without a package (#10601)", async t => {
  const web = fs.readdirSync(updatesDir).find(it => /^AutoUpdateProto Web Setup 1\.0\.2\.exe$/.test(it))
  if (!t.ok(web != null, "the 1.0.2 web installer is in server/updates (B3)")) return
  server.clear()
  const r = ps(t, "silent", `${fetch(web)}\n$c = (Start-Process (Join-Path ${WORK} ${psq(web)}) -ArgumentList "/S","--updated" -Wait -PassThru).ExitCode\n"exit=" + $c`)
  t.has(r.out, "exit=2", "/S --updated without --package-file exits with code 2")
  t.ok(server.requests(it => !it.path.endsWith(".exe")).length === 0, "the web installer made no request", server.lines())
  t.manual("run it without /S and check the message box text and its #an-nsis-web-installer-started-as-an-update-needs-a-package-file link (QA_MANUAL.md, W8)")
})

session.check("W9", "portable launcher quoting (#10591)", async t => {
  const portable = fs.readdirSync(updatesDir).find(it => /^AutoUpdateProto 1\.0\.2\.exe$/.test(it))
  if (!t.ok(portable != null, "the 1.0.2 portable exe is in server/updates (B3)")) return
  win(`${fetch(portable)}\nCopy-Item "$env:WINDIR\\System32\\whoami.exe" "$env:TEMP\\QA.exe" -Force`)
  try {
    const r = launch(t, "portable", { QA_AFTER_DOWNLOAD: "skip" }, { exe: `${WORK}\\${portable}` })
    t.has(r.out, "[qa] done:", "the app itself started from %TEMP%\\QA Portable (not the %TEMP%\\QA.exe decoy)")
  } finally {
    win(`Remove-Item -Force "$env:TEMP\\QA.exe" -ErrorAction SilentlyContinue`)
  }
})

session.check("W10", "reinstall over the log-enabled 1.0.2 install (#10483, F18 #10627, F19 #10628)", async t => {
  const exe = `${QA_APPS_DIR}\\AutoUpdateProto.exe`
  if (exeVersion(exe) !== "1.0.2") {
    t.skip("needs the 1.0.2 install from W7")
    return
  }
  const setup = winSetup("1.0.2")
  const log = `${QA_APPS_DIR}\\install.log`
  const r = ps(
    t,
    "reinstall",
    `Get-Process AutoUpdateProto -ErrorAction SilentlyContinue | Stop-Process -Force
"log-before=" + (Test-Path "${log}")
${fetch(setup)}
$p = Start-Process -FilePath (Join-Path ${WORK} ${psq(setup)}) -ArgumentList "/S" -PassThru
$null = $p.Handle
if ($p.WaitForExit(300000)) { "exit=" + $p.ExitCode } else { Stop-Process -Id $p.Id -Force; "exit=timeout" }
Start-Sleep -Seconds 3
Get-Process AutoUpdateProto -ErrorAction SilentlyContinue | Stop-Process -Force
if (Test-Path "${log}") { Get-Content "${log}" -Encoding Unicode | Select-String "Can't rename" | Select-Object -Last 1 | ForEach-Object { "abort: " + $_.Line.Trim() } }`,
    { timeoutMs: 420_000 },
  )
  // F19 (#10628): the installer starts logging once $INSTDIR is final, so W7's install wrote install.log there
  t.has(r.out, "log-before=True", "W7's install wrote install.log in the install dir (F19)")
  // F18 (#10627): the old log-enabled uninstaller logs to %TEMP%, so it no longer holds install.log open while it moves $INSTDIR aside
  const exit = /exit=(\S+)/.exec(r.out)?.[1] ?? "?"
  t.ok(exit === "0", `the reinstall over the log-enabled install exits 0 (F18; exit ${exit})`, /abort: .*/.exec(r.out) ?? [])
  t.ok(exeVersion(exe) === "1.0.2", `1.0.2 is installed (${exeVersion(exe)})`)
})

// ---------------------------------------------------------------------------

const restore = harnessRestorer()
await session.run({
  async preflight() {
    requirePreflight(checkLinkedDist())
    requireBuildsNewerThanMainJs(/^AutoUpdateProto (Web )?Setup 1\.0\.[012]\.exe$/, "win")
    if (vmState(WIN_VM) !== "running") throw new Error(`the VM "${WIN_VM}" is ${vmState(WIN_VM) ?? "missing"}: start it and log in`)
    for (const name of ["v1.0.1", "win-1.0.2", "win-1.0.2-web", "win-forged-1.0.2", "win-web-wrong-arch"]) {
      if (!stashExists(name)) throw new Error(`stash ${name} is missing: run session B first`)
    }
    await requireFreePorts([8080])
    server = await startServer({ port: 8080, host: "0.0.0.0" })
    forwardWindowsPorts()
    if (!windowsReaches()) throw new Error("the VM cannot reach the Mac's update server (setup S5; allow node in the macOS firewall)")
    if (process.env.QA_WIN_CER) {
      const cer = fs.readFileSync(process.env.QA_WIN_CER).toString("base64")
      const imported = win(`$f = Join-Path $env:TEMP "qa.cer"; [IO.File]::WriteAllBytes($f, [Convert]::FromBase64String(${psq(cer)})); Import-Certificate -FilePath $f -CertStoreLocation Cert:\\LocalMachine\\Root | Out-Null; "imported"`, { system: true })
      console.log(`QA_WIN_CER: ${imported.out.trim()} into LocalMachine\\Root (remove it after QA: QA_MANUAL.md W-cleanup)`)
    }
  },
  async restore() {
    restore()
    if (originalYml != null && vmState(WIN_VM) === "running") win("Get-Process AutoUpdateProto -ErrorAction SilentlyContinue | Stop-Process -Force")
  },
})
