import crypto from "node:crypto";
import { DataToolError } from "./database.mjs";
import { readPythonSandboxTextFile, runPythonAnalysis } from "./aio_sandbox.mjs";

const ANALYSIS_TYPES = new Set(["profile", "group_summary", "trend", "correlation", "outlier"]);
const CHART_TYPES = new Set(["auto", "none", "bar", "line", "scatter", "histogram", "box", "heatmap"]);
const DEFAULT_DISPLAY_LABELS = {
  machine_id: "设备", line_id: "产线", product_id: "产品", supplier_id: "供应商", item_id: "物料", shift: "班次",
  total_actual: "实际产量", total_good: "合格数量", total_scrap: "报废数量", total_planned: "计划产量",
  scrap_rate: "报废率", total_runtime_min: "运行时间（分钟）", total_electricity_kwh: "耗电量（kWh）",
  total_downtime_min: "停机时间（分钟）", event_count: "事件数", total_defects: "缺陷数",
};

function safeId(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(String(value || ""))) {
    throw new DataToolError("INVALID_SANDBOX_REPORT_ID", `${label} 只能包含字母、数字、点、下划线和短横线，最长80个字符。`);
  }
  return String(value);
}

function parseSummary(content, resultId) {
  try {
    const parsed = JSON.parse(content);
    return parsed.summary && typeof parsed.summary === "object" ? parsed.summary : parsed;
  } catch {
    throw new DataToolError("INVALID_ANALYSIS_RESULT", "分析结果文件不是有效 JSON。", { resultId });
  }
}

function inferColumns(summary) {
  const row = summary.preview?.[0] || summary.matrix?.[0];
  return row && typeof row === "object" ? Object.keys(row) : [];
}

function inferNumericColumns(summary, columns) {
  const rows = summary.preview || summary.matrix || [];
  return columns.filter((column) => rows.some((row) => typeof row?.[column] === "number"));
}

function autoChart(analysisType) {
  return { group_summary: "bar", trend: "line", correlation: "heatmap", profile: "none", outlier: "none" }[analysisType];
}

