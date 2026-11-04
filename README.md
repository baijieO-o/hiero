# Hiero

个人自用、开源的 Agent 工作台原型。项目以显式状态机、确定性工具网关、渐进式上下文披露和 WebSocket 事件驱动 UI 为核心，当前定位是**可验证的 Agent 编排骨架**，还不是生产级自主编码代理。

## 功能概览

Hiero 是一个个人自用、开源的 Agent 工作台。后端使用显式状态机驱动任务执行，前端提供多窗口工作台，并通过 WebSocket 实时同步状态。

### 任务编排（Agent 核心）

- **显式状态机**：`Plan → Exec → Verify`，并支持 `Handoff`（交接）与 `Rewind`（回滚）。
- **Verify 闭环**：任务的 `cmd:` 验收标准在 Docker 沙箱中执行，退出码为 0 即通过。失败或 Exec 出错时回滚并重新规划，最多重试 2 次，耗尽后交接给人工。严格模式下拒绝执行 `cmd:` 验收命令。
- **DAG 任务编排**（默认开启，`useDagPlan`）：Planner 可输出 JSON 格式的任务依赖图，无依赖的任务并行执行（`maxParallel` 限制并发数）。解析或校验失败时自动回退为线性计划。
- **自我纠错**：Verify 失败时，`ErrorParser` 先提取核心报错行（支持 TypeScript、Python Traceback、Rust、GCC/Clang，其他输出按头尾截断），再作为上一次失败原因注入重新规划的提示，而不是让模型盲猜。
- **执行保护**：同一工具、同一参数连续调用 3 次触发熔断（MOD-005）；超过任务时间预算自动停止（MOD-006）。
- **自动交接**：超过上下文阈值时保存 `.hiero/handoff.json`，进入 Handoff 状态。

### 模型与上下文

- **OpenAI 兼容模型网关**：令牌池、429 冷却、401 废弃、fallback。可连接 Ollama、vLLM 或任何兼容 Chat Completions 的服务，本地模型无需 API 密钥。
- **上下文压缩**：超过阈值时把较早的历史总结为摘要，保留最近原文。可设置 `HIERO_COMPACT_MODEL` 指定便宜或本地的小模型做总结，未设置时使用主模型。聊天界面支持 `/compact` 手动压缩，并显示上下文窗口用量。
- **令牌用量与成本**：每次回复显示模型调用次数、输入/输出 tokens、耗时和估算成本（按 USD 计价后以 7.2 换算为 CNY）。价格取自 LiteLLM 公共价格表，失败时回退到内置价格表。
- **子代理**：聊天中可委派只读子任务（`delegate_read`）或带审批的写入子任务（`delegate_write`）。子代理的工具白名单由代码强制，最多 4 轮，结果截断到 4000 字符以内。
- **执行时间线**：每次聊天请求记录模型调用、工具调用、子代理调用和错误，可在消息下折叠查看，并持久化到工作区 `.hiero/traces.jsonl`。

### 工具、权限与安全

- **Tool Gateway**：Zod 参数校验、权限检查、证据记录。
- **联网工具**：内置 `web_search`（Brave Search API，需设置环境变量 `HIERO_BRAVE_API_KEY`，未设置时返回明确错误）和 `web_fetch`（抓取网页并转为纯文本）。两者均需审批；仅主代理可用，子代理无法联网。`web_fetch` 会拒绝内网、回环和链路本地地址，并逐跳校验重定向。已知限制：DNS 校验与实际请求之间存在 DNS rebinding 空窗，尚未做 IP 固定。
- **权限模式**：`strict`（严格，不执行终端命令）、`standard`（标准，只允许只读命令，禁止管道、重定向和工作区外路径）、`auto`（自动，不做命令限制）。外部动作需审批，审批通过统一的审批弹窗处理。
- **文件操作**：工作区受限的 `read_file`、`list_dir`、`write_file`。路径必须位于工作区内，拒绝绝对路径。写入前保存快照，并检测人工修改。
- **终端沙箱**：命令通过 Docker 容器执行，工作区只读挂载，禁用网络，容器根文件系统只读，并施加 CPU、内存、PID 限制。Docker 不可用时失败关闭，不回退到宿主机。
- **WebSocket 安全**：仅接受本机回环地址连接；浏览器 Origin 必须是 localhost / 127.0.0.1 / [::1]。
- **记忆**：第 0、1 层为全局准则与项目记忆，聊天时注入；第 0 层只在用户明确要求时写入。第 2 层为本地 JSONL 深层记忆，检索支持关键词，配置 `HIERO_EMBED_*` 后可启用向量检索。

