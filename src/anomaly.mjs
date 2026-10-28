import { DataToolError } from "./database.mjs";
import { findProductionExceptions, getProductionTrend } from "./production.mjs";
import { findQualityExceptions, getQualityTrend } from "./quality.mjs";
import { findEquipmentExceptions, getEquipmentTrend } from "./equipment.mjs";
import { findEnergyExceptions, getEnergyTrend } from "./energy.mjs";
import { findSupplierExceptions, getSupplierTrend } from "./supplier.mjs";
import { findInventoryExceptions, getInventoryTrend } from "./inventory.mjs";
import { findCrossDomainRisks } from "./cross_domain.mjs";

const RULE_DOMAINS = new Set(["production", "quality", "equipment", "energy", "supplier", "inventory", "cross_domain"]);
const METHODS = new Set(["zscore", "iqr", "mad"]);
const TREND_METHODS = new Set(["change_rate", "rolling_slope"]);
const DIRECTIONS = new Set(["both", "high", "low"]);
const GRAINS = new Set(["day", "week", "month"]);

const SERIES_CATALOG = {
  "production.scrap_rate": { domain: "production", field: "scrap_rate", adverseDirection: "high" },
  "production.plan_completion_rate": { domain: "production", field: "plan_completion_rate", adverseDirection: "low" },
  "quality.fail_rate": { domain: "quality", field: "fail_rate", adverseDirection: "high" },
  "quality.sample_defect_rate": { domain: "quality", field: "sample_defect_rate", adverseDirection: "high" },
  "equipment.unplanned_downtime_min": { domain: "equipment", field: "unplanned_downtime_min", adverseDirection: "high" },
  "equipment.oee": { domain: "equipment", field: "oee", adverseDirection: "low" },
  "energy.kwh_per_runtime_hour": { domain: "energy", field: "kwh_per_runtime_hour", adverseDirection: "high" },
  "energy.electricity_kwh": { domain: "energy", field: "electricity_kwh", adverseDirection: "high" },
  "supplier.on_time_rate": { domain: "supplier", field: "on_time_rate", adverseDirection: "low" },
  "supplier.defect_rate": { domain: "supplier", field: "defect_rate", adverseDirection: "high" },
  "inventory.net_movement_qty": { domain: "inventory", field: "net_movement_qty", adverseDirection: "both" },
  "inventory.outbound_qty": { domain: "inventory", field: "outbound_qty", adverseDirection: "both" },
};

const NOTES = [
  "Statistical and trend anomalies indicate unusual observations relative to the selected series; they do not establish root cause.",
  "Daily energy is aligned by machine/date, while supplier and inventory series remain plant-wide under machine or line filters.",
  "Rule anomalies preserve the source domain's metric definitions and data-granularity limitations.",
];

function validateList(values, field, allowed = null) {
  if (values == null) return [];
  if (!Array.isArray(values) || values.length > 100 || values.some((value) => typeof value !== "string" || !value.trim())) throw new DataToolError("INVALID_SCOPE", `${field} must contain at most 100 non-empty strings`);
  const normalized = [...new Set(values.map((value) => value.trim()))];
  if (allowed && normalized.some((value) => !allowed.has(value))) throw new DataToolError("INVALID_SCOPE", `${field} contains an unsupported value`);
  return normalized;
}

function sharedScope(input = {}) {
  return {
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    machineIds: validateList(input.machineIds, "machineIds"),
    lineIds: validateList(input.lineIds, "lineIds"),
  };
}

function thresholdObject(input) {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new DataToolError("INVALID_THRESHOLD", "thresholdOverrides must be an object");
  return input;
}

function normalizeRuleRows(domain, rows) {
  const entity = {
    production: (row) => ["work_order", row.order_id, row.actual_start],
    quality: (row) => ["inspection", row.inspection_id, row.inspection_time],
    equipment: (row) => ["machine", row.machine_id, null],
    energy: (row) => ["energy_reading", row.reading_id, row.reading_date],
    supplier: (row) => ["supplier_receipt", row.receipt_id, row.receipt_date],
    inventory: (row) => ["inventory_item", row.item_id, row.last_transaction_time],
    cross_domain: (row) => ["machine", row.machine_id, null],
  };
  return rows.map((row) => {
    const [entityType, entityId, eventTime] = entity[domain](row);
    return {
      anomaly_type: "RULE",
      domain,
      entity_type: entityType,
      entity_id: entityId,
      event_time: eventTime,
      severity_score: Number(row.severity_score ?? row.risk_score ?? 1),
      anomaly_reasons: row.exception_reasons ?? row.risk_reasons ?? "RULE_MATCH",
      record: row,
    };
  });
}

