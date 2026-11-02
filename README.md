# Hiero

个人自用、开源的 Agent 工作台原型。项目以显式状态机、确定性工具网关、渐进式上下文披露和 WebSocket 事件驱动 UI 为核心，当前定位是**可验证的 Agent 编排骨架**，还不是生产级自主编码代理。

## 交接摘要

最近一次已上传到 GitHub 的提交：`c199026`。仓库地址：<https://github.com/baijieO-o/hiero>。

当前已完成并验证：

- TypeScript 后端显式状态机：`Plan → Exec → Verify`，以及 `Handoff`、`Rewind`。
- `TaskContract`、`HandoffDocument`、`ErrorRecord` 等核心契约。
- OpenAI-compatible Model Gateway：令牌池、429 冷却、401 废弃、fallback 基础逻辑。
- Tool Gateway：Zod 参数校验、权限检查、证据记录。
- MCP stdio/SSE/HTTP 客户端和 Skill 渐进式披露路由。远程服务器的 headers 与 env 支持 ${VAR} 占位符，在连接时从环境变量展开，凭据不落盘。WebSocket 服务仅接受本机连接；前端可通过 `VITE_HIERO_WS_URL` 指定运行时地址（默认 `ws://localhost:8080`）。
- 独立 `SystemAgent` 子进程，用于扩展安装流程。
- 工作区文本快照和 `FILE_DIFF` 广播。
- 前端 Mission Control、TodoList、CodeReview、HandoffPanel。
- TodoList 只根据 WebSocket `STATE_CHANGE` 更新，不解析 LLM 文本。
- 自动 Handoff 阈值检查和 `.hiero/handoff.json` 持久化。
- Monaco 动态加载与 Vite `manualChunks` 分包。
- `examples/real-test.ts`：读取本地 API 配置，尝试通过真实模型调用 `write_file`。

## 验证状态

后端测试：

```powershell
npm install
npm test
```

当前已验证结果：`38 passed, 0 failed`。

后端构建：

```powershell
npm run build
```

前端安装和构建：

```powershell
Set-Location frontend
npm install
npm run build
```

前端构建已验证通过，入口代码和 Monaco 已拆分为独立 chunk；当前项目没有安装 Xterm，因此不会生成实际的 Xterm chunk。

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
- MCP 运行时默认 Server 自动发现和严格 JSON Schema → Zod 转换尚未完整闭环。前端 MCP 预设（文件系统、GitHub、Postgres）默认禁用。
- SystemAgent 是独立进程，不等同于安全沙箱；扩展依赖仍可能在宿主机执行。
- 前端各面板尚未统一为单一、带重连的 WebSocket 事件总线。
- 已有全局准则与项目记忆（第 0、1 层，聊天时注入）；第 2 层深层记忆已实现为本地关键词检索（无向量库），完整 Verify（编译/测试/格式化）闭环或自动 Git commit 审批流程。
- 根项目仍缺少真正的生产级权限审批、回退保护和人类修改检测。

## 核心目录

```text
src/
  agent-executor.ts       模型规划、ReAct、上下文预算检查
  agent-workflow.ts       Plan/Exec/Verify/Handoff 编排
  basic-tools.ts          工作区受限 write_file
  capability-router.ts    MCP/Skill 能力发现和渐进披露
  context-manager.ts      Handoff 文档持久化和阈值判断
  contracts.ts            核心接口和结构化错误
  hiero-runtime.ts        运行时组装和 WebSocket 任务入口
  mcp-client.ts           MCP stdio/SSE/HTTP 客户端\n  ws-guard.ts             WebSocket 回环地址和 Origin 校验
  model-gateway.ts        OpenAI-compatible 模型网关
  runtime-server.ts       WebSocket 事件广播
  state-machine.ts        显式状态机
  system_agent.ts         独立系统管家进程
  system-agent-client.ts  主进程与系统管家通信
  tool-gateway.ts         工具注册、校验、权限和证据
  workspace-diff.ts       工作区快照和文件 Diff

frontend/src/
  App.tsx                 工作台面板和运行时事件监听
  style.css               工作台样式
frontend/vite.config.ts   Vite 分包和 Monaco 优化
examples/real-test.ts     真实 API 端到端测试脚本
test/                    后端集成测试
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
