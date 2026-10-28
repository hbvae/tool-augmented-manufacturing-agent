import { DataToolError, runReadOnlySql } from "./database.mjs";

const BREAKDOWN_DIMENSIONS = new Set(["machine", "line", "product", "shift", "month", "day"]);
const TREND_GRAINS = new Set(["day", "week", "month"]);
const SORT_FIELDS = new Set([
  "order_count", "planned_qty", "actual_qty", "good_qty", "scrap_qty",
  "plan_completion_rate", "yield_rate", "scrap_rate", "weighted_cycle_time_min",
  "cycle_time_index", "avg_start_delay_min",
]);
const EXCEPTION_TYPES = new Set(["low_completion", "high_scrap", "late_start", "slow_cycle"]);

const METRIC_DEFINITIONS = {
  plan_completion_rate: "SUM(actual_qty) / SUM(planned_qty)",
  yield_rate: "SUM(good_qty) / SUM(actual_qty)",
  scrap_rate: "SUM(scrap_qty) / SUM(actual_qty)",
  weighted_cycle_time_min: "SUM(runtime_min) / SUM(actual_qty)",
  weighted_standard_cycle_min: "SUM(actual_qty * standard_cycle_min) / SUM(actual_qty)",
  cycle_time_index: "SUM(runtime_min) / SUM(actual_qty * standard_cycle_min)",
  avg_start_delay_min: "AVG(actual_start - planned_start), minutes",
};

function requireIsoDate(value, field) {
  if (value == null) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new DataToolError("INVALID_DATE", `${field} must use YYYY-MM-DD format`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new DataToolError("INVALID_DATE", `${field} is not a valid calendar date`);
  }
  return value;
}

function nextDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function validateIdList(values, field) {
  if (values == null) return [];
  if (!Array.isArray(values) || values.length > 100 || values.some((value) => typeof value !== "string" || !value.trim())) {
    throw new DataToolError("INVALID_SCOPE", `${field} must contain at most 100 non-empty strings`);
  }
  return [...new Set(values.map((value) => value.trim()))];
}

function buildScope(scope = {}) {
  const clauses = [];
  const params = [];
  const dateFrom = requireIsoDate(scope.dateFrom, "dateFrom");
  const dateTo = requireIsoDate(scope.dateTo, "dateTo");
  if (dateFrom && dateTo && dateFrom > dateTo) throw new DataToolError("INVALID_DATE_RANGE", "dateFrom must not be later than dateTo");
  if (dateFrom) { clauses.push("o.actual_start >= ?"); params.push(`${dateFrom}T00:00:00`); }
  if (dateTo) { clauses.push("o.actual_start < ?"); params.push(`${nextDate(dateTo)}T00:00:00`); }

  const mappings = [
    ["machineIds", "o.machine_id"], ["productIds", "o.product_id"],
    ["lineIds", "o.line_id"], ["shifts", "o.shift"],
  ];
  for (const [field, column] of mappings) {
    const values = validateIdList(scope[field], field);
    if (values.length) {
      clauses.push(`${column} IN (${values.map(() => "?").join(",")})`);
      params.push(...values);
    }
  }
  return { clauses, params, normalized: { dateFrom, dateTo, machineIds: scope.machineIds ?? [], productIds: scope.productIds ?? [], lineIds: scope.lineIds ?? [], shifts: scope.shifts ?? [] } };
}

function metricSql() {
  return `
    COUNT(*) AS order_count,
    SUM(o.planned_qty) AS planned_qty,
    SUM(o.actual_qty) AS actual_qty,
    SUM(o.good_qty) AS good_qty,
    SUM(o.scrap_qty) AS scrap_qty,
    SUM(o.actual_qty) - SUM(o.planned_qty) AS plan_variance_qty,
    ROUND(SUM(o.actual_qty) * 1.0 / NULLIF(SUM(o.planned_qty), 0), 4) AS plan_completion_rate,
    ROUND(SUM(o.good_qty) * 1.0 / NULLIF(SUM(o.actual_qty), 0), 4) AS yield_rate,
    ROUND(SUM(o.scrap_qty) * 1.0 / NULLIF(SUM(o.actual_qty), 0), 4) AS scrap_rate,
    SUM(o.runtime_min) AS runtime_min,
    ROUND(SUM(o.runtime_min) * 1.0 / NULLIF(SUM(o.actual_qty), 0), 3) AS weighted_cycle_time_min,
    ROUND(SUM(o.actual_qty * p.standard_cycle_min) * 1.0 / NULLIF(SUM(o.actual_qty), 0), 3) AS weighted_standard_cycle_min,
    ROUND(SUM(o.runtime_min) * 1.0 / NULLIF(SUM(o.actual_qty * p.standard_cycle_min), 0), 4) AS cycle_time_index,
    ROUND(AVG((julianday(o.actual_start) - julianday(o.planned_start)) * 1440.0), 2) AS avg_start_delay_min`;
}

