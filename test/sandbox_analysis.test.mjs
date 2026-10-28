import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { analyzeSandboxDataset } from "../src/sandbox_analysis.mjs";

const requests = [];
const manifest = {
  datasetId: "production-analysis-test",
  format: "csv",
  file: "/home/gem/workspace/datasets/production-analysis-test.csv",
  rowCount: 50,
  sha256: "abc123",
  columns: ["machine_id", "actual_qty", "scrap_qty", "start_time"].map((name) => ({ name })),
  source: { table: "production_orders" },
  dataQualityNotes: [],
};

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const body = raw ? JSON.parse(raw) : {};
  requests.push({ url: req.url, body });
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/v1/file/read") {
    return res.end(JSON.stringify({ success: true, data: { file: body.file, content: JSON.stringify(manifest), line_count: 1 } }));
  }
  if (req.url === "/v1/jupyter/sessions/create") {
    return res.end(JSON.stringify({ success: true, data: { session_id: body.session_id, kernel_name: "python3", state: "ready" } }));
  }
  if (req.method === "DELETE" && req.url.startsWith("/v1/jupyter/sessions/")) {
    return res.end(JSON.stringify({ success: true, data: { deleted: true } }));
  }
  if (req.url === "/v1/jupyter/execute") {
    const payload = {
      summary: { group_count: 2, preview: [{ machine_id: "M07", total_actual: 1000, total_scrap: 80 }] },
      files: ["/home/gem/workspace/outputs/group-result.json", "/home/gem/workspace/outputs/group-result.csv"],
    };
    return res.end(JSON.stringify({ success: true, data: {
      status: "ok", kernel_name: "python3", execution_count: 1,
      outputs: [{ output_type: "stream", name: "stdout", text: `__MCP_ANALYSIS_RESULT__${JSON.stringify(payload)}\n` }],
    } }));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ success: false, message: "not found" }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.MANUFACTURING_AIO_BASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.MANUFACTURING_AIO_API_KEY = "analysis-test-key";
test.after(() => new Promise((resolve) => server.close(resolve)));

test("runs governed grouped analysis and returns bounded structured output", async () => {
  const result = await analyzeSandboxDataset({
    datasetId: "production-analysis-test",
    analysisType: "group_summary",
    resultId: "group-result",
    groupBy: ["machine_id"],
    metrics: [
      { field: "actual_qty", aggregation: "sum", alias: "total_actual" },
      { field: "scrap_qty", aggregation: "sum", alias: "total_scrap" },
    ],
  });
  assert.equal(result.analysisType, "group_summary");
  assert.equal(result.summary.group_count, 2);
  assert.equal(result.source.table, "production_orders");
  assert.equal(result.sandboxFiles.length, 2);
  assert.equal(result.execution.status, "ok");
  const execute = requests.find((request) => request.url === "/v1/jupyter/execute");
  assert.ok(execute.body.code.includes("pd.NamedAgg"));
  assert.equal(execute.body.code.includes("total_actual"), false, "user-controlled fields should be base64 encoded rather than interpolated into code");
});

test("rejects unknown analysis columns before Python execution", async () => {
  const executionsBefore = requests.filter((request) => request.url === "/v1/jupyter/execute").length;
  await assert.rejects(
    () => analyzeSandboxDataset({
      datasetId: "production-analysis-test",
      analysisType: "outlier",
      numericColumns: ["not_a_column"],
    }),
    (error) => error.code === "UNKNOWN_ANALYSIS_COLUMN",
  );
  assert.equal(requests.filter((request) => request.url === "/v1/jupyter/execute").length, executionsBefore);
});

test("requires metrics for grouped analysis", async () => {
  await assert.rejects(
    () => analyzeSandboxDataset({ datasetId: "production-analysis-test", analysisType: "group_summary", groupBy: ["machine_id"], metrics: [] }),
    (error) => error.code === "MISSING_ANALYSIS_METRICS",
  );
});
