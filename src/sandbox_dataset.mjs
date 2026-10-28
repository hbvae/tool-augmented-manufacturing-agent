import crypto from "node:crypto";
import { DataToolError, queryRecords } from "./database.mjs";
import { maskSensitive, serverTimezone } from "./security.mjs";
import { uploadPythonSandboxFile } from "./aio_sandbox.mjs";

const MAX_DATASET_ROWS = 500;
const MAX_PREVIEW_ROWS = 10;

function safeDatasetId(value) {
  if (value == null || value === "") return `dataset-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value)) {
    throw new DataToolError("INVALID_DATASET_ID", "datasetId 只能包含字母、数字、点、下划线和短横线，最长80个字符。");
  }
  return value;
}

function csvEscape(value) {
  if (value == null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function serializeDataset(format, columns, rows) {
  if (format === "json") return `${JSON.stringify(rows, null, 2)}\n`;
  return `${[columns, ...rows.map((row) => columns.map((column) => row[column]))]
    .map((values) => values.map(csvEscape).join(","))
    .join("\r\n")}\r\n`;
}

function profileColumns(columns, rows) {
  return columns.map((column) => {
    const values = rows.map((row) => row[column]);
    const nonNull = values.filter((value) => value != null);
    const observedTypes = [...new Set(nonNull.map((value) => Array.isArray(value) ? "array" : typeof value))].sort();
    return {
      name: column,
      nullCount: values.length - nonNull.length,
      nonNullCount: nonNull.length,
      observedTypes,
    };
  });
}

export async function prepareSandboxDataset({
  table,
  columns,
  filters = [],
  orderBy = [],
  limit = 500,
  offset = 0,
  format = "csv",
  datasetId,
  previewRows = 5,
  dateColumn,
} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || MAX_DATASET_ROWS, 1), MAX_DATASET_ROWS);
  const safePreviewRows = Math.min(Math.max(Number(previewRows) || 0, 0), MAX_PREVIEW_ROWS);
  if (!new Set(["csv", "json"]).has(format)) throw new DataToolError("INVALID_DATASET_FORMAT", "format 必须是 csv 或 json。");
  const id = safeDatasetId(datasetId);
  const query = queryRecords({ table, columns, filters, orderBy, limit: safeLimit, offset });
  const rows = maskSensitive(query.rows);
  const observedDates = dateColumn && query.columns.includes(dateColumn)
    ? rows.map((row) => String(row[dateColumn] ?? "").match(/^\d{4}-\d{2}(?:-\d{2})?/)?.[0]).filter(Boolean).sort()
    : [];
  const observedDataRange = observedDates.length
    ? { start: observedDates[0], end: observedDates.at(-1), column: dateColumn }
    : null;
  const content = serializeDataset(format, query.columns, rows);
  const extension = format === "json" ? "json" : "csv";
  const relativePath = `datasets/${id}.${extension}`;
  const manifestPath = `datasets/${id}.manifest.json`;
  const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  const generatedAt = new Date().toISOString();
  const uploaded = await uploadPythonSandboxFile({ relativePath, content, encoding: "utf-8", append: false });
  const manifest = {
    schemaVersion: "1.0",
    datasetId: id,
    generatedAt,
    timezone: serverTimezone,
    format,
    file: uploaded.file,
    sha256,
    rowCount: rows.length,
    observedDataRange,
    columns: profileColumns(query.columns, rows),
    source: {
      mode: "validated_table_query",
      table: query.table,
      selectedColumns: query.columns,
      filters: maskSensitive(filters),
      orderBy,
      pagination: query.page,
    },
    security: {
      databaseReadOnly: true,
      tableAndFieldAllowlist: true,
      parameterizedFilters: true,
      sensitiveFieldsMasked: true,
      sandboxHostPathsExposed: false,
    },
    dataQualityNotes: query.page.hasMore
      ? [`本数据集只包含第 ${query.page.offset + 1} 至 ${query.page.offset + query.page.returned} 行；筛选后共有 ${query.page.total} 行。`]
      : [],
  };
  const manifestUploaded = await uploadPythonSandboxFile({ relativePath: manifestPath, content: `${JSON.stringify(manifest, null, 2)}\n`, encoding: "utf-8", append: false });
  return {
    datasetId: id,
    format,
    sandboxFile: uploaded.file,
    manifestFile: manifestUploaded.file,
    rowCount: rows.length,
    returned: rows.length,
    totalMatchingRows: query.page.total,
    truncated: query.page.hasMore,
    columns: query.columns,
    contentBytes: Buffer.byteLength(content, "utf8"),
    sha256,
    preview: safePreviewRows ? rows.slice(0, safePreviewRows) : [],
    observedDataRange,
    source: manifest.source,
    dataQualityNotes: manifest.dataQualityNotes,
    nextStep: `在 run_python_analysis 中读取 ${uploaded.file}；数据清单位于 ${manifestUploaded.file}。`,
  };
}

export const sandboxDatasetLimits = { maxRows: MAX_DATASET_ROWS, maxPreviewRows: MAX_PREVIEW_ROWS };
