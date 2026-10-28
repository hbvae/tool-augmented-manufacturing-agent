from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse


STATUS_COMPLETE = "complete"
STATUS_PARTIAL = "partial"
STATUS_FAILED = "failed"
EVIDENCE_COMPLETE = "complete"
EVIDENCE_PARTIAL = "partial"
EVIDENCE_INSUFFICIENT = "insufficient"

MACHINE_PATTERN = re.compile(r"(?<![A-Za-z0-9])M\d{2}(?![A-Za-z0-9])", re.IGNORECASE)
PRODUCT_PATTERN = re.compile(r"(?<![A-Za-z0-9])P\d{3}(?![A-Za-z0-9])", re.IGNORECASE)
SUPPLIER_PATTERN = re.compile(r"(?<![A-Za-z0-9])S\d{3}(?![A-Za-z0-9])", re.IGNORECASE)
I01_ALLOWED_TOP3_ORDERS = (("M03", "M07", "M08"), ("M07", "M03", "M08"))
I01_RISK_FORMULA = {
    "scrap_rate_above": 0.03,
    "quality_fail_rate_above": 0.10,
    "unplanned_downtime_min_above": 600,
    "availability_below": 0.90,
    "oee_below": 0.85,
    "kwh_per_runtime_hour_above": 25,
    "points_per_trigger": 1,
}
MONTH_PATTERN = re.compile(
    r"(?:20\d{2}[-年/.](?:0?[1-9]|1[0-2])(?:月)?|(?:1[0-2]|0?[1-9])月|"
    r"\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
    r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b)",
    re.IGNORECASE,
)
DATE_RANGE_PATTERN = re.compile(
    r"(?:"
    # Explicit ranges, including year-only wording such as “2024年至2025年初”.
    r"20\d{2}(?:[-年/.]\d{1,2}(?:[-月/.]\d{1,2})?)?年?(?:初|中|末|底)?"
    r".{0,20}?(?:至|到|—|–|~|～|\bto\b).{0,20}?"
    r"20\d{2}(?:[-年/.]\d{1,2}(?:[-月/.]\d{1,2})?)?年?(?:初|中|末|底)?|"
    # Labelled ranges and knowledge cut-offs used in research answers.
    r"(?:数据|资料|统计|时间|知识|信息|报告|分析).{0,16}?"
    r"(?:范围|期间|时段|基准|截至|截止|覆盖(?:至|到)?).{0,48}?20\d{2}|"
    # Natural cut-off wording such as “主要覆盖到2024年” or “截至2024年”.
    r"(?:截至|截止|覆盖至|覆盖到).{0,8}?20\d{2}|"
    # Machine-readable and labelled cut-off dates returned by governed tools.
    r"(?:asOfDate|as[-_ ]?of|截至日期|截止日期|基准日期)\s*[:=：]?\s*20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}"
    r")",
    re.IGNORECASE,
)
UNKNOWN_DATE_RANGE_DISCLOSURE_PATTERN = re.compile(
    r"(?:数据|资料|统计|时间|知识|信息|报告|分析).{0,24}?"
    r"(?:"
    r"(?:时间范围|起止日期|日期范围|覆盖期间|dataTimeRange).{0,100}?"
    r"(?:未返回|未提供|未记录|未知|不明确|未能确认|无法(?:界定|确定|识别|获取)|不可(?:界定|确定|获得)|为空|null)|"
    r"(?:未返回|未提供|未记录|未知|不明确|未能确认|无法(?:界定|确定|识别|获取)|不可(?:界定|确定|获得)|为空|null)"
    r".{0,100}?(?:时间范围|起止日期|日期范围|覆盖期间|dataTimeRange)"
    r")",
    re.IGNORECASE | re.DOTALL,
)
ANSWER_URL_PATTERN = re.compile(r"https?://[^\s\]\[()<>{}\"'`\\，。；：！？、）】》」』]+", re.IGNORECASE)
SOURCE_CATEGORY_PATTERNS: dict[str, re.Pattern[str]] = {
    "manufacturer": re.compile(r"(?:设备)?厂商|制造商|OEM|原厂|官方(?:资料|手册|说明书)", re.IGNORECASE),
    "research": re.compile(r"专利|论文|期刊|会议论文|研究文献|\bDOI\b", re.IGNORECASE),
    "maintenance": re.compile(r"维修(?:技术)?资料|维护(?:技术)?资料|维修手册|检修资料|故障排查资料", re.IGNORECASE),
}
SOURCE_CATEGORY_LABELS = {
    "manufacturer": "设备厂商资料",
    "research": "专利或论文",
    "maintenance": "维修技术资料",
}
SOURCE_CATEGORY_SHORTFALL_PATTERNS: dict[str, re.Pattern[str]] = {
    "manufacturer": re.compile(
        r"(?:厂商|制造商|OEM|原厂|官方).{0,24}?(?:证据不足|缺失|没有|无(?:可用|正规)?|未(?:取得|获得|检索到|提供))|"
        r"(?:未(?:取得|获得|检索到)|没有|无(?:可用|正规)?).{0,40}?(?:厂商|制造商|OEM|原厂|官方).{0,20}?(?:资料|手册|原文)",
        re.IGNORECASE | re.DOTALL,
    ),
    "research": re.compile(
        r"(?:未(?:取得|获得|检索到)|没有|无(?:可用)?).{0,30}?"
        r"(?:专利(?:或|、|和)论文|论文(?:或|、|和)专利|研究文献).{0,12}?(?:原文|证据)?",
        re.IGNORECASE | re.DOTALL,
    ),
    "maintenance": re.compile(
        r"(?:未(?:取得|获得|检索到)|没有|无(?:可用|正规)?).{0,30}?(?:任何|可用的)?(?:维修|维护|检修).{0,12}?(?:资料|手册|原文)|"
        r"(?:维修|维护|检修).{0,12}?(?:资料|手册|原文).{0,12}?(?:缺失|证据不足)",
        re.IGNORECASE | re.DOTALL,
    ),
}
SOURCE_CATEGORY_POSITIVE_PATTERNS: dict[str, re.Pattern[str]] = {
    "manufacturer": re.compile(
        r"(?:厂商|制造商|OEM|原厂|官方).{0,30}?(?:手册|指南|说明书|资料).{0,16}?(?:指出|要求|规定|建议|说明|给出|提供)|"
        r"(?:手册|指南|说明书|资料).{0,16}?(?:指出|要求|规定|建议|说明|给出|提供)|"
        r"(?:厂商侧|设备厂商资料|制造商资料|原厂资料|官方资料).{0,120}?"
        r"(?:提供|支持|说明|介绍|指出|要求|建议|用于)",
        re.IGNORECASE,
    ),
    "research": re.compile(
        r"doi\.org|patents?\.|(?:专利|论文|期刊|会议论文|研究文献).{0,32}?"
        r"(?:表明|指出|发现|研究|分析|显示|支持|提供|采用|用于|可作为.{0,8}?依据)",
        re.IGNORECASE,
    ),
    "maintenance": re.compile(
        r"(?:维修|维护|检修|故障排查).{0,20}?(?:资料|手册|指南|方法|步骤|流程).{0,16}?(?:指出|要求|规定|建议|说明|给出|提供)|"
        r"(?:维修|维护|检修|故障排查)(?:资料|手册|指南).{0,16}?(?:指出|要求|规定|建议|说明|给出|提供)",
        re.IGNORECASE,
    ),
}
LOW_AUTHORITY_SOURCE_DOMAINS = frozenset({
    "baidu.com", "baijiahao.baidu.com", "zhihu.com", "sohu.com", "163.com", "csdn.net",
    "alibaba.com", "1688.com", "made-in-china.com", "11467.com", "book118.com", "doc88.com",
    "wenku.baidu.com", "mp.weixin.qq.com", "autohome.com.cn",
})
RESEARCH_SOURCE_DOMAINS = frozenset({
    "doi.org", "ieee.org", "asme.org", "springer.com", "sciencedirect.com", "elsevier.com",
    "wiley.com", "tandfonline.com", "arxiv.org", "semanticscholar.org", "cnki.net",
    "cnki.com.cn", "wanfangdata.com", "ci.nii.ac.jp", "patents.google.com", "patentscope.wipo.int",
})
MANUFACTURER_SOURCE_DOMAINS = frozenset({
    "haascnc.com", "fanuc.com", "fanuc.eu", "siemens.com", "mitsubishielectric.com",
    "dmgmori.com", "mazak.com", "okuma.com", "skf.com", "schaeffler.com", "nsk.com",
    "ntnamericas.com", "sandvik.coromant.com", "fischerspindle.com", "gmnbt.com",
    "ibag.com", "setco.com", "westwind-air-bearing.com",
})
FORMAL_MAINTENANCE_CONTEXT_RE = re.compile(
    r"\b(?:service|repair|maintenance|troubleshooting|workshop)[-\s]+"
    r"(?:manual|handbook|guide|procedure|instruction|bulletin)\b|"
    r"\b(?:manual|handbook|guide|procedure|instruction|bulletin)[-\s]+"
    r"(?:service|repair|maintenance|troubleshooting)\b|"
    r"维修手册|维护手册|检修规程|维修规程|故障排查指南|维护指南|维修技术公告|"
    r"/(?:[a-z0-9_-]*[-_])?(?:manual|handbook|guide|procedure|bulletin)\b",
    re.IGNORECASE,
)
INTERNAL_SECTION_LABEL_RE = re.compile(r"内部.{0,12}?(?:数据|证据|分析|来源)", re.IGNORECASE)
EXTERNAL_SECTION_LABEL_RE = re.compile(r"外部.{0,12}?(?:资料|证据|来源|方法)", re.IGNORECASE)
NON_EVIDENCE_TOOLS = {
    "get_dataset_info",
    "list_tables",
    "describe_table",
    "list_metric_definitions",
    "get_metric_definition",
    "get_security_status",
    "get_embedding_status",
    "get_python_sandbox_status",
}


