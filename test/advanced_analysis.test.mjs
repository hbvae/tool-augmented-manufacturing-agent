import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildChartDataset, predictMaintenanceRisk, rankMachineRootCausesBatch, rankRootCauseCandidates } from "../src/advanced_analysis.mjs";
import { exportAnalysisXlsx } from "../src/excel_export.mjs";
import { listMetricDefinitions, resolveMetric } from "../src/semantic.mjs";

test("semantic layer exposes governed metric definitions and aliases", () => {
  const catalog = listMetricDefinitions({});
  assert.equal(catalog.totalMetrics, 27);
  assert.equal(resolveMetric("良品率").metric, "yield_rate");
  assert.equal(resolveMetric("OEE").unit, "%");
  assert.equal(resolveMetric("completion_rate").metric, "plan_completion_rate");
  assert.equal(resolveMetric("energy_per_unit").metric, "kwh_per_good_unit");
  assert.equal(resolveMetric("单位合格品能耗").metric, "kwh_per_good_unit");
  assert.equal(resolveMetric("supplier on-time delivery rate").metric, "supplier_on_time_rate");
  assert.equal(resolveMetric("incoming inspection pass rate").metric, "supplier_inspection_pass_rate");
  assert.equal(resolveMetric("inventory stock status").metric, "inventory_status");
});

test("predictive maintenance ranks M03 as critical with transparent components", () => {
  const result = predictMaintenanceRisk({ limit: 8, horizonDays: 30 });
  assert.equal(result.rows[0].machine_id, "M03");
  assert.equal(result.rows[0].risk_level, "CRITICAL");
  assert.ok(result.rows[0].component_scores.downtime > 0);
  assert.equal(result.model, "transparent_weighted_heuristic_v1");
});

test("root-cause candidate ranking identifies M07 hydraulic evidence", () => {
  const result = rankRootCauseCandidates({ machineId: "M07", limit: 10 });
  assert.equal(result.rows[0].candidate, "Hydraulic Leak");
  assert.equal(result.rows[0].domain, "equipment");
  assert.equal(result.productionPaceEvidence.returned, 2);
  assert.equal(result.productionPaceEvidence.rows[0].shift, "B");
  assert.ok(result.productionPaceEvidence.rows.every((row) => Number.isFinite(row.weighted_cycle_time_min)));
  assert.ok(result.productionPaceEvidence.rows.every((row) => Number.isFinite(row.weighted_standard_cycle_min)));
  assert.ok(result.productionPaceEvidence.rows.every((row) => Number.isFinite(row.cycle_time_index)));
  assert.equal(result.productionPaceEvidence.material_slowdown_detected, false);
  assert.match(result.dataNotes[0], /不证明因果/);
});

test("batch root-cause analysis returns compact evidence for every requested machine", () => {
  const result = rankMachineRootCausesBatch({ machineIds: ["M03", "M07", "M08"], limitPerMachine: 3 });
  assert.deepEqual(result.rows.map((row) => row.machine_id), ["M03", "M07", "M08"]);
  assert.ok(result.rows.every((row) => row.candidates.length === 3));
  assert.ok(result.rows.every((row) => row.productionPaceEvidence.returned >= 1));
  assert.ok(result.rows.every((row) => typeof row.productionPaceEvidence.material_slowdown_detected === "boolean"));
});

test("chart data standardizes production trend metadata", () => {
  const result = buildChartDataset({ domain: "production", view: "trend", metric: "scrap_rate", grain: "month" });
  assert.equal(result.chart.type, "line");
  assert.equal(result.chart.series[0].unit, "%");
  assert.equal(result.rows.length, 6);
  assert.equal(result.rows[3].period, "2026-04");
});

test("chart data supports maintenance risk ranking", () => {
  const result = buildChartDataset({ view: "maintenance_risk", limit: 3 });
  assert.equal(result.chart.type, "bar");
  assert.equal(result.rows[0].machine_id, "M03");
});

test("Excel export creates a verified native workbook", async () => {
  const result = await exportAnalysisXlsx({ analysisType: "maintenance", fileName: "advanced_analysis_test.xlsx", limit: 8 });
  assert.equal(result.format, "xlsx");
  assert.deepEqual(result.sheets, ["Summary", "Data"]);
  assert.equal(result.verification.formulaErrorsFound, false);
  assert.equal(result.verification.summaryRendered, true);
  assert.equal(fs.existsSync(result.file), true);
  assert.equal(fs.existsSync(`${result.file}.inspect.ndjson`), false);
  assert.ok(fs.statSync(result.file).size > 5000);
});
