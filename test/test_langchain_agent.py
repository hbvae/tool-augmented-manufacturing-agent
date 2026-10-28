from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from langchain.agents.middleware.types import ModelResponse
from langchain_core.messages import AIMessage, ToolMessage

from langchain_agent.client import (
    MAX_AGENT_TOOL_RESULT_CHARACTERS,
    MIN_AGENT_TOOL_RESULT_CHARACTERS,
    BoundedToolResultMiddleware,
    GovernedCompletionGateMiddleware,
    ExternalToolBudgetMiddleware,
    RobustModelCallMiddleware,
    compress_tool_content,
)
from langchain_agent.settings import AgentSettings, ConfigurationError
from langchain_agent.tools import (
    CORE_TOOL_ALLOWLIST,
    DEFAULT_TOOL_ALLOWLIST,
    EXTERNAL_SEARCH_TOOL_ALLOWLIST,
    select_agent_tools,
    unprefixed_tool_name,
)


def write_config(tmp_path: Path, node_command: str, server_script: str) -> Path:
    target = tmp_path / "mcp.json"
    target.write_text(
        json.dumps(
            {
                "servers": {
                    "manufacturing-data": {
                        "type": "stdio",
                        "command": node_command,
                        "args": [server_script],
                        "env": {
                            "MANUFACTURING_DB": "demo.db",
                            "TAVILY_API_KEY": "${input:tavily-api-key}",
                            "MANUFACTURING_AIO_API_KEY": "configured-aio-key",
                        },
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    return target


def test_settings_reuses_stdio_config_and_drops_unresolved_inputs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    node = tmp_path / "node.exe"
    script = tmp_path / "server.mjs"
    node.write_bytes(b"")
    script.write_text("", encoding="utf-8")
    config = write_config(tmp_path, str(node), str(script))
    monkeypatch.setenv("MANUFACTURING_MCP_CONFIG", str(config))
    monkeypatch.setenv("MANUFACTURING_AIO_API_KEY", "environment-aio-key")
    monkeypatch.setenv("TAVILY_API_KEY", "")
    settings = AgentSettings.load(require_model=False)
    server = settings.mcp_config["mcpServers"]["manufacturing"]
    assert server["command"] == str(node)
    assert server["args"] == [str(script)]
    assert "TAVILY_API_KEY" not in server["env"]
    assert server["env"]["MANUFACTURING_AIO_API_KEY"] == "environment-aio-key"


def test_model_key_is_required_only_for_agent_execution(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    node = tmp_path / "node.exe"
    script = tmp_path / "server.mjs"
    node.write_bytes(b"")
    script.write_text("", encoding="utf-8")
    monkeypatch.setenv("MANUFACTURING_MCP_CONFIG", str(write_config(tmp_path, str(node), str(script))))
    for key in ("MANUFACTURING_LLM_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY"):
        # Empty process values prevent the project's real .env from leaking into this isolated test.
        monkeypatch.setenv(key, "")
    assert AgentSettings.load(require_model=False).api_key is None
    with pytest.raises(ConfigurationError, match="API Key"):
        AgentSettings.load(require_model=True)


def test_default_tool_selection_keeps_high_level_safe_surface() -> None:
    tools = [
        SimpleNamespace(name="manufacturing_run_natural_language_sandbox_analysis"),
        SimpleNamespace(name="manufacturing_get_dataset_info"),
        SimpleNamespace(name="manufacturing_get_domain_reliability_report"),
        SimpleNamespace(name="manufacturing_analyze_quality_breakdown"),
        SimpleNamespace(name="manufacturing_analyze_machine_360"),
        SimpleNamespace(name="manufacturing_compare_machine_monthly_performance"),
        SimpleNamespace(name="manufacturing_analyze_supplier_inventory_risk"),
        SimpleNamespace(name="manufacturing_find_inventory_exceptions"),
        SimpleNamespace(name="manufacturing_rank_root_cause_candidates"),
        SimpleNamespace(name="manufacturing_rank_machine_root_causes_batch"),
        SimpleNamespace(name="manufacturing_analyze_energy_production_efficiency"),
        SimpleNamespace(name="manufacturing_run_python_analysis"),
        SimpleNamespace(name="manufacturing_run_readonly_sql"),
    ]
    selected = select_agent_tools(tools)
    assert [tool.name for tool in selected] == [
        "manufacturing_run_natural_language_sandbox_analysis",
        "manufacturing_get_dataset_info",
        "manufacturing_get_domain_reliability_report",
        "manufacturing_analyze_quality_breakdown",
        "manufacturing_analyze_machine_360",
        "manufacturing_compare_machine_monthly_performance",
        "manufacturing_analyze_supplier_inventory_risk",
        "manufacturing_find_inventory_exceptions",
        "manufacturing_rank_root_cause_candidates",
        "manufacturing_rank_machine_root_causes_batch",
        "manufacturing_analyze_energy_production_efficiency",
    ]
    assert len(CORE_TOOL_ALLOWLIST) == 22
    assert len(EXTERNAL_SEARCH_TOOL_ALLOWLIST) == 6
    assert len(DEFAULT_TOOL_ALLOWLIST) == 28
    assert unprefixed_tool_name(selected[0].name) == "run_natural_language_sandbox_analysis"


def test_all_tools_requires_explicit_opt_in() -> None:
    tools = [SimpleNamespace(name="run_python_analysis"), SimpleNamespace(name="run_readonly_sql")]
    assert select_agent_tools(tools) == []
    assert select_agent_tools(tools, include_all=True) == tools


def test_external_search_tools_can_be_disabled_without_hiding_core_tools() -> None:
    tools = [
        SimpleNamespace(name="ask_manufacturing_question"),
        SimpleNamespace(name="search_external_sources"),
        SimpleNamespace(name="fetch_external_document"),
    ]
    selected = select_agent_tools(tools, include_external_search=False)
    assert [tool.name for tool in selected] == ["ask_manufacturing_question"]


def test_agent_tool_result_compression_preserves_structure_and_urls() -> None:
    payload = {
        "items": [
            {"title": f"来源{index}", "url": f"https://source{index}.example/report", "excerpt": "证据" * 2_000}
            for index in range(30)
        ],
        "metadata": {"requestId": "req-1", "sourceTables": []},
    }
    compressed, changed = compress_tool_content(json.dumps(payload, ensure_ascii=False))
    assert changed is True
    assert isinstance(compressed, str)
    assert len(compressed) <= MAX_AGENT_TOOL_RESULT_CHARACTERS
    decoded = json.loads(compressed)
    assert decoded["_compression"]["applied"] is True
    assert decoded["payload"]["metadata"]["requestId"] == "req-1"
    assert decoded["payload"]["items"][0]["url"] == "https://source0.example/report"


def test_agent_tool_result_budget_shrinks_after_cumulative_context_is_consumed() -> None:
    request = SimpleNamespace(state={
        "messages": [ToolMessage(content="x" * 30_000, tool_call_id="prior-call")],
    })
    assert BoundedToolResultMiddleware()._result_limit(request) == MIN_AGENT_TOOL_RESULT_CHARACTERS


def test_model_call_timeout_policy_is_bounded() -> None:
    middleware = RobustModelCallMiddleware(timeout_seconds=150, timeout_retries=1)
    assert middleware.timeout_seconds == 150
    assert middleware.timeout_retries == 1


def test_external_stop_counter_counts_successes_but_not_tool_errors() -> None:
    messages = [
        ToolMessage(content='{"items":[]}', name="retrieve_external_evidence", tool_call_id="ok-1", status="success"),
        ToolMessage(content='{"dataAvailable":false}', name="fetch_external_document", tool_call_id="ok-2", status="success"),
        ToolMessage(content='{"error":{"code":"FAILED"}}', name="search_external_sources", tool_call_id="bad", status="error"),
    ]
    assert GovernedCompletionGateMiddleware._successful_external_call_count(messages) == 2
    assert GovernedCompletionGateMiddleware._successful_tool_counts(messages) == {
        "retrieve_external_evidence": 1,
        "fetch_external_document": 1,
    }


def test_required_external_source_categories_are_derived_from_question_semantics() -> None:
    question = "至少使用设备厂商资料、专利或论文、维修技术资料三类来源形成排查步骤。"
    assert GovernedCompletionGateMiddleware._required_external_source_categories(question) == {
        "manufacturer", "research", "maintenance",
    }


def test_external_source_category_coverage_uses_domain_and_local_source_content() -> None:
    payload = {
        "items": [
            {
                "title": "Haas spindle troubleshooting service manual",
                "url": "https://www.haascnc.com/service/troubleshooting-and-how-to/troubleshooting/spindle.html",
                "excerpt": "Official maintenance manual and troubleshooting guide.",
            },
            {
                "title": "Machine tool spindle vibration fault diagnosis paper",
                "url": "https://doi.org/10.1000/spindle-paper",
                "excerpt": "Conference paper on bearing vibration diagnosis.",
            },
        ]
    }
    messages = [ToolMessage(
        content=json.dumps(payload), name="retrieve_external_evidence",
        tool_call_id="external-categories", status="success",
    )]
    assert GovernedCompletionGateMiddleware._covered_external_source_categories(messages) == {
        "manufacturer", "research", "maintenance",
    }


def test_low_authority_pages_do_not_satisfy_governed_source_categories() -> None:
    payload = {
        "items": [
            {
                "title": "官方主轴维修手册和论文汇总",
                "url": "https://baike.baidu.com/item/example",
                "excerpt": "转载的厂商手册、维修指南和论文介绍。",
            }
        ]
    }
    messages = [ToolMessage(
        content=json.dumps(payload, ensure_ascii=False), name="retrieve_external_evidence",
        tool_call_id="external-junk", status="success",
    )]
    assert GovernedCompletionGateMiddleware._covered_external_source_categories(messages) == set()


def test_category_search_stops_after_three_calls_with_one_unimproved_gap() -> None:
    required = {"manufacturer", "research", "maintenance"}
    covered = {"manufacturer", "research"}
    assert GovernedCompletionGateMiddleware._category_search_has_diminishing_returns(
        call_count=3, required=required, covered=covered, latest={"manufacturer"},
    ) is True
    assert GovernedCompletionGateMiddleware._category_search_has_diminishing_returns(
        call_count=2, required=required, covered=covered, latest={"manufacturer"},
    ) is False
    assert GovernedCompletionGateMiddleware._category_search_has_diminishing_returns(
        call_count=3, required=required, covered=covered, latest={"maintenance"},
    ) is False


def test_equipment_external_evidence_stop_requires_url_and_domain_diversity() -> None:
    payload = {
        "items": [
            {"title": f"Source {index}", "url": f"https://source{index % 3}.example/report/{index}", "excerpt": "evidence"}
            for index in range(6)
        ]
    }
    messages = [ToolMessage(
        content=json.dumps(payload), name="retrieve_external_evidence",
        tool_call_id="external-diverse", status="success",
    )]
    assert GovernedCompletionGateMiddleware._has_sufficient_equipment_external_evidence(messages) is True


def test_parallel_external_tool_calls_are_trimmed_to_remaining_budget() -> None:
    response = ModelResponse(result=[AIMessage(content="", tool_calls=[
        {"name": "retrieve_external_evidence", "args": {"query": "one"}, "id": "ext-1", "type": "tool_call"},
        {"name": "retrieve_external_evidence", "args": {"query": "two"}, "id": "ext-2", "type": "tool_call"},
        {"name": "analyze_quality_breakdown", "args": {"dimension": "machine"}, "id": "internal-1", "type": "tool_call"},
    ])])
    trimmed = ExternalToolBudgetMiddleware.trim_response(response, remaining=1)
    names = [call["name"] for call in trimmed.result[0].tool_calls]
    assert names == ["retrieve_external_evidence", "analyze_quality_breakdown"]


def test_external_tool_calls_are_serialized_even_when_budget_has_room() -> None:
    response = ModelResponse(result=[AIMessage(content="", tool_calls=[
        {"name": "retrieve_external_evidence", "args": {"query": "one"}, "id": "ext-1", "type": "tool_call"},
        {"name": "search_external_sources", "args": {"query": "two"}, "id": "ext-2", "type": "tool_call"},
        {"name": "fetch_external_document", "args": {"url": "https://example.com"}, "id": "ext-3", "type": "tool_call"},
        {"name": "analyze_quality_breakdown", "args": {"dimension": "machine"}, "id": "internal-1", "type": "tool_call"},
    ])])
    trimmed = ExternalToolBudgetMiddleware.trim_response(response, remaining=4)
    names = [call["name"] for call in trimmed.result[0].tool_calls]
    assert names == ["retrieve_external_evidence", "analyze_quality_breakdown"]


def test_agent_compression_removes_full_sql_list_from_model_visible_payload() -> None:
    payload = {
        "rows": [{"machine_id": "M03", "risk_score": 3}],
        "metadata": {
            "sourceTables": ["production_orders"],
            "queryTrace": {
                "digest": "abc123",
                "queries": [{"sql": "SELECT " + "x" * 4_000} for _ in range(10)],
            },
        },
    }
    compressed, changed = compress_tool_content(json.dumps(payload, ensure_ascii=False))
    decoded = json.loads(compressed)
    assert changed is True
    assert decoded["payload"]["rows"][0]["machine_id"] == "M03"
    assert decoded["payload"]["metadata"]["queryTrace"]["digest"] == "abc123"
    assert decoded["payload"]["metadata"]["queryTrace"]["queries"] == [
        {"_truncatedItems": 10, "_originalItems": 10}
    ]


def test_agent_compression_removes_sql_even_when_payload_is_below_size_limit() -> None:
    payload = {
        "rows": [{"machine_id": "M03", "risk_score": 3}],
        "metadata": {"queryTrace": {"digest": "small123", "queries": [{"sql": "SELECT 1"}]}},
    }
    compressed, changed = compress_tool_content(json.dumps(payload, ensure_ascii=False))
    decoded = json.loads(compressed)
    assert changed is True
    assert decoded["payload"]["metadata"]["queryTrace"]["digest"] == "small123"
    assert decoded["payload"]["metadata"]["queryTrace"]["queries"] == [
        {"_truncatedItems": 1, "_originalItems": 1}
    ]


def test_monthly_energy_compression_keeps_all_period_rows() -> None:
    rows = [{
        "period": f"2026-{index % 6 + 1:02d}", "machine_id": f"M{index % 8 + 1:02d}",
        "electricity_kwh": 100 + index, "max_peak_demand_kw": 20,
        "runtime_hours": 10, "actual_qty": 200, "good_qty": 195,
        "scrap_qty": 5, "kwh_per_good_unit": 0.5, "quantity_balance_ok": True,
        "irrelevant_large_field": "x" * 300,
    } for index in range(48)]
    compressed, changed = compress_tool_content(json.dumps({"periodRows": rows}, ensure_ascii=False))
    payload = json.loads(compressed)["payload"]
    assert changed is True
    assert len(compressed) <= MAX_AGENT_TOOL_RESULT_CHARACTERS
    assert payload["periodRowsComplete"] is True
    assert payload["completePeriodRowCount"] == 48
    assert payload["periodRowsMarkdown"].count("\n") == 49
