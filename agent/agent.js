import { execFile } from "node:child_process";
import { execSync } from "child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import robot from "robotjs";
import screenshotDesktop from "screenshot-desktop";

const execFileAsync = promisify(execFile);
const AGENT_VERSION = "1.6.3";
const CONFIG_PATH = path.resolve("agent.config.json");
const EXAMPLE_CONFIG_PATH = path.resolve("agent.config.example.json");
const STATE_PATH = path.resolve("agent.state.json");

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
    reconnectMinMs,
    reconnectMaxMs: Math.round(clampNumber(config.reconnectMaxMs, reconnectMinMs, 120000, 10000)),
    logDirectory: path.resolve(String(config.logDirectory || "./logs")),
    fileTransferRoot: path.resolve(String(config.fileTransferRoot || "./transfer")),
    maxUploadBytes: Number(config.maxUploadBytes || 5 * 1024 * 1024),
    maxTransferBytes: Number(config.maxTransferBytes || config.maxUploadBytes || 5 * 1024 * 1024),
    allowScreenCapture: Boolean(config.allowScreenCapture),
    allowRemoteControl: Boolean(config.allowRemoteControl),
    allowKeyboardInput: Boolean(config.allowKeyboardInput),
    allowFileTransfer: Boolean(config.allowFileTransfer),
    allowSessionRecording: Boolean(config.allowSessionRecording),
    screenCaptureQuality: Number(config.screenCaptureQuality || 72),
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
    throw new Error(data.error || `Server request failed with status ${response.status}`);
  }

  return data;
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
  const response = await fetch(`${config.serverUrl}/api/artifact-download.php?command_id=${encodeURIComponent(String(commandId))}`, {
    headers: {
      Authorization: `Bearer ${state.deviceToken}`,
    },
  });
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

  const response = await fetch(`${config.serverUrl}/api/upload.php`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${state.deviceToken}`,
    },
    body: form,
  });

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

let cachedDisplays = [];
let cachedDisplaysAt = 0;
let lastUploadedScreenHash = "";

async function cachedDisplayList() {
  if (Date.now() - cachedDisplaysAt < 60000) {
    return cachedDisplays;
  }
  cachedDisplays = await screenshotDesktop.listDisplays().catch(() => []);
  cachedDisplaysAt = Date.now();
  return cachedDisplays;
}

async function captureScreen(config, payload) {
  if (!config.allowScreenCapture) {
    throw new Error("Screen capture is disabled in agent.config.json.");
  }

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
        const deltaX = clampInteger(event?.deltaX, -20, 20, 0);
        const deltaY = clampInteger(event?.deltaY, -20, 20, 0);
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

async function complete(config, state, commandId, payload) {
  await apiJson(config, "/api/complete.php", {
    command_id: commandId,
    ...payload,
  }, state.deviceToken);
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

let activeTransport = "";
let longPollSuspendedUntil = 0;
let consecutivePollErrors = 0;
let preferredTransportMode = "poll";

async function pollOnce(config, state) {
  const requestedWaitMs = preferredTransportMode === "long-poll" && Date.now() >= longPollSuspendedUntil
    ? config.longPollMs
    : 0;
  const result = await apiJson(config, "/api/poll.php", {
    agent_version: AGENT_VERSION,
    wait_ms: requestedWaitMs,
  }, state.deviceToken, {
    timeoutMs: Math.max(config.requestTimeoutMs, requestedWaitMs + 5000),
  });
  const selectedTransport = String(result.transport?.selected || "http-poll");
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
    const task = executeCommand(config, state, result.command)
      .catch((error) => {
        console.error(`[agent] background command #${commandId} completion failed: ${error.message}`);
      })
      .finally(() => {
        backgroundCommands.delete(commandId);
      });
    backgroundCommands.set(commandId, task);
    return 0;
  }

  await executeCommand(config, state, result.command);
  return 0;
}

async function main() {
  const config = await loadConfig();
  const state = await enrollIfNeeded(config, await loadState());
  preferredTransportMode = config.initialTransportMode === "long-poll" ? "long-poll" : "poll";
  robot.setMouseDelay(0);
  robot.setKeyboardDelay(0);

  console.log(`[agent] visible agent v${AGENT_VERSION} started for "${config.deviceName}"`);
  console.log(`[agent] connecting to ${config.serverUrl}`);
  console.log(`[agent] initial transport=${preferredTransportMode === "long-poll" ? "http-long-poll" : "http-poll"} long-poll-capability=${config.longPollMs}ms fallback=${config.pollIntervalMs}ms`);
  console.log(`[agent] logDirectory=${config.logDirectory}`);

  let reconnectDelayMs = config.reconnectMinMs;
  while (true) {
    try {
      const nextPollMs = await pollOnce(config, state);
      reconnectDelayMs = config.reconnectMinMs;
      consecutivePollErrors = 0;
      if (nextPollMs > 0) {
        await sleep(nextPollMs);
      }
    } catch (error) {
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
  console.error(`[agent] fatal: ${error.message}`);
  process.exitCode = 1;
});
