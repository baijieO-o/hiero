import { strict as assert } from 'node:assert';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { McpToolClient } from '../src/mcp-client.js';

function echoServer(): McpServer {
  const server = new McpServer({ name: 'echo-test', version: '1.0.0' });
  server.registerTool('echo', { description: 'Echoes the input text', inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: 'text', text: `echo:${text}` }],
  }));
  return server;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', (chunk) => { data += chunk; });
    request.on('end', () => {
      try { resolve(data ? JSON.parse(data) : undefined); } catch (cause) { reject(cause); }
    });
    request.on('error', reject);
  });
}

async function serveSse(): Promise<{ url: string; close: () => Promise<void> }> {
  const transports = new Map<string, SSEServerTransport>();
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', response);
      transports.set(transport.sessionId, transport);
      response.on('close', () => transports.delete(transport.sessionId));
      await echoServer().connect(transport);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/messages') {
      const transport = transports.get(url.searchParams.get('sessionId') ?? '');
      if (!transport) { response.writeHead(404).end(); return; }
      await transport.handlePostMessage(request, response, await readBody(request));
      return;
    }
    response.writeHead(404).end();
  });
  const base = await listen(server);
  return { url: `${base}/sse`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function serveStreamableHttp(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp') { response.writeHead(404).end(); return; }
    const transport = new StreamableHTTPServerTransport({});
    response.on('close', () => { void transport.close(); });
    await echoServer().connect(transport);
    await transport.handleRequest(request, response, await readBody(request));
  });
  const base = await listen(server);
  return { url: `${base}/mcp`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test('an SSE MCP server is discovered and its tool can be called end to end', async () => {
  const remote = await serveSse();
  const client = new McpToolClient();
  try {
    await client.connect({ name: 'remote-sse', transport: 'sse', url: remote.url });
    const tools = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['echo']);
    assert.deepEqual(client.statuses(['remote-sse']), [{ name: 'remote-sse', connected: true, tool_count: 1 }]);

    const result = await client.callTool('echo', { text: 'hi' }) as { content: { text: string }[] };
    assert.equal(result.content[0]?.text, 'echo:hi');
  } finally {
    await client.close();
    await remote.close();
  }
});

test('a Streamable HTTP MCP server is discovered and its tool can be called end to end', async () => {
  const remote = await serveStreamableHttp();
  const client = new McpToolClient();
  try {
    await client.connect({ name: 'remote-http', transport: 'http', url: remote.url });
    const tools = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['echo']);

    const result = await client.callTool('echo', { text: 'there' }) as { content: { text: string }[] };
    assert.equal(result.content[0]?.text, 'echo:there');
  } finally {
    await client.close();
    await remote.close();
  }
});
