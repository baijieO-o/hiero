export interface TokenUsageLike {
  input_tokens: number;
  output_tokens: number;
}

/** Price per one million tokens, in USD. Estimates only; update when provider prices change. */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

/** Built-in fallback prices, used until the remote table loads or when it fails. */
export const FALLBACK_MODEL_PRICES: Record<string, ModelPrice> = {
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'deepseek-chat': { inputPerMillion: 0.27, outputPerMillion: 1.1 },
  'deepseek-reasoner': { inputPerMillion: 0.55, outputPerMillion: 2.19 },
};

/** Public LiteLLM price table; per-token USD prices, maintained by the community. */
export const PRICE_SOURCE_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const PRICE_CACHE_KEY = 'hiero-model-prices';

interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
}

/**
 * Converts LiteLLM's per-token table to per-million prices. Keys are stored with their
 * provider prefix (for example "deepseek/deepseek-chat"); the prefix is dropped so lookups
 * match the bare model name. Entries without both prices are skipped.
 */
export function normalizeLiteLLMPrices(raw: Record<string, unknown>): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {};
  // Bare keys (no provider prefix) take priority over prefixed variants such as "azure/gpt-4o".
  const bareNames = new Set<string>();
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as LiteLLMEntry;
    if (typeof entry.input_cost_per_token !== 'number' || typeof entry.output_cost_per_token !== 'number') continue;
    const isPrefixed = key.includes('/');
    const name = (isPrefixed ? key.slice(key.lastIndexOf('/') + 1) : key).toLowerCase();
    if (!isPrefixed) bareNames.add(name);
    if (isPrefixed && bareNames.has(name)) continue;
    out[name] = {
      inputPerMillion: entry.input_cost_per_token * 1_000_000,
      outputPerMillion: entry.output_cost_per_token * 1_000_000,
    };
  }
  return out;
}

/** Remote prices if loaded, otherwise the fallback table. */
export let MODEL_PRICES: Record<string, ModelPrice> = FALLBACK_MODEL_PRICES;

/** Fetches the remote price table (cached in localStorage for 24h) and swaps it in. Falls back silently. */
export async function loadModelPrices(): Promise<void> {
  try {
    const cached = localStorage.getItem(PRICE_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as { savedAt: number; prices: Record<string, ModelPrice> };
      if (Date.now() - parsed.savedAt < 24 * 60 * 60 * 1000 && Object.keys(parsed.prices).length > 0) {
        MODEL_PRICES = parsed.prices;
        return;
      }
    }
    const response = await fetch(PRICE_SOURCE_URL);
    if (!response.ok) return;
    const prices = normalizeLiteLLMPrices((await response.json()) as Record<string, unknown>);
    if (Object.keys(prices).length === 0) return;
    MODEL_PRICES = prices;
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), prices }));
  } catch {
    // Network or parse failure: keep the fallback table.
  }
}

/** Fixed USD to CNY rate used for display only. */
export const USD_TO_CNY = 7.2;

export function findModelPrice(model: string | undefined, table: Record<string, ModelPrice> = MODEL_PRICES): ModelPrice | undefined {
  if (!model) return undefined;
  const name = model.toLowerCase();
  let best: { prefix: string; price: ModelPrice } | undefined;
  for (const [prefix, price] of Object.entries(table)) {
    if (name.startsWith(prefix.toLowerCase()) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, price };
    }
  }
  return best?.price;
}

/** Returns the estimated USD cost, or undefined when the model has no known price. */
export function estimateCostUsd(usage: TokenUsageLike, model: string | undefined, table: Record<string, ModelPrice> = MODEL_PRICES): number | undefined {
  const price = findModelPrice(model, table);
  if (!price) return undefined;
  return (usage.input_tokens * price.inputPerMillion + usage.output_tokens * price.outputPerMillion) / 1_000_000;
}

export function formatCost(usd: number | undefined): string {
  if (usd === undefined) return '未知（无该模型价格）';
  const cny = usd * USD_TO_CNY;
  return `约 $${usd.toFixed(4)} / ¥${cny.toFixed(4)}`;
}
