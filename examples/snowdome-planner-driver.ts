// Example third-party Snowdome driver. Copy the compiled file to ~/.hiero/drivers and set "driver" to its file name.
import type { DriverContext, SnowdomeDriver } from '../src/snowdome-driver.js';
import type { SnowdomeDecision, SnowdomeIntent, SnowdomeObservation } from '../src/snowdome-adapter.js';

const PLAN_INTERVAL_MS = 30_000;

// Plans run off the observation path. The adapter always receives the newest observation, and a slow plan
// never blocks observation handling.
export default function createPlannerDriver(ctx: DriverContext): SnowdomeDriver {
  let plan: SnowdomeIntent[] = [];
  let pendingNotice: string | undefined;
  let pendingPersona: string | undefined;
  let planning = false;
  let lastPlanAt = 0;

  async function replan(observation: SnowdomeObservation): Promise<void> {
    planning = true;
    try {
      // Read the persona at each round, so an owner edit or an earlier rewrite is used by the next plan.
      const prompt = [
        ctx.getPersona(),
        '你在 Snowdome 小镇里。根据下面的观察，给出接下来要做的 0 到 3 个动作。',
        '只输出 JSON：{"intents":[{"kind":"move","target":{"x":0,"y":0,"z":0}}|{"kind":"speak","mode":"talk|whisper|shout","text":"..."}|{"kind":"emote","emoji":"单个emoji"}],"mood":"可选，{\\"valence\\":-1到1,\\"arousal\\":-1到1}，你当前的心情","notice":"可选，值得告诉主人的一句话","personaUpdate":"可选，仅在被冒犯、被说服、被揭穿等重要事件后填写的新人设","commitment":"可选，一个承诺动作对象"}',
        'emote 的 emoji 必须是单个 emoji；每次决策都可以附带一个表情。mood 只在心情明显变化时填写，数值在 [-1, 1] 内。',
        'commitment 的形式：{"action":"propose","counterparty":"对方名字","content":"不超过200字"} 或 {"action":"accept","commitmentId":"id"} 或 {"action":"report","commitmentId":"id","outcome":"fulfilled|breached"}。',
        'move 每次最多移动 3 格。只允许 move 与 speak，不要输出其他动作。',
        '对话要收尾：对同一个人的寒暄最多回应一次，不要反问、不要追问“最近怎么样”之类的问题；若对方的话没有新内容，就不要 speak，只可以做表情或移动。',
        'commitment 只在你和对方明确约定、或对方履行/违约后填写；没有就省略。accept 与 report 只对对方发给你的承诺有效。',
        'notice 只在遇到重要的人或事时填写，否则省略。personaUpdate 只在重要事件改变了你的看法时填写；第一行的名字与定位会被保留，只改后面的描述，且不超过 500 字。',
        JSON.stringify(observation),
      ].join('\n');
      const text = await ctx.ask(prompt);
      const decision = parseDecision(text);
      // emote and mood join the plan so they are paced with moves and speech, sharing the same action budget.
      plan = decision.intents;
      if (decision.mood) plan = [...plan, { kind: 'mood', ...decision.mood } as SnowdomeIntent];
      if (decision.notice) pendingNotice = decision.notice;
      if (decision.personaUpdate) pendingPersona = decision.personaUpdate;
      if (decision.commitment) await runCommitment(decision.commitment);
    } catch {
      // A failed plan leaves the resident idle; the next observation triggers another plan.
      plan = [];
    } finally {
      planning = false;
    }
  }

  // Snowdome decides what counts; a refusal (for example not_counterparty) is recorded as a notice, never retried.
  async function runCommitment(action: CommitmentPlan): Promise<void> {
    try {
      const receipt = action.action === 'propose'
        ? await ctx.proposeCommitment(action.counterparty, action.content)
        : action.action === 'accept'
          ? await ctx.acceptCommitment(action.commitmentId)
          : await ctx.reportCommitment(action.commitmentId, action.outcome);
      pendingNotice = receipt.accepted ? `承诺已记录：${action.action}` : `承诺被拒绝：${receipt.reason_code}`;
    } catch (error) {
      pendingNotice = `承诺失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return {
    onObservation(observation: SnowdomeObservation): SnowdomeDecision {
      const now = Date.now();
      if (!planning && now - lastPlanAt >= PLAN_INTERVAL_MS) {
        lastPlanAt = now;
        void replan(observation);
      }
      const intents = plan;
      plan = [];
      const notice = pendingNotice;
      pendingNotice = undefined;
      const personaUpdate = pendingPersona;
      pendingPersona = undefined;
      return {
        intents,
        ...(notice ? { notice } : {}),
        ...(personaUpdate ? { personaUpdate } : {}),
      };
    },
  };
}

type CommitmentPlan =
  | { action: 'propose'; counterparty: string; content: string }
  | { action: 'accept'; commitmentId: string }
  | { action: 'report'; commitmentId: string; outcome: 'fulfilled' | 'breached' };

interface ParsedDecision extends SnowdomeDecision {
  commitment?: CommitmentPlan;
  mood?: { valence: number; arousal: number };
}

function parseMood(raw: unknown): { valence: number; arousal: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  const inRange = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -1 && v <= 1;
  return inRange(m.valence) && inRange(m.arousal) ? { valence: m.valence, arousal: m.arousal } : undefined;
}

function parseCommitment(raw: unknown): CommitmentPlan | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  if (c.action === 'propose' && typeof c.counterparty === 'string' && typeof c.content === 'string') {
    return { action: 'propose', counterparty: c.counterparty, content: c.content };
  }
  if (c.action === 'accept' && typeof c.commitmentId === 'string') {
    return { action: 'accept', commitmentId: c.commitmentId };
  }
  if (c.action === 'report' && typeof c.commitmentId === 'string' && (c.outcome === 'fulfilled' || c.outcome === 'breached')) {
    return { action: 'report', commitmentId: c.commitmentId, outcome: c.outcome };
  }
  return undefined;
}

function parseDecision(text: string): ParsedDecision {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return { intents: [] };
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as { intents?: unknown; notice?: unknown; personaUpdate?: unknown; commitment?: unknown; mood?: unknown };
    const intents = Array.isArray(raw.intents) ? (raw.intents as SnowdomeIntent[]) : [];
    const notice = typeof raw.notice === 'string' ? raw.notice : undefined;
    const personaUpdate = typeof raw.personaUpdate === 'string' && raw.personaUpdate.trim() ? raw.personaUpdate : undefined;
    const commitment = parseCommitment(raw.commitment);
    const mood = parseMood(raw.mood);
    return {
      intents,
      ...(notice ? { notice } : {}),
      ...(personaUpdate ? { personaUpdate } : {}),
      ...(commitment ? { commitment } : {}),
      ...(mood ? { mood } : {}),
    };
  } catch {
    return { intents: [] };
  }
}
