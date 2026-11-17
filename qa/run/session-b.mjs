#!/usr/bin/env node
// Session B (QA_TEST_PLAN.md): the builds every later session uses, plus the build-time and CLI checks.
// Builds run on the Mac for all three platforms; Windows and Linux are built for arm64, the arch of the Parallels VMs
// (QA_ARCH=x64 for x64 VMs).
//
//   node qa/run/session-b.mjs [--list] [--only B5,B6] [--skip-builds]
//     --skip-builds  B1–B3 check the logs of an earlier run (qa-logs/b*.log) instead of building again
//
// Needs (QA_MANUAL.md P2): WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD for signed Windows builds, the keychain Developer ID
// for macOS. Full run: about 45–60 min (three cold-cache 1.0.0 builds, three 1.0.1 builds, two extra builds).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  builderDir,
  checkLinkedDist,
  cleanEnv,
  createSession,
  harnessRestorer,
  logsDir,
  projectDir,
  qa,
  requireFreePorts,
  requirePreflight,
  sh,
  shLogged,
  startServer,
  stopAllServers,
  updatesDir,
} from "./lib.mjs"

const session = createSession("B", "builds and build-time / CLI checks")
const ARCH = process.env.QA_ARCH ?? "arm64"
const keyFile = path.join(projectDir, "keys", "update-private-key.pem")
const signEnv = { ELECTRON_BUILDER_UPDATE_SIGN_KEY_FILE: keyFile }
const builderVersion = JSON.parse(fs.readFileSync(path.join(builderDir, "packages", "electron-builder", "package.json"), "utf8")).version
const scratchDir = path.join(projectDir, "qa-scratch")
const logOf = name => path.join(logsDir, `${name}.log`)
const readLog = name => (fs.existsSync(logOf(name)) ? fs.readFileSync(logOf(name), "utf8") : null)
// QA_PLATFORMS=win,linux rebuilds only those (the checks of the others are skipped)
const SELECTED = new Set((process.env.QA_PLATFORMS ?? "mac,win,linux").split(",").map(it => it.trim()))
const PLATFORMS = [
  ["mac", ["--mac"]],
  ["win", ["--win", `--${ARCH}`]],
  ["linux", ["--linux", `--${ARCH}`]],
].filter(([platform]) => SELECTED.has(platform))
// toolset name as it appears in download labels and cache paths → the version the release ships as default
const TOOLSETS = [
  ["7zip|7za|sevenZip", "1.1.0"],
  ["dmg-?builder|dmgbuild", "1.2.7"],
  ["nsis", "2.0.4"],
  ["win-?code-?sign", "1.3.3"],
  ["appimage", "1.2.1"],
  ["fpm", "2.3.1"],
  ["archive", "1.0.0"],
]

function eb(args, env = {}) {
  return sh("pnpm", ["exec", "electron-builder", ...args], { env: cleanEnv({ ...signEnv, ...env }) })
}

async function release(name, args, env = {}) {
  console.log(`\n      building ${name}: pnpm release ${args.join(" ")} (log: qa-logs/${name}.log)`)
  return shLogged("pnpm", ["release", ...args], logOf(name), { env: cleanEnv({ ...signEnv, ...env }) })
}

function listTree(dir, depth = 4) {
  const out = []
  const walk = (current, level) => {
    if (level > depth) return
    for (const entry of fs.existsSync(current) ? fs.readdirSync(current, { withFileTypes: true }) : []) {
      const full = path.join(current, entry.name)
      out.push(full)
      if (entry.isDirectory()) walk(full, level + 1)
    }
  }
  walk(dir, 0)
  return out.join("\n")
}

const firstMatch = (dir, re) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter(it => re.test(it))
        .map(it => path.join(dir, it))[0]
    : undefined
const magic = (file, bytes) => (file != null && fs.existsSync(file) ? fs.readFileSync(file).subarray(0, bytes).toString("hex").toUpperCase() : "(missing)")

// ---------------------------------------------------------------------------

