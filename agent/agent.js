import { execFile, execSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import robot from "robotjs";
import screenshotDesktop from "screenshot-desktop";

const execFileAsync = promisify(execFile);
const AGENT_VERSION = "1.12.1";
const AGENT_BOOT_ID = crypto.randomUUID();
const AGENT_BOOT_STARTED_AT = Date.now();
const INSTANCE_LOCK_PATH = path.resolve("agent.instance.lock");
const CONFIG_PATH = path.resolve("agent.config.json");
const EXAMPLE_CONFIG_PATH = path.resolve("agent.config.example.json");
const STATE_PATH = path.resolve("agent.state.json");
const DEFAULT_MAX_CLIPBOARD_TEXT_BYTES = 8192;
let lastConfigMtimeMs = 0;

const DIAGNOSTIC_COMMANDS = {
  node_version: {
    file: process.platform === "win32" ? "node.exe" : "node",
    args: ["--version"],
  },
  npm_version: {
    file: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["--version"],
  },
  git_version: {
    file: process.platform === "win32" ? "git.exe" : "git",
    args: ["--version"],
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function releaseInstanceLock() {
  try {
    const lock = JSON.parse(fs.readFileSync(INSTANCE_LOCK_PATH, "utf8"));
    if (Number(lock?.pid) === process.pid) {
      fs.unlinkSync(INSTANCE_LOCK_PATH);
    }
  } catch {}
}

function acquireInstanceLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(INSTANCE_LOCK_PATH, "wx");
      fs.writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        bootId: AGENT_BOOT_ID,
        startedAt: new Date().toISOString(),
      }));
      fs.closeSync(fd);
      process.once("exit", releaseInstanceLock);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        const existing = JSON.parse(fs.readFileSync(INSTANCE_LOCK_PATH, "utf8"));
        if (processIsAlive(Number(existing?.pid))) {
          throw new Error(`Another local agent process is already running (PID ${existing.pid}).`);
        }
        fs.unlinkSync(INSTANCE_LOCK_PATH);
      } catch (lockError) {
        if (/Another local agent process/.test(String(lockError?.message || ""))) {
          throw lockError;
        }
        try {
          fs.unlinkSync(INSTANCE_LOCK_PATH);
        } catch {}
      }
    }
  }
  throw new Error("Could not acquire the local agent instance lock.");
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(filePath, fallback = null) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (fallback !== null && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function loadConfig() {
  const exists = fs.existsSync(CONFIG_PATH);
  if (!exists) {
    const exampleExists = fs.existsSync(EXAMPLE_CONFIG_PATH);
    if (!exampleExists) {
      throw new Error("agent.config.json is missing.");
    }
    throw new Error("Copy agent.config.example.json to agent.config.json and edit it first.");
  }

  const config = await readJson(CONFIG_PATH);
  const configuredServerUrl = config.serverUrl || config.serverUri;
  if (!configuredServerUrl || !config.enrollmentCode) {
    throw new Error("serverUrl/serverUri and enrollmentCode are required in agent.config.json.");
  }
  const reconnectMinMs = Math.round(clampNumber(config.reconnectMinMs, 100, 60000, 250));
  const initialTransportMode = ["poll", "long-poll", "auto"].includes(String(config.initialTransportMode))
    ? String(config.initialTransportMode)
    : "poll";

  return {
    serverUrl: String(configuredServerUrl).replace(/\/+$/, ""),
    enrollmentCode: String(config.enrollmentCode),
    deviceName: String(config.deviceName || os.hostname()),
    pollIntervalMs: Math.round(clampNumber(config.pollIntervalMs, 50, 60000, 5000)),
    longPollMs: Math.round(clampNumber(config.longPollMs, 0, 25000, 15000)),
    initialTransportMode,
    requestTimeoutMs: Math.round(clampNumber(config.requestTimeoutMs, 5000, 120000, 30000)),
    heartbeatLogMs: Math.round(clampNumber(config.heartbeatLogMs, 10000, 300000, 30000)),
    reconnectMinMs,
    reconnectMaxMs: Math.round(clampNumber(config.reconnectMaxMs, reconnectMinMs, 120000, 10000)),
    configReloadMs: Math.round(clampNumber(config.configReloadMs, 1000, 60000, 2000)),
    logDirectory: path.resolve(String(config.logDirectory || "./logs")),
    fileTransferRoot: path.resolve(String(config.fileTransferRoot || "./transfer")),
    maxUploadBytes: Number(config.maxUploadBytes || 5 * 1024 * 1024),
    maxTransferBytes: Number(config.maxTransferBytes || config.maxUploadBytes || 5 * 1024 * 1024),
    allowScreenCapture: Boolean(config.allowScreenCapture),
    allowRemoteControl: Boolean(config.allowRemoteControl),
    allowKeyboardInput: Boolean(config.allowKeyboardInput),
    allowClipboardPaste: config.allowClipboardPaste !== false,
    allowFileTransfer: Boolean(config.allowFileTransfer),
    allowSessionRecording: Boolean(config.allowSessionRecording),
    allowPowerControl: Boolean(config.allowPowerControl),
    allowWebRtcTransport: config.allowWebRtcTransport !== false,
    webRtcSignalPollMs: Math.round(clampNumber(config.webRtcSignalPollMs, 500, 10000, 1000)),
    webRtcFrameFps: Math.round(clampNumber(config.webRtcFrameFps, 1, 24, 10)),
    webRtcFrameChunkBytes: Math.round(clampNumber(config.webRtcFrameChunkBytes, 16384, 262144, 65536)),
    webRtcIceServers: Array.isArray(config.webRtcIceServers) && config.webRtcIceServers.length
      ? config.webRtcIceServers
      : [{ urls: "stun:stun.l.google.com:19302" }],
    preventSleepWhileRunning: Boolean(config.preventSleepWhileRunning),
    maxClipboardTextBytes: Math.round(clampNumber(
      config.maxClipboardTextBytes,
      256,
      262144,
      DEFAULT_MAX_CLIPBOARD_TEXT_BYTES
    )),
    screenCaptureQuality: Number(config.screenCaptureQuality || 72),
    wheelScrollMultiplier: clampNumber(config.wheelScrollMultiplier, 0.25, 32, 16),
  };
}

async function loadState() {
  const state = await readJson(STATE_PATH, {});
  if (!state.deviceUid) {
    state.deviceUid = crypto.randomUUID();
    await writeJson(STATE_PATH, state);
  }
  return state;
}

async function rememberConfigMtime() {
  try {
    const stat = await fsp.stat(CONFIG_PATH);
    lastConfigMtimeMs = stat.mtimeMs;
  } catch {
    lastConfigMtimeMs = Date.now();
  }
}

async function maybeReloadConfig(config, state) {
  let stat;
  try {
    stat = await fsp.stat(CONFIG_PATH);
  } catch (error) {
    console.error(`[agent] config reload skipped: ${error.message}`);
    return;
  }
  if (stat.mtimeMs <= lastConfigMtimeMs + 1) {
    return;
  }

  const previousServerUrl = config.serverUrl;
  const previousEnrollmentCode = config.enrollmentCode;
  const previousAllowWebRtc = config.allowWebRtcTransport;
  let next;
  try {
    next = await loadConfig();
  } catch (error) {
    console.error(`[agent] config reload failed: ${error.message}`);
    lastConfigMtimeMs = stat.mtimeMs;
    return;
  }

  const serverChanged = next.serverUrl !== previousServerUrl
    || next.enrollmentCode !== previousEnrollmentCode;
  if (serverChanged && activeWebRtcSessionUid) {
    await closeActiveWebRtc(config, state, "closed", "agent config changed");
  }

  Object.assign(config, next);
  lastConfigMtimeMs = stat.mtimeMs;
  if (serverChanged) {
    activeTransport = "";
    preferredTransportMode = config.initialTransportMode === "long-poll" ? "long-poll" : "poll";
    await enrollIfNeeded(config, state);
  }
  if (previousAllowWebRtc && !config.allowWebRtcTransport && activeWebRtcSessionUid) {
    await closeActiveWebRtc(config, state, "closed", "WebRTC disabled in config");
  }
  syncKeepAwake(config);
  console.log(`[agent] config reloaded${serverChanged ? " and re-enrolled" : ""}`);
}

async function apiJson(config, endpoint, body, token = null, options = {}) {
  const headers = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || config.requestTimeoutMs || 30000));
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms.`)), timeoutMs);
  let response;
  try {
    response = await fetch(`${config.serverUrl}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Server returned non-JSON response (${response.status}): ${text.slice(0, 200)}`);
  }

  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `Server request failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return data;
}

