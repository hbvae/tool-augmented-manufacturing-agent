import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, constants as sqliteConstants } from "node:sqlite";
import { recordQuery } from "./query_trace.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const projectDir = path.resolve(moduleDir, "..");
export const defaultDbPath = path.resolve(projectDir, "..", "manufacturing_data", "manufacturing_demo.db");
export const dbPath = path.resolve(process.env.MANUFACTURING_DB || defaultDbPath);
export const exportDir = path.resolve(process.env.MANUFACTURING_EXPORT_DIR || path.join(projectDir, "exports"));

if (!fs.existsSync(dbPath)) {
  throw new Error(`Manufacturing database not found: ${dbPath}`);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec("PRAGMA query_only = ON;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA busy_timeout = 3000;");
db.enableDefensive(true);

const MAX_PAGE_SIZE = 500;
const MAX_AGG_ROWS = 500;
const MAX_EXPORT_ROWS = 10000;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "between", "in", "like", "is_null", "not_null"]);
const AGGREGATIONS = new Set(["count", "count_distinct", "sum", "avg", "min", "max"]);
const readOnlyVirtualSchemas = new Map([
  ["json_each", new Set(["key", "value", "type", "atom", "id", "parent", "fullkey", "path"])],
]);

const implicitRelationships = [
  { sourceTable: "production_orders", sourceField: "product_id", targetTable: "products", targetField: "product_id" },
  { sourceTable: "production_orders", sourceField: "machine_id", targetTable: "machines", targetField: "machine_id" },
  { sourceTable: "quality_inspections", sourceField: "order_id", targetTable: "production_orders", targetField: "order_id" },
  { sourceTable: "downtime_events", sourceField: "machine_id", targetTable: "machines", targetField: "machine_id" },
  { sourceTable: "downtime_events", sourceField: "order_id", targetTable: "production_orders", targetField: "order_id", optional: true },
  { sourceTable: "energy_readings", sourceField: "machine_id", targetTable: "machines", targetField: "machine_id" },
  { sourceTable: "supplier_receipts", sourceField: "supplier_id", targetTable: "suppliers", targetField: "supplier_id" },
  { sourceTable: "supplier_receipts", sourceField: "material_id", targetTable: "materials", targetField: "material_id" },
];

export class DataToolError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "DataToolError";
    this.code = code;
    this.details = details;
  }
}

function quoteIdentifier(identifier) {
  if (!IDENTIFIER.test(identifier)) {
    throw new DataToolError("INVALID_IDENTIFIER", `Invalid identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export function listTables({ includeViews = true } = {}) {
  const types = includeViews ? ["table", "view"] : ["table"];
  const placeholders = types.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT name, type
    FROM sqlite_master
    WHERE type IN (${placeholders}) AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all(...types);
  return rows.map((row) => ({
    ...row,
    rowCount: Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(row.name)}`).get().n),
  }));
}

function tableInfo(table) {
  const found = listTables().find((item) => item.name === table);
  if (!found) throw new DataToolError("UNKNOWN_TABLE", `Unknown table or view: ${table}`);
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
  return { found, columns };
}

function columnMap(table) {
  const { columns } = tableInfo(table);
  return new Map(columns.map((column) => [column.name, column]));
}

function validateColumn(columns, field, allowStar = false) {
  if (allowStar && field === "*") return;
  if (!columns.has(field)) {
    throw new DataToolError("UNKNOWN_FIELD", `Unknown field: ${field}`, { availableFields: [...columns.keys()] });
  }
}

function normalizeColumns(table, requested) {
  const columns = columnMap(table);
  const names = requested?.length ? requested : [...columns.keys()];
  names.forEach((field) => validateColumn(columns, field));
  return { columns, names };
}

function toSqlValue(value, label = "filter value") {
  if (value === undefined || Array.isArray(value) || (typeof value === "object" && value !== null)) {
    throw new DataToolError("INVALID_FILTER_VALUE", `${label} must be a string, number, boolean, or null`);
  }
  return typeof value === "boolean" ? (value ? 1 : 0) : value;
}

