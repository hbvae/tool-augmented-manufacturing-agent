import { DataToolError, runReadOnlySql } from "./database.mjs";

const BREAKDOWN_DIMENSIONS = new Set(["supplier", "region", "material", "material_type", "supplier_rating", "inspection_result", "preference", "month", "day"]);
const TREND_GRAINS = new Set(["day", "week", "month"]);
const SORT_FIELDS = new Set(["receipt_count", "received_qty", "purchase_spend_cny", "incoming_defect_qty", "defect_rate", "pass_rate", "on_time_rate", "avg_lead_time_days", "avg_delay_days", "cost_variance_rate", "preferred_receipt_rate"]);
const EXCEPTION_TYPES = new Set(["late_delivery", "high_defect_rate", "failed_inspection", "high_cost_variance", "non_preferred_supplier"]);

const METRIC_DEFINITIONS = {
  defect_rate: "SUM(incoming_defect_qty) / SUM(received_qty)",
  pass_rate: "PASS receipt count / receipt_count",
  on_time_rate: "receipts with actual_lead_time_days <= contract_lead_time_days / receipt_count",
  purchase_spend_cny: "SUM(received_qty * unit_cost_cny)",
  standard_cost_value_cny: "SUM(received_qty * standard_cost_cny)",
  cost_variance_rate: "purchase_spend_cny / standard_cost_value_cny - 1",
  preferred_receipt_rate: "receipts where supplier_id = preferred_supplier_id / receipt_count",
  avg_delay_days: "AVG(actual_lead_time_days - contract_lead_time_days)",
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
  if (!Array.isArray(values) || values.length > 100 || values.some((value) => typeof value !== "string" || !value.trim())) throw new DataToolError("INVALID_SCOPE", `${field} must contain at most 100 non-empty strings`);
  return [...new Set(values.map((value) => value.trim()))];
}

function normalizeScope(scope = {}) {
  const normalized = {
    dateFrom: requireIsoDate(scope.dateFrom, "dateFrom"),
    dateTo: requireIsoDate(scope.dateTo, "dateTo"),
    supplierIds: validateList(scope.supplierIds, "supplierIds"),
    materialIds: validateList(scope.materialIds, "materialIds"),
    regions: validateList(scope.regions, "regions"),
    materialTypes: validateList(scope.materialTypes, "materialTypes"),
    supplierRatings: validateList(scope.supplierRatings, "supplierRatings"),
    inspectionResults: validateList(scope.inspectionResults, "inspectionResults"),
    supplierPreference: scope.supplierPreference ?? "any",
  };
  if (normalized.dateFrom && normalized.dateTo && normalized.dateFrom > normalized.dateTo) throw new DataToolError("INVALID_DATE_RANGE", "dateFrom must not be later than dateTo");
  if (!new Set(["any", "preferred", "non_preferred"]).has(normalized.supplierPreference)) throw new DataToolError("INVALID_SCOPE", "supplierPreference must be any, preferred, or non_preferred");
  return normalized;
}

function addListFilter(clauses, params, column, values) {
  if (!values.length) return;
  clauses.push(`${column} IN (${values.map(() => "?").join(",")})`);
  params.push(...values);
}

function buildScope(scope) {
  const clauses = [];
  const params = [];
  if (scope.dateFrom) { clauses.push("r.receipt_date >= ?"); params.push(scope.dateFrom); }
  if (scope.dateTo) { clauses.push("r.receipt_date < ?"); params.push(nextDate(scope.dateTo)); }
  addListFilter(clauses, params, "r.supplier_id", scope.supplierIds);
  addListFilter(clauses, params, "r.material_id", scope.materialIds);
  addListFilter(clauses, params, "s.region", scope.regions);
  addListFilter(clauses, params, "s.material_type", scope.materialTypes);
  addListFilter(clauses, params, "s.supplier_rating", scope.supplierRatings);
  addListFilter(clauses, params, "r.inspection_result", scope.inspectionResults);
  if (scope.supplierPreference === "preferred") clauses.push("r.supplier_id = m.preferred_supplier_id");
  if (scope.supplierPreference === "non_preferred") clauses.push("r.supplier_id <> m.preferred_supplier_id");
  return { clauses, params };
}

