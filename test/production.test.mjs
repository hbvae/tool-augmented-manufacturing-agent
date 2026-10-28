import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeProductionBreakdown,
  findProductionExceptions,
  getProductionSummary,
  getProductionTrend,
} from "../src/production.mjs";

test("production summary uses weighted KPI definitions", () => {
  const result = getProductionSummary({});
  assert.equal(result.dataAvailable, true);
  assert.equal(result.metrics.order_count, 360);
  assert.equal(result.metrics.actual_qty, 91696);
  assert.equal(result.metrics.good_qty + result.metrics.scrap_qty, result.metrics.actual_qty);
  assert.equal(result.metrics.scrap_rate, Number((result.metrics.scrap_qty / result.metrics.actual_qty).toFixed(4)));
  assert.ok(result.metrics.plan_completion_rate > 0.8 && result.metrics.plan_completion_rate < 1.2);
});

test("production scope filters by inclusive calendar dates", () => {
  const result = getProductionSummary({ dateFrom: "2026-04-01", dateTo: "2026-04-30", machineIds: ["M03"] });
  assert.ok(result.metrics.order_count > 0);
  assert.ok(result.metrics.order_count < 360);
  assert.equal(result.scope.dateTo, "2026-04-30");
});

test("machine breakdown exposes M07 scrap pattern", () => {
  const result = analyzeProductionBreakdown({ dimension: "machine", orderBy: "scrap_rate", direction: "desc" });
  assert.equal(result.rows[0].machine_id, "M07");
  assert.ok(result.rows[0].scrap_rate > 0.03);
});

test("monthly production trend returns six periods", () => {
  const result = getProductionTrend({ grain: "month" });
  assert.deepEqual(result.rows.map((row) => row.period), ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]);
});

test("production exceptions identify high scrap orders", () => {
  const result = findProductionExceptions({ exceptionTypes: ["high_scrap"], scrapAbove: 0.05, limit: 100 });
  assert.ok(result.rows.length > 0);
  assert.ok(result.rows.every((row) => row.scrap_rate > 0.05));
  assert.ok(result.rows.some((row) => row.machine_id === "M07" && row.shift === "B"));
});
