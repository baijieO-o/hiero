export type ErrorDocLevel = 'blocker' | 'degradation' | 'warning';

export interface ErrorDocRow {
  code: string;
  level: ErrorDocLevel;
  message: string;
  causes: string;
  suggestion: string;
}

export interface ErrorDocGroup {
  group: string;
  rows: ErrorDocRow[];
}

export const ERROR_DOCS: ErrorDocGroup[] = [
  { group: 'MOD · 模型调用', rows: [
    { code: 'MOD-001', level: 'blocker', message: '当前请求没有可用模型。', causes: '未配置首选模型或回退链，或所有模型通道都不可用。', suggestion: '检查模型配置、令牌健康状况与回退通道。' },
    { code: 'MOD-002', level: 'blocker', message: '模型通道失败且无可恢复回退。', causes: '未设置 HIERO_LLM_ENDPOINT，或端点不可达。', suggestion: '检查 HIERO_LLM_ENDPOINT 与传输层及回退配置。' },
    { code: 'MOD-003', level: 'blocker', message: '令牌池为空，或所有令牌被拒绝（401）。', causes: 'HIERO_LLM_TOKENS 未配置或已失效。', suggestion: '替换 HIERO_LLM_TOKENS 中失效的令牌，或使用无需认证的本地模型。' },
    { code: 'MOD-003', level: 'degradation', message: '当前没有可用的模型令牌，正在冷却等待。', causes: '令牌进入冷却期，最近的请求持续失败。', suggestion: '等待冷却结束，检查端点，或配置其他令牌。' },
    { code: 'MOD-004', level: 'blocker', message: '模型响应格式无效，或工具调用参数无法解析。', causes: '服务商返回的 JSON 结构不符合预期，或模型生成的工具参数不是合法 JSON。', suggestion: '检查服务商的响应结构；必要时换用更稳定的模型。' },
    { code: 'MOD-005', level: 'blocker', message: '同一工具以相同参数被连续调用多次。', causes: '模型陷入重复调用循环。', suggestion: '更换参数或思路，而不是重复同一调用。' },
    { code: 'MOD-006', level: 'blocker', message: '任务超出时间预算。', causes: '目标过大，或 budget_envelope.max_time_ms 设置过小。', suggestion: '缩小目标范围，或调大 budget_envelope.max_time_ms。' },
    { code: 'MOD-007', level: 'degradation', message: '模型请求已被用户取消。', causes: '用户主动中止了当前回复。', suggestion: '重新发送消息即可继续。' },
  ] },
  { group: 'CTX · 上下文', rows: [
    { code: 'CTX-002', level: 'blocker', message: '交接文档校验失败或文件不可读。', causes: '交接文档结构被改坏，或文件已被删除。', suggestion: '重新生成交接文档。' },
    { code: 'CTX-003', level: 'blocker', message: '上下文阈值无效。', causes: '阈值不在 (0, 1] 范围内。', suggestion: '使用 (0, 1] 之间的阈值。' },
    { code: 'CTX-004', level: 'blocker', message: '上下文预算无效。', causes: 'maxTokens 非正数，或 usedTokens 为负数。', suggestion: '提供正数 maxTokens 与非负数 usedTokens。' },
  ] },
  { group: 'GOV · 工具治理', rows: [
    { code: 'GOV-001', level: 'blocker', message: '工具未注册、需要审批，或被操作者拒绝。', causes: '工具名拼写错误，工具未注册；不可逆操作未获批准；或审批被拒绝。', suggestion: '注册工具，获取人工审批，或换用允许的权限模式与方法。' },
    { code: 'GOV-002', level: 'blocker', message: '工具参数不符合 schema。', causes: '调用参数缺失或类型不对。', suggestion: '按工具 schema 修正参数。' },
    { code: 'GOV-003', level: 'degradation', message: '工具执行失败。', causes: '网络错误、接口返回错误、搜索被验证码拦截，或未配置 HIERO_BRAVE_API_KEY 导致回退到 DuckDuckGo 而被拦截。', suggestion: '查看工具证据，确认安全后重试；搜索失败可配置 HIERO_BRAVE_API_KEY。' },
  ] },
  { group: 'MCP · 外部工具服务', rows: [
    { code: 'MCP-001', level: 'blocker', message: 'MCP 服务器发现失败。', causes: '服务器的 command、args 或 cwd 配置错误，或进程启动失败。', suggestion: '在设置面板中检查该服务器的 command、args 与 cwd。' },
    { code: 'MCP-003', level: 'blocker', message: 'MCP 工具未找到。', causes: '工具名不存在，或对应服务器未连接。', suggestion: '先搜索已连接的 MCP 服务器再执行。' },
  ] },
  { group: 'ORG · 状态机', rows: [
    { code: 'ORG-001', level: 'warning', message: '执行仍在进行中。', causes: '在上一步执行未结束时尝试推进。', suggestion: '先完成验证，再推进到下一步。' },
    { code: 'ORG-002', level: 'blocker', message: '开始下一个计划前需要验证。', causes: '上一次验证没有成功，或尚未验证。', suggestion: '提供一次成功的验证结果。' },
    { code: 'ORG-003', level: 'blocker', message: '非法的状态转换。', causes: '当前状态不允许直接跳转到目标状态，或任务在执行中被重复启动。', suggestion: '按明确的状态图推进，等待当前任务到达 Verify 或 Handoff。' },
    { code: 'ORG-005', level: 'blocker', message: '状态机内部异常。', causes: '状态机在处理事件时抛出了未预期的错误。', suggestion: '查看状态机事件日志。' },
  ] },
  { group: 'SYS · 扩展安装', rows: [
    { code: 'SYS-001', level: 'blocker', message: '扩展安装失败。', causes: '仓库地址无效、网络不可达，或扩展构建失败。', suggestion: '检查仓库地址，查看扩展构建日志后重试。' },
  ] },
  { group: 'RBK · 回滚', rows: [
    { code: 'RBK-006', level: 'warning', message: '人工修改过的文件未被回滚，已保留。', causes: '智能体写入之后，文件又被人工修改。', suggestion: '手动检查列出的文件。' },
  ] },
  { group: 'MEM · 记忆', rows: [
    { code: 'MEM-001', level: 'blocker', message: '记忆内容超过字符上限。', causes: '单条或整体记忆超过 MEMORY_LIMIT_CHARS / DEEP_MEMORY_ENTRY_LIMIT_CHARS。', suggestion: '精简记忆内容后保存。' },
  ] },
];
