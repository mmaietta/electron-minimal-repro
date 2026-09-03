#!/usr/bin/env node
// Copy build output into the update server directory (alternative to `pnpm release ... --publish`).
//
//   node scripts/publish-copy.mjs [--from dist] [--to server/updates]
//
// Copies dist/*.{yml,exe,blockmap,zip,dmg,AppImage} (top level only — dist/custom/*.yml are the duplicates the custom
// publisher uploads, dist/<platform>-unpacked/ are not artifacts).
import fs from "node:fs"
import path from "node:path"

const projectDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 ? argv[i + 1] : fallback
}
const from = path.resolve(projectDir, option("from", "dist"))
const to = path.resolve(projectDir, option("to", "server/updates"))
const extensions = new Set([".yml", ".exe", ".blockmap", ".zip", ".dmg", ".AppImage"])

if (!fs.existsSync(from)) {
  console.error(`nothing to copy: ${from} does not exist (run \`pnpm release --version X.Y.Z\` first)`)
  process.exit(1)
}
fs.mkdirSync(to, { recursive: true })

let count = 0
for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
  if (!entry.isFile() || !extensions.has(path.extname(entry.name))) continue
  const target = path.join(to, entry.name)
  const tmp = `${target}.tmp`
  fs.copyFileSync(path.join(from, entry.name), tmp)
  fs.renameSync(tmp, target) // atomic swap so a polling app never sees a half-written yml
  console.log(`copied ${entry.name} -> ${path.relative(projectDir, target)}`)
  count++
}
console.log(count === 0 ? "no artifacts found in dist/" : `${count} file(s) copied`)
