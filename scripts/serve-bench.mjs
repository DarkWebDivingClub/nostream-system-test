import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..', 'bench');
const projectRoot = path.resolve(__dirname, '..');
const nodeModulesRoot = path.resolve(projectRoot, 'node_modules');
const port = Number(process.env.BENCH_PORT ?? '4174');

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function resolvePath(urlPathname) {
  const clean = decodeURIComponent((urlPathname || '/').split('?')[0]);
  const requested = clean === '/' ? '/videojs-dash.html' : clean;

  if (requested.startsWith('/node_modules/')) {
    const full = path.resolve(projectRoot, `.${requested}`);
    if (!full.startsWith(nodeModulesRoot)) {
      return null;
    }
    return full;
  }

  const full = path.resolve(root, `.${requested}`);
  if (!full.startsWith(root)) {
    return null;
  }

  return full;
}

const server = http.createServer((req, res) => {
  const fullPath = resolvePath(req.url || '/');
  if (!fullPath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = contentTypes[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[bench] serving ${root} on http://0.0.0.0:${port}/videojs-dash.html`);
});
