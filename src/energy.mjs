import { DataToolError, runReadOnlySql } from "./database.mjs";

const BREAKDOWN_DIMENSIONS = new Set(["machine", "line", "machine_type", "manufacturer", "status"]);
const TREND_GRAINS = new Set(["day", "week", "month"]);
const SORT_FIELDS = new Set([
  "reading_count", "runtime_hours", "electricity_kwh", "compressed_air_m3", "coolant_liter",
  "idle_reading_count", "idle_electricity_kwh", "max_peak_demand_kw", "avg_peak_demand_kw",
  "kwh_per_runtime_hour", "air_m3_per_runtime_hour", "coolant_liter_per_runtime_hour",
  "electric_load_factor", "good_qty", "kwh_per_good_unit",
]);
const EXCEPTION_TYPES = new Set(["idle_consumption", "high_electricity_intensity", "high_air_intensity", "high_coolant_intensity", "high_peak_utilization"]);

const METRIC_DEFINITIONS = {
  kwh_per_runtime_hour: "SUM(electricity_kwh) / SUM(runtime_hours)",
  air_m3_per_runtime_hour: "SUM(compressed_air_m3) / SUM(runtime_hours)",
  coolant_liter_per_runtime_hour: "SUM(coolant_liter) / SUM(runtime_hours)",
  electric_load_factor: "SUM(electricity_kwh) / SUM(runtime_hours * rated_power_kw)",
  kwh_per_good_unit: "SUM(electricity_kwh) / SUM(good_qty) for the same machine/date scope",
  idle_electricity_kwh: "SUM(electricity_kwh) where runtime_hours = 0",
  peak_utilization: "peak_demand_kw / rated_power_kw",
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
    machineIds: validateList(scope.machineIds, "machineIds"),
    lineIds: validateList(scope.lineIds, "lineIds"),
    machineTypes: validateList(scope.machineTypes, "machineTypes"),
    manufacturers: validateList(scope.manufacturers, "manufacturers"),
    statuses: validateList(scope.statuses, "statuses"),
  };
  if (normalized.dateFrom && normalized.dateTo && normalized.dateFrom > normalized.dateTo) throw new DataToolError("INVALID_DATE_RANGE", "dateFrom must not be later than dateTo");
  return normalized;
}

function addListFilter(clauses, params, column, values) {
  if (!values.length) return;
  clauses.push(`${column} IN (${values.map(() => "?").join(",")})`);
  params.push(...values);
}

function buildFilters(scope, source = "energy") {
  const clauses = [];
  const params = [];
  addListFilter(clauses, params, "m.machine_id", scope.machineIds);
  addListFilter(clauses, params, "m.line_id", scope.lineIds);
  addListFilter(clauses, params, "m.machine_type", scope.machineTypes);
  addListFilter(clauses, params, "m.manufacturer", scope.manufacturers);
  addListFilter(clauses, params, "m.status", scope.statuses);
  const column = source === "energy" ? "e.reading_date" : "o.actual_start";
  if (scope.dateFrom) { clauses.push(`${column} >= ?`); params.push(source === "energy" ? scope.dateFrom : `${scope.dateFrom}T00:00:00`); }
  if (scope.dateTo) { clauses.push(`${column} < ?`); params.push(source === "energy" ? nextDate(scope.dateTo) : `${nextDate(scope.dateTo)}T00:00:00`); }
  return { clauses, params };
}

function whereSql(filter) { return filter.clauses.length ? ` WHERE ${filter.clauses.join(" AND ")}` : ""; }
function ratio(a, b) { return b > 0 ? a / b : null; }
function rounded(value, digits = 4) { return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits)); }
function number(value) { return value == null ? 0 : Number(value); }

