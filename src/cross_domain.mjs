import { DataToolError, runReadOnlySql } from "./database.mjs";
import { analyzeProductionBreakdown, getProductionSummary, getProductionTrend } from "./production.mjs";
import { analyzeQualityBreakdown, getQualitySummary, getQualityTrend } from "./quality.mjs";
import { analyzeEquipmentBreakdown, getEquipmentSummary, getEquipmentTrend } from "./equipment.mjs";
import { analyzeEnergyBreakdown, getEnergySummary, getEnergyTrend } from "./energy.mjs";
import { getSupplierSummary, getSupplierTrend, scoreSuppliers } from "./supplier.mjs";
import { analyzeInventoryStatus, getInventorySummary, getInventoryTrend } from "./inventory.mjs";

const GRAINS = new Set(["day", "week", "month"]);
const MACHINE_SORT_FIELDS = new Set(["risk_score", "actual_qty", "scrap_rate", "quality_fail_rate", "unplanned_downtime_min", "availability", "oee", "kwh_per_runtime_hour"]);
const PRODUCT_SORT_FIELDS = new Set(["actual_qty", "scrap_rate", "quality_fail_rate", "defect_rate", "inferred_balance_qty", "inferred_balance_value_cny"]);

const CROSS_DOMAIN_NOTES = [
  "Production, quality, and order-linked downtime share transactional keys; daily energy is aligned by machine/date rather than directly linked to an order.",
  "Inventory balances are inferred from cumulative movements; finished goods have no sales-shipment demand basis.",
  "Supplier and inventory domains remain plant-wide when machineIds or lineIds filters are used because those domains have no machine/line key.",
  "Cross-domain risk flags are threshold-based screening signals, not causal conclusions.",
];

function validateList(values, field) {
  if (values == null) return [];
  if (!Array.isArray(values) || values.length > 100 || values.some((value) => typeof value !== "string" || !value.trim())) throw new DataToolError("INVALID_SCOPE", `${field} must contain at most 100 non-empty strings`);
  return [...new Set(values.map((value) => value.trim()))];
}

function validateDate(value, field) {
  if (value == null) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DataToolError("INVALID_DATE", `${field} must use YYYY-MM-DD format`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new DataToolError("INVALID_DATE", `${field} is not a valid calendar date`);
  return value;
}

function commonScope(input = {}) {
  const scope = {
    dateFrom: validateDate(input.dateFrom, "dateFrom"),
    dateTo: validateDate(input.dateTo, "dateTo"),
    machineIds: validateList(input.machineIds, "machineIds"),
    lineIds: validateList(input.lineIds, "lineIds"),
  };
  if (scope.dateFrom && scope.dateTo && scope.dateFrom > scope.dateTo) throw new DataToolError("INVALID_DATE_RANGE", "dateFrom must not be later than dateTo");
  return scope;
}

function machineObservedDataRange(scope) {
  const sources = [
    { table: "production_orders o JOIN machines m ON m.machine_id = o.machine_id", date: "o.actual_start", machine: "o.machine_id", line: "m.line_id" },
    { table: "quality_inspections q JOIN production_orders o ON o.order_id = q.order_id JOIN machines m ON m.machine_id = o.machine_id", date: "q.inspection_time", machine: "o.machine_id", line: "m.line_id" },
    { table: "downtime_events d JOIN machines m ON m.machine_id = d.machine_id", date: "d.start_time", machine: "d.machine_id", line: "m.line_id" },
    { table: "energy_readings e JOIN machines m ON m.machine_id = e.machine_id", date: "e.reading_date", machine: "e.machine_id", line: "m.line_id" },
  ];
  const params = [];
  const parts = sources.map((source) => {
    const clauses = [`${source.date} IS NOT NULL`];
    if (scope.dateFrom) { clauses.push(`substr(${source.date},1,10) >= ?`); params.push(scope.dateFrom); }
    if (scope.dateTo) { clauses.push(`substr(${source.date},1,10) <= ?`); params.push(scope.dateTo); }
    if (scope.machineIds.length) {
      clauses.push(`${source.machine} IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(scope.machineIds));
    }
    if (scope.lineIds.length) {
      clauses.push(`${source.line} IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(scope.lineIds));
    }
    return `SELECT MIN(substr(${source.date},1,10)) AS date_from, MAX(substr(${source.date},1,10)) AS date_to FROM ${source.table} WHERE ${clauses.join(" AND ")}`;
  });
  const row = runReadOnlySql({
    sql: `SELECT MIN(date_from) AS date_from, MAX(date_to) AS date_to FROM (${parts.join(" UNION ALL ")})`,
    params,
    limit: 1,
  }).rows[0] ?? {};
  return {
    dateFrom: row.date_from ?? null,
    dateTo: row.date_to ?? null,
    sourceDomains: ["production", "quality", "downtime", "energy"],
  };
}

function domainRowsByKey(rows, key) { return new Map(rows.map((row) => [row[key], row])); }
function without(row, keys) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
}

