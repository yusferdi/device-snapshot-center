import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const AGENT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(AGENT_ROOT, "agent.config.json");
const EXAMPLE_CONFIG_PATH = path.join(AGENT_ROOT, "agent.config.example.json");
const MANAGER_STATE_PATH = path.join(AGENT_ROOT, "agent-manager.state.json");
const LOG_ROOT = path.join(AGENT_ROOT, "logs");
const TASK_NAME = process.env.AGENT_TASK_NAME || "DeviceSnapshotAgent";
const HOST = "127.0.0.1";
const PORT = Number(process.env.AGENT_MANAGER_PORT || 8765);

const TEXT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

const STRING_FIELDS = [
  "serverUri",
  "enrollmentCode",
  "deviceName",
  "initialTransportMode",
  "logDirectory",
  "fileTransferRoot",
];

const NUMBER_FIELDS = [
  "pollIntervalMs",
  "longPollMs",
  "requestTimeoutMs",
  "heartbeatLogMs",
  "configReloadMs",
  "reconnectMinMs",
  "reconnectMaxMs",
  "webRtcSignalPollMs",
  "maxUploadBytes",
  "maxTransferBytes",
  "maxClipboardTextBytes",
  "wheelScrollMultiplier",
];

const BOOLEAN_FIELDS = [
  "allowScreenCapture",
  "allowRemoteControl",
  "allowKeyboardInput",
  "allowClipboardPaste",
  "allowFileTransfer",
  "allowSessionRecording",
  "allowPowerControl",
  "allowWebRtcTransport",
  "preventSleepWhileRunning",
];

function jsonResponse(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function textResponse(response, statusCode, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function asyncRoute(handler) {
  return async (request, response) => {
    try {
      await handler(request, response);
    } catch (error) {
      jsonResponse(response, 500, {
        ok: false,
        error: error.message,
      });
    }
  };
}

function parseJsonBody(request, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > maxBytes) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

async function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(tempPath, filePath);
}

async function readConfigForUi() {
  const configExists = fs.existsSync(CONFIG_PATH);
  const fallback = await readJson(EXAMPLE_CONFIG_PATH, {});
  const local = configExists ? await readJson(CONFIG_PATH, {}) : {};
  const config = { ...fallback, ...local };
  return {
    configExists,
    config,
  };
}

function normalizeConfigPatch(input) {
  const patch = {};
  for (const field of STRING_FIELDS) {
    if (field in input) {
      patch[field] = String(input[field] ?? "").trim();
    }
  }
  if (patch.initialTransportMode && !["poll", "long-poll", "auto"].includes(patch.initialTransportMode)) {
    patch.initialTransportMode = "poll";
  }
  for (const field of NUMBER_FIELDS) {
    if (field in input) {
      const value = Number(input[field]);
      if (Number.isFinite(value)) {
        patch[field] = value;
      }
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (field in input) {
      patch[field] = Boolean(input[field]);
    }
  }
  if ("webRtcIceServersText" in input) {
    const text = String(input.webRtcIceServersText || "").trim();
    if (!text) {
      patch.webRtcIceServers = [];
    } else {
      try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) {
          throw new Error("webRtcIceServers must be a JSON array.");
        }
        patch.webRtcIceServers = parsed;
      } catch (error) {
        throw new Error(`Invalid WebRTC ICE JSON: ${error.message}`);
      }
    }
  }
  if (!patch.serverUri && "serverUri" in input) {
    throw new Error("serverUri cannot be empty.");
  }
  if (!patch.enrollmentCode && "enrollmentCode" in input) {
    throw new Error("enrollmentCode cannot be empty.");
  }
  return patch;
}

async function saveConfig(input) {
  const current = fs.existsSync(CONFIG_PATH)
    ? await readJson(CONFIG_PATH, {})
    : await readJson(EXAMPLE_CONFIG_PATH, {});
  const next = {
    ...current,
    ...normalizeConfigPatch(input),
  };
  delete next.serverUrl;
  await writeJsonAtomic(CONFIG_PATH, next);
  return next;
}

async function readManagerState() {
  return readJson(MANAGER_STATE_PATH, {});
}

async function writeManagerState(state) {
  await writeJsonAtomic(MANAGER_STATE_PATH, state);
}

function isPidRunning(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function runPowerShell(script, timeoutMs = 15000) {
  const { stdout, stderr } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      cwd: AGENT_ROOT,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    }
  );
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

