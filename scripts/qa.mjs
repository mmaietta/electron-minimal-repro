#!/usr/bin/env node
// QA helper for QA_TEST_PLAN.md: one-liners for the manifest swaps, cache seeding and state checks the plan repeats.
// Zero dependencies. Run from anywhere: node scripts/qa.mjs <command> [args]
//
//   status                         served manifest versions, package.json version, dev key, updater cache
//   archive                        move dist/ and server/updates/* (keeps .gitkeep) to ~/qa-backup/pre-a14-<time>/
//   version <x.y.z>                set package.json "version" (dev mode compares against it)
//   stash <name>                   copy the served server/updates/*.yml into server/updates/stash/<name>/
//   serve <name>                   copy server/updates/stash/<name>/*.yml back as the served manifests
//   stash-dist <win|mac|linux>-<name> [--web]
//                                  copy that platform's dist/ artifacts into server/updates (manifests untouched) and its
//                                  dist/*.yml into stash/<name>; --web also stashes dist/nsis-web/latest.yml as <name>-web
//   manifests                      write the qa-*-mac.yml channel files (from stash/v1.0.1) and the stash/win-forged-1.0.2
//                                  and stash/win-web-wrong-arch variants (from stash/v1.0.1 and stash/win-1.0.2-web)
//   shrink-size                    served latest-mac.yml: set the zip's size to 1000000 (restore with: serve v1.0.1)
//   dev-key on|off                 add/remove updateManifestPublicKey (derived from keys/update-private-key.pem) in
//                                  dev-app-update.yml, so dev mode verifies signed manifests
//   public-key                     print that public key as one base64 line (for -c.updateManifest.publicKey=...)
//   cache path|clear|seed <ver> [--blockmap]|corrupt-v2
//                                  the updater cache (macOS: ~/Library/Caches/autoupdate-proto-updater): seed puts the
//                                  <ver> mac zip (and its .blockmap) there as update.zip / current.blockmap, which is what
//                                  a differential download starts from; corrupt-v2 breaks the cached v2 map's checksums
//   pending                        list the cache's pending/ dir; exits 1 when a temp-* file is left (#10580)
//   scratch                        qa-scratch/: APFS clones of the served latest-mac.yml, zip, dmg and blockmaps (B5/B6)
import { createPrivateKey, createPublicKey } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import zlib from "node:zlib"

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const updatesDir = path.join(projectDir, "server", "updates")
const stashRoot = path.join(updatesDir, "stash")
const distDir = path.join(projectDir, "dist")
const devConfigPath = path.join(projectDir, "dev-app-update.yml")
const cacheDirName = "autoupdate-proto-updater"
const DEV_KEY_BEGIN = "# >>> qa.mjs dev-key (remove with: node scripts/qa.mjs dev-key off)"
const DEV_KEY_END = "# <<< qa.mjs dev-key"
const PLATFORM_YML = {
  win: name => /^(latest|alpha|beta)\.yml$/.test(name),
  mac: name => /-mac\.yml$/.test(name),
  linux: name => /-linux(-[a-z0-9]+)?\.yml$/.test(name),
}
const ARTIFACT_EXTENSIONS = new Set([".exe", ".zip", ".dmg", ".blockmap", ".AppImage", ".deb", ".rpm", ".7z"])

const [command, ...rest] = process.argv.slice(2)
const commands = { status, archive, version, stash, serve, "stash-dist": stashDist, manifests, "shrink-size": shrinkSize, "dev-key": devKey, "public-key": publicKey, cache, pending, scratch }
if (commands[command] == null) {
  const header = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1)
  console.error(header.slice(0, header.findIndex(line => !line.startsWith("//"))).map(line => line.replace(/^\/\/ ?/, "")).join("\n"))
  process.exit(2)
}
await commands[command](...rest)

// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`qa.mjs: ${message}`)
  process.exit(1)
}

