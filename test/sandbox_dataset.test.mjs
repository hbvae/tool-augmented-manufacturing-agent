import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { prepareSandboxDataset } from "../src/sandbox_dataset.mjs";

const writes = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  writes.push(body);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ success: true, data: { file: body.file, bytes_written: Buffer.byteLength(body.content, "utf8") } }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.MANUFACTURING_AIO_BASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.MANUFACTURING_AIO_API_KEY = "dataset-test-key";
test.after(() => new Promise((resolve) => server.close(resolve)));

test("prepares a filtered CSV and provenance manifest directly in sandbox", async () => {
  const result = await prepareSandboxDataset({
    table: "production_orders",
    columns: ["order_id", "machine_id", "actual_qty", "scrap_qty"],
    filters: [{ field: "machine_id", operator: "eq", value: "M07" }],
    orderBy: [{ field: "scrap_qty", direction: "desc" }],
    limit: 3,
    datasetId: "m07-production-test",
    previewRows: 2,
  });
  assert.equal(result.datasetId, "m07-production-test");
  assert.equal(result.rowCount, 3);
  assert.equal(result.preview.length, 2);
  assert.equal(result.preview.every((row) => row.machine_id === "M07"), true);
  assert.equal(result.sandboxFile, "/home/gem/workspace/datasets/m07-production-test.csv");
  assert.equal(result.manifestFile, "/home/gem/workspace/datasets/m07-production-test.manifest.json");
  assert.equal(result.truncated, true);
  assert.equal(writes.length, 2);
  const csv = writes.find((write) => write.file.endsWith(".csv"));
  const manifest = writes.find((write) => write.file.endsWith(".manifest.json"));
  assert.match(csv.content, /^order_id,machine_id,actual_qty,scrap_qty\r\n/);
  const parsedManifest = JSON.parse(manifest.content);
  assert.equal(parsedManifest.source.mode, "validated_table_query");
  assert.equal(parsedManifest.source.table, "production_orders");
  assert.equal(parsedManifest.security.databaseReadOnly, true);
  assert.equal(parsedManifest.sha256, result.sha256);
});

test("supports JSON datasets and validates database fields before upload", async () => {
  const before = writes.length;
  const result = await prepareSandboxDataset({
    table: "machines",
    columns: ["machine_id", "machine_type", "status"],
    format: "json",
    datasetId: "machines-json-test",
    limit: 2,
    previewRows: 0,
  });
  assert.equal(result.format, "json");
  assert.equal(result.rowCount, 2);
  assert.equal(result.preview.length, 0);
  assert.equal(writes.length, before + 2);
  await assert.rejects(
    () => prepareSandboxDataset({ table: "machines", columns: ["password"], datasetId: "invalid-test" }),
    (error) => error.code === "UNKNOWN_FIELD",
  );
  assert.equal(writes.length, before + 2);
});

test("records the observed source date range for reports", async () => {
  const result = await prepareSandboxDataset({
    table: "production_orders",
    columns: ["machine_id", "actual_start", "actual_qty"],
    dateColumn: "actual_start",
    datasetId: "production-range-test",
    limit: 500,
  });
  assert.equal(result.observedDataRange.column, "actual_start");
  assert.equal(result.observedDataRange.start, "2026-01-01");
  assert.equal(result.observedDataRange.end, "2026-06-29");
});