async function fetchWithTimeout(url, options, timeoutMs, label) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms.`)),
    timeoutMs
  );
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function enrollIfNeeded(config, state) {
  if (state.deviceToken && state.serverUrl === config.serverUrl) {
    return state;
  }
  if (state.deviceToken && state.serverUrl !== config.serverUrl) {
    delete state.deviceId;
    delete state.deviceToken;
  }

  console.log("[agent] enrolling device");
  const result = await apiJson(config, "/api/enroll.php", {
    enrollment_code: config.enrollmentCode,
    device_uid: state.deviceUid,
    name: config.deviceName,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    hostname: os.hostname(),
    agent_version: AGENT_VERSION,
  });

  state.deviceId = result.device_id;
  state.deviceToken = result.device_token;
  state.serverUrl = config.serverUrl;
  await writeJson(STATE_PATH, state);
  console.log(`[agent] enrolled as device_id=${state.deviceId}`);
  return state;
}

async function reenroll(config, state) {
  delete state.deviceId;
  delete state.deviceToken;
  state.serverUrl = config.serverUrl;
  await writeJson(STATE_PATH, state);
  return enrollIfNeeded(config, state);
}

function summarizeSystemInfo() {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    uptimeSeconds: os.uptime(),
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    cpuCount: cpus.length,
    cpuModel: cpus[0]?.model || "unknown",
    nodeVersion: process.version,
    agentVersion: AGENT_VERSION,
  };
}

function summarizeNetworkInterfaces() {
  const interfaces = os.networkInterfaces();
  const result = {};

  for (const [name, entries] of Object.entries(interfaces)) {
    result[name] = (entries || []).map((entry) => ({
      family: entry.family,
      address: entry.address,
      internal: entry.internal,
      cidr: entry.cidr,
    }));
  }

  return result;
}

async function listLogFiles(config) {
  await fsp.mkdir(config.logDirectory, { recursive: true });
  const entries = await fsp.readdir(config.logDirectory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const absolute = path.join(config.logDirectory, entry.name);
    const stat = await fsp.stat(absolute);
    files.push({
      name: entry.name,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  }

  return files.sort((a, b) => a.name.localeCompare(b.name));
}

function resolveLogPath(config, relativePath) {
  if (!relativePath || typeof relativePath !== "string") {
    throw new Error("payload.relativePath is required.");
  }

  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.includes("..") || path.isAbsolute(normalized)) {
    throw new Error("relativePath must stay inside logDirectory.");
  }

  const root = path.resolve(config.logDirectory);
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("relativePath resolved outside logDirectory.");
  }

  return target;
}

function normalizeRelativePath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.includes("..") || path.isAbsolute(normalized)) {
    throw new Error("Path must stay inside the configured root.");
  }
  return normalized;
}

function resolveTransferPath(config, relativePath = "") {
  const root = path.resolve(config.fileTransferRoot);
  const normalized = normalizeRelativePath(relativePath);
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path resolved outside fileTransferRoot.");
  }
  return { root, target, relativePath: normalized };
}

async function ensureFileTransfer(config) {
  if (!config.allowFileTransfer) {
    throw new Error("File transfer is disabled in agent.config.json.");
  }
  await fsp.mkdir(config.fileTransferRoot, { recursive: true });
}

async function listTransferFiles(config, payload) {
  await ensureFileTransfer(config);
  const { target, relativePath } = resolveTransferPath(config, payload?.path || "");
  const stat = await fsp.stat(target).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error("Remote path is not a directory.");
  }

  const entries = await fsp.readdir(target, { withFileTypes: true });
  const result = [];
  for (const entry of entries.slice(0, 200)) {
    const absolute = path.join(target, entry.name);
    const entryStat = await fsp.stat(absolute);
    const entryRelative = [relativePath, entry.name].filter(Boolean).join("/");
    result.push({
      name: entry.name,
      relativePath: entryRelative,
      isDirectory: entry.isDirectory(),
      sizeBytes: entry.isDirectory() ? 0 : entryStat.size,
      modifiedAt: entryStat.mtime.toISOString(),
    });
  }

  return {
    root: config.fileTransferRoot,
    path: relativePath,
    entries: result.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name)),
    listedAt: new Date().toISOString(),
  };
}

async function pullTransferFile(config, state, commandId, payload) {
  await ensureFileTransfer(config);
  const { target, relativePath } = resolveTransferPath(config, payload?.relativePath || "");
  const stat = await fsp.stat(target);
  if (!stat.isFile()) {
    throw new Error("Remote path is not a file.");
  }
  if (stat.size > config.maxTransferBytes) {
    throw new Error(`File exceeds maxTransferBytes (${config.maxTransferBytes}).`);
  }

  const artifact = await uploadArtifact(config, state, commandId, target, path.basename(target));
  return {
    relativePath,
    sizeBytes: stat.size,
    uploaded: artifact,
  };
}

async function downloadCommandArtifact(config, state, commandId) {
  const response = await fetchWithTimeout(
    `${config.serverUrl}/api/artifact-download.php?command_id=${encodeURIComponent(String(commandId))}`,
    {
      headers: {
        Authorization: `Bearer ${state.deviceToken}`,
      },
    },
    Math.max(config.requestTimeoutMs, 60000),
    "Artifact download"
  );
  if (!response.ok) {
    throw new Error(`Server artifact download failed (${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function putTransferFile(config, state, commandId, payload) {
  await ensureFileTransfer(config);
  const targetName = safeTransferFileName(String(payload?.targetName || `upload-${commandId}.bin`));
  let savedName = targetName;
  let { target } = resolveTransferPath(config, targetName);
  const buffer = await downloadCommandArtifact(config, state, commandId);
  if (buffer.length <= 0 || buffer.length > config.maxTransferBytes) {
    throw new Error(`Downloaded file exceeds maxTransferBytes (${config.maxTransferBytes}).`);
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, buffer, { flag: "wx" }).catch(async (error) => {
    if (error.code !== "EEXIST") {
      throw error;
    }
    const parsed = path.parse(targetName);
    savedName = `${parsed.name}-${Date.now()}${parsed.ext}`;
    target = resolveTransferPath(config, savedName).target;
    await fsp.writeFile(target, buffer, { flag: "wx" });
  });

  return {
    targetName: savedName,
    relativePath: savedName,
    sizeBytes: buffer.length,
    savedAt: new Date().toISOString(),
  };
}

function safeTransferFileName(name) {
  const base = path.basename(name.replace(/\\/g, "/")).replace(/[^a-zA-Z0-9._ ()-]/g, "_").replace(/^[. ]+|[. ]+$/g, "");
  return base || "upload.bin";
}

async function runDiagnostic(payload) {
  const name = String(payload?.name || "");
  const command = DIAGNOSTIC_COMMANDS[name];
  if (!command) {
    throw new Error(`Diagnostic "${name}" is not allowed.`);
  }

  const { stdout, stderr } = await execFileAsync(command.file, command.args, {
    timeout: 5000,
    windowsHide: false,
    maxBuffer: 128 * 1024,
  });

  return {
    name,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

async function uploadArtifact(config, state, commandId, filePath, fileName, mimeType = "application/octet-stream") {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) {
    throw new Error("Selected artifact is not a file.");
  }
  if (stat.size > config.maxUploadBytes) {
    throw new Error(`File exceeds maxUploadBytes (${config.maxUploadBytes}).`);
  }

  return uploadArtifactBuffer(config, state, commandId, await fsp.readFile(filePath), fileName, mimeType);
}

async function uploadArtifactBuffer(config, state, commandId, buffer, fileName, mimeType = "application/octet-stream") {
  if (!Buffer.isBuffer(buffer) || buffer.length <= 0) {
    throw new Error("Artifact buffer is empty.");
  }
  if (buffer.length > config.maxUploadBytes) {
    throw new Error(`File exceeds maxUploadBytes (${config.maxUploadBytes}).`);
  }

  const form = new FormData();
  form.append("command_id", String(commandId));
  form.append("artifact", new Blob([buffer], { type: mimeType }), fileName);

  const response = await fetchWithTimeout(
    `${config.serverUrl}/api/upload.php`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.deviceToken}`,
      },
      body: form,
    },
    Math.max(config.requestTimeoutMs, 60000),
    "Artifact upload"
  );

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Upload returned non-JSON response (${response.status}): ${text.slice(0, 500)}`);
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Upload failed with status ${response.status}`);
  }

  return data.artifact;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

async function removeQuietly(targetPath) {
  if (!targetPath) {
    return;
  }

  try {
    await fsp.rm(targetPath, { recursive: true, force: true });
  } catch {
    // Temp cleanup is best-effort.
  }
}

async function runProcessWithInput(file, args, input, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error, result = null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish(new Error(`${label} failed: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish(null, { stdout, stderr });
      } else {
        const details = stderr.trim() || stdout.trim();
        finish(new Error(`${label} exited with code ${code}${details ? `: ${details}` : ""}`));
      }
    });

    child.stdin.on("error", () => {});
    child.stdin.end(input, "utf8");
  });
}

