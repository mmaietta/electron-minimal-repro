#!/usr/bin/env node
// Session L (QA_TEST_PLAN.md): Linux in the Parallels VM (Ubuntu), driven from the Mac with prlctl exec. The app runs
// in the VM user's desktop session; the VM reaches the Mac's update server on its own 127.0.0.1:8080 (socat, setup S5).
//
//   node qa/run/session-l.mjs [--list] [--only L1,L3]
//
// L2 needs a person at the VM: pkexec shows a polkit password dialog (twice). The runner starts the app, says when to
// answer it, and checks the result. Needs the arm64 (QA_ARCH) AppImage and deb 1.0.0/1.0.1 in server/updates (session B).
import fs from "node:fs"
import { checkLinkedDist, createSession, harnessRestorer, qa, requireFreePorts, requireBuildsNewerThanMainJs, requirePreflight, startServer, stashExists, updatesDir } from "./lib.mjs"
import { bq, forwardLinuxPorts, linux, LINUX_VM, linuxReaches, vmState } from "./vm.mjs"

const session = createSession("L", "Linux in the Parallels VM")
const WORK = "$HOME/qa"
const QA_LOG = "$HOME/.config/AutoUpdateProto/updater-qa.log"
const DEB_APP = "/opt/AutoUpdateProto/autoupdate-proto"
// FUSE is not needed (extract and run) and Electron's sandbox needs a userns that Ubuntu 24.04's AppArmor may refuse
const APP_ENV = { APPIMAGE_EXTRACT_AND_RUN: "1", ELECTRON_DISABLE_SANDBOX: "1" }
let server = null

const findFile = re => fs.readdirSync(updatesDir).find(it => re.test(it))
const fetchCmd = file => `mkdir -p ${WORK} && curl -fsS -o ${WORK}/${bq(file)} http://127.0.0.1:8080/${encodeURIComponent(file)}`

// Launches a command in the desktop session with QA toggles, waits for it to quit, returns the new updater-qa.log lines.
function launch(t, label, command, env = {}, { timeoutMs = 300_000, root = false } = {}) {
  server.clear()
  const exports = Object.entries({ QA_AUTO_CHECK: "1", QA_EXIT_WHEN_DONE: "1", QA_EXIT_AFTER_MS: String(timeoutMs - 20_000), ...APP_ENV, ...env })
    .map(([key, value]) => `export ${key}=${bq(value)}`)
    .join("\n")
  const result = linux(
    `log=${QA_LOG}
mkdir -p "$(dirname "$log")"; touch "$log"
before=$(stat -c %s "$log")
${exports}
timeout ${Math.round(timeoutMs / 1000)} ${command} >/tmp/qa-app-stdout.log 2>&1; echo "QA-RUN: exit=$?"
sleep 2
tail -c +$((before + 1)) "$log"`,
    { gui: true, root, timeoutMs: timeoutMs + 60_000 },
  )
  t.save(`${result.out}\n--- Mac server\n${server.lines().join("\n")}`, label)
  t.ok(!/QA-RUN: exit=124/.test(result.out), `${label}: the app quit by itself`)
  return { out: result.out, requests: server.requests() }
}

const debVersion = () => linux("dpkg-query -W -f='${Version}' autoupdate-proto 2>/dev/null || echo none").out.trim()

// apt/dpkg must be free: a background transaction (aptd, unattended-upgrades) holding the lock blocks every install
function requireFreeDpkgLock() {
  const holder = linux("fuser /var/lib/dpkg/lock-frontend 2>/dev/null | xargs -r ps -o pid=,etime=,cmd= -p", { root: true }).out.trim()
  if (holder !== "") {
    throw new Error(`the dpkg lock in the VM is held by:\n${holder}\nfinish or cancel that software update in the VM (or: sudo systemctl stop aptd / sudo kill <pid>), then re-run`)
  }
}

function installDeb(t, version) {
  requireFreeDpkgLock()
  const deb = findFile(new RegExp(`^autoupdate-proto_${version.replace(/\./g, "\\.")}_.*\\.deb$`))
  if (deb == null) throw new Error(`no autoupdate-proto_${version}_*.deb in server/updates (session B)`)
  const result = linux(`${fetchCmd(deb)} && cp ${WORK}/${bq(deb)} /tmp/${bq(deb)} && chmod 644 /tmp/${bq(deb)}`)
  if (result.code !== 0) throw new Error(`download of ${deb} failed: ${result.out}`)
  const install = linux(`DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y --allow-downgrades /tmp/${bq(deb)}`, { root: true })
  t.ok(install.code === 0 && debVersion() === version, `the ${version} deb is installed (dpkg: ${debVersion()})`, install.out.split("\n").slice(-3))
}

// ---------------------------------------------------------------------------