function baseFrom() {
  return " FROM production_orders o JOIN products p ON p.product_id = o.product_id JOIN machines m ON m.machine_id = o.machine_id";
}

export function getProductionSummary(scope = {}) {
  const filter = buildScope(scope);
  const where = filter.clauses.length ? ` WHERE ${filter.clauses.join(" AND ")}` : "";
  const sql = `SELECT COUNT(DISTINCT o.product_id) AS product_count, COUNT(DISTINCT o.machine_id) AS machine_count, ${metricSql()}${baseFrom()}${where}`;
  const row = runReadOnlySql({ sql, params: filter.params, limit: 1 }).rows[0];
  return {
    scope: filter.normalized,
    dataAvailable: Boolean(row?.order_count),
    metrics: row,
    metricDefinitions: METRIC_DEFINITIONS,
  };
}

const breakdownMap = {
  machine: { select: "o.machine_id AS machine_id, m.machine_type AS machine_type", group: "o.machine_id, m.machine_type", fields: ["machine_id", "machine_type"] },
  line: { select: "o.line_id AS line_id", group: "o.line_id", fields: ["line_id"] },
  product: { select: "o.product_id AS product_id, p.product_name AS product_name", group: "o.product_id, p.product_name", fields: ["product_id", "product_name"] },
  shift: { select: "o.shift AS shift", group: "o.shift", fields: ["shift"] },
  month: { select: "substr(o.actual_start, 1, 7) AS month", group: "substr(o.actual_start, 1, 7)", fields: ["month"] },
  day: { select: "substr(o.actual_start, 1, 10) AS day", group: "substr(o.actual_start, 1, 10)", fields: ["day"] },
};

export function analyzeProductionBreakdown({ dimension, orderBy = "actual_qty", direction = "desc", limit = 100, ...scope }) {
  if (!BREAKDOWN_DIMENSIONS.has(dimension)) throw new DataToolError("INVALID_DIMENSION", `Unsupported production dimension: ${dimension}`);
  if (!SORT_FIELDS.has(orderBy)) throw new DataToolError("INVALID_SORT_FIELD", `Unsupported production sort field: ${orderBy}`);
  const dir = String(direction).toLowerCase();
  if (!new Set(["asc", "desc"]).has(dir)) throw new DataToolError("INVALID_SORT", `Invalid sort direction: ${direction}`);
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const filter = buildScope(scope);
  const where = filter.clauses.length ? ` WHERE ${filter.clauses.join(" AND ")}` : "";
  const config = breakdownMap[dimension];
  const sql = `SELECT ${config.select}, ${metricSql()}${baseFrom()}${where} GROUP BY ${config.group} ORDER BY ${orderBy} ${dir.toUpperCase()}`;
  const rows = runReadOnlySql({ sql, params: filter.params, limit: safeLimit }).rows;
  return { scope: filter.normalized, dimension, rows, returned: rows.length, metricDefinitions: METRIC_DEFINITIONS };
}

const trendMap = {
  day: "substr(o.actual_start, 1, 10)",
  week: "strftime('%Y-W%W', o.actual_start)",
  month: "substr(o.actual_start, 1, 7)",
};

export function getProductionTrend({ grain = "month", limit = 500, ...scope }) {
  if (!TREND_GRAINS.has(grain)) throw new DataToolError("INVALID_GRAIN", `Unsupported time grain: ${grain}`);
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 500);
  const filter = buildScope(scope);
  const where = filter.clauses.length ? ` WHERE ${filter.clauses.join(" AND ")}` : "";
  const period = trendMap[grain];
  const sql = `SELECT ${period} AS period, ${metricSql()}${baseFrom()}${where} GROUP BY ${period} ORDER BY period ASC`;
  const rows = runReadOnlySql({ sql, params: filter.params, limit: safeLimit }).rows;
  return { scope: filter.normalized, grain, rows, returned: rows.length, metricDefinitions: METRIC_DEFINITIONS };
}