function whereSql(filter) { return filter.clauses.length ? ` WHERE ${filter.clauses.join(" AND ")}` : ""; }
function baseFrom() { return " FROM supplier_receipts r JOIN suppliers s ON s.supplier_id = r.supplier_id JOIN materials m ON m.material_id = r.material_id"; }

function metricSql() {
  return `COUNT(*) AS receipt_count,
    COUNT(DISTINCT r.supplier_id) AS supplier_count,
    COUNT(DISTINCT r.material_id) AS material_count,
    SUM(r.received_qty) AS received_qty,
    ROUND(SUM(r.received_qty * r.unit_cost_cny), 2) AS purchase_spend_cny,
    ROUND(SUM(r.received_qty * m.standard_cost_cny), 2) AS standard_cost_value_cny,
    ROUND(SUM(r.received_qty * r.unit_cost_cny) - SUM(r.received_qty * m.standard_cost_cny), 2) AS cost_variance_cny,
    ROUND(SUM(r.received_qty * r.unit_cost_cny) * 1.0 / NULLIF(SUM(r.received_qty * m.standard_cost_cny), 0) - 1.0, 4) AS cost_variance_rate,
    SUM(r.incoming_defect_qty) AS incoming_defect_qty,
    ROUND(SUM(r.incoming_defect_qty) * 1.0 / NULLIF(SUM(r.received_qty), 0), 4) AS defect_rate,
    SUM(CASE WHEN r.inspection_result = 'PASS' THEN 1 ELSE 0 END) AS pass_count,
    SUM(CASE WHEN r.inspection_result <> 'PASS' THEN 1 ELSE 0 END) AS fail_count,
    ROUND(SUM(CASE WHEN r.inspection_result = 'PASS' THEN 1 ELSE 0 END) * 1.0 / COUNT(*), 4) AS pass_rate,
    SUM(CASE WHEN CAST(r.actual_lead_time_days AS REAL) <= CAST(s.contract_lead_time_days AS REAL) THEN 1 ELSE 0 END) AS on_time_count,
    SUM(CASE WHEN CAST(r.actual_lead_time_days AS REAL) > CAST(s.contract_lead_time_days AS REAL) THEN 1 ELSE 0 END) AS late_count,
    ROUND(SUM(CASE WHEN CAST(r.actual_lead_time_days AS REAL) <= CAST(s.contract_lead_time_days AS REAL) THEN 1 ELSE 0 END) * 1.0 / COUNT(*), 4) AS on_time_rate,
    ROUND(AVG(CAST(r.actual_lead_time_days AS REAL)), 2) AS avg_lead_time_days,
    ROUND(AVG(CAST(s.contract_lead_time_days AS REAL)), 2) AS avg_contract_lead_time_days,
    ROUND(AVG(CAST(r.actual_lead_time_days AS REAL) - CAST(s.contract_lead_time_days AS REAL)), 2) AS avg_delay_days,
    ROUND(AVG(CASE WHEN CAST(r.actual_lead_time_days AS REAL) > CAST(s.contract_lead_time_days AS REAL) THEN CAST(r.actual_lead_time_days AS REAL) - CAST(s.contract_lead_time_days AS REAL) END), 2) AS avg_late_days,
    SUM(CASE WHEN r.supplier_id = m.preferred_supplier_id THEN 1 ELSE 0 END) AS preferred_receipt_count,
    ROUND(SUM(CASE WHEN r.supplier_id = m.preferred_supplier_id THEN 1 ELSE 0 END) * 1.0 / COUNT(*), 4) AS preferred_receipt_rate`;
}

