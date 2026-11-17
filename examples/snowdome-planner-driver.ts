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
        '只输出 JSON：{"intents":[{"kind":"move","target":{"x":0,"y":0,"z":0}}|{"kind":"speak","mode":"talk|whisper|shout","text":"..."}],"notice":"可选，值得告诉主人的一句话","personaUpdate":"可选，仅在被冒犯、被说服、被揭穿等重要事件后填写的新人设"}',
        'move 每次最多移动 3 格。只允许 move 与 speak，不要输出其他动作。',
        'notice 只在遇到重要的人或事时填写，否则省略。personaUpdate 只在重要事件改变了你的看法时填写；第一行的名字与定位会被保留，只改后面的描述，且不超过 500 字。',
        JSON.stringify(observation),
      ].join('\n');
      const text = await ctx.ask(prompt);
      const decision = parseDecision(text);
      plan = decision.intents;
      if (decision.notice) pendingNotice = decision.notice;
      if (decision.personaUpdate) pendingPersona = decision.personaUpdate;
    } catch {
      // A failed plan leaves the resident idle; the next observation triggers another plan.
      plan = [];
    } finally {
      planning = false;
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

function parseDecision(text: string): SnowdomeDecision {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return { intents: [] };
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as { intents?: unknown; notice?: unknown; personaUpdate?: unknown };
    const intents = Array.isArray(raw.intents) ? (raw.intents as SnowdomeIntent[]) : [];
    const notice = typeof raw.notice === 'string' ? raw.notice : undefined;
    const personaUpdate = typeof raw.personaUpdate === 'string' && raw.personaUpdate.trim() ? raw.personaUpdate : undefined;
    return {
      intents,
      ...(notice ? { notice } : {}),
      ...(personaUpdate ? { personaUpdate } : {}),
    };
  } catch {
    return { intents: [] };
  }
}
