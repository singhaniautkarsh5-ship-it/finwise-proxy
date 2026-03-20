// FinWise Proxy Server — proxies Twelve Data (REST + WebSocket)
// Deploy free on Render.com — see README below
// ─────────────────────────────────────────────────────────────
const http  = require('http');
const https = require('https');
const url   = require('url');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');

const PORT    = process.env.PORT     || 3001;
const TD_KEY  = process.env.TD_KEY   || 'be5cb92f2c744ed98fd46f787a62088d';
const ALLOWED = process.env.ALLOWED_ORIGIN || '*';

function cors(origin) {
  return {
    'Access-Control-Allow-Origin':  ALLOWED === '*' ? (origin || '*') : ALLOWED,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

function fetchUpstream(targetUrl) {
  return new Promise((resolve, reject) => {
    https.get(targetUrl, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch(e) { resolve({ status: res.statusCode, body: {} }); }
      });
    }).on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, cors(origin)); res.end(); return; }
  if (path === '/health') {
    res.writeHead(200, { ...cors(origin), 'Content-Type':'application/json' });
    res.end(JSON.stringify({ ok: true })); return;
  }
  if (path === '/proxy/td') {
    const endpoint = parsed.query.path;
    if (!endpoint) { res.writeHead(400, cors(origin)); res.end('{}'); return; }
    const upstream = new URL(`https://api.twelvedata.com/${endpoint}`);
    upstream.searchParams.set('apikey', TD_KEY);
    Object.entries(parsed.query).forEach(([k, v]) => { if (k !== 'path') upstream.searchParams.set(k, v); });
    try {
      const { status, body } = await fetchUpstream(upstream.toString());
      res.writeHead(status, { ...cors(origin), 'Content-Type':'application/json' });
      res.end(JSON.stringify(body));
    } catch(e) {
      res.writeHead(502, cors(origin)); res.end(JSON.stringify({ error: 'upstream failed' }));
    }
    return;
  }
  res.writeHead(404, cors(origin)); res.end('{}');
});

const wss = new WebSocketServer({ server, path: '/ws/td' });
wss.on('connection', clientWs => {
  const upstream = new WebSocket(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${TD_KEY}`);
  upstream.on('message', d  => { if (clientWs.readyState === 1) clientWs.send(d.toString()); });
  clientWs.on('message', d  => { if (upstream.readyState  === 1) upstream.send(d.toString()); });
  upstream.on('close',   () => clientWs.close());
  clientWs.on('close',  () => upstream.close());
  upstream.on('error',   e  => { console.error('WS upstream:', e.message); clientWs.close(); });
  clientWs.on('error',   e  => { console.error('WS client:',   e.message); upstream.close(); });
});

server.listen(PORT, () => {
  console.log(`FinWise proxy on :${PORT}`);
  console.log(`  Test: http://localhost:${PORT}/health`);
});