### 扩展

- **MCP 客户端**：支持 stdio、SSE、HTTP 传输。远程服务的 headers 与 env 支持 `${VAR}` 占位符，在连接时从环境变量展开，凭据不落盘。首次运行时会写入一个默认的文件系统 MCP 服务器（范围限定在工作区根目录），可在配置中编辑或删除。前端添加的新服务器默认为禁用状态，需手动启用。
- **Skill 渐进式披露**：能力路由按需暴露 Skill 与 MCP 工具，避免一次性塞入全部定义。Skill 的保存与删除需要审批。
- **独立 SystemAgent 子进程**：用于扩展安装流程，与主进程通过消息通信。

### 前端工作台

- React + Vite 网页版，基于 dockview 的多面板布局，支持多工作区（聊天、任务、文件管理器、终端共用工作区）。
- **聊天**：Markdown 渲染（含 Mermaid 图与 Markmap 思维导图）、图片与文件引用、停止生成、会话压缩、执行时间线。
- **任务面板**：TodoList、CodeReview（展示 `FILE_DIFF`）、HandoffPanel，状态只根据后端 `STATE_CHANGE` 更新，不解析 LLM 文本。
- **文件管理器与代码编辑**：Monaco 编辑器按需加载。
- **终端**：基于 xterm.js，经由 Docker 沙箱执行。
- **设置面板**：模型与令牌、权限模式、子代理、MCP、外观（渐变、模糊、动画、滚动条、热边侧栏）等。
- **统一事件总线**：后端广播带单调递增的 `seq`，新连接先收到 `SNAPSHOT`；前端通过共享的带重连 `RuntimeSocket`（`frontend/src/runtime-socket.ts`）订阅。

### 已知限制

- 事件总线断线期间错过的事件不会回放；重连后只用 SNAPSHOT 重新对齐当前节点。
- DAG 编排默认开启（解析失败回退线性）；任务的 `read_only` 标记由模型自报，只用于分组调度（只读任务可并行，写入任务串行），不是安全边界。
- 本项目不是完整安全沙箱：Docker 只用于终端命令和 `cmd:` 验收命令，不覆盖整个 Agent；SystemAgent 扩展依赖仍可能在宿主机执行。
- 聊天界面的上下文用量为按约 4 字符/token 的估算，不是模型专用 tokenizer。
- 深层记忆在未配置 embedding 时仅支持关键词检索。

### 验证状态

```powershell
npm install
npm test        # 编译后运行 148 项后端测试
```

前端：

```powershell
Set-Location frontend
npm install
npm run build   # 类型检查 + Vite 构建，入口与 Monaco 已分包
```

## 启动 Hiero

后端默认监听 `ws://localhost:8080`：

```powershell
Set-Location C:\path\to\hiero
. .\hiero-llm.local.ps1
npm start
```

前端开发服务器默认监听 `http://localhost:5173`：

```powershell
Set-Location C:\path\to\hiero\frontend
npm run dev
```

也可以使用仓库中的 Windows 启动脚本，但请先确认本地配置文件已经正确设置。

