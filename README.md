# Hiero

Hiero 是一个个人自用、开源的 Agent 工作台。它用显式状态机驱动任务执行，用确定性的工具网关记录证据，并通过 WebSocket 把状态实时同步到网页界面。当前定位是**可验证的 Agent 编排骨架**，还不是生产级自主编码代理。

完整功能说明见 [docs/FEATURES.md](docs/FEATURES.md)，架构见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 功能特性

- **显式状态机与可验证执行**：任务按 `Plan → Exec → Verify` 推进，支持 Handoff（交接）与 Rewind（回滚）。`cmd:` 验收标准在 Docker 沙箱中执行，退出码为 0 才算通过。
- **断点恢复**：每次工具调用完成后写入检查点，任务中断后重跑时，已完成的调用直接从证据重放，不会重复执行。
- **DAG 任务编排**：Planner 可输出依赖图，无依赖的任务并行执行；解析或校验失败时自动回退为线性计划。
- **上下文管理**：超过阈值时把较早历史压缩为摘要，保留最近 6 条原文；聊天中可用 `/compact` 手动压缩。
- **人工审批（HITL）**：通过 `HIERO_HITL_TOOLS` 指定的工具在每次调用前暂停，等待你确认。
- **精确编辑与回滚**：`edit_file` 做唯一匹配的字符串替换；写入前保存快照（持久化到 `~/.hiero/write-snapshots.json`），并能检测人工修改。
- **代码符号搜索**：只读的 `symbol_search` 基于正则扫描 TypeScript、JavaScript、Python 的符号定义。
- **安全边界**：模型网关支持令牌池与 fallback；`strict` / `standard` / `auto` 三种权限模式；终端命令在禁网、只读根文件系统的 Docker 容器中执行，Docker 不可用时失败关闭。

## 环境要求

- Node.js 22 或更高版本
- npm
- Docker（终端命令与 `cmd:` 验收需要；未安装时这些功能会失败关闭）
- 一个兼容 OpenAI Chat Completions 的模型服务（云端服务、Ollama 或 vLLM），并且模型支持 function calling

> 本项目主要在 Windows + PowerShell 下开发和使用，命令示例以 PowerShell 为准。

## 安装

```powershell
git clone https://github.com/baijieO-o/hiero.git
Set-Location hiero
npm install
Set-Location frontend
npm install
```

## 快速开始

