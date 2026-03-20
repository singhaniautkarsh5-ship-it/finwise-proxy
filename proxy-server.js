// FinWise Proxy Server v2
// Routes:
//   US stocks      → Twelve Data REST + WebSocket
//   Indian stocks  → NSE/BSE via Yahoo Finance (free, no key)
//   Global stocks  → Yahoo Finance fallback (free, no key)
//   Search         → Twelve Data symbol_search
// ─────────────────────────────────────────────────────────────
const http      = require('http');
const https     = require('https');
const urlModule = require('url');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');

const PORT    = process.env.PORT            || 3001;
const TD_KEY  = process.env.TD_KEY          || 'be5cb92f2c744ed98fd46f787a62088d';
const ALLOWED = process.env.ALLOWED_ORIGIN  || '*';

// ── CORS ──────────────────────────────────────────────────────
function cors(origin) {
  return {
    'Access-Control-Allow-Origin':  ALLOWED === '*' ? (origin || '*') : ALLOWED,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

// ── Generic HTTPS fetch ───────────────────────────────────────
function fetchJSON(targetUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const opts = new URL(targetUrl);
    https.get({
      hostname: opts.hostname,
      path:     opts.pathname + opts.search,
      headers:  { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...extraHeaders },
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch(e) { resolve({ status: res.statusCode, body: { raw: body.slice(0, 200) } }); }
      });
    }).on('error', reject);
  });
}

// ── Detect market from ticker ─────────────────────────────────
function getMarket(symbol) {
  if (!symbol) return 'US';
  if (symbol.endsWith('.NS') || symbol.endsWith('.BO')) return 'IN';
  if (symbol.endsWith('.L'))  return 'UK';
  if (symbol.endsWith('.T'))  return 'JP';
  if (symbol.endsWith('.HK')) return 'HK';
  if (symbol.endsWith('.AX')) return 'AU';
  if (symbol.endsWith('.DE') || symbol.endsWith('.F')) return 'DE';
  if (symbol.endsWith('.PA')) return 'FR';
  if (symbol.endsWith('.TO')) return 'CA';
  return 'US';
}

// ── Yahoo Finance quote (works for all global tickers) ────────
async function yahooQuote(symbols) {
  const syms = symbols.join(',');
  const url = `https://query1.finance.yahoo.com/v8/finance/quote?symbols=${encodeURIComponent(syms)}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketChange,regularMarketOpen,regularMarketDayHigh,regularMarketDayLow,regularMarketPreviousClose,shortName,longName,exchange,sector,industry,marketCap`;
  try {
    const { body } = await fetchJSON(url, { 'Cookie': 'GUC=xxx' });
    const items = body?.quoteResponse?.result || [];
    return items.map(q => ({
      symbol:            q.symbol,
      price:             q.regularMarketPrice,
      changesPercentage: q.regularMarketChangePercent,
      change:            q.regularMarketChange,
      open:              q.regularMarketOpen,
      high:              q.regularMarketDayHigh,
      low:               q.regularMarketDayLow,
      previous_close:    q.regularMarketPreviousClose,
      name:              q.shortName || q.longName || q.symbol,
      exchange:          q.exchange || '',
      sector:            q.sector || '',
      industry:          q.industry || '',
      close:             q.regularMarketPrice,
      percent_change:    q.regularMarketChangePercent,
    }));
  } catch(e) { return []; }
}

