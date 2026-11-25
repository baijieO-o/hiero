import { useEffect, useRef, useState, type ReactElement } from 'react';
import { McpServersForm, type McpConfigState, type McpSaveState, type McpServerEntry, type McpServerStatus } from './settings';
import { CAPABILITY_STATE_LABELS, mcpCapability, toggledCapability, type CapabilityEntry } from './capability-badge';
import { RUNTIME_WS_URL } from './runtime-url';
import type { RuntimeSocketMessage } from './runtime-socket';
import { requestWorkspace, type SkillScope } from './workspace-request';

type RuntimeMessage = RuntimeSocketMessage;
const SKILL_SCOPE_LABELS: Record<SkillScope, string> = { project: '项目', user: '用户', agents: '通用', codex: 'Codex' };
type SkillRecord = { id: string; name: string; scope: SkillScope; description: string; path: string; size: number };

const SKILL_CATEGORIES = ['MCP 服务器', '技能', '指令', '智能体', '挂钩', '工具'] as const;
type SkillCategory = (typeof SKILL_CATEGORIES)[number];

type HotPlugItem = { name: string; enabled: boolean };
type SnowdomeResidentState = { name: string; url: string; persona: string; driver: string };
type SnowdomeConfigDraft = { residents: SnowdomeResidentState[] };
type SnowdomeAdapterState = { enabled: boolean; residents: SnowdomeResidentState[]; statuses: Record<string, { enabled: boolean; error?: string } | undefined> };
type HotPlugSnapshot = { servers: McpServerEntry[]; statuses: McpServerStatus[]; retrying?: string[]; adapters: SnowdomeAdapterState; skills: HotPlugItem[]; tools: HotPlugItem[] };
type HotPlugKind = 'mcp' | 'skill' | 'tool' | 'adapter';

/** Hot-plug state for MCP servers, skills and built-in tools, sharing one backend socket per view. */
function useHotPlug(): { snapshot: HotPlugSnapshot | null; error: string | null; toggle: (kind: HotPlugKind, name: string, enabled: boolean) => void; saveAdapter: (config: SnowdomeConfigDraft) => void } {
  const [snapshot, setSnapshot] = useState<HotPlugSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    let active = true;
    const socket = new WebSocket(RUNTIME_WS_URL);
    socketRef.current = socket;
    socket.onopen = () => { if (active) socket.send(JSON.stringify({ type: 'hot_plug_list' })); };
    socket.onmessage = (event) => {
      if (!active) return;
      try {
        const message = JSON.parse(String(event.data)) as RuntimeMessage;
        if (message.type !== 'HOT_PLUG_RESULT') return;
        const result = message.payload as unknown as ({ ok: true } & HotPlugSnapshot) | { ok: false; message: string };
        if (result.ok) { setSnapshot(result); setError(null); } else setError(result.message);
      } catch { /* Ignore non-JSON runtime messages. */ }
    };
    socket.onerror = () => { if (active) setError(`未连接到后端（${RUNTIME_WS_URL}）。`); };
    return () => { active = false; socketRef.current = null; socket.close(); };
  }, []);
  const toggle = (kind: HotPlugKind, name: string, enabled: boolean) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) { setError(`未连接到后端（${RUNTIME_WS_URL}）。`); return; }
    socket.send(JSON.stringify({ type: 'hot_plug_set', kind, name, enabled }));
  };
  const saveAdapter = (config: SnowdomeConfigDraft) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) { setError(`未连接到后端（${RUNTIME_WS_URL}）。`); return; }
    socket.send(JSON.stringify({ type: 'hot_plug_set', snowdome: config }));
  };
  return { snapshot, error, toggle, saveAdapter };
}

function HotPlugToggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }): ReactElement {
  return (
    <label className="hot-plug-toggle" title={checked ? '已启用' : '已停用'}>
      <input type="checkbox" role="switch" checked={checked} aria-label={label} onChange={(event) => onChange(event.target.checked)} />
      <span className="hot-plug-track" aria-hidden="true" />
    </label>
  );
}

