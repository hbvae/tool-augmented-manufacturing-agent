import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeSupplierInventoryRisk,
  analyzeMachine360,
  analyzeProduct360,
  compareMachineMonthlyPerformance,
  findCrossDomainRisks,
  getCrossDomainTrend,
  getManufacturingOverview,
  traceWorkOrder,
} from "../src/cross_domain.mjs";
import { DataToolError } from "../src/database.mjs";

test("manufacturing overview reconciles domain highlights", () => {
  const result = getManufacturingOverview({});
  assert.equal(result.highlights.actual_qty, 91696);
  assert.equal(result.highlights.quality_pass_rate, 0.9264);
  assert.equal(result.highlights.equipment_oee, 0.9257);
  assert.equal(result.highlights.electricity_kwh, 98379.94);
});

test("machine 360 joins four machine domains and exposes risk drivers", () => {
  const result = analyzeMachine360({});
  assert.equal(result.rows.length, 8);
  assert.deepEqual(result.rows.slice(0, 3).map((row) => row.machine_id), ["M03", "M07", "M08"]);
  assert.deepEqual(result.rows.slice(0, 3).map((row) => row.risk_score), [3, 3, 2]);
  assert.equal(result.rows[0].risk_score, 3);
  assert.equal(result.rows.find((row) => row.machine_id === "M07").quality.fail_rate, 0.1327);
  assert.deepEqual(result.thresholds, {
    scrapRateAbove: 0.03,
    qualityFailRateAbove: 0.1,
    unplannedDowntimeAboveMin: 600,
    availabilityBelow: 0.9,
    oeeBelow: 0.85,
    energyPerRuntimeHourAbove: 25,
  });
  assert.deepEqual(result.dataTimeRange, {
    dateFrom: "2026-01-01",
    dateTo: "2026-06-30",
    sourceDomains: ["production", "quality", "downtime", "energy"],
  });
});

test("machine 360 reports the observed range after date and machine filters", () => {
  const result = analyzeMachine360({
    machineIds: ["M03"], dateFrom: "2026-02-01", dateTo: "2026-04-30",
  });
  assert.deepEqual(result.dataTimeRange, {
    dateFrom: "2026-02-01",
    dateTo: "2026-04-30",
    sourceDomains: ["production", "quality", "downtime", "energy"],
  });
  assert.deepEqual(result.rows.map((row) => row.machine_id), ["M03"]);
});

test("monthly machine comparison aligns production quality downtime OEE and energy", () => {
  const result = compareMachineMonthlyPerformance({ machineIds: ["M03", "M07"] });
  assert.equal(result.rows.length, 12);
  assert.deepEqual([...new Set(result.rows.map((row) => row.machine_id))], ["M03", "M07"]);
  assert.equal(result.rows[0].period, "2026-01");
  for (const field of ["actual_qty", "plan_completion_rate", "scrap_rate", "quality_fail_rate", "unplanned_downtime_min", "oee", "kwh_per_good_unit"]) {
    assert.notEqual(result.rows[0][field], null, `missing ${field}`);
  }
  assert.equal(result.rows.find((row) => row.machine_id === "M03" && row.period === "2026-04").oee, 0.3516);
  assert.equal(result.resultTruncated, false);
});

test("supplier inventory risk links preferred materials without inventing current shortages", () => {
  const result = analyzeSupplierInventoryRisk({ lookbackDays: 180 });
  assert.equal(result.rows[0].supplier_id, "S004");
  assert.equal(result.rows[0].combined_quality_supply_risk, true);
  assert.ok(result.rows[0].preferred_materials.some((item) => item.material_id === "RM002"));
  assert.equal(result.inventoryOverview.low_coverage_count, 0);
  assert.equal(result.inventoryOverview.negative_balance_count, 0);
  assert.equal(result.rankings.highest_purchase_spend_supplier.supplier_id, "S003");
  assert.equal(result.rankings.purchase_spend_desc[0].purchase_spend_cny, 3555817.04);
});

test("product 360 joins production, quality, inventory, and related equipment", () => {
  const result = analyzeProduct360({});
  assert.equal(result.rows.length, 8);
  assert.equal(result.rows[0].product_id, "P007");
  assert.equal(result.rows[0].production.actual_qty, 12332);
  assert.notEqual(result.rows[0].inventory.inferred_balance_qty, null);
  assert.equal(result.dataTimeRange.dateFrom, "2026-01-01");
  assert.equal(result.dataTimeRange.dateTo, "2026-06-30");
  assert.equal(result.rows[0].relatedEquipment.machine_count, 8);
  assert.ok(result.rows[0].relatedEquipment.machines.some((row) => row.machine_id === "M03" && row.machine_risk_score === 3));
});

test("cross-domain monthly trend aligns six domains", () => {
  const result = getCrossDomainTrend({ grain: "month" });
  assert.equal(result.rows.length, 6);
  assert.equal(result.rows[0].period, "2026-01");
  for (const domain of ["production", "quality", "equipment", "energy", "supplier", "inventory"]) assert.ok(result.rows[0][domain]);
});

test("work-order trace follows direct quality, downtime, and inventory links", () => {
  const result = traceWorkOrder({ orderId: "WO00001" });
  assert.equal(result.order.order_id, "WO00001");
  assert.equal(result.summaries.quality.inspection_count, 2);
  assert.equal(result.summaries.downtime.event_count, 1);
  assert.equal(result.summaries.inventory.transaction_count, 3);
});

test("work-order trace rejects unknown orders", () => {
  assert.throws(() => traceWorkOrder({ orderId: "WO-NOT-FOUND" }), (error) => error instanceof DataToolError && error.code === "ORDER_NOT_FOUND");
});

test("cross-domain risks identify M03 and M07 at score three", () => {
  const result = findCrossDomainRisks({ minimumRiskScore: 3 });
  assert.deepEqual(result.rows.map((row) => row.machine_id), ["M03", "M07"]);
});
