import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DataToolError, exportDir } from "./database.mjs";
import { getManufacturingOverview, analyzeMachine360 } from "./cross_domain.mjs";
import { predictMaintenanceRisk, rankRootCauseCandidates } from "./advanced_analysis.mjs";

function artifactToolModulePath() {
  if (process.env.MANUFACTURING_ARTIFACT_TOOL_MODULE) return path.resolve(process.env.MANUFACTURING_ARTIFACT_TOOL_MODULE);
  return path.resolve(path.dirname(process.execPath), "..", "node_modules", "@oai", "artifact-tool", "dist", "artifact_tool.mjs");
}

async function loadArtifactTool() {
  const modulePath = artifactToolModulePath();
  if (!fs.existsSync(modulePath)) throw new DataToolError("XLSX_ENGINE_NOT_FOUND", "Excel export engine was not found", { modulePath, configuration: "Set MANUFACTURING_ARTIFACT_TOOL_MODULE" });
  return import(pathToFileURL(modulePath).href);
}

function safeCellValue(value) {
  if (typeof value === "string" && /^[=+\-@]/.test(value)) return `'${value}`;
  if (value === undefined || Number.isNaN(value)) return null;
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return value;
}

function flattenRow(row, prefix = "", output = {}) {
  for (const [key, value] of Object.entries(row ?? {})) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) flattenRow(value, name, output);
    else output[name] = safeCellValue(value);
  }
  return output;
}

function exportData(analysisType, input) {
  if (analysisType === "overview") {
    const source = getManufacturingOverview(input);
    return { title: "制造经营概览", rows: Object.entries(source.highlights).map(([metric, value]) => ({ metric, value })), source };
  }
  if (analysisType === "machine_risk") {
    const source = analyzeMachine360({ ...input, sortBy: "risk_score", direction: "desc", limit: input.limit });
    return { title: "设备综合风险", rows: source.rows.map((row) => flattenRow(row)), source };
  }
  if (analysisType === "maintenance") {
    const source = predictMaintenanceRisk(input);
    return { title: "预测性维护风险", rows: source.rows.map((row) => flattenRow(row)), source };
  }
  if (analysisType === "root_cause") {
    const source = rankRootCauseCandidates({ machineId: input.machineIds?.[0], dateFrom: input.dateFrom, dateTo: input.dateTo, limit: input.limit });
    return { title: `${source.machineId} 根因候选`, rows: source.rows.map((row) => flattenRow(row)), source };
  }
  throw new DataToolError("INVALID_ANALYSIS_TYPE", "analysisType must be overview, machine_risk, maintenance, or root_cause");
}

function columnName(index) {
  let value = index + 1; let result = "";
  while (value > 0) { value -= 1; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); }
  return result;
}

