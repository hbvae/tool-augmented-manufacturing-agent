import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DataToolError } from "./database.mjs";
import { downloadPythonSandboxFile } from "./aio_sandbox.mjs";
import { prepareSandboxDataset } from "./sandbox_dataset.mjs";
import { analyzeSandboxDataset } from "./sandbox_analysis.mjs";
import { generateSandboxReport } from "./sandbox_report.mjs";

function safeId(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(String(value || ""))) {
    throw new DataToolError("INVALID_SANDBOX_WORKFLOW_ID", `${label} 只能包含字母、数字、点、下划线和短横线，最长80个字符。`);
  }
  return String(value);
}

function relativeSandboxPath(file) {
  const prefix = "/home/gem/workspace/";
  if (typeof file !== "string" || !file.startsWith(prefix)) {
    throw new DataToolError("INVALID_WORKFLOW_OUTPUT_PATH", "工作流输出不在允许的沙箱工作区内。", { file });
  }
  return file.slice(prefix.length);
}

function stageError(stage, error, workflowId, completedStages) {
  if (error instanceof DataToolError) {
    return new DataToolError("SANDBOX_WORKFLOW_FAILED", `沙箱分析工作流在 ${stage} 阶段失败：${error.message}`, {
      workflowId,
      failedStage: stage,
      completedStages,
      cause: { code: error.code, message: error.message, details: error.details },
    });
  }
  return new DataToolError("SANDBOX_WORKFLOW_FAILED", `沙箱分析工作流在 ${stage} 阶段失败。`, {
    workflowId,
    failedStage: stage,
    completedStages,
    cause: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) },
  });
}