export function getSupplierSummary(input = {}) {
  const scope = normalizeScope(input);
  const filter = buildScope(scope);
  const row = runReadOnlySql({ sql: `SELECT ${metricSql()}${baseFrom()}${whereSql(filter)}`, params: filter.params, limit: 1 }).rows[0];
  return { scope, dataAvailable: Boolean(row?.receipt_count), metrics: row, metricDefinitions: METRIC_DEFINITIONS };
}

const breakdownMap = {
  supplier: { select: "r.supplier_id AS supplier_id, s.supplier_name AS supplier_name, s.region AS region, s.material_type AS material_type, s.supplier_rating AS supplier_rating", group: "r.supplier_id, s.supplier_name, s.region, s.material_type, s.supplier_rating" },
  region: { select: "s.region AS region", group: "s.region" },
  material: { select: "r.material_id AS material_id, m.material_name AS material_name, m.uom AS uom", group: "r.material_id, m.material_name, m.uom" },
  material_type: { select: "s.material_type AS material_type", group: "s.material_type" },
  supplier_rating: { select: "s.supplier_rating AS supplier_rating", group: "s.supplier_rating" },
  inspection_result: { select: "r.inspection_result AS inspection_result", group: "r.inspection_result" },
  preference: { select: "CASE WHEN r.supplier_id = m.preferred_supplier_id THEN 'PREFERRED' ELSE 'NON_PREFERRED' END AS preference", group: "CASE WHEN r.supplier_id = m.preferred_supplier_id THEN 'PREFERRED' ELSE 'NON_PREFERRED' END" },
  month: { select: "substr(r.receipt_date, 1, 7) AS month", group: "substr(r.receipt_date, 1, 7)" },
  day: { select: "r.receipt_date AS day", group: "r.receipt_date" },
};

export function analyzeSupplierBreakdown({ dimension, orderBy = "purchase_spend_cny", direction = "desc", limit = 100, ...input }) {
  if (!BREAKDOWN_DIMENSIONS.has(dimension)) throw new DataToolError("INVALID_DIMENSION", `Unsupported supplier dimension: ${dimension}`);
  if (!SORT_FIELDS.has(orderBy)) throw new DataToolError("INVALID_SORT_FIELD", `Unsupported supplier sort field: ${orderBy}`);
  const dir = String(direction).toLowerCase();
  if (!new Set(["asc", "desc"]).has(dir)) throw new DataToolError("INVALID_SORT", `Invalid sort direction: ${direction}`);
  const scope = normalizeScope(input);
  const filter = buildScope(scope);
  const config = breakdownMap[dimension];
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = runReadOnlySql({ sql: `SELECT ${config.select}, ${metricSql()}${baseFrom()}${whereSql(filter)} GROUP BY ${config.group} ORDER BY ${orderBy} ${dir.toUpperCase()}`, params: filter.params, limit: safeLimit }).rows;
  return { scope, dimension, rows, returned: rows.length, metricDefinitions: METRIC_DEFINITIONS };
}

const periodMap = { day: "r.receipt_date", week: "strftime('%Y-W%W', r.receipt_date)", month: "substr(r.receipt_date, 1, 7)" };

export function getSupplierTrend({ grain = "month", limit = 500, ...input }) {
  if (!TREND_GRAINS.has(grain)) throw new DataToolError("INVALID_GRAIN", `Unsupported time grain: ${grain}`);
  const scope = normalizeScope(input);
  const filter = buildScope(scope);
  const period = periodMap[grain];
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 500);
  const rows = runReadOnlySql({ sql: `SELECT ${period} AS period, ${metricSql()}${baseFrom()}${whereSql(filter)} GROUP BY ${period} ORDER BY period`, params: filter.params, limit: safeLimit }).rows;
  return { scope, grain, rows, returned: rows.length, metricDefinitions: METRIC_DEFINITIONS };
}

