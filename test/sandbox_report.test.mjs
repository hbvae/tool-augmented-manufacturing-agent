import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { generateSandboxReport } from "../src/sandbox_report.mjs";

const requests = [];
const summary = {
  group_count: 2,
  preview: [
    { machine_id: "M03", total_actual: 1200, total_scrap: 30 },
    { machine_id: "M07", total_actual: 1100, total_scrap: 80 },
  ],
};

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const body = raw ? JSON.parse(raw) : {};
  requests.push({ url: req.url, body });
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/v1/file/read") {
    return res.end(JSON.stringify({ success: true, data: { file: body.file, content: JSON.stringify(summary), line_count: 1 } }));
  }
  if (req.url === "/v1/jupyter/sessions/create") {
    return res.end(JSON.stringify({ success: true, data: { session_id: body.session_id, kernel_name: "python3", state: "ready" } }));
  }
  if (req.method === "DELETE" && req.url.startsWith("/v1/jupyter/sessions/")) {
    return res.end(JSON.stringify({ success: true, data: { deleted: true } }));
  }
  if (req.url === "/v1/jupyter/execute") {
    const encoded = body.code.match(/base64\.b64decode\('([^']+)'\)/)?.[1];
    const config = encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) : { chartType: "bar", title: "设备产量分析" };
    const payload = {
      manifest: {
        reportId: config.reportId, resultId: config.resultId, analysisType: config.analysisType, chartType: config.chartType,
        title: config.title, markdownFile: `/home/gem/workspace/outputs/${config.reportId}.md`,
        chartFile: config.chartType === "none" ? null : `/home/gem/workspace/outputs/${config.reportId}.png`,
        sourceSummaryFile: "/home/gem/workspace/outputs/machine-summary.json",
        sourceCsvFile: "/home/gem/workspace/outputs/machine-summary.csv",
      },
      files: [`/home/gem/workspace/outputs/${config.reportId}.md`, `/home/gem/workspace/outputs/${config.reportId}.report.json`, ...(config.chartType === "none" ? [] : [`/home/gem/workspace/outputs/${config.reportId}.png`])],
    };
    return res.end(JSON.stringify({ success: true, data: {
      status: "ok", kernel_name: "python3", execution_count: 1,
      outputs: [{ output_type: "stream", name: "stdout", text: `__MCP_REPORT_RESULT__${JSON.stringify(payload)}\n` }],
    } }));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ success: false, message: "not found" }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.MANUFACTURING_AIO_BASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.MANUFACTURING_AIO_API_KEY = "report-test-key";
test.after(() => new Promise((resolve) => server.close(resolve)));

test("generates a governed report with automatic bar chart", async () => {
  const result = await generateSandboxReport({
    resultId: "machine-summary",
    analysisType: "group_summary",
    reportId: "machine-report",
    title: "设备产量分析",
    chartType: "auto",
  });
  assert.equal(result.chartType, "bar");
  assert.equal(result.sandboxFiles.length, 3);
  assert.equal(result.execution.status, "ok");
  const execute = requests.find((request) => request.url === "/v1/jupyter/execute");
  assert.ok(execute.body.code.includes("matplotlib.use('Agg')"));
  assert.ok(execute.body.code.includes("Noto Sans CJK JP"));
  assert.ok(execute.body.code.includes("axes.unicode_minus"));
  assert.equal(execute.body.code.includes("设备产量分析"), false, "title should be encoded rather than interpolated into Python");
});

test("report program adds governed sections and a derived rate on a secondary axis", async () => {
  await generateSandboxReport({
    resultId: "machine-summary",
    analysisType: "group_summary",
    reportId: "machine-governed-report",
    title: "设备生产分析",
    chartType: "bar",
    xColumn: "machine_id",
    yColumns: ["total_actual", "total_scrap", "scrap_rate"],
    derivedMetrics: [{ alias: "scrap_rate", numerator: "total_scrap", denominator: "total_actual", multiplier: 1 }],
    sourceTable: "production_orders",
    sourceFilters: [],
    metricDefinitions: { scrap_rate: "total_scrap / total_actual" },
    dataRange: { dateFrom: null, dateTo: null, note: "全部记录" },
  });
  const execute = requests.filter((request) => request.url === "/v1/jupyter/execute").at(-1);
  assert.match(execute.body.code, /derivedMetrics/);
  assert.match(execute.body.code, /twinx/);
  assert.match(execute.body.code, /PercentFormatter/);
  assert.match(execute.body.code, /bbox_to_anchor/);
  assert.match(execute.body.code, /数量（件）/);
  assert.match(execute.body.code, /display_headers/);
  assert.match(execute.body.code, /无额外筛选条件/);
  assert.match(execute.body.code, /详细分析结果见下方数据表/);
  assert.match(execute.body.code, /float\(value\) \* 100/);
  assert.match(execute.body.code, /## 数据范围/);
  assert.match(execute.body.code, /## 数据质量提示/);
});

test("rejects chart columns not present in analysis result", async () => {
  const executionCount = requests.filter((request) => request.url === "/v1/jupyter/execute").length;
  await assert.rejects(
    () => generateSandboxReport({
      resultId: "machine-summary", analysisType: "group_summary", reportId: "invalid-report",
      chartType: "bar", xColumn: "machine_id", yColumns: ["missing_metric"],
    }),
    (error) => error.code === "UNKNOWN_REPORT_COLUMN",
  );
  assert.equal(requests.filter((request) => request.url === "/v1/jupyter/execute").length, executionCount);
});

test("profile reports allow chart-free markdown output", async () => {
  const profileSummary = { row_count: 10, column_count: 3, columns: [] };
  const original = summary.preview;
  delete summary.preview;
  Object.assign(summary, profileSummary);
  const result = await generateSandboxReport({ resultId: "machine-profile", analysisType: "profile", reportId: "profile-report", chartType: "auto" });
  assert.equal(result.chartType, "none");
  assert.equal(result.sandboxFiles.length, 2);
  summary.preview = original;
});

test("empty analysis results downgrade automatic chart to a chart-free report", async () => {
  const original = summary.preview;
  summary.preview = [];
  const result = await generateSandboxReport({
    resultId: "empty-summary", analysisType: "group_summary", reportId: "empty-report", chartType: "auto",
  });
  assert.equal(result.chartType, "none");
  assert.equal(result.sandboxFiles.length, 2);
  summary.preview = original;
});
