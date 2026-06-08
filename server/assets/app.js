(() => {
  const root = document.querySelector("[data-live-dashboard]");
  if (!root) {
    return;
  }

  const apiUrl = root.dataset.liveApi;
  const webrtcApiUrl = root.dataset.webrtcApi;
  const csrfToken = root.dataset.csrfToken;
  const defaultCaptureIntervalMs = Math.max(400, Number(root.dataset.captureInterval || 1000));
  const defaultStatusIntervalMs = Math.max(300, Number(root.dataset.statusInterval || 650));
  const idleStatusIntervalMs = Math.max(2000, Number(root.dataset.idleStatusInterval || 5000));
  const defaultPointerBatchMs = Math.max(12, Number(root.dataset.pointerBatch || 24));
  const pointerMaxEvents = Math.max(4, Number(root.dataset.pointerMaxEvents || 64));
  const wheelPixelPerLine = Math.max(4, Number(root.dataset.wheelPixelPerLine || 6));
  const wheelPageLines = Math.max(3, Number(root.dataset.wheelPageLines || 24));
  const wheelMaxLines = Math.max(3, Number(root.dataset.wheelMaxLines || 120));
  const speedProfiles = {
    eco: {
      capture: Math.max(2800, defaultCaptureIntervalMs + 1800),
      status: Math.max(1500, defaultStatusIntervalMs + 850),
      pointer: Math.max(64, defaultPointerBatchMs * 2),
    },
    flow: {
      capture: defaultCaptureIntervalMs,
      status: defaultStatusIntervalMs,
      pointer: defaultPointerBatchMs,
    },
    burst: {
      capture: Math.max(240, Math.min(420, Math.round(defaultCaptureIntervalMs / 3))),
      status: Math.max(240, Math.min(360, Math.round(defaultStatusIntervalMs / 2))),
      pointer: 12,
    },
  };

  const deviceSelect = root.querySelector("[data-live-device]");
  const transportSelect = root.querySelector("[data-live-transport-select]");
  const liveToggle = root.querySelector("[data-live-toggle]");
  const frameToggle = root.querySelector("[data-frame-toggle]");
  const controlToggle = root.querySelector("[data-control-toggle]");
  const keyboardToggle = root.querySelector("[data-keyboard-toggle]");
  const refreshButton = root.querySelector("[data-live-refresh]");
  const fullscreenButton = root.querySelector("[data-live-fullscreen]");
  const gridButton = root.querySelector("[data-live-grid]");
  const verboseButton = root.querySelector("[data-live-verbose]");
  const zoomOutButton = root.querySelector("[data-live-zoom-out]");
  const zoomInButton = root.querySelector("[data-live-zoom-in]");
  const zoomResetButton = root.querySelector("[data-live-zoom-reset]");
  const speedButtons = Array.from(root.querySelectorAll("[data-live-speed]"));
  const stopButton = root.querySelector("[data-live-stop]");
  const viewer = root.querySelector("[data-live-viewer]");
  const stage = root.querySelector("[data-live-stage]");
  const screen = root.querySelector("[data-live-screen]");
  const empty = root.querySelector("[data-live-empty]");
  const status = root.querySelector("[data-live-status]");
  const freshness = root.querySelector("[data-live-freshness]");
  const queue = root.querySelector("[data-live-queue]");
  const transport = root.querySelector("[data-live-transport]");
  const mode = root.querySelector("[data-live-mode]");
  const deviceSearch = document.querySelector("[data-device-search]");
  const deviceCards = Array.from(document.querySelectorAll("[data-device-card]"));
  const workspaceTabs = Array.from(document.querySelectorAll("[data-workspace-tab]"));
  const workspacePanels = Array.from(document.querySelectorAll("[data-workspace-panel]"));
  const uploadZones = Array.from(document.querySelectorAll("[data-upload-zone]"));

  let statusTimer = null;
  let captureTimer = null;
  let liveLoopGeneration = 0;
  let latestFrameId = null;
  let statusInFlight = false;
  let captureInFlight = false;
  let clickInFlight = false;
  let singleClickTimer = null;
  let keyChain = Promise.resolve();
  let activeSpeed = "flow";
  let captureIntervalMs = speedProfiles.flow.capture;
  let statusIntervalMs = speedProfiles.flow.status;
  let pointerBatchMs = speedProfiles.flow.pointer;
  let visibleLiveWanted = false;
  let frameLoopEnabled = localStorage.getItem("dsc_live_frames") !== "off";
  let pointerBatchTimer = null;
  let pointerKeepaliveTimer = null;
  let pointerEvents = [];
  let pointerPackets = [];
  let pointerSending = false;
  let pointerState = null;
  let pointerSequence = 0;
  let pointerEpoch = Date.now();
  let pointerGestureNumber = 0;
  let pointerInputAvailable = false;
  let keyboardStateAvailable = false;
  let wheelInputAvailable = false;
  let wheelRemainderX = 0;
  let wheelRemainderY = 0;
  let liveRttMs = null;
  let focusModeActive = false;
  let liveZoom = 1;
  let livePanX = 0;
  let livePanY = 0;
  let panState = null;
  let detailStatusEnabled = localStorage.getItem("dsc_live_detail_status") === "on";
  let webRtcPeer = null;
  let webRtcChannel = null;
  let webRtcSessionUid = "";
  let webRtcAnswerTimer = null;
  let webRtcState = "idle";
  let webRtcMessageId = 0;
  const webRtcPending = new Map();
  const remoteKeysDown = new Set();
  const pointerEventsSupported = "PointerEvent" in window;

  if (frameToggle) {
    frameToggle.checked = frameLoopEnabled;
  }

  function framesAreEnabled() {
    return !frameToggle || frameToggle.checked;
  }

  function selectedDeviceId() {
    return Number(deviceSelect?.value || 0);
  }

  deviceSearch?.addEventListener("input", () => {
    const needle = deviceSearch.value.trim().toLowerCase();
    deviceCards.forEach((card) => {
      card.hidden = needle !== "" && !String(card.dataset.search || "").includes(needle);
    });
  });

  function activateWorkspacePanel(target) {
    workspaceTabs.forEach((tabButton) => {
      const active = tabButton.dataset.workspaceTab === target;
      tabButton.classList.toggle("is-active", active);
      tabButton.setAttribute("aria-selected", active ? "true" : "false");
    });
    workspacePanels.forEach((panel) => {
      const active = panel.dataset.workspacePanel === target;
      panel.classList.toggle("is-active", active);
      panel.hidden = !active;
    });
  }

  workspaceTabs.forEach((tabButton) => {
    tabButton.addEventListener("click", () => activateWorkspacePanel(tabButton.dataset.workspaceTab || "devices"));
  });

  function formatUploadBytes(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) {
      return "0 B";
    }
    const units = ["B", "KB", "MB", "GB"];
    let amount = value;
    let unitIndex = 0;
    while (amount >= 1024 && unitIndex < units.length - 1) {
      amount /= 1024;
      unitIndex += 1;
    }
    return `${amount >= 10 || unitIndex === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unitIndex]}`;
  }

  function updateUploadZone(zone, input) {
    const file = input.files?.[0] || null;
    const label = zone.querySelector("[data-upload-file-name]");
    zone.classList.toggle("has-file", Boolean(file));
    zone.classList.remove("is-dragging");
    if (label) {
      label.textContent = file ? `${file.name} - ${formatUploadBytes(file.size)}` : "atau klik untuk pilih file";
    }
  }

  uploadZones.forEach((zone) => {
    const input = zone.querySelector("[data-upload-input]");
    if (!input) {
      return;
    }

    input.addEventListener("change", () => updateUploadZone(zone, input));
    zone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        input.click();
      }
    });

    ["dragenter", "dragover"].forEach((eventName) => {
      zone.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
        zone.classList.add("is-dragging");
      });
    });

    ["dragleave", "dragend"].forEach((eventName) => {
      zone.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
        zone.classList.remove("is-dragging");
      });
    });

    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const file = event.dataTransfer?.files?.[0];
      if (!file || typeof DataTransfer === "undefined") {
        updateUploadZone(zone, input);
        return;
      }
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    updateUploadZone(zone, input);
  });

  if (uploadZones.length) {
    document.addEventListener("dragover", (event) => {
      event.preventDefault();
    });
    document.addEventListener("drop", (event) => {
      if (!event.target?.closest?.("[data-upload-zone]")) {
        event.preventDefault();
      }
    });
  }

  function setStatus(text, options = {}) {
    if (options.detail && !detailStatusEnabled) {
      return;
    }
    status.textContent = text;
  }

  function updateVerboseState() {
    root.dataset.detailStatus = detailStatusEnabled ? "on" : "off";
    if (!verboseButton) {
      return;
    }
    const label = detailStatusEnabled ? "Hide detailed live status" : "Show detailed live status";
    verboseButton.setAttribute("aria-pressed", detailStatusEnabled ? "true" : "false");
    verboseButton.setAttribute("aria-label", label);
    verboseButton.setAttribute("title", label);
    verboseButton.querySelector("[data-verbose-label]")?.replaceChildren(label);
  }

  function updateZoomState() {
    clampLivePan();
    const label = liveZoom === 1 ? "Fit" : `${Math.round(liveZoom * 100)}%`;
    stage?.style.setProperty("--live-zoom", String(liveZoom));
    stage?.style.setProperty("--live-pan-x", `${Math.round(livePanX)}px`);
    stage?.style.setProperty("--live-pan-y", `${Math.round(livePanY)}px`);
    root.dataset.zoom = liveZoom === 1 ? "fit" : "manual";
    zoomResetButton?.replaceChildren(label);
    zoomResetButton?.setAttribute("aria-label", liveZoom === 1 ? "Zoom fit" : `Reset zoom from ${label}`);
    zoomOutButton?.toggleAttribute("disabled", liveZoom <= 1);
    zoomResetButton?.toggleAttribute("disabled", liveZoom === 1);
  }

  function setLiveZoom(nextZoom) {
    const normalized = Math.max(1, Math.min(4, Math.round(nextZoom * 100) / 100));
    liveZoom = normalized;
    if (liveZoom === 1) {
      livePanX = 0;
      livePanY = 0;
    }
    updateZoomState();
    stage?.focus({ preventScroll: true });
    setStatus(liveZoom === 1 ? "Zoom fit" : `Zoom ${Math.round(liveZoom * 100)}%`, { detail: true });
  }

  function maxLivePan() {
    if (liveZoom <= 1 || !screen?.classList.contains("ready")) {
      return { x: 0, y: 0 };
    }
    try {
      const box = renderedImageBox();
      return {
        x: Math.max(0, (box.width * (liveZoom - 1)) / 2),
        y: Math.max(0, (box.height * (liveZoom - 1)) / 2),
      };
    } catch {
      return { x: 0, y: 0 };
    }
  }

  function clampLivePan() {
    if (liveZoom <= 1) {
      livePanX = 0;
      livePanY = 0;
      return;
    }
    const max = maxLivePan();
    livePanX = Math.max(-max.x, Math.min(max.x, livePanX));
    livePanY = Math.max(-max.y, Math.min(max.y, livePanY));
  }

  function panLiveView(deltaX, deltaY) {
    if (liveZoom <= 1) {
      return;
    }
    livePanX += deltaX;
    livePanY += deltaY;
    updateZoomState();
    setStatus(`Pan ${Math.round(livePanX)}, ${Math.round(livePanY)}`, { detail: true });
  }

  function stepLiveZoom(direction) {
    const levels = [1, 1.25, 1.5, 2, 3, 4];
    const currentIndex = levels.findIndex((level) => level >= liveZoom - 0.01);
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = Math.max(0, Math.min(levels.length - 1, baseIndex + direction));
    setLiveZoom(levels[nextIndex]);
  }

  function setMode(text, state) {
    mode.textContent = text;
    mode.dataset.state = state;
    root.dataset.mode = state;
  }

  function setQueue(data) {
    const parts = [];
    if (data?.pending_capture) {
      parts.push("frame");
    }
    if (data?.pending_click) {
      parts.push("klik");
    }
    if (data?.pending_pointer) {
      parts.push("pointer");
    }
    if (data?.pending_keyboard) {
      parts.push("keyboard");
    }
    if (data?.pending_keyboard_state) {
      parts.push("keys");
    }
    queue.textContent = parts.length ? `Queue ${parts.join(", ")}` : "Queue clear";
    queue.dataset.state = parts.length ? "pending" : "clear";
  }

  function setTransport(data) {
    if (!transport || !data?.transport) {
      return;
    }
    const requested = String(data.transport.requested || "poll");
    const selected = String(data.transport.primary || "http-poll");
    const webRtcActive = webRtcState === "open";
    const selectedLabel = webRtcActive || selected === "webrtc-data"
      ? "WebRTC"
      : selected === "http-long-poll"
        ? "Long poll"
        : "Polling";
    const transportLabel = requested === "auto" ? `Auto - ${selectedLabel}` : selectedLabel;
    const latencyLabel = Number.isFinite(liveRttMs) ? ` - ${Math.round(liveRttMs)}ms` : "";
    transport.textContent = `${transportLabel}${latencyLabel}`;
    transport.dataset.state = requested === "webrtc" && !webRtcActive && selected !== "webrtc-data"
      ? "pending"
      : requested === "long-poll" && selected !== "http-long-poll"
        ? "pending"
        : "ready";
    if (transportSelect && transportSelect.value !== requested) {
      transportSelect.value = requested;
    }
  }

  function setCapabilities(data) {
    pointerInputAvailable = Boolean(data?.capabilities?.pointer_input);
    keyboardStateAvailable = Boolean(data?.capabilities?.keyboard_state);
    wheelInputAvailable = Boolean(data?.capabilities?.wheel_input);
    root.dataset.pointerInput = pointerInputAvailable ? "stream" : "click";
    root.dataset.keyboardInput = keyboardStateAvailable ? "state" : "tap";
    root.dataset.wheelInput = wheelInputAvailable ? "on" : "off";
    root.dataset.webrtcInput = data?.capabilities?.webrtc_data ? "available" : "missing";
  }

  function clearWebRtcAnswerTimer() {
    if (webRtcAnswerTimer) {
      clearTimeout(webRtcAnswerTimer);
      webRtcAnswerTimer = null;
    }
  }

  function closeWebRtcSession(reason = "closed") {
    clearWebRtcAnswerTimer();
    for (const pending of webRtcPending.values()) {
      pending.reject(new Error(`WebRTC ${reason}`));
    }
    webRtcPending.clear();
    if (webRtcChannel) {
      try {
        webRtcChannel.close();
      } catch {}
    }
    if (webRtcPeer) {
      try {
        webRtcPeer.close();
      } catch {}
    }
    if (webRtcSessionUid && webrtcApiUrl) {
      fetch(webrtcApiUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          action: "close",
          csrf_token: csrfToken,
          session_uid: webRtcSessionUid,
        }),
      }).catch(() => {});
    }
    webRtcPeer = null;
    webRtcChannel = null;
    webRtcSessionUid = "";
    webRtcState = "idle";
  }

  function waitForIceGathering(peer) {
    if (peer.iceGatheringState === "complete") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timeout = window.setTimeout(resolve, 2500);
      peer.addEventListener("icegatheringstatechange", () => {
        if (peer.iceGatheringState === "complete") {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  }

  async function postWebRtc(action, payload = {}) {
    if (!webrtcApiUrl) {
      throw new Error("Endpoint WebRTC belum tersedia");
    }
    const response = await fetch(webrtcApiUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({
        action,
        csrf_token: csrfToken,
        ...payload,
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.error || `WebRTC request gagal (${response.status})`);
    }
    return data;
  }

  async function pollWebRtcAnswer(sessionUid, generation) {
    if (generation !== webRtcSessionUid || webRtcState === "open") {
      return;
    }
    try {
      const data = await postWebRtc("get_answer", { session_uid: sessionUid });
      if (data.answer && webRtcPeer) {
        await webRtcPeer.setRemoteDescription(data.answer);
        const candidates = Array.isArray(data.answer.candidates) ? data.answer.candidates : [];
        for (const candidate of candidates) {
          try {
            await webRtcPeer.addIceCandidate(candidate);
          } catch {}
        }
        setStatus("WebRTC answer diterima", { detail: true });
        return;
      }
      if (["failed", "closed", "expired"].includes(String(data.status))) {
        throw new Error(data.error || `WebRTC ${data.status}`);
      }
      webRtcAnswerTimer = window.setTimeout(() => pollWebRtcAnswer(sessionUid, generation), 650);
    } catch (error) {
      closeWebRtcSession("failed");
      setStatus(error.message);
    }
  }

  async function startWebRtcSession() {
    if (!webrtcApiUrl || typeof RTCPeerConnection === "undefined") {
      setStatus("Browser tidak mendukung WebRTC data channel");
      return;
    }
    if (webRtcState === "connecting" || webRtcState === "open") {
      return;
    }
    closeWebRtcSession("restart");
    webRtcState = "connecting";
    setStatus("Membuka WebRTC...");
    try {
      const peer = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      const channel = peer.createDataChannel("device-control", {
        ordered: true,
      });
      webRtcPeer = peer;
      webRtcChannel = channel;
      channel.onopen = () => {
        webRtcState = "open";
        setStatus("WebRTC data channel aktif");
        setTransport({ transport: { requested: "webrtc", primary: "webrtc-data" } });
      };
      channel.onclose = () => {
        if (webRtcState === "open") {
          setStatus("WebRTC tertutup, fallback HTTP");
        }
        webRtcState = "idle";
      };
      channel.onerror = () => {
        setStatus("WebRTC error, fallback HTTP");
      };
      channel.onmessage = (event) => {
        let message = null;
        try {
          message = JSON.parse(String(event.data || "{}"));
        } catch {
          return;
        }
        if (!message?.id || !webRtcPending.has(message.id)) {
          return;
        }
        const pending = webRtcPending.get(message.id);
        webRtcPending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.ok === false) {
          pending.reject(new Error(message.error || "WebRTC command gagal"));
        } else {
          pending.resolve(message);
        }
      };
      peer.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
          closeWebRtcSession(peer.connectionState);
        }
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);
      const created = await postWebRtc("create_offer", {
        device_id: selectedDeviceId(),
        offer: peer.localDescription,
      });
      webRtcSessionUid = created.session_uid;
      pollWebRtcAnswer(webRtcSessionUid, webRtcSessionUid);
    } catch (error) {
      closeWebRtcSession("failed");
      setStatus(error.message);
    }
  }

  function sendWebRtcControl(action, payload) {
    if (webRtcState !== "open" || !webRtcChannel || webRtcChannel.readyState !== "open") {
      throw new Error("WebRTC belum aktif");
    }
    const id = ++webRtcMessageId;
    webRtcChannel.send(JSON.stringify({ id, action, payload }));
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        webRtcPending.delete(id);
        reject(new Error("WebRTC command timeout"));
      }, 2500);
      webRtcPending.set(id, { resolve, reject, timeout });
    });
  }

  async function postControl(action, payload = {}) {
    if ((transportSelect?.value || "") === "webrtc" && webRtcState === "open") {
      try {
        const direct = await sendWebRtcControl(action, payload);
        return direct.response || { ok: true };
      } catch (error) {
        setStatus(`${error.message}; fallback HTTP`, { detail: true });
      }
    }
    return postLive(action, payload);
  }

  function pointerCanStream() {
    return pointerEventsSupported && pointerInputAvailable;
  }

  function setFrameFreshness(frame) {
    if (!frame?.completed_at) {
      freshness.textContent = "Frame -";
      freshness.dataset.state = "empty";
      return;
    }

    const observedAt = String(frame.observed_at || frame.completed_at || "").replace(" ", "T");
    const ageMs = Date.now() - Date.parse(observedAt);
    const ageLabel = Number.isFinite(ageMs) && ageMs >= 0 ? ` · ${Math.max(0, Math.round(ageMs / 100) / 10)}s` : "";
    const captureMs = Number(frame.screen?.captureMs);
    const captureLabel = Number.isFinite(captureMs) ? ` · cap ${Math.round(captureMs)}ms` : "";
    freshness.textContent = `Frame #${frame.id}${ageLabel}${captureLabel}`;
    freshness.dataset.state = "ready";
  }

  function updateSwitchAria() {
    liveToggle?.setAttribute("aria-checked", liveToggle.checked ? "true" : "false");
    frameToggle?.setAttribute("aria-checked", frameToggle.checked ? "true" : "false");
    controlToggle?.setAttribute("aria-checked", controlToggle.checked ? "true" : "false");
    controlToggle?.setAttribute("aria-disabled", controlToggle.disabled ? "true" : "false");
    keyboardToggle?.setAttribute("aria-checked", keyboardToggle.checked ? "true" : "false");
    keyboardToggle?.setAttribute("aria-disabled", keyboardToggle.disabled ? "true" : "false");
    root.dataset.frames = framesAreEnabled() ? "on" : "off";
  }

  function controlIsReady() {
    return Boolean(controlToggle?.checked && screen?.classList.contains("ready"));
  }

  function keyboardIsReady() {
    return Boolean(controlIsReady() && keyboardToggle?.checked);
  }

  function syncControlState() {
    if (!controlIsReady()) {
      if (keyboardToggle) {
        keyboardToggle.checked = false;
        keyboardToggle.disabled = true;
      }
      root.dataset.control = "off";
      root.dataset.keyboard = "off";
      updateSwitchAria();
      return;
    }

    if (keyboardToggle) {
      keyboardToggle.disabled = false;
    }
    root.dataset.control = "on";
    root.dataset.keyboard = keyboardToggle?.checked ? "on" : "off";
    updateSwitchAria();
  }

  function updateSpeedButtons() {
    root.dataset.speed = activeSpeed;
    speedButtons.forEach((button) => {
      button.setAttribute("aria-pressed", button.dataset.liveSpeed === activeSpeed ? "true" : "false");
    });
  }

  function setLiveSpeed(speed) {
    if (!Object.prototype.hasOwnProperty.call(speedProfiles, speed)) {
      return;
    }

    activeSpeed = speed;
    captureIntervalMs = speedProfiles[speed].capture;
    statusIntervalMs = speedProfiles[speed].status;
    pointerBatchMs = speedProfiles[speed].pointer;
    updateSpeedButtons();
    setStatus(`${speed[0].toUpperCase()}${speed.slice(1)} · frame ${captureIntervalMs}ms · input ${pointerBatchMs}ms`);

    if (liveToggle?.checked && !document.hidden) {
      startLive();
    }
  }

  async function postLive(action, payload = {}) {
    const requestStartedAt = performance.now();
    const response = await fetch(apiUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({
        action,
        csrf_token: csrfToken,
        device_id: selectedDeviceId(),
        live_active: Boolean(liveToggle?.checked || controlToggle?.checked || keyboardToggle?.checked),
        profile: activeSpeed,
        ...payload,
      }),
    });

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Server membalas non-JSON (${response.status})`);
    }

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || `Request gagal (${response.status})`);
    }

    const requestRttMs = performance.now() - requestStartedAt;
    liveRttMs = liveRttMs === null ? requestRttMs : ((liveRttMs * 0.75) + (requestRttMs * 0.25));
    data.client_rtt_ms = Math.round(requestRttMs);
    return data;
  }

  function loadFrameImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Frame gagal dimuat"));
      image.src = src;
    });
  }

  async function renderFrame(frame) {
    setFrameFreshness(frame);
    if (!frame) {
      screen.removeAttribute("src");
      screen.classList.remove("ready");
      screen.dataset.frameId = "";
      screen.dataset.naturalWidth = "";
      screen.dataset.naturalHeight = "";
      screen.dataset.controlWidth = "";
      screen.dataset.controlHeight = "";
      controlToggle.checked = false;
      controlToggle.disabled = true;
      syncControlState();
      empty.hidden = false;
      latestFrameId = null;
      return;
    }

    if (frame.id === latestFrameId) {
      return;
    }

    const nextSrc = `${frame.url}&v=${frame.id}-${Date.now()}`;
    try {
      const loadedImage = await loadFrameImage(nextSrc);
      latestFrameId = frame.id;
      screen.src = nextSrc;
      screen.dataset.frameId = String(frame.id);
      screen.dataset.naturalWidth = String(loadedImage.naturalWidth || "");
      screen.dataset.naturalHeight = String(loadedImage.naturalHeight || "");
      screen.dataset.controlWidth = String(frame.screen?.controlScreenSize?.width || loadedImage.naturalWidth || "");
      screen.dataset.controlHeight = String(frame.screen?.controlScreenSize?.height || loadedImage.naturalHeight || "");
      if (loadedImage.naturalWidth && loadedImage.naturalHeight) {
        root.style.setProperty("--screen-aspect", `${loadedImage.naturalWidth} / ${loadedImage.naturalHeight}`);
      }
      screen.classList.add("ready");
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        screen.animate(
          [{ opacity: 0.86 }, { opacity: 1 }],
          { duration: 140, easing: "ease-out" }
        );
      }
      controlToggle.disabled = false;
      syncControlState();
      empty.hidden = true;
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function refreshStatus() {
    if (statusInFlight) {
      return;
    }

    statusInFlight = true;
    try {
      const data = await postLive("status");
      await renderFrame(data.frame);
      setQueue(data);
      setTransport(data);
      setCapabilities(data);
      if ((transportSelect?.value || "") === "webrtc" && webRtcState === "idle") {
        startWebRtcSession();
      }
      const ageSeconds = Number(data.device?.last_seen_age_seconds);
      const agentVersion = data.device?.agent_version ? ` · v${data.device.agent_version}` : "";
      if (data.device?.online) {
        root.dataset.agentState = "online";
        setStatus(detailStatusEnabled
          ? `Agent connected${agentVersion} · ${Number.isFinite(ageSeconds) ? `${Math.round(ageSeconds)}s ago` : "active"}`
          : "Agent online");
      } else {
        root.dataset.agentState = "offline";
        setStatus(data.device?.last_seen ? `Agent offline${agentVersion} · last seen ${data.device.last_seen}` : "Agent belum pernah terhubung");
      }
    } catch (error) {
      root.dataset.agentState = "error";
      setMode("Error", "error");
      setStatus(error.message);
    } finally {
      statusInFlight = false;
    }
  }

  async function requestFrame(options = {}) {
    if (captureInFlight || document.hidden) {
      return;
    }
    if (!options.force && !framesAreEnabled()) {
      setMode("Frames paused", "paused");
      setStatus("Frame loop paused");
      return;
    }

    captureInFlight = true;
    try {
      const data = await postLive("capture", { profile: activeSpeed });
      await renderFrame(data.frame);
      setQueue(data);
      setTransport(data);
      setCapabilities(data);
      setStatus(data.pending_capture ? "Mengambil frame..." : "Frame diminta");
    } catch (error) {
      setMode("Error", "error");
      setStatus(error.message);
    } finally {
      captureInFlight = false;
    }
  }

  function stopTimers() {
    liveLoopGeneration += 1;
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    if (captureTimer) {
      clearTimeout(captureTimer);
      captureTimer = null;
    }
  }

  async function runCaptureLoop(generation) {
    await requestFrame();
    if (generation === liveLoopGeneration && liveToggle?.checked && framesAreEnabled() && !document.hidden) {
      captureTimer = window.setTimeout(() => runCaptureLoop(generation), captureIntervalMs);
    }
  }

  async function runStatusLoop(generation) {
    await refreshStatus();
    if (generation === liveLoopGeneration && liveToggle?.checked && !document.hidden) {
      statusTimer = window.setTimeout(() => runStatusLoop(generation), statusIntervalMs);
    }
  }

  async function runIdleStatusLoop(generation) {
    await refreshStatus();
    if (generation === liveLoopGeneration && !liveToggle?.checked && !document.hidden) {
      statusTimer = window.setTimeout(() => runIdleStatusLoop(generation), idleStatusIntervalMs);
    }
  }

  function stopLive() {
    stopTimers();
    setMode("Idle", "idle");
    setStatus("Idle");
    if (!document.hidden) {
      runIdleStatusLoop(liveLoopGeneration);
    }
  }

  function startLive() {
    stopTimers();
    if (document.hidden) {
      visibleLiveWanted = true;
      setMode("Paused", "paused");
      setStatus("Tab tidak aktif");
      return;
    }

    visibleLiveWanted = false;
    setMode(framesAreEnabled() ? "Live" : "Frames paused", framesAreEnabled() ? "live" : "paused");
    if (!framesAreEnabled()) {
      setStatus("Live status aktif, frame paused");
    }
    const generation = liveLoopGeneration;
    if (framesAreEnabled()) {
      runCaptureLoop(generation);
    }
    runStatusLoop(generation);
  }

  function panicOff() {
    if (singleClickTimer) {
      clearTimeout(singleClickTimer);
      singleClickTimer = null;
    }
    cancelPointerGesture("Kontrol dihentikan");
    releaseRemoteKeys("Kontrol dihentikan");
    if (liveToggle) {
      liveToggle.checked = false;
    }
    if (controlToggle) {
      controlToggle.checked = false;
    }
    if (keyboardToggle) {
      keyboardToggle.checked = false;
    }
    root.dataset.control = "off";
    root.dataset.keyboard = "off";
    visibleLiveWanted = false;
    updateSwitchAria();
    stopLive();
  }

  liveToggle?.addEventListener("change", () => {
    updateSwitchAria();
    if (liveToggle.checked) {
      startLive();
      return;
    }
    visibleLiveWanted = false;
    stopLive();
  });

  frameToggle?.addEventListener("change", () => {
    frameLoopEnabled = frameToggle.checked;
    localStorage.setItem("dsc_live_frames", frameLoopEnabled ? "on" : "off");
    updateSwitchAria();
    if (!frameLoopEnabled) {
      if (captureTimer) {
        clearTimeout(captureTimer);
        captureTimer = null;
      }
      setMode("Frames paused", "paused");
      setStatus("Frame loop paused");
      return;
    }
    setStatus("Frame loop resumed");
    if (liveToggle?.checked && !document.hidden) {
      startLive();
    }
  });

  controlToggle?.addEventListener("change", () => {
    if (!controlToggle.checked) {
      cancelPointerGesture("Kontrol mouse nonaktif");
      releaseRemoteKeys("Kontrol keyboard nonaktif");
    }
    syncControlState();
    if (controlToggle.checked) {
      setStatus(pointerCanStream() ? "Kontrol pointer dan drag aktif" : "Kontrol klik kompatibel aktif", { detail: true });
    }
  });

  keyboardToggle?.addEventListener("change", () => {
    if (!keyboardToggle.checked) {
      releaseRemoteKeys("Keyboard nonaktif");
    }
    syncControlState();
    if (keyboardToggle.checked) {
      stage?.focus({ preventScroll: true });
      setStatus("Keyboard aktif", { detail: true });
    }
  });

  refreshButton?.addEventListener("click", () => {
    requestFrame({ force: true });
    refreshStatus();
  });

  function updateFullscreenState() {
    root.dataset.fullscreen = focusModeActive ? "on" : "off";
    viewer?.classList.toggle("is-focus-mode", focusModeActive);
    document.body.classList.toggle("live-focus-active", focusModeActive);
    if (fullscreenButton) {
      const label = focusModeActive ? "Exit focus view" : "Enter focus view";
      const title = focusModeActive ? "Exit focus view" : "Focus view tanpa mengunci taskbar";
      fullscreenButton.setAttribute("aria-label", label);
      fullscreenButton.setAttribute("title", title);
      fullscreenButton.querySelector("[data-button-label]")?.replaceChildren(label);
    }
  }

  function toggleFullscreen() {
    focusModeActive = !focusModeActive;
    updateFullscreenState();
    stage?.focus({ preventScroll: true });
    setStatus(focusModeActive ? "Focus view aktif" : "Focus view nonaktif");
  }

  fullscreenButton?.addEventListener("click", toggleFullscreen);
  zoomOutButton?.addEventListener("click", () => stepLiveZoom(-1));
  zoomInButton?.addEventListener("click", () => stepLiveZoom(1));
  zoomResetButton?.addEventListener("click", () => setLiveZoom(1));
  gridButton?.addEventListener("click", () => {
    const active = root.dataset.grid !== "on";
    root.dataset.grid = active ? "on" : "off";
    gridButton.setAttribute("aria-pressed", active ? "true" : "false");
    setStatus(active ? "Grid koordinat aktif" : "Grid koordinat nonaktif");
  });
  verboseButton?.addEventListener("click", () => {
    detailStatusEnabled = !detailStatusEnabled;
    localStorage.setItem("dsc_live_detail_status", detailStatusEnabled ? "on" : "off");
    updateVerboseState();
    setStatus(detailStatusEnabled ? "Detail status aktif" : "Detail status sunyi");
  });
  speedButtons.forEach((button) => {
    button.addEventListener("click", () => setLiveSpeed(button.dataset.liveSpeed || "flow"));
  });
  transportSelect?.addEventListener("change", async () => {
    try {
      if ((transportSelect.value || "poll") !== "webrtc") {
        closeWebRtcSession("transport change");
      }
      const data = await postLive("transport", { mode: transportSelect.value || "poll" });
      setTransport(data);
      if (deviceSelect?.selectedOptions[0]) {
        deviceSelect.selectedOptions[0].dataset.transportMode = transportSelect.value || "poll";
      }
      setStatus(`Metode koneksi: ${transportSelect.options[transportSelect.selectedIndex]?.text || transportSelect.value}`);
      if ((transportSelect.value || "") === "webrtc") {
        startWebRtcSession();
      }
    } catch (error) {
      setStatus(error.message);
      refreshStatus();
    }
  });
  stopButton?.addEventListener("click", panicOff);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && focusModeActive) {
      focusModeActive = false;
      updateFullscreenState();
      setStatus("Focus view nonaktif");
    }
  });

  deviceSelect?.addEventListener("change", () => {
    cancelPointerGesture("Device diganti");
    closeWebRtcSession("device change");
    latestFrameId = null;
    renderFrame(null);
    if (transportSelect) {
      transportSelect.value = deviceSelect.selectedOptions[0]?.dataset.transportMode || "poll";
    }
    if (liveToggle?.checked) {
      startLive();
    } else {
      stopLive();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      visibleLiveWanted = Boolean(liveToggle?.checked);
      stopTimers();
      setMode(visibleLiveWanted ? "Paused" : "Idle", visibleLiveWanted ? "paused" : "idle");
      return;
    }
    if (visibleLiveWanted && liveToggle?.checked) {
      startLive();
    } else {
      stopLive();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && ((event.ctrlKey && event.altKey) || !keyboardIsReady())) {
      event.preventDefault();
      event.stopPropagation();
      panicOff();
    }
  }, true);

  function renderedImageBox() {
    const rect = screen.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      throw new Error("Frame belum siap");
    }

    const naturalWidth = screen.naturalWidth || Number(screen.dataset.naturalWidth) || rect.width;
    const naturalHeight = screen.naturalHeight || Number(screen.dataset.naturalHeight) || rect.height;
    const controlWidth = Number(screen.dataset.controlWidth) || naturalWidth;
    const controlHeight = Number(screen.dataset.controlHeight) || naturalHeight;
    const naturalRatio = naturalWidth / naturalHeight;
    const rectRatio = rect.width / rect.height;
    let width = rect.width;
    let height = rect.height;
    let left = rect.left;
    let top = rect.top;

    if (rectRatio > naturalRatio) {
      width = rect.height * naturalRatio;
      left = rect.left + ((rect.width - width) / 2);
    } else {
      height = rect.width / naturalRatio;
      top = rect.top + ((rect.height - height) / 2);
    }

    return { left, top, width, height, naturalWidth, naturalHeight, controlWidth, controlHeight };
  }

  function screenPoint(event, clampOutside = false) {
    const box = renderedImageBox();
    const zoom = liveZoom || 1;
    let localX = ((event.clientX - box.left - livePanX - (box.width / 2)) / zoom) + (box.width / 2);
    let localY = ((event.clientY - box.top - livePanY - (box.height / 2)) / zoom) + (box.height / 2);

    if (!clampOutside && (localX < 0 || localY < 0 || localX > box.width || localY > box.height)) {
      throw new Error("Klik di luar area frame");
    }
    localX = Math.max(0, Math.min(box.width, localX));
    localY = Math.max(0, Math.min(box.height, localY));

    const x = Math.round((localX / box.width) * box.controlWidth);
    const y = Math.round((localY / box.height) * box.controlHeight);

    return {
      x: Math.max(0, Math.min(Math.max(0, box.controlWidth - 1), x)),
      y: Math.max(0, Math.min(Math.max(0, box.controlHeight - 1), y)),
    };
  }

  function pointerButton(event) {
    return {
      0: "left",
      1: "middle",
      2: "right",
    }[event.button] || pointerState?.button || "left";
  }

  function appendPointerEvent(type, source, button = pointerState?.button || "left") {
    const point = ["cancel", "wheel"].includes(type) ? {} : screenPoint(source, true);
    if (pointerState && Object.prototype.hasOwnProperty.call(point, "x")) {
      pointerState.lastPoint = point;
    }
    pointerEvents.push({
      type,
      button,
      sequence: ++pointerSequence,
      ...point,
    });
  }

  function stopPointerKeepalive() {
    if (pointerKeepaliveTimer) {
      clearInterval(pointerKeepaliveTimer);
      pointerKeepaliveTimer = null;
    }
  }

  function startPointerKeepalive() {
    stopPointerKeepalive();
    pointerKeepaliveTimer = window.setInterval(() => {
      if (!pointerState?.lastPoint || !pointerCanStream() || !controlIsReady()) {
        return;
      }
      pointerEvents.push({
        type: "move",
        button: pointerState.button,
        sequence: ++pointerSequence,
        ...pointerState.lastPoint,
      });
      flushPointerEvents();
    }, 1000);
  }

  function schedulePointerFlush() {
    if (pointerBatchTimer) {
      return;
    }
    pointerBatchTimer = window.setTimeout(() => {
      pointerBatchTimer = null;
      flushPointerEvents();
    }, pointerBatchMs);
  }

  function flushPointerEvents() {
    if (pointerBatchTimer) {
      clearTimeout(pointerBatchTimer);
      pointerBatchTimer = null;
    }
    if (!pointerEvents.length) {
      return;
    }

    const events = pointerEvents.splice(0, pointerMaxEvents);
    const packet = {
      device_id: pointerState?.deviceId || selectedDeviceId(),
      epoch: pointerEpoch,
      gesture_id: pointerState?.gestureId || `release-${pointerEpoch}`,
      events,
      moveOnly: events.every((event) => event.type === "move"),
    };
    const latestPacket = pointerPackets[pointerPackets.length - 1];
    if (packet.moveOnly && latestPacket?.moveOnly) {
      pointerPackets[pointerPackets.length - 1] = packet;
    } else {
      pointerPackets.push(packet);
    }
    drainPointerPackets();

    if (pointerEvents.length) {
      schedulePointerFlush();
    }
  }

  async function drainPointerPackets() {
    if (pointerSending) {
      return;
    }
    pointerSending = true;
    try {
      while (pointerPackets.length) {
        const packet = pointerPackets.shift();
        const data = await postControl("pointer", packet);
        setQueue(data);
      }
    } catch (error) {
      setStatus(error.message);
    } finally {
      pointerSending = false;
      if (pointerPackets.length) {
        drainPointerPackets();
      }
    }
  }

  function cancelPointerGesture(reason = "Kontrol pointer dihentikan") {
    stopPointerKeepalive();
    if (!pointerState && !pointerEvents.length) {
      return;
    }
    pointerEvents = [];
    pointerPackets = pointerPackets.filter((packet) => !packet.moveOnly);
    appendPointerEvent("cancel", null, pointerState?.button || "left");
    flushPointerEvents();
    pointerState = null;
    pointerEpoch = Date.now();
    pointerSequence = 0;
    setStatus(reason, { detail: true });
  }

  function clickName(button, double) {
    if (double) {
      return "Double-click";
    }
    if (button === "right") {
      return "Right-click";
    }
    if (button === "middle") {
      return "Middle-click";
    }
    return "Klik";
  }

  async function sendRemoteClick({ x, y, button = "left", double = false }) {
    if (clickInFlight) {
      return;
    }

    clickInFlight = true;
    try {
      await postControl("click", { x, y, button, double });
      setQueue({ pending_capture: false, pending_click: true });
      setStatus(`${clickName(button, double)} dikirim: ${x}, ${y}`, { detail: true });
      window.setTimeout(requestFrame, 450);
    } catch (error) {
      setStatus(error.message);
    } finally {
      clickInFlight = false;
    }
  }

  const keyNameMap = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    Backspace: "backspace",
    Delete: "delete",
    Enter: "enter",
    Tab: "tab",
    Home: "home",
    End: "end",
    PageUp: "pageup",
    PageDown: "pagedown",
    Insert: "insert",
    CapsLock: "capslock",
    PrintScreen: "printscreen",
    ContextMenu: "menu",
    Escape: "escape",
    Control: "control",
    Alt: "alt",
    Shift: "shift",
    Meta: "command",
    AudioVolumeMute: "audio_mute",
    AudioVolumeDown: "audio_vol_down",
    AudioVolumeUp: "audio_vol_up",
    MediaPlayPause: "audio_play",
    MediaStop: "audio_stop",
    MediaTrackPrevious: "audio_prev",
    MediaTrackNext: "audio_next",
  };
  const codeNameMap = {
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    NumpadAdd: "numpad_+",
    NumpadSubtract: "numpad_-",
    NumpadMultiply: "numpad_*",
    NumpadDivide: "numpad_/",
    NumpadDecimal: "numpad_.",
    NumLock: "numpad_lock",
  };

  function keyboardModifiers(event) {
    const modifiers = [];
    if (event.ctrlKey) {
      modifiers.push("control");
    }
    if (event.altKey) {
      modifiers.push("alt");
    }
    if (event.shiftKey) {
      modifiers.push("shift");
    }
    return modifiers;
  }

  function keyboardPayload(event) {
    if (event.metaKey || event.key === "Dead" || event.key === "Unidentified") {
      return null;
    }

    const modifiers = keyboardModifiers(event);
    const hasCommandModifier = event.ctrlKey || event.altKey || event.metaKey;

    if (event.key.length === 1 && !hasCommandModifier) {
      return { kind: "text", text: event.key };
    }

    if (event.key === " ") {
      return {
        kind: "key",
        key: "space",
        modifiers,
      };
    }

    if (event.key.length === 1) {
      return {
        kind: "key",
        key: event.key.toLowerCase(),
        modifiers,
      };
    }

    const functionMatch = /^F([1-9]|1[0-9]|2[0-4])$/.exec(event.key);
    const mappedKey = functionMatch ? event.key.toLowerCase() : keyNameMap[event.key];
    if (!mappedKey) {
      return null;
    }

    return {
      kind: "key",
      key: mappedKey,
      modifiers,
    };
  }

  function keyboardStateKey(event) {
    if (event.key === "Dead" || event.key === "Unidentified") {
      return null;
    }
    if (keyNameMap[event.key]) {
      return keyNameMap[event.key];
    }
    if (/^Key[A-Z]$/.test(event.code)) {
      return event.code.slice(-1).toLowerCase();
    }
    if (/^Digit[0-9]$/.test(event.code)) {
      return event.code.slice(-1);
    }
    if (/^Numpad[0-9]$/.test(event.code)) {
      return `numpad_${event.code.slice(-1)}`;
    }
    if (codeNameMap[event.code]) {
      return codeNameMap[event.code];
    }
    const functionMatch = /^F([1-9]|1[0-9]|2[0-4])$/.exec(event.key);
    if (functionMatch) {
      return event.key.toLowerCase();
    }
    if (event.key === " ") {
      return "space";
    }
    if (event.key.length === 1 && /^[a-z0-9,./;'[\]\\\-=`]$/i.test(event.key)) {
      return event.key.toLowerCase();
    }
    return null;
  }

  function sendRemoteKey(payload) {
    keyChain = keyChain
      .then(async () => {
        const data = await postControl("key", payload);
        setQueue(data);
        setStatus(payload.kind === "text" ? "Keyboard text dikirim" : `Keyboard ${payload.key} dikirim`, { detail: true });
      })
      .catch((error) => {
        setStatus(error.message);
      });
  }

  function sendRemoteKeyState(key, state) {
    if (!key) {
      return;
    }
    if (state === "down") {
      if (remoteKeysDown.has(key)) {
        return;
      }
      remoteKeysDown.add(key);
    } else {
      if (!remoteKeysDown.has(key)) {
        return;
      }
      remoteKeysDown.delete(key);
    }
    sendRemoteKey({ kind: "state", key, state });
  }

  function releaseRemoteKeys(reason = "") {
    if (!remoteKeysDown.size) {
      return;
    }
    [...remoteKeysDown].reverse().forEach((key) => sendRemoteKeyState(key, "up"));
    if (reason) {
      setStatus(reason, { detail: true });
    }
  }

  function shouldPanStage(event) {
    return liveZoom > 1 && (!controlIsReady() || event.altKey || event.button === 1);
  }

  stage?.addEventListener("pointerdown", (event) => {
    if (!shouldPanStage(event) || panState) {
      return;
    }
    event.preventDefault();
    stage.focus({ preventScroll: true });
    panState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: livePanX,
      panY: livePanY,
    };
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {}
    setStatus("Pan zoom aktif", { detail: true });
  });

  stage?.addEventListener("pointerdown", (event) => {
    if (panState || shouldPanStage(event)) {
      return;
    }
    if (!pointerCanStream() || !controlIsReady() || pointerState) {
      return;
    }
    if (![0, 1, 2].includes(event.button)) {
      return;
    }

    event.preventDefault();
    stage.focus({ preventScroll: true });
    const button = pointerButton(event);
    pointerState = {
      pointerId: event.pointerId,
      button,
      deviceId: selectedDeviceId(),
      gestureId: `gesture-${pointerEpoch}-${++pointerGestureNumber}`,
    };
    try {
      stage.setPointerCapture(event.pointerId);
      appendPointerEvent("down", event, button);
      startPointerKeepalive();
      flushPointerEvents();
      setStatus(`Pointer ${button} aktif`, { detail: true });
    } catch (error) {
      cancelPointerGesture(error.message);
    }
  });

  stage?.addEventListener("pointermove", (event) => {
    if (panState && event.pointerId === panState.pointerId) {
      event.preventDefault();
      livePanX = panState.panX + (event.clientX - panState.startX);
      livePanY = panState.panY + (event.clientY - panState.startY);
      updateZoomState();
      return;
    }
    if (!pointerCanStream() || !controlIsReady()) {
      return;
    }
    if (pointerState && event.pointerId !== pointerState.pointerId) {
      return;
    }

    event.preventDefault();
    try {
      const samples = typeof event.getCoalescedEvents === "function"
        ? event.getCoalescedEvents()
        : [event];
      const usableSamples = samples.length ? samples.slice(-16) : [event];
      usableSamples.forEach((sample) => appendPointerEvent("move", sample, pointerState?.button || "left"));
      if (pointerEvents.length >= Math.max(4, pointerMaxEvents - 16)) {
        flushPointerEvents();
      } else {
        schedulePointerFlush();
      }
    } catch (error) {
      cancelPointerGesture(error.message);
    }
  });

  function finishPointerGesture(event, type = "up") {
    if (!pointerCanStream() || !pointerState || event.pointerId !== pointerState.pointerId) {
      return;
    }

    event.preventDefault();
    try {
      appendPointerEvent(type, event, pointerState.button);
      stopPointerKeepalive();
      flushPointerEvents();
      pointerState = null;
      if (stage.hasPointerCapture(event.pointerId)) {
        stage.releasePointerCapture(event.pointerId);
      }
      setStatus(type === "up" ? "Pointer selesai" : "Pointer dibatalkan", { detail: true });
      window.setTimeout(requestFrame, 180);
    } catch (error) {
      cancelPointerGesture(error.message);
    }
  }

  stage?.addEventListener("pointerup", (event) => finishPointerGesture(event, "up"));
  stage?.addEventListener("pointerup", (event) => {
    if (panState && event.pointerId === panState.pointerId) {
      event.preventDefault();
      panState = null;
      if (stage.hasPointerCapture(event.pointerId)) {
        stage.releasePointerCapture(event.pointerId);
      }
      setStatus("Pan zoom selesai", { detail: true });
    }
  });
  stage?.addEventListener("pointercancel", (event) => finishPointerGesture(event, "cancel"));
  stage?.addEventListener("pointercancel", (event) => {
    if (panState && event.pointerId === panState.pointerId) {
      panState = null;
      setStatus("Pan zoom dibatalkan", { detail: true });
    }
  });
  stage?.addEventListener("lostpointercapture", (event) => {
    if (panState && event.pointerId === panState.pointerId) {
      panState = null;
      setStatus("Pan zoom terputus", { detail: true });
    }
    if (pointerState && event.pointerId === pointerState.pointerId) {
      cancelPointerGesture("Pointer capture terputus");
    }
  });

  stage?.addEventListener("click", (event) => {
    if (pointerCanStream() || !controlIsReady()) {
      return;
    }

    event.preventDefault();
    stage.focus({ preventScroll: true });
    try {
      const point = screenPoint(event);
      if (singleClickTimer) {
        clearTimeout(singleClickTimer);
      }
      singleClickTimer = window.setTimeout(() => {
        singleClickTimer = null;
        sendRemoteClick({ ...point, button: "left" });
      }, 180);
    } catch (error) {
      setStatus(error.message);
    }
  });

  stage?.addEventListener("dblclick", (event) => {
    if (pointerCanStream() || !controlIsReady()) {
      return;
    }

    event.preventDefault();
    stage.focus({ preventScroll: true });
    if (singleClickTimer) {
      clearTimeout(singleClickTimer);
      singleClickTimer = null;
    }
    try {
      sendRemoteClick({ ...screenPoint(event), button: "left", double: true });
    } catch (error) {
      setStatus(error.message);
    }
  });

  stage?.addEventListener("contextmenu", (event) => {
    if (!controlIsReady()) {
      return;
    }

    event.preventDefault();
    if (pointerCanStream()) {
      return;
    }
    stage.focus({ preventScroll: true });
    if (singleClickTimer) {
      clearTimeout(singleClickTimer);
      singleClickTimer = null;
    }
    try {
      sendRemoteClick({ ...screenPoint(event), button: "right" });
    } catch (error) {
      setStatus(error.message);
    }
  });

  stage?.addEventListener("wheel", (event) => {
    if (liveZoom > 1 && (!controlIsReady() || event.altKey)) {
      event.preventDefault();
      panLiveView(-event.deltaX, -event.deltaY);
      return;
    }
    if (!controlIsReady() || !wheelInputAvailable) {
      return;
    }
    event.preventDefault();
    const normalizeWheel = (value, axis) => {
      if (!value) {
        return 0;
      }
      const lineDelta = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? -value
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? -value * wheelPageLines
          : -value / wheelPixelPerLine;
      const accumulated = lineDelta + (axis === "x" ? wheelRemainderX : wheelRemainderY);
      const normalized = Math.max(-wheelMaxLines, Math.min(wheelMaxLines, Math.trunc(accumulated)));
      const remainder = normalized === Math.trunc(accumulated) ? accumulated - normalized : 0;
      if (axis === "x") {
        wheelRemainderX = remainder;
      } else {
        wheelRemainderY = remainder;
      }
      return normalized;
    };
    const deltaX = normalizeWheel(event.deltaX, "x");
    const deltaY = normalizeWheel(event.deltaY, "y");
    if (!deltaX && !deltaY) {
      return;
    }
    pointerEvents.push({
      type: "wheel",
      button: "middle",
      sequence: ++pointerSequence,
      deltaX,
      deltaY,
    });
    schedulePointerFlush();
  }, { passive: false });

  stage?.addEventListener("keydown", (event) => {
    if (liveZoom > 1 && (!keyboardIsReady() || event.altKey)) {
      const step = event.shiftKey ? 90 : 36;
      const panKeys = {
        ArrowLeft: [step, 0],
        ArrowRight: [-step, 0],
        ArrowUp: [0, step],
        ArrowDown: [0, -step],
      };
      const delta = panKeys[event.key];
      if (delta) {
        event.preventDefault();
        panLiveView(delta[0], delta[1]);
        return;
      }
    }
    if (!keyboardIsReady()) {
      return;
    }

    if (keyboardStateAvailable) {
      const key = keyboardStateKey(event);
      if (!key) {
        return;
      }
      event.preventDefault();
      sendRemoteKeyState(key, "down");
      return;
    }

    const payload = keyboardPayload(event);
    if (!payload) {
      return;
    }

    event.preventDefault();
    sendRemoteKey(payload);
  });

  stage?.addEventListener("keyup", (event) => {
    if (!keyboardIsReady() || !keyboardStateAvailable) {
      return;
    }
    const key = keyboardStateKey(event);
    if (!key) {
      return;
    }
    event.preventDefault();
    sendRemoteKeyState(key, "up");
  });

  window.addEventListener("blur", () => {
    cancelPointerGesture("Fokus browser berpindah");
    releaseRemoteKeys("Fokus browser berpindah");
  });

  window.addEventListener("beforeunload", () => {
    cancelPointerGesture();
    releaseRemoteKeys();
    closeWebRtcSession("page unload");
    stopPointerKeepalive();
    stopTimers();
  });

  controlToggle.disabled = true;
  if (keyboardToggle) {
    keyboardToggle.disabled = true;
  }
  root.dataset.control = "off";
  root.dataset.keyboard = "off";
  root.dataset.fullscreen = "off";
  root.dataset.grid = "off";
  if (transportSelect) {
    transportSelect.value = deviceSelect?.selectedOptions[0]?.dataset.transportMode || "poll";
  }
  updateSwitchAria();
  updateSpeedButtons();
  updateVerboseState();
  updateZoomState();
  updateFullscreenState();
  stopLive();
})();