session.check("B1", "cold-cache 1.0.0 builds: toolsets, no warnings, update config, codesign", async (t, options) => {
  let cacheListing = ""
  if (!options.flags.has("skip-builds")) {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "qa-cold-cache-"))
    t.note(`cold toolset cache: ${cache}`)
    for (const [platform, args] of PLATFORMS) {
      const result = await release(`b1-${platform}`, ["--version", "1.0.0", ...args, "--publish"], {
        ELECTRON_BUILDER_CACHE: cache,
        ELECTRON_BUILDER_OFFLINE: "",
      })
      t.ok(result.code === 0, `${platform} 1.0.0 builds and publishes`, result.out.trim().split("\n").slice(-6))
    }
    cacheListing = listTree(cache)
    fs.writeFileSync(logOf("b1-cache-listing"), cacheListing)
    qa("stash", "v1.0.0")
  } else {
    cacheListing = readLog("b1-cache-listing") ?? ""
  }
  const logs = PLATFORMS.map(([platform]) => readLog(`b1-${platform}`))
  if (logs.some(it => it == null)) {
    t.skip("no qa-logs/b1-*.log from an earlier run: run without --skip-builds")
    return
  }
  const all = logs.join("\n")
  for (const [platform] of PLATFORMS)
    t.has(
      readLog(`b1-${platform}`),
      new RegExp(`electron-builder\\s+version=${builderVersion.replace(/\./g, "\\.")}`),
      `${platform}: banner shows version=${builderVersion}`,
    )
  const wanted = TOOLSETS.filter(
    ([name]) =>
      !(/dmg/.test(name) && !SELECTED.has("mac")) &&
      !(/nsis|code-\?sign/.test(name) && !SELECTED.has("win")) &&
      !(/appimage|fpm/.test(name) && !SELECTED.has("linux")),
  )
  for (const [name, version] of wanted) {
    t.ok(
      new RegExp(`(${name})[^\\n]*${version.replace(/\./g, "\\.")}`, "i").test(`${all}\n${cacheListing}`),
      `toolset ${name.split("|")[0]}@${version} was downloaded`,
    )
  }
  t.none(all, "found no mention of crossOriginHeaders", "no missing-crossOriginHeaders warning (main.js sets it)")
  t.none(all, "uses plain http", "no plain-http feed warning (the feed is loopback)")
  const macConfig = firstMatch(path.join(projectDir, "dist"), /^mac/)
  const macYml = macConfig && path.join(macConfig, "AutoUpdateProto.app", "Contents", "Resources", "app-update.yml")
  if (SELECTED.has("mac"))
    t.ok(
      macYml != null && fs.existsSync(macYml) && fs.readFileSync(macYml, "utf8").includes("updateManifestPublicKey"),
      "the mac app-update.yml embeds updateManifestPublicKey",
    )
  const winUnpacked = firstMatch(path.join(projectDir, "dist"), /^win-.*unpacked$/)
  const winYml = winUnpacked && path.join(winUnpacked, "resources", "app-update.yml")
  if (SELECTED.has("win"))
    t.ok(
      winYml != null && fs.existsSync(winYml) && /publisherName:\s*\n\s*- CN=/.test(fs.readFileSync(winYml, "utf8")),
      "the win app-update.yml lists publisherName: - CN=… (needs WIN_CSC_LINK)",
      winYml ? [winYml] : [],
    )
  if (macConfig != null && SELECTED.has("mac")) {
    const codesign = sh("codesign", ["--verify", "--deep", "--strict", "--verbose=2", path.join(macConfig, "AutoUpdateProto.app")])
    t.ok(codesign.code === 0, "codesign --verify --deep --strict passes", codesign.out.trim().split("\n").slice(-3))
  }
})

session.check("B2", "1.0.1 builds, all manifests signed", async (t, options) => {
  if (!options.flags.has("skip-builds")) {
    for (const [platform, args] of PLATFORMS) {
      const result = await release(`b2-${platform}`, ["--version", "1.0.1", ...args, "--publish"])
      t.ok(result.code === 0, `${platform} 1.0.1 builds and publishes`, result.out.trim().split("\n").slice(-6))
    }
    qa("stash", "v1.0.1")
  }
  const status = qa("status").stdout
  // the qa-*.yml channel files are generated unsigned on purpose (qa.mjs manifests)
  const served = status.split("\n").filter(it => it.startsWith("served ") && !/^served qa-/.test(it))
  t.ok(served.length >= 3, `manifests are served (${served.length})`, served)
  t.ok(
    served.every(it => / version 1\.0\.1 \(signed\)$/.test(it)),
    "every served manifest is 1.0.1 and signed",
    served,
  )
})