async function getAgentProcesses() {
  if (process.platform !== "win32") {
    const state = await readManagerState();
    return isPidRunning(state.agentPid)
      ? [{ pid: state.agentPid, commandLine: "agent.js", source: "manager-state" }]
      : [];
  }
  const root = AGENT_ROOT.replace(/'/g, "''");
  const script = `
$root = '${root}'
$items = @(Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and
  $_.CommandLine -like '*agent.js*' -and
  $_.CommandLine -like "*$root*" -and
  $_.CommandLine -notlike '*agent-manager.js*'
} | Select-Object @{Name='pid';Expression={$_.ProcessId}}, @{Name='name';Expression={$_.Name}}, @{Name='commandLine';Expression={$_.CommandLine}})
$items | ConvertTo-Json -Compress
`;
  const { stdout } = await runPowerShell(script);
  if (!stdout) {
    return [];
  }
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function getTaskStatus(taskName = TASK_NAME) {
  if (process.platform !== "win32") {
    return { installed: false, platform: process.platform };
  }
  const safeTask = taskName.replace(/'/g, "''");
  const script = `
$task = Get-ScheduledTask -TaskName '${safeTask}' -ErrorAction SilentlyContinue
if (-not $task) {
  @{ installed = $false; taskName = '${safeTask}' } | ConvertTo-Json -Compress
  exit 0
}
$info = Get-ScheduledTaskInfo -TaskName '${safeTask}' -ErrorAction SilentlyContinue
@{
  installed = $true
  taskName = '${safeTask}'
  state = [string]$task.State
  taskPath = [string]$task.TaskPath
  userId = [string]$task.Principal.UserId
  logonType = [string]$task.Principal.LogonType
  runLevel = [string]$task.Principal.RunLevel
  wakeToRun = [bool]$task.Settings.WakeToRun
  startWhenAvailable = [bool]$task.Settings.StartWhenAvailable
  lastRunTime = if ($info) { [string]$info.LastRunTime } else { "" }
  lastTaskResult = if ($info) { [string]$info.LastTaskResult } else { "" }
  nextRunTime = if ($info) { [string]$info.NextRunTime } else { "" }
} | ConvertTo-Json -Compress
`;
  const { stdout } = await runPowerShell(script);
  return stdout ? JSON.parse(stdout) : { installed: false, taskName };
}

async function startAgent(nodePath = process.execPath) {
  await fsp.mkdir(LOG_ROOT, { recursive: true });
  const state = await readManagerState();
  if (isPidRunning(state.agentPid)) {
    return { started: false, pid: state.agentPid, message: "Agent already running from manager." };
  }

  const stdoutPath = path.join(LOG_ROOT, "agent-gui.log");
  const stderrPath = path.join(LOG_ROOT, "agent-gui.err.log");
  const stdoutFd = fs.openSync(stdoutPath, "a");
  const stderrFd = fs.openSync(stderrPath, "a");
  const child = spawn(nodePath || process.execPath, ["agent.js"], {
    cwd: AGENT_ROOT,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  child.unref();
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  const nextState = {
    ...state,
    agentPid: child.pid,
    nodePath: nodePath || process.execPath,
    startedAt: new Date().toISOString(),
  };
  await writeManagerState(nextState);
  return { started: true, pid: child.pid };
}

async function stopAgent() {
  const state = await readManagerState();
  const pids = new Set();
  if (state.agentPid && isPidRunning(state.agentPid)) {
    pids.add(Number(state.agentPid));
  }
  for (const processInfo of await getAgentProcesses()) {
    if (processInfo.pid) {
      pids.add(Number(processInfo.pid));
    }
  }
  if (pids.size === 0) {
    return { stopped: false, message: "No running agent process found." };
  }

  for (const pid of pids) {
    if (process.platform === "win32") {
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
      }).catch(() => {});
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }
  await writeManagerState({ ...state, agentPid: null, stoppedAt: new Date().toISOString() });
  return { stopped: true, pids: Array.from(pids) };
}

async function restartAgent(nodePath = process.execPath) {
  const stopped = await stopAgent();
  await new Promise((resolve) => setTimeout(resolve, 600));
  const started = await startAgent(nodePath);
  return { stopped, started };
}

async function installTask(input) {
  if (process.platform !== "win32") {
    throw new Error("Scheduled Task install is only available on Windows.");
  }
  const taskName = String(input.taskName || TASK_NAME);
  const nodePath = String(input.nodePath || process.execPath);
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(AGENT_ROOT, "install-startup-task.ps1"),
    "-TaskName",
    taskName,
    "-AgentRoot",
    AGENT_ROOT,
    "-NodePath",
    nodePath,
  ];
  if (input.wakeToRun) {
    args.push("-WakeToRun");
  }
  const { stdout, stderr } = await execFileAsync("powershell.exe", args, {
    cwd: AGENT_ROOT,
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim(), task: await getTaskStatus(taskName) };
}

async function runTaskAction(action, taskName = TASK_NAME) {
  if (process.platform !== "win32") {
    throw new Error("Scheduled Task control is only available on Windows.");
  }
  const safeTask = String(taskName || TASK_NAME).replace(/'/g, "''");
  const commands = {
    start: `Start-ScheduledTask -TaskName '${safeTask}'`,
    stop: `Stop-ScheduledTask -TaskName '${safeTask}'`,
    uninstall: `if (Get-ScheduledTask -TaskName '${safeTask}' -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName '${safeTask}' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${safeTask}' -Confirm:$false }`,
  };
  if (!commands[action]) {
    throw new Error(`Unknown task action: ${action}`);
  }
  const result = await runPowerShell(commands[action], 30000);
  return { ...result, task: await getTaskStatus(taskName) };
}

async function tailLog(fileName, maxBytes = 12000) {
  const allowed = new Set([
    "agent-gui.log",
    "agent-gui.err.log",
    "agent-service.log",
    "agent-service.err.log",
    "supervisor.log",
  ]);
  if (!allowed.has(fileName)) {
    throw new Error("Unknown log file.");
  }
  const filePath = path.join(LOG_ROOT, fileName);
  try {
    const stat = await fsp.stat(filePath);
    const size = Math.min(stat.size, maxBytes);
    const handle = await fsp.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, Math.max(0, stat.size - size));
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function statusPayload() {
  const { configExists, config } = await readConfigForUi();
  const state = await readManagerState();
  const processes = await getAgentProcesses();
  const task = await getTaskStatus();
  return {
    ok: true,
    manager: {
      pid: process.pid,
      root: AGENT_ROOT,
      nodePath: process.execPath,
      url: `http://${HOST}:${PORT}/`,
      taskName: TASK_NAME,
    },
    configExists,
    config,
    state,
    processes,
    running: processes.length > 0,
    task,
    sleepReality: "Windows sleep/hibernate stops CPU and network execution. Use SYSTEM startup, resume, prevent sleep, and optional wake timers; user code cannot keep running while the machine is truly asleep or hibernated.",
  };
}

async function serveStatic(request, response, pathname) {
  const fileName = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = path.normalize(fileName).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(AGENT_ROOT, "manager", safePath);
  if (!filePath.startsWith(path.join(AGENT_ROOT, "manager"))) {
    textResponse(response, 403, "Forbidden");
    return;
  }
  const ext = path.extname(filePath);
  const body = await fsp.readFile(filePath);
  response.writeHead(200, {
    "Content-Type": TEXT_TYPES[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

const server = http.createServer(asyncRoute(async (request, response) => {
  const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  if (request.method === "GET" && (pathname === "/" || pathname === "/manager.css" || pathname === "/manager.js")) {
    await serveStatic(request, response, pathname);
    return;
  }

  if (request.method === "GET" && pathname === "/api/status") {
    jsonResponse(response, 200, await statusPayload());
    return;
  }

  if (request.method === "GET" && pathname === "/api/logs") {
    const file = url.searchParams.get("file") || "agent-gui.log";
    jsonResponse(response, 200, { ok: true, file, text: await tailLog(file) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/config") {
    const body = await parseJsonBody(request);
    jsonResponse(response, 200, { ok: true, config: await saveConfig(body) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/agent/start") {
    const body = await parseJsonBody(request);
    jsonResponse(response, 200, { ok: true, result: await startAgent(body.nodePath || process.execPath) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/agent/stop") {
    jsonResponse(response, 200, { ok: true, result: await stopAgent() });
    return;
  }

  if (request.method === "POST" && pathname === "/api/agent/restart") {
    const body = await parseJsonBody(request);
    jsonResponse(response, 200, { ok: true, result: await restartAgent(body.nodePath || process.execPath) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/task/install") {
    jsonResponse(response, 200, { ok: true, result: await installTask(await parseJsonBody(request)) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/task/start") {
    const body = await parseJsonBody(request);
    jsonResponse(response, 200, { ok: true, result: await runTaskAction("start", body.taskName) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/task/stop") {
    const body = await parseJsonBody(request);
    jsonResponse(response, 200, { ok: true, result: await runTaskAction("stop", body.taskName) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/task/uninstall") {
    const body = await parseJsonBody(request);
    jsonResponse(response, 200, { ok: true, result: await runTaskAction("uninstall", body.taskName) });
    return;
  }

  jsonResponse(response, 404, { ok: false, error: "Not found." });
}));

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log(`[manager] Device Snapshot Agent Manager is running at ${url}`);
  if (process.env.AGENT_MANAGER_OPEN !== "0" && process.platform === "win32") {
    spawn("powershell.exe", ["-NoProfile", "-Command", `Start-Process '${url}'`], {
      windowsHide: true,
      stdio: "ignore",
    }).unref();
  }
});