let cachedDisplays = [];
let cachedDisplaysAt = 0;
let lastUploadedScreenHash = "";
let cachedDesktopState = null;
let cachedDesktopStateAt = 0;

async function cachedDisplayList() {
  if (Date.now() - cachedDisplaysAt < 60000) {
    return cachedDisplays;
  }
  cachedDisplays = await screenshotDesktop.listDisplays().catch(() => []);
  cachedDisplaysAt = Date.now();
  return cachedDisplays;
}

async function getDesktopState() {
  if (process.platform !== "win32") {
    return {
      interactive: true,
      sessionId: null,
      blocker: "",
      reason: "",
    };
  }
  if (cachedDesktopState && Date.now() - cachedDesktopStateAt < 900) {
    return cachedDesktopState;
  }

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$sessionId=[System.Diagnostics.Process]::GetCurrentProcess().SessionId; $blocker=Get-Process -Name LogonUI,consent -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $sessionId } | Select-Object -First 1 -ExpandProperty ProcessName; Write-Output ($sessionId.ToString() + '|' + [string]$blocker)",
    ], {
      windowsHide: true,
      timeout: 1500,
      maxBuffer: 4096,
    });
    const [sessionText, blocker = ""] = String(stdout || "").trim().split("|", 2);
    const sessionId = Number(sessionText);
    const normalizedBlocker = String(blocker || "").trim();
    const interactive = Number.isFinite(sessionId) && sessionId > 0 && normalizedBlocker === "";
    cachedDesktopState = {
      interactive,
      sessionId: Number.isFinite(sessionId) ? sessionId : null,
      blocker: normalizedBlocker,
      reason: sessionId === 0
        ? "agent berjalan di Windows Session 0"
        : normalizedBlocker
          ? `Windows Secure Desktop aktif (${normalizedBlocker})`
          : interactive
            ? ""
            : "desktop interaktif tidak tersedia",
    };
  } catch (error) {
    cachedDesktopState = {
      interactive: false,
      sessionId: null,
      blocker: "",
      reason: `status desktop tidak dapat diverifikasi: ${error.message}`,
    };
  }
  cachedDesktopStateAt = Date.now();
  return cachedDesktopState;
}

async function requireInteractiveDesktop(operation) {
  const desktop = await getDesktopState();
  if (!desktop.interactive) {
    throw new Error(`${operation} paused: ${desktop.reason}. Sign in atau tutup Secure Desktop untuk melanjutkan.`);
  }
  return desktop;
}

