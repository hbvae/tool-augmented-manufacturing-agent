import { DataToolError, runReadOnlySql } from "./database.mjs";

const BREAKDOWN_DIMENSIONS = new Set(["item", "item_type", "warehouse", "transaction_type", "month", "day"]);
const TREND_GRAINS = new Set(["day", "week", "month"]);
const SORT_FIELDS = new Set(["transaction_count", "inbound_qty", "outbound_qty", "net_movement_qty", "inbound_value_cny", "outbound_value_cny", "net_movement_value_cny"]);
const EXCEPTION_TYPES = new Set(["negative_balance", "low_coverage", "excess_coverage", "no_consumption", "inactive_stock"]);

const METRIC_DEFINITIONS = {
  inbound_qty: "SUM(quantity) where quantity > 0",
  outbound_qty: "SUM(ABS(quantity)) where quantity < 0",
  net_movement_qty: "SUM(quantity)",
  inbound_value_cny: "SUM(quantity * unit_cost_cny) where quantity > 0",
  outbound_value_cny: "SUM(ABS(quantity * unit_cost_cny)) where quantity < 0",
  inferred_balance_qty: "cumulative SUM(quantity) through asOfDate; no separate opening balance exists",
  days_of_supply: "inferred_balance_qty / (ISSUE quantity during lookback / lookbackDays); raw-material demand only",
  annualized_turnover_proxy: "365 / days_of_supply; uses current inferred balance, not average inventory",
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

function subtractDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days + 1);
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
    itemTypes: validateList(scope.itemTypes, "itemTypes"),
    itemIds: validateList(scope.itemIds, "itemIds"),
    warehouseIds: validateList(scope.warehouseIds, "warehouseIds"),
    transactionTypes: validateList(scope.transactionTypes, "transactionTypes"),
  };
  if (normalized.dateFrom && normalized.dateTo && normalized.dateFrom > normalized.dateTo) throw new DataToolError("INVALID_DATE_RANGE", "dateFrom must not be later than dateTo");
  return normalized;
}

function addListFilter(clauses, params, column, values) {
  if (!values.length) return;
  clauses.push(`${column} IN (${values.map(() => "?").join(",")})`);
  params.push(...values);
}

function buildMovementScope(scope, alias = "t", includeDates = true, includeTransactionTypes = true) {
  const clauses = [];
  const params = [];
  if (includeDates && scope.dateFrom) { clauses.push(`${alias}.transaction_time >= ?`); params.push(`${scope.dateFrom}T00:00:00`); }
  if (includeDates && scope.dateTo) { clauses.push(`${alias}.transaction_time < ?`); params.push(`${nextDate(scope.dateTo)}T00:00:00`); }
  addListFilter(clauses, params, `${alias}.item_type`, scope.itemTypes);
  addListFilter(clauses, params, `${alias}.item_id`, scope.itemIds);
  addListFilter(clauses, params, `${alias}.warehouse_id`, scope.warehouseIds);
  if (includeTransactionTypes) addListFilter(clauses, params, `${alias}.transaction_type`, scope.transactionTypes);
  return { clauses, params };
}

function whereSql(filter) { return filter.clauses.length ? ` WHERE ${filter.clauses.join(" AND ")}` : ""; }

function metricSql() {
  return `COUNT(*) AS transaction_count,
    COUNT(DISTINCT t.item_id) AS item_count,
    COUNT(DISTINCT t.warehouse_id) AS warehouse_count,
    SUM(CASE WHEN t.quantity > 0 THEN t.quantity ELSE 0 END) AS inbound_qty,
    SUM(CASE WHEN t.quantity < 0 THEN -t.quantity ELSE 0 END) AS outbound_qty,
    SUM(t.quantity) AS net_movement_qty,
    ROUND(SUM(CASE WHEN t.quantity > 0 THEN t.quantity * t.unit_cost_cny ELSE 0 END), 2) AS inbound_value_cny,
    ROUND(SUM(CASE WHEN t.quantity < 0 THEN -t.quantity * t.unit_cost_cny ELSE 0 END), 2) AS outbound_value_cny,
    ROUND(SUM(t.quantity * t.unit_cost_cny), 2) AS net_movement_value_cny,
    ROUND(SUM(ABS(t.quantity * t.unit_cost_cny)) / NULLIF(SUM(ABS(t.quantity)), 0), 4) AS weighted_unit_cost_cny`;
}

function baseFrom() {
  return " FROM inventory_transactions t LEFT JOIN materials m ON t.item_type = 'RAW_MATERIAL' AND m.material_id = t.item_id LEFT JOIN products p ON t.item_type = 'FINISHED_GOOD' AND p.product_id = t.item_id";
}