function validateScoreConfig(config) {
  const values = {
    targetDefectRate: config.targetDefectRate ?? 0.01,
    costVarianceTolerance: config.costVarianceTolerance ?? 0.1,
    leadTimeStdDevTolerance: config.leadTimeStdDevTolerance ?? 5,
    deliveryWeight: config.deliveryWeight ?? 0.35,
    qualityWeight: config.qualityWeight ?? 0.35,
    costWeight: config.costWeight ?? 0.2,
    stabilityWeight: config.stabilityWeight ?? 0.1,
  };
  for (const [name, value] of Object.entries(values)) if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new DataToolError("INVALID_SCORE_CONFIG", `${name} must be a non-negative number`);
  if (values.targetDefectRate <= 0 || values.costVarianceTolerance <= 0 || values.leadTimeStdDevTolerance <= 0) throw new DataToolError("INVALID_SCORE_CONFIG", "Score tolerances must be greater than zero");
  const weightTotal = values.deliveryWeight + values.qualityWeight + values.costWeight + values.stabilityWeight;
  if (weightTotal <= 0) throw new DataToolError("INVALID_SCORE_CONFIG", "At least one score weight must be greater than zero");
  return { ...values, weightTotal };
}

function clampScore(value) { return Math.max(0, Math.min(100, value)); }
function round(value, digits = 2) { return Number(value.toFixed(digits)); }

export function scoreSuppliers({ limit = 100, ...input } = {}) {
  const config = validateScoreConfig(input);
  const scope = normalizeScope(input);
  const filter = buildScope(scope);
  const sql = `SELECT r.supplier_id, s.supplier_name, s.region, s.material_type, s.supplier_rating, ${metricSql()}, SUM(CAST(r.actual_lead_time_days AS REAL)) AS lead_sum, SUM(CAST(r.actual_lead_time_days AS REAL) * CAST(r.actual_lead_time_days AS REAL)) AS lead_sum_squares${baseFrom()}${whereSql(filter)} GROUP BY r.supplier_id, s.supplier_name, s.region, s.material_type, s.supplier_rating`;
  const rawRows = runReadOnlySql({ sql, params: filter.params, limit: 500 }).rows;
  const rows = rawRows.map((row) => {
    const n = row.receipt_count;
    const variance = n > 1 ? Math.max(0, (row.lead_sum_squares - row.lead_sum * row.lead_sum / n) / (n - 1)) : 0;
    const leadTimeStdDev = Math.sqrt(variance);
    const deliveryScore = clampScore(row.on_time_rate * 100);
    const defectComponent = clampScore((1 - row.defect_rate / config.targetDefectRate) * 100);
    const qualityScore = clampScore((row.pass_rate * 100 + defectComponent) / 2);
    const costScore = clampScore((1 - Math.max(row.cost_variance_rate, 0) / config.costVarianceTolerance) * 100);
    const stabilityScore = clampScore((1 - leadTimeStdDev / config.leadTimeStdDevTolerance) * 100);
    const totalScore = (deliveryScore * config.deliveryWeight + qualityScore * config.qualityWeight + costScore * config.costWeight + stabilityScore * config.stabilityWeight) / config.weightTotal;
    const grade = totalScore >= 90 ? "A" : totalScore >= 80 ? "B" : totalScore >= 70 ? "C" : "D";
    const { lead_sum, lead_sum_squares, ...metrics } = row;
    return { ...metrics, lead_time_stddev_days: round(leadTimeStdDev), delivery_score: round(deliveryScore), quality_score: round(qualityScore), cost_score: round(costScore), stability_score: round(stabilityScore), total_score: round(totalScore), grade };
  }).sort((a, b) => b.total_score - a.total_score || a.supplier_id.localeCompare(b.supplier_id));
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
  return {
    scope,
    scoring: { targetDefectRate: config.targetDefectRate, costVarianceTolerance: config.costVarianceTolerance, leadTimeStdDevTolerance: config.leadTimeStdDevTolerance, weights: { delivery: round(config.deliveryWeight / config.weightTotal, 4), quality: round(config.qualityWeight / config.weightTotal, 4), cost: round(config.costWeight / config.weightTotal, 4), stability: round(config.stabilityWeight / config.weightTotal, 4) } },
    rows: rows.slice(0, safeLimit), returned: Math.min(rows.length, safeLimit), metricDefinitions: METRIC_DEFINITIONS,
  };
}