function compileFilters(columns, filters = []) {
  const clauses = [];
  const params = [];
  for (const filter of filters) {
    const { field, operator = "eq", value } = filter;
    validateColumn(columns, field);
    if (!OPERATORS.has(operator)) throw new DataToolError("INVALID_OPERATOR", `Unsupported operator: ${operator}`);
    const column = quoteIdentifier(field);
    switch (operator) {
      case "eq": clauses.push(`${column} = ?`); params.push(toSqlValue(value)); break;
      case "ne": clauses.push(`${column} <> ?`); params.push(toSqlValue(value)); break;
      case "gt": clauses.push(`${column} > ?`); params.push(toSqlValue(value)); break;
      case "gte": clauses.push(`${column} >= ?`); params.push(toSqlValue(value)); break;
      case "lt": clauses.push(`${column} < ?`); params.push(toSqlValue(value)); break;
      case "lte": clauses.push(`${column} <= ?`); params.push(toSqlValue(value)); break;
      case "like": clauses.push(`${column} LIKE ?`); params.push(toSqlValue(value)); break;
      case "is_null": clauses.push(`${column} IS NULL`); break;
      case "not_null": clauses.push(`${column} IS NOT NULL`); break;
      case "between": {
        if (!Array.isArray(value) || value.length !== 2) throw new DataToolError("INVALID_FILTER_VALUE", "between requires exactly two values");
        clauses.push(`${column} BETWEEN ? AND ?`); params.push(toSqlValue(value[0]), toSqlValue(value[1])); break;
      }
      case "in": {
        if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new DataToolError("INVALID_FILTER_VALUE", "in requires 1 to 100 values");
        clauses.push(`${column} IN (${value.map(() => "?").join(",")})`); params.push(...value.map((item) => toSqlValue(item))); break;
      }
    }
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

function compileOrderBy(columns, orderBy = []) {
  if (!orderBy.length) return "";
  const parts = orderBy.map(({ field, direction = "asc" }) => {
    validateColumn(columns, field);
    const normalized = String(direction).toLowerCase();
    if (!new Set(["asc", "desc"]).has(normalized)) throw new DataToolError("INVALID_SORT", `Invalid sort direction: ${direction}`);
    return `${quoteIdentifier(field)} ${normalized.toUpperCase()}`;
  });
  return ` ORDER BY ${parts.join(", ")}`;
}

function serializeRows(rows) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? Number(value) : value])));
}

function explainPlan(sql, params = []) {
  try {
    return serializeRows(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params));
  } catch {
    return [];
  }
}

export function getDatasetInfo() {
  const stat = fs.statSync(dbPath);
  const tables = listTables();
  return {
    dataset: "manufacturing_mcp_demo",
    databaseFile: path.basename(dbPath),
    databaseSizeBytes: stat.size,
    sqliteVersion: db.prepare("SELECT sqlite_version() AS version").get().version,
    readOnly: true,
    tables: tables.length,
    totalRows: tables.reduce((sum, item) => sum + item.rowCount, 0),
    limits: { pageSize: MAX_PAGE_SIZE, aggregateRows: MAX_AGG_ROWS, exportRows: MAX_EXPORT_ROWS },
  };
}

export function describeTable(table) {
  const { found, columns } = tableInfo(table);
  const indexes = db.prepare(`PRAGMA index_list(${quoteIdentifier(table)})`).all();
  const relationships = implicitRelationships.filter((r) => r.sourceTable === table || r.targetTable === table);
  return {
    name: found.name,
    type: found.type,
    rowCount: found.rowCount,
    columns: columns.map((c) => ({ name: c.name, type: c.type, nullable: c.notnull === 0, defaultValue: c.dflt_value, primaryKeyPosition: c.pk })),
    indexes: indexes.map((i) => ({ name: i.name, unique: Boolean(i.unique), origin: i.origin })),
    relationships,
  };
}