session.check("L1", "AppImage: install at next launch with the default event (#10525 #10490)", async t => {
  qa("serve", "v1.0.1")
  const appImage = findFile(/^AutoUpdateProto-1\.0\.0.*\.AppImage$/)
  if (!t.ok(appImage != null, "server/updates has the 1.0.0 AppImage (session B)")) return
  linux(`rm -rf "$HOME/.cache/autoupdate-proto-updater" && ${fetchCmd(appImage)} && chmod +x ${WORK}/${bq(appImage)}`)
  const path = `${WORK}/${bq(appImage)}`
  const mark = launch(t, "mark", path, { QA_EXPLICIT_PENDING: "0", QA_NEXT_LAUNCH_EVENT: "keep", QA_AFTER_DOWNLOAD: "next-launch" })
  t.has(mark.out, "[qa] done: update-downloaded -> next-launch", "1.0.1 downloaded and marked for the next launch")
  // no check of its own at this launch: only the updater's install at launch may act (it quits the app to install)
  const install = launch(t, "relaunch", path, { QA_EXPLICIT_PENDING: "0", QA_AUTO_CHECK: "0" }, { timeoutMs: 120_000 })
  t.has(install.out, /Executing: .*AppImage/, "the updater replaces the AppImage at launch")
  t.none(install.out, "installPendingUpdateIfAvailable() on launch ->", "installed by the updater itself, not by the explicit call")
  // the AppImage it left in place (same path, or renamed after the new version) must be 1.0.1. The updater started it
  // with this launch's QA_EXIT_AFTER_MS; extracted (APPIMAGE_EXTRACT_AND_RUN) it runs as …/autoupdate-proto
  linux("sleep 15; pkill -i -f autoupdate || true")
  const current = linux(`ls -t ${WORK}/*.AppImage | head -1`).out.trim()
  const after = launch(t, "after", bq(current), { QA_AFTER_DOWNLOAD: "skip" })
  t.has(after.out, "Update for version 1.0.1 is not available (latest version: 1.0.1", `1.0.1 runs after the install (${current.split("/").pop()})`)
})

session.check("L2", "deb through pkexec (#10577) — needs your password in the VM", async t => {
  for (const [label, env, text] of [
    ["default", {}, "Installing a local .deb with apt; apt verifies no signature on a local .deb file"],
    ["unverified-0", { QA_ALLOW_UNVERIFIED_LINUX: "0" }, "allowUnverifiedLinuxPackages=false does not verify the .deb itself"],
  ]) {
    installDeb(t, "1.0.0")
    linux('rm -rf "$HOME/.cache/autoupdate-proto-updater"')
    console.log(`\n      >>> L2 ${label}: a polkit password dialog will appear in the "${LINUX_VM}" window — enter the password of user "parallels" (5 min timeout)`)
    const r = launch(t, label, DEB_APP, { ...env, QA_AFTER_DOWNLOAD: "on-quit" })
    t.has(r.out, text, `${label}: the apt log line tells the truth about verification`)
    t.none(r.out, "verifies the package signature", `${label}: never the old claim that it verifies`)
    let version = debVersion()
    for (let i = 0; i < 60 && version !== "1.0.1"; i++) {
      linux("sleep 5")
      version = debVersion()
    }
    t.ok(version === "1.0.1", `${label}: 1.0.1 is installed after the dialog (dpkg: ${version})`)
  }
  t.manual("confirm the polkit dialog showed the apt/dpkg command it runs (QA_MANUAL.md, L2)")
})

session.check("L3", "unsafe installer path with gksudo (#10524)", async t => {
  installDeb(t, "1.0.0")
  const cache = "/tmp/qa o'brien"
  try {
    linux(`mv /usr/bin/pkexec /usr/bin/pkexec.off
printf '#!/bin/sh\\ntouch /tmp/gksudo-ran\\nexit 1\\n' > /usr/local/bin/gksudo && chmod 755 /usr/local/bin/gksudo
rm -f /tmp/gksudo-ran`, { root: true })
    const r = launch(t, "unsafe-path", DEB_APP, { XDG_CACHE_HOME: cache, QA_AFTER_DOWNLOAD: "on-quit" })
    t.has(r.out, "ERR_UPDATER_UNSAFE_INSTALLER_PATH", "ERR_UPDATER_UNSAFE_INSTALLER_PATH")
    t.has(r.out, "qa o'brien", "the message names the unsafe path")
    t.ok(linux("test -e /tmp/gksudo-ran && echo ran || echo clean").out.trim() === "clean", "gksudo was never run")
    t.ok(debVersion() === "1.0.0", "the app is still 1.0.0")
  } finally {
    linux(`test -e /usr/bin/pkexec.off && mv /usr/bin/pkexec.off /usr/bin/pkexec; rm -f /usr/local/bin/gksudo /tmp/gksudo-ran; rm -rf ${bq(cache)}`, { root: true })
  }
  t.ok(linux("test -u /usr/bin/pkexec && echo ok", { root: true }).out.trim() === "ok", "pkexec is restored (setuid)")
  t.manual("optional: with pkexec restored, the same XDG_CACHE_HOME installs (QA_MANUAL.md, L3) — it needs the polkit password again")
})

// ---------------------------------------------------------------------------

const restore = harnessRestorer()
await session.run({
  async preflight() {
    requirePreflight(checkLinkedDist())
    requireBuildsNewerThanMainJs(/^(AutoUpdateProto-1\.0\.[01].*\.AppImage|autoupdate-proto_1\.0\.[01]_.*\.deb)$/, "linux")
    if (vmState(LINUX_VM) !== "running") throw new Error(`the VM "${LINUX_VM}" is ${vmState(LINUX_VM) ?? "missing"}: start it and log in to the desktop`)
    if (!stashExists("v1.0.1")) throw new Error("stash v1.0.1 is missing: run session B first")
    await requireFreePorts([8080])
    server = await startServer({ port: 8080, host: "0.0.0.0" })
    forwardLinuxPorts()
    if (!linuxReaches()) throw new Error("the VM cannot reach the Mac's update server (setup S5; allow node in the macOS firewall)")
  },
  restore,
})
