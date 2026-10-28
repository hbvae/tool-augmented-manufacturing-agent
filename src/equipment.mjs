import { DataToolError, runReadOnlySql } from "./database.mjs";

const BREAKDOWN_DIMENSIONS = new Set(["machine", "line", "machine_type", "manufacturer", "status"]);
const DOWNTIME_DIMENSIONS = new Set(["machine", "line", "category", "reason", "severity", "planned_flag", "month", "day"]);
const TREND_GRAINS = new Set(["day", "week", "month"]);
const SORT_FIELDS = new Set([
  "machine_count", "order_count", "actual_qty", "good_qty", "scrap_qty", "runtime_min",
  "downtime_event_count", "downtime_min", "unplanned_downtime_min", "failure_count",
  "availability", "performance", "quality_rate", "oee", "mtbf_hours", "mttr_min",
  "electricity_kwh", "energy_runtime_hours", "kwh_per_runtime_hour",
]);
const EXCEPTION_TYPES = new Set(["high_downtime", "frequent_failures", "low_availability", "low_oee", "high_energy_intensity"]);

const METRIC_DEFINITIONS = {
  availability: "production runtime_min / (production runtime_min + unplanned downtime_min)",
  performance: "SUM(actual_qty * standard_cycle_min) / SUM(runtime_min)",
  quality_rate: "SUM(good_qty) / SUM(actual_qty)",
  oee: "availability * performance * quality_rate",
  mtbf_hours: "SUM(runtime_min) / 60 / failure_count; failure means downtime category FAILURE",
  mttr_min: "failure_downtime_min / failure_count",
  kwh_per_runtime_hour: "SUM(electricity_kwh) / SUM(energy_readings.runtime_hours)",
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

function normalizeScope(scope = {}) {
  const normalized = {
    dateFrom: requireIsoDate(scope.dateFrom, "dateFrom"),
    dateTo: requireIsoDate(scope.dateTo, "dateTo"),
    machineIds: validateList(scope.machineIds, "machineIds"),
    lineIds: validateList(scope.lineIds, "lineIds"),
    machineTypes: validateList(scope.machineTypes, "machineTypes"),
    manufacturers: validateList(scope.manufacturers, "manufacturers"),
    statuses: validateList(scope.statuses, "statuses"),
    productIds: validateList(scope.productIds, "productIds"),
    shifts: validateList(scope.shifts, "shifts"),
  };
  if (normalized.dateFrom && normalized.dateTo && normalized.dateFrom > normalized.dateTo) {
    throw new DataToolError("INVALID_DATE_RANGE", "dateFrom must not be later than dateTo");
  }
  return normalized;
}

function addListFilter(clauses, params, column, values) {
  if (!values.length) return;
  clauses.push(`${column} IN (${values.map(() => "?").join(",")})`);
  params.push(...values);
}

function machineFilters(scope, alias = "m") {
  const clauses = [];
  const params = [];
  addListFilter(clauses, params, `${alias}.machine_id`, scope.machineIds);
  addListFilter(clauses, params, `${alias}.line_id`, scope.lineIds);
  addListFilter(clauses, params, `${alias}.machine_type`, scope.machineTypes);
  addListFilter(clauses, params, `${alias}.manufacturer`, scope.manufacturers);
  addListFilter(clauses, params, `${alias}.status`, scope.statuses);
  return { clauses, params };
}

function sourceFilters(scope, source) {
  const filter = machineFilters(scope);
  const { clauses, params } = filter;
  const dateColumn = source === "production" ? "o.actual_start" : source === "downtime" ? "d.start_time" : "e.reading_date";
  if (scope.dateFrom) { clauses.push(`${dateColumn} >= ?`); params.push(source === "energy" ? scope.dateFrom : `${scope.dateFrom}T00:00:00`); }
  if (scope.dateTo) { clauses.push(`${dateColumn} < ?`); params.push(source === "energy" ? nextDate(scope.dateTo) : `${nextDate(scope.dateTo)}T00:00:00`); }
  if (source === "production") {
    addListFilter(clauses, params, "o.product_id", scope.productIds);
    addListFilter(clauses, params, "o.shift", scope.shifts);
  } else if (source === "downtime") {
    addListFilter(clauses, params, "o.product_id", scope.productIds);
    addListFilter(clauses, params, "o.shift", scope.shifts);
  }
  return { clauses, params };
}

function whereSql(filter) {
  return filter.clauses.length ? ` WHERE ${filter.clauses.join(" AND ")}` : "";
}

function emptyRaw(machine = {}) {
  return {
    ...machine,
    machine_count: machine.machine_id ? 1 : 0,
    order_count: 0, actual_qty: 0, good_qty: 0, scrap_qty: 0, runtime_min: 0, ideal_runtime_min: 0,
    downtime_event_count: 0, downtime_min: 0, planned_downtime_min: 0, unplanned_downtime_min: 0,
    failure_count: 0, failure_downtime_min: 0,
    energy_reading_count: 0, energy_runtime_hours: 0, electricity_kwh: 0,
  };
}

function number(value) { return value == null ? 0 : Number(value); }
function rounded(value, digits = 4) { return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits)); }
function ratio(numerator, denominator) { return denominator > 0 ? numerator / denominator : null; }