export function queryRecords({ table, columns: requested, filters = [], orderBy = [], limit = 100, offset = 0 }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), MAX_PAGE_SIZE);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const { columns, names } = normalizeColumns(table, requested);
  const where = compileFilters(columns, filters);
  const sort = compileOrderBy(columns, orderBy);
  const select = names.map(quoteIdentifier).join(", ");
  const base = ` FROM ${quoteIdentifier(table)}${where.sql}`;
  const sql = `SELECT ${select}${base}${sort} LIMIT ? OFFSET ?`;
  const sqlParams = [...where.params, safeLimit, safeOffset];
  const plan = explainPlan(sql, sqlParams);
  recordQuery({ sql, params: sqlParams, plan });
  const rows = serializeRows(db.prepare(sql).all(...sqlParams));
  const total = Number(db.prepare(`SELECT COUNT(*) AS n${base}`).get(...where.params).n);
  return {
    table,
    columns: names,
    rows,
    page: { limit: safeLimit, offset: safeOffset, returned: rows.length, total, hasMore: safeOffset + rows.length < total },
  };
}

export function previewData({ table, columns, limit = 20, offset = 0 }) {
  const info = describeTable(table);
  const primary = info.columns.filter((c) => c.primaryKeyPosition > 0).sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition);
  const orderBy = primary.length ? primary.map((c) => ({ field: c.name, direction: "asc" })) : [];
  return queryRecords({ table, columns, filters: [], orderBy, limit: Math.min(limit, 100), offset });
}

export function aggregateMetrics({ table, dimensions = [], metrics, filters = [], orderBy = [], limit = 100 }) {
  const columns = columnMap(table);
  dimensions.forEach((field) => validateColumn(columns, field));
  if (!metrics?.length) throw new DataToolError("MISSING_METRICS", "At least one metric is required");
  const aliases = new Set();
  const expressions = metrics.map((metric, index) => {
    const aggregation = String(metric.aggregation).toLowerCase();
    if (!AGGREGATIONS.has(aggregation)) throw new DataToolError("INVALID_AGGREGATION", `Unsupported aggregation: ${aggregation}`);
    const field = metric.field ?? "*";
    validateColumn(columns, field, aggregation === "count");
    if (field === "*" && aggregation !== "count") throw new DataToolError("INVALID_METRIC", "Only count supports field='*'");
    const alias = metric.alias || `${aggregation}_${field === "*" ? "rows" : field}`;
    if (!IDENTIFIER.test(alias) || aliases.has(alias)) throw new DataToolError("INVALID_ALIAS", `Invalid or duplicate metric alias: ${alias}`);
    aliases.add(alias);
    const value = field === "*" ? "*" : quoteIdentifier(field);
    if (aggregation === "count_distinct") return `COUNT(DISTINCT ${value}) AS ${quoteIdentifier(alias)}`;
    return `${aggregation.toUpperCase()}(${value}) AS ${quoteIdentifier(alias)}`;
  });
  const where = compileFilters(columns, filters);
  const group = dimensions.length ? ` GROUP BY ${dimensions.map(quoteIdentifier).join(", ")}` : "";
  const resultFields = new Set([...dimensions, ...aliases]);
  const sort = orderBy.length ? ` ORDER BY ${orderBy.map(({ field, direction = "asc" }) => {
    if (!resultFields.has(field)) throw new DataToolError("INVALID_SORT_FIELD", `Aggregate sort field not found: ${field}`);
    const dir = String(direction).toLowerCase();
    if (!new Set(["asc", "desc"]).has(dir)) throw new DataToolError("INVALID_SORT", `Invalid sort direction: ${direction}`);
    return `${quoteIdentifier(field)} ${dir.toUpperCase()}`;
  }).join(", ")}` : "";
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), MAX_AGG_ROWS);
  const select = [...dimensions.map(quoteIdentifier), ...expressions].join(", ");
  const sql = `SELECT ${select} FROM ${quoteIdentifier(table)}${where.sql}${group}${sort} LIMIT ?`;
  const sqlParams = [...where.params, safeLimit];
  const plan = explainPlan(sql, sqlParams);
  recordQuery({ sql, params: sqlParams, plan });
  const rows = serializeRows(db.prepare(sql).all(...sqlParams));
  return { table, dimensions, metrics, rows, returned: rows.length, truncated: rows.length === safeLimit };
}