function validateConfig(input, summary) {
  if (!ANALYSIS_TYPES.has(input.analysisType)) throw new DataToolError("INVALID_REPORT_ANALYSIS_TYPE", "不支持的 analysisType。");
  if (!CHART_TYPES.has(input.chartType)) throw new DataToolError("INVALID_CHART_TYPE", "不支持的 chartType。");
  const available = inferColumns(summary);
  const numeric = inferNumericColumns(summary, available);
  const derivedMetrics = (input.derivedMetrics || []).map((metric) => {
    const alias = String(metric.alias || "");
    const numerator = String(metric.numerator || "");
    const denominator = String(metric.denominator || "");
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(alias) || available.includes(alias)) throw new DataToolError("INVALID_DERIVED_METRIC_ALIAS", "报告派生指标 alias 无效或与已有字段冲突。");
    if (!available.includes(numerator) || !available.includes(denominator)) throw new DataToolError("UNKNOWN_DERIVED_METRIC_SOURCE", "报告派生指标引用了不存在的字段。", { numerator, denominator, available });
    const multiplier = metric.multiplier == null ? 1 : Number(metric.multiplier);
    if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 10000) throw new DataToolError("INVALID_DERIVED_METRIC_MULTIPLIER", "报告派生指标 multiplier 必须大于0且不超过10000。");
    available.push(alias); numeric.push(alias);
    return { alias, numerator, denominator, multiplier, formula: `${numerator} / ${denominator} * ${multiplier}` };
  });
  let chartType = input.chartType === "auto" ? autoChart(input.analysisType) : input.chartType;
  let xColumn = input.xColumn || null;
  let yColumns = [...new Set(input.yColumns || [])];
  if (!available.length && chartType !== "none") {
    chartType = "none";
    xColumn = null;
    yColumns = [];
  }
  if (chartType === "heatmap" && input.analysisType !== "correlation") throw new DataToolError("INVALID_HEATMAP_SOURCE", "heatmap 仅适用于 correlation 分析结果。");
  if (chartType !== "none" && input.analysisType === "profile") throw new DataToolError("PROFILE_CHART_UNSUPPORTED", "profile 结果没有明细 CSV；请选择 chartType=none。");
  if (new Set(["bar", "line", "scatter"]).has(chartType)) {
    xColumn ||= available[0];
    if (!yColumns.length) yColumns = numeric.filter((column) => column !== xColumn).slice(0, 5);
    if (!xColumn || !yColumns.length) throw new DataToolError("MISSING_CHART_COLUMNS", `${chartType} 图需要 xColumn 和至少一个数值 yColumns。`, { available, numeric });
  }
  if (new Set(["histogram", "box"]).has(chartType)) {
    if (!yColumns.length) yColumns = numeric.slice(0, 5);
    if (!yColumns.length) throw new DataToolError("MISSING_CHART_COLUMNS", `${chartType} 图至少需要一个数值 yColumns。`, { available, numeric });
  }
  const requested = [xColumn, ...yColumns].filter(Boolean);
  const unknown = requested.filter((column) => !available.includes(column));
  if (unknown.length) throw new DataToolError("UNKNOWN_REPORT_COLUMN", "图表字段不在分析结果中。", { unknown, available });
  if (yColumns.length > 5) throw new DataToolError("TOO_MANY_REPORT_COLUMNS", "yColumns 最多允许5个字段。");
  return {
    analysisType: input.analysisType, resultId: input.resultId, reportId: input.reportId,
    title: input.title || `${input.resultId} 制造业分析报告`, chartType, xColumn, yColumns,
    maxChartRows: Math.min(Math.max(Number(input.maxChartRows) || 200, 1), 500),
    includeDataTable: input.includeDataTable !== false,
    derivedMetrics,
    sourceTable: input.sourceTable || null,
    sourceFilters: input.sourceFilters || [],
    sourceColumns: input.sourceColumns || [],
    sourceRowCount: input.sourceRowCount ?? null,
    sourceTotalRows: input.sourceTotalRows ?? null,
    sourceTruncated: Boolean(input.sourceTruncated),
    metricDefinitions: input.metricDefinitions || {},
    dataRange: input.dataRange || null,
    dataQualityNotes: input.dataQualityNotes || [],
    displayLabels: { ...DEFAULT_DISPLAY_LABELS, ...(input.displayLabels || {}) },
    percentageColumns: derivedMetrics.filter((metric) => /(?:rate|ratio|pct|percent)/i.test(metric.alias) && metric.multiplier === 1).map((metric) => metric.alias),
    summaryFile: `/home/gem/workspace/outputs/${input.resultId}.json`,
    csvFile: `/home/gem/workspace/outputs/${input.resultId}.csv`,
    reportBase: `/home/gem/workspace/outputs/${input.reportId}`,
  };
}