function calculateMetrics(raw, energyAvailable = true) {
  const availability = ratio(raw.runtime_min, raw.runtime_min + raw.unplanned_downtime_min);
  const performance = ratio(raw.ideal_runtime_min, raw.runtime_min);
  const qualityRate = ratio(raw.good_qty, raw.actual_qty);
  const oee = availability == null || performance == null || qualityRate == null ? null : availability * performance * qualityRate;
  return {
    ...raw,
    availability: rounded(availability),
    performance: rounded(performance),
    quality_rate: rounded(qualityRate),
    oee: rounded(oee),
    mtbf_hours: rounded(ratio(raw.runtime_min / 60, raw.failure_count), 2),
    mttr_min: rounded(ratio(raw.failure_downtime_min, raw.failure_count), 2),
    energy_reading_count: energyAvailable ? raw.energy_reading_count : null,
    energy_runtime_hours: energyAvailable ? rounded(raw.energy_runtime_hours, 2) : null,
    electricity_kwh: energyAvailable ? rounded(raw.electricity_kwh, 2) : null,
    kwh_per_runtime_hour: energyAvailable ? rounded(ratio(raw.electricity_kwh, raw.energy_runtime_hours), 3) : null,
  };
}

function addRaw(target, source) {
  for (const key of ["machine_count", "order_count", "actual_qty", "good_qty", "scrap_qty", "runtime_min", "ideal_runtime_min", "downtime_event_count", "downtime_min", "planned_downtime_min", "unplanned_downtime_min", "failure_count", "failure_downtime_min", "energy_reading_count", "energy_runtime_hours", "electricity_kwh"]) {
    target[key] = number(target[key]) + number(source[key]);
  }
  return target;
}

function getMachineRows(scope) {
  const filter = machineFilters(scope);
  return runReadOnlySql({
    sql: `SELECT m.machine_id, m.line_id, m.machine_type, m.manufacturer, m.install_date, m.rated_power_kw, m.status FROM machines m${whereSql(filter)} ORDER BY m.machine_id`,
    params: filter.params, limit: 500,
  }).rows;
}

function getProductionRows(scope, periodExpression = null) {
  const filter = sourceFilters(scope, "production");
  const key = periodExpression ? `${periodExpression} AS group_key` : "o.machine_id AS group_key";
  return runReadOnlySql({
    sql: `SELECT ${key}, COUNT(*) AS order_count, SUM(o.actual_qty) AS actual_qty, SUM(o.good_qty) AS good_qty, SUM(o.scrap_qty) AS scrap_qty, SUM(o.runtime_min) AS runtime_min, SUM(o.actual_qty * p.standard_cycle_min) AS ideal_runtime_min FROM production_orders o JOIN products p ON p.product_id = o.product_id JOIN machines m ON m.machine_id = o.machine_id${whereSql(filter)} GROUP BY group_key`,
    params: filter.params, limit: 500,
  }).rows;
}

