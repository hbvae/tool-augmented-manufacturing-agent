import { DataToolError, runReadOnlySql } from "./database.mjs";

const BREAKDOWN_DIMENSIONS = new Set(["machine", "line", "product", "shift", "stage", "defect_type", "inspector", "result", "month", "day"]);
const TREND_GRAINS = new Set(["day", "week", "month"]);
const SORT_FIELDS = new Set([
  "inspection_count", "pass_count", "fail_count", "pass_rate", "fail_rate",
  "sample_size", "defect_count", "sample_defect_rate", "out_of_spec_count", "out_of_spec_rate",
]);
const EXCEPTION_TYPES = new Set(["failed_result", "out_of_spec", "high_defect_rate"]);

const METRIC_DEFINITIONS = {
  pass_rate: "pass_count / inspection_count",
  fail_rate: "fail_count / inspection_count",
  sample_defect_rate: "SUM(defect_count) / SUM(sample_size)",
  defect_free_inspection_rate: "inspections with defect_count = 0 / inspection_count",
  out_of_spec_rate: "measurements outside specification limits / inspection_count",
  defects_per_1000_samples: "SUM(defect_count) * 1000 / SUM(sample_size)",
};

function requireIsoDate(value, field) {
  if (value == null) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DataToolError("INVALID_DATE", `${field} must use YYYY-MM-DD format`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new DataToolError("INVALID_DATE", `${field} is not a valid calendar date`);
  return value;
}

function nextDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function validateList(values, field) {
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
  if (dateFrom) { clauses.push("q.inspection_time >= ?"); params.push(`${dateFrom}T00:00:00`); }
  if (dateTo) { clauses.push("q.inspection_time < ?"); params.push(`${nextDate(dateTo)}T00:00:00`); }
  const mappings = [
    ["machineIds", "o.machine_id"], ["productIds", "o.product_id"], ["lineIds", "o.line_id"],
    ["shifts", "o.shift"], ["stages", "q.inspection_stage"], ["results", "q.result"],
    ["defectTypes", "q.defect_type"], ["inspectorIds", "q.inspector_id"],
  ];
  const normalized = { dateFrom, dateTo };
  for (const [field, column] of mappings) {
    const values = validateList(scope[field], field);
    normalized[field] = values;
    if (values.length) {
      clauses.push(`${column} IN (${values.map(() => "?").join(",")})`);
      params.push(...values);
    }
  }
  return { clauses, params, normalized };
}

function metricSql() {
  return `
    COUNT(*) AS inspection_count,
    SUM(CASE WHEN q.result = 'PASS' THEN 1 ELSE 0 END) AS pass_count,
    SUM(CASE WHEN q.result = 'FAIL' THEN 1 ELSE 0 END) AS fail_count,
    ROUND(SUM(CASE WHEN q.result = 'PASS' THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*), 0), 4) AS pass_rate,
    ROUND(SUM(CASE WHEN q.result = 'FAIL' THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*), 0), 4) AS fail_rate,
    SUM(q.sample_size) AS sample_size,
    SUM(q.defect_count) AS defect_count,
    ROUND(SUM(q.defect_count) * 1.0 / NULLIF(SUM(q.sample_size), 0), 4) AS sample_defect_rate,
    ROUND(SUM(q.defect_count) * 1000.0 / NULLIF(SUM(q.sample_size), 0), 2) AS defects_per_1000_samples,
    SUM(CASE WHEN q.defect_count = 0 THEN 1 ELSE 0 END) AS defect_free_inspection_count,
    ROUND(SUM(CASE WHEN q.defect_count = 0 THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*), 0), 4) AS defect_free_inspection_rate,
    SUM(CASE WHEN q.measured_value_mm < q.spec_lower_mm OR q.measured_value_mm > q.spec_upper_mm THEN 1 ELSE 0 END) AS out_of_spec_count,
    ROUND(SUM(CASE WHEN q.measured_value_mm < q.spec_lower_mm OR q.measured_value_mm > q.spec_upper_mm THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*), 0), 4) AS out_of_spec_rate`;
}

function baseFrom() {
  return " FROM quality_inspections q JOIN production_orders o ON o.order_id = q.order_id JOIN products p ON p.product_id = o.product_id JOIN machines m ON m.machine_id = o.machine_id";
}

export function getQualitySummary(scope = {}) {
  const filter = buildScope(scope);
  const where = filter.clauses.length ? ` WHERE ${filter.clauses.join(" AND ")}` : "";
  const sql = `SELECT COUNT(DISTINCT q.order_id) AS order_count, COUNT(DISTINCT o.product_id) AS product_count, COUNT(DISTINCT o.machine_id) AS machine_count, ${metricSql()}${baseFrom()}${where}`;
  const row = runReadOnlySql({ sql, params: filter.params, limit: 1 }).rows[0];
  return { scope: filter.normalized, dataAvailable: Boolean(row?.inspection_count), metrics: row, metricDefinitions: METRIC_DEFINITIONS };
}

const breakdownMap = {
  machine: { select: "o.machine_id AS machine_id, m.machine_type AS machine_type", group: "o.machine_id, m.machine_type" },
  line: { select: "o.line_id AS line_id", group: "o.line_id" },
  product: { select: "o.product_id AS product_id, p.product_name AS product_name", group: "o.product_id, p.product_name" },
  shift: { select: "o.shift AS shift", group: "o.shift" },
  stage: { select: "q.inspection_stage AS inspection_stage", group: "q.inspection_stage" },
  defect_type: { select: "q.defect_type AS defect_type", group: "q.defect_type" },
  inspector: { select: "q.inspector_id AS inspector_id", group: "q.inspector_id" },
  result: { select: "q.result AS result", group: "q.result" },
  month: { select: "substr(q.inspection_time, 1, 7) AS month", group: "substr(q.inspection_time, 1, 7)" },
  day: { select: "substr(q.inspection_time, 1, 10) AS day", group: "substr(q.inspection_time, 1, 10)" },
};

export function analyzeQualityBreakdown({ dimension, orderBy = "inspection_count", direction = "desc", limit = 100, ...scope }) {
  if (!BREAKDOWN_DIMENSIONS.has(dimension)) throw new DataToolError("INVALID_DIMENSION", `Unsupported quality dimension: ${dimension}`);
  if (!SORT_FIELDS.has(orderBy)) throw new DataToolError("INVALID_SORT_FIELD", `Unsupported quality sort field: ${orderBy}`);
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
  day: "substr(q.inspection_time, 1, 10)",
  week: "strftime('%Y-W%W', q.inspection_time)",
  month: "substr(q.inspection_time, 1, 7)",
};

export function getQualityTrend({ grain = "month", limit = 500, ...scope }) {
  if (!TREND_GRAINS.has(grain)) throw new DataToolError("INVALID_GRAIN", `Unsupported quality time grain: ${grain}`);
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 500);
  const filter = buildScope(scope);
  const where = filter.clauses.length ? ` WHERE ${filter.clauses.join(" AND ")}` : "";
  const period = trendMap[grain];
  const sql = `SELECT ${period} AS period, ${metricSql()}${baseFrom()}${where} GROUP BY ${period} ORDER BY period ASC`;
  const rows = runReadOnlySql({ sql, params: filter.params, limit: safeLimit }).rows;
  return { scope: filter.normalized, grain, rows, returned: rows.length, metricDefinitions: METRIC_DEFINITIONS };
}

