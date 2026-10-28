from __future__ import annotations

import csv
import json
from pathlib import Path

from langchain_core.messages import AIMessage, ToolMessage

from langchain_agent.comparison_experiment import (
    BASELINE_SYSTEM_PROMPT,
    ExperimentQuestion,
    answer_quality,
    build_finalization_recovery_evidence,
    _source_category_candidates,
    correctable_validation_codes,
    correctable_evidence_codes,
    correctable_source_validation_codes,
    extract_artifacts,
    extract_sources,
    fixed_context_plan,
    load_questions,
    message_usage,
    needs_external_finalization_recovery,
    contains_pseudo_tool_call,
    parser,
    prepare_blind_evaluation,
    score_ratings,
    select_questions,
    tool_metrics,
    tool_trace,
    write_all_outputs_report,
    write_evidence_audit_outputs,
    write_efficiency_audit_output,
    write_qualitative_report,
)
from langchain_agent.evidence_audit import audit_answer_evidence, build_agent_tool_evidence
from langchain_agent.efficiency_audit import audit_tool_efficiency
from langchain_agent.task_validation import TASK_CONTRACTS, validate_task_result


def test_load_and_filter_questions(tmp_path: Path) -> None:
    source = tmp_path / "questions.jsonl"
    source.write_text(
        "\n".join(
            [
                json.dumps({"taskId": "E01", "category": "external", "title": "外部", "question": "问题一"}),
                json.dumps({"taskId": "I01", "category": "internal", "title": "内部", "question": "问题二"}),
            ]
        ),
        encoding="utf-8",
    )
    questions = load_questions(source)
    selected = select_questions(questions, task_ids=None, categories={"external"}, limit=None)
    assert [item.task_id for item in selected] == ["E01"]


def test_baseline_prompt_is_isolated_from_tool_instructions() -> None:
    assert "当前对话没有任何工具" in BASELINE_SYSTEM_PROMPT
    assert "禁止输出工具调用" in BASELINE_SYSTEM_PROMPT
    assert "retrieve_external_evidence" not in BASELINE_SYSTEM_PROMPT
    assert "get_manufacturing_overview" not in BASELINE_SYSTEM_PROMPT
    assert contains_pseudo_tool_call('<｜｜DSML｜｜ invoke name="get_manufacturing_overview">')
    assert contains_pseudo_tool_call('<tool_call>{"name":"search"}</tool_call>')
    assert not contains_pseudo_tool_call("无法访问本地数据库，因此只能说明分析方法。")


def test_usage_tool_trace_and_sources_are_bounded_metadata() -> None:
    ai = AIMessage(
        content="",
        tool_calls=[{"name": "search_external_sources", "args": {"query": "secret query"}, "id": "call-1", "type": "tool_call"}],
        usage_metadata={"input_tokens": 10, "output_tokens": 4, "total_tokens": 14},
    )
    tool = ToolMessage(content="large private result", tool_call_id="call-1", name="search_external_sources", status="success")
    assert message_usage([ai, tool]) == {"promptTokens": 10, "completionTokens": 4, "totalTokens": 14}
    assert tool_trace([ai, tool]) == [{"name": "search_external_sources", "callId": "call-1", "status": "success"}]
    assert extract_sources("来源 `https://example.com/a`。重复 https://example.com/a\\") == ["https://example.com/a"]
    assert extract_sources("来源（https://example.com/cbam）【https://example.com/report】") == [
        "https://example.com/cbam",
        "https://example.com/report",
    ]


def test_tool_trace_extracts_mcp_error_and_metrics() -> None:
    ai = AIMessage(
        content="",
        tool_calls=[{"name": "search_external_sources", "args": {}, "id": "call-error", "type": "tool_call"}],
    )
    tool = ToolMessage(
        content=json.dumps(
            {"error": {"code": "INVALID_EXTERNAL_COUNTRY", "message": "country cannot be used with news"}},
            ensure_ascii=False,
        ),
        tool_call_id="call-error",
        name="search_external_sources",
        status="success",
    )
    trace = tool_trace([ai, tool])
    assert trace == [
        {
            "name": "search_external_sources",
            "callId": "call-error",
            "status": "error",
            "errorCode": "INVALID_EXTERNAL_COUNTRY",
            "errorMessage": "country cannot be used with news",
        }
    ]
    assert tool_metrics(trace) == {
        "toolCallCount": 1,
        "toolErrorCount": 1,
        "toolSuccessRate": 0.0,
        "degraded": True,
        "toolErrorCodes": ["INVALID_EXTERNAL_COUNTRY"],
    }


def test_tool_trace_classifies_unknown_tool_name() -> None:
    ai = AIMessage(
        content="",
        tool_calls=[{"name": "made_up_tool", "args": {}, "id": "call-invalid", "type": "tool_call"}],
    )
    tool = ToolMessage(
        content="Error: made_up_tool is not a valid tool, try one of [search_external_sources].",
        tool_call_id="call-invalid",
        name="made_up_tool",
        status="error",
    )
    trace = tool_trace([ai, tool])
    assert trace[0]["errorCode"] == "INVALID_TOOL_NAME"
    assert tool_metrics(trace)["toolErrorCodes"] == ["INVALID_TOOL_NAME"]


def test_tool_trace_prefers_raw_artifact_error_code() -> None:
    ai = AIMessage(content="", tool_calls=[{
        "name": "run_natural_language_sandbox_analysis", "args": {},
        "id": "sandbox-error", "type": "tool_call",
    }])
    tool = ToolMessage(
        content="工具执行失败", tool_call_id="sandbox-error",
        name="run_natural_language_sandbox_analysis", status="error",
        artifact={"manufacturingRawToolContent": json.dumps({
            "error": {"code": "SANDBOX_WORKFLOW_FAILED", "message": "prepare_dataset failed"}
        })},
    )
    trace = tool_trace([ai, tool])
    assert trace[0]["errorCode"] == "SANDBOX_WORKFLOW_FAILED"


def test_external_answer_without_url_gets_traceability_warning() -> None:
    external = ExperimentQuestion("E05", "external", "标题", "引用了ISO但没有链接")
    missing = answer_quality(external, "参考ISO 20816和厂商资料。")
    assert missing["sourceTraceabilityIncomplete"] is True
    assert missing["qualityWarnings"][0]["code"] == "EXTERNAL_SOURCE_URL_MISSING"
    complete = answer_quality(external, "来源：https://www.iso.org/")
    assert complete["sourceTraceabilityIncomplete"] is False


def test_prepare_blind_evaluation_separates_key(tmp_path: Path) -> None:
    records = [
        {
            "taskId": "E01",
            "repetition": 1,
            "category": "external",
            "title": "测试",
            "question": "测试问题",
            "qualitative": True,
            "group": "baseline",
            "answer": "基线回答",
            "success": True,
        },
        {
            "taskId": "E01",
            "repetition": 1,
            "category": "external",
            "title": "测试",
            "question": "测试问题",
            "qualitative": True,
            "group": "context_baseline",
            "answer": "固定上下文回答",
            "success": True,
        },
        {
            "taskId": "E01",
            "repetition": 1,
            "category": "external",
            "title": "测试",
            "question": "测试问题",
            "qualitative": True,
            "group": "agent",
            "answer": "智能体回答",
            "success": True,
        },
    ]
    (tmp_path / "raw_results.jsonl").write_text(
        "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in records),
        encoding="utf-8",
    )
    assert prepare_blind_evaluation(tmp_path, seed=7) == 1
    blind = (tmp_path / "blind_answers.jsonl").read_text(encoding="utf-8")
    key = (tmp_path / "blind_key.jsonl").read_text(encoding="utf-8")
    assert "baseline" not in blind and "context_baseline" not in blind and "agent" not in blind
    assert "answerC" in blind
    assert "baseline" in key and "context_baseline" in key and "agent" in key
    balance = json.loads((tmp_path / "blind_position_balance.json").read_text(encoding="utf-8"))
    assert balance["maximumPositionImbalance"] <= 1
    with (tmp_path / "ratings_template.csv").open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert rows[0]["taskId"] == "E01"
    assert write_qualitative_report(tmp_path) == 1
    assert write_all_outputs_report(tmp_path) == 1
    qualitative = (tmp_path / "qualitative_comparison.md").read_text(encoding="utf-8")
    assert "基线回答" in qualitative and "固定上下文回答" in qualitative and "智能体回答" in qualitative
    all_outputs = (tmp_path / "all_outputs_comparison.md").read_text(encoding="utf-8")
    assert "基线回答" in all_outputs and "固定上下文回答" in all_outputs and "智能体回答" in all_outputs


def test_blind_positions_are_globally_balanced(tmp_path: Path) -> None:
    records = []
    for task_index in range(1, 7):
        for group in ("baseline", "context_baseline", "agent"):
            records.append({
                "taskId": f"E{task_index:02d}", "repetition": 1, "category": "external",
                "title": "测试", "question": "测试问题", "group": group,
                "answer": f"{group}-{task_index}", "success": True,
            })
    (tmp_path / "raw_results.jsonl").write_text(
        "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in records), encoding="utf-8"
    )
    assert prepare_blind_evaluation(tmp_path, seed=23) == 6
    balance = json.loads((tmp_path / "blind_position_balance.json").read_text(encoding="utf-8"))
    assert balance["maximumPositionImbalance"] == 0
    for counts in balance["positionCounts"].values():
        assert counts == {"A": 2, "B": 2, "C": 2}

    ratings_path = tmp_path / "ratings_template.csv"
    with ratings_path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        fields = list(reader.fieldnames or [])
        rating_rows = list(reader)
    rating_rows[0]["evaluatorId"] = "R1"
    for label in ("A", "B", "C"):
        for dimension in ("taskCompletion", "accuracy", "traceability", "analysisDepth", "actionability", "uncertainty"):
            rating_rows[0][f"answer{label}_{dimension}"] = "4"
        rating_rows[0][f"answer{label}_overallSatisfaction"] = "4"
    rating_rows[0]["preferredAnswer"] = "A"
    with ratings_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rating_rows)
    assert score_ratings(tmp_path) == 3
    report = (tmp_path / "satisfaction_report.md").read_text(encoding="utf-8")
    assert "4.000" in report


def test_all_outputs_report_includes_non_qualitative_questions(tmp_path: Path) -> None:
    records = []
    for group, answer in (("baseline", "对照组E02"), ("agent", "智能体E02")):
        records.append(
            {
                "taskId": "E02",
                "repetition": 1,
                "category": "external",
                "title": "动力电池技术路线",
                "question": "测试问题",
                "qualitative": False,
                "group": group,
                "answer": answer,
                "success": True,
                "toolCalls": [],
                "sources": [],
            }
        )
    (tmp_path / "raw_results.jsonl").write_text(
        "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in records),
        encoding="utf-8",
    )
    assert write_qualitative_report(tmp_path) == 0
    assert write_all_outputs_report(tmp_path) == 1
    report = (tmp_path / "all_outputs_comparison.md").read_text(encoding="utf-8")
    assert "E02" in report and "对照组E02" in report and "智能体E02" in report


