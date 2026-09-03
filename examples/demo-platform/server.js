import http from 'node:http';

const items = new Map();
let nextId = 1;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('content-type', 'application/json');
  if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { ok: true, service: 'demo-platform' });
  if (request.method === 'GET' && url.pathname === '/items') return send(response, 200, { items: [...items.values()] });
  if (request.method === 'POST' && url.pathname === '/items') { const body = await readBody(request); if (!body.name) return send(response, 400, { error: 'name_required' }); const item = { id: String(nextId++), name: body.name }; items.set(item.id, item); return send(response, 201, item); }
  const match = url.pathname.match(/^\/items\/(\w+)$/);
  if (request.method === 'DELETE' && match) { if (!items.delete(match[1])) return send(response, 404, { error: 'not_found' }); return send(response, 204, null); }
  send(response, 404, { error: 'not_found' });
});
const port = Number(process.env.DEMO_PORT || 4317);
server.listen(port, '127.0.0.1', () => console.log(`demo-platform listening on http://127.0.0.1:${port}`));
function send(response, status, body) { response.statusCode = status; if (body !== null) response.end(JSON.stringify(body)); else response.end(); }
function readBody(request) { return new Promise((resolve, reject) => { let raw = ''; request.on('data', (chunk) => { raw += chunk; }); request.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); } }); request.on('error', reject); }); }
