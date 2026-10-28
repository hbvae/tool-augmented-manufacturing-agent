import crypto from "node:crypto";
import { DataToolError } from "./database.mjs";
import { readPythonSandboxTextFile, runPythonAnalysis } from "./aio_sandbox.mjs";

const ANALYSIS_TYPES = new Set(["profile", "group_summary", "trend", "correlation", "outlier"]);
const AGGREGATIONS = new Set(["sum", "mean", "min", "max", "median", "std", "count", "nunique"]);
const FREQUENCIES = new Set(["day", "week", "month", "quarter"]);
const OUTLIER_METHODS = new Set(["iqr", "zscore"]);

function safeId(value, label, max = 80) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(String(value || "")) || String(value).length > max) {
    throw new DataToolError("INVALID_SANDBOX_ANALYSIS_ID", `${label} 只能包含字母、数字、点、下划线和短横线，最长${max}个字符。`);
  }
  return String(value);
}

function loadManifest(text, datasetId) {
  let manifest;
  try { manifest = JSON.parse(text); }
  catch { throw new DataToolError("INVALID_DATASET_MANIFEST", "数据集来源清单不是有效 JSON。", { datasetId }); }
  if (manifest.datasetId !== datasetId || !Array.isArray(manifest.columns) || !manifest.file) {
    throw new DataToolError("INVALID_DATASET_MANIFEST", "数据集来源清单缺少必要字段或与 datasetId 不匹配。", { datasetId });
  }
  return manifest;
}

function validateColumns(requested, available, label, { required = false, maximum = 20 } = {}) {
  const values = [...new Set((requested || []).map(String))];
  if (required && !values.length) throw new DataToolError("MISSING_ANALYSIS_COLUMN", `${label} 至少需要一个字段。`);
  if (values.length > maximum) throw new DataToolError("TOO_MANY_ANALYSIS_COLUMNS", `${label} 最多允许 ${maximum} 个字段。`);
  const unknown = values.filter((value) => !available.has(value));
  if (unknown.length) throw new DataToolError("UNKNOWN_ANALYSIS_COLUMN", `${label} 包含数据集中不存在的字段。`, { unknown, available: [...available] });
  return values;
}

function validateRequest(input, manifest) {
  const available = new Set(manifest.columns.map((column) => column.name));
  if (!ANALYSIS_TYPES.has(input.analysisType)) throw new DataToolError("INVALID_ANALYSIS_TYPE", "不支持的数据集分析类型。");
  const config = {
    analysisType: input.analysisType,
    datasetId: input.datasetId,
    sourceFile: manifest.file,
    sourceFormat: manifest.format,
    resultBase: `/home/gem/workspace/outputs/${input.resultId}`,
    maxResultRows: Math.min(Math.max(Number(input.maxResultRows) || 500, 1), 500),
    groupBy: [], metrics: [], dateColumn: null, valueColumns: [], numericColumns: [],
    aggregation: input.aggregation || "sum", frequency: input.frequency || "month",
    outlierMethod: input.outlierMethod || "iqr", threshold: Number(input.threshold) || 3,
  };
  if (input.analysisType === "group_summary") {
    config.groupBy = validateColumns(input.groupBy, available, "groupBy", { required: true, maximum: 3 });
    if (!Array.isArray(input.metrics) || !input.metrics.length) throw new DataToolError("MISSING_ANALYSIS_METRICS", "group_summary 至少需要一个指标。");
    if (input.metrics.length > 10) throw new DataToolError("TOO_MANY_ANALYSIS_METRICS", "metrics 最多允许10项。");
    config.metrics = input.metrics.map((metric) => {
      const [field] = validateColumns([metric.field], available, "metrics.field", { required: true, maximum: 1 });
      if (!AGGREGATIONS.has(metric.aggregation)) throw new DataToolError("INVALID_ANALYSIS_AGGREGATION", `不支持聚合方式：${metric.aggregation}`);
      return { field, aggregation: metric.aggregation, alias: metric.alias || `${metric.aggregation}_${field}` };
    });
    if (new Set(config.metrics.map((metric) => metric.alias)).size !== config.metrics.length || config.metrics.some((metric) => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(metric.alias))) {
      throw new DataToolError("INVALID_ANALYSIS_ALIAS", "指标 alias 必须唯一，并使用字母、数字和下划线。");
    }
  }
  if (input.analysisType === "trend") {
    [config.dateColumn] = validateColumns([input.dateColumn], available, "dateColumn", { required: true, maximum: 1 });
    config.valueColumns = validateColumns(input.valueColumns, available, "valueColumns", { required: true, maximum: 10 });
    if (!AGGREGATIONS.has(config.aggregation)) throw new DataToolError("INVALID_ANALYSIS_AGGREGATION", `不支持聚合方式：${config.aggregation}`);
    if (!FREQUENCIES.has(config.frequency)) throw new DataToolError("INVALID_TREND_FREQUENCY", "frequency 必须是 day、week、month 或 quarter。");
  }
  if (input.analysisType === "correlation") {
    config.numericColumns = validateColumns(input.numericColumns, available, "numericColumns", { maximum: 20 });
    config.correlationMethod = input.correlationMethod || "pearson";
    if (!new Set(["pearson", "spearman"]).has(config.correlationMethod)) throw new DataToolError("INVALID_CORRELATION_METHOD", "correlationMethod 必须是 pearson 或 spearman。");
  }
  if (input.analysisType === "outlier") {
    config.numericColumns = validateColumns(input.numericColumns, available, "numericColumns", { required: true, maximum: 10 });
    if (!OUTLIER_METHODS.has(config.outlierMethod)) throw new DataToolError("INVALID_OUTLIER_METHOD", "outlierMethod 必须是 iqr 或 zscore。");
    if (!(config.threshold > 0 && config.threshold <= 20)) throw new DataToolError("INVALID_OUTLIER_THRESHOLD", "threshold 必须大于0且不超过20。");
  }
  return config;
}

