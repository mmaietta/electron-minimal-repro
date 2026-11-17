// Drives the Parallels VMs from the Mac with `prlctl exec` (sessions W and L, the e2e runner's VM checks).
//
// prlctl joins its arguments into one command line, so quoting does not survive: PowerShell goes as -EncodedCommand
// (UTF-16LE base64) and bash as `echo <base64> | base64 -d | bash`.
//   --current-user  runs in the logged-in user's session (no admin): app launches, per-user installs
//   (without it)    SYSTEM on Windows, root on Linux: netsh portproxy, certificate stores, moving pkexec
import { sh } from "./lib.mjs"

export const WIN_VM = process.env.QA_WIN_VM ?? "Windows 11 (1)"
export const LINUX_VM = process.env.QA_LINUX_VM ?? "Ubuntu 24.04 ARM64"

// The Mac on the Parallels shared network: the bridge whose IPv4 is in 10.211.55.0/24, unless QA_MAC_IP says otherwise.
export function macIp() {
  if (process.env.QA_MAC_IP) return process.env.QA_MAC_IP
  const out = sh("ifconfig", []).stdout
  const match = /inet (10\.211\.55\.\d+) /.exec(out)
  if (match == null) throw new Error("no 10.211.55.x address on this Mac (Parallels shared network): set QA_MAC_IP")
  return match[1]
}

// "running" | "suspended" | "stopped" | ... | null when the VM does not exist
export function vmState(name) {
  const result = sh("prlctl", ["list", "-a", "-o", "status,name", "--no-header"])
  for (const line of result.stdout.split("\n")) {
    const m = /^\s*(\S+)\s+(.+?)\s*$/.exec(line)
    if (m != null && m[2] === name) return m[1]
  }
  return null
}

// prlctl now and then fails a job with "PrlJob_GetResult: Invalid argument" before the command runs: retry that once
function prlExec(args, timeoutMs) {
  let result = sh("prlctl", ["exec", ...args], { timeoutMs })
  if (result.code !== 0 && /PrlJob_GetResult|Unable to open new session/.test(result.out)) {
    result = sh("prlctl", ["exec", ...args], { timeoutMs })
  }
  return result
}

function stripClixml(text) {
  return text
    .replace(/#< CLIXML\r?\n?/g, "")
    .replace(/<Objs Version=[\s\S]*?<\/Objs>/g, "")
    .replace(/\r/g, "")
}

// Runs a PowerShell script in the Windows VM. Resolves with { code, out }. Errors stop the script
// ($ErrorActionPreference = "Stop") and give a non-zero exit code.
export function win(script, { system = false, timeoutMs = 600_000 } = {}) {
  const full = `$ProgressPreference = "SilentlyContinue"\n$ErrorActionPreference = "Stop"\ntry {\n${script}\n} catch { Write-Output ("PS-ERROR: " + $_.Exception.Message); exit 1 }`
  const encoded = Buffer.from(full, "utf16le").toString("base64")
  if (encoded.length > 30_000) throw new Error("PowerShell script too long for one command line")
  const result = prlExec([WIN_VM, ...(system ? [] : ["--current-user"]), "powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], timeoutMs)
  return { code: result.code, out: stripClixml(result.out) }
}

// The GUI session of the Ubuntu VM's user (uid 1000): Wayland, with XWayland on :0.
const LINUX_GUI_ENV = "export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 DISPLAY=:0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus"

// Runs a bash script in the Linux VM. { root } runs it as root, { gui } adds the desktop session's display variables.
export function linux(script, { root = false, gui = false, timeoutMs = 600_000 } = {}) {
  const full = `set -o pipefail\n${gui ? `${LINUX_GUI_ENV}\n` : ""}${script}`
  const encoded = Buffer.from(full, "utf8").toString("base64")
  const result = prlExec([LINUX_VM, ...(root ? [] : ["--current-user"]), `echo ${encoded} | base64 -d | bash`], timeoutMs)
  return { code: result.code, out: result.out.replace(/\r/g, "") }
}

// PowerShell single-quoted string literal
export const psq = value => `'${String(value).replace(/'/g, "''")}'`
// bash single-quoted string literal
export const bq = value => `'${String(value).replace(/'/g, `'\\''`)}'`

// Forwards the VM's loopback ports to the Mac (QA_TEST_PLAN.md S5), so the baked-in http://127.0.0.1:8080/ feed
// stays loopback (plain http to any other host fails with ERR_UPDATER_INSECURE_FEED). Idempotent.
export function forwardWindowsPorts(ports = [8080, 8081]) {
  const ip = macIp()
  const lines = ports.map(port => `netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=${port} | Out-Null; netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=${port} connectaddress=${ip} connectport=${port} | Out-Null`)
  return win(`${lines.join("\n")}\nnetsh interface portproxy show v4tov4`, { system: true })
}

export function forwardLinuxPorts(ports = [8080, 8081]) {
  const ip = macIp()
  const lines = ports.map(port => `pkill -f "socat TCP-LISTEN:${port}," || true\nsetsid -f socat TCP-LISTEN:${port},bind=127.0.0.1,reuseaddr,fork TCP:${ip}:${port} >/dev/null 2>&1`)
  return linux(`${lines.join("\n")}\nsleep 0.5\npgrep -af "socat TCP-LISTEN" || true`)
}

// Whether the guest reaches the Mac's update server through its loopback forward
export function windowsReaches(port = 8080) {
  const result = win(`try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 http://127.0.0.1:${port}/).StatusCode } catch { "unreachable: " + $_.Exception.Message }`)
  return result.out.trim().startsWith("200")
}

export function linuxReaches(port = 8080) {
  return linux(`curl -fsS -o /dev/null -w "%{http_code}" --max-time 10 http://127.0.0.1:${port}/ || true`).out.trim().endsWith("200")
}