function energyMetricSql() {
  return `COUNT(*) AS reading_count,
    COUNT(DISTINCT e.reading_date) AS reading_day_count,
    COUNT(DISTINCT e.machine_id) AS machine_count,
    SUM(CAST(e.runtime_hours AS REAL)) AS runtime_hours,
    SUM(e.electricity_kwh) AS electricity_kwh,
    SUM(e.compressed_air_m3) AS compressed_air_m3,
    SUM(e.coolant_liter) AS coolant_liter,
    SUM(CAST(e.runtime_hours AS REAL) * m.rated_power_kw) AS rated_capacity_kwh,
    SUM(CASE WHEN CAST(e.runtime_hours AS REAL) = 0 THEN 1 ELSE 0 END) AS idle_reading_count,
    SUM(CASE WHEN CAST(e.runtime_hours AS REAL) = 0 THEN e.electricity_kwh ELSE 0 END) AS idle_electricity_kwh,
    MAX(e.peak_demand_kw) AS max_peak_demand_kw,
    AVG(e.peak_demand_kw) AS avg_peak_demand_kw`;
}

function finalize(row, production = {}) {
  const runtime = number(row.runtime_hours);
  const electricity = number(row.electricity_kwh);
  const air = number(row.compressed_air_m3);
  const coolant = number(row.coolant_liter);
  const ratedCapacity = number(row.rated_capacity_kwh);
  const goodQty = number(production.good_qty);
  return {
    ...row,
    runtime_hours: rounded(runtime, 2),
    electricity_kwh: rounded(electricity, 2),
    compressed_air_m3: rounded(air, 2),
    coolant_liter: rounded(coolant, 2),
    rated_capacity_kwh: rounded(ratedCapacity, 2),
    idle_electricity_kwh: rounded(number(row.idle_electricity_kwh), 2),
    max_peak_demand_kw: rounded(number(row.max_peak_demand_kw), 2),
    avg_peak_demand_kw: rounded(number(row.avg_peak_demand_kw), 2),
    actual_qty: number(production.actual_qty),
    good_qty: goodQty,
    kwh_per_runtime_hour: rounded(ratio(electricity, runtime), 3),
    air_m3_per_runtime_hour: rounded(ratio(air, runtime), 3),
    coolant_liter_per_runtime_hour: rounded(ratio(coolant, runtime), 4),
    electric_load_factor: rounded(ratio(electricity, ratedCapacity), 4),
    kwh_per_good_unit: rounded(ratio(electricity, goodQty), 4),
  };
}

const dimensionMap = {
  machine: { energy: "e.machine_id AS machine_id, m.line_id AS line_id, m.machine_type AS machine_type, m.manufacturer AS manufacturer, m.rated_power_kw AS rated_power_kw", production: "o.machine_id AS machine_id, m.line_id AS line_id, m.machine_type AS machine_type, m.manufacturer AS manufacturer, m.rated_power_kw AS rated_power_kw", group: "m.machine_id, m.line_id, m.machine_type, m.manufacturer, m.rated_power_kw", keys: ["machine_id"] },
  line: { energy: "m.line_id AS line_id", production: "m.line_id AS line_id", group: "m.line_id", keys: ["line_id"] },
  machine_type: { energy: "m.machine_type AS machine_type", production: "m.machine_type AS machine_type", group: "m.machine_type", keys: ["machine_type"] },
  manufacturer: { energy: "m.manufacturer AS manufacturer", production: "m.manufacturer AS manufacturer", group: "m.manufacturer", keys: ["manufacturer"] },
  status: { energy: "m.status AS status", production: "m.status AS status", group: "m.status", keys: ["status"] },
};

function rowKey(row, keys) { return JSON.stringify(keys.map((key) => row[key])); }

function aggregateEnergy(scope, config = null) {
  const filter = buildFilters(scope, "energy");
  const select = config ? `${config.energy}, ` : "";
  const group = config ? ` GROUP BY ${config.group}` : "";
  return runReadOnlySql({ sql: `SELECT ${select}${energyMetricSql()} FROM energy_readings e JOIN machines m ON m.machine_id = e.machine_id${whereSql(filter)}${group}`, params: filter.params, limit: 500 }).rows;
}

