#!/usr/bin/env node
// Session M (QA_TEST_PLAN.md): the packaged macOS app. Installs the 1.0.0 dmg into /Applications, checks the packaged
// allowInsecureFeed warning (M1), then lets Squirrel.Mac install 1.0.1 through the updater's authenticated local
// proxy (M2) and relaunches the installed app.
//
//   node qa/run/session-m.mjs [--list] [--only M2] [--keep-app]
//     --keep-app  leave /Applications/AutoUpdateProto.app installed afterwards
//
// Needs the signed mac 1.0.0 dmg and the 1.0.1 build in server/updates (session B).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { checkLinkedDist, createSession, harnessRestorer, launchPackagedMac, macAppPath, qa, requireFreePorts, requireBuildsNewerThanMainJs, requirePreflight, sh, sleep, startServer, stashExists, updatesDir } from "./lib.mjs"

const session = createSession("M", "packaged macOS (one install, one hop)")

function installedVersion() {
  const result = sh("defaults", ["read", path.join(macAppPath, "Contents", "Info.plist"), "CFBundleShortVersionString"])
  return result.code === 0 ? result.stdout.trim() : null
}

function installDmg(version) {
  const dmg = fs.readdirSync(updatesDir).find(it => it.startsWith(`AutoUpdateProto-${version}-`) && it.endsWith(".dmg"))
  if (dmg == null) throw new Error(`no AutoUpdateProto-${version}-*.dmg in server/updates (session B)`)
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), "qa-dmg-"))
  const attach = sh("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, path.join(updatesDir, dmg)])
  if (attach.code !== 0) throw new Error(`hdiutil attach failed: ${attach.out}`)
  try {
    fs.rmSync(macAppPath, { recursive: true, force: true })
    const copy = sh("ditto", [path.join(mountPoint, "AutoUpdateProto.app"), macAppPath])
    if (copy.code !== 0) throw new Error(`ditto failed: ${copy.out}`)
  } finally {
    sh("hdiutil", ["detach", mountPoint, "-force"])
  }
  // copied from a local dmg: no quarantine attribute, so Gatekeeper does not prompt; clear it in case
  sh("xattr", ["-dr", "com.apple.quarantine", macAppPath])
  return dmg
}

async function launch(t, label, env, options = {}) {
  const server = await startServer({ port: 8080 })
  try {
    const result = await launchPackagedMac(env, { timeoutMs: 300_000, ...options })
    t.save(`${result.stdout}\n--- server A\n${server.lines().join("\n")}`, label)
    t.ok(!result.timedOut, `${label}: the app quit by itself (${Math.round(result.ms / 1000)} s)`)
    return { ...result, out: result.stdout, a: server }
  } finally {
    await server.stop()
  }
}

session.check("M1", "the packaged allowInsecureFeed warning (#10566)", async t => {
  qa("cache", "clear")
  const dmg = installDmg("1.0.0")
  t.ok(installedVersion() === "1.0.0", `${dmg} is installed in /Applications (version ${installedVersion()})`)
  const r = await launch(t, "insecure-force", { QA_ALLOW_INSECURE: "force", QA_AUTO_INSTALL_EVENT: "manual", QA_AFTER_DOWNLOAD: "skip" })
  t.count(r.out, "autoUpdater.allowInsecureFeed is true in a packaged app", 1, "exactly one packaged-app allowInsecureFeed warning")
  t.has(r.out, "v27-runtime-changes#update-requests-require-https", "the warning links the migration section (F7)")
  t.none(r.out, "nativeUpdater.update-downloaded", "with autoInstallEvent manual nothing is staged in Squirrel.Mac")
  t.ok(installedVersion() === "1.0.0", "the app is still 1.0.0")
  t.manual("confirm no Gatekeeper or keychain dialog appeared while the app ran (QA_MANUAL.md, M)")
})

session.check("M2", "a real Squirrel.Mac update through the authenticated proxy (#10581 #10477 #10478 #10595)", async t => {
  if (installedVersion() !== "1.0.0") installDmg("1.0.0")
  qa("cache", "clear")
  const r = await launch(t, "update", { QA_AFTER_DOWNLOAD: "on-quit" })
  t.inOrder(
    r.out,
    ["Proxy server for native Squirrel.Mac: request without valid credentials rejected", "Proxy server for native Squirrel.Mac: serving", "nativeUpdater.update-downloaded"],
    "the proxy rejects the request without credentials, then serves the update, then Squirrel.Mac has it",
  )
  t.has(r.out, "[qa] done: update-downloaded -> on-quit", "update on quit")
  // Squirrel.Mac's ShipIt swaps the bundle after the app has quit
  const deadline = Date.now() + 120_000
  while (installedVersion() !== "1.0.1" && Date.now() < deadline) await sleep(2000)
  t.ok(installedVersion() === "1.0.1", `the installed app is 1.0.1 after the quit (now ${installedVersion()})`)
  const after = await launch(t, "relaunch", { QA_AFTER_DOWNLOAD: "skip" })
  t.has(after.out, "Update for version 1.0.1 is not available (latest version: 1.0.1", "the relaunched app runs 1.0.1 and finds no newer update")
  const codesign = sh("codesign", ["--verify", "--deep", "--strict", macAppPath])
  t.ok(codesign.code === 0, "the updated bundle still passes codesign --verify --deep --strict", codesign.out.trim().split("\n").slice(-2))
})

const restore = harnessRestorer()
await session.run({
  async preflight() {
    requirePreflight(checkLinkedDist())
    requireBuildsNewerThanMainJs(/^AutoUpdateProto-1\.0\.[01]-.*\.(dmg|zip)$/, "mac")
    await requireFreePorts([8080])
    if (stashExists("v1.0.1")) qa("serve", "v1.0.1")
    const running = sh("pgrep", ["-x", "AutoUpdateProto"])
    if (running.code === 0) throw new Error("AutoUpdateProto is running: quit it first")
  },
  async restore() {
    restore()
    if (!session.options.flags.has("keep-app")) {
      fs.rmSync(macAppPath, { recursive: true, force: true })
      console.log(`removed ${macAppPath} (pass --keep-app to keep it)`)
    }
  },
})
