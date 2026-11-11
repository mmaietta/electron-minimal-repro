#!/usr/bin/env node
// Zero-dependency update server for the electron-updater "generic" provider.
//
//   node server/update-server.mjs [--port 8080] [--host 127.0.0.1] [--dir server/updates]
//                                 [--redirect-match <regex> --redirect-to <base-url> [--redirect-status 302]]
//                                 [--auth <regex>] [--throttle-kbps <n>] [--extra-bytes <file>:<n>]
//
// - GET/HEAD /<file>   static file with Content-Length + Accept-Ranges.
//                      Single Range  -> 206 with Content-Range.
//                      Multiple ranges -> 206 multipart/byteranges (electron-updater's differential download uses
//                      useMultipleRangeRequest: true by default; framing adapted from electron-builder
//                      test/src/helpers/launchAppCrossPlatform.ts createLocalServer, which matches DataSplitter).
// - PUT/POST /<file>   receives an upload from build/electron-publisher-custom.js. Written atomically
//                      (tmp file + rename) -> 201 Created.
// - GET /              plain-text listing of the directory.
// - Every request is logged: method, path, status, range, body bytes actually sent, the Host, the NAMES of the
//   request headers and query parameters (never their values), and ABORTED when the client closed the connection
//   before the response ended.
//
// QA options (QA_TEST_PLAN.md). Pass them as `--flag value`:
//   --redirect-match <regex>   GET/HEAD paths matching it are answered with a redirect to
//   --redirect-to <base-url>   <base-url><path><query>, e.g. another port (another origin) for cross-origin tests
//   --redirect-status <n>      301 | 302 | 303 | 307 | 308, default 302
//   --auth <regex>             paths matching it need `Authorization: Basic qa:secret`, else 401 + WWW-Authenticate
//   --throttle-kbps <n>        send response bodies at about n KiB/s (cancel tests)
//   --extra-bytes <file>:<n>   a full GET of <file> gets n zero bytes more than the file (size-cap tests)
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"

const args = parseArgs(process.argv.slice(2))
const port = Number(args.port ?? 8080)
const host = args.host ?? "127.0.0.1"
const root = path.resolve(args.dir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "updates"))
fs.mkdirSync(root, { recursive: true })

const MULTIPART_BOUNDARY = "electron-updater-range-boundary"
const QA_BASIC_AUTH = `Basic ${Buffer.from("qa:secret").toString("base64")}`
const redirectMatch = typeof args["redirect-match"] === "string" ? new RegExp(args["redirect-match"]) : null
const redirectTo = typeof args["redirect-to"] === "string" ? args["redirect-to"].replace(/\/+$/, "") : null
const redirectStatus = Number(args["redirect-status"] ?? 302)
const authMatch = typeof args.auth === "string" ? new RegExp(args.auth) : null
const throttleBytesPerSecond = Number(args["throttle-kbps"] ?? 0) * 1024
const extraBytes = parseExtraBytes(args["extra-bytes"])
if ((redirectMatch == null) !== (redirectTo == null)) {
  console.error("--redirect-match and --redirect-to must be used together")
  process.exit(2)
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now()
  const counter = { bytes: 0 }
  const rangeHeader = req.headers.range
  const url = new URL(req.url ?? "/", "http://localhost")
  let logged = false
  const finish = aborted => {
    if (logged) return
    logged = true
    const ms = Date.now() - startedAt
    let pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      pathname = url.pathname
    }
    const headerNames = Object.keys(req.headers).sort().join(",")
    const queryNames = [...new Set(url.searchParams.keys())].join(",")
    console.log(
      `${new Date().toISOString()} ${req.method} ${pathname} -> ${res.statusCode}` +
        `${rangeHeader ? ` range="${rangeHeader}"` : ""} bytes=${counter.bytes} ${ms}ms` +
        ` host=${req.headers.host ?? "-"} hdr=[${headerNames}]${queryNames ? ` q=[${queryNames}]` : ""}${aborted ? " ABORTED" : ""}`
    )
  }
  res.once("finish", () => finish(false))
  res.once("close", () => {
    if (!res.writableFinished) finish(true)
  })

  try {
    if (authMatch != null && authMatch.test(url.pathname) && req.headers.authorization !== QA_BASIC_AUTH) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="qa"', "Content-Length": 0 })
      res.end()
      return
    }

    if (redirectMatch != null && redirectTo != null && (req.method === "GET" || req.method === "HEAD") && redirectMatch.test(url.pathname)) {
      res.writeHead(redirectStatus, { Location: `${redirectTo}${url.pathname}${url.search}`, "Content-Length": 0 })
      res.end()
      return
    }

    const resolved = resolveSafe(url.pathname)
    if (resolved == null) {
      return send(res, 403, "Forbidden: path escapes the updates directory\n")
    }
    const { filePath, relative } = resolved

    if (req.method === "GET" || req.method === "HEAD") {
      if (relative === "") {
        return listDirectory(req, res)
      }
      const stat = await fs.promises.stat(filePath).catch(() => null)
      if (stat == null || !stat.isFile()) {
        return send(res, 404, `Not found: ${relative}\n`)
      }
      await serveFile(req, res, filePath, stat, rangeHeader, counter, extraBytes.get(relative) ?? 0)
      return
    }

    if (req.method === "PUT" || req.method === "POST") {
      if (relative === "" || relative.endsWith("/")) {
        return send(res, 400, "Bad request: upload target must be a file name\n")
      }
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
      try {
        const out = fs.createWriteStream(tmp)
        req.on("data", chunk => (counter.bytes += chunk.length))
        await pipeline(req, out)
        await fs.promises.rename(tmp, filePath)
      } catch (e) {
        await fs.promises.rm(tmp, { force: true })
        throw e
      }
      res.writeHead(201, { "Content-Type": "text/plain; charset=utf-8", Location: `/${encodeURIComponent(relative)}` })
      res.end(`Created ${relative} (${counter.bytes} bytes)\n`)
      return
    }

    res.setHeader("Allow", "GET, HEAD, PUT, POST")
    send(res, 405, "Method not allowed\n")
  } catch (e) {
    if (e?.code === "ERR_STREAM_PREMATURE_CLOSE" || e?.code === "EPIPE" || e?.code === "ECONNRESET") {
      return // the client closed the connection; the close handler logs it (ABORTED unless the response had ended)
    }
    console.error(e)
    if (!res.headersSent) {
      send(res, 500, `Internal error: ${e.message}\n`)
    } else {
      res.destroy()
    }
  }
})

