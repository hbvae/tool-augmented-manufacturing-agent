import { DataToolError, runReadOnlySql } from "./database.mjs";
import { analyzeMachine360, analyzeProduct360 } from "./cross_domain.mjs";
import { analyzeProductionBreakdown, getProductionTrend } from "./production.mjs";
import { analyzeQualityBreakdown, getQualityTrend } from "./quality.mjs";
import { analyzeDowntime, getEquipmentTrend } from "./equipment.mjs";
import { analyzeEnergyBreakdown, getEnergyTrend } from "./energy.mjs";
import { analyzeSupplierBreakdown, getSupplierTrend } from "./supplier.mjs";
import { analyzeInventoryStatus, getInventoryTrend } from "./inventory.mjs";
import { metricCatalog, resolveMetric } from "./semantic.mjs";

function clamp(value, minimum = 0, maximum = 1) { return Math.max(minimum, Math.min(maximum, value)); }
function round(value, digits = 2) { const scale = 10 ** digits; return Math.round(value * scale) / scale; }
function finite(value, fallback = 0) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }
const driverLabels = { downtime: "非计划停机", failures: "故障频次", mtbf: "MTBF", oee: "OEE", deteriorationTrend: "停机恶化趋势", quality: "质量失败", energy: "能耗强度" };

function linearSlope(values) {
  if (values.length < 2) return 0;
  const xMean = (values.length - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0; let denominator = 0;
  values.forEach((value, index) => { numerator += (index - xMean) * (value - yMean); denominator += (index - xMean) ** 2; });
  return denominator ? numerator / denominator : 0;
}

function latestDataDate() {
  return runReadOnlySql({ sql: "SELECT MAX(substr(actual_start,1,10)) AS latest_date FROM production_orders", limit: 1 }).rows[0].latest_date;
}

export function predictMaintenanceRisk({ dateFrom, dateTo, machineIds = [], lineIds = [], horizonDays = 30, limit = 100 } = {}) {
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 365) throw new DataToolError("INVALID_HORIZON", "horizonDays must be an integer from 1 to 365");
  const scope = { dateFrom, dateTo, machineIds, lineIds };
  const machines = analyzeMachine360({ ...scope, sortBy: "risk_score", direction: "desc", limit: 100 }).rows;
  const asOfDate = dateTo ?? latestDataDate();
  const predictions = machines.map((row) => {
    const trendRows = getEquipmentTrend({ ...scope, machineIds: [row.machine_id], grain: "month", limit: 24 }).rows;
    const downtimeSeries = trendRows.slice(-6).map((item) => finite(item.unplanned_downtime_min));
    const averageDowntime = downtimeSeries.length ? downtimeSeries.reduce((sum, value) => sum + value, 0) / downtimeSeries.length : 0;
    const slope = linearSlope(downtimeSeries);
    const normalizedSlope = averageDowntime > 0 ? slope / averageDowntime : 0;
    const components = {
      downtime: 20 * clamp(finite(row.equipment?.unplanned_downtime_min) / 1200),
      failures: 15 * clamp(finite(row.equipment?.failure_count) / 6),
      mtbf: 15 * clamp((200 - finite(row.equipment?.mtbf_hours, 200)) / 200),
      oee: 15 * clamp((0.9 - finite(row.equipment?.oee, 0.9)) / 0.2),
      deteriorationTrend: 15 * clamp(normalizedSlope / 0.5),
      quality: 10 * clamp(finite(row.quality?.fail_rate) / 0.15),
      energy: 10 * clamp((finite(row.energy?.kwh_per_runtime_hour) - 18) / 12),
    };
    const riskScore = round(Object.values(components).reduce((sum, value) => sum + value, 0));
    const riskLevel = riskScore >= 70 ? "CRITICAL" : riskScore >= 50 ? "HIGH" : riskScore >= 30 ? "MEDIUM" : "LOW";
    const recommendedWithinDays = riskLevel === "CRITICAL" ? 3 : riskLevel === "HIGH" ? 7 : riskLevel === "MEDIUM" ? 14 : horizonDays;
    const due = new Date(`${asOfDate}T00:00:00Z`); due.setUTCDate(due.getUTCDate() + Math.min(recommendedWithinDays, horizonDays));
    const drivers = Object.entries(components).sort((a, b) => b[1] - a[1]).filter(([, value]) => value > 0).slice(0, 3).map(([name]) => name);
    return {
      machine_id: row.machine_id,
      line_id: row.line_id,
      risk_score: riskScore,
      risk_level: riskLevel,
      recommended_action_by: due.toISOString().slice(0, 10),
      top_drivers: drivers,
      monthly_downtime_slope: round(slope),
      latest_oee: row.equipment?.oee ?? null,
      mtbf_hours: row.equipment?.mtbf_hours ?? null,
      mttr_min: row.equipment?.mttr_min ?? null,
      quality_fail_rate: row.quality?.fail_rate ?? null,
      kwh_per_runtime_hour: row.energy?.kwh_per_runtime_hour ?? null,
      component_scores: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, round(value)])),
      recommended_action: riskLevel === "LOW" ? "按当前预防性维护计划执行并持续监测。" : `在${Math.min(recommendedWithinDays, horizonDays)}天内检查${drivers.map((driver) => driverLabels[driver]).join("、")}相关项目。`,
    };
  }).sort((a, b) => b.risk_score - a.risk_score).slice(0, Math.min(Math.max(Number(limit) || 100, 1), 100));
  return {
    scope, asOfDate, horizonDays, model: "transparent_weighted_heuristic_v1", rows: predictions, returned: predictions.length,
    modelDefinition: {
      maximumScore: 100,
      weights: { downtime: 20, failures: 15, mtbf: 15, oee: 15, deteriorationTrend: 15, quality: 10, energy: 10 },
      levels: { critical: ">=70", high: "50-69.99", medium: "30-49.99", low: "<30" },
    },
    dataNotes: ["该结果是基于历史停机、可靠性、OEE、质量和能耗信号的透明风险筛查，不是经过故障标签训练的失效概率模型。", "建议结合点检、振动、温度和维修工单数据后再制定维修决策。"],
  };
}