export async function runSandboxAnalysisWorkflow(input = {}) {
  const workflowId = safeId(input.workflowId || `workflow-${crypto.randomUUID().slice(0, 8)}`, "workflowId");
  const datasetId = safeId(input.datasetId || `${workflowId}-dataset`, "datasetId");
  const resultId = safeId(input.resultId || `${workflowId}-result`, "resultId");
  const reportId = safeId(input.reportId || `${workflowId}-report`, "reportId");
  const completedStages = [];
  const timings = {};

  const runStage = async (name, operation) => {
    const started = Date.now();
    try {
      const value = await operation();
      timings[name] = Date.now() - started;
      completedStages.push(name);
      return value;
    } catch (error) {
      timings[name] = Date.now() - started;
      throw stageError(name, error, workflowId, completedStages);
    }
  };

  const dataset = await runStage("prepare_dataset", () => prepareSandboxDataset({
    table: input.table,
    columns: input.columns,
    filters: input.filters,
    orderBy: input.orderBy,
    limit: input.limit,
    offset: input.offset,
    format: input.format,
    datasetId,
    previewRows: input.previewRows,
    dateColumn: input.sourceDateColumn ?? input.dateColumn,
  }));

  if (!dataset.rowCount) {
    return {
      workflowId,
      status: "insufficient_data",
      completedStages,
      ids: { datasetId, resultId, reportId },
      dataset,
      analysis: null,
      report: null,
      downloads: [],
      sandboxFiles: [...new Set([dataset.sandboxFile, dataset.manifestFile].filter(Boolean))],
      localFiles: [],
      timingsMs: { ...timings, total: Object.values(timings).reduce((sum, value) => sum + value, 0) },
      provenance: {
        table: dataset.source.table,
        filters: dataset.source.filters,
        rowCount: 0,
        datasetSha256: dataset.sha256,
        databaseReadOnly: true,
        governedPythonTemplates: true,
        arbitraryCodeAccepted: false,
      },
      dataQualityNotes: [...(dataset.dataQualityNotes || []), "筛选条件未返回数据，已跳过分析、图表和报告阶段。"],
      nextStep: "请调整日期范围或筛选条件；系统不会为无数据结果生成空图表。",
    };
  }

  const analysis = await runStage("analyze_dataset", () => analyzeSandboxDataset({
    datasetId,
    analysisType: input.analysisType,
    resultId,
    groupBy: input.groupBy,
    metrics: input.metrics,
    dateColumn: input.dateColumn,
    valueColumns: input.valueColumns,
    aggregation: input.aggregation,
    frequency: input.frequency,
    numericColumns: input.numericColumns,
    correlationMethod: input.correlationMethod,
    outlierMethod: input.outlierMethod,
    threshold: input.threshold,
    maxResultRows: input.maxResultRows,
    timeoutSeconds: input.analysisTimeoutSeconds,
  }));

  const report = await runStage("generate_report", () => generateSandboxReport({
    resultId,
    analysisType: input.analysisType,
    reportId,
    title: input.title,
    chartType: input.chartType,
    xColumn: input.xColumn,
    yColumns: input.yColumns,
    maxChartRows: input.maxChartRows,
    includeDataTable: input.includeDataTable,
    derivedMetrics: input.derivedMetrics,
    sourceTable: dataset.source.table,
    sourceFilters: dataset.source.filters,
    sourceColumns: dataset.columns,
    sourceRowCount: dataset.rowCount,
    sourceTotalRows: dataset.totalMatchingRows,
    sourceTruncated: dataset.truncated,
    metricDefinitions: input.metricDefinitions,
    dataRange: dataset.observedDataRange ?? input.dataRange,
    dataQualityNotes: dataset.dataQualityNotes,
    timeoutSeconds: input.reportTimeoutSeconds,
  }));

  const downloads = [];
  if (input.downloadOutputs !== false) {
    const files = input.downloadAnalysisFiles
      ? [...analysis.sandboxFiles, ...report.sandboxFiles]
      : report.sandboxFiles;
    await runStage("download_outputs", async () => {
      for (const file of files) {
        const extension = path.posix.extname(file);
        const base = path.posix.basename(file, extension);
        const fileName = `${base}-${crypto.randomUUID().slice(0, 8)}${extension}`;
        downloads.push(await downloadPythonSandboxFile({ relativePath: relativeSandboxPath(file), fileName }));
      }
      const localNames = new Map(downloads.map((item) => [path.posix.basename(item.source), path.basename(item.file)]));
      for (const item of downloads.filter((download) => path.extname(download.file).toLowerCase() === ".md")) {
        let markdown = fs.readFileSync(item.file, "utf8");
        for (const [sourceName, localName] of localNames) markdown = markdown.replaceAll(`](${sourceName})`, `](${localName})`);
        fs.writeFileSync(item.file, markdown, "utf8");
        const bytes = fs.readFileSync(item.file);
        item.bytes = bytes.length;
        item.sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      }
      return downloads;
    });
  }

  return {
    workflowId,
    status: "completed",
    completedStages,
    ids: { datasetId, resultId, reportId },
    dataset,
    analysis,
    report,
    downloads,
    sandboxFiles: [...new Set([dataset.sandboxFile, dataset.manifestFile, ...analysis.sandboxFiles, ...report.sandboxFiles])],
    localFiles: downloads.map((item) => item.file),
    timingsMs: { ...timings, total: Object.values(timings).reduce((sum, value) => sum + value, 0) },
    provenance: {
      table: dataset.source.table,
      filters: dataset.source.filters,
      rowCount: dataset.rowCount,
      observedDataRange: dataset.observedDataRange,
      datasetSha256: dataset.sha256,
      databaseReadOnly: true,
      governedPythonTemplates: true,
      arbitraryCodeAccepted: false,
    },
    dataQualityNotes: dataset.dataQualityNotes,
    nextStep: downloads.length
      ? "报告已下载到 MCP 服务的 exports 目录，可直接打开 Markdown 或 PNG 文件。"
      : "报告保存在沙箱中；可使用 download_python_sandbox_file 下载 sandboxFiles 中的文件。",
  };
}
