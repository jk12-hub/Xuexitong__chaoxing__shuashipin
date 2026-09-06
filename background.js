"use strict";

const SESSION_KEY = "chaoxingQaActiveTabsV1";
const LOG_KEY = "chaoxingQaLogsV1";
const CREDENTIALS_KEY = "chaoxingQaCredentialsV1";
const PANEL_POSITION_KEY = "chaoxingQaPanelPositionV1";
const MAX_LOGS_PER_TAB = 200;
const WATCHDOG_TIMEOUT_MS = 2 * 60 * 1000;
const WATCHDOG_ALARM_NAME = "chaoxing-qa-watchdog";
const RELOAD_ERROR_MESSAGE = "检测到刷新页面，请重新点击开始。";

async function getSessions() {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return stored[SESSION_KEY] || {};
}

async function saveSessions(sessions) {
  await chrome.storage.session.set({ [SESSION_KEY]: sessions });
}

async function getTabState(tabId) {
  const sessions = await getSessions();
  return sessions[String(tabId)] || {
    running: false,
    autoNext: true,
    videoOnlyMode: true,
    startedAt: null,
    pendingNextClicks: 0,
    nextEligibleAt: 0,
    advanceStartedAt: 0,
    lastVideoSeenAt: 0,
    lastProgressAt: 0,
    watchdogTimedOut: false,
    lastDirectNavigationAt: 0,
    navigationPhase: "scanning",
    visibleErrorMessage: "",
    pendingVisibleErrorMessage: "",
    pageFullscreen: false,
    updatedAt: Date.now()
  };
}

async function updateTabState(tabId, patch) {
  const sessions = await getSessions();
  const key = String(tabId);
  sessions[key] = {
    running: false,
    autoNext: true,
    videoOnlyMode: true,
    startedAt: null,
    pendingNextClicks: 0,
    nextEligibleAt: 0,
    advanceStartedAt: 0,
    lastVideoSeenAt: 0,
    lastProgressAt: 0,
    watchdogTimedOut: false,
    lastDirectNavigationAt: 0,
    navigationPhase: "scanning",
    visibleErrorMessage: "",
    pendingVisibleErrorMessage: "",
    pageFullscreen: false,
    ...(sessions[key] || {}),
    ...patch,
    updatedAt: Date.now()
  };
  await saveSessions(sessions);
  return sessions[key];
}

async function isWindowFullscreen(windowId) {
  if (!windowId) return false;
  try {
    const browserWindow = await chrome.windows.get(windowId);
    return browserWindow.state === "fullscreen";
  } catch (_error) {
    return false;
  }
}

async function revealPendingVisibleError(tabId, windowId) {
  const state = await getTabState(tabId);
  if (!state.pendingVisibleErrorMessage || state.pageFullscreen || await isWindowFullscreen(windowId)) return;
  await updateTabState(tabId, {
    visibleErrorMessage: state.pendingVisibleErrorMessage,
    pendingVisibleErrorMessage: ""
  });
}

async function appendLog(tabId, entry) {
  const stored = await chrome.storage.local.get(LOG_KEY);
  const logsByTab = stored[LOG_KEY] || {};
  const key = String(tabId);
  const logs = logsByTab[key] || [];
  logs.push({
    at: new Date().toISOString(),
    ...entry
  });
  logsByTab[key] = logs.slice(-MAX_LOGS_PER_TAB);
  await chrome.storage.local.set({ [LOG_KEY]: logsByTab });
}

async function getCredentials() {
  const stored = await chrome.storage.local.get(CREDENTIALS_KEY);
  const credentials = stored[CREDENTIALS_KEY] || {};
  return {
    account: String(credentials.account || ""),
    password: String(credentials.password || "")
  };
}

async function saveCredentials(accountValue, passwordValue) {
  const credentials = {
    account: String(accountValue || "").trim().slice(0, 30),
    password: String(passwordValue || "").slice(0, 20)
  };
  await chrome.storage.local.set({ [CREDENTIALS_KEY]: credentials });
  return credentials;
}

async function getPanelPosition() {
  const stored = await chrome.storage.local.get(PANEL_POSITION_KEY);
  const position = stored[PANEL_POSITION_KEY];
  if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) return null;
  return { left: position.left, top: position.top };
}

async function savePanelPosition(leftValue, topValue) {
  const position = {
    left: Math.max(0, Number(leftValue) || 0),
    top: Math.max(0, Number(topValue) || 0)
  };
  await chrome.storage.local.set({ [PANEL_POSITION_KEY]: position });
  return position;
}