const DATA_NOTES = [
  "Inventory balances are inferred from cumulative transactions because no separate opening-balance or stock-snapshot table exists.",
  "Traditional turnover based on average inventory cannot be established; annualized_turnover_proxy uses current inferred balance.",
  "Demand coverage uses RAW_MATERIAL ISSUE transactions only. Finished goods have no shipment transactions, so their coverage is null.",
];

function latestInventoryDate() {
  return runReadOnlySql({ sql: "SELECT MAX(substr(transaction_time, 1, 10)) AS latest_date FROM inventory_transactions", limit: 1 }).rows[0]?.latest_date;
}

export function getInventorySummary(input = {}) {
  const scope = normalizeScope(input);
  const filter = buildMovementScope(scope);
  const movement = runReadOnlySql({ sql: `SELECT ${metricSql()}${baseFrom()}${whereSql(filter)}`, params: filter.params, limit: 1 }).rows[0];
  const status = analyzeInventoryStatus({
    asOfDate: input.asOfDate ?? scope.dateTo,
    lookbackDays: input.lookbackDays ?? 90,
    lowCoverageDays: input.lowCoverageDays ?? 15,
    excessCoverageDays: input.excessCoverageDays ?? 180,
    groupBy: "item",
    itemTypes: scope.itemTypes,
    itemIds: scope.itemIds,
    warehouseIds: scope.warehouseIds,
  });
  const balance = status.rows.reduce((acc, row) => {
    acc.inferred_balance_qty += row.inferred_balance_qty;
    acc.inferred_balance_value_cny += row.inferred_balance_value_cny;
    acc.negative_balance_item_count += row.inferred_balance_qty < 0 ? 1 : 0;
    acc.low_coverage_item_count += row.coverage_status === "LOW_COVERAGE" ? 1 : 0;
    acc.excess_coverage_item_count += row.coverage_status === "EXCESS_COVERAGE" ? 1 : 0;
    acc.no_consumption_item_count += row.coverage_status === "NO_CONSUMPTION" ? 1 : 0;
    return acc;
  }, { as_of_date: status.asOfDate, inferred_balance_qty: 0, inferred_balance_value_cny: 0, negative_balance_item_count: 0, low_coverage_item_count: 0, excess_coverage_item_count: 0, no_consumption_item_count: 0 });
  balance.inferred_balance_qty = Number(balance.inferred_balance_qty.toFixed(2));
  balance.inferred_balance_value_cny = Number(balance.inferred_balance_value_cny.toFixed(2));
  return { scope, dataAvailable: Boolean(movement?.transaction_count), movementMetrics: movement, balanceMetrics: balance, metricDefinitions: METRIC_DEFINITIONS, dataNotes: DATA_NOTES };
}

const breakdownMap = {
  item: { select: "t.item_type AS item_type, t.item_id AS item_id, COALESCE(m.material_name, p.product_name, t.item_id) AS item_name, COALESCE(m.uom, 'pcs') AS uom", group: "t.item_type, t.item_id, COALESCE(m.material_name, p.product_name, t.item_id), COALESCE(m.uom, 'pcs')" },
  item_type: { select: "t.item_type AS item_type", group: "t.item_type" },
  warehouse: { select: "t.warehouse_id AS warehouse_id", group: "t.warehouse_id" },
  transaction_type: { select: "t.transaction_type AS transaction_type", group: "t.transaction_type" },
  month: { select: "substr(t.transaction_time, 1, 7) AS month", group: "substr(t.transaction_time, 1, 7)" },
  day: { select: "substr(t.transaction_time, 1, 10) AS day", group: "substr(t.transaction_time, 1, 10)" },
};

export function analyzeInventoryBreakdown({ dimension, orderBy = "inbound_value_cny", direction = "desc", limit = 100, ...input }) {
  if (!BREAKDOWN_DIMENSIONS.has(dimension)) throw new DataToolError("INVALID_DIMENSION", `Unsupported inventory dimension: ${dimension}`);
  if (!SORT_FIELDS.has(orderBy)) throw new DataToolError("INVALID_SORT_FIELD", `Unsupported inventory sort field: ${orderBy}`);
  const dir = String(direction).toLowerCase();
  if (!new Set(["asc", "desc"]).has(dir)) throw new DataToolError("INVALID_SORT", `Invalid sort direction: ${direction}`);
  const scope = normalizeScope(input);
  const filter = buildMovementScope(scope);
  const config = breakdownMap[dimension];
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = runReadOnlySql({ sql: `SELECT ${config.select}, ${metricSql()}${baseFrom()}${whereSql(filter)} GROUP BY ${config.group} ORDER BY ${orderBy} ${dir.toUpperCase()}`, params: filter.params, limit: safeLimit }).rows;
  return { scope, dimension, rows, returned: rows.length, metricDefinitions: METRIC_DEFINITIONS, dataNotes: DATA_NOTES };
}