function candidateRows(rows, domain, key, valueField, weight, evidenceFields) {
  const maximum = Math.max(...rows.map((row) => finite(row[valueField])), 0);
  return rows.filter((row) => row[key] != null && finite(row[valueField]) > 0).map((row) => ({
    domain,
    candidate: String(row[key]),
    candidate_score: maximum ? round(weight * finite(row[valueField]) / maximum) : 0,
    primary_metric: valueField,
    primary_value: row[valueField],
    evidence: Object.fromEntries(evidenceFields.map((field) => [field, row[field] ?? null])),
  }));
}

function buildProductionPaceEvidence(rows) {
  const normalized = rows.map((row) => {
    const cycleTimeIndex = row.cycle_time_index == null ? null : finite(row.cycle_time_index);
    const varianceRate = cycleTimeIndex == null ? null : round(cycleTimeIndex - 1, 4);
    const paceStatus = cycleTimeIndex == null ? "NO_DATA"
      : cycleTimeIndex > 1.15 ? "SLOWER_THAN_STANDARD"
        : cycleTimeIndex < 0.85 ? "FASTER_THAN_STANDARD" : "NEAR_STANDARD";
    return {
      shift: row.shift,
      order_count: row.order_count,
      actual_qty: row.actual_qty,
      scrap_qty: row.scrap_qty,
      scrap_rate: row.scrap_rate,
      runtime_min: row.runtime_min,
      weighted_cycle_time_min: row.weighted_cycle_time_min,
      weighted_standard_cycle_min: row.weighted_standard_cycle_min,
      cycle_time_index: row.cycle_time_index,
      cycle_time_variance_rate: varianceRate,
      avg_start_delay_min: row.avg_start_delay_min,
      pace_status: paceStatus,
    };
  });
  const ranked = [...normalized].filter((row) => row.cycle_time_index != null)
    .sort((a, b) => b.cycle_time_index - a.cycle_time_index);
  const slowest = ranked[0] ?? null;
  return {
    grain: "shift",
    rows: normalized,
    returned: normalized.length,
    slowest_shift: slowest?.shift ?? null,
    maximum_cycle_time_index: slowest?.cycle_time_index ?? null,
    material_slowdown_detected: Boolean(slowest && slowest.cycle_time_index > 1.15),
    threshold: { slower_than_standard: "> 1.15", faster_than_standard: "< 0.85", near_standard: "0.85 to 1.15" },
    metricDefinitions: {
      weighted_cycle_time_min: "SUM(runtime_min) / SUM(actual_qty)",
      weighted_standard_cycle_min: "SUM(actual_qty * standard_cycle_min) / SUM(actual_qty)",
      cycle_time_index: "SUM(runtime_min) / SUM(actual_qty * standard_cycle_min); values above 1 indicate slower-than-standard pace",
    },
  };
}

