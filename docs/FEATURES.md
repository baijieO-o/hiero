# Hiero 功能说明

本文说明 Hiero 当前已实现的功能、使用方式和限制。内容以代码实际行为为准。错误码与常见原因见界面右上角的「文档」面板。

## 1. 启动与连接

- 后端：在仓库根目录运行 `npm start`，WebSocket 默认监听 `ws://localhost:8080`。
- 前端：在 `frontend` 目录运行 `npm run dev`，默认地址 `http://127.0.0.1:5173`。
- 页面刷新或断线重连后，后端会发送 `SNAPSHOT` 对齐状态。断线期间错过的事件不会回放。
- 如果刷新时正好有回复在生成，重连后会重新挂载到该请求上继续接收。

## 2. 聊天

- **流式输出**：回复按 token 流式显示，生成中显示光标，完成后淡出。
- **块级渲染**：已完成的段落、列表项、代码块按块淡入；未完成的尾部单独渲染，已完成内容不会重排。
- **Markdown**：支持标题、列表、表格、引用和代码块。代码块带语言标签、逐行高亮和复制按钮。
- **图形**：` ```mermaid ` 渲染为流程图等图形，` ```markmap ` 渲染为思维导图。
- **数学公式**：`$...$` 为行内公式，`$$...$$` 为块级公式，使用 KaTeX 渲染。代码块和行内代码中的 `$` 不会被当作公式。公式未闭合时先显示源码。
- **链接与图片**：链接显示为预览卡片；图片加载前显示骨架屏。
- **自动滚动**：生成时跟随底部。用户向上滚动后自动跟随暂停，并出现「回到底部」按钮。
- **长回复保存**：没有调用工具、且超过 4000 字符的回复，会保存到工作区 `.hiero/replies/<时间>-<请求ID>.md`，聊天里只显示摘要和文件路径。
- **停止生成**：生成过程中可以取消当前请求。
- **桌面端内置浏览器**：`npm run desktop`（需先运行后端与前端 dev 服务器）打开 Electron 窗口，内置浏览器使用 `<webview>` 嵌入页面，多数网站可正常显示（普通浏览器模式仍使用 iframe，部分站点会被禁止嵌入）。桌面版还开放 `127.0.0.1:9333` 的 CDP 端口，智能体的 `shared` 模式借此与面板共享同一页面和登录态；面板中的「暂停智能体」可阻止其点击与输入。
- **标准浏览器共享**：不使用桌面版时，可手动启动带 CDP 的外部 Chrome/Edge（`--remote-debugging-port=9333 --user-data-dir=<独立目录>`），后端默认连接 `127.0.0.1:9333`（可用 `HIERO_SHARED_CDP_URL` 修改）。智能体在 `shared` 模式下会自动接管当前共享页面，可以读取用户打开的任何页面（包括 localhost）；但它自己发起的导航仍要经过公网地址校验。
- **标准浏览器共享**：不使用桌面版时，可手动启动带 CDP 的外部 Chrome/Edge（`--remote-debugging-port=9333 --user-data-dir=<独立目录>`），后端默认连接 `127.0.0.1:9333`（可用 `HIERO_SHARED_CDP_URL` 修改）。智能体在 `shared` 模式下会自动接管当前共享页面。该页面需为公网地址，智能体不能访问 localhost 或内网地址。
- **浏览器共享**：内置浏览器点击「分享给智能体」会在输入框上方添加一个可移除的链接标签。发送时后端会抓取该页面正文并附加到用户消息中（最多 3 个页面；仅允许公网 http(s)，不支持 localhost）。跨域 iframe 内容不会直接从界面提取。
- **热插拔（cordis 内核）**：`src/hot-plug.ts` 用 cordis 的 fiber 管理 MCP 服务。通过 WebSocket 发送 `hot_plug_list` 或 `hot_plug_set`（字段 `kind`：`mcp` / `skill` / `tool`，`name`，`enabled`）。后端回复 `HOT_PLUG_RESULT`，载荷含 `servers`、`statuses`、`skills`（`{name,enabled}`）、`tools`（`{name,enabled}`）。`mcp` 会改写 `.hiero/mcp.json` 并立即连接或断开。`skill` 只隐藏，不删除文件。`tool` 只过滤新建对话的内置工具，正在运行的对话不受影响。skill 和 tool 的停用项保存在 `.hiero/hot-plug.json`，重启后保持；mcp 的启停写入 `mcp.json`。前端「技能管理」面板的「MCP 服务器」「技能」「工具」分类都提供开关。
- **智能体浏览器工具**：智能体可以使用独立的 Playwright 浏览器（默认 headed Edge，`visible` 模式，用户可以看到窗口）：`browser_open`、`browser_snapshot`（无障碍树）、`browser_screenshot`（仅返回元数据，模型看不到图片）、`browser_click`、`browser_type`（点击和输入每次需要用户确认）。`headless_extract` 使用无头浏览器提取正文；设置 `HIERO_HEADLESS_CDP_URL` 可接入外部 CDP 引擎（如 Lightpanda，尚未在 Windows 上验证）。该浏览器没有用户登录状态，也不共享用户的 DOM 或 Cookie。子智能体不能使用这些工具。审批弹窗和链接标签尚未在界面中端到端验证。
- **上下文用量**：按约 4 字符一个 token 估算，并非精确值。
- **历史压缩**：历史过长时，把旧消息压缩为摘要。可通过 `HIERO_COMPACT_MODEL` 指定压缩模型，未设置则使用主模型。

