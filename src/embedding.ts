export interface EmbeddingConfig {
  endpoint: string;
  model: string;
  token: string;
}

export type Embedder = (texts: string[]) => Promise<number[][]>;

/** Reads HIERO_EMBED_* settings. Returns undefined when no endpoint or model is set, which disables vector recall. */
export function embeddingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig | undefined {
  const endpoint = env.HIERO_EMBED_ENDPOINT?.trim();
  const model = env.HIERO_EMBED_MODEL?.trim();
  if (!endpoint || !model) return undefined;
  return { endpoint, model, token: (env.HIERO_EMBED_TOKENS ?? '').split(/[,;\n]/)[0]?.trim() ?? '' };
}

export function createEmbedder(config: EmbeddingConfig, fetchImpl: typeof fetch = fetch): Embedder {
  return async (texts) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.token) headers.authorization = `Bearer ${config.token}`;
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.model, input: texts }),
    });
    if (!response.ok) throw new Error(`Embedding request failed with status ${response.status}`);
    const payload = (await response.json()) as { data?: { index?: number; embedding?: unknown }[] };
    const data = payload.data;
    if (!Array.isArray(data) || data.length !== texts.length) throw new Error('Embedding response is invalid.');
    const vectors = [...data]
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((item) => {
        if (!Array.isArray(item.embedding) || !item.embedding.every((value) => typeof value === 'number')) {
          throw new Error('Embedding response is invalid.');
        }
        return item.embedding as number[];
      });
    return vectors;
  };
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
