from __future__ import annotations

import json
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MCP_CONFIG = PROJECT_ROOT / ".vscode" / "mcp.json"
INPUT_PLACEHOLDER = re.compile(r"^\$\{input:[^}]+}$")
SECRET_PLACEHOLDERS = ("replace-with-", "your-", "请替换", "你的")


class ConfigurationError(RuntimeError):
    """Raised when the local agent configuration is incomplete or unsafe."""


def usable_secret(value: Any) -> str | None:
    if value is None:
        return None
    rendered = str(value).strip()
    if not rendered or INPUT_PLACEHOLDER.match(rendered):
        return None
    lowered = rendered.lower()
    if any(marker in lowered for marker in SECRET_PLACEHOLDERS):
        return None
    return rendered


def _read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as exc:
        raise ConfigurationError(f"找不到 MCP 配置文件：{path}") from exc
    except json.JSONDecodeError as exc:
        raise ConfigurationError(f"MCP 配置不是有效 JSON：{path}") from exc


def _configured_server(path: Path, server_name: str) -> dict[str, Any]:
    document = _read_json(path)
    servers = document.get("servers") or document.get("mcpServers") or {}
    server = servers.get(server_name)
    if not isinstance(server, dict):
        raise ConfigurationError(f"MCP 配置中不存在服务器 {server_name!r}。")
    return server


def _resolved_command(raw: str | None) -> str:
    command = os.getenv("MANUFACTURING_NODE_COMMAND") or raw or shutil.which("node")
    if not command:
        raise ConfigurationError("找不到 Node.js；请设置 MANUFACTURING_NODE_COMMAND。")
    candidate = Path(command)
    if candidate.is_absolute() and not candidate.is_file():
        raise ConfigurationError(f"Node.js 命令不存在：{candidate}")
    return str(candidate) if candidate.is_absolute() else command


def _child_environment(configured: dict[str, Any]) -> dict[str, str]:
    source = configured.get("env") if isinstance(configured.get("env"), dict) else {}
    child = {
        str(key): str(value)
        for key, value in source.items()
        if value is not None and usable_secret(value) is not None
    }
    allowed_overrides = (
        "MANUFACTURING_DB",
        "MANUFACTURING_EXTERNAL_SEARCH_PROVIDER",
        "MANUFACTURING_EXTERNAL_CONTENT_PROVIDER",
        "BAIDU_AI_SEARCH_API_KEY",
        "TAVILY_API_KEY",
        "MANUFACTURING_EXTERNAL_SEARCH_TIMEOUT_MS",
        "MANUFACTURING_EXTERNAL_SEARCH_MAX_RETRIES",
        "MANUFACTURING_EXTERNAL_SEARCH_RETRY_BASE_DELAY_MS",
        "MANUFACTURING_EXTERNAL_SEARCH_CACHE_TTL_MS",
        "MANUFACTURING_AGENT_MODEL_CALL_TIMEOUT_SECONDS",
        "MANUFACTURING_AGENT_MODEL_CALL_TIMEOUT_RETRIES",
        "MANUFACTURING_AGENT_EXTERNAL_SEARCH_STOP_CALLS",
        "MANUFACTURING_EMBEDDING_ENABLED",
        "MANUFACTURING_EMBEDDING_OFFLINE",
        "MANUFACTURING_AIO_BASE_URL",
        "MANUFACTURING_AIO_API_KEY",
        "MANUFACTURING_AIO_WORKSPACE",
        "MANUFACTURING_AIO_REQUEST_TIMEOUT_MS",
        "MANUFACTURING_EXPORT_DIR",
    )
    for key in allowed_overrides:
        value = usable_secret(os.getenv(key))
        if value is not None:
            child[key] = value
    return child


@dataclass(frozen=True)
class AgentSettings:
    mcp_config_path: Path
    mcp_server_name: str
    mcp_config: dict[str, Any]
    model: str
    api_key: str | None
    base_url: str | None
    temperature: float
    max_retries: int

    @classmethod
    def load(cls, *, require_model: bool = True) -> "AgentSettings":
        load_dotenv(PROJECT_ROOT / ".env", override=False)
        config_path = Path(os.getenv("MANUFACTURING_MCP_CONFIG", DEFAULT_MCP_CONFIG)).resolve()
        server_name = os.getenv("MANUFACTURING_MCP_SERVER", "manufacturing-data")
        configured = _configured_server(config_path, server_name)
        args = [str(value) for value in configured.get("args", [])]
        if not args:
            raise ConfigurationError("MCP stdio 配置必须包含 args。")
        server_script = Path(args[0])
        if server_script.is_absolute() and not server_script.is_file():
            raise ConfigurationError(f"MCP 服务入口不存在：{server_script}")
        command = _resolved_command(configured.get("command"))
        mcp_config = {
            "mcpServers": {
                "manufacturing": {
                    "command": command,
                    "args": args,
                    "env": _child_environment(configured),
                }
            }
        }

        api_key = (
            usable_secret(os.getenv("MANUFACTURING_LLM_API_KEY"))
            or usable_secret(os.getenv("DEEPSEEK_API_KEY"))
            or usable_secret(os.getenv("OPENAI_API_KEY"))
        )
        base_url = os.getenv("MANUFACTURING_LLM_BASE_URL")
        if not base_url and os.getenv("DEEPSEEK_API_KEY") and not os.getenv("MANUFACTURING_LLM_API_KEY"):
            base_url = "https://api.deepseek.com"
        model = os.getenv("MANUFACTURING_LLM_MODEL") or ("deepseek-chat" if os.getenv("DEEPSEEK_API_KEY") else "gpt-4.1-mini")
        if require_model and not api_key:
            raise ConfigurationError("未配置模型 API Key；请设置 MANUFACTURING_LLM_API_KEY、DEEPSEEK_API_KEY 或 OPENAI_API_KEY。")
        return cls(
            mcp_config_path=config_path,
            mcp_server_name=server_name,
            mcp_config=mcp_config,
            model=model,
            api_key=api_key,
            base_url=base_url,
            temperature=float(os.getenv("MANUFACTURING_LLM_TEMPERATURE", "0")),
            max_retries=max(0, min(int(os.getenv("MANUFACTURING_LLM_MAX_RETRIES", "2")), 5)),
        )