## 3. 任务编排

每个任务按状态机运行：`Plan → Exec → Verify`，失败时回滚并可能进入 `Handoff`（交接）。

- **DAG 计划**：运行时默认开启。Planner 输出 JSON 依赖图，无依赖的任务并行执行，并发数由 `maxParallel` 限制。解析或校验失败时回退为线性计划。
- **只读标记**：任务的 `read_only` 由模型自报，只用于调度（只读任务可并行）。它不是安全边界。
- **验收**：任务中的 `cmd:` 验收命令在 Docker 容器中执行，退出码为 0 视为通过。失败时回滚并重新规划，最多重试 2 次；耗尽后进入交接状态，等待人工处理。
- **失败分类**：验收失败会归类为 `timeout`、`env`、`syntax`、`type`、`test` 或 `unknown`，并附带修正指导，随重试提示交给 Planner。
- **报错提取**：`ErrorParser` 从输出中提取核心报错行，支持 TypeScript、Python Traceback、Rust、GCC/Clang。无法识别时按头尾截断。
- **保护机制**：同一工具和参数连续调用 3 次会熔断（MOD-005）；超过任务时间预算会自动停止（MOD-006）。
- **交接文档**：上下文超过阈值时写入 `.hiero/handoff.json`。
- **回归记录**：失败的验收命令追加到 `.hiero/regressions.jsonl`。

## 4. 内置工具

| 工具 | 作用 |
| --- | --- |
| `read_file` | 读取工作区文件 |
| `list_dir` | 列出目录 |
| `write_file` | 写入文件，写入前记录快照，可回滚 |
| `web_search` | 联网搜索，返回若干结果 |
| `web_fetch` | 抓取网页正文，拒绝访问内网和回环地址 |
| `memory_recall` | 检索记忆 |
| `memory_remember` | 保存记忆 |
| `memory_append` | 向已有记忆追加内容 |
| `load_skill` | 读取技能的完整 `SKILL.md` |
| `delegate_read` / `delegate_write` / `delegate_task` | 派生子代理（见第 8 节） |

### 联网搜索

- 设置 `HIERO_BRAVE_API_KEY` 后使用 Brave Search API。
- 未设置时回退到 DuckDuckGo 的 HTML 接口。该接口经常返回人机验证页面，此时报 GOV-003，建议改用 `web_fetch` 或配置 Brave 密钥。
- 密钥只放在请求头中，不返回给模型或界面。

## 5. 权限模式

在聊天输入区切换，共三档：

- **严格**：不执行终端命令；写入和不可逆操作需要确认。
- **标准**（默认）：只允许只读命令（如 `ls`、`cat`、`git status/log/diff`）。不允许管道、重定向、命令拼接，也不允许指向工作区外的路径参数。
- **自动**：不做命令限制，只适合可信环境。

规则见 [permission-policy.ts](../src/permission-policy.ts)。

## 6. 终端与沙箱

- 终端命令和 `cmd:` 验收命令在 Docker 中执行。
- 容器挂载工作区到 `/workspace`，禁用网络，根文件系统只读，并限制资源。
- 首次运行会拉取 `node:22-alpine`。
- Docker 不可用时命令直接失败，不会回退到宿主机执行。
- 这不是完整安全沙箱：它只覆盖终端和验收命令，不覆盖整个 Agent 进程。

