import { DataToolError } from "./database.mjs";

export const metricCatalog = {
  planned_qty: { domain: "production", label: "计划产量", definition: "所选范围内生产工单计划数量合计", formula: "SUM(planned_qty)", unit: "件", polarity: "context", sourceTables: ["production_orders"] },
  actual_qty: { domain: "production", label: "实际产量", definition: "所选范围内生产工单实际数量合计", formula: "SUM(actual_qty)", unit: "件", polarity: "high", sourceTables: ["production_orders"] },
  plan_completion_rate: { domain: "production", label: "计划完成率", definition: "实际产量相对于计划产量的加权完成程度", formula: "SUM(actual_qty) / SUM(planned_qty)", unit: "%", polarity: "high", sourceTables: ["production_orders"], caveat: "必须按总量加权。" },
  yield_rate: { domain: "production", label: "良品率", definition: "良品数量占实际产量的比例", formula: "SUM(good_qty) / SUM(actual_qty)", unit: "%", polarity: "high", sourceTables: ["production_orders"] },
  scrap_rate: { domain: "production", label: "报废率", definition: "报废数量占实际产量的比例", formula: "SUM(scrap_qty) / SUM(actual_qty)", unit: "%", polarity: "low", sourceTables: ["production_orders"] },
  weighted_cycle_time_min: { domain: "production", label: "加权循环时间", definition: "生产每件产品实际占用的平均运行时间", formula: "SUM(runtime_min) / SUM(actual_qty)", unit: "分钟/件", polarity: "low", sourceTables: ["production_orders"] },
  inspection_pass_rate: { domain: "quality", label: "检验通过率", definition: "结果为PASS的检验记录占比", formula: "pass_count / inspection_count", unit: "%", polarity: "high", sourceTables: ["quality_inspections"] },
  quality_fail_rate: { domain: "quality", label: "质量失败率", definition: "结果为FAIL的检验记录占比", formula: "fail_count / inspection_count", unit: "%", polarity: "low", sourceTables: ["quality_inspections"] },
  sample_defect_rate: { domain: "quality", label: "样本缺陷率", definition: "抽样检验中缺陷件数占样本数的比例", formula: "SUM(defect_count) / SUM(sample_size)", unit: "%", polarity: "low", sourceTables: ["quality_inspections"] },
  out_of_spec_rate: { domain: "quality", label: "超规格率", definition: "测量值超出规格上下限的检验记录占比", formula: "out_of_spec_count / inspection_count", unit: "%", polarity: "low", sourceTables: ["quality_inspections"] },
  availability: { domain: "equipment", label: "可用率", definition: "运行时间占运行时间与非计划停机时间之和的比例", formula: "runtime_min / (runtime_min + unplanned_downtime_min)", unit: "%", polarity: "high", sourceTables: ["production_orders", "downtime_events"], caveat: "当前数据没有完整计划生产日历。" },
  performance_rate: { domain: "equipment", label: "性能率", definition: "标准节拍产出时间相对于实际运行时间的比例", formula: "SUM(actual_qty × standard_cycle_min) / SUM(runtime_min)", unit: "%", polarity: "high", sourceTables: ["production_orders", "products"] },
  oee: { domain: "equipment", label: "OEE", definition: "设备综合效率的推导值", formula: "availability × performance_rate × quality_rate", unit: "%", polarity: "high", sourceTables: ["production_orders", "products", "downtime_events"], caveat: "缺少完整计划生产日历，因此属于透明推导指标。" },
  mtbf_hours: { domain: "equipment", label: "MTBF", definition: "平均故障间隔运行时间", formula: "runtime_hours / failure_count", unit: "小时", polarity: "high", sourceTables: ["production_orders", "downtime_events"] },
  mttr_min: { domain: "equipment", label: "MTTR", definition: "平均每次故障的修复时间", formula: "failure_downtime_min / failure_count", unit: "分钟", polarity: "low", sourceTables: ["downtime_events"] },
  unplanned_downtime_min: { domain: "equipment", label: "非计划停机", definition: "非计划停机事件时长合计", formula: "SUM(duration_min WHERE planned_flag = 0)", unit: "分钟", polarity: "low", sourceTables: ["downtime_events"] },
  electricity_kwh: { domain: "energy", label: "总耗电", definition: "电力读数合计", formula: "SUM(electricity_kwh)", unit: "kWh", polarity: "context", sourceTables: ["energy_readings"] },
  energy_intensity: { domain: "energy", label: "单位运行小时耗电", definition: "每个能源记录运行小时对应的耗电量", formula: "SUM(electricity_kwh) / SUM(runtime_hours)", unit: "kWh/运行小时", polarity: "low", sourceTables: ["energy_readings"] },
  kwh_per_good_unit: { domain: "energy", label: "单位良品耗电", definition: "每件良品对应的耗电量", formula: "SUM(electricity_kwh) / SUM(good_qty)", unit: "kWh/件", polarity: "low", sourceTables: ["energy_readings", "production_orders"] },
  peak_utilization: { domain: "energy", label: "峰值功率利用率", definition: "峰值需量相对于设备额定功率的比例", formula: "peak_demand_kw / rated_power_kw", unit: "%", polarity: "low", sourceTables: ["energy_readings", "machines"] },
  supplier_on_time_rate: { domain: "supplier", label: "供应商准时交付率", definition: "实际交期不超过合同交期的到货批次占比", formula: "on_time_receipts / receipt_count", unit: "%", polarity: "high", sourceTables: ["supplier_receipts", "suppliers"] },
  supplier_defect_rate: { domain: "supplier", label: "供应商来料缺陷率", definition: "来料缺陷数量占到货数量的比例", formula: "SUM(incoming_defect_qty) / SUM(received_qty)", unit: "%", polarity: "low", sourceTables: ["supplier_receipts"] },
  supplier_inspection_pass_rate: { domain: "supplier", label: "供应商来料检验通过率", definition: "来料检验结果为PASS的到货批次占比", formula: "pass_count / receipt_count", unit: "%", polarity: "high", sourceTables: ["supplier_receipts"] },
  cost_variance_rate: { domain: "supplier", label: "采购成本偏差率", definition: "实际采购成本相对于物料标准成本的加权偏差", formula: "(actual_spend - standard_spend) / standard_spend", unit: "%", polarity: "low", sourceTables: ["supplier_receipts", "materials"] },
  inferred_inventory_balance: { domain: "inventory", label: "推导库存余额", definition: "库存流水净变动推导的期末数量", formula: "SUM(receipt + return + adjustment - issue)", unit: "物料计量单位", polarity: "context", sourceTables: ["inventory_transactions"], caveat: "没有期初库存快照，因此是流水推导余额。" },
  inventory_days_of_supply: { domain: "inventory", label: "库存覆盖天数", definition: "当前推导库存可覆盖历史平均日领料需求的天数", formula: "inferred_balance_qty / average_daily_issue_qty", unit: "天", polarity: "context", sourceTables: ["inventory_transactions"], caveat: "只对观察期内存在领料记录的物料计算。" },
  inventory_status: { domain: "inventory", label: "库存状态", definition: "结合推导库存余额、库存覆盖天数、是否存在消耗和物料类型形成的库存风险分类", formula: "规则分类(inferred_balance_qty, inventory_days_of_supply, consumption_status, item_type)", unit: "分类", polarity: "context", sourceTables: ["inventory_transactions", "materials", "products"], caveat: "没有期初库存快照，状态判断基于观察期流水和历史消耗。" },
};