function getDowntimeRows(scope, periodExpression = null) {
  const filter = sourceFilters(scope, "downtime");
  const key = periodExpression ? `${periodExpression} AS group_key` : "d.machine_id AS group_key";
  return runReadOnlySql({
    sql: `SELECT ${key}, COUNT(*) AS downtime_event_count, SUM(d.duration_min) AS downtime_min, SUM(CASE WHEN d.planned_flag = 1 THEN d.duration_min ELSE 0 END) AS planned_downtime_min, SUM(CASE WHEN d.planned_flag = 0 THEN d.duration_min ELSE 0 END) AS unplanned_downtime_min, SUM(CASE WHEN d.category = 'FAILURE' THEN 1 ELSE 0 END) AS failure_count, SUM(CASE WHEN d.category = 'FAILURE' THEN d.duration_min ELSE 0 END) AS failure_downtime_min FROM downtime_events d JOIN machines m ON m.machine_id = d.machine_id LEFT JOIN production_orders o ON o.order_id = NULLIF(d.order_id, '')${whereSql(filter)} GROUP BY group_key`,
    params: filter.params, limit: 500,
  }).rows;
}

function getEnergyRows(scope, periodExpression = null) {
  if (scope.productIds.length || scope.shifts.length) return [];
  const filter = sourceFilters(scope, "energy");
  const key = periodExpression ? `${periodExpression} AS group_key` : "e.machine_id AS group_key";
  return runReadOnlySql({
    sql: `SELECT ${key}, COUNT(*) AS energy_reading_count, SUM(CAST(e.runtime_hours AS REAL)) AS energy_runtime_hours, SUM(e.electricity_kwh) AS electricity_kwh FROM energy_readings e JOIN machines m ON m.machine_id = e.machine_id${whereSql(filter)} GROUP BY group_key`,
    params: filter.params, limit: 500,
  }).rows;
}

function mergeByMachine(scope) {
  const machines = getMachineRows(scope);
  const map = new Map(machines.map((machine) => [machine.machine_id, emptyRaw(machine)]));
  for (const rows of [getProductionRows(scope), getDowntimeRows(scope), getEnergyRows(scope)]) {
    for (const row of rows) if (map.has(row.group_key)) Object.assign(map.get(row.group_key), row);
  }
  const energyAvailable = !scope.productIds.length && !scope.shifts.length;
  return { rows: [...map.values()].map((row) => calculateMetrics(row, energyAvailable)), energyAvailable };
}

function dataNotes(scope, energyAvailable) {
  const notes = ["OEE is a data-derived proxy because the dataset has no planned production calendar.", "Availability uses production runtime plus unplanned downtime as the operating-time denominator."];
  if (!energyAvailable) notes.push("Energy metrics are null when productIds or shifts are supplied because energy readings have daily machine granularity only.");
  if (scope.shifts.length) notes.push("Downtime under a shift filter includes only events linked to a production order; unlinked events have no shift attribution.");
  return notes;
}

function rawFromMetricRow(row) {
  const raw = emptyRaw();
  addRaw(raw, row);
  return raw;
}

export function getEquipmentSummary(input = {}) {
  const scope = normalizeScope(input);
  const merged = mergeByMachine(scope);
  const raw = emptyRaw();
  raw.machine_count = 0;
  for (const row of merged.rows) addRaw(raw, rawFromMetricRow(row));
  return {
    scope,
    dataAvailable: merged.rows.length > 0,
    metrics: calculateMetrics(raw, merged.energyAvailable),
    metricDefinitions: METRIC_DEFINITIONS,
    dataNotes: dataNotes(scope, merged.energyAvailable),
  };
}

const dimensionKey = {
  machine: (row) => ({ machine_id: row.machine_id, line_id: row.line_id, machine_type: row.machine_type, manufacturer: row.manufacturer, status: row.status }),
  line: (row) => ({ line_id: row.line_id }),
  machine_type: (row) => ({ machine_type: row.machine_type }),
  manufacturer: (row) => ({ manufacturer: row.manufacturer }),
  status: (row) => ({ status: row.status }),
};