## 7. 技能（Skills）

技能是包含 `SKILL.md` 的目录，frontmatter 需要 `name` 和 `description`。

扫描位置（同名时靠前的优先）：

1. 项目：`<工作区>/.agent/skills/`
2. 用户：`~/.copilot/skills/`
3. 通用：`~/.agents/skills/`
4. Codex：`~/.codex/skills/`

每次请求都会重新扫描。系统提示里只放每个技能的 `name` 和 `description`。模型判断需要某个技能时，调用 `load_skill` 读取完整内容后再执行。

技能的保存和删除需要审批（`skill_save`、`skill_delete`）。

## 8. 子代理

- `delegate_read`：只读调研。
- `delegate_write`：可编辑文件的任务，写入需审批。
- `delegate_task`：通用任务，可使用外部工具。子代理不能再次委派。
- 限制：每轮最多 `maxConcurrent` 个，每次聊天最多 `maxPerChat` 个，超出的调用会被拒绝并提示模型直接回答。

## 9. MCP

- 配置文件为工作区的 `.hiero/mcp.json`，每个服务器需要唯一的 `name`。
- 配置中的 `${NAME}` 在连接时从运行环境展开，因此密钥不必写入文件；变量未设置会报错。
- 配置无效时后端会忽略 MCP 并打印警告，不影响其他功能。

## 10. 记忆

- **全局记忆**：跨项目保存。
- **项目记忆**：只对当前工作区生效。
- **深层记忆**：未配置 embedding 时只做关键词检索。

## 11. 文件与编辑

- 文件管理器可浏览工作区。编辑器按需加载，保存时写入工作区。
- 目录先列文件夹，再按数字感知顺序排列（`file2` 排在 `file10` 前）。
- 键盘：方向键移动选择，Home/End 跳到首尾，PageUp/PageDown 按 10 行翻页，Enter 打开，Backspace 返回上级。进入或返回目录后焦点保留在列表上。
- 预览：二进制文件（前 8000 字节含 NUL 字节）不显示乱码，只提示文件大小。文本预览上限 200 KB。
- 模型通过 `write_file` 写入的内容会记录快照。本次会话内可回滚；如果文件之后被人工修改，回滚会跳过该文件并给出 RBK-006 警告。快照只保存在内存中，重启后失效。

## 12. 模型配置

Hiero 使用 OpenAI Chat Completions 兼容协议，可连接 Ollama、vLLM 等服务。模型需要支持 function calling。

配置优先级从高到低：环境变量 → 工作区 `.hiero/config.json` → 用户 `~/.hiero/config.json`。

| 变量 | 说明 |
| --- | --- |
| `HIERO_LLM_ENDPOINT` | 兼容接口地址，如 `http://localhost:11434/v1/chat/completions` |
| `HIERO_LLM_MODEL` | 模型名 |
| `HIERO_LLM_TOKENS` | 访问令牌，多个用逗号分隔；本地服务可留空 |
| `HIERO_LLM_PROVIDERS` | 可选，多供应商多 key：JSON 数组，每项含 `name`、`endpoint`、`tokens`、`models`；按模型名路由，未匹配的模型使用默认端点和 `HIERO_LLM_TOKENS` |
| `HIERO_LLM_TASK_MODELS` | 可选，按任务类型指定模型（chat / planning / execution / subagent / compaction），JSON 对象；也可在设置面板修改 |
| `HIERO_LLM_MAX_TOKENS` | 单次回复的最大 token 数 |
| `HIERO_COMPACT_MODEL` | 历史压缩使用的模型，未设置则使用主模型 |
| `HIERO_BRAVE_API_KEY` | 可选，启用 Brave Search；未设置时使用 DuckDuckGo |
| `HIERO_STEP_VERIFY` | 可选，设为 `1` 后每个写入步骤之后都执行验收 |
| `HIERO_HITL_TOOLS` | 可选，逗号分隔的工具名，调用前需要人工审批 |
| `HIERO_LOG_FILE` | 可选，遥测日志文件路径 |
| `HIERO_EMBED_ENDPOINT` / `HIERO_EMBED_MODEL` / `HIERO_EMBED_TOKENS` | 可选，启用深层记忆的向量检索 |
| `HIERO_UI_PORT` | 可选，前端端口，默认 5173 |
| `HIERO_UPDATE_CHECK` | 设为 `0` 可关闭启动时的版本检查 |