async function captureScreen(config, payload) {
  if (!config.allowScreenCapture) {
    throw new Error("Screen capture is disabled in agent.config.json.");
  }

  const desktop = await requireInteractiveDesktop("Screen capture");
  const timeoutMs = Math.round(clampNumber(payload?.timeoutMs, 3000, 30000, 15000));
  const fileName = `screen-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
  const startedAt = Date.now();

  const [displays, buffer] = await Promise.all([
    cachedDisplayList(),
    withTimeout(
      screenshotDesktop({ format: "jpg" }),
      timeoutMs,
      `Screen capture timed out after ${timeoutMs}ms.`
    ),
  ]);
  if (!Buffer.isBuffer(buffer) || buffer.length <= 0) {
    throw new Error("Screen capture returned an empty buffer.");
  }
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  return {
    buffer,
    fileName,
    mimeType: "image/jpeg",
    metadata: {
      bytes: buffer.length,
      sha256,
      captureMs: Date.now() - startedAt,
      capturedAt: new Date().toISOString(),
      displays,
      controlScreenSize: robot.getScreenSize(),
      desktop,
    },
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function recordSession(config, payload) {
  if (!config.allowScreenCapture || !config.allowSessionRecording) {
    throw new Error("Session recording is disabled in agent.config.json.");
  }

  const durationSeconds = Math.round(clampNumber(payload?.durationSeconds, 3, 30, 10));
  const intervalMs = Math.round(clampNumber(payload?.intervalMs, 800, 5000, 1500));
  const frameCount = Math.max(2, Math.min(24, Math.ceil((durationSeconds * 1000) / intervalMs)));
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "device-recording-"));
  const frames = [];

  try {
    for (let index = 0; index < frameCount; index += 1) {
      const frame = await captureScreen(config, { timeoutMs: 15000 });
      frames.push({
        index,
        capturedAt: frame.metadata.capturedAt,
        dataUrl: `data:image/jpeg;base64,${frame.buffer.toString("base64")}`,
      });
      if (index < frameCount - 1) {
        await sleep(intervalMs);
      }
    }

    const fileName = `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.html`;
    const filePath = path.join(tempDir, fileName);
    const slides = frames.map((frame, index) => `
      <figure class="frame${index === 0 ? " active" : ""}" data-frame="${index}">
        <img src="${frame.dataUrl}" alt="Frame ${index + 1}">
        <figcaption>Frame ${index + 1} / ${frames.length} - ${escapeHtml(frame.capturedAt)}</figcaption>
      </figure>`).join("\n");
    const html = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Device Session Recording</title>
<style>
body{margin:0;background:#0e1726;color:#e5edf7;font-family:Inter,Segoe UI,Arial,sans-serif}
main{min-height:100vh;display:grid;grid-template-rows:auto 1fr auto;gap:12px;padding:14px}
header,footer{display:flex;align-items:center;justify-content:space-between;gap:12px}
h1{font-size:18px;margin:0}.muted{color:#9fb0c4}.stage{display:grid;place-items:center;overflow:hidden;border:1px solid #2a3a52;border-radius:8px;background:#020617}
.frame{display:none;margin:0;width:100%;height:100%}.frame.active{display:grid;grid-template-rows:minmax(0,1fr)auto}
img{width:100%;height:100%;max-height:78vh;object-fit:contain}figcaption{padding:8px 0;color:#9fb0c4;font-size:12px}
button{border:0;border-radius:6px;padding:9px 12px;color:#fff;background:#156f8f;font-weight:700;cursor:pointer}
</style>
</head>
<body>
<main>
<header><h1>Device Session Recording</h1><span class="muted">${frames.length} frames</span></header>
<section class="stage">${slides}</section>
<footer><button id="prev">Prev</button><span id="count"></span><button id="next">Next</button></footer>
</main>
<script>
const frames=[...document.querySelectorAll('.frame')];let index=0;
function show(next){frames[index].classList.remove('active');index=(next+frames.length)%frames.length;frames[index].classList.add('active');count.textContent=(index+1)+' / '+frames.length}
prev.onclick=()=>show(index-1);next.onclick=()=>show(index+1);show(0);setInterval(()=>show(index+1),${Math.max(1000, intervalMs)});
</script>
</body>
</html>`;
    await fsp.writeFile(filePath, html, "utf8");
    return {
      filePath,
      fileName,
      mimeType: "text/html",
      cleanupDir: tempDir,
      metadata: {
        frames: frames.length,
        durationSeconds,
        intervalMs,
        recordedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    await removeQuietly(tempDir);
    throw error;
  }
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.round(Math.min(max, Math.max(min, number)));
}

async function mouseClick(config, payload) {
  if (!config.allowRemoteControl) {
    throw new Error("Remote mouse control is disabled in agent.config.json.");
  }

  await requireInteractiveDesktop("Remote mouse");
  const screenSize = robot.getScreenSize();
  const x = clampInteger(payload?.x, 0, Math.max(0, screenSize.width - 1), -1);
  const y = clampInteger(payload?.y, 0, Math.max(0, screenSize.height - 1), -1);
  const button = ["left", "right", "middle"].includes(String(payload?.button))
    ? String(payload.button)
    : "left";
  const double = Boolean(payload?.double);

  if (x < 0 || y < 0) {
    throw new Error("payload.x and payload.y are required.");
  }

  const previous = robot.getMousePos();
  robot.moveMouse(x, y);
  robot.mouseClick(button, double);

  return {
    x,
    y,
    button,
    double,
    previous,
    screenSize,
    clickedAt: new Date().toISOString(),
  };
}

const activeMouseButtons = new Set();
let mouseReleaseTimer = null;
let latestMouseEpoch = -1;
let latestMouseSequence = -1;

function releaseActiveMouseButtons(reason = "release") {
  if (mouseReleaseTimer) {
    clearTimeout(mouseReleaseTimer);
    mouseReleaseTimer = null;
  }

  const released = [];
  for (const button of activeMouseButtons) {
    try {
      robot.mouseToggle("up", button);
      released.push(button);
    } catch (error) {
      console.error(`[agent] failed to release ${button} mouse button: ${error.message}`);
    }
  }
  activeMouseButtons.clear();
  if (released.length) {
    console.log(`[agent] mouse safety release (${reason}): ${released.join(", ")}`);
  }
  return released;
}

function armMouseSafetyRelease(timeoutMs) {
  if (mouseReleaseTimer) {
    clearTimeout(mouseReleaseTimer);
    mouseReleaseTimer = null;
  }
  if (!activeMouseButtons.size) {
    return;
  }

  mouseReleaseTimer = setTimeout(() => {
    releaseActiveMouseButtons("watchdog timeout");
  }, clampInteger(timeoutMs, 500, 10000, 2500));
}

async function mouseInput(config, payload) {
  if (!config.allowRemoteControl) {
    throw new Error("Remote mouse control is disabled in agent.config.json.");
  }

  await requireInteractiveDesktop("Remote pointer");
  const events = Array.isArray(payload?.events) ? payload.events : [];
  if (!events.length || events.length > 128) {
    throw new Error("payload.events must contain between 1 and 128 pointer events.");
  }

  const epoch = clampInteger(payload?.epoch, 0, Number.MAX_SAFE_INTEGER, 0);
  if (epoch < latestMouseEpoch) {
    return { ignored: events.length, reason: "stale epoch" };
  }
  if (epoch > latestMouseEpoch) {
    releaseActiveMouseButtons("new pointer epoch");
    latestMouseEpoch = epoch;
    latestMouseSequence = -1;
  }

  const screenSize = robot.getScreenSize();
  let processed = 0;
  let ignored = 0;
  try {
    for (const event of events) {
      const sequence = clampInteger(event?.sequence, 0, Number.MAX_SAFE_INTEGER, 0);
      if (sequence <= latestMouseSequence) {
        ignored += 1;
        continue;
      }

      const type = String(event?.type || "").toLowerCase();
      const button = ["left", "right", "middle"].includes(String(event?.button))
        ? String(event.button)
        : "left";
      latestMouseSequence = sequence;

      if (type === "cancel") {
        releaseActiveMouseButtons("pointer cancel");
        processed += 1;
        continue;
      }
      if (type === "wheel") {
        const deltaX = clampInteger(
          Math.round(clampInteger(event?.deltaX, -120, 120, 0) * config.wheelScrollMultiplier),
          -120,
          120,
          0
        );
        const deltaY = clampInteger(
          Math.round(clampInteger(event?.deltaY, -120, 120, 0) * config.wheelScrollMultiplier),
          -120,
          120,
          0
        );
        if (deltaX || deltaY) {
          robot.scrollMouse(deltaX, deltaY);
        }
        processed += 1;
        continue;
      }

      const x = clampInteger(event?.x, 0, Math.max(0, screenSize.width - 1), -1);
      const y = clampInteger(event?.y, 0, Math.max(0, screenSize.height - 1), -1);
      if (x < 0 || y < 0) {
        throw new Error("Pointer coordinates are required.");
      }

      if (type === "down") {
        robot.moveMouse(x, y);
        if (!activeMouseButtons.has(button)) {
          robot.mouseToggle("down", button);
          activeMouseButtons.add(button);
        }
      } else if (type === "move") {
        const dragButton = activeMouseButtons.values().next().value;
        if (dragButton) {
          robot.dragMouse(x, y, dragButton);
        } else {
          robot.moveMouse(x, y);
        }
      } else if (type === "up") {
        if (activeMouseButtons.has(button)) {
          robot.dragMouse(x, y, button);
          robot.mouseToggle("up", button);
          activeMouseButtons.delete(button);
        } else {
          robot.moveMouse(x, y);
        }
      } else {
        throw new Error(`Unsupported pointer event: ${type}`);
      }
      processed += 1;
    }
  } catch (error) {
    releaseActiveMouseButtons("pointer error");
    throw error;
  }

  armMouseSafetyRelease(payload?.releaseTimeoutMs);
  return {
    gestureId: String(payload?.gestureId || ""),
    epoch,
    processed,
    ignored,
    activeButtons: [...activeMouseButtons],
    screenSize,
    appliedAt: new Date().toISOString(),
  };
}

const ROBOT_KEY_ALLOWLIST = new Set([
  ..."abcdefghijklmnopqrstuvwxyz0123456789",
  ",", ".", "/", ";", "'", "[", "]", "\\", "-", "=", "`",
  "space", "backspace", "delete", "enter", "tab", "escape",
  "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
  "insert", "capslock", "printscreen", "menu",
  "control", "alt", "shift", "command",
  "audio_mute", "audio_vol_down", "audio_vol_up", "audio_play", "audio_stop",
  "audio_pause", "audio_prev", "audio_next",
  "numpad_lock", "numpad_0", "numpad_1", "numpad_2", "numpad_3", "numpad_4",
  "numpad_5", "numpad_6", "numpad_7", "numpad_8", "numpad_9",
  "numpad_+", "numpad_-", "numpad_*", "numpad_/", "numpad_.",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
  "f13", "f14", "f15", "f16", "f17", "f18", "f19", "f20", "f21", "f22", "f23", "f24",
]);

const MODIFIER_ALIASES = new Map([
  ["ctrl", "control"],
  ["control", "control"],
  ["alt", "alt"],
  ["shift", "shift"],
]);

function normalizeRobotKey(value) {
  const key = String(value || "").toLowerCase();
  if (!ROBOT_KEY_ALLOWLIST.has(key)) {
    throw new Error(`Keyboard key "${key}" is not allowed.`);
  }
  return key;
}

function normalizeKeyboardModifiers(value) {
  const rawModifiers = Array.isArray(value) ? value : (value ? [value] : []);
  const modifiers = [];

  for (const rawModifier of rawModifiers) {
    const modifier = MODIFIER_ALIASES.get(String(rawModifier || "").toLowerCase());
    if (!modifier) {
      throw new Error(`Keyboard modifier "${rawModifier}" is not allowed.`);
    }
    if (!modifiers.includes(modifier)) {
      modifiers.push(modifier);
    }
  }

  return modifiers;
}

async function keyboardInput(config, payload) {
  if (!config.allowRemoteControl || !config.allowKeyboardInput) {
    throw new Error("Remote keyboard input is disabled in agent.config.json.");
  }

  await requireInteractiveDesktop("Remote keyboard");
  const kind = String(payload?.kind || "key").toLowerCase();
  if (kind === "text") {
    const text = String(payload?.text || "");
    if (!text || text.length > 512 || /[\u0000-\u001f\u007f]/.test(text)) {
      throw new Error("payload.text is invalid.");
    }
    robot.typeString(text);
    return {
      kind: "text",
      length: text.length,
      typedAt: new Date().toISOString(),
    };
  }

  if (kind !== "key") {
    throw new Error("payload.kind must be text or key.");
  }

  const key = normalizeRobotKey(payload?.key);
  const modifiers = normalizeKeyboardModifiers(payload?.modifiers);
  if (key === "delete" && modifiers.includes("control") && modifiers.includes("alt")) {
    throw new Error("Ctrl+Alt+Delete is not supported.");
  }

  robot.keyTap(key, modifiers.length ? modifiers : undefined);
  return {
    kind: "key",
    key,
    modifiers,
    tappedAt: new Date().toISOString(),
  };
}

function clipboardTextFromPayload(payload, maxBytes) {
  const text = String(payload?.text ?? "");
  const bytes = Buffer.byteLength(text, "utf8");
  if (text.trim() === "") {
    throw new Error("payload.text is required.");
  }
  if (text.includes("\u0000")) {
    throw new Error("payload.text cannot contain NUL bytes.");
  }
  if (bytes > maxBytes) {
    throw new Error(`payload.text is too large (${bytes} bytes, max ${maxBytes}).`);
  }
  return { text, bytes };
}

async function writeClipboardText(text) {
  const timeoutMs = 6000;

  if (process.platform === "win32") {
    try {
      await runProcessWithInput(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); $value = [Console]::In.ReadToEnd(); Set-Clipboard -Value $value",
        ],
        text,
        timeoutMs,
        "PowerShell Set-Clipboard"
      );
      return "powershell";
    } catch (powershellError) {
      await runProcessWithInput("clip.exe", [], text, timeoutMs, `clip.exe fallback after ${powershellError.message}`);
      return "clip.exe";
    }
  }

  if (process.platform === "darwin") {
    await runProcessWithInput("pbcopy", [], text, timeoutMs, "pbcopy");
    return "pbcopy";
  }

  const candidates = [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ];
  const errors = [];
  for (const [file, args] of candidates) {
    try {
      await runProcessWithInput(file, args, text, timeoutMs, file);
      return file;
    } catch (error) {
      errors.push(error.message);
    }
  }

  throw new Error(`No supported Linux clipboard tool worked: ${errors.join("; ")}`);
}