export function detectRuleAnomalies({ domains = [...RULE_DOMAINS], limitPerDomain = 50, thresholdOverrides = {}, ...input } = {}) {
  const selected = validateList(domains, "domains", RULE_DOMAINS);
  if (!selected.length) throw new DataToolError("INVALID_SCOPE", "domains must not be empty");
  const safeLimit = Math.min(Math.max(Number(limitPerDomain) || 50, 1), 200);
  const scope = sharedScope(input);
  const overrides = thresholdObject(thresholdOverrides);
  const dateScope = { dateFrom: scope.dateFrom, dateTo: scope.dateTo };
  const machineScope = { ...dateScope, machineIds: scope.machineIds, lineIds: scope.lineIds };
  const results = {};
  for (const domain of selected) {
    let result;
    if (domain === "production") result = findProductionExceptions({ ...machineScope, ...(overrides.production ?? {}), limit: safeLimit });
    if (domain === "quality") result = findQualityExceptions({ ...machineScope, ...(overrides.quality ?? {}), limit: safeLimit });
    if (domain === "equipment") result = findEquipmentExceptions({ ...machineScope, ...(overrides.equipment ?? {}), limit: safeLimit });
    if (domain === "energy") result = findEnergyExceptions({ ...machineScope, ...(overrides.energy ?? {}), limit: safeLimit });
    if (domain === "supplier") result = findSupplierExceptions({ ...dateScope, ...(overrides.supplier ?? {}), limit: safeLimit });
    if (domain === "inventory") result = findInventoryExceptions({ asOfDate: scope.dateTo, itemTypes: ["RAW_MATERIAL"], ...(overrides.inventory ?? {}), limit: safeLimit });
    if (domain === "cross_domain") result = findCrossDomainRisks({ ...machineScope, ...(overrides.cross_domain ?? {}), limit: safeLimit });
    results[domain] = normalizeRuleRows(domain, result?.rows ?? []);
  }
  const anomalies = Object.values(results).flat().sort((a, b) => b.severity_score - a.severity_score || a.domain.localeCompare(b.domain));
  return { scope, domains: selected, thresholdOverrides: overrides, counts: Object.fromEntries(Object.entries(results).map(([domain, rows]) => [domain, rows.length])), total: anomalies.length, anomalies, dataNotes: NOTES };
}

function getSeries(metric, grain, scope) {
  const config = SERIES_CATALOG[metric];
  if (!config) throw new DataToolError("INVALID_METRIC", `Unsupported anomaly metric: ${metric}`);
  const machineInput = { ...scope, grain, limit: 500 };
  const dateInput = { dateFrom: scope.dateFrom, dateTo: scope.dateTo, grain, limit: 500 };
  let rows;
  if (config.domain === "production") rows = getProductionTrend(machineInput).rows;
  if (config.domain === "quality") rows = getQualityTrend(machineInput).rows;
  if (config.domain === "equipment") rows = getEquipmentTrend(machineInput).rows;
  if (config.domain === "energy") rows = getEnergyTrend(machineInput).rows;
  if (config.domain === "supplier") rows = getSupplierTrend(dateInput).rows;
  if (config.domain === "inventory") rows = getInventoryTrend(dateInput).rows;
  const series = rows.map((row) => ({ period: row.period, value: row[config.field] })).filter((row) => typeof row.value === "number" && Number.isFinite(row.value));
  return { config, series };
}

function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function sampleStdDev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}
function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position); const upper = Math.ceil(position);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
function median(values) { return quantile(values, 0.5); }
function directionMatches(value, center, direction) { return direction === "both" || (direction === "high" && value > center) || (direction === "low" && value < center); }
function round(value, digits = 4) { return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits)); }