@dataclass(frozen=True)
class TaskContract:
    task_id: str
    min_answer_chars: int = 300
    min_urls: int = 0
    min_independent_domains: int = 0
    official_domains: tuple[str, ...] = ()
    min_official_urls: int = 0
    required_entities: tuple[str, ...] = ()
    min_machine_ids: int = 0
    min_product_ids: int = 0
    min_supplier_ids: int = 0
    required_term_groups: tuple[tuple[str, ...], ...] = ()
    require_date_range: bool = False
    min_time_points: int = 0
    required_artifact_extensions: tuple[str, ...] = ()
    require_verified_artifacts: bool = False
    require_internal_external_labels: bool = False
    required_source_categories: tuple[str, ...] = ()
    notes: tuple[str, ...] = ()


def _groups(*groups: Iterable[str]) -> tuple[tuple[str, ...], ...]:
    return tuple(tuple(group) for group in groups)


def _matches_required_term(answer_lower: str, term: str) -> bool:
    """Match a required concept without depending on one exact phrase."""
    normalized = term.lower().strip()
    if normalized in answer_lower:
        return True
    # Chinese headings often insert short qualifiers: “相关高风险设备”
    # still covers “相关设备”, and “备选与缓解措施” covers “备选措施”.
    if len(normalized) >= 4 and re.fullmatch(r"[\u4e00-\u9fff]+", normalized):
        return bool(re.search(
            rf"{re.escape(normalized[:2])}[\u4e00-\u9fff]{{0,8}}{re.escape(normalized[-2:])}",
            answer_lower,
        ))
    return False