async function clipboardWrite(config, payload) {
  if (!config.allowRemoteControl || !config.allowClipboardPaste) {
    throw new Error("Remote clipboard paste is disabled in agent.config.json.");
  }

  await requireInteractiveDesktop("Remote clipboard");
  const paste = payload?.paste !== false;
  if (paste && !config.allowKeyboardInput) {
    throw new Error("Paste requires allowKeyboardInput in agent.config.json.");
  }

  const { text, bytes } = clipboardTextFromPayload(payload, config.maxClipboardTextBytes);
  const method = await writeClipboardText(text);

  if (paste) {
    await sleep(70);
    const modifier = process.platform === "darwin" ? "command" : "control";
    robot.keyTap("v", [modifier]);
  }

  return {
    kind: "clipboard",
    bytes,
    characters: [...text].length,
    pasted: paste,
    method,
    appliedAt: new Date().toISOString(),
  };
}

const activeKeyboardKeys = new Set();
let keyboardReleaseTimer = null;

function releaseActiveKeyboardKeys(reason = "release") {
  if (keyboardReleaseTimer) {
    clearTimeout(keyboardReleaseTimer);
    keyboardReleaseTimer = null;
  }
  const released = [];
  for (const key of [...activeKeyboardKeys].reverse()) {
    try {
      robot.keyToggle(key, "up");
      released.push(key);
    } catch (error) {
      console.error(`[agent] failed to release keyboard key ${key}: ${error.message}`);
    }
  }
  activeKeyboardKeys.clear();
  if (released.length) {
    console.log(`[agent] keyboard safety release (${reason}): ${released.join(", ")}`);
  }
  return released;
}

function armKeyboardSafetyRelease() {
  if (keyboardReleaseTimer) {
    clearTimeout(keyboardReleaseTimer);
    keyboardReleaseTimer = null;
  }
  if (!activeKeyboardKeys.size) {
    return;
  }
  keyboardReleaseTimer = setTimeout(() => {
    releaseActiveKeyboardKeys("watchdog timeout");
  }, 15000);
}

async function keyboardState(config, payload) {
  if (!config.allowRemoteControl || !config.allowKeyboardInput) {
    throw new Error("Remote keyboard input is disabled in agent.config.json.");
  }

  await requireInteractiveDesktop("Remote keyboard");
  const key = normalizeRobotKey(payload?.key);
  const state = String(payload?.state || "").toLowerCase();
  if (!["down", "up"].includes(state)) {
    throw new Error("payload.state must be down or up.");
  }
  if (key === "delete" && activeKeyboardKeys.has("control") && activeKeyboardKeys.has("alt")) {
    throw new Error("Ctrl+Alt+Delete is not supported.");
  }

  if (state === "down") {
    if (!activeKeyboardKeys.has(key)) {
      robot.keyToggle(key, "down");
      activeKeyboardKeys.add(key);
    }
  } else if (activeKeyboardKeys.has(key)) {
    robot.keyToggle(key, "up");
    activeKeyboardKeys.delete(key);
  }
  armKeyboardSafetyRelease();

  return {
    kind: "state",
    key,
    state,
    activeKeys: [...activeKeyboardKeys],
    appliedAt: new Date().toISOString(),
  };
}

async function runPowerShell(script, timeoutMs = 8000, label = "PowerShell") {
  const result = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeout: timeoutMs, windowsHide: true }
  );
  return {
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  };
}

