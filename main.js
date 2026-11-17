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

// Packaged Windows/Linux apps have no visible stdout, so every log line and error event also goes to
// <userData>/updater-qa.log (macOS: ~/Library/Application Support/AutoUpdateProto, Windows: %APPDATA%\AutoUpdateProto).
const qaLogFile = path.join(app.getPath("userData"), "updater-qa.log")
function appendQaLog(line) {
  try {
    fs.appendFileSync(qaLogFile, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // logging must never break the updater
  }
}

// Logger object handed to autoUpdater.logger; mirrors to stdout, to the renderer and to updater-qa.log.
const logger = {}
for (const level of ["debug", "info", "warn", "error"]) {
  logger[level] = (...args) => {
    const message = args.map(a => (typeof a === "string" ? a : safeStringify(a))).join(" ")
    console[level === "debug" ? "log" : level](`[updater:${level}] ${message}`)
    appendQaLog(`[updater:${level}] ${message}`)
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
// The three buttons change it right before quitting. Unpackaged runs default to "manual": there is nothing to
// install, and MacUpdater would otherwise hand every download to Squirrel.Mac, which fails for an unpackaged app.
const QA = process.env
autoUpdater.autoInstallEvent = QA.QA_AUTO_INSTALL_EVENT || (app.isPackaged ? "onQuit" : "manual")

// ---------------------------------------------------------------------------
// QA toggles (environment variables, see QA_TEST_PLAN.md). All of them are applied synchronously before `ready`,
// so the install at launch of a pending update sees the same configuration as an update check.
// ---------------------------------------------------------------------------
if (QA.QA_FORCE_DEV === "0") autoUpdater.forceDevUpdateConfig = false
if (QA.QA_FEED) autoUpdater.setFeedURL({ provider: "generic", url: QA.QA_FEED })
if (QA.QA_CHANNEL) autoUpdater.channel = QA.QA_CHANNEL
if (QA.QA_ALLOW_INSECURE === "dev") autoUpdater.allowInsecureFeed = !app.isPackaged
if (QA.QA_ALLOW_INSECURE === "force") autoUpdater.allowInsecureFeed = true
if (QA.QA_AUTH === "1") {
  autoUpdater.requestHeaders = { "x-qa-tenant": "t1" }
  autoUpdater.addAuthHeader("Bearer QA-SECRET-TOKEN")
}
if (QA.QA_MAX_UPDATE_INFO_SIZE) autoUpdater.maxUpdateInfoSize = Number(QA.QA_MAX_UPDATE_INFO_SIZE)
// NsisUpdater only (Windows); a harmless extra property elsewhere
if (QA.QA_PUBLISHER_NAME) autoUpdater.publisherName = QA.QA_PUBLISHER_NAME
if (QA.QA_INSTALL_DIR) autoUpdater.installDirectory = QA.QA_INSTALL_DIR
// Linux deb/rpm/pacman: false makes rpm updates need a verified GPG signature and changes the apt log line (#10577)
if (QA.QA_ALLOW_UNVERIFIED_LINUX === "0") autoUpdater.allowUnverifiedLinuxPackages = false
if (QA.QA_CUSTOM_VERIFIER === "accept") {
  autoUpdater.verifyUpdateFileAuthenticodeSignature = async (publisherNames, file) => {
    logger.info(`[qa] custom verifier accepts ${file} (publisherNames: ${publisherNames.join(" | ")})`)
    return { response: "success" }
  }
}

// v7 alpha.14: required. It gets the lowercase NAMES of the headers about to be sent to another origin than the feed
// and returns the ones to send. The default "none" (() => []) keeps Authorization and custom headers on the feed's
// origin; "all" forwards everything (the leak the property exists to prevent, kept only to demonstrate it).
const CROSS_ORIGIN_POLICIES = {
  none: () => [],
  all: headerNames => headerNames,
  tenant: (headerNames, hop) => (hop.to.origin === "http://localhost:8081" ? headerNames.filter(it => it === "x-qa-tenant") : []),
  throw: () => {
    throw new Error("QA-SECRET-THROW")
  },
  bad: () => "authorization",
}
const crossOriginMode = QA.QA_CROSS_ORIGIN || "none"
if (crossOriginMode === "array") {
  autoUpdater.crossOriginHeaders = [] // not a function: same as unset
} else if (crossOriginMode !== "unset") {
  const policy = CROSS_ORIGIN_POLICIES[crossOriginMode] ?? CROSS_ORIGIN_POLICIES.none
  autoUpdater.crossOriginHeaders = (headerNames, hop) => {
    logger.info(`[qa] cross-origin hop ${hop.from.origin} -> ${hop.to.origin} offered [${headerNames.join(", ")}] (QA_CROSS_ORIGIN=${crossOriginMode})`)
    return policy(headerNames, hop)
  }
}

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
  autoUpdater.on(name, (...args) => {
    // "error" is emitted as (error, message): forward the error itself, so the status line shows its code
    if (name === "error") {
      appendQaLog(`[event:error] ${args[0]?.code ?? ""} ${args[0]?.message ?? args[0]}`)
      emitToRenderer(name, plain(args[0]))
      return
    }
    emitToRenderer(name, args.length <= 1 ? plain(args[0]) : args.map(plain))
  })
}

// "login" (v7 alpha.14: (authInfo, callback, url)) is emitted for authentication challenges on update requests.
// QA_LOGIN: origin (default) answers qa:secret only for a server challenge from the feed's own origin and cancels
// anything else; legacy is a pre-alpha.14 handler without the url argument that answers every challenge; throw;
// hang never answers (the request then times out); none registers no listener.
function emitLogin(authInfo, url) {
  let where = null
  try {
    where = url == null ? null : `${new URL(url).origin}${new URL(url).pathname}`
  } catch {
    where = "(unparsable url)"
  }
  logger.info(`[qa] login event: isProxy=${authInfo?.isProxy} host=${authInfo?.host}:${authInfo?.port} url=${where}`)
  emitToRenderer("login", { ...plain(authInfo), url: where })
}
function feedOrigin() {
  try {
    return new URL(QA.QA_FEED ?? readUpdateConfig().url ?? "http://127.0.0.1:8080/").origin
  } catch {
    return null
  }
}
switch (QA.QA_LOGIN || "origin") {
  case "origin":
    autoUpdater.on("login", (authInfo, callback, url) => {
      emitLogin(authInfo, url)
      let origin = null
      try {
        origin = url == null ? null : new URL(url).origin
      } catch {
        origin = null
      }
      if (authInfo?.isProxy !== true && origin != null && origin === feedOrigin()) {
        callback("qa", "secret")
      } else {
        callback()
      }
    })
    break
  case "legacy":
    autoUpdater.on("login", (authInfo, callback) => {
      emitLogin(authInfo, null)
      callback("qa", "secret")
    })
    break
  case "throw":
    autoUpdater.on("login", () => {
      throw new Error("QA-SECRET-LOGIN")
    })
    break
  case "hang":
    autoUpdater.on("login", authInfo => emitLogin(authInfo, null))
    break
  default: // "none": no listener
    break
}

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
    feedUrl: QA.QA_FEED ?? config.url ?? null,
    provider: config.provider ?? null,
    qaToggles: Object.keys(QA)
      .filter(it => it.startsWith("QA_"))
      .sort()
      .map(it => `${it}=${QA[it]}`),
    qaLogFile,
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

ipcMain.handle("updater:check", () => checkForUpdates())

// The "Check for updates" button, and QA_AUTO_CHECK=1 once the window has loaded.
async function checkForUpdates() {
  try {
    const result = await autoUpdater.checkForUpdates()
    if (result == null) {
      // isUpdaterActive() returned false (not packaged and forceDevUpdateConfig off)
      return { ok: true, result: null }
    }
    // QA_CANCEL_AFTER_MS: cancel the autoDownload download through the token checkForUpdates() returns (#10506)
    if (QA.QA_CANCEL_AFTER_MS && result.cancellationToken != null && result.downloadPromise != null) {
      const ms = Number(QA.QA_CANCEL_AFTER_MS)
      result.downloadPromise.catch(e => logger.info(`[qa] download promise rejected: ${e?.name ?? ""} ${e?.message ?? e}`))
      setTimeout(() => {
        logger.info(`[qa] cancelling the download after ${ms} ms`)
        result.cancellationToken.cancel()
      }, ms)
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
}

ipcMain.handle("updater:install", (_event, mode) => install(mode))

// The three install buttons, and QA_AFTER_DOWNLOAD once an update is downloaded.
function install(mode) {
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
      // QA_NEXT_LAUNCH_EVENT=keep leaves autoInstallEvent as it is (default "onQuit"): since alpha.14 (#10525) a
      // waitUntilNextLaunch update installs at the next launch with any autoInstallEvent but "manual".
      if (QA.QA_NEXT_LAUNCH_EVENT !== "keep") {
        autoUpdater.autoInstallEvent = "onNextLaunch"
      }
      autoUpdater.quitAndInstall({ waitUntilNextLaunch: true })
      return { mode, action: `autoInstallEvent=${autoUpdater.autoInstallEvent}; quitAndInstall({ waitUntilNextLaunch: true })` }

    case "skip":
      // The quit handler (already registered after download) checks autoInstallEvent at quit time and does nothing
      // for "manual". The downloaded installer stays in the updater cache and is reused (sha512 match) next time.
      autoUpdater.autoInstallEvent = "manual"
      setImmediate(() => app.quit())
      return { mode, action: "autoInstallEvent=manual; app.quit()" }

    default:
      return { mode, error: `unknown install mode "${mode}"` }
  }
}

// ---------------------------------------------------------------------------
// Unattended runs (qa/run/*.mjs): no clicks and no window to close.
//   QA_AFTER_DOWNLOAD=skip|on-quit|next-launch  on update-downloaded, do what that button does
//   QA_EXIT_WHEN_DONE=1                          quit once the check has settled (error, not available, cancelled,
//                                                downloaded, updater inactive); "[qa] done: <reason>" marks the end
//   QA_EXIT_AFTER_MS                             with QA_EXIT_WHEN_DONE: quit after this long regardless (default 120000)
// A packaged app with an update downloaded installs on quit (autoInstallEvent "onQuit"), so packaged runs that only
// want to look should set QA_AFTER_DOWNLOAD=skip.
// ---------------------------------------------------------------------------
const AFTER_DOWNLOAD_MODES = { skip: "skip", "on-quit": "on-quit", "next-launch": "next-launch" }
let doneReported = false
function qaDone(reason) {
  if (doneReported) return
  doneReported = true
  logger.info(`[qa] done: ${reason}`)
  if (QA.QA_EXIT_WHEN_DONE === "1") {
    setTimeout(() => app.quit(), 1000)
  }
}
if (QA.QA_AFTER_DOWNLOAD != null && AFTER_DOWNLOAD_MODES[QA.QA_AFTER_DOWNLOAD] == null) {
  logger.warn(`[qa] QA_AFTER_DOWNLOAD=${QA.QA_AFTER_DOWNLOAD} is not one of ${Object.keys(AFTER_DOWNLOAD_MODES).join(", ")}; ignored`)
}
autoUpdater.on("update-downloaded", () => {
  const mode = AFTER_DOWNLOAD_MODES[QA.QA_AFTER_DOWNLOAD]
  if (mode == null) {
    qaDone("update-downloaded")
    return
  }
  // reported first: install() quits the app itself
  doneReported = true
  logger.info(`[qa] done: update-downloaded -> ${mode}`)
  install(mode)
})
autoUpdater.on("update-not-available", () => qaDone("update-not-available"))
autoUpdater.on("update-cancelled", () => qaDone("update-cancelled"))
autoUpdater.on("error", error => qaDone(`error ${error?.code ?? ""}`.trim()))
if (QA.QA_EXIT_WHEN_DONE === "1") {
  const ms = Number(QA.QA_EXIT_AFTER_MS || 120000)
  setTimeout(() => {
    logger.info(`[qa] exit: timeout after ${ms} ms`)
    app.quit()
  }, ms).unref()
}

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

  // QA_AUTO_CHECK=1: check for updates as soon as the window has loaded (saves a click per relaunch)
  if (QA.QA_AUTO_CHECK === "1") {
    mainWindow.webContents.once("did-finish-load", async () => {
      const response = await checkForUpdates()
      const summary = response.ok
        ? { ok: true, isUpdateAvailable: response.result?.isUpdateAvailable ?? null, version: response.result?.updateInfo?.version ?? null }
        : { ok: false, code: response.error?.code ?? null }
      logger.info(`[qa] QA_AUTO_CHECK -> ${JSON.stringify(summary)}`)
      // the events above settle a check; these two outcomes emit none of them
      if (response.ok && response.result == null) qaDone("updater inactive")
      else if (!response.ok) qaDone(`check failed ${response.error?.code ?? ""}`.trim())
    })
  }

  // Startup: install an update a previous run deferred with "Update on next launch".
  // Resolves true when a pending update was validated and its installer spawned (the app quits right after),
  // false when nothing is pending / not supported (macOS) / not packaged.
  // QA_EXPLICIT_PENDING=0 skips this call, so only the updater's own install at launch (#10525) can install it.
  if (QA.QA_EXPLICIT_PENDING !== "0") {
    try {
      const installed = await autoUpdater.installPendingUpdateIfAvailable()
      logger.info(`installPendingUpdateIfAvailable() on launch -> ${installed}`)
      emitToRenderer("pending-install-on-launch", { installed })
    } catch (e) {
      logger.warn(`installPendingUpdateIfAvailable() failed on launch: ${e.message}`)
    }
  } else {
    logger.info("[qa] QA_EXPLICIT_PENDING=0: not calling installPendingUpdateIfAvailable() on launch")
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
