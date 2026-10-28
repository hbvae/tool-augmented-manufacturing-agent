"""LangChain client for the manufacturing-data MCP server."""

from .client import create_manufacturing_agent, discover_mcp_tools
from .settings import AgentSettings

__all__ = ["AgentSettings", "create_manufacturing_agent", "discover_mcp_tools"]
