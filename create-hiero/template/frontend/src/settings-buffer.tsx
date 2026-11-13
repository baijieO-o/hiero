import { useRef, useState, useEffect, type ReactElement } from 'react';
import { SettingsPanel, type McpConfigState, type McpSaveState, type McpServerEntry, type McpServerStatus, type ModelListState, type ModelSettings, type SaveState, type TaskModelKindId } from './settings';
import { RUNTIME_WS_URL } from './runtime-url';
import { storeModelCatalog } from './model-catalog-store';
import type { RuntimeSocketMessage } from './runtime-socket';
import { PanelHeader } from './panel-header';

type RuntimeMessage = RuntimeSocketMessage;

export function SettingsBuffer(): ReactElement {
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const [mcpConfig, setMcpConfig] = useState<McpConfigState | null>(null);
  const [mcpSaveState, setMcpSaveState] = useState<McpSaveState>({ status: 'idle' });
  const [modelList, setModelList] = useState<ModelListState>({ status: 'idle' });
  const socketRef = useRef<WebSocket | null>(null);
  const fetchModels = (input: { endpoint: string; tokens: string }) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setModelList({ status: 'error', message: '未连接到后端（localhost:8080），请先启动后端。' });
      return;
    }
    setModelList({ status: 'loading' });
    socket.send(JSON.stringify({ type: 'model_list', request_id: 'model-list', payload: input }));
  };
  const saveModel = (input: { endpoint: string; model: string; tokens: string; task_models: Partial<Record<TaskModelKindId, string>> }) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setSaveState({ status: 'error', message: '未连接到后端（localhost:8080），请先启动后端再保存。' });
      return;
    }
    setSaveState({ status: 'saving' });
    socket.send(JSON.stringify({ type: 'settings_save', payload: input }));
  };
  const saveMcp = (servers: McpServerEntry[]) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setMcpSaveState({ status: 'error', message: '未连接到后端（localhost:8080），请先启动后端再保存。' });
      return;
    }
    setMcpSaveState({ status: 'saving' });
    socket.send(JSON.stringify({ type: 'mcp_config_save', payload: { servers } }));
  };
  useEffect(() => {
    let active = true;
    const socket = new WebSocket(RUNTIME_WS_URL);
    socketRef.current = socket;
    socket.onopen = () => {
      if (!active) return;
      socket.send(JSON.stringify({ type: 'settings_get' }));
      socket.send(JSON.stringify({ type: 'mcp_config_get' }));
    };
    socket.onmessage = (event) => {
      if (!active) return;
      try {
        const message = JSON.parse(String(event.data)) as RuntimeMessage;
        if (message.type === 'SETTINGS') setSettings(message.payload as unknown as ModelSettings);
        if (message.type === 'MODEL_LIST') {
          const result = message.payload as unknown as { models: string[]; error?: string };
          setModelList(result.error ? { status: 'error', message: result.error } : { status: 'ready', models: result.models });
          if (!result.error) storeModelCatalog(result.models);
        }
        if (message.type === 'MCP_CONFIG') setMcpConfig(message.payload as unknown as McpConfigState);
        if (message.type === 'MCP_CONFIG_SAVE_RESULT') {
          const result = message.payload as unknown as { ok: true; servers: McpServerEntry[]; statuses: McpServerStatus[]; path: string } | { ok: false; message: string };
          if (result.ok) {
            setMcpConfig({ servers: result.servers, statuses: result.statuses, path: result.path });
            setMcpSaveState({ status: 'saved' });
          } else {
            setMcpSaveState({ status: 'error', message: result.message });
          }
        }
        if (message.type === 'SETTINGS_SAVE_RESULT') {
          const result = message.payload as unknown as { ok: boolean; message?: string; settings?: ModelSettings };
          if (result.ok && result.settings) {
            setSettings(result.settings);
            setSaveState({ status: 'saved', tokenCount: result.settings.token_count });
          } else {
            setSaveState({ status: 'error', message: result.message ?? '保存失败' });
          }
        }
      } catch { /* Ignore non-JSON runtime messages. */ }
    };
    socket.onerror = () => { if (active) setSettings(null); };
    return () => {
      active = false;
      socketRef.current = null;
      socket.close();
    };
  }, []);
  return <section className="panel-content"><PanelHeader eyebrow="配置" title="设置" /><SettingsPanel modelSettings={settings} saveState={saveState} onSaveModel={saveModel} modelList={modelList} onFetchModels={fetchModels} mcpConfig={mcpConfig}   mcpSaveState={mcpSaveState} onSaveMcp={saveMcp} /></section>;
}