export function rankRootCauseCandidates({ machineId, dateFrom, dateTo, limit = 10 } = {}) {
  const selected = machineId ?? analyzeMachine360({ dateFrom, dateTo, sortBy: "risk_score", direction: "desc", limit: 1 }).rows[0]?.machine_id;
  if (!selected) throw new DataToolError("INSUFFICIENT_DATA", "No machine data is available for root-cause candidate ranking");
  const scope = { dateFrom, dateTo, machineIds: [selected] };
  const downtime = analyzeDowntime({ ...scope, dimension: "reason", orderBy: "downtime_min", direction: "desc", limit: 20 }).rows;
  const quality = analyzeQualityBreakdown({ ...scope, dimension: "defect_type", orderBy: "sample_defect_rate", direction: "desc", limit: 20 }).rows;
  const production = analyzeProductionBreakdown({ ...scope, dimension: "shift", orderBy: "scrap_rate", direction: "desc", limit: 20 }).rows;
  const productionPaceEvidence = buildProductionPaceEvidence(production);
  const energy = analyzeEnergyBreakdown({ ...scope, dimension: "machine", orderBy: "kwh_per_runtime_hour", direction: "desc", limit: 1 }).rows;
  const candidates = [
    ...candidateRows(downtime, "equipment", "reason", "downtime_min", 40, ["event_count", "downtime_min", "unplanned_downtime_min", "failure_count"]),
    ...candidateRows(quality, "quality", "defect_type", "sample_defect_rate", 30, ["inspection_count", "fail_count", "defect_count", "sample_defect_rate"]),
    ...candidateRows(production, "production", "shift", "scrap_rate", 20, ["order_count", "actual_qty", "scrap_qty", "scrap_rate"]),
    ...candidateRows(energy, "energy", "machine_id", "kwh_per_runtime_hour", 10, ["electricity_kwh", "runtime_hours", "kwh_per_runtime_hour", "idle_electricity_kwh"]),
  ].sort((a, b) => b.candidate_score - a.candidate_score).slice(0, Math.min(Math.max(Number(limit) || 10, 1), 50))
    .map((row, index) => ({ rank: index + 1, ...row }));
  return {
    machineId: selected, scope, rows: candidates, returned: candidates.length, productionPaceEvidence,
    scoring: { equipment: 40, quality: 30, production: 20, energy: 10, method: "within-domain relative evidence strength" },
    dataNotes: ["候选项按跨表证据强度排序，用于缩小排查范围，不证明因果关系。", "设备停机原因、质量缺陷类型、生产班次和能耗信号的粒度不同。", "productionPaceEvidence 单独给出各班次实际加权循环时间、标准节拍和节拍指数；即使节拍接近标准，也应作为反对生产节拍根因的证据明确报告。"],
  };
}

export function rankMachineRootCausesBatch({ machineIds, dateFrom, dateTo, limitPerMachine = 5 } = {}) {
  if (!Array.isArray(machineIds) || machineIds.length < 2 || machineIds.length > 10) {
    throw new DataToolError("INVALID_MACHINE_SCOPE", "machineIds must contain 2 to 10 machine identifiers");
  }
  const normalizedIds = [...new Set(machineIds.map((value) => String(value).trim()).filter(Boolean))];
  if (normalizedIds.length !== machineIds.length) {
    throw new DataToolError("INVALID_MACHINE_SCOPE", "machineIds must be non-empty and unique");
  }
  const safeLimit = Math.min(Math.max(Number(limitPerMachine) || 5, 1), 10);
  const rows = normalizedIds.map((machineId) => {
    const result = rankRootCauseCandidates({ machineId, dateFrom, dateTo, limit: safeLimit });
    return {
      machine_id: machineId,
      candidates: result.rows,
      productionPaceEvidence: result.productionPaceEvidence,
    };
  });
  return {
    scope: { machineIds: normalizedIds, dateFrom, dateTo },
    limitPerMachine: safeLimit,
    rows,
    returned: rows.length,
    scoring: { equipment: 40, quality: 30, production: 20, energy: 10, method: "within-domain relative evidence strength" },
    dataNotes: [
      "每台设备的候选项独立排序，用于批量缩小排查范围，不证明因果关系。",
      "每台设备均返回 productionPaceEvidence；回答应明确节拍证据支持还是反对生产节拍异常假设。",
    ],
  };
}

