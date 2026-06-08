import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverRoot = path.join(projectRoot, "server");
const criticalFiles = {
  "index.php": path.join(serverRoot, "index.php"),
  "artifact.php": path.join(serverRoot, "artifact.php"),
  "version.php": path.join(serverRoot, "version.php"),
  "api/artifact-download.php": path.join(serverRoot, "api", "artifact-download.php"),
  "api/complete.php": path.join(serverRoot, "api", "complete.php"),
  "api/enroll.php": path.join(serverRoot, "api", "enroll.php"),
  "api/live.php": path.join(serverRoot, "api", "live.php"),
  "api/poll.php": path.join(serverRoot, "api", "poll.php"),
  "api/upload.php": path.join(serverRoot, "api", "upload.php"),
  "lib/config.php": path.join(serverRoot, "lib", "config.php"),
  "lib/db.php": path.join(serverRoot, "lib", "db.php"),
  "lib/helpers.php": path.join(serverRoot, "lib", "helpers.php"),
  "assets/app.js": path.join(serverRoot, "assets", "app.js"),
  "assets/style.css": path.join(serverRoot, "assets", "style.css"),
  "schema.sql": path.join(serverRoot, "schema.sql"),
};

function normalizeServerUrl(value) {
  const url = new URL(String(value || "").trim());
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Server URL must use http or https.");
  }
  return url.toString().replace(/\/+$/, "");
}

async function expectedRelease() {
  const release = crypto.createHash("sha256");
  const files = {};
  for (const [name, filePath] of Object.entries(criticalFiles)) {
    const bytes = await fs.readFile(filePath);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    files[name] = sha256;
    release.update(`${name}:`);
    release.update(bytes);
  }
  return { release: release.digest("hex").slice(0, 12), files };
}

async function fetchChecked(url, options = {}) {
  const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}verify=${Date.now()}`, {
    redirect: "manual",
    ...options,
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  return { response, text };
}

const serverUrl = normalizeServerUrl(process.argv[2] || "https://lppsp.ui.ac.id/any/server");
const expected = await expectedRelease();
const failures = [];

console.log(`[verify] target   ${serverUrl}`);
console.log(`[verify] expected ${expected.release}`);

let remoteVersion = null;
try {
  const { response, text } = await fetchChecked(`${serverUrl}/version.php`);
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.includes("application/json")) {
    failures.push(`version.php returned ${response.status} ${contentType || "(no content-type)"}; deployment path or rewrite is wrong`);
  } else {
    remoteVersion = JSON.parse(text);
  }
} catch (error) {
  failures.push(`version.php failed: ${error.message}`);
}

if (remoteVersion) {
  if (remoteVersion.contract_version !== 3) {
    failures.push(`version contract is ${remoteVersion.contract_version ?? "missing"}, expected 3`);
  }
  if (remoteVersion.features?.capture_queue_compaction !== true) {
    failures.push("remote release does not advertise capture_queue_compaction");
  }
  if (remoteVersion.features?.agent_boot_recovery !== true) {
    failures.push("remote release does not advertise agent_boot_recovery");
  }
  if (remoteVersion.features?.live_command_expiry !== true) {
    failures.push("remote release does not advertise live_command_expiry");
  }
  if (remoteVersion.features?.remote_clipboard !== true) {
    failures.push("remote release does not advertise remote_clipboard");
  }
  if (remoteVersion.features?.live_zoom !== true) {
    failures.push("remote release does not advertise live_zoom");
  }
  if (remoteVersion.features?.focus_toolbar_compact !== true) {
    failures.push("remote release does not advertise focus_toolbar_compact");
  }
  if (remoteVersion.features?.low_latency_http_tuning !== true) {
    failures.push("remote release does not advertise low_latency_http_tuning");
  }
  if (remoteVersion.features?.drag_drop_upload !== true) {
    failures.push("remote release does not advertise drag_drop_upload");
  }
  if (remoteVersion.features?.neumorphic_ui !== true) {
    failures.push("remote release does not advertise neumorphic_ui");
  }
  if (remoteVersion.release !== expected.release) {
    console.log(`[verify] remote release label ${remoteVersion.release} differs from auto hash; validating file hashes`);
  }
  for (const [name, expectedHash] of Object.entries(expected.files)) {
    const remoteHash = remoteVersion.files?.[name]?.sha256;
    if (remoteHash !== expectedHash) {
      failures.push(`${name} mismatch: remote=${remoteHash || "missing"} expected=${expectedHash}`);
    }
  }
}

try {
  const { response, text } = await fetchChecked(`${serverUrl}/`);
  const releaseHeader = response.headers.get("x-app-release");
  if (!response.ok) {
    failures.push(`dashboard returned HTTP ${response.status}`);
  }
  if (remoteVersion && releaseHeader !== remoteVersion.release) {
    failures.push(`dashboard X-App-Release=${releaseHeader || "missing"}, version.php=${remoteVersion.release}`);
  }
  if (!text.includes('meta name="app-release"')) {
    failures.push("dashboard HTML does not contain app-release marker");
  }
} catch (error) {
  failures.push(`dashboard failed: ${error.message}`);
}

try {
  const { response } = await fetchChecked(`${serverUrl}/api/poll.php`, { method: "GET" });
  if (response.status !== 405) {
    failures.push(`api/poll.php GET returned ${response.status}, expected 405`);
  }
} catch (error) {
  failures.push(`api/poll.php probe failed: ${error.message}`);
}

if (failures.length) {
  console.error("\n[verify] FAILED");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  console.error("\nDeploy the complete server/ directory to the path serving this URL, then clear/restart PHP OPcache if timestamps are disabled.");
  process.exitCode = 1;
} else {
  console.log(`[verify] PASS release=${remoteVersion.release} contract=${remoteVersion.contract_version}`);
}
