// electron-builder v27 configuration (CommonJS). Discovered automatically: v27 looks for
// electron-builder.{yml,yaml,json,json5,toml,js,cjs,ts} (app-builder-lib/src/util/config/load.ts findAndReadConfig).
// A JS file is used so the update-server URL and channel can come from the environment at release time
// (scripts/release.mjs sets them).
const url = process.env.UPDATE_SERVER_URL || "http://127.0.0.1:8080/"
const channel = process.env.UPDATE_CHANNEL || "latest"

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "com.mmaietta.autoupdate-proto",
  productName: "AutoUpdateProto",
  directories: {
    output: "dist",
    buildResources: "build", // build/electron-publisher-custom.js lives here (PublishManager.requireProviderClass)
  },
  files: ["main.js", "preload.js", "renderer.js", "index.html", "styles.css"],
  // v27: root `npmRebuild` moved under `nativeModules` (website/docs/migration/v27-breaking-changes.md).
  nativeModules: { npmRebuild: false },
  // latest -> also writes alpha*.yml + beta*.yml; beta -> also alpha*.yml (updateInfoBuilder.computeChannelNames)
  generateUpdatesFilesForAllChannels: true,

  // Order matters (PublishManager.getAppUpdatePublishConfiguration uses publishConfigs[0]):
  //   [0] generic  -> what gets embedded into resources/app-update.yml, so electron-updater polls `url`.
  //                   The generic provider never uploads anything (PublishManager.scheduleUpload early-return).
  //   [1] custom   -> build/electron-publisher-custom.js PUTs every artifact to the same server.
  //                   Its update-info yml files are written to dist/custom/ and uploaded through it, so
  //                   `publishAutoUpdate` must stay true and `channel` must match entry [0]
  //                   (updateInfoBuilder.createUpdateInfoTasks uses each publish config's own channel).
  publish: [
    { provider: "generic", url, channel },
    { provider: "custom", url, channel },
  ],

  mac: {
    // zip is required for latest-mac.yml / Squirrel.Mac; dmg is only for humans.
    target: ["zip", "dmg"],
    // v27: `mac.identity` moved to `mac.sign.identity`. Leave identity unset so electron-builder picks the
    // Developer ID Application certificate from the default keychain (or set CSC_NAME / CSC_LINK).
    sign: {
      hardenedRuntime: true,
    },
  },
  win: {
    target: ["nsis"],
  },
  nsis: {
    oneClick: true,
    perMachine: false, // per-user install: electron-updater can install silently and on next launch without UAC
  },
  linux: {
    target: ["AppImage"],
    category: "Utility",
  },
}