async function handlePageReload(tabId, frameUrl, windowId, pageFullscreen = false) {
  const state = await getTabState(tabId);
  if (!state.running) {
    return { wasRunning: false, deferred: false, state };
  }

  let resolvedWindowId = windowId;
  if (!resolvedWindowId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      resolvedWindowId = tab.windowId;
    } catch (_error) {
      resolvedWindowId = 0;
    }
  }

  const fullscreen = Boolean(pageFullscreen) || await isWindowFullscreen(resolvedWindowId);
  await updateTabState(tabId, {
    running: false,
    startedAt: null,
    lastProgressAt: 0,
    watchdogTimedOut: false,
    pendingNextClicks: 0,
    nextEligibleAt: 0,
    advanceStartedAt: 0,
    lastDirectNavigationAt: 0,
    navigationPhase: "scanning",
    visibleErrorMessage: fullscreen ? "" : RELOAD_ERROR_MESSAGE,
    pendingVisibleErrorMessage: fullscreen ? RELOAD_ERROR_MESSAGE : "",
    pageFullscreen: Boolean(pageFullscreen)
  });
  await appendLog(tabId, {
    level: "error",
    frameUrl,
    message: RELOAD_ERROR_MESSAGE
  });
  return { wasRunning: true, deferred: fullscreen, state: await getTabState(tabId) };
}

async function checkWatchdogTimeouts() {
  const sessions = await getSessions();
  const now = Date.now();
  for (const [key, state] of Object.entries(sessions)) {
    const tabId = Number(key);
    if (!Number.isInteger(tabId) || !state.running || !state.autoNext || !state.videoOnlyMode || state.watchdogTimedOut) continue;
    const lastProgressAt = Math.max(Number(state.startedAt || 0), Number(state.lastProgressAt || 0));
    if (!lastProgressAt || now - lastProgressAt < WATCHDOG_TIMEOUT_MS) continue;

    await updateTabState(tabId, { watchdogTimedOut: true });
    await appendLog(tabId, {
      level: "error",
      frameUrl: "background-watchdog",
      message: "连续2分钟未检测到页面进展或视频播放进度"
    });

    let windowFullscreen = false;
    try {
      const tab = await chrome.tabs.get(tabId);
      windowFullscreen = await isWindowFullscreen(tab.windowId);
    } catch (_error) {
      // A tab can close between reading session state and checking its window.
    }

    if (state.pageFullscreen || windowFullscreen) {
      await updateTabState(tabId, {
        pendingVisibleErrorMessage: "连续2分钟未检测到页面进展或视频播放进度"
      });
    } else {
      await updateTabState(tabId, {
        visibleErrorMessage: "连续2分钟未检测到页面进展或视频播放进度"
      });
    }
  }
}