function pythonProgram(config) {
  const encoded = Buffer.from(JSON.stringify(config), "utf8").toString("base64");
  return `import base64, json, math\nfrom pathlib import Path\nimport numpy as np\nimport pandas as pd\n\ncfg = json.loads(base64.b64decode('${encoded}').decode('utf-8'))\nsource = Path(cfg['sourceFile'])\nif not source.is_file():\n    raise FileNotFoundError(f'Dataset not found: {source}')\nif cfg['sourceFormat'] == 'json':\n    df = pd.read_json(source)\nelse:\n    df = pd.read_csv(source)\n\ndef scalar(v):\n    if v is None or (isinstance(v, float) and (math.isnan(v) or math.isinf(v))):\n        return None\n    if isinstance(v, (np.integer,)): return int(v)\n    if isinstance(v, (np.floating,)): return float(v)\n    if isinstance(v, (np.bool_,)): return bool(v)\n    if isinstance(v, (pd.Timestamp, np.datetime64)): return str(v)\n    return v\n\ndef records(frame, limit=20):\n    return [{str(k): scalar(v) for k, v in row.items()} for row in frame.head(limit).to_dict(orient='records')]\n\ndef numeric_frame(columns):\n    chosen = columns or list(df.select_dtypes(include='number').columns)\n    if not chosen:\n        raise ValueError('No numeric columns available for this analysis')\n    converted = df[chosen].apply(pd.to_numeric, errors='coerce')\n    return chosen, converted\n\nkind = cfg['analysisType']\nresult_frame = None\nif kind == 'profile':\n    cols = []\n    for name in df.columns:\n        series = df[name]\n        numeric = pd.to_numeric(series, errors='coerce')\n        numeric_count = int(numeric.notna().sum())\n        item = {'name': str(name), 'dtype': str(series.dtype), 'null_count': int(series.isna().sum()), 'null_rate': float(series.isna().mean()), 'unique_count': int(series.nunique(dropna=True))}\n        if numeric_count:\n            item.update({'numeric_count': numeric_count, 'min': scalar(numeric.min()), 'max': scalar(numeric.max()), 'mean': scalar(numeric.mean()), 'median': scalar(numeric.median())})\n        cols.append(item)\n    summary = {'row_count': int(len(df)), 'column_count': int(len(df.columns)), 'columns': cols}\nelif kind == 'group_summary':\n    named = {m['alias']: pd.NamedAgg(column=m['field'], aggfunc=m['aggregation']) for m in cfg['metrics']}\n    result_frame = df.groupby(cfg['groupBy'], dropna=False).agg(**named).reset_index().head(cfg['maxResultRows'])\n    summary = {'group_count': int(len(result_frame)), 'preview': records(result_frame)}\nelif kind == 'trend':\n    working = df[[cfg['dateColumn']] + cfg['valueColumns']].copy()\n    working[cfg['dateColumn']] = pd.to_datetime(working[cfg['dateColumn']], errors='coerce')\n    working = working.dropna(subset=[cfg['dateColumn']])\n    for col in cfg['valueColumns']: working[col] = pd.to_numeric(working[col], errors='coerce')\n    freq = {'day':'D','week':'W','month':'MS','quarter':'QS'}[cfg['frequency']]\n    result_frame = working.set_index(cfg['dateColumn'])[cfg['valueColumns']].resample(freq).agg(cfg['aggregation']).reset_index().head(cfg['maxResultRows'])\n    summary = {'period_count': int(len(result_frame)), 'frequency': cfg['frequency'], 'preview': records(result_frame)}\nelif kind == 'correlation':\n    chosen, numeric = numeric_frame(cfg['numericColumns'])\n    result_frame = numeric.corr(method=cfg['correlationMethod']).reset_index().rename(columns={'index':'field'})\n    summary = {'method': cfg['correlationMethod'], 'columns': chosen, 'matrix': records(result_frame, 20)}\nelif kind == 'outlier':\n    chosen, numeric = numeric_frame(cfg['numericColumns'])\n    flags = pd.DataFrame(False, index=df.index, columns=chosen)\n    bounds = {}\n    for col in chosen:\n        series = numeric[col]\n        if cfg['outlierMethod'] == 'iqr':\n            q1, q3 = series.quantile(0.25), series.quantile(0.75)\n            iqr = q3 - q1\n            low, high = q1 - cfg['threshold'] * iqr, q3 + cfg['threshold'] * iqr\n        else:\n            mean, std = series.mean(), series.std(ddof=0)\n            low, high = mean - cfg['threshold'] * std, mean + cfg['threshold'] * std\n        bounds[col] = {'lower': scalar(low), 'upper': scalar(high)}\n        flags[col] = (series < low) | (series > high)\n    mask = flags.any(axis=1)\n    result_frame = df.loc[mask].copy().head(cfg['maxResultRows'])\n    result_frame['_outlier_fields'] = flags.loc[mask].head(cfg['maxResultRows']).apply(lambda row: ','.join(row.index[row]), axis=1)\n    summary = {'method': cfg['outlierMethod'], 'threshold': cfg['threshold'], 'outlier_count': int(mask.sum()), 'bounds': bounds, 'preview': records(result_frame)}\nelse:\n    raise ValueError(f'Unsupported analysis type: {kind}')\n\nout_base = Path(cfg['resultBase'])\nout_base.parent.mkdir(parents=True, exist_ok=True)\njson_file = out_base.with_suffix('.json')\njson_file.write_text(json.dumps(summary, ensure_ascii=False, indent=2, default=str) + '\\n', encoding='utf-8')\nfiles = [str(json_file)]\nif result_frame is not None:\n    csv_file = out_base.with_suffix('.csv')\n    result_frame.to_csv(csv_file, index=False)\n    files.append(str(csv_file))\nprint('__MCP_ANALYSIS_RESULT__' + json.dumps({'summary': summary, 'files': files}, ensure_ascii=False, default=str))`;
}

