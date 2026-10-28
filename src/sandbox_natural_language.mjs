import { DataToolError, describeTable } from "./database.mjs";
import { parseAnalysisQuestion } from "./natural_language.mjs";
import { runSandboxAnalysisWorkflow } from "./sandbox_workflow.mjs";

const DOMAIN_CONFIG = {
  production: {
    label: "生产", table: "production_orders", dateColumn: "actual_start", idColumn: "order_id", defaultGroup: "machine_id",
    defaultMetrics: [["actual_qty", "sum", "total_actual"], ["scrap_qty", "sum", "total_scrap"]],
    metrics: [
      [/计划.*(数量|产量)|planned/i, "planned_qty", "sum", "total_planned"],
      [/良品|合格(?:品|数量)?|good/i, "good_qty", "sum", "total_good"],
      [/报废|废品|scrap/i, "scrap_qty", "sum", "total_scrap"],
      [/运行时间|runtime/i, "runtime_min", "sum", "total_runtime_min"],
      [/节拍|周期|cycle/i, "cycle_time_min", "mean", "avg_cycle_time_min"],
      [/实际产量|产量|产出|actual/i, "actual_qty", "sum", "total_actual"],
    ],
  },
  quality: {
    label: "质量", table: "quality_inspections", dateColumn: "inspection_time", idColumn: "inspection_id", defaultGroup: "inspection_stage",
    defaultMetrics: [["sample_size", "sum", "total_sample"], ["defect_count", "sum", "total_defects"]],
    metrics: [
      [/样本|抽检|sample/i, "sample_size", "sum", "total_sample"],
      [/缺陷|不良|defect/i, "defect_count", "sum", "total_defects"],
      [/测量值|尺寸|measured/i, "measured_value_mm", "mean", "avg_measured_value_mm"],
    ],
  },
  equipment: {
    label: "设备停机", table: "downtime_events", dateColumn: "start_time", idColumn: "downtime_id", defaultGroup: "machine_id",
    defaultMetrics: [["duration_min", "sum", "total_downtime_min"], ["downtime_id", "count", "event_count"]],
    metrics: [
      [/停机时长|停机时间|时长|duration/i, "duration_min", "sum", "total_downtime_min"],
      [/次数|频次|事件数|count/i, "downtime_id", "count", "event_count"],
    ],
  },
  energy: {
    label: "能耗", table: "energy_readings", dateColumn: "reading_date", idColumn: "reading_id", defaultGroup: "machine_id",
    defaultMetrics: [["electricity_kwh", "sum", "total_electricity_kwh"]],
    metrics: [
      [/耗电|电量|electric/i, "electricity_kwh", "sum", "total_electricity_kwh"],
      [/压缩空气|air/i, "compressed_air_m3", "sum", "total_compressed_air_m3"],
      [/冷却液|coolant/i, "coolant_liter", "sum", "total_coolant_liter"],
      [/峰值|需量|peak/i, "peak_demand_kw", "max", "max_peak_demand_kw"],
      [/运行时间|runtime/i, "runtime_hours", "sum", "total_runtime_hours"],
    ],
  },
  supplier: {
    label: "供应商", table: "supplier_receipts", dateColumn: "receipt_date", idColumn: "receipt_id", defaultGroup: "supplier_id",
    defaultMetrics: [["received_qty", "sum", "total_received"], ["incoming_defect_qty", "sum", "total_incoming_defects"]],
    metrics: [
      [/到货|收货|数量|received/i, "received_qty", "sum", "total_received"],
      [/缺陷|不良|defect/i, "incoming_defect_qty", "sum", "total_incoming_defects"],
      [/交期|提前期|lead/i, "actual_lead_time_days", "mean", "avg_lead_time_days"],
      [/成本|单价|cost/i, "unit_cost_cny", "mean", "avg_unit_cost_cny"],
    ],
  },
  inventory: {
    label: "库存", table: "inventory_transactions", dateColumn: "transaction_time", idColumn: "transaction_id", defaultGroup: "item_id",
    defaultMetrics: [["quantity", "sum", "net_quantity"]],
    metrics: [
      [/数量|出库|入库|领料|库存|quantity/i, "quantity", "sum", "net_quantity"],
      [/成本|单价|cost/i, "unit_cost_cny", "mean", "avg_unit_cost_cny"],
      [/次数|笔数|count/i, "transaction_id", "count", "transaction_count"],
    ],
  },
};