function aggregateProduction(scope, config = null) {
  const filter = buildFilters(scope, "production");
  const select = config ? `${config.production}, ` : "";
  const group = config ? ` GROUP BY ${config.group}` : "";
  return runReadOnlySql({ sql: `SELECT ${select}SUM(o.actual_qty) AS actual_qty, SUM(o.good_qty) AS good_qty, SUM(o.scrap_qty) AS scrap_qty FROM production_orders o JOIN machines m ON m.machine_id = o.machine_id${whereSql(filter)}${group}`, params: filter.params, limit: 500 }).rows;
}

function notes() {
  return [
    "Energy readings have daily machine granularity; shift- and product-level energy attribution is not available.",
    "kwh_per_good_unit aligns energy and production by the selected machine/date scope, not by a direct meter-to-order link.",
    "Electric load factor uses rated power multiplied by recorded runtime hours as the denominator.",
  ];
}

export function getEnergySummary(input = {}) {
  const scope = normalizeScope(input);
  const energy = aggregateEnergy(scope)[0];
  const production = aggregateProduction(scope)[0];
  return { scope, dataAvailable: Boolean(energy?.reading_count), metrics: energy ? finalize(energy, production) : null, metricDefinitions: METRIC_DEFINITIONS, dataNotes: notes() };
}

export function analyzeEnergyBreakdown({ dimension, orderBy = "electricity_kwh", direction = "desc", limit = 100, ...input }) {
  if (!BREAKDOWN_DIMENSIONS.has(dimension)) throw new DataToolError("INVALID_DIMENSION", `Unsupported energy dimension: ${dimension}`);
  if (!SORT_FIELDS.has(orderBy)) throw new DataToolError("INVALID_SORT_FIELD", `Unsupported energy sort field: ${orderBy}`);
  const dir = String(direction).toLowerCase();
  if (!new Set(["asc", "desc"]).has(dir)) throw new DataToolError("INVALID_SORT", `Invalid sort direction: ${direction}`);
  const scope = normalizeScope(input);
  const config = dimensionMap[dimension];
  const productionMap = new Map(aggregateProduction(scope, config).map((row) => [rowKey(row, config.keys), row]));
  const rows = aggregateEnergy(scope, config).map((row) => finalize(row, productionMap.get(rowKey(row, config.keys))));
  rows.sort((a, b) => {
    if (a[orderBy] == null && b[orderBy] == null) return 0;
    if (a[orderBy] == null) return 1;
    if (b[orderBy] == null) return -1;
    return dir === "asc" ? a[orderBy] - b[orderBy] : b[orderBy] - a[orderBy];
  });
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return { scope, dimension, rows: rows.slice(0, safeLimit), returned: Math.min(rows.length, safeLimit), metricDefinitions: METRIC_DEFINITIONS, dataNotes: notes() };
}

const periodMap = {
  day: { energy: "e.reading_date", production: "substr(o.actual_start, 1, 10)" },
  week: { energy: "strftime('%Y-W%W', e.reading_date)", production: "strftime('%Y-W%W', o.actual_start)" },
  month: { energy: "substr(e.reading_date, 1, 7)", production: "substr(o.actual_start, 1, 7)" },
};

export function getEnergyTrend({ grain = "month", limit = 500, ...input }) {
  if (!TREND_GRAINS.has(grain)) throw new DataToolError("INVALID_GRAIN", `Unsupported time grain: ${grain}`);
  const scope = normalizeScope(input);
  const period = periodMap[grain];
  const energyFilter = buildFilters(scope, "energy");
  const productionFilter = buildFilters(scope, "production");
  const energyRows = runReadOnlySql({ sql: `SELECT ${period.energy} AS period, ${energyMetricSql()} FROM energy_readings e JOIN machines m ON m.machine_id = e.machine_id${whereSql(energyFilter)} GROUP BY period ORDER BY period`, params: energyFilter.params, limit: 500 }).rows;
  const productionRows = runReadOnlySql({ sql: `SELECT ${period.production} AS period, SUM(o.actual_qty) AS actual_qty, SUM(o.good_qty) AS good_qty FROM production_orders o JOIN machines m ON m.machine_id = o.machine_id${whereSql(productionFilter)} GROUP BY period`, params: productionFilter.params, limit: 500 }).rows;
  const productionMap = new Map(productionRows.map((row) => [row.period, row]));
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 500);
  const rows = energyRows.slice(0, safeLimit).map((row) => ({ period: row.period, ...finalize(row, productionMap.get(row.period)) }));
  return { scope, grain, rows, returned: rows.length, metricDefinitions: METRIC_DEFINITIONS, dataNotes: notes() };
}