// ── Twelve Data quote (US stocks only) ───────────────────────
async function tdQuote(symbols) {
  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbols.join(','))}&apikey=${TD_KEY}`;
  try {
    const { body } = await fetchJSON(url);
    if (!body) return [];
    // TD returns single object for 1 symbol, keyed object for many
    const items = Array.isArray(body) ? body
                : symbols.length === 1 ? [body]
                : Object.values(body);
    return items.filter(q => q && q.symbol && parseFloat(q.close) > 0).map(q => ({
      symbol:            q.symbol,
      price:             parseFloat(q.close),
      changesPercentage: parseFloat(q.percent_change),
      change:            parseFloat(q.change),
      open:              parseFloat(q.open),
      high:              parseFloat(q.high),
      low:               parseFloat(q.low),
      previous_close:    parseFloat(q.previous_close),
      name:              q.name || q.symbol,
      exchange:          q.exchange || '',
      close:             parseFloat(q.close),
      percent_change:    parseFloat(q.percent_change),
    }));
  } catch(e) { return []; }
}

// ── Smart quote router ────────────────────────────────────────
// US tickers → Twelve Data (more accurate real-time)
// All others → Yahoo Finance (global coverage)
async function smartQuote(symbols) {
  const usSymbols    = symbols.filter(s => getMarket(s) === 'US');
  const globalSymbols = symbols.filter(s => getMarket(s) !== 'US');
  const results = [];
  if (usSymbols.length) {
    const tdResults = await tdQuote(usSymbols);
    // If TD failed for any US symbol, fall back to Yahoo
    const tdFetched = new Set(tdResults.map(r => r.symbol));
    const missed = usSymbols.filter(s => !tdFetched.has(s));
    results.push(...tdResults);
    if (missed.length) {
      const yf = await yahooQuote(missed);
      results.push(...yf);
    }
  }
  if (globalSymbols.length) {
    const yf = await yahooQuote(globalSymbols);
    results.push(...yf);
  }
  return results;
}

// ── Yahoo Finance historical data ─────────────────────────────
async function yahooHistorical(symbol, from, to) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${from}&period2=${to}`;
  try {
    const { body } = await fetchJSON(url, { 'Cookie': 'GUC=xxx' });
    const chart = body?.chart?.result?.[0];
    if (!chart) return [];
    const timestamps = chart.timestamp || [];
    const closes     = chart.indicators?.quote?.[0]?.close || [];
    return timestamps.map((ts, i) => ({
      datetime: new Date(ts * 1000).toISOString().slice(0, 10),
      close:    closes[i],
    })).filter(d => d.close != null);
  } catch(e) { return []; }
}

// ── Yahoo Finance profile ─────────────────────────────────────
async function yahooProfile(symbol) {
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=assetProfile,price,financialData,defaultKeyStatistics`;
  try {
    const { body } = await fetchJSON(url, { 'Cookie': 'GUC=xxx' });
    const r = body?.quoteSummary?.result?.[0];
    if (!r) return null;
    const p = r.assetProfile || {}, pr = r.price || {}, fd = r.financialData || {}, ks = r.defaultKeyStatistics || {};
    return {
      symbol, name: pr.shortName || pr.longName || symbol,
      description: p.longBusinessSummary || '',
      sector: p.sector || '', industry: p.industry || '',
      hq: [p.city, p.state, p.country].filter(Boolean).join(', '),
      employees: p.fullTimeEmployees || null,
      website: p.website || '', exchange: pr.exchangeName || '',
      marketCap: pr.marketCap?.raw, revenue: fd.totalRevenue?.raw,
      pe: ks.trailingPE?.raw, pb: ks.priceToBook?.raw,
      roe: fd.returnOnEquity?.raw, de: fd.debtToEquity?.raw,
      grossMargin: fd.grossMargins?.raw, currentRatio: fd.currentRatio?.raw,
      eps: ks.trailingEps?.raw,
    };
  } catch(e) { return null; }
}

// ── Yahoo Finance search ──────────────────────────────────────
async function yahooSearch(query) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`;
  try {
    const { body } = await fetchJSON(url, { 'Cookie': 'GUC=xxx' });
    const quotes = body?.finance?.result?.[0]?.quotes || body?.quotes || [];
    return quotes
      .filter(r => r.symbol && (r.shortname || r.longname) && r.quoteType === 'EQUITY')
      .slice(0, 10)
      .map(r => ({ symbol: r.symbol, name: r.shortname || r.longname, exchange: r.exchange || '' }));
  } catch(e) { return []; }
}