function parseAnalysisResult(execution) {
  const text = execution.outputs.map((output) => output.text || "").join("\n");
  const marker = "__MCP_ANALYSIS_RESULT__";
  const index = text.lastIndexOf(marker);
  if (index < 0) {
    throw new DataToolError("SANDBOX_ANALYSIS_RESULT_MISSING", "Python 分析未返回可解析的结构化结果。", { status: execution.status, output: text.slice(-2000) });
  }
  try { return JSON.parse(text.slice(index + marker.length).trim()); }
  catch { throw new DataToolError("SANDBOX_ANALYSIS_RESULT_INVALID", "Python 分析返回的结构化结果不是有效 JSON。"); }
}

export async function analyzeSandboxDataset(input = {}) {
  const datasetId = safeId(input.datasetId, "datasetId");
  const resultId = safeId(input.resultId || `${datasetId}-${input.analysisType}-${crypto.randomUUID().slice(0, 8)}`, "resultId");
  const manifestRead = await readPythonSandboxTextFile({ relativePath: `datasets/${datasetId}.manifest.json`, maxCharacters: 500_000 });
  const manifest = loadManifest(manifestRead.content, datasetId);
  const config = validateRequest({ ...input, datasetId, resultId }, manifest);
  const execution = await runPythonAnalysis({ code: pythonProgram(config), timeoutSeconds: input.timeoutSeconds || 60 });
  if (!execution.succeeded) {
    throw new DataToolError("SANDBOX_ANALYSIS_FAILED", "沙箱数据分析执行失败。", { status: execution.status, outputs: execution.outputs });
  }
  const parsed = parseAnalysisResult(execution);
  return {
    datasetId,
    analysisType: input.analysisType,
    resultId,
    summary: parsed.summary,
    sandboxFiles: parsed.files,
    source: {
      dataFile: manifest.file,
      manifestFile: manifestRead.file,
      rowCount: manifest.rowCount,
      columns: manifest.columns.map((column) => column.name),
      sha256: manifest.sha256,
      table: manifest.source?.table ?? null,
    },
    execution: {
      status: execution.status,
      durationMs: execution.durationMs,
      kernelName: execution.kernelName,
      codeDigest: execution.codeDigest,
      outputTruncated: execution.outputTruncated,
    },
    dataQualityNotes: manifest.dataQualityNotes || [],
    nextStep: "如需取回完整结果，请对 sandboxFiles 中的文件调用 download_python_sandbox_file。",
  };
}

export const sandboxAnalysisCapabilities = {
  analysisTypes: [...ANALYSIS_TYPES], aggregations: [...AGGREGATIONS], frequencies: [...FREQUENCIES], outlierMethods: [...OUTLIER_METHODS],
};
