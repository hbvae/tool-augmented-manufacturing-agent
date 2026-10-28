import assert from "node:assert/strict";
import test from "node:test";
import {
  detectRuleAnomalies,
  detectStatisticalAnomalies,
  detectTrendAnomalies,
  getAnomalyOverview,
} from "../src/anomaly.mjs";
import { DataToolError } from "../src/database.mjs";

test("rule anomalies normalize results from multiple domains", () => {
  const result = detectRuleAnomalies({ domains: ["cross_domain", "inventory"], limitPerDomain: 10 });
  assert.equal(result.counts.cross_domain, 8);
  assert.equal(result.counts.inventory, 7);
  assert.ok(result.anomalies.every((row) => row.anomaly_type === "RULE"));
});

test("rule threshold overrides select only high cross-domain scores", () => {
  const result = detectRuleAnomalies({ domains: ["cross_domain"], thresholdOverrides: { cross_domain: { minimumRiskScore: 3 } } });
  assert.deepEqual(result.anomalies.map((row) => row.entity_id), ["M03", "M07"]);
});

test("z-score detects the April daily downtime anomaly cluster", () => {
  const result = detectStatisticalAnomalies({ metric: "equipment.unplanned_downtime_min", grain: "day", method: "zscore", threshold: 2, minimumPoints: 8 });
  assert.ok(result.anomalyCount > 0);
  assert.equal(result.anomalies[0].period, "2026-04-04");
  assert.ok(result.anomalies.every((row) => row.period.startsWith("2026-04")));
});

test("IQR detector returns reproducible baseline bounds", () => {
  const result = detectStatisticalAnomalies({ metric: "quality.fail_rate", grain: "day", method: "iqr", threshold: 1.5, minimumPoints: 8 });
  assert.equal(result.method, "iqr");
  assert.equal(typeof result.statistics.lower_bound, "number");
  assert.equal(typeof result.statistics.upper_bound, "number");
});

test("trend change detector isolates April downtime level shift", () => {
  const result = detectTrendAnomalies({ metric: "equipment.unplanned_downtime_min", grain: "month", method: "change_rate", window: 2, threshold: 0.5, minimumPoints: 5 });
  assert.equal(result.anomalyCount, 1);
  assert.equal(result.anomalies[0].period, "2026-04");
  assert.equal(result.anomalies[0].baseline, 906.5);
});

test("statistical detector rejects an insufficient monthly sample", () => {
  assert.throws(
    () => detectStatisticalAnomalies({ metric: "energy.electricity_kwh", grain: "month", method: "zscore", minimumPoints: 8 }),
    (error) => error instanceof DataToolError && error.code === "INSUFFICIENT_DATA",
  );
});

test("anomaly overview combines all three detection families", () => {
  const result = getAnomalyOverview({ limitPerDomain: 5 });
  assert.ok(result.counts.rule > 0);
  assert.ok(result.counts.statistical > 0);
  assert.ok(result.counts.trend > 0);
  assert.deepEqual(result.methodComparison.comparedDomains, ["production", "quality", "equipment", "energy"]);
  assert.equal(result.statisticalChecks.length, 4);
  assert.equal(result.trendChecks.length, 4);
  assert.equal(result.methodComparison.level, "domain");
});