session.check("B3", "extra builds: offline Windows signing, log-enabled NSIS stubs, a v2 blockmap", async (t, options) => {
  if (!options.flags.has("skip-builds")) {
    if (SELECTED.has("win")) {
      const win = await release("b3-win", ["--version", "1.0.2", "--win", `--${ARCH}`], { ELECTRON_BUILDER_OFFLINE: "1", QA_WEB: "1", QA_NSIS_LOG: "1" })
      t.ok(win.code === 0, "win 1.0.2 (nsis, nsis-web, portable) builds offline", win.out.trim().split("\n").slice(-6))
      if (win.code === 0) qa("stash-dist", "win-1.0.2", "--web")
    }
    if (SELECTED.has("mac")) {
      const mac = await release("b3-mac", ["--version", "1.1.0", "--mac"], { QA_BLOCKMAP: "v2" })
      t.ok(mac.code === 0, "mac 1.1.0 (v2 blockmap) builds", mac.out.trim().split("\n").slice(-6))
      if (mac.code === 0) qa("stash-dist", "mac-1.1.0")
    }
    qa("manifests")
    qa("serve", "v1.0.1")
  }
  const winLog = readLog("b3-win")
  if (winLog == null) {
    t.skip("no qa-logs/b3-win.log from an earlier run")
    return
  }
  t.count(winLog, "ELECTRON_BUILDER_OFFLINE is set, so Windows signatures get no timestamp", 1, "one offline-signing (no timestamp) warning")
  t.ok(magic(firstMatch(updatesDir, /^AutoUpdateProto-1\.1\.0-.*mac\.zip\.blockmap$/), 2) === "1F8B", "the 1.1.0 blockmap is v2 (gzip, 1f8b)")
  t.ok(
    magic(firstMatch(updatesDir, /^AutoUpdateProto-1\.0\.1-.*mac\.zip\.blockmap$/), 4) === Buffer.from("EBB3").toString("hex").toUpperCase(),
    'the 1.0.1 blockmap is v3 (ASCII magic "EBB3")',
  )
  const stashes = /stashes: (.*)/.exec(qa("status").stdout)?.[1] ?? ""
  for (const name of ["v1.0.0", "v1.0.1", "win-1.0.2", "win-1.0.2-web", "mac-1.1.0", "win-forged-1.0.2", "win-web-wrong-arch"])
    t.ok(stashes.split(", ").includes(name), `stash ${name} exists`, [stashes])
})

