#!/usr/bin/env node
// Session D (QA_TEST_PLAN.md): dev mode on the Mac, no packaging. Every check launches the unpackaged app with QA
// toggles, lets it check once and quit, then asserts on its output and on the request logs of the two update
// servers: A on :8080 (the feed) and B on :8081 (a second origin).
//
//   node qa/run/session-d.mjs [--list] [--only D2,D5]
//
// Needs the mac 1.0.0 and 1.0.1 builds in server/updates (session B, or pnpm release --mac). D12 also needs
// stash/mac-1.1.0 (B3); it is skipped without it.
import fs from "node:fs"
import path from "node:path"
import {
  builderDir,
  checkLinkedDist,
  cleanEnv,
  createSession,
  harnessRestorer,
  launchDev,
  projectDir,
  qa,
  requireFreePorts,
  requirePreflight,
  sh,
  startServer,
  stashExists,
  stopAllServers,
  updatesDir,
} from "./lib.mjs"

const session = createSession("D", "dev mode on the Mac")
const ZIP_1_0_1 = /^\/AutoUpdateProto-1\.0\.1-arm64-mac\.zip$/
const isZip = r => /-mac\.zip$/.test(r.path) && r.method === "GET"
const isYml = r => /\.yml$/.test(r.path)
const doneDownloaded = "[qa] done: update-downloaded"
const doneError = code => `[qa] done: error ${code}`
// the updater's own log lines (QA lines included), never the app's info line
const updaterLines = text =>
  text
    .split("\n")
    .filter(it => it.startsWith("[updater:"))
    .join("\n")

// Restarts the servers for one launch: A always, B when `b` is given. Returns { a, b }.
async function servers({ a = [], b = null } = {}) {
  await stopAllServers()
  const servedA = await startServer({ port: 8080, flags: a })
  const servedB = b == null ? null : await startServer({ port: 8081, flags: b })
  return { a: servedA, b: servedB }
}

// One launch: fresh servers, the env, the app's stdout kept as evidence.
async function launch(t, label, env, serverFlags = {}, options = {}) {
  const s = await servers(serverFlags)
  if (options.clearCache !== false) qa("cache", "clear")
  const result = await launchDev(env, options)
  t.save(`${result.stdout}\n--- server A\n${s.a.lines().join("\n")}${s.b ? `\n--- server B\n${s.b.lines().join("\n")}` : ""}`, label)
  t.ok(!result.timedOut, `${label}: the app quit by itself (${Math.round(result.ms / 1000)} s)`)
  return { ...result, out: result.stdout, a: s.a, b: s.b }
}

function headersOf(requests) {
  return [...new Set(requests.flatMap(it => it.headers))].sort()
}

// ---------------------------------------------------------------------------

session.check("D1", "crossOriginHeaders is required (#10563)", async t => {
  for (const [label, env] of [
    ["unset", { QA_CROSS_ORIGIN: "unset" }],
    ["unset-no-force-dev", { QA_CROSS_ORIGIN: "unset", QA_FORCE_DEV: "0" }],
    ["array", { QA_CROSS_ORIGIN: "array" }],
  ]) {
    const r = await launch(t, label, env)
    t.has(r.out, doneError("ERR_UPDATER_CROSS_ORIGIN_HEADERS_NOT_CONFIGURED"), `${label}: ERR_UPDATER_CROSS_ORIGIN_HEADERS_NOT_CONFIGURED`)
    t.has(r.out, "checkForUpdates requires autoUpdater.crossOriginHeaders", `${label}: the message names the property`)
    t.has(r.out, "#cross-origin-headers", `${label}: links the migration section`)
    t.none(r.out, "Checking for update", `${label}: no check started`)
    t.ok(r.a.requests().length === 0, `${label}: the feed got no request`, r.a.lines())
  }
})

