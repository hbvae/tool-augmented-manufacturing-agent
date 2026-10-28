import { DataToolError, runReadOnlySql } from "./database.mjs";
import { getProductionSummary, getProductionTrend } from "./production.mjs";
import { analyzeQualityBreakdown, getQualitySummary, getQualityTrend } from "./quality.mjs";
import { analyzeEquipmentBreakdown, getEquipmentSummary, getEquipmentTrend } from "./equipment.mjs";
import { analyzeEnergyBreakdown, getEnergySummary, getEnergyTrend } from "./energy.mjs";
import { analyzeSupplierBreakdown, getSupplierSummary, getSupplierTrend, scoreSuppliers } from "./supplier.mjs";
import { analyzeInventoryStatus, findInventoryExceptions, getInventorySummary, getInventoryTrend } from "./inventory.mjs";
import { analyzeMachine360, analyzeProduct360, findCrossDomainRisks, getCrossDomainTrend, getManufacturingOverview, traceWorkOrder } from "./cross_domain.mjs";
import { detectRuleAnomalies, detectStatisticalAnomalies, detectTrendAnomalies, getAnomalyOverview } from "./anomaly.mjs";
import { metricCatalog, resolveMetric } from "./semantic.mjs";
import { predictMaintenanceRisk, rankRootCauseCandidates } from "./advanced_analysis.mjs";

const METRICS = {
  scrap_rate: { label: "报废率", formula: "SUM(scrap_qty) / SUM(actual_qty)", source: "production_orders", caveat: "必须按总量加权，不能直接平均工单报废率。" },
  yield_rate: { label: "良品率", formula: "SUM(good_qty) / SUM(actual_qty)", source: "production_orders", caveat: "按实际产量加权。" },
  plan_completion_rate: { label: "计划完成率", formula: "SUM(actual_qty) / SUM(planned_qty)", source: "production_orders", caveat: "按计划数量加权。" },
  quality_fail_rate: { label: "质量失败率", formula: "fail_count / inspection_count", source: "quality_inspections", caveat: "这是检验记录失败率，不等同于样本缺陷率。" },
  sample_defect_rate: { label: "样本缺陷率", formula: "SUM(defect_count) / SUM(sample_size)", source: "quality_inspections", caveat: "使用抽样数量加权。" },
  oee: { label: "OEE", formula: "availability × performance × quality_rate", source: "production_orders + downtime_events", caveat: "当前数据没有计划生产日历，因此为数据推导 OEE。" },
  availability: { label: "可用率", formula: "runtime_min / (runtime_min + unplanned_downtime_min)", source: "production_orders + downtime_events", caveat: "使用运行时间与非计划停机推导。" },
  mtbf: { label: "MTBF", formula: "runtime_hours / failure_count", source: "production_orders + downtime_events", caveat: "故障定义为停机类别 FAILURE。" },
  mttr: { label: "MTTR", formula: "failure_downtime_min / failure_count", source: "downtime_events", caveat: "故障定义为停机类别 FAILURE。" },
  energy_intensity: { label: "单位运行小时耗电", formula: "SUM(electricity_kwh) / SUM(runtime_hours)", source: "energy_readings", caveat: "能源数据粒度为每日设备。" },
  supplier_on_time_rate: { label: "供应商准时交付率", formula: "on_time_receipts / receipt_count", source: "supplier_receipts + suppliers", caveat: "实际交期不超过合同交期视为准时。" },
  inventory_days_of_supply: { label: "库存覆盖天数", formula: "inferred_balance_qty / average_daily_issue_qty", source: "inventory_transactions", caveat: "只对存在 ISSUE 领料记录的原材料计算，余额为流水推导值。" },
};

