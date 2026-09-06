"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

function createStorageArea() {
  const values = {};
  return {
    async get(key) {
      return { [key]: values[key] };
    },
    async set(patch) {
      Object.assign(values, patch);
    }
  };
}

const runtimeMessages = createEvent();
let windowState = "normal";

const chrome = {
  alarms: {
    create() {},
    onAlarm: createEvent()
  },
  runtime: {
    onInstalled: createEvent(),
    onMessage: runtimeMessages,
    onStartup: createEvent()
  },
  storage: {
    local: createStorageArea(),
    session: createStorageArea()
  },
  tabs: {
    async get() {
      return { id: 7, windowId: 3 };
    },
    async query() {
      return [{ id: 7 }];
    },
    sendMessage() {
      return Promise.resolve();
    },
    onRemoved: createEvent()
  },
  webNavigation: {
    onCommitted: createEvent()
  },
  windows: {
    async get() {
      return { state: windowState };
    },
    onBoundsChanged: createEvent()
  }
};

const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
vm.runInNewContext(source, { chrome, Date, Object, Promise, String, URL });

const onMessage = runtimeMessages.listeners[0];
const onNavigationCommitted = chrome.webNavigation.onCommitted.listeners[0];
const sender = {
  frameId: 0,
  tab: { id: 7, windowId: 3 },
  url: "https://mooc1.chaoxing.com/mycourse/studentstudy"
};

function send(message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No response for ${message.type}`)), 1000);
    onMessage({ source: "chaoxing-course-qa", ...message }, sender, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

(async () => {
  const saved = await send({ type: "save-credentials", account: "  test-user  ", password: "test-password" });
  assert.equal(saved.ok, true);
  assert.equal(saved.credentials.account, "test-user");
  assert.equal(saved.credentials.password, "test-password");
  const loaded = await send({ type: "get-credentials" });
  assert.equal(loaded.credentials.account, saved.credentials.account);
  assert.equal(loaded.credentials.password, saved.credentials.password);

  await send({ type: "set-running", running: true, autoNext: true, videoOnlyMode: true });
  const immediate = await send({ type: "page-reloaded", pageFullscreen: false });
  assert.equal(immediate.ok, true);
  assert.equal(immediate.wasRunning, true);
  assert.equal(immediate.deferred, false);
  assert.equal(immediate.state.running, false);
  assert.equal(immediate.state.visibleErrorMessage, "检测到刷新页面，请重新点击开始。");
  assert.equal(immediate.state.pendingVisibleErrorMessage, "");

  windowState = "fullscreen";
  await send({ type: "set-running", running: true, autoNext: true, videoOnlyMode: true });
  const deferred = await send({ type: "page-reloaded", pageFullscreen: false });
  assert.equal(deferred.ok, true);
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.state.running, false);
  assert.equal(deferred.state.visibleErrorMessage, "");
  assert.equal(deferred.state.pendingVisibleErrorMessage, "检测到刷新页面，请重新点击开始。");

  windowState = "normal";
  await send({ type: "fullscreen-state", pageFullscreen: false });
  let state = await send({ type: "get-state" });
  assert.equal(state.state.visibleErrorMessage, "检测到刷新页面，请重新点击开始。");
  assert.equal(state.state.pendingVisibleErrorMessage, "");

  await send({ type: "set-running", running: true, autoNext: true, videoOnlyMode: true });
  await onNavigationCommitted({
    tabId: 7,
    frameId: 0,
    transitionType: "link",
    url: sender.url
  });
  state = await send({ type: "get-state" });
  assert.equal(state.state.running, true);

  await onNavigationCommitted({
    tabId: 7,
    frameId: 0,
    transitionType: "reload",
    url: sender.url
  });
  state = await send({ type: "get-state" });
  assert.equal(state.state.running, false);
  assert.equal(state.state.visibleErrorMessage, "检测到刷新页面，请重新点击开始。");

  const cleared = await send({ type: "clear-credentials" });
  assert.equal(cleared.credentials.account, "");
  assert.equal(cleared.credentials.password, "");

  console.log("background reload tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
