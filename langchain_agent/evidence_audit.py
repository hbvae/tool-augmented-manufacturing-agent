from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Iterable
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlparse, urlunparse

from langchain_core.messages import AIMessage, ToolMessage


EXTERNAL_TOOLS = {
    "search_external_sources",
    "retrieve_external_evidence",
    "retrieve_external_sources",
    "fetch_external_document",
    "cross_check_external_sources",
}
MIN_EXTERNAL_CLAIM_BINDING_RATE = 0.75
MIN_INTERNAL_CLAIM_BINDING_RATE = 0.75
SENSITIVE_KEYS = {"password", "token", "secret", "api_key", "apikey", "authorization", "contentbase64"}
URL_RE = re.compile(r"https?://[^\s\]\[()<>{}\"'`\\，。；：！？、）】》」』]+", re.IGNORECASE)
URL_TRAILING_PUNCTUATION = ".,;:!?，。；：！？、`\\）】》」』"
EVIDENCE_ID_RE = re.compile(r"\b(?:EXT|TE|SRC)-\d{3}(?:-SRC-\d{3})?\b", re.IGNORECASE)
KNOWN_TABLES = {
    "downtime_events", "energy_readings", "inventory_transactions", "machines", "materials",
    "production_orders", "products", "quality_inspections", "supplier_receipts", "suppliers", "v_machine_kpi",
}
CLAIM_RE = re.compile(
    r"(?:\d+(?:[.,]\d+)?\s*(?:%|％|吨|件|台|家|分|亿元|万元|元|欧元|美元|kwh|kw|分钟|小时|天)|"
    r"20\d{2}年?|法规|政策|标准|正式生效|进入.*阶段|实施时间|截止|截至)",
    re.IGNORECASE,
)
EXTERNAL_CLAIM_RE = re.compile(
    r"(?:政策|法规|(?:国家|行业|国际|团体|技术|安全|质量管理)标准|"
    r"标准(?:号|体系|要求|规范|发布|实施|认证)|正式生效|实施时间|最新|行业趋势|"
    r"公开资料|欧盟|委员会|法规编号|ISO\s*\d+)",
    re.IGNORECASE,
)
STRONG_EXTERNAL_CLAIM_RE = re.compile(
    r"(?:外部资料|公开资料|政策|法规|正式生效|实施时间|最新|行业趋势|欧盟|委员会|法规编号|ISO\s*\d+)",
    re.IGNORECASE,
)
INTERNAL_CLAIM_RE = re.compile(
    r"(?:内部数据|内部证据|来源表|查询摘要|\bM\d{2}\b|实际产量|合格数量|报废数量|报废率|良品率|"
    r"计划完成率|循环时间|标准节拍|质量失败率|非计划停机|停机时间|故障次数|MTBF|MTTR|OEE|"
    r"耗电量|运行小时|覆盖天数|无消耗|库存|物料|供应商|数据集\s*SHA256)",
    re.IGNORECASE,
)
INTERNAL_PROVENANCE_MARKER_RE = re.compile(r"(?:内部证据|来源表|查询摘要)", re.IGNORECASE)
EXTERNAL_PROVENANCE_MARKER_RE = re.compile(
    r"^\s*(?:>\s*)?(?:[（(]\s*)?(?:外部证据|证据|依据|来源|阈值依据|技术依据|参考资料)\s*[:：]",
    re.IGNORECASE,
)
POTENTIAL_CONTEXT_RE = re.compile(
    r"(?:潜在风险|潜在影响|尚未.{0,30}(?:体现|形成|证实)|待验证|不构成因果|"
    r"不构成.{0,30}(?:确认|结论|依据)|不能作为确定结论|仅用于.{0,30}(?:补充|机理|排查))",
    re.IGNORECASE,
)
METHODOLOGY_BLOCK_RE = re.compile(
    r"(?:使用工具|内部来源表|查询摘要哈希|方法与数据说明|数据时间范围)",
    re.IGNORECASE,
)
LIMITATION_MARKER_RE = re.compile(
    r"(?:不确定性|局限|限制声明|证据不足|数据不足|缺少|未取得|未提供|未核实|无法确认|"
    r"未(?:能|完整|获得|获取|返回|针对)|没有可核验|无法(?:给出|核验|引用)|无权威|"
    r"权威性有限|仅作参考|不证明因果|不等于因果|不能(?:直接|作为)|不可作为|不替代|以.+为准)",
    re.IGNORECASE,
)
PROPOSED_PARAMETER_MARKER_RE = re.compile(
    r"(?:初始设定|初始设置|初始阈值|试点初始|建议值|建议阈值|暂定值|候选阈值|"
    r"待(?:标定|校准|验证|确认)|需.{0,20}(?:标定|校准|查表确认))",
    re.IGNORECASE,
)
PROPOSED_PARAMETER_CAVEAT_RE = re.compile(
    r"(?:待(?:标定|校准|验证|确认)|需.{0,20}(?:标定|校准|查表确认)|"
    r"(?:不得|不能|不可).{0,20}(?:直接|作为).{0,20}(?:标准|阈值|依据))",
    re.IGNORECASE,
)
ORIGINAL_SOURCE_TEXT_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("caam", re.compile(r"中国汽车工业协会|中汽协|\bCAAM\b", re.IGNORECASE)),
    ("cpca", re.compile(r"乘用车市场信息联席会|乘联会|\bCPCA\b", re.IGNORECASE)),
    ("china_customs", re.compile(r"海关总署|中国海关", re.IGNORECASE)),
    ("china_statistics", re.compile(r"国家统计局", re.IGNORECASE)),
    ("cabia", re.compile(r"中国汽车动力电池产业创新联盟|动力电池产业创新联盟|电池联盟", re.IGNORECASE)),
)
ORIGINAL_SOURCE_DOMAIN_FAMILIES = {
    "caam.org.cn": "caam",
    "cpcaauto.com": "cpca",
    "customs.gov.cn": "china_customs",
    "stats.gov.cn": "china_statistics",
    "miit.gov.cn": "miit",
    "ndrc.gov.cn": "ndrc",
    "mof.gov.cn": "ministry_of_finance",
    "chinatax.gov.cn": "state_taxation_administration",
    "gov.cn": "state_council",
}
INDEPENDENT_SOURCE_SHORTFALL_DISCLOSURE_RE = re.compile(
    r"(?:至少\s*[3三]\s*个?.{0,24}?(?:独立|原始).{0,30}?(?:未(?:能)?满足|不足|不满足)|"
    r"(?:独立|原始).{0,20}?(?:来源|机构).{0,30}?(?:只|仅).{0,12}?[12一二两]\s*个|"
    r"(?:只|仅).{0,12}?[12一二两]\s*个?.{0,12}?(?:独立|原始).{0,12}?(?:来源|机构)|"
    r"(?:至少\s*[3三]\s*个?.{0,40}?要求).{0,30}?(?:未(?:能)?(?:完全)?满足|不满足))",
    re.IGNORECASE | re.DOTALL,
)


