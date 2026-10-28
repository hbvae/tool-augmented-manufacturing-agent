from __future__ import annotations

from collections import Counter
from typing import Any, Iterable


DISCOVERY_TOOLS = {
    "get_dataset_info",
    "list_tables",
    "describe_table",
    "list_metric_definitions",
    "get_embedding_status",
    "get_python_sandbox_status",
}
GENERIC_ANALYSIS_TOOLS = {"ask_manufacturing_question"}
HIGH_LEVEL_ANALYSIS_TOOLS = {
    "get_manufacturing_overview",
    "analyze_machine_360",
    "compare_machine_monthly_performance",
    "analyze_product_360",
    "analyze_supplier_inventory_risk",
    "find_cross_domain_risks",
    "get_anomaly_overview",
    "rank_root_cause_candidates",
    "rank_machine_root_causes_batch",
    "predict_maintenance_risk",
    "analyze_energy_production_efficiency",
}
EXTERNAL_TOOLS = {
    "search_external_sources",
    "retrieve_external_evidence",
    "retrieve_external_sources",
    "fetch_external_document",
    "cross_check_external_sources",
}


def _issue(code: str, message: str, details: dict[str, Any]) -> dict[str, Any]:
    return {"code": code, "message": message, "severity": "warning", "details": details}


