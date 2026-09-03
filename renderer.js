// Renderer: talks to main only through window.updater (see preload.js).
const $ = id => document.getElementById(id)

const logEl = $("log")
const statusEl = $("status")
const progressEl = $("progress")
const installButtons = $("install-buttons")

function log(line) {
  logEl.textContent += line + "\n"
  logEl.scrollTop = logEl.scrollHeight
}

function setStatus(text) {
  statusEl.textContent = `Status: ${text}`
}

async function refreshInfo() {
  const info = await window.updater.getInfo()
  $("app-version").textContent = info.appVersion
  $("channel").textContent = `${info.channel} (${info.channelSource})`
  $("feed-url").textContent = info.feedUrl ?? `(no url in ${info.configPath}: ${info.configError ?? "missing key"})`
  $("info-extra").textContent =
    `isPackaged=${info.isPackaged} platform=${info.platform}/${info.arch} provider=${info.provider} ` +
    `autoInstallEvent=${info.autoInstallEvent} allowDowngrade=${info.allowDowngrade} ` +
    `signedManifests=${info.signedManifests} electron-updater=${info.electronUpdaterVersion}`
  if ([...$("channel-select").options].some(o => o.value === info.channel)) {
    $("channel-select").value = info.channel
  }
  return info
}

$("runtime").textContent =
  `Electron ${window.updater.versions.electron}, Chromium ${window.updater.versions.chrome}, Node.js ${window.updater.versions.node}`

$("channel-select").addEventListener("change", async e => {
  const info = await window.updater.setChannel(e.target.value)
  log(`[ui] channel -> ${info.channel}, allowDowngrade=${info.allowDowngrade}`)
  await refreshInfo()
})

$("check").addEventListener("click", async () => {
  installButtons.hidden = true
  progressEl.textContent = ""
  setStatus("checking...")
  const response = await window.updater.check()
  if (!response.ok) {
    setStatus(`❌ error ${response.error.code ?? ""} ${response.error.message}`)
    return
  }
  if (response.result == null) {
    setStatus("❌ updater inactive (not packaged and forceDevUpdateConfig is off)")
    return
  }
  const { isUpdateAvailable, updateInfo, willDownload } = response.result
  log(`[ui] checkForUpdates -> isUpdateAvailable=${isUpdateAvailable} version=${updateInfo.version} willDownload=${willDownload}`)
})

for (const [id, mode] of [
  ["install-on-quit", "on-quit"],
  ["install-next-launch", "next-launch"],
  ["install-skip", "skip"],
]) {
  $(id).addEventListener("click", async () => {
    const result = await window.updater.install(mode)
    log(`[ui] install(${mode}) -> ${JSON.stringify(result)}`)
  })
}

window.updater.onEvent(({ ts, type, payload }) => {
  const time = ts.slice(11, 23)
  switch (type) {
    case "log":
      log(`${time} [${payload.level}] ${payload.message}`)
      return
    case "checking-for-update":
      setStatus("checking...")
      break
    case "update-available":
      setStatus(`✅ update available: ${payload.version} (downloading...)`)
      break
    case "update-not-available":
      setStatus(`❌ no update (server has ${payload.version})`)
      break
    case "download-progress":
      progressEl.textContent =
        `Download: ${payload.percent.toFixed(1)}% (${payload.transferred}/${payload.total} bytes, ${Math.round(payload.bytesPerSecond / 1024)} KB/s)`
      return
    case "update-downloaded":
      setStatus(`✅ downloaded ${payload.version} -> ${payload.downloadedFile}`)
      progressEl.textContent = "Download: complete"
      installButtons.hidden = false
      break
    case "error":
      setStatus(`❌ error ${payload?.code ?? ""} ${payload?.message ?? payload}`)
      break
    default:
      break
  }
  log(`${time} ${type} ${payload === undefined ? "" : JSON.stringify(payload)}`)
})

refreshInfo().then(info => log(`[ui] loaded: ${JSON.stringify(info)}`))
