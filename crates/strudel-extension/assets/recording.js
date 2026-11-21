const HOST_SESSION = "chan:extension-session-context:v1";
const HOST_MICROPHONE_REQUEST = "chan:extension-microphone-request:v1";
const HOST_MICROPHONE_EVENT = "chan:extension-microphone-event:v1";
const MAX_RECORDING_BYTES = 64 * 1024 * 1024;
const MAX_RECORDING_SECONDS = 10 * 60;

function requestId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function elapsed(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function createRecording(host) {
  const element = (id) => document.getElementById(id);
  const dialog = element("recording-dialog");
  const toggle = element("recording-toggle");
  const open = element("recording-open");
  const close = element("recording-close");
  const status = element("recording-status");
  const result = element("recording-result");
  const example = element("recording-example");
  let windowId = null;
  let activeId = null;
  let phase = "idle";
  let startedAt = 0;
  let timer = null;

  function send(action) {
    if (!activeId) return;
    host.postMessage(
      {
        type: HOST_MICROPHONE_REQUEST,
        request_id: activeId,
        action,
      },
      "*",
    );
  }

  function clearTimer() {
    clearInterval(timer);
    timer = null;
  }

  function render() {
    toggle.disabled = ["requesting", "saving"].includes(phase);
    toggle.textContent = phase === "recording" ? "stop & save" : "record from microphone";
    close.textContent = ["requesting", "recording"].includes(phase) ? "cancel" : "close";
    open.disabled = !windowId;
    if (phase === "recording") {
      const seconds = Math.min(
        MAX_RECORDING_SECONDS,
        Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      );
      status.textContent = `Recording ${elapsed(seconds)} / ${elapsed(MAX_RECORDING_SECONDS)}. Stop when you are ready to save.`;
    }
  }

  function resetResult() {
    result.hidden = true;
    result.textContent = "";
    example.hidden = true;
    example.textContent = "";
  }

  function begin() {
    clearTimer();
    resetResult();
    activeId = requestId();
    phase = "requesting";
    status.textContent = "Requesting microphone access. Choose Allow when your browser asks.";
    render();
    send("start");
  }

  function cancel() {
    if (["requesting", "recording"].includes(phase)) send("cancel");
    clearTimer();
    activeId = null;
    phase = "idle";
  }

  function closeDialog() {
    cancel();
    dialog.close();
  }

  async function save(audio, limited) {
    phase = "saving";
    status.textContent = limited ? "Recording limit reached. Saving..." : "Saving recording...";
    render();
    try {
      const response = await fetch("recording", {
        method: "POST",
        headers: { "content-type": audio.type },
        body: audio,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const saved = await response.json();
      phase = "saved";
      status.textContent = "Recording saved.";
      result.textContent = `${saved.path} (${Math.round(saved.bytes / 1024)} KiB)`;
      result.hidden = false;
      example.textContent = `samples({take: '${saved.url}'})\ns("take")`;
      example.hidden = false;
    } catch (error) {
      phase = "error";
      status.textContent = `Could not save the recording: ${error.message}`;
    }
    activeId = null;
    render();
  }

  async function openDirectory() {
    if (!windowId) return;
    open.disabled = true;
    try {
      const response = await fetch("recordings/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ window_id: windowId }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
    } catch (error) {
      status.textContent = `Could not open the file browser: ${error.message}`;
    } finally {
      open.disabled = !windowId;
    }
  }

  toggle.addEventListener("click", () => {
    if (phase === "recording") {
      phase = "saving";
      status.textContent = "Finishing the recording...";
      send("stop");
      render();
    } else if (!["requesting", "saving"].includes(phase)) {
      begin();
    }
  });
  close.addEventListener("click", closeDialog);
  open.addEventListener("click", openDirectory);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });

  return {
    show() {
      if (phase !== "saving") {
        phase = "idle";
        status.textContent = "Your browser will ask for microphone permission. Choose Allow to start recording.";
      }
      render();
      dialog.showModal();
      toggle.focus();
    },
    cancel,
    handle(message) {
      if (!message || typeof message !== "object") return;
      if (message.type === HOST_SESSION && typeof message.self_id === "string") {
        windowId = message.self_id;
        render();
        return;
      }
      if (message.type !== HOST_MICROPHONE_EVENT || message.request_id !== activeId) return;
      if (message.state === "recording") {
        phase = "recording";
        startedAt = Date.now();
        clearTimer();
        timer = setInterval(render, 1000);
        render();
      } else if (message.state === "error") {
        clearTimer();
        activeId = null;
        phase = "error";
        status.textContent = `Recording failed: ${message.message || "unknown error"}`;
        render();
      } else if (message.state === "complete" && message.audio instanceof Blob) {
        clearTimer();
        if (message.audio.size === 0 || message.audio.size > MAX_RECORDING_BYTES) {
          activeId = null;
          phase = "error";
          status.textContent = "Recording failed: the audio is empty or exceeds 64 MiB.";
          render();
          return;
        }
        save(message.audio, message.limited === true).catch((error) => {
          phase = "error";
          status.textContent = error.message;
          render();
        });
      }
    },
  };
}