def audit_tool_efficiency(tool_evidence: Iterable[dict[str, Any]], *, total_tokens: int | None = None) -> dict[str, Any]:
    """Produce descriptive efficiency metrics without enforcing hard call limits."""
    evidence = list(tool_evidence)
    names = [str(item.get("tool") or "unknown") for item in evidence]
    tool_counts = Counter(names)
    signatures = [f"{name}:{item.get('argumentsDigest') or ''}" for name, item in zip(names, evidence)]
    signature_counts = Counter(signatures)
    duplicate_count = sum(count - 1 for count in signature_counts.values() if count > 1)
    duplicate_signatures = sorted(signature for signature, count in signature_counts.items() if count > 1)
    discovery_count = sum(name in DISCOVERY_TOOLS for name in names)
    generic_count = sum(name in GENERIC_ANALYSIS_TOOLS for name in names)
    high_level_count = sum(name in HIGH_LEVEL_ANALYSIS_TOOLS for name in names)
    external_count = sum(name in EXTERNAL_TOOLS for name in names)
    sandbox_count = sum("sandbox" in name or "python" in name for name in names)
    failed_count = sum(item.get("status") in {"error", "failed", "failure"} for item in evidence)
    successful = [item for item in evidence if item.get("status") not in {"error", "failed", "failure"}]
    evidence_bearing = [
        item for item in successful
        if item.get("externalSources")
        or item.get("sourceTables")
        or int(item.get("queryTrace", {}).get("queryCount") or 0) > 0
        or bool(item.get("resultSummary"))
    ]
    call_count = len(evidence)
    discovery_rate = discovery_count / call_count if call_count else None
    duplicate_rate = duplicate_count / call_count if call_count else None
    productive_rate = len(evidence_bearing) / call_count if call_count else None
    warnings: list[dict[str, Any]] = []
    if duplicate_count:
        warnings.append(_issue(
            "EXACT_DUPLICATE_TOOL_CALLS",
            "存在工具名和参数完全相同的重复调用；应复用首次结果。",
            {"duplicateCallCount": duplicate_count, "signatures": duplicate_signatures[:10]},
        ))
    if discovery_count >= 4 and (discovery_rate or 0) >= 0.3:
        warnings.append(_issue(
            "DISCOVERY_HEAVY_PLAN",
            "数据集或表结构发现调用占比较高；已知实体可由高层工具处理时应直接分析。",
            {"discoveryCallCount": discovery_count, "discoveryCallRate": round(discovery_rate or 0, 4)},
        ))
    if generic_count >= 3 and (not high_level_count or generic_count > high_level_count * 2):
        warnings.append(_issue(
            "GENERIC_ANALYSIS_TOOL_OVERUSE",
            "连续依赖通用问答工具，未使用可一次返回跨表证据的高层分析工具。",
            {"genericAnalysisCallCount": generic_count, "highLevelAnalysisCallCount": high_level_count},
        ))
    if sandbox_count >= 6 and sandbox_count / call_count >= 0.5:
        warnings.append(_issue(
            "SANDBOX_QUERY_FRAGMENTATION",
            "同一任务被拆成大量沙箱调用；应优先使用一次返回完整时间×实体结果的高层分析工具。",
            {"sandboxCallCount": sandbox_count, "sandboxCallRate": round(sandbox_count / call_count, 4)},
        ))
    partitioned_tools = {
        name: count for name, count in tool_counts.items()
        if count >= 6 and len({signature for signature in signatures if signature.startswith(f"{name}:")}) >= 4
    }
    if partitioned_tools:
        warnings.append(_issue(
            "PARTITIONED_TOOL_CALL_EXPLOSION",
            "同一工具被不同筛选参数拆分为大量调用；应复用一次完整高层结果，而不是按实体或月份重新查询。",
            {"tools": partitioned_tools},
        ))
    high_level_fanout = {name: count for name, count in tool_counts.items() if name in HIGH_LEVEL_ANALYSIS_TOOLS and count >= 6}
    if high_level_fanout:
        warnings.append(_issue(
            "HIGH_LEVEL_TOOL_FANOUT",
            "高层综合工具被重复调用过多，说明完成条件或检索停止条件未生效。",
            {"tools": high_level_fanout},
        ))
    if failed_count:
        warnings.append(_issue(
            "TOOL_CALL_FAILURES",
            "工具链包含失败调用；应检查参数、空结果处理或降级路径。",
            {"failedToolCallCount": failed_count},
        ))
    if external_count >= 4:
        warnings.append(_issue(
            "EXTERNAL_SEARCH_FANOUT_HIGH",
            "外部检索调用较多；应先使用覆盖面充分的查询，再针对明确缺口追加检索。",
            {"externalSearchCallCount": external_count},
        ))
    semantic_overlap = "analyze_machine_360" in names and "find_cross_domain_risks" in names
    individual_root_cause_count = names.count("rank_root_cause_candidates")
    if semantic_overlap:
        warnings.append(_issue(
            "SEMANTICALLY_REDUNDANT_RISK_TOOLS",
            "同一回答同时调用了设备360风险排名和跨域风险筛选；两者的风险触发逻辑重叠，应保留与题目口径一致的一种。",
            {"tools": ["analyze_machine_360", "find_cross_domain_risks"]},
        ))
    if individual_root_cause_count >= 2:
        warnings.append(_issue(
            "ROOT_CAUSE_CALL_FRAGMENTATION",
            "对多台设备逐台调用根因工具；应改用一次 rank_machine_root_causes_batch。",
            {"individualRootCauseCallCount": individual_root_cause_count},
        ))
    if call_count and isinstance(total_tokens, int) and total_tokens > 40_000:
        warnings.append(_issue(
            "MODEL_CONTEXT_TOKEN_HIGH",
            "本次工具型回答的总Token偏高；应继续压缩模型可见工具结果或更早停止补充分析。",
            {"totalTokens": total_tokens, "warningAbove": 40_000, "toolCallCount": call_count},
        ))
    penalty = 0.0
    penalty += (duplicate_rate or 0) * 40
    penalty += max(0.0, (discovery_rate or 0) - 0.25) * 40
    penalty += max(0, generic_count - 2) * 5
    penalty += max(0, external_count - 3) * 5
    penalty += max(0, sandbox_count - 4) * 3
    penalty += failed_count * 5
    penalty += 10 if call_count and isinstance(total_tokens, int) and total_tokens > 40_000 else 0
    penalty += 10 if semantic_overlap else 0
    penalty += min(15, max(0, individual_root_cause_count - 1) * 5)
    penalty += min(30, sum(max(0, count - 2) for count in partitioned_tools.values()) * 2)
    score = round(max(0.0, 100.0 - penalty), 1) if call_count else None
    return {
        "efficiencyAuditVersion": 5,
        "efficiencyStatus": "not_applicable" if not call_count else ("review" if warnings or (score is not None and score < 80) else "efficient"),
        "efficiencyScore": score,
        "efficiencyWarnings": warnings,
        "efficiencySummary": {
            "toolCallCount": call_count,
            "uniqueToolCount": len(set(names)),
            "uniqueCallSignatureCount": len(set(signatures)),
            "exactDuplicateCallCount": duplicate_count,
            "duplicateCallRate": round(duplicate_rate, 4) if duplicate_rate is not None else None,
            "discoveryCallCount": discovery_count,
            "discoveryCallRate": round(discovery_rate, 4) if discovery_rate is not None else None,
            "genericAnalysisCallCount": generic_count,
            "highLevelAnalysisCallCount": high_level_count,
            "externalSearchCallCount": external_count,
            "sandboxCallCount": sandbox_count,
            "failedToolCallCount": failed_count,
            "evidenceBearingCallCount": len(evidence_bearing),
            "productiveCallRate": round(productive_rate, 4) if productive_rate is not None else None,
            "totalTokens": total_tokens,
            "tokensPerToolCall": round(total_tokens / call_count, 1) if isinstance(total_tokens, int) and call_count else None,
            "semanticOverlapDetected": semantic_overlap,
            "individualRootCauseCallCount": individual_root_cause_count,
            "toolSequence": names,
            "toolCounts": dict(sorted(tool_counts.items())),
            "partitionedToolCalls": partitioned_tools,
        },
    }