function ensureWatchdogAlarm() {
  chrome.alarms.create(WATCHDOG_ALARM_NAME, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(ensureWatchdogAlarm);
chrome.runtime.onStartup.addListener(ensureWatchdogAlarm);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM_NAME) checkWatchdogTimeouts().catch(() => {});
});
ensureWatchdogAlarm();

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0 || details.transitionType !== "reload") return;
  let hostname = "";
  try {
    hostname = new URL(details.url).hostname;
  } catch (_error) {
    return;
  }
  if (hostname !== "chaoxing.com" && !hostname.endsWith(".chaoxing.com")) return;
  return handlePageReload(details.tabId, details.url).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  if (!tabId || !message || message.source !== "chaoxing-course-qa") {
    return false;
  }

  (async () => {
    if (message.type === "get-state") {
      sendResponse({ ok: true, state: await getTabState(tabId) });
      return;
    }

    if (message.type === "get-credentials") {
      sendResponse({ ok: true, credentials: await getCredentials() });
      return;
    }

    if (message.type === "save-credentials") {
      const credentials = await saveCredentials(message.account, message.password);
      sendResponse({ ok: true, credentials });
      return;
    }

    if (message.type === "clear-credentials") {
      const credentials = await saveCredentials("", "");
      sendResponse({ ok: true, credentials });
      return;
    }

    if (message.type === "get-panel-position") {
      sendResponse({ ok: true, position: await getPanelPosition() });
      return;
    }

    if (message.type === "save-panel-position") {
      const position = await savePanelPosition(message.left, message.top);
      sendResponse({ ok: true, position });
      return;
    }

    if (message.type === "page-reloaded") {
      const result = await handlePageReload(
        tabId,
        sender.url,
        sender.tab.windowId,
        Boolean(message.pageFullscreen)
      );
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message.type === "set-running") {
      const now = Date.now();
      const state = await updateTabState(tabId, {
        running: Boolean(message.running),
        autoNext: message.autoNext !== false,
        videoOnlyMode: message.videoOnlyMode !== false,
        startedAt: message.running ? now : null,
        lastProgressAt: message.running ? now : 0,
        watchdogTimedOut: false,
        pendingNextClicks: 0,
        nextEligibleAt: 0,
        advanceStartedAt: 0,
        lastDirectNavigationAt: 0,
        navigationPhase: "scanning",
        visibleErrorMessage: "",
        pendingVisibleErrorMessage: ""
      });
      await appendLog(tabId, {
        level: "info",
        frameUrl: sender.url,
        message: state.running ? "用户启动测试" : "用户停止测试"
      });
      sendResponse({ ok: true, state });
      return;
    }

    if (message.type === "set-auto-next") {
      const state = await updateTabState(tabId, {
        autoNext: Boolean(message.autoNext)
      });
      sendResponse({ ok: true, state });
      return;
    }

    if (message.type === "set-options") {
      const state = await updateTabState(tabId, {
        autoNext: message.autoNext !== false,
        videoOnlyMode: message.videoOnlyMode !== false
      });
      sendResponse({ ok: true, state });
      return;
    }

    if (message.type === "log") {
      await appendLog(tabId, {
        level: message.level || "info",
        frameUrl: sender.url,
        message: String(message.message || "")
      });
      if (sender.frameId !== 0) {
        chrome.tabs.sendMessage(tabId, {
          source: "chaoxing-course-qa",
          type: "frame-status",
          level: message.level || "info",
          message: String(message.message || "")
        }).catch(() => {});
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "video-ended") {
      const state = await getTabState(tabId);
      await appendLog(tabId, {
        level: "info",
        frameUrl: sender.url,
        message: "视频自然播放结束"
      });
      if (state.running) {
        const now = Date.now();
        await updateTabState(tabId, {
          pendingNextClicks: state.autoNext ? 1 : 0,
          nextEligibleAt: state.autoNext ? now + 5000 : 0,
          advanceStartedAt: now,
          lastProgressAt: now,
          watchdogTimedOut: false,
          navigationPhase: state.autoNext ? "to-next-page" : "scanning"
        });
        chrome.tabs.sendMessage(tabId, {
          source: "chaoxing-course-qa",
          type: "video-ended",
          at: Date.now()
        }).catch(() => {});
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "video-seen") {
      const now = Date.now();
      const updated = await updateTabState(tabId, {
        lastVideoSeenAt: now,
        lastProgressAt: now,
        watchdogTimedOut: false
      });
      sendResponse({ ok: true, state: updated });
      return;
    }

    if (message.type === "quiz-completed") {
      const state = await getTabState(tabId);
      if (!state.running || state.videoOnlyMode) {
        sendResponse({ ok: false, error: "completed-quiz-not-eligible", state });
        return;
      }
      const updated = await updateTabState(tabId, {
        pendingNextClicks: 1,
        nextEligibleAt: Date.now() + 2000,
        navigationPhase: "to-next-page",
        lastProgressAt: Date.now(),
        watchdogTimedOut: false
      });
      await appendLog(tabId, {
        level: "info",
        frameUrl: sender.url,
        message: "检测到章节测验已完成"
      });
      sendResponse({ ok: true, state: updated });
      return;
    }

    if (message.type === "skip-quiz") {
      const state = await getTabState(tabId);
      if (!state.running || !state.videoOnlyMode) {
        sendResponse({ ok: false, error: "quiz-skip-not-eligible", state });
        return;
      }
      if (["to-quiz-confirm", "awaiting-quiz-confirm"].includes(state.navigationPhase)) {
        sendResponse({ ok: true, alreadyQueued: true, state });
        return;
      }
      const updated = await updateTabState(tabId, {
        pendingNextClicks: 1,
        nextEligibleAt: Date.now() + 1500,
        navigationPhase: "to-quiz-confirm",
        lastProgressAt: Date.now(),
        watchdogTimedOut: false
      });
      await appendLog(tabId, {
        level: "info",
        frameUrl: sender.url,
        message: "视频巡检模式跳过章节测验，未提交答案"
      });
      sendResponse({ ok: true, state: updated });
      return;
    }

    if (message.type === "learning-objective-detected") {
      const state = await getTabState(tabId);
      const now = Date.now();
      if (!state.running || !state.autoNext) {
        sendResponse({ ok: false, error: "navigation-not-enabled", state });
        return;
      }
      if (state.navigationPhase === "to-learning-objective-next" && state.pendingNextClicks > 0) {
        sendResponse({ ok: true, alreadyQueued: true, state });
        return;
      }
      if (state.navigationPhase !== "scanning" || now - Number(state.lastDirectNavigationAt || 0) < 3500) {
        sendResponse({ ok: false, error: "navigation-cooldown", state });
        return;
      }
      const updated = await updateTabState(tabId, {
        pendingNextClicks: 1,
        nextEligibleAt: now + 300,
        navigationPhase: "to-learning-objective-next",
        advanceStartedAt: now,
        lastProgressAt: now,
        watchdogTimedOut: false
      });
      await appendLog(tabId, {
        level: "info",
        frameUrl: sender.url,
        message: "检测到学习目标页，已请求顶层页面进入视频"
      });
      sendResponse({ ok: true, state: updated });
      return;
    }

    if (message.type === "consume-next-click") {
      const state = await getTabState(tabId);
      if (!state.running || state.pendingNextClicks <= 0 || Date.now() < state.nextEligibleAt) {
        sendResponse({ ok: false, error: "not-eligible", state });
        return;
      }
      const updated = await updateTabState(tabId, {
        pendingNextClicks: state.pendingNextClicks - 1,
        nextEligibleAt: 0,
        navigationPhase: state.navigationPhase === "to-quiz-confirm" ? "awaiting-quiz-confirm" : "scanning",
        advanceStartedAt: Date.now(),
        lastProgressAt: Date.now(),
        watchdogTimedOut: false,
        lastDirectNavigationAt: state.navigationPhase === "to-learning-objective-next"
          ? Date.now()
          : Number(state.lastDirectNavigationAt || 0)
      });
      sendResponse({ ok: true, state: updated });
      return;
    }

    if (message.type === "claim-direct-navigation") {
      const state = await getTabState(tabId);
      const now = Date.now();
      if (!state.running || !state.autoNext) {
        sendResponse({ ok: false, error: "navigation-not-enabled", state });
        return;
      }
      if (now - Number(state.lastDirectNavigationAt || 0) < 3500) {
        sendResponse({ ok: false, error: "navigation-cooldown", state });
        return;
      }
      const updated = await updateTabState(tabId, {
        lastDirectNavigationAt: now,
        navigationPhase: "scanning",
        advanceStartedAt: now,
        lastProgressAt: now,
        watchdogTimedOut: false
      });
      await appendLog(tabId, {
        level: "info",
        frameUrl: sender.url,
        message: String(message.reason || "页面流程继续")
      });
      sendResponse({ ok: true, state: updated });
      return;
    }

    if (message.type === "claim-quiz-confirm") {
      const state = await getTabState(tabId);
      const now = Date.now();
      if (!state.running || !state.autoNext || !state.videoOnlyMode || state.navigationPhase !== "awaiting-quiz-confirm") {
        sendResponse({ ok: false, error: "quiz-confirm-not-eligible", state });
        return;
      }
      if (now - Number(state.lastDirectNavigationAt || 0) < 1000) {
        sendResponse({ ok: false, error: "navigation-cooldown", state });
        return;
      }
      const updated = await updateTabState(tabId, {
        lastDirectNavigationAt: now,
        navigationPhase: "scanning",
        advanceStartedAt: now,
        lastProgressAt: now,
        watchdogTimedOut: false
      });
      await appendLog(tabId, {
        level: "info",
        frameUrl: sender.url,
        message: "确认跳过未完成的章节测验"
      });
      sendResponse({ ok: true, state: updated });
      return;
    }

    if (message.type === "report-playback-error") {
      const fullscreen = Boolean(message.pageFullscreen) || await isWindowFullscreen(sender.tab.windowId);
      const reason = String(message.reason || "自动播放视频错误");
      await appendLog(tabId, {
        level: "error",
        frameUrl: sender.url,
        message: reason
      });
      if (fullscreen) {
        const state = await updateTabState(tabId, {
          pendingVisibleErrorMessage: reason
        });
        sendResponse({ ok: true, deferred: true, state });
      } else {
        const state = await updateTabState(tabId, { visibleErrorMessage: reason });
        sendResponse({ ok: true, deferred: false, state });
      }
      return;
    }

    if (message.type === "fullscreen-state") {
      await updateTabState(tabId, { pageFullscreen: Boolean(message.pageFullscreen) });
      if (!message.pageFullscreen) {
        await revealPendingVisibleError(tabId, sender.tab.windowId);
      }
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "unknown-message" });
  })().catch((error) => {
    sendResponse({ ok: false, error: String(error && error.message || error) });
  });

  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const sessions = await getSessions();
  delete sessions[String(tabId)];
  await saveSessions(sessions);
});

chrome.windows.onBoundsChanged.addListener(async (browserWindow) => {
  if (browserWindow.state === "fullscreen") return;
  try {
    const tabs = await chrome.tabs.query({ windowId: browserWindow.id });
    for (const tab of tabs) {
      if (tab.id) await revealPendingVisibleError(tab.id, browserWindow.id);
    }
  } catch (_error) {
    // A closing browser window can disappear before the query completes.
  }
});
