const CAPTURE_SOURCES = "chan:extension-capture-sources:v1";
const CAPTURE_REQUEST = "chan:extension-capture-request:v1";
const CAPTURE_EVENT = "chan:extension-capture-event:v1";

function requestId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const SOURCE_REASONS = {
  not_granted: "Microphone is not granted for this extension.",
  insecure_context: "Microphone requires a secure context.",
  unsupported: "Microphone recording is not supported in this browser.",
};

export function createRecording(host) {
  const element = (id) => document.getElementById(id);
  const dialog = element("recording-dialog");
  const toggle = element("recording-toggle");
  const stopButton = element("recording-stop");
  const cancelButton = element("recording-cancel");
  const close = element("recording-close");
  const status = element("recording-status");
  const takesList = element("recording-takes");

  let source = null;
  let activeRequestId = null;
  let hostState = "idle";
  let hostError = "";
  const takes = new Map();

  function send(message) {
    host.postMessage({ type: CAPTURE_REQUEST, ...message }, "*");
  }

  function ack(takeId) {
    send({ action: "ack", take_id: takeId });
  }

  function sourceReason() {
    if (source === null) return "Microphone unavailable: this Chan does not report capture sources. Update Chan to record.";
    if (source === "available") return "";
    return SOURCE_REASONS[source] || `Microphone unavailable: ${source}.`;
  }

  function hostStateText() {
    if (hostState === "armed") return "Waiting for you to start recording in Chan.";
    if (hostState === "starting") return "Starting recording in Chan.";
    if (hostState === "recording") return "Recording in Chan. Use Stop in Chan or here to finish.";
    if (hostState === "finishing") return "Finishing the recording in Chan.";
    if (hostState === "error") return hostError ? `Recording failed: ${hostError}` : "Recording failed.";
    if (hostState === "cancelled") return "Recording cancelled.";
    return "";
  }

  function render() {
    const reason = sourceReason();
    const stateText = hostStateText();
    if (toggle) {
      toggle.disabled = source !== "available" || activeRequestId !== null;
      toggle.textContent = "record from microphone";
    }
    if (stopButton) stopButton.disabled = !(activeRequestId && ["armed", "starting", "recording", "finishing"].includes(hostState));
    if (cancelButton) cancelButton.disabled = !activeRequestId;
    if (status) {
      const waiting = [...takes.values()].filter((take) => take.status === "pending" || take.status === "failed").length;
      if (reason) status.textContent = reason;
      else if (stateText) status.textContent = stateText;
      else if (waiting) status.textContent = `${waiting} recording${waiting === 1 ? "" : "s"} waiting to save.`;
      else status.textContent = "Ready to record. Chan will ask you to start the take.";
    }
    if (takesList) renderTakes();
  }

  function renderTakes() {
    takesList.replaceChildren();
    for (const take of takes.values()) {
      const row = document.createElement("div");
      row.className = "recording-take";
      row.dataset.takeId = take.take_id;
      const label = document.createElement("p");
      if (take.status === "saved" && take.saved) {
        label.textContent = `${take.saved.path} (${Math.round(take.saved.bytes / 1024)} KiB)`;
      } else if (take.status === "uploading") {
        label.textContent = `Take ${take.take_id.slice(0, 8)}: saving...`;
      } else if (take.status === "failed") {
        label.textContent = `Take ${take.take_id.slice(0, 8)}: could not save${take.error ? `: ${take.error}` : ""}.`;
      } else {
        label.textContent = `Take ${take.take_id.slice(0, 8)}: ready to save.`;
      }
      row.append(label);
      if (take.status === "saved" && take.saved) {
        const example = document.createElement("pre");
        example.textContent = `samples({take: '${take.saved.url}'})\ns("take")`;
        row.append(example);
      }
      const actions = document.createElement("div");
      actions.className = "row";
      if (take.status === "pending" || take.status === "failed") {
        const save = document.createElement("button");
        save.type = "button";
        save.textContent = take.status === "failed" ? "retry" : "save";
        save.dataset.action = "retry";
        save.addEventListener("click", () => { upload(take.take_id).catch(() => {}); });
        actions.append(save);
      }
      if (take.status !== "saved") {
        const discard = document.createElement("button");
        discard.type = "button";
        discard.textContent = "discard";
        discard.dataset.action = "discard";
        discard.addEventListener("click", () => discardTake(take.take_id));
        actions.append(discard);
      }
      row.append(actions);
      takesList.append(row);
    }
  }

  async function upload(takeId) {
    const take = takes.get(takeId);
    if (!take || take.status === "uploading" || take.status === "saved") return;
    take.status = "uploading";
    take.error = "";
    render();
    try {
      const mime = take.mime || take.audio?.type || "";
      const url = `recording?take=${encodeURIComponent(take.take_id)}&started=${encodeURIComponent(String(take.started_at))}`;
      const response = await fetch(url, {
        method: "POST",
        headers: mime ? { "content-type": mime } : {},
        body: take.audio,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const saved = await response.json();
      const current = takes.get(takeId);
      if (!current) return;
      current.status = "saved";
      current.saved = saved;
      current.error = "";
      ack(takeId);
    } catch (error) {
      const current = takes.get(takeId);
      if (!current) return;
      current.status = "failed";
      current.error = error.message;
    }
    render();
  }

  function discardTake(takeId) {
    if (!takes.has(takeId)) return;
    takes.delete(takeId);
    ack(takeId);
    render();
  }

  function begin() {
    if (source !== "available" || activeRequestId) return;
    activeRequestId = requestId();
    hostError = "";
    send({ action: "open", request_id: activeRequestId, source: "microphone", processing: "raw" });
    render();
  }

  function cancel() {
    if (!activeRequestId) return;
    send({ action: "cancel", request_id: activeRequestId });
    activeRequestId = null;
    hostState = "idle";
    render();
  }

  toggle?.addEventListener("click", begin);
  stopButton?.addEventListener("click", () => {
    if (!activeRequestId) return;
    send({ action: "stop", request_id: activeRequestId });
    render();
  });
  cancelButton?.addEventListener("click", cancel);
  close?.addEventListener("click", () => dialog?.close());
  dialog?.addEventListener("cancel", () => {});

  render();

  return {
    show() {
      render();
      dialog?.showModal();
    },
    cancel,
    handle(message) {
      if (!message || typeof message !== "object") return;
      if (message.type === CAPTURE_SOURCES) {
        source = message.sources && typeof message.sources.microphone === "string" ? message.sources.microphone : null;
        render();
        return;
      }
      if (message.type !== CAPTURE_EVENT) return;
      if (message.state === "take") {
        const takeId = message.take_id;
        if (typeof takeId !== "string" || !(message.audio instanceof Blob)) return;
        if (message.request_id && message.request_id === activeRequestId) {
          activeRequestId = null;
          hostState = "idle";
        }
        if (!takes.has(takeId)) {
          takes.set(takeId, {
            take_id: takeId,
            request_id: typeof message.request_id === "string" ? message.request_id : null,
            audio: message.audio,
            mime: typeof message.mime === "string" ? message.mime : message.audio.type || "",
            bytes: typeof message.bytes === "number" ? message.bytes : message.audio.size,
            duration_ms: typeof message.duration_ms === "number" ? message.duration_ms : null,
            started_at: message.started_at,
            end: message.end || null,
            redelivered: message.redelivered === true,
            status: "pending",
            saved: null,
            error: "",
          });
          render();
          if (!message.redelivered) upload(takeId).catch(() => {});
        } else {
          render();
        }
        return;
      }
      if (typeof message.request_id === "string") {
        if (activeRequestId && message.request_id !== activeRequestId) return;
        if (!activeRequestId) activeRequestId = message.request_id;
      }
      if (message.state === "armed" || message.state === "starting" || message.state === "recording" || message.state === "finishing") {
        hostState = message.state;
      } else if (message.state === "cancelled") {
        activeRequestId = null;
        hostState = "cancelled";
      } else if (message.state === "error") {
        activeRequestId = null;
        hostState = "error";
        hostError = message.message || message.code || "unknown error";
      } else {
        return;
      }
      render();
    },
    takes: () => [...takes.values()],
    source: () => source,
    activeRequestId: () => activeRequestId,
  };
}
