# Hiero

Hiero 是一个个人自用、开源的 Agent 工作台。它用显式状态机驱动任务执行，用确定性的工具网关记录证据，并通过 WebSocket 把状态实时同步到网页界面。当前定位是**可验证的 Agent 编排骨架**，还不是生产级自主编码代理。

完整功能说明见 [docs/FEATURES.md](docs/FEATURES.md)，架构见 [ARCHITECTURE.md](ARCHITECTURE.md)，二次开发（添加工具、扩展点）见 [docs/DEVELOPING.md](docs/DEVELOPING.md)。

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

### 检查与更新版本

启动后，界面顶部会在发现 GitHub 仓库有新版本标签时显示提示；也可以在「设置 → 版本更新」中手动点击「检查更新」。

- 检查方式：通过 `git ls-remote --tags` 读取远程 `v*` 标签，需要本机安装 git。
- 仅提示，不会自动修改代码。更新时在项目目录执行：

```powershell
git pull
npm install
npm run build
```

- 设置环境变量 `HIERO_UPDATE_CHECK=0` 可关闭启动时的自动检查。

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

全部环境变量及其说明见 [docs/FEATURES.md 第 12 节](docs/FEATURES.md#12-模型配置)，这里不再重复。

## 项目结构

```text
src/             后端：状态机、Agent 执行器、工具网关、模型网关、运行时
frontend/src/    前端：React + Vite 工作台、设置面板、终端、运行时事件
test/            后端测试
examples/        示例：real-test.ts（真实 API 调用，需自行配置模型）、custom-tool/（自定义工具示例）
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

当前共有 59 个测试文件、256 个后端测试用例。并行运行偶尔会出现不稳定的失败，建议串行运行：

```powershell
node --test --test-concurrency=1 dist/test/*.test.js
```

前端的类型检查与构建：

```powershell
Set-Location frontend
npm run build
```

## 已知限制

完整列表见 [docs/FEATURES.md 第 14 节](docs/FEATURES.md#14-已知限制)。最需要注意的是：Docker 沙箱只覆盖终端和 `cmd:` 验收命令，不是完整安全沙箱。

## 贡献

欢迎通过 [GitHub Issues](https://github.com/baijieO-o/hiero/issues) 提交问题或建议。

## 许可证

本项目基于 [MIT License](LICENSE) 发布。

版权所有 © 2026 baijie（白皆）。

## 联系方式

- GitHub Issues：<https://github.com/baijieO-o/hiero/issues>
- 邮箱：baijie190801@163.com
