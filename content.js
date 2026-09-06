(function startChaoxingQa() {
  "use strict";

  const core = globalThis.ChaoxingQaCore;
  if (!core) return;

  const isTopFrame = window.top === window;
  const attachedVideos = new WeakSet();
  const observedVideoTimes = new WeakMap();
  let state = { running: false, autoNext: true };
  let tickTimer = null;
  let lastStatus = "等待启动";
  let lastNextEventAt = 0;
  let panel = null;
  let onboardingDismissed = false;
  let lastVideoSeenReportAt = 0;
  let advancing = false;
  let lastReportedError = "";
  let lastReportedErrorAt = 0;
  let lastQuizCompletionReportAt = 0;
  let lastQuizSkipReportAt = 0;
  let lastPlayControlClickAt = 0;
  let firstPlayControlClickAt = 0;
  let tickBusy = false;
  let credentials = { account: "", password: "" };
  let credentialsLoaded = false;
  let loginAttempted = false;

  const DIALOG_SELECTORS = [
    "[role='dialog']",
    ".el-dialog",
    ".layui-layer",
    ".ant-modal",
    ".modal-dialog",
    ".modal",
    ".maskDiv",
    ".mask-no-bg",
    "#workpop",
    "#hintPop",
    ".popDiv",
    ".ans-dialog"
  ];

  function send(type, payload = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { source: "chaoxing-course-qa", type, ...payload },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false });
        }
      );
    });
  }

  function pageIsFullscreen() {
    return Boolean(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement
    );
  }

  function pageWasReloaded() {
    try {
      const navigation = performance.getEntriesByType("navigation")[0];
      if (navigation) return navigation.type === "reload";
      return Boolean(performance.navigation && performance.navigation.type === 1);
    } catch (_error) {
      return false;
    }
  }

  function reportPlaybackError(reason) {
    const normalized = core.normalizeText(reason) || "自动播放视频错误";
    const now = Date.now();
    if (normalized === lastReportedError && now - lastReportedErrorAt < 30000) return;
    lastReportedError = normalized;
    lastReportedErrorAt = now;
    send("report-playback-error", {
      reason: normalized,
      pageFullscreen: pageIsFullscreen()
    });
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findSafetyGate() {
    const selectors = [...DIALOG_SELECTORS, ".mask"];
    const texts = [];
    for (const element of document.querySelectorAll(selectors.join(","))) {
      if (isVisible(element)) texts.push(element.innerText || element.textContent || "");
    }
    return core.blockedReasonFromTexts(texts);
  }

  function updatePanelStatus(message, level = "info") {
    const normalized = core.normalizeText(message);
    if (!normalized) return;
    if (panel) {
      const status = panel.querySelector("[data-qa-status]");
      if (status) {
        status.textContent = normalized;
        status.dataset.level = level;
      }
    }
  }

  function setStatus(message, level = "info") {
    const normalized = core.normalizeText(message);
    if (!normalized || normalized === lastStatus) return;
    lastStatus = normalized;
    updatePanelStatus(normalized, level);
    send("log", { level, message: normalized });
  }

  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function clampPanelPosition(leftValue, topValue) {
    if (!panel) return { left: 0, top: 0 };
    const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
    return {
      left: Math.min(maxLeft, Math.max(0, Number(leftValue) || 0)),
      top: Math.min(maxTop, Math.max(0, Number(topValue) || 0))
    };
  }

  function applyPanelPosition(leftValue, topValue) {
    if (!panel) return null;
    const position = clampPanelPosition(leftValue, topValue);
    panel.style.left = `${position.left}px`;
    panel.style.top = `${position.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    return position;
  }

  function enablePanelDragging() {
    if (!panel) return;
    const handle = panel.querySelector("[data-qa-drag-handle]");
    if (!handle) return;
    let drag = null;

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
      };
      handle.setPointerCapture(event.pointerId);
      handle.dataset.dragging = "true";
      event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      applyPanelPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
    });

    async function finishDrag(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const position = applyPanelPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
      drag = null;
      delete handle.dataset.dragging;
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      if (position) await send("save-panel-position", position);
    }

    handle.addEventListener("pointerup", finishDrag);
    handle.addEventListener("pointercancel", finishDrag);
    window.addEventListener("resize", () => {
      if (!panel.style.left || !panel.style.top) return;
      const rect = panel.getBoundingClientRect();
      applyPanelPosition(rect.left, rect.top);
    });
  }

  function findLoginSafetyGate() {
    const selectors = [
      "input[placeholder*='验证码']",
      "input[name*='captcha' i]",
      "input[id*='captcha' i]",
      "[class*='captcha' i]",
      "[id*='captcha' i]",
      "[class*='verify' i]",
      "[id*='verify' i]"
    ];
    const texts = Array.from(document.querySelectorAll(selectors.join(",")))
      .filter(isVisible)
      .map((element) => element.innerText || element.textContent || element.getAttribute("placeholder") || "");
    return core.blockedReasonFromTexts(texts) || findSafetyGate();
  }

  function findLoginButton(accountInput, passwordInput) {
    const root = passwordInput.form || accountInput.form || document;
    const candidates = Array.from(root.querySelectorAll(
      "button, input[type='submit'], input[type='button'], [role='button'], a, [onclick]"
    )).filter((element) => {
      if (!isVisible(element) || element.closest("#chaoxing-qa-panel")) return false;
      if (element.disabled || element.getAttribute("aria-disabled") === "true") return false;
      const label = core.normalizeText(
        element.value || element.innerText || element.textContent || element.getAttribute("aria-label") || ""
      );
      const compactLabel = label.replace(/\s+/g, "");
      return compactLabel === "登录" || compactLabel === "立即登录";
    });
    return candidates.length === 1 ? candidates[0] : null;
  }

  function autofillLoginIfNeeded() {
    if (!isTopFrame || !credentialsLoaded || loginAttempted) return;
    if (!credentials.account || !credentials.password) return;
    if (!core.normalizeText(document.title).includes("用户登录")) return;
    const accountInput = document.querySelector("input#phone[maxlength='30']");
    const passwordInput = document.querySelector("input#pwd[type='password'][maxlength='20']");
    if (!accountInput || !passwordInput || !isVisible(accountInput) || !isVisible(passwordInput)) return;

    const gate = findLoginSafetyGate();
    if (gate) {
      setStatus(`检测到${gate}，请人工完成后登录`, "warning");
      return;
    }

    if (!accountInput.value) setInputValue(accountInput, credentials.account);
    if (!passwordInput.value) setInputValue(passwordInput, credentials.password);
    if (accountInput.value && passwordInput.value) {
      const loginButton = findLoginButton(accountInput, passwordInput);
      if (!loginButton) {
        setStatus("已填写账号密码，但未找到唯一登录按钮", "warning");
        return;
      }
      loginAttempted = true;
      setStatus("已自动填写账号密码，正在登录");
      loginButton.click();
    }
  }

  function dismissKnownOnboarding() {
    if (!isTopFrame || !state.running || onboardingDismissed) return;
    const buttons = Array.from(document.querySelectorAll("button, [role='button'], a"));
    const candidates = buttons.filter((element) => {
      if (!isVisible(element) || core.normalizeText(element.textContent) !== "知道了") return false;
      const context = element.closest("[role='dialog'], .modal, .popover, .tips, .note_tips") || element.parentElement;
      return Boolean(context && core.isKnownOnboardingText(context.textContent));
    });
    if (candidates.length === 1) {
      candidates[0].click();
      onboardingDismissed = true;
      setStatus("已关闭首次视频引导，正在等待播放器");
    }
  }

  function attachVideo(video) {
    if (attachedVideos.has(video)) return;
    attachedVideos.add(video);
    video.addEventListener("ended", () => {
      setStatus("视频已自然播放结束");
      send("video-ended");
    });
    video.addEventListener("error", () => {
      setStatus("视频播放器报告错误，已等待人工检查", "error");
      reportPlaybackError("视频播放器报告错误");
    });
  }

  function findVisiblePlayControl() {
    const selectors = [
      ".vjs-big-play-button",
      ".xgplayer-start",
      ".prism-big-play-btn",
      ".dplayer-play-icon",
      ".jw-display-icon-container",
      ".playButton",
      ".play-button",
      ".play-btn",
      "button[aria-label='播放']",
      "button[title='播放']",
      "[role='button'][aria-label='播放']"
    ];
    const candidates = Array.from(document.querySelectorAll(selectors.join(","))).filter((element) => {
      if (!isVisible(element)) return false;
      if (element.disabled || element.getAttribute("aria-disabled") === "true") return false;
      return !element.closest("form");
    });
    return candidates.length === 1 ? candidates[0] : null;
  }

  function tryStartPlayerFromControl() {
    const now = Date.now();
    if (now - lastPlayControlClickAt < 8000) return false;
    const playControl = findVisiblePlayControl();
    if (!playControl) return false;
    lastPlayControlClickAt = now;
    if (!firstPlayControlClickAt) firstPlayControlClickAt = now;
    playControl.click();
    setStatus("已点击播放器中央播放按钮，等待视频初始化");
    return true;
  }

  async function operateVideos() {
    const videos = Array.from(document.querySelectorAll("video"));
    for (const video of videos) attachVideo(video);
    if (!state.running) return;

    const gate = findSafetyGate();
    if (gate) {
      for (const video of videos) {
        if (!video.paused) video.pause();
      }
      setStatus(`检测到${gate}，自动化已暂停`, "warning");
      reportPlaybackError(`检测到${gate}`);
      return;
    }

    const playable = videos.find((video) => isVisible(video) && !video.ended && video.readyState >= 2);
    if (!playable) {
      const clicked = tryStartPlayerFromControl();
      if (!clicked && firstPlayControlClickAt && Date.now() - firstPlayControlClickAt > 15000) {
        reportPlaybackError("点击播放器启动按钮后仍未初始化");
      }
      return;
    }

    firstPlayControlClickAt = 0;

    if (playable.paused) {
      tryStartPlayerFromControl();
      try {
        await playable.play();
        setStatus("视频正在正常播放");
      } catch (_error) {
        setStatus("浏览器阻止了自动播放，请手动点击一次播放按钮", "warning");
        reportPlaybackError("浏览器阻止自动播放");
      }
    } else {
      setStatus("视频正在正常播放");
    }

    const now = Date.now();
    const currentTime = Number(playable.currentTime || 0);
    const previousTime = observedVideoTimes.get(playable);
    observedVideoTimes.set(playable, currentTime);
    if (!playable.paused && previousTime !== undefined && currentTime > previousTime + 0.2 && now - lastVideoSeenReportAt > 4000) {
      lastVideoSeenReportAt = now;
      send("video-seen");
    }
  }

  function nextCandidateData(element) {
    const contextElement = element.closest("form, [role='dialog'], .exam, .test, .quiz, .TiMu") || element.parentElement;
    return {
      element,
      label: element.innerText || element.textContent || element.getAttribute("aria-label") || "",
      context: contextElement ? contextElement.innerText || contextElement.textContent || "" : "",
      disabled: Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true" || element.classList.contains("disabled"),
      visible: isVisible(element)
    };
  }

  function goToNextSection(eventAt) {
    if (!isTopFrame || !state.running || !state.autoNext || eventAt <= lastNextEventAt) return;
    lastNextEventAt = eventAt;
    setStatus(state.videoOnlyMode ? "视频结束，准备进入下一视频" : "视频结束，准备进入下一节");
  }

  function exactNextControls(root, options = {}) {
    const scope = root || document;
    const elements = Array.from(scope.querySelectorAll("a, button, [role='button'], [onclick], div, span"));
    const candidates = new Set();
    for (const element of elements) {
      if (!isVisible(element) || !core.isExactNextLabel(element.innerText || element.textContent || element.getAttribute("aria-label"))) continue;
      const clickable = element.matches("a, button, [role='button'], [onclick]")
        ? element
        : element.closest("a, button, [role='button'], [onclick]");
      const candidate = clickable && scope.contains(clickable) ? clickable : element;
      if (!isVisible(candidate)) continue;
      if (candidate.disabled || candidate.getAttribute("aria-disabled") === "true" || candidate.classList.contains("disabled")) continue;
      if (candidate.tagName === "BUTTON" && String(candidate.type || "").toLowerCase() === "submit") continue;
      if (options.excludeForms && candidate.closest("form")) continue;
      if (options.excludeDialogs && candidate.closest(DIALOG_SELECTORS.join(","))) continue;
      if (candidate.closest("#chaoxing-qa-panel")) continue;
      candidates.add(candidate);
    }
    const list = Array.from(candidates);
    const leafCandidates = list.filter((candidate) => !list.some((other) => other !== candidate && candidate.contains(other)));
    return leafCandidates;
  }

  function findUniqueNavigationNext() {
    const chaoxingPrimary = document.querySelector("#prevNextFocusNext");
    if (chaoxingPrimary) {
      const label = chaoxingPrimary.innerText || chaoxingPrimary.textContent || chaoxingPrimary.getAttribute("aria-label");
      const handler = chaoxingPrimary.getAttribute("onclick") || "";
      if (isVisible(chaoxingPrimary) &&
          core.isExactNextLabel(label) &&
          /(?:^|[;.\s])(?:window\.)?PCount\.next\s*\(/.test(handler) &&
          !chaoxingPrimary.classList.contains("disabled") &&
          chaoxingPrimary.getAttribute("aria-disabled") !== "true") {
        return chaoxingPrimary;
      }
    }
    const candidates = exactNextControls(document, {
      excludeForms: true,
      excludeDialogs: true
    });
    return candidates.length === 1 ? candidates[0] : null;
  }

  function pageText() {
    if (!document.body) return "";
    const bodyText = document.body.innerText || document.body.textContent || "";
    const injectedPanel = document.getElementById("chaoxing-qa-panel");
    const panelText = injectedPanel ? injectedPanel.innerText || injectedPanel.textContent || "" : "";
    return panelText ? bodyText.replace(panelText, "") : bodyText;
  }

  function findUnfinishedTaskDialog() {
    const candidates = new Set();
    for (const element of document.querySelectorAll(DIALOG_SELECTORS.join(","))) {
      if (isVisible(element) && core.isUnfinishedTaskConfirm(element.innerText || element.textContent || "")) {
        candidates.add(element);
      }
    }

    const exactNextElements = Array.from(document.querySelectorAll("a, button, [role='button'], [onclick], [class*='btn'], [class*='button']"))
      .filter((element) => isVisible(element) && core.isExactNextLabel(element.innerText || element.textContent || element.getAttribute("aria-label")));
    for (const element of exactNextElements) {
      let ancestor = element.parentElement;
      for (let depth = 0; ancestor && ancestor !== document.body && depth < 10; depth += 1) {
        if (isVisible(ancestor) && core.isUnfinishedTaskConfirm(ancestor.innerText || ancestor.textContent || "")) {
          candidates.add(ancestor);
          break;
        }
        ancestor = ancestor.parentElement;
      }
    }

    return Array.from(candidates).sort((left, right) => {
      return core.normalizeText(left.innerText || left.textContent).length -
        core.normalizeText(right.innerText || right.textContent).length;
    })[0] || null;
  }

  function findUniqueModalNext(dialog) {
    if (!dialog) return null;
    const candidates = exactNextControls(dialog);
    return candidates.length === 1 ? candidates[0] : null;
  }

  function findUniqueChaoxingNextChapterFallback() {
    const candidates = Array.from(document.querySelectorAll("a.nextChapter"))
      .filter((element) => {
        const label = element.innerText || element.textContent || element.getAttribute("aria-label");
        const handler = element.getAttribute("onclick") || "";
        return core.isExactNextLabel(label) &&
          /(?:^|[;.\s])(?:window\.)?PCount\.next\s*\(/.test(handler) &&
          !element.classList.contains("disabled") &&
          element.getAttribute("aria-disabled") !== "true" &&
          !element.closest("#chaoxing-qa-panel");
      });
    if (candidates.length === 1) return candidates[0];

    const chapterIds = new Set();
    try {
      const urlChapterId = new URL(location.href).searchParams.get("chapterId");
      if (/^\d+$/.test(urlChapterId || "")) chapterIds.add(urlChapterId);
    } catch (_error) {
      // Some embedded player URLs are not useful for chapter matching.
    }
    for (const selector of ["#curChapterId", "input[name='chapterId']", "input[name='chapterid']"]) {
      const value = document.querySelector(selector)?.value;
      if (/^\d+$/.test(value || "")) chapterIds.add(value);
    }

    const chapterMatches = candidates.filter((element) => {
      const handler = element.getAttribute("onclick") || "";
      return Array.from(chapterIds).some((chapterId) =>
        handler.includes(`'${chapterId}'`) || handler.includes(`"${chapterId}"`)
      );
    });
    if (chapterMatches.length === 1) return chapterMatches[0];

    // Responsive layouts may duplicate the same hidden anchor. If every matching
    // copy performs exactly the same action, clicking the first copy is equivalent.
    const equivalent = chapterMatches.length > 1 ? chapterMatches : candidates;
    const handlers = new Set(equivalent.map((element) => core.normalizeText(element.getAttribute("onclick") || "")));
    return equivalent.length > 0 && handlers.size === 1 ? equivalent[0] : null;
  }

  async function confirmUnfinishedTaskSkip() {
    if (!state.running || !state.autoNext || !state.videoOnlyMode || state.navigationPhase !== "awaiting-quiz-confirm") return false;
    const dialog = findUnfinishedTaskDialog();
    if (!dialog) return false;

    const next = findUniqueModalNext(dialog) || findUniqueChaoxingNextChapterFallback();
    if (!next) {
      reportPlaybackError("未找到未完成任务提示中的下一节按钮");
      return true;
    }

    const response = await send("claim-quiz-confirm");
    if (!response.ok) {
      if (response.error !== "navigation-cooldown") reportPlaybackError("无法确认章节测验跳转");
      return true;
    }
    state = response.state;
    next.click();
    setStatus("已点击提示框中的下一节，等待下一页");
    return true;
  }

  async function advanceLearningObjective() {
    if (!state.running || !state.autoNext) return false;
    if (!core.looksLikeLearningObjectivePage(pageText())) return false;

    // The marker is normally inside #iframe while the visible navigation button is
    // owned by the top document. Queue one shared navigation task for whichever frame
    // can see the real control.
    const response = await send("learning-objective-detected");
    if (!response.ok) {
      if (response.error !== "navigation-cooldown") reportPlaybackError("学习目标页无法请求进入视频");
      return false;
    }
    state = response.state;
    setStatus("已识别学习目标页，等待顶层页面进入视频");
    return false;
  }

  async function maybeAdvance() {
    // The chapter document can live in a course iframe. Every frame may look for the
    // control, while consume-next-click in the service worker atomically allows only one.
    if (advancing || !state.running || !state.autoNext) return;
    if (!state.pendingNextClicks || Date.now() < Number(state.nextEligibleAt || 0)) return;
    const gate = findSafetyGate();
    if (gate) {
      setStatus(`检测到${gate}，未继续导航`, "warning");
      reportPlaybackError(`检测到${gate}`);
      return;
    }
    const next = findUniqueNavigationNext() || findUniqueChaoxingNextChapterFallback();
    if (!next) {
      // Other frames may own the navigation control, so do not raise a false alarm
      // immediately. The top frame reports only after all frames had time to respond.
      if (isTopFrame && Date.now() - Number(state.advanceStartedAt || 0) > 15000) {
        setStatus("未找到唯一且安全的“下一节”导航，请人工检查", "warning");
        reportPlaybackError("未找到安全的下一节导航");
      }
      return;
    }
    advancing = true;
    const response = await send("consume-next-click");
    if (!response.ok) {
      advancing = false;
      return;
    }
    state = response.state;
    next.click();
    setStatus(response.state.navigationPhase === "awaiting-quiz-confirm" ? "已点击测验页下一节，等待确认提示" : "已进入下一页，正在重新识别");
    window.setTimeout(() => { advancing = false; }, 1500);
  }

  async function detectCompletedQuiz() {
    if (!state.running || state.videoOnlyMode || ["to-next-page", "to-quiz-confirm", "awaiting-quiz-confirm"].includes(state.navigationPhase)) return;
    if (Date.now() - lastQuizCompletionReportAt < 5000) return;
    const text = pageText();
    if (!core.looksLikeCompletedQuiz(text, location.href)) return;
    lastQuizCompletionReportAt = Date.now();
    const response = await send("quiz-completed");
    if (response.ok) {
      state = response.state;
      setStatus("章节测验已完成，准备进入下一个视频");
    }
  }

  async function skipQuizWhenRequested() {
    if (!state.running || !state.videoOnlyMode || ["to-quiz-confirm", "awaiting-quiz-confirm"].includes(state.navigationPhase)) return;
    if (Date.now() - lastQuizSkipReportAt < 5000) return;
    const text = pageText();
    if (!core.looksLikeQuizPage(text, location.href)) return;
    lastQuizSkipReportAt = Date.now();
    const response = await send("skip-quiz");
    if (response.ok) {
      state = response.state;
      setStatus("已识别章节测验，准备跳转到下一个视频");
    }
  }

  function renderPanel() {
    if (!isTopFrame || document.getElementById("chaoxing-qa-panel")) return;
    panel = document.createElement("section");
    panel.id = "chaoxing-qa-panel";
    panel.innerHTML = `
      <div class="chaoxing-qa-title" data-qa-drag-handle title="按住拖动面板">课程 QA</div>
      <div class="chaoxing-qa-status" data-qa-status>等待启动</div>
      <div class="chaoxing-qa-credentials">
        <input type="text" maxlength="30" autocomplete="off" data-qa-account placeholder="学习通账号">
        <input type="password" maxlength="20" autocomplete="off" data-qa-password placeholder="学习通密码">
        <div class="chaoxing-qa-credential-actions">
          <button type="button" data-qa-save-credentials>保存账密</button>
          <button type="button" data-qa-clear-credentials>清除</button>
        </div>
      </div>
      <label class="chaoxing-qa-option">
        <input type="checkbox" data-qa-auto-next checked>
        视频结束后进入下一节
      </label>
      <label class="chaoxing-qa-option">
        <input type="checkbox" data-qa-video-only checked>
        跳过章节测验，稍后完成
      </label>
      <div class="chaoxing-qa-actions">
        <button type="button" data-qa-start>开始</button>
        <button type="button" data-qa-stop>停止</button>
      </div>
      <div class="chaoxing-qa-note">仅正常播放；不答题、不跳时长、不绕过验证</div>
    `;
    document.documentElement.appendChild(panel);
    enablePanelDragging();

    const startButton = panel.querySelector("[data-qa-start]");
    const stopButton = panel.querySelector("[data-qa-stop]");
    const autoNext = panel.querySelector("[data-qa-auto-next]");
    const videoOnly = panel.querySelector("[data-qa-video-only]");
    const accountInput = panel.querySelector("[data-qa-account]");
    const passwordInput = panel.querySelector("[data-qa-password]");
    const saveCredentialsButton = panel.querySelector("[data-qa-save-credentials]");
    const clearCredentialsButton = panel.querySelector("[data-qa-clear-credentials]");

    function syncRunButtons() {
      startButton.textContent = state.running ? "进行中..." : "开始";
      startButton.disabled = Boolean(state.running);
      stopButton.disabled = !state.running;
    }

    startButton.addEventListener("click", async () => {
      const response = await send("set-running", {
        running: true,
        autoNext: autoNext.checked,
        videoOnlyMode: videoOnly.checked
      });
      if (response.ok) {
        state = response.state;
        syncRunButtons();
        setStatus("测试已启动，正在查找视频");
      } else {
        setStatus(`启动失败：${response.error || "未知错误"}`, "error");
      }
    });

    stopButton.addEventListener("click", async () => {
      const response = await send("set-running", {
        running: false,
        autoNext: autoNext.checked,
        videoOnlyMode: videoOnly.checked
      });
      if (response.ok) {
        state = response.state;
        syncRunButtons();
        setStatus("测试已停止");
      }
    });

    saveCredentialsButton.addEventListener("click", async () => {
      const account = accountInput.value.trim();
      const password = passwordInput.value;
      if (!account || !password) {
        setStatus("请完整输入学习通账号和密码", "warning");
        return;
      }
      const response = await send("save-credentials", { account, password });
      if (!response.ok) {
        setStatus("账号密码保存失败", "error");
        return;
      }
      credentials = response.credentials;
      credentialsLoaded = true;
      loginAttempted = false;
      passwordInput.value = credentials.password;
      setStatus("账号密码已保存到本机");
      autofillLoginIfNeeded();
    });

    clearCredentialsButton.addEventListener("click", async () => {
      const response = await send("clear-credentials");
      if (!response.ok) {
        setStatus("账号密码清除失败", "error");
        return;
      }
      credentials = response.credentials;
      credentialsLoaded = true;
      loginAttempted = false;
      accountInput.value = "";
      passwordInput.value = "";
      setStatus("本机保存的账号密码已清除");
    });

    async function saveOptions() {
      const response = await send("set-options", {
        autoNext: autoNext.checked,
        videoOnlyMode: videoOnly.checked
      });
      if (response.ok) state = response.state;
    }
    autoNext.addEventListener("change", saveOptions);
    videoOnly.addEventListener("change", saveOptions);
    syncRunButtons();
  }

  async function refreshState() {
    const response = await send("get-state");
    if (response.ok) {
      state = response.state;
      if (panel) {
        const autoNext = panel.querySelector("[data-qa-auto-next]");
        const videoOnly = panel.querySelector("[data-qa-video-only]");
        if (autoNext) autoNext.checked = state.autoNext !== false;
        if (videoOnly) videoOnly.checked = state.videoOnlyMode !== false;
        const startButton = panel.querySelector("[data-qa-start]");
        const stopButton = panel.querySelector("[data-qa-stop]");
        if (startButton) {
          startButton.textContent = state.running ? "进行中..." : "开始";
          startButton.disabled = Boolean(state.running);
        }
        if (stopButton) stopButton.disabled = !state.running;
        if (state.visibleErrorMessage) {
          lastStatus = core.normalizeText(state.visibleErrorMessage);
          updatePanelStatus(lastStatus, "error");
        }
      }
    }
  }

  async function loadCredentials() {
    const response = await send("get-credentials");
    if (!response.ok) return;
    credentials = response.credentials;
    credentialsLoaded = true;
    if (panel) {
      const accountInput = panel.querySelector("[data-qa-account]");
      const passwordInput = panel.querySelector("[data-qa-password]");
      if (accountInput) accountInput.value = credentials.account;
      if (passwordInput) passwordInput.value = credentials.password;
    }
    autofillLoginIfNeeded();
  }

  async function loadPanelPosition() {
    const response = await send("get-panel-position");
    if (!response.ok || !response.position) return;
    applyPanelPosition(response.position.left, response.position.top);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.source !== "chaoxing-course-qa") return;
    if (message.type === "video-ended") goToNextSection(Number(message.at) || Date.now());
    if (message.type === "frame-status" && isTopFrame) {
      updatePanelStatus(message.message, message.level || "info");
    }
  });

  for (const eventName of ["fullscreenchange", "webkitfullscreenchange", "mozfullscreenchange", "MSFullscreenChange"]) {
    document.addEventListener(eventName, () => {
      send("fullscreen-state", { pageFullscreen: pageIsFullscreen() });
    });
  }

  async function tick() {
    if (tickBusy) return;
    tickBusy = true;
    try {
      await refreshState();
      autofillLoginIfNeeded();
      dismissKnownOnboarding();
      await operateVideos();
      if (await confirmUnfinishedTaskSkip()) return;
      if (await advanceLearningObjective()) return;
      await skipQuizWhenRequested();
      if (!state.videoOnlyMode) await detectCompletedQuiz();
      await maybeAdvance();
    } finally {
      tickBusy = false;
    }
  }

  async function initialize() {
    renderPanel();
    if (isTopFrame) await loadPanelPosition();
    if (isTopFrame && pageWasReloaded()) {
      const response = await send("page-reloaded", { pageFullscreen: pageIsFullscreen() });
      if (response.ok) {
        state = response.state;
        if (response.wasRunning) {
          setStatus("检测到刷新页面，请重新点击开始。", "error");
        }
      }
    }
    await refreshState();
    if (isTopFrame) await loadCredentials();
    tickTimer = window.setInterval(tick, 1500);
  }

  initialize();

  window.addEventListener("pagehide", () => {
    if (tickTimer) window.clearInterval(tickTimer);
  }, { once: true });
})();
