/** Snowdome commitment and reputation endpoints. Snowdome records facts only; the counts are shown as given, never scored here. */

export type SnowdomeCommitmentOutcome = 'fulfilled' | 'breached';

/** Commitment state as Snowdome reports it. Only `active` commitments count toward reputation. */
export type SnowdomeCommitmentState = 'pending' | 'active' | 'fulfilled' | 'breached' | string;

export interface SnowdomeCommitmentReceipt {
  accepted: boolean;
  reason_code: string;
  state_delta: Record<string, unknown>;
  cooldown_ms: number;
}

export interface SnowdomeReputation {
  /** Counts only commitments both parties have confirmed; shown side by side, never merged into one score. */
  parties_reported: { commitments: number; fulfilled: number; breached: number };
  /** No system verification rule exists yet, so this stays null. */
  system_verified: null;
}

export interface SnowdomeReputationResponse {
  id: string;
  reputation: SnowdomeReputation;
  commitments: Record<string, unknown>[];
}

/** Maps a receipt to a thrown error with Snowdome's reason code, so callers can tell a refusal from a transport failure. */
export function assertCommitmentAccepted(receipt: SnowdomeCommitmentReceipt): SnowdomeCommitmentReceipt {
  if (!receipt.accepted) throw new Error(`Snowdome 承诺被拒绝：${receipt.reason_code}`);
  return receipt;
}

export async function postCommitment(
  baseUrl: string,
  token: string,
  path: 'commitment' | 'commitment/accept' | 'commitment/report',
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<SnowdomeCommitmentReceipt> {
  const response = await fetchImpl(`${baseUrl}/api/agent/${path}?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok && response.status >= 500) throw new Error(`Snowdome 承诺请求失败：${response.status}`);
  return await response.json() as SnowdomeCommitmentReceipt;
}

export async function fetchReputation(baseUrl: string, id: string, fetchImpl: typeof fetch = fetch): Promise<SnowdomeReputationResponse> {
  const response = await fetchImpl(`${baseUrl}/api/agent/reputation?id=${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`Snowdome 声誉查询失败：${response.status}`);
  return await response.json() as SnowdomeReputationResponse;
}

/** Derives the HTTP base (scheme + host) from the login URL, which is what every /api/agent route is relative to. */
export function snowdomeBaseUrl(loginUrl: string): string {
  if (!/\/api\/login$/.test(loginUrl)) throw new Error(`Snowdome 登录地址必须以 /api/login 结尾：${loginUrl}`);
  return loginUrl.replace(/\/api\/login$/, '');
}
