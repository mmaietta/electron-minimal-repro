#!/usr/bin/env node
// The v27 runtime e2e cases from electron-builder #10620 (PR_DESCRIPTION_test-e2e-v27-runtime-checks.md):
// confirm in CI what only CI can prove, and run the cases locally where this Mac can.
//
//   node qa/run/e2e.mjs [--list] [--only E1,E3] [--no-compile]
//     E1/E2  CI audit: did the new files run (not skip) and pass on master's merge commit and on the release commit
//     E3     local: blackboxHarnessTest + generateToolsetFilenamesTest (any OS, ~1 min)
//     E4     local: MAC-REQUEST-RULES on this Mac (arm64, ~5 min)
//     E5     local: NSIS-INSTALLER-CHECKS + NSIS-NEXT-LAUNCH-MODES in Parallels VM mode (~30–50 min)
//     E6     local: APPIMAGE-REQUEST-RULES in Docker (arm64 image on this Mac, ~20 min)
//
// Runs in ../electron-builder-5 (QA_BUILDER_DIR). Nothing there is committed or left behind: E4's entitlements files
// and E6's arm64 snapshot entries are removed afterwards. Run it after sessions W and L: importing the blackbox helpers
// suspends the Windows VM on exit (E5 resumes it if it was running).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { builderDir, cleanEnv, createSession, logsDir, sh, shLogged, startServer } from "./lib.mjs"
import { vmState, win, WIN_VM } from "./vm.mjs"

