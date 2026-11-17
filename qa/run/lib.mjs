// Shared helpers for the QA runners (qa/run/*.mjs): update servers, app launches, checks and the results report.
// Zero dependencies. See QA_MANUAL.md for how to run them and QA_TEST_PLAN.md for what each check proves.
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
export const builderDir = path.resolve(process.env.QA_BUILDER_DIR ?? path.join(projectDir, "..", "electron-builder-5"))
export const logsDir = path.join(projectDir, "qa-logs")
export const updatesDir = path.join(projectDir, "server", "updates")
export const electronBin = path.join(projectDir, "node_modules", ".bin", "electron")
export const macAppPath = "/Applications/AutoUpdateProto.app"
// <userData>/updater-qa.log of the app (dev and packaged share it: both are named AutoUpdateProto)
export const macQaLog = path.join(os.homedir(), "Library", "Application Support", "AutoUpdateProto", "updater-qa.log")

// ---------------------------------------------------------------------------
// processes
// ---------------------------------------------------------------------------

// The environment for child processes: without ELECTRON_RUN_AS_NODE (some IDE shells set it, and Electron then runs
// as plain Node) and without QA_* toggles inherited from the calling shell.
export function cleanEnv(extra = {}) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of Object.keys(env)) {
    if (key.startsWith("QA_") && key !== "QA_BUILDER_DIR" && key !== "QA_WIN_VM" && key !== "QA_LINUX_VM" && key !== "QA_MAC_IP") delete env[key]
  }
  return { ...env, ...extra }
}

// Runs a command to completion. Returns { code, stdout, stderr, out } (out = stdout + stderr).
export function sh(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectDir,
    env: options.env ?? cleanEnv(),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeoutMs,
    input: options.input,
  })
  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""
  return { code: result.status ?? (result.error != null ? 127 : 1), stdout, stderr, out: stdout + stderr, error: result.error }
}

// The same, streaming the output to a log file (and to the console with options.echo) for long commands such as builds.
export function shLogged(command, args, logFile, options = {}) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd ?? projectDir, env: options.env ?? cleanEnv(), stdio: ["ignore", "pipe", "pipe"] })
    const out = fs.createWriteStream(logFile)
    let text = ""
    const onData = chunk => {
      text += chunk
      out.write(chunk)
      if (options.echo) process.stdout.write(chunk)
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    child.on("close", code => {
      out.end()
      resolve({ code: code ?? 1, out: text })
    })
  })
}

// scripts/qa.mjs, the harness helper. Throws on a non-zero exit unless { allowFail: true }.
export function qa(...args) {
  const options = typeof args[args.length - 1] === "object" ? args.pop() : {}
  const result = sh(process.execPath, [path.join(projectDir, "scripts", "qa.mjs"), ...args])
  if (result.code !== 0 && !options.allowFail) {
    throw new Error(`qa.mjs ${args.join(" ")} failed (${result.code}): ${result.out.trim()}`)
  }
  return result
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function portFree(port, host = "127.0.0.1") {
  return new Promise(resolve => {
    const probe = net.createServer()
    probe.once("error", () => resolve(false))
    probe.listen(port, host, () => probe.close(() => resolve(true)))
  })
}

// ---------------------------------------------------------------------------
// update servers (server/update-server.mjs)
// ---------------------------------------------------------------------------

const REQUEST_LINE =
  /^(\S+) (GET|HEAD|PUT|POST) (.+?) -> (\d+)(?: range="([^"]*)")? bytes=(\d+) (\d+)ms host=(\S+) hdr=\[([^\]]*)\](?: q=\[([^\]]*)\])?( ABORTED)?$/
const runningServers = new Set()

