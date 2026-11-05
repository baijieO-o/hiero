import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertFetchableUrl, fetchWebPage, htmlToText, isBlockedAddress, parseDuckDuckGoHtml, searchWeb } from '../src/web-tools.js';

test('isBlockedAddress rejects loopback, private, link-local and mapped private addresses', () => {
  for (const host of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', '::ffff:127.0.0.1', 'localhost', 'api.local']) {
    assert.equal(isBlockedAddress(host), true, host);
  }
  for (const host of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) {
    assert.equal(isBlockedAddress(host), false, host);
  }
});

test('assertFetchableUrl refuses non-http schemes, credentials and private targets', () => {
  assert.throws(() => assertFetchableUrl('file:///etc/passwd'), /Only http and https/);
  assert.throws(() => assertFetchableUrl('http://user:pw@example.com/'), /credentials/);
  assert.throws(() => assertFetchableUrl('http://127.0.0.1:8080/'), /not allowed/);
  assert.throws(() => assertFetchableUrl('not a url'), /Invalid URL/);
  assert.equal(assertFetchableUrl('https://example.com/a').hostname, 'example.com');
});

test('htmlToText strips scripts, styles and tags', () => {
  const text = htmlToText('<html><style>p{}</style><script>alert(1)</script><h1>Title</h1><p>A &amp; B</p></html>');
  assert.equal(text.includes('alert'), false);
  assert.equal(text.includes('p{}'), false);
  assert.ok(text.includes('Title'));
  assert.ok(text.includes('A & B'));
});

test('fetchWebPage follows a validated redirect and returns text', async () => {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const href = input instanceof URL ? input.href : String(input);
    calls.push(href);
    if (href === 'https://example.com/start') {
      return new Response(null, { status: 302, headers: { location: '/final' } });
    }
    return new Response('<p>Hello <b>world</b></p>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }) as typeof fetch;
  const lookup = (async () => [{ address: '93.184.216.34', family: 4 }]) as never;
  const result = await fetchWebPage('https://example.com/start', fetcher, lookup);
  assert.deepEqual(calls, ['https://example.com/start', 'https://example.com/final']);
  assert.equal(result.status, 200);
  assert.equal(result.text, 'Hello world');
});

test('fetchWebPage refuses a redirect to a private address', async () => {
  const fetcher = (async () => new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/latest' } })) as typeof fetch;
  const lookup = (async () => [{ address: '93.184.216.34', family: 4 }]) as never;
  await assert.rejects(fetchWebPage('https://example.com/', fetcher, lookup), /not allowed/);
});

test('fetchWebPage refuses hostnames that resolve to private addresses', async () => {
  const fetcher = (async () => new Response('x')) as typeof fetch;
  const lookup = (async () => [{ address: '10.0.0.5', family: 4 }]) as never;
  await assert.rejects(fetchWebPage('https://internal.example.com/', fetcher, lookup), /resolves to a private/);
});

test('searchWeb falls back to DuckDuckGo when no Brave key is set', async () => {
  let seenUrl = '';
  const html = '<div class="result results_links"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fx&amp;rut=1">Ex <b>Title</b></a></h2><a class="result__snippet" href="#">A snippet</a></div>';
  const fetcher = (async (input: string | URL | Request) => { seenUrl = String(input); return new Response(html, { status: 200 }); }) as typeof fetch;
  const results = await searchWeb('hello world', 3, undefined, fetcher);
  assert.ok(seenUrl.startsWith('https://html.duckduckgo.com/html/'));
  assert.deepEqual(results, [{ title: 'Ex Title', url: 'https://example.test/x', description: 'A snippet' }]);
});

test('searchWeb reports a DuckDuckGo bot-challenge page instead of returning no results', async () => {
  const fetcher = (async () => new Response('<html><div class="anomaly-modal">challenge</div></html>', { status: 202 })) as typeof fetch;
  await assert.rejects(searchWeb('weibo hot search', 5, undefined, fetcher), /bot-challenge/);
});

test('searchWeb reports when DuckDuckGo returns no parseable results', async () => {
  const fetcher = (async () => new Response('<html><body>nothing</body></html>', { status: 200 })) as typeof fetch;
  await assert.rejects(searchWeb('weibo hot search', 5, undefined, fetcher), /no parseable results/);
});

test('parseDuckDuckGoHtml respects count and skips non-http links', () => {
  const block = (href: string) => `<div class="result"><a class="result__a" href="${href}">T</a><a class="result__snippet">S</a></div>`;
  const html = block('javascript:void(0)') + block('https://a.test') + block('https://b.test') + block('https://c.test');
  assert.deepEqual(parseDuckDuckGoHtml(html, 2).map((item) => item.url), ['https://a.test', 'https://b.test']);
});

test('searchWeb sends the key in a header and maps results', async () => {
  let seenKey = '';
  let seenUrl = '';
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(input);
    seenKey = String((init?.headers as Record<string, string>)['x-subscription-token']);
    return new Response(JSON.stringify({ web: { results: [{ title: 'T <b>1</b>', url: 'https://a.test', description: 'D' }, { title: 'no url' }] } }), { status: 200 });
  }) as typeof fetch;
  const results = await searchWeb('hello world', 5, 'secret-key', fetcher);
  assert.equal(seenKey, 'secret-key');
  assert.ok(seenUrl.includes('q=hello+world'));
  assert.deepEqual(results, [{ title: 'T 1', url: 'https://a.test', description: 'D' }]);
});