const session = createSession("E", "v27 runtime e2e (#10620)")
const REPO = "electron-userland/electron-builder"
const NEW_FILES = ["blackboxUpdateRequestRules", "blackboxUpdateAppImageRules", "blackboxNsisInstallerChecks", "blackboxNsisNextLaunchModes", "blackboxNsisAuthenticode", "blackboxHarnessTest"]
const ANSI = /\x1b\[[0-9;]*m/g

// ---------------------------------------------------------------------------
// CI audit
// ---------------------------------------------------------------------------

// the GitHub API answers 502/504 now and then: three attempts
function gh(args) {
  let result = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    result = sh("gh", args, { timeoutMs: 180_000 })
    if (result.code === 0) return result.stdout
    sh("sleep", [String(attempt * 5)])
  }
  if (result.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${result.out.trim().split("\n").slice(-2).join(" ")}`)
  return result.stdout
}

function testRunFor(sha) {
  const lines = gh(["api", `repos/${REPO}/actions/runs?head_sha=${sha}&per_page=30`, "--jq", '.workflow_runs[] | select(.name=="Test") | "\\(.id) \\(.status) \\(.conclusion)"']).trim().split("\n").filter(Boolean)
  if (lines.length === 0) return null
  const [id, status, conclusion] = lines[0].split(" ")
  return { id, status, conclusion }
}

// For every job of the run that could run a new file: the vitest result lines that name a new file.
function auditRun(t, label, sha) {
  const run = testRunFor(sha)
  if (run == null) {
    t.manual(`${label}: no Test run for ${sha.slice(0, 9)} yet`)
    return
  }
  t.note(`${label} ${sha.slice(0, 9)}: Test run ${run.id} ${run.status}/${run.conclusion} — https://github.com/${REPO}/actions/runs/${run.id}`)
  if (run.status !== "completed") {
    t.manual(`${label}: the Test run is still in progress`)
    return
  }
  const jobs = gh(["api", `repos/${REPO}/actions/runs/${run.id}/jobs?per_page=100&filter=latest`, "--jq", '.jobs[] | select(.name | test("macOS|Windows|appimage-update-rules")) | "\\(.id)\\t\\(.conclusion)\\t\\(.name)"'])
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => line.split("\t"))
  const seen = new Map(NEW_FILES.filter(it => it !== "blackboxHarnessTest").map(it => [it, []]))
  const failedJobs = []
  for (const [id, conclusion, name] of jobs) {
    if (conclusion === "failure") failedJobs.push(name)
    const log = gh(["api", `repos/${REPO}/actions/jobs/${id}/logs`]).replace(ANSI, "")
    for (const file of seen.keys()) {
      for (const line of log.split("\n")) {
        // vitest's per-file summary: " ✓ test/src/…/<file>….e2e.ts (2 tests | 1 skipped) 290s", "❯ …" when it failed
        if (line.includes(file) && /\.(e2e\.)?ts\b.*\(\d+ tests?/.test(line)) seen.get(file).push(`${name}: ${line.replace(/^\S+Z\s+/, "").trim()}`)
      }
    }
  }
  for (const [file, lines] of seen) {
    if (lines.length === 0) {
      t.ok(false, `${label}: ${file} appears in no job log (not collected?)`)
      continue
    }
    // "(2 tests | 2 skipped)" = every test of the file skipped in that job (an NSIS file on a macOS shard without a VM)
    const fullySkipped = line => {
      const m = /\((\d+) tests? \| (\d+) skipped\)/.exec(line)
      return m != null && m[1] === m[2]
    }
    const failedLines = lines.filter(it => /❯|×|\d+ failed/.test(it))
    const ranLines = lines.filter(it => !fullySkipped(it) && !failedLines.includes(it))
    t.ok(failedLines.length === 0, `${label}: ${file} did not fail`, failedLines)
    if (ranLines.length > 0) {
      t.ok(true, `${label}: ${file} ran`, ranLines)
      t.note(`${label}: ${file} ran in ${ranLines.map(it => it.split(": ")[0]).join(", ")}`)
    }
    else if (failedLines.length === 0) {
      t.note(`${label}: ${file} was skipped in every job: ${lines[0]}`)
      if (file === "blackboxNsisAuthenticode") t.manual(`${label}: ${file} was skipped in CI (not elevated, or a provided certificate) — run it elevated in the VM (QA_MANUAL.md, E-auth)`)
      else t.ok(false, `${label}: ${file} ran in at least one job`, lines)
    }
  }
  if (failedJobs.length > 0) {
    t.note(`${label}: failed jobs: ${failedJobs.join(", ")} — setup S2 explains infrastructure failures (Apple timestamp outages)`)
  }
}

session.check("E1", "CI: the new e2e files ran and passed on master's merge commit of #10620", async t => {
  const merge = sh("git", ["log", "--format=%H", "-1", "--grep=(#10620)", "origin/master"], { cwd: builderDir }).stdout.trim()
  if (!t.ok(merge !== "", "found the #10620 merge commit on origin/master")) return
  auditRun(t, "master", merge)
})

session.check("E2", "CI: the new e2e files on the release commit", async t => {
  auditRun(t, "release", sh("git", ["rev-parse", "HEAD"], { cwd: builderDir }).stdout.trim())
})

// ---------------------------------------------------------------------------
// local runs
// ---------------------------------------------------------------------------

function newestResults(since) {
  const dir = path.join(builderDir, "test-results")
  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter(it => /^results-.*\.json$/.test(it))
        .map(it => path.join(dir, it))
        .filter(it => fs.statSync(it).mtimeMs >= since)
    : []
  return files.map(it => JSON.parse(fs.readFileSync(it, "utf8")))
}

// Runs `pnpm ci:test` for TEST_FILES in the checkout and checks vitest's JSON report.
async function ciTest(t, label, testFiles, { env = {}, expectRan = [], command = ["pnpm", ["ci:test"]] } = {}) {
  const since = Date.now() - 1000
  const logFile = path.join(logsDir, "E", `${label}.log`)
  const [bin, args] = command
  console.log(`\n      ${label}: TEST_FILES=${testFiles} ${bin} ${args.join(" ")} (log: ${path.relative(path.dirname(logsDir), logFile)})`)
  const result = await shLogged(bin, args, logFile, { cwd: builderDir, env: cleanEnv({ TEST_FILES: testFiles, ...env }) })
  const reports = newestResults(since)
  const assertions = reports.flatMap(report => report.testResults.flatMap(file => file.assertionResults.map(it => ({ file: path.basename(file.name), ...it }))))
  const byStatus = status => assertions.filter(it => it.status === status)
  t.note(`${label}: ${byStatus("passed").length} passed, ${byStatus("failed").length} failed, ${byStatus("pending").length + byStatus("skipped").length} skipped`)
  t.ok(result.code === 0, `${label}: exit code 0`, result.out.replace(ANSI, "").trim().split("\n").slice(-8))
  for (const failed of byStatus("failed")) t.ok(false, `${label}: ${failed.fullName}`, (failed.failureMessages ?? []).join("\n").split("\n").slice(0, 6))
  for (const name of expectRan) {
    const ran = assertions.filter(it => it.file.includes(name) && it.status === "passed")
    t.ok(ran.length > 0, `${label}: ${name} ran and passed (${ran.length} tests)`, assertions.filter(it => it.file.includes(name)).map(it => `${it.status} ${it.fullName}`))
  }
  return { result, assertions }
}

session.check("E3", "local: blackboxHarnessTest + generateToolsetFilenamesTest", async t => {
  await ciTest(t, "harness", "blackboxHarnessTest,generateToolsetFilenamesTest", { expectRan: ["blackboxHarnessTest", "generateToolsetFilenamesTest"] })
})

// Disables library validation for the self-signed test app: this Mac refuses to load Electron's frameworks into it
// otherwise ("different Team IDs"), while CI's runner launches it. The fixture build picks these files up by name.
const ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
`

session.check("E4", "local: MAC-REQUEST-RULES (arm64 - update request rules)", async (t, options) => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    t.skip("arm64 macOS only")
    return
  }
  // F17: runUpdateScenario hands the detected Windows VM to every target, so with any Windows VM registered in
  // Parallels (it is started when it is not running) the mac case is launched inside the Windows VM and fails
  if (vmState(WIN_VM) != null && !options.flags.has("force-mac-e2e")) {
    t.skip(`a Windows Parallels VM ("${WIN_VM}") is registered: the e2e helper would run the mac app inside it (finding F17). CI covers this case (E1); --force-mac-e2e runs it anyway`)
    return
  }
  const buildDir = path.join(builderDir, "test", "fixtures", "test-app", "build")
  const files = ["entitlements.mac.plist", "entitlements.mac.inherit.plist"].map(it => path.join(buildDir, it))
  if (files.some(it => fs.existsSync(it))) throw new Error(`${files.find(it => fs.existsSync(it))} already exists: remove it first`)
  const keychainsBefore = sh("security", ["list-keychains", "-d", "user"]).stdout
  try {
    for (const file of files) fs.writeFileSync(file, ENTITLEMENTS)
    await ciTest(t, "mac-request-rules", "blackboxUpdateRequestRules", { expectRan: ["blackboxUpdateRequestRules"] })
  } finally {
    for (const file of files) fs.rmSync(file, { force: true })
  }
  t.ok(sh("git", ["status", "--porcelain", "--", "test/fixtures/test-app"], { cwd: builderDir }).stdout.trim() === "", "the fixture is unchanged afterwards")
  t.ok(sh("security", ["list-keychains", "-d", "user"]).stdout === keychainsBefore, "no temporary keychain is left in the search list")
})

// The interface the e2e helper binds the VM-mode feed to: the first prl*/bridge* interface with an IPv4 address
// (test/src/helpers/launchAppCrossPlatform.ts). It must be one the Windows guest can reach.
function helperHostIp() {
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (!/^(prl|bridge)/.test(name)) continue
    const v4 = (addresses ?? []).find(it => it.family === "IPv4" && !it.internal)
    if (v4 != null) return { name, address: v4.address }
  }
  return null
}

session.check("E5", "local: NSIS-INSTALLER-CHECKS + NSIS-NEXT-LAUNCH-MODES in Parallels VM mode", async t => {
  const before = vmState(WIN_VM)
  if (before !== "running") {
    t.manual(`start the VM "${WIN_VM}" and log in (it is ${before ?? "missing"})`)
    return
  }
  const host = helperHostIp()
  if (!t.ok(host != null, "a prl*/bridge* interface with IPv4 exists")) return
  const probe = await startServer({ port: 8093, host: "0.0.0.0" })
  try {
    const reach = win(`try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 http://${host.address}:8093/).StatusCode } catch { "unreachable" }`).out.trim()
    if (!t.ok(reach.startsWith("200"), `the guest reaches ${host.address} (${host.name}), the address the e2e helper serves the feed on`, [reach])) {
      t.note("the e2e helper serves the feed on the first prl*/bridge* interface with IPv4; the VM must reach it (QA_MANUAL.md, known local limits)")
      return
    }
  } finally {
    await probe.stop()
  }
  try {
    await ciTest(t, "nsis-vm", "blackboxNsisInstallerChecks,blackboxNsisNextLaunchModes", { expectRan: ["blackboxNsisInstallerChecks", "blackboxNsisNextLaunchModes"] })
    t.note("VM mode skips expectNoPartialDownload and expectInstalledNsis (the host cannot read the guest's files): CI's native run covers them")
  } finally {
    if (vmState(WIN_VM) === "suspended") sh("prlctl", ["resume", WIN_VM])
  }
})