server.listen(port, host, () => {
  console.log(`update server serving ${root}`)
  for (const address of listenUrls(host, port)) {
    console.log(`  ${address}`)
  }
  for (const line of describeQaOptions()) {
    console.log(`  qa: ${line}`)
  }
  console.log("release with:  UPDATE_SERVER_URL=<one of the URLs above> pnpm release --version X.Y.Z --publish")
})

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const [key, inlineValue] = a.slice(2).split("=", 2)
      if (inlineValue !== undefined) {
        out[key] = inlineValue
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        out[key] = argv[++i]
      } else {
        out[key] = true
      }
    }
  }
  if (out.help) {
    console.log(
      "usage: node server/update-server.mjs [--port 8080] [--host 127.0.0.1] [--dir server/updates]\n" +
        "         [--redirect-match <regex> --redirect-to <base-url> [--redirect-status 302]] [--auth <regex>]\n" +
        "         [--throttle-kbps <n>] [--extra-bytes <file>:<n>]"
    )
    process.exit(0)
  }
  return out
}

// "--extra-bytes AutoUpdateProto-1.0.1-arm64-mac.zip:20000000" -> Map { name => 20000000 }
function parseExtraBytes(value) {
  const result = new Map()
  if (typeof value !== "string") return result
  for (const entry of value.split(",")) {
    const separator = entry.lastIndexOf(":")
    const count = Number(entry.slice(separator + 1))
    if (separator <= 0 || !Number.isInteger(count) || count <= 0) {
      console.error(`--extra-bytes: expected <file>:<positive integer>, got "${entry}"`)
      process.exit(2)
    }
    result.set(entry.slice(0, separator), count)
  }
  return result
}

function describeQaOptions() {
  const lines = []
  if (redirectMatch != null) lines.push(`redirect ${redirectMatch} -> ${redirectTo}<path> (${redirectStatus})`)
  if (authMatch != null) lines.push(`basic auth qa:secret required for ${authMatch}`)
  if (throttleBytesPerSecond > 0) lines.push(`throttle ${throttleBytesPerSecond / 1024} KiB/s`)
  for (const [name, count] of extraBytes) lines.push(`${name}: ${count} extra bytes on a full GET`)
  return lines
}

function listenUrls(bindHost, bindPort) {
  if (bindHost !== "0.0.0.0" && bindHost !== "::") {
    return [`http://${bindHost}:${bindPort}/`]
  }
  const urls = [`http://127.0.0.1:${bindPort}/`]
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) {
        urls.push(`http://${addr.address}:${bindPort}/   (${name}, use this from a VM / other machine)`)
      }
    }
  }
  return urls
}

// Returns null when the decoded path would escape `root` (path traversal), otherwise the absolute file path.
function resolveSafe(pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes("\0")) {
    return null
  }
  const relative = decoded.replace(/^\/+/, "")
  const filePath = path.resolve(root, relative)
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    return null
  }
  return { filePath, relative: path.relative(root, filePath).split(path.sep).join("/") + (decoded.endsWith("/") && relative !== "" ? "/" : "") }
}