session.check("D2", "credentials stay on the feed's origin (#10563 #10520 #10568)", async t => {
  const base = { QA_AUTH: "1", QA_CHANNEL: "qa-xo" }
  {
    const r = await launch(t, "default", base, { b: [] })
    const yml = r.a.requests(it => it.path === "/qa-xo-mac.yml")
    t.ok(yml.length > 0, "default: the feed served qa-xo-mac.yml", r.a.lines())
    for (const name of ["authorization", "x-qa-tenant", "x-user-staging-id"]) t.ok(headersOf(yml).includes(name), `default: the feed's yml request has ${name}`, headersOf(yml))
    const zip = r.b.requests(isZip)
    t.ok(zip.length > 0, "default: B served the zip", r.b.lines())
    for (const name of ["authorization", "x-qa-tenant", "x-user-staging-id"]) t.ok(!headersOf(zip).includes(name), `default: B's zip request has no ${name}`, headersOf(zip))
    t.ok(zip.every(it => it.query.includes("sig")), "default: B's zip request kept the query (q=[sig])", zip.map(it => it.line))
    t.count(r.out, /left out authorization, x-qa-tenant for the request from http:\/\/127\.0\.0\.1:8080 to http:\/\/localhost:8081/, 1, "default: one left-out warning")
    t.none(r.out, "QA-SECRET-SIG", "default: no URL is logged with its query")
    t.has(r.out, doneDownloaded, "default: the download completes")
  }
  {
    const r = await launch(t, "tenant", { ...base, QA_CROSS_ORIGIN: "tenant" }, { b: [] })
    const zip = headersOf(r.b.requests(isZip))
    t.ok(zip.includes("x-qa-tenant") && !zip.includes("authorization"), "tenant: B gets x-qa-tenant but not authorization", zip)
  }
  {
    const r = await launch(t, "all", { ...base, QA_CROSS_ORIGIN: "all" }, { b: [] })
    t.ok(headersOf(r.b.requests(isZip)).includes("authorization"), "all: B gets authorization (the leak the property prevents)", headersOf(r.b.requests(isZip)))
    t.none(r.out, "left out", "all: no left-out warning")
  }
})

session.check("D3", "a broken crossOriginHeaders callback (#10563)", async t => {
  for (const [mode, text] of [
    ["throw", "threw for the request from http://127.0.0.1:8080 to http://localhost:8081"],
    ["bad", "must return an array"],
  ]) {
    const r = await launch(t, mode, { QA_AUTH: "1", QA_CHANNEL: "qa-xo", QA_CROSS_ORIGIN: mode }, { b: [] })
    t.has(r.out, doneError("ERR_UPDATER_INVALID_CROSS_ORIGIN_HEADERS"), `${mode}: ERR_UPDATER_INVALID_CROSS_ORIGIN_HEADERS`)
    t.has(r.out, text, `${mode}: the message says "${text}"`)
    t.ok(r.b.requests().length === 0, `${mode}: B got no request`, r.b.lines())
    t.none(updaterLines(r.out), "QA-SECRET-THROW", `${mode}: the callback's error text is not logged`)
  }
})

session.check("D4", "a real Electron redirect to another origin (#10563 #10520)", async t => {
  {
    const r = await launch(t, "zip-redirect", { QA_AUTH: "1", QA_CHANNEL: "qa" }, { a: ["--redirect-match", "\\.zip$", "--redirect-to", "http://localhost:8081"], b: [] })
    t.ok(r.a.requests(it => isZip(it) && it.status === 302).length === 1, "A answered the zip with one 302", r.a.lines())
    const zip = r.b.requests(isZip)
    t.ok(zip.length === 1, "B got exactly one zip GET (two = Electron followed the redirect itself)", r.b.lines())
    t.ok(!headersOf(zip).includes("authorization") && !headersOf(zip).includes("x-qa-tenant"), "B's zip GET has neither authorization nor x-qa-tenant", headersOf(zip))
    t.has(r.out, doneDownloaded, "the download completes")
  }
  {
    const r = await launch(t, "yml-redirect", { QA_AUTH: "1", QA_CHANNEL: "qa" }, { a: ["--redirect-match", "\\.yml$", "--redirect-to", "http://localhost:8081"], b: [] })
    const yml = r.b.requests(isYml)
    t.ok(yml.length > 0, "B served the redirected channel file", r.b.lines())
    t.ok(!headersOf(yml).includes("authorization"), "B's channel file request has no authorization", headersOf(yml))
    t.count(r.out, /crossOriginHeaders left out [^\n]* to http:\/\/localhost:8081/, 1, "one left-out warning for the redirected channel file")
  }
})

