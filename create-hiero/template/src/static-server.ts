import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

/** Default location of the built UI: `<package>/frontend/dist`, relative to `dist/src/`. */
export function defaultFrontendDir(): string {
  return fileURLToPath(new URL('../../frontend/dist/', import.meta.url));
}

/**
 * Serves the built frontend on loopback only. Requests outside `frontendDir` are rejected,
 * so path traversal cannot read other files.
 */
export function startStaticServer(port: number, frontendDir = defaultFrontendDir()): Server {
  const root = resolve(frontendDir);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const target = normalize(join(root, relative));
      if (target !== root && !target.startsWith(root + sep)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const info = await stat(target).catch(() => undefined);
      if (!info?.isFile()) {
        res.writeHead(404).end('Not found');
        return;
      }
      const body = await readFile(target);
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(500).end('Internal error');
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}