export async function exportAnalysisXlsx({ analysisType = "overview", fileName, dateFrom, dateTo, machineIds = [], lineIds = [], horizonDays = 30, limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const baseName = fileName || `${analysisType}_${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.xlsx`;
  if (!/^[A-Za-z0-9_.-]+\.xlsx$/i.test(baseName)) throw new DataToolError("INVALID_FILE_NAME", "fileName must be a simple .xlsx file name");
  const target = path.resolve(exportDir, baseName);
  if (path.dirname(target) !== exportDir) throw new DataToolError("INVALID_FILE_NAME", "Export path must stay inside the export directory");
  const input = { dateFrom, dateTo, machineIds, lineIds, horizonDays, limit: safeLimit };
  const { title, rows, source } = exportData(analysisType, input);
  const limitedRows = rows.slice(0, safeLimit);
  const { SpreadsheetFile, Workbook } = await loadArtifactTool();
  const workbook = Workbook.create();
  const summary = workbook.worksheets.add("Summary");
  const data = workbook.worksheets.add("Data");
  summary.showGridLines = false;
  data.showGridLines = false;
  summary.getRange("A2:F2").merge();
  summary.getRange("A2").values = [[title]];
  summary.getRange("A2").format = { font: { name: "Arial", size: 16, bold: true, color: "#17365D" } };
  summary.getRange("A4:B8").values = [
    ["分析类型", analysisType], ["数据开始", dateFrom ?? "数据起点"], ["数据结束", dateTo ?? "数据终点"],
    ["返回记录", limitedRows.length], ["生成时间", new Date()],
  ];
  summary.getRange("A4:A8").format = { fill: "#D9EAF7", font: { name: "Arial", bold: true, color: "#17365D" } };
  summary.getRange("B4:B8").format.font = { name: "Arial", size: 10 };
  summary.getRange("B8").format.numberFormat = "yyyy-mm-dd hh:mm:ss";
  summary.getRange("A4:B8").format.borders = { preset: "outside", style: "thin", color: "#A6A6A6" };
  summary.getRange("A10:B11").merge();
  summary.getRange("A10").values = [["说明：分析结果来源于只读制造数据库；预测性维护和根因候选属于风险筛查，不表示确定因果或失效概率。"]];
  summary.getRange("A10").format = { font: { name: "Arial", size: 10, italic: true, color: "#666666" }, wrapText: true };
  summary.getRange("A10:B11").format.verticalAlignment = "top";
  summary.getRange("A:A").format.columnWidth = 18;
  summary.getRange("B:B").format.columnWidth = 28;

  const headers = limitedRows.length ? [...new Set(limitedRows.flatMap((row) => Object.keys(row)))] : ["message"];
  const matrix = [headers, ...(limitedRows.length ? limitedRows.map((row) => headers.map((header) => safeCellValue(row[header]))) : [["所选条件下没有可导出的数据"]])];
  data.getRangeByIndexes(0, 0, matrix.length, headers.length).values = matrix;
  data.getRangeByIndexes(0, 0, 1, headers.length).format = { fill: "#1F4E78", font: { name: "Arial", bold: true, color: "#FFFFFF" }, horizontalAlignment: "center", verticalAlignment: "center" };
  data.getRangeByIndexes(1, 0, Math.max(matrix.length - 1, 1), headers.length).format.font = { name: "Arial", size: 10 };
  data.getRangeByIndexes(0, 0, matrix.length, headers.length).format.autofitColumns();
  for (let index = 0; index < headers.length; index += 1) {
    const column = data.getRange(`${columnName(index)}:${columnName(index)}`);
    if (/rate|oee|availability|utilization/i.test(headers[index])) column.format.numberFormat = "0.00%";
    if (/qty|count|minutes|min$|hours|kwh|score|value/i.test(headers[index])) column.format.numberFormat = "#,##0.00";
  }
  data.freezePanes.freezeRows(1);
  if (matrix.length > 1) {
    const table = data.tables.add(`A1:${columnName(headers.length - 1)}${matrix.length}`, true, "AnalysisData");
    table.style = "TableStyleMedium2";
    table.showFilterButton = true;
  }

  const categoryKey = analysisType === "maintenance" ? "machine_id" : analysisType === "machine_risk" ? "machine_id" : analysisType === "root_cause" ? "candidate" : "metric";
  const valueKey = analysisType === "maintenance" ? "risk_score" : analysisType === "machine_risk" ? "risk_score" : analysisType === "root_cause" ? "candidate_score" : "value";
  if (limitedRows.length && headers.includes(categoryKey) && headers.includes(valueKey)) {
    const chartRows = limitedRows.slice(0, 15).map((row) => [row[categoryKey], row[valueKey]]);
    const chartHeaders = analysisType === "root_cause" ? ["候选", "证据分数"] : analysisType === "overview" ? ["指标", "数值"] : ["设备", analysisType === "maintenance" ? "维护风险分数" : "综合风险分数"];
    summary.getRangeByIndexes(12, 0, chartRows.length + 1, 2).values = [chartHeaders, ...chartRows];
    const chart = summary.charts.add("bar", summary.getRange(`A13:B${13 + chartRows.length}`));
    chart.title = title;
    chart.titleTextStyle.typeface = "Arial";
    chart.legend = { position: "top", textStyle: { typeface: "Arial" } };
    chart.xAxis = { axisType: "textAxis", textStyle: { typeface: "Arial" } };
    chart.yAxis = { numberFormatCode: "0.00", numberFormatSourceLinked: false, textStyle: { typeface: "Arial" } };
    chart.setPosition("D4", "L20");
  }
  workbook.recalculate();
  const inspection = await workbook.inspect({ kind: "table", range: `Data!A1:${columnName(Math.min(headers.length - 1, 11))}${Math.min(matrix.length, 20)}`, include: "values,formulas", tableMaxRows: 20, tableMaxCols: 12, maxChars: 8000 });
  const formulaErrors = await workbook.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!", options: { useRegex: true, maxResults: 100 }, summary: "formula error scan" });
  await workbook.render({ sheetName: "Summary", autoCrop: "all", scale: 1, format: "png" });
  await fsp.mkdir(exportDir, { recursive: true });
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(target);
  await fsp.rm(`${target}.inspect.ndjson`, { force: true });
  return {
    file: target, format: "xlsx", analysisType, sheets: ["Summary", "Data"], rows: limitedRows.length,
    truncated: rows.length > limitedRows.length, sourceSummary: { dataAvailable: source.dataAvailable ?? limitedRows.length > 0 },
    verification: { inspected: Boolean(inspection.ndjson), formulaErrorsFound: /#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!)/.test(formulaErrors.ndjson), summaryRendered: true },
  };
}