TASK_CONTRACTS: dict[str, TaskContract] = {
    "E01": TaskContract("E01", min_urls=3, min_independent_domains=3, require_date_range=True,
                        required_term_groups=_groups(("产量", "销量"), ("渗透率",), ("出口",), ("电池",), ("政策",))),
    "E02": TaskContract("E02", min_urls=3, min_independent_domains=3,
                        required_term_groups=_groups(("磷酸铁锂", "LFP"), ("三元锂", "NCM", "NCA"), ("钠离子",), ("固态",),
                                                     ("实验室",), ("中试",), ("装车",), ("量产",))),
    "E03": TaskContract("E03", min_urls=3, min_independent_domains=3,
                        official_domains=("europa.eu", "eur-lex.europa.eu"), min_official_urls=1, require_date_range=True,
                        required_term_groups=_groups(("电池护照",), ("碳足迹",), ("尽职调查",), ("再生材料",))),
    "E04": TaskContract("E04", min_urls=3, min_independent_domains=3,
                        required_term_groups=_groups(("宣传", "展示"), ("试验", "试点"), ("小批量",), ("规模化",), ("商业回报", "ROI"))),
    "E05": TaskContract("E05", min_urls=3, min_independent_domains=3,
                        required_term_groups=_groups(("振动",), ("温度",), ("电流",), ("声学",), ("多模态",),
                                                     ("标准",), ("论文",), ("厂商", "制造商", "OEM"))),
    "E06": TaskContract("E06", min_urls=3, min_independent_domains=3,
                        required_source_categories=("manufacturer", "research", "maintenance"),
                        required_term_groups=_groups(("安全停机", "停机"), ("外观检查",), ("振动",), ("温度",), ("拆检",),
                                                     ("专业人员", "授权人员"))),
    "E07": TaskContract("E07", min_urls=3, min_independent_domains=3,
                        official_domains=("europa.eu",), min_official_urls=1, require_date_range=True,
                        required_term_groups=_groups(("已经生效", "已生效", "正式阶段"), ("未来", "计划", "提案"), ("钢铁",), ("铝",), ("汽车零部件",))),
    "E08": TaskContract("E08", min_urls=2, min_independent_domains=2,
                        required_term_groups=_groups(("OPC UA",), ("MQTT",), ("Sparkplug",), ("实时性",), ("语义",), ("安全",), ("成本",))),
    "I01": TaskContract("I01", min_machine_ids=3, require_date_range=True,
                        required_term_groups=_groups(("生产",), ("质量",), ("停机",), ("能耗",), ("维护",),
                                                     ("风险分数", "风险评分", "risk_score", "触发项"),
                                                     ("可能原因", "假设", "候选原因")),
                        notes=("综合风险分数为六项阈值触发数，每项1分；M03与M07并列第一，M08第三。",)),
    "I02": TaskContract("I02", required_entities=("M03", "M07"), require_date_range=True, min_time_points=3,
                        required_term_groups=_groups(("月度", "月份"), ("产量",), ("完成率",), ("报废率",), ("质量",),
                                                     ("停机",), ("OEE",), ("单位产量能耗", "单位良品能耗", "单位能耗"))),
    "I03": TaskContract("I03", min_machine_ids=1, require_date_range=True,
                        required_term_groups=_groups(("根因候选", "候选原因"),
                                                     ("支持证据", "支持依据", "正向证据", "关键数据", "支持 vs 反对",
                                                      "支持/反对", "逐项证据评估"),
                                                     ("反对证据", "不支持证据", "反对依据", "局限"),
                                                     ("质量缺陷", "缺陷"), ("停机原因", "停机"), ("生产节拍", "节拍"),
                                                     ("设备状态", "设备侧", "设备运行", "可用率", "OEE", "故障"))),
    "I04": TaskContract("I04", min_supplier_ids=1, require_date_range=True,
                        required_term_groups=_groups(("供应商质量", "来料质量", "检验"), ("交付",), ("库存",),
                                                     ("缺料", "短缺", "覆盖天数"), ("优先", "排序"))),
    "I05": TaskContract("I05", min_machine_ids=8, require_date_range=True, min_time_points=6,
                        required_term_groups=_groups(("月度", "月份"), ("能耗", "kWh"), ("峰值功率", "kW"), ("运行时间",),
                                                     ("产量",), ("良品", "合格品"), ("单位合格品能耗", "单位良品能耗", "kWh/件"))),
    "I06": TaskContract("I06", min_product_ids=1, require_date_range=True,
                        required_term_groups=_groups(("产量",), ("报废",), ("质量缺陷", "缺陷"), ("库存",), ("设备依赖", "相关设备"))),
    "I07": TaskContract("I07", require_date_range=True, min_time_points=3,
                        required_term_groups=_groups(("规则异常",), ("统计异常",), ("趋势异常",),
                                                     ("共同异常", "共同领域", "三方法共同", "三者共同", "唯一交集"),
                                                     ("独有异常", "独有发现", "独有领域", "规则法独有", "规则独有",
                                                      "统计法独有", "统计独有", "趋势法独有", "趋势独有", "仅规则",
                                                      "方法差集", "差集"),
                                                     ("时间序列", "环比", "趋势",))),
    "I08": TaskContract("I08", required_entities=("M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08"), require_date_range=True,
                        required_term_groups=_groups(("实际产量",), ("合格数量", "良品数量"), ("报废数量",), ("报废率",),
                                                     ("指标定义",), ("来源表",), ("筛选条件",), ("数据质量",)),
                        required_artifact_extensions=(".png", ".md"), require_verified_artifacts=True),
    "H01": TaskContract("H01", min_urls=3, min_independent_domains=3, min_machine_ids=1, require_date_range=True,
                        require_internal_external_labels=True,
                        required_term_groups=_groups(("内部证据",), ("外部证据",), ("验证步骤", "排查步骤"))),
    "H02": TaskContract("H02", min_urls=2, min_independent_domains=2, required_entities=("M07",), require_date_range=True,
                        require_internal_external_labels=True,
                        required_term_groups=_groups(("根因候选", "候选原因"), ("排查清单", "排查步骤"), ("内部数据", "内部证据"), ("外部资料", "外部证据"))),
    "H03": TaskContract("H03", min_urls=2, min_independent_domains=2, min_machine_ids=1, require_date_range=True,
                        require_internal_external_labels=True,
                         required_term_groups=_groups(
                             ("缺陷类型",), ("短期遏制",), ("原因验证",),
                             ("长期改善", "长期纠正措施", "永久纠正措施", "防止再发", "D5", "D6", "D7"),
                         )),
    "H04": TaskContract("H04", min_urls=1, min_independent_domains=1, min_machine_ids=1, require_date_range=True,
                        official_domains=("iso.org",), min_official_urls=1, require_internal_external_labels=True,
                        required_term_groups=_groups(("能源效率", "单位良品能耗", "单位能耗"), ("ISO 50001",), ("传感器", "测量"))),
    "H05": TaskContract("H05", min_urls=2, min_independent_domains=2, min_machine_ids=1, require_date_range=True,
                        require_internal_external_labels=True,
                        required_term_groups=_groups(("传感器",), ("采样指标", "采样"), ("报警逻辑", "报警"), ("验证方法", "验证"))),
    "H06": TaskContract("H06", min_urls=2, min_independent_domains=2, min_supplier_ids=1, require_date_range=True,
                        require_internal_external_labels=True,
                        required_term_groups=_groups(("收货",), ("来料质量", "检验"), ("交付",), ("供应品类", "物料类别", "品类"),
                                                     ("审核重点", "供应商审核"), ("备选措施", "替代措施"))),
    "H07": TaskContract("H07", min_urls=2, min_independent_domains=2, require_date_range=True,
                        require_internal_external_labels=True,
                        required_term_groups=_groups(("覆盖天数",), ("无消耗", "积压"), ("供应商依赖",),
                                                     ("内部已经证实", "内部证据"), ("潜在风险", "外部环境"))),
    "H08": TaskContract("H08", min_urls=3, min_independent_domains=3, require_date_range=True,
                        require_internal_external_labels=True,
                        required_term_groups=_groups(("生产",), ("质量",), ("设备",), ("能耗",), ("供应商",), ("库存",),
                                                     ("新能源汽车",), ("智能制造",), ("机会",), ("风险",))),
}


def _issue(code: str, message: str, scope: str, severity: str = "error", details: dict[str, Any] | None = None) -> dict[str, Any]:
    value: dict[str, Any] = {"code": code, "message": message, "scope": scope, "severity": severity}
    if details:
        value["details"] = details
    return value


def _domain(url: str) -> str:
    host = (urlparse(url).hostname or "").lower().removeprefix("www.")
    return host


def _matches_domain(host: str, expected: str) -> bool:
    expected = expected.lower().removeprefix("www.")
    return host == expected or host.endswith("." + expected)


def _unique_matches(pattern: re.Pattern[str], answer: str) -> set[str]:
    return {match.upper() for match in pattern.findall(answer)}


def _artifact_extensions(artifacts: Iterable[dict[str, Any]], *, verified_only: bool) -> set[str]:
    extensions: set[str] = set()
    for artifact in artifacts:
        if verified_only and not artifact.get("verified"):
            continue
        extension = str(artifact.get("extension") or "").lower()
        if not extension:
            extension = Path(str(artifact.get("path") or "")).suffix.lower()
        if extension:
            extensions.add(extension)
    return extensions