function send(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(text) })
  res.end(text)
}

async function listDirectory(req, res) {
  const entries = await fs.promises.readdir(root, { withFileTypes: true })
  const lines = [`# ${root}`, ""]
  for (const entry of entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
    const stat = await fs.promises.stat(path.join(root, entry.name))
    lines.push(`${String(stat.size).padStart(12)}  ${stat.mtime.toISOString()}  ${entry.name}`)
  }
  if (entries.length === 0) {
    lines.push("(empty — run `pnpm release --version X.Y.Z --publish` or `pnpm publish:copy`)")
  }
  const text = lines.join("\n") + "\n"
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(text) })
  res.end(req.method === "HEAD" ? undefined : text)
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".yml" || ext === ".yaml") return "text/yaml; charset=utf-8"
  if (ext === ".json") return "application/json"
  if (ext === ".txt") return "text/plain; charset=utf-8"
  return "application/octet-stream"
}

// Counts the body bytes handed to the response (counter.bytes) and, with --throttle-kbps, paces them.
function meter(counter) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      counter.bytes += chunk.length
      if (throttleBytesPerSecond > 0) {
        setTimeout(() => callback(null, chunk), (chunk.length / throttleBytesPerSecond) * 1000)
      } else {
        callback(null, chunk)
      }
    },
  })
}

// One body stream per response (piped into it once): writing parts through several pipeline() calls stacks
// listeners on the response, one set per part, and a differential download asks for up to 200 ranges at a time.
async function* fileThenZeros(filePath, extra) {
  yield* fs.createReadStream(filePath)
  for (let left = extra; left > 0; left -= 64 * 1024) {
    yield Buffer.alloc(Math.min(64 * 1024, left))
  }
}

async function* multipartBody(filePath, parts, trailer) {
  for (const part of parts) {
    yield Buffer.from(part.header)
    yield* fs.createReadStream(filePath, { start: part.start, end: part.end })
  }
  yield Buffer.from(trailer)
}

// Serves a whole file (200) or byte ranges (206 single / multipart). counter.bytes counts what was actually sent.
async function serveFile(req, res, filePath, stat, rangeHeader, counter, extra) {
  const size = stat.size
  const type = contentType(filePath)
  res.setHeader("Accept-Ranges", "bytes")
  res.setHeader("Last-Modified", stat.mtime.toUTCString())
  res.setHeader("ETag", `"${stat.size}-${Number(stat.mtimeMs).toString(16)}"`)
  res.setHeader("Cache-Control", "no-cache")

  if (!rangeHeader) {
    res.writeHead(200, { "Content-Length": size + extra, "Content-Type": type })
    if (req.method === "HEAD") {
      res.end()
      return
    }
    await pipeline(Readable.from(fileThenZeros(filePath, extra)), meter(counter), res)
    return
  }

  const ranges = parseByteRanges(rangeHeader, size)
  if (ranges == null) {
    res.writeHead(416, { "Content-Range": `bytes */${size}` })
    res.end()
    return
  }

  if (ranges.length === 1) {
    const [start, end] = ranges[0]
    res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1, "Content-Type": type })
    if (req.method === "HEAD") {
      res.end()
      return
    }
    await pipeline(fs.createReadStream(filePath, { start, end }), meter(counter), res)
    return
  }

  // multipart/byteranges. electron-updater's DataSplitter expects the very first boundary WITHOUT a leading CRLF.
  const parts = ranges.map(([start, end], i) => ({
    start,
    end,
    header: `${i === 0 ? "" : "\r\n"}--${MULTIPART_BOUNDARY}\r\nContent-Type: ${type}\r\nContent-Range: bytes ${start}-${end}/${size}\r\n\r\n`,
  }))
  const trailer = `\r\n--${MULTIPART_BOUNDARY}--\r\n`
  const contentLength = parts.reduce((n, p) => n + Buffer.byteLength(p.header) + (p.end - p.start + 1), 0) + Buffer.byteLength(trailer)
  res.writeHead(206, { "Content-Type": `multipart/byteranges; boundary=${MULTIPART_BOUNDARY}`, "Content-Length": contentLength })
  if (req.method === "HEAD") {
    res.end()
    return
  }
  await pipeline(Readable.from(multipartBody(filePath, parts, trailer)), meter(counter), res)
}

function parseByteRanges(header, size) {
  const m = /^bytes=(.+)$/.exec(header)
  if (!m || size === 0) return null
  const ranges = []
  for (const raw of m[1].split(",")) {
    const [s, e] = raw.trim().split("-")
    const start = s === "" ? size - parseInt(e, 10) : parseInt(s, 10)
    const end = e === "" ? size - 1 : Math.min(parseInt(e, 10), size - 1)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end) return null
    ranges.push([start, end])
  }
  return ranges.length > 0 ? ranges : null
}
