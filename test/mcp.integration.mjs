import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverFile = path.join(root, "src", "server.mjs");
const client = new Client({ name: "manufacturing-test-client", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [serverFile], cwd: root });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  for (const expected of ["get_dataset_info", "list_tables", "describe_table", "preview_data", "query_records", "aggregate_metrics", "run_readonly_sql", "export_records_csv", "get_production_summary", "analyze_production_breakdown", "get_production_trend", "find_production_exceptions", "get_quality_summary", "analyze_quality_breakdown", "get_quality_trend", "find_quality_exceptions", "analyze_process_capability", "get_equipment_summary", "analyze_equipment_breakdown", "get_equipment_trend", "analyze_downtime", "calculate_equipment_oee", "find_equipment_exceptions", "get_energy_summary", "analyze_energy_breakdown", "get_energy_trend", "analyze_energy_efficiency", "analyze_peak_demand", "find_energy_exceptions", "get_supplier_summary", "analyze_supplier_breakdown", "get_supplier_trend", "score_suppliers", "find_supplier_exceptions", "get_inventory_summary", "analyze_inventory_breakdown", "get_inventory_trend", "analyze_inventory_status", "find_inventory_exceptions", "get_manufacturing_overview", "analyze_machine_360", "analyze_product_360", "get_cross_domain_trend", "trace_work_order", "find_cross_domain_risks", "detect_rule_anomalies", "detect_statistical_anomalies", "detect_trend_anomalies", "get_anomaly_overview", "parse_analysis_question", "ask_manufacturing_question", "explain_manufacturing_metric", "generate_natural_language_report", "get_security_status", "query_audit_log", "get_domain_reliability_report", "list_metric_definitions", "get_metric_definition", "build_chart_dataset", "rank_root_cause_candidates", "rank_machine_root_causes_batch", "predict_maintenance_risk", "export_analysis_xlsx", "search_external_sources", "retrieve_external_evidence", "retrieve_external_sources", "fetch_external_document", "cross_check_external_sources", "get_embedding_status", "get_python_sandbox_status", "create_python_session", "run_python_analysis", "upload_python_sandbox_file", "download_python_sandbox_file", "destroy_python_session", "prepare_sandbox_dataset", "analyze_sandbox_dataset", "generate_sandbox_report", "run_sandbox_analysis_workflow", "run_natural_language_sandbox_analysis"]) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }
  assert.ok(names.includes("analyze_energy_production_efficiency"), "missing tool: analyze_energy_production_efficiency");
  assert.ok(names.includes("compare_machine_monthly_performance"), "missing tool: compare_machine_monthly_performance");
  assert.ok(names.includes("analyze_supplier_inventory_risk"), "missing tool: analyze_supplier_inventory_risk");

  const tables = await client.callTool({ name: "list_tables", arguments: { includeViews: true } });
  assert.equal(tables.isError, undefined);
  assert.ok(tables.structuredContent.items.some((item) => item.name === "production_orders"));

  const query = await client.callTool({
    name: "query_records",
    arguments: { table: "machines", columns: ["machine_id", "machine_type"], limit: 2, offset: 0 },
  });
  assert.equal(query.structuredContent.rows.length, 2);

  const exported = await client.callTool({
    name: "export_records_csv",
    arguments: { table: "machines", columns: ["machine_id", "machine_type", "status"], fileName: "integration_machines.csv" },
  });
  assert.equal(exported.isError, undefined);
  assert.equal(exported.structuredContent.rows, 8);
  assert.equal(fs.existsSync(exported.structuredContent.file), true);

  const production = await client.callTool({
    name: "analyze_production_breakdown",
    arguments: { dimension: "machine", orderBy: "scrap_rate", direction: "desc", limit: 8 },
  });
  assert.equal(production.isError, undefined);
  assert.equal(production.structuredContent.rows[0].machine_id, "M07");
  assert.ok(production.structuredContent.metadata.sourceTables.includes("production_orders"));
  assert.ok(production.structuredContent.metadata.queryTrace.queryCount > 0);
  assert.equal(production.structuredContent.metadata.timezone, "Asia/Shanghai");

  const exceptions = await client.callTool({
    name: "find_production_exceptions",
    arguments: { exceptionTypes: ["high_scrap"], scrapAbove: 0.05, limit: 20 },
  });
  assert.equal(exceptions.isError, undefined);
  assert.ok(exceptions.structuredContent.rows.length > 0);

  const quality = await client.callTool({
    name: "analyze_quality_breakdown",
    arguments: { dimension: "machine", orderBy: "fail_rate", direction: "desc", limit: 8 },
  });
  assert.equal(quality.isError, undefined);
  assert.equal(quality.structuredContent.rows[0].machine_id, "M07");

  const capability = await client.callTool({
    name: "analyze_process_capability",
    arguments: { dimension: "overall", minSampleSize: 20 },
  });
  assert.equal(capability.isError, undefined);
  assert.equal(capability.structuredContent.rows.length, 1);

  const equipment = await client.callTool({
    name: "analyze_equipment_breakdown",
    arguments: { dimension: "machine", orderBy: "downtime_min", direction: "desc", limit: 8 },
  });
  assert.equal(equipment.isError, undefined);
  assert.equal(equipment.structuredContent.rows[0].machine_id, "M03");

  const oee = await client.callTool({
    name: "calculate_equipment_oee",
    arguments: { dimension: "overall" },
  });
  assert.equal(oee.isError, undefined);
  assert.equal(oee.structuredContent.rows.length, 1);

  const energy = await client.callTool({
    name: "analyze_energy_efficiency",
    arguments: { dimension: "machine", efficiencyMetric: "kwh_per_runtime_hour", limit: 8 },
  });
  assert.equal(energy.isError, undefined);
  assert.equal(energy.structuredContent.rows[0].machine_id, "M08");

  const energyExceptions = await client.callTool({
    name: "find_energy_exceptions",
    arguments: { exceptionTypes: ["idle_consumption"], idleKwhAbove: 10, limit: 10 },
  });
  assert.equal(energyExceptions.isError, undefined);
  assert.ok(energyExceptions.structuredContent.rows.length > 0);

  const suppliers = await client.callTool({
    name: "analyze_supplier_breakdown",
    arguments: { dimension: "supplier", orderBy: "defect_rate", direction: "desc", limit: 6 },
  });
  assert.equal(suppliers.isError, undefined);
  assert.equal(suppliers.structuredContent.rows[0].supplier_id, "S004");

  const supplierScores = await client.callTool({ name: "score_suppliers", arguments: {} });
  assert.equal(supplierScores.isError, undefined);
  assert.equal(supplierScores.structuredContent.rows.at(-1).supplier_id, "S004");

  const inventory = await client.callTool({
    name: "analyze_inventory_status",
    arguments: { itemTypes: ["RAW_MATERIAL"], lookbackDays: 90 },
  });
  assert.equal(inventory.isError, undefined);
  assert.equal(inventory.structuredContent.rows.length, 10);
  assert.ok(inventory.structuredContent.rows.some((row) => row.coverage_status === "EXCESS_COVERAGE"));

  const inventoryExceptions = await client.callTool({
    name: "find_inventory_exceptions",
    arguments: { itemTypes: ["RAW_MATERIAL"], exceptionTypes: ["no_consumption"], limit: 20 },
  });
  assert.equal(inventoryExceptions.isError, undefined);
  assert.ok(inventoryExceptions.structuredContent.rows.some((row) => row.item_id === "RM009"));

  const machine360 = await client.callTool({ name: "analyze_machine_360", arguments: { limit: 8 } });
  assert.equal(machine360.isError, undefined);
  assert.equal(machine360.structuredContent.rows[0].machine_id, "M03");

  const trace = await client.callTool({ name: "trace_work_order", arguments: { orderId: "WO00001" } });
  assert.equal(trace.isError, undefined);
  assert.equal(trace.structuredContent.summaries.quality.inspection_count, 2);

  const crossRisks = await client.callTool({ name: "find_cross_domain_risks", arguments: { minimumRiskScore: 3 } });
  assert.equal(crossRisks.isError, undefined);
  assert.deepEqual(crossRisks.structuredContent.rows.map((row) => row.machine_id), ["M03", "M07"]);

  const statisticalAnomalies = await client.callTool({
    name: "detect_statistical_anomalies",
    arguments: { metric: "equipment.unplanned_downtime_min", grain: "day", method: "zscore", threshold: 2, minimumPoints: 8 },
  });
  assert.equal(statisticalAnomalies.isError, undefined);
  assert.equal(statisticalAnomalies.structuredContent.anomalies[0].period, "2026-04-04");

  const trendAnomalies = await client.callTool({
    name: "detect_trend_anomalies",
    arguments: { metric: "equipment.unplanned_downtime_min", grain: "month", method: "change_rate", window: 2, threshold: 0.5, minimumPoints: 5 },
  });
  assert.equal(trendAnomalies.isError, undefined);
  assert.equal(trendAnomalies.structuredContent.anomalies[0].period, "2026-04");

  const parsedQuestion = await client.callTool({
    name: "parse_analysis_question",
    arguments: { question: "请追溯工单WO00001" },
  });
  assert.equal(parsedQuestion.isError, undefined);
  assert.equal(parsedQuestion.structuredContent.suggestedTool, "trace_work_order");

  const naturalAnswer = await client.callTool({
    name: "ask_manufacturing_question",
    arguments: { question: "哪台设备报废率最高？" },
  });
  assert.equal(naturalAnswer.isError, undefined);
  assert.equal(naturalAnswer.structuredContent.execution.tool, "analyze_machine_360");
  assert.equal(naturalAnswer.structuredContent.evidence.rows[0].machine_id, "M07");

  const securityStatus = await client.callTool({ name: "get_security_status", arguments: {} });
  assert.equal(securityStatus.isError, undefined);
  assert.equal(securityStatus.structuredContent.databaseMode, "read_only + query_only + defensive");
  assert.equal(securityStatus.structuredContent.masking.enabled, true);

  const auditLog = await client.callTool({ name: "query_audit_log", arguments: { tool: "analyze_production_breakdown", limit: 5 } });
  assert.equal(auditLog.isError, undefined);
  assert.ok(auditLog.structuredContent.rows.length > 0);
  assert.equal(auditLog.structuredContent.rows[0].tool, "analyze_production_breakdown");

  const metricDefinition = await client.callTool({ name: "get_metric_definition", arguments: { metric: "良品率" } });
  assert.equal(metricDefinition.isError, undefined);
  assert.equal(metricDefinition.structuredContent.metric, "yield_rate");

  const chartData = await client.callTool({ name: "build_chart_dataset", arguments: { domain: "production", view: "trend", metric: "scrap_rate", grain: "month" } });
  assert.equal(chartData.isError, undefined);
  assert.equal(chartData.structuredContent.rows.length, 6);
  assert.equal(chartData.structuredContent.chart.type, "line");

  const rootCauses = await client.callTool({ name: "rank_root_cause_candidates", arguments: { machineId: "M07", limit: 5 } });
  assert.equal(rootCauses.isError, undefined);
  assert.equal(rootCauses.structuredContent.rows[0].candidate, "Hydraulic Leak");
  assert.equal(rootCauses.structuredContent.productionPaceEvidence.returned, 2);
  assert.equal(rootCauses.structuredContent.productionPaceEvidence.material_slowdown_detected, false);

  const batchRootCauses = await client.callTool({
    name: "rank_machine_root_causes_batch",
    arguments: { machineIds: ["M03", "M07", "M08"], limitPerMachine: 3 },
  });
  assert.equal(batchRootCauses.isError, undefined);
  assert.deepEqual(batchRootCauses.structuredContent.rows.map((row) => row.machine_id), ["M03", "M07", "M08"]);
  assert.ok(batchRootCauses.structuredContent.rows.every((row) => row.productionPaceEvidence.returned >= 1));

  const maintenance = await client.callTool({ name: "predict_maintenance_risk", arguments: { limit: 8, horizonDays: 30 } });
  assert.equal(maintenance.isError, undefined);
  assert.equal(maintenance.structuredContent.rows[0].machine_id, "M03");
  assert.equal(maintenance.structuredContent.rows[0].risk_level, "CRITICAL");

  const reliability = await client.callTool({ name: "get_domain_reliability_report", arguments: {
    domains: ["production", "quality", "equipment", "energy"], dateFrom: "2026-04-01", dateTo: "2026-04-30",
    machineIds: ["M03"], lineIds: ["L1"], includePassedChecks: false,
  } });
  assert.equal(reliability.isError, undefined);
  assert.equal(reliability.structuredContent.status, "PASS");
  assert.equal(reliability.structuredContent.summary.checkedDomains, 4);
  assert.equal(reliability.structuredContent.domains.length, 4);
  assert.deepEqual(reliability.structuredContent.requestedScope.machineIds, ["M03"]);

  const excel = await client.callTool({ name: "export_analysis_xlsx", arguments: { analysisType: "maintenance", fileName: "integration_maintenance.xlsx", limit: 8 } });
  assert.equal(excel.isError, undefined);
  assert.equal(excel.structuredContent.verification.formulaErrorsFound, false);
  assert.equal(fs.existsSync(excel.structuredContent.file), true);

  const blocked = await client.callTool({ name: "run_readonly_sql", arguments: { sql: "DROP TABLE machines" } });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.structuredContent.error.code, "READ_ONLY_REQUIRED");

  if (!process.env.TAVILY_API_KEY) {
    const externalUnconfigured = await client.callTool({ name: "search_external_sources", arguments: { query: "设备预测性维护" } });
    assert.equal(externalUnconfigured.isError, true);
    assert.equal(externalUnconfigured.structuredContent.error.code, "EXTERNAL_SEARCH_NOT_CONFIGURED");
  }

  const sandboxStatus = await client.callTool({ name: "get_python_sandbox_status", arguments: { probe: false } });
  assert.equal(sandboxStatus.isError, undefined);
  assert.equal(sandboxStatus.structuredContent.provider, "AIO Sandbox");

  console.log(JSON.stringify({ status: "passed", protocolVersion: client.getNegotiatedProtocolVersion(), tools: names }, null, 2));
} finally {
  await client.close();
}