function combineMachinePeriodRows(scope, grain) {
  const period = periodMap[grain];
  const config = dimensionMap.machine;
  const energyFilter = buildFilters(scope, "energy");
  const productionFilter = buildFilters(scope, "production");
  const energyRows = runReadOnlySql({
    sql: `SELECT ${period.energy} AS period, ${config.energy}, ${energyMetricSql()} FROM energy_readings e JOIN machines m ON m.machine_id = e.machine_id${whereSql(energyFilter)} GROUP BY period, ${config.group} ORDER BY period, m.machine_id`,
    params: energyFilter.params,
    limit: 500,
  }).rows;
  const productionRows = runReadOnlySql({
    sql: `SELECT ${period.production} AS period, ${config.production}, SUM(o.actual_qty) AS actual_qty, SUM(o.good_qty) AS good_qty, SUM(o.scrap_qty) AS scrap_qty FROM production_orders o JOIN machines m ON m.machine_id = o.machine_id${whereSql(productionFilter)} GROUP BY period, ${config.group} ORDER BY period, m.machine_id`,
    params: productionFilter.params,
    limit: 500,
  }).rows;
  const productionMap = new Map(productionRows.map((row) => [rowKey(row, ["period", ...config.keys]), row]));
  return energyRows.map((row) => {
    const production = productionMap.get(rowKey(row, ["period", ...config.keys])) || {};
    return {
      period: row.period,
      ...finalize(row, production),
      scrap_qty: number(production.scrap_qty),
      quantity_balance_ok: number(production.actual_qty) === number(production.good_qty) + number(production.scrap_qty),
    };
  });
}

function summarizeMachinePeriods(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const current = grouped.get(row.machine_id) || {
      machine_id: row.machine_id,
      line_id: row.line_id,
      machine_type: row.machine_type,
      manufacturer: row.manufacturer,
      rated_power_kw: row.rated_power_kw,
      period_count: 0,
      reading_count: 0,
      runtime_hours: 0,
      electricity_kwh: 0,
      compressed_air_m3: 0,
      coolant_liter: 0,
      rated_capacity_kwh: 0,
      idle_reading_count: 0,
      idle_electricity_kwh: 0,
      max_peak_demand_kw: 0,
      weighted_peak_sum: 0,
      actual_qty: 0,
      good_qty: 0,
      scrap_qty: 0,
    };
    current.period_count += 1;
    current.reading_count += number(row.reading_count);
    current.runtime_hours += number(row.runtime_hours);
    current.electricity_kwh += number(row.electricity_kwh);
    current.compressed_air_m3 += number(row.compressed_air_m3);
    current.coolant_liter += number(row.coolant_liter);
    current.rated_capacity_kwh += number(row.rated_capacity_kwh);
    current.idle_reading_count += number(row.idle_reading_count);
    current.idle_electricity_kwh += number(row.idle_electricity_kwh);
    current.max_peak_demand_kw = Math.max(current.max_peak_demand_kw, number(row.max_peak_demand_kw));
    current.weighted_peak_sum += number(row.avg_peak_demand_kw) * number(row.reading_count);
    current.actual_qty += number(row.actual_qty);
    current.good_qty += number(row.good_qty);
    current.scrap_qty += number(row.scrap_qty);
    grouped.set(row.machine_id, current);
  }
  return [...grouped.values()].map((row) => ({
    ...finalize({
      ...row,
      avg_peak_demand_kw: ratio(row.weighted_peak_sum, row.reading_count),
    }, row),
    period_count: row.period_count,
    scrap_qty: row.scrap_qty,
    quantity_balance_ok: row.actual_qty === row.good_qty + row.scrap_qty,
  }));
}