const trendHandlers = { production: getProductionTrend, quality: getQualityTrend, equipment: getEquipmentTrend, energy: getEnergyTrend, supplier: getSupplierTrend, inventory: getInventoryTrend };
const defaultTrendMetric = { production: "actual_qty", quality: "quality_fail_rate", equipment: "unplanned_downtime_min", energy: "electricity_kwh", supplier: "supplier_on_time_rate", inventory: "inferred_inventory_balance" };
const trendFieldOverride = { quality_fail_rate: "fail_rate", supplier_on_time_rate: "on_time_rate", inferred_inventory_balance: "net_movement_qty", energy_intensity: "kwh_per_runtime_hour", mtbf_hours: "mtbf_hours" };

export function buildChartDataset({ domain, view = "trend", metric, grain = "month", dateFrom, dateTo, machineIds = [], lineIds = [], limit = 20 } = {}) {
  if (view === "maintenance_risk") {
    const result = predictMaintenanceRisk({ dateFrom, dateTo, machineIds, lineIds, limit });
    return { chart: { type: "bar", title: "设备预测性维护风险", categoryField: "machine_id", series: [{ field: "risk_score", label: "风险分数", unit: "分" }], sort: "descending" }, rows: result.rows, returned: result.rows.length, source: result };
  }
  if (view === "root_cause") {
    const result = rankRootCauseCandidates({ machineId: machineIds[0], dateFrom, dateTo, limit });
    return { chart: { type: "bar", title: `${result.machineId} 根因候选`, categoryField: "candidate", series: [{ field: "candidate_score", label: "证据分数", unit: "分" }], sort: "descending" }, rows: result.rows, returned: result.rows.length, source: result };
  }
  if (view === "machine_ranking") {
    const selectedMetric = metric ?? "scrap_rate";
    const result = analyzeMachine360({ dateFrom, dateTo, machineIds, lineIds, sortBy: selectedMetric === "energy_intensity" ? "kwh_per_runtime_hour" : selectedMetric, direction: metricCatalog[selectedMetric]?.polarity === "high" ? "asc" : "desc", limit });
    const rows = result.rows.map((row) => ({ machine_id: row.machine_id, value: selectedMetric === "energy_intensity" ? row.energy?.kwh_per_runtime_hour : row.production?.[selectedMetric] ?? row.quality?.[selectedMetric] ?? row.equipment?.[selectedMetric] }));
    const definition = resolveMetric(selectedMetric);
    return { chart: { type: "bar", title: `设备${definition.label}排名`, categoryField: "machine_id", series: [{ field: "value", label: definition.label, unit: definition.unit }], sort: "descending" }, rows, returned: rows.length, metricDefinition: definition };
  }
  if (view !== "trend" || !trendHandlers[domain]) throw new DataToolError("INVALID_CHART_VIEW", "view must be trend, machine_ranking, maintenance_risk, or root_cause");
  const selectedMetric = metric ?? defaultTrendMetric[domain];
  const definition = resolveMetric(selectedMetric);
  if (definition.domain !== domain) throw new DataToolError("INVALID_METRIC_DOMAIN", `${selectedMetric} does not belong to ${domain}`);
  const result = trendHandlers[domain]({ dateFrom, dateTo, machineIds, lineIds, grain, limit: 500 });
  const field = trendFieldOverride[selectedMetric] ?? selectedMetric;
  const rows = result.rows.map((row) => ({ period: row.period, value: row[field] ?? null }));
  return { chart: { type: "line", title: `${definition.label}趋势`, categoryField: "period", series: [{ field: "value", label: definition.label, unit: definition.unit }], grain }, rows, returned: rows.length, metricDefinition: definition, dataNotes: result.dataNotes ?? [] };
}