export function findSupplierExceptions({
  exceptionTypes = ["late_delivery", "high_defect_rate", "failed_inspection", "high_cost_variance", "non_preferred_supplier"],
  lateDaysAbove = 0, defectRateAbove = 0.01, costVarianceAbove = 0.1, limit = 100, ...input
} = {}) {
  const types = [...new Set(exceptionTypes)];
  if (!types.length || types.some((type) => !EXCEPTION_TYPES.has(type))) throw new DataToolError("INVALID_EXCEPTION_TYPE", `exceptionTypes must use: ${[...EXCEPTION_TYPES].join(", ")}`);
  const thresholds = { lateDaysAbove, defectRateAbove, costVarianceAbove };
  for (const [name, value] of Object.entries(thresholds)) if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new DataToolError("INVALID_THRESHOLD", `${name} must be a non-negative number`);
  const scope = normalizeScope(input);
  const filter = buildScope(scope);
  const rows = runReadOnlySql({ sql: `SELECT r.receipt_id, r.receipt_date, r.supplier_id, s.supplier_name, s.region, r.material_id, m.material_name, m.preferred_supplier_id, r.supplier_lot_id, r.received_qty, r.unit_cost_cny, m.standard_cost_cny, CAST(r.actual_lead_time_days AS REAL) AS actual_lead_time_days, CAST(s.contract_lead_time_days AS REAL) AS contract_lead_time_days, r.incoming_defect_qty, r.inspection_result${baseFrom()}${whereSql(filter)} ORDER BY r.receipt_date DESC, r.receipt_id`, params: filter.params, limit: 500 }).rows;
  const tests = {
    late_delivery: (row) => row.actual_lead_time_days - row.contract_lead_time_days > lateDaysAbove,
    high_defect_rate: (row) => row.received_qty > 0 && row.incoming_defect_qty / row.received_qty > defectRateAbove,
    failed_inspection: (row) => row.inspection_result !== "PASS",
    high_cost_variance: (row) => row.standard_cost_cny > 0 && row.unit_cost_cny / row.standard_cost_cny - 1 > costVarianceAbove,
    non_preferred_supplier: (row) => row.supplier_id !== row.preferred_supplier_id,
  };
  const labels = { late_delivery: "LATE_DELIVERY", high_defect_rate: "HIGH_DEFECT_RATE", failed_inspection: "FAILED_INSPECTION", high_cost_variance: "HIGH_COST_VARIANCE", non_preferred_supplier: "NON_PREFERRED_SUPPLIER" };
  const resultRows = rows.map((row) => {
    const reasons = types.filter((type) => tests[type](row));
    return { ...row, delay_days: row.actual_lead_time_days - row.contract_lead_time_days, receipt_defect_rate: row.received_qty > 0 ? round(row.incoming_defect_qty / row.received_qty, 4) : null, unit_cost_variance_rate: row.standard_cost_cny > 0 ? round(row.unit_cost_cny / row.standard_cost_cny - 1, 4) : null, severity_score: reasons.length, exception_reasons: reasons.map((type) => labels[type]).join(",") };
  }).filter((row) => row.severity_score > 0).sort((a, b) => b.severity_score - a.severity_score || b.delay_days - a.delay_days).slice(0, Math.min(Math.max(Number(limit) || 100, 1), 200));
  return { scope, exceptionTypes: types, thresholds, rows: resultRows, returned: resultRows.length };
}

export const supplierMetricDefinitions = METRIC_DEFINITIONS;
