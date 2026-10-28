import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DataToolError } from "./database.mjs";
import { captureQueryTrace } from "./query_trace.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(moduleDir, "..");
export const auditLogPath = path.resolve(process.env.MANUFACTURING_AUDIT_LOG || path.join(projectDir, "logs", "query-audit.jsonl"));
export const serverTimezone = process.env.MANUFACTURING_TIMEZONE || "Asia/Shanghai";
export const sqlTimeoutMs = Math.min(Math.max(Number(process.env.MANUFACTURING_SQL_TIMEOUT_MS) || 3000, 100), 60000);

const knownTables = new Set([
  "downtime_events", "energy_readings", "inventory_transactions", "machines", "materials",
  "production_orders", "products", "quality_inspections", "supplier_receipts", "suppliers", "v_machine_kpi",
]);
const defaultSensitiveFields = ["phone", "mobile", "email", "address", "id_card", "bank_account", "contact_name", "password", "token", "secret", "api_key"];
const sensitiveFields = new Set([
  ...defaultSensitiveFields,
  ...(process.env.MANUFACTURING_SENSITIVE_FIELDS || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
]);

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase();
  return sensitiveFields.has(normalized) || [...sensitiveFields].some((field) => normalized.endsWith(`_${field}`));
}

function maskedValue(value) {
  if (value == null) return value;
  const text = String(value);
  if (text.length <= 4) return "****";
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function sanitizeSql(sql) {
  return String(sql).replace(/'(?:''|[^'])*'/g, "'?' ").replace(/\s+/g, " ").trim();
}

export function maskSensitive(value, key = "") {
  if (key === "sql" && typeof value === "string") return sanitizeSql(value);
  if (key === "params" && Array.isArray(value)) return value.map(() => "[REDACTED]");
  if (["content", "contentBase64"].includes(key) && typeof value === "string") {
    return `[PAYLOAD length=${value.length} sha256=${crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)}]`;
  }
  if (isSensitiveKey(key)) return maskedValue(value);
  if (Array.isArray(value)) return value.map((item) => maskSensitive(item));
  if (value && typeof value === "object") {
    const output = Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, maskSensitive(childValue, childKey)]));
    if (typeof value.field === "string" && isSensitiveKey(value.field) && Object.hasOwn(value, "value")) output.value = maskedValue(value.value);
    return output;
  }
  return value;
}

function maskToolArguments(args) {
  const output = maskSensitive(args ?? {});
  if (args && typeof args.code === "string") {
    output.code = `[PAYLOAD length=${args.code.length} sha256=${crypto.createHash("sha256").update(args.code).digest("hex").slice(0, 16)}]`;
  }
  return output;
}

function sourceTables(queries) {
  const found = new Set();
  for (const query of queries) {
    for (const match of query.sql.matchAll(/\b(?:from|join)\s+["`\[]?([A-Za-z_][A-Za-z0-9_]*)/gi)) {
      const table = match[1].toLowerCase();
      if (knownTables.has(table)) found.add(table);
    }
  }
  return [...found].sort();
}

function returnedRows(data) {
  if (!data || typeof data !== "object") return 0;
  if (typeof data.page?.returned === "number") return data.page.returned;
  if (typeof data.returned === "number") return data.returned;
  if (typeof data.anomalyCount === "number") return data.anomalyCount;
  if (Array.isArray(data.rows)) return data.rows.length;
  if (Array.isArray(data.items)) return data.items.length;
  return data.error ? 0 : 1;
}

function isTruncated(data) {
  return Boolean(data?.truncated || data?.page?.truncated || data?.page?.hasMore);
}

function requestedRange(args) {
  const dateFrom = args?.dateFrom ?? args?.scope?.dateFrom;
  const dateTo = args?.dateTo ?? args?.asOfDate ?? args?.scope?.dateTo;
  return dateFrom || dateTo ? { dateFrom: dateFrom ?? null, dateTo: dateTo ?? null } : null;
}

function observedRange(data) {
  const dates = [];
  const visit = (value, key = "") => {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, key));
    if (value && typeof value === "object") return Object.entries(value).forEach(([childKey, childValue]) => visit(childValue, childKey));
    if (typeof value === "string" && /(date|time|period|start|end)$/i.test(key)) {
      const match = value.match(/^\d{4}-\d{2}(?:-\d{2})?/);
      if (match) dates.push(match[0]);
    }
  };
  visit(data);
  if (!dates.length) return null;
  dates.sort();
  return { from: dates[0], to: dates.at(-1) };
}

function dataSufficiency(data) {
  if (data?.error?.code === "INSUFFICIENT_DATA") return { status: "insufficient", message: data.error.message };
  if (data?.dataAvailable === false || (Array.isArray(data?.rows) && data.rows.length === 0)) {
    return { status: "insufficient", message: "所选时间范围和筛选条件下没有足够数据。" };
  }
  return { status: "sufficient", message: null };
}

function qualityNotes(data) {
  const notes = Array.isArray(data?.dataNotes) ? data.dataNotes : [];
  return [...new Set(notes.map(String))];
}

function assumptions(data, notes) {
  const derived = notes.filter((note) => /derived|inferred|assum|推导|假设|粒度/i.test(note));
  if (data?.caveat) derived.push(String(data.caveat));
  return [...new Set(derived)];
}

function queryDigest(queries) {
  return crypto.createHash("sha256").update(queries.map((query) => query.sql).join("\n")).digest("hex").slice(0, 16);
}

function writeAudit(record) {
  fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
  fs.appendFileSync(auditLogPath, `${JSON.stringify(record)}\n`, "utf8");
}

