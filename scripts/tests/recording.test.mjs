// Host-owned capture in recording.js, executed as shipped against a fake
// DOM. Run with: node --test scripts/tests/recording.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.textContent = "";
    this.className = "";
    this.disabled = false;
    this.hidden = false;
    this.type = "";
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  click() { for (const fn of this.listeners.click ?? []) fn({ preventDefault() {} }); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
}

function setup(fetchImpl) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id === "recording-dialog" ? "dialog" : "div"));
      return elements.get(id);
    },
    createElement(tag) { return new FakeElement(tag); },
  };
  globalThis.document = document;
  globalThis.fetch = fetchImpl;
  const sent = [];
  const host = { postMessage: (message) => sent.push(message) };
  return { elements, document, sent, host };
}

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const sources = (value) => ({ type: "chan:extension-capture-sources:v1", sources: { microphone: value } });
const event = (request_id, state, extra = {}) => ({ type: "chan:extension-capture-event:v1", request_id, state, ...extra });
const TAKE_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TAKE_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function load(fetchImpl) {
  const ctx = setup(fetchImpl);
  const { createRecording } = await import("../../crates/strudel-extension/assets/recording.js");
  const ui = createRecording(ctx.host);
  return { ...ctx, ui, el: (id) => ctx.document.getElementById(id) };
}

test("record is enabled only when the host reports microphone available", async () => {
  const { ui, el, sent } = await load(async () => { throw new Error("no fetch"); });
  assert.equal(el("recording-toggle").disabled, true);
  assert.match(el("recording-status").textContent, /unavailable/);
  ui.handle(sources("not_granted"));
  assert.equal(el("recording-toggle").disabled, true);
  assert.match(el("recording-status").textContent, /not granted/);
  ui.handle(sources("insecure_context"));
  assert.match(el("recording-status").textContent, /secure context/);
  ui.handle(sources("unsupported"));
  assert.match(el("recording-status").textContent, /not supported/);
  ui.handle(sources("available"));
  assert.equal(el("recording-toggle").disabled, false);
  el("recording-toggle").click();
  const open = sent.at(-1);
  assert.equal(open.type, "chan:extension-capture-request:v1");
  assert.equal(open.action, "open");
  assert.equal(open.source, "microphone");
  assert.equal(open.processing, "raw");
  assert.ok(open.request_id);
  assert.equal(open.max_ms, undefined);
});

test("a failed upload keeps the take, retry succeeds, and ack follows only a 2xx", async () => {
  let calls = 0;
  const { ui, el, sent } = await load(async (url, init) => {
    calls++;
    assert.match(url, new RegExp(`recording\\?take=${TAKE_A}&started=1704164645000`));
    assert.equal(init.headers["content-type"], "audio/webm");
    if (calls === 1) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ path: "/tmp/mic.webm", url: "samples/recordings/mic.webm", bytes: 5 }) };
  });
  ui.handle(sources("available"));
  el("recording-toggle").click();
  const requestId = sent.at(-1).request_id;
  ui.handle(event(requestId, "recording", { started_at: 1704164645000 }));
  ui.handle(event(requestId, "take", { take_id: TAKE_A, audio: new Blob(["audio"], { type: "audio/webm" }), mime: "audio/webm", started_at: 1704164645000 }));
  await settle();
  assert.equal(calls, 1);
  assert.equal(sent.filter((m) => m.action === "ack").length, 0);
  assert.equal(ui.takes().length, 1);
  assert.equal(ui.takes()[0].status, "failed");
  // Retry through the row button offered for this take.
  const row = el("recording-takes").children.find((r) => r.dataset.takeId === TAKE_A);
  const retry = row.children.at(-1).children.find((b) => b.dataset.action === "retry");
  retry.click();
  await settle();
  assert.equal(calls, 2);
  assert.equal(ui.takes()[0].status, "saved");
  const acks = sent.filter((m) => m.action === "ack" && m.take_id === TAKE_A);
  assert.equal(acks.length, 1);
  assert.equal(acks[0].type, "chan:extension-capture-request:v1");
});