function boundedLimit(value, fallback = 100, maximum = 500) {
  return Math.min(Math.max(Number(value) || fallback, 1), maximum);
}

function byPeriod(rows) { return new Map(rows.map((row) => [row.period, row])); }

export function compareMachineMonthlyPerformance({ limit = 500, ...input } = {}) {
  const scope = commonScope(input);
  const selectedMachines = scope.machineIds.length
    ? scope.machineIds
    : analyzeMachine360({ ...scope, sortBy: "actual_qty", direction: "desc", limit: 100 }).rows.map((row) => row.machine_id);
  const sourceFilter = (dateColumn, machineColumn = "m.machine_id", lineColumn = "m.line_id") => {
    const clauses = [];
    const params = [];
    if (scope.dateFrom) { clauses.push(`${dateColumn} >= ?`); params.push(dateColumn.startsWith("e.") ? scope.dateFrom : `${scope.dateFrom}T00:00:00`); }
    if (scope.dateTo) {
      const next = new Date(`${scope.dateTo}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
      clauses.push(`${dateColumn} < ?`); params.push(dateColumn.startsWith("e.") ? next.toISOString().slice(0, 10) : `${next.toISOString().slice(0, 10)}T00:00:00`);
    }
    if (selectedMachines.length) { clauses.push(`${machineColumn} IN (${selectedMachines.map(() => "?").join(",")})`); params.push(...selectedMachines); }
    if (scope.lineIds.length) { clauses.push(`${lineColumn} IN (${scope.lineIds.map(() => "?").join(",")})`); params.push(...scope.lineIds); }
    return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
  };
  const productionFilter = sourceFilter("o.actual_start");
  const qualityFilter = sourceFilter("q.inspection_time");
  const downtimeFilter = sourceFilter("d.start_time");
  const energyFilter = sourceFilter("e.reading_date");
  const sql = `WITH
    production AS (
      SELECT o.machine_id, substr(o.actual_start,1,7) AS period,
        SUM(o.planned_qty) AS planned_qty, SUM(o.actual_qty) AS actual_qty,
        SUM(o.good_qty) AS good_qty, SUM(o.scrap_qty) AS scrap_qty,
        SUM(o.runtime_min) AS runtime_min, SUM(o.actual_qty * p.standard_cycle_min) AS ideal_runtime_min,
        ROUND(SUM(o.runtime_min) * 1.0 / NULLIF(SUM(o.actual_qty),0),3) AS weighted_cycle_time_min
      FROM production_orders o JOIN products p ON p.product_id=o.product_id JOIN machines m ON m.machine_id=o.machine_id
      ${productionFilter.sql} GROUP BY o.machine_id, period
    ), quality AS (
      SELECT o.machine_id, substr(q.inspection_time,1,7) AS period, COUNT(*) AS inspection_count,
        SUM(CASE WHEN q.result='FAIL' THEN 1 ELSE 0 END) AS fail_count,
        SUM(q.sample_size) AS sample_size, SUM(q.defect_count) AS defect_count
      FROM quality_inspections q JOIN production_orders o ON o.order_id=q.order_id JOIN machines m ON m.machine_id=o.machine_id
      ${qualityFilter.sql} GROUP BY o.machine_id, period
    ), downtime AS (
      SELECT d.machine_id, substr(d.start_time,1,7) AS period,
        SUM(CASE WHEN d.planned_flag=0 THEN d.duration_min ELSE 0 END) AS unplanned_downtime_min,
        SUM(CASE WHEN d.category='FAILURE' THEN 1 ELSE 0 END) AS failure_count
      FROM downtime_events d JOIN machines m ON m.machine_id=d.machine_id
      ${downtimeFilter.sql} GROUP BY d.machine_id, period
    ), energy AS (
      SELECT e.machine_id, substr(e.reading_date,1,7) AS period,
        SUM(e.electricity_kwh) AS electricity_kwh, SUM(CAST(e.runtime_hours AS REAL)) AS runtime_hours
      FROM energy_readings e JOIN machines m ON m.machine_id=e.machine_id
      ${energyFilter.sql} GROUP BY e.machine_id, period
    ), keys AS (
      SELECT machine_id,period FROM production UNION SELECT machine_id,period FROM quality
      UNION SELECT machine_id,period FROM downtime UNION SELECT machine_id,period FROM energy
    )
    SELECT k.machine_id,k.period,p.planned_qty,p.actual_qty,p.good_qty,p.scrap_qty,
      ROUND(p.actual_qty*1.0/NULLIF(p.planned_qty,0),4) AS plan_completion_rate,
      ROUND(p.good_qty*1.0/NULLIF(p.actual_qty,0),4) AS yield_rate,
      ROUND(p.scrap_qty*1.0/NULLIF(p.actual_qty,0),4) AS scrap_rate,
      p.weighted_cycle_time_min, ROUND(p.runtime_min*1.0/NULLIF(p.ideal_runtime_min,0),4) AS cycle_time_index,
      q.inspection_count, ROUND(q.fail_count*1.0/NULLIF(q.inspection_count,0),4) AS quality_fail_rate,
      ROUND(q.defect_count*1.0/NULLIF(q.sample_size,0),4) AS sample_defect_rate,
      COALESCE(d.unplanned_downtime_min,0) AS unplanned_downtime_min, COALESCE(d.failure_count,0) AS failure_count,
      ROUND(p.runtime_min*1.0/NULLIF(p.runtime_min+COALESCE(d.unplanned_downtime_min,0),0),4) AS availability,
      ROUND((p.runtime_min*1.0/NULLIF(p.runtime_min+COALESCE(d.unplanned_downtime_min,0),0))*(p.ideal_runtime_min*1.0/NULLIF(p.runtime_min,0))*(p.good_qty*1.0/NULLIF(p.actual_qty,0)),4) AS oee,
      ROUND(e.electricity_kwh,2) AS electricity_kwh, ROUND(e.runtime_hours,2) AS runtime_hours,
      ROUND(e.electricity_kwh*1.0/NULLIF(p.good_qty,0),4) AS kwh_per_good_unit,
      ROUND(e.electricity_kwh*1.0/NULLIF(e.runtime_hours,0),3) AS kwh_per_runtime_hour
    FROM keys k LEFT JOIN production p USING(machine_id,period) LEFT JOIN quality q USING(machine_id,period)
      LEFT JOIN downtime d USING(machine_id,period) LEFT JOIN energy e USING(machine_id,period)
    ORDER BY k.machine_id,k.period`;
  const rawRows = runReadOnlySql({
    sql,
    params: [...productionFilter.params, ...qualityFilter.params, ...downtimeFilter.params, ...energyFilter.params],
    limit: 500,
  }).rows;
  const rows = rawRows.map((row) => {
    const anomalyReasons = [];
    if (row.plan_completion_rate != null && row.plan_completion_rate < 0.9) anomalyReasons.push("LOW_PLAN_COMPLETION");
    if (row.scrap_rate != null && row.scrap_rate > 0.03) anomalyReasons.push("HIGH_SCRAP_RATE");
    if (row.quality_fail_rate != null && row.quality_fail_rate > 0.1) anomalyReasons.push("HIGH_QUALITY_FAIL_RATE");
    if (row.unplanned_downtime_min != null && row.unplanned_downtime_min > 600) anomalyReasons.push("HIGH_UNPLANNED_DOWNTIME");
    if (row.oee != null && row.oee < 0.85) anomalyReasons.push("LOW_OEE");
    return { ...row, anomaly_score: anomalyReasons.length, anomaly_reasons: anomalyReasons.join(",") };
  });
  const safeLimit = boundedLimit(limit, 500, 500);
  const resultRows = rows.slice(0, safeLimit);
  return {
    scope: { ...scope, machineIds: selectedMachines }, grain: "month", rows: resultRows, returned: resultRows.length,
    resultTruncated: resultRows.length < rows.length,
    metricDefinitions: {
      plan_completion_rate: "SUM(actual_qty) / SUM(planned_qty)",
      scrap_rate: "SUM(scrap_qty) / SUM(actual_qty)",
      quality_fail_rate: "FAIL inspection count / inspection count",
      availability: "runtime_min / (runtime_min + unplanned_downtime_min)",
      oee: "availability * performance * quality_rate",
      kwh_per_good_unit: "SUM(electricity_kwh) / SUM(good_qty) for the same machine and month",
    },
    dataNotes: [...CROSS_DOMAIN_NOTES, "Rows are aligned by machine and calendar month; each domain is aggregated independently before alignment."],
  };
}

export function analyzeSupplierInventoryRisk({
  dateFrom, dateTo, supplierIds = [], materialIds = [], asOfDate, lookbackDays = 180,
  lowCoverageDays = 30, excessCoverageDays = 180, defectRateAbove = 0.005,
  passRateBelow = 0.95, onTimeRateBelow = 0.5, limit = 100,
} = {}) {
  const normalizedSupplierIds = validateList(supplierIds, "supplierIds");
  const normalizedMaterialIds = validateList(materialIds, "materialIds");
  const validatedFrom = validateDate(dateFrom, "dateFrom");
  const validatedTo = validateDate(dateTo, "dateTo");
  if (validatedFrom && validatedTo && validatedFrom > validatedTo) throw new DataToolError("INVALID_DATE_RANGE", "dateFrom must not be later than dateTo");
  for (const [name, value] of Object.entries({ lowCoverageDays, excessCoverageDays, defectRateAbove, passRateBelow, onTimeRateBelow })) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new DataToolError("INVALID_THRESHOLD", `${name} must be a non-negative number`);
  }
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 3650) throw new DataToolError("INVALID_LOOKBACK", "lookbackDays must be an integer from 1 to 3650");
  const supplierScores = scoreSuppliers({ dateFrom: validatedFrom, dateTo: validatedTo, supplierIds: normalizedSupplierIds, materialIds: normalizedMaterialIds, limit: 100 }).rows;
  const inventory = analyzeInventoryStatus({
    asOfDate: asOfDate ?? validatedTo, lookbackDays, lowCoverageDays, excessCoverageDays,
    itemTypes: ["RAW_MATERIAL"], itemIds: normalizedMaterialIds,
  });
  const clauses = [];
  const params = [];
  if (normalizedSupplierIds.length) { clauses.push(`preferred_supplier_id IN (${normalizedSupplierIds.map(() => "?").join(",")})`); params.push(...normalizedSupplierIds); }
  if (normalizedMaterialIds.length) { clauses.push(`material_id IN (${normalizedMaterialIds.map(() => "?").join(",")})`); params.push(...normalizedMaterialIds); }
  const materialSources = runReadOnlySql({
    sql: `SELECT material_id, material_name, uom, preferred_supplier_id, standard_cost_cny FROM materials${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY material_id`,
    params, limit: 500,
  }).rows;
  const inventoryByItem = new Map(inventory.rows.map((row) => [row.item_id, row]));
  const materialsBySupplier = new Map();
  for (const material of materialSources) {
    const row = { ...material, inventory: inventoryByItem.get(material.material_id) ?? null };
    const current = materialsBySupplier.get(material.preferred_supplier_id) ?? [];
    current.push(row); materialsBySupplier.set(material.preferred_supplier_id, current);
  }
  const ranked = supplierScores.map((supplier) => {
    const materials = materialsBySupplier.get(supplier.supplier_id) ?? [];
    const shortageMaterials = materials.filter((item) => ["LOW_COVERAGE", "NEGATIVE_BALANCE"].includes(item.inventory?.coverage_status));
    const comparableCoverage = materials.map((item) => item.inventory?.days_of_supply).filter((value) => Number.isFinite(value));
    const qualityRisk = supplier.defect_rate > defectRateAbove || supplier.pass_rate < passRateBelow;
    const deliveryRisk = supplier.on_time_rate < onTimeRateBelow;
    const reasons = [];
    if (supplier.defect_rate > defectRateAbove) reasons.push("HIGH_INCOMING_DEFECT_RATE");
    if (supplier.pass_rate < passRateBelow) reasons.push("LOW_INSPECTION_PASS_RATE");
    if (deliveryRisk) reasons.push("LOW_ON_TIME_DELIVERY");
    if (shortageMaterials.length) reasons.push("CURRENT_LOW_COVERAGE");
    const combinedRisk = qualityRisk && (deliveryRisk || shortageMaterials.length > 0);
    return {
      ...supplier,
      preferred_materials: materials,
      preferred_material_count: materials.length,
      minimum_days_of_supply: comparableCoverage.length ? Math.min(...comparableCoverage) : null,
      current_shortage_material_count: shortageMaterials.length,
      current_shortage_material_ids: shortageMaterials.map((item) => item.material_id),
      quality_risk: qualityRisk, delivery_risk: deliveryRisk,
      combined_quality_supply_risk: combinedRisk,
      risk_score: reasons.length + (combinedRisk ? 2 : 0), risk_reasons: reasons.join(","),
    };
  }).sort((a, b) => b.risk_score - a.risk_score || a.total_score - b.total_score || a.supplier_id.localeCompare(b.supplier_id));
  const safeLimit = boundedLimit(limit, 100, 100);
  const purchaseSpendRanking = [...ranked]
    .sort((a, b) => (b.purchase_spend_cny ?? -Infinity) - (a.purchase_spend_cny ?? -Infinity))
    .map((row, index) => ({ rank: index + 1, supplier_id: row.supplier_id, supplier_name: row.supplier_name, purchase_spend_cny: row.purchase_spend_cny }));
  return {
    scope: { dateFrom: validatedFrom, dateTo: validatedTo, supplierIds: normalizedSupplierIds, materialIds: normalizedMaterialIds },
    asOfDate: inventory.asOfDate, lookbackDays,
    thresholds: { lowCoverageDays, excessCoverageDays, defectRateAbove, passRateBelow, onTimeRateBelow },
    rows: ranked.slice(0, safeLimit), returned: Math.min(ranked.length, safeLimit),
    rankings: {
      purchase_spend_desc: purchaseSpendRanking,
      highest_purchase_spend_supplier: purchaseSpendRanking[0] ?? null,
    },
    inventoryOverview: {
      raw_material_count: inventory.rows.length,
      low_coverage_count: inventory.rows.filter((row) => row.coverage_status === "LOW_COVERAGE").length,
      negative_balance_count: inventory.rows.filter((row) => row.coverage_status === "NEGATIVE_BALANCE").length,
      excess_coverage_count: inventory.rows.filter((row) => row.coverage_status === "EXCESS_COVERAGE").length,
      no_consumption_count: inventory.rows.filter((row) => row.coverage_status === "NO_CONSUMPTION").length,
    },
    dataNotes: [
      "Supplier quality and delivery metrics are linked to raw-material inventory only through materials.preferred_supplier_id; this indicates exposure, not causality.",
      ...inventory.dataNotes,
      "combined_quality_supply_risk requires supplier quality risk plus either delivery risk or a currently low/negative inventory position.",
    ],
  };
}

function validateThresholds(input = {}) {
  const thresholds = {
    scrapRateAbove: input.scrapRateAbove ?? 0.03,
    qualityFailRateAbove: input.qualityFailRateAbove ?? 0.1,
    unplannedDowntimeAboveMin: input.unplannedDowntimeAboveMin ?? 600,
    availabilityBelow: input.availabilityBelow ?? 0.9,
    oeeBelow: input.oeeBelow ?? 0.85,
    energyPerRuntimeHourAbove: input.energyPerRuntimeHourAbove ?? 25,
  };
  for (const [name, value] of Object.entries(thresholds)) if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new DataToolError("INVALID_THRESHOLD", `${name} must be a non-negative number`);
  return thresholds;
}

function machineRisk(row, thresholds) {
  const reasons = [];
  if (row.production?.scrap_rate != null && row.production.scrap_rate > thresholds.scrapRateAbove) reasons.push("HIGH_SCRAP_RATE");
  if (row.quality?.fail_rate != null && row.quality.fail_rate > thresholds.qualityFailRateAbove) reasons.push("HIGH_QUALITY_FAIL_RATE");
  if (row.equipment?.unplanned_downtime_min != null && row.equipment.unplanned_downtime_min > thresholds.unplannedDowntimeAboveMin) reasons.push("HIGH_UNPLANNED_DOWNTIME");
  if (row.equipment?.availability != null && row.equipment.availability < thresholds.availabilityBelow) reasons.push("LOW_AVAILABILITY");
  if (row.equipment?.oee != null && row.equipment.oee < thresholds.oeeBelow) reasons.push("LOW_OEE");
  if (row.energy?.kwh_per_runtime_hour != null && row.energy.kwh_per_runtime_hour > thresholds.energyPerRuntimeHourAbove) reasons.push("HIGH_ENERGY_INTENSITY");
  return { risk_score: reasons.length, risk_reasons: reasons.join(",") };
}

export function analyzeMachine360({ sortBy = "risk_score", direction = "desc", limit = 100, ...input } = {}) {
  if (!MACHINE_SORT_FIELDS.has(sortBy)) throw new DataToolError("INVALID_SORT_FIELD", `Unsupported machine 360 sort field: ${sortBy}`);
  const dir = String(direction).toLowerCase();
  if (!new Set(["asc", "desc"]).has(dir)) throw new DataToolError("INVALID_SORT", `Invalid sort direction: ${direction}`);
  const scope = commonScope(input);
  const dataTimeRange = machineObservedDataRange(scope);
  const thresholds = validateThresholds(input);
  const shared = { dateFrom: scope.dateFrom, dateTo: scope.dateTo, machineIds: scope.machineIds, lineIds: scope.lineIds };
  const productionRows = analyzeProductionBreakdown({ ...shared, dimension: "machine", orderBy: "actual_qty", direction: "desc", limit: 500 }).rows;
  const qualityRows = analyzeQualityBreakdown({ ...shared, dimension: "machine", orderBy: "inspection_count", direction: "desc", limit: 500 }).rows;
  const equipmentRows = analyzeEquipmentBreakdown({ ...shared, dimension: "machine", orderBy: "downtime_min", direction: "desc", limit: 500 }).rows;
  const energyRows = analyzeEnergyBreakdown({ ...shared, dimension: "machine", orderBy: "electricity_kwh", direction: "desc", limit: 500 }).rows;
  const production = domainRowsByKey(productionRows, "machine_id");
  const quality = domainRowsByKey(qualityRows, "machine_id");
  const energy = domainRowsByKey(energyRows, "machine_id");
  const ids = new Set([...equipmentRows.map((row) => row.machine_id), ...production.keys(), ...quality.keys(), ...energy.keys()]);
  const equipment = domainRowsByKey(equipmentRows, "machine_id");
  const rows = [...ids].map((machineId) => {
    const base = equipment.get(machineId) ?? production.get(machineId) ?? quality.get(machineId) ?? energy.get(machineId);
    const row = {
      machine_id: machineId,
      line_id: base?.line_id ?? null,
      machine_type: base?.machine_type ?? null,
      manufacturer: base?.manufacturer ?? null,
      production: without(production.get(machineId), ["machine_id", "machine_type"]),
      quality: without(quality.get(machineId), ["machine_id", "machine_type"]),
      equipment: without(equipment.get(machineId), ["machine_id", "line_id", "machine_type", "manufacturer", "status"]),
      energy: without(energy.get(machineId), ["machine_id", "line_id", "machine_type", "manufacturer", "rated_power_kw"]),
    };
    return { ...row, ...machineRisk(row, thresholds) };
  });
  const value = (row) => sortBy === "risk_score" ? row.risk_score
    : sortBy === "actual_qty" || sortBy === "scrap_rate" ? row.production?.[sortBy]
    : sortBy === "quality_fail_rate" ? row.quality?.fail_rate
    : sortBy === "kwh_per_runtime_hour" ? row.energy?.kwh_per_runtime_hour
    : row.equipment?.[sortBy];
  rows.sort((a, b) => {
    const av = value(a); const bv = value(b);
    if (av == null && bv == null) return a.machine_id.localeCompare(b.machine_id);
    if (av == null) return 1;
    if (bv == null) return -1;
    return dir === "asc" ? av - bv : bv - av;
  });
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
  return { scope, dataTimeRange, thresholds, rows: rows.slice(0, safeLimit), returned: Math.min(rows.length, safeLimit), dataNotes: CROSS_DOMAIN_NOTES };
}

export function analyzeProduct360({ productIds = [], sortBy = "actual_qty", direction = "desc", limit = 100, ...input } = {}) {
  if (!PRODUCT_SORT_FIELDS.has(sortBy)) throw new DataToolError("INVALID_SORT_FIELD", `Unsupported product 360 sort field: ${sortBy}`);
  const dir = String(direction).toLowerCase();
  if (!new Set(["asc", "desc"]).has(dir)) throw new DataToolError("INVALID_SORT", `Invalid sort direction: ${direction}`);
  const scope = commonScope(input);
  const ids = validateList(productIds, "productIds");
  const shared = { dateFrom: scope.dateFrom, dateTo: scope.dateTo, machineIds: scope.machineIds, lineIds: scope.lineIds, productIds: ids };
  const dataTimeRange = machineObservedDataRange(scope);
  const productionRows = analyzeProductionBreakdown({ ...shared, dimension: "product", orderBy: "actual_qty", direction: "desc", limit: 500 }).rows;
  const qualityRows = analyzeQualityBreakdown({ ...shared, dimension: "product", orderBy: "inspection_count", direction: "desc", limit: 500 }).rows;
  const inventoryRows = analyzeInventoryStatus({ asOfDate: scope.dateTo, itemTypes: ["FINISHED_GOOD"], itemIds: ids }).rows;
  const quality = domainRowsByKey(qualityRows, "product_id");
  const inventory = domainRowsByKey(inventoryRows, "item_id");
  const production = domainRowsByKey(productionRows, "product_id");
  const machineRiskRows = analyzeMachine360({ ...scope, sortBy: "risk_score", direction: "desc", limit: 100 }).rows;
  const machineRisks = domainRowsByKey(machineRiskRows, "machine_id");
  const machineClauses = [];
  const machineParams = [];
  if (scope.dateFrom) { machineClauses.push("substr(o.actual_start,1,10) >= ?"); machineParams.push(scope.dateFrom); }
  if (scope.dateTo) { machineClauses.push("substr(o.actual_start,1,10) <= ?"); machineParams.push(scope.dateTo); }
  if (scope.machineIds.length) { machineClauses.push("o.machine_id IN (SELECT value FROM json_each(?))"); machineParams.push(JSON.stringify(scope.machineIds)); }
  if (scope.lineIds.length) { machineClauses.push("m.line_id IN (SELECT value FROM json_each(?))"); machineParams.push(JSON.stringify(scope.lineIds)); }
  if (ids.length) { machineClauses.push("o.product_id IN (SELECT value FROM json_each(?))"); machineParams.push(JSON.stringify(ids)); }
  const productMachineRows = runReadOnlySql({
    sql: `SELECT o.product_id, o.machine_id, m.line_id, m.machine_type,
      SUM(o.actual_qty) AS actual_qty, SUM(o.good_qty) AS good_qty, SUM(o.scrap_qty) AS scrap_qty,
      ROUND(SUM(o.scrap_qty)*1.0/NULLIF(SUM(o.actual_qty),0),4) AS scrap_rate
      FROM production_orders o JOIN machines m ON m.machine_id=o.machine_id
      ${machineClauses.length ? `WHERE ${machineClauses.join(" AND ")}` : ""}
      GROUP BY o.product_id,o.machine_id,m.line_id,m.machine_type
      ORDER BY o.product_id,actual_qty DESC,o.machine_id`,
    params: machineParams,
    limit: 500,
  }).rows;
  const machinesByProduct = new Map();
  for (const item of productMachineRows) {
    const risk = machineRisks.get(item.machine_id);
    const row = { ...item, machine_risk_score: risk?.risk_score ?? 0, machine_risk_reasons: risk?.risk_reasons ?? "" };
    if (!machinesByProduct.has(item.product_id)) machinesByProduct.set(item.product_id, []);
    machinesByProduct.get(item.product_id).push(row);
  }
  const allIds = new Set([...production.keys(), ...quality.keys(), ...inventory.keys()]);
  const rows = [...allIds].map((productId) => {
    const p = production.get(productId);
    const q = quality.get(productId);
    const i = inventory.get(productId);
    const relatedMachines = machinesByProduct.get(productId) ?? [];
    const productActualQty = Number(p?.actual_qty ?? 0);
    const highRiskActualQty = relatedMachines.filter((item) => item.machine_risk_score >= 3)
      .reduce((sum, item) => sum + Number(item.actual_qty ?? 0), 0);
    const reasons = [];
    if (p?.scrap_rate > 0.03) reasons.push("HIGH_SCRAP_RATE");
    if (q?.fail_rate > 0.1) reasons.push("HIGH_QUALITY_FAIL_RATE");
    return {
      product_id: productId,
      product_name: p?.product_name ?? i?.item_name ?? null,
      production: without(p, ["product_id", "product_name"]),
      quality: without(q, ["product_id", "product_name"]),
      inventory: without(i, ["item_id", "item_name", "item_type"]),
      relatedEquipment: {
        machine_count: relatedMachines.length,
        high_risk_machine_count: relatedMachines.filter((item) => item.machine_risk_score >= 3).length,
        high_risk_machine_actual_share: productActualQty ? Number((highRiskActualQty / productActualQty).toFixed(4)) : null,
        machines: relatedMachines,
      },
      risk_score: reasons.length,
      risk_reasons: reasons.join(","),
    };
  });
  const value = (row) => sortBy === "actual_qty" || sortBy === "scrap_rate" ? row.production?.[sortBy]
    : sortBy === "quality_fail_rate" ? row.quality?.fail_rate
    : sortBy === "defect_rate" ? row.quality?.sample_defect_rate
    : row.inventory?.[sortBy];
  rows.sort((a, b) => {
    const av = value(a); const bv = value(b);
    if (av == null && bv == null) return a.product_id.localeCompare(b.product_id);
    if (av == null) return 1;
    if (bv == null) return -1;
    return dir === "asc" ? av - bv : bv - av;
  });
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
  return { scope: { ...scope, productIds: ids }, dataTimeRange, rows: rows.slice(0, safeLimit), returned: Math.min(rows.length, safeLimit), dataNotes: CROSS_DOMAIN_NOTES };
}

export function getCrossDomainTrend({ grain = "month", ...input } = {}) {
  if (!GRAINS.has(grain)) throw new DataToolError("INVALID_GRAIN", `Unsupported time grain: ${grain}`);
  const scope = commonScope(input);
  const machineScope = { dateFrom: scope.dateFrom, dateTo: scope.dateTo, machineIds: scope.machineIds, lineIds: scope.lineIds, grain, limit: 500 };
  const dateScope = { dateFrom: scope.dateFrom, dateTo: scope.dateTo, grain, limit: 500 };
  const domains = {
    production: getProductionTrend(machineScope).rows,
    quality: getQualityTrend(machineScope).rows,
    equipment: getEquipmentTrend(machineScope).rows,
    energy: getEnergyTrend(machineScope).rows,
    supplier: getSupplierTrend(dateScope).rows,
    inventory: getInventoryTrend(dateScope).rows,
  };
  const periods = new Set(Object.values(domains).flatMap((rows) => rows.map((row) => row.period)));
  const maps = Object.fromEntries(Object.entries(domains).map(([name, rows]) => [name, new Map(rows.map((row) => [row.period, without(row, ["period"])]))]));
  const rows = [...periods].sort().map((period) => ({ period, ...Object.fromEntries(Object.entries(maps).map(([name, map]) => [name, map.get(period) ?? null])) }));
  return { scope, grain, rows, returned: rows.length, dataNotes: CROSS_DOMAIN_NOTES };
}

export function traceWorkOrder({ orderId }) {
  if (typeof orderId !== "string" || !orderId.trim()) throw new DataToolError("INVALID_ORDER_ID", "orderId must be a non-empty string");
  const id = orderId.trim();
  const order = runReadOnlySql({
    sql: `SELECT o.*, p.product_name, p.standard_cycle_min, m.machine_type, m.manufacturer FROM production_orders o JOIN products p ON p.product_id = o.product_id JOIN machines m ON m.machine_id = o.machine_id WHERE o.order_id = ?`,
    params: [id], limit: 1,
  }).rows[0];
  if (!order) throw new DataToolError("ORDER_NOT_FOUND", `Unknown production order: ${id}`);
  const inspections = runReadOnlySql({ sql: "SELECT * FROM quality_inspections WHERE order_id = ? ORDER BY inspection_time, inspection_id", params: [id], limit: 500 }).rows;
  const downtime = runReadOnlySql({ sql: "SELECT * FROM downtime_events WHERE order_id = ? ORDER BY start_time, downtime_id", params: [id], limit: 500 }).rows;
  const inventory = runReadOnlySql({ sql: "SELECT * FROM inventory_transactions WHERE reference_id = ? ORDER BY transaction_time, transaction_id", params: [id], limit: 500 }).rows;
  const inspectionSummary = inspections.reduce((acc, row) => {
    acc.inspection_count += 1; acc.pass_count += row.inspection_result === "PASS" ? 1 : 0; acc.fail_count += row.inspection_result === "PASS" ? 0 : 1; acc.sample_size += Number(row.sample_size); acc.defect_count += Number(row.defect_count); return acc;
  }, { inspection_count: 0, pass_count: 0, fail_count: 0, sample_size: 0, defect_count: 0 });
  inspectionSummary.sample_defect_rate = inspectionSummary.sample_size ? Number((inspectionSummary.defect_count / inspectionSummary.sample_size).toFixed(4)) : null;
  const downtimeSummary = downtime.reduce((acc, row) => { acc.event_count += 1; acc.duration_min += Number(row.duration_min); acc.unplanned_duration_min += row.planned_flag ? 0 : Number(row.duration_min); return acc; }, { event_count: 0, duration_min: 0, unplanned_duration_min: 0 });
  const inventorySummary = inventory.reduce((acc, row) => { acc.transaction_count += 1; acc.net_quantity += Number(row.quantity); acc.net_value_cny += Number(row.quantity) * Number(row.unit_cost_cny); return acc; }, { transaction_count: 0, net_quantity: 0, net_value_cny: 0 });
  inventorySummary.net_value_cny = Number(inventorySummary.net_value_cny.toFixed(2));
  return { order, summaries: { quality: inspectionSummary, downtime: downtimeSummary, inventory: inventorySummary }, inspections, downtimeEvents: downtime, inventoryTransactions: inventory, dataNotes: ["Downtime and inventory rows are included only when their order_id/reference_id directly matches the requested work order."] };
}

export function findCrossDomainRisks({ minimumRiskScore = 1, limit = 100, ...input } = {}) {
  if (!Number.isInteger(minimumRiskScore) || minimumRiskScore < 1 || minimumRiskScore > 6) throw new DataToolError("INVALID_THRESHOLD", "minimumRiskScore must be an integer from 1 to 6");
  const result = analyzeMachine360({ ...input, sortBy: "risk_score", direction: "desc", limit: 100 });
  const rows = result.rows.filter((row) => row.risk_score >= minimumRiskScore).slice(0, Math.min(Math.max(Number(limit) || 100, 1), 100));
  return { scope: result.scope, thresholds: result.thresholds, minimumRiskScore, rows, returned: rows.length, dataNotes: CROSS_DOMAIN_NOTES };
}

export function getManufacturingOverview(input = {}) {
  const scope = commonScope(input);
  const shared = { dateFrom: scope.dateFrom, dateTo: scope.dateTo, machineIds: scope.machineIds, lineIds: scope.lineIds };
  const production = getProductionSummary(shared);
  const quality = getQualitySummary(shared);
  const equipment = getEquipmentSummary(shared);
  const energy = getEnergySummary(shared);
  const supplier = getSupplierSummary({ dateFrom: scope.dateFrom, dateTo: scope.dateTo });
  const inventory = getInventorySummary({ dateFrom: scope.dateFrom, dateTo: scope.dateTo, asOfDate: scope.dateTo });
  const machineRisks = findCrossDomainRisks({ ...scope, minimumRiskScore: 1, limit: 100 });
  return {
    scope,
    highlights: {
      actual_qty: production.metrics?.actual_qty ?? 0,
      yield_rate: production.metrics?.yield_rate ?? null,
      quality_pass_rate: quality.metrics?.pass_rate ?? null,
      equipment_oee: equipment.metrics?.oee ?? null,
      electricity_kwh: energy.metrics?.electricity_kwh ?? 0,
      supplier_on_time_rate: supplier.metrics?.on_time_rate ?? null,
      supplier_defect_rate: supplier.metrics?.defect_rate ?? null,
      inferred_inventory_value_cny: inventory.balanceMetrics?.inferred_balance_value_cny ?? null,
      cross_domain_risk_machine_count: machineRisks.returned,
    },
    domains: { production, quality, equipment, energy, supplier, inventory },
    machineRisks: machineRisks.rows,
    dataNotes: CROSS_DOMAIN_NOTES,
  };
}
