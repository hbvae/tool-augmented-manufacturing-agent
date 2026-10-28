import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeSupplierBreakdown,
  findSupplierExceptions,
  getSupplierSummary,
  getSupplierTrend,
  scoreSuppliers,
} from "../src/supplier.mjs";

test("supplier summary reconciles receipt, quality, and delivery totals", () => {
  const result = getSupplierSummary({});
  assert.equal(result.metrics.receipt_count, 240);
  assert.equal(result.metrics.supplier_count, 6);
  assert.equal(result.metrics.incoming_defect_qty, 1586);
  assert.equal(result.metrics.fail_count, 9);
  assert.equal(result.metrics.on_time_count + result.metrics.late_count, 240);
});

test("supplier date scope is inclusive by calendar day", () => {
  const result = getSupplierSummary({ dateFrom: "2026-01-01", dateTo: "2026-01-31" });
  assert.equal(result.metrics.receipt_count, 42);
  assert.equal(result.metrics.pass_rate, 1);
});

test("supplier breakdown exposes S004 quality pattern", () => {
  const result = analyzeSupplierBreakdown({ dimension: "supplier", orderBy: "defect_rate", direction: "desc" });
  assert.equal(result.rows[0].supplier_id, "S004");
  assert.equal(result.rows[0].fail_count, 9);
  assert.equal(result.rows[0].defect_rate, 0.0072);
});

test("monthly supplier trend returns six periods", () => {
  const result = getSupplierTrend({ grain: "month" });
  assert.equal(result.rows.length, 6);
  assert.equal(result.rows.find((row) => row.period === "2026-04").on_time_rate, 0.35);
});

test("supplier scorecard is transparent and ranks S004 last", () => {
  const result = scoreSuppliers({});
  assert.equal(result.rows.length, 6);
  assert.equal(result.rows.at(-1).supplier_id, "S004");
  assert.equal(result.rows.at(-1).grade, "D");
  assert.equal(result.scoring.weights.delivery, 0.35);
});

test("supplier exceptions identify failed high-defect S004 receipts", () => {
  const result = findSupplierExceptions({ limit: 20 });
  assert.ok(result.rows.some((row) => row.supplier_id === "S004" && row.exception_reasons.includes("FAILED_INSPECTION") && row.exception_reasons.includes("HIGH_DEFECT_RATE")));
});

test("preferred-source filter isolates three non-preferred receipts", () => {
  const result = getSupplierSummary({ supplierPreference: "non_preferred" });
  assert.equal(result.metrics.receipt_count, 3);
  assert.equal(result.metrics.preferred_receipt_rate, 0);
});
