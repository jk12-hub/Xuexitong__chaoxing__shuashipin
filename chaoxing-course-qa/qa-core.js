(function exposeQaCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.ChaoxingQaCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createQaCore() {
  "use strict";

  const NEXT_LABELS = new Set(["下一节", "下一章", "下一个", "下一任务"]);
  const BLOCKED_TERMS = [
    "验证码",
    "人脸识别",
    "人脸认证",
    "身份认证",
    "安全验证",
    "滑块验证"
  ];
  const DANGEROUS_CONTEXT_TERMS = ["提交", "交卷", "考试", "测验", "作答"];

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function blockedReasonFromTexts(texts) {
    for (const rawText of texts || []) {
      const text = normalizeText(rawText);
      const term = BLOCKED_TERMS.find((item) => text.includes(item));
      if (term) return term;
    }
    return "";
  }

  function isExactNextLabel(value) {
    return NEXT_LABELS.has(normalizeText(value));
  }

  function isDangerousContext(value) {
    const text = normalizeText(value);
    return DANGEROUS_CONTEXT_TERMS.some((term) => text.includes(term));
  }

  function isKnownOnboardingText(value) {
    const text = normalizeText(value);
    return text.includes("可边看边记") && text.includes("笔记") && text.includes("视频时间点");
  }

  function looksLikeCompletedQuiz(value, urlValue) {
    const text = normalizeText(value);
    const url = String(urlValue || "").toLowerCase();
    const quizContext = text.includes("章节测验") || text.includes("测验") || /work|quiz|test/.test(url);
    if (!quizContext) return false;
    return [
      "恭喜你，已通过",
      "恭喜您，已通过",
      "测验已完成",
      "章节测验已完成",
      "提交成功",
      "已提交",
      "查看答案",
      "重新作答",
      "重做"
    ].some((term) => text.includes(term));
  }

  function looksLikeQuizPage(value, urlValue) {
    const text = normalizeText(value);
    const url = String(urlValue || "").toLowerCase();
    if (/work|quiz|test/.test(url) && text.includes("章节测验")) return true;
    if (!text.includes("章节测验")) return false;
    return [
      "单选题",
      "多选题",
      "判断题",
      "填空题",
      "简答题",
      "题量",
      "满分",
      "提交测验"
    ].some((term) => text.includes(term));
  }

  function looksLikeLearningObjectivePage(value) {
    const text = normalizeText(value);
    return text.includes("通过本章学习，你需要掌握和了解以下问题");
  }

  function looksLikeVideoPage(value) {
    const text = normalizeText(value);
    return text.includes("完成条件") &&
      text.includes("观看时长需") &&
      /总时长的\s*90%/.test(text);
  }

  function isUnfinishedTaskConfirm(value) {
    const text = normalizeText(value);
    return text.includes("当前章节还有任务点未完成") && text.includes("是否去完成");
  }

  function classifyCoursePage(value, urlValue) {
    if (looksLikeQuizPage(value, urlValue)) return "quiz";
    if (looksLikeVideoPage(value)) return "video";
    if (looksLikeLearningObjectivePage(value)) return "learning-objective";
    return "unknown";
  }

  function selectUniqueNextCandidate(candidates) {
    const safe = (candidates || []).filter((candidate) => {
      return Boolean(candidate && candidate.visible) &&
        !candidate.disabled &&
        isExactNextLabel(candidate.label) &&
        !isDangerousContext(candidate.context);
    });
    return safe.length === 1 ? safe[0] : null;
  }

  return Object.freeze({
    BLOCKED_TERMS,
    NEXT_LABELS,
    blockedReasonFromTexts,
    isDangerousContext,
    isExactNextLabel,
    isKnownOnboardingText,
    isUnfinishedTaskConfirm,
    classifyCoursePage,
    looksLikeCompletedQuiz,
    looksLikeLearningObjectivePage,
    looksLikeQuizPage,
    looksLikeVideoPage,
    normalizeText,
    selectUniqueNextCandidate
  });
});