function copyAtomic(from, to) {
  const tmp = `${to}.${process.pid}.tmp`
  fs.copyFileSync(from, tmp)
  fs.renameSync(tmp, to) // a polling app never reads a half-written manifest
}

function writeAtomic(to, text) {
  const tmp = `${to}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, to)
}

function servedYml() {
  return fs.existsSync(updatesDir) ? fs.readdirSync(updatesDir).filter(it => it.endsWith(".yml") && fs.statSync(path.join(updatesDir, it)).isFile()) : []
}

function topLevelVersion(text) {
  return /^version: *['"]?([^'"\s]+)/m.exec(text)?.[1] ?? "?"
}

function packageJson() {
  return JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"))
}

function cacheDir() {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", cacheDirName)
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), cacheDirName)
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), cacheDirName)
}

function macZip(version) {
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  for (const name of [`AutoUpdateProto-${version}-${arch}-mac.zip`, `AutoUpdateProto-${version}-mac.zip`]) {
    if (fs.existsSync(path.join(updatesDir, name))) return path.join(updatesDir, name)
  }
  fail(`no mac zip of ${version} in server/updates (build it, then stash-dist / publish it)`)
}

// Drops the top-level signature / signatures entries (the qa channel files are served unsigned).
function withoutSignatures(text) {
  const out = []
  let skipping = false
  for (const line of text.split("\n")) {
    if (/^signatures?:/.test(line)) {
      skipping = true
      continue
    }
    if (skipping && /^\s/.test(line)) continue
    skipping = false
    out.push(line)
  }
  return out.join("\n")
}

function moveAcrossVolumes(from, to) {
  try {
    fs.renameSync(from, to)
  } catch (e) {
    if (e.code !== "EXDEV") throw e
    fs.cpSync(from, to, { recursive: true })
    fs.rmSync(from, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------

function status() {
  console.log(`package.json version: ${packageJson().version}`)
  for (const name of servedYml().sort()) {
    const text = fs.readFileSync(path.join(updatesDir, name), "utf8")
    console.log(`served ${name.padEnd(26)} version ${topLevelVersion(text)}${/^signature:/m.test(text) ? " (signed)" : ""}`)
  }
  const stashes = fs.existsSync(stashRoot) ? fs.readdirSync(stashRoot) : []
  console.log(`stashes: ${stashes.length > 0 ? stashes.sort().join(", ") : "-"}`)
  const devConfig = fs.existsSync(devConfigPath) ? fs.readFileSync(devConfigPath, "utf8") : ""
  console.log(`dev-app-update.yml key: ${devConfig.includes(DEV_KEY_BEGIN) ? "on" : "off"}`)
  const dir = cacheDir()
  console.log(`updater cache ${dir}: ${fs.existsSync(dir) ? fs.readdirSync(dir).join(", ") || "(empty)" : "(none)"}`)
}

function archive() {
  const target = path.join(os.homedir(), "qa-backup", `pre-a14-${new Date().toISOString().replace(/[:.]/g, "-")}`)
  fs.mkdirSync(path.join(target, "updates"), { recursive: true })
  if (fs.existsSync(distDir)) {
    moveAcrossVolumes(distDir, path.join(target, "dist"))
  }
  for (const name of fs.existsSync(updatesDir) ? fs.readdirSync(updatesDir) : []) {
    if (name === ".gitkeep") continue
    moveAcrossVolumes(path.join(updatesDir, name), path.join(target, "updates", name))
  }
  console.log(`moved dist/ and server/updates/* to ${target}`)
}

function version(value) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(value ?? "")) fail("usage: version <x.y.z>")
  const file = path.join(projectDir, "package.json")
  const data = packageJson()
  const previous = data.version
  data.version = value
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n")
  console.log(`package.json version: ${previous} -> ${value}`)
}

function stash(name) {
  if (!name) fail("usage: stash <name>")
  const files = servedYml()
  if (files.length === 0) fail("server/updates has no manifests to stash")
  const dir = path.join(stashRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  for (const file of files) fs.copyFileSync(path.join(updatesDir, file), path.join(dir, file))
  console.log(`stashed ${files.join(", ")} as ${name}`)
}

function serve(name) {
  const dir = path.join(stashRoot, name ?? "")
  if (!name || !fs.existsSync(dir)) fail(`usage: serve <name> (stashes: ${fs.existsSync(stashRoot) ? fs.readdirSync(stashRoot).join(", ") : "-"})`)
  const files = fs.readdirSync(dir).filter(it => it.endsWith(".yml"))
  for (const file of files) copyAtomic(path.join(dir, file), path.join(updatesDir, file))
  console.log(`serving ${name}: ${files.map(it => `${it} (${topLevelVersion(fs.readFileSync(path.join(dir, it), "utf8"))})`).join(", ")}`)
}

function stashDist(name, flag) {
  const platform = /^(win|mac|linux)-/.exec(name ?? "")?.[1]
  if (platform == null) fail("usage: stash-dist <win|mac|linux>-<name> [--web]")
  if (!fs.existsSync(distDir)) fail("no dist/ to stash")
  const dir = path.join(stashRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  const copied = []
  for (const entry of fs.readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (entry.name.endsWith(".yml")) {
      if (PLATFORM_YML[platform](entry.name)) fs.copyFileSync(path.join(distDir, entry.name), path.join(dir, entry.name))
    } else if (ARTIFACT_EXTENSIONS.has(path.extname(entry.name))) {
      copyAtomic(path.join(distDir, entry.name), path.join(updatesDir, entry.name))
      copied.push(entry.name)
    }
  }
  if (flag === "--web") {
    const webDir = path.join(distDir, "nsis-web")
    if (!fs.existsSync(path.join(webDir, "latest.yml"))) fail("no dist/nsis-web/latest.yml (build with QA_WEB=1)")
    fs.mkdirSync(`${dir}-web`, { recursive: true })
    fs.copyFileSync(path.join(webDir, "latest.yml"), path.join(`${dir}-web`, "latest.yml"))
    for (const entry of fs.readdirSync(webDir, { withFileTypes: true })) {
      if (entry.isFile() && ARTIFACT_EXTENSIONS.has(path.extname(entry.name))) {
        copyAtomic(path.join(webDir, entry.name), path.join(updatesDir, entry.name))
        copied.push(entry.name)
      }
    }
  }
  console.log(`stashed ${platform} manifests as ${name}${flag === "--web" ? ` and ${name}-web` : ""}; copied into server/updates: ${copied.join(", ") || "-"}`)
}

function manifests() {
  const base = path.join(stashRoot, "v1.0.1")
  const macPath = path.join(base, "latest-mac.yml")
  if (fs.existsSync(macPath)) {
    const mac = withoutSignatures(fs.readFileSync(macPath, "utf8")).trimEnd() + "\n"
    const crossOrigin = mac
      .replace(/^(\s*- url: )(.+)$/gm, "$1http://localhost:8081/$2?sig=QA-SECRET-SIG")
      .replace(/^path: (.+)$/m, "path: http://localhost:8081/$1?sig=QA-SECRET-SIG")
    const aliasOk = `${mac}releaseName: &qaName QA harmless alias\nreleaseNotes: *qaName\n`
    const aliasBomb =
      `${mac}qaBomb:\n` +
      `  a: &a ["lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol"]\n` +
      ["b", "c", "d", "e", "f"].map((key, i) => `  ${key}: &${key} [${Array(9).fill(`*${"abcde"[i]}`).join(", ")}]\n`).join("")
    const written = { "qa-mac.yml": mac, "qa-xo-mac.yml": crossOrigin, "qa-alias-ok-mac.yml": aliasOk, "qa-alias-bomb-mac.yml": aliasBomb }
    for (const [file, text] of Object.entries(written)) writeAtomic(path.join(updatesDir, file), text)
    console.log(`wrote ${Object.keys(written).join(", ")} (channels qa, qa-xo, qa-alias-ok, qa-alias-bomb)`)
  } else {
    console.log("skipped the qa-*-mac.yml files: no stash/v1.0.1/latest-mac.yml")
  }

  const winPath = path.join(base, "latest.yml")
  if (fs.existsSync(winPath)) {
    const win = fs.readFileSync(winPath, "utf8")
    const forged = win.replace(/^version: .+$/m, "version: 1.0.2")
    if (forged === win) fail("stash/v1.0.1/latest.yml has no top-level version line")
    fs.mkdirSync(path.join(stashRoot, "win-forged-1.0.2"), { recursive: true })
    fs.writeFileSync(path.join(stashRoot, "win-forged-1.0.2", "latest.yml"), forged)
    console.log("wrote stash/win-forged-1.0.2 (the 1.0.1 manifest announced as 1.0.2: installer ProductVersion mismatch)")
  } else {
    console.log("skipped win-forged-1.0.2: no stash/v1.0.1/latest.yml")
  }

  const webPath = path.join(stashRoot, "win-1.0.2-web", "latest.yml")
  if (fs.existsSync(webPath)) {
    const web = fs.readFileSync(webPath, "utf8")
    // rename the first arch key under "packages:" (arm64 <-> x64), so the app's own arch has no package
    const wrongArch = web.replace(/^(packages:\n {2})(arm64|x64|ia32):/m, (_all, prefix, arch) => `${prefix}${arch === "x64" ? "arm64" : "x64"}:`)
    if (wrongArch === web) fail("stash/win-1.0.2-web/latest.yml has no packages entry to rename")
    fs.mkdirSync(path.join(stashRoot, "win-web-wrong-arch"), { recursive: true })
    fs.writeFileSync(path.join(stashRoot, "win-web-wrong-arch", "latest.yml"), wrongArch)
    console.log("wrote stash/win-web-wrong-arch (no package for the built arch)")
  } else {
    console.log("skipped win-web-wrong-arch: no stash/win-1.0.2-web (stash-dist win-1.0.2 --web)")
  }
}

function shrinkSize() {
  const file = path.join(updatesDir, "latest-mac.yml")
  const lines = fs.readFileSync(file, "utf8").split("\n")
  let inZipEntry = false
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*- url: .*-mac\.zip$/.test(lines[i])) {
      inZipEntry = true
    } else if (/^\s*- url: /.test(lines[i]) || /^\S/.test(lines[i])) {
      inZipEntry = false
    } else if (inZipEntry && /^\s+size: \d+$/.test(lines[i])) {
      lines[i] = lines[i].replace(/\d+$/, "1000000")
      changed = true
      inZipEntry = false
    }
  }
  if (!changed) fail("served latest-mac.yml has no zip entry with a size")
  writeAtomic(file, lines.join("\n"))
  console.log("served latest-mac.yml: zip size set to 1000000 (restore with: node scripts/qa.mjs serve v1.0.1)")
}

function updateManifestPublicKeyPem() {
  const keyFile = process.env.ELECTRON_BUILDER_UPDATE_SIGN_KEY_FILE ?? path.join(projectDir, "keys", "update-private-key.pem")
  return {
    keyFile,
    pem: createPublicKey(createPrivateKey(fs.readFileSync(keyFile))).export({ type: "spki", format: "pem" }).toString().trim(),
  }
}

function publicKey() {
  console.log(
    updateManifestPublicKeyPem()
      .pem.split("\n")
      .filter(it => !it.startsWith("-----"))
      .join("")
  )
}

function devKey(state) {
  const text = fs.readFileSync(devConfigPath, "utf8")
  const begin = text.indexOf(DEV_KEY_BEGIN)
  const without = begin === -1 ? text : text.slice(0, begin).trimEnd() + "\n" + text.slice(text.indexOf(DEV_KEY_END) + DEV_KEY_END.length).replace(/^\n/, "")
  if (state === "off") {
    fs.writeFileSync(devConfigPath, without)
    console.log("dev-app-update.yml: updateManifestPublicKey removed (dev mode skips manifest verification)")
    return
  }
  if (state !== "on") fail("usage: dev-key on|off")
  const { keyFile, pem } = updateManifestPublicKeyPem()
  const block = [DEV_KEY_BEGIN, "updateManifestPublicKey: |-", ...pem.split("\n").map(it => `  ${it}`), DEV_KEY_END].join("\n")
  fs.writeFileSync(devConfigPath, `${without.trimEnd()}\n${block}\n`)
  console.log(`dev-app-update.yml: updateManifestPublicKey of ${path.relative(projectDir, keyFile)} added (relaunch the app)`)
}

function cache(action, versionArg, flag) {
  const dir = cacheDir()
  switch (action) {
    case "path":
      console.log(dir)
      return
    case "clear":
      fs.rmSync(dir, { recursive: true, force: true })
      console.log(`cleared ${dir}`)
      return
    case "seed": {
      if (!versionArg) fail("usage: cache seed <version> [--blockmap]")
      const zip = macZip(versionArg)
      fs.rmSync(dir, { recursive: true, force: true })
      fs.mkdirSync(dir, { recursive: true })
      fs.copyFileSync(zip, path.join(dir, "update.zip"), fs.constants.COPYFILE_FICLONE)
      if (flag === "--blockmap") fs.copyFileSync(`${zip}.blockmap`, path.join(dir, "current.blockmap"))
      console.log(`seeded ${dir}: update.zip = ${path.basename(zip)}${flag === "--blockmap" ? `, current.blockmap = ${path.basename(zip)}.blockmap` : ""}`)
      return
    }
    case "corrupt-v2": {
      const file = path.join(dir, "current.blockmap")
      const data = fs.readFileSync(file)
      if (data[0] !== 0x1f || data[1] !== 0x8b) fail("the cached current.blockmap is not a v2 (gzipped JSON) map: seed a v2 one first")
      const map = JSON.parse(zlib.gunzipSync(data).toString())
      map.files[0].checksums[0] = "0".repeat(64)
      fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(map)))
      console.log("current.blockmap: first v2 checksum replaced by a non-blake2b value")
      return
    }
    default:
      fail("usage: cache path|clear|seed <version> [--blockmap]|corrupt-v2")
  }
}

function pending() {
  const dir = path.join(cacheDir(), "pending")
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : []
  for (const name of entries) {
    const stat = fs.statSync(path.join(dir, name))
    console.log(`${String(stat.isFile() ? stat.size : "-").padStart(12)}  ${name}`)
  }
  const temp = entries.filter(it => it.startsWith("temp-"))
  console.log(`${dir}: ${entries.length} entries, ${temp.length} temp-* file(s)`)
  if (temp.length > 0) process.exit(1)
}

function scratch() {
  const dir = path.join(projectDir, "qa-scratch")
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const manifest = path.join(updatesDir, "latest-mac.yml")
  const text = fs.readFileSync(manifest, "utf8")
  const names = new Set([...text.matchAll(/^\s*- url: (.+)$/gm)].map(it => it[1].trim()))
  fs.copyFileSync(manifest, path.join(dir, "latest-mac.yml"))
  for (const name of names) {
    for (const file of [name, `${name}.blockmap`]) {
      if (fs.existsSync(path.join(updatesDir, file))) {
        // a clone (copy-on-write on APFS): appending to it never touches the served file
        fs.copyFileSync(path.join(updatesDir, file), path.join(dir, file), fs.constants.COPYFILE_FICLONE)
      }
    }
  }
  console.log(`qa-scratch/: latest-mac.yml (${topLevelVersion(text)}) + ${[...names].join(", ")}`)
}
