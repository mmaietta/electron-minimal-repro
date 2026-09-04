// Main process: stock quick-start window + electron-updater v7 wiring.
const { app, BrowserWindow, ipcMain } = require("electron")
const fs = require("node:fs")
const path = require("node:path")
const { autoUpdater } = require("electron-updater")

let mainWindow = null

// ---------------------------------------------------------------------------
// Event forwarding: everything goes to the renderer as { ts, type, payload }
// ---------------------------------------------------------------------------
function emitToRenderer(type, payload) {
  const event = { ts: new Date().toISOString(), type, payload }
  if (mainWindow != null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("updater:event", event)
  }
}

// Logger object handed to autoUpdater.logger; mirrors to stdout and to the renderer.
const logger = {}
for (const level of ["debug", "info", "warn", "error"]) {
  logger[level] = (...args) => {
    const message = args.map(a => (typeof a === "string" ? a : safeStringify(a))).join(" ")
    console[level === "debug" ? "log" : level](`[updater:${level}] ${message}`)
    emitToRenderer("log", { level, message })
  }
}

function safeStringify(value) {
  if (value instanceof Error) {
    return JSON.stringify({ name: value.name, message: value.message, code: value.code, stack: value.stack })
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// Serialize event payloads so they survive structured clone over IPC.
function plain(value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: value.code, stack: value.stack }
  }
  if (value == null) {
    return value
  }
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// autoUpdater configuration (electron-updater v7 API)
// ---------------------------------------------------------------------------
autoUpdater.logger = logger
autoUpdater.autoDownload = true
// dev: read ./dev-app-update.yml instead of resources/app-update.yml (checks + downloads work, install does not)
autoUpdater.forceDevUpdateConfig = !app.isPackaged
// v7: autoInstallOnAppQuit is gone; autoInstallEvent is "onQuit" (default) | "onNextLaunch" | "manual".
// Kept at the default here; the three buttons change it right before quitting.
autoUpdater.autoInstallEvent = "onQuit"

// Every event in AppUpdaterEvents (electron-updater/src/AppUpdater.ts) plus the legacy UpdaterEvents union.
const UPDATER_EVENTS = [
  "checking-for-update",
  "update-available",
  "update-not-available",
  "download-progress",
  "update-downloaded",
  "update-cancelled",
  "appimage-filename-updated",
  "error",
]
for (const name of UPDATER_EVENTS) {
  autoUpdater.on(name, (...args) => emitToRenderer(name, args.length <= 1 ? plain(args[0]) : args.map(plain)))
}
// "login" carries a callback and is only emitted for authenticated feeds; log it, never forward the callback.
autoUpdater.on("login", authInfo => emitToRenderer("login", plain(authInfo)))

// ---------------------------------------------------------------------------
// Update config introspection (feed URL / channel shown in the UI)
// ---------------------------------------------------------------------------
function updateConfigPath() {
  return app.isPackaged ? path.join(process.resourcesPath, "app-update.yml") : path.join(app.getAppPath(), "dev-app-update.yml")
}

// Tiny "yaml" reader: top-level scalar keys only, which is all app-update.yml uses for provider/url/channel.
function readUpdateConfig() {
  const result = { path: updateConfigPath() }
  try {
    const text = fs.readFileSync(result.path, "utf8")
    for (const line of text.split(/\r?\n/)) {
      const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
      if (m && m[2] !== "" && m[2] !== "|") {
        result[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
      }
    }
    result.hasPublicKey = /^(?!\s*#)\s*updateManifestPublicKey:/m.test(text)
  } catch (e) {
    result.error = e.message
  }
  return result
}

function getInfo() {
  const config = readUpdateConfig()
  return {
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    channel: autoUpdater.channel ?? config.channel ?? "latest",
    channelSource: autoUpdater.channel != null ? "autoUpdater.channel" : "update config",
    feedUrl: config.url ?? null,
    provider: config.provider ?? null,
    configPath: config.path,
    configError: config.error ?? null,
    signedManifests: Boolean(config.hasPublicKey) || autoUpdater.updateManifestPublicKey != null,
    autoInstallEvent: autoUpdater.autoInstallEvent,
    allowDowngrade: autoUpdater.allowDowngrade,
    autoDownload: autoUpdater.autoDownload,
    forceDevUpdateConfig: autoUpdater.forceDevUpdateConfig,
    electronUpdaterVersion: require("electron-updater/package.json").version,
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle("updater:info", () => getInfo())

ipcMain.handle("updater:set-channel", (_event, channel) => {
  // AppUpdater.ts: the channel setter also sets allowDowngrade = true (so latest -> alpha -> latest works).
  autoUpdater.channel = channel
  logger.info(`channel set to "${channel}" (allowDowngrade is now ${autoUpdater.allowDowngrade})`)
  return getInfo()
})

ipcMain.handle("updater:check", async () => {
  try {
    const result = await autoUpdater.checkForUpdates()
    if (result == null) {
      // isUpdaterActive() returned false (not packaged and forceDevUpdateConfig off)
      return { ok: true, result: null }
    }
    return {
      ok: true,
      result: {
        isUpdateAvailable: result.isUpdateAvailable,
        updateInfo: plain(result.updateInfo),
        willDownload: result.downloadPromise != null,
      },
    }
  } catch (e) {
    logger.error(`checkForUpdates failed: ${e.message}`)
    return { ok: false, error: plain(e) }
  }
})

ipcMain.handle("updater:install", (_event, mode) => {
  logger.info(`install mode chosen: ${mode}`)
  switch (mode) {
    case "on-quit":
      // BaseUpdater.addQuitHandler(): on app.quit() with exit code 0 and autoInstallEvent === "onQuit",
      // install(isSilent = true, isForceRunAfter = false) spawns the installer while the app exits.
      autoUpdater.autoInstallEvent = "onQuit"
      setImmediate(() => app.quit())
      return { mode, action: "autoInstallEvent=onQuit; app.quit()" }

    case "next-launch":
      // BaseUpdater.quitAndInstall({ waitUntilNextLaunch: true }): writes the install-on-next-launch marker into
      // the updater cache (pending/update-info.json) and quits by itself. If no update is downloaded it emits
      // "error" and does NOT quit. On the next launch main.js calls installPendingUpdateIfAvailable() (below).
      // macOS: MacUpdater just quits, Squirrel.Mac already staged the update and applies it on relaunch.
      autoUpdater.autoInstallEvent = "onNextLaunch"
      autoUpdater.quitAndInstall({ waitUntilNextLaunch: true })
      return { mode, action: "autoInstallEvent=onNextLaunch; quitAndInstall({ waitUntilNextLaunch: true })" }

    case "skip":
      // The quit handler (already registered after download) checks autoInstallEvent at quit time and does nothing
      // for "manual". The downloaded installer stays in the updater cache and is reused (sha512 match) next time.
      autoUpdater.autoInstallEvent = "manual"
      setImmediate(() => app.quit())
      return { mode, action: "autoInstallEvent=manual; app.quit()" }

    default:
      return { mode, error: `unknown install mode "${mode}"` }
  }
})

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  })
  mainWindow.loadFile("index.html")
}

app.whenReady().then(async () => {
  createWindow()

  // Startup: install an update a previous run deferred with "Update on next launch".
  // Resolves true when a pending update was validated and its installer spawned (the app quits right after),
  // false when nothing is pending / not supported (macOS) / not packaged.
  try {
    const installed = await autoUpdater.installPendingUpdateIfAvailable()
    logger.info(`installPendingUpdateIfAvailable() on launch -> ${installed}`)
    emitToRenderer("pending-install-on-launch", { installed })
  } catch (e) {
    logger.warn(`installPendingUpdateIfAvailable() failed on launch: ${e.message}`)
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