function HotPlugList({ items, kind, note, onToggle, stateOf }: { items: HotPlugItem[]; kind: HotPlugKind; note: string; onToggle: HotPlugToggleFn; stateOf?: (item: HotPlugItem) => CapabilityEntry }): ReactElement {
  if (items.length === 0) return <p className="skills-empty">暂无条目。</p>;
  return (
    <div className="hot-plug-list">
      <p className="skills-empty">{note}</p>
      <ul>
        {items.map((item) => {
          const capability = stateOf?.(item);
          return (
            <li key={item.name} className={item.enabled ? '' : 'disabled'}>
              <span>{item.name}</span>
              {capability ? (
                <span className={`capability-badge capability-${capability.state}`} title={capability.reason}>
                  {CAPABILITY_STATE_LABELS[capability.state]}{capability.reason ? `：${capability.reason}` : ''}
                </span>
              ) : null}
              <HotPlugToggle checked={item.enabled} label={`${kind} ${item.name}`} onChange={(checked) => onToggle(kind, item.name, checked)} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type HotPlugToggleFn = (kind: HotPlugKind, name: string, enabled: boolean) => void;

function ToolsCategoryView(): ReactElement {
  const { snapshot, error, toggle } = useHotPlug();
  return (
    <div className="skills-editor">
      {error ? <p role="alert">{error}</p> : null}
      {snapshot ? (
        <HotPlugList items={snapshot.tools} kind="tool" note="内置工具。开关对新对话生效，已有对话保持不变。" onToggle={toggle} stateOf={(item) => toggledCapability(item.name, item.enabled)} />
      ) : <p className="skills-empty">正在读取工具列表…</p>}
    </div>
  );
}

function McpCategoryView(): ReactElement {
  const hotPlug = useHotPlug();
  const [config, setConfig] = useState<McpConfigState | null>(null);
  const [saveState, setSaveState] = useState<McpSaveState>({ status: 'idle' });
  const socketRef = useRef<WebSocket | null>(null);
  const { snapshot } = hotPlug;
  useEffect(() => {
    if (!snapshot) return;
    setConfig((current) => (current ? { ...current, servers: snapshot.servers, statuses: snapshot.statuses } : current));
  }, [snapshot]);
  useEffect(() => {
    let active = true;
    const socket = new WebSocket(RUNTIME_WS_URL);
    socketRef.current = socket;
    socket.onopen = () => { if (active) socket.send(JSON.stringify({ type: 'mcp_config_get' })); };
    socket.onmessage = (event) => {
      if (!active) return;
      try {
        const message = JSON.parse(String(event.data)) as RuntimeMessage;
        if (message.type === 'MCP_CONFIG') setConfig(message.payload as unknown as McpConfigState);
        if (message.type === 'MCP_CONFIG_SAVE_RESULT') {
          const result = message.payload as unknown as { ok: true; servers: McpServerEntry[]; statuses: McpServerStatus[]; path: string } | { ok: false; message: string };
          if (result.ok) {
            setConfig({ servers: result.servers, statuses: result.statuses, path: result.path });
            setSaveState({ status: 'saved' });
          } else {
            setSaveState({ status: 'error', message: result.message });
          }
        }
      } catch { /* Ignore non-JSON runtime messages. */ }
    };
    socket.onerror = () => { if (active) setSaveState({ status: 'error', message: `未连接到后端（${RUNTIME_WS_URL}）。` }); };
    return () => { active = false; socketRef.current = null; socket.close(); };
  }, []);
  const save = (servers: McpServerEntry[]) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setSaveState({ status: 'error', message: `未连接到后端（${RUNTIME_WS_URL}），请先启动后端再保存。` });
      return;
    }
    setSaveState({ status: 'saving' });
    socket.send(JSON.stringify({ type: 'mcp_config_save', payload: { servers } }));
  };
  return (
    <div className="skills-editor skills-scroll">
      {hotPlug.error ? <p role="alert">{hotPlug.error}</p> : null}
      {hotPlug.snapshot && hotPlug.snapshot.servers.length > 0 ? (
        <HotPlugList
          items={hotPlug.snapshot.servers.map((server) => ({ name: server.name, enabled: server.enabled !== false }))}
          kind="mcp"
          note="启停立即生效，并写入 mcp.json，重启后保持。"
          onToggle={hotPlug.toggle}
          stateOf={(item) => mcpCapability(item.name, item.enabled, hotPlug.snapshot?.statuses.find((status) => status.name === item.name), hotPlug.snapshot?.retrying?.includes(item.name) ?? false)}
        />
      ) : null}
      {hotPlug.snapshot ? (
        <SnowdomeAdapterView
          adapter={hotPlug.snapshot.adapters}
          error={hotPlug.error}
          onToggle={hotPlug.toggle}
          onSave={hotPlug.saveAdapter}
        />
      ) : null}
      <McpServersForm config={config} saveState={saveState} onSave={save} />
    </div>
  );
}

/** Snowdome adapter: a global switch plus the resident list. Each resident has its own Snowdome address and persona; all share one model. */
function SnowdomeAdapterView({ adapter, error, onSave, onToggle }: { adapter: SnowdomeAdapterState; error: string | null; onSave: (config: SnowdomeConfigDraft) => void; onToggle: HotPlugToggleFn }): ReactElement {
  const [residents, setResidents] = useState<SnowdomeResidentState[]>(adapter.residents);
  useEffect(() => { setResidents(adapter.residents); }, [adapter.residents]);
  const dirty = JSON.stringify(residents) !== JSON.stringify(adapter.residents);
  const update = (index: number, patch: Partial<SnowdomeResidentState>) => setResidents(residents.map((resident, i) => (i === index ? { ...resident, ...patch } : resident)));
  const add = () => setResidents([...residents, { name: `居民${residents.length + 1}`, url: 'ws://localhost:3000/agent', persona: '', driver: 'snowdome-planner-driver.js' }]);
  const remove = (index: number) => setResidents(residents.filter((_, i) => i !== index));
  return (
    <details className="hot-plug-list snowdome-section" open>
      <summary>Snowdome 适配器（{adapter.enabled ? '已开启' : '已停用'}，{residents.length} 个居民）</summary>
      {error ? <p role="alert">{error}</p> : null}
      <ul>
        <li className={adapter.enabled ? '' : 'disabled'}>
          <span>Snowdome 适配器</span>
          <HotPlugToggle checked={adapter.enabled} label="adapter snowdome" onChange={(checked) => onToggle('adapter', 'snowdome', checked)} />
        </li>
      </ul>
      <p className="skills-empty">启停立即生效。开启后每个居民各自以昵称登录其 Snowdome 地址，由 ~/.hiero/drivers 中的第三方驱动决策，人设各自配置。</p>
      {residents.map((resident, index) => {
        const status = adapter.statuses[resident.name];
        return (
          <div key={index} className="snowdome-resident">
            {status?.error ? <p role="alert">{status.error}</p> : null}
            <label>昵称 <input value={resident.name} onChange={(event) => update(index, { name: event.target.value })} /></label>
            <label>服务端地址 <input value={resident.url} onChange={(event) => update(index, { url: event.target.value })} /></label>
            <label>人设提示词 <textarea value={resident.persona} onChange={(event) => update(index, { persona: event.target.value })} /></label>
            <button type="button" onClick={() => remove(index)}>删除居民</button>
          </div>
        );
      })}
      <button type="button" onClick={add}>添加居民</button>
      <button type="button" disabled={!dirty} onClick={() => onSave({ residents })}>保存配置</button>
    </details>
  );
}
export function SkillsBuffer(): ReactElement {
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [category, setCategory] = useState<SkillCategory>('技能');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hotPlug = useHotPlug();
  const categoryCount = (item: SkillCategory): number => {
    if (item === '技能') return skills.length;
    if (item === 'MCP 服务器') return hotPlug.snapshot?.servers.length ?? 0;
    if (item === '工具') return hotPlug.snapshot?.tools.length ?? 0;
    return 0;
  };

  const refresh = () => {
    setError(null);
    requestWorkspace({ type: 'skill_list' })
      .then((payload) => setSkills((payload.skills as SkillRecord[]) ?? []))
      .catch((cause: Error) => setError(cause.message));
  };
  useEffect(refresh, []);

  const open = (skill: SkillRecord) => {
    setSelectedId(skill.id);
    setStatus(null);
    requestWorkspace({ type: 'skill_read', scope: skill.scope, name: skill.name })
      .then((payload) => { const text = String(payload.content ?? ''); setDraft(text); setSaved(text); })
      .catch((cause: Error) => setError(cause.message));
  };

  const selected = skills.find((skill) => skill.id === selectedId) ?? null;
  const dirty = draft !== saved;

  const save = () => {
    if (!selected) return;
    requestWorkspace({ type: 'skill_save', scope: selected.scope, name: selected.name, content: draft })
      .then(() => { setSaved(draft); setStatus('已保存'); refresh(); })
      .catch((cause: Error) => setError(cause.message));
  };

  const remove = () => {
    if (!selected || !window.confirm(`删除技能 ${selected.name}？此操作会删除其目录。`)) return;
    requestWorkspace({ type: 'skill_delete', scope: selected.scope, name: selected.name })
      .then(() => { setSelectedId(null); setDraft(''); setSaved(''); setStatus('已删除'); refresh(); })
      .catch((cause: Error) => setError(cause.message));
  };

  return (
    <div className="skills-panel">
      <nav className="skills-categories" aria-label="分类">
        {SKILL_CATEGORIES.map((item) => (
          <button key={item} type="button" className={item === category ? 'active' : ''} onClick={() => setCategory(item)}>
            <span>{item}</span>
            <b>{categoryCount(item)}</b>
          </button>
        ))}
      </nav>
      <div className="skills-main">
        {category === 'MCP 服务器' && <McpCategoryView />}
        {category === '工具' && <ToolsCategoryView />}
        {category !== '技能' && category !== 'MCP 服务器' && category !== '工具' && <p className="skills-empty">{category} 暂未接入数据源。</p>}
        {category === '技能' && (
          <div className="skills-body">
            <ul className="skills-list">
              {skills.map((skill) => {
                const enabled = hotPlug.snapshot?.skills.find((item) => item.name === skill.name)?.enabled !== false;
                return (
                  <li key={skill.id} className={enabled ? '' : 'disabled'}>
                    <button type="button" className={skill.id === selectedId ? 'active' : ''} onClick={() => open(skill)}>
                      <strong>{skill.name}</strong>
                      <small>{SKILL_SCOPE_LABELS[skill.scope]} · {skill.description || '无描述'}{enabled ? '' : ' · 已停用'}</small>
                    </button>
                    {hotPlug.snapshot ? (
                      <HotPlugToggle checked={enabled} label={`skill ${skill.name}`} onChange={(checked) => hotPlug.toggle('skill', skill.name, checked)} />
                    ) : null}
                  </li>
                );
              })}
              {skills.length === 0 && <li className="skills-empty">未找到技能。可在 .agent/skills、~/.copilot/skills 或 ~/.agents/skills 下新建 &lt;name&gt;/SKILL.md。</li>}
            </ul>
            <div className="skills-editor">
              {selected ? (
                <>
                  <div className="skills-editor-head">
                    <span>{selected.path}</span>
                    <button type="button" onClick={save} disabled={!dirty}>保存</button>
                    <button type="button" onClick={remove}>删除</button>
                  </div>
                  <textarea value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} aria-label="SKILL.md 内容" />
                </>
              ) : <p className="skills-empty">选择一个技能以查看或编辑。</p>}
              {status && <p className="skills-status">{status}</p>}
              {error && <p className="skills-error">{error}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
