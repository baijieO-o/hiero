import type { Browser, BrowserContext, Page } from 'playwright-core';
import { z } from 'zod';
import type { RegisteredTool } from './tool-gateway.js';
import { assertFetchableUrl, assertPublicHost } from './web-tools.js';

/**
 * A browser the agent can drive. "visible" is a headed Edge window the user can watch and take over.
 * "headless" connects to a CDP endpoint (for example Lightpanda) when configured, otherwise runs headless Edge.
 */
export type BrowserMode = 'visible' | 'headless';

const NAV_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 10_000;
const MAX_SNAPSHOT_CHARS = 20_000;
const MAX_EXTRACT_CHARS = 20_000;

interface BrowserSessionOptions {
  /** CDP endpoint for a headless engine such as Lightpanda, for example http://127.0.0.1:9222. */
  headlessCdpUrl?: string | undefined;
}

/** Owns one Playwright browser per mode. Pages are created on demand and reused by the agent. */
export class BrowserSessions {
  private readonly browsers = new Map<BrowserMode, Promise<Browser>>();
  private readonly contexts = new Map<BrowserMode, BrowserContext>();
  private readonly pages = new Map<BrowserMode, Page>();

  constructor(private readonly options: BrowserSessionOptions = {}) {}

  private async browserFor(mode: BrowserMode): Promise<Browser> {
    const existing = this.browsers.get(mode);
    if (existing) return existing;
    const launching = (async () => {
      const { chromium } = await import('playwright-core');
      if (mode === 'headless' && this.options.headlessCdpUrl) {
        return chromium.connectOverCDP(this.options.headlessCdpUrl);
      }
      return chromium.launch({ channel: 'msedge', headless: mode === 'headless' });
    })();
    this.browsers.set(mode, launching);
    launching.catch(() => this.browsers.delete(mode));
    return launching;
  }

