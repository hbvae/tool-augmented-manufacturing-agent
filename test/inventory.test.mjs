import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeInventoryBreakdown,
  analyzeInventoryStatus,
  findInventoryExceptions,
  getInventorySummary,
  getInventoryTrend,
} from "../src/inventory.mjs";

test("inventory summary reconciles movements and inferred balances", () => {
  const result = getInventorySummary({});
  assert.equal(result.movementMetrics.transaction_count, 1320);
  assert.equal(result.movementMetrics.item_count, 18);
  assert.equal(result.balanceMetrics.inferred_balance_qty, 724330.02);
  assert.equal(result.balanceMetrics.negative_balance_item_count, 0);
});

test("inventory breakdown separates all four transaction types", () => {
  const result = analyzeInventoryBreakdown({ dimension: "transaction_type", orderBy: "transaction_count", direction: "desc" });
  assert.equal(result.rows.length, 4);
  assert.ok(result.rows.some((row) => row.transaction_type === "RECEIPT"));
  assert.ok(result.rows.some((row) => row.transaction_type === "ISSUE"));
});

test("monthly inventory trend returns six periods", () => {
  const result = getInventoryTrend({ grain: "month" });
  assert.equal(result.rows.length, 6);
  assert.equal(result.rows[0].period, "2026-01");
});

test("raw-material status calculates coverage from issue velocity", () => {
  const result = analyzeInventoryStatus({ itemTypes: ["RAW_MATERIAL"], lookbackDays: 90 });
  assert.equal(result.rows.length, 10);
  const rm004 = result.rows.find((row) => row.item_id === "RM004");
  assert.equal(rm004.coverage_status, "EXCESS_COVERAGE");
  assert.equal(rm004.days_of_supply, 291.26);
});

test("finished goods do not receive fabricated demand coverage", () => {
  const result = analyzeInventoryStatus({ itemTypes: ["FINISHED_GOOD"] });
  assert.equal(result.rows.length, 8);
  assert.ok(result.rows.every((row) => row.days_of_supply === null && row.coverage_status === "NO_DEMAND_BASIS"));
});

test("inventory exceptions expose excess and no-consumption materials", () => {
  const result = findInventoryExceptions({ itemTypes: ["RAW_MATERIAL"], limit: 20 });
  assert.ok(result.rows.some((row) => row.item_id === "RM004" && row.exception_reasons.includes("EXCESS_COVERAGE")));
  assert.ok(result.rows.some((row) => row.item_id === "RM009" && row.exception_reasons.includes("NO_CONSUMPTION")));
});

test("as-of date excludes later inventory movements", () => {
  const january = analyzeInventoryStatus({ asOfDate: "2026-01-31", itemTypes: ["RAW_MATERIAL"] });
  const latest = analyzeInventoryStatus({ itemTypes: ["RAW_MATERIAL"] });
  const januaryTotal = january.rows.reduce((sum, row) => sum + row.inferred_balance_qty, 0);
  const latestTotal = latest.rows.reduce((sum, row) => sum + row.inferred_balance_qty, 0);
  assert.ok(januaryTotal < latestTotal);
});
