// Custom electron-builder publish provider (zero dependencies).
//
// Loaded by app-builder-lib PublishManager.requireProviderClass(): for `publish: [{ provider: "custom", ... }]` it looks for
// build/electron-publisher-custom.{mjs,js,cjs} in directories.buildResources and instantiates `new clazz(context, publishConfig)`.
// The schema only allows provider: "custom" for user-defined publishers (scheme.json CustomPublishOptions, provider const "custom").
//
// Contract (electron-publish/src/publisher.ts): `providerName` getter, `upload(task: UploadTask): Promise<any>`, `toString()`.
// UploadTask (electron-publish/src/index.ts) = { file, fileContent?, arch, safeArtifactName?, timeout? }.
// electron-builder calls upload() for every artifact (installer, blockmap, zip, dmg, AppImage) AND for the update-info
// yml files written for this publish config (updateInfoBuilder.writeUpdateInfoFiles emits them with fileContent set).
//
// Each file is PUT to `${url}/${basename}` — see server/update-server.mjs for the receiving side.
const fs = require("node:fs")
const http = require("node:http")
const https = require("node:https")
const path = require("node:path")

class LocalUpdateServerPublisher {
  constructor(context, publishConfig) {
    this.context = context
    this.config = publishConfig
    if (!publishConfig.url) {
      throw new Error('publish provider "custom": "url" is required (e.g. http://127.0.0.1:8080/)')
    }
    this.baseUrl = new URL(publishConfig.url.endsWith("/") ? publishConfig.url : `${publishConfig.url}/`)
  }

  get providerName() {
    return "custom"
  }

  toString() {
    return `custom (HTTP PUT to ${this.baseUrl.href})`
  }

  async upload(task) {
    const fileName = path.basename(task.file)
    const target = new URL(encodeURIComponent(fileName), this.baseUrl)
    const body = task.fileContent ?? null
    const size = body != null ? body.length : (await fs.promises.stat(task.file)).size
    const transport = target.protocol === "https:" ? https : http
    const headers = {
      ...(this.config.requestHeaders ?? {}),
      "Content-Type": "application/octet-stream",
      "Content-Length": size,
    }

    process.stdout.write(`  • uploading       file=${fileName} provider=custom size=${size} url=${target.href}\n`)

    await new Promise((resolve, reject) => {
      const request = transport.request(target, { method: "PUT", headers, timeout: task.timeout ?? 120_000 }, response => {
        let responseBody = ""
        response.setEncoding("utf8")
        response.on("data", chunk => (responseBody += chunk))
        response.on("end", () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve()
          } else {
            reject(new Error(`PUT ${target.href} failed: HTTP ${response.statusCode} ${responseBody.trim()}`))
          }
        })
      })
      request.on("timeout", () => request.destroy(new Error(`PUT ${target.href} timed out`)))
      request.on("error", reject)

      if (this.context?.cancellationToken != null) {
        this.context.cancellationToken.onCancel(() => request.destroy(new Error("upload cancelled")))
      }

      if (body != null) {
        request.end(body)
      } else {
        const stream = fs.createReadStream(task.file)
        stream.on("error", reject)
        stream.pipe(request)
      }
    })

    return target.href
  }
}

module.exports = LocalUpdateServerPublisher
