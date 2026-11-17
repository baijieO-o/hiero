// Example third-party Snowdome driver. Copy the compiled file to ~/.hiero/drivers and set "driver" to its file name.
import type { DriverContext, SnowdomeDriver } from '../src/snowdome-driver.js';
import type { SnowdomeDecision, SnowdomeIntent, SnowdomeObservation } from '../src/snowdome-adapter.js';

const PLAN_INTERVAL_MS = 30_000;

// Plans run off the observation path. The adapter always receives the newest observation, and a slow plan
// never blocks observation handling.
export default function createPlannerDriver(ctx: DriverContext): SnowdomeDriver {
  let plan: SnowdomeIntent[] = [];
  let pendingNotice: string | undefined;
  let planning = false;
  let lastPlanAt = 0;
  let skill = '';

  async function loadSkill(): Promise<void> {
    if (skill) return;
    const detail = await ctx.loadSkill('snowdome-planning').catch(() => undefined);
    skill = detail?.content ?? '';
  }

  async function replan(observation: SnowdomeObservation): Promise<void> {
    planning = true;
    try {
      await loadSkill();
      const prompt = [
        skill,
        '你在 Snowdome 小镇里。根据下面的观察，给出接下来要做的 0 到 3 个动作。',
        '只输出 JSON：{"intents":[{"kind":"move","x":0,"y":0}|{"kind":"speak","mode":"talk","text":"..."}],"notice":"可选，值得告诉主人的一句话"}',
        '动作仅限 move、speak、place、enter。不要输出 leave。notice 只在遇到重要的人或事时填写，否则省略。',
        JSON.stringify(observation),
      ].join('\n');
      const text = await ctx.ask(prompt);
      const decision = parseDecision(text);
      plan = decision.intents;
      if (decision.notice) pendingNotice = decision.notice;
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
      return notice ? { intents, notice } : { intents };
    },
  };
}

function parseDecision(text: string): SnowdomeDecision {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return { intents: [] };
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as { intents?: unknown; notice?: unknown };
    const intents = Array.isArray(raw.intents) ? (raw.intents as SnowdomeIntent[]) : [];
    const notice = typeof raw.notice === 'string' ? raw.notice : undefined;
    return notice ? { intents, notice } : { intents };
  } catch {
    return { intents: [] };
  }
}
