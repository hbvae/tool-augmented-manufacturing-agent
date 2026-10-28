from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

from .client import create_manufacturing_agent, discover_mcp_tools, final_text
from .settings import AgentSettings, ConfigurationError
from .tools import select_agent_tools


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description="制造业 LangChain + MCP 智能体客户端")
    value.add_argument("--question", "-q", help="执行一次问题后退出；不提供时进入连续对话")
    value.add_argument("--list-tools", action="store_true", help="仅测试 MCP 连接并列出工具，不需要模型 API Key")
    value.add_argument("--smoke-test", action="store_true", help="通过 LangChain 实际调用只读 MCP 工具，不需要模型 API Key")
    value.add_argument("--external-search-smoke-test", action="store_true", help="实际调用当前外部搜索供应商，不需要模型 API Key")
    value.add_argument("--all-tools", action="store_true", help="向模型开放全部 MCP 工具（不推荐）")
    value.add_argument("--plan-only", action="store_true", help="要求智能体只生成分析计划，不实际生成报告")
    return value


async def list_tools(settings: AgentSettings, include_all: bool) -> int:
    discovered = await discover_mcp_tools(settings)
    selected = select_agent_tools(discovered, include_all=include_all)
    selected_names = {tool.name for tool in selected}
    print(f"MCP 连接成功：发现 {len(discovered)} 个工具，智能体可用 {len(selected)} 个。")
    for tool in discovered:
        flag = "启用" if tool.name in selected_names else "未开放"
        print(f"- [{flag}] {tool.name}")
    return 0


async def smoke_test(settings: AgentSettings) -> int:
    discovered = await discover_mcp_tools(settings)

    def find(name: str) -> Any:
        match = next((tool for tool in discovered if tool.name == name or tool.name.endswith(f"_{name}")), None)
        if match is None:
            raise ConfigurationError(f"冒烟测试缺少 MCP 工具：{name}")
        return match

    dataset = await find("get_dataset_info").ainvoke({})
    planned = await find("run_natural_language_sandbox_analysis").ainvoke(
        {
            "question": "按设备汇总生产实际产量和报废数量",
            "limit": 10,
            "downloadOutputs": False,
            "downloadAnalysisFiles": False,
            "dryRun": True,
        }
    )
    if not dataset or not planned:
        raise RuntimeError("MCP 工具返回了空结果。")
    print("LangChain → MCP 冒烟测试通过：")
    print("- get_dataset_info：调用成功")
    print("- run_natural_language_sandbox_analysis(dryRun=true)：调用成功")
    return 0


async def external_search_smoke_test(settings: AgentSettings) -> int:
    server_env = settings.mcp_config["mcpServers"]["manufacturing"].get("env", {})
    provider = server_env.get("MANUFACTURING_EXTERNAL_SEARCH_PROVIDER", "tavily").lower()
    required_key = "BAIDU_AI_SEARCH_API_KEY" if provider.startswith("baidu") else "TAVILY_API_KEY"
    if not server_env.get(required_key):
        raise ConfigurationError(f"当前供应商为 {provider}，但未配置 {required_key}；请将它加入项目 .env 后重试。")
    discovered = await discover_mcp_tools(settings)
    tool = next(
        (item for item in discovered if item.name == "search_external_sources" or item.name.endswith("_search_external_sources")),
        None,
    )
    if tool is None:
        raise ConfigurationError("MCP Server 没有提供 search_external_sources。")
    result = await tool.ainvoke(
        {
            "query": "数控机床主轴异常噪声 故障诊断",
            "searchDepth": "basic",
            "language": "zh",
            "country": "cn",
            "maxResults": 3,
            "includeDomains": [],
            "excludeDomains": [],
            "safeSearch": True,
        }
    )
    rendered = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)
    if '"error"' in rendered or "'error'" in rendered:
        raise RuntimeError(f"外部检索工具返回错误：{rendered[:1500]}")
    print(f"LangChain → MCP → {provider} 外部检索测试通过。")
    print(rendered[:1500])
    return 0


async def invoke(agent: Any, messages: list[Any], question: str, plan_only: bool) -> dict[str, Any]:
    content = question
    if plan_only:
        content += "\n只生成并解释分析计划，不执行分析；调用自然语言沙箱分析工具时设置 dryRun=true。"
    return await agent.ainvoke({"messages": [*messages, {"role": "user", "content": content}]})


async def run(args: argparse.Namespace) -> int:
    settings = AgentSettings.load(require_model=not (args.list_tools or args.smoke_test or args.external_search_smoke_test))
    if args.list_tools:
        return await list_tools(settings, args.all_tools)
    if args.smoke_test:
        return await smoke_test(settings)
    if args.external_search_smoke_test:
        return await external_search_smoke_test(settings)

    agent, tools = await create_manufacturing_agent(settings, include_all_tools=args.all_tools)
    print(f"模型：{settings.model}；已开放 {len(tools)} 个 MCP 工具。")
    history: list[Any] = []
    if args.question:
        result = await invoke(agent, history, args.question, args.plan_only)
        print(final_text(result))
        return 0

    print("输入制造业分析问题；输入 exit 或 quit 退出。")
    while True:
        try:
            question = input("\n你：").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        if question.lower() in {"exit", "quit", "退出"}:
            return 0
        if not question:
            continue
        result = await invoke(agent, history, question, args.plan_only)
        print(f"\n智能体：{final_text(result)}")
        history = list(result.get("messages") or [])


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    try:
        raise SystemExit(asyncio.run(run(parser().parse_args())))
    except ConfigurationError as exc:
        print(f"配置错误：{exc}", file=sys.stderr)
        raise SystemExit(2) from exc
    except Exception as exc:
        print(f"运行失败：{type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