session.check("D5", "https-only feeds (#10566)", async t => {
  {
    const r = await launch(t, "qa.localhost", { QA_FEED: "http://qa.localhost:8080/" })
    t.has(r.out, doneError("ERR_UPDATER_INSECURE_FEED"), "qa.localhost: ERR_UPDATER_INSECURE_FEED")
    t.has(r.out, "qa.localhost", "qa.localhost: the message names the host")
    t.has(r.out, "loopback host", "qa.localhost: the message states the loopback exception")
    t.ok(r.a.requests().length === 0, "qa.localhost: A got no request", r.a.lines())
  }
  {
    const r = await launch(t, "localhost", { QA_FEED: "http://localhost:8080/" })
    t.has(r.out, doneDownloaded, "localhost: allowed, the update downloads")
  }
  {
    const r = await launch(t, "insecure-dev", { QA_FEED: "http://qa.localhost:8080/", QA_ALLOW_INSECURE: "dev" })
    t.has(r.out, doneDownloaded, "qa.localhost + allowInsecureFeed: the update downloads")
    t.none(r.out, "in a packaged app", "qa.localhost + allowInsecureFeed: no packaged-app warning (unpackaged)")
  }
})

session.check("D6", "redirect rules (#10566)", async t => {
  {
    const r = await launch(t, "to-insecure", { QA_CHANNEL: "qa" }, { a: ["--redirect-match", "\\.zip$", "--redirect-to", "http://qa.localhost:8081"], b: [] })
    t.has(r.out, doneError("ERR_UPDATER_INSECURE_FEED"), "a redirect to plain http on a non-loopback host: ERR_UPDATER_INSECURE_FEED")
    t.ok(r.b.requests().length === 0, "B got no request", r.b.lines())
  }
  {
    const r = await launch(t, "to-loopback", { QA_FEED: "http://qa.localhost:8080/", QA_ALLOW_INSECURE: "dev" }, { a: ["--redirect-match", "\\.yml$", "--redirect-to", "http://localhost:8081"], b: [] })
    t.has(r.out, doneError("ERR_UPDATER_LOOPBACK_REDIRECT"), "a non-loopback feed redirecting to loopback: ERR_UPDATER_LOOPBACK_REDIRECT")
    t.ok(r.b.requests().length === 0, "B got no request", r.b.lines())
  }
})

session.check("D7", "login gets the request URL (#10565 #10549 #10566)", async t => {
  const authYml = { a: ["--auth", "\\.yml$"] }
  {
    const r = await launch(t, "none", { QA_LOGIN: "none" }, authYml)
    t.count(r.out, "autoUpdater has no login listener", 1, "none: one no-listener warning")
    t.has(r.out, doneError("HTTP_ERROR_401"), "none: HTTP_ERROR_401")
    t.ok(r.ms < 30_000, `none: fails at once, not after a timeout (${r.ms} ms)`)
  }
  {
    const r = await launch(t, "origin", { QA_LOGIN: "origin" }, authYml)
    t.has(r.out, "[qa] login event: isProxy=false host=127.0.0.1:8080 url=http://127.0.0.1:8080/latest-mac.yml", "origin: the login event carries the request URL")
    const yml = r.a.requests(it => it.path === "/latest-mac.yml")
    t.ok(yml.some(it => it.status === 401) && yml.some(it => it.status === 200 && it.headers.includes("authorization")), "origin: A logs a 401, then a 200 with authorization", yml.map(it => it.line))
  }
  {
    const r = await launch(t, "throw", { QA_LOGIN: "throw" }, authYml)
    t.has(r.out, "A login listener threw for the server 127.0.0.1:8080", "throw: the listener-threw warning")
    t.has(r.out, doneError("HTTP_ERROR_401"), "throw: HTTP_ERROR_401")
    t.none(updaterLines(r.out), "QA-SECRET-LOGIN", "throw: the listener's error text is not logged")
  }
  const crossOriginAuth = { a: ["--redirect-match", "\\.zip$", "--redirect-to", "http://localhost:8081"], b: ["--auth", "\\.zip$"] }
  {
    const r = await launch(t, "legacy", { QA_LOGIN: "legacy", QA_CHANNEL: "qa" }, crossOriginAuth)
    t.count(r.out, "every login handler answers without the url argument", 1, "legacy: one legacy-handler warning")
    t.ok(r.b.requests(it => isZip(it) && it.status === 200 && it.headers.includes("authorization")).length > 0, "legacy: B gets a 200 with authorization (a legacy handler answers every origin)", r.b.lines())
  }
  {
    const r = await launch(t, "origin-cross", { QA_LOGIN: "origin", QA_CHANNEL: "qa" }, crossOriginAuth)
    t.has(r.out, "url=http://localhost:8081/", "origin cross-origin: a login event for localhost:8081")
    t.has(r.out, doneError("HTTP_ERROR_401"), "origin cross-origin: cancelled, HTTP_ERROR_401")
    t.ok(r.b.requests(it => it.status === 200).length === 0, "origin cross-origin: B never served the zip", r.b.lines())
  }
  {
    const r = await launch(t, "insecure", { QA_FEED: "http://qa.localhost:8080/", QA_ALLOW_INSECURE: "dev" }, authYml)
    t.none(r.out, "[qa] login event", "insecure feed: no login event at all")
    t.has(r.out, "HTTP_ERROR_401", "insecure feed: the challenge is cancelled (401)")
  }
})

