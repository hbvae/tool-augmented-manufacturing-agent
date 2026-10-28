import assert from "node:assert/strict";
import test from "node:test";
import {
  DataToolError,
  aggregateMetrics,
  describeTable,
  getDatasetInfo,
  listTables,
  previewData,
  queryRecords,
  runReadOnlySql,
} from "../src/database.mjs";

test("dataset and schema discovery", () => {
  const info = getDatasetInfo();
  assert.equal(info.readOnly, true);
  assert.ok(info.totalRows > 4000);
  assert.ok(listTables().some((item) => item.name === "production_orders"));
  const table = describeTable("production_orders");
  assert.equal(table.rowCount, 360);
  assert.ok(table.columns.some((column) => column.name === "scrap_qty"));
});

test("preview and filtered pagination", () => {
  const preview = previewData({ table: "machines", limit: 3, offset: 0 });
  assert.equal(preview.rows.length, 3);
  assert.equal(preview.rows[0].machine_id, "M01");
  const result = queryRecords({
    table: "production_orders", columns: ["order_id", "machine_id", "shift", "scrap_qty"],
    filters: [{ field: "machine_id", operator: "eq", value: "M07" }, { field: "shift", operator: "eq", value: "B" }],
    orderBy: [{ field: "scrap_qty", direction: "desc" }], limit: 5, offset: 0,
  });
  assert.equal(result.rows.length, 5);
  assert.ok(result.rows.every((row) => row.machine_id === "M07" && row.shift === "B"));
  assert.equal(result.page.hasMore, true);
});

test("aggregations expose designed manufacturing pattern", () => {
  const result = aggregateMetrics({
    table: "production_orders", dimensions: ["machine_id"],
    metrics: [
      { field: "actual_qty", aggregation: "sum", alias: "actual_qty" },
      { field: "scrap_qty", aggregation: "sum", alias: "scrap_qty" },
    ], orderBy: [{ field: "scrap_qty", direction: "desc" }], limit: 20,
  });
  assert.ok(result.rows.find((row) => row.machine_id === "M07").scrap_qty > 300);
});

test("read-only SQL works and writes are rejected", () => {
  const result = runReadOnlySql({ sql: "SELECT machine_id, SUM(duration_min) AS downtime FROM downtime_events GROUP BY machine_id ORDER BY downtime DESC", limit: 3 });
  assert.equal(result.rows[0].machine_id, "M03");
  assert.throws(() => runReadOnlySql({ sql: "DELETE FROM machines" }), (error) => error instanceof DataToolError && error.code === "READ_ONLY_REQUIRED");
  assert.throws(() => runReadOnlySql({ sql: "SELECT * FROM machines; SELECT * FROM products" }), (error) => error instanceof DataToolError && error.code === "UNSAFE_SQL");
});

test("unknown fields are rejected", () => {
  assert.throws(() => queryRecords({ table: "machines", columns: ["not_a_field"] }), (error) => error instanceof DataToolError && error.code === "UNKNOWN_FIELD");
  assert.throws(() => queryRecords({ table: "machines", filters: [{ field: "status", operator: "eq" }] }), (error) => error instanceof DataToolError && error.code === "INVALID_FILTER_VALUE");
});