def _digest(value: Any) -> str:
    try:
        rendered = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str, separators=(",", ":"))
    except (TypeError, ValueError):
        rendered = str(value)
    return hashlib.sha256(rendered.encode("utf-8", errors="replace")).hexdigest()[:16]


def _sanitize(value: Any, key: str = "", depth: int = 0) -> Any:
    if depth > 8:
        return "[DEPTH_LIMIT]"
    normalized = key.lower()
    if normalized in SENSITIVE_KEYS or any(normalized.endswith("_" + item) for item in SENSITIVE_KEYS):
        return "[REDACTED]"
    if isinstance(value, str):
        if normalized in {"code", "content", "contentbase64"} and len(value) > 500:
            return f"[PAYLOAD length={len(value)} sha256={_digest(value)}]"
        return value if len(value) <= 1000 else value[:1000] + "[TRUNCATED]"
    if isinstance(value, dict):
        return {str(child_key): _sanitize(child, str(child_key), depth + 1) for child_key, child in list(value.items())[:100]}
    if isinstance(value, (list, tuple)):
        return [_sanitize(item, key, depth + 1) for item in list(value)[:50]]
    return value


def _decode(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if stripped[:1] in "[{":
            try:
                return _decode(json.loads(stripped), depth + 1)
            except (json.JSONDecodeError, TypeError):
                return value
        return value
    if isinstance(value, list):
        decoded = [_decode(item, depth + 1) for item in value]
        for item in decoded:
            if isinstance(item, dict) and item.get("type") == "text" and "text" in item:
                nested = _decode(item["text"], depth + 1)
                if isinstance(nested, (dict, list)):
                    return nested
        return decoded
    if isinstance(value, dict):
        if "structuredContent" in value and isinstance(value["structuredContent"], dict):
            return _decode(value["structuredContent"], depth + 1)
        if value.get("type") == "text" and "text" in value:
            nested = _decode(value["text"], depth + 1)
            if isinstance(nested, (dict, list)):
                return nested
        return {key: _decode(item, depth + 1) for key, item in value.items()}
    return value


def _payload_dict(value: Any) -> dict[str, Any]:
    decoded = _decode(value)
    if isinstance(decoded, dict):
        return decoded
    if isinstance(decoded, list):
        for item in decoded:
            if isinstance(item, dict):
                return item
    return {}


def _clean_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    match = URL_RE.search(value)
    if not match:
        return None
    url = match.group(0).rstrip(URL_TRAILING_PUNCTUATION)
    parsed = urlparse(url)
    return url if parsed.scheme in {"http", "https"} and parsed.hostname else None


def _canonical_url(value: str) -> str:
    parsed = urlparse(value)
    hostname = (parsed.hostname or "").lower()
    port = parsed.port
    if port and not ((parsed.scheme.lower() == "http" and port == 80) or (parsed.scheme.lower() == "https" and port == 443)):
        hostname = f"{hostname}:{port}"
    # Percent-encoded and literal Unicode paths identify the same resource. Decode
    # first and then encode deterministically so audit results do not depend on how
    # the model rendered a Chinese URL.
    decoded_path = unquote(parsed.path or "/")
    path = quote(decoded_path.rstrip("/") or "/", safe="/~:@!$&'()*+,;=-._")
    # Keep resource-identifying parameters but remove transport/marketing state.
    # WeChat articles in particular are often returned with chksm/scene while the
    # model cites the same article without them; those forms must audit as one URL.
    tracking_names = {
        "wfr", "for", "from", "spm", "source", "chksm", "scene", "ascene",
        "sessionid", "clicktime", "enterid", "devicetype", "version", "lang",
        "nettype", "exportkey", "pass_ticket", "wx_header", "key", "uin",
    }
    query_items = [
        (key, item)
        for key, item in parse_qsl(parsed.query, keep_blank_values=True)
        if key.lower() not in tracking_names and not key.lower().startswith("utm_")
    ]
    query = urlencode(sorted(query_items), doseq=True)
    return urlunparse((parsed.scheme.lower(), hostname, path, "", query, ""))


def _original_source_family(source: dict[str, Any]) -> str | None:
    text = " ".join(str(source.get(key) or "") for key in ("title", "excerptPreview"))
    for family, pattern in ORIGINAL_SOURCE_TEXT_PATTERNS:
        if pattern.search(text):
            return family
    host = str(source.get("domain") or urlparse(str(source.get("url") or "")).hostname or "").lower().removeprefix("www.")
    for domain, family in ORIGINAL_SOURCE_DOMAIN_FAMILIES.items():
        if host == domain or host.endswith("." + domain):
            return family
    return None


def _external_sources(payload: dict[str, Any], evidence_id: str) -> list[dict[str, Any]]:
    candidates: list[Any] = []
    # `cross_check_external_sources` returns an array named `documents`, while
    # discovery/reranking tools use evidence/items/results. Keep all supported
    # response shapes here so evidence is not lost simply because a different
    # external-search tool produced it.
    for key in ("evidence", "items", "sources", "results", "documents"):
        if isinstance(payload.get(key), list):
            candidates.extend(payload[key])
    document = payload.get("document")
    if isinstance(document, dict):
        candidates.append(document)
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(candidates, start=1):
        if not isinstance(item, dict):
            continue
        url = _clean_url(item.get("url") or item.get("sourceUrl"))
        if not url or url in seen:
            continue
        seen.add(url)
        excerpt = str(item.get("excerpt") or item.get("content") or item.get("text") or "")
        output.append(
            {
                "sourceId": f"{evidence_id}-SRC-{index:03d}",
                "providerEvidenceId": item.get("evidenceId"),
                "title": str(item.get("title") or "")[:300],
                "url": url,
                "domain": str(item.get("domain") or urlparse(url).hostname or "").lower(),
                "publishedAt": item.get("publishedAt") or item.get("published_at"),
                "relevanceScore": item.get("relevanceScore") or item.get("providerScore"),
                "excerptDigest": _digest(excerpt) if excerpt else None,
                "excerptPreview": excerpt[:300] if excerpt else None,
            }
        )
    return output


def _compact_result(payload: dict[str, Any]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for key in ("provider", "query", "searchedAt", "scope", "grain", "dimension", "dataAvailable", "returned", "anomalyCount", "metricDefinitions"):
        if key in payload:
            output[key] = _sanitize(payload[key], key)
    if isinstance(payload.get("metrics"), dict):
        output["metrics"] = _sanitize(payload["metrics"], "metrics")
    if isinstance(payload.get("rows"), list):
        output["rowCountInPayload"] = len(payload["rows"])
        output["rowPreview"] = _sanitize(payload["rows"][:3], "rows")
    if isinstance(payload.get("summary"), dict):
        output["summary"] = _sanitize(payload["summary"], "summary")
    return output


def extract_tool_evidence_record(
    *,
    evidence_id: str,
    tool_name: str,
    call_id: str,
    arguments: Any,
    content: Any,
    status: str,
) -> dict[str, Any]:
    payload = _payload_dict(content)
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    query_trace = metadata.get("queryTrace") if isinstance(metadata.get("queryTrace"), dict) else {}
    queries = query_trace.get("queries") if isinstance(query_trace.get("queries"), list) else []
    compact_queries = []
    for query in queries[:10]:
        if not isinstance(query, dict):
            continue
        compact_queries.append(
            {
                "sql": str(query.get("sql") or "")[:2000],
                "parameterCount": query.get("parameterCount"),
                "plan": [str(item)[:500] for item in (query.get("plan") or [])[:10]],
            }
        )
    external_sources = _external_sources(payload, evidence_id)
    source_tables = [str(item) for item in (metadata.get("sourceTables") or [])]
    kind = "external" if tool_name in EXTERNAL_TOOLS or external_sources else "internal"
    if "sandbox" in tool_name or "python" in tool_name:
        kind = "sandbox"
    error = payload.get("error") if isinstance(payload.get("error"), dict) else None
    return {
        "evidenceId": evidence_id,
        "kind": kind,
        "tool": tool_name,
        "callId": call_id,
        "status": "error" if error else status,
        "arguments": _sanitize(metadata.get("filters") if metadata.get("filters") is not None else arguments, "arguments"),
        "argumentsDigest": _digest(arguments),
        "resultDigest": _digest(payload if payload else content),
        "requestId": metadata.get("requestId"),
        "executedAt": metadata.get("executedAt"),
        "dataTimeRange": _sanitize(metadata.get("dataTimeRange"), "dataTimeRange"),
        "sourceTables": sorted(set(source_tables)),
        "queryTrace": {
            "queryCount": query_trace.get("queryCount", len(compact_queries)),
            "truncated": bool(query_trace.get("truncated")),
            "digest": query_trace.get("digest"),
            "queries": compact_queries,
        },
        "returnedRows": metadata.get("returnedRows"),
        "resultTruncated": bool(metadata.get("resultTruncated")),
        "dataSufficiency": _sanitize(metadata.get("dataSufficiency"), "dataSufficiency"),
        "dataQualityNotes": _sanitize(metadata.get("dataQualityNotes") or payload.get("dataNotes") or [], "dataQualityNotes"),
        "assumptions": _sanitize(metadata.get("assumptions") or payload.get("assumptions") or [], "assumptions"),
        "externalSources": external_sources,
        "resultSummary": _compact_result(payload),
        "error": _sanitize(error, "error") if error else None,
    }


def build_agent_tool_evidence(messages: Iterable[Any]) -> list[dict[str, Any]]:
    calls: dict[str, dict[str, Any]] = {}
    ordered: list[str] = []
    for message in messages:
        if isinstance(message, AIMessage):
            for call in message.tool_calls or []:
                call_id = str(call.get("id") or "")
                if call_id not in calls:
                    ordered.append(call_id)
                calls[call_id] = {"name": str(call.get("name") or "unknown"), "arguments": call.get("args") or {}}
    records: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, ToolMessage):
            continue
        call_id = str(getattr(message, "tool_call_id", "") or "")
        call = calls.get(call_id, {"name": str(message.name or "unknown"), "arguments": {}})
        evidence_id = f"TE-{len(records) + 1:03d}"
        artifact = message.artifact if isinstance(message.artifact, dict) else {}
        evidence_content = artifact.get("manufacturingRawToolContent", message.content)
        records.append(
            extract_tool_evidence_record(
                evidence_id=evidence_id,
                tool_name=call["name"],
                call_id=call_id,
                arguments=call["arguments"],
                content=evidence_content,
                status=str(getattr(message, "status", None) or "completed"),
            )
        )
    return records


def _paragraphs(answer: str) -> list[str]:
    return [part.strip() for part in re.split(r"\n\s*\n", answer) if part.strip()]


def _is_markdown_table(paragraph: str) -> bool:
    """Return true only for a Markdown block containing a real table separator."""
    lines = [line.strip() for line in paragraph.splitlines() if line.strip()]
    if len(lines) < 2 or not any(line.startswith("|") for line in lines):
        return False
    return any(
        re.fullmatch(r"\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?", line)
        for line in lines
    )


def _is_markdown_heading(paragraph: str) -> bool:
    return bool(re.match(r"^#{1,6}\s+", paragraph.strip()))


def _is_limitation_disclosure(paragraph: str) -> bool:
    """Return true for explicit evidence limitations, not factual claims."""
    stripped = paragraph.strip()
    if re.match(
        r"^(?:#{1,6}\s*)?(?:\*\*)?(?:不确定性|局限(?:性)?|限制声明|证据边界|数据限制|使用建议)",
        stripped,
        re.IGNORECASE,
    ):
        return True
    if re.search(
        r"(?:本次|本轮).{0,50}?(?:证据|检索|资料).{0,120}?(?:未|无法|没有|不足)",
        stripped,
        re.IGNORECASE | re.DOTALL,
    ):
        return True
    if re.search(
        r"(?:引用|证据).{0,30}?(?:规则|状态).{0,120}?(?:无法|未能|不足|不写成)",
        stripped,
        re.IGNORECASE | re.DOTALL,
    ):
        return True
    nonempty_lines = [line.strip() for line in stripped.splitlines() if line.strip()]
    marker_lines = sum(bool(LIMITATION_MARKER_RE.search(line)) for line in nonempty_lines)
    marker_count = len(LIMITATION_MARKER_RE.findall(stripped))
    return marker_count >= 2 and marker_lines / max(len(nonempty_lines), 1) >= 0.5


def _is_proposed_parameter_table(paragraph: str) -> bool:
    """Exclude explicitly provisional design parameters from factual claims.

    This intentionally requires a Markdown table plus both proposal wording and
    a calibration/confirmation caveat. A numeric table presented as an existing
    standard therefore remains subject to ordinary evidence binding.
    """
    if not _is_markdown_table(paragraph):
        return False
    return bool(
        PROPOSED_PARAMETER_MARKER_RE.search(paragraph)
        and PROPOSED_PARAMETER_CAVEAT_RE.search(paragraph)
    )


def _is_action_plan(paragraph: str) -> bool:
    """Exclude future data-acquisition steps from factual-claim binding."""
    lines = [line.strip() for line in paragraph.strip().splitlines() if line.strip()]
    if not lines or not all(re.match(r"^(?:[-*+]\s+|\d+[.、]\s*)", line) for line in lines):
        return False
    action_lines = sum(bool(re.search(
        r"(?:建议|下一步|需要|需另行|应当|应先|获取|补充|检索|查询|核对|验证|确认|重新)",
        line,
        re.IGNORECASE,
    )) for line in lines)
    return action_lines / len(lines) >= 0.5


def _issue(code: str, message: str, severity: str = "error", details: dict[str, Any] | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"code": code, "message": message, "severity": severity}
    if details:
        result["details"] = details
    return result


def audit_answer_evidence(
    *,
    task_id: str = "",
    category: str,
    group: str,
    answer: str,
    answer_sources: Iterable[str],
    tool_evidence: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    tool_evidence = list(tool_evidence)
    answer_sources = list(dict.fromkeys(answer_sources))
    available_sources = {
        _canonical_url(source["url"]): source
        for evidence in tool_evidence
        for source in evidence.get("externalSources") or []
        if source.get("url")
    }
    answer_sources_by_key = {_canonical_url(url): url for url in answer_sources}
    cited_keys = set(answer_sources_by_key) & set(available_sources)
    cited_from_tools = sorted(available_sources[key]["url"] for key in cited_keys)
    cited_original_source_families = sorted({
        family
        for key in cited_keys
        if (family := _original_source_family(available_sources[key]))
    })
    answer_only_sources = sorted(answer_sources_by_key[key] for key in set(answer_sources_by_key) - set(available_sources))
    retrieved_not_cited = sorted(available_sources[key]["url"] for key in set(available_sources) - set(answer_sources_by_key))
    source_tables = sorted({table for evidence in tool_evidence for table in evidence.get("sourceTables") or []})
    query_digests = sorted({
        str(evidence.get("queryTrace", {}).get("digest"))
        for evidence in tool_evidence
        if evidence.get("kind") in {"internal", "sandbox"}
        and int(evidence.get("queryTrace", {}).get("queryCount") or 0) > 0
        and evidence.get("queryTrace", {}).get("digest")
    })
    query_count = sum(
        int(evidence.get("queryTrace", {}).get("queryCount") or 0)
        for evidence in tool_evidence
        if evidence.get("kind") in {"internal", "sandbox"}
    )

    valid_evidence_ids = {
        str(evidence.get("evidenceId")).upper()
        for evidence in tool_evidence
        if evidence.get("evidenceId")
    }
    valid_evidence_ids.update(
        str(identifier).upper()
        for evidence in tool_evidence
        for source in (evidence.get("externalSources") or [])
        for identifier in (source.get("sourceId"), source.get("providerEvidenceId"))
        if identifier
    )
    cited_ids = {match.upper() for match in EVIDENCE_ID_RE.findall(answer)}
    unknown_ids = sorted(cited_ids - valid_evidence_ids)
    paragraphs = _paragraphs(answer)
    # Section headings organize claims but are not themselves evidence-bearing prose.
    # Requiring a URL in every year-bearing heading inflated the denominator and
    # penalized otherwise fully cited reports.
    claim_paragraphs = [
        paragraph for paragraph in paragraphs
        if CLAIM_RE.search(paragraph)
        and not _is_markdown_heading(paragraph)
        and not _is_limitation_disclosure(paragraph)
        and not _is_action_plan(paragraph)
        and not _is_proposed_parameter_table(paragraph)
    ]
    internal_evidence_ids = {
        str(evidence.get("evidenceId")).upper()
        for evidence in tool_evidence
        if evidence.get("kind") in {"internal", "sandbox"} and evidence.get("evidenceId")
    }

    def has_external_binding(paragraph: str) -> bool:
        paragraph_ids = {match.upper() for match in EVIDENCE_ID_RE.findall(paragraph)}
        return bool(URL_RE.search(paragraph) or (paragraph_ids & (valid_evidence_ids - internal_evidence_ids)))

    def has_internal_binding(paragraph: str) -> bool:
        paragraph_lower = paragraph.lower()
        paragraph_ids = {match.upper() for match in EVIDENCE_ID_RE.findall(paragraph)}
        return bool(
            paragraph_ids & internal_evidence_ids
            or any(digest.lower() in paragraph_lower for digest in query_digests if digest and digest != "None")
            or any(re.search(rf"\b{re.escape(table)}\b", paragraph, re.IGNORECASE) for table in source_tables)
        )

    paragraph_positions: dict[str, list[int]] = {}
    for index, paragraph in enumerate(paragraphs):
        paragraph_positions.setdefault(paragraph, []).append(index)

    def has_adjacent_internal_binding(paragraph: str) -> bool:
        """Accept nearby explicit provenance without weakening prose-claim binding.

        Ordinary claims remain limited to an immediately adjacent provenance block.
        Markdown tables may cross one short interpretation block because reports
        commonly place a table, a one-paragraph takeaway, then the table provenance.
        """
        distance = 2 if _is_markdown_table(paragraph) else 1
        for index in paragraph_positions.get(paragraph, []):
            for offset in range(1, distance + 1):
                adjacent_indexes = (index - offset, index + offset)
                for adjacent_index in adjacent_indexes:
                    if not 0 <= adjacent_index < len(paragraphs):
                        continue
                    adjacent = paragraphs[adjacent_index]
                    if INTERNAL_PROVENANCE_MARKER_RE.search(adjacent) and has_internal_binding(adjacent):
                        return True
        return False

    def has_adjacent_external_binding(paragraph: str) -> bool:
        """Allow an immediately adjacent, explicitly labelled URL source note.

        Tables retain the historical adjacent-URL behavior. Ordinary prose and
        list blocks require a clear source-note label so an unrelated nearby URL
        cannot accidentally bind the claim.
        """
        for index in paragraph_positions.get(paragraph, []):
            for adjacent_index in (index - 1, index + 1):
                if not 0 <= adjacent_index < len(paragraphs):
                    continue
                adjacent = paragraphs[adjacent_index]
                if not has_external_binding(adjacent):
                    continue
                if _is_markdown_table(paragraph) or EXTERNAL_PROVENANCE_MARKER_RE.search(adjacent):
                    return True
        return False

    external_claims: list[str] = []
    internal_claims: list[str] = []
    for paragraph in claim_paragraphs:
        if category == "external":
            external_claims.append(paragraph)
        elif category == "internal":
            internal_claims.append(paragraph)
        elif _is_markdown_table(paragraph) and (
            has_internal_binding(paragraph) or has_adjacent_internal_binding(paragraph)
        ):
            # In hybrid reports an internal numeric table can contain words such
            # as “standard” or “latest”. Captured nearby database provenance is
            # stronger classification evidence than those lexical hints.
            internal_claims.append(paragraph)
        elif not URL_RE.search(paragraph) and (
            has_internal_binding(paragraph) or has_adjacent_internal_binding(paragraph)
        ) and (
            not STRONG_EXTERNAL_CLAIM_RE.search(paragraph)
            or POTENTIAL_CONTEXT_RE.search(paragraph)
            or METHODOLOGY_BLOCK_RE.search(paragraph)
        ):
            # A paragraph can mention external risk categories while reporting
            # internally measured exposure, or document methods/limitations.
            # When there is no URL or affirmative external conclusion, captured
            # internal provenance should bind the paragraph as internal.
            internal_claims.append(paragraph)
        elif URL_RE.search(paragraph) or STRONG_EXTERNAL_CLAIM_RE.search(paragraph):
            external_claims.append(paragraph)
        elif INTERNAL_CLAIM_RE.search(paragraph):
            internal_claims.append(paragraph)
        elif EXTERNAL_CLAIM_RE.search(paragraph):
            external_claims.append(paragraph)
        else:
            # In a hybrid answer, numerical claims without policy/standard/latest
            # markers normally come from the captured internal dataset.
            internal_claims.append(paragraph)

    external_bound_claims = [
        paragraph for paragraph in external_claims
        if has_external_binding(paragraph) or has_adjacent_external_binding(paragraph)
    ]
    internal_bound_claims = [
        paragraph for paragraph in internal_claims
        if has_internal_binding(paragraph) or has_adjacent_internal_binding(paragraph)
    ]
    bound_claims = external_bound_claims + internal_bound_claims
    claim_binding_rate = len(bound_claims) / len(claim_paragraphs) if claim_paragraphs else None
    external_binding_rate = len(external_bound_claims) / len(external_claims) if external_claims else None
    internal_binding_rate = len(internal_bound_claims) / len(internal_claims) if internal_claims else None
    issues: list[dict[str, Any]] = []

    if category in {"external", "hybrid"}:
        if available_sources and not cited_from_tools:
            issues.append(_issue("RETRIEVED_SOURCES_NOT_CITED", "工具检索到了外部来源，但最终回答没有引用这些来源链接。",
                                 details={"retrieved": len(available_sources), "cited": 0}))
        elif available_sources and len(cited_from_tools) / len(available_sources) < 0.25:
            issues.append(_issue("LOW_RETRIEVED_SOURCE_UTILIZATION", "最终回答只使用了少量已检索来源。",
                                 "warning", details={"retrieved": len(available_sources), "cited": len(cited_from_tools)}))
        if group != "baseline" and answer_only_sources:
            issues.append(_issue("ANSWER_SOURCE_NOT_IN_TOOL_EVIDENCE", "最终回答包含未出现在工具证据中的链接，需要人工核验来源是否真实访问。", "warning",
                                 details={"urls": answer_only_sources[:10]}))
        if unknown_ids:
            issues.append(_issue("UNKNOWN_EVIDENCE_ID_CITED", "最终回答引用了未在本次工具证据中登记的证据编号。",
                                 details={"evidenceIds": unknown_ids[:20]}))
        if external_claims and (external_binding_rate or 0) < MIN_EXTERNAL_CLAIM_BINDING_RATE:
            issues.append(_issue("KEY_CLAIMS_LACK_INLINE_CITATIONS", "至少75%的数字、政策、标准或时间性结论必须在相邻段落绑定URL或证据编号。",
                                 details={"claimParagraphs": len(external_claims), "boundParagraphs": len(external_bound_claims),
                                          "minimumBindingRate": MIN_EXTERNAL_CLAIM_BINDING_RATE,
                                          "sampleUnboundClaims": [item[:300] for item in external_claims if item not in external_bound_claims][:5]}))
        if task_id == "E01" and group != "baseline" and (
            len(cited_original_source_families) < 3 or INDEPENDENT_SOURCE_SHORTFALL_DISCLOSURE_RE.search(answer)
        ):
            issues.append(_issue(
                "ORIGINAL_SOURCE_DIVERSITY_INSUFFICIENT",
                "E01 至少需要3个独立原始来源；不同转载域名不能重复计为独立原始来源。",
                details={
                    "minimum": 3,
                    "actual": len(cited_original_source_families),
                    "sourceFamilies": cited_original_source_families,
                    "answerDisclosesShortfall": bool(INDEPENDENT_SOURCE_SHORTFALL_DISCLOSURE_RE.search(answer)),
                },
            ))

    if category in {"internal", "hybrid"} and group != "baseline" and internal_claims and (internal_binding_rate or 0) < MIN_INTERNAL_CLAIM_BINDING_RATE:
        issues.append(_issue(
            "INTERNAL_CLAIMS_LACK_PROVENANCE",
            "至少75%的内部数值结论必须就近绑定已捕获的来源表、查询摘要或内部工具证据编号。",
            details={
                "claimParagraphs": len(internal_claims),
                "boundParagraphs": len(internal_bound_claims),
                "minimumBindingRate": MIN_INTERNAL_CLAIM_BINDING_RATE,
                "sampleUnboundClaims": [item[:300] for item in internal_claims if item not in internal_bound_claims][:5],
            },
        ))

    if category in {"internal", "hybrid"} and group != "baseline":
        substantive = [item for item in tool_evidence if item.get("kind") in {"internal", "sandbox"} and item.get("status") not in {"error", "failed"}]
        if not substantive:
            issues.append(_issue("INTERNAL_TOOL_EVIDENCE_NOT_CAPTURED", "没有捕获到成功的内部数据或沙箱工具证据。"))
        if substantive and not source_tables and not query_digests and not any(item.get("resultSummary") for item in substantive):
            issues.append(_issue("INTERNAL_QUERY_PROVENANCE_NOT_CAPTURED", "内部工具已执行，但没有捕获来源表、查询摘要或结构化结果摘要。"))
        mentioned_tables = {
            table for table in KNOWN_TABLES
            if re.search(rf"\b{re.escape(table)}\b", answer, re.IGNORECASE)
        }
        unsupported_tables = sorted(mentioned_tables - set(source_tables))
        if unsupported_tables and source_tables:
            issues.append(_issue("ANSWER_TABLE_NOT_IN_TOOL_EVIDENCE", "回答提到的部分来源表未出现在工具查询血缘中。", "warning",
                                 details={"tables": unsupported_tables, "capturedSourceTables": source_tables}))

    errors = [issue for issue in issues if issue["severity"] == "error"]
    if not errors:
        status = "complete"
    elif answer_sources or source_tables or query_digests or tool_evidence:
        status = "partial"
    else:
        status = "insufficient"
    return {
        "evidenceAuditVersion": 8,
        "evidenceAuditStatus": status,
        "evidenceAuditPassed": not errors,
        "evidenceAuditErrors": errors,
        "evidenceAuditWarnings": [issue for issue in issues if issue["severity"] != "error"],
        "evidenceSummary": {
            "toolEvidenceCount": len(tool_evidence),
            "externalSourcesRetrieved": len(available_sources),
            "externalSourcesCited": len(cited_from_tools),
            "citedOriginalSourceFamilyCount": len(cited_original_source_families),
            "citedOriginalSourceFamilies": cited_original_source_families,
            "retrievedSourceUtilization": round(len(cited_from_tools) / len(available_sources), 4) if available_sources else None,
            "answerOnlySourceCount": len(answer_only_sources),
            "sourceTables": source_tables,
            "queryCount": query_count,
            "queryDigests": query_digests,
            "claimParagraphs": len(claim_paragraphs),
            "claimParagraphsWithCitation": len(bound_claims),
            "claimBindingRate": round(claim_binding_rate, 4) if claim_binding_rate is not None else None,
            "externalClaimParagraphs": len(external_claims),
            "externalClaimParagraphsWithCitation": len(external_bound_claims),
            "externalClaimBindingRate": round(external_binding_rate, 4) if external_binding_rate is not None else None,
            "internalClaimParagraphs": len(internal_claims),
            "internalClaimParagraphsWithProvenance": len(internal_bound_claims),
            "internalClaimBindingRate": round(internal_binding_rate, 4) if internal_binding_rate is not None else None,
            "retrievedNotCitedUrls": retrieved_not_cited[:20],
        },
    }

