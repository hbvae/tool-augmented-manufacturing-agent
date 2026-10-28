import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeProcessCapability,
  analyzeQualityBreakdown,
  findQualityExceptions,
  getQualitySummary,
  getQualityTrend,
} from "../src/quality.mjs";

test("quality summary reconciles inspection counts and weighted rates", () => {
  const result = getQualitySummary({});
  assert.equal(result.dataAvailable, true);
  assert.equal(result.metrics.inspection_count, 720);
  assert.equal(result.metrics.pass_count + result.metrics.fail_count, result.metrics.inspection_count);
  assert.equal(result.metrics.pass_rate, Number((result.metrics.pass_count / result.metrics.inspection_count).toFixed(4)));
  assert.equal(result.metrics.sample_defect_rate, Number((result.metrics.defect_count / result.metrics.sample_size).toFixed(4)));
});

test("quality scope filters stage and date", () => {
  const result = getQualitySummary({ dateFrom: "2026-03-01", dateTo: "2026-03-31", stages: ["FINAL"] });
  assert.ok(result.metrics.inspection_count > 0);
  assert.ok(result.metrics.inspection_count < 720);
  assert.deepEqual(result.scope.stages, ["FINAL"]);
});

test("machine breakdown exposes M07 quality failure pattern", () => {
  const result = analyzeQualityBreakdown({ dimension: "machine", orderBy: "fail_rate", direction: "desc" });
  assert.equal(result.rows[0].machine_id, "M07");
  assert.ok(result.rows[0].fail_rate > 0.1);
});

test("monthly quality trend returns six periods", () => {
  const result = getQualityTrend({ grain: "month" });
  assert.deepEqual(result.rows.map((row) => row.period), ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]);
});

test("quality exceptions honor requested reason and threshold", () => {
  const result = findQualityExceptions({ exceptionTypes: ["high_defect_rate"], defectRateAbove: 0.1, limit: 100 });
  assert.ok(result.rows.length > 0);
  assert.ok(result.rows.every((row) => row.sample_defect_rate > 0.1));
  assert.ok(result.rows.every((row) => row.exception_reasons === "HIGH_DEFECT_RATE"));
});

test("process capability returns descriptive Cp and Cpk", () => {
  const result = analyzeProcessCapability({ dimension: "machine", minSampleSize: 20 });
  assert.equal(result.rows.length, 8);
  assert.ok(result.rows.every((row) => row.sample_count >= 20));
  assert.ok(result.rows.every((row) => row.status === "OK"));
  assert.ok(result.rows.every((row) => typeof row.cp === "number" && typeof row.cpk === "number"));
});