def _i08_artifact_issues(artifacts: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Verify the downloaded Markdown itself contains the requested governed report."""
    markdown_paths = [
        Path(str(item.get("path") or ""))
        for item in artifacts
        if item.get("verified") and str(item.get("extension") or Path(str(item.get("path") or "")).suffix).lower() == ".md"
    ]
    existing = [path for path in markdown_paths if path.is_file()]
    if not existing:
        return []  # REQUIRED_ARTIFACT_MISSING reports this separately.
    try:
        content = existing[0].read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        return [_issue("ARTIFACT_CONTENT_UNREADABLE", "无法读取 I08 Markdown 交付文件。", "completion", details={"error": str(error)})]
    issues: list[dict[str, Any]] = []
    required_sections = {
        "数据范围": ("数据范围", "时间范围"),
        "指标定义": ("指标定义", "指标口径"),
        "来源表": ("来源表", "数据源"),
        "筛选条件": ("筛选条件", "过滤条件"),
        "数据质量提示": ("数据质量提示", "数据质量说明"),
    }
    missing_sections = [
        label for label, alternatives in required_sections.items()
        if not any(re.search(rf"^#{{1,6}}\s*{re.escape(term)}(?:\s|$)", content, re.MULTILINE) for term in alternatives)
    ]
    required_fields = {
        "实际产量": ("实际产量", "total_actual", "actual_qty"),
        "合格数量": ("合格数量", "良品数量", "total_good", "good_qty"),
        "报废数量": ("报废数量", "total_scrap", "scrap_qty"),
        "报废率": ("报废率", "scrap_rate"),
    }
    table_headers = [line for line in content.splitlines() if line.lstrip().startswith("|")]
    missing_fields = [label for label, alternatives in required_fields.items() if not any(any(term.lower() in line.lower() for term in alternatives) for line in table_headers)]
    if missing_sections:
        issues.append(_issue("ARTIFACT_REQUIRED_SECTION_MISSING", "Markdown 交付文件缺少必需审计章节。", "completion",
                             details={"path": str(existing[0]), "missing": missing_sections}))
    if missing_fields:
        issues.append(_issue("ARTIFACT_REQUIRED_METRIC_MISSING", "Markdown 交付文件缺少必需指标。", "completion",
                             details={"path": str(existing[0]), "missing": missing_fields}))
    return issues


def _i08_range_consistency_issues(answer: str) -> list[dict[str, Any]]:
    """Cross-check a narrated 'other machines' percentage range against the detail table."""
    range_match = re.search(r"其余.{0,40}?(\d+(?:\.\d+)?)%\s*[—–~～至到-]\s*(\d+(?:\.\d+)?)%", answer, re.DOTALL)
    if not range_match:
        return []
    rates: list[tuple[str, float]] = []
    lines = answer.splitlines()
    for index in range(len(lines) - 1):
        if "|" not in lines[index] or "|" not in lines[index + 1] or "---" not in lines[index + 1]:
            continue
        headers = [_clean_cell(cell) for cell in lines[index].strip().strip("|").split("|")]
        machine_col = _find_column(headers, ("设备", "machine"))
        rate_col = _find_column(headers, ("报废率", "scrap_rate", "scraprate"))
        if machine_col is None or rate_col is None:
            continue
        for candidate in lines[index + 2:]:
            if "|" not in candidate:
                break
            cells = [_clean_cell(cell) for cell in candidate.strip().strip("|").split("|")]
            if len(cells) <= max(machine_col, rate_col):
                continue
            machine = MACHINE_PATTERN.search(cells[machine_col])
            rate = _parse_number(cells[rate_col])
            if machine and rate is not None:
                rates.append((machine.group(0).upper(), rate))
        if rates:
            break
    if len(rates) < 3:
        return []
    outlier_machine, _ = max(rates, key=lambda item: item[1])
    remaining = [rate for machine, rate in rates if machine != outlier_machine]
    actual_low, actual_high = min(remaining), max(remaining)
    reported_low, reported_high = float(range_match.group(1)), float(range_match.group(2))
    if abs(reported_low - actual_low) > 0.011 or abs(reported_high - actual_high) > 0.011:
        return [_issue("NARRATIVE_RANGE_MISMATCH", "摘要中的其余设备报废率区间与明细表不一致。", "completion",
                       details={"reportedPct": [reported_low, reported_high], "calculatedPct": [actual_low, actual_high], "excludedOutlier": outlier_machine})]
    return []


def _i04_superlative_issues(answer: str) -> list[dict[str, Any]]:
    claims: set[str] = set()
    current_supplier: str | None = None
    for line in answer.splitlines():
        supplier_matches = list(SUPPLIER_PATTERN.finditer(line))
        suppliers = {match.group(0).upper() for match in supplier_matches}
        if len(suppliers) == 1:
            current_supplier = next(iter(suppliers))
        claim_match = re.search(r"(?:采购金额|采购额).{0,20}?(?:最高|最大)|(?:最高|最大).{0,20}?(?:采购金额|采购额)", line)
        if claim_match:
            if supplier_matches:
                nearest = min(supplier_matches, key=lambda match: min(abs(match.start() - claim_match.end()), abs(match.end() - claim_match.start())))
                claims.add(nearest.group(0).upper())
            elif current_supplier:
                claims.add(current_supplier)
    if len(claims) > 1:
        return [_issue("CONTRADICTORY_SUPERLATIVE", "多个供应商同时被描述为采购金额最高，排序结论自相矛盾。", "completion",
                       details={"suppliers": sorted(claims)})]
    return []


def _successful_substantive_tools(tool_calls: Iterable[dict[str, Any]]) -> list[str]:
    names: list[str] = []
    for call in tool_calls:
        status = str(call.get("status") or "").lower()
        name = str(call.get("name") or "")
        if status in {"success", "completed"} and name and name not in NON_EVIDENCE_TOOLS:
            names.append(name)
    return names


def _clean_cell(value: str) -> str:
    return re.sub(r"[*_`]", "", value).strip()


def _parse_number(value: str) -> float | None:
    cleaned = _clean_cell(value).replace(",", "").replace("，", "").replace("%", "").strip()
    match = re.search(r"-?\d+(?:\.\d+)?", cleaned)
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def _find_column(headers: list[str], alternatives: tuple[str, ...]) -> int | None:
    for index, header in enumerate(headers):
        normalized = header.lower().replace(" ", "")
        if any(term.lower().replace(" ", "") in normalized for term in alternatives):
            return index
    return None


def _source_category_issues(answer: str, required_categories: Iterable[str]) -> list[dict[str, Any]]:
    """Require each source URL to be locally and affirmatively bound to its class."""
    # A whole Markdown paragraph may contain several numbered source categories.
    # Audit the physical line surrounding each URL so an unrelated URL elsewhere
    # in the same list cannot satisfy a missing manufacturer/maintenance source.
    url_contexts: list[tuple[str, str]] = []
    for match in ANSWER_URL_PATTERN.finditer(answer):
        start = answer.rfind("\n", 0, match.start()) + 1
        end = answer.find("\n", match.end())
        if end < 0:
            end = len(answer)
        url_contexts.append((answer[start:end].strip(), match.group(0).rstrip(".,;:!?")))
    issues: list[dict[str, Any]] = []
    for category in required_categories:
        marker = SOURCE_CATEGORY_PATTERNS.get(category)
        if marker is None:
            continue
        matching = [(context, url) for context, url in url_contexts if marker.search(context)]
        shortfall = SOURCE_CATEGORY_SHORTFALL_PATTERNS.get(category)
        positive = SOURCE_CATEGORY_POSITIVE_PATTERNS.get(category)
        usable = []
        for context, url in matching:
            domain = (urlparse(url).hostname or "").lower().removeprefix("www.")
            low_authority = any(
                domain == blocked or domain.endswith(f".{blocked}")
                for blocked in LOW_AUTHORITY_SOURCE_DOMAINS
            )
            recognized_research_domain = any(
                domain == scholarly or domain.endswith(f".{scholarly}")
                for scholarly in RESEARCH_SOURCE_DOMAINS
            )
            recognized_manufacturer_domain = any(
                domain == manufacturer or domain.endswith(f".{manufacturer}")
                for manufacturer in MANUFACTURER_SOURCE_DOMAINS
            )
            manufacturer_topic_match = bool(re.search(
                r"主轴|机床|轴承|spindle|machine\s*tools?|bearing",
                context,
                re.IGNORECASE,
            ))
            if category == "manufacturer" and recognized_manufacturer_domain and manufacturer_topic_match:
                # As with scholarly sources, the category marker and URL must
                # share one physical line. Product/service pages prove only the
                # existence and limited claims of manufacturer material; they
                # do not become troubleshooting manuals or numeric standards.
                usable.append(context)
                continue
            if shortfall is not None and shortfall.search(context):
                continue
            if category == "research" and recognized_research_domain:
                # The category marker and URL are already on this same physical
                # line. An authoritative scholarly/patent host is sufficient to
                # establish document type even when prose says "supports" or
                # "provides" beyond the bounded wording window.
                usable.append(context)
                continue
            if positive is not None and not positive.search(context):
                continue
            if category in {"manufacturer", "maintenance"} and low_authority:
                continue
            if category == "maintenance" and not FORMAL_MAINTENANCE_CONTEXT_RE.search(context):
                continue
            usable.append(context)
        if usable:
            continue
        issues.append(_issue(
            "REQUIRED_SOURCE_CATEGORY_MISSING",
            f"没有取得可用于结论的{SOURCE_CATEGORY_LABELS.get(category, category)}。仅提及该类别或明确声明缺失不算满足任务要求。",
            "completion",
            details={
                "category": category,
                "label": SOURCE_CATEGORY_LABELS.get(category, category),
                "citedBlocksFound": len(matching),
                "shortfallDisclosed": bool(
                    matching and shortfall and any(shortfall.search(context) for context, _ in matching)
                ),
            },
        ))
    return issues


H05_ALERT_THRESHOLD_RE = re.compile(
    r"(?:L[123]\s*(?:预警|报警)|报警逻辑).{0,1200}?(?:≥|≤|>|<|\d+\s*%|MPa|℃|μm)",
    re.IGNORECASE | re.DOTALL,
)
PROVISIONAL_THRESHOLD_MARKER_RE = re.compile(
    r"(?:试点初始|初始设定|初始阈值|候选阈值|暂定阈值|方案假设|试点假设)",
    re.IGNORECASE,
)
THRESHOLD_CALIBRATION_CAVEAT_RE = re.compile(
    r"(?:待|需).{0,20}?(?:设备|机型|历史|现场|基线)?.{0,12}?(?:标定|校准|验证|确认)|"
    r"(?:不得|不能|不可).{0,20}?(?:直接套用|作为正式阈值|作为停机依据)",
    re.IGNORECASE,
)


def _h05_provisional_threshold_issues(answer: str) -> list[dict[str, Any]]:
    """Require designed alarm thresholds to be disclosed as unvalidated trial settings."""
    if not H05_ALERT_THRESHOLD_RE.search(answer):
        return []
    if PROVISIONAL_THRESHOLD_MARKER_RE.search(answer) and THRESHOLD_CALIBRATION_CAVEAT_RE.search(answer):
        return []
    return [_issue(
        "PROVISIONAL_THRESHOLD_DISCLOSURE_MISSING",
        "预测性维护试点中的数值报警阈值必须明确标为试点初始假设，并说明需按设备历史基线标定后才能使用。",
        "evidence",
    )]


def _markdown_numeric_tables(answer: str) -> list[dict[str, Any]]:
    """Parse compact Markdown tables for generic narrative consistency checks."""
    lines = answer.splitlines(keepends=True)
    starts: list[int] = []
    cursor = 0
    for line in lines:
        starts.append(cursor)
        cursor += len(line)
    tables: list[dict[str, Any]] = []
    index = 0
    while index + 1 < len(lines):
        header_line = lines[index].strip()
        separator_line = lines[index + 1].strip()
        if "|" not in header_line or "|" not in separator_line or "---" not in separator_line:
            index += 1
            continue
        headers = [_clean_cell(cell) for cell in header_line.strip("|").split("|")]
        row_index = index + 2
        rows: list[list[str]] = []
        while row_index < len(lines) and "|" in lines[row_index]:
            cells = [_clean_cell(cell) for cell in lines[row_index].strip().strip("|").split("|")]
            if len(cells) >= len(headers) and not all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells if cell):
                rows.append(cells[:len(headers)])
            row_index += 1
        if rows:
            end = starts[row_index] if row_index < len(starts) else len(answer)
            tables.append({"headers": headers, "rows": rows, "start": starts[index], "end": end})
        index = max(row_index, index + 1)
    return tables


def _reported_number_tolerance(raw: str) -> float:
    decimals = len(raw.partition(".")[2]) if "." in raw else 0
    return 0.5 * (10 ** -decimals) + 1e-9


def _table_narrative_consistency_issues(answer: str) -> list[dict[str, Any]]:
    """Cross-check narrated numeric ranges and speed extrema against Markdown tables."""
    tables = _markdown_numeric_tables(answer)
    if not tables:
        return []
    table_spans = [(int(table["start"]), int(table["end"])) for table in tables]

    def outside_table(position: int) -> bool:
        return not any(start <= position < end for start, end in table_spans)

    issues: list[dict[str, Any]] = []
    seen: set[tuple[Any, ...]] = set()

    # Validate prose ranges such as “节拍指数 1.015–1.020” against the
    # corresponding numeric column in the nearest table.
    for table in tables:
        for column, header in enumerate(table["headers"]):
            metric = re.sub(r"[（(].*?[）)]", "", header).strip()
            if len(metric) < 2 or not re.search(r"指数|率|时间|时长|能耗|产量|功率|温度|振动|数量|金额|得分|分数", metric):
                continue
            values = [value for row in table["rows"] if column < len(row) and (value := _parse_number(row[column])) is not None]
            if len(values) < 2:
                continue
            range_pattern = re.compile(
                rf"{re.escape(metric)}\s*(?:的)?\s*(?:范围|区间|为|介于|约为|：|:)?\s*"
                r"(-?\d+(?:\.\d+)?)\s*(?:%|％)?\s*[—–~～至到]\s*"
                r"(-?\d+(?:\.\d+)?)\s*(?:%|％)?",
                re.IGNORECASE,
            )
            candidates = [match for match in range_pattern.finditer(answer) if outside_table(match.start())]
            if not candidates:
                continue
            nearest = min(candidates, key=lambda match: min(abs(match.start() - int(table["start"])), abs(match.end() - int(table["end"]))))
            reported_raw = (nearest.group(1), nearest.group(2))
            reported = sorted(float(item) for item in reported_raw)
            actual = [min(values), max(values)]
            tolerance = max(_reported_number_tolerance(item) for item in reported_raw)
            if abs(reported[0] - actual[0]) > tolerance or abs(reported[1] - actual[1]) > tolerance:
                key = ("range", metric, nearest.start(), int(table["start"]))
                if key not in seen:
                    seen.add(key)
                    issues.append(_issue(
                        "TABLE_NARRATIVE_RANGE_MISMATCH",
                        f"文字中的{metric}区间与明细表不一致。",
                        "completion",
                        details={"metric": metric, "reported": reported, "calculated": [round(item, 6) for item in actual]},
                    ))

    # “最慢班次/设备”为对表格中实际循环时间最大的实体；相对标准
    # 偏离最大不能被表述成绝对最慢。
    extrema_pattern = re.compile(
        r"最(?P<direction>慢|快)(?:的)?(?P<entity>班次|设备|产线|产品|供应商)?"
        r"(?:为|是|：|:)?\s*(?P<label>[A-Za-z][A-Za-z0-9_-]{0,15})",
        re.IGNORECASE,
    )
    for match in extrema_pattern.finditer(answer):
        if not outside_table(match.start()):
            continue
        eligible: list[tuple[dict[str, Any], int]] = []
        for table in tables:
            cycle_column = next((
                index for index, header in enumerate(table["headers"])
                if re.search(r"(?:实际|加权)?.{0,8}(?:循环时间|加工时间|周期时间|节拍时间)", header)
                and "标准" not in header
            ), None)
            if cycle_column is not None:
                eligible.append((table, cycle_column))
        if not eligible:
            continue
        table, cycle_column = min(
            eligible,
            key=lambda item: min(abs(match.start() - int(item[0]["start"])), abs(match.end() - int(item[0]["end"]))),
        )
        label_column = 0
        rows = []
        for row in table["rows"]:
            if len(row) <= max(label_column, cycle_column):
                continue
            value = _parse_number(row[cycle_column])
            if value is not None:
                rows.append((row[label_column].strip().upper(), value))
        if len(rows) < 2:
            continue
        extreme_value = (max if match.group("direction") == "慢" else min)(value for _, value in rows)
        expected = sorted(label for label, value in rows if abs(value - extreme_value) <= 1e-9)
        reported = match.group("label").upper()
        if reported not in expected:
            key = ("extremum", match.start(), int(table["start"]))
            if key not in seen:
                seen.add(key)
                issues.append(_issue(
                    "TABLE_NARRATIVE_EXTREMUM_MISMATCH",
                    f"文字中的最{match.group('direction')}{match.group('entity') or '对象'}与明细表不一致。",
                    "completion",
                    details={
                        "metric": table["headers"][cycle_column],
                        "reported": reported,
                        "expected": expected,
                        "values": {label: value for label, value in rows},
                    },
                ))
    return issues


def _i08_numeric_issues(answer: str) -> list[dict[str, Any]]:
    """Check I08 Markdown detail rows, totals, quantity balance and scrap-rate formula."""
    lines = answer.splitlines()
    parsed_rows: list[dict[str, Any]] = []
    total_row: dict[str, Any] | None = None
    for line_number, line in enumerate(lines):
        if "|" not in line:
            continue
        headers = [_clean_cell(cell) for cell in line.strip().strip("|").split("|")]
        machine_col = _find_column(headers, ("设备", "machine"))
        actual_col = _find_column(headers, ("实际产量", "actual_qty", "actualqty"))
        good_col = _find_column(headers, ("合格数量", "良品数量", "good_qty", "goodqty"))
        scrap_col = _find_column(headers, ("报废数量", "scrap_qty", "scrapqty"))
        rate_col = _find_column(headers, ("报废率", "scrap_rate", "scraprate"))
        required = (machine_col, actual_col, good_col, scrap_col, rate_col)
        if any(index is None for index in required):
            continue
        indices = [int(index) for index in required]
        for candidate in lines[line_number + 1 :]:
            if "|" not in candidate:
                if parsed_rows:
                    break
                continue
            cells = [_clean_cell(cell) for cell in candidate.strip().strip("|").split("|")]
            if len(cells) <= max(indices) or all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells if cell):
                continue
            machine_cell = cells[int(machine_col)]
            machine_match = MACHINE_PATTERN.search(machine_cell)
            is_total = any(term in machine_cell for term in ("合计", "总计", "总数", "全厂"))
            if not machine_match and not is_total:
                if parsed_rows:
                    break
                continue
            row = {
                "machine": machine_match.group(0).upper() if machine_match else "TOTAL",
                "actual": _parse_number(cells[int(actual_col)]),
                "good": _parse_number(cells[int(good_col)]),
                "scrap": _parse_number(cells[int(scrap_col)]),
                "ratePct": _parse_number(cells[int(rate_col)]),
            }
            if is_total:
                total_row = row
            else:
                parsed_rows.append(row)
        if parsed_rows:
            break

    issues: list[dict[str, Any]] = []
    unique_machines = {row["machine"] for row in parsed_rows}
    if len(unique_machines) < 8:
        issues.append(_issue("NUMERIC_VALIDATION_UNAVAILABLE", "无法从结果表中解析8台设备的完整数值，不能验证合计和公式。", "completion",
                             details={"parsedMachines": sorted(unique_machines)}))
        return issues

    for row in parsed_rows:
        if None in (row["actual"], row["good"], row["scrap"], row["ratePct"]):
            issues.append(_issue("NUMERIC_VALUE_MISSING", f"{row['machine']} 的数量或报废率无法解析。", "completion",
                                 details={"row": row}))
            continue
        actual = float(row["actual"])
        good = float(row["good"])
        scrap = float(row["scrap"])
        rate = float(row["ratePct"])
        if abs((good + scrap) - actual) > 0.5:
            issues.append(_issue("QUANTITY_BALANCE_MISMATCH", f"{row['machine']} 的合格数量与报废数量之和不等于实际产量。", "completion",
                                 details={"machine": row["machine"], "actual": actual, "goodPlusScrap": good + scrap}))
        expected_rate = scrap / actual * 100 if actual else None
        if expected_rate is None or abs(rate - expected_rate) > 0.011:
            issues.append(_issue("RATE_CALCULATION_MISMATCH", f"{row['machine']} 的报废率不符合 报废数量÷实际产量。", "completion",
                                 details={"machine": row["machine"], "reportedPct": rate, "calculatedPct": round(expected_rate, 4) if expected_rate is not None else None}))

    sums = {
        key: sum(float(row[key]) for row in parsed_rows if row[key] is not None)
        for key in ("actual", "good", "scrap")
    }
    calculated_total_rate = sums["scrap"] / sums["actual"] * 100 if sums["actual"] else None
    if total_row is None:
        issues.append(_issue("NUMERIC_TOTAL_MISSING", "结果表缺少可核对的合计行。", "completion", details={"calculatedTotals": sums}))
        return issues
    for key, label in (("actual", "实际产量"), ("good", "合格数量"), ("scrap", "报废数量")):
        reported = total_row.get(key)
        if reported is None or abs(float(reported) - sums[key]) > 0.5:
            issues.append(_issue("NUMERIC_TOTAL_MISMATCH", f"合计行的{label}与8台设备明细之和不一致。", "completion",
                                 details={"metric": key, "reported": reported, "calculated": sums[key]}))
    reported_rate = total_row.get("ratePct")
    if reported_rate is None or calculated_total_rate is None or abs(float(reported_rate) - calculated_total_rate) > 0.011:
        issues.append(_issue("RATE_CALCULATION_MISMATCH", "合计报废率与8台设备明细重新计算的结果不一致。", "completion",
                             details={"machine": "TOTAL", "reportedPct": reported_rate,
                                      "calculatedPct": round(calculated_total_rate, 4) if calculated_total_rate is not None else None}))
    return issues


def _normalized_month(value: str) -> str | None:
    match = re.search(r"(20\d{2})[-年/.](0?[1-9]|1[0-2])", _clean_cell(value))
    return f"{match.group(1)}-{int(match.group(2)):02d}" if match else None


def _i05_numeric_issues(answer: str) -> list[dict[str, Any]]:
    """Cross-check monthly production/energy tables and the kWh-per-good-unit formula."""
    lines = answer.splitlines()
    metrics: dict[str, dict[tuple[str, str], float]] = {
        "actual": {}, "good": {}, "energy": {}, "peak": {}, "runtime": {}, "intensity": {},
    }
    issues: list[dict[str, Any]] = []
    for index in range(len(lines) - 1):
        if "|" not in lines[index] or "|" not in lines[index + 1] or "---" not in lines[index + 1]:
            continue
        headers = [_clean_cell(cell) for cell in lines[index].strip().strip("|").split("|")]
        machine_col = _find_column(headers, ("设备", "machine"))
        period_col = _find_column(headers, ("月份", "期间", "period", "month"))
        intensity_col = _find_column(headers, ("单位良品能耗", "单位合格品能耗", "kwh_per_good_unit", "kwh/件"))
        energy_col = _find_column(headers, ("electricity_kwh", "耗电量", "能耗kwh", "能耗(kwh)"))
        peak_col = _find_column(headers, ("峰值功率", "峰值需量", "峰值", "max_peak_demand_kw", "peak_demand_kw"))
        runtime_col = _find_column(headers, ("运行时间", "运行时长", "runtime_hours", "runtime"))
        actual_col = _find_column(headers, ("实际产量", "产量", "actual_qty", "actualqty"))
        good_col = _find_column(headers, ("良品数量", "良品数", "合格品数量", "合格数量", "good_qty", "goodqty"))
        long_columns = {
            "energy": energy_col, "peak": peak_col, "runtime": runtime_col,
            "actual": actual_col, "good": good_col, "intensity": intensity_col,
        }
        if machine_col is not None and period_col is not None and all(value is not None for value in long_columns.values()):
            row_index = index + 2
            required_indices = [int(machine_col), int(period_col), *(int(value) for value in long_columns.values() if value is not None)]
            while row_index < len(lines) and "|" in lines[row_index]:
                cells = [_clean_cell(cell) for cell in lines[row_index].strip().strip("|").split("|")]
                row_index += 1
                if len(cells) <= max(required_indices):
                    continue
                machine_match = MACHINE_PATTERN.search(cells[int(machine_col)])
                month = _normalized_month(cells[int(period_col)])
                if not machine_match or not month:
                    continue
                key = (machine_match.group(0).upper(), month)
                for metric_name, column in long_columns.items():
                    value = _parse_number(cells[int(column)])
                    if value is not None:
                        metrics[metric_name][key] = value
        month_columns = [(position, _normalized_month(header)) for position, header in enumerate(headers)]
        month_columns = [(position, month) for position, month in month_columns if month]
        if machine_col is None or not month_columns:
            continue
        title = next((lines[position] for position in range(index - 1, max(-1, index - 5), -1) if lines[position].strip()), "")
        context = f"{title} {lines[index]}".lower()
        metric = None
        if "kwh_per_good" in context or "kwh/件" in context or ("单位" in context and ("能耗" in context or "电耗" in context)):
            metric = "intensity"
        elif "peak_demand" in context or "峰值功率" in context or "峰值需量" in context:
            metric = "peak"
        elif "runtime_hours" in context or "运行时间" in context:
            metric = "runtime"
        elif "good_qty" in context or "良品" in context or "合格品" in context or "合格数量" in context:
            metric = "good"
        elif "actual_qty" in context or ("产量" in context and "良品" not in context and "合格" not in context):
            metric = "actual"
        elif "electricity_kwh" in context or "月度能耗" in context or "耗电量" in context:
            metric = "energy"
        if not metric:
            continue
        total_col = _find_column(headers, ("合计", "总计", "total"))
        row_index = index + 2
        while row_index < len(lines) and "|" in lines[row_index]:
            cells = [_clean_cell(cell) for cell in lines[row_index].strip().strip("|").split("|")]
            row_index += 1
            if len(cells) <= max([int(machine_col), *(position for position, _ in month_columns)]):
                continue
            machine_match = MACHINE_PATTERN.search(cells[int(machine_col)])
            if not machine_match:
                continue
            machine = machine_match.group(0).upper()
            parsed_values: list[float] = []
            for position, month in month_columns:
                value = _parse_number(cells[position])
                if value is not None:
                    metrics[metric][(machine, month)] = value
                    parsed_values.append(value)
            if metric not in {"intensity", "peak"} and total_col is not None and int(total_col) < len(cells):
                reported_total = _parse_number(cells[int(total_col)])
                if reported_total is not None and parsed_values:
                    tolerance = 0.05 if metric in {"energy", "runtime"} else 0.5
                    if abs(reported_total - sum(parsed_values)) > tolerance:
                        issues.append(_issue(
                            "NUMERIC_TOTAL_MISMATCH",
                            f"{machine} 的{metric}合计与月度明细之和不一致。",
                            "completion",
                            details={"machine": machine, "metric": metric, "reported": reported_total, "calculated": round(sum(parsed_values), 4)},
                        ))

    missing = [name for name, values in metrics.items() if not values]
    if missing:
        issues.append(_issue(
            "NUMERIC_VALIDATION_UNAVAILABLE",
            "无法解析完整的设备×月份能耗、峰值功率、运行时间、产量、良品和单位良品能耗数据，不能执行逐行数值一致性校验。",
            "completion",
            details={"missingMetrics": missing},
        ))
        return issues

    machines = {machine for values in metrics.values() for machine, _ in values}
    months = {month for values in metrics.values() for _, month in values}
    expected_keys = {(machine, month) for machine in machines for month in months}
    missing_cells = {
        name: sorted(expected_keys - set(values))
        for name, values in metrics.items()
        if expected_keys - set(values)
    }
    if missing_cells:
        issues.append(_issue(
            "MONTHLY_DETAIL_INCOMPLETE",
            "设备×月份明细表存在缺失字段或缺失行，不能完成全量逐行校验。",
            "completion",
            details={"expectedRows": len(expected_keys), "missingCounts": {name: len(rows) for name, rows in missing_cells.items()},
                     "examples": {name: rows[:5] for name, rows in missing_cells.items()}},
        ))

    for key in sorted(set(metrics["actual"]) & set(metrics["good"])):
        actual = metrics["actual"][key]
        good = metrics["good"][key]
        if good > actual + 0.5:
            issues.append(_issue(
                "QUANTITY_BALANCE_MISMATCH",
                f"{key[0]} {key[1]} 的良品数量大于实际产量。",
                "completion",
                details={"machine": key[0], "period": key[1], "actual": actual, "good": good},
            ))

    for key in sorted(set(metrics["energy"]) & set(metrics["good"]) & set(metrics["intensity"])):
        energy = metrics["energy"][key]
        good = metrics["good"][key]
        reported = metrics["intensity"][key]
        expected = energy / good if good else None
        tolerance = max(0.002, abs(expected or 0) * 0.002)
        if expected is None or abs(reported - expected) > tolerance:
            issues.append(_issue(
                "ENERGY_INTENSITY_FORMULA_MISMATCH",
                f"{key[0]} {key[1]} 的单位良品能耗不符合 能耗÷良品数量。",
                "completion",
                details={"machine": key[0], "period": key[1], "reported": reported,
                         "calculated": round(expected, 4) if expected is not None else None},
            ))
    return issues


def validate_task_result(
    *,
    task_id: str,
    category: str,
    answer: str,
    sources: Iterable[str] = (),
    artifacts: Iterable[dict[str, Any]] = (),
    tool_calls: Iterable[dict[str, Any]] = (),
    execution_status: str = "success",
) -> dict[str, Any]:
    """Validate deliverables without prescribing tool choice or analysis order."""
    contract = TASK_CONTRACTS.get(task_id, TaskContract(task_id))
    sources = list(dict.fromkeys(str(source) for source in sources if source))
    artifacts = list(artifacts)
    tool_calls = list(tool_calls)
    issues: list[dict[str, Any]] = []

    if execution_status != "success":
        issues.append(_issue("EXECUTION_FAILED", "模型或工具执行失败，无法完成任务验收。", "execution"))
    if len(answer.strip()) < contract.min_answer_chars:
        issues.append(_issue("ANSWER_TOO_SHORT", f"回答少于 {contract.min_answer_chars} 个字符，未形成完整交付。", "completion"))

    lowered = answer.lower()
    for entity in contract.required_entities:
        if entity.lower() not in lowered:
            issues.append(_issue("REQUIRED_ENTITY_MISSING", f"回答缺少必需实体：{entity}。", "completion", details={"entity": entity}))
    entity_requirements = (
        (contract.min_machine_ids, MACHINE_PATTERN, "设备"),
        (contract.min_product_ids, PRODUCT_PATTERN, "产品"),
        (contract.min_supplier_ids, SUPPLIER_PATTERN, "供应商"),
    )
    for minimum, pattern, label in entity_requirements:
        found = _unique_matches(pattern, answer)
        if minimum and len(found) < minimum:
            issues.append(_issue("ENTITY_COVERAGE_INCOMPLETE", f"至少需要 {minimum} 个{label}实体，实际识别到 {len(found)} 个。", "completion",
                                 details={"entityType": label, "minimum": minimum, "found": sorted(found)}))

    if task_id == "I01":
        ranked_machines: list[str] = []
        for match in MACHINE_PATTERN.finditer(answer):
            machine_id = match.group(0).upper()
            if machine_id not in ranked_machines:
                ranked_machines.append(machine_id)
        reported_top3 = tuple(ranked_machines[:3])
        if reported_top3 not in I01_ALLOWED_TOP3_ORDERS:
            issues.append(_issue(
                "I01_RISK_RANKING_MISMATCH",
                "I01前三台设备不符合预注册综合风险公式的允许排序。",
                "completion",
                details={
                    "reportedTop3": list(reported_top3),
                    "allowedTop3Orders": [list(item) for item in I01_ALLOWED_TOP3_ORDERS],
                    "formula": I01_RISK_FORMULA,
                },
            ))

    for alternatives in contract.required_term_groups:
        if not any(_matches_required_term(lowered, term) for term in alternatives):
            issues.append(_issue("REQUIRED_TOPIC_MISSING", f"回答未覆盖要求主题：{' / '.join(alternatives)}。", "completion",
                                 details={"alternatives": list(alternatives)}))
    if contract.require_date_range and not (
        DATE_RANGE_PATTERN.search(answer) or UNKNOWN_DATE_RANGE_DISCLOSURE_PATTERN.search(answer)
    ):
        issues.append(_issue("DATA_TIME_RANGE_MISSING", "回答没有明确说明数据或资料的时间范围。", "completion"))
    if contract.min_time_points:
        time_points = {match.group(0).lower() for match in MONTH_PATTERN.finditer(answer)}
        if len(time_points) < contract.min_time_points:
            issues.append(_issue("TIME_SERIES_COVERAGE_INCOMPLETE", f"至少需要 {contract.min_time_points} 个明确时间点，实际识别到 {len(time_points)} 个。", "completion",
                                 details={"minimum": contract.min_time_points, "found": sorted(time_points)}))

    domains = {_domain(url) for url in sources if _domain(url)}
    if len(sources) < contract.min_urls:
        issues.append(_issue("SOURCE_URL_COUNT_INSUFFICIENT", f"至少需要 {contract.min_urls} 个来源链接，实际为 {len(sources)} 个。", "evidence",
                             details={"minimum": contract.min_urls, "actual": len(sources)}))
    if len(domains) < contract.min_independent_domains:
        issues.append(_issue("INDEPENDENT_SOURCE_COUNT_INSUFFICIENT", f"至少需要 {contract.min_independent_domains} 个独立来源域名，实际为 {len(domains)} 个。", "evidence",
                             details={"minimum": contract.min_independent_domains, "actual": len(domains), "domains": sorted(domains)}))
    if contract.min_official_urls:
        official = [url for url in sources if any(_matches_domain(_domain(url), domain) for domain in contract.official_domains)]
        if len(official) < contract.min_official_urls:
            issues.append(_issue("OFFICIAL_SOURCE_MISSING", f"至少需要 {contract.min_official_urls} 个指定官方来源链接。", "evidence",
                                 details={"officialDomains": list(contract.official_domains), "actual": len(official)}))
    if contract.required_source_categories:
        issues.extend(_source_category_issues(answer, contract.required_source_categories))
    if contract.require_internal_external_labels:
        internal = bool(INTERNAL_SECTION_LABEL_RE.search(answer) or "厂内数据" in answer)
        external = bool(EXTERNAL_SECTION_LABEL_RE.search(answer) or "公开资料" in answer)
        if not (internal and external):
            issues.append(_issue("INTERNAL_EXTERNAL_DISTINCTION_MISSING", "回答没有清楚区分内部数据与外部公开资料。", "evidence"))

    if contract.required_artifact_extensions:
        extensions = _artifact_extensions(artifacts, verified_only=contract.require_verified_artifacts)
        for extension in contract.required_artifact_extensions:
            if extension.lower() not in extensions:
                issues.append(_issue("REQUIRED_ARTIFACT_MISSING", f"缺少可验证的 {extension} 交付文件。", "completion",
                                     details={"extension": extension, "verifiedRequired": contract.require_verified_artifacts}))

    if task_id == "I05":
        issues.extend(_i05_numeric_issues(answer))
    if task_id == "I08":
        issues.extend(_i08_numeric_issues(answer))
        issues.extend(_i08_range_consistency_issues(answer))
        issues.extend(_i08_artifact_issues(artifacts))
    if task_id == "I04":
        issues.extend(_i04_superlative_issues(answer))
    if task_id == "H05":
        issues.extend(_h05_provisional_threshold_issues(answer))
    issues.extend(_table_narrative_consistency_issues(answer))

    if category in {"internal", "hybrid"}:
        substantive_tools = _successful_substantive_tools(tool_calls)
        if not substantive_tools:
            issues.append(_issue("INTERNAL_DATA_EVIDENCE_MISSING", "没有成功的内部数据分析工具调用，无法证明回答使用了实际内部数据。", "evidence"))
        provenance_terms = ("来源表", "数据源", "内部数据库", "内部数据", "SQL", "查询计划", "sourceTables")
        if not any(term.lower() in lowered for term in provenance_terms):
            issues.append(_issue("INTERNAL_DATA_PROVENANCE_MISSING", "回答没有说明内部数据来源表、数据库或查询依据。", "evidence"))

    errors = [issue for issue in issues if issue["severity"] == "error"]
    completion_errors = [issue for issue in errors if issue["scope"] in {"execution", "completion"}]
    evidence_errors = [
        issue for issue in errors
        if issue["scope"] == "evidence" or issue["code"] == "REQUIRED_SOURCE_CATEGORY_MISSING"
    ]
    if execution_status != "success" or not answer.strip():
        completion_status = STATUS_FAILED
    elif completion_errors:
        completion_status = STATUS_PARTIAL
    else:
        completion_status = STATUS_COMPLETE
    if category not in {"external", "hybrid"} and not evidence_errors:
        evidence_status = EVIDENCE_COMPLETE
    elif not evidence_errors:
        evidence_status = EVIDENCE_COMPLETE
    elif sources or any(issue["code"] == "INTERNAL_EXTERNAL_DISTINCTION_MISSING" for issue in evidence_errors):
        evidence_status = EVIDENCE_PARTIAL
    else:
        evidence_status = EVIDENCE_INSUFFICIENT

    checked = 1 + len(contract.required_entities) + len(contract.required_term_groups)
    checked += sum(1 for value in (contract.min_machine_ids, contract.min_product_ids, contract.min_supplier_ids,
                                  contract.require_date_range, contract.min_time_points, contract.min_urls,
                                  contract.min_independent_domains, contract.min_official_urls,
                                  contract.require_internal_external_labels) if value)
    checked += len(contract.required_source_categories)
    checked += len(contract.required_artifact_extensions)
    passed = max(0, checked - len(errors))
    return {
        "contractVersion": 1,
        "completionStatus": completion_status,
        "evidenceStatus": evidence_status,
        "completionScore": round(passed / checked, 4) if checked else 1.0,
        "validationPassed": not errors,
        "validationErrors": errors,
        "validationWarnings": [issue for issue in issues if issue["severity"] != "error"],
        "validationSummary": {"checks": checked, "passed": passed, "failed": len(errors)},
    }


def contract_manifest() -> dict[str, Any]:
    return {
        task_id: {
            "minAnswerChars": contract.min_answer_chars,
            "minUrls": contract.min_urls,
            "minIndependentDomains": contract.min_independent_domains,
            "officialDomains": list(contract.official_domains),
            "minOfficialUrls": contract.min_official_urls,
            "requiredEntities": list(contract.required_entities),
            "minMachineIds": contract.min_machine_ids,
            "minProductIds": contract.min_product_ids,
            "minSupplierIds": contract.min_supplier_ids,
            "requiredTermGroups": [list(group) for group in contract.required_term_groups],
            "requireDateRange": contract.require_date_range,
            "minTimePoints": contract.min_time_points,
            "requiredArtifactExtensions": list(contract.required_artifact_extensions),
            "requireVerifiedArtifacts": contract.require_verified_artifacts,
            "requireInternalExternalLabels": contract.require_internal_external_labels,
            "requiredSourceCategories": list(contract.required_source_categories),
            "notes": list(contract.notes),
        }
        for task_id, contract in TASK_CONTRACTS.items()
    }
