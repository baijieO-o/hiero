import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { RegisteredTool } from './tool-gateway.js';

export const webSearchInput = z.object({
  query: z.string().trim().min(1).max(300),
  count: z.number().int().min(1).max(10).default(5),
});

export const webFetchInput = z.object({
  url: z.string().trim().min(1).max(2000),
});

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 20_000;
const MAX_REDIRECTS = 5;
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

/** Returns true for addresses a model-chosen URL must never reach (loopback, private, link-local, unspecified). */
export function isBlockedAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const version = isIP(host);
  if (version === 4) {
    const [a = 0, b = 0] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (version === 6) {
    if (host === '::' || host === '::1') return true;
    if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return true;
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isBlockedAddress(mapped[1]);
  }
  return false;
}

/** Validates a URL before any request is made. Throws with a human-readable reason when it is not allowed. */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs can be fetched.');
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed.');
  if (isBlockedAddress(url.hostname)) throw new Error(`Fetching private or local address "${url.hostname}" is not allowed.`);
  return url;
}

/** Resolves a hostname and rejects it if any returned address is private or local (guards against DNS pointing at internal hosts). */
export async function assertPublicHost(url: URL, lookup: typeof dnsLookup = dnsLookup): Promise<void> {
  if (isIP(url.hostname)) return;
  const addresses = await lookup(url.hostname, { all: true });
  const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
  if (blocked) throw new Error(`Host "${url.hostname}" resolves to a private or local address and cannot be fetched.`);
}

/** Converts HTML to readable plain text: drops scripts/styles, strips tags, decodes common entities, collapses whitespace. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

async function readLimitedText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_RESPONSE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(value);
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).subarray(0, MAX_RESPONSE_BYTES).toString('utf8');
}

export interface WebFetchResult {
  url: string;
  status: number;
  content_type: string;
  text: string;
  truncated: boolean;
}

/** Fetches a public web page and returns readable text. Redirects are followed manually so every hop is validated. */
export async function fetchWebPage(raw: string, fetcher: typeof fetch = fetch, lookup: typeof dnsLookup = dnsLookup): Promise<WebFetchResult> {
  let url = assertFetchableUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(url, lookup);
    const response = await fetcher(url, {
      redirect: 'manual',
      headers: { 'user-agent': 'Hiero/0.2 (+personal agent workbench)', accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new Error(`Redirect from ${url.href} has no Location header.`);
      url = assertFetchableUrl(new URL(location, url).href);
      continue;
    }
    const contentType = response.headers.get('content-type') ?? '';
    const body = await readLimitedText(response);
    const text = /html/i.test(contentType) ? htmlToText(body) : body;
    return {
      url: url.href,
      status: response.status,
      content_type: contentType,
      text: text.slice(0, MAX_TEXT_CHARS),
      truncated: text.length > MAX_TEXT_CHARS || body.length >= MAX_RESPONSE_BYTES,
    };
  }
  throw new Error(`Too many redirects (limit ${MAX_REDIRECTS}).`);
}

export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
}

/** Queries the Brave Search API. Requires HIERO_BRAVE_API_KEY; the key is sent only in a request header and never returned. */
export async function searchWeb(query: string, count: number, apiKey: string | undefined, fetcher: typeof fetch = fetch): Promise<WebSearchResult[]> {
  if (!apiKey?.trim()) throw new Error('Web search is not configured. Set HIERO_BRAVE_API_KEY to a Brave Search API key.');
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));
  const response = await fetcher(url, {
    headers: { accept: 'application/json', 'x-subscription-token': apiKey.trim() },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Web search failed with HTTP ${response.status}.`);
  const data = await response.json() as { web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> } };
  return (data.web?.results ?? []).slice(0, count).map((item) => ({
    title: typeof item.title === 'string' ? htmlToText(item.title) : '',
    url: typeof item.url === 'string' ? item.url : '',
    description: typeof item.description === 'string' ? htmlToText(item.description) : '',
  })).filter((item) => item.url);
}

/** Network tools are always marked `networkAccess`, so the gateway asks for approval outside auto mode. */
export function createWebSearchTool(apiKey: string | undefined): RegisteredTool<z.infer<typeof webSearchInput>, { results: WebSearchResult[] }> {
  return {
    name: 'web_search',
    inputSchema: webSearchInput,
    effect: 'external',
    networkAccess: true,
    execute: async ({ query, count }) => ({ results: await searchWeb(query, count, apiKey) }),
  };
}

export function createWebFetchTool(): RegisteredTool<z.infer<typeof webFetchInput>, WebFetchResult> {
  return {
    name: 'web_fetch',
    inputSchema: webFetchInput,
    effect: 'external',
    networkAccess: true,
    execute: async ({ url }) => fetchWebPage(url),
  };
}
