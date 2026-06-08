const statusEls = {
  agentState: document.getElementById("agentState"),
  taskState: document.getElementById("taskState"),
  managerPid: document.getElementById("managerPid"),
  agentPid: document.getElementById("agentPid"),
  serverPreview: document.getElementById("serverPreview"),
  toast: document.getElementById("toast"),
  logs: document.getElementById("logs"),
};

const configForm = document.getElementById("configForm");
const configInputs = Array.from(document.querySelectorAll("[data-config]"));
const taskNameInput = document.getElementById("taskName");
const nodePathInput = document.getElementById("nodePath");
const wakeToRunInput = document.getElementById("wakeToRun");
const iceServersText = document.getElementById("webRtcIceServersText");
const logFileSelect = document.getElementById("logFile");
let formDirty = false;
let latestStatus = null;
let toastTimer = null;

function toast(message, tone = "info") {
  clearTimeout(toastTimer);
  statusEls.toast.textContent = message;
  statusEls.toast.style.background = tone === "bad"
    ? "rgba(167, 49, 49, 0.95)"
    : tone === "ok"
      ? "rgba(24, 112, 94, 0.95)"
      : "rgba(24, 32, 47, 0.92)";
  statusEls.toast.classList.add("show");
  toastTimer = setTimeout(() => statusEls.toast.classList.remove("show"), 3600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Request failed with status ${response.status}`);
  }
  return data;
}

function setPill(el, text, className) {
  el.textContent = text;
  el.classList.remove("ok", "warn", "bad");
  if (className) {
    el.classList.add(className);
  }
}

function valueForField(input) {
  if (input.type === "checkbox") {
    return input.checked;
  }
  if (input.type === "number") {
    return input.value === "" ? "" : Number(input.value);
  }
  return input.value;
}

function applyConfig(config) {
  for (const input of configInputs) {
    const key = input.dataset.config;
    if (!(key in config)) {
      continue;
    }
    if (input.type === "checkbox") {
      input.checked = Boolean(config[key]);
    } else {
      input.value = config[key] ?? "";
    }
  }
  iceServersText.value = JSON.stringify(config.webRtcIceServers || [], null, 2);
  formDirty = false;
}

function collectConfig() {
  const payload = {};
  for (const input of configInputs) {
    payload[input.dataset.config] = valueForField(input);
  }
  payload.webRtcIceServersText = iceServersText.value;
  return payload;
}

function renderStatus(data) {
  latestStatus = data;
  const processList = data.processes || [];
  const pids = processList.map((item) => item.pid).filter(Boolean);
  setPill(
    statusEls.agentState,
    data.running ? `Agent: running (${pids.join(", ")})` : "Agent: stopped",
    data.running ? "ok" : "warn"
  );
  const task = data.task || {};
  setPill(
    statusEls.taskState,
    task.installed ? `Task: ${task.state || "installed"}` : "Task: not installed",
    task.installed ? "ok" : "warn"
  );
  statusEls.managerPid.textContent = data.manager?.pid || "-";
  statusEls.agentPid.textContent = pids.length ? pids.join(", ") : "-";
  statusEls.serverPreview.textContent = data.config?.serverUri || data.config?.serverUrl || "-";
  taskNameInput.value = task.taskName || data.manager?.taskName || "DeviceSnapshotAgent";
  nodePathInput.value = data.state?.nodePath || data.manager?.nodePath || "node.exe";
  wakeToRunInput.checked = Boolean(task.wakeToRun);
  if (!formDirty) {
    applyConfig(data.config || {});
  }
}

async function refreshStatus() {
  const data = await api("/api/status");
  renderStatus(data);
  await refreshLogs();
}

async function refreshLogs() {
  const file = encodeURIComponent(logFileSelect.value);
  const data = await api(`/api/logs?file=${file}`);
  statusEls.logs.textContent = data.text || "No log lines yet.";
}

async function saveConfig({ restart = false } = {}) {
  const payload = collectConfig();
  await api("/api/config", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  formDirty = false;
  if (restart) {
    await api("/api/agent/restart", {
      method: "POST",
      body: JSON.stringify({ nodePath: nodePathInput.value }),
    });
    toast("Config saved and agent restarted.", "ok");
  } else {
    toast("Config saved. Running agent will reload supported fields automatically.", "ok");
  }
  await refreshStatus();
}

async function runAction(path, body = {}, message = "Done.") {
  await api(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  toast(message, "ok");
  await refreshStatus();
}

for (const input of [...configInputs, iceServersText]) {
  input.addEventListener("input", () => {
    formDirty = true;
  });
  input.addEventListener("change", () => {
    formDirty = true;
  });
}

document.getElementById("refreshBtn").addEventListener("click", () => {
  refreshStatus().catch((error) => toast(error.message, "bad"));
});

document.getElementById("startAgentBtn").addEventListener("click", () => {
  runAction("/api/agent/start", { nodePath: nodePathInput.value }, "Agent started.").catch((error) => toast(error.message, "bad"));
});

document.getElementById("stopAgentBtn").addEventListener("click", () => {
  runAction("/api/agent/stop", {}, "Agent stopped.").catch((error) => toast(error.message, "bad"));
});

document.getElementById("restartAgentBtn").addEventListener("click", () => {
  runAction("/api/agent/restart", { nodePath: nodePathInput.value }, "Agent restarted.").catch((error) => toast(error.message, "bad"));
});

document.getElementById("saveConfigBtn").addEventListener("click", () => {
  saveConfig({ restart: false }).catch((error) => toast(error.message, "bad"));
});

document.getElementById("saveRestartBtn").addEventListener("click", () => {
  saveConfig({ restart: true }).catch((error) => toast(error.message, "bad"));
});

document.getElementById("installTaskBtn").addEventListener("click", () => {
  runAction("/api/task/install", {
    taskName: taskNameInput.value,
    nodePath: nodePathInput.value,
    wakeToRun: wakeToRunInput.checked,
  }, "Scheduled Task installed.").catch((error) => toast(error.message, "bad"));
});

document.getElementById("startTaskBtn").addEventListener("click", () => {
  runAction("/api/task/start", { taskName: taskNameInput.value }, "Scheduled Task started.").catch((error) => toast(error.message, "bad"));
});

document.getElementById("stopTaskBtn").addEventListener("click", () => {
  runAction("/api/task/stop", { taskName: taskNameInput.value }, "Scheduled Task stopped.").catch((error) => toast(error.message, "bad"));
});

document.getElementById("uninstallTaskBtn").addEventListener("click", () => {
  runAction("/api/task/uninstall", { taskName: taskNameInput.value }, "Scheduled Task uninstalled.").catch((error) => toast(error.message, "bad"));
});

logFileSelect.addEventListener("change", () => {
  refreshLogs().catch((error) => toast(error.message, "bad"));
});

configForm.addEventListener("submit", (event) => {
  event.preventDefault();
});

refreshStatus().catch((error) => toast(error.message, "bad"));
setInterval(() => {
  refreshStatus().catch(() => {});
}, 3500);
