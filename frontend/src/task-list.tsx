import type { ReactElement } from 'react';
import { usePreferences } from './settings';
/** Only the fields the list reads; the App's Conversation type satisfies it structurally. */
type TaskConversation = { id: string; title: string; messages: { role: string }[]; updatedAt: number };

export function TaskList({ conversations, activeId, pending, onOpen }: { conversations: TaskConversation[]; activeId: string | null; pending: boolean; onOpen: (id: string) => void }): ReactElement {
  const showMeta = usePreferences((state) => state.values.taskMeta);
  const groupMode = usePreferences((state) => state.values.taskGroupMode);
  const groups: { title: string; items: TaskConversation[] }[] = groupMode === 'time'
    ? [{ title: '今天', items: [] }, { title: '近 7 天', items: [] }, { title: '更早', items: [] }]
    : [{ title: '运行中', items: [] }, { title: '待处理', items: [] }, { title: '已完成', items: [] }];
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const weekStart = dayStart - 6 * 24 * 60 * 60 * 1000;
  for (const conv of [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (groupMode === 'time') {
      if (conv.updatedAt >= dayStart) groups[0]?.items.push(conv);
      else if (conv.updatedAt >= weekStart) groups[1]?.items.push(conv);
      else groups[2]?.items.push(conv);
      continue;
    }
    const last = conv.messages[conv.messages.length - 1];
    if (conv.id === activeId && pending) groups[0]?.items.push(conv);
    else if (last?.role === 'user') groups[1]?.items.push(conv);
    else groups[2]?.items.push(conv);
  }
  return <aside className="task-list" aria-label="任务列表">
    {groups.map((group) => <section key={group.title} className="task-group">
      <h3>{group.title}（{group.items.length}）</h3>
      {group.items.length === 0 && <p className="task-empty">暂无</p>}
      {group.items.map((conv) => <button key={conv.id} type="button" className={`task-item ${conv.id === activeId ? 'active' : ''}`} onClick={() => onOpen(conv.id)}>
        <span>{conv.title || '新对话'}</span>
        {showMeta && <small>{new Date(conv.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · {conv.messages.length} 条消息</small>}
      </button>)}
    </section>)}
  </aside>;
}