session.check("D8", "YAML alias budget (#10514 #10536 #10575 #10522)", async t => {
  {
    const r = await launch(t, "ok", { QA_CHANNEL: "qa-alias-ok" })
    t.none(r.out, "ERR_UPDATER_INVALID_UPDATE_INFO", "ok: a harmless alias loads")
    t.has(r.out, doneDownloaded, "ok: the update downloads")
  }
  {
    const r = await launch(t, "bomb", { QA_CHANNEL: "qa-alias-bomb" })
    t.has(r.out, doneError("ERR_UPDATER_INVALID_UPDATE_INFO"), "bomb: ERR_UPDATER_INVALID_UPDATE_INFO")
    t.has(r.out, "#update-manifest-yaml-aliases-are-limited", "bomb: links the migration section")
    t.ok(r.ms < 15_000, `bomb: rejected quickly, the app stays responsive (${r.ms} ms for the whole run)`)
  }
})

session.check("D9", "channel-file size limit (#10508)", async t => {
  {
    const r = await launch(t, "1024", { QA_MAX_UPDATE_INFO_SIZE: "1024" })
    t.has(r.out, doneError("ERR_HTTP_RESPONSE_TOO_LARGE"), "1024: ERR_HTTP_RESPONSE_TOO_LARGE")
    t.has(r.out, "raise the limit with maxUpdateInfoSize", "1024: names the option")
    t.has(r.out, "#channel-files-are-limited-to-10-mib", "1024: links the migration section")
  }
  {
    const r = await launch(t, "-1", { QA_MAX_UPDATE_INFO_SIZE: "-1" })
    t.has(r.out, doneError("ERR_UPDATER_INVALID_MAX_UPDATE_INFO_SIZE"), "-1: ERR_UPDATER_INVALID_MAX_UPDATE_INFO_SIZE")
    t.ok(r.a.requests().length === 0, "-1: A got no request", r.a.lines())
  }
  {
    const r = await launch(t, "0", { QA_MAX_UPDATE_INFO_SIZE: "0" })
    t.has(r.out, doneDownloaded, "0: no limit, a normal check")
  }
})

session.check("D10", "a signed manifest with a staged rollout (#10530 #10423)", async t => {
  const served = path.join(updatesDir, "latest-mac.yml")
  try {
    qa("serve", "v1.0.1")
    qa("dev-key", "on")
    fs.appendFileSync(served, "stagingPercentage: 50\n")
    {
      const r = await launch(t, "unsigned-edit", {})
      t.has(r.out, doneError("ERR_UPDATER_MANIFEST_SIGNATURE_INVALID"), "edited: ERR_UPDATER_MANIFEST_SIGNATURE_INVALID")
      t.has(r.out, "stagingPercentage", "edited: the message says stagingPercentage is covered by the signature")
      t.has(r.out, "staged-rollout", "edited: links the staged-rollout docs")
    }
    const sign = sh("pnpm", ["exec", "electron-builder", "sign-update-manifest", served], { env: cleanEnv({ ELECTRON_BUILDER_UPDATE_SIGN_KEY_FILE: path.join(projectDir, "keys", "update-private-key.pem") }) })
    t.ok(sign.code === 0, "sign-update-manifest re-signs the edited manifest", sign.out.split("\n").slice(-5))
    {
      const r = await launch(t, "re-signed", {})
      t.has(r.out, "Update manifest signature verified for version 1.0.1", "re-signed: signature verified")
      t.has(r.out, "Staging percentage: 0.5,", "re-signed: the staging percentage (50 → 0.5) is applied")
    }
  } finally {
    qa("serve", "v1.0.1")
    qa("dev-key", "off")
  }
})

