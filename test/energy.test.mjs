import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeEnergyBreakdown,
  analyzeEnergyEfficiency,
  analyzeEnergyProductionEfficiency,
  analyzePeakDemand,
  findEnergyExceptions,
  getEnergySummary,
  getEnergyTrend,
} from "../src/energy.mjs";

test("energy summary reconciles daily meter readings", () => {
  const result = getEnergySummary({});
  assert.equal(result.metrics.reading_count, 1440);
  assert.equal(result.metrics.machine_count, 8);
  assert.equal(result.metrics.electricity_kwh, 98379.94);
  assert.equal(result.metrics.kwh_per_runtime_hour, 20);
  assert.equal(result.metrics.kwh_per_good_unit, 1.0936);
});

test("energy date scope is inclusive by calendar day", () => {
  const result = getEnergySummary({ dateFrom: "2026-01-01", dateTo: "2026-01-31" });
  assert.equal(result.metrics.reading_count, 248);
  assert.equal(result.metrics.electricity_kwh, 17298.43);
});

test("machine breakdown exposes M08 electricity intensity", () => {
  const result = analyzeEnergyBreakdown({ dimension: "machine", orderBy: "kwh_per_runtime_hour", direction: "desc" });
  assert.equal(result.rows.length, 8);
  assert.equal(result.rows[0].machine_id, "M08");
  assert.equal(result.rows[0].kwh_per_runtime_hour, 28.654);
});

test("monthly energy trend returns six periods", () => {
  const result = getEnergyTrend({ grain: "month" });
  assert.equal(result.rows.length, 6);
  assert.equal(result.rows.find((row) => row.period === "2026-04").electricity_kwh, 16812.71);
});

test("energy efficiency ranking supports good-unit intensity", () => {
  const result = analyzeEnergyEfficiency({ dimension: "machine", efficiencyMetric: "kwh_per_good_unit" });
  assert.equal(result.rows[0].machine_id, "M08");
  assert.equal(result.rows[0].kwh_per_good_unit, 1.5149);
});

test("energy-production efficiency returns reconciled machine-month rows in one analysis", () => {
  const result = analyzeEnergyProductionEfficiency({ grain: "month" });
  assert.equal(result.periodRows.length, 48);
  assert.equal(result.validation.quantityBalancePassed, true);
  assert.equal(result.overview.electricity_kwh, 98379.94);
  assert.equal(result.overview.good_qty, 89957);
  assert.equal(result.overview.kwh_per_good_unit, 1.0936);
  const marchM07 = result.periodRows.find((row) => row.period === "2026-03" && row.machine_id === "M07");
  assert.equal(marchM07.actual_qty, 2404);
  assert.equal(marchM07.good_qty, 2307);
  assert.equal(marchM07.scrap_qty, 97);
  assert.equal(marchM07.kwh_per_good_unit, 1.1313);
  assert.deepEqual(result.highEnergyLowOutput.map((row) => row.machine_id), ["M08", "M04", "M03"]);
});

test("peak demand analysis filters by rated-power utilization", () => {
  const result = analyzePeakDemand({ minimumPeakUtilization: 0.9, limit: 10 });
  assert.ok(result.rows.length > 0);
  assert.equal(result.rows[0].machine_id, "M05");
  assert.equal(result.rows[0].peak_utilization, 0.92);
});

test("energy exceptions identify combined idle and peak events", () => {
  const result = findEnergyExceptions({ limit: 20 });
  assert.ok(result.rows.length > 0);
  assert.ok(result.rows.some((row) => row.exception_reasons.includes("IDLE_CONSUMPTION") && row.exception_reasons.includes("HIGH_PEAK_UTILIZATION")));
});