const periodMap = { day: "substr(t.transaction_time, 1, 10)", week: "strftime('%Y-W%W', t.transaction_time)", month: "substr(t.transaction_time, 1, 7)" };

export function getInventoryTrend({ grain = "month", limit = 500, ...input }) {
  if (!TREND_GRAINS.has(grain)) throw new DataToolError("INVALID_GRAIN", `Unsupported time grain: ${grain}`);
  const scope = normalizeScope(input);
  const filter = buildMovementScope(scope);
  const period = periodMap[grain];
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 500);
  const rows = runReadOnlySql({ sql: `SELECT ${period} AS period, ${metricSql()}${baseFrom()}${whereSql(filter)} GROUP BY ${period} ORDER BY period`, params: filter.params, limit: safeLimit }).rows;
  return { scope, grain, rows, returned: rows.length, metricDefinitions: METRIC_DEFINITIONS, dataNotes: DATA_NOTES };
}

export function analyzeInventoryStatus({ asOfDate, lookbackDays = 90, lowCoverageDays = 15, excessCoverageDays = 180, groupBy = "item", ...input } = {}) {
  const scope = normalizeScope(input);
  const resolvedDate = requireIsoDate(asOfDate, "asOfDate") ?? latestInventoryDate();
  if (!resolvedDate) return { scope, asOfDate: null, rows: [], returned: 0, metricDefinitions: METRIC_DEFINITIONS, dataNotes: DATA_NOTES };
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 3650) throw new DataToolError("INVALID_LOOKBACK", "lookbackDays must be an integer from 1 to 3650");
  for (const [name, value] of Object.entries({ lowCoverageDays, excessCoverageDays })) if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new DataToolError("INVALID_THRESHOLD", `${name} must be a non-negative number`);
  if (lowCoverageDays > excessCoverageDays) throw new DataToolError("INVALID_THRESHOLD", "lowCoverageDays must not exceed excessCoverageDays");
  if (!new Set(["item", "item_warehouse"]).has(groupBy)) throw new DataToolError("INVALID_DIMENSION", "groupBy must be item or item_warehouse");
  const balanceFilter = buildMovementScope(scope, "t", false, false);
  balanceFilter.clauses.push("t.transaction_time < ?");
  balanceFilter.params.push(`${nextDate(resolvedDate)}T00:00:00`);
  const demandFilter = buildMovementScope(scope, "t", false, false);
  demandFilter.clauses.push("t.transaction_time >= ?", "t.transaction_time < ?", "t.item_type = 'RAW_MATERIAL'", "t.transaction_type = 'ISSUE'", "t.quantity < 0");
  demandFilter.params.push(`${subtractDays(resolvedDate, lookbackDays)}T00:00:00`, `${nextDate(resolvedDate)}T00:00:00`);
  const warehouseSelect = groupBy === "item_warehouse" ? ", t.warehouse_id AS warehouse_id" : "";
  const warehouseGroup = groupBy === "item_warehouse" ? ", t.warehouse_id" : "";
  const joinWarehouse = groupBy === "item_warehouse" ? " AND d.warehouse_id = b.warehouse_id" : "";
  const sql = `WITH balance AS (
      SELECT t.item_type, t.item_id${warehouseSelect}, SUM(t.quantity) AS inferred_balance_qty, SUM(t.quantity * t.unit_cost_cny) AS inferred_balance_value_cny, MAX(t.transaction_time) AS last_transaction_time
      FROM inventory_transactions t${whereSql(balanceFilter)} GROUP BY t.item_type, t.item_id${warehouseGroup}
    ), demand AS (
      SELECT t.item_type, t.item_id${warehouseSelect}, SUM(-t.quantity) AS issue_qty, COUNT(*) AS issue_transaction_count, MAX(t.transaction_time) AS last_issue_time
      FROM inventory_transactions t${whereSql(demandFilter)} GROUP BY t.item_type, t.item_id${warehouseGroup}
    )
    SELECT b.*, COALESCE(m.material_name, p.product_name, b.item_id) AS item_name, COALESCE(m.uom, 'pcs') AS uom, COALESCE(d.issue_qty, 0) AS lookback_issue_qty, COALESCE(d.issue_transaction_count, 0) AS issue_transaction_count, d.last_issue_time
    FROM balance b
    LEFT JOIN demand d ON d.item_type = b.item_type AND d.item_id = b.item_id${joinWarehouse}
    LEFT JOIN materials m ON b.item_type = 'RAW_MATERIAL' AND m.material_id = b.item_id
    LEFT JOIN products p ON b.item_type = 'FINISHED_GOOD' AND p.product_id = b.item_id
    ORDER BY b.item_type, b.item_id`;
  const rows = runReadOnlySql({ sql, params: [...balanceFilter.params, ...demandFilter.params], limit: 500 }).rows.map((row) => {
    const balance = Number(row.inferred_balance_qty);
    const issueQty = Number(row.lookback_issue_qty);
    const dailyIssue = row.item_type === "RAW_MATERIAL" && issueQty > 0 ? issueQty / lookbackDays : null;
    const daysOfSupply = dailyIssue > 0 ? balance / dailyIssue : null;
    let coverageStatus = "NO_DEMAND_BASIS";
    if (balance < 0) coverageStatus = "NEGATIVE_BALANCE";
    else if (row.item_type === "RAW_MATERIAL" && issueQty === 0) coverageStatus = "NO_CONSUMPTION";
    else if (daysOfSupply != null && daysOfSupply < lowCoverageDays) coverageStatus = "LOW_COVERAGE";
    else if (daysOfSupply != null && daysOfSupply > excessCoverageDays) coverageStatus = "EXCESS_COVERAGE";
    else if (daysOfSupply != null) coverageStatus = "NORMAL";
    return {
      ...row,
      inferred_balance_qty: Number(balance.toFixed(2)),
      inferred_balance_value_cny: Number(Number(row.inferred_balance_value_cny).toFixed(2)),
      lookback_issue_qty: Number(issueQty.toFixed(2)),
      avg_daily_issue_qty: dailyIssue == null ? null : Number(dailyIssue.toFixed(3)),
      days_of_supply: daysOfSupply == null ? null : Number(daysOfSupply.toFixed(2)),
      annualized_turnover_proxy: daysOfSupply > 0 ? Number((365 / daysOfSupply).toFixed(3)) : null,
      coverage_status: coverageStatus,
    };
  });
  return { scope, asOfDate: resolvedDate, lookbackDays, thresholds: { lowCoverageDays, excessCoverageDays }, groupBy, rows, returned: rows.length, metricDefinitions: METRIC_DEFINITIONS, dataNotes: DATA_NOTES };
}