test("closing and reopening during an upload does not lose the next take", async () => {
  const pending = [];
  const { ui, el, sent } = await load(async () => await new Promise((resolve) => pending.push(resolve)));
  ui.handle(sources("available"));
  ui.show();
  el("recording-toggle").click();
  const first = sent.at(-1).request_id;
  ui.handle(event(first, "recording"));
  ui.handle(event(first, "take", { take_id: TAKE_A, audio: new Blob(["one"], { type: "audio/webm" }), mime: "audio/webm", started_at: 1704164645000 }));
  await settle();
  assert.equal(pending.length, 1);
  el("recording-close").click();
  ui.show();
  el("recording-toggle").click();
  const second = sent.filter((m) => m.action === "open").at(-1).request_id;
  assert.notEqual(second, first);
  ui.handle(event(second, "recording"));
  ui.handle(event(second, "take", { take_id: TAKE_B, audio: new Blob(["two"], { type: "audio/webm" }), mime: "audio/webm", started_at: 1704164646000 }));
  await settle();
  assert.equal(pending.length, 2);
  pending[0]({ ok: true, status: 200, json: async () => ({ path: "/a.webm", url: "samples/recordings/a.webm", bytes: 3 }) });
  await settle();
  const takes = Object.fromEntries(ui.takes().map((t) => [t.take_id, t.status]));
  assert.equal(takes[TAKE_A], "saved");
  assert.equal(takes[TAKE_B], "uploading");
  pending[1]({ ok: true, status: 200, json: async () => ({ path: "/b.webm", url: "samples/recordings/b.webm", bytes: 3 }) });
  await settle();
  assert.equal(ui.takes().find((t) => t.take_id === TAKE_B).status, "saved");
  assert.equal(sent.filter((m) => m.action === "cancel").length, 0);
});

test("a redelivered take with no local request is offered for save and discard sends ack", async () => {
  let calls = 0;
  const { ui, el, sent } = await load(async () => { calls++; return { ok: true, status: 200, json: async () => ({ path: "/r.webm", url: "samples/recordings/r.webm", bytes: 3 }) }; });
  ui.handle(sources("available"));
  ui.handle(event("unknown-request", "take", { take_id: TAKE_A, audio: new Blob(["x"], { type: "audio/webm" }), mime: "audio/webm", started_at: 1704164645000, redelivered: true }));
  await settle();
  assert.equal(ui.takes().length, 1);
  assert.equal(ui.takes()[0].status, "pending");
  assert.equal(calls, 0);
  const row = el("recording-takes").children.find((r) => r.dataset.takeId === TAKE_A);
  assert.ok(row, "the redelivered take is rendered for save");
  const save = row.children.at(-1).children.find((b) => b.dataset.action === "retry");
  save.click();
  await settle();
  assert.equal(calls, 1);
  assert.equal(ui.takes()[0].status, "saved");
  // A second redelivered take can be discarded, which acks it.
  ui.handle(event("unknown-2", "take", { take_id: TAKE_B, audio: new Blob(["y"], { type: "audio/webm" }), mime: "audio/webm", started_at: 1704164646000, redelivered: true }));
  const rowB = el("recording-takes").children.find((r) => r.dataset.takeId === TAKE_B);
  const discard = rowB.children.at(-1).children.find((b) => b.dataset.action === "discard");
  discard.click();
  assert.equal(ui.takes().some((t) => t.take_id === TAKE_B), false);
  assert.ok(sent.some((m) => m.action === "ack" && m.take_id === TAKE_B));
});

test("app.js does not cancel capture on pagehide", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../../crates/strudel-extension/assets/app.js", import.meta.url), "utf8");
  const pagehide = app.slice(app.indexOf("pagehide"), app.indexOf("pagehide") + 120);
  assert.doesNotMatch(pagehide, /recording\.cancel/);
  assert.doesNotMatch(app, /extension-microphone|session-context|recordings\/open/);
});