export function findQualityExceptions({
  exceptionTypes = ["failed_result", "out_of_spec", "high_defect_rate"],
  defectRateAbove = 0.1,
  limit = 100,
  ...scope
}) {
  const uniqueTypes = [...new Set(exceptionTypes)];
  if (!uniqueTypes.length || uniqueTypes.some((type) => !EXCEPTION_TYPES.has(type))) {
    throw new DataToolError("INVALID_EXCEPTION_TYPE", `exceptionTypes must use: ${[...EXCEPTION_TYPES].join(", ")}`);
  }
  if (typeof defectRateAbove !== "number" || !Number.isFinite(defectRateAbove) || defectRateAbove < 0) {
    throw new DataToolError("INVALID_THRESHOLD", "defectRateAbove must be a non-negative number");
  }
  const specs = {
    failed_result: { sql: "q.result = 'FAIL'", params: [], label: "FAILED_RESULT" },
    out_of_spec: { sql: "q.measured_value_mm < q.spec_lower_mm OR q.measured_value_mm > q.spec_upper_mm", params: [], label: "OUT_OF_SPEC" },
    high_defect_rate: { sql: "q.defect_count * 1.0 / NULLIF(q.sample_size, 0) > ?", params: [defectRateAbove], label: "HIGH_DEFECT_RATE" },
  };
  const filter = buildScope(scope);
  const conditions = uniqueTypes.map((type) => `(${specs[type].sql})`);
  const conditionParams = uniqueTypes.flatMap((type) => specs[type].params);
  const severityParts = uniqueTypes.map((type) => `CASE WHEN ${specs[type].sql} THEN 1 ELSE 0 END`);
  const severityParams = uniqueTypes.flatMap((type) => specs[type].params);
  const reasonParts = uniqueTypes.map((type) => `CASE WHEN ${specs[type].sql} THEN '${specs[type].label},' ELSE '' END`);
  const reasonParams = uniqueTypes.flatMap((type) => specs[type].params);
  const clauses = [...filter.clauses, `(${conditions.join(" OR ")})`];
  const sql = `
    SELECT q.inspection_id, q.order_id, q.inspection_time, q.inspection_stage,
           o.product_id, p.product_name, o.machine_id, o.line_id, o.shift,
           q.sample_size, q.defect_count,
           ROUND(q.defect_count * 1.0 / NULLIF(q.sample_size, 0), 4) AS sample_defect_rate,
           q.defect_type, q.measured_value_mm, q.spec_lower_mm, q.spec_upper_mm, q.result, q.inspector_id,
           (${severityParts.join(" + ")}) AS severity_score,
           TRIM(${reasonParts.join(" || ")}, ',') AS exception_reasons
    ${baseFrom()}
    WHERE ${clauses.join(" AND ")}
    ORDER BY severity_score DESC, sample_defect_rate DESC, q.inspection_time DESC`;
  const params = [...severityParams, ...reasonParams, ...filter.params, ...conditionParams];
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const rows = runReadOnlySql({ sql, params, limit: safeLimit }).rows;
  return { scope: filter.normalized, exceptionTypes: uniqueTypes, thresholds: { defectRateAbove }, rows, returned: rows.length };
}