async function setDisplayPower(state) {
  if (process.platform !== "win32") {
    throw new Error("Display power control is currently implemented for Windows only.");
  }
  const powerState = state === "on" ? -1 : 2;
  await runPowerShell(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NativeDisplay {
  [DllImport("user32.dll")]
  public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
}
"@
[NativeDisplay]::SendMessage([IntPtr]0xffff, 0x0112, [IntPtr]0xF170, [IntPtr]${powerState}) | Out-Null
`, 8000, `display ${state}`);
  if (state === "on") {
    const pos = robot.getMousePos();
    robot.moveMouse(pos.x + 1, pos.y);
    robot.moveMouse(pos.x, pos.y);
  }
}

async function requestDeviceRestart(delaySeconds) {
  const delay = clampInteger(delaySeconds, 0, 600, 5);
  if (process.platform === "win32") {
    await execFileAsync("shutdown.exe", ["/r", "/t", String(delay), "/c", "Device Snapshot Center requested restart"], {
      timeout: 8000,
      windowsHide: true,
    });
    return { platform: "win32", delaySeconds: delay };
  }
  if (process.platform === "darwin") {
    await execFileAsync("osascript", ["-e", 'tell app "System Events" to restart'], { timeout: 8000 });
    return { platform: "darwin", delaySeconds: 0 };
  }
  await execFileAsync("systemctl", ["reboot"], { timeout: 8000 });
  return { platform: process.platform, delaySeconds: 0 };
}

async function requestSleepOrHibernate(operation) {
  if (process.platform === "win32") {
    if (operation === "hibernate") {
      await execFileAsync("shutdown.exe", ["/h"], { timeout: 8000, windowsHide: true });
      return { platform: "win32", operation };
    }
    await runPowerShell("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)", 8000, "sleep");
    return { platform: "win32", operation };
  }
  if (process.platform === "darwin") {
    await execFileAsync("pmset", ["sleepnow"], { timeout: 8000 });
    return { platform: "darwin", operation: "sleep" };
  }
  await execFileAsync("systemctl", [operation === "hibernate" ? "hibernate" : "suspend"], { timeout: 8000 });
  return { platform: process.platform, operation };
}

async function devicePower(config, payload) {
  if (!config.allowPowerControl) {
    throw new Error("Power/display control is disabled in agent.config.json.");
  }
  const operation = String(payload?.operation || "").toLowerCase();
  if (operation === "quiet_awake") {
    quietAwakeActive = true;
    syncKeepAwake(config);
    await setDisplayPower("off");
  } else if (operation === "display_off") {
    await setDisplayPower("off");
  } else if (operation === "display_on") {
    quietAwakeActive = false;
    syncKeepAwake(config);
    await setDisplayPower("on");
  } else if (operation === "restart_device") {
    return {
      operation,
      ...(await requestDeviceRestart(payload?.delaySeconds)),
      requestedAt: new Date().toISOString(),
    };
  } else if (operation === "sleep" || operation === "hibernate") {
    return {
      operation,
      ...(await requestSleepOrHibernate(operation)),
      requestedAt: new Date().toISOString(),
    };
  } else {
    throw new Error(`Unsupported power operation: ${operation}`);
  }

  return {
    operation,
    platform: process.platform,
    quietAwakeActive,
    appliedAt: new Date().toISOString(),
  };
}

function scheduleAgentRestart(reason = "requested") {
  console.log(`[agent] restart scheduled: ${reason}`);
  setTimeout(() => {
    releaseActiveMouseButtons("agent restart");
    releaseActiveKeyboardKeys("agent restart");
    process.exit(0);
  }, 500);
}

async function complete(config, state, commandId, payload) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await apiJson(config, "/api/complete.php", {
        command_id: commandId,
        ...payload,
      }, state.deviceToken);
      return;
    } catch (error) {
      if (/Task not found or already completed/i.test(error.message)) {
        return;
      }
      lastError = error;
      if (attempt < 3) {
        await sleep(200 * (2 ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}

async function handleCommand(config, state, command) {
  const id = Number(command.id);
  const action = String(command.action);
  const payload = command.payload || {};

  console.log(`[agent] command #${id}: ${action}`);

  switch (action) {
    case "health_check":
      await complete(config, state, id, {
        status: "succeeded",
        result_json: {
          ok: true,
          timestamp: new Date().toISOString(),
          pid: process.pid,
          uptimeSeconds: process.uptime(),
          desktop: await getDesktopState(),
        },
      });
      return;

    case "system_info":
      await complete(config, state, id, {
        status: "succeeded",
        result_json: summarizeSystemInfo(),
      });
      return;

    case "network_interfaces":
      await complete(config, state, id, {
        status: "succeeded",
        result_json: summarizeNetworkInterfaces(),
      });
      return;

    case "list_log_files":
      await complete(config, state, id, {
        status: "succeeded",
        result_json: {
          logDirectory: config.logDirectory,
          files: await listLogFiles(config),
        },
      });
      return;

    case "upload_log_file": {
      const filePath = resolveLogPath(config, payload.relativePath);
      const artifact = await uploadArtifact(config, state, id, filePath, path.basename(filePath));
      await complete(config, state, id, {
        status: "succeeded",
        result_json: {
          uploaded: artifact,
        },
      });
      return;
    }

    case "run_diagnostic": {
      const result = await runDiagnostic(payload);
      await complete(config, state, id, {
        status: "succeeded",
        result_text: result.stdout || result.stderr || "(no output)",
        result_json: result,
      });
      return;
    }

    case "capture_screen": {
      const snapshot = await captureScreen(config, payload);
      const unchanged = Boolean(
        payload?.dedupe
        && lastUploadedScreenHash
        && snapshot.metadata.sha256 === lastUploadedScreenHash
      );
      let artifact = null;
      if (!unchanged) {
        artifact = await uploadArtifactBuffer(
          config,
          state,
          id,
          snapshot.buffer,
          snapshot.fileName,
          snapshot.mimeType
        );
        lastUploadedScreenHash = snapshot.metadata.sha256;
      }
      await complete(config, state, id, {
        status: "succeeded",
        result_json: {
          screen: snapshot.metadata,
          unchanged,
          uploaded: artifact,
        },
      });
      return;
    }

    case "mouse_click": {
      const result = await mouseClick(config, payload);
      await complete(config, state, id, {
        status: "succeeded",
        result_json: result,
      });
      return;
    }

    case "mouse_input": {
      const result = await mouseInput(config, payload);
      await complete(config, state, id, {
        status: "succeeded",
        result_json: result,
      });
      return;
    }

    case "keyboard_input": {
      const result = await keyboardInput(config, payload);
      await complete(config, state, id, {
        status: "succeeded",
        result_json: result,
      });
      return;
    }

    case "keyboard_state": {
      const result = await keyboardState(config, payload);
      await complete(config, state, id, {
        status: "succeeded",
        result_json: result,
      });
      return;
    }

    case "clipboard_write": {
      const result = await clipboardWrite(config, payload);
      await complete(config, state, id, {
        status: "succeeded",
        result_json: result,
      });
      return;
    }

    case "device_power": {
      const result = await devicePower(config, payload);
      await complete(config, state, id, {
        status: "succeeded",
        result_json: result,
      });
      return;
    }

    case "agent_restart": {
      await complete(config, state, id, {
        status: "succeeded",
        result_json: {
          restarted: true,
          reason: String(payload?.reason || "requested"),
          scheduledAt: new Date().toISOString(),
        },
      });
      scheduleAgentRestart(payload?.reason || "requested");
      return;
    }

    case "file_list": {
      const result = await listTransferFiles(config, payload);
      await complete(config, state, id, {
        status: "succeeded",
        result_json: result,
      });
      return;
    }

    case "file_pull": {
      const result = await pullTransferFile(config, state, id, payload);
      await complete(config, state, id, {
        status: "succeeded",
        result_json: result,
      });
      return;
    }

    case "file_put": {
      const result = await putTransferFile(config, state, id, payload);
      await complete(config, state, id, {
        status: "succeeded",
        result_json: result,
      });
      return;
    }

    case "record_session": {
      let recording = null;
      try {
        recording = await recordSession(config, payload);
        const artifact = await uploadArtifact(
          config,
          state,
          id,
          recording.filePath,
          recording.fileName,
          recording.mimeType
        );
        await complete(config, state, id, {
          status: "succeeded",
          result_json: {
            recording: recording.metadata,
            uploaded: artifact,
          },
        });
      } finally {
        await removeQuietly(recording?.cleanupDir);
      }
      return;
    }

    default:
      throw new Error(`Unsupported action: ${action}`);
  }
}

const BACKGROUND_COMMAND_ACTIONS = new Set(["capture_screen", "record_session"]);
const backgroundCommands = new Map();
let activeScreenCommand = null;

async function executeCommand(config, state, command) {
  try {
    await handleCommand(config, state, command);
  } catch (error) {
    console.error(`[agent] command #${command.id} failed: ${error.message}`);
    await complete(config, state, Number(command.id), {
      status: "failed",
      error_text: error.stack || error.message,
    });
  }
}

async function handleDirectControl(config, action, payload) {
  switch (String(action || "")) {
    case "ping":
      return {
        pong: true,
        timestamp: new Date().toISOString(),
      };
    case "click":
      return mouseClick(config, payload);
    case "pointer":
      return mouseInput(config, payload);
    case "key":
      return (payload?.kind || "") === "state"
        ? keyboardState(config, payload)
        : keyboardInput(config, payload);
    default:
      throw new Error(`Unsupported WebRTC action: ${action}`);
  }
}

let activeWebRtcPeer = null;
let activeWebRtcSessionUid = "";
let activeWebRtcFrameChannel = null;
let activeWebRtcFrameLoop = null;

function sendJsonDataChannel(channel, payload) {
  channel.sendMessage(JSON.stringify(payload));
}

function sendBinaryDataChannel(channel, buffer) {
  if (typeof channel.sendMessageBinary === "function") {
    channel.sendMessageBinary(buffer);
    return;
  }
  channel.sendMessage(buffer);
}

function stopWebRtcFrameLoop(reason = "stopped") {
  if (!activeWebRtcFrameLoop) {
    return false;
  }
  activeWebRtcFrameLoop.stopped = true;
  activeWebRtcFrameLoop = null;
  console.log(`[agent] WebRTC frame loop stopped (${reason})`);
  return true;
}

async function sendWebRtcFrame(channel, config, frameId) {
  const snapshot = await captureScreen(config, { timeoutMs: 5000 });
  const chunkBytes = Math.max(16384, Math.min(262144, Number(config.webRtcFrameChunkBytes || 65536)));
  const totalChunks = Math.ceil(snapshot.buffer.length / chunkBytes);
  sendJsonDataChannel(channel, {
    kind: "frame-start",
    id: frameId,
    mime: snapshot.mimeType,
    bytes: snapshot.buffer.length,
    chunks: totalChunks,
    screen: snapshot.metadata,
  });
  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * chunkBytes;
    const chunk = snapshot.buffer.subarray(start, Math.min(snapshot.buffer.length, start + chunkBytes));
    sendBinaryDataChannel(channel, chunk);
    if (index % 4 === 0) {
      await sleep(0);
    }
  }
  sendJsonDataChannel(channel, {
    kind: "frame-end",
    id: frameId,
  });
}

