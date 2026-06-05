(() => {
  const root = document.querySelector("[data-live-dashboard]");
  if (!root) {
    return;
  }

  const apiUrl = root.dataset.liveApi;
  const csrfToken = root.dataset.csrfToken;
  const defaultCaptureIntervalMs = Math.max(800, Number(root.dataset.captureInterval || 1800));
  const statusIntervalMs = Math.max(500, Number(root.dataset.statusInterval || 900));
  const pointerBatchMs = Math.max(24, Number(root.dataset.pointerBatch || 48));
  const pointerMaxEvents = Math.max(4, Number(root.dataset.pointerMaxEvents || 64));
  const speedIntervals = {
    eco: Math.max(1600, defaultCaptureIntervalMs + 800),
    flow: defaultCaptureIntervalMs,
    burst: Math.max(800, defaultCaptureIntervalMs - 700),
  };

  const deviceSelect = root.querySelector("[data-live-device]");
  const liveToggle = root.querySelector("[data-live-toggle]");
  const controlToggle = root.querySelector("[data-control-toggle]");
  const keyboardToggle = root.querySelector("[data-keyboard-toggle]");
  const refreshButton = root.querySelector("[data-live-refresh]");
  const fullscreenButton = root.querySelector("[data-live-fullscreen]");
  const gridButton = root.querySelector("[data-live-grid]");
  const speedButtons = Array.from(root.querySelectorAll("[data-live-speed]"));
  const stopButton = root.querySelector("[data-live-stop]");
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
  let latestFrameId = null;
  let statusInFlight = false;
  let captureInFlight = false;
  let clickInFlight = false;
  let singleClickTimer = null;
  let keyChain = Promise.resolve();
  let activeSpeed = "flow";
  let captureIntervalMs = speedIntervals.flow;
  let visibleLiveWanted = false;
  let pointerBatchTimer = null;
  let pointerEvents = [];
  let pointerPackets = [];
  let pointerSending = false;
  let pointerState = null;
  let pointerSequence = 0;
  let pointerEpoch = Date.now();
  let pointerGestureNumber = 0;
  let pointerInputAvailable = false;
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
    queue.textContent = parts.length ? `Queue ${parts.join(", ")}` : "Queue clear";
    queue.dataset.state = parts.length ? "pending" : "clear";
  }

  function setTransport(data) {
    if (!transport || !data?.transport) {
      return;
    }
    const selected = String(data.transport.primary || "http-poll");
    transport.textContent = selected === "http-long-poll" ? "Adaptive HTTP" : "HTTP polling";
    transport.dataset.state = selected === "http-long-poll" ? "ready" : "pending";
  }

  function setCapabilities(data) {
    pointerInputAvailable = Boolean(data?.capabilities?.pointer_input);
    root.dataset.pointerInput = pointerInputAvailable ? "stream" : "click";
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

    freshness.textContent = `Frame #${frame.id}`;
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
    if (!Object.prototype.hasOwnProperty.call(speedIntervals, speed)) {
      return;
    }

    activeSpeed = speed;
    captureIntervalMs = speedIntervals[speed];
    updateSpeedButtons();
    setStatus(`Mode ${speed}`);

    if (liveToggle?.checked && !document.hidden) {
      startLive();
    }
  }

  async function postLive(action, payload = {}) {
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
      const lastSeen = data.device?.last_seen ? `Last seen ${data.device.last_seen}` : "Device belum terlihat";
      setStatus(lastSeen);
    } catch (error) {
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
      const data = await postLive("capture");
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
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
    if (captureTimer) {
      clearInterval(captureTimer);
      captureTimer = null;
    }
  }

  function stopLive() {
    stopTimers();
    setMode("Idle", "idle");
    setStatus("Idle");
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
    requestFrame();
    refreshStatus();
    captureTimer = setInterval(requestFrame, captureIntervalMs);
    statusTimer = setInterval(refreshStatus, statusIntervalMs);
  }

  function panicOff() {
    if (singleClickTimer) {
      clearTimeout(singleClickTimer);
      singleClickTimer = null;
    }
    cancelPointerGesture("Kontrol dihentikan");
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
    syncControlState();
    if (controlToggle.checked) {
      setStatus(pointerCanStream() ? "Kontrol pointer dan drag aktif" : "Kontrol klik kompatibel aktif");
    }
  });

  keyboardToggle?.addEventListener("change", () => {
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
    const active = document.fullscreenElement === root;
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
      if (document.fullscreenElement === root) {
        await document.exitFullscreen();
      } else {
        await root.requestFullscreen();
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
  stopButton?.addEventListener("click", panicOff);
  document.addEventListener("fullscreenchange", updateFullscreenState);

  deviceSelect?.addEventListener("change", () => {
    cancelPointerGesture("Device diganti");
    latestFrameId = null;
    renderFrame(null);
    if (liveToggle?.checked) {
      startLive();
    } else {
      refreshStatus();
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
      refreshStatus();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      panicOff();
    }
  });

  function renderedImageBox() {
    const rect = screen.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      throw new Error("Frame belum siap");
    }

    const naturalWidth = screen.naturalWidth || Number(screen.dataset.naturalWidth) || rect.width;
    const naturalHeight = screen.naturalHeight || Number(screen.dataset.naturalHeight) || rect.height;
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

    return { left, top, width, height, naturalWidth, naturalHeight };
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

    const x = Math.round((localX / box.width) * box.naturalWidth);
    const y = Math.round((localY / box.height) * box.naturalHeight);

    return {
      x: Math.max(0, Math.min(Math.max(0, box.naturalWidth - 1), x)),
      y: Math.max(0, Math.min(Math.max(0, box.naturalHeight - 1), y)),
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
    const point = type === "cancel" ? {} : screenPoint(source, true);
    pointerEvents.push({
      type,
      button,
      sequence: ++pointerSequence,
      ...point,
    });
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
    if (event.repeat || event.metaKey || event.key === "Escape" || event.key === "Dead" || event.key === "Unidentified") {
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
      flushPointerEvents();
      setStatus(`Pointer ${button} aktif`);
    } catch (error) {
      cancelPointerGesture(error.message);
    }
  });

  stage?.addEventListener("pointermove", (event) => {
    if (!pointerCanStream() || !pointerState || event.pointerId !== pointerState.pointerId) {
      return;
    }

    event.preventDefault();
    try {
      const samples = typeof event.getCoalescedEvents === "function"
        ? event.getCoalescedEvents()
        : [event];
      const usableSamples = samples.length ? samples.slice(-16) : [event];
      usableSamples.forEach((sample) => appendPointerEvent("move", sample, pointerState.button));
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
      flushPointerEvents();
      if (stage.hasPointerCapture(event.pointerId)) {
        stage.releasePointerCapture(event.pointerId);
      }
      pointerState = null;
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

  stage?.addEventListener("keydown", (event) => {
    if (!keyboardIsReady()) {
      return;
    }

    const payload = keyboardPayload(event);
    if (!payload) {
      return;
    }

    event.preventDefault();
    sendRemoteKey(payload);
  });

  window.addEventListener("beforeunload", () => {
    cancelPointerGesture();
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
  updateSwitchAria();
  updateSpeedButtons();
  updateFullscreenState();
  setMode("Idle", "idle");
  refreshStatus();
})();
