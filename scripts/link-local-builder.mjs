#!/usr/bin/env node
// Point this app at a local electron-builder monorepo checkout (unreleased branch) using pnpm overrides.
//
//   node scripts/link-local-builder.mjs ../electron-builder     # link
//   node scripts/link-local-builder.mjs --unlink                 # back to the registry versions in package.json
//
// Writes `pnpm.overrides` entries `<pkg>: link:<checkout>/packages/<pkg>` for every workspace package that
// electron-builder / electron-updater pull in (they depend on each other by exact version, so all must be swapped
// together), then runs `pnpm install`. The checkout must be compiled first (`pnpm install && pnpm compile` there);
// the linked packages resolve their own dependencies from the checkout's node_modules.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const packageJsonPath = path.join(projectDir, "package.json")
const argv = process.argv.slice(2)

// electron-builder -> app-builder-lib, builder-util, builder-util-runtime, dmg-builder, electron-publish;
// app-builder-lib peerDeps -> dmg-builder, electron-builder-squirrel-windows; electron-updater -> builder-util-runtime.
const PACKAGES = [
  "electron-builder",
  "app-builder-lib",
  "builder-util",
  "builder-util-runtime",
  "electron-publish",
  "dmg-builder",
  "electron-builder-squirrel-windows",
  "electron-updater",
]

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))

if (argv.includes("--unlink")) {
  let linkedCheckout = null
  if (packageJson.pnpm?.overrides) {
    const linked = packageJson.pnpm.overrides["electron-builder"]
    if (typeof linked === "string" && linked.startsWith("link:")) {
      linkedCheckout = path.resolve(projectDir, linked.slice("link:".length), "..", "..")
    }
    for (const name of PACKAGES) delete packageJson.pnpm.overrides[name]
    if (Object.keys(packageJson.pnpm.overrides).length === 0) delete packageJson.pnpm.overrides
    if (Object.keys(packageJson.pnpm).length === 0) delete packageJson.pnpm
  }
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n")
  console.log("removed pnpm.overrides for electron-builder packages")
  install()
  if (linkedCheckout != null) {
    // Observed with pnpm 10: when a link: override is removed, pnpm prunes node_modules INSIDE the previously linked
    // packages (packages/electron-builder/node_modules, packages/electron-updater/node_modules), which breaks the
    // checkout's CLI until its workspace is installed again.
    console.warn(`\nnote: pnpm removes node_modules inside the previously linked packages of ${linkedCheckout}.`)
    console.warn(`      Run \`pnpm install\` in ${linkedCheckout} before using that checkout again (or before the next \`pnpm link-builder\`).`)
  }
  process.exit(0)
}

const checkoutArg = argv.find(a => !a.startsWith("--"))
if (!checkoutArg) {
  console.error("usage: pnpm link-builder <path-to-electron-builder-checkout> | pnpm unlink-builder")
  process.exit(2)
}
const checkout = path.resolve(process.cwd(), checkoutArg)
const missing = PACKAGES.filter(name => !fs.existsSync(path.join(checkout, "packages", name, "package.json")))
if (missing.length > 0) {
  console.error(`${checkout} does not look like an electron-builder monorepo checkout; missing packages/: ${missing.join(", ")}`)
  process.exit(1)
}
const notCompiled = PACKAGES.filter(name => !fs.existsSync(path.join(checkout, "packages", name, "dist")))
if (notCompiled.length > 0) {
  console.warn(`warning: no dist/ in ${notCompiled.join(", ")} — run \`pnpm install && pnpm compile\` in ${checkout} (electron-builder will fail to load otherwise)`)
}
// The linked packages resolve their dependencies from the checkout's own node_modules (pnpm workspace links).
// A previous `pnpm unlink-builder` removes them (see below), so check before linking.
const notInstalled = PACKAGES.filter(name => !fs.existsSync(path.join(checkout, "packages", name, "node_modules")))
if (notInstalled.length > 0) {
  console.warn(`warning: no node_modules/ in packages/{${notInstalled.join(",")}} of ${checkout} — run \`pnpm install\` there first, otherwise the linked electron-builder cannot import app-builder-lib`)
}

packageJson.pnpm ??= {}
packageJson.pnpm.overrides ??= {}
for (const name of PACKAGES) {
  // relative path so the override survives a `git clone` to a sibling directory
  const rel = path.relative(projectDir, path.join(checkout, "packages", name)).split(path.sep).join("/")
  packageJson.pnpm.overrides[name] = `link:${rel}`
}
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n")
console.log(`pnpm.overrides -> link:${path.relative(projectDir, checkout)}/packages/{${PACKAGES.join(",")}}`)
install()
report()

function install() {
  console.log("> pnpm install")
  const result = spawnSync("pnpm", ["install"], { cwd: projectDir, stdio: "inherit", env: process.env })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function report() {
  // Only the two direct dependencies are visible in this project's node_modules; the linked packages resolve
  // app-builder-lib & co from the checkout's own node_modules (pnpm workspace links), which is why they are not listed.
  for (const name of ["electron-builder", "electron-updater"]) {
    const installed = path.join(projectDir, "node_modules", name)
    try {
      const real = fs.realpathSync(installed)
      const version = JSON.parse(fs.readFileSync(path.join(real, "package.json"), "utf8")).version
      console.log(`${name}@${version} -> ${real}`)
    } catch (e) {
      console.log(`${name}: not resolvable (${e.message})`)
    }
  }
  console.log("reminder: after changing the checkout run `pnpm compile` there; `pnpm unlink-builder` restores registry versions.")
}