const METRIC_ALIASES = [
  [/报废率|scrap/i, "scrap_rate"], [/良品率|合格率|yield/i, "yield_rate"], [/计划完成率|完成率/i, "plan_completion_rate"],
  [/质量失败率|检验失败率/i, "quality_fail_rate"], [/缺陷率|不良率/i, "sample_defect_rate"], [/oee|综合设备效率/i, "oee"],
  [/可用率|availability/i, "availability"], [/mtbf|平均故障间隔/i, "mtbf"], [/mttr|平均修复/i, "mttr"],
  [/单位.*耗电|能耗强度|kwh.*小时/i, "energy_intensity"], [/准时.*率|准交率/i, "supplier_on_time_rate"], [/覆盖天数|库存天数/i, "inventory_days_of_supply"],
];

function latestDataDate() {
  const sql = `SELECT MAX(value) AS latest_date FROM (
    SELECT MAX(substr(actual_start,1,10)) AS value FROM production_orders
    UNION ALL SELECT MAX(substr(inspection_time,1,10)) FROM quality_inspections
    UNION ALL SELECT MAX(reading_date) FROM energy_readings
    UNION ALL SELECT MAX(receipt_date) FROM supplier_receipts
    UNION ALL SELECT MAX(substr(transaction_time,1,10)) FROM inventory_transactions
  )`;
  return runReadOnlySql({ sql, limit: 1 }).rows[0]?.latest_date;
}