export function findProductionExceptions({
  exceptionTypes = ["low_completion", "high_scrap", "late_start", "slow_cycle"],
  completionBelow = 0.9,
  scrapAbove = 0.03,
  startDelayAboveMin = 30,
  cycleTimeAbovePct = 0.15,
  limit = 100,
  ...scope
}) {
  const uniqueTypes = [...new Set(exceptionTypes)];
  if (!uniqueTypes.length || uniqueTypes.some((type) => !EXCEPTION_TYPES.has(type))) {
    throw new DataToolError("INVALID_EXCEPTION_TYPE", `exceptionTypes must use: ${[...EXCEPTION_TYPES].join(", ")}`);
  }
  const thresholds = { completionBelow, scrapAbove, startDelayAboveMin, cycleTimeAbovePct };
  for (const [name, value] of Object.entries(thresholds)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new DataToolError("INVALID_THRESHOLD", `${name} must be a non-negative number`);
  }
  const filter = buildScope(scope);
  const conditions = [];
  const conditionParams = [];
  const expressions = {
    low_completion: "o.actual_qty * 1.0 / NULLIF(o.planned_qty, 0) < ?",
    high_scrap: "o.scrap_qty * 1.0 / NULLIF(o.actual_qty, 0) > ?",
    late_start: "(julianday(o.actual_start) - julianday(o.planned_start)) * 1440.0 > ?",
    slow_cycle: "o.cycle_time_min > p.standard_cycle_min * (1.0 + ?)",
  };
  const values = { low_completion: completionBelow, high_scrap: scrapAbove, late_start: startDelayAboveMin, slow_cycle: cycleTimeAbovePct };
  for (const type of uniqueTypes) { conditions.push(expressions[type]); conditionParams.push(values[type]); }
  const allClauses = [...filter.clauses, `(${conditions.join(" OR ")})`];
  const severityParts = uniqueTypes.map((type) => `CASE WHEN ${expressions[type]} THEN 1 ELSE 0 END`);
  const reasonLabels = { low_completion: "LOW_COMPLETION", high_scrap: "HIGH_SCRAP", late_start: "LATE_START", slow_cycle: "SLOW_CYCLE" };
  const reasonParts = uniqueTypes.map((type) => `CASE WHEN ${expressions[type]} THEN '${reasonLabels[type]},' ELSE '' END`);
  const selectedThresholdParams = uniqueTypes.map((type) => values[type]);
  const sql = `
    SELECT o.order_id, o.product_id, p.product_name, o.machine_id, o.line_id, o.shift,
           o.planned_start, o.actual_start, o.planned_qty, o.actual_qty, o.good_qty, o.scrap_qty,
           ROUND(o.actual_qty * 1.0 / NULLIF(o.planned_qty, 0), 4) AS plan_completion_rate,
           ROUND(o.good_qty * 1.0 / NULLIF(o.actual_qty, 0), 4) AS yield_rate,
           ROUND(o.scrap_qty * 1.0 / NULLIF(o.actual_qty, 0), 4) AS scrap_rate,
           o.cycle_time_min, p.standard_cycle_min,
           ROUND((o.cycle_time_min - p.standard_cycle_min) / NULLIF(p.standard_cycle_min, 0), 4) AS cycle_time_variance_rate,
           ROUND((julianday(o.actual_start) - julianday(o.planned_start)) * 1440.0, 1) AS start_delay_min,
           (${severityParts.join(" + ")}) AS severity_score,
           TRIM(
             ${reasonParts.join(" || ")},
             ','
           ) AS exception_reasons
    ${baseFrom()}
    WHERE ${allClauses.join(" AND ")}
    ORDER BY severity_score DESC, scrap_rate DESC, start_delay_min DESC`;
  const params = [...selectedThresholdParams, ...selectedThresholdParams, ...filter.params, ...conditionParams];
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const rows = runReadOnlySql({ sql, params, limit: safeLimit }).rows;
  return { scope: filter.normalized, exceptionTypes: uniqueTypes, thresholds, rows, returned: rows.length };
}

export const productionMetricDefinitions = METRIC_DEFINITIONS;