export function analyzeEnergyProductionEfficiency({ grain = "month", limit = 500, ...input } = {}) {
  if (!TREND_GRAINS.has(grain)) throw new DataToolError("INVALID_GRAIN", `Unsupported time grain: ${grain}`);
  const scope = normalizeScope(input);
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 500);
  const allPeriodRows = combineMachinePeriodRows(scope, grain);
  const periodRows = allPeriodRows.slice(0, safeLimit);
  const machineSummary = summarizeMachinePeriods(allPeriodRows)
    .sort((a, b) => (b.kwh_per_good_unit ?? -Infinity) - (a.kwh_per_good_unit ?? -Infinity));
  const totals = machineSummary.reduce((acc, row) => {
    acc.electricity_kwh += number(row.electricity_kwh);
    acc.runtime_hours += number(row.runtime_hours);
    acc.actual_qty += number(row.actual_qty);
    acc.good_qty += number(row.good_qty);
    acc.scrap_qty += number(row.scrap_qty);
    acc.max_peak_demand_kw = Math.max(acc.max_peak_demand_kw, number(row.max_peak_demand_kw));
    return acc;
  }, { electricity_kwh: 0, runtime_hours: 0, actual_qty: 0, good_qty: 0, scrap_qty: 0, max_peak_demand_kw: 0 });
  const benchmark = rounded(ratio(totals.electricity_kwh, totals.good_qty), 4);
  const averageGoodQty = machineSummary.length ? totals.good_qty / machineSummary.length : 0;
  const highEnergyLowOutput = machineSummary.filter((row) => (
    row.kwh_per_good_unit != null && benchmark != null
    && row.kwh_per_good_unit > benchmark && row.good_qty < averageGoodQty
  ));
  const invalidQuantityRows = allPeriodRows
    .filter((row) => !row.quantity_balance_ok || row.good_qty > row.actual_qty)
    .map((row) => ({ period: row.period, machine_id: row.machine_id, actual_qty: row.actual_qty, good_qty: row.good_qty, scrap_qty: row.scrap_qty }));
  return {
    scope,
    grain,
    periodRows,
    returned: periodRows.length,
    resultTruncated: periodRows.length < allPeriodRows.length,
    machineSummary,
    overview: {
      electricity_kwh: rounded(totals.electricity_kwh, 2),
      runtime_hours: rounded(totals.runtime_hours, 2),
      max_peak_demand_kw: rounded(totals.max_peak_demand_kw, 2),
      actual_qty: totals.actual_qty,
      good_qty: totals.good_qty,
      scrap_qty: totals.scrap_qty,
      kwh_per_good_unit: benchmark,
      average_good_qty_per_machine: rounded(averageGoodQty, 2),
    },
    highEnergyLowOutput,
    validation: {
      invalidQuantityRows,
      quantityBalancePassed: invalidQuantityRows.length === 0,
      formula: METRIC_DEFINITIONS.kwh_per_good_unit,
    },
    metricDefinitions: METRIC_DEFINITIONS,
    dataNotes: [
      ...notes(),
      "Energy and production are independently pre-aggregated by machine and period before alignment; raw fact tables are never directly joined.",
      "Timestamp scopes use an inclusive start and exclusive next-day boundary, preventing end-of-day production records from being dropped.",
      "highEnergyLowOutput means above-factory kWh per good unit and below-average good quantity; it is a screening rule, not a causal finding.",
    ],
  };
}

export function analyzeEnergyEfficiency({ dimension = "machine", efficiencyMetric = "kwh_per_runtime_hour", direction = "desc", limit = 100, ...input } = {}) {
  if (dimension === "overall") {
    const summary = getEnergySummary(input);
    return { scope: summary.scope, dimension, efficiencyMetric, rows: summary.metrics ? [summary.metrics] : [], returned: summary.metrics ? 1 : 0, metricDefinitions: METRIC_DEFINITIONS, dataNotes: notes() };
  }
  if (!new Set(["machine", "line", "machine_type", "manufacturer"]).has(dimension)) throw new DataToolError("INVALID_DIMENSION", "Efficiency dimension must be overall, machine, line, machine_type, or manufacturer");
  if (!new Set(["kwh_per_runtime_hour", "air_m3_per_runtime_hour", "coolant_liter_per_runtime_hour", "electric_load_factor", "kwh_per_good_unit"]).has(efficiencyMetric)) throw new DataToolError("INVALID_EFFICIENCY_METRIC", "Unsupported energy efficiency metric");
  return { ...analyzeEnergyBreakdown({ ...input, dimension, orderBy: efficiencyMetric, direction, limit }), efficiencyMetric };
}