1. 配置模型（见下方[配置](#配置)）。
2. 启动后端和前端：

   ```powershell
   . .\hiero-llm.local.ps1
   npm start
   ```

   后端默认监听 `ws://localhost:8080`。

3. 另开一个终端启动前端开发服务器：

   ```powershell
   Set-Location frontend
   npm run dev
   ```

   然后在浏览器打开 `http://localhost:5173`。

Windows 用户也可以双击仓库根目录的 `launch-hiero.bat`，它会同时启动后端和前端。启动前请确认本地配置已正确设置。

## 配置

Hiero 按以下顺序合并配置，优先级从高到低：

1. 环境变量
2. 工作区配置 `.hiero/config.json`
3. 用户配置 `~/.hiero/config.json`

### 模型配置

不要把真实密钥提交到仓库。可以从模板创建本地配置：

```powershell
Copy-Item .\hiero-llm.local.example.ps1 .\hiero-llm.local.ps1
notepad .\hiero-llm.local.ps1
```

普通 CMD 请使用 `copy` 和 `notepad`。模板内容如下：

```powershell
$env:HIERO_LLM_ENDPOINT = "https://你的兼容服务/v1/chat/completions"
$env:HIERO_LLM_MODEL = "你的模型名"
$env:HIERO_LLM_TOKENS = "你的令牌"
```

### Ollama / vLLM 本地模型

Ollama（先执行 `ollama pull qwen3:8b`）：

```dotenv
HIERO_LLM_ENDPOINT=http://localhost:11434/v1/chat/completions
HIERO_LLM_MODEL=qwen3:8b
HIERO_LLM_TOKENS=
```

vLLM（以兼容 API 启动）：

```powershell
vllm serve Qwen/Qwen2.5-7B-Instruct --host 0.0.0.0 --port 8000
```

```dotenv
HIERO_LLM_ENDPOINT=http://localhost:8000/v1/chat/completions
HIERO_LLM_MODEL=Qwen/Qwen2.5-7B-Instruct
HIERO_LLM_TOKENS=EMPTY
```

如果 vLLM 启用了 API key，把 `HIERO_LLM_TOKENS` 设为对应密钥。设置面板也可以填写这些字段。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `HIERO_LLM_ENDPOINT` | 模型服务的 Chat Completions 地址 |
| `HIERO_LLM_MODEL` | 模型名 |
| `HIERO_LLM_TOKENS` | 令牌，多个令牌用逗号分隔 |
| `HIERO_LLM_MAX_TOKENS` | 可选，单次回复的最大输出 token 数 |
| `HIERO_COMPACT_MODEL` | 可选，用于压缩总结的模型，未设置时使用主模型 |
| `HIERO_BRAVE_API_KEY` | 可选，启用 Brave Search；未设置时使用 DuckDuckGo |
| `HIERO_STEP_VERIFY` | 可选，设为 `1` 后每个写入步骤之后都执行验收 |
| `HIERO_HITL_TOOLS` | 可选，逗号分隔的工具名，调用前需要人工审批 |
| `HIERO_LOG_FILE` | 可选，遥测日志文件路径 |
| `HIERO_EMBED_ENDPOINT` / `HIERO_EMBED_MODEL` / `HIERO_EMBED_TOKENS` | 可选，启用深层记忆的向量检索 |
| `HIERO_UI_PORT` | 可选，前端端口，默认 5173 |

完整模板见 [.env.example](.env.example)。`.env` 与 `hiero-llm.local.ps1` 已加入 `.gitignore`。

## 项目结构

```text
src/             后端：状态机、Agent 执行器、工具网关、模型网关、运行时
frontend/src/    前端：React + Vite 工作台、设置面板、终端、运行时事件
test/            后端测试
examples/        真实 API 测试脚本（需要自行提供模型配置）
docs/            功能说明
```

各模块的职责说明见 [ARCHITECTURE.md](ARCHITECTURE.md) 和 [docs/FEATURES.md](docs/FEATURES.md)。

## 开发指南

编译后端：

```powershell
npm run build
```

构建前端：

```powershell
npm run build:frontend
```

## 测试

```powershell
npm test
```

当前共有 224 项后端测试。并行运行偶尔会出现不稳定的失败，建议串行运行：

```powershell
node --test --test-concurrency=1 dist/test/*.test.js
```

前端的类型检查与构建：

```powershell
Set-Location frontend
npm run build
```

## 已知限制

- **不是完整的安全沙箱**：Docker 只用于终端命令和 `cmd:` 验收命令，不覆盖整个 Agent。SystemAgent 扩展依赖仍可能在宿主机执行。
- **Docker 沙箱未在真实环境验证**：挂载与容器限制由单元测试检查参数，尚未在真实容器中端到端运行。
- **写入安全**：`write_file` 与 `edit_file` 都限制在工作区内，并拒绝绝对路径，但没有显式的符号链接逃逸防护。写入同名文件会覆盖原内容。Rewind 的快照是全局回滚，不能只回滚单个文件。
- **断点恢复**：基于工具调用级别的检查点，不是整个会话的快照。
- **事件总线**：断线期间错过的事件不会回放，重连后只通过 SNAPSHOT 重新对齐当前状态。
- **DAG 的只读标记**：任务的 `read_only` 由模型自报，只用于调度分组，不是安全边界。
- **代码搜索**：`symbol_search` 是正则实现，没有类型解析，也没有全库索引。
- **Token 计量**：按字符数估算（约 4 字符/token），不是模型专用的 tokenizer。
- **深层记忆**：未配置 `HIERO_EMBED_*` 时只支持关键词检索。
- **MCP**：服务器自动发现和严格的 JSON Schema → Zod 转换尚未完整闭环。

## 贡献

欢迎通过 [GitHub Issues](https://github.com/baijieO-o/hiero/issues) 提交问题或建议。

## 许可证

本项目基于 [MIT License](LICENSE) 发布。

版权所有 © 2026 baijie（白皆）。

## 联系方式

- GitHub Issues：<https://github.com/baijieO-o/hiero/issues>
- 邮箱：baijie190801@163.com
