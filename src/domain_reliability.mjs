import { DataToolError, runReadOnlySql } from "./database.mjs";
import { getProductionSummary } from "./production.mjs";
import { getQualitySummary } from "./quality.mjs";
import { getEquipmentSummary } from "./equipment.mjs";
import { getEnergySummary } from "./energy.mjs";
import { getSupplierSummary } from "./supplier.mjs";
import { getInventorySummary } from "./inventory.mjs";

export const RELIABILITY_DOMAINS = ["production", "quality", "equipment", "energy", "supplier", "inventory"];

const DOMAIN_LABELS = {
  production: "生产", quality: "质量", equipment: "设备",
  energy: "能耗", supplier: "供应商", inventory: "库存",
};

function rounded(value, digits = 4) {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(Number(value).toFixed(digits));
}

function close(actual, expected, tolerance = 0.0001) {
  if (actual == null || expected == null) return actual == null && expected == null;
  return Math.abs(Number(actual) - Number(expected)) <= tolerance;
}

function requireIsoDate(value, field) {
  if (value == null || value === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DataToolError("INVALID_DATE", `${field} 必须使用 YYYY-MM-DD 格式。`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new DataToolError("INVALID_DATE", `${field} 不是有效日期。`);
  return value;
}

function nextDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function normalizeList(values, field) {
  if (values == null) return [];
  if (!Array.isArray(values) || values.length > 100 || values.some((value) => typeof value !== "string" || !value.trim())) {
    throw new DataToolError("INVALID_RELIABILITY_SCOPE", `${field} 必须是最多包含100个非空字符串的数组。`);
  }
  return [...new Set(values.map((value) => value.trim()))];
}

function normalizeScope(input = {}) {
  const scope = {
    dateFrom: requireIsoDate(input.dateFrom, "dateFrom"),
    dateTo: requireIsoDate(input.dateTo, "dateTo"),
    machineIds: normalizeList(input.machineIds, "machineIds"),
    lineIds: normalizeList(input.lineIds, "lineIds"),
    productIds: normalizeList(input.productIds, "productIds"),
    supplierIds: normalizeList(input.supplierIds, "supplierIds"),
  };
  if (scope.dateFrom && scope.dateTo && scope.dateFrom > scope.dateTo) throw new DataToolError("INVALID_DATE_RANGE", "dateFrom 不能晚于 dateTo。");
  return scope;
}

function addListFilter(clauses, params, column, values) {
  if (!values.length) return;
  clauses.push(`${column} IN (${values.map(() => "?").join(",")})`);
  params.push(...values);
}

function addDateFilter(clauses, params, column, scope, timestamp = true) {
  if (scope.dateFrom) { clauses.push(`${column} >= ?`); params.push(timestamp ? `${scope.dateFrom}T00:00:00` : scope.dateFrom); }
  if (scope.dateTo) { clauses.push(`${column} < ?`); params.push(timestamp ? `${nextDate(scope.dateTo)}T00:00:00` : nextDate(scope.dateTo)); }
}

function whereSql(clauses) { return clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""; }

function scoped(domain, scope) {
  const common = { dateFrom: scope.dateFrom, dateTo: scope.dateTo };
  if (["production", "quality", "equipment"].includes(domain)) return { ...common, machineIds: scope.machineIds, lineIds: scope.lineIds, productIds: scope.productIds };
  if (domain === "energy") return { ...common, machineIds: scope.machineIds, lineIds: scope.lineIds };
  if (domain === "supplier") return { ...common, supplierIds: scope.supplierIds };
  return common;
}

function scopeNotes(domain, scope) {
  const notes = [];
  if (domain === "energy" && scope.productIds.length) notes.push("productIds 未应用到能耗领域：能源数据只有每日×设备粒度，无法可靠归属到产品。");
  if (["production", "quality", "equipment", "energy", "inventory"].includes(domain) && scope.supplierIds.length) notes.push("supplierIds 仅适用于供应商领域，本领域未应用该条件。");
  if (["supplier", "inventory"].includes(domain) && (scope.machineIds.length || scope.lineIds.length || scope.productIds.length)) notes.push("设备、产线和产品条件与本领域没有可靠直接关联，因此未应用。");
  return notes;
}

function check(id, label, passed, { actual = null, expected = null, severity = "error", note = null } = {}) {
  return {
    id, label,
    status: passed ? "PASS" : severity === "warning" ? "WARN" : "FAIL",
    actual, expected, note,
  };
}

function formulaCheck(id, label, actual, numerator, denominator, digits = 4) {
  const expected = Number(denominator) > 0 ? rounded(Number(numerator) / Number(denominator), digits) : null;
  return check(id, label, close(actual, expected, 10 ** (-digits)), { actual, expected });
}

function definitionChecks(definitions, required) {
  return required.map((metric) => check(
    `definition.${metric}`,
    `指标 ${metric} 具有公式定义`,
    typeof definitions?.[metric] === "string" && definitions[metric].trim().length > 0,
    { actual: definitions?.[metric] ?? null, expected: "非空公式定义" },
  ));
}

function productionAudit(scope) {
  const appliedScope = scoped("production", scope);
  const result = getProductionSummary(appliedScope);
  const m = result.metrics || {};
  const clauses = [];
  const params = [];
  addDateFilter(clauses, params, "actual_start", scope);
  addListFilter(clauses, params, "machine_id", scope.machineIds);
  addListFilter(clauses, params, "line_id", scope.lineIds);
  addListFilter(clauses, params, "product_id", scope.productIds);
  const truth = runReadOnlySql({
    sql: `SELECT COUNT(*) AS order_count, SUM(planned_qty) AS planned_qty, SUM(actual_qty) AS actual_qty, SUM(good_qty) AS good_qty, SUM(scrap_qty) AS scrap_qty, SUM(runtime_min) AS runtime_min FROM production_orders${whereSql(clauses)}`,
    params, limit: 1,
  }).rows[0];
  return {
    dataAvailable: result.dataAvailable, appliedScope, scopeNotes: scopeNotes("production", scope),
    sourceTables: ["production_orders"],
    checks: [
      check("production.data_available", "生产数据可用", result.dataAvailable === true),
      check("production.source_order_count", "工单数量与来源表一致", m.order_count === truth.order_count, { actual: m.order_count, expected: truth.order_count }),
      check("production.source_actual_qty", "实际产量与来源表一致", m.actual_qty === truth.actual_qty, { actual: m.actual_qty, expected: truth.actual_qty }),
      check("production.quantity_balance", "实际产量等于良品与报废数量之和", m.actual_qty === m.good_qty + m.scrap_qty, { actual: m.actual_qty, expected: m.good_qty + m.scrap_qty }),
      formulaCheck("production.plan_completion_rate", "计划完成率公式一致", m.plan_completion_rate, m.actual_qty, m.planned_qty),
      formulaCheck("production.yield_rate", "良品率公式一致", m.yield_rate, m.good_qty, m.actual_qty),
      formulaCheck("production.scrap_rate", "报废率公式一致", m.scrap_rate, m.scrap_qty, m.actual_qty),
      formulaCheck("production.weighted_cycle_time", "加权循环时间公式一致", m.weighted_cycle_time_min, m.runtime_min, m.actual_qty, 3),
      ...definitionChecks(result.metricDefinitions, ["plan_completion_rate", "yield_rate", "scrap_rate", "weighted_cycle_time_min"]),
    ],
  };
}

function qualityAudit(scope) {
  const appliedScope = scoped("quality", scope);
  const result = getQualitySummary(appliedScope);
  const m = result.metrics || {};
  const clauses = [];
  const params = [];
  addDateFilter(clauses, params, "q.inspection_time", scope);
  addListFilter(clauses, params, "o.machine_id", scope.machineIds);
  addListFilter(clauses, params, "o.line_id", scope.lineIds);
  addListFilter(clauses, params, "o.product_id", scope.productIds);
  const truth = runReadOnlySql({
    sql: `SELECT COUNT(*) AS inspection_count, SUM(CASE WHEN q.result = 'PASS' THEN 1 ELSE 0 END) AS pass_count, SUM(CASE WHEN q.result = 'FAIL' THEN 1 ELSE 0 END) AS fail_count, SUM(q.sample_size) AS sample_size, SUM(q.defect_count) AS defect_count FROM quality_inspections q JOIN production_orders o ON o.order_id = q.order_id${whereSql(clauses)}`,
    params, limit: 1,
  }).rows[0];
  return {
    dataAvailable: result.dataAvailable, appliedScope, scopeNotes: scopeNotes("quality", scope),
    sourceTables: ["quality_inspections", "production_orders"],
    checks: [
      check("quality.data_available", "质量数据可用", result.dataAvailable === true),
      check("quality.source_count", "检验数量与来源表一致", m.inspection_count === truth.inspection_count, { actual: m.inspection_count, expected: truth.inspection_count }),
      check("quality.result_balance", "通过与失败数量之和等于检验数量", m.pass_count + m.fail_count === m.inspection_count, { actual: m.pass_count + m.fail_count, expected: m.inspection_count }),
      formulaCheck("quality.pass_rate", "检验通过率公式一致", m.pass_rate, m.pass_count, m.inspection_count),
      formulaCheck("quality.fail_rate", "质量失败率公式一致", m.fail_rate, m.fail_count, m.inspection_count),
      formulaCheck("quality.sample_defect_rate", "样本缺陷率公式一致", m.sample_defect_rate, m.defect_count, m.sample_size),
      check("quality.source_sample_size", "样本数与来源表一致", m.sample_size === truth.sample_size, { actual: m.sample_size, expected: truth.sample_size }),
      ...definitionChecks(result.metricDefinitions, ["pass_rate", "fail_rate", "sample_defect_rate", "out_of_spec_rate"]),
    ],
  };
}

function equipmentAudit(scope) {
  const appliedScope = scoped("equipment", scope);
  const result = getEquipmentSummary(appliedScope);
  const m = result.metrics || {};
  const machineClauses = [];
  const machineParams = [];
  addListFilter(machineClauses, machineParams, "m.machine_id", scope.machineIds);
  addListFilter(machineClauses, machineParams, "m.line_id", scope.lineIds);
  const productionClauses = [...machineClauses];
  const productionParams = [...machineParams];
  addDateFilter(productionClauses, productionParams, "o.actual_start", scope);
  addListFilter(productionClauses, productionParams, "o.product_id", scope.productIds);
  const downtimeClauses = [...machineClauses];
  const downtimeParams = [...machineParams];
  addDateFilter(downtimeClauses, downtimeParams, "d.start_time", scope);
  addListFilter(downtimeClauses, downtimeParams, "o.product_id", scope.productIds);
  const energyClauses = [...machineClauses];
  const energyParams = [...machineParams];
  addDateFilter(energyClauses, energyParams, "e.reading_date", scope, false);
  const machineCount = runReadOnlySql({ sql: `SELECT COUNT(*) AS count FROM machines m${whereSql(machineClauses)}`, params: machineParams, limit: 1 }).rows[0].count;
  const orderCount = runReadOnlySql({ sql: `SELECT COUNT(*) AS count FROM production_orders o JOIN machines m ON m.machine_id = o.machine_id${whereSql(productionClauses)}`, params: productionParams, limit: 1 }).rows[0].count;
  const downtimeCount = runReadOnlySql({ sql: `SELECT COUNT(*) AS count FROM downtime_events d JOIN machines m ON m.machine_id = d.machine_id LEFT JOIN production_orders o ON o.order_id = NULLIF(d.order_id, '')${whereSql(downtimeClauses)}`, params: downtimeParams, limit: 1 }).rows[0].count;
  const energyCount = scope.productIds.length ? null : runReadOnlySql({ sql: `SELECT COUNT(*) AS count FROM energy_readings e JOIN machines m ON m.machine_id = e.machine_id${whereSql(energyClauses)}`, params: energyParams, limit: 1 }).rows[0].count;
  const truth = { machine_count: machineCount, order_count: orderCount, downtime_event_count: downtimeCount, energy_reading_count: energyCount };
  return {
    dataAvailable: result.dataAvailable, appliedScope, scopeNotes: scopeNotes("equipment", scope),
    sourceTables: ["machines", "production_orders", "downtime_events", "energy_readings", "products"],
    checks: [
      check("equipment.data_available", "设备数据可用", result.dataAvailable === true),
      ...["machine_count", "order_count", "downtime_event_count", "energy_reading_count"].map((field) => check(`equipment.source_${field}`, `${field} 与来源表一致`, m[field] === truth[field], { actual: m[field], expected: truth[field] })),
      check("equipment.quantity_balance", "设备汇总产量守恒", m.actual_qty === m.good_qty + m.scrap_qty, { actual: m.actual_qty, expected: m.good_qty + m.scrap_qty }),
      check("equipment.downtime_balance", "计划与非计划停机之和等于总停机", m.downtime_min === m.planned_downtime_min + m.unplanned_downtime_min, { actual: m.downtime_min, expected: m.planned_downtime_min + m.unplanned_downtime_min }),
      formulaCheck("equipment.availability", "可用率公式一致", m.availability, m.runtime_min, m.runtime_min + m.unplanned_downtime_min),
      check("equipment.oee", "OEE等于可用率×性能率×质量率", close(m.oee, rounded(m.availability * m.performance * m.quality_rate), 0.0002), { actual: m.oee, expected: rounded(m.availability * m.performance * m.quality_rate) }),
      formulaCheck("equipment.mtbf", "MTBF公式一致", m.mtbf_hours, m.runtime_min / 60, m.failure_count, 2),
      formulaCheck("equipment.mttr", "MTTR公式一致", m.mttr_min, m.failure_downtime_min, m.failure_count, 2),
      check("equipment.proxy_disclosed", "OEE推导口径限制已披露", result.dataNotes?.some((note) => /proxy|计划生产日历/i.test(note)), { severity: "warning", actual: result.dataNotes, expected: "包含OEE代理指标限制说明" }),
      ...definitionChecks(result.metricDefinitions, ["availability", "performance", "quality_rate", "oee", "mtbf_hours", "mttr_min"]),
    ],
  };
}

function energyAudit(scope) {
  const appliedScope = scoped("energy", scope);
  const result = getEnergySummary(appliedScope);
  const m = result.metrics || {};
  const clauses = [];
  const params = [];
  addDateFilter(clauses, params, "e.reading_date", scope, false);
  addListFilter(clauses, params, "m.machine_id", scope.machineIds);
  addListFilter(clauses, params, "m.line_id", scope.lineIds);
  const truth = runReadOnlySql({
    sql: `SELECT COUNT(*) AS reading_count, ROUND(SUM(e.electricity_kwh), 2) AS electricity_kwh, ROUND(SUM(CAST(e.runtime_hours AS REAL)), 2) AS runtime_hours FROM energy_readings e JOIN machines m ON m.machine_id = e.machine_id${whereSql(clauses)}`,
    params, limit: 1,
  }).rows[0];
  return {
    dataAvailable: result.dataAvailable, appliedScope, scopeNotes: scopeNotes("energy", scope),
    sourceTables: ["energy_readings", "machines", "production_orders"],
    checks: [
      check("energy.data_available", "能耗数据可用", result.dataAvailable === true),
      check("energy.source_count", "能源读数数量与来源表一致", m.reading_count === truth.reading_count, { actual: m.reading_count, expected: truth.reading_count }),
      check("energy.source_electricity", "总耗电量与来源表一致", close(m.electricity_kwh, truth.electricity_kwh, 0.01), { actual: m.electricity_kwh, expected: truth.electricity_kwh }),
      formulaCheck("energy.kwh_per_runtime_hour", "单位运行小时耗电公式一致", m.kwh_per_runtime_hour, m.electricity_kwh, m.runtime_hours, 3),
      formulaCheck("energy.air_intensity", "压缩空气强度公式一致", m.air_m3_per_runtime_hour, m.compressed_air_m3, m.runtime_hours, 3),
      formulaCheck("energy.coolant_intensity", "冷却液强度公式一致", m.coolant_liter_per_runtime_hour, m.coolant_liter, m.runtime_hours, 4),
      formulaCheck("energy.load_factor", "电力负载率公式一致", m.electric_load_factor, m.electricity_kwh, m.rated_capacity_kwh),
      formulaCheck("energy.kwh_per_good_unit", "单位良品耗电公式一致", m.kwh_per_good_unit, m.electricity_kwh, m.good_qty),
      check("energy.granularity_disclosed", "能耗数据粒度限制已披露", result.dataNotes?.some((note) => /daily machine|日.*设备|granularity/i.test(note)), { severity: "warning", actual: result.dataNotes, expected: "包含日/设备粒度说明" }),
      ...definitionChecks(result.metricDefinitions, ["kwh_per_runtime_hour", "air_m3_per_runtime_hour", "coolant_liter_per_runtime_hour", "electric_load_factor", "kwh_per_good_unit"]),
    ],
  };
}

function supplierAudit(scope) {
  const appliedScope = scoped("supplier", scope);
  const result = getSupplierSummary(appliedScope);
  const m = result.metrics || {};
  const clauses = [];
  const params = [];
  addDateFilter(clauses, params, "r.receipt_date", scope, false);
  addListFilter(clauses, params, "r.supplier_id", scope.supplierIds);
  const truth = runReadOnlySql({
    sql: `SELECT COUNT(*) AS receipt_count, SUM(r.received_qty) AS received_qty, SUM(r.incoming_defect_qty) AS incoming_defect_qty FROM supplier_receipts r${whereSql(clauses)}`,
    params, limit: 1,
  }).rows[0];
  return {
    dataAvailable: result.dataAvailable, appliedScope, scopeNotes: scopeNotes("supplier", scope),
    sourceTables: ["supplier_receipts", "suppliers", "materials"],
    checks: [
      check("supplier.data_available", "供应商数据可用", result.dataAvailable === true),
      check("supplier.source_count", "到货批次数与来源表一致", m.receipt_count === truth.receipt_count, { actual: m.receipt_count, expected: truth.receipt_count }),
      check("supplier.inspection_balance", "检验通过与失败批次守恒", m.pass_count + m.fail_count === m.receipt_count, { actual: m.pass_count + m.fail_count, expected: m.receipt_count }),
      check("supplier.delivery_balance", "准时与延迟批次守恒", m.on_time_count + m.late_count === m.receipt_count, { actual: m.on_time_count + m.late_count, expected: m.receipt_count }),
      formulaCheck("supplier.defect_rate", "来料缺陷率公式一致", m.defect_rate, m.incoming_defect_qty, m.received_qty),
      formulaCheck("supplier.pass_rate", "来料检验通过率公式一致", m.pass_rate, m.pass_count, m.receipt_count),
      formulaCheck("supplier.on_time_rate", "准时交付率公式一致", m.on_time_rate, m.on_time_count, m.receipt_count),
      formulaCheck("supplier.preferred_rate", "优选供应商到货率公式一致", m.preferred_receipt_rate, m.preferred_receipt_count, m.receipt_count),
      check("supplier.source_received_qty", "到货数量与来源表一致", m.received_qty === truth.received_qty, { actual: m.received_qty, expected: truth.received_qty }),
      ...definitionChecks(result.metricDefinitions, ["defect_rate", "pass_rate", "on_time_rate", "cost_variance_rate", "preferred_receipt_rate"]),
    ],
  };
}

function inventoryAudit(scope) {
  const appliedScope = scoped("inventory", scope);
  const result = getInventorySummary({ ...appliedScope, asOfDate: scope.dateTo });
  const m = result.movementMetrics || {};
  const b = result.balanceMetrics || {};
  const clauses = [];
  const params = [];
  addDateFilter(clauses, params, "transaction_time", scope);
  const truth = runReadOnlySql({
    sql: `SELECT COUNT(*) AS transaction_count, SUM(CASE WHEN quantity > 0 THEN quantity ELSE 0 END) AS inbound_qty, SUM(CASE WHEN quantity < 0 THEN -quantity ELSE 0 END) AS outbound_qty, SUM(quantity) AS net_movement_qty FROM inventory_transactions${whereSql(clauses)}`,
    params, limit: 1,
  }).rows[0];
  const balanceCheck = scope.dateFrom
    ? check("inventory.balance_scope_disclosed", "日期区间净变动与截至日累计余额没有被错误等同", true, { actual: "区间净变动与累计余额分别校验", expected: "不进行错误对等", note: "存在 dateFrom 时，余额包含 dateFrom 之前的历史流水。" })
    : check("inventory.balance_reconciliation", "推导余额与截至日累计净变动一致", close(b.inferred_balance_qty, m.net_movement_qty, 0.01), { actual: b.inferred_balance_qty, expected: m.net_movement_qty });
  return {
    dataAvailable: result.dataAvailable, appliedScope, scopeNotes: scopeNotes("inventory", scope),
    sourceTables: ["inventory_transactions", "materials", "products"],
    checks: [
      check("inventory.data_available", "库存流水数据可用", result.dataAvailable === true),
      check("inventory.source_count", "库存流水数量与来源表一致", m.transaction_count === truth.transaction_count, { actual: m.transaction_count, expected: truth.transaction_count }),
      check("inventory.movement_balance", "入库减出库等于净变动", close(m.inbound_qty - m.outbound_qty, m.net_movement_qty, 0.001), { actual: m.inbound_qty - m.outbound_qty, expected: m.net_movement_qty }),
      check("inventory.source_net", "净变动数量与来源表一致", close(m.net_movement_qty, truth.net_movement_qty, 0.001), { actual: m.net_movement_qty, expected: truth.net_movement_qty }),
      balanceCheck,
      check("inventory.caveat_disclosed", "无期初库存限制已披露", result.dataNotes?.some((note) => /opening.balance|期初库存/i.test(note)), { severity: "warning", actual: result.dataNotes, expected: "包含无期初库存说明" }),
      ...definitionChecks(result.metricDefinitions, ["inbound_qty", "outbound_qty", "net_movement_qty", "inferred_balance_qty", "days_of_supply"]),
    ],
  };
}

const AUDITORS = { production: productionAudit, quality: qualityAudit, equipment: equipmentAudit, energy: energyAudit, supplier: supplierAudit, inventory: inventoryAudit };

function summarize(domain, audit) {
  if (!audit.dataAvailable) {
    return {
      domain, label: DOMAIN_LABELS[domain], status: "INSUFFICIENT", score: null,
      counts: { passed: 0, warnings: 0, failed: 0, total: 0 },
      appliedScope: audit.appliedScope, scopeNotes: audit.scopeNotes,
      sourceTables: audit.sourceTables,
      checks: [{ id: `${domain}.data_insufficient`, label: "当前范围没有足够数据执行可靠性校验", status: "INSUFFICIENT", actual: 0, expected: "至少一条可用记录", note: "请调整日期或实体筛选条件。" }],
    };
  }
  const counts = { passed: 0, warnings: 0, failed: 0 };
  for (const item of audit.checks) {
    if (item.status === "PASS") counts.passed += 1;
    else if (item.status === "WARN") counts.warnings += 1;
    else counts.failed += 1;
  }
  const total = audit.checks.length;
  const score = total ? Number((((counts.passed + counts.warnings * 0.5) / total) * 100).toFixed(1)) : 0;
  return {
    domain, label: DOMAIN_LABELS[domain], status: counts.failed ? "FAIL" : counts.warnings ? "WARN" : "PASS",
    score, counts: { ...counts, total }, appliedScope: audit.appliedScope, scopeNotes: audit.scopeNotes,
    sourceTables: audit.sourceTables, checks: audit.checks,
  };
}

export function getDomainReliabilityReport(input = {}) {
  const { domains = RELIABILITY_DOMAINS, includePassedChecks = true } = input;
  if (!Array.isArray(domains) || !domains.length) throw new DataToolError("INVALID_RELIABILITY_DOMAINS", "domains 至少需要一个领域。");
  const normalized = [...new Set(domains.map((domain) => String(domain).trim().toLowerCase()))];
  const unknown = normalized.filter((domain) => !RELIABILITY_DOMAINS.includes(domain));
  if (unknown.length) throw new DataToolError("INVALID_RELIABILITY_DOMAINS", "包含不支持的领域。", { unknown, available: RELIABILITY_DOMAINS });
  const requestedScope = normalizeScope(input);
  const results = normalized.map((domain) => summarize(domain, AUDITORS[domain](requestedScope)));
  if (!includePassedChecks) for (const result of results) result.checks = result.checks.filter((item) => item.status !== "PASS");
  const failedDomains = results.filter((result) => result.status === "FAIL").map((result) => result.domain);
  const warningDomains = results.filter((result) => result.status === "WARN").map((result) => result.domain);
  const insufficientDomains = results.filter((result) => result.status === "INSUFFICIENT").map((result) => result.domain);
  const scored = results.filter((result) => Number.isFinite(result.score));
  return {
    generatedAt: new Date().toISOString(),
    requestedScope,
    scope: "按 requestedScope 审计；每个领域的实际筛选条件见 appliedScope，不支持的跨粒度条件见 scopeNotes。",
    methodology: "独立来源表聚合 + 数量守恒 + 公式重算 + 指标定义覆盖 + 领域限制披露",
    status: failedDomains.length ? "FAIL" : insufficientDomains.length ? "INSUFFICIENT" : warningDomains.length ? "WARN" : "PASS",
    score: scored.length ? Number((scored.reduce((sum, result) => sum + result.score, 0) / scored.length).toFixed(1)) : null,
    summary: { checkedDomains: results.length, passedDomains: results.filter((result) => result.status === "PASS").length, warningDomains, failedDomains, insufficientDomains },
    domains: results,
    assumptions: ["本次审计验证计算一致性和来源表对账，不代表业务阈值本身已经获得行业认证。", "库存余额因缺少期初快照而属于流水推导值。", "设备OEE因缺少完整计划生产日历而属于透明代理指标。"],
  };
}
