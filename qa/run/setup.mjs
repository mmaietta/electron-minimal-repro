#!/usr/bin/env node
// Setup (QA_TEST_PLAN.md S1–S5): compile the linked electron-builder checkout, gate on its CI, optionally archive the
// old harness state, check the Windows signing input, and forward the VMs' loopback ports to the Mac.
//
//   node qa/run/setup.mjs [--list] [--only S1,S5] [--fresh] [--no-compile]
//     --fresh       S3: move dist/ and server/updates/* to ~/qa-backup/ (needed once, before the first session B)
//     --no-compile  S1: only check the markers, do not run pnpm compile
import fs from "node:fs"
import path from "node:path"
import { builderDir, builderHead, checkLinkedDist, createSession, logsDir, projectDir, qa, sh, shLogged, startServer } from "./lib.mjs"
import { forwardLinuxPorts, forwardWindowsPorts, LINUX_VM, linuxReaches, vmState, WIN_VM, windowsReaches } from "./vm.mjs"

const session = createSession("S", "setup")
const REPO = "electron-userland/electron-builder"

session.check("S1", "the linked electron-builder checkout is compiled", async (t, options) => {
  t.note(`checkout ${builderDir} at ${builderHead()} (${sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: builderDir }).stdout.trim()})`)
  if (!options.flags.has("no-compile")) {
    const compile = await shLogged("pnpm", ["compile"], path.join(logsDir, "S1-compile.log"), { cwd: builderDir })
    t.ok(compile.code === 0, "pnpm compile succeeds", compile.out.trim().split("\n").slice(-5))
  }
  const problems = checkLinkedDist()
  t.ok(problems.length === 0, "fresh-dist markers are present", problems)
  const help = sh("pnpm", ["exec", "electron-builder", "sign-update-manifest", "--help"])
  t.ok(help.code === 0, "electron-builder sign-update-manifest is available", help.out.split("\n").slice(0, 2))
  t.ok(fs.existsSync(path.join(projectDir, "keys", "update-private-key.pem")), "the update signing key keys/update-private-key.pem exists")
})

session.check("S2", "CI is green for the release commit", async t => {
  const head = sh("git", ["rev-parse", "HEAD"], { cwd: builderDir }).stdout.trim()
  const runs = sh("gh", ["api", `repos/${REPO}/actions/runs?head_sha=${head}&per_page=20`, "--jq", '.workflow_runs[] | select(.name=="Test") | "\\(.id) \\(.status) \\(.conclusion)"'])
  if (!t.ok(runs.code === 0, "gh can read the Actions runs", runs.out.split("\n").slice(0, 3))) return
  const [latest] = runs.stdout.trim().split("\n").filter(Boolean)
  if (latest == null) {
    t.manual(`no Test run for ${head.slice(0, 9)} yet: re-run setup later`)
    return
  }
  const [id, status, conclusion] = latest.split(" ")
  t.note(`Test run ${id}: ${status}/${conclusion} (https://github.com/${REPO}/actions/runs/${id})`)
  if (status !== "completed") {
    t.manual("the Test run is still in progress: re-run S2 when it finishes")
    return
  }
  if (conclusion === "success") {
    t.ok(true, "the Test run passed")
    return
  }
  const failed = sh("gh", ["api", `repos/${REPO}/actions/runs/${id}/jobs?per_page=100&filter=latest`, "--jq", '.jobs[] | select(.conclusion=="failure") | "\\(.id)\\t\\(.name)"']).stdout.trim().split("\n").filter(Boolean)
  const causes = []
  for (const line of failed) {
    const [jobId, name] = line.split("\t")
    const log = sh("gh", ["api", `repos/${REPO}/actions/jobs/${jobId}/logs`]).stdout
    const infra = /The timestamp service is not available/.test(log) ? "Apple timestamp outage (infrastructure)" : null
    const tests = [...new Set([...log.matchAll(/FAIL\s+(test\/\S+)/g)].map(m => m[1]))]
    causes.push(`${name}: ${infra ?? tests.join(", ") ?? "see the log"}`)
  }
  t.ok(false, `the Test run failed (${failed.length} jobs)`, causes)
  if (causes.every(it => it.includes("infrastructure"))) t.note(`only infrastructure failures: re-run them with  gh run rerun ${id} --failed -R ${REPO}`)
})

session.check("S3", "fresh harness state (archive the old builds)", async (t, options) => {
  if (!options.flags.has("fresh")) {
    t.skip("pass --fresh to move dist/ and server/updates/* to ~/qa-backup/ before the first session B")
    return
  }
  const result = qa("archive")
  t.ok(true, result.stdout.trim())
  fs.mkdirSync(logsDir, { recursive: true })
})

session.check("S4", "Windows signing input", async t => {
  const link = process.env.WIN_CSC_LINK
  if (link == null || process.env.WIN_CSC_KEY_PASSWORD == null) {
    t.manual("export WIN_CSC_LINK=<pfx> and WIN_CSC_KEY_PASSWORD=<password> in the shell that runs session B (QA_MANUAL.md, step P2)")
    return
  }
  t.ok(link.startsWith("http") || fs.existsSync(link), `WIN_CSC_LINK points at a file (${path.basename(link)})`)
  t.ok(process.env.CSC_LINK == null, "CSC_LINK is unset, so macOS signing keeps using the keychain Developer ID")
})

session.check("S5", "VM networking: loopback ports forwarded to the Mac", async t => {
  const server = await startServer({ port: 8080, host: "0.0.0.0" })
  try {
    for (const [name, forward, reaches] of [
      [WIN_VM, forwardWindowsPorts, windowsReaches],
      [LINUX_VM, forwardLinuxPorts, linuxReaches],
    ]) {
      const state = vmState(name)
      if (state !== "running") {
        t.manual(`start the VM "${name}" and log in (it is ${state ?? "missing"}), then re-run S5`)
        continue
      }
      const forwarded = forward()
      t.ok(forwarded.code === 0, `${name}: ports 8080/8081 forwarded`, forwarded.out.trim().split("\n").slice(-3))
      const ok = reaches(8080)
      t.ok(ok, `${name}: http://127.0.0.1:8080/ reaches the Mac`)
      if (!ok) t.note("if it does not: allow incoming connections for node in System Settings › Network › Firewall (QA_MANUAL.md, step P3)")
    }
  } finally {
    await server.stop()
  }
})

await session.run()
