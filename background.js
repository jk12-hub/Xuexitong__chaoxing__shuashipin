"use strict";

const SESSION_KEY = "chaoxingQaActiveTabsV1";
const LOG_KEY = "chaoxingQaLogsV1";
const MAX_LOGS_PER_TAB = 200;
const NOTIFICATION_COOLDOWN_MS = 30000;
const WATCHDOG_TIMEOUT_MS = 2 * 60 * 1000;
const WATCHDOG_ALARM_NAME = "chaoxing-qa-watchdog";
const NOTIFICATION_ICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl2EAAAAASUVORK5CYII=";

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
    pendingSystemError: false,
    pageFullscreen: false,
    lastSystemErrorAt: 0,
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
    pendingSystemError: false,
    pageFullscreen: false,
    lastSystemErrorAt: 0,
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

async function showSystemError(tabId) {
  const state = await getTabState(tabId);
  const now = Date.now();
  if (now - Number(state.lastSystemErrorAt || 0) < NOTIFICATION_COOLDOWN_MS) return false;
  await chrome.notifications.create(`chaoxing-qa-error-${tabId}-${now}`, {
    type: "basic",
    iconUrl: NOTIFICATION_ICON_DATA_URL,
    title: "自动播放视频错误",
    message: "自动播放视频错误",
    priority: 2,
    requireInteraction: true
  });
  await updateTabState(tabId, {
    pendingSystemError: false,
    lastSystemErrorAt: now
  });
  return true;
}

async function flushPendingSystemError(tabId, windowId) {
  const state = await getTabState(tabId);
  if (!state.pendingSystemError || state.pageFullscreen || await isWindowFullscreen(windowId)) return;
  await showSystemError(tabId);
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
      await updateTabState(tabId, { pendingSystemError: true });
    } else {
      const shown = await showSystemError(tabId);
      if (!shown) await updateTabState(tabId, { watchdogTimedOut: false });
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
        pendingSystemError: false
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
      await appendLog(tabId, {
        level: "error",
        frameUrl: sender.url,
        message: String(message.reason || "自动播放视频错误")
      });
      if (fullscreen) {
        const state = await updateTabState(tabId, { pendingSystemError: true });
        sendResponse({ ok: true, deferred: true, state });
      } else {
        await showSystemError(tabId);
        sendResponse({ ok: true, deferred: false, state: await getTabState(tabId) });
      }
      return;
    }

    if (message.type === "fullscreen-state") {
      await updateTabState(tabId, { pageFullscreen: Boolean(message.pageFullscreen) });
      if (!message.pageFullscreen) {
        await flushPendingSystemError(tabId, sender.tab.windowId);
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
      if (tab.id) await flushPendingSystemError(tab.id, browserWindow.id);
    }
  } catch (_error) {
    // A closing browser window can disappear before the query completes.
  }
});
