import assert from "node:assert/strict";
import test from "node:test";
import { planNaturalLanguageSandboxAnalysis, runNaturalLanguageSandboxAnalysis } from "../src/sandbox_natural_language.mjs";

test("plans a production group summary from Chinese natural language", () => {
  const result = planNaturalLanguageSandboxAnalysis({
    question: "分析M07设备的实际产量和报废数量，按设备汇总并生成柱状图",
    limit: 100,
  });
  assert.equal(result.status, "ready");
  assert.equal(result.interpretation.domain, "production");
  assert.equal(result.plan.table, "production_orders");
  assert.equal(result.plan.analysisType, "group_summary");
  assert.equal(result.plan.sourceDateColumn, "actual_start");
  assert.ok(result.plan.columns.includes("actual_start"));
  assert.deepEqual(result.plan.groupBy, ["machine_id"]);
  assert.deepEqual(result.plan.filters[0], { field: "machine_id", operator: "eq", value: "M07" });
  assert.deepEqual(result.plan.metrics.map((item) => item.field).sort(), ["actual_qty", "scrap_qty"]);
  assert.equal(result.plan.limit, 100);
});

test("explicit source table overrides generic data-quality wording", () => {
  const result = planNaturalLanguageSandboxAnalysis({
    question: "按设备汇总实际产量、合格数量和报废数量，生成柱状图和Markdown报告，并包含数据质量提示。数据来源表production_orders。",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.interpretation.domain, "production");
  assert.equal(result.interpretation.explicitSourceTable, true);
  assert.equal(result.plan.table, "production_orders");
  assert.deepEqual(result.plan.groupBy, ["machine_id"]);
  assert.deepEqual(result.plan.metrics.map((item) => item.field).sort(), ["actual_qty", "good_qty", "scrap_qty"]);
});

test("report boilerplate data-quality wording does not override production signals", () => {
  const result = planNaturalLanguageSandboxAnalysis({
    question: "按设备汇总实际产量、合格数量和报废数量，计算报废率，生成柱状图和Markdown报告。报告包含数据范围、指标定义、来源表、筛选条件和数据质量提示。",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.interpretation.domain, "production");
  assert.equal(result.plan.table, "production_orders");
  assert.deepEqual(result.plan.groupBy, ["machine_id"]);
  assert.deepEqual(result.plan.metrics.map((item) => item.field).sort(), ["actual_qty", "good_qty", "scrap_qty"]);
  assert.deepEqual(result.plan.derivedMetrics, [{ alias: "scrap_rate", numerator: "total_scrap", denominator: "total_actual", multiplier: 1 }]);
  assert.match(result.plan.title, /按设备汇总/);
  assert.doesNotMatch(result.plan.title, /报告包含/);
});

test("multiple explicit source tables require clarification", () => {
  const result = planNaturalLanguageSandboxAnalysis({
    question: "同时分析 production_orders 和 quality_inspections",
  });
  assert.equal(result.status, "needs_clarification");
  assert.equal(result.execute, false);
  assert.match(result.clarification, /多个来源表/);
});

test("plans a monthly energy trend with an explicit date range", () => {
  const result = planNaturalLanguageSandboxAnalysis({ question: "分析M03从2026-01-01到2026-04-30的耗电量月度趋势" });
  assert.equal(result.status, "ready");
  assert.equal(result.plan.table, "energy_readings");
  assert.equal(result.plan.analysisType, "trend");
  assert.equal(result.plan.dateColumn, "reading_date");
  assert.equal(result.plan.frequency, "month");
  assert.deepEqual(result.plan.valueColumns, ["electricity_kwh"]);
  assert.equal(result.plan.filters.length, 3);
});

test("timestamp date ranges use an exclusive next-day upper bound", () => {
  const result = planNaturalLanguageSandboxAnalysis({
    question: "从 production_orders 表筛选 actual_start 在 2026-03-01 到 2026-03-31 之间的产量，按设备汇总",
  });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.plan.filters, [
    { field: "actual_start", operator: "gte", value: "2026-03-01" },
    { field: "actual_start", operator: "lt", value: "2026-04-01" },
  ]);
});

test("returns clarification for vague or unsupported cross-table requests", async () => {
  const vague = await runNaturalLanguageSandboxAnalysis({ question: "帮我分析一下", dryRun: false });
  assert.equal(vague.status, "needs_clarification");
  assert.equal(vague.executed, false);
  const crossTable = planNaturalLanguageSandboxAnalysis({ question: "分析M07设备的质量缺陷" });
  assert.equal(crossTable.status, "needs_clarification");
  assert.match(crossTable.clarification, /不能直接按设备筛选/);
});

test("dry run exposes the validated plan without contacting the sandbox", async () => {
  const result = await runNaturalLanguageSandboxAnalysis({ question: "按供应商汇总到货数量和来料缺陷", dryRun: true });
  assert.equal(result.status, "ready");
  assert.equal(result.executed, false);
  assert.equal(result.plan.table, "supplier_receipts");
  assert.deepEqual(result.plan.groupBy, ["supplier_id"]);
});