function startWebRtcFrameLoop(channel, config, requestedFps = null) {
  stopWebRtcFrameLoop("restarted");
  const loop = {
    stopped: false,
    frameId: 0,
  };
  activeWebRtcFrameLoop = loop;
  const fps = Math.max(1, Math.min(24, Number(requestedFps || config.webRtcFrameFps || 10)));
  const intervalMs = Math.max(40, Math.round(1000 / fps));
  console.log(`[agent] WebRTC direct frame loop starting fps=${fps}`);
  (async () => {
    while (!loop.stopped) {
      const startedAt = Date.now();
      try {
        if (!channel.isOpen || !channel.isOpen()) {
          break;
        }
        loop.frameId += 1;
        await sendWebRtcFrame(channel, config, loop.frameId);
      } catch (error) {
        try {
          sendJsonDataChannel(channel, {
            kind: "frame-error",
            error: error.message,
          });
        } catch {}
        console.error(`[agent] WebRTC frame failed: ${error.message}`);
        await sleep(750);
      }
      const elapsed = Date.now() - startedAt;
      await sleep(Math.max(0, intervalMs - elapsed));
    }
    if (activeWebRtcFrameLoop === loop) {
      activeWebRtcFrameLoop = null;
    }
  })().catch((error) => {
    console.error(`[agent] WebRTC frame loop stopped: ${error.message}`);
  });
}

async function closeActiveWebRtc(config, state, status = "closed", error = "") {
  stopWebRtcFrameLoop("closed");
  activeWebRtcFrameChannel = null;
  if (activeWebRtcPeer) {
    try {
      activeWebRtcPeer.close();
    } catch {}
  }
  if (activeWebRtcSessionUid) {
    try {
      await apiJson(config, "/api/webrtc.php", {
        action: "agent_status",
        session_uid: activeWebRtcSessionUid,
        status,
        error,
      }, state.deviceToken, { timeoutMs: Math.min(config.requestTimeoutMs, 10000) });
    } catch (statusError) {
      console.error(`[agent] failed to update WebRTC status: ${statusError.message}`);
    }
  }
  activeWebRtcPeer = null;
  activeWebRtcSessionUid = "";
}

async function answerWebRtcSession(config, state, session) {
  const nodeDataChannel = await import("node-datachannel");
  const sessionUid = String(session.session_uid || "");
  const offer = session.offer || {};
  if (!sessionUid || offer.type !== "offer" || !offer.sdp) {
    throw new Error("Invalid WebRTC offer from server.");
  }

  await closeActiveWebRtc(config, state, "closed", "replaced by new session");
  const iceServers = (config.webRtcIceServers || [])
    .map((server) => server?.urls || server?.url || server)
    .flat()
    .filter(Boolean)
    .map(String);
  const peer = new nodeDataChannel.PeerConnection(`agent-${sessionUid}`, {
    iceServers,
  });
  activeWebRtcPeer = peer;
  activeWebRtcSessionUid = sessionUid;
  const candidates = [];
  let localDescription = null;

  peer.onLocalCandidate((candidate, mid) => {
    if (candidate) {
      candidates.push({
        candidate,
        sdpMid: mid,
      });
    }
  });
  peer.onLocalDescription((sdp, type) => {
    localDescription = {
      type,
      sdp,
    };
  });
  peer.onStateChange((stateName) => {
    if (["failed", "disconnected", "closed"].includes(String(stateName))) {
      console.log(`[agent] WebRTC ${stateName}`);
      if (activeWebRtcSessionUid === sessionUid) {
        stopWebRtcFrameLoop(`peer ${stateName}`);
        activeWebRtcFrameChannel = null;
        activeWebRtcPeer = null;
        activeWebRtcSessionUid = "";
      }
    }
  });
  peer.onDataChannel((channel) => {
    const channelLabel = String(channel.getLabel?.() || "data");
    console.log(`[agent] WebRTC data channel received: ${channelLabel}`);
    if (channelLabel === "screen-frame") {
      activeWebRtcFrameChannel = channel;
      channel.onOpen(() => {
        console.log("[agent] WebRTC frame channel open");
      });
      channel.onClosed(() => {
        stopWebRtcFrameLoop("channel closed");
        if (activeWebRtcFrameChannel === channel) {
          activeWebRtcFrameChannel = null;
        }
      });
      channel.onMessage(async (raw) => {
        let message = null;
        try {
          const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "{}");
          message = JSON.parse(text);
        } catch (error) {
          sendJsonDataChannel(channel, { kind: "frame-error", error: `Invalid frame control JSON: ${error.message}` });
          return;
        }
        const action = String(message?.action || "");
        if (action === "start") {
          startWebRtcFrameLoop(channel, config, message?.fps);
        } else if (action === "stop") {
          stopWebRtcFrameLoop("requested");
        } else if (action === "capture_once") {
          try {
            await sendWebRtcFrame(channel, config, Number(message?.id || Date.now()));
          } catch (error) {
            sendJsonDataChannel(channel, { kind: "frame-error", error: error.message });
          }
        }
      });
      return;
    }
    channel.onOpen(() => {
      console.log("[agent] WebRTC data channel open");
      apiJson(config, "/api/webrtc.php", {
        action: "agent_status",
        session_uid: sessionUid,
        status: "connected",
      }, state.deviceToken).catch((error) => {
        console.error(`[agent] failed to mark WebRTC connected: ${error.message}`);
      });
    });
    channel.onClosed(() => {
      console.log("[agent] WebRTC data channel closed");
    });
    channel.onMessage(async (raw) => {
      let message = null;
      try {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "{}");
        message = JSON.parse(text);
      } catch (error) {
        channel.sendMessage(JSON.stringify({ ok: false, error: `Invalid WebRTC JSON: ${error.message}` }));
        return;
      }

      const id = message?.id;
      try {
        const result = await handleDirectControl(config, message?.action, message?.payload || {});
        channel.sendMessage(JSON.stringify({
          id,
          ok: true,
          response: {
            result,
            transport: "webrtc-data",
          },
        }));
      } catch (error) {
        channel.sendMessage(JSON.stringify({
          id,
          ok: false,
          error: error.message,
        }));
      }
    });
  });

  peer.setRemoteDescription(offer.sdp, offer.type);
  peer.setLocalDescription("answer");
  const startedAt = Date.now();
  while (!localDescription && Date.now() - startedAt < 5000) {
    await sleep(50);
  }
  await sleep(1200);
  if (!localDescription) {
    throw new Error("WebRTC answer localDescription was not generated.");
  }
  await apiJson(config, "/api/webrtc.php", {
    action: "agent_answer",
    session_uid: sessionUid,
    answer: {
      type: String(localDescription.type || "answer").toLowerCase(),
      sdp: localDescription.sdp,
      candidates,
    },
  }, state.deviceToken);
  console.log(`[agent] WebRTC answer posted session=${sessionUid}`);
}

async function startWebRtcLoop(config, state) {
  let delayMs = config.webRtcSignalPollMs;
  while (true) {
    if (!config.allowWebRtcTransport) {
      if (activeWebRtcSessionUid) {
        await closeActiveWebRtc(config, state, "closed", "WebRTC disabled in config");
      }
      await sleep(Math.max(1000, config.configReloadMs || config.webRtcSignalPollMs || 1000));
      continue;
    }
    try {
      const result = await apiJson(config, "/api/webrtc.php", {
        action: "agent_poll",
        agent_version: AGENT_VERSION,
        agent_boot_id: AGENT_BOOT_ID,
      }, state.deviceToken, { timeoutMs: Math.min(config.requestTimeoutMs, 12000) });
      if (result.session?.session_uid && result.session.session_uid !== activeWebRtcSessionUid) {
        await answerWebRtcSession(config, state, result.session);
      }
      delayMs = config.webRtcSignalPollMs;
    } catch (error) {
      console.error(`[agent] WebRTC signal error: ${error.message}`);
      delayMs = Math.min(15000, Math.max(config.webRtcSignalPollMs, delayMs * 1.5));
    }
    await sleep(delayMs);
  }
}

