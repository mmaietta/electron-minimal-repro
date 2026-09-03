#!/usr/bin/env node
// Bump package.json version, then run electron-builder with the update-server URL/channel exported for electron-builder.js.
//
//   node scripts/release.mjs --version 1.0.1 [--channel latest|beta|alpha] [--publish] [--mac] [--win] [--linux] [--dir]
//
//   --publish   `electron-builder --publish always`: build/electron-publisher-custom.js PUTs artifacts + yml to the server.
//               Without it: `--publish never` (v27 has no implicit publish) — files stay in dist/, use `pnpm publish:copy`.
//   --channel   sets UPDATE_CHANNEL (default "latest"); becomes publish.channel -> which <channel>*.yml files are written
//               and which channel app-update.yml points the installed app at.
//   UPDATE_SERVER_URL (env, default http://127.0.0.1:8080/) is passed through; use the LAN URL printed by `pnpm serve --host 0.0.0.0`
//               when the app will be installed in a VM or another machine.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const projectDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const argv = process.argv.slice(2)

function flag(name) {
  return argv.includes(`--${name}`)
}
function option(name) {
  const i = argv.indexOf(`--${name}`)
  if (i !== -1) return argv[i + 1]
  const inline = argv.find(a => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : undefined
}

const version = option("version")
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: pnpm release --version X.Y.Z[-pre.N] [--channel latest|beta|alpha] [--publish] [--mac] [--win] [--linux] [--dir]")
  process.exit(2)
}
const channel = option("channel") ?? process.env.UPDATE_CHANNEL ?? "latest"
const serverUrl = process.env.UPDATE_SERVER_URL ?? "http://127.0.0.1:8080/"

// 1. bump version (keep the file formatting: 2-space JSON + trailing newline, like the original)
const packageJsonPath = path.join(projectDir, "package.json")
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
const previousVersion = packageJson.version
packageJson.version = version
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n")
console.log(`version: ${previousVersion} -> ${version}`)

// 2. electron-builder
const builderArgs = []
for (const platform of ["mac", "win", "linux"]) {
  if (flag(platform)) builderArgs.push(`--${platform}`)
}
if (flag("dir")) builderArgs.push("--dir")
builderArgs.push("--publish", flag("publish") ? "always" : "never")

const env = { ...process.env, UPDATE_SERVER_URL: serverUrl, UPDATE_CHANNEL: channel }
console.log(`UPDATE_SERVER_URL=${serverUrl} UPDATE_CHANNEL=${channel}`)
console.log(`> pnpm exec electron-builder ${builderArgs.join(" ")}`)
const result = spawnSync("pnpm", ["exec", "electron-builder", ...builderArgs], { cwd: projectDir, env, stdio: "inherit" })
if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

console.log("")
console.log(`built ${version} (channel ${channel}).`)
if (!flag("publish")) {
  console.log("not published (no --publish): run `pnpm publish:copy` to copy dist/* into server/updates, or re-run with --publish.")
}
