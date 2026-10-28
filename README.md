# Tool-Augmented Manufacturing Agent

面向制造业多源数据分析的工具增强型大模型智能体。系统以 LangChain 组织任务规划，通过模型上下文协议（MCP）统一接入只读制造数据库、外部检索与隔离式 Python 沙箱，并结合客户端本地 RAG、指标语义、完成门控和证据审计生成可追溯分析结果。

> 本仓库用于论文复现与研究交流。`data/` 中的数据均为合成演示数据，不代表任何真实企业或生产现场。

## 主要能力

- 生产、质量、设备、能耗、供应商和库存分析
- 跨表综合分析、异常检测与自然语言分析
- 只读 SQL、字段白名单、分页、超时和最大行数限制
- 百度 AI Search / Tavily 外部检索适配器
- AIO Sandbox 隔离式 Python 分析与报告生成
- LangChain 智能体、命令行客户端和网页聊天界面
- 来源追踪、数值复算、证据审计和任务完成验收
- 三组配对对比实验及盲评材料生成

## 仓库结构

```text
src/                         MCP 服务及制造业分析工具
langchain_agent/             LangChain 智能体、实验程序与网页客户端
data/                        合成制造业 CSV、SQLite 和 Excel 数据
experiments/
  comparison_questions.jsonl 24 项实验任务及验收要求
  final_results/             正式实验原始结果与审计材料
test/                        Node.js 与 Python 自动化测试
docs/                        复现和安全说明
```

## 环境要求

- Node.js 20 或更高版本
- pnpm
- Python 3.11 或更高版本
- Docker Desktop（仅在使用 AIO Sandbox 时需要）
- DeepSeek 或其他 OpenAI 兼容模型 API
- 百度 AI Search 或 Tavily API（仅在使用外部检索时需要）

## 快速开始

### 1. 安装 MCP 服务依赖

```powershell
pnpm install --frozen-lockfile
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env`，填写自己的模型和搜索服务密钥。不要把 `.env` 提交到 Git。

数据库默认可设置为：

```text
MANUFACTURING_DB=./data/manufacturing_demo.db
```

### 3. 启动 MCP 服务

```powershell
.\start.cmd
```

### 4. 安装并运行 LangChain 客户端

```powershell
.\install-langchain-agent.cmd
.\run-langchain-agent.cmd --list-tools
.\run-langchain-web.cmd
```

### 5. 可选：启动 Python 沙箱

```powershell
.\start-aio-sandbox.cmd
```

浏览器访问 `http://127.0.0.1:8080/v1/docs` 检查服务状态。

## 运行测试

```powershell
pnpm test
.\test-langchain-agent.cmd
```

## 复现实验

实验任务位于 `experiments/comparison_questions.jsonl`。运行三组对比实验：

```powershell
.\run-comparison-experiment.cmd --repetitions 3 --timeout-seconds 900
```

正式实验的原始回答、工具轨迹、盲评材料、证据审计和效率审计位于 `experiments/final_results/`。实验使用合成数据库，外部网页内容可能随时间变化，因此重新运行外部检索任务时不保证返回完全相同的来源。

## 安全说明

- 数据库工具仅允许只读操作。
- 禁止提交 API Key、访问令牌、真实企业数据和个人敏感信息。
- Python 沙箱不暴露宿主机 Shell 或宿主机路径。
- 系统输出仅用于研究与辅助分析，不应直接触发生产控制、维修工单或高风险业务操作。

发现安全问题时，请不要在公开 Issue 中提交密钥、内部路径或真实生产数据，详见 [SECURITY.md](SECURITY.md)。

## 许可证

- 源代码采用 [MIT License](LICENSE)。
- `data/` 中的合成演示数据采用 [CC BY 4.0](DATA_LICENSE)。
- 外部网页内容及第三方软件仍适用其各自许可证和使用条款。

## 引用

如果本仓库对你的研究有帮助，请引用仓库中的 `CITATION.cff`。论文正式发表后，可在该文件中补充 DOI、期刊和作者信息。