session.check("B4", "build warnings for an app that needs attention (#10584 #10566 #10568)", async t => {
  const result = eb(["--mac", "zip", "--publish", "never"], {
    QA_SCAN_PROBE: "1",
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    UPDATE_SERVER_URL: "http://qa.example.com:8080/?token=abc",
  })
  fs.writeFileSync(logOf("b4"), result.out)
  t.ok(result.code === 0, "the probe build succeeds", result.out.trim().split("\n").slice(-5))
  t.count(result.out, "found no mention of crossOriginHeaders", 1, "one missing-crossOriginHeaders warning")
  t.count(result.out, "the update feed written to app-update.yml uses plain http", 1, "one plain-http feed warning")
  t.count(result.out, "the generic publish url has a query string", 1, "one feed-query warning")
  t.has(result.out, /queryParameters=token/, "the query warning names the parameter")
  t.none(result.out, "abc", "the query value is never printed")
  t.ok(countLinks(result.out) >= 3, `each warning links its migration section (${countLinks(result.out)} links)`)
})
const countLinks = text => (text.match(/migration\/v27-runtime-changes#/g) ?? []).length

session.check("B5", "sign-update-manifest (#10423)", async t => {
  const publicKey = qa("public-key").stdout.trim()
  const manifest = path.join(scratchDir, "latest-mac.yml")
  const outputs = []
  const step = (label, args, env) => {
    const result = eb(["sign-update-manifest", ...args], env)
    outputs.push(result.out)
    fs.appendFileSync(logOf("b5"), `\n### ${label}: ${args.join(" ")}\n${result.out}`)
    return result
  }
  fs.rmSync(logOf("b5"), { force: true })
  qa("scratch")
  fs.appendFileSync(manifest, "stagingPercentage: 50\n")
  const s1 = step("1 re-sign", [manifest])
  t.ok(
    s1.code === 0 && /^stagingPercentage: 50$/m.test(fs.readFileSync(manifest, "utf8")),
    "1: re-signs and keeps the added field",
    s1.out.trim().split("\n").slice(-3),
  )
  const s2 = step("2 verify", ["--verify", manifest, `-c.updateManifest.publicKey=${publicKey}`])
  t.ok(s2.code === 0 && /verified/i.test(s2.out), "2: --verify reports verified", s2.out.trim().split("\n").slice(-3))
  fs.symlinkSync("latest-mac.yml", path.join(scratchDir, "link.yml"))
  const s3 = step("3 symlink", [path.join(scratchDir, "link.yml")])
  t.ok(s3.code !== 0, "3: a symlinked manifest is refused", s3.out.trim().split("\n").slice(-3))
  const text = fs.readFileSync(manifest, "utf8")
  const dmg = /^\s*- url: (\S+\.dmg)$/m.exec(text)?.[1]
  // a listed file is found by name or by its sha512 + size: rename the dmg entries and change their size, so no local file
  // matches either way (the zip next to the manifest is another file of the release, so the entry cannot be skipped)
  const missing = text.replace(
    new RegExp(`(- url: )${dmg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\n(?:\\s+\\w+: .*\\n)*?\\s+size: )\\d+`, "g"),
    (_all, prefix, middle) => `${prefix}${dmg.replace(/\.dmg$/, "-missing.dmg")}${middle}1`,
  )
  fs.writeFileSync(manifest, missing)
  const s4 = step("4 missing file", [manifest])
  t.ok(
    s4.code !== 0 && /missing|not found|ENOENT|does not exist/i.test(s4.out),
    "4: a listed file that is missing is refused",
    s4.out.trim().split("\n").slice(-3),
  )
  qa("scratch")
  const zip = fs.readdirSync(scratchDir).find(it => it.endsWith("-mac.zip"))
  const zipPath = path.join(scratchDir, zip)
  fs.appendFileSync(zipPath, "x")
  const expectedSize = fs.statSync(zipPath).size
  const s5 = step("5 stale size", [manifest])
  t.ok(s5.code !== 0 && /size|sha512/i.test(s5.out), "5: a size/sha512 mismatch is refused", s5.out.trim().split("\n").slice(-3))
  const s6 = step("6 rehash", ["--rehash", manifest])
  t.ok(
    s6.code === 0 && new RegExp(`size: ${expectedSize}`).test(fs.readFileSync(manifest, "utf8")),
    `6: --rehash re-signs with size ${expectedSize}`,
    s6.out.trim().split("\n").slice(-3),
  )
  const s7 = step("7 unreadable key", [manifest], { ELECTRON_BUILDER_UPDATE_SIGN_KEY_FILE: "/nonexistent" })
  t.ok(
    s7.code !== 0 && /InvalidConfigurationError|ELECTRON_BUILDER_UPDATE_SIGN_KEY_FILE/.test(s7.out),
    "7: an unreadable key is an InvalidConfigurationError naming its source",
    s7.out.trim().split("\n").slice(-3),
  )
  t.none(outputs.join("\n"), /BEGIN (EC |)PRIVATE KEY|MC4CAQAw/, "no key material is printed")
})

session.check("B6", "verify, publish -f and migrate-schema (#10582 #10566 #10568 #10475 #10490)", async t => {
  const publicKey = qa("public-key").stdout.trim()
  const manifest = path.join(scratchDir, "latest-mac.yml")
  qa("scratch")
  fs.appendFileSync(manifest, "releaseName: &n QA\nreleaseNotes: *n\n")
  const zip = path.join(
    scratchDir,
    fs.readdirSync(scratchDir).find(it => it.endsWith("-mac.zip")),
  )
  fs.appendFileSync(zip, "x")
  const verify = eb(["verify", scratchDir, `-c.updateManifest.publicKey=${publicKey}`])
  fs.writeFileSync(logOf("b6-verify"), verify.out)
  t.ok(verify.code !== 0, "verify fails", verify.out.trim().split("\n").slice(-4))
  t.has(verify.out, /alias/i, "verify reports the YAML aliases")
  t.has(verify.out, /size|sha512/i, "verify reports the zip's stale size/sha512")
  const signVerify = eb(["sign-update-manifest", "--verify", manifest, `-c.updateManifest.publicKey=${publicKey}`])
  t.note(
    `sign-update-manifest --verify on the same aliased manifest: exit ${signVerify.code} — ${/verified/i.test(signVerify.out) ? "reports verified (finding F5 still open)" : "refused (F5 fixed)"}`,
  )

  const target = path.join(scratchDir, "publish-target")
  fs.mkdirSync(target, { recursive: true })
  await requireFreePorts([8082])
  const server = await startServer({ port: 8082, dir: target })
  try {
    const publish = eb(["publish", "-f", manifest, "-f", zip], { UPDATE_SERVER_URL: "http://127.0.0.1:8082/" })
    fs.writeFileSync(logOf("b6-publish"), publish.out)
    // F15 (pre-existing since alpha.14): publish -f loads the config twice and merges it into itself, so a config with a
    // `publish` list crashes (JS: circular JSON) or fails validation (JSON/YAML) before anything is checked or uploaded
    if (/Converting circular structure to JSON|configuration\.publish should be/.test(publish.out)) {
      t.ok(
        false,
        "publish -f runs at all (F15: it crashes on this config's publish list before the #10582 warnings)",
        publish.out
          .split("\n")
          .filter(it => /⨯|circular|publish should/.test(it))
          .slice(0, 3),
      )
    } else {
      t.ok(
        server.requests(it => it.method === "PUT" || it.method === "POST").length > 0,
        "publish -f uploads to the throwaway server",
        server.lines().slice(-4),
      )
      t.count(publish.out, /rules electron-updater/i, 1, "publish -f prints the update-file rules once")
      t.has(publish.out, /alias/i, "publish -f names the YAML aliases")
      t.has(publish.out, /size|sha512/i, "publish -f names the stale zip")
    }
  } finally {
    await server.stop()
  }

  const migrate = eb(["migrate-schema", "-c", "qa/migrate.json", "-n"])
  fs.writeFileSync(logOf("b6-migrate"), migrate.out)
  t.has(migrate.out, /plain http/i, "migrate-schema prints the plain-http feed advisory")
  t.has(migrate.out, /query/i, "migrate-schema prints the feed-query advisory")
  t.has(migrate.out, /1\.2\.1/, 'migrate-schema rewrites toolsets.appimage "1.2.0" to "1.2.1"')
  t.note(
    `leftover toolsets.linuxToolsMac is reported as: ${
      migrate.out
        .split("\n")
        .find(it => /linuxToolsMac/.test(it))
        ?.trim() ?? "(not mentioned)"
    }`,
  )
})

// ---------------------------------------------------------------------------

const restore = harnessRestorer()
let server = null
await session.run({
  async preflight(options) {
    requirePreflight(checkLinkedDist())
    if (!fs.existsSync(keyFile)) throw new Error(`no update signing key at ${keyFile}: --publish refuses unsigned manifests`)
    await requireFreePorts([8080])
    if (!options.flags.has("skip-builds")) {
      if (process.env.WIN_CSC_LINK == null)
        console.log("note: WIN_CSC_LINK is not set, so the Windows builds are unsigned and session W3/W7 cannot pass (QA_MANUAL.md P2)")
      // --publish uploads through build/electron-publisher-custom.js to this server
      server = await startServer({ port: 8080 })
    }
  },
  async restore() {
    if (server != null) await stopAllServers()
    fs.rmSync(scratchDir, { recursive: true, force: true })
    restore()
  },
})