export function analyzePeakDemand({ orderBy = "peak_utilization", direction = "desc", minimumPeakUtilization = 0, limit = 100, ...input } = {}) {
  if (!new Set(["peak_utilization", "peak_demand_kw", "electricity_kwh"]).has(orderBy)) throw new DataToolError("INVALID_SORT_FIELD", `Unsupported peak-demand sort field: ${orderBy}`);
  const dir = String(direction).toLowerCase();
  if (!new Set(["asc", "desc"]).has(dir)) throw new DataToolError("INVALID_SORT", `Invalid sort direction: ${direction}`);
  if (typeof minimumPeakUtilization !== "number" || !Number.isFinite(minimumPeakUtilization) || minimumPeakUtilization < 0) throw new DataToolError("INVALID_THRESHOLD", "minimumPeakUtilization must be a non-negative number");
  const scope = normalizeScope(input);
  const filter = buildFilters(scope, "energy");
  filter.clauses.push("e.peak_demand_kw * 1.0 / NULLIF(m.rated_power_kw, 0) >= ?");
  filter.params.push(minimumPeakUtilization);
  const sql = `SELECT e.reading_id, e.reading_date, e.machine_id, m.line_id, m.machine_type, m.rated_power_kw, CAST(e.runtime_hours AS REAL) AS runtime_hours, e.electricity_kwh, e.peak_demand_kw, ROUND(e.peak_demand_kw * 1.0 / NULLIF(m.rated_power_kw, 0), 4) AS peak_utilization FROM energy_readings e JOIN machines m ON m.machine_id = e.machine_id${whereSql(filter)} ORDER BY ${orderBy} ${dir.toUpperCase()}, e.reading_date DESC`;
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = runReadOnlySql({ sql, params: filter.params, limit: safeLimit }).rows;
  return { scope, minimumPeakUtilization, rows, returned: rows.length, metricDefinitions: { peak_utilization: METRIC_DEFINITIONS.peak_utilization } };
}