function validateReadOnlySql(sql) {
  if (typeof sql !== "string" || !sql.trim()) throw new DataToolError("EMPTY_SQL", "SQL is required");
  let normalized = sql.trim();
  if (normalized.endsWith(";")) normalized = normalized.slice(0, -1).trim();
  if (normalized.includes(";") || /--|\/\*|\*\//.test(normalized)) throw new DataToolError("UNSAFE_SQL", "Comments and multiple statements are not allowed");
  if (!/^(select|with)\b/i.test(normalized)) throw new DataToolError("READ_ONLY_REQUIRED", "Only SELECT or WITH queries are allowed");
  const blocked = /\b(insert|update|delete|drop|alter|create|attach|detach|vacuum|reindex|replace|pragma)\b/i;
  if (blocked.test(normalized)) throw new DataToolError("READ_ONLY_REQUIRED", "SQL contains a blocked write or administration keyword");
  return normalized;
}

export function runReadOnlySql({ sql, params = [], limit = 200, offset = 0 }) {
  const safeSql = validateReadOnlySql(sql);
  if (!Array.isArray(params) || params.length > 100) throw new DataToolError("INVALID_PARAMS", "params must be an array with at most 100 values");
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), MAX_PAGE_SIZE);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const wrapped = `SELECT * FROM (${safeSql}) AS _mcp_query LIMIT ? OFFSET ?`;
  const safeParams = params.map((value) => toSqlValue(value, "SQL parameter"));
  const executeParams = [...safeParams, safeLimit, safeOffset];
  const schemas = new Map(listTables().map(({ name }) => [name, new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all().map((column) => column.name))]));
  db.setAuthorizer((action, arg1, arg2) => {
    if (action === sqliteConstants.SQLITE_READ) {
      const columns = schemas.get(arg1) ?? readOnlyVirtualSchemas.get(arg1);
      return columns && (!arg2 || columns.has(arg2)) ? sqliteConstants.SQLITE_OK : sqliteConstants.SQLITE_DENY;
    }
    if ([sqliteConstants.SQLITE_SELECT, sqliteConstants.SQLITE_FUNCTION, sqliteConstants.SQLITE_RECURSIVE].includes(action)) return sqliteConstants.SQLITE_OK;
    return sqliteConstants.SQLITE_DENY;
  });
  try {
    const plan = explainPlan(wrapped, executeParams);
    recordQuery({ sql: wrapped, params: executeParams, plan });
    const rows = serializeRows(db.prepare(wrapped).all(...executeParams));
    return {
      rows,
      page: { limit: safeLimit, offset: safeOffset, returned: rows.length, truncated: rows.length === safeLimit },
      queryTrace: { queries: [{ sql: wrapped.replace(/\s+/g, " ").trim(), parameterCount: executeParams.length, plan: plan.map((row) => row.detail).filter(Boolean) }] },
    };
  } catch (error) {
    if (/not authorized|authorization denied|prohibited/i.test(String(error?.message))) throw new DataToolError("SCHEMA_NOT_ALLOWED", "SQL referenced a table, field, or operation outside the allowlist");
    throw error;
  } finally {
    db.setAuthorizer(null);
  }
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportRecords({ table, columns, filters = [], orderBy = [], fileName }) {
  const result = queryRecords({ table, columns, filters, orderBy, limit: MAX_PAGE_SIZE, offset: 0 });
  const { columns: validatedColumns } = normalizeColumns(table, columns);
  const where = compileFilters(validatedColumns, filters);
  const sort = compileOrderBy(validatedColumns, orderBy);
  const names = result.columns;
  const rows = serializeRows(db.prepare(`SELECT ${names.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table)}${where.sql}${sort} LIMIT ?`).all(...where.params, MAX_EXPORT_ROWS));
  fs.mkdirSync(exportDir, { recursive: true });
  const base = fileName || `${table}_${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.csv`;
  if (!/^[A-Za-z0-9_.-]+\.csv$/i.test(base)) throw new DataToolError("INVALID_FILE_NAME", "fileName must be a simple .csv file name");
  const target = path.resolve(exportDir, base);
  if (path.dirname(target) !== exportDir) throw new DataToolError("INVALID_FILE_NAME", "Export path must stay inside the export directory");
  const csv = [names, ...rows.map((row) => names.map((name) => row[name]))].map((row) => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
  fs.writeFileSync(target, csv, "utf8");
  return { file: target, format: "csv", rows: rows.length, columns: names, truncated: rows.length === MAX_EXPORT_ROWS };
}

export function closeDatabase() {
  db.close();
}