def test_all_outputs_report_keeps_single_group_run(tmp_path: Path) -> None:
    record = {
        "taskId": "I05",
        "repetition": 1,
        "category": "internal",
        "title": "能耗与生产效率",
        "question": "分析各设备月度能耗。",
        "qualitative": False,
        "group": "agent",
        "answer": "智能体单组完整回答",
        "success": True,
        "toolCalls": [],
        "sources": [],
    }
    (tmp_path / "raw_results.jsonl").write_text(
        json.dumps(record, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    assert write_all_outputs_report(tmp_path) == 1
    report = (tmp_path / "all_outputs_comparison.md").read_text(encoding="utf-8")
    assert "I05" in report
    assert "智能体单组完整回答" in report
    assert "尚未运行实验组：传统API闭卷基线, 固定上下文API基线" in report


def test_question_dataclass_defaults_to_non_qualitative() -> None:
    question = ExperimentQuestion("E01", "external", "标题", "问题")
    assert question.qualitative is False


def test_parser_defaults_to_all_three_groups_and_accepts_context_baseline() -> None:
    assert parser().parse_args([]).mode == "all"
    assert parser().parse_args(["--mode", "context_baseline"]).mode == "context_baseline"


def test_fixed_context_plan_is_deterministic_and_category_aware() -> None:
    external = ExperimentQuestion("E01", "external", "标题", "外部问题")
    internal = ExperimentQuestion("I01", "internal", "标题", "内部问题")
    hybrid = ExperimentQuestion("H01", "hybrid", "标题", "混合问题")
    external_plan = fixed_context_plan(external)
    assert [step["tool"] for step in external_plan] == ["retrieve_external_evidence", "retrieve_external_evidence"]
    assert "miit.gov.cn" in external_plan[0]["args"]["includeDomains"]
    assert [step["tool"] for step in fixed_context_plan(internal)] == [
        "analyze_machine_360", "predict_maintenance_risk",
    ]
    hybrid_tools = [step["tool"] for step in fixed_context_plan(hybrid)]
    assert hybrid_tools.count("ask_manufacturing_question") == 2
    assert hybrid_tools[-1] == "retrieve_external_evidence"

    regulated = ExperimentQuestion("E03", "external", "标题", "欧盟电池法规")
    regulated_plan = fixed_context_plan(regulated)
    assert [step["tool"] for step in regulated_plan] == ["retrieve_external_evidence", "retrieve_external_evidence"]
    assert regulated_plan[0]["args"]["language"] == "en"
    assert "eur-lex.europa.eu" in regulated_plan[0]["args"]["includeDomains"]
    assert regulated_plan[1]["args"]["language"] == "zh-cn"


def test_all_24_tasks_have_acceptance_contracts() -> None:
    assert set(TASK_CONTRACTS) == {
        *(f"E{index:02d}" for index in range(1, 9)),
        *(f"I{index:02d}" for index in range(1, 9)),
        *(f"H{index:02d}" for index in range(1, 9)),
    }


def test_external_contract_separates_completion_and_evidence() -> None:
    answer = (
        "数据时间范围截至2026年10月。CBAM正式阶段已经生效，并需区分未来计划。"
        "报告覆盖钢铁、铝和汽车零部件的直接与间接影响。" + "分析。" * 120
    )
    result = validate_task_result(
        task_id="E07",
        category="external",
        answer=answer,
        sources=[
            "https://taxation-customs.ec.europa.eu/cbam",
            "https://example-industry.org/report",
            "https://another-source.com/analysis",
        ],
    )
    assert result["completionStatus"] == "complete"
    assert result["evidenceStatus"] == "complete"
    assert result["validationPassed"] is True


def test_missing_urls_only_fails_evidence_status() -> None:
    answer = (
        "数据时间范围截至2026年10月。CBAM正式阶段已经生效，并需区分未来计划。"
        "报告覆盖钢铁、铝和汽车零部件的直接与间接影响。" + "分析。" * 120
    )
    result = validate_task_result(task_id="E07", category="external", answer=answer)
    assert result["completionStatus"] == "complete"
    assert result["evidenceStatus"] == "insufficient"
    assert {item["code"] for item in result["validationErrors"]} >= {
        "SOURCE_URL_COUNT_INSUFFICIENT",
        "INDEPENDENT_SOURCE_COUNT_INSUFFICIENT",
        "OFFICIAL_SOURCE_MISSING",
    }


def test_date_range_accepts_natural_knowledge_cutoff_and_year_only_range() -> None:
    cases = (
        "下面内容基于训练知识范围内的公开行业信息，主要覆盖到2024年。",
        "以下内容的时间基准大致为2024年至2025年初的公开行业信息。",
        "本报告资料截至2024年12月，之后的变化无法实时核验。",
    )
    for answer_prefix in cases:
        answer = answer_prefix + "产量、销量、渗透率、出口、电池和政策分析。" + "分析。" * 120
        result = validate_task_result(task_id="E01", category="external", answer=answer)
        assert "DATA_TIME_RANGE_MISSING" not in {item["code"] for item in result["validationErrors"]}


def test_date_range_accepts_markdown_as_of_observation_and_forecast_window() -> None:
    answer = (
        "数据时间范围：工具返回的观测日期为 **2026-06-29**（asOfDate），30 天预测窗口。"
        "内部数据与外部公开资料已明确区分，M03传感器采样指标、报警逻辑和验证方法如下。"
        "来源：https://source1.example/report 和 https://source2.example/guide。" + "分析。" * 120
    )
    result = validate_task_result(
        task_id="H05", category="hybrid", answer=answer,
        sources=["https://source1.example/report", "https://source2.example/guide"],
        tool_calls=[{"name": "predict_maintenance_risk", "status": "success"}],
    )
    assert "DATA_TIME_RANGE_MISSING" not in {
        item["code"] for item in result["validationErrors"]
    }


def test_date_range_does_not_accept_unrelated_year_mentions() -> None:
    answer = "2024年销量增长，预计2025年继续增长。产量、销量、渗透率、出口、电池和政策分析。" + "分析。" * 120
    result = validate_task_result(task_id="E01", category="external", answer=answer)
    assert "DATA_TIME_RANGE_MISSING" in {item["code"] for item in result["validationErrors"]}


def test_date_range_accepts_explicit_unavailable_range_disclosure() -> None:
    answer = (
        "数据时间范围：工具未返回明确的数据时间范围，因此当前数据集全量的起止日期无法界定。"
        "内部数据与外部资料已明确区分。缺陷类型、短期遏制、原因验证和D5长期纠正措施如下。"
        + "分析。" * 120
    )
    result = validate_task_result(task_id="H03", category="hybrid", answer=answer)
    codes = {item["code"] for item in result["validationErrors"]}
    assert "DATA_TIME_RANGE_MISSING" not in codes
    assert "REQUIRED_TOPIC_MISSING" not in codes


def test_date_range_accepts_unavailable_marker_before_chinese_range_label() -> None:
    answer = (
        "内部数据结论与外部方法证据已分开说明。数据限制说明："
        "工具返回的 dataTimeRange.observedInResult 为空，未能确认质量记录的具体起止日期。"
        "缺陷类型为BURR，设备M01；方案包含短期遏制、原因验证和D7防止再发。"
        + "分析。" * 120
    )
    result = validate_task_result(task_id="H03", category="hybrid", answer=answer)
    codes = {item["code"] for item in result["validationErrors"]}
    assert "DATA_TIME_RANGE_MISSING" not in codes
    assert "INTERNAL_EXTERNAL_DISTINCTION_MISSING" not in codes


def test_h03_accepts_permanent_corrective_action_as_long_term_improvement() -> None:
    answer = (
        "数据时间范围：2026-01-01至2026-06-30。内部数据与外部资料已明确区分。"
        "缺陷类型为BURR，相关设备M01。方案包含短期遏制、原因验证、永久纠正措施及D7防止再发。"
        + "分析。" * 120
    )
    result = validate_task_result(task_id="H03", category="hybrid", answer=answer)
    missing = [item for item in result["validationErrors"] if item["code"] == "REQUIRED_TOPIC_MISSING"]
    assert missing == []


def test_external_budget_progress_answer_triggers_finalization_recovery() -> None:
    trace = [
        {"name": "retrieve_external_evidence", "status": "success"}
        for _ in range(4)
    ]
    assert needs_external_finalization_recovery(
        "还需要继续检索，接下来补充政策原文。", trace, 4,
    ) is True
    assert needs_external_finalization_recovery(
        "完整最终答案。" + "结论。" * 120, trace, 4,
    ) is False
    assert needs_external_finalization_recovery(
        "还需要继续检索。", trace[:3], 4,
    ) is False


def test_pseudo_tool_call_triggers_recovery_without_external_budget() -> None:
    trace = [{"name": "analyze_supplier_inventory_risk", "status": "success"}]
    answer = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="analyze_supplier_inventory_risk">'
    assert needs_external_finalization_recovery(answer, trace, 4) is True


def test_finalization_recovery_evidence_is_bounded_and_keeps_source_urls() -> None:
    calls = [{
        "name": "retrieve_external_evidence", "args": {"query": "新能源汽车"},
        "id": "ext-1", "type": "tool_call",
    }]
    payload = {
        "evidence": [
            {"title": f"来源{index}", "url": f"https://source{index}.example/report", "excerpt": "证据" * 500}
            for index in range(80)
        ]
    }
    messages = [
        AIMessage(content="", tool_calls=calls),
        ToolMessage(
            content=json.dumps(payload, ensure_ascii=False), name="retrieve_external_evidence",
            tool_call_id="ext-1", status="success",
        ),
    ]
    packet = build_finalization_recovery_evidence(messages)
    assert len(packet) <= 24_100
    assert "https://source0.example/report" in packet
    assert "完整证据仍保留在实验记录中" in packet


def test_finalization_recovery_packet_keeps_internal_scope_and_sufficiency() -> None:
    messages = [
        AIMessage(content="", tool_calls=[{
            "name": "analyze_supplier_inventory_risk",
            "args": {"dateFrom": "2025-01-01", "dateTo": "2025-12-31"},
            "id": "internal-1", "type": "tool_call",
        }]),
        ToolMessage(
            content=json.dumps({
                "rows": [],
                "metadata": {
                    "returnedRows": 0,
                    "dataTimeRange": {"requested": {"dateFrom": "2025-01-01", "dateTo": "2025-12-31"}},
                    "dataSufficiency": {"status": "insufficient"},
                    "sourceTables": ["inventory_transactions"],
                    "queryTrace": {"queryCount": 1, "digest": "inventory123", "queries": []},
                },
            }, ensure_ascii=False),
            name="analyze_supplier_inventory_risk", tool_call_id="internal-1", status="success",
        ),
    ]
    packet = build_finalization_recovery_evidence(messages)
    assert "inventory_transactions" in packet
    assert "insufficient" in packet
    assert "2025-01-01" in packet


def test_external_audit_excludes_markdown_headings_and_binds_adjacent_table_source_note() -> None:
    url = "https://official.example/report"
    evidence = [{
        "evidenceId": "TE-001", "kind": "external", "status": "success", "sourceTables": [],
        "queryTrace": {"queryCount": 0},
        "externalSources": [{"url": url, "domain": "official.example", "title": "报告", "excerptPreview": "数据"}],
    }]
    answer = (
        "# 2026年行业趋势\n\n"
        "| 年份 | 销量 |\n|---|---:|\n| 2026 | 100万辆 |\n\n"
        f"口径对照来源：{url}\n\n"
        f"截至2026年，行业进入新阶段。{url}"
    )
    audit = audit_answer_evidence(
        category="external", group="agent", answer=answer,
        answer_sources=[url], tool_evidence=evidence,
    )
    summary = audit["evidenceSummary"]
    assert summary["externalClaimParagraphs"] == 2
    assert summary["externalClaimParagraphsWithCitation"] == 2
    assert audit["evidenceAuditStatus"] == "complete"


def test_e01_audit_rejects_reposts_of_only_two_original_source_families() -> None:
    urls = [
        "https://miit.gov.cn/a", "https://news.example.com/b", "https://media.example.org/c",
    ]
    evidence = [{
        "evidenceId": "TE-001", "kind": "external", "status": "success", "sourceTables": [],
        "queryTrace": {"queryCount": 0},
        "externalSources": [
            {"url": urls[0], "domain": "miit.gov.cn", "title": "中汽协发布汽车产销数据", "excerptPreview": "中国汽车工业协会数据"},
            {"url": urls[1], "domain": "news.example.com", "title": "转载中汽协数据", "excerptPreview": "中国汽车工业协会发布"},
            {"url": urls[2], "domain": "media.example.org", "title": "动力电池月报", "excerptPreview": "中国汽车动力电池产业创新联盟发布"},
        ],
    }]
    answer = "\n\n".join(f"2026年数据结论，来源：{url}" for url in urls)
    audit = audit_answer_evidence(
        task_id="E01", category="external", group="agent", answer=answer,
        answer_sources=urls, tool_evidence=evidence,
    )
    assert "ORIGINAL_SOURCE_DIVERSITY_INSUFFICIENT" in {
        item["code"] for item in audit["evidenceAuditErrors"]
    }
    assert audit["evidenceSummary"]["citedOriginalSourceFamilyCount"] == 2


def test_e01_audit_honors_answer_disclosure_that_three_source_requirement_is_unmet() -> None:
    url = "https://miit.gov.cn/report"
    evidence = [{
        "evidenceId": "TE-001", "kind": "external", "status": "success", "sourceTables": [],
        "queryTrace": {"queryCount": 0},
        "externalSources": [{
            "url": url, "domain": "miit.gov.cn", "title": "行业数据", "excerptPreview": "工业和信息化部发布",
        }],
    }]
    answer = (
        f"2026年行业结论，来源：{url}。严格意义上本次证据只覆盖了2个原始统计机构，"
        "至少3个独立来源的要求未能完全满足。"
    )
    audit = audit_answer_evidence(
        task_id="E01", category="external", group="context_baseline", answer=answer,
        answer_sources=[url], tool_evidence=evidence,
    )
    issue = next(
        item for item in audit["evidenceAuditErrors"]
        if item["code"] == "ORIGINAL_SOURCE_DIVERSITY_INSUFFICIENT"
    )
    assert issue["details"]["answerDisclosesShortfall"] is True


def test_i08_requires_verified_png_and_markdown(tmp_path: Path) -> None:
    png = tmp_path / "chart.png"
    markdown = tmp_path / "report.md"
    png.write_bytes(b"PNG")
    markdown.write_text(
        "# 报告\n## 数据范围\n全部记录\n## 指标定义\n报废率 = total_scrap / total_actual\n"
        "## 来源表\nproduction_orders\n## 筛选条件\n无\n## 数据质量提示\n未截断\n"
        "| machine_id | total_actual | total_good | total_scrap | scrap_rate |\n",
        encoding="utf-8",
    )
    answer = (
        "数据时间范围：2026-01至2026-06。设备 M01 M02 M03 M04 M05 M06 M07 M08。"
        "报告包含实际产量、合格数量、报废数量、报废率、指标定义、来源表、筛选条件和数据质量。"
        "\n| 设备 | 实际产量 | 合格数量 | 报废数量 | 报废率 |\n"
        "| --- | ---: | ---: | ---: | ---: |\n"
        "| M01 | 100 | 98 | 2 | 2.00% |\n"
        "| M02 | 100 | 98 | 2 | 2.00% |\n"
        "| M03 | 100 | 98 | 2 | 2.00% |\n"
        "| M04 | 100 | 98 | 2 | 2.00% |\n"
        "| M05 | 100 | 98 | 2 | 2.00% |\n"
        "| M06 | 100 | 98 | 2 | 2.00% |\n"
        "| M07 | 100 | 98 | 2 | 2.00% |\n"
        "| M08 | 100 | 98 | 2 | 2.00% |\n"
        "| 合计 | 800 | 784 | 16 | 2.00% |\n"
        + "内部数据库查询分析。" * 40
    )
    artifacts = [
        {"path": str(png), "extension": ".png", "verified": png.is_file()},
        {"path": str(markdown), "extension": ".md", "verified": markdown.is_file()},
    ]
    complete = validate_task_result(
        task_id="I08",
        category="internal",
        answer=answer,
        artifacts=artifacts,
        tool_calls=[{"name": "ask_manufacturing_question", "status": "success"}],
    )
    assert complete["completionStatus"] == "complete"
    assert complete["evidenceStatus"] == "complete"

    missing = validate_task_result(
        task_id="I08",
        category="internal",
        answer=answer,
        artifacts=[],
        tool_calls=[{"name": "ask_manufacturing_question", "status": "success"}],
    )
    assert missing["completionStatus"] == "partial"
    assert [item["code"] for item in missing["validationErrors"]].count("REQUIRED_ARTIFACT_MISSING") == 2


def test_extract_artifacts_does_not_treat_uncreated_filename_as_verified(tmp_path: Path) -> None:
    existing = tmp_path / "actual.png"
    existing.write_bytes(b"PNG")
    answer = f"真实文件：{existing}；计划文件：exports/not-created.md；外部来源：https://example.com/report.pdf"
    artifacts = extract_artifacts([], answer)
    by_extension = {item["extension"]: item for item in artifacts}
    assert by_extension[".png"]["verified"] is True
    assert by_extension[".md"]["verified"] is False
    assert ".pdf" not in by_extension


def test_internal_evidence_requires_substantive_successful_tool() -> None:
    answer = "数据时间范围截至2026年6月，来源表 production_orders。" + "内部数据分析。" * 80
    missing = validate_task_result(task_id="I01", category="internal", answer=answer, tool_calls=[])
    assert missing["evidenceStatus"] == "insufficient"
    assert "INTERNAL_DATA_EVIDENCE_MISSING" in {item["code"] for item in missing["validationErrors"]}

    metadata_only = validate_task_result(
        task_id="I01",
        category="internal",
        answer=answer,
        tool_calls=[{"name": "list_tables", "status": "success"}],
    )
    assert metadata_only["evidenceStatus"] == "insufficient"

    supported = validate_task_result(
        task_id="I01",
        category="internal",
        answer=answer,
        tool_calls=[{"name": "analyze_machine_360", "status": "success"}],
    )
    assert "INTERNAL_DATA_EVIDENCE_MISSING" not in {item["code"] for item in supported["validationErrors"]}


def test_i01_enforces_preregistered_top_three_with_tie_tolerance() -> None:
    base = (
        "数据时间范围截至2026年6月。综合生产、质量、停机、能耗和维护数据，"
        "风险分数按阈值触发项计算，并说明可能原因。" + "分析。" * 120
    )
    for ranking in ("M03、M07、M08", "M07、M03、M08"):
        result = validate_task_result(
            task_id="I01", category="internal", answer=f"前三名依次为{ranking}。{base}",
            tool_calls=[{"name": "analyze_machine_360", "status": "success"}],
        )
        assert "I01_RISK_RANKING_MISMATCH" not in {item["code"] for item in result["validationErrors"]}

    wrong = validate_task_result(
        task_id="I01", category="internal", answer=f"前三名依次为M03、M08、M07。{base}",
        tool_calls=[{"name": "analyze_machine_360", "status": "success"}],
    )
    assert "I01_RISK_RANKING_MISMATCH" in {item["code"] for item in wrong["validationErrors"]}


def test_i08_detects_total_and_rate_mismatch(tmp_path: Path) -> None:
    png = tmp_path / "chart.png"
    markdown = tmp_path / "report.md"
    png.write_bytes(b"PNG")
    markdown.write_text("report", encoding="utf-8")
    rows = "\n".join(f"| M{index:02d} | 100 | 98 | 2 | 2.00% |" for index in range(1, 9))
    answer = (
        "数据时间范围：2026-01至2026-06。实际产量、合格数量、报废数量、报废率、指标定义、来源表、筛选条件和数据质量如下。\n"
        "| 设备 | 实际产量 | 合格数量 | 报废数量 | 报废率 |\n"
        "| --- | ---: | ---: | ---: | ---: |\n"
        f"{rows}\n"
        "| 合计 | 900 | 880 | 15 | 1.67% |\n" + "内部数据库分析。" * 50
    )
    result = validate_task_result(
        task_id="I08",
        category="internal",
        answer=answer,
        artifacts=[
            {"path": str(png), "extension": ".png", "verified": True},
            {"path": str(markdown), "extension": ".md", "verified": True},
        ],
        tool_calls=[{"name": "analyze_machine_360", "status": "success"}],
    )
    codes = [item["code"] for item in result["validationErrors"]]
    assert "NUMERIC_TOTAL_MISMATCH" in codes
    assert "RATE_CALCULATION_MISMATCH" in codes
    assert result["completionStatus"] == "partial"


def test_i08_rejects_incomplete_downloaded_markdown(tmp_path: Path) -> None:
    png = tmp_path / "chart.png"
    markdown = tmp_path / "report.md"
    png.write_bytes(b"PNG")
    markdown.write_text("# 泛化报告\n只有数据预览，没有审计章节。", encoding="utf-8")
    rows = "\n".join(f"| M{index:02d} | 100 | 98 | 2 | 2.00% |" for index in range(1, 9))
    answer = (
        "数据时间范围：全部记录。指标定义、来源表、筛选条件和数据质量如下。\n"
        "| 设备 | 实际产量 | 合格数量 | 报废数量 | 报废率 |\n| --- | ---: | ---: | ---: | ---: |\n"
        f"{rows}\n| 合计 | 800 | 784 | 16 | 2.00% |\n" + "内部数据。" * 80
    )
    result = validate_task_result(
        task_id="I08", category="internal", answer=answer,
        artifacts=[
            {"path": str(png), "extension": ".png", "verified": True},
            {"path": str(markdown), "extension": ".md", "verified": True},
        ],
        tool_calls=[{"name": "run_natural_language_sandbox_analysis", "status": "success"}],
    )
    codes = {item["code"] for item in result["validationErrors"]}
    assert "ARTIFACT_REQUIRED_SECTION_MISSING" in codes
    assert "ARTIFACT_REQUIRED_METRIC_MISSING" in codes


def test_i08_detects_narrative_range_mismatch(tmp_path: Path) -> None:
    png = tmp_path / "chart.png"
    markdown = tmp_path / "report.md"
    png.write_bytes(b"PNG")
    markdown.write_text(
        "## 数据范围\n全部记录\n## 指标定义\nscrap_rate\n## 来源表\nproduction_orders\n"
        "## 筛选条件\n无\n## 数据质量提示\n无\ntotal_actual total_good total_scrap",
        encoding="utf-8",
    )
    rates = [1.61, 1.55, 1.52, 1.52, 1.63, 1.70, 3.81, 1.61]
    rows = "\n".join(f"| M{index:02d} | 10000 | {10000-round(rate*100)} | {round(rate*100)} | {rate:.2f}% |" for index, rate in enumerate(rates, 1))
    total_scrap = sum(round(rate * 100) for rate in rates)
    answer = (
        "数据范围：全部记录。其余7台设备报废率为1.57%–1.66%。指标定义、来源表、筛选条件、数据质量。\n"
        "| 设备 | 实际产量 | 合格数量 | 报废数量 | 报废率 |\n| --- | ---: | ---: | ---: | ---: |\n"
        f"{rows}\n| 合计 | 80000 | {80000-total_scrap} | {total_scrap} | {total_scrap/800:.2f}% |\n" + "内部数据。" * 80
    )
    result = validate_task_result(
        task_id="I08", category="internal", answer=answer,
        artifacts=[{"path": str(png), "extension": ".png", "verified": True}, {"path": str(markdown), "extension": ".md", "verified": True}],
        tool_calls=[{"name": "run_natural_language_sandbox_analysis", "status": "success"}],
    )
    assert "NARRATIVE_RANGE_MISMATCH" in {item["code"] for item in result["validationErrors"]}


def test_i04_detects_conflicting_purchase_spend_superlatives() -> None:
    answer = (
        "数据时间范围截至2026-06-30。供应商质量、交付、库存、缺料风险及优先顺序如下。\n\n"
        "S001 是采购金额最大供应商，采购金额226万元。\n\n"
        "S003 采购金额355万元，为采购金额最高供应商。\n\n" + "来源表 supplier_receipts，内部数据分析。" * 40
    )
    result = validate_task_result(
        task_id="I04", category="internal", answer=answer,
        tool_calls=[{"name": "analyze_supplier_inventory_risk", "status": "success"}],
    )
    assert "CONTRADICTORY_SUPERLATIVE" in {item["code"] for item in result["validationErrors"]}


def test_i04_accepts_repeated_consistent_purchase_spend_superlative() -> None:
    answer = (
        "数据时间范围截至2026-06-30。供应商质量、交付、库存、缺料风险及优先顺序如下。\n"
        "| 供应商 | 采购额 |\n|---|---:|\n| S001 | 2268543 |\n| S003 | 3555817 |\n\n"
        "采购金额最高者为 S003 Precision Alloy。\n\n"
        "## P2 S003\n交付风险 + 采购额最高，应优先协调排程。\n\n" + "来源表 supplier_receipts，内部数据分析。" * 40
    )
    result = validate_task_result(
        task_id="I04", category="internal", answer=answer,
        tool_calls=[{"name": "analyze_supplier_inventory_risk", "status": "success"}],
    )
    assert "CONTRADICTORY_SUPERLATIVE" not in {item["code"] for item in result["validationErrors"]}


def test_tool_evidence_captures_external_sources_and_internal_lineage() -> None:
    ai = AIMessage(
        content="",
        tool_calls=[
            {"name": "retrieve_external_evidence", "args": {"query": "CBAM", "api_key": "secret"}, "id": "external-1", "type": "tool_call"},
            {"name": "analyze_machine_360", "args": {"machineIds": ["M07"]}, "id": "internal-1", "type": "tool_call"},
        ],
    )
    external_payload = {
        "evidence": [
            {"evidenceId": "EXT-001", "title": "EU CBAM", "url": "https://example.eu/cbam", "domain": "example.eu", "excerpt": "CBAM entered into force."}
        ],
        "metadata": {
            "requestId": "r1",
            "filters": {"query": "CBAM", "api_key": "masked"},
            "sourceTables": [],
            "queryTrace": {"queryCount": 0, "digest": "abc", "queries": []},
            "returnedRows": 1,
        },
    }
    internal_payload = {
        "rows": [{"machine_id": "M07", "scrap_rate": 0.0381}],
        "metadata": {
            "requestId": "r2",
            "filters": {"machineIds": ["M07"]},
            "sourceTables": ["production_orders", "machines"],
            "dataTimeRange": {"requested": None, "observedInResult": {"from": "2026-01-01", "to": "2026-06-29"}},
            "queryTrace": {
                "queryCount": 1,
                "digest": "query123",
                "queries": [{"sql": "SELECT machine_id FROM production_orders", "parameterCount": 0, "plan": ["SCAN production_orders"]}],
            },
            "returnedRows": 1,
        },
    }
    messages = [
        ai,
        ToolMessage(content=[{"type": "text", "text": json.dumps(external_payload)}], tool_call_id="external-1", name="retrieve_external_evidence", status="success"),
        ToolMessage(content=json.dumps(internal_payload), tool_call_id="internal-1", name="analyze_machine_360", status="success"),
    ]
    evidence = build_agent_tool_evidence(messages)
    assert len(evidence) == 2
    assert evidence[0]["externalSources"][0]["url"] == "https://example.eu/cbam"
    assert evidence[0]["arguments"]["api_key"] == "[REDACTED]"
    assert evidence[1]["sourceTables"] == ["machines", "production_orders"]
    assert evidence[1]["queryTrace"]["digest"] == "query123"
    assert evidence[1]["resultSummary"]["rowPreview"][0]["machine_id"] == "M07"


def test_tool_evidence_captures_cross_check_documents() -> None:
    ai = AIMessage(
        content="",
        tool_calls=[
            {"name": "cross_check_external_sources", "args": {"query": "CBAM"}, "id": "cross-check-1", "type": "tool_call"},
        ],
    )
    payload = {
        "query": "CBAM",
        "returned": 2,
        "documents": [
            {"title": "Official CBAM", "url": "https://example.eu/cbam", "domain": "example.eu", "content": "Official facts."},
            {"title": "Industry analysis", "url": "https://industry.example/report", "domain": "industry.example", "content": "Industry analysis."},
        ],
    }
    messages = [
        ai,
        ToolMessage(
            content=json.dumps(payload),
            tool_call_id="cross-check-1",
            name="cross_check_external_sources",
            status="success",
        ),
    ]
    evidence = build_agent_tool_evidence(messages)
    assert [item["url"] for item in evidence[0]["externalSources"]] == [
        "https://example.eu/cbam",
        "https://industry.example/report",
    ]


def test_fullwidth_url_punctuation_does_not_create_answer_only_source() -> None:
    evidence = [{
        "kind": "external", "status": "success", "sourceTables": [],
        "queryTrace": {"queryCount": 0, "digest": None},
        "externalSources": [{"url": "https://example.eu/cbam", "title": "CBAM"}],
    }]
    answer = "CBAM于2026年正式实施（https://example.eu/cbam）。"
    audit = audit_answer_evidence(
        category="external",
        group="agent",
        answer=answer,
        answer_sources=extract_sources(answer),
        tool_evidence=evidence,
    )
    warning_codes = {item["code"] for item in audit["evidenceAuditWarnings"]}
    assert "ANSWER_SOURCE_NOT_IN_TOOL_EVIDENCE" not in warning_codes
    assert audit["evidenceAuditStatus"] == "complete"


def test_percent_encoded_and_unicode_urls_are_the_same_evidence_source() -> None:
    evidence = [{
        "kind": "external", "status": "success", "sourceTables": [],
        "queryTrace": {"queryCount": 0, "digest": None},
        "externalSources": [{
            "url": "https://baike.baidu.com/item/%E6%96%B0%E8%83%BD%E6%BA%90%E6%B1%BD%E8%BD%A6%E5%B8%82%E5%9C%BA/68858927?wfr=spider&for=pc",
            "title": "新能源汽车市场",
        }],
    }]
    answer_url = "https://baike.baidu.com/item/新能源汽车市场/68858927"
    audit = audit_answer_evidence(
        category="external", group="context_baseline",
        answer=f"来源：{answer_url}", answer_sources=[answer_url], tool_evidence=evidence,
    )
    warning_codes = {item["code"] for item in audit["evidenceAuditWarnings"]}
    assert "ANSWER_SOURCE_NOT_IN_TOOL_EVIDENCE" not in warning_codes
    assert audit["evidenceSummary"]["answerOnlySourceCount"] == 0


def test_evidence_audit_detects_retrieved_but_uncited_sources() -> None:
    evidence = [
        {
            "kind": "external",
            "status": "success",
            "sourceTables": [],
            "queryTrace": {"queryCount": 0, "digest": None},
            "externalSources": [{"url": "https://example.eu/cbam", "title": "CBAM"}],
        }
    ]
    audit = audit_answer_evidence(
        category="external",
        group="agent",
        answer="CBAM于2026年正式实施，证书价格为75欧元。",
        answer_sources=[],
        tool_evidence=evidence,
    )
    codes = {item["code"] for item in audit["evidenceAuditErrors"]}
    assert "RETRIEVED_SOURCES_NOT_CITED" in codes
    assert "KEY_CLAIMS_LACK_INLINE_CITATIONS" in codes
    assert audit["evidenceAuditStatus"] == "partial"


def test_evidence_audit_accepts_inline_source_and_internal_lineage() -> None:
    external = [{
        "kind": "external", "status": "success", "sourceTables": [],
        "queryTrace": {"queryCount": 0, "digest": None},
        "externalSources": [{"url": "https://example.eu/cbam", "title": "CBAM"}],
    }]
    external_audit = audit_answer_evidence(
        category="external", group="agent",
        answer="CBAM于2026年正式实施，来源：https://example.eu/cbam",
        answer_sources=["https://example.eu/cbam"], tool_evidence=external,
    )
    assert external_audit["evidenceAuditStatus"] == "complete"

    internal = [{
        "kind": "internal", "status": "success", "sourceTables": ["production_orders"],
        "queryTrace": {"queryCount": 1, "digest": "q1"}, "externalSources": [], "resultSummary": {"rowCountInPayload": 8},
    }]
    internal_audit = audit_answer_evidence(
        category="internal", group="agent",
        answer="内部数据来自 production_orders，2026年共生产100件。",
        answer_sources=[], tool_evidence=internal,
    )
    assert internal_audit["evidenceAuditStatus"] == "complete"
    assert internal_audit["evidenceSummary"]["sourceTables"] == ["production_orders"]


def test_low_retrieved_source_utilization_is_an_efficiency_warning() -> None:
    evidence = [{
        "kind": "external", "status": "success", "sourceTables": [],
        "queryTrace": {"queryCount": 0, "digest": None},
        "externalSources": [
            {"url": f"https://source{index}.example/report", "title": f"Source {index}"}
            for index in range(8)
        ],
    }]
    audit = audit_answer_evidence(
        category="external", group="agent",
        answer="该法规于2027年实施：https://source0.example/report",
        answer_sources=["https://source0.example/report"], tool_evidence=evidence,
    )
    assert audit["evidenceAuditStatus"] == "complete"
    assert not audit["evidenceAuditErrors"]
    assert "LOW_RETRIEVED_SOURCE_UTILIZATION" in {
        item["code"] for item in audit["evidenceAuditWarnings"]
    }


def test_external_claim_binding_requires_at_least_seventy_five_percent() -> None:
    evidence = [{
        "kind": "external", "status": "success", "sourceTables": [],
        "queryTrace": {"queryCount": 0, "digest": None},
        "externalSources": [
            {"url": f"https://source{index}.example/report", "title": f"Source {index}"}
            for index in range(3)
        ],
    }]
    answer = (
        "该法规于2026年生效：https://source0.example/report\n\n"
        "第二项标准于2027年实施：https://source1.example/report\n\n"
        "第三项政策计划于2028年实施，但这里没有就近引用。"
    )
    audit = audit_answer_evidence(
        category="external", group="agent", answer=answer,
        answer_sources=["https://source0.example/report", "https://source1.example/report"],
        tool_evidence=evidence,
    )
    assert audit["evidenceSummary"]["externalClaimBindingRate"] < 0.75
    assert "KEY_CLAIMS_LACK_INLINE_CITATIONS" in {
        item["code"] for item in audit["evidenceAuditErrors"]
    }


def test_external_list_claim_accepts_adjacent_labelled_source_note() -> None:
    url = "https://source.example/monitoring"
    evidence = [{
        "kind": "external", "status": "success", "sourceTables": [],
        "queryTrace": {"queryCount": 0, "digest": None},
        "externalSources": [{"url": url, "title": "监测资料"}],
    }]
    answer = (
        "**L1 预警**\n"
        "- 振动RMS上升30%。\n"
        "- 温升超过5℃。\n\n"
        f"（阈值依据：{url}）"
    )
    audit = audit_answer_evidence(
        category="external", group="agent", answer=answer,
        answer_sources=[url], tool_evidence=evidence,
    )
    assert "KEY_CLAIMS_LACK_INLINE_CITATIONS" not in {
        item["code"] for item in audit["evidenceAuditErrors"]
    }
    assert audit["evidenceSummary"]["externalClaimBindingRate"] == 1.0


def test_external_list_claim_rejects_unlabelled_nearby_url() -> None:
    url = "https://source.example/monitoring"
    evidence = [{
        "kind": "external", "status": "success", "sourceTables": [],
        "queryTrace": {"queryCount": 0, "digest": None},
        "externalSources": [{"url": url, "title": "监测资料"}],
    }]
    answer = "2026年阈值提高30%。\n\n另见该网页：" + url
    audit = audit_answer_evidence(
        category="external", group="agent", answer=answer,
        answer_sources=[url], tool_evidence=evidence,
    )
    assert "KEY_CLAIMS_LACK_INLINE_CITATIONS" in {
        item["code"] for item in audit["evidenceAuditErrors"]
    }


def test_explicit_limitations_are_not_counted_as_uncited_external_claims() -> None:
    url = "https://official.example/manual"
    evidence = [{
        "evidenceId": "TE-001", "kind": "external", "status": "success", "sourceTables": [],
        "queryTrace": {"queryCount": 0, "digest": None},
        "externalSources": [{"url": url, "title": "维护资料"}],
    }]
    answer = (
        f"2026年维护建议以原厂规程为准，来源：{url}\n\n"
        "**不确定性**：\n"
        "- 未取得设备原厂手册，温升和振动阈值无法确认。\n"
        "- 无权威数值阈值，本文不替代原厂规程。"
    )
    audit = audit_answer_evidence(
        category="external", group="agent", answer=answer,
        answer_sources=[url], tool_evidence=evidence,
    )
    assert "KEY_CLAIMS_LACK_INLINE_CITATIONS" not in {
        item["code"] for item in audit["evidenceAuditErrors"]
    }
    assert audit["evidenceSummary"]["externalClaimParagraphs"] == 1


def test_bulleted_source_limitations_are_not_counted_as_external_claims() -> None:
    url = "https://official.example/manual"
    evidence = [{
        "evidenceId": "TE-001", "kind": "external", "status": "success", "sourceTables": [],
        "queryTrace": {"queryCount": 0, "digest": None},
        "externalSources": [{"url": url, "title": "维护资料"}],
    }]
    answer = (
        f"2026年维护建议以原厂规程为准，来源：{url}\n\n"
        "- 英文检索返回结果质量较差，未获得设备原厂手册。\n"
        "- 中文来源的权威性有限，部分信息仅作参考。\n"
        "- 外部资料未针对本机型，不能作为维修操作的唯一依据。"
    )
    audit = audit_answer_evidence(
        category="external", group="agent", answer=answer,
        answer_sources=[url], tool_evidence=evidence,
    )
    assert audit["evidenceAuditStatus"] == "complete"
    assert audit["evidenceSummary"]["externalClaimParagraphs"] == 1


def test_provisional_parameter_table_is_not_treated_as_external_fact() -> None:
    answer = (
        "| 监测项 | 触发条件（初始设定） | 处置 |\n"
        "|---|---:|---|\n"
        "| 振动 | 基线 +2σ | 告警 |\n"
        "| 压力 | 偏差 >10% | 检查 |\n"
        "| 电流不平衡 | >10% | 需按机组功率和安装方式查表确认 |"
    )
    audit = audit_answer_evidence(
        category="external", group="agent", answer=answer,
        answer_sources=[], tool_evidence=[],
    )
    assert audit["evidenceSummary"]["externalClaimParagraphs"] == 0
    assert "KEY_CLAIMS_LACK_INLINE_CITATIONS" not in {
        item["code"] for item in audit["evidenceAuditErrors"]
    }


def test_established_standard_table_still_requires_external_evidence() -> None:
    answer = (
        "| 标准 | 正式阈值 | 实施时间 |\n"
        "|---|---:|---|\n"
        "| 行业标准 | 10% | 2026年 |"
    )
    audit = audit_answer_evidence(
        category="external", group="agent", answer=answer,
        answer_sources=[], tool_evidence=[],
    )
    assert audit["evidenceSummary"]["externalClaimParagraphs"] == 1
    assert "KEY_CLAIMS_LACK_INLINE_CITATIONS" in {
        item["code"] for item in audit["evidenceAuditErrors"]
    }


def test_wechat_tracking_parameters_do_not_create_answer_only_source() -> None:
    tool_url = (
        "https://mp.weixin.qq.com/s?__biz=MzA1&mid=123&idx=1&sn=abc"
        "&chksm=deadbeef&scene=27&utm_source=chat"
    )
    answer_url = "https://mp.weixin.qq.com/s?__biz=MzA1&mid=123&idx=1&sn=abc"
    evidence = [{
        "evidenceId": "TE-001", "kind": "external", "status": "success", "sourceTables": [],
        "queryTrace": {"queryCount": 0, "digest": None},
        "externalSources": [{"url": tool_url, "title": "行业资料"}],
    }]
    audit = audit_answer_evidence(
        category="external", group="agent",
        answer=f"该政策于2026年实施，来源：{answer_url}",
        answer_sources=[answer_url], tool_evidence=evidence,
    )
    warning_codes = {item["code"] for item in audit["evidenceAuditWarnings"]}
    assert "ANSWER_SOURCE_NOT_IN_TOOL_EVIDENCE" not in warning_codes
    assert audit["evidenceSummary"]["answerOnlySourceCount"] == 0
    assert audit["evidenceSummary"]["externalSourcesCited"] == 1


def test_internal_task_claim_binding_requires_at_least_seventy_five_percent() -> None:
    evidence = [{
        "evidenceId": "TE-001", "kind": "internal", "status": "success",
        "sourceTables": ["production_orders"],
        "queryTrace": {"queryCount": 1, "digest": "query123"},
        "externalSources": [], "resultSummary": {"rowCountInPayload": 8},
    }]
    answer = (
        "M03风险分为3分。内部证据：来源表 production_orders；查询摘要 query123。\n\n"
        "M07风险分为3分，但这一段没有就近血缘。\n\n"
        "M08风险分为2分，这一段也没有就近血缘。"
    )
    audit = audit_answer_evidence(
        category="internal", group="agent", answer=answer,
        answer_sources=[], tool_evidence=evidence,
    )
    assert audit["evidenceSummary"]["internalClaimBindingRate"] < 0.75
    assert "INTERNAL_CLAIMS_LACK_PROVENANCE" in {
        item["code"] for item in audit["evidenceAuditErrors"]
    }


def test_internal_closed_book_baseline_is_exempt_from_provenance_binding_gate() -> None:
    audit = audit_answer_evidence(
        category="internal", group="baseline",
        answer="建议使用最近12周数据计算风险，但当前无法访问本地数据库。",
        answer_sources=[], tool_evidence=[],
    )
    assert "INTERNAL_CLAIMS_LACK_PROVENANCE" not in {
        item["code"] for item in audit["evidenceAuditErrors"]
    }


def test_hybrid_audit_separates_external_and_internal_claim_binding() -> None:
    evidence = [
        {
            "evidenceId": "TE-001", "kind": "internal", "status": "success",
            "sourceTables": ["production_orders"],
            "queryTrace": {"queryCount": 1, "digest": "query123"},
            "externalSources": [], "resultSummary": {"rowCountInPayload": 8},
        },
        {
            "evidenceId": "TE-002", "kind": "external", "status": "success",
            "sourceTables": [], "queryTrace": {"queryCount": 0, "digest": None},
            "externalSources": [{"url": "https://example.eu/policy", "title": "Policy"}],
        },
    ]
    answer = (
        "M07报废率为3.81%。内部证据：来源表 production_orders；查询摘要 query123。\n\n"
        "最新政策于2026年实施：https://example.eu/policy"
    )
    audit = audit_answer_evidence(
        category="hybrid", group="agent", answer=answer,
        answer_sources=["https://example.eu/policy"], tool_evidence=evidence,
    )
    assert audit["evidenceAuditStatus"] == "complete"
    assert audit["evidenceSummary"]["externalClaimBindingRate"] == 1.0
    assert audit["evidenceSummary"]["internalClaimBindingRate"] == 1.0


def test_hybrid_audit_treats_standard_cycle_metrics_as_internal() -> None:
    evidence = [{
        "evidenceId": "TE-001", "kind": "internal", "status": "success",
        "sourceTables": ["production_orders"],
        "queryTrace": {"queryCount": 1, "digest": "query123"},
        "externalSources": [], "resultSummary": {"rowCountInPayload": 8},
    }]
    answer = (
        "M07实际产量为12,609件，报废率为3.81%，加权循环时间为3.265分钟，标准节拍为3.21分钟。"
        "内部证据：来源表 production_orders；查询摘要 query123。"
    )
    audit = audit_answer_evidence(
        category="hybrid", group="agent", answer=answer,
        answer_sources=[], tool_evidence=evidence,
    )
    summary = audit["evidenceSummary"]
    assert summary["externalClaimParagraphs"] == 0
    assert summary["internalClaimParagraphs"] == 1
    assert summary["internalClaimBindingRate"] == 1.0


def test_hybrid_audit_treats_external_boundary_sentence_as_internal_context() -> None:
    evidence = [{
        "evidenceId": "TE-001", "kind": "internal", "status": "success",
        "sourceTables": ["production_orders", "downtime_events"],
        "queryTrace": {"queryCount": 2, "digest": "machine123"},
        "externalSources": [], "resultSummary": {"rowCountInPayload": 8},
    }]
    answer = (
        "M07在2026年触发3项风险阈值，报废率3.81%，非计划停机1110分钟。"
        "外部资料仅用于补充通用诊断机理与排查方法，不构成对M07具体故障的确认。\n\n"
        "内部证据：来源表 production_orders、downtime_events；查询摘要 machine123。"
    )
    audit = audit_answer_evidence(
        category="hybrid", group="agent", answer=answer,
        answer_sources=[], tool_evidence=evidence,
    )
    assert audit["evidenceSummary"]["externalClaimParagraphs"] == 0
    assert audit["evidenceSummary"]["internalClaimParagraphs"] == 1
    assert audit["evidenceSummary"]["internalClaimBindingRate"] == 1.0


def test_required_source_categories_reject_disclosed_manufacturer_shortfall() -> None:
    answer = (
        "安全停机后依次进行外观检查、振动分析、温度检查和拆检决策，拆检必须由专业人员完成。\n\n"
        "设备厂商资料：证据不足。目录页 https://catalog.example.com/manual 未提供故障排查内容，"
        "本次未取得设备制造商官方手册原文。\n\n"
        "会议论文研究表明振动频谱可用于区分故障方向：https://doi.org/10.1000/example 。\n\n"
        "维修技术资料给出了轴承检查和拆装步骤：https://repair.example.com/guide 。\n\n"
        + "排查时应记录工况、转速、负载和测量位置，并明确所有数值必须以适用机型资料为准。" * 4
    )
    result = validate_task_result(
        task_id="E06", category="external", answer=answer,
        sources=[
            "https://catalog.example.com/manual",
            "https://doi.org/10.1000/example",
            "https://repair.example.com/guide",
        ],
    )
    category_errors = [
        item for item in result["validationErrors"]
        if item["code"] == "REQUIRED_SOURCE_CATEGORY_MISSING"
    ]
    assert [item["details"]["category"] for item in category_errors] == ["manufacturer"]
    assert result["completionStatus"] == "partial"
    assert result["evidenceStatus"] == "partial"


def test_required_source_categories_accept_usable_cited_blocks() -> None:
    answer = (
        "安全停机后依次进行外观检查、振动分析、温度检查和拆检决策，拆检必须由专业人员完成。\n\n"
        "设备厂商官方手册要求先断电锁定并核对主轴报警：https://vendor.example.com/manual 。\n\n"
        "会议论文研究表明振动频谱可用于区分故障方向：https://doi.org/10.1000/example 。\n\n"
        "维修技术资料给出了轴承检查和拆装步骤：https://repair.example.com/guide 。\n\n"
        + "排查时应记录工况、转速、负载和测量位置，并明确所有数值必须以适用机型资料为准。" * 4
    )
    result = validate_task_result(
        task_id="E06", category="external", answer=answer,
        sources=[
            "https://vendor.example.com/manual",
            "https://doi.org/10.1000/example",
            "https://repair.example.com/guide",
        ],
    )
    assert "REQUIRED_SOURCE_CATEGORY_MISSING" not in {
        item["code"] for item in result["validationErrors"]
    }
    assert result["completionStatus"] == "complete"


def test_manufacturer_service_page_supports_limited_service_capability_claim() -> None:
    answer = (
        "安全停机后依次进行外观检查、振动分析、温度检查和拆检决策，拆检必须由专业人员完成。\n\n"
        "厂商侧：DMG MORI提供专业主轴维修服务，该资料支持大修交由专业机构的结论："
        "https://en.dmgmori.com/service/spindle-service 。\n\n"
        "专利论文研究表明振动分析可用于故障方向判断：https://doi.org/10.1000/example 。\n\n"
        "维修技术资料给出正式检查步骤：https://repair.example.com/service-manual 。\n\n"
        + "所有操作按安全规程执行，具体阈值以适用机型文件为准。" * 8
    )
    result = validate_task_result(
        task_id="E06", category="external", answer=answer,
        sources=[
            "https://en.dmgmori.com/service/spindle-service",
            "https://doi.org/10.1000/example",
            "https://repair.example.com/service-manual",
        ],
    )
    missing = {
        item["details"]["category"] for item in result["validationErrors"]
        if item["code"] == "REQUIRED_SOURCE_CATEGORY_MISSING"
    }
    assert "manufacturer" not in missing


def test_manufacturer_category_accepts_recognized_domain_on_same_line() -> None:
    answer = (
        "安全停机后依次进行外观检查、振动分析、温度检查和拆检决策，拆检必须由专业人员完成。\n\n"
        "设备厂商资料：SKF主轴单元页 https://www.skf.com/industries/spindle-units 和"
        "Haas产品页 https://www.haascnc.com/productivity/spindles.html；页面内容覆盖有限。\n\n"
        "专利论文研究：https://doi.org/10.1000/example 。\n\n"
        "维修技术资料给出正式步骤：https://repair.example.com/service-manual 。\n\n"
        + "所有具体阈值仍以适用机型文件为准。" * 10
    )
    result = validate_task_result(
        task_id="E06", category="external", answer=answer,
        sources=[
            "https://www.skf.com/industries/spindle-units",
            "https://www.haascnc.com/productivity/spindles.html",
            "https://doi.org/10.1000/example",
            "https://repair.example.com/service-manual",
        ],
    )
    missing = {
        item["details"]["category"] for item in result["validationErrors"]
        if item["code"] == "REQUIRED_SOURCE_CATEGORY_MISSING"
    }
    assert "manufacturer" not in missing


def test_manufacturer_category_requires_recognized_url_on_same_line() -> None:
    answer = (
        "安全停机后依次进行外观检查、振动分析、温度检查和拆检决策，拆检必须由专业人员完成。\n\n"
        "设备厂商资料仍需核验。\n"
        "另见主轴网页：https://www.skf.com/industries/spindle-units 。\n\n"
        "专利论文研究：https://doi.org/10.1000/example 。\n\n"
        "维修技术资料给出正式步骤：https://repair.example.com/service-manual 。\n\n"
        + "所有具体阈值仍以适用机型文件为准。" * 10
    )
    result = validate_task_result(
        task_id="E06", category="external", answer=answer,
        sources=[
            "https://www.skf.com/industries/spindle-units",
            "https://doi.org/10.1000/example",
            "https://repair.example.com/service-manual",
        ],
    )
    missing = {
        item["details"]["category"] for item in result["validationErrors"]
        if item["code"] == "REQUIRED_SOURCE_CATEGORY_MISSING"
    }
    assert "manufacturer" in missing


def test_low_authority_repair_content_is_not_formal_maintenance_evidence() -> None:
    answer = (
        "安全停机后依次进行外观检查、振动分析、温度检查和拆检决策，拆检必须由专业人员完成。\n\n"
        "设备厂商资料提供专业维修能力说明：https://www.skf.com/services/reman-spindles 。\n\n"
        "专利论文研究表明振动分析可用于故障方向判断：https://doi.org/10.1000/example 。\n\n"
        "维修技术资料给出了轴承拆装流程：https://baike.baidu.com/item/spindle-repair 。\n\n"
        + "所有操作按安全规程执行，具体阈值以适用机型文件为准。" * 8
    )
    result = validate_task_result(
        task_id="E06", category="external", answer=answer,
        sources=[
            "https://www.skf.com/services/reman-spindles",
            "https://doi.org/10.1000/example",
            "https://baike.baidu.com/item/spindle-repair",
        ],
    )
    missing = {
        item["details"]["category"] for item in result["validationErrors"]
        if item["code"] == "REQUIRED_SOURCE_CATEGORY_MISSING"
    }
    assert missing == {"maintenance"}


def test_research_source_category_accepts_provides_and_method_basis_wording() -> None:
    answer = (
        "安全停机后依次进行外观检查、振动分析、温度检查和拆检决策，拆检必须由专业人员完成。\n\n"
        "设备厂商官方资料指出应先断电锁定：https://vendor.example.com/manual 。\n\n"
        "专利或论文：专利提供多时段振动特征点比对方法，可作为诊断依据："
        "https://doi.org/10.1000/example 。\n\n"
        "维修技术资料给出了轴承检查流程：https://repair.example.com/guide 。\n\n"
        + "排查时记录工况、转速、负载和测量位置，数值以适用机型资料为准。" * 6
    )
    result = validate_task_result(
        task_id="E06", category="external", answer=answer,
        sources=[
            "https://vendor.example.com/manual",
            "https://doi.org/10.1000/example",
            "https://repair.example.com/guide",
        ],
    )
    missing = {
        item["details"]["category"] for item in result["validationErrors"]
        if item["code"] == "REQUIRED_SOURCE_CATEGORY_MISSING"
    }
    assert "research" not in missing


def test_research_category_accepts_authoritative_domain_on_same_line() -> None:
    answer = (
        "安全停机后依次进行外观检查、振动分析、温度检查和拆检决策，拆检必须由专业人员完成。\n\n"
        "设备厂商资料提供专业服务能力说明：https://www.skf.com/services/reman-spindles 。\n\n"
        "专利或论文类别：https://ieeexplore.ieee.org/document/10538267/ 、"
        "https://www.sciencedirect.com/science/article/pii/example ，这些资料支持噪声环境下的轴承诊断结论。\n\n"
        "维修技术资料给出正式步骤：https://repair.example.com/service-manual 。\n\n"
        + "所有操作按安全规程执行，阈值以适用机型文件为准。" * 8
    )
    result = validate_task_result(
        task_id="E06", category="external", answer=answer,
        sources=[
            "https://www.skf.com/services/reman-spindles",
            "https://ieeexplore.ieee.org/document/10538267/",
            "https://www.sciencedirect.com/science/article/pii/example",
            "https://repair.example.com/service-manual",
        ],
    )
    missing = {
        item["details"]["category"] for item in result["validationErrors"]
        if item["code"] == "REQUIRED_SOURCE_CATEGORY_MISSING"
    }
    assert "research" not in missing


def test_research_category_requires_authoritative_url_on_same_line() -> None:
    answer = (
        "安全停机后依次进行外观检查、振动分析、温度检查和拆检决策，拆检必须由专业人员完成。\n\n"
        "设备厂商资料提供专业服务能力说明：https://www.skf.com/services/reman-spindles 。\n\n"
        "专利或论文类别仍需证据。\n"
        "另见一般振动资料：https://ieeexplore.ieee.org/document/10538267/ 。\n\n"
        "维修技术资料给出正式步骤：https://repair.example.com/service-manual 。\n\n"
        + "所有操作按安全规程执行，阈值以适用机型文件为准。" * 8
    )
    result = validate_task_result(
        task_id="E06", category="external", answer=answer,
        sources=[
            "https://www.skf.com/services/reman-spindles",
            "https://ieeexplore.ieee.org/document/10538267/",
            "https://repair.example.com/service-manual",
        ],
    )
    missing = {
        item["details"]["category"] for item in result["validationErrors"]
        if item["code"] == "REQUIRED_SOURCE_CATEGORY_MISSING"
    }
    assert "research" in missing


def test_source_categories_bind_each_url_locally_and_keep_paper_or_patent_semantics() -> None:
    answer = (
        "安全停机后依次进行外观检查、振动分析、温度检查和拆检决策，拆检必须由专业人员完成。\n\n"
        "1. 设备厂商官方资料缺失：仅有第三方转载目录页 "
        "https://catalog.example.com/manual ，未取得制造商官方手册原文。\n"
        "2. 专利或论文：已取得会议论文题录 http://doi.org/10.1000/example ，"
        "其研究支持振动分析方向，但未取得任何专利文献。\n"
        "3. 维修技术资料缺失：无正规维修手册，现有网页不能替代厂商检修规程。\n\n"
        "振动测量基础可参考 https://reference.example.com/vibration ，"
        "但所有限值仍须以适用设备文件为准。\n\n"
        + "排查时应记录工况、转速、负载和测量位置，不把二手网页升级为官方结论。" * 5
    )
    result = validate_task_result(
        task_id="E06", category="external", answer=answer,
        sources=[
            "https://catalog.example.com/manual",
            "http://doi.org/10.1000/example",
            "https://reference.example.com/vibration",
        ],
    )
    missing = {
        item["details"]["category"] for item in result["validationErrors"]
        if item["code"] == "REQUIRED_SOURCE_CATEGORY_MISSING"
    }
    assert missing == {"manufacturer", "maintenance"}


def test_as_of_date_and_qualified_internal_external_headings_are_recognized() -> None:
    answer = (
        "# 预测性维护试点\n\n"
        "## 内部数据筛查结论\n\n"
        "数据范围与工具：预测窗口30天，asOfDate 2026-06-29。M03为风险最高设备。"
        "内部证据来自来源表 downtime_events，查询摘要 abc123。\n\n"
        "## 外部监测技术证据\n\n"
        "公开监测资料支持振动传感器和温度传感器方案：https://source1.example.com/report 。\n\n"
        "## 采样指标、报警逻辑和验证方法\n\n"
        "采样指标包括RMS与温升；报警逻辑采用基线偏离；验证方法采用报警与维修工单对照。"
        "方案明确列出传感器、采样频率、报警阈值标定方法和现场验证步骤。" * 5
        + "\n\n补充来源：https://source2.example.com/guide"
    )
    result = validate_task_result(
        task_id="H05", category="hybrid", answer=answer,
        sources=["https://source1.example.com/report", "https://source2.example.com/guide"],
        tool_calls=[{"name": "predict_maintenance_risk", "status": "success"}],
    )
    codes = {item["code"] for item in result["validationErrors"]}
    assert "DATA_TIME_RANGE_MISSING" not in codes
    assert "INTERNAL_EXTERNAL_DISTINCTION_MISSING" not in codes


def test_h05_requires_provisional_disclosure_for_designed_alarm_thresholds() -> None:
    base = (
        "数据时间范围：2026-06-29（asOfDate），预测窗口30天。内部数据与外部公开资料分开说明。"
        "M03配置振动传感器，采样指标包含RMS，报警逻辑采用三级阈值，验证方法为工单回测。\n\n"
        "L1 预警：振动RMS较基线上升≥30%，温升≥5℃；L2报警：压力低于2.0 MPa。\n\n"
        "外部依据：https://source1.example/report 与 https://source2.example/guide。" + "分析。" * 120
    )
    kwargs = {
        "task_id": "H05", "category": "hybrid", "answer": base,
        "sources": ["https://source1.example/report", "https://source2.example/guide"],
        "tool_calls": [{"name": "predict_maintenance_risk", "status": "success"}],
    }
    missing = validate_task_result(**kwargs)
    assert "PROVISIONAL_THRESHOLD_DISCLOSURE_MISSING" in {
        item["code"] for item in missing["validationErrors"]
    }

    disclosed = validate_task_result(**{
        **kwargs,
        "answer": base + (
            "\n\n上述数值均为试点初始假设阈值，需按M03设备历史基线和现场工况标定，"
            "不得直接作为正式停机阈值。"
        ),
    })
    assert "PROVISIONAL_THRESHOLD_DISCLOSURE_MISSING" not in {
        item["code"] for item in disclosed["validationErrors"]
    }


def test_generic_table_narrative_consistency_detects_range_and_extremum_errors() -> None:
    answer = (
        "节拍指数 1.017–1.020。最慢班次为 A。\n\n"
        "| 班次 | 实际加权循环时间(min) | 标准节拍(min) | 节拍指数 |\n"
        "|---|---:|---:|---:|\n"
        "| B | 3.801 | 3.745 | 1.0151 |\n"
        "| A | 2.812 | 2.757 | 1.0199 |\n\n"
        + "该表用于核对文字中的绝对速度、相对标准偏离和数值区间，所有结论都应与明细逐项一致。" * 6
    )
    result = validate_task_result(task_id="X", category="external", answer=answer)
    codes = {item["code"] for item in result["validationErrors"]}
    assert "TABLE_NARRATIVE_RANGE_MISMATCH" in codes
    assert "TABLE_NARRATIVE_EXTREMUM_MISMATCH" in codes


def test_generic_table_narrative_consistency_accepts_matching_claims() -> None:
    answer = (
        "节拍指数 1.015–1.020。最慢班次为 B。\n\n"
        "| 班次 | 实际加权循环时间(min) | 标准节拍(min) | 节拍指数 |\n"
        "|---|---:|---:|---:|\n"
        "| B | 3.801 | 3.745 | 1.0151 |\n"
        "| A | 2.812 | 2.757 | 1.0199 |\n\n"
        + "该表用于核对文字中的绝对速度、相对标准偏离和数值区间，所有结论都应与明细逐项一致。" * 6
    )
    result = validate_task_result(task_id="X", category="external", answer=answer)
    codes = {item["code"] for item in result["validationErrors"]}
    assert "TABLE_NARRATIVE_RANGE_MISMATCH" not in codes
    assert "TABLE_NARRATIVE_EXTREMUM_MISMATCH" not in codes


def test_hybrid_audit_accepts_immediately_adjacent_internal_provenance() -> None:
    evidence = [{
        "evidenceId": "TE-001", "kind": "internal", "status": "success",
        "sourceTables": ["downtime_events"],
        "queryTrace": {"queryCount": 1, "digest": "2c5896a9b8d40076"},
        "externalSources": [], "resultSummary": {"rowCountInPayload": 21},
    }]
    answer = (
        "关键观察：液压泄漏417分钟、主轴报警143分钟、轴承振动76分钟，合计636分钟。\n\n"
        "> 内部证据：来源表 `downtime_events`；查询摘要 `2c5896a9b8d40076`。"
    )
    audit = audit_answer_evidence(
        category="hybrid", group="agent", answer=answer,
        answer_sources=[], tool_evidence=evidence,
    )
    assert audit["evidenceAuditStatus"] == "complete"
    assert audit["evidenceSummary"]["internalClaimParagraphs"] == 1
    assert audit["evidenceSummary"]["internalClaimParagraphsWithProvenance"] == 1
    assert audit["evidenceSummary"]["internalClaimBindingRate"] == 1.0


def test_hybrid_audit_rejects_non_adjacent_internal_provenance() -> None:
    evidence = [{
        "evidenceId": "TE-001", "kind": "internal", "status": "success",
        "sourceTables": ["downtime_events"],
        "queryTrace": {"queryCount": 1, "digest": "2c5896a9b8d40076"},
        "externalSources": [], "resultSummary": {"rowCountInPayload": 21},
    }]
    answer = (
        "关键观察：液压泄漏417分钟、主轴报警143分钟、轴承振动76分钟，合计636分钟。\n\n"
        "这是一段没有血缘信息的分析说明。\n\n"
        "> 内部证据：来源表 `downtime_events`；查询摘要 `2c5896a9b8d40076`。"
    )
    audit = audit_answer_evidence(
        category="hybrid", group="agent", answer=answer,
        answer_sources=[], tool_evidence=evidence,
    )
    assert audit["evidenceAuditStatus"] == "partial"
    assert audit["evidenceSummary"]["internalClaimBindingRate"] == 0.0


def test_internal_audit_accepts_table_provenance_across_one_takeaway_paragraph() -> None:
    evidence = [{
        "evidenceId": "TE-001", "kind": "internal", "status": "success",
        "sourceTables": ["downtime_events"],
        "queryTrace": {"queryCount": 1, "digest": "query123"},
        "externalSources": [], "resultSummary": {"rowCountInPayload": 6},
    }]
    answer = (
        "| 月份 | 非计划停机 |\n"
        "|---|---:|\n"
        "| 2026-04 | 8597分钟 |\n\n"
        "要点：2026-04的设备停机明显升高。\n\n"
        "内部证据：来源表 downtime_events；查询摘要 query123。"
    )
    audit = audit_answer_evidence(
        category="internal", group="agent", answer=answer,
        answer_sources=[], tool_evidence=evidence,
    )
    assert audit["evidenceAuditStatus"] == "complete"
    assert audit["evidenceSummary"]["internalClaimParagraphs"] == 2
    assert audit["evidenceSummary"]["internalClaimParagraphsWithProvenance"] == 2


def test_hybrid_sensor_table_with_standard_wording_uses_internal_provenance() -> None:
    evidence = [{
        "evidenceId": "TE-001", "kind": "internal", "status": "success",
        "sourceTables": ["machines"],
        "queryTrace": {"queryCount": 1, "digest": "machine123"},
        "externalSources": [], "resultSummary": {"rowCountInPayload": 1},
    }]
    answer = (
        "| 设备 | 标准采样频率 | 最新OEE |\n"
        "|---|---:|---:|\n"
        "| M03 | 10 kHz | 78.55% |\n\n"
        "内部证据：来源表 machines；查询摘要 machine123。"
    )
    audit = audit_answer_evidence(
        category="hybrid", group="agent", answer=answer,
        answer_sources=[], tool_evidence=evidence,
    )
    assert audit["evidenceSummary"]["externalClaimParagraphs"] == 0
    assert audit["evidenceSummary"]["internalClaimBindingRate"] == 1.0


def test_required_topic_matching_accepts_short_inserted_qualifiers() -> None:
    i06_answer = (
        "数据时间范围：2026-01-01至2026-06-30。P001的产量、报废、质量缺陷、库存和"
        "相关高风险设备均已分析。" + "分析。" * 120
    )
    i06 = validate_task_result(task_id="I06", category="internal", answer=i06_answer)
    assert not [item for item in i06["validationErrors"] if item["code"] == "REQUIRED_TOPIC_MISSING"]

    h06_answer = (
        "数据时间范围：2026-01-01至2026-06-30。内部证据和外部证据已分开。"
        "S001的收货、来料质量、交付、供应品类、供应商审核重点及备选与缓解措施如下。"
        + "分析。" * 120
    )
    h06 = validate_task_result(task_id="H06", category="hybrid", answer=h06_answer)
    assert not [item for item in h06["validationErrors"] if item["code"] == "REQUIRED_TOPIC_MISSING"]


def test_i03_validation_accepts_semantically_equivalent_evidence_labels() -> None:
    answer = """
数据时间范围：2026-01-01 至 2026-06-30。M07是报废率最高设备。
根因候选排序覆盖质量缺陷、停机原因、生产节拍，并列出支持 vs 反对的关键数据和局限。
设备侧使用故障、非计划停机、可用率和OEE描述运行情况，不把相关性写成因果关系。
""" * 8
    result = validate_task_result(
        task_id="I03", category="internal", answer=answer,
        tool_calls=[{"name": "rank_root_cause_candidates", "status": "success"}],
    )
    missing_topics = [item for item in result["validationErrors"] if item["code"] == "REQUIRED_TOPIC_MISSING"]
    assert missing_topics == []


def test_i03_validation_accepts_slash_support_and_opposition_heading() -> None:
    answer = """
数据时间范围：2026-01-01 至 2026-06-30。M07是报废率最高设备。
根因候选排序覆盖质量缺陷、停机原因、生产节拍和设备状态。
根因候选排序（含支持/反对证据）：液压泄漏的支持是停机417分钟，反对是缺少事件级对齐。
""" * 8
    result = validate_task_result(
        task_id="I03", category="internal", answer=answer,
        tool_calls=[{"name": "rank_machine_root_causes_batch", "status": "success"}],
    )
    assert not [item for item in result["validationErrors"] if item["code"] == "REQUIRED_TOPIC_MISSING"]


def test_i07_validation_accepts_domain_level_common_and_unique_wording() -> None:
    answer = """
数据时间范围：2026-01-01 至 2026-06-30，覆盖2026-01、2026-02、2026-03、2026-04、2026-05、2026-06。
规则异常、统计异常和趋势异常按时间序列进行比较。
共同领域是设备，也是三者共同的唯一交集；独有领域方面，能耗是规则独有，统计独有与趋势独有均为无。
以上仅表示领域信号重合，不把相关性写成因果关系。
""" * 6
    result = validate_task_result(
        task_id="I07", category="internal", answer=answer,
        tool_calls=[{"name": "get_anomaly_overview", "status": "success"}],
    )
    assert not [item for item in result["validationErrors"] if item["code"] == "REQUIRED_TOPIC_MISSING"]
    assert result["completionStatus"] == "complete"


def test_completion_self_correction_accepts_bounded_consistency_codes() -> None:
    validation = {
        "validationErrors": [
            {"code": "NUMERIC_TOTAL_MISMATCH", "scope": "completion"},
            {"code": "RATE_CALCULATION_MISMATCH", "scope": "completion"},
            {"code": "NARRATIVE_RANGE_MISMATCH", "scope": "completion"},
            {"code": "CONTRADICTORY_SUPERLATIVE", "scope": "completion"},
            {"code": "REQUIRED_ARTIFACT_MISSING", "scope": "completion"},
            {"code": "NUMERIC_TOTAL_MISMATCH", "scope": "evidence"},
        ]
    }
    assert correctable_validation_codes(validation) == [
        "CONTRADICTORY_SUPERLATIVE", "NARRATIVE_RANGE_MISMATCH",
        "NUMERIC_TOTAL_MISMATCH", "RATE_CALCULATION_MISMATCH",
    ]


def test_evidence_format_correction_only_accepts_binding_codes() -> None:
    audit = {
        "evidenceAuditErrors": [
            {"code": "KEY_CLAIMS_LACK_INLINE_CITATIONS"},
            {"code": "INTERNAL_CLAIMS_LACK_PROVENANCE"},
            {"code": "RETRIEVED_SOURCES_NOT_CITED"},
        ]
    }
    assert correctable_evidence_codes(audit) == [
        "INTERNAL_CLAIMS_LACK_PROVENANCE",
        "KEY_CLAIMS_LACK_INLINE_CITATIONS",
        "RETRIEVED_SOURCES_NOT_CITED",
    ]


def test_source_validation_correction_accepts_only_repairable_evidence_codes() -> None:
    validation = {
        "validationErrors": [
            {"code": "SOURCE_URL_COUNT_INSUFFICIENT", "scope": "evidence"},
            {"code": "INDEPENDENT_SOURCE_COUNT_INSUFFICIENT", "scope": "evidence"},
            {
                "code": "OFFICIAL_SOURCE_MISSING", "scope": "evidence",
                "details": {"officialDomains": ["europa.eu"]},
            },
            {"code": "REQUIRED_TOPIC_MISSING", "scope": "completion"},
        ]
    }
    evidence = [{
        "externalSources": [{"url": "https://taxation-customs.ec.europa.eu/cbam"}],
    }]
    assert correctable_source_validation_codes(validation, evidence) == [
        "INDEPENDENT_SOURCE_COUNT_INSUFFICIENT",
        "OFFICIAL_SOURCE_MISSING",
        "SOURCE_URL_COUNT_INSUFFICIENT",
    ]


def test_official_source_missing_is_not_repairable_without_captured_official_url() -> None:
    validation = {
        "validationErrors": [{
            "code": "OFFICIAL_SOURCE_MISSING", "scope": "evidence",
            "details": {"officialDomains": ["europa.eu", "eur-lex.europa.eu"]},
        }]
    }
    evidence = [{
        "externalSources": [
            {"url": "https://chinawto.mofcom.gov.cn/article/cbam"},
            {"url": "https://industry.example/cbam-analysis"},
        ],
    }]
    assert correctable_source_validation_codes(validation, evidence) == []


def test_source_category_repair_requires_qualified_captured_evidence() -> None:
    validation = {
        "validationErrors": [
            {
                "code": "REQUIRED_SOURCE_CATEGORY_MISSING",
                "scope": "completion",
                "details": {"category": "research"},
            },
            {
                "code": "REQUIRED_SOURCE_CATEGORY_MISSING",
                "scope": "completion",
                "details": {"category": "maintenance"},
            },
        ]
    }
    evidence = [{
        "arguments": {"includeDomains": []},
        "externalSources": [
            {"title": "Bearing diagnosis research", "url": "https://doi.org/10.1/example"},
            {"title": "Spindle Repair Service", "url": "https://vendor.example/spindle-service"},
        ],
    }]
    candidates = _source_category_candidates(evidence)
    assert candidates["research"] == ["https://doi.org/10.1/example"]
    assert candidates["maintenance"] == []
    assert correctable_source_validation_codes(validation, evidence) == [
        "REQUIRED_SOURCE_CATEGORY_MISSING"
    ]


def test_source_category_repair_does_not_upgrade_service_advertising() -> None:
    validation = {
        "validationErrors": [{
            "code": "REQUIRED_SOURCE_CATEGORY_MISSING",
            "scope": "completion",
            "details": {"category": "maintenance"},
        }]
    }
    evidence = [{
        "arguments": {"includeDomains": []},
        "externalSources": [{
            "title": "Spindle Repair and Replacement Service",
            "url": "https://vendor.example/service/spindle-repair",
            "excerptPreview": "Contact our service team for spindle replacement.",
        }],
    }]
    assert correctable_source_validation_codes(validation, evidence) == []


def test_source_category_repair_does_not_upgrade_low_authority_repair_flow() -> None:
    validation = {
        "validationErrors": [{
            "code": "REQUIRED_SOURCE_CATEGORY_MISSING",
            "scope": "completion",
            "details": {"category": "maintenance"},
        }]
    }
    evidence = [{
        "arguments": {"includeDomains": []},
        "externalSources": [{
            "title": "电主轴维修流程",
            "url": "https://baike.baidu.com/item/spindle-repair",
            "excerptPreview": "维修指南和轴承拆装流程。",
        }],
    }]
    assert _source_category_candidates(evidence)["maintenance"] == []
    assert correctable_source_validation_codes(validation, evidence) == []


def test_source_category_repair_accepts_formal_maintenance_manual() -> None:
    validation = {
        "validationErrors": [{
            "code": "REQUIRED_SOURCE_CATEGORY_MISSING",
            "scope": "completion",
            "details": {"category": "maintenance"},
        }]
    }
    evidence = [{
        "arguments": {"includeDomains": []},
        "externalSources": [{
            "title": "CNC Spindle Troubleshooting Manual",
            "url": "https://docs.example/spindle-troubleshooting-manual.pdf",
        }],
    }]
    assert correctable_source_validation_codes(validation, evidence) == [
        "REQUIRED_SOURCE_CATEGORY_MISSING"
    ]


def test_efficiency_audit_flags_discovery_generic_and_duplicate_overhead() -> None:
    evidence = []
    for index, tool in enumerate([
        "get_dataset_info", "list_tables", "describe_table", "list_metric_definitions",
        "ask_manufacturing_question", "ask_manufacturing_question", "ask_manufacturing_question",
        "retrieve_external_evidence", "retrieve_external_evidence", "retrieve_external_evidence", "retrieve_external_evidence",
    ]):
        digest = "duplicate" if index in {7, 8} else f"args-{index}"
        evidence.append({
            "tool": tool, "argumentsDigest": digest, "status": "success",
            "externalSources": [{"url": "https://example.com"}] if "external" in tool else [],
            "sourceTables": ["production_orders"] if tool == "ask_manufacturing_question" else [],
            "queryTrace": {"queryCount": 1 if tool == "ask_manufacturing_question" else 0},
            "resultSummary": {},
        })
    audit = audit_tool_efficiency(evidence)
    codes = {item["code"] for item in audit["efficiencyWarnings"]}
    assert audit["efficiencyStatus"] == "review"
    assert audit["efficiencySummary"]["exactDuplicateCallCount"] == 1
    assert "EXACT_DUPLICATE_TOOL_CALLS" in codes
    assert "DISCOVERY_HEAVY_PLAN" in codes
    assert "GENERIC_ANALYSIS_TOOL_OVERUSE" in codes
    assert "EXTERNAL_SEARCH_FANOUT_HIGH" in codes


def test_efficiency_audit_rewards_compact_high_level_plan() -> None:
    evidence = [
        {
            "tool": "analyze_machine_360", "argumentsDigest": "machine", "status": "success",
            "externalSources": [], "sourceTables": ["production_orders", "quality_inspections"],
            "queryTrace": {"queryCount": 4}, "resultSummary": {"rowCountInPayload": 1},
        },
        {
            "tool": "rank_root_cause_candidates", "argumentsDigest": "root", "status": "success",
            "externalSources": [], "sourceTables": ["downtime_events", "quality_inspections"],
            "queryTrace": {"queryCount": 3}, "resultSummary": {"rowCountInPayload": 5},
        },
        {
            "tool": "retrieve_external_evidence", "argumentsDigest": "external", "status": "success",
            "externalSources": [{"url": "https://example.com/source"}], "sourceTables": [],
            "queryTrace": {"queryCount": 0}, "resultSummary": {"returned": 6},
        },
    ]
    audit = audit_tool_efficiency(evidence)
    assert audit["efficiencyStatus"] == "efficient"
    assert audit["efficiencyScore"] == 100.0
    assert audit["efficiencySummary"]["highLevelAnalysisCallCount"] == 2
    assert audit["efficiencySummary"]["productiveCallRate"] == 1.0


def test_efficiency_audit_flags_high_model_context_tokens() -> None:
    evidence = [{
        "tool": "analyze_machine_360", "argumentsDigest": "machine", "status": "success",
        "externalSources": [], "sourceTables": ["production_orders"],
        "queryTrace": {"queryCount": 1}, "resultSummary": {"rowCountInPayload": 8},
    }]
    audit = audit_tool_efficiency(evidence, total_tokens=55_052)
    assert audit["efficiencyStatus"] == "review"
    assert audit["efficiencyScore"] == 90.0
    assert audit["efficiencySummary"]["tokensPerToolCall"] == 55_052.0
    assert "MODEL_CONTEXT_TOKEN_HIGH" in {
        item["code"] for item in audit["efficiencyWarnings"]
    }


def test_efficiency_audit_flags_semantic_risk_overlap_and_fragmented_root_causes() -> None:
    names = [
        "find_cross_domain_risks", "analyze_machine_360",
        "rank_root_cause_candidates", "rank_root_cause_candidates", "rank_root_cause_candidates",
    ]
    evidence = [{
        "tool": name, "argumentsDigest": f"args-{index}", "status": "success",
        "externalSources": [], "sourceTables": ["production_orders"],
        "queryTrace": {"queryCount": 1}, "resultSummary": {"rowCountInPayload": 3},
    } for index, name in enumerate(names)]
    audit = audit_tool_efficiency(evidence)
    codes = {item["code"] for item in audit["efficiencyWarnings"]}
    assert audit["efficiencyStatus"] == "review"
    assert audit["efficiencySummary"]["semanticOverlapDetected"] is True
    assert audit["efficiencySummary"]["individualRootCauseCallCount"] == 3
    assert "SEMANTICALLY_REDUNDANT_RISK_TOOLS" in codes
    assert "ROOT_CAUSE_CALL_FRAGMENTATION" in codes


def test_efficiency_audit_counts_batch_root_causes_as_high_level_analysis() -> None:
    evidence = [
        {
            "tool": "analyze_machine_360", "argumentsDigest": "ranking", "status": "success",
            "externalSources": [], "sourceTables": ["production_orders"],
            "queryTrace": {"queryCount": 9}, "resultSummary": {"rowCountInPayload": 8},
        },
        {
            "tool": "rank_machine_root_causes_batch", "argumentsDigest": "batch-root", "status": "success",
            "externalSources": [], "sourceTables": ["downtime_events", "quality_inspections"],
            "queryTrace": {"queryCount": 15}, "resultSummary": {"rowCountInPayload": 3},
        },
    ]
    audit = audit_tool_efficiency(evidence, total_tokens=38_963)
    assert audit["efficiencyStatus"] == "efficient"
    assert audit["efficiencyScore"] == 100.0
    assert audit["efficiencySummary"]["highLevelAnalysisCallCount"] == 2


def test_efficiency_audit_flags_semantically_fragmented_sandbox_plan() -> None:
    evidence = [
        {
            "tool": "run_natural_language_sandbox_analysis",
            "argumentsDigest": f"month-{index}",
            "status": "error" if index == 5 else "success",
            "externalSources": [],
            "sourceTables": ["production_orders"],
            "queryTrace": {"queryCount": 1},
            "resultSummary": {},
        }
        for index in range(10)
    ]
    audit = audit_tool_efficiency(evidence)
    codes = {item["code"] for item in audit["efficiencyWarnings"]}
    assert audit["efficiencyStatus"] == "review"
    assert audit["efficiencySummary"]["sandboxCallCount"] == 10
    assert audit["efficiencySummary"]["failedToolCallCount"] == 1
    assert "SANDBOX_QUERY_FRAGMENTATION" in codes
    assert "TOOL_CALL_FAILURES" in codes
    assert audit["efficiencyScore"] < 80


def test_efficiency_audit_flags_partitioned_high_level_tool_explosion() -> None:
    evidence = [{
        "tool": "analyze_energy_production_efficiency",
        "argumentsDigest": f"month-machine-{index}", "status": "success",
        "externalSources": [], "sourceTables": ["energy_readings", "production_orders"],
        "queryTrace": {"queryCount": 2}, "resultSummary": {"rowCountInPayload": 8},
    } for index in range(12)]
    audit = audit_tool_efficiency(evidence)
    codes = {item["code"] for item in audit["efficiencyWarnings"]}
    assert "PARTITIONED_TOOL_CALL_EXPLOSION" in codes
    assert "HIGH_LEVEL_TOOL_FANOUT" in codes
    assert audit["efficiencySummary"]["partitionedToolCalls"] == {
        "analyze_energy_production_efficiency": 12
    }


def test_i05_validation_detects_monthly_quantity_and_energy_formula_errors() -> None:
    answer = """
数据时间范围：2026-01-01 至 2026-03-31。按月分析能耗、峰值功率、运行时间、产量、良品和单位合格品能耗。

### 月度能耗 electricity_kwh
| 设备 | 2026-01 | 2026-02 | 2026-03 | 合计 |
| --- | ---: | ---: | ---: | ---: |
| M07 | 100 | 110 | 120 | 330 |

### 月度产量 actual_qty
| 设备 | 2026-01 | 2026-02 | 2026-03 | 合计 |
| --- | ---: | ---: | ---: | ---: |
| M07 | 100 | 90 | 80 | 270 |

### 月度良品 good_qty
| 设备 | 2026-01 | 2026-02 | 2026-03 | 合计 |
| --- | ---: | ---: | ---: | ---: |
| M07 | 95 | 95 | 70 | 260 |

### 月度峰值功率 peak_demand_kw
| 设备 | 2026-01 | 2026-02 | 2026-03 |
| --- | ---: | ---: | ---: |
| M07 | 20 | 21 | 22 |

### 月度运行时间 runtime_hours
| 设备 | 2026-01 | 2026-02 | 2026-03 | 合计 |
| --- | ---: | ---: | ---: | ---: |
| M07 | 50 | 55 | 60 | 165 |

### 单位合格品能耗 kWh/件
| 设备 | 2026-01 | 2026-02 | 2026-03 |
| --- | ---: | ---: | ---: |
| M07 | 1.0526 | 1.1000 | 1.7143 |

来源表 energy_readings、production_orders；筛选条件为上述时间范围。高能耗但低产出仅表示筛查结果，不代表因果关系。
""" * 2
    result = validate_task_result(
        task_id="I05", category="internal", answer=answer,
        tool_calls=[{"name": "analyze_energy_production_efficiency", "status": "success"}],
    )
    codes = {item["code"] for item in result["validationErrors"]}
    assert "QUANTITY_BALANCE_MISMATCH" in codes
    assert "ENERGY_INTENSITY_FORMULA_MISMATCH" in codes
    assert result["completionStatus"] == "partial"


def _i05_complete_detail_answer(*, omit_last_row: bool = False) -> str:
    rows = []
    for machine_index in range(1, 9):
        for month_index in range(1, 7):
            if omit_last_row and machine_index == 8 and month_index == 6:
                continue
            actual = 1000 + machine_index * 10 + month_index
            good = actual - 5
            energy = good * 1.25
            rows.append(
                f"| M{machine_index:02d} | 2026-{month_index:02d} | {energy:.2f} | "
                f"{30 + machine_index:.2f} | {100 + month_index:.2f} | {actual} | {good} | {energy / good:.4f} |"
            )
    return """
数据时间范围：2026-01-01 至 2026-06-30。以下为各设备完整月度明细，覆盖月度能耗、峰值功率、运行时间、产量、良品和单位良品能耗。

| 设备 | 月份 | 能耗(kWh) | 峰值功率(kW) | 运行时间(h) | 产量 | 良品数量 | 单位良品能耗(kWh/件) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
""" + "\n".join(rows) + """

来源表：energy_readings、production_orders。筛选条件：2026-01-01 至 2026-06-30、全部设备。数据质量：字段完整；相关性不代表因果关系。
"""


def test_i05_validation_accepts_complete_machine_month_detail_table() -> None:
    result = validate_task_result(
        task_id="I05", category="internal", answer=_i05_complete_detail_answer(),
        tool_calls=[{"name": "analyze_energy_production_efficiency", "status": "success"}],
    )
    numeric_codes = {
        item["code"] for item in result["validationErrors"]
        if item["code"] in {
            "NUMERIC_VALIDATION_UNAVAILABLE", "MONTHLY_DETAIL_INCOMPLETE",
            "QUANTITY_BALANCE_MISMATCH", "ENERGY_INTENSITY_FORMULA_MISMATCH",
        }
    }
    assert numeric_codes == set()
    assert result["completionStatus"] == "complete"


def test_i05_validation_rejects_missing_machine_month_row() -> None:
    result = validate_task_result(
        task_id="I05", category="internal", answer=_i05_complete_detail_answer(omit_last_row=True),
        tool_calls=[{"name": "analyze_energy_production_efficiency", "status": "success"}],
    )
    codes = {item["code"] for item in result["validationErrors"]}
    assert "MONTHLY_DETAIL_INCOMPLETE" in codes
    assert result["completionStatus"] == "partial"


def test_i07_validation_accepts_explicit_method_specific_findings_as_unique_anomalies() -> None:
    answer = """
数据时间范围：2026-01-01 至 2026-06-30。比较规则异常、统计异常和趋势异常。
2026-01、2026-02、2026-03、2026-04、2026-05、2026-06均进入时间序列比较。
共同异常是2026-04停机上升。规则法独有发现包括供应商批次异常；统计法独有发现包括质量离群日；
趋势法独有发现是停机环比台阶式变化。以上差集反映方法口径不同，不代表已经证明因果关系。
来源表：downtime_events、quality_inspections、energy_readings；查询摘要：abc123。
""" * 2
    result = validate_task_result(
        task_id="I07", category="internal", answer=answer,
        tool_calls=[{"name": "get_anomaly_overview", "status": "success"}],
    )
    missing_topics = [item for item in result["validationErrors"] if item["code"] == "REQUIRED_TOPIC_MISSING"]
    assert missing_topics == []
    assert result["completionStatus"] == "complete"


def test_write_efficiency_audit_output(tmp_path: Path) -> None:
    record = {
        "taskId": "H02", "group": "agent", "repetition": 1,
        **audit_tool_efficiency([{
            "tool": "analyze_machine_360", "argumentsDigest": "one", "status": "success",
            "externalSources": [], "sourceTables": ["production_orders"],
            "queryTrace": {"queryCount": 1}, "resultSummary": {"rowCountInPayload": 1},
        }]),
    }
    (tmp_path / "raw_results.jsonl").write_text(json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8")
    assert write_efficiency_audit_output(tmp_path) == 1
    report = (tmp_path / "efficiency_audit_report.md").read_text(encoding="utf-8")
    assert "H02" in report
    assert "analyze_machine_360" not in report  # report stays aggregate and compact


def test_write_evidence_audit_outputs(tmp_path: Path) -> None:
    record = {
        "runId": "run-test", "taskId": "E01", "repetition": 1, "group": "agent",
        "evidenceAuditStatus": "partial",
        "evidenceAuditErrors": [{"code": "RETRIEVED_SOURCES_NOT_CITED"}],
        "evidenceSummary": {
            "toolEvidenceCount": 1, "externalSourcesRetrieved": 1, "externalSourcesCited": 0,
            "retrievedSourceUtilization": 0.0, "claimBindingRate": 0.0, "sourceTables": [], "queryCount": 0,
        },
        "toolEvidence": [{"evidenceId": "TE-001", "tool": "retrieve_external_evidence", "externalSources": []}],
    }
    (tmp_path / "raw_results.jsonl").write_text(json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8")
    assert write_evidence_audit_outputs(tmp_path) == 1
    assert "TE-001" in (tmp_path / "tool_evidence.jsonl").read_text(encoding="utf-8")
    report = (tmp_path / "evidence_audit_report.md").read_text(encoding="utf-8")
    assert "RETRIEVED_SOURCES_NOT_CITED" in report