export function detectStatisticalAnomalies({ metric, grain = "day", method = "mad", direction, threshold, minimumPoints = 8, ...input }) {
  if (!GRAINS.has(grain)) throw new DataToolError("INVALID_GRAIN", `Unsupported time grain: ${grain}`);
  if (!METHODS.has(method)) throw new DataToolError("INVALID_METHOD", `Unsupported statistical method: ${method}`);
  if (!Number.isInteger(minimumPoints) || minimumPoints < 5 || minimumPoints > 500) throw new DataToolError("INVALID_THRESHOLD", "minimumPoints must be an integer from 5 to 500");
  if (threshold != null && (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0)) throw new DataToolError("INVALID_THRESHOLD", "threshold must be a non-negative number");
  const scope = sharedScope(input);
  const { config, series } = getSeries(metric, grain, scope);
  if (series.length < minimumPoints) throw new DataToolError("INSUFFICIENT_DATA", `Need at least ${minimumPoints} numeric periods; received ${series.length}`);
  const selectedDirection = direction ?? config.adverseDirection;
  if (!DIRECTIONS.has(selectedDirection)) throw new DataToolError("INVALID_DIRECTION", `Unsupported direction: ${selectedDirection}`);
  const values = series.map((row) => row.value);
  const anomalies = [];
  let statistics;
  let cutoff = threshold;
  if (method === "zscore") {
    cutoff ??= 3;
    const avg = mean(values); const sd = sampleStdDev(values);
    statistics = { mean: round(avg), standard_deviation: round(sd) };
    for (const row of series) {
      const score = sd > 0 ? (row.value - avg) / sd : 0;
      if (Math.abs(score) > cutoff && directionMatches(row.value, avg, selectedDirection)) anomalies.push({ ...row, anomaly_score: round(score), deviation_from_center: round(row.value - avg) });
    }
  } else if (method === "iqr") {
    cutoff ??= 1.5;
    const q1 = quantile(values, 0.25); const q3 = quantile(values, 0.75); const iqr = q3 - q1;
    const lower = q1 - cutoff * iqr; const upper = q3 + cutoff * iqr; const center = median(values);
    statistics = { q1: round(q1), q3: round(q3), iqr: round(iqr), lower_bound: round(lower), upper_bound: round(upper) };
    for (const row of series) {
      const isOutlier = row.value < lower || row.value > upper;
      const score = iqr > 0 ? (row.value - center) / iqr : 0;
      if (isOutlier && directionMatches(row.value, center, selectedDirection)) anomalies.push({ ...row, anomaly_score: round(score), deviation_from_center: round(row.value - center) });
    }
  } else {
    cutoff ??= 3.5;
    const center = median(values); const deviations = values.map((value) => Math.abs(value - center)); const mad = median(deviations);
    statistics = { median: round(center), mad: round(mad) };
    for (const row of series) {
      const score = mad > 0 ? 0.6745 * (row.value - center) / mad : 0;
      if (Math.abs(score) > cutoff && directionMatches(row.value, center, selectedDirection)) anomalies.push({ ...row, anomaly_score: round(score), deviation_from_center: round(row.value - center) });
    }
  }
  anomalies.sort((a, b) => Math.abs(b.anomaly_score) - Math.abs(a.anomaly_score));
  return { scope, metric, domain: config.domain, field: config.field, grain, method, direction: selectedDirection, threshold: cutoff, statistics, seriesPointCount: series.length, anomalies, anomalyCount: anomalies.length, dataNotes: NOTES };
}

function linearSlope(values) {
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  let numerator = 0; let denominator = 0;
  for (let i = 0; i < n; i += 1) { numerator += (i - xMean) * (values[i] - yMean); denominator += (i - xMean) ** 2; }
  return denominator ? numerator / denominator : 0;
}

export function detectTrendAnomalies({ metric, grain = "day", method = "change_rate", direction, window = 7, threshold, minimumPoints = 12, ...input }) {
  if (!GRAINS.has(grain)) throw new DataToolError("INVALID_GRAIN", `Unsupported time grain: ${grain}`);
  if (!TREND_METHODS.has(method)) throw new DataToolError("INVALID_METHOD", `Unsupported trend method: ${method}`);
  if (!Number.isInteger(window) || window < 2 || window > 100) throw new DataToolError("INVALID_WINDOW", "window must be an integer from 2 to 100");
  if (!Number.isInteger(minimumPoints) || minimumPoints < window + 1 || minimumPoints > 500) throw new DataToolError("INVALID_THRESHOLD", "minimumPoints must be greater than window and at most 500");
  const scope = sharedScope(input);
  const { config, series } = getSeries(metric, grain, scope);
  if (series.length < minimumPoints) throw new DataToolError("INSUFFICIENT_DATA", `Need at least ${minimumPoints} numeric periods; received ${series.length}`);
  const selectedDirection = direction ?? config.adverseDirection;
  if (!DIRECTIONS.has(selectedDirection)) throw new DataToolError("INVALID_DIRECTION", `Unsupported direction: ${selectedDirection}`);
  const cutoff = threshold ?? (method === "change_rate" ? 0.3 : 0.05);
  if (typeof cutoff !== "number" || !Number.isFinite(cutoff) || cutoff < 0) throw new DataToolError("INVALID_THRESHOLD", "threshold must be a non-negative number");
  const anomalies = [];
  if (method === "change_rate") {
    for (let index = window; index < series.length; index += 1) {
      const baselineValues = series.slice(index - window, index).map((row) => row.value);
      const baseline = mean(baselineValues);
      const changeRate = baseline !== 0 ? (series[index].value - baseline) / Math.abs(baseline) : null;
      if (changeRate != null && Math.abs(changeRate) > cutoff && directionMatches(series[index].value, baseline, selectedDirection)) {
        anomalies.push({ ...series[index], baseline: round(baseline), change_rate: round(changeRate), anomaly_score: round(Math.abs(changeRate) / (cutoff || 1)) });
      }
    }
  } else {
    for (let index = window - 1; index < series.length; index += 1) {
      const windowRows = series.slice(index - window + 1, index + 1);
      const values = windowRows.map((row) => row.value);
      const center = mean(values);
      const slope = linearSlope(values);
      const normalizedSlope = center !== 0 ? slope / Math.abs(center) : null;
      const impliedDirectionValue = normalizedSlope == null ? center : center + normalizedSlope;
      if (normalizedSlope != null && Math.abs(normalizedSlope) > cutoff && directionMatches(impliedDirectionValue, center, selectedDirection)) {
        anomalies.push({ ...series[index], window_start: windowRows[0].period, window_mean: round(center), slope: round(slope), normalized_slope: round(normalizedSlope), anomaly_score: round(Math.abs(normalizedSlope) / (cutoff || 1)) });
      }
    }
  }
  anomalies.sort((a, b) => b.anomaly_score - a.anomaly_score || a.period.localeCompare(b.period));
  return { scope, metric, domain: config.domain, field: config.field, grain, method, direction: selectedDirection, window, threshold: cutoff, seriesPointCount: series.length, anomalies, anomalyCount: anomalies.length, dataNotes: NOTES };
}