const capabilityMap = {
  overall: { select: "'ALL' AS group_key", group: "" },
  machine: { select: "o.machine_id AS group_key", group: " GROUP BY o.machine_id" },
  product: { select: "o.product_id AS group_key", group: " GROUP BY o.product_id" },
  line: { select: "o.line_id AS group_key", group: " GROUP BY o.line_id" },
  shift: { select: "o.shift AS group_key", group: " GROUP BY o.shift" },
  stage: { select: "q.inspection_stage AS group_key", group: " GROUP BY q.inspection_stage" },
  inspector: { select: "q.inspector_id AS group_key", group: " GROUP BY q.inspector_id" },
};

export function analyzeProcessCapability({ dimension = "overall", minSampleSize = 20, limit = 100, ...scope }) {
  if (!Object.hasOwn(capabilityMap, dimension)) throw new DataToolError("INVALID_DIMENSION", `Unsupported capability dimension: ${dimension}`);
  if (!Number.isInteger(minSampleSize) || minSampleSize < 2 || minSampleSize > 10000) throw new DataToolError("INVALID_SAMPLE_SIZE", "minSampleSize must be an integer from 2 to 10000");
  const filter = buildScope(scope);
  const baseClauses = ["q.measured_value_mm IS NOT NULL", "q.spec_lower_mm IS NOT NULL", "q.spec_upper_mm IS NOT NULL", ...filter.clauses];
  const config = capabilityMap[dimension];
  const sql = `
    SELECT ${config.select}, COUNT(*) AS sample_count,
           SUM(q.measured_value_mm) AS sum_x,
           SUM(q.measured_value_mm * q.measured_value_mm) AS sum_x2,
           ROUND(AVG(q.measured_value_mm), 6) AS mean,
           MIN(q.measured_value_mm) AS minimum,
           MAX(q.measured_value_mm) AS maximum,
           MIN(q.spec_lower_mm) AS spec_lower_min,
           MAX(q.spec_lower_mm) AS spec_lower_max,
           MIN(q.spec_upper_mm) AS spec_upper_min,
           MAX(q.spec_upper_mm) AS spec_upper_max,
           COUNT(DISTINCT q.spec_lower_mm || '|' || q.spec_upper_mm) AS specification_pair_count,
           SUM(CASE WHEN q.measured_value_mm < q.spec_lower_mm OR q.measured_value_mm > q.spec_upper_mm THEN 1 ELSE 0 END) AS out_of_spec_count
    ${baseFrom()}
    WHERE ${baseClauses.join(" AND ")}
    ${config.group}
    HAVING COUNT(*) >= ?
    ORDER BY sample_count DESC`;
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
  const rawRows = runReadOnlySql({ sql, params: [...filter.params, minSampleSize], limit: safeLimit }).rows;
  const rows = rawRows.map((row) => {
    const n = row.sample_count;
    const variance = n > 1 ? Math.max(0, (row.sum_x2 - (row.sum_x * row.sum_x) / n) / (n - 1)) : null;
    const standardDeviation = variance == null ? null : Math.sqrt(variance);
    const mixedSpecifications = row.specification_pair_count !== 1;
    let status = "OK";
    let cp = null;
    let cpk = null;
    if (mixedSpecifications) status = "MIXED_SPECIFICATIONS";
    else if (standardDeviation == null || standardDeviation === 0) status = "ZERO_OR_INSUFFICIENT_VARIATION";
    else {
      const lower = row.spec_lower_min;
      const upper = row.spec_upper_min;
      cp = (upper - lower) / (6 * standardDeviation);
      cpk = Math.min((upper - row.mean) / (3 * standardDeviation), (row.mean - lower) / (3 * standardDeviation));
    }
    return {
      group_key: row.group_key,
      sample_count: n,
      mean: row.mean,
      standard_deviation: standardDeviation == null ? null : Number(standardDeviation.toFixed(6)),
      minimum: row.minimum,
      maximum: row.maximum,
      spec_lower: mixedSpecifications ? null : row.spec_lower_min,
      spec_upper: mixedSpecifications ? null : row.spec_upper_min,
      out_of_spec_count: row.out_of_spec_count,
      out_of_spec_rate: Number((row.out_of_spec_count / n).toFixed(4)),
      cp: cp == null ? null : Number(cp.toFixed(4)),
      cpk: cpk == null ? null : Number(cpk.toFixed(4)),
      status,
    };
  });
  return {
    scope: filter.normalized,
    dimension,
    minSampleSize,
    rows,
    returned: rows.length,
    warning: "Cp/Cpk interpretation assumes a statistically stable process. This tool calculates descriptive capability values but does not establish process control.",
  };
}

export const qualityMetricDefinitions = METRIC_DEFINITIONS;