export function findEnergyExceptions({
  exceptionTypes = ["idle_consumption", "high_electricity_intensity", "high_air_intensity", "high_coolant_intensity", "high_peak_utilization"],
  idleKwhAbove = 10, kwhPerRuntimeHourAbove = 30, airPerRuntimeHourAbove = 10,
  coolantPerRuntimeHourAbove = 0.3, peakUtilizationAbove = 0.9, limit = 100, ...input
} = {}) {
  const types = [...new Set(exceptionTypes)];
  if (!types.length || types.some((type) => !EXCEPTION_TYPES.has(type))) throw new DataToolError("INVALID_EXCEPTION_TYPE", `exceptionTypes must use: ${[...EXCEPTION_TYPES].join(", ")}`);
  const thresholds = { idleKwhAbove, kwhPerRuntimeHourAbove, airPerRuntimeHourAbove, coolantPerRuntimeHourAbove, peakUtilizationAbove };
  for (const [name, value] of Object.entries(thresholds)) if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new DataToolError("INVALID_THRESHOLD", `${name} must be a non-negative number`);
  const scope = normalizeScope(input);
  const filter = buildFilters(scope, "energy");
  const expressions = {
    idle_consumption: "(CAST(e.runtime_hours AS REAL) = 0 AND e.electricity_kwh > ?)",
    high_electricity_intensity: "(CAST(e.runtime_hours AS REAL) > 0 AND e.electricity_kwh / CAST(e.runtime_hours AS REAL) > ?)",
    high_air_intensity: "(CAST(e.runtime_hours AS REAL) > 0 AND e.compressed_air_m3 / CAST(e.runtime_hours AS REAL) > ?)",
    high_coolant_intensity: "(CAST(e.runtime_hours AS REAL) > 0 AND e.coolant_liter / CAST(e.runtime_hours AS REAL) > ?)",
    high_peak_utilization: "(m.rated_power_kw > 0 AND e.peak_demand_kw / m.rated_power_kw > ?)",
  };
  const values = { idle_consumption: idleKwhAbove, high_electricity_intensity: kwhPerRuntimeHourAbove, high_air_intensity: airPerRuntimeHourAbove, high_coolant_intensity: coolantPerRuntimeHourAbove, high_peak_utilization: peakUtilizationAbove };
  const conditions = types.map((type) => expressions[type]);
  const conditionParams = types.map((type) => values[type]);
  filter.clauses.push(`(${conditions.join(" OR ")})`);
  const severitySql = types.map((type) => `CASE WHEN ${expressions[type]} THEN 1 ELSE 0 END`).join(" + ");
  const severityParams = types.map((type) => values[type]);
  const rows = runReadOnlySql({
    sql: `SELECT e.reading_id, e.reading_date, e.machine_id, m.line_id, m.machine_type, m.rated_power_kw, CAST(e.runtime_hours AS REAL) AS runtime_hours, e.electricity_kwh, e.compressed_air_m3, e.coolant_liter, e.peak_demand_kw FROM energy_readings e JOIN machines m ON m.machine_id = e.machine_id${whereSql(filter)} ORDER BY (${severitySql}) DESC, e.reading_date DESC, e.machine_id`,
    params: [...filter.params, ...conditionParams, ...severityParams], limit: 500,
  }).rows;
  const tests = {
    idle_consumption: (row) => row.runtime_hours === 0 && row.electricity_kwh > idleKwhAbove,
    high_electricity_intensity: (row) => row.runtime_hours > 0 && row.electricity_kwh / row.runtime_hours > kwhPerRuntimeHourAbove,
    high_air_intensity: (row) => row.runtime_hours > 0 && row.compressed_air_m3 / row.runtime_hours > airPerRuntimeHourAbove,
    high_coolant_intensity: (row) => row.runtime_hours > 0 && row.coolant_liter / row.runtime_hours > coolantPerRuntimeHourAbove,
    high_peak_utilization: (row) => row.rated_power_kw > 0 && row.peak_demand_kw / row.rated_power_kw > peakUtilizationAbove,
  };
  const labels = { idle_consumption: "IDLE_CONSUMPTION", high_electricity_intensity: "HIGH_ELECTRICITY_INTENSITY", high_air_intensity: "HIGH_AIR_INTENSITY", high_coolant_intensity: "HIGH_COOLANT_INTENSITY", high_peak_utilization: "HIGH_PEAK_UTILIZATION" };
  const resultRows = rows.map((row) => {
    const reasons = types.filter((type) => tests[type](row));
    return {
      ...row,
      kwh_per_runtime_hour: row.runtime_hours > 0 ? rounded(row.electricity_kwh / row.runtime_hours, 3) : null,
      air_m3_per_runtime_hour: row.runtime_hours > 0 ? rounded(row.compressed_air_m3 / row.runtime_hours, 3) : null,
      coolant_liter_per_runtime_hour: row.runtime_hours > 0 ? rounded(row.coolant_liter / row.runtime_hours, 4) : null,
      peak_utilization: row.rated_power_kw > 0 ? rounded(row.peak_demand_kw / row.rated_power_kw, 4) : null,
      severity_score: reasons.length,
      exception_reasons: reasons.map((type) => labels[type]).join(","),
    };
  }).filter((row) => row.severity_score > 0).sort((a, b) => b.severity_score - a.severity_score || b.peak_utilization - a.peak_utilization).slice(0, Math.min(Math.max(Number(limit) || 100, 1), 200));
  return { scope, exceptionTypes: types, thresholds, rows: resultRows, returned: resultRows.length, metricDefinitions: METRIC_DEFINITIONS };
}

export const energyMetricDefinitions = METRIC_DEFINITIONS;
