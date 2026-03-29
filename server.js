import http from 'http';
import https from 'https';
import { parse } from 'url';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

const PORT          = process.env.PORT           || 3001;
const TD_KEY        = process.env.TD_KEY         || 'be5cb92f2c744ed98fd46f787a62088d';
const FMP_KEY       = process.env.FMP_KEY        || '0QaZFReu3rNLGWHlfuYwehPHOX99PfC0';
const MARKETAUX_KEY = process.env.MARKETAUX_KEY  || '';
const ALLOWED       = process.env.ALLOWED_ORIGIN || '*';

const FMP = 'https://financialmodelingprep.com/api/v3';
const TD  = 'https://api.twelvedata.com';

function cors(origin) {
  return {
    'Access-Control-Allow-Origin':  ALLOWED === '*' ? (origin || '*') : ALLOWED,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      headers:  { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch(e) { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

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

// FMP quote — works for US stocks, server-side no CORS issue
async function fmpQuote(symbols) {
  const { body } = await get(`${FMP}/quote/${symbols.join(',')}?apikey=${FMP_KEY}`);
  if (!Array.isArray(body)) return [];
  return body.filter(d => d?.price > 0).map(d => ({
    symbol: d.symbol, price: d.price,
    changesPercentage: d.changesPercentage, change: d.change,
    open: d.open, dayHigh: d.dayHigh, dayLow: d.dayLow,
    previousClose: d.previousClose, name: d.name || d.symbol,
    exchange: d.exchange || '', marketCap: d.marketCap,
  }));
}

// Twelve Data quote — US real-time
async function tdQuote(symbols) {
  const { body } = await get(`${TD}/quote?symbol=${symbols.join(',')}&apikey=${TD_KEY}`);
  if (!body) return [];
  const items = symbols.length === 1 ? [body] : Object.values(body);
  return items.filter(d => d && parseFloat(d.close) > 0).map(d => ({
    symbol: d.symbol, price: parseFloat(d.close),
    changesPercentage: parseFloat(d.percent_change), change: parseFloat(d.change),
    open: parseFloat(d.open), dayHigh: parseFloat(d.high), dayLow: parseFloat(d.low),
    previousClose: parseFloat(d.previous_close), name: d.name || d.symbol, exchange: d.exchange || '',
  }));
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const parsed = parse(req.url, true);
  const path   = parsed.pathname;
  const q      = parsed.query;

  if (req.method === 'OPTIONS') { res.writeHead(204, cors(origin)); res.end(); return; }

  const json = (data, status = 200) => {
    res.writeHead(status, { ...cors(origin), 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // /health
  if (path === '/health') { json({ ok: true, version: '5.0', apis: 'TD+FMP+Marketaux' }); return; }

  // /quote?symbol=AAPL,RELIANCE.NS
  if (path === '/quote') {
    const symbols    = (q.symbol || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!symbols.length) { json([]); return; }
    const usSyms     = symbols.filter(s => getMarket(s) === 'US');
    const globalSyms = symbols.filter(s => getMarket(s) !== 'US');
    const results    = [];

    // US → Twelve Data first, FMP fallback
    if (usSyms.length) {
      try {
        const tdResults = await tdQuote(usSyms);
        results.push(...tdResults);
        const fetched = new Set(tdResults.map(r => r.symbol));
        const missed  = usSyms.filter(s => !fetched.has(s));
        if (missed.length) {
          const fmpResults = await fmpQuote(missed);
          results.push(...fmpResults);
        }
      } catch(e) {
        try { results.push(...await fmpQuote(usSyms)); } catch(e2) {}
      }
    }

    // Global → FMP (supports many exchanges)
    if (globalSyms.length) {
      try {
        const fmpResults = await fmpQuote(globalSyms);
        results.push(...fmpResults);
        // Any FMP missed → try TD
        const fetched = new Set(fmpResults.map(r => r.symbol));
        const missed  = globalSyms.filter(s => !fetched.has(s));
        if (missed.length) {
          const tdResults = await tdQuote(missed);
          results.push(...tdResults);
        }
      } catch(e) {}
    }

    json(results); return;
  }

  // /profile?symbol=AAPL  — FMP profile + ratios-ttm
  if (path === '/profile') {
    const symbol = q.symbol || '';
    if (!symbol) { json({ error: 'symbol required' }, 400); return; }
    console.log(`[profile] ${symbol}`);
    try {
      const [profRes, ratioRes] = await Promise.all([
        get(`${FMP}/profile/${encodeURIComponent(symbol)}?apikey=${FMP_KEY}`),
        get(`${FMP}/ratios-ttm/${encodeURIComponent(symbol)}?apikey=${FMP_KEY}`),
      ]);

      const p = Array.isArray(profRes.body)  ? profRes.body[0]  : null;
      const r = Array.isArray(ratioRes.body) ? ratioRes.body[0] : null;

      if (!p) throw new Error(`FMP profile empty for ${symbol}`);

      const profile = {
        symbol,
        name:         p.companyName       || symbol,
        description:  p.description       || '',
        sector:       p.sector            || '',
        industry:     p.industry          || '',
        hq:           [p.city, p.state, p.country].filter(Boolean).join(', '),
        employees:    p.fullTimeEmployees  || null,
        website:      p.website           || '',
        exchange:     p.exchangeShortName || p.exchange || '',
        marketCap:    p.mktCap,
        revenue:      null,
        // Ratios from FMP ratios-ttm (reliable, free tier)
        pe:           r?.peRatioTTM,
        pb:           r?.priceToBookRatioTTM,
        roe:          r?.returnOnEquityTTM,
        de:           r?.debtEquityRatioTTM,
        grossMargin:  r?.grossProfitMarginTTM,
        currentRatio: r?.currentRatioTTM,
        eps:          r?.netIncomePerShareTTM,
        forwardPE:    null,
        dividendYield:r?.dividendYieldTTM,
        beta:         p.beta,
        fiftyTwoWeekHigh: p['52WeekHigh'] || p.range?.split('-')?.[1]?.trim() || null,
        fiftyTwoWeekLow:  p['52WeekLow']  || p.range?.split('-')?.[0]?.trim() || null,
        profitMargin: r?.netProfitMarginTTM,
        revenueGrowth: null,
      };

      console.log(`[profile] ${symbol} ok — pe:${profile.pe} sector:${profile.sector}`);
      json(profile);
    } catch(e) {
      console.error(`[profile] ${symbol} failed:`, e.message);
      json({ symbol, name: symbol, description: '', sector: '', industry: '', _error: e.message });
    }
    return;
  }

  // /search?query=apple
  if (path === '/search') {
    const query = q.query || q.symbol || '';
    if (!query) { json([]); return; }
    const results = [];
    // TD search (good for global)
    try {
      const { body } = await get(`${TD}/symbol_search?symbol=${encodeURIComponent(query)}&outputsize=6&apikey=${TD_KEY}`);
      (body?.data || []).filter(r => r.symbol && r.instrument_name && r.instrument_type === 'Common Stock')
        .forEach(r => results.push({ symbol: r.symbol, name: r.instrument_name, exchange: r.exchange || '' }));
    } catch(e) {}
    // FMP search (good for US)
    try {
      const { body } = await get(`${FMP}/search?query=${encodeURIComponent(query)}&limit=8&apikey=${FMP_KEY}`);
      (Array.isArray(body) ? body : []).filter(r => r.symbol && r.name)
        .forEach(r => { if (!results.find(x => x.symbol === r.symbol))
          results.push({ symbol: r.symbol, name: r.name, exchange: r.stockExchange || r.exchangeShortName || '' }); });
    } catch(e) {}
    json(results.slice(0, 10)); return;
  }

  // /time_series
  if (path === '/time_series') {
    const symbol = q.symbol || '';
    if (!symbol) { json({ values: [] }); return; }
    // TD first (US, real-time accurate)
    if (getMarket(symbol) === 'US') {
      try {
        const { body } = await get(`${TD}/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&start_date=${q.start_date||''}&end_date=${q.end_date||''}&outputsize=365&order=ASC&apikey=${TD_KEY}`);
        if (body?.values?.length) { json(body); return; }
      } catch(e) {}
    }
    // FMP historical (global coverage)
    try {
      const { body } = await get(`${FMP}/historical-price-full/${encodeURIComponent(symbol)}?from=${q.start_date||''}&to=${q.end_date||''}&apikey=${FMP_KEY}`);
      const hist = body?.historical || [];
      json({ values: [...hist].reverse().map(d => ({ datetime: d.date, close: d.close })) });
    } catch(e) { json({ values: [] }); }
    return;
  }

  // /fx
  if (path === '/fx') {
    try {
      const { body } = await get(`${FMP}/quote/USDINR,USDGBP?apikey=${FMP_KEY}`);
      json(Array.isArray(body) ? body.map(d => ({ symbol: d.symbol, price: d.price })) : []);
    } catch(e) { json([]); }
    return;
  }

  // /news
  if (path === '/news') {
    if (!MARKETAUX_KEY) { json({ error: 'MARKETAUX_KEY not set' }, 500); return; }
    const type = q.type || 'company';
    let url;
    if (type === 'company' && q.symbols)
      url = `https://api.marketaux.com/v1/news/all?symbols=${encodeURIComponent(q.symbols)}&filter_entities=true&language=en&limit=8&api_token=${MARKETAUX_KEY}`;
    else if (type === 'sector' && q.sector)
      url = `https://api.marketaux.com/v1/news/all?industries=${encodeURIComponent(q.sector)}&filter_entities=true&language=en&limit=8&api_token=${MARKETAUX_KEY}`;
    else if (type === 'market' && q.country)
      url = `https://api.marketaux.com/v1/news/all?countries=${encodeURIComponent(q.country)}&filter_entities=true&language=en&limit=8&api_token=${MARKETAUX_KEY}`;
    else
      url = `https://api.marketaux.com/v1/news/all?filter_entities=true&language=en&limit=8&api_token=${MARKETAUX_KEY}`;
    try { const { body } = await get(url); json(body || { data: [] }); }
    catch(e) { json({ error: 'news failed' }, 502); }
    return;
  }

  json({ error: 'not found' }, 404);
});

// ── WebSocket — Twelve Data real-time ────────────────────────
const wss = new WebSocketServer({ server, path: '/ws/td' });
wss.on('connection', clientWs => {
  const upstream = new WebSocket(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${TD_KEY}`);
  upstream.on('message', d => { if (clientWs.readyState === 1) clientWs.send(d.toString()); });
  clientWs.on('message', d => { if (upstream.readyState  === 1) upstream.send(d.toString()); });
  upstream.on('close', () => clientWs.close());
  clientWs.on('close', () => upstream.close());
  upstream.on('error', e => { console.error('WS up:', e.message); clientWs.close(); });
  clientWs.on('error', e => { console.error('WS cl:', e.message); upstream.close(); });
});

server.listen(PORT, () => console.log(`FinWise proxy v5.0 on :${PORT}`));