终端命令通过 Docker 容器执行；请先安装并启动 Docker。容器将工作区挂载到 `/workspace`，禁用网络、使用只读根文件系统并施加 CPU/内存/PID 限制。首次执行会拉取 `node:22-alpine`。若 Docker 不可用，命令会失败关闭，不会在宿主机执行。


Hiero 的模型网关使用 OpenAI Chat Completions 兼容协议，可连接本机 Ollama 或 vLLM，无需云端 API 密钥。Agent 工具调用需要模型本身支持 function calling。

Ollama 示例（先运行 `ollama pull qwen3:8b`）：

```dotenv
HIERO_LLM_ENDPOINT=http://localhost:11434/v1/chat/completions
HIERO_LLM_MODEL=qwen3:8b
HIERO_LLM_TOKENS=
```

也可将模型替换为 Ollama 已拉取且支持工具调用的 Llama 模型，例如 `llama3.1:8b`。

vLLM 示例（以兼容 API 启动）：

```powershell
vllm serve Qwen/Qwen2.5-7B-Instruct --host 0.0.0.0 --port 8000
```

```dotenv
HIERO_LLM_ENDPOINT=http://localhost:8000/v1/chat/completions
HIERO_LLM_MODEL=Qwen/Qwen2.5-7B-Instruct
HIERO_LLM_TOKENS=
```

如果 vLLM 启用了 API key，将 `HIERO_LLM_TOKENS` 设为相应密钥。设置面板也可填写这些字段。复制下方 `.env` 模板后按需取消注释本地配置。

## LLM 配置

不要提交真实密钥。可复制模板：

```powershell
Copy-Item .\hiero-llm.local.example.ps1 .\hiero-llm.local.ps1
notepad .\hiero-llm.local.ps1
. .\hiero-llm.local.ps1
```

普通 CMD 不支持 `Copy-Item`，请使用：

```cmd
copy hiero-llm.local.example.ps1 hiero-llm.local.ps1
notepad hiero-llm.local.ps1
```

模板使用以下变量：

```powershell
$env:HIERO_LLM_ENDPOINT = "https://兼容服务/v1/chat/completions"
$env:HIERO_LLM_MODEL = "你的模型名"
$env:HIERO_LLM_TOKENS = "你的令牌"
```

## Step 10 真实测试

`examples/real-test.ts` 不包含密钥，从以下变量读取配置：

- `LLM_BASE_URL`
- `LLM_API_KEY`
- 可选：`LLM_MODEL`

先编译：

```powershell
Set-Location C:\path\to\hiero
npm run build
```

在**专用临时目录**中运行，避免覆盖重要文件。该脚本使用 `permission_mode: auto`，检查模型写入后的 `hello.txt` 内容是否恰好为 `Hello Hiero`，并广播 `FILE_DIFF`：

```powershell
$env:LLM_BASE_URL = "https://兼容服务/v1"
$env:LLM_API_KEY = "不要把密钥写入仓库"
$env:LLM_MODEL = "你的模型名"
node .\dist\examples\real-test.js
```

脚本会连接本地 `ws://localhost:8080`。前端应在脚本广播事件前打开并连接；不要同时启动另一个占用 8080 端口的后端。

## 安全边界与已知限制

当前 `write_file` 工具：

- 拒绝绝对路径。
- 解析后要求目标位于配置工作区内。
- 通过 Zod 校验 `path` 和 `content`。
- 被标记为不可逆操作，标准/严格权限模式不会自动执行。
- 真实测试脚本进一步把模型工具 Schema 限制为 `hello.txt` 和 `Hello Hiero`。

这仍然**不是完整安全沙箱**：当前没有 Docker/VM 级隔离，也没有显式的符号链接逃逸防护；写入同名文件可能覆盖原内容。请只在临时工作区进行真实测试。

其他已知限制：