function enhancedPythonProgram(config) {
  let program = pythonProgram(config);
  program = program.replace("from matplotlib import font_manager", "from matplotlib import font_manager, ticker");
  program = program.replace(
    "df = pd.read_csv(csv_path).head(cfg['maxChartRows']) if csv_path.is_file() else None",
    "df = pd.read_csv(csv_path).head(cfg['maxChartRows']) if csv_path.is_file() else None\nif df is not None:\n    for metric in cfg.get('derivedMetrics', []):\n        numerator = pd.to_numeric(df[metric['numerator']], errors='coerce')\n        denominator = pd.to_numeric(df[metric['denominator']], errors='coerce').replace(0, float('nan'))\n        df[metric['alias']] = numerator / denominator * metric['multiplier']",
  );
  program = program.replace(
    "if chart == 'bar': work.plot(kind='bar', ax=plt.gca())\n        else: work.plot(kind='line', marker='o', ax=plt.gca())\n        plt.xlabel(cfg['xColumn']); plt.ylabel(', '.join(cfg['yColumns']))",
    "labels = cfg.get('displayLabels', {})\n        main_ax = plt.gca()\n        if chart == 'bar':\n            derived = [m['alias'] for m in cfg.get('derivedMetrics', []) if m['alias'] in work.columns]\n            primary = [c for c in cfg['yColumns'] if c not in derived]\n            if primary:\n                work[primary].rename(columns=labels).plot(kind='bar', ax=main_ax)\n                main_ax.set_ylabel('数量（件）' if all(c in ('total_actual','total_good','total_scrap','total_planned') for c in primary) else '指标值')\n            if derived:\n                rate_ax = main_ax.twinx()\n                work[derived].rename(columns=labels).plot(kind='line', marker='o', linewidth=2, ax=rate_ax, color=['#d62728'][:len(derived)])\n                rate_ax.set_ylabel('、'.join(labels.get(c, c) for c in derived))\n                if all(c in cfg.get('percentageColumns', []) for c in derived): rate_ax.yaxis.set_major_formatter(ticker.PercentFormatter(xmax=1.0, decimals=1))\n                handles1, legend1 = main_ax.get_legend_handles_labels()\n                handles2, legend2 = rate_ax.get_legend_handles_labels()\n                if rate_ax.get_legend() is not None: rate_ax.get_legend().remove()\n                main_ax.legend(handles1 + handles2, legend1 + legend2, loc='upper center', bbox_to_anchor=(0.5, -0.18), ncol=max(1, min(4, len(legend1) + len(legend2))), frameon=False)\n        else:\n            work.rename(columns=labels).plot(kind='line', marker='o', ax=main_ax)\n            main_ax.set_ylabel('指标值')\n        main_ax.set_xlabel(labels.get(cfg['xColumn'], cfg['xColumn']))",
  );
  program = program.replace(
    "for row in small.astype(str).itertuples(index=False, name=None): lines.append('| ' + ' | '.join(md_escape(v) for v in row) + ' |')",
    "display_headers = [labels.get(h, h) + (f'（{h}）' if labels.get(h) and labels.get(h) != h else '') for h in headers]\n    lines[0] = '| ' + ' | '.join(md_escape(h) for h in display_headers) + ' |'\n    for row in small.itertuples(index=False, name=None):\n        values = []\n        for column, value in zip(headers, row):\n            if column in cfg.get('percentageColumns', []) and value != '':\n                try: value = f'{float(value) * 100:.2f}%'\n                except (TypeError, ValueError): pass\n            elif isinstance(value, float):\n                value = f'{value:.4f}'.rstrip('0').rstrip('.')\n            values.append(md_escape(value))\n        lines.append('| ' + ' | '.join(values) + ' |')",
  );
  program = program.replace(
    "lines += ['## 使用说明', '', '- 本报告由固定分析模板生成，未执行用户提供的任意代码。'",
    "data_range = cfg.get('dataRange') or {}\nrange_lines = []\nif data_range.get('dateFrom') or data_range.get('dateTo'):\n    range_lines.append('- 起始日期：' + str(data_range.get('dateFrom') or '未限定'))\n    range_lines.append('- 结束日期：' + str(data_range.get('dateTo') or '未限定'))\nif data_range.get('note'): range_lines.append('- 说明：' + str(data_range['note']))\nif not range_lines: range_lines.append('- 未提供明确的数据时间范围。')\nmetric_lines = []\nfor name, definition in (cfg.get('metricDefinitions') or {}).items():\n    label = cfg.get('displayLabels', {}).get(name, name)\n    metric_lines.append(f'- {label}（`{name}`）：`{definition}`')\nif not metric_lines: metric_lines.append('- 未提供指标定义。')\nfilters = cfg.get('sourceFilters') or []\nfilter_lines = ['- 无额外筛选条件。'] if not filters else ['- `' + json.dumps(item, ensure_ascii=False) + '`' for item in filters]\nquality = list(cfg.get('dataQualityNotes', []))\nquality.append('结果已截断，仅展示部分记录。' if cfg.get('sourceTruncated') else '结果未截断。')\nlines += ['## 数据范围', ''] + range_lines + ['', '## 指标定义', ''] + metric_lines + ['', '## 来源表', '', '`' + str(cfg.get('sourceTable') or '未提供') + '`', '', '## 筛选条件', ''] + filter_lines + ['', '## 数据质量提示', '']\nlines += ['- ' + str(item) for item in quality]\nlines += ['', '## 使用说明', '', '- 本报告由固定分析模板生成，未执行用户提供的任意代码。'",
  );
  program = program.replace(
    "summary_text = json.dumps(summary, ensure_ascii=False, indent=2, default=str).replace('\\n', '\\n    ')\nlines += ['## 分析摘要', '', '    ' + summary_text, '']",
    "summary_lines = []\nfor key, value in summary.items() if isinstance(summary, dict) else []:\n    if key in ('preview', 'matrix'): continue\n    label = {'group_count':'分组数量', 'row_count':'记录数量', 'outlier_count':'异常点数量'}.get(key, cfg.get('displayLabels', {}).get(key, key))\n    rendered = json.dumps(value, ensure_ascii=False, default=str) if isinstance(value, (dict, list)) else str(value)\n    summary_lines.append(f'- {label}：{rendered}')\nif not summary_lines: summary_lines.append('- 详细分析结果见下方数据表。')\nlines += ['## 分析摘要', ''] + summary_lines + ['']",
  );
  return program;
}