不要把真实密钥提交到仓库。完整模板见 [.env.example](../.env.example)，本地配置可参考 `hiero-llm.local.example.ps1`。`.env` 与 `hiero-llm.local.ps1` 已加入 `.gitignore`。

## 13. 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+Space` | 打开空缓存窗口 |
| `Ctrl+Shift+Y` | 新建对话 |
| `Ctrl+Shift+L` | 聚焦对话输入框 |
| `Ctrl+Shift+P` | 聚焦命令栏 |
| `Ctrl+Shift+E` | 显示/隐藏快捷栏 |
| `Ctrl+Shift+,` | 打开设置 |
| `Ctrl+Shift+U` | 打开文档 |

Mac 上可用 `Cmd` 代替 `Ctrl`。避开了浏览器保留的组合键（如 `Ctrl+Shift+N`、`Ctrl+Shift+B`、`Ctrl+Shift+D`）。

## 13.1 主题

在设置中可以调整外观，所有配置保存在本地浏览器（`localStorage` 的 `hiero-preferences`）。

- **内置预设**：默认深色、默认浅色、Nord、Solarized 深色、高对比度。
- **自定义配色**：逐项修改页面背景、文字等 CSS 变量，每项可单独还原。
- **导入 / 导出**：导出为 `hiero-theme.json`，导入时校验文件格式，无效文件会提示错误。
- **自定义 CSS**：直接输入样式规则，清空后即移除。

## 14. 已知限制

- **不是完整的安全沙箱**：Docker 只覆盖终端和 `cmd:` 验收命令，不覆盖整个 Agent。SystemAgent 扩展依赖仍可能在宿主机执行。
- **Docker 沙箱未在真实环境端到端验证**：挂载与容器限制由单元测试检查参数。
- **写入安全**：`write_file` 与 `edit_file` 限制在工作区内并拒绝绝对路径，但没有显式的符号链接逃逸防护。写入同名文件会覆盖原内容。Rewind 快照是全局回滚，不能只回滚单个文件。快照只在内存中，重启后失效。
- **断点恢复**：基于工具调用级别的检查点，不是整个会话的快照。
- **对话检查点（聊天界面）**：每条用户消息旁有两个独立按钮。「还原检查点」删除该消息及之后的内容（原地截断）；「派生对话」复制该消息之前的历史到一个新的分支对话（标题后缀「（分支）」），原对话保持不变，可在列表中切换。运行中两个按钮都禁用。
- **对话多选与置顶（侧栏）**：点击「多选」进入多选模式，可勾选多段对话后批量「置顶」或「删除」（删除需二次确认）。单条对话也可用 📌 按钮或右键菜单「置顶/取消置顶」；置顶对话按置顶顺序排在列表最前。正在运行的对话不可被选中删除。
- **事件总线**：断线期间错过的事件不回放，重连后只靠 `SNAPSHOT` 对齐当前状态。
- **`read_only` 标记**：由模型自报，只用于调度分组，不具备安全效力。
- **代码搜索**：`symbol_search` 是正则实现，没有类型解析，也没有全库索引。
- **Token 计量**：按字符数估算（约 4 字符/token），不是模型专用的 tokenizer。
- **工具结果截断**：单次工具结果超过 8,000 字符时保留头部 70% 和尾部 30%，中间部分丢弃。对任务成功率的影响尚未用真实模型验证。
- **历史压缩**：压缩摘要保留首条用户消息原文作为锚点，以及未完成的待办和精确路径。压缩模型的摘要质量未用真实模型逐项验证。
- **深层记忆**：未配置 `HIERO_EMBED_*` 时只支持关键词检索。
- **MCP**：服务器自动发现和严格的 JSON Schema → Zod 转换尚未完整闭环。
- **错误码文档**为手工整理的静态内容，错误码变化时需同步更新。
- 本文未在真实模型上逐项验证。

## 15. 验证状态

- 技能的 `load_skill` 路径有单元测试覆盖，未在真实模型上端到端验证。
- 文档面板已在浏览器中打开检查。其他面板的界面未逐一复核。