// Starts an update server and resolves once it listens. `requests()` returns the parsed request log lines:
// { method, path, status, range, bytes, host, headers: [names], query: [names], aborted }.
export async function startServer({ port = 8080, host = "127.0.0.1", flags = [], dir } = {}) {
  const args = [path.join(projectDir, "server", "update-server.mjs"), "--port", String(port), "--host", host, ...(dir ? ["--dir", dir] : []), ...flags]
  const child = spawn(process.execPath, args, { cwd: projectDir, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] })
  const lines = []
  let buffer = ""
  const onData = chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf("\n")) !== -1) {
      lines.push(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
    }
  }
  child.stdout.on("data", onData)
  child.stderr.on("data", onData)
  const exited = new Promise(resolve => child.once("exit", code => resolve(code)))
  const handle = {
    port,
    url: `http://127.0.0.1:${port}`,
    lines: () => [...lines],
    requests(filter = () => true) {
      return lines
        .map(line => REQUEST_LINE.exec(line))
        .filter(Boolean)
        .map(m => ({
          method: m[2],
          path: m[3],
          status: Number(m[4]),
          range: m[5] ?? null,
          bytes: Number(m[6]),
          host: m[8],
          headers: m[9] === "" ? [] : m[9].split(","),
          query: m[10] == null || m[10] === "" ? [] : m[10].split(","),
          aborted: m[11] != null,
          line: m[0],
        }))
        .filter(filter)
    },
    clear() {
      lines.length = 0
    },
    async stop() {
      runningServers.delete(handle)
      if (child.exitCode == null) {
        child.kill("SIGTERM")
        await exited
      }
    },
  }
  runningServers.add(handle)
  const deadline = Date.now() + 10_000
  while (!lines.some(it => it.startsWith("update server serving"))) {
    if (child.exitCode != null) throw new Error(`update server on :${port} exited: ${lines.join("\n")}`)
    if (Date.now() > deadline) throw new Error(`update server on :${port} did not start: ${lines.join("\n")}`)
    await sleep(50)
  }
  handle.clear()
  return handle
}

export async function stopAllServers() {
  for (const server of [...runningServers]) await server.stop()
}

// ---------------------------------------------------------------------------
// app launches
// ---------------------------------------------------------------------------