let keepAwakeChild = null;
let quietAwakeActive = false;

function startKeepAwake(reason = "requested") {
  if (process.platform !== "win32" || keepAwakeChild) {
    return;
  }
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NativePower {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
while ($true) {
  [NativePower]::SetThreadExecutionState(0x80000000 -bor 0x00000001 -bor 0x00000002) | Out-Null
  Start-Sleep -Seconds 45
}
`;
  keepAwakeChild = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, stdio: "ignore" }
  );
  keepAwakeChild.on("exit", () => {
    keepAwakeChild = null;
  });
  keepAwakeChild.unref();
  console.log(`[agent] keep-awake active: ${reason}`);
}

function stopKeepAwake(reason = "disabled") {
  if (!keepAwakeChild) {
    return;
  }
  try {
    keepAwakeChild.kill();
  } catch {}
  keepAwakeChild = null;
  console.log(`[agent] preventSleepWhileRunning stopped: ${reason}`);
}

function syncKeepAwake(config) {
  if (config.preventSleepWhileRunning || quietAwakeActive) {
    startKeepAwake(quietAwakeActive ? "quiet_awake" : "config");
  } else {
    stopKeepAwake("config disabled");
  }
}

process.once("exit", () => {
  stopKeepAwake("agent exit");
});

let activeTransport = "";
let longPollSuspendedUntil = 0;
let consecutivePollErrors = 0;
let preferredTransportMode = "poll";
let successfulPolls = 0;
let lastHeartbeatAt = 0;

function logHeartbeat(config, nextPollMs) {
  const now = Date.now();
  if (now - lastHeartbeatAt < config.heartbeatLogMs) {
    return;
  }
  lastHeartbeatAt = now;
  console.log(
    `[agent] heartbeat transport=${activeTransport || "connecting"} polls=${successfulPolls} next=${Math.round(nextPollMs)}ms background=${backgroundCommands.size}`
  );
}

async function pollOnce(config, state) {
  const requestedWaitMs = preferredTransportMode === "long-poll" && Date.now() >= longPollSuspendedUntil
    ? config.longPollMs
    : 0;
  const result = await apiJson(config, "/api/poll.php", {
    agent_version: AGENT_VERSION,
    agent_boot_id: AGENT_BOOT_ID,
    agent_boot_started_at: AGENT_BOOT_STARTED_AT,
    wait_ms: requestedWaitMs,
  }, state.deviceToken, {
    timeoutMs: Math.max(config.requestTimeoutMs, requestedWaitMs + 5000),
  });
  const selectedTransport = String(result.transport?.selected || "http-poll");
  const recoveredCommands = Number(result.agent_session?.recovered || 0);
  const discardedLiveCommands = Number(result.agent_session?.discarded_live || 0);
  if (recoveredCommands > 0 || discardedLiveCommands > 0) {
    console.log(
      `[agent] recovered previous boot: failed=${recoveredCommands} discarded-live=${discardedLiveCommands}`
    );
  }
  const serverPreference = String(result.transport?.requested || "auto");
  if (serverPreference === "poll" && preferredTransportMode !== "poll") {
    preferredTransportMode = "poll";
    console.log("[agent] web requested transport: http-poll");
  } else if (serverPreference === "long-poll" && preferredTransportMode !== "long-poll") {
    preferredTransportMode = "long-poll";
    console.log("[agent] web requested transport: http-long-poll");
  }
  if (selectedTransport !== activeTransport) {
    activeTransport = selectedTransport;
    console.log(`[agent] transport selected: ${activeTransport}`);
  }
  if (!result.command) {
    return Number.isFinite(Number(result.poll_after_ms))
      ? Math.max(0, Number(result.poll_after_ms))
      : config.pollIntervalMs;
  }

  const commandId = Number(result.command.id);
  const action = String(result.command.action);
  if (BACKGROUND_COMMAND_ACTIONS.has(action)) {
    if (activeScreenCommand) {
      const busy = {
        active_command_id: activeScreenCommand.id,
        active_action: activeScreenCommand.action,
      };
      if (action === "capture_screen") {
        await complete(config, state, commandId, {
          status: "succeeded",
          result_json: {
            skipped: true,
            reason: "screen_pipeline_busy",
            ...busy,
          },
        });
      } else {
        await complete(config, state, commandId, {
          status: "failed",
          error_text: `Screen pipeline is busy with ${activeScreenCommand.action} #${activeScreenCommand.id}. Retry recording.`,
          result_json: busy,
        });
      }
      return 0;
    }

    activeScreenCommand = { id: commandId, action };
    const task = executeCommand(config, state, result.command)
      .catch((error) => {
        console.error(`[agent] background command #${commandId} completion failed: ${error.message}`);
      })
      .finally(() => {
        backgroundCommands.delete(commandId);
        if (activeScreenCommand?.id === commandId) {
          activeScreenCommand = null;
        }
      });
    backgroundCommands.set(commandId, task);
    return 0;
  }

  await executeCommand(config, state, result.command);
  return 0;
}

async function main() {
  acquireInstanceLock();
  const config = await loadConfig();
  await rememberConfigMtime();
  const state = await enrollIfNeeded(config, await loadState());
  preferredTransportMode = config.initialTransportMode === "long-poll" ? "long-poll" : "poll";
  robot.setMouseDelay(0);
  robot.setKeyboardDelay(0);
  syncKeepAwake(config);
  startWebRtcLoop(config, state).catch((error) => {
    console.error(`[agent] WebRTC loop stopped: ${error.message}`);
  });

  console.log(`[agent] visible agent v${AGENT_VERSION} started for "${config.deviceName}"`);
  console.log(`[agent] connecting to ${config.serverUrl}`);
  console.log(`[agent] initial transport=${preferredTransportMode === "long-poll" ? "http-long-poll" : "http-poll"} long-poll-capability=${config.longPollMs}ms fallback=${config.pollIntervalMs}ms`);
  console.log(`[agent] logDirectory=${config.logDirectory}`);

  let reconnectDelayMs = config.reconnectMinMs;
  while (true) {
    try {
      await maybeReloadConfig(config, state);
      const nextPollMs = await pollOnce(config, state);
      reconnectDelayMs = config.reconnectMinMs;
      consecutivePollErrors = 0;
      successfulPolls += 1;
      logHeartbeat(config, nextPollMs);
      if (nextPollMs > 0) {
        await sleep(nextPollMs);
      }
    } catch (error) {
      if (
        error.status === 409
        && /superseded|boot-session support/i.test(String(error.message || ""))
      ) {
        throw error;
      }
      if (error.status === 401) {
        activeTransport = "";
        releaseActiveMouseButtons("authentication rejected");
        releaseActiveKeyboardKeys("authentication rejected");
        console.log("[agent] saved token was rejected; re-enrolling device");
        try {
          await reenroll(config, state);
          reconnectDelayMs = config.reconnectMinMs;
          consecutivePollErrors = 0;
          continue;
        } catch (enrollError) {
          console.error(`[agent] re-enrollment failed: ${enrollError.message}`);
        }
      }
      console.error(`[agent] poll error: ${error.message}`);
      consecutivePollErrors += 1;
      if (config.longPollMs > 0 && consecutivePollErrors >= 2 && Date.now() >= longPollSuspendedUntil) {
        const cooldownMs = Math.min(60000, 5000 * consecutivePollErrors);
        longPollSuspendedUntil = Date.now() + cooldownMs;
        console.log(`[agent] circuit breaker: falling back to http-poll for ${cooldownMs}ms`);
      }
      activeTransport = "";
      releaseActiveMouseButtons("transport error");
      releaseActiveKeyboardKeys("transport error");
      await sleep(reconnectDelayMs);
      reconnectDelayMs = Math.min(config.reconnectMaxMs, Math.max(config.reconnectMinMs, reconnectDelayMs * 2));
    }
  }
}

main().catch((error) => {
  releaseActiveMouseButtons("fatal error");
  releaseActiveKeyboardKeys("fatal error");
  releaseInstanceLock();
  console.error(`[agent] fatal: ${error.message}`);
  setTimeout(() => process.exit(1), 25);
});
