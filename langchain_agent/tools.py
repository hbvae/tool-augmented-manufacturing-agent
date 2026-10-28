from __future__ import annotations

from collections.abc import Iterable
from typing import Any


CORE_TOOL_ALLOWLIST = frozenset(
    {
        "get_dataset_info",
        "list_tables",
        "describe_table",
        "ask_manufacturing_question",
        "analyze_quality_breakdown",
        "explain_manufacturing_metric",
        "list_metric_definitions",
        "get_domain_reliability_report",
        "get_python_sandbox_status",
        "run_natural_language_sandbox_analysis",
        "get_manufacturing_overview",
        "analyze_machine_360",
        "compare_machine_monthly_performance",
        "analyze_product_360",
        "analyze_supplier_inventory_risk",
        "find_inventory_exceptions",
        "find_cross_domain_risks",
        "get_anomaly_overview",
        "rank_root_cause_candidates",
        "rank_machine_root_causes_batch",
        "predict_maintenance_risk",
        "analyze_energy_production_efficiency",
    }
)

EXTERNAL_SEARCH_TOOL_ALLOWLIST = frozenset(
    {
        "search_external_sources",
        "retrieve_external_evidence",
        "retrieve_external_sources",
        "fetch_external_document",
        "cross_check_external_sources",
        "get_embedding_status",
    }
)

DEFAULT_TOOL_ALLOWLIST = CORE_TOOL_ALLOWLIST | EXTERNAL_SEARCH_TOOL_ALLOWLIST


def unprefixed_tool_name(name: str) -> str:
    for expected in sorted(DEFAULT_TOOL_ALLOWLIST, key=len, reverse=True):
        if name == expected or name.endswith(f"_{expected}"):
            return expected
    return name


def select_agent_tools(
    tools: Iterable[Any],
    *,
    include_all: bool = False,
    include_external_search: bool = True,
) -> list[Any]:
    items = list(tools)
    if include_all:
        return items
    allowed = DEFAULT_TOOL_ALLOWLIST if include_external_search else CORE_TOOL_ALLOWLIST
    return [tool for tool in items if unprefixed_tool_name(tool.name) in allowed]
