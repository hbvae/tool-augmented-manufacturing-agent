import assert from "node:assert/strict";
import test from "node:test";
import {
  askManufacturingQuestion,
  explainManufacturingMetric,
  generateNaturalLanguageReport,
  parseAnalysisQuestion,
} from "../src/natural_language.mjs";

test("parser routes an equipment scrap ranking to machine 360", () => {
  const parsed = parseAnalysisQuestion({ question: "哪台设备报废率最高？" });
  assert.equal(parsed.domain, "equipment");
  assert.equal(parsed.intent, "ranking");
  assert.equal(parsed.metric, "scrap_rate");
  assert.equal(parsed.suggestedTool, "analyze_machine_360");
  assert.equal(parsed.suggestedArguments.sortBy, "scrap_rate");
});

test("parser extracts entity and Chinese month", () => {
  const parsed = parseAnalysisQuestion({ question: "分析M07在2026年4月的停机趋势" });
  assert.deepEqual(parsed.entities.machineIds, ["M07"]);
  assert.deepEqual(parsed.dateRange, { dateFrom: "2026-04-01", dateTo: "2026-04-30", source: "explicit_month" });
  assert.equal(parsed.suggestedTool, "get_equipment_trend");
});

test("natural-language equipment answer includes data and execution audit trail", () => {
  const answer = askManufacturingQuestion({ question: "M07设备情况怎么样？" });
  assert.equal(answer.execution.tool, "analyze_machine_360");
  assert.deepEqual(answer.execution.arguments.machineIds, ["M07"]);
  assert.match(answer.answer, /M07/);
  assert.equal(answer.evidence.rows[0].machine_id, "M07");
});

test("natural-language work-order trace uses transactional evidence", () => {
  const answer = askManufacturingQuestion({ question: "请追溯工单WO00001" });
  assert.equal(answer.execution.tool, "trace_work_order");
  assert.equal(answer.evidence.summaries.quality.inspection_count, 2);
  assert.match(answer.answer, /WO00001/);
});

test("trend anomaly question keeps historical baseline and finds April shift", () => {
  const answer = askManufacturingQuestion({ question: "2026年4月停机趋势异常" });
  assert.equal(answer.execution.tool, "detect_trend_anomalies");
  assert.equal(answer.evidence.anomalies[0].period, "2026-04");
  assert.match(answer.answer, /2026-04/);
});

test("metric explanation returns formula and derivation caveat", () => {
  const result = explainManufacturingMetric({ metric: "OEE" });
  assert.equal(result.metric, "oee");
  assert.match(result.formula, /availability/);
  assert.match(result.caveat, /推导/);
});

test("lowest supplier score question identifies S004", () => {
  const answer = askManufacturingQuestion({ question: "哪个供应商综合评分最低？" });
  assert.equal(answer.execution.tool, "score_suppliers");
  assert.equal(answer.evidence.rows[0].supplier_id, "S004");
  assert.match(answer.answer, /S004/);
});

test("risk report contains narrative sections and supporting evidence", () => {
  const result = generateNaturalLanguageReport({ reportType: "risk" });
  assert.match(result.report, /# 制造分析报告/);
  assert.match(result.report, /## 异常检测/);
  assert.ok(result.evidence.overview.highlights.actual_qty > 0);
});

test("natural-language maintenance request routes to predictive screening", () => {
  const answer = askManufacturingQuestion({ question: "未来30天哪些设备维护风险最高？" });
  assert.equal(answer.execution.tool, "predict_maintenance_risk");
  assert.equal(answer.evidence.rows[0].machine_id, "M03");
});

test("natural-language root-cause request routes to evidence ranking", () => {
  const answer = askManufacturingQuestion({ question: "分析M07报废问题的根因" });
  assert.equal(answer.execution.tool, "rank_root_cause_candidates");
  assert.equal(answer.evidence.machineId, "M07");
});