const aliases = new Map([
  ["良品率", "yield_rate"], ["合格率", "yield_rate"], ["报废率", "scrap_rate"], ["计划完成率", "plan_completion_rate"],
  ["completion_rate", "plan_completion_rate"], ["completion rate", "plan_completion_rate"], ["plan completion rate", "plan_completion_rate"],
  ["检验通过率", "inspection_pass_rate"], ["质量失败率", "quality_fail_rate"], ["样本缺陷率", "sample_defect_rate"],
  ["可用率", "availability"], ["综合设备效率", "oee"], ["mtbf", "mtbf_hours"], ["mttr", "mttr_min"],
  ["能耗强度", "energy_intensity"], ["单位良品耗电", "kwh_per_good_unit"], ["单位合格品能耗", "kwh_per_good_unit"], ["单位产量能耗", "kwh_per_good_unit"],
  ["energy_per_unit", "kwh_per_good_unit"], ["energy per unit", "kwh_per_good_unit"], ["energy per good unit", "kwh_per_good_unit"],
  ["准时交付率", "supplier_on_time_rate"], ["supplier on-time delivery rate", "supplier_on_time_rate"], ["supplier on time delivery rate", "supplier_on_time_rate"], ["on_time_delivery_rate", "supplier_on_time_rate"],
  ["来料检验合格率", "supplier_inspection_pass_rate"], ["来料检验通过率", "supplier_inspection_pass_rate"], ["incoming inspection pass rate", "supplier_inspection_pass_rate"], ["supplier inspection pass rate", "supplier_inspection_pass_rate"],
  ["库存覆盖天数", "inventory_days_of_supply"], ["库存余额", "inferred_inventory_balance"], ["库存状态", "inventory_status"], ["inventory stock status", "inventory_status"], ["stock status", "inventory_status"],
]);

export function resolveMetric(metric) {
  const normalized = String(metric ?? "").trim().toLowerCase();
  const key = Object.hasOwn(metricCatalog, normalized) ? normalized : aliases.get(normalized);
  if (!key) throw new DataToolError("UNKNOWN_METRIC", `Unsupported metric: ${metric}`, { availableMetrics: Object.keys(metricCatalog) });
  return { metric: key, ...metricCatalog[key] };
}

export function listMetricDefinitions({ domain, search, limit = 100 } = {}) {
  const validDomains = new Set(["production", "quality", "equipment", "energy", "supplier", "inventory"]);
  if (domain && !validDomains.has(domain)) throw new DataToolError("INVALID_DOMAIN", `Unsupported metric domain: ${domain}`);
  const needle = String(search ?? "").trim().toLowerCase();
  const rows = Object.entries(metricCatalog).map(([metric, definition]) => ({ metric, ...definition }))
    .filter((row) => !domain || row.domain === domain)
    .filter((row) => !needle || `${row.metric} ${row.label} ${row.definition} ${row.formula}`.toLowerCase().includes(needle))
    .slice(0, Math.min(Math.max(Number(limit) || 100, 1), 200));
  return { domain: domain ?? null, search: search ?? null, rows, returned: rows.length, totalMetrics: Object.keys(metricCatalog).length };
}