export function analyzeEquipmentBreakdown({ dimension, orderBy = "downtime_min", direction = "desc", limit = 100, ...input }) {
  if (!BREAKDOWN_DIMENSIONS.has(dimension)) throw new DataToolError("INVALID_DIMENSION", `Unsupported equipment dimension: ${dimension}`);
  if (!SORT_FIELDS.has(orderBy)) throw new DataToolError("INVALID_SORT_FIELD", `Unsupported equipment sort field: ${orderBy}`);
  const dir = String(direction).toLowerCase();
  if (!new Set(["asc", "desc"]).has(dir)) throw new DataToolError("INVALID_SORT", `Invalid sort direction: ${direction}`);
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const scope = normalizeScope(input);
  const merged = mergeByMachine(scope);
  const grouped = new Map();
  for (const row of merged.rows) {
    const labels = dimensionKey[dimension](row);
    const key = JSON.stringify(labels);
    if (!grouped.has(key)) grouped.set(key, { ...labels, ...emptyRaw() });
    addRaw(grouped.get(key), row);
  }
  const rows = [...grouped.values()].map((row) => calculateMetrics(row, merged.energyAvailable));
  rows.sort((a, b) => {
    const av = a[orderBy]; const bv = b[orderBy];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return dir === "asc" ? av - bv : bv - av;
  });
  return { scope, dimension, rows: rows.slice(0, safeLimit), returned: Math.min(rows.length, safeLimit), metricDefinitions: METRIC_DEFINITIONS, dataNotes: dataNotes(scope, merged.energyAvailable) };
}

const periodExpressions = {
  day: { production: "substr(o.actual_start, 1, 10)", downtime: "substr(d.start_time, 1, 10)", energy: "e.reading_date" },
  week: { production: "strftime('%Y-W%W', o.actual_start)", downtime: "strftime('%Y-W%W', d.start_time)", energy: "strftime('%Y-W%W', e.reading_date)" },
  month: { production: "substr(o.actual_start, 1, 7)", downtime: "substr(d.start_time, 1, 7)", energy: "substr(e.reading_date, 1, 7)" },
};

export function getEquipmentTrend({ grain = "month", limit = 500, ...input }) {
  if (!TREND_GRAINS.has(grain)) throw new DataToolError("INVALID_GRAIN", `Unsupported time grain: ${grain}`);
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 500);
  const scope = normalizeScope(input);
  const expressions = periodExpressions[grain];
  const map = new Map();
  for (const rows of [getProductionRows(scope, expressions.production), getDowntimeRows(scope, expressions.downtime), getEnergyRows(scope, expressions.energy)]) {
    for (const row of rows) {
      if (!map.has(row.group_key)) map.set(row.group_key, emptyRaw());
      addRaw(map.get(row.group_key), row);
    }
  }
  const energyAvailable = !scope.productIds.length && !scope.shifts.length;
  const rows = [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, safeLimit).map(([period, raw]) => ({ period, ...calculateMetrics(raw, energyAvailable), machine_count: null }));
  return { scope, grain, rows, returned: rows.length, metricDefinitions: METRIC_DEFINITIONS, dataNotes: dataNotes(scope, energyAvailable) };
}

const downtimeDimensionMap = {
  machine: { select: "d.machine_id AS machine_id, m.machine_type AS machine_type", group: "d.machine_id, m.machine_type" },
  line: { select: "m.line_id AS line_id", group: "m.line_id" },
  category: { select: "d.category AS category", group: "d.category" },
  reason: { select: "d.reason AS reason", group: "d.reason" },
  severity: { select: "d.severity AS severity", group: "d.severity" },
  planned_flag: { select: "d.planned_flag AS planned_flag", group: "d.planned_flag" },
  month: { select: "substr(d.start_time, 1, 7) AS month", group: "substr(d.start_time, 1, 7)" },
  day: { select: "substr(d.start_time, 1, 10) AS day", group: "substr(d.start_time, 1, 10)" },
};