export function getAnomalyOverview(input = {}) {
  const scope = sharedScope(input);
  const rules = detectRuleAnomalies({ ...scope, limitPerDomain: input.limitPerDomain ?? 10 });
  const comparisonMetrics = [
    ["production", "production.scrap_rate"],
    ["quality", "quality.fail_rate"],
    ["equipment", "equipment.unplanned_downtime_min"],
    ["energy", "energy.kwh_per_runtime_hour"],
  ];
  const safeCheck = (method, domain, metric, operation) => {
    try { return { status: "completed", method, domain, ...operation() }; }
    catch (error) {
      if (error instanceof DataToolError && error.code === "INSUFFICIENT_DATA") {
        return { status: "insufficient_data", method, domain, metric, anomalyCount: 0, anomalies: [], error: { code: error.code, message: error.message } };
      }
      throw error;
    }
  };
  const statisticalChecks = comparisonMetrics.map(([domain, metric]) => safeCheck("statistical", domain, metric, () =>
    detectStatisticalAnomalies({ ...scope, metric, grain: "day", method: "mad", minimumPoints: 8 })));
  const trendChecks = comparisonMetrics.map(([domain, metric]) => safeCheck("trend", domain, metric, () =>
    detectTrendAnomalies({ ...scope, metric, grain: "month", method: "change_rate", window: 2, threshold: 0.3, minimumPoints: 5 })));
  const methodDomains = {
    rule: comparisonMetrics.map(([domain]) => domain).filter((domain) => (rules.counts[domain] ?? 0) > 0),
    statistical: statisticalChecks.filter((result) => result.anomalyCount > 0).map((result) => result.domain),
    trend: trendChecks.filter((result) => result.anomalyCount > 0).map((result) => result.domain),
  };
  const allDomains = comparisonMetrics.map(([domain]) => domain);
  const commonDomains = allDomains.filter((domain) => Object.values(methodDomains).every((domains) => domains.includes(domain)));
  const uniqueDomains = Object.fromEntries(Object.entries(methodDomains).map(([method, domains]) => [
    method,
    domains.filter((domain) => Object.entries(methodDomains).every(([other, values]) => other === method || !values.includes(domain))),
  ]));
  return {
    scope,
    counts: { rule: rules.total, statistical: statisticalChecks.reduce((sum, result) => sum + result.anomalyCount, 0), trend: trendChecks.reduce((sum, result) => sum + result.anomalyCount, 0) },
    rules,
    statisticalChecks,
    trendChecks,
    methodComparison: {
      level: "domain",
      comparedDomains: allDomains,
      methodDomains,
      commonDomains,
      uniqueDomains,
      caveat: "共同与独有异常按领域信号比较；规则记录、统计时间点和趋势窗口粒度不同，不能据此认定为同一事件或因果关系。",
    },
    dataNotes: NOTES,
  };
}

export const anomalySeriesCatalog = SERIES_CATALOG;