- 自动 Handoff 会保存文档并进入 Handoff，但尚未自动创建新上下文无缝续跑。
- Token 计量目前是字符数近似值，不是模型专用 tokenizer。
- MCP 运行时默认 Server 自动发现和严格 JSON Schema → Zod 转换尚未完整闭环。
- SystemAgent 是独立进程，不等同于安全沙箱；扩展依赖仍可能在宿主机执行。
- 事件总线断线期间错过的事件不会回放；重连后仅通过 SNAPSHOT 重新对齐当前节点。聊天、设置、审批等请求/响应流仍使用各自的连接。
- 已有全局准则与项目记忆（第 0、1 层，聊天时注入）；第 2 层深层记忆为本地 JSONL，检索为关键词 + 可选向量（配置 `HIERO_EMBED_*` 后启用，未配置时仅关键词）。
- 根项目仍缺少真正的生产级权限审批、回退保护和人类修改检测。

## 核心目录

```text
src/
  agent-executor.ts       模型规划、ReAct、执行保护（MOD-005/006）
  agent-workflow.ts       Plan/Exec/Verify/Handoff 编排，线性与 DAG 执行
  plan-dag.ts             DAG 计划解析、校验、分层调度
  error-parser.ts         Verify 失败输出解析（TS/Python/Rust/GCC/Clang）
  verification.ts         cmd: 验收标准（Docker 中执行）
  approval-broker.ts      外部动作审批
  permission-policy.ts    strict/standard/auto 命令策略
  basic-tools.ts          工作区受限的 read_file / list_dir / write_file
  read-only-subagent.ts   delegate_read / delegate_write 子代理
  capability-router.ts    MCP/Skill 能力发现和渐进披露
  mcp-client.ts           MCP stdio/SSE/HTTP 客户端
  mcp-config.ts           MCP 服务器配置与预设
  skill-store.ts          Skill 读写
  context-manager.ts      Handoff 文档持久化和阈值判断
  context-compactor.ts    历史总结压缩
  context-usage.ts        上下文窗口用量估算
  deep-memory.ts          第 2 层深层记忆（JSONL）
  memory-store.ts         第 0/1 层记忆
  embedding.ts            可选向量检索（HIERO_EMBED_*）
  trace-store.ts          执行时间线持久化
  chat-trace.ts           聊天执行时间线
  write-snapshots.ts      写入快照与人工修改检测
  workspace-diff.ts       工作区快照和文件 Diff
  workspace-services.ts   文件管理与终端服务
  state-store.ts          持久化状态
  contracts.ts            核心接口和结构化错误
  hiero-runtime.ts        运行时组装和 WebSocket 任务入口
  model-gateway.ts        OpenAI-compatible 模型网关
  runtime-server.ts       WebSocket 事件广播（seq + SNAPSHOT）
  ws-guard.ts             WebSocket 回环地址和 Origin 校验
  state-machine.ts        显式状态机
  tool-gateway.ts         工具注册、校验、权限和证据
  system_agent.ts         独立系统管家进程
  system-agent-client.ts  主进程与系统管家通信

frontend/src/
  App.tsx                 工作台面板和运行时事件监听
  runtime-socket.ts       共享的带重连 WebSocket 订阅
  settings.tsx            设置面板
  mcp-model.ts            MCP 管理界面模型
  token-cost.ts           令牌成本估算（LiteLLM 价格表）
  compaction.ts           压缩相关的前端逻辑
  devtools.ts             运行时日志
  terminal-view.tsx       终端（xterm.js）
  style.css               工作台样式
frontend/vite.config.ts   Vite 分包和 Monaco 优化
examples/real-test.ts     真实 API 端到端测试脚本
test/                     后端测试（148 项）
```

## 换设备

```powershell
git clone https://github.com/baijieO-o/hiero.git
Set-Location hiero
npm install
Set-Location frontend
npm install
Set-Location ..
npm test
```

然后重新创建本机的 `hiero-llm.local.ps1` 或 `.env`。真实密钥不会存放在 GitHub 仓库中。
