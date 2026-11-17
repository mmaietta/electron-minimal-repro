#!/usr/bin/env node
// Runs the QA sessions in order: setup → B → D → M → W → L → e2e (QA_MANUAL.md). Stops after the first session with a
// FAIL unless --keep-going. The e2e runner goes last: it can suspend the Windows VM that W uses.
//
//   node qa/run/all.mjs [--keep-going] [--from W] [--skip-builds]
//     --from <S|B|D|M|W|L|E>  start at that session
//     --skip-builds           passed to session B
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { cleanEnv } from "./lib.mjs"

const dir = path.dirname(fileURLToPath(import.meta.url))
const SESSIONS = [
  ["S", "setup.mjs"],
  ["B", "session-b.mjs"],
  ["D", "session-d.mjs"],
  ["M", "session-m.mjs"],
  ["W", "session-w.mjs"],
  ["L", "session-l.mjs"],
  ["E", "e2e.mjs"],
]
const argv = process.argv.slice(2)
const keepGoing = argv.includes("--keep-going")
const from = argv.includes("--from") ? argv[argv.indexOf("--from") + 1].toUpperCase() : "S"
const start = SESSIONS.findIndex(([id]) => id === from)
if (start === -1) {
  console.error(`--from must be one of ${SESSIONS.map(([id]) => id).join(", ")}`)
  process.exit(2)
}

const outcomes = []
for (const [id, file] of SESSIONS.slice(start)) {
  const args = [path.join(dir, file)]
  if (id === "B" && argv.includes("--skip-builds")) args.push("--skip-builds")
  const { status } = spawnSync(process.execPath, args, { stdio: "inherit", env: cleanEnv() })
  outcomes.push(`${id}: ${status === 0 ? "ok" : "FAIL"}`)
  if (status !== 0 && !keepGoing) {
    console.log(`\nstopped after session ${id}; rerun with --from ${id} once it is fixed, or pass --keep-going`)
    break
  }
}
console.log(`\n${outcomes.join("\n")}`)
process.exitCode = outcomes.every(it => it.endsWith("ok")) ? 0 : 1
