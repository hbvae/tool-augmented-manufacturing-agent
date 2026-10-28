from __future__ import annotations

import asyncio
import mimetypes
import sys
from pathlib import Path
from typing import Any

import streamlit as st
from langchain_core.messages import AIMessage, ToolMessage

from langchain_agent.client import create_manufacturing_agent, final_text
from langchain_agent.settings import AgentSettings, ConfigurationError, PROJECT_ROOT


st.set_page_config(
    page_title="制造业数据智能体",
    page_icon="⚙️",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.markdown(
    """
    <style>
    :root { --ink:#172033; --muted:#667085; --line:#e7eaf0; --brand:#165d8f; --accent:#e9862c; }
    .stApp { background: linear-gradient(180deg, #f6f8fb 0%, #ffffff 36%); color: var(--ink); }
    [data-testid="stHeader"] { background: transparent; }
    [data-testid="stSidebar"] { background: #101b2b; }
    [data-testid="stSidebar"] h1,
    [data-testid="stSidebar"] h2,
    [data-testid="stSidebar"] h3,
    [data-testid="stSidebar"] p,
    [data-testid="stSidebar"] label,
    [data-testid="stSidebar"] [data-testid="stMarkdownContainer"] { color: #edf4fb; }
    [data-testid="stSidebar"] .stCaption { color: #9eb1c6 !important; }
    [data-testid="stSidebar"] .stButton > button,
    [data-testid="stSidebar"] .stDownloadButton > button {
        background: #1b3048 !important;
        color: #f7fbff !important;
        border: 1px solid #45627f !important;
        border-radius: 9px;
        box-shadow: none;
    }
    [data-testid="stSidebar"] .stButton > button p,
    [data-testid="stSidebar"] .stButton > button span,
    [data-testid="stSidebar"] .stDownloadButton > button p,
    [data-testid="stSidebar"] .stDownloadButton > button span {
        color: #f7fbff !important;
    }
    [data-testid="stSidebar"] .stButton > button:hover,
    [data-testid="stSidebar"] .stDownloadButton > button:hover {
        background: #274a6b !important;
        border-color: #78a9d1 !important;
        color: #ffffff !important;
    }
    [data-testid="stSidebar"] .stButton > button:focus-visible,
    [data-testid="stSidebar"] .stDownloadButton > button:focus-visible {
        outline: 3px solid rgba(233, 134, 44, .45) !important;
        outline-offset: 2px;
    }
    [data-testid="stSidebar"] .stButton > button:disabled,
    [data-testid="stSidebar"] .stDownloadButton > button:disabled {
        background: #19283a !important;
        border-color: #30465e !important;
        color: #8497aa !important;
        opacity: 1;
    }
    [data-testid="stSidebar"] .stButton > button:disabled p,
    [data-testid="stSidebar"] .stButton > button:disabled span,
    [data-testid="stSidebar"] .stDownloadButton > button:disabled p,
    [data-testid="stSidebar"] .stDownloadButton > button:disabled span {
        color: #8497aa !important;
    }
    .hero { padding: 1.2rem 0 .8rem; border-bottom: 1px solid var(--line); margin-bottom: 1rem; }
    .hero-kicker { color: var(--accent); font-size:.78rem; font-weight:750; letter-spacing:.12em; text-transform:uppercase; }
    .hero h1 { color:var(--ink); font-size:2rem; line-height:1.15; margin:.35rem 0; letter-spacing:-.03em; }
    .hero p { color:var(--muted); max-width:780px; margin:0; }
    .status-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.6rem; margin:.7rem 0 1.1rem; }
    .status-card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:.72rem .85rem; box-shadow:0 4px 18px rgba(23,32,51,.04); }
    .status-label { color:var(--muted); font-size:.74rem; }
    .status-value { color:var(--ink); font-size:.93rem; font-weight:700; margin-top:.15rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .dot { width:.5rem; height:.5rem; display:inline-block; border-radius:50%; background:#21a179; margin-right:.35rem; }
    [data-testid="stChatMessage"] { background:#fff; border:1px solid var(--line); border-radius:14px; padding:.25rem .4rem; box-shadow:0 4px 16px rgba(23,32,51,.035); }
    .trace-box { color:#536174; font-size:.83rem; line-height:1.5; }
    .privacy-note { background:#16263a; border:1px solid #29405a; border-radius:10px; padding:.65rem .75rem; font-size:.78rem; color:#b9c8d8; }
    @media(max-width:760px){ .status-grid{grid-template-columns:1fr;} .hero h1{font-size:1.55rem;} }
    </style>
    """,
    unsafe_allow_html=True,
)


def run_async(awaitable: Any) -> Any:
    return asyncio.run(awaitable)


@st.cache_resource(show_spinner=False)
def load_runtime(include_external_search: bool) -> tuple[AgentSettings, Any, list[Any]]:
    settings = AgentSettings.load(require_model=True)
    agent, tools = run_async(
        create_manufacturing_agent(
            settings,
            include_all_tools=False,
            include_external_search=include_external_search,
        )
    )
    return settings, agent, tools


def trace_summary(messages: list[Any]) -> list[str]:
    rows: list[str] = []
    for message in messages:
        if isinstance(message, AIMessage):
            for call in message.tool_calls or []:
                rows.append(f"调用工具：{call.get('name', 'unknown')}")
        elif isinstance(message, ToolMessage):
            status = getattr(message, "status", None) or "completed"
            rows.append(f"工具返回：{message.name or 'unknown'} · {status}")
    return rows


def external_status(settings: AgentSettings) -> tuple[str, bool]:
    server = settings.mcp_config["mcpServers"]["manufacturing"]
    environment = server.get("env", {})
    provider = str(environment.get("MANUFACTURING_EXTERNAL_SEARCH_PROVIDER", "tavily")).lower()
    if provider.startswith("baidu"):
        ready = bool(environment.get("BAIDU_AI_SEARCH_API_KEY"))
        if provider in {"baidu_fallback", "baidu-fallback"}:
            ready = ready or bool(environment.get("TAVILY_API_KEY"))
    else:
        ready = bool(environment.get("TAVILY_API_KEY"))
    return provider, ready


def find_tool(tools: list[Any], expected_name: str) -> Any | None:
    return next(
        (tool for tool in tools if tool.name == expected_name or tool.name.endswith(f"_{expected_name}")),
        None,
    )


def render_recent_exports() -> None:
    export_dir = PROJECT_ROOT / "exports"
    if not export_dir.is_dir():
        st.caption("尚无导出文件")
        return
    files = sorted((item for item in export_dir.iterdir() if item.is_file()), key=lambda item: item.stat().st_mtime, reverse=True)[:8]
    if not files:
        st.caption("尚无导出文件")
        return
    for index, file in enumerate(files):
        size = file.stat().st_size
        if size > 10 * 1024 * 1024:
            continue
        mime = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        st.download_button(
            label=f"↓ {file.name}",
            data=file.read_bytes(),
            file_name=file.name,
            mime=mime,
            key=f"download-{index}-{file.stat().st_mtime_ns}",
            use_container_width=True,
        )


if "display_messages" not in st.session_state:
    st.session_state.display_messages = []
if "agent_messages" not in st.session_state:
    st.session_state.agent_messages = []
if "pending_prompt" not in st.session_state:
    st.session_state.pending_prompt = None


with st.sidebar:
    st.markdown("## ⚙ 制造业智能体")
    st.caption("LangChain · MCP · AIO Sandbox")
    st.divider()
    include_external = st.toggle("启用外部检索", value=True, help="启用已配置的搜索供应商、证据重排和多来源核对工具")
    plan_only = st.toggle("仅生成分析计划", value=False, help="不执行沙箱分析，也不生成文件")
    st.caption("默认不会向模型开放任意 Python、任意 SQL或文件上传工具。")
    if st.button("清空当前对话", use_container_width=True):
        st.session_state.display_messages = []
        st.session_state.agent_messages = []
        st.rerun()
    if st.button("重新加载配置", use_container_width=True):
        load_runtime.clear()
        st.session_state.agent_messages = []
        st.rerun()
    st.divider()
    st.markdown("### 最近生成的文件")
    render_recent_exports()
    st.markdown('<div class="privacy-note">密钥只从本机 .env 读取，不会显示在网页，也不会写入对话消息。</div>', unsafe_allow_html=True)


try:
    settings, agent, available_tools = load_runtime(include_external)
except ConfigurationError as exc:
    st.markdown('<div class="hero"><div class="hero-kicker">LOCAL ANALYTICS COPILOT</div><h1>制造业数据智能体</h1><p>通过 LangChain 调用本地 MCP 工具，并在 AIO Sandbox 中执行受控分析。</p></div>', unsafe_allow_html=True)
    st.error(f"配置错误：{exc}")
    st.code(
        "MANUFACTURING_LLM_API_KEY=你的模型Key\n"
        "MANUFACTURING_LLM_BASE_URL=https://api.deepseek.com\n"
        "MANUFACTURING_LLM_MODEL=deepseek-chat\n"
        "MANUFACTURING_EXTERNAL_SEARCH_PROVIDER=baidu\n"
        "BAIDU_AI_SEARCH_API_KEY=你的百度AI搜索Key",
        language="dotenv",
    )
    st.info("请修改项目根目录的 .env，然后点击左侧“重新加载配置”。")
    st.stop()
except Exception as exc:
    st.error(f"初始化失败：{type(exc).__name__}: {exc}")
    st.info("请先运行 run-langchain-agent.cmd --smoke-test 检查 MCP 连接。")
    st.stop()


search_provider, external_ready = external_status(settings)
st.markdown(
    '<div class="hero"><div class="hero-kicker">LOCAL ANALYTICS COPILOT</div><h1>制造业数据智能体</h1>'
    '<p>用自然语言查询内部制造数据、生成沙箱分析报告，并检索可追溯的外部公开资料。</p></div>',
    unsafe_allow_html=True,
)
st.markdown(
    f"""
    <div class="status-grid">
      <div class="status-card"><div class="status-label">模型</div><div class="status-value"><span class="dot"></span>{settings.model}</div></div>
      <div class="status-card"><div class="status-label">MCP 工具</div><div class="status-value"><span class="dot"></span>{len(available_tools)} 个已开放</div></div>
      <div class="status-card"><div class="status-label">外部检索</div><div class="status-value"><span class="dot" style="background:{'#21a179' if external_ready else '#e9862c'}"></span>{search_provider + (' 已配置' if external_ready else ' 等待 Key')}</div></div>
    </div>
    """,
    unsafe_allow_html=True,
)

if include_external and not external_ready:
    st.warning(f"外部检索已开启，但 {search_provider} 没有有效的 API Key；内部数据分析仍可正常使用。")

with st.sidebar:
    st.divider()
    st.markdown("### 连接测试")
    if st.button(
        "测试外部检索",
        use_container_width=True,
        disabled=not (include_external and external_ready),
        help="执行一次最多返回1条结果的真实搜索，会消耗当前供应商的一次调用额度。",
    ):
        search_tool = find_tool(available_tools, "search_external_sources")
        if search_tool is None:
            st.error("当前工具白名单中没有外部检索工具。")
        else:
            try:
                with st.spinner(f"正在连接 {search_provider}…"):
                    test_result = run_async(
                        search_tool.ainvoke(
                            {
                                "query": "数控机床预测性维护",
                                "searchDepth": "basic",
                                "language": "zh",
                                "maxResults": 1,
                                "includeDomains": [],
                                "excludeDomains": [],
                                "safeSearch": True,
                            }
                        )
                    )
                if test_result:
                    st.success(f"{search_provider} 连接成功，外部检索工具已返回结果。")
                else:
                    st.warning("调用成功，但没有返回搜索结果。")
            except Exception as exc:
                st.error(f"{search_provider} 测试失败：{type(exc).__name__}: {exc}")

if not st.session_state.display_messages:
    st.info(f"可以直接提问。涉及最新行业资料时，智能体会调用 {search_provider}；涉及内部数据时，会调用只读制造业工具。")
    columns = st.columns(3)
    examples = [
        "分析M07设备的实际产量和报废数量，生成柱状图报告",
        "检索数控机床主轴异常噪声的可靠排查资料并附来源",
        "解释OEE指标口径，并说明当前数据中的计算假设",
    ]
    for column, example in zip(columns, examples, strict=True):
        if column.button(example, use_container_width=True):
            st.session_state.pending_prompt = example
            st.rerun()

for entry in st.session_state.display_messages:
    with st.chat_message(entry["role"]):
        st.markdown(entry["content"])
        if entry.get("trace"):
            with st.expander("查看工具调用过程"):
                st.markdown("<div class='trace-box'>" + "<br>".join(entry["trace"]) + "</div>", unsafe_allow_html=True)

typed_prompt = st.chat_input("输入制造业分析问题，例如：比较M03与M07的设备风险")
prompt = st.session_state.pending_prompt or typed_prompt
st.session_state.pending_prompt = None

if prompt:
    st.session_state.display_messages.append({"role": "user", "content": prompt})
    with st.chat_message("user"):
        st.markdown(prompt)
    with st.chat_message("assistant"):
        with st.spinner("正在规划并调用 MCP 工具…"):
            try:
                content = prompt
                if plan_only:
                    content += "\n只生成并解释分析计划，不执行分析；调用自然语言沙箱分析工具时设置 dryRun=true。"
                old_count = len(st.session_state.agent_messages)
                result = run_async(
                    agent.ainvoke(
                        {
                            "messages": [
                                *st.session_state.agent_messages,
                                {"role": "user", "content": content},
                            ]
                        }
                    )
                )
                answer = final_text(result)
                full_messages = list(result.get("messages") or [])
                trace = trace_summary(full_messages[old_count:])
                st.markdown(answer)
                if trace:
                    with st.expander("查看工具调用过程"):
                        st.markdown("<div class='trace-box'>" + "<br>".join(trace) + "</div>", unsafe_allow_html=True)
                st.session_state.agent_messages = full_messages
                st.session_state.display_messages.append({"role": "assistant", "content": answer, "trace": trace})
            except Exception as exc:
                message = f"调用失败：{type(exc).__name__}: {exc}"
                st.error(message)
                st.session_state.display_messages.append({"role": "assistant", "content": message, "trace": []})
