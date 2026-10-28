import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { runSandboxAnalysisWorkflow } from "../src/sandbox_workflow.mjs";
import { runNaturalLanguageSandboxAnalysis } from "../src/sandbox_natural_language.mjs";

const files = new Map();
const requests = [];
const localTestFiles = [];

function decodeConfig(code) {
  const encoded = code.match(/base64\.b64decode\('([^']+)'\)/)?.[1];
  return encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) : {};
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
  requests.push({ url: req.url, body });

  if (req.url === "/v1/file/write") {
    files.set(body.file, body.content);
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: true, data: { file: body.file, bytes_written: Buffer.byteLength(body.content, "utf8") } }));
  }
  if (req.url === "/v1/file/read") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: true, data: { file: body.file, content: files.get(body.file), line_count: 1 } }));
  }
  if (req.url === "/v1/jupyter/sessions/create") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: true, data: { session_id: body.session_id, kernel_name: "python3", state: "ready" } }));
  }
  if (req.method === "DELETE" && req.url.startsWith("/v1/jupyter/sessions/")) {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: true, data: { deleted: true } }));
  }
  if (req.url === "/v1/jupyter/execute") {
    const config = decodeConfig(body.code);
    let marker;
    let payload;
    if (body.code.includes("__MCP_ANALYSIS_RESULT__")) {
      const summary = { group_count: 1, preview: [{ machine_id: "M07", total_actual: 1000, total_scrap: 80 }] };
      const jsonFile = `${config.resultBase}.json`;
      const csvFile = `${config.resultBase}.csv`;
      files.set(jsonFile, JSON.stringify(summary));
      files.set(csvFile, "machine_id,total_actual,total_scrap\nM07,1000,80\n");
      marker = "__MCP_ANALYSIS_RESULT__";
      payload = { summary, files: [jsonFile, csvFile] };
    } else {
      const mdFile = `${config.reportBase}.md`;
      const manifestFile = `${config.reportBase}.report.json`;
      const chartFile = `${config.reportBase}.png`;
      const manifest = {
        reportId: config.reportId, resultId: config.resultId, analysisType: config.analysisType,
        chartType: config.chartType, title: config.title, markdownFile: mdFile, chartFile,
        sourceSummaryFile: config.summaryFile, sourceCsvFile: config.csvFile,
      };
      files.set(mdFile, `# Test report\n\n![chart](${path.posix.basename(chartFile)})\n`);
      files.set(manifestFile, JSON.stringify(manifest));
      files.set(chartFile, "fake-png");
      marker = "__MCP_REPORT_RESULT__";
      payload = { manifest, files: [mdFile, manifestFile, chartFile] };
    }
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: true, data: {
      status: "ok", kernel_name: "python3", execution_count: 1,
      outputs: [{ output_type: "stream", name: "stdout", text: `${marker}${JSON.stringify(payload)}\n` }],
    } }));
  }
  if (req.url.startsWith("/v1/file/download?")) {
    const source = new URL(req.url, "http://localhost").searchParams.get("path");
    const content = files.get(source) || "download";
    res.setHeader("Content-Type", "application/octet-stream");
    return res.end(content);
  }
  res.statusCode = 404;
  res.end("not found");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.MANUFACTURING_AIO_BASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.MANUFACTURING_AIO_API_KEY = "workflow-test-key";
test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => {
  for (const file of localTestFiles) fs.rmSync(file, { force: true });
});

test("runs prepare, analysis, report, and download as one governed workflow", async () => {
  const result = await runSandboxAnalysisWorkflow({
    workflowId: "workflow-success-test",
    table: "production_orders",
    columns: ["machine_id", "actual_qty", "scrap_qty"],
    filters: [{ field: "machine_id", operator: "eq", value: "M07" }],
    limit: 3,
    analysisType: "group_summary",
    groupBy: ["machine_id"],
    metrics: [
      { field: "actual_qty", aggregation: "sum", alias: "total_actual" },
      { field: "scrap_qty", aggregation: "sum", alias: "total_scrap" },
    ],
    title: "M07 production report",
    chartType: "auto",
    downloadOutputs: true,
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.completedStages, ["prepare_dataset", "analyze_dataset", "generate_report", "download_outputs"]);
  assert.equal(result.ids.datasetId, "workflow-success-test-dataset");
  assert.equal(result.analysis.summary.group_count, 1);
  assert.equal(result.report.chartType, "bar");
  assert.equal(result.downloads.length, 3);
  assert.equal(result.localFiles.length, 3);
  const markdownFile = result.localFiles.find((file) => file.endsWith(".md"));
  const pngFile = result.localFiles.find((file) => file.endsWith(".png"));
  assert.ok(fs.readFileSync(markdownFile, "utf8").includes(`](${path.basename(pngFile)})`));
  localTestFiles.push(...result.localFiles);
  assert.equal(result.provenance.databaseReadOnly, true);
  assert.equal(result.provenance.arbitraryCodeAccepted, false);
});

test("reports the failed stage and does not run report generation", async () => {
  const executionsBefore = requests.filter((request) => request.url === "/v1/jupyter/execute").length;
  await assert.rejects(
    () => runSandboxAnalysisWorkflow({
      workflowId: "workflow-failure-test",
      table: "production_orders",
      columns: ["machine_id", "actual_qty"],
      analysisType: "group_summary",
      groupBy: ["missing_column"],
      metrics: [{ field: "actual_qty", aggregation: "sum", alias: "total_actual" }],
      downloadOutputs: false,
    }),
    (error) => error.code === "SANDBOX_WORKFLOW_FAILED"
      && error.details.failedStage === "analyze_dataset"
      && error.details.cause.code === "UNKNOWN_ANALYSIS_COLUMN"
      && error.details.completedStages.includes("prepare_dataset"),
  );
  assert.equal(requests.filter((request) => request.url === "/v1/jupyter/execute").length, executionsBefore);
});

test("returns insufficient data without running analysis or report", async () => {
  const executionsBefore = requests.filter((request) => request.url === "/v1/jupyter/execute").length;
  const result = await runSandboxAnalysisWorkflow({
    workflowId: "workflow-empty-test",
    table: "production_orders",
    columns: ["machine_id", "actual_qty"],
    filters: [{ field: "machine_id", operator: "eq", value: "M99" }],
    analysisType: "group_summary",
    groupBy: ["machine_id"],
    metrics: [{ field: "actual_qty", aggregation: "sum", alias: "total_actual" }],
    downloadOutputs: false,
  });
  assert.equal(result.status, "insufficient_data");
  assert.deepEqual(result.completedStages, ["prepare_dataset"]);
  assert.equal(result.provenance.rowCount, 0);
  assert.equal(result.analysis, null);
  assert.equal(result.report, null);
  assert.equal(requests.filter((request) => request.url === "/v1/jupyter/execute").length, executionsBefore);
});

test("executes the complete workflow from a natural-language request", async () => {
  const result = await runNaturalLanguageSandboxAnalysis({
    question: "分析M07设备的实际产量和报废数量，按设备汇总并生成柱状图",
    workflowId: "natural-workflow-test",
    limit: 3,
    downloadOutputs: false,
  });
  assert.equal(result.status, "ready");
  assert.equal(result.executed, true);
  assert.equal(result.interpretation.domain, "production");
  assert.equal(result.workflow.status, "completed");
  assert.deepEqual(result.workflow.completedStages, ["prepare_dataset", "analyze_dataset", "generate_report"]);
  assert.equal(result.workflow.ids.datasetId, "natural-workflow-test-dataset");
  assert.equal(result.workflow.report.chartType, "bar");
});