session.check("E6", "local: APPIMAGE-REQUEST-RULES-INSTALL-MODES in Docker", async t => {
  if (sh("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 }).code !== 0) {
    t.manual("start Docker Desktop, then run  node qa/run/e2e.mjs --only E6  (QA_MANUAL.md, E6)")
    return
  }
  const snapshot = "test/snapshots/updater/blackboxUpdateAppImageRules.e2e.js.snap"
  try {
    await ciTest(t, "appimage-docker", "blackboxUpdateAppImageRules", {
      command: ["bash", ["test/src/updater/test-specific-platforms.sh", "appimage"]],
      env: { RUN_APP_IMAGE_TEST: "true" },
      expectRan: ["blackboxUpdateAppImageRules"],
    })
  } finally {
    // the committed snapshot has only the x64 (CI) entries; a local arm64 run writes its own next to them
    sh("git", ["checkout", "--", snapshot], { cwd: builderDir })
  }
  t.note(`${process.arch} image: CI runs x64; the arm64 result here uses snapshot entries written by this run, not the committed ones`)
})

// ---------------------------------------------------------------------------

await session.run({
  async preflight(options) {
    const head = sh("git", ["log", "--oneline", "-1"], { cwd: builderDir }).stdout.trim()
    console.log(`electron-builder checkout: ${head}`)
    const needsBuild = options.only == null || [...options.only].some(id => ["E3", "E4", "E5", "E6"].includes(id))
    if (needsBuild && !options.flags.has("no-compile")) {
      console.log("pnpm compile (the fixture app links packages/*/dist) ...")
      const compile = await shLogged("pnpm", ["compile"], path.join(logsDir, "E", "compile.log"), { cwd: builderDir })
      if (compile.code !== 0) throw new Error("pnpm compile failed: see qa-logs/E/compile.log")
    }
  },
  async restore() {
    const dirty = sh("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: builderDir }).stdout.trim()
    if (dirty !== "") console.log(`note: tracked files changed in the checkout:\n${dirty}`)
  },
})