  private async pageFor(mode: BrowserMode): Promise<Page> {
    const existing = this.pages.get(mode);
    if (existing && !existing.isClosed()) return existing;
    const browser = await this.browserFor(mode);
    let context = this.contexts.get(mode);
    if (!context) {
      context = browser.contexts()[0] ?? await browser.newContext();
      this.contexts.set(mode, context);
    }
    const page = await context.newPage();
    // Every request, including redirects and subresources, must target a public address.
    await page.route('**/*', async (route) => {
      const requested = route.request().url();
      if (!/^https?:/i.test(requested)) return route.continue();
      try {
        const next = assertFetchableUrl(requested);
        await assertPublicHost(next);
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });
    this.pages.set(mode, page);
    return page;
  }

  /** Navigates only to public http(s) addresses. Redirects are validated by the browser's request handling below. */
  async open(mode: BrowserMode, rawUrl: string): Promise<{ url: string; title: string }> {
    const url = assertFetchableUrl(rawUrl);
    await assertPublicHost(url);
    const page = await this.pageFor(mode);
    await page.goto(url.toString(), { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    return { url: page.url(), title: await page.title() };
  }

  /** Returns the accessibility tree of the current page. Used by the agent to find element refs. */
  async snapshot(mode: BrowserMode): Promise<{ url: string; title: string; tree: string }> {
    const page = await this.requirePage(mode);
    const tree = await page.locator('body').ariaSnapshot({ timeout: ACTION_TIMEOUT_MS });
    return { url: page.url(), title: await page.title(), tree: tree.slice(0, MAX_SNAPSHOT_CHARS) };
  }

  /** Returns only metadata. Raw image data would flood the model context, and the user watches visible mode directly. */
  async screenshot(mode: BrowserMode): Promise<{ url: string; title: string; bytes: number }> {
    const page = await this.requirePage(mode);
    const buffer = await page.screenshot({ type: 'png', timeout: ACTION_TIMEOUT_MS });
    return { url: page.url(), title: await page.title(), bytes: buffer.length };
  }

  /** Clicks by visible text or role+name, not CSS selectors, so the agent acts on what the snapshot shows. */
  async click(mode: BrowserMode, role: string, name: string): Promise<{ url: string }> {
    const page = await this.requirePage(mode);
    await page.getByRole(role as Parameters<Page['getByRole']>[0], { name, exact: true }).first().click({ timeout: ACTION_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
    return { url: page.url() };
  }

  async type(mode: BrowserMode, role: string, name: string, text: string): Promise<{ url: string }> {
    const page = await this.requirePage(mode);
    await page.getByRole(role as Parameters<Page['getByRole']>[0], { name, exact: true }).first().fill(text, { timeout: ACTION_TIMEOUT_MS });
    return { url: page.url() };
  }

  /** Headless extraction: opens a URL and returns its visible text. Read-only. */
  async extract(rawUrl: string): Promise<{ url: string; title: string; text: string }> {
    const mode: BrowserMode = 'headless';
    await this.open(mode, rawUrl);
    const page = await this.requirePage(mode);
    const text = await page.locator('body').innerText({ timeout: ACTION_TIMEOUT_MS });
    return { url: page.url(), title: await page.title(), text: text.slice(0, MAX_EXTRACT_CHARS) };
  }

  private async requirePage(mode: BrowserMode): Promise<Page> {
    const page = this.pages.get(mode);
    if (!page || page.isClosed()) throw new Error(`No page is open in ${mode} browser. Call browser_open first.`);
    return page;
  }

  async close(): Promise<void> {
    for (const launching of this.browsers.values()) {
      const browser = await launching.catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
    this.browsers.clear();
    this.contexts.clear();
    this.pages.clear();
  }
}

const modeSchema = z.enum(['visible', 'headless']).default('visible');

/** Read-only browser tools. Visible mode is the user-watchable window; headless is for bulk extraction. */
export function createBrowserReadTools(sessions: BrowserSessions): RegisteredTool<unknown, unknown>[] {
  return [
    {
      name: 'browser_open',
      inputSchema: z.object({ url: z.string().trim().min(1).max(2000), mode: modeSchema }),
      effect: 'read',
      execute: async (input) => { const { url, mode } = input as { url: string; mode: BrowserMode }; return sessions.open(mode, url); },
    },
    {
      name: 'browser_snapshot',
      inputSchema: z.object({ mode: modeSchema }),
      effect: 'read',
      execute: async (input) => sessions.snapshot((input as { mode: BrowserMode }).mode),
    },
    {
      name: 'browser_screenshot',
      inputSchema: z.object({ mode: modeSchema }),
      effect: 'read',
      execute: async (input) => sessions.screenshot((input as { mode: BrowserMode }).mode),
    },
    {
      name: 'headless_extract',
      inputSchema: z.object({ url: z.string().trim().min(1).max(2000) }),
      effect: 'read',
      execute: async (input) => sessions.extract((input as { url: string }).url),
    },
  ];
}

/** State-changing browser tools. They are irreversible, so the tool gateway asks for approval before running. */
export function createBrowserActionTools(sessions: BrowserSessions): RegisteredTool<unknown, unknown>[] {
  return [
    {
      name: 'browser_click',
      inputSchema: z.object({ mode: modeSchema, role: z.string().min(1).max(40), name: z.string().min(1).max(200) }),
      effect: 'external',
      irreversible: true,
      execute: async (input) => {
        const { mode, role, name } = input as { mode: BrowserMode; role: string; name: string };
        return sessions.click(mode, role, name);
      },
    },
    {
      name: 'browser_type',
      inputSchema: z.object({ mode: modeSchema, role: z.string().min(1).max(40), name: z.string().min(1).max(200), text: z.string().max(2000) }),
      effect: 'external',
      irreversible: true,
      execute: async (input) => {
        const { mode, role, name, text } = input as { mode: BrowserMode; role: string; name: string; text: string };
        return sessions.type(mode, role, name, text);
      },
    },
  ];
}