export function buildSandboxReportProgramForTesting(input, summary) {
  const config = validateConfig({
    ...input,
    resultId: input.resultId || "test-result",
    reportId: input.reportId || "test-report",
    analysisType: input.analysisType || "group_summary",
    chartType: input.chartType || "auto",
  }, summary);
  return enhancedPythonProgram(config);
}

function pythonProgram(config) {
  const encoded = Buffer.from(JSON.stringify(config), "utf8").toString("base64");
  return `import base64, json
from datetime import datetime, timezone
from pathlib import Path
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

def configure_cjk_font():
    available = {font.name for font in font_manager.fontManager.ttflist}
    preferred = ['Noto Sans CJK SC', 'Noto Sans CJK JP', 'Source Han Sans CN', 'WenQuanYi Micro Hei', 'AR PL UMing CN', 'AR PL UKai CN', 'SimHei', 'Microsoft YaHei']
    selected = next((name for name in preferred if name in available), None)
    if selected:
        matplotlib.rcParams['font.family'] = 'sans-serif'
        matplotlib.rcParams['font.sans-serif'] = [selected, 'DejaVu Sans']
    matplotlib.rcParams['axes.unicode_minus'] = False
    return selected

cjk_font = configure_cjk_font()

cfg = json.loads(base64.b64decode('${encoded}').decode('utf-8'))
summary_path = Path(cfg['summaryFile'])
if not summary_path.is_file(): raise FileNotFoundError(f'Analysis result not found: {summary_path}')
raw = json.loads(summary_path.read_text(encoding='utf-8'))
summary = raw.get('summary', raw) if isinstance(raw, dict) else raw
csv_path = Path(cfg['csvFile'])
df = pd.read_csv(csv_path).head(cfg['maxChartRows']) if csv_path.is_file() else None
out_base = Path(cfg['reportBase'])
out_base.parent.mkdir(parents=True, exist_ok=True)
chart_file = None
chart = cfg['chartType']

if chart != 'none':
    if df is None: raise FileNotFoundError(f'Analysis CSV not found: {csv_path}')
    plt.figure(figsize=(10, 5.5))
    if chart in ('bar', 'line'):
        work = df[[cfg['xColumn']] + cfg['yColumns']].copy()
        for col in cfg['yColumns']: work[col] = pd.to_numeric(work[col], errors='coerce')
        work = work.set_index(cfg['xColumn'])
        if chart == 'bar': work.plot(kind='bar', ax=plt.gca())
        else: work.plot(kind='line', marker='o', ax=plt.gca())
        plt.xlabel(cfg['xColumn']); plt.ylabel(', '.join(cfg['yColumns']))
    elif chart == 'scatter':
        x, y = cfg['xColumn'], cfg['yColumns'][0]
        plt.scatter(pd.to_numeric(df[x], errors='coerce'), pd.to_numeric(df[y], errors='coerce'), alpha=0.75)
        plt.xlabel(x); plt.ylabel(y)
    elif chart == 'histogram':
        df[cfg['yColumns']].apply(pd.to_numeric, errors='coerce').plot(kind='hist', bins=20, alpha=0.65, ax=plt.gca())
        plt.xlabel('Value'); plt.ylabel('Frequency')
    elif chart == 'box':
        df[cfg['yColumns']].apply(pd.to_numeric, errors='coerce').plot(kind='box', ax=plt.gca())
        plt.ylabel('Value')
    elif chart == 'heatmap':
        matrix = df.set_index(df.columns[0]).apply(pd.to_numeric, errors='coerce')
        image = plt.imshow(matrix.values, cmap='coolwarm', vmin=-1, vmax=1, aspect='auto')
        plt.colorbar(image, label='Correlation')
        plt.xticks(range(len(matrix.columns)), matrix.columns, rotation=45, ha='right')
        plt.yticks(range(len(matrix.index)), matrix.index)
    plt.title(cfg['title']); plt.grid(chart in ('bar', 'line'), alpha=0.2); plt.tight_layout()
    chart_file = out_base.with_suffix('.png')
    plt.savefig(chart_file, dpi=160, bbox_inches='tight'); plt.close()

def md_escape(value):
    return str(value).replace('|', '\\|').replace('\\n', ' ')

def table_markdown(frame, limit=20):
    small = frame.head(limit).fillna('')
    headers = [str(c) for c in small.columns]
    lines = ['| ' + ' | '.join(md_escape(h) for h in headers) + ' |', '| ' + ' | '.join('---' for _ in headers) + ' |']
    for row in small.astype(str).itertuples(index=False, name=None): lines.append('| ' + ' | '.join(md_escape(v) for v in row) + ' |')
    return '\\n'.join(lines)

lines = [f"# {cfg['title']}", '', f"- 生成时间：{datetime.now(timezone.utc).isoformat()}", f"- 分析类型：{cfg['analysisType']}", f"- 分析结果：{cfg['resultId']}", f"- 图表类型：{chart}", '']
if chart_file is not None: lines += ['## 图表', '', f"![{cfg['title']}]({chart_file.name})", '']
summary_text = json.dumps(summary, ensure_ascii=False, indent=2, default=str).replace('\\n', '\\n    ')
lines += ['## 分析摘要', '', '    ' + summary_text, '']
if cfg['includeDataTable'] and df is not None: lines += ['## 数据预览', '', table_markdown(df, 20), '']
lines += ['## 使用说明', '', '- 本报告由固定分析模板生成，未执行用户提供的任意代码。', '- 图表最多使用前 ' + str(cfg['maxChartRows']) + ' 行分析结果。', '- 相关性与离群值属于分析线索，不代表确定因果关系。', '']
md_file = out_base.with_suffix('.md')
md_file.write_text('\\n'.join(lines), encoding='utf-8')
manifest = {'schemaVersion':'1.1','reportId':cfg['reportId'],'resultId':cfg['resultId'],'analysisType':cfg['analysisType'],'chartType':chart,'title':cfg['title'],'chartFontFamily':cjk_font,'markdownFile':str(md_file),'chartFile':None if chart_file is None else str(chart_file),'sourceSummaryFile':str(summary_path),'sourceCsvFile':str(csv_path) if csv_path.is_file() else None}
manifest_file = out_base.with_suffix('.report.json')
manifest_file.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\\n', encoding='utf-8')
files = [str(md_file), str(manifest_file)] + ([] if chart_file is None else [str(chart_file)])
print('__MCP_REPORT_RESULT__' + json.dumps({'manifest':manifest,'files':files}, ensure_ascii=False))`;
}

