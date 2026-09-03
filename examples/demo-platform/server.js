import http from 'node:http';

const items = new Map();
let nextId = 1;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/') return sendHtml(response, homePage());
  response.setHeader('content-type', 'application/json');
  if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { ok: true, service: 'demo-platform' });
  if (request.method === 'GET' && url.pathname === '/items') {
    const prefix = url.searchParams.get('prefix');
    const values = [...items.values()].filter((item) => !prefix || item.name.startsWith(prefix));
    return send(response, 200, { items: values });
  }
  if (request.method === 'POST' && url.pathname === '/items') {
    const body = await readBody(request);
    if (!body.name || typeof body.name !== 'string') return send(response, 400, { error: 'name_required' });
    const item = { id: String(nextId++), name: body.name };
    items.set(item.id, item);
    return send(response, 201, item);
  }
  const match = url.pathname.match(/^\/items\/(\w+)$/);
  if (request.method === 'DELETE' && match) {
    if (!items.delete(match[1])) return send(response, 404, { error: 'not_found' });
    return send(response, 204, null);
  }
  return send(response, 404, { error: 'not_found' });
});

const port = Number(process.env.DEMO_PORT || 4317);
server.listen(port, '127.0.0.1', () => console.log(`demo-platform listening on http://127.0.0.1:${port}`));
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));

function homePage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Public Demo Platform</title><style>body{font:16px system-ui;margin:40px;max-width:720px;color:#18202a}main{border:1px solid #d9dee5;padding:24px;border-radius:8px}ul{padding-left:20px}li{margin:8px 0}</style></head><body><main><h1 data-testid="demo-title">Public Demo Platform</h1><p data-testid="demo-description">A local platform for safe adapter and soak tests.</p><h2>Items</h2><ul data-testid="items"></ul></main><script>fetch('/items').then((r)=>r.json()).then(({items})=>{document.querySelector('[data-testid="items"]').innerHTML=items.map((item)=>'<li>'+item.name+'</li>').join('')||'<li>no items</li>'})</script></body></html>`;
}
function send(response, status, body) { response.statusCode = status; response.end(body === null ? undefined : JSON.stringify(body)); }
function sendHtml(response, body) { response.statusCode = 200; response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(body); }
function readBody(request) { return new Promise((resolve, reject) => { let raw = ''; request.on('data', (chunk) => { raw += chunk; }); request.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); } }); request.on('error', reject); }); }