function detectDomain(question) {
  // Report boilerplate such as “数据质量提示” describes the requested
  // deliverable, not the quality_inspections domain. Score concrete business
  // signals so a production report containing that phrase still routes to
  // production_orders without a discovery round-trip.
  const text = question.replace(/数据质量(?:提示|说明|检查|报告)?/gi, "");
  const patterns = {
    supplier: /供应商|采购|到货|来料|supplier/gi,
    inventory: /库存|仓库|入库|出库|领料|inventory|stock/gi,
    energy: /能耗|耗电|电量|压缩空气|冷却液|需量|energy/gi,
    quality: /质量失败|质量缺陷|质量问题|检验|缺陷|不良|quality/gi,
    equipment: /停机|故障|维修|设备事件|downtime|failure/gi,
    production: /生产|实际产量|计划产量|产量|产出|工单|报废|良品|合格数量|计划完成|节拍|production/gi,
  };
  const priority = ["supplier", "inventory", "energy", "quality", "equipment", "production"];
  const scores = priority.map((domain) => ({ domain, score: (text.match(patterns[domain]) ?? []).length }));
  scores.sort((a, b) => b.score - a.score || priority.indexOf(a.domain) - priority.indexOf(b.domain));
  return scores[0].score > 0 ? scores[0].domain : null;
}

function detectExplicitDomain(question) {
  const matches = Object.entries(DOMAIN_CONFIG)
    .filter(([, config]) => new RegExp(`\\b${config.table}\\b`, "i").test(question))
    .map(([domain]) => domain);
  return matches.length === 1 ? matches[0] : matches.length > 1 ? "ambiguous" : null;
}

function detectAnalysisType(question) {
  if (/相关性|相关分析|关联程度|correlation/i.test(question)) return "correlation";
  if (/离群|异常值|极端值|outlier|z.?score|iqr/i.test(question)) return "outlier";
  if (/趋势|走势|变化|按日|按周|按月|按季度|trend/i.test(question)) return "trend";
  if (/按.+汇总|汇总|柱状图|分组对比|group.?summary/i.test(question)) return "group_summary";
  if (/概况|画像|描述统计|数据质量|字段分布|profile/i.test(question)) return "profile";
  return "group_summary";
}

function detectFrequency(question) {
  if (/按日|每天|每日|daily/i.test(question)) return "day";
  if (/按周|每周|weekly/i.test(question)) return "week";
  if (/按季度|每季度|quarter/i.test(question)) return "quarter";
  return "month";
}

function detectGroup(question, config) {
  const groups = [
    [/按设备|按机台|各设备|每台设备|machine/i, "machine_id"],
    [/按产线|各产线|line/i, "line_id"],
    [/按班次|各班次|shift/i, "shift"],
    [/按产品|各产品|product/i, "product_id"],
    [/按检验阶段|各检验阶段|stage/i, "inspection_stage"],
    [/按缺陷类型|缺陷原因|defect type/i, "defect_type"],
    [/按结果|检验结果|result/i, "result"],
    [/按原因|停机原因|reason/i, "reason"],
    [/按类别|停机类别|category/i, "category"],
    [/按供应商|各供应商|supplier/i, "supplier_id"],
    [/按物料|各物料|material/i, config.table === "inventory_transactions" ? "item_id" : "material_id"],
    [/按仓库|各仓库|warehouse/i, "warehouse_id"],
    [/按事务类型|出入库类型|transaction type/i, "transaction_type"],
  ];
  return groups.find(([pattern]) => pattern.test(question))?.[1] || config.defaultGroup;
}

function detectMetrics(question, config) {
  const selected = [];
  for (const [pattern, field, aggregation, alias] of config.metrics) {
    if (pattern.test(question) && !selected.some((item) => item.field === field)) selected.push({ field, aggregation, alias });
  }
  const source = selected.length ? selected : config.defaultMetrics.map(([field, aggregation, alias]) => ({ field, aggregation, alias }));
  return source;
}

function entityFilters(parsed, available) {
  const mapping = [
    ["machine_id", parsed.entities.machineIds], ["line_id", parsed.entities.lineIds], ["product_id", parsed.entities.productIds],
    ["supplier_id", parsed.entities.supplierIds], [available.has("item_id") ? "item_id" : "material_id", parsed.entities.materialIds], ["order_id", parsed.entities.orderIds],
  ];
  return mapping.flatMap(([field, values]) => available.has(field) && values.length ? [{ field, operator: values.length === 1 ? "eq" : "in", value: values.length === 1 ? values[0] : values }] : []);
}