function parseReportResult(execution) {
  const text = execution.outputs.map((output) => output.text || "").join("\n");
  const marker = "__MCP_REPORT_RESULT__";
  const index = text.lastIndexOf(marker);
  if (index < 0) throw new DataToolError("SANDBOX_REPORT_RESULT_MISSING", "报告生成未返回可解析的结构化结果。", { status: execution.status, output: text.slice(-2000) });
  try { return JSON.parse(text.slice(index + marker.length).trim()); }
  catch { throw new DataToolError("SANDBOX_REPORT_RESULT_INVALID", "报告生成返回的结构化结果不是有效 JSON。"); }
}

export async function generateSandboxReport(input = {}) {
  const resultId = safeId(input.resultId, "resultId");
  const reportId = safeId(input.reportId || `${resultId}-report-${crypto.randomUUID().slice(0, 8)}`, "reportId");
  const analysisType = String(input.analysisType || "");
  const chartType = String(input.chartType || "auto");
  const summaryRead = await readPythonSandboxTextFile({ relativePath: `outputs/${resultId}.json`, maxCharacters: 1_000_000 });
  const summary = parseSummary(summaryRead.content, resultId);
  const config = validateConfig({ ...input, resultId, reportId, analysisType, chartType }, summary);
  const execution = await runPythonAnalysis({ code: enhancedPythonProgram(config), timeoutSeconds: input.timeoutSeconds || 90 });
  if (!execution.succeeded) throw new DataToolError("SANDBOX_REPORT_FAILED", "沙箱报告生成失败。", { status: execution.status, outputs: execution.outputs });
  const parsed = parseReportResult(execution);
  return {
    reportId, resultId, analysisType, chartType: parsed.manifest.chartType, title: parsed.manifest.title,
    sandboxFiles: parsed.files, report: parsed.manifest,
    execution: { status: execution.status, durationMs: execution.durationMs, kernelName: execution.kernelName, codeDigest: execution.codeDigest, outputTruncated: execution.outputTruncated },
    nextStep: "使用 download_python_sandbox_file 下载 Markdown、PNG 和 report.json 文件。",
  };
}

export const sandboxReportCapabilities = { analysisTypes: [...ANALYSIS_TYPES], chartTypes: [...CHART_TYPES] };