session.check("D11", "differential download with v3 maps", async t => {
  {
    qa("cache", "seed", "1.0.0")
    const r = await launch(t, "zip-only", {}, {}, { clearCache: false })
    t.has(r.out, "No cached blockmap for the old installer, downloading it", "P1: downloads the old blockmap")
    t.has(r.out, /has \d+ changed blocks/, "P1: plans changed blocks")
    t.has(r.out, "Differential download succeeded", "P1: differential download succeeded")
    t.ok(r.a.requests(it => it.status === 206 && (it.range ?? "").includes(",")).length > 0, "P1: A served multi-range 206 requests", r.a.lines().slice(-5))
  }
  {
    qa("cache", "seed", "1.0.0", "--blockmap")
    const r = await launch(t, "with-blockmap", {}, {}, { clearCache: false })
    t.has(r.out, /Block map v3: .* reused from the old map/, "P2: v3 groups reused from the cached map")
    t.has(r.out, "Differential download succeeded", "P2: differential download succeeded")
    const cached = path.join(qa("cache", "path").stdout.trim(), "current.blockmap")
    // a v3 map starts with the ASCII magic "EBB3"; a v2 map is gzip (1f 8b)
    const magic = fs.existsSync(cached) ? fs.readFileSync(cached).subarray(0, 4).toString("latin1") : "(missing)"
    t.ok(magic === "EBB3", `the cached current.blockmap is v3 (starts with ${JSON.stringify(magic)})`)
  }
})

session.check("D12", "switching the blockmap format (#10497)", async t => {
  if (!stashExists("mac-1.1.0")) {
    t.skip("needs the v2-blockmap mac 1.1.0 build: run session B (B3) first")
    return
  }
  try {
    {
      qa("serve", "mac-1.1.0")
      qa("version", "1.0.1")
      qa("cache", "seed", "1.0.1", "--blockmap")
      const r = await launch(t, "v3-to-v2", {}, {}, { clearCache: false })
      t.has(r.out, "Block map format changed (old: v3, new: v2): comparing the blocks", "v3 → v2: stays differential")
      t.has(r.out, "Differential download succeeded", "v3 → v2: differential download succeeded")
    }
    {
      qa("serve", "v1.0.1")
      qa("version", "1.1.0")
      qa("cache", "seed", "1.1.0", "--blockmap")
      const r = await launch(t, "v2-to-v3", { QA_CHANNEL: "latest" }, {}, { clearCache: false })
      t.has(r.out, "Block map format changed (old: v2, new: v3): comparing the blocks", "v2 → v3: stays differential")
      t.has(r.out, "Differential download succeeded", "v2 → v3: differential download succeeded")
    }
    {
      qa("cache", "seed", "1.1.0", "--blockmap")
      qa("cache", "corrupt-v2")
      const r = await launch(t, "corrupt-v2", { QA_CHANNEL: "latest" }, {}, { clearCache: false })
      t.count(r.out, "ERR_UPDATER_BLOCKMAP_FORMAT_CHANGED", 1, "corrupt v2: ERR_UPDATER_BLOCKMAP_FORMAT_CHANGED logged once")
      t.has(r.out, doneDownloaded, "corrupt v2: falls back to a full download")
    }
  } finally {
    qa("serve", "v1.0.1")
    qa("version", "1.0.0")
  }
})

