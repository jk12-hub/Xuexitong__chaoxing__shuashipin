"use strict";

const assert = require("node:assert/strict");
const core = require("../qa-core.js");

assert.equal(core.normalizeText("  下一节\n"), "下一节");
assert.equal(core.isExactNextLabel("下一节"), true);
assert.equal(core.isExactNextLabel("提交并进入下一节"), false);
assert.equal(core.blockedReasonFromTexts(["请完成人脸认证后继续"]), "人脸认证");
assert.equal(core.blockedReasonFromTexts(["课程目录", "正常页面"]), "");
assert.equal(core.isDangerousContext("章节测验：下一节"), true);
assert.equal(core.isKnownOnboardingText("可边看边记，笔记会标记视频时间点"), true);
assert.equal(core.isKnownOnboardingText("普通课程提示"), false);
assert.equal(core.looksLikeCompletedQuiz("章节测验 提交成功 查看答案", "https://example.com/work"), true);
assert.equal(core.looksLikeCompletedQuiz("章节测验 正在作答", "https://example.com/work"), false);
assert.equal(core.looksLikeCompletedQuiz("普通课程 已提交资料", "https://example.com/course"), false);
assert.equal(core.looksLikeQuizPage("章节测验 题量：3 满分：100 单选题", "https://example.com/studentstudy"), true);
assert.equal(core.looksLikeQuizPage("课程目录 3 章节测验 2 视频", "https://example.com/studentstudy"), false);
assert.equal(core.looksLikeQuizPage("课程目录 章节测验 待完成", "https://example.com/studentstudy"), false);
assert.equal(core.looksLikeLearningObjectivePage("通过本章学习，你需要掌握和了解以下问题："), true);
assert.equal(core.looksLikeLearningObjectivePage("普通课程介绍"), false);
assert.equal(core.looksLikeVideoPage("完成条件 观看时长需 ≥ 总时长的 90%"), true);
assert.equal(core.looksLikeVideoPage("任务点已完成"), false);
assert.equal(core.isUnfinishedTaskConfirm("当前章节还有任务点未完成，是否去完成？"), true);
assert.equal(core.isUnfinishedTaskConfirm("视频已经播放完成"), false);
assert.equal(core.classifyCoursePage("通过本章学习，你需要掌握和了解以下问题：", ""), "learning-objective");
assert.equal(core.classifyCoursePage("完成条件 观看时长需 ≥ 总时长的90%", ""), "video");
assert.equal(core.classifyCoursePage("章节测验 题量：3 判断题", ""), "quiz");

const safeCandidate = { label: "下一节", context: "课程章节", visible: true, disabled: false };
assert.equal(core.selectUniqueNextCandidate([safeCandidate]), safeCandidate);
assert.equal(core.selectUniqueNextCandidate([
  safeCandidate,
  { label: "下一章", context: "课程章节", visible: true, disabled: false }
]), null);
assert.equal(core.selectUniqueNextCandidate([
  { label: "下一节", context: "考试提交", visible: true, disabled: false }
]), null);

console.log("qa-core tests passed");