function readFrom(file, offset) {
  try {
    const data = fs.readFileSync(file)
    return data.subarray(Math.min(offset, data.length)).toString("utf8")
  } catch {
    return ""
  }
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

// Launches the app (dev mode by default) with QA toggles and waits for it to exit. QA_AUTO_CHECK=1 and
// QA_EXIT_WHEN_DONE=1 are set unless overridden, so the run needs no click. Resolves with
// { code, stdout, log (the new lines of updater-qa.log), text (both), ms, timedOut }.
export async function launchApp(env = {}, { exe = electronBin, args = ["."], timeoutMs = 180_000, logFile = macQaLog } = {}) {
  const offset = sizeOf(logFile)
  const started = Date.now()
  const child = spawn(exe, args, {
    cwd: projectDir,
    env: cleanEnv({ QA_AUTO_CHECK: "1", QA_EXIT_WHEN_DONE: "1", QA_EXIT_AFTER_MS: String(Math.max(timeoutMs - 10_000, 10_000)), ...env }),
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  child.stdout.on("data", chunk => (stdout += chunk))
  child.stderr.on("data", chunk => (stdout += chunk))
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, timeoutMs)
  const code = await new Promise(resolve => child.once("exit", c => resolve(c)))
  clearTimeout(timer)
  const log = readFrom(logFile, offset)
  return { code, stdout, log, text: `${stdout}\n${log}`, ms: Date.now() - started, timedOut }
}

export const launchDev = (env, options) => launchApp(env, options)

export const launchPackagedMac = (env, options) => launchApp(env, { exe: path.join(macAppPath, "Contents", "MacOS", "AutoUpdateProto"), args: [], ...options })

// ---------------------------------------------------------------------------
// checks and the report
// ---------------------------------------------------------------------------

function matches(text, pattern) {
  return typeof pattern === "string" ? text.includes(pattern) : pattern.test(text)
}

function countOf(text, pattern) {
  if (typeof pattern === "string") return text.split(pattern).length - 1
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
  return [...text.matchAll(new RegExp(pattern.source, flags))].length
}

// lines of text matching the pattern (evidence for a report)
function evidence(text, pattern) {
  return text
    .split("\n")
    .filter(line => matches(line, typeof pattern === "string" ? pattern : new RegExp(pattern.source, pattern.flags.replace("g", ""))))
    .slice(0, 5)
}

class CheckContext {
  constructor(id, session) {
    this.id = id
    this.session = session
    this.assertions = []
    this.notes = []
    this.status = null
    this.artifacts = 0
  }

  ok(condition, label, detail = []) {
    this.assertions.push({ ok: Boolean(condition), label, evidence: Array.isArray(detail) ? detail : [String(detail)] })
    return Boolean(condition)
  }

  has(text, pattern, label = `has ${pattern}`) {
    return this.ok(matches(text, pattern), label, evidence(text, pattern))
  }

  none(text, pattern, label = `has no ${pattern}`) {
    return this.ok(!matches(text, pattern), label, evidence(text, pattern))
  }

  count(text, pattern, expected, label = `${pattern} appears ${expected}×`) {
    const actual = countOf(text, pattern)
    return this.ok(actual === expected, `${label} (got ${actual})`, evidence(text, pattern))
  }

  // the text must contain the patterns in this order
  inOrder(text, patterns, label = `in order: ${patterns.join(" → ")}`) {
    let from = 0
    for (const pattern of patterns) {
      const rest = text.slice(from)
      const index = typeof pattern === "string" ? rest.indexOf(pattern) : rest.search(pattern)
      if (index === -1) return this.ok(false, `${label} (missing ${pattern})`)
      from += index + 1
    }
    return this.ok(true, label)
  }

  note(message) {
    this.notes.push(message)
  }

  // needs a person: QA_MANUAL.md has the steps
  manual(message) {
    this.status = this.status ?? "MANUAL"
    this.notes.push(`MANUAL: ${message}`)
  }

  skip(message) {
    this.status = "SKIP"
    this.notes.push(`SKIP: ${message}`)
  }

  // keeps an app run's output as evidence: qa-logs/<session>/<id>-<n>.log
  save(text, label = "") {
    const dir = path.join(logsDir, this.session)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${this.id}-${++this.artifacts}${label ? `-${label}` : ""}.log`)
    fs.writeFileSync(file, text)
    return file
  }
}

// --list, --only D2,D5, --name=value (options.values.name), and plain --flags (options.flags)
function parseArgs(argv) {
  const options = { only: null, list: false, flags: new Set(), values: {} }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const valued = /^--([\w-]+)=(.*)$/.exec(arg)
    if (arg === "--list") options.list = true
    else if (arg === "--only") options.only = new Set((argv[++i] ?? "").split(",").map(it => it.trim().toUpperCase()))
    else if (valued != null) options.values[valued[1]] = valued[2]
    else if (arg.startsWith("--")) options.flags.add(arg.slice(2))
  }
  return options
}

// A session: a list of checks run in order. Usage:
//   const session = createSession("D", "dev mode on the Mac")
//   session.check("D1", "crossOriginHeaders is required", async t => { ... })
//   await session.run({ preflight, restore })
export function createSession(name, title) {
  const checks = []
  const options = parseArgs(process.argv.slice(2))
  return {
    options,
    check(id, checkTitle, fn, { manual = false } = {}) {
      checks.push({ id, title: checkTitle, fn, manual })
    },
    async run({ preflight, restore } = {}) {
      if (options.list) {
        for (const check of checks) console.log(`${check.id.padEnd(5)} ${check.manual ? "[needs a person] " : ""}${check.title}`)
        return
      }
      const selected = checks.filter(it => options.only == null || options.only.has(it.id.toUpperCase()))
      console.log(`\n=== Session ${name}: ${title} (${selected.length} checks) ===`)
      const results = []
      let restoreError = null
      try {
        if (preflight != null) await preflight(options)
        for (const check of selected) {
          const t = new CheckContext(check.id, name)
          const started = Date.now()
          process.stdout.write(`--- ${check.id} ${check.title} ... `)
          try {
            await check.fn(t, options)
          } catch (error) {
            t.ok(false, `threw: ${error?.message ?? error}`, String(error?.stack ?? "").split("\n").slice(1, 4))
          }
          const failed = t.assertions.some(it => !it.ok)
          const status = failed ? "FAIL" : (t.status ?? "PASS")
          console.log(status)
          for (const assertion of t.assertions.filter(it => !it.ok)) {
            console.log(`      ✗ ${assertion.label}`)
            for (const line of assertion.evidence) console.log(`          ${line.slice(0, 240)}`)
          }
          for (const message of t.notes) console.log(`      · ${message}`)
          results.push({ id: check.id, title: check.title, status, ms: Date.now() - started, assertions: t.assertions, notes: t.notes })
        }
      } finally {
        await stopAllServers()
        if (restore != null) {
          try {
            await restore()
          } catch (error) {
            restoreError = error
            console.error(`restore failed: ${error.message}`)
          }
        }
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-")
      fs.mkdirSync(logsDir, { recursive: true })
      const reportFile = path.join(logsDir, `results-${name}-${stamp}.json`)
      fs.writeFileSync(reportFile, JSON.stringify({ session: name, title, builderHead: builderHead(), results }, null, 2))
      const counts = {}
      for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1
      console.log(`\nSession ${name}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "nothing run"}`)
      console.log(`report: ${path.relative(projectDir, reportFile)}`)
      process.exitCode = results.some(it => it.status === "FAIL") || restoreError != null ? 1 : 0
    },
  }
}

export function builderHead() {
  const result = sh("git", ["rev-parse", "--short", "HEAD"], { cwd: builderDir })
  return result.code === 0 ? result.stdout.trim() : null
}

// ---------------------------------------------------------------------------
// preflight and restore
// ---------------------------------------------------------------------------

// The linked electron-builder dist must be compiled: every runner checks the markers from QA_TEST_PLAN.md S1.
export function checkLinkedDist() {
  const problems = []
  const runtime = path.join(builderDir, "packages", "builder-util-runtime", "dist", "httpExecutor.js")
  if (!fs.existsSync(runtime) || !fs.readFileSync(runtime, "utf8").includes("ERR_UPDATER_DOWNLOAD_SIZE_EXCEEDED")) problems.push(`${runtime} lacks ERR_UPDATER_DOWNLOAD_SIZE_EXCEEDED (run pnpm compile in ${builderDir})`)
  if (!fs.existsSync(path.join(builderDir, "packages", "electron-updater", "dist", "windowsExecutableVersion.js"))) problems.push("electron-updater dist lacks windowsExecutableVersion.js")
  if (!fs.existsSync(path.join(projectDir, "node_modules", "electron", "dist"))) problems.push("node_modules/electron/dist is missing: run node node_modules/electron/install.js")
  return problems
}

export async function requireFreePorts(ports) {
  for (const port of ports) {
    if (!(await portFree(port))) throw new Error(`port ${port} is in use (stop the other update server first: pkill -f server/update-server.mjs)`)
  }
}

export function requirePreflight(problems) {
  if (problems.length > 0) throw new Error(`preflight failed:\n  - ${problems.join("\n  - ")}`)
  console.log(`electron-builder checkout ${builderDir} at ${builderHead()}`)
}

// Puts the harness back the way the plan expects between sessions: v1.0.1 served, dev key off, empty cache,
// and the package.json version the run started with.
export function harnessRestorer() {
  const startVersion = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8")).version
  return () => {
    if (fs.existsSync(path.join(updatesDir, "stash", "v1.0.1"))) qa("serve", "v1.0.1")
    qa("dev-key", "off")
    qa("cache", "clear")
    qa("version", startVersion)
  }
}

export function stashExists(name) {
  return fs.existsSync(path.join(updatesDir, "stash", name))
}