session.check("D13", "full downloads stop at the declared size (#10580, F1)", async t => {
  const sizeError = "ERR_UPDATER_DOWNLOAD_SIZE_EXCEEDED"
  try {
    for (let i = 1; i <= 3; i++) {
      qa("serve", "v1.0.1")
      qa("shrink-size")
      const r = await launch(t, `unsigned-${i}`, {})
      t.has(r.out, doneError(sizeError), `unsigned ${i}: ${sizeError}`)
      t.has(r.out, "#full-downloads-stop-at-the-declared-size", `unsigned ${i}: links the migration section`)
      const pending = qa("pending", { allowFail: true })
      t.ok(pending.code === 0, `unsigned ${i}: no temp-* file left in pending/ (F1)`, pending.out.trim().split("\n"))
    }
    qa("serve", "v1.0.1")
    qa("dev-key", "on")
    {
      const r = await launch(t, "signed", {}, { a: ["--extra-bytes", "AutoUpdateProto-1.0.1-arm64-mac.zip:20000000"] })
      t.inOrder(r.out, ["Update manifest signature verified", sizeError], "signed: signature verified, then the size error")
      const pending = qa("pending", { allowFail: true })
      t.ok(pending.code === 0, "signed: no temp-* file left in pending/ (F1)", pending.out.trim().split("\n"))
    }
    {
      const r = await launch(t, "restore", {})
      t.has(r.out, doneDownloaded, "restore: the exact size is accepted")
    }
  } finally {
    qa("serve", "v1.0.1")
    qa("dev-key", "off")
  }
})

session.check("D14", "cancelling a download (#10506)", async t => {
  {
    const r = await launch(t, "cancel", { QA_CANCEL_AFTER_MS: "5000" }, { a: ["--throttle-kbps", "2048"] })
    t.has(r.out, "[qa] cancelling the download after 5000 ms", "the download is cancelled after 5 s")
    t.has(r.out, "[qa] done: update-cancelled", "update-cancelled is emitted")
    t.none(r.out, "[qa] done: error", "no error event")
    const zip = r.a.requests(it => ZIP_1_0_1.test(it.path))
    t.ok(zip.length === 1 && zip[0].aborted, "A logs the zip GET as ABORTED", zip.map(it => it.line))
    t.ok(zip.length === 1 && zip[0].bytes > 4_000_000 && zip[0].bytes < 16_000_000, `about 10 MB were sent before the abort (${zip[0]?.bytes})`)
  }
  {
    const r = await launch(t, "relaunch", {})
    t.has(r.out, doneDownloaded, "the relaunch downloads in full")
  }
})

session.check("D15", "electron-updater bundled into main (#10531)", async t => {
  const bundle = path.join(projectDir, "main.bundle.js")
  try {
    const build = sh("npx", ["--yes", "esbuild@0.25.12", "main.js", "--bundle", "--platform=node", "--external:electron", "--external:electron-updater/package.json", `--outfile=${bundle}`], { timeoutMs: 180_000 })
    if (build.code !== 0 && build.out.includes("Yarn Plug'n'Play manifest forbids")) {
      let pnp = "a .pnp.cjs above this project"
      for (let dir = path.dirname(projectDir); dir !== path.dirname(dir); dir = path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, ".pnp.cjs"))) {
          pnp = path.join(dir, ".pnp.cjs")
          break
        }
      }
      t.skip(`esbuild resolves through a Yarn Plug'n'Play manifest (${pnp}); move it aside to run D15, it is AUTO via autoUpdaterBundleTest anyway`)
      return
    }
    if (!t.ok(build.code === 0, "esbuild bundles main.js", build.out.split("\n").slice(-5))) return
    await servers()
    qa("cache", "clear")
    const r = await launchDev({}, { args: [bundle] })
    t.save(r.stdout, "bundled")
    t.has(r.stdout, /\[qa\] QA_AUTO_CHECK -> \{"ok":true/, "the bundled main runs a check")
    t.none(r.stdout, "[qa] done: error", "no updater error from the bundled main")
  } finally {
    fs.rmSync(bundle, { force: true })
  }
})

// ---------------------------------------------------------------------------

const restore = harnessRestorer()
await session.run({
  async preflight() {
    requirePreflight(checkLinkedDist())
    await requireFreePorts([8080, 8081])
    if (!stashExists("v1.0.1")) {
      const served = fs.readFileSync(path.join(updatesDir, "latest-mac.yml"), "utf8")
      if (!/^version: 1\.0\.1$/m.test(served)) throw new Error("server/updates must serve the mac 1.0.1 build (session B, or pnpm release --version 1.0.1 --mac --publish)")
      qa("stash", "v1.0.1")
    }
    qa("manifests")
    qa("serve", "v1.0.1")
    qa("dev-key", "off")
    qa("version", "1.0.0")
    console.log(`app 1.0.0 (dev mode), serving 1.0.1; linked updater from ${builderDir}`)
  },
  restore,
})