export function findInventoryExceptions({ exceptionTypes = ["negative_balance", "low_coverage", "excess_coverage", "no_consumption", "inactive_stock"], inactiveDaysAbove = 60, limit = 100, ...input } = {}) {
  const types = [...new Set(exceptionTypes)];
  if (!types.length || types.some((type) => !EXCEPTION_TYPES.has(type))) throw new DataToolError("INVALID_EXCEPTION_TYPE", `exceptionTypes must use: ${[...EXCEPTION_TYPES].join(", ")}`);
  if (typeof inactiveDaysAbove !== "number" || !Number.isFinite(inactiveDaysAbove) || inactiveDaysAbove < 0) throw new DataToolError("INVALID_THRESHOLD", "inactiveDaysAbove must be a non-negative number");
  const status = analyzeInventoryStatus(input);
  const asOfTime = new Date(`${status.asOfDate}T00:00:00Z`).getTime();
  const tests = {
    negative_balance: (row) => row.inferred_balance_qty < 0,
    low_coverage: (row) => row.coverage_status === "LOW_COVERAGE",
    excess_coverage: (row) => row.coverage_status === "EXCESS_COVERAGE",
    no_consumption: (row) => row.item_type === "RAW_MATERIAL" && row.coverage_status === "NO_CONSUMPTION" && row.inferred_balance_qty > 0,
    inactive_stock: (row) => row.inferred_balance_qty > 0 && (asOfTime - new Date(row.last_transaction_time).getTime()) / 86400000 > inactiveDaysAbove,
  };
  const labels = { negative_balance: "NEGATIVE_BALANCE", low_coverage: "LOW_COVERAGE", excess_coverage: "EXCESS_COVERAGE", no_consumption: "NO_CONSUMPTION", inactive_stock: "INACTIVE_STOCK" };
  const rows = status.rows.map((row) => {
    const reasons = types.filter((type) => tests[type](row));
    const inactiveDays = Math.max(0, (asOfTime - new Date(row.last_transaction_time).getTime()) / 86400000);
    return { ...row, inactive_days: Number(inactiveDays.toFixed(1)), severity_score: reasons.length, exception_reasons: reasons.map((type) => labels[type]).join(",") };
  }).filter((row) => row.severity_score > 0).sort((a, b) => b.severity_score - a.severity_score || (b.days_of_supply ?? -1) - (a.days_of_supply ?? -1)).slice(0, Math.min(Math.max(Number(limit) || 100, 1), 200));
  return { scope: status.scope, asOfDate: status.asOfDate, lookbackDays: status.lookbackDays, thresholds: { ...status.thresholds, inactiveDaysAbove }, exceptionTypes: types, rows, returned: rows.length, metricDefinitions: METRIC_DEFINITIONS, dataNotes: DATA_NOTES };
}

export const inventoryMetricDefinitions = METRIC_DEFINITIONS;