function nextMonth(year, month) {
  const date = new Date(Date.UTC(year, month, 1));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function parseDateRange(question) {
  const isoDays = [...question.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)].map((match) => match[0]);
  if (isoDays.length >= 2) return { dateFrom: isoDays[0], dateTo: isoDays[1], source: "explicit_day_range" };
  if (isoDays.length === 1) return { dateFrom: isoDays[0], dateTo: isoDays[0], source: "explicit_day" };
  const chineseMonth = question.match(/(20\d{2})年\s*(\d{1,2})月/);
  const isoMonth = question.match(/\b(20\d{2})-(\d{2})(?!-\d{2})\b/);
  const monthMatch = chineseMonth ?? isoMonth;
  if (monthMatch) {
    const year = Number(monthMatch[1]); const month = Number(monthMatch[2]);
    if (month >= 1 && month <= 12) return { dateFrom: `${year}-${String(month).padStart(2, "0")}-01`, dateTo: nextMonth(year, month), source: "explicit_month" };
  }
  const recent = question.match(/最近\s*(\d+)\s*天|last\s+(\d+)\s+days?/i);
  if (recent) {
    const days = Number(recent[1] ?? recent[2]);
    if (days > 0 && days <= 3650) {
      const latest = latestDataDate(); const start = new Date(`${latest}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - days + 1);
      return { dateFrom: start.toISOString().slice(0, 10), dateTo: latest, source: "relative_days" };
    }
  }
  return {};
}

function collectIds(question, pattern) { return [...new Set([...question.toUpperCase().matchAll(pattern)].map((match) => match[0]))]; }
function detectMetric(question) { return METRIC_ALIASES.find(([pattern]) => pattern.test(question))?.[1] ?? null; }

function detectDomain(question, entities) {
  if (entities.orderIds.length) return "work_order";
  if (/供应商|采购|到货|来料|supplier/i.test(question)) return "supplier";
  if (/库存|仓库|入库|出库|领料|积压|stock|inventory/i.test(question)) return "inventory";
  if (/能耗|耗电|电力|压缩空气|冷却液|峰值需量|energy/i.test(question)) return "energy";
  if (/质量|检验|缺陷|不良|cpk|quality/i.test(question)) return "quality";
  if (/停机|故障|设备|机台|oee|mtbf|mttr|machine/i.test(question) || entities.machineIds.length) return "equipment";
  if (/产品|品种|product/i.test(question) || entities.productIds.length) return "product";
  if (/生产|产量|报废|计划|工单|节拍|production/i.test(question)) return "production";
  return "overview";
}

function detectIntent(question) {
  if (/怎么算|如何计算|口径|定义|解释.*指标|what is/i.test(question)) return "explain_metric";
  if (/预测性维护|维护风险|保养风险|预测.*故障|predictive maintenance/i.test(question)) return "predictive_maintenance";
  if (/根因|原因分析|为什么|root cause/i.test(question)) return "root_cause";
  if (/统计异常|离群|z.?score|iqr|mad/i.test(question)) return "statistical_anomaly";
  if (/趋势异常|突变|拐点|斜率异常/i.test(question)) return "trend_anomaly";
  if (/异常|风险|问题|预警|积压|短缺/i.test(question)) return "rule_anomaly";
  if (/趋势|变化|走势|按月|按周|按日|trend/i.test(question)) return "trend";
  if (/最高|最低|最多|最少|最好|最差|排名|排行|前\s*\d+|top\s*\d+/i.test(question)) return "ranking";
  if (/对比|比较|compare/i.test(question)) return "comparison";
  return "summary";
}

function detectGrain(question) {
  if (/按日|每天|每日|daily/i.test(question)) return "day";
  if (/按周|每周|weekly/i.test(question)) return "week";
  return "month";
}

function detectTopK(question) {
  const match = question.match(/前\s*(\d+)|top\s*(\d+)/i);
  return match ? Math.min(Math.max(Number(match[1] ?? match[2]), 1), 100) : 10;
}

function metricForAnomaly(metric, domain) {
  const mapping = {
    scrap_rate: "production.scrap_rate", plan_completion_rate: "production.plan_completion_rate",
    quality_fail_rate: "quality.fail_rate", sample_defect_rate: "quality.sample_defect_rate",
    oee: "equipment.oee", energy_intensity: "energy.kwh_per_runtime_hour",
    supplier_on_time_rate: "supplier.on_time_rate",
  };
  if (mapping[metric]) return mapping[metric];
  if (domain === "quality") return "quality.fail_rate";
  if (domain === "energy") return "energy.kwh_per_runtime_hour";
  if (domain === "supplier") return "supplier.on_time_rate";
  if (domain === "inventory") return "inventory.net_movement_qty";
  if (domain === "production") return "production.scrap_rate";
  return "equipment.unplanned_downtime_min";
}

function chooseRoute(parsed) {
  const { domain, intent, entities, grain, metric, topK, dateRange } = parsed;
  const dateArgs = { dateFrom: dateRange.dateFrom, dateTo: dateRange.dateTo };
  const common = { ...dateArgs, machineIds: entities.machineIds, lineIds: entities.lineIds };
  // Anomaly detection needs the full baseline. The requested month is retained in
  // the interpretation, but must not truncate the historical comparison window.
  const anomalyCommon = { machineIds: entities.machineIds, lineIds: entities.lineIds };
  if (domain === "work_order") return { tool: "trace_work_order", args: { orderId: entities.orderIds[0] } };
  if (intent === "explain_metric") return { tool: "explain_manufacturing_metric", args: { metric: metric ?? "oee" } };
  if (intent === "predictive_maintenance") return { tool: "predict_maintenance_risk", args: { ...dateArgs, machineIds: entities.machineIds, lineIds: entities.lineIds, horizonDays: 30, limit: topK } };
  if (intent === "root_cause") return { tool: "rank_root_cause_candidates", args: { machineId: entities.machineIds[0], ...dateArgs, limit: topK } };
  if (intent === "statistical_anomaly") return { tool: "detect_statistical_anomalies", args: { ...anomalyCommon, metric: metricForAnomaly(metric, domain), grain: grain === "month" ? "day" : grain, method: "mad", minimumPoints: 8 } };
  if (intent === "trend_anomaly") return { tool: "detect_trend_anomalies", args: { ...anomalyCommon, metric: metricForAnomaly(metric, domain), grain, method: "change_rate", window: grain === "month" ? 2 : 7, minimumPoints: grain === "month" ? 5 : 12 } };
  if (intent === "rule_anomaly") {
    if (domain === "inventory") return { tool: "find_inventory_exceptions", args: { itemTypes: ["RAW_MATERIAL"], asOfDate: dateRange.dateTo, limit: topK } };
    const domainMap = { production: "production", quality: "quality", equipment: "equipment", energy: "energy", supplier: "supplier" };
    return { tool: "detect_rule_anomalies", args: { ...common, ...(domainMap[domain] ? { domains: [domainMap[domain]] } : {}), limitPerDomain: topK } };
  }
  if (intent === "trend") {
    const toolMap = { production: "get_production_trend", quality: "get_quality_trend", equipment: "get_equipment_trend", energy: "get_energy_trend", supplier: "get_supplier_trend", inventory: "get_inventory_trend" };
    return { tool: toolMap[domain] ?? "get_cross_domain_trend", args: { ...common, grain } };
  }
  if (domain === "supplier" && /评分|综合表现|score/i.test(parsed.question)) return { tool: "score_suppliers", args: { ...dateArgs, limit: topK } };
  if (domain === "supplier") return { tool: intent === "ranking" || intent === "comparison" ? "analyze_supplier_breakdown" : "get_supplier_summary", args: intent === "ranking" || intent === "comparison" ? { ...dateArgs, dimension: "supplier", orderBy: metric === "supplier_on_time_rate" ? "on_time_rate" : "defect_rate", direction: /最低|最少/.test(parsed.question) ? "asc" : "desc", limit: topK } : dateArgs };
  if (domain === "inventory") return { tool: "analyze_inventory_status", args: { asOfDate: dateRange.dateTo, itemIds: entities.materialIds, itemTypes: entities.materialIds.length ? ["RAW_MATERIAL"] : [], lookbackDays: 90 } };
  if (domain === "energy") return { tool: intent === "ranking" || intent === "comparison" ? "analyze_energy_breakdown" : "get_energy_summary", args: intent === "ranking" || intent === "comparison" ? { ...common, dimension: "machine", orderBy: "kwh_per_runtime_hour", direction: /最低|最少/.test(parsed.question) ? "asc" : "desc", limit: topK } : common };
  if (domain === "quality" && (intent === "ranking" || intent === "comparison")) return { tool: "analyze_quality_breakdown", args: { ...common, dimension: "machine", orderBy: "fail_rate", direction: /最低|最少|最好/.test(parsed.question) ? "asc" : "desc", limit: topK } };
  if (domain === "quality") return { tool: "get_quality_summary", args: common };
  if (domain === "product") return { tool: "analyze_product_360", args: { ...common, productIds: entities.productIds, sortBy: metric === "scrap_rate" ? "scrap_rate" : "actual_qty", direction: /最低|最少/.test(parsed.question) ? "asc" : "desc", limit: topK } };
  if (domain === "equipment" || (domain === "production" && (intent === "ranking" || entities.machineIds.length))) {
    const sortMap = { scrap_rate: "scrap_rate", quality_fail_rate: "quality_fail_rate", oee: "oee", availability: "availability", energy_intensity: "kwh_per_runtime_hour" };
    const sortBy = sortMap[metric] ?? (/停机|故障/.test(parsed.question) ? "unplanned_downtime_min" : "risk_score");
    return { tool: "analyze_machine_360", args: { ...common, sortBy, direction: /最低|最少|最好/.test(parsed.question) ? "asc" : "desc", limit: topK } };
  }
  if (domain === "production") return { tool: "get_production_summary", args: common };
  return { tool: "get_manufacturing_overview", args: common };
}

export function parseAnalysisQuestion({ question }) {
  if (typeof question !== "string" || !question.trim()) throw new DataToolError("INVALID_QUESTION", "question must be a non-empty string");
  const text = question.trim();
  const entities = {
    orderIds: collectIds(text, /\bWO\d{5}\b/g),
    machineIds: collectIds(text, /\bM\d{2}\b/g),
    lineIds: collectIds(text, /\bL\d+\b/g),
    productIds: collectIds(text, /\bP\d{3}\b/g),
    supplierIds: collectIds(text, /\bS\d{3}\b/g),
    materialIds: collectIds(text, /\bRM\d{3}\b/g),
  };
  const metric = detectMetric(text);
  const domain = detectDomain(text, entities);
  const intent = detectIntent(text);
  const parsed = { question: text, language: /[\u4e00-\u9fff]/.test(text) ? "zh" : "en", domain, intent, metric, entities, dateRange: parseDateRange(text), grain: detectGrain(text), topK: detectTopK(text) };
  const route = chooseRoute(parsed);
  const recognizedSignals = (domain !== "overview" ? 1 : 0) + (intent !== "summary" ? 1 : 0) + (metric ? 1 : 0) + (Object.values(entities).some((ids) => ids.length) ? 1 : 0) + (Object.keys(parsed.dateRange).length ? 1 : 0);
  return { ...parsed, suggestedTool: route.tool, suggestedArguments: route.args, confidence: Number(Math.min(0.98, 0.5 + recognizedSignals * 0.1).toFixed(2)), warnings: domain === "overview" && intent === "summary" ? ["未识别到具体领域或指标，默认返回制造全局概览。"] : [] };
}

export function explainManufacturingMetric({ metric }) {
  if (typeof metric !== "string" || !metric.trim()) throw new DataToolError("INVALID_METRIC", "metric must be a non-empty string");
  const legacyKey = METRICS[metric] ? metric : detectMetric(metric);
  const definition = resolveMetric(legacyKey ?? metric);
  return { ...definition, explanation: `${definition.label}：${definition.definition}。计算公式：${definition.formula}。单位：${definition.unit}。${definition.caveat ?? ""}`.trim() };
}

function executeRoute(tool, args) {
  const handlers = {
    get_manufacturing_overview: getManufacturingOverview,
    analyze_machine_360: analyzeMachine360,
    analyze_product_360: analyzeProduct360,
    get_cross_domain_trend: getCrossDomainTrend,
    trace_work_order: traceWorkOrder,
    find_cross_domain_risks: findCrossDomainRisks,
    get_production_summary: getProductionSummary,
    get_production_trend: getProductionTrend,
    get_quality_summary: getQualitySummary,
    analyze_quality_breakdown: analyzeQualityBreakdown,
    get_quality_trend: getQualityTrend,
    get_equipment_summary: getEquipmentSummary,
    analyze_equipment_breakdown: analyzeEquipmentBreakdown,
    get_equipment_trend: getEquipmentTrend,
    get_energy_summary: getEnergySummary,
    analyze_energy_breakdown: analyzeEnergyBreakdown,
    get_energy_trend: getEnergyTrend,
    get_supplier_summary: getSupplierSummary,
    analyze_supplier_breakdown: analyzeSupplierBreakdown,
    score_suppliers: scoreSuppliers,
    get_supplier_trend: getSupplierTrend,
    get_inventory_summary: getInventorySummary,
    analyze_inventory_status: analyzeInventoryStatus,
    find_inventory_exceptions: findInventoryExceptions,
    get_inventory_trend: getInventoryTrend,
    detect_rule_anomalies: detectRuleAnomalies,
    detect_statistical_anomalies: detectStatisticalAnomalies,
    detect_trend_anomalies: detectTrendAnomalies,
    get_anomaly_overview: getAnomalyOverview,
    explain_manufacturing_metric: explainManufacturingMetric,
    predict_maintenance_risk: predictMaintenanceRisk,
    rank_root_cause_candidates: rankRootCauseCandidates,
  };
  if (!handlers[tool]) throw new DataToolError("UNSUPPORTED_ROUTE", `Unsupported natural-language route: ${tool}`);
  return handlers[tool](args);
}

function pct(value) { return value == null ? "暂无" : `${(value * 100).toFixed(2)}%`; }
function num(value, digits = 2) { return value == null ? "暂无" : Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits }); }

function buildAnswer(tool, data) {
  if (tool === "get_manufacturing_overview") return `整体生产数量 ${num(data.highlights.actual_qty, 0)}，良品率 ${pct(data.highlights.yield_rate)}，质量检验通过率 ${pct(data.highlights.quality_pass_rate)}，推导 OEE ${pct(data.highlights.equipment_oee)}，总耗电 ${num(data.highlights.electricity_kwh)} kWh；当前有 ${data.highlights.cross_domain_risk_machine_count} 台设备触发至少一项跨域风险。`;
  if (tool === "analyze_machine_360") {
    const row = data.rows[0]; if (!row) return "所选范围内没有设备数据。";
    return `${row.machine_id} 排在首位：报废率 ${pct(row.production?.scrap_rate)}，质量失败率 ${pct(row.quality?.fail_rate)}，非计划停机 ${num(row.equipment?.unplanned_downtime_min, 0)} 分钟，OEE ${pct(row.equipment?.oee)}，单位运行小时耗电 ${num(row.energy?.kwh_per_runtime_hour, 3)} kWh；风险原因：${row.risk_reasons || "未触发默认风险规则"}。`;
  }
  if (tool === "analyze_product_360") {
    const row = data.rows[0]; if (!row) return "所选范围内没有产品数据。";
    return `${row.product_id}（${row.product_name}）排在首位：实际产量 ${num(row.production?.actual_qty, 0)}，报废率 ${pct(row.production?.scrap_rate)}，质量失败率 ${pct(row.quality?.fail_rate)}，推导成品余额 ${num(row.inventory?.inferred_balance_qty)}。`;
  }
  if (tool === "trace_work_order") return `工单 ${data.order.order_id} 使用设备 ${data.order.machine_id} 生产 ${data.order.product_name}；关联 ${data.summaries.quality.inspection_count} 次检验、${data.summaries.downtime.event_count} 次停机和 ${data.summaries.inventory.transaction_count} 条库存事务。样本缺陷率 ${pct(data.summaries.quality.sample_defect_rate)}，关联停机 ${num(data.summaries.downtime.duration_min, 0)} 分钟。`;
  if (tool === "detect_rule_anomalies") return `共发现 ${data.total} 条规则异常。各领域数量：${Object.entries(data.counts).map(([domain, count]) => `${domain} ${count} 条`).join("，")}。`;
  if (tool === "detect_statistical_anomalies" || tool === "detect_trend_anomalies") {
    const first = data.anomalies?.[0];
    return first ? `${data.metric} 使用 ${data.method} 共识别 ${data.anomalyCount} 个异常，最显著周期为 ${first.period}，观测值 ${num(first.value, 4)}，异常分数 ${num(first.anomaly_score, 4)}。` : `${data.metric} 使用 ${data.method} 未发现超过当前阈值的异常。`;
  }
  if (tool.includes("trend")) {
    const rows = data.rows ?? []; const last = rows.at(-1);
    return rows.length ? `共返回 ${rows.length} 个时间周期，最新周期为 ${last.period}。详细指标已保存在结构化结果中。` : "所选范围内没有趋势数据。";
  }
  if (tool === "find_inventory_exceptions") return `共发现 ${data.returned} 项库存异常；${data.rows.slice(0, 3).map((row) => `${row.item_id}: ${row.exception_reasons}`).join("；")}。`;
  if (tool === "analyze_inventory_status") return `共分析 ${data.returned} 个库存项目，其中 ${data.rows.filter((row) => row.coverage_status === "EXCESS_COVERAGE").length} 项覆盖过高，${data.rows.filter((row) => row.coverage_status === "NO_CONSUMPTION").length} 项在观察期内无领料。`;
  if (tool === "analyze_supplier_breakdown") { const row = data.rows[0]; return row ? `${row.supplier_id}（${row.supplier_name}）排在首位：来料缺陷率 ${pct(row.defect_rate)}，检验通过率 ${pct(row.pass_rate)}，准时交付率 ${pct(row.on_time_rate)}。` : "所选范围内没有供应商数据。"; }
  if (tool === "score_suppliers") { const row = data.rows[0]; return row ? `${row.supplier_id}（${row.supplier_name}）综合评分 ${num(row.total_score)}，评级 ${row.grade}；交付 ${num(row.delivery_score)}、质量 ${num(row.quality_score)}、成本 ${num(row.cost_score)}、稳定性 ${num(row.stability_score)}。` : "所选范围内没有供应商评分数据。"; }
  if (tool === "predict_maintenance_risk") { const row = data.rows[0]; return row ? `${row.machine_id} 的维护风险最高，风险分数 ${num(row.risk_score)}，等级 ${row.risk_level}，建议在 ${row.recommended_action_by} 前处理；主要驱动因素：${row.top_drivers.join("、")}。` : "所选范围内没有足够的设备维护风险数据。"; }
  if (tool === "rank_root_cause_candidates") { const row = data.rows[0]; return row ? `${data.machineId} 的首要排查候选是 ${row.candidate}（${row.domain}），证据分数 ${num(row.candidate_score)}。该排序用于缩小排查范围，不代表已经证明因果关系。` : "所选范围内没有足够的根因候选证据。"; }
  if (tool === "analyze_energy_breakdown") { const row = data.rows[0]; return row ? `${row.machine_id} 单位运行小时耗电 ${num(row.kwh_per_runtime_hour, 3)} kWh，单位良品耗电 ${num(row.kwh_per_good_unit, 4)} kWh。` : "所选范围内没有能耗数据。"; }
  if (tool === "analyze_quality_breakdown") { const row = data.rows[0]; return row ? `${row.machine_id} 质量失败率 ${pct(row.fail_rate)}，样本缺陷率 ${pct(row.sample_defect_rate)}。` : "所选范围内没有质量数据。"; }
  if (tool === "get_production_summary") return `实际产量 ${num(data.metrics.actual_qty, 0)}，计划完成率 ${pct(data.metrics.plan_completion_rate)}，良品率 ${pct(data.metrics.yield_rate)}，报废率 ${pct(data.metrics.scrap_rate)}。`;
  if (tool === "get_quality_summary") return `共 ${num(data.metrics.inspection_count, 0)} 次检验，检验通过率 ${pct(data.metrics.pass_rate)}，样本缺陷率 ${pct(data.metrics.sample_defect_rate)}。`;
  if (tool === "get_equipment_summary") return `设备运行 ${num(data.metrics.runtime_hours)} 小时，非计划停机 ${num(data.metrics.unplanned_downtime_min, 0)} 分钟，可用率 ${pct(data.metrics.availability)}，推导 OEE ${pct(data.metrics.oee)}。`;
  if (tool === "get_energy_summary") return `总耗电 ${num(data.metrics.electricity_kwh)} kWh，单位运行小时耗电 ${num(data.metrics.kwh_per_runtime_hour, 3)} kWh，停机耗电 ${num(data.metrics.idle_electricity_kwh)} kWh。`;
  if (tool === "get_supplier_summary") return `供应商到货 ${num(data.metrics.receipt_count, 0)} 批，准时交付率 ${pct(data.metrics.on_time_rate)}，来料缺陷率 ${pct(data.metrics.defect_rate)}，成本偏差率 ${pct(data.metrics.cost_variance_rate)}。`;
  if (tool === "explain_manufacturing_metric") return data.explanation;
  const metrics = data.metrics ?? data.movementMetrics;
  if (metrics) return `已完成 ${tool} 分析，核心指标和口径已返回结构化结果。`;
  return `已完成 ${tool} 分析，详细证据已返回结构化结果。`;
}

function followUps(parsed) {
  const suggestions = {
    overview: ["哪些设备的综合风险最高？", "最近六个月各领域趋势如何？"],
    equipment: ["这台设备的停机原因是什么？", "它的质量和能耗是否也异常？"],
    quality: ["质量失败率最高的设备是哪台？", "异常是否集中在某个月？"],
    energy: ["单位运行小时耗电最高的设备是哪台？", "是否存在停机待机耗电？"],
    supplier: ["哪个供应商综合评分最低？", "来料失败集中在哪些批次？"],
    inventory: ["哪些原材料覆盖天数超过180天？", "哪些物料最近90天没有领料？"],
    production: ["报废率最高的设备是哪台？", "生产异常集中在哪个月？"],
    product: ["该产品质量失败率是多少？", "该产品当前推导库存余额是多少？"],
    work_order: ["该工单有哪些检验失败记录？", "该工单关联了哪些停机事件？"],
  };
  return suggestions[parsed.domain] ?? suggestions.overview;
}

export function askManufacturingQuestion({ question, includeData = true }) {
  const parsed = parseAnalysisQuestion({ question });
  let data = executeRoute(parsed.suggestedTool, parsed.suggestedArguments);
  if (parsed.suggestedTool === "score_suppliers" && /最低|最差|末位/.test(parsed.question)) data = { ...data, rows: [...data.rows].reverse() };
  return {
    question: parsed.question,
    answer: buildAnswer(parsed.suggestedTool, data),
    interpretation: parsed,
    execution: { tool: parsed.suggestedTool, arguments: parsed.suggestedArguments },
    evidence: includeData ? data : undefined,
    followUpQuestions: followUps(parsed),
    caveat: "回答由确定性语义路由和已验证分析工具生成；请结合 evidence、执行参数和数据口径核验。",
  };
}

export function generateNaturalLanguageReport({ reportType = "executive", dateFrom, dateTo } = {}) {
  if (!new Set(["executive", "operations", "quality", "risk"]).has(reportType)) throw new DataToolError("INVALID_REPORT_TYPE", "reportType must be executive, operations, quality, or risk");
  const scope = { dateFrom, dateTo };
  const overview = getManufacturingOverview(scope);
  const risks = findCrossDomainRisks({ ...scope, minimumRiskScore: 1, limit: 8 });
  const topRisk = risks.rows[0];
  const sections = [
    `# 制造分析报告`,
    `分析范围：${dateFrom ?? "数据起点"} 至 ${dateTo ?? "数据终点"}`,
    `## 核心指标`,
    `实际产量 ${num(overview.highlights.actual_qty, 0)}，良品率 ${pct(overview.highlights.yield_rate)}，质量通过率 ${pct(overview.highlights.quality_pass_rate)}，推导 OEE ${pct(overview.highlights.equipment_oee)}，总耗电 ${num(overview.highlights.electricity_kwh)} kWh。`,
    `供应商准时交付率 ${pct(overview.highlights.supplier_on_time_rate)}，供应商来料缺陷率 ${pct(overview.highlights.supplier_defect_rate)}，推导库存价值 ${num(overview.highlights.inferred_inventory_value_cny)} 元。`,
    `## 风险提示`,
    topRisk ? `${topRisk.machine_id} 综合风险最高，触发 ${topRisk.risk_score} 项：${topRisk.risk_reasons}。` : "没有设备触发默认跨域风险阈值。",
  ];
  if (reportType === "quality") sections.push("## 质量关注", `当前总体质量检验通过率为 ${pct(overview.highlights.quality_pass_rate)}。建议进一步查看质量失败率最高的设备及失败检验明细。`);
  if (reportType === "operations") sections.push("## 运营关注", `当前推导设备 OEE 为 ${pct(overview.highlights.equipment_oee)}。建议结合非计划停机、报废和能耗强度进行设备分层。`);
  if (reportType === "risk") {
    const anomaly = getAnomalyOverview({ ...scope, limitPerDomain: 5 });
    sections.push("## 异常检测", `规则异常 ${anomaly.counts.rule} 条，统计异常 ${anomaly.counts.statistical} 个，趋势异常 ${anomaly.counts.trend} 个。`);
  }
  sections.push("## 口径说明", "OEE、库存余额和库存周转均包含数据推导口径；异常与风险用于筛查，不表示因果关系。详细结构化证据随报告一并返回。");
  return { reportType, scope, report: sections.join("\n\n"), evidence: { overview, risks: risks.rows }, generatedBy: "deterministic_natural_language_layer" };
}

export const manufacturingMetricCatalog = metricCatalog;