export function analyzeDowntime({ dimension, orderBy = "downtime_min", direction = "desc", limit = 100, ...input }) {
  if (!DOWNTIME_DIMENSIONS.has(dimension)) throw new DataToolError("INVALID_DIMENSION", `Unsupported downtime dimension: ${dimension}`);
  if (!new Set(["event_count", "downtime_min", "avg_duration_min", "max_duration_min"]).has(orderBy)) throw new DataToolError("INVALID_SORT_FIELD", `Unsupported downtime sort field: ${orderBy}`);
  const dir = String(direction).toLowerCase();
  if (!new Set(["asc", "desc"]).has(dir)) throw new DataToolError("INVALID_SORT", `Invalid sort direction: ${direction}`);
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const scope = normalizeScope(input);
  const filter = sourceFilters(scope, "downtime");
  const config = downtimeDimensionMap[dimension];
  const sql = `SELECT ${config.select}, COUNT(*) AS event_count, SUM(d.duration_min) AS downtime_min, ROUND(AVG(d.duration_min), 2) AS avg_duration_min, MAX(d.duration_min) AS max_duration_min, SUM(CASE WHEN d.planned_flag = 0 THEN d.duration_min ELSE 0 END) AS unplanned_downtime_min, SUM(CASE WHEN d.category = 'FAILURE' THEN 1 ELSE 0 END) AS failure_count FROM downtime_events d JOIN machines m ON m.machine_id = d.machine_id LEFT JOIN production_orders o ON o.order_id = NULLIF(d.order_id, '')${whereSql(filter)} GROUP BY ${config.group} ORDER BY ${orderBy} ${dir.toUpperCase()}`;
  const rows = runReadOnlySql({ sql, params: filter.params, limit: safeLimit }).rows;
  return { scope, dimension, rows, returned: rows.length, dataNotes: dataNotes(scope, true) };
}

export function calculateEquipmentOee({ dimension = "machine", ...input } = {}) {
  if (dimension === "overall") {
    const summary = getEquipmentSummary(input);
    return { scope: summary.scope, dimension, rows: [summary.metrics], returned: 1, metricDefinitions: METRIC_DEFINITIONS, dataNotes: summary.dataNotes };
  }
  if (!new Set(["machine", "line", "machine_type"]).has(dimension)) throw new DataToolError("INVALID_DIMENSION", "OEE dimension must be overall, machine, line, or machine_type");
  return analyzeEquipmentBreakdown({ ...input, dimension, orderBy: "oee", direction: "asc", limit: 500 });
}

export function findEquipmentExceptions({
  exceptionTypes = ["high_downtime", "frequent_failures", "low_availability", "low_oee", "high_energy_intensity"],
  downtimeAboveMin = 600, failureCountAbove = 5, availabilityBelow = 0.9, oeeBelow = 0.75,
  energyPerRuntimeHourAbove = 30, limit = 100, ...input
}) {
  const types = [...new Set(exceptionTypes)];
  if (!types.length || types.some((type) => !EXCEPTION_TYPES.has(type))) throw new DataToolError("INVALID_EXCEPTION_TYPE", `exceptionTypes must use: ${[...EXCEPTION_TYPES].join(", ")}`);
  const thresholds = { downtimeAboveMin, failureCountAbove, availabilityBelow, oeeBelow, energyPerRuntimeHourAbove };
  for (const [name, value] of Object.entries(thresholds)) if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new DataToolError("INVALID_THRESHOLD", `${name} must be a non-negative number`);
  const breakdown = analyzeEquipmentBreakdown({ ...input, dimension: "machine", orderBy: "downtime_min", direction: "desc", limit: 500 });
  const tests = {
    high_downtime: (row) => row.unplanned_downtime_min > downtimeAboveMin,
    frequent_failures: (row) => row.failure_count > failureCountAbove,
    low_availability: (row) => row.availability != null && row.availability < availabilityBelow,
    low_oee: (row) => row.oee != null && row.oee < oeeBelow,
    high_energy_intensity: (row) => row.kwh_per_runtime_hour != null && row.kwh_per_runtime_hour > energyPerRuntimeHourAbove,
  };
  const labels = { high_downtime: "HIGH_DOWNTIME", frequent_failures: "FREQUENT_FAILURES", low_availability: "LOW_AVAILABILITY", low_oee: "LOW_OEE", high_energy_intensity: "HIGH_ENERGY_INTENSITY" };
  const rows = breakdown.rows.map((row) => {
    const reasons = types.filter((type) => tests[type](row));
    return { ...row, severity_score: reasons.length, exception_reasons: reasons.map((type) => labels[type]).join(",") };
  }).filter((row) => row.severity_score > 0).sort((a, b) => b.severity_score - a.severity_score || b.unplanned_downtime_min - a.unplanned_downtime_min).slice(0, Math.min(Math.max(Number(limit) || 100, 1), 200));
  return { scope: breakdown.scope, exceptionTypes: types, thresholds, rows, returned: rows.length, metricDefinitions: METRIC_DEFINITIONS, dataNotes: breakdown.dataNotes };
}

export const equipmentMetricDefinitions = METRIC_DEFINITIONS;