export function getSecurityStatus() {
  const externalProvider = String(process.env.MANUFACTURING_EXTERNAL_SEARCH_PROVIDER || "tavily").trim().toLowerCase();
  const externalConfigured = externalProvider.startsWith("baidu")
    ? Boolean(process.env.BAIDU_AI_SEARCH_API_KEY)
    : Boolean(process.env.TAVILY_API_KEY);
  return {
    databaseMode: "read_only + query_only + defensive",
    sqlPolicy: "single SELECT/WITH statement; write/admin keywords and comments blocked",
    sqlTimeoutMs,
    limits: { queryRows: 500, aggregateRows: 500, exportRows: 10000, traceQueries: 50 },
    validation: "Zod JSON Schema plus table/field/operator allowlists",
    masking: { enabled: true, fields: [...sensitiveFields].sort() },
    audit: { enabled: true, file: auditLogPath },
    externalSearch: {
      provider: externalProvider,
      configured: externalConfigured,
      mode: "read_only_open_world",
      directResultPageFetching: false,
      contentProvider: process.env.MANUFACTURING_EXTERNAL_CONTENT_PROVIDER || (externalProvider.startsWith("baidu") ? "search_snippet" : "tavily"),
      providerManagedContentExtraction: !externalProvider.startsWith("baidu"),
      apiKeyExposed: false,
      timeoutMs: Math.min(Math.max(Number(process.env.MANUFACTURING_EXTERNAL_SEARCH_TIMEOUT_MS) || 12000, 1000), 60000),
      extractionTimeoutMs: Math.min(Math.max(Number(process.env.MANUFACTURING_EXTERNAL_EXTRACT_TIMEOUT_MS) || 30000, 1000), 60000),
      maxResults: 20,
      maxExtractedDocuments: 20,
      localEmbeddingRerank: !/^(?:0|false|no|off)$/i.test(process.env.MANUFACTURING_EMBEDDING_ENABLED || "true"),
      embeddingVectorsNormalized: true,
      embeddingVectorsExposed: false,
    },
    pythonSandbox: {
      provider: "AIO Sandbox",
      endpointConfigured: Boolean(process.env.MANUFACTURING_AIO_BASE_URL || "http://127.0.0.1:8080"),
      apiKeyConfigured: Boolean(process.env.MANUFACTURING_AIO_API_KEY),
      arbitraryShellExposed: false,
      workspacePathsOnly: true,
      maxExecutionSeconds: 300,
      maxUploadBytes: 5 * 1024 * 1024,
      maxDownloadBytes: 10 * 1024 * 1024,
    },
    dateFormat: "YYYY-MM-DD",
    timezone: serverTimezone,
    timestampStandard: "ISO-8601 UTC; business date interpretation uses the configured timezone",
    units: "Field names and metric definitions carry explicit business units; SI-compatible units are preferred.",
  };
}

export function readAuditLog({ limit = 100, tool, status } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  if (!fs.existsSync(auditLogPath)) return { rows: [], returned: 0, file: auditLogPath };
  const rows = fs.readFileSync(auditLogPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => !tool || row.tool === tool)
    .filter((row) => !status || row.status === status)
    .slice(-safeLimit).reverse();
  return { rows, returned: rows.length, file: auditLogPath };
}

export function secureMcpHandler(toolName, handler) {
  return async (args) => {
    const requestId = crypto.randomUUID();
    const startedAt = new Date();
    let captured;
    try {
      captured = await captureQueryTrace(() => handler(args));
    } catch (error) {
      captured = { value: { content: [], structuredContent: { error: { code: "INTERNAL_ERROR", message: String(error) } }, isError: true }, queries: [] };
    }
    const response = captured.value;
    const rawData = response?.structuredContent ?? {};
    const workerQueries = Array.isArray(rawData?.queryTrace?.queries) ? rawData.queryTrace.queries : [];
    const queries = [...captured.queries, ...workerQueries].slice(0, 50);
    const notes = qualityNotes(rawData);
    const sources = sourceTables(queries);
    const durationMs = Date.now() - startedAt.getTime();
    const metadata = {
      requestId,
      tool: toolName,
      executedAt: startedAt.toISOString(),
      durationMs,
      timezone: serverTimezone,
      timestampStandard: "ISO-8601 UTC",
      dataTimeRange: { requested: requestedRange(args), observedInResult: observedRange(rawData) },
      filters: maskToolArguments(args),
      sourceTables: sources,
      queryTrace: { queryCount: queries.length, truncated: captured.queries.length + workerQueries.length > 50, digest: queryDigest(queries), queries },
      returnedRows: returnedRows(rawData),
      resultTruncated: isTruncated(rawData) || (Number.isFinite(args?.limit) && returnedRows(rawData) >= args.limit),
      dataSufficiency: dataSufficiency(rawData),
      dataQualityNotes: notes,
      assumptions: assumptions(rawData, notes),
      units: "See metricDefinitions and unit-bearing field names.",
    };
    let auditWarning;
    try {
      writeAudit({
        timestamp: new Date().toISOString(), requestId, tool: toolName, status: response?.isError ? "error" : "success",
        durationMs, arguments: maskToolArguments(args), sourceTables: sources, queryDigest: metadata.queryTrace.digest,
        queryCount: queries.length, returnedRows: metadata.returnedRows, truncated: metadata.resultTruncated,
        errorCode: rawData?.error?.code ?? null,
      });
    } catch (error) {
      auditWarning = `Audit log write failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (auditWarning) metadata.auditWarning = auditWarning;
    const data = maskSensitive({ ...rawData, metadata });
    return { ...response, structuredContent: data, content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  };
}

export function validateAuditStatus(status) {
  if (status != null && !new Set(["success", "error"]).has(status)) throw new DataToolError("INVALID_AUDIT_FILTER", "status must be success or error");
}

