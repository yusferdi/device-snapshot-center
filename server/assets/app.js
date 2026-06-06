(() => {
  const root = document.querySelector("[data-live-dashboard]");
  if (!root) {
    return;
  }

  const apiUrl = root.dataset.liveApi;
  const csrfToken = root.dataset.csrfToken;
  const defaultCaptureIntervalMs = Math.max(800, Number(root.dataset.captureInterval || 1800));
  const defaultStatusIntervalMs = Math.max(500, Number(root.dataset.statusInterval || 900));
  const idleStatusIntervalMs = Math.max(2000, Number(root.dataset.idleStatusInterval || 5000));
  const defaultPointerBatchMs = Math.max(24, Number(root.dataset.pointerBatch || 48));
  const pointerMaxEvents = Math.max(4, Number(root.dataset.pointerMaxEvents || 64));
  const wheelPixelPerLine = Math.max(8, Number(root.dataset.wheelPixelPerLine || 32));
  const wheelPageLines = Math.max(3, Number(root.dataset.wheelPageLines || 12));
  const wheelMaxLines = Math.max(3, Number(root.dataset.wheelMaxLines || 60));
  const speedProfiles = {
    eco: {
      capture: Math.max(3500, defaultCaptureIntervalMs + 2000),
      status: Math.max(1800, defaultStatusIntervalMs + 1000),
      pointer: Math.max(96, defaultPointerBatchMs * 2),
    },
    flow: {
      capture: defaultCaptureIntervalMs,
      status: defaultStatusIntervalMs,
      pointer: defaultPointerBatchMs,
    },
    burst: {
      capture: Math.max(350, Math.min(650, Math.round(defaultCaptureIntervalMs / 3))),
      status: Math.max(350, Math.min(500, Math.round(defaultStatusIntervalMs / 2))),
      pointer: 24,
    },
  };

  const deviceSelect = root.querySelector("[data-live-device]");
  const transportSelect = root.querySelector("[data-live-transport-select]");
  const liveToggle = root.querySelector("[data-live-toggle]");
  const controlToggle = root.querySelector("[data-control-toggle]");
  const keyboardToggle = root.querySelector("[data-keyboard-toggle]");
  const refreshButton = root.querySelector("[data-live-refresh]");
  const fullscreenButton = root.querySelector("[data-live-fullscreen]");
  const gridButton = root.querySelector("[data-live-grid]");
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
  const remoteKeysDown = new Set();
  const pointerEventsSupported = "PointerEvent" in window;

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

  function setStatus(text) {
    status.textContent = text;
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
    const selectedLabel = selected === "http-long-poll" ? "Long poll" : "Polling";
    const transportLabel = requested === "auto" ? `Auto · ${selectedLabel}` : selectedLabel;
    const latencyLabel = Number.isFinite(liveRttMs) ? ` · ${Math.round(liveRttMs)}ms` : "";
    transport.textContent = `${transportLabel}${latencyLabel}`;
    transport.dataset.state = requested === "long-poll" && selected !== "http-long-poll" ? "pending" : "ready";
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
    controlToggle?.setAttribute("aria-checked", controlToggle.checked ? "true" : "false");
    controlToggle?.setAttribute("aria-disabled", controlToggle.disabled ? "true" : "false");
    keyboardToggle?.setAttribute("aria-checked", keyboardToggle.checked ? "true" : "false");
    keyboardToggle?.setAttribute("aria-disabled", keyboardToggle.disabled ? "true" : "false");
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
      const ageSeconds = Number(data.device?.last_seen_age_seconds);
      const agentVersion = data.device?.agent_version ? ` · v${data.device.agent_version}` : "";
      if (data.device?.online) {
        root.dataset.agentState = "online";
        setStatus(`Agent connected${agentVersion} · ${Number.isFinite(ageSeconds) ? `${Math.round(ageSeconds)}s ago` : "active"}`);
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

  async function requestFrame() {
    if (captureInFlight || document.hidden) {
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
    if (generation === liveLoopGeneration && liveToggle?.checked && !document.hidden) {
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
    setMode("Live", "live");
    const generation = liveLoopGeneration;
    runCaptureLoop(generation);
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

  controlToggle?.addEventListener("change", () => {
    if (!controlToggle.checked) {
      cancelPointerGesture("Kontrol mouse nonaktif");
      releaseRemoteKeys("Kontrol keyboard nonaktif");
    }
    syncControlState();
    if (controlToggle.checked) {
      setStatus(pointerCanStream() ? "Kontrol pointer dan drag aktif" : "Kontrol klik kompatibel aktif");
    }
  });

  keyboardToggle?.addEventListener("change", () => {
    if (!keyboardToggle.checked) {
      releaseRemoteKeys("Keyboard nonaktif");
    }
    syncControlState();
    if (keyboardToggle.checked) {
      stage?.focus({ preventScroll: true });
      setStatus("Keyboard aktif");
    }
  });

  refreshButton?.addEventListener("click", () => {
    requestFrame();
    refreshStatus();
  });

  function updateFullscreenState() {
    const active = document.fullscreenElement === viewer;
    root.dataset.fullscreen = active ? "on" : "off";
    if (fullscreenButton) {
      const label = active ? "Exit fullscreen" : "Enter fullscreen";
      fullscreenButton.setAttribute("aria-label", label);
      fullscreenButton.setAttribute("title", label);
      fullscreenButton.querySelector("[data-button-label]")?.replaceChildren(label);
    }
  }

  async function toggleFullscreen() {
    if (!document.fullscreenEnabled) {
      setStatus("Fullscreen tidak didukung browser");
      return;
    }

    try {
      if (document.fullscreenElement === viewer) {
        await document.exitFullscreen();
      } else {
        await viewer.requestFullscreen();
        stage?.focus({ preventScroll: true });
      }
      updateFullscreenState();
    } catch (error) {
      setStatus(error.message || "Fullscreen gagal");
    }
  }

  fullscreenButton?.addEventListener("click", toggleFullscreen);
  gridButton?.addEventListener("click", () => {
    const active = root.dataset.grid !== "on";
    root.dataset.grid = active ? "on" : "off";
    gridButton.setAttribute("aria-pressed", active ? "true" : "false");
  });
  speedButtons.forEach((button) => {
    button.addEventListener("click", () => setLiveSpeed(button.dataset.liveSpeed || "flow"));
  });
  transportSelect?.addEventListener("change", async () => {
    try {
      const data = await postLive("transport", { mode: transportSelect.value || "poll" });
      setTransport(data);
      if (deviceSelect?.selectedOptions[0]) {
        deviceSelect.selectedOptions[0].dataset.transportMode = transportSelect.value || "poll";
      }
      setStatus(`Metode koneksi: ${transportSelect.options[transportSelect.selectedIndex]?.text || transportSelect.value}`);
    } catch (error) {
      setStatus(error.message);
      refreshStatus();
    }
  });
  stopButton?.addEventListener("click", panicOff);
  document.addEventListener("fullscreenchange", updateFullscreenState);

  deviceSelect?.addEventListener("change", () => {
    cancelPointerGesture("Device diganti");
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
    let localX = event.clientX - box.left;
    let localY = event.clientY - box.top;

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
        const data = await postLive("pointer", packet);
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
    setStatus(reason);
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
      await postLive("click", { x, y, button, double });
      setQueue({ pending_capture: false, pending_click: true });
      setStatus(`${clickName(button, double)} dikirim: ${x}, ${y}`);
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
        const data = await postLive("key", payload);
        setQueue(data);
        setStatus(payload.kind === "text" ? "Keyboard text dikirim" : `Keyboard ${payload.key} dikirim`);
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
      setStatus(reason);
    }
  }

  stage?.addEventListener("pointerdown", (event) => {
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
      setStatus(`Pointer ${button} aktif`);
    } catch (error) {
      cancelPointerGesture(error.message);
    }
  });

  stage?.addEventListener("pointermove", (event) => {
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
      setStatus(type === "up" ? "Pointer selesai" : "Pointer dibatalkan");
      window.setTimeout(requestFrame, 180);
    } catch (error) {
      cancelPointerGesture(error.message);
    }
  }

  stage?.addEventListener("pointerup", (event) => finishPointerGesture(event, "up"));
  stage?.addEventListener("pointercancel", (event) => finishPointerGesture(event, "cancel"));
  stage?.addEventListener("lostpointercapture", (event) => {
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
  updateFullscreenState();
  stopLive();
})();