// ── HTTP Request Handler ──────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const origin  = req.headers.origin;
  const parsed  = urlModule.parse(req.url, true);
  const path    = parsed.pathname;
  const q       = parsed.query;

  if (req.method === 'OPTIONS') { res.writeHead(204, cors(origin)); res.end(); return; }

  const json = (data, status = 200) => {
    res.writeHead(status, { ...cors(origin), 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (path === '/health') { json({ ok: true, version: '2.0' }); return; }

  // /quote?symbol=AAPL,RELIANCE.NS,700.HK
  if (path === '/quote') {
    const symbols = (q.symbol || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!symbols.length) { json({ error: 'symbol required' }, 400); return; }
    const results = await smartQuote(symbols);
    json(results); return;
  }

  // /time_series?symbol=AAPL&start_date=2024-01-01&end_date=2024-12-31
  if (path === '/time_series') {
    const symbol    = q.symbol || '';
    const startDate = q.start_date || '';
    const endDate   = q.end_date   || '';
    if (!symbol) { json({ error: 'symbol required' }, 400); return; }
    const from = Math.floor(new Date(startDate || Date.now() - 30*86400000).getTime() / 1000);
    const to   = Math.floor(new Date(endDate   || Date.now()).getTime() / 1000);
    // US stocks: try Twelve Data first for accurate data
    if (getMarket(symbol) === 'US') {
      const tdUrl = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&start_date=${startDate}&end_date=${endDate}&outputsize=365&order=ASC&apikey=${TD_KEY}`;
      try {
        const { body } = await fetchJSON(tdUrl);
        if (body?.values?.length) { json(body); return; }
      } catch(e) {}
    }
    // Fallback / global: Yahoo Finance
    const hist = await yahooHistorical(symbol, from, to);
    json({ values: hist }); return;
  }

  // /profile?symbol=AAPL
  if (path === '/profile') {
    const symbol = q.symbol || '';
    if (!symbol) { json({ error: 'symbol required' }, 400); return; }
    // Try Twelve Data profile for US stocks
    if (getMarket(symbol) === 'US') {
      try {
        const tdUrl = `https://api.twelvedata.com/profile?symbol=${encodeURIComponent(symbol)}&apikey=${TD_KEY}`;
        const { body: profile } = await fetchJSON(tdUrl);
        const statsUrl = `https://api.twelvedata.com/statistics?symbol=${encodeURIComponent(symbol)}&apikey=${TD_KEY}`;
        const { body: stats } = await fetchJSON(statsUrl);
        if (profile && !profile.code) {
          const s = stats?.statistics || {};
          json({
            symbol, name: profile.name || symbol,
            description: profile.description || '',
            sector: profile.sector || '', industry: profile.industry || '',
            hq: [profile.address, profile.city, profile.country].filter(Boolean).join(', '),
            employees: profile.employees || null, website: profile.website || '',
            exchange: profile.exchange || '',
            marketCap:    s.valuations_metrics?.market_capitalization,
            pe:           parseFloat(s.valuations_metrics?.trailing_pe) || null,
            pb:           parseFloat(s.valuations_metrics?.price_to_book_mrq) || null,
            eps:          parseFloat(s.valuations_metrics?.earnings_per_share_basic_ttm) || null,
          });
          return;
        }
      } catch(e) {}
    }
    // Yahoo Finance for all global stocks
    const profile = await yahooProfile(symbol);
    if (profile) { json(profile); return; }
    json({ symbol, name: symbol, description: '', sector: '', industry: '' }); return;
  }

  // /search?query=reliance
  if (path === '/search') {
    const query = q.query || q.symbol || '';
    if (!query) { json([], 200); return; }
    // Try TD search first (good for US)
    try {
      const tdUrl = `https://api.twelvedata.com/symbol_search?symbol=${encodeURIComponent(query)}&outputsize=5&apikey=${TD_KEY}`;
      const { body } = await fetchJSON(tdUrl);
      const tdItems = (body?.data || [])
        .filter(r => r.symbol && r.instrument_name && r.instrument_type === 'Common Stock')
        .map(r => ({ symbol: r.symbol, name: r.instrument_name, exchange: r.exchange || '' }));
      // Also search Yahoo (better for global/Indian stocks)
      const yfItems = await yahooSearch(query);
      // Merge, deduplicate by symbol
      const seen = new Set();
      const merged = [...tdItems, ...yfItems].filter(r => {
        if (seen.has(r.symbol)) return false;
        seen.add(r.symbol); return true;
      }).slice(0, 10);
      json(merged); return;
    } catch(e) {
      const yfItems = await yahooSearch(query);
      json(yfItems); return;
    }
  }

  // /fx — currency rates
  if (path === '/fx') {
    try {
      const results = await yahooQuote(['USDINR=X', 'USDGBP=X', 'USDEUR=X', 'USDGBP=X']);
      json(results); return;
    } catch(e) { json([]); return; }
  }

  json({ error: 'Not found' }, 404);
});

// ── WebSocket proxy — Twelve Data real-time ───────────────────
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
  console.log(`FinWise proxy v2 running on :${PORT}`);
  console.log(`  /quote?symbol=AAPL,RELIANCE.NS,700.HK`);
  console.log(`  /search?query=reliance`);
  console.log(`  /profile?symbol=AAPL`);
  console.log(`  /time_series?symbol=AAPL&start_date=2024-01-01&end_date=2024-12-31`);
  console.log(`  /health`);
});
