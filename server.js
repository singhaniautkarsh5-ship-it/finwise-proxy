// FinWise Proxy v3 — uses yahoo-finance2 for reliable data
const http  = require('http');
const urlModule = require('url');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const https = require('https');

const PORT          = process.env.PORT           || 3001;
const TD_KEY        = process.env.TD_KEY         || 'be5cb92f2c744ed98fd46f787a62088d';
const MARKETAUX_KEY = process.env.MARKETAUX_KEY  || '';
const ALLOWED       = process.env.ALLOWED_ORIGIN || '*';

let yf;
(async () => {
  const mod = await import('yahoo-finance2');
  yf = mod.default;
  // Suppress validation warnings
  yf.setGlobalConfig({ validation: { logErrors: false } });
  console.log('yahoo-finance2 ready');
})();

// ── CORS ──────────────────────────────────────────────────────
function cors(origin) {
  return {
    'Access-Control-Allow-Origin':  ALLOWED === '*' ? (origin || '*') : ALLOWED,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

// ── Simple HTTPS fetch (for Twelve Data + Marketaux) ─────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Market detection ─────────────────────────────────────────
function getMarket(s) {
  if (!s) return 'US';
  if (s.endsWith('.NS') || s.endsWith('.BO')) return 'IN';
  if (s.endsWith('.L'))  return 'UK';
  if (s.endsWith('.T'))  return 'JP';
  if (s.endsWith('.HK')) return 'HK';
  if (s.endsWith('.AX')) return 'AU';
  if (s.endsWith('.DE') || s.endsWith('.F')) return 'DE';
  return 'US';
}

// ── HTTP Server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const parsed = urlModule.parse(req.url, true);
  const path   = parsed.pathname;
  const q      = parsed.query;

  if (req.method === 'OPTIONS') { res.writeHead(204, cors(origin)); res.end(); return; }

  const json = (data, status = 200) => {
    res.writeHead(status, { ...cors(origin), 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // ── Health ──────────────────────────────────────────────────
  if (path === '/health') { json({ ok: true, version: '3.0', yf: !!yf }); return; }

  // ── /quote?symbol=AAPL,RELIANCE.NS ─────────────────────────
  if (path === '/quote') {
    const symbols = (q.symbol || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!symbols.length) { json([], 200); return; }

    // US stocks → Twelve Data (real-time); global → yahoo-finance2
    const us     = symbols.filter(s => getMarket(s) === 'US');
    const global = symbols.filter(s => getMarket(s) !== 'US');
    const results = [];

    if (us.length) {
      try {
        const url = `https://api.twelvedata.com/quote?symbol=${us.join(',')}&apikey=${TD_KEY}`;
        const data = await fetchJSON(url);
        const items = us.length === 1 ? [data] : Object.values(data || {});
        items.filter(d => d && parseFloat(d.close) > 0).forEach(d => results.push({
          symbol: d.symbol, price: parseFloat(d.close),
          changesPercentage: parseFloat(d.percent_change),
          change: parseFloat(d.change), open: parseFloat(d.open),
          dayHigh: parseFloat(d.high), dayLow: parseFloat(d.low),
          previousClose: parseFloat(d.previous_close),
          name: d.name || d.symbol, exchange: d.exchange || '',
        }));
      } catch(e) { console.warn('TD quote error:', e.message); }
      // Fill any TD misses from yahoo-finance2
      const tdFetched = new Set(results.map(r => r.symbol));
      const missed = us.filter(s => !tdFetched.has(s));
      if (missed.length) global.push(...missed);
    }

    if (global.length && yf) {
      try {
        const quotes = await yf.quote(global.length === 1 ? global[0] : global);
        const arr = Array.isArray(quotes) ? quotes : [quotes];
        arr.filter(d => d && d.regularMarketPrice).forEach(d => results.push({
          symbol: d.symbol, price: d.regularMarketPrice,
          changesPercentage: d.regularMarketChangePercent,
          change: d.regularMarketChange, open: d.regularMarketOpen,
          dayHigh: d.regularMarketDayHigh, dayLow: d.regularMarketDayLow,
          previousClose: d.regularMarketPreviousClose,
          name: d.shortName || d.longName || d.symbol,
          exchange: d.fullExchangeName || d.exchange || '',
          marketCap: d.marketCap,
        }));
      } catch(e) { console.warn('YF quote error:', e.message); }
    }
    json(results); return;
  }

  // ── /profile?symbol=AAPL ────────────────────────────────────
  if (path === '/profile') {
    const symbol = q.symbol || '';
    if (!symbol) { json({ error: 'symbol required' }, 400); return; }
    if (!yf) { json({ error: 'yahoo-finance2 not ready' }, 503); return; }
    console.log(`[profile] ${symbol}`);
    try {
      const result = await yf.quoteSummary(symbol, {
        modules: ['assetProfile', 'summaryDetail', 'price', 'financialData', 'defaultKeyStatistics'],
      });
      const p  = result.assetProfile        || {};
      const sd = result.summaryDetail        || {};
      const pr = result.price               || {};
      const fd = result.financialData       || {};
      const ks = result.defaultKeyStatistics || {};

      const profile = {
        symbol,
        name:             pr.shortName || pr.longName || symbol,
        description:      p.longBusinessSummary || '',
        sector:           p.sector    || '',
        industry:         p.industry  || '',
        hq:               [p.city, p.state, p.country].filter(Boolean).join(', '),
        employees:        p.fullTimeEmployees || null,
        website:          p.website   || '',
        exchange:         pr.exchangeName || '',
        marketCap:        pr.marketCap    || sd.marketCap,
        revenue:          fd.totalRevenue,
        // Ratios
        pe:               ks.trailingPE    || sd.trailingPE,
        pb:               ks.priceToBook,
        roe:              fd.returnOnEquity,
        de:               fd.debtToEquity,
        grossMargin:      fd.grossMargins,
        currentRatio:     fd.currentRatio,
        eps:              ks.trailingEps,
        forwardPE:        ks.forwardPE,
        dividendYield:    sd.dividendYield || sd.trailingAnnualDividendYield,
        beta:             sd.beta || ks.beta,
        fiftyTwoWeekHigh: sd.fiftyTwoWeekHigh,
        fiftyTwoWeekLow:  sd.fiftyTwoWeekLow,
        profitMargin:     fd.profitMargins,
        revenueGrowth:    fd.revenueGrowth,
      };
      console.log(`[profile] ${symbol} ok — pe:${profile.pe} roe:${profile.roe} sector:${profile.sector}`);
      json(profile);
    } catch(e) {
      console.error(`[profile] ${symbol} error:`, e.message);
      json({ symbol, name: symbol, description: '', sector: '', industry: '' });
    }
    return;
  }

  // ── /search?query=apple ─────────────────────────────────────
  if (path === '/search') {
    const query = q.query || q.symbol || '';
    if (!query) { json([], 200); return; }
    const results = [];
    // Twelve Data search (good for US)
    try {
      const url = `https://api.twelvedata.com/symbol_search?symbol=${encodeURIComponent(query)}&outputsize=6&apikey=${TD_KEY}`;
      const data = await fetchJSON(url);
      (data?.data || [])
        .filter(r => r.symbol && r.instrument_name && r.instrument_type === 'Common Stock')
        .forEach(r => results.push({ symbol: r.symbol, name: r.instrument_name, exchange: r.exchange || '' }));
    } catch(e) {}
    // Yahoo Finance search (better global/Indian coverage)
    if (yf) {
      try {
        const data = await yf.search(query, { quotesCount: 8, newsCount: 0 });
        (data.quotes || [])
          .filter(r => r.symbol && r.shortname && r.quoteType === 'EQUITY')
          .forEach(r => {
            if (!results.find(x => x.symbol === r.symbol))
              results.push({ symbol: r.symbol, name: r.shortname || r.longname, exchange: r.exchange || '' });
          });
      } catch(e) {}
    }
    json(results.slice(0, 10)); return;
  }

  // ── /time_series?symbol=AAPL&start_date=...&end_date=... ────
  if (path === '/time_series') {
    const symbol    = q.symbol || '';
    const startDate = q.start_date || '';
    const endDate   = q.end_date   || '';
    if (!symbol) { json({ error: 'symbol required' }, 400); return; }
    // US → try Twelve Data first
    if (getMarket(symbol) === 'US') {
      try {
        const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&start_date=${startDate}&end_date=${endDate}&outputsize=365&order=ASC&apikey=${TD_KEY}`;
        const data = await fetchJSON(url);
        if (data?.values?.length) { json(data); return; }
      } catch(e) {}
    }
    // Yahoo Finance historical (works for all markets)
    if (yf) {
      try {
        const from = new Date(startDate || Date.now() - 30*86400000);
        const to   = new Date(endDate   || Date.now());
        const data = await yf.historical(symbol, { period1: from, period2: to, interval: '1d' });
        const values = (data || []).map(d => ({
          datetime: d.date.toISOString().slice(0, 10),
          close:    d.close,
        }));
        json({ values }); return;
      } catch(e) { console.warn('historical error:', e.message); }
    }
    json({ values: [] }); return;
  }

  // ── /fx ─────────────────────────────────────────────────────
  if (path === '/fx') {
    if (!yf) { json([]); return; }
    try {
      const quotes = await yf.quote(['USDINR=X', 'USDGBP=X']);
      json((quotes || []).map(q => ({
        symbol: q.symbol,
        price:  q.regularMarketPrice,
      })));
    } catch(e) { json([]); }
    return;
  }

  // ── /news?type=company&symbols=AAPL ────────────────────────
  if (path === '/news') {
    if (!MARKETAUX_KEY) { json({ error: 'MARKETAUX_KEY not configured' }, 500); return; }
    const type    = q.type    || 'company';
    const symbols = q.symbols || '';
    const sector  = q.sector  || '';
    const country = q.country || '';
    try {
      let apiUrl;
      if (type === 'company' && symbols)
        apiUrl = `https://api.marketaux.com/v1/news/all?symbols=${encodeURIComponent(symbols)}&filter_entities=true&language=en&limit=8&api_token=${MARKETAUX_KEY}`;
      else if (type === 'sector' && sector)
        apiUrl = `https://api.marketaux.com/v1/news/all?industries=${encodeURIComponent(sector)}&filter_entities=true&language=en&limit=8&api_token=${MARKETAUX_KEY}`;
      else if (type === 'market' && country)
        apiUrl = `https://api.marketaux.com/v1/news/all?countries=${encodeURIComponent(country)}&filter_entities=true&language=en&limit=8&api_token=${MARKETAUX_KEY}`;
      else
        apiUrl = `https://api.marketaux.com/v1/news/all?filter_entities=true&language=en&limit=8&api_token=${MARKETAUX_KEY}`;
      const data = await fetchJSON(apiUrl);
      json(data || { data: [] });
    } catch(e) { json({ error: 'news fetch failed' }, 502); }
    return;
  }

  json({ error: 'Not found' }, 404);
});

// ── WebSocket proxy — Twelve Data real-time ──────────────────
const wss = new WebSocketServer({ server, path: '/ws/td' });
wss.on('connection', clientWs => {
  const upstream = new WebSocket(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${TD_KEY}`);
  upstream.on('message', d => { if (clientWs.readyState === 1) clientWs.send(d.toString()); });
  clientWs.on('message', d => { if (upstream.readyState  === 1) upstream.send(d.toString()); });
  upstream.on('close', () => clientWs.close());
  clientWs.on('close', () => upstream.close());
  upstream.on('error', e => { console.error('WS upstream:', e.message); clientWs.close(); });
  clientWs.on('error', e => { console.error('WS client:',   e.message); upstream.close(); });
});

server.listen(PORT, () => {
  console.log(`FinWise proxy v3 on :${PORT}`);
});