function dateFilters(parsed, config) {
  const { dateFrom, dateTo } = parsed.dateRange;
  if (!dateFrom && !dateTo) return [];
  const dateOnly = config.dateColumn.endsWith("_date") || config.dateColumn === "reading_date" || config.dateColumn === "receipt_date";
  const nextDay = (value) => {
    const date = new Date(`${value}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  };
  return [
    ...(dateFrom ? [{ field: config.dateColumn, operator: "gte", value: dateFrom }] : []),
    ...(dateTo ? [{ field: config.dateColumn, operator: dateOnly ? "lte" : "lt", value: dateOnly ? dateTo : nextDay(dateTo) }] : []),
  ];
}

function referencedColumns(plan) {
  return [...new Set([
    ...(plan.columns || []), ...(plan.groupBy || []), ...(plan.valueColumns || []), ...(plan.numericColumns || []),
    ...plan.metrics.map((item) => item.field), ...plan.filters.map((item) => item.field), plan.dateColumn, plan.sourceDateColumn,
  ].filter(Boolean))];
}

function conciseReportTitle(config, analysisType, group, metrics, derivedMetrics) {
  const groupLabels = { machine_id: "设备", line_id: "产线", product_id: "产品", supplier_id: "供应商", item_id: "物料", shift: "班次" };
  const metricLabels = {
    total_actual: "实际产量", total_good: "合格数量", total_scrap: "报废数量", scrap_rate: "报废率",
    total_planned: "计划产量", total_runtime_min: "运行时间", total_electricity_kwh: "耗电量",
    total_downtime_min: "停机时间", event_count: "事件数", total_defects: "缺陷数",
  };
  const labels = [...metrics.map((item) => metricLabels[item.alias] || item.alias), ...derivedMetrics.map((item) => metricLabels[item.alias] || item.alias)];
  const action = analysisType === "group_summary" ? `按${groupLabels[group] || group}汇总` : "数据分析";
  return `${config.label}分析报告：${action}${labels.length ? `（${labels.join("、")}）` : ""}`.slice(0, 160);
}

export function planNaturalLanguageSandboxAnalysis({ question, limit = 500, downloadOutputs = true, downloadAnalysisFiles = false } = {}) {
  if (typeof question !== "string" || !question.trim()) throw new DataToolError("INVALID_QUESTION", "question 必须是非空文本。");
  const text = question.trim();
  const explicitDomain = detectExplicitDomain(text);
  if (explicitDomain === "ambiguous") {
    return {
      status: "needs_clarification", execute: false, question: text, confidence: 0.35,
      clarification: "问题中同时指定了多个来源表；当前一键沙箱工作流只处理单表，请明确唯一来源表。",
      recognized: { domain: null, analysisType: detectAnalysisType(text), explicitSourceTable: true },
    };
  }
  // An explicitly named allowlisted table is a hard routing constraint. This
  // prevents boilerplate such as “数据质量提示” from being mistaken for a
  // request to analyze quality_inspections.
  const domain = explicitDomain || detectDomain(text);
  if (!domain) {
    return {
      status: "needs_clarification", execute: false, question: text, confidence: 0.2,
      clarification: "请说明要分析的制造领域，例如生产、质量、停机、能耗、供应商或库存，并指出希望查看的指标。",
      recognized: { domain: null, analysisType: detectAnalysisType(text) },
    };
  }
  const config = DOMAIN_CONFIG[domain];
  const parsed = parseAnalysisQuestion({ question: text });
  const schema = describeTable(config.table);
  const available = new Set(schema.columns.map((column) => column.name));
  const entityRequirements = [
    ["machine_id", parsed.entities.machineIds, "设备"], ["line_id", parsed.entities.lineIds, "产线"],
    ["product_id", parsed.entities.productIds, "产品"], ["supplier_id", parsed.entities.supplierIds, "供应商"],
    [available.has("item_id") ? "item_id" : "material_id", parsed.entities.materialIds, "物料"], ["order_id", parsed.entities.orderIds, "工单"],
  ];
  const unsupportedEntities = entityRequirements.filter(([field, values]) => values.length && !available.has(field));
  if (unsupportedEntities.length) {
    return {
      status: "needs_clarification", execute: false, question: text, confidence: 0.45,
      clarification: `${config.label}明细表 ${config.table} 不能直接按${unsupportedEntities.map((item) => item[2]).join("、")}筛选；当前一键沙箱工作流只处理单表，请改用该表支持的字段或使用已有跨表分析工具。`,
      recognized: { domain, analysisType: detectAnalysisType(text), entities: parsed.entities, dateRange: parsed.dateRange },
      availableColumns: [...available],
    };
  }
  const analysisType = detectAnalysisType(text);
  const metrics = detectMetrics(text, config);
  const group = detectGroup(text, config);
  const filters = [...entityFilters(parsed, available), ...dateFilters(parsed, config)];
  const numericColumns = [...new Set(metrics.map((item) => item.field).filter((field) => field !== config.idColumn))];
  const plan = {
    table: config.table,
    columns: [], filters, orderBy: [], limit: Math.min(Math.max(Number(limit) || 500, 1), 500), format: "csv", previewRows: 5,
    analysisType, groupBy: [], metrics: [], derivedMetrics: [], valueColumns: [], numericColumns: [], aggregation: "sum",
    frequency: detectFrequency(text), correlationMethod: /斯皮尔曼|spearman/i.test(text) ? "spearman" : "pearson",
    outlierMethod: /z.?score|z分数/i.test(text) ? "zscore" : "iqr", threshold: /z.?score|z分数/i.test(text) ? 3 : 1.5,
    maxResultRows: 500, title: "", chartType: "auto", yColumns: [],
    maxChartRows: 200, includeDataTable: true, downloadOutputs, downloadAnalysisFiles,
    sourceDateColumn: config.dateColumn,
  };
  if (analysisType === "group_summary") {
    plan.groupBy = [group]; plan.metrics = metrics;
    const aliases = new Set(metrics.map((item) => item.alias));
    if (domain === "production" && /报废率|scrap.?rate/i.test(text) && aliases.has("total_scrap") && aliases.has("total_actual")) {
      plan.derivedMetrics = [{ alias: "scrap_rate", numerator: "total_scrap", denominator: "total_actual", multiplier: 1 }];
    }
    plan.xColumn = group;
    plan.yColumns = [...metrics.map((item) => item.alias), ...plan.derivedMetrics.map((item) => item.alias)].slice(0, 5);
  } else if (analysisType === "trend") {
    plan.dateColumn = config.dateColumn; plan.valueColumns = numericColumns.slice(0, 10); plan.yColumns = plan.valueColumns.slice(0, 5);
  } else if (analysisType === "correlation") {
    plan.numericColumns = numericColumns.length >= 2 ? numericColumns : config.defaultMetrics.map(([field]) => field).filter((field) => field !== config.idColumn);
  } else if (analysisType === "outlier") {
    plan.numericColumns = numericColumns.slice(0, 10);
  }
  plan.title = conciseReportTitle(config, analysisType, group, metrics, plan.derivedMetrics);
  plan.metricDefinitions = Object.fromEntries([
    ...metrics.map((item) => [item.alias, `${item.aggregation.toUpperCase()}(${item.field})`]),
    ...plan.derivedMetrics.map((item) => [item.alias, `${item.numerator} / ${item.denominator}`]),
  ]);
  plan.dataRange = parsed.dateRange.dateFrom || parsed.dateRange.dateTo
    ? { dateFrom: parsed.dateRange.dateFrom ?? null, dateTo: parsed.dateRange.dateTo ?? null }
    : { dateFrom: null, dateTo: null, note: "用户未指定日期范围，使用来源表中当前可查询的全部记录。" };
  plan.columns = referencedColumns(plan);
  const unknown = referencedColumns(plan).filter((column) => !available.has(column));
  if (unknown.length) {
    return {
      status: "needs_clarification", execute: false, question: text, confidence: 0.5,
      clarification: `当前 ${config.label} 数据表不包含字段：${unknown.join("、")}。请换一种分组方式或分析对象。`,
      recognized: { domain, analysisType, entities: parsed.entities, dateRange: parsed.dateRange },
      availableColumns: [...available],
    };
  }
  if ((analysisType === "correlation" && plan.numericColumns.length < 2) || (analysisType === "outlier" && !plan.numericColumns.length)) {
    return {
      status: "needs_clarification", execute: false, question: text, confidence: 0.5,
      clarification: analysisType === "correlation" ? "相关性分析至少需要两个数值指标，请明确要比较的指标。" : "异常值分析至少需要一个数值指标。",
      recognized: { domain, analysisType }, availableNumericSuggestions: config.metrics.map((item) => item[1]),
    };
  }
  const signals = [parsed.dateRange.dateFrom, filters.length, analysisType !== "group_summary", metrics.length, group].filter(Boolean).length;
  return {
    status: "ready", execute: true, question: text, confidence: Number(Math.min(0.98, 0.68 + signals * 0.05).toFixed(2)),
    interpretation: {
      domain, domainLabel: config.label, analysisType, entities: parsed.entities, dateRange: parsed.dateRange,
      frequency: plan.frequency, explicitSourceTable: Boolean(explicitDomain),
    },
    plan,
    assumptions: [
      `数据来源使用只读表 ${config.table}。`,
      ...(parsed.dateRange.dateFrom ? [] : ["用户未指定日期范围，使用表中当前可查询的数据。"]),
      ...(analysisType === "group_summary" ? [`按 ${group} 汇总。`] : []),
    ],
  };
}

export async function runNaturalLanguageSandboxAnalysis(input = {}) {
  const planned = planNaturalLanguageSandboxAnalysis(input);
  if (planned.status !== "ready" || input.dryRun === true) return { ...planned, executed: false };
  const workflow = await runSandboxAnalysisWorkflow({ ...planned.plan, workflowId: input.workflowId });
  return { ...planned, executed: true, workflow };
}
