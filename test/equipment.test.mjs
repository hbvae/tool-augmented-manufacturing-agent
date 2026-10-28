import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeDowntime,
  analyzeEquipmentBreakdown,
  calculateEquipmentOee,
  findEquipmentExceptions,
  getEquipmentSummary,
  getEquipmentTrend,
} from "../src/equipment.mjs";

test("equipment summary reconciles all source tables", () => {
  const result = getEquipmentSummary({});
  assert.equal(result.metrics.machine_count, 8);
  assert.equal(result.metrics.order_count, 360);
  assert.equal(result.metrics.downtime_event_count, 190);
  assert.equal(result.metrics.energy_reading_count, 1440);
  assert.equal(result.metrics.failure_count, 75);
  assert.equal(result.metrics.oee, 0.9257);
});

test("equipment breakdown exposes M03 downtime and reliability pattern", () => {
  const result = analyzeEquipmentBreakdown({ dimension: "machine", orderBy: "downtime_min", direction: "desc" });
  assert.equal(result.rows.length, 8);
  assert.equal(result.rows[0].machine_id, "M03");
  assert.equal(result.rows[0].downtime_min, 8087);
  assert.equal(result.rows[0].failure_count, 47);
});

test("equipment trend shows the April downtime event", () => {
  const result = getEquipmentTrend({ grain: "month" });
  assert.equal(result.rows.length, 6);
  const april = result.rows.find((row) => row.period === "2026-04");
  assert.equal(april.downtime_min, 8890);
  assert.equal(april.failure_count, 48);
});

test("downtime reason analysis ranks hydraulic leaks first", () => {
  const result = analyzeDowntime({ dimension: "reason", orderBy: "downtime_min", direction: "desc" });
  assert.equal(result.rows[0].reason, "Hydraulic Leak");
  assert.equal(result.rows[0].downtime_min, 3435);
});

test("OEE factors reconcile and M03 is lowest", () => {
  const result = calculateEquipmentOee({ dimension: "machine" });
  const first = result.rows[0];
  assert.equal(first.machine_id, "M03");
  assert.ok(Math.abs(first.oee - first.availability * first.performance * first.quality_rate) < 0.0002);
});

test("equipment exceptions identify M03 as the most severe", () => {
  const result = findEquipmentExceptions({});
  assert.equal(result.rows[0].machine_id, "M03");
  assert.match(result.rows[0].exception_reasons, /HIGH_DOWNTIME/);
  assert.match(result.rows[0].exception_reasons, /FREQUENT_FAILURES/);
});

test("shift filter suppresses incompatible daily energy metrics", () => {
  const result = getEquipmentSummary({ shifts: ["A"] });
  assert.equal(result.metrics.electricity_kwh, null);
  assert.ok(result.dataNotes.some((note) => note.includes("Energy metrics are null")));
});
