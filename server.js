import http from 'http';
import https from 'https';
import { parse } from 'url';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

const PORT          = process.env.PORT           || 3001;
const TD_KEY        = process.env.TD_KEY         || 'be5cb92f2c744ed98fd46f787a62088d';
const MARKETAUX_KEY = process.env.MARKETAUX_KEY  || '';
const ALLOWED       = process.env.ALLOWED_ORIGIN || '*';

// ── CORS ─────────────────────────────────────────────────────
function cors(origin) {
  return {
    'Access-Control-Allow-Origin':  ALLOWED === '*' ? (origin || '*') : ALLOWED,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

// ── HTTPS GET with full browser-like headers ─────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept':          'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Referer':         'https://finance.yahoo.com/',
        'Origin':          'https://finance.yahoo.com',
      },
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }); }
        catch(e) { resolve({ status: res.statusCode, headers: res.headers, body: null, raw: body.slice(0,200) }); }
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

// ── Yahoo Finance v8 quote (works server-side) ───────────────
async function yfQuote(symbols) {
  const syms = Array.isArray(symbols) ? symbols : [symbols];
  const url = `https://query1.finance.yahoo.com/v8/finance/quote?symbols=${encodeURIComponent(syms.join(','))}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketChange,regularMarketOpen,regularMarketDayHigh,regularMarketDayLow,regularMarketPreviousClose,shortName,longName,fullExchangeName,sector,marketCap`;
  const { body } = await get(url);
  return body?.quoteResponse?.result || [];
}

// ── Yahoo Finance quoteSummary (profile + ratios) ────────────
async function yfSummary(symbol) {
  const modules = 'assetProfile,summaryDetail,price,financialData,defaultKeyStatistics';
  const url = `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumbStore=true`;
  const { body, status } = await get(url);
  console.log(`[yfSummary] ${symbol} status:${status} hasResult:${!!body?.quoteSummary?.result?.[0]}`);
  return body?.quoteSummary?.result?.[0] || null;
}

// ── Yahoo Finance search ─────────────────────────────────────
async function yfSearch(query) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`;
  const { body } = await get(url);
  return body?.quotes || [];
}

// ── Yahoo Finance historical ─────────────────────────────────
async function yfHistorical(symbol, from, to) {
  const p1 = Math.floor(new Date(from).getTime() / 1000);
  const p2 = Math.floor(new Date(to).getTime()   / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${p1}&period2=${p2}`;
  const { body } = await get(url);
  const chart = body?.chart?.result?.[0];
  if (!chart) return [];
  const ts     = chart.timestamp || [];
  const closes = chart.indicators?.quote?.[0]?.close || [];
  return ts.map((t, i) => ({ datetime: new Date(t*1000).toISOString().slice(0,10), close: closes[i] }))
           .filter(d => d.close != null);
}

// ── HTTP Server ───────────────────────────────────────────────
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

  // /debug — tests Yahoo Finance endpoints live
  if (path === '/debug') {
    const symbol = q.symbol || 'AAPL';
    const results = {};
    const endpoints = [
      `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${symbol}?modules=price`,
      `https://query2.finance.yahoo.com/v11/finance/quoteSummary/${symbol}?modules=price`,
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=price`,
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=price`,
      `https://query1.finance.yahoo.com/v8/finance/quote?symbols=${symbol}`,
      `https://query2.finance.yahoo.com/v8/finance/quote?symbols=${symbol}`,
    ];
    for (const url of endpoints) {
      try {
        const { status, body, raw } = await get(url);
        const key = url.replace('https://','').slice(0,60);
        results[key] = { status, hasResult: !!body?.quoteSummary?.result?.[0] || !!body?.quoteResponse?.result?.[0], snippet: raw || JSON.stringify(body).slice(0,120) };
      } catch(e) {
        results[url.slice(0,60)] = { error: e.message };
      }
    }
    json(results); return;
  }

  // /quote?symbol=AAPL,RELIANCE.NS
  if (path === '/quote') {
    const symbols    = (q.symbol || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!symbols.length) { json([]); return; }
    const usSyms     = symbols.filter(s => getMarket(s) === 'US');
    const globalSyms = symbols.filter(s => getMarket(s) !== 'US');
    const results    = [];

    // US → Twelve Data (real-time)
    if (usSyms.length) {
      try {
        const data  = await get(`https://api.twelvedata.com/quote?symbol=${usSyms.join(',')}&apikey=${TD_KEY}`);
        const items = usSyms.length === 1 ? [data.body] : Object.values(data.body || {});
        items.filter(d => d && parseFloat(d.close) > 0).forEach(d => results.push({
          symbol: d.symbol, price: parseFloat(d.close),
          changesPercentage: parseFloat(d.percent_change), change: parseFloat(d.change),
          open: parseFloat(d.open), dayHigh: parseFloat(d.high), dayLow: parseFloat(d.low),
          previousClose: parseFloat(d.previous_close), name: d.name || d.symbol, exchange: d.exchange || '',
        }));
      } catch(e) { console.warn('TD quote:', e.message); }
      const fetched = new Set(results.map(r => r.symbol));
      usSyms.filter(s => !fetched.has(s)).forEach(s => globalSyms.push(s));
    }

    // Global → Yahoo Finance v8
    if (globalSyms.length) {
      try {
        const raw = await yfQuote(globalSyms);
        raw.filter(d => d?.regularMarketPrice).forEach(d => results.push({
          symbol: d.symbol, price: d.regularMarketPrice,
          changesPercentage: d.regularMarketChangePercent, change: d.regularMarketChange,
          open: d.regularMarketOpen, dayHigh: d.regularMarketDayHigh, dayLow: d.regularMarketDayLow,
          previousClose: d.regularMarketPreviousClose,
          name: d.shortName || d.longName || d.symbol,
          exchange: d.fullExchangeName || d.exchange || '', marketCap: d.marketCap,
        }));
      } catch(e) { console.warn('YF quote:', e.message); }
    }
    json(results); return;
  }

  // /profile?symbol=AAPL
  if (path === '/profile') {
    const symbol = q.symbol || '';
    if (!symbol) { json({ error: 'symbol required' }, 400); return; }
    console.log(`[profile] ${symbol}`);
    try {
      const r  = await yfSummary(symbol);
      if (!r) throw new Error('empty result from Yahoo');
      const p  = r.assetProfile         || {};
      const sd = r.summaryDetail         || {};
      const pr = r.price                 || {};
      const fd = r.financialData         || {};
      const ks = r.defaultKeyStatistics  || {};
      const raw = v => v?.raw !== undefined ? v.raw : (typeof v === 'number' ? v : null);
      const profile = {
        symbol, name: pr.shortName || pr.longName || symbol,
        description: p.longBusinessSummary || '',
        sector: p.sector || '', industry: p.industry || '',
        hq: [p.city, p.state, p.country].filter(Boolean).join(', '),
        employees: raw(p.fullTimeEmployees), website: p.website || '',
        exchange: pr.exchangeName || '',
        marketCap: raw(pr.marketCap) || raw(sd.marketCap),
        revenue: raw(fd.totalRevenue),
        pe: raw(ks.trailingPE) || raw(sd.trailingPE),
        pb: raw(ks.priceToBook),
        roe: raw(fd.returnOnEquity),
        de: raw(fd.debtToEquity),
        grossMargin: raw(fd.grossMargins),
        currentRatio: raw(fd.currentRatio),
        eps: raw(ks.trailingEps),
        forwardPE: raw(ks.forwardPE),
        dividendYield: raw(sd.dividendYield) || raw(sd.trailingAnnualDividendYield),
        beta: raw(sd.beta) || raw(ks.beta),
        fiftyTwoWeekHigh: raw(sd.fiftyTwoWeekHigh),
        fiftyTwoWeekLow: raw(sd.fiftyTwoWeekLow),
        profitMargin: raw(fd.profitMargins),
        revenueGrowth: raw(fd.revenueGrowth),
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
    try {
      const data = await get(`https://api.twelvedata.com/symbol_search?symbol=${encodeURIComponent(query)}&outputsize=6&apikey=${TD_KEY}`);
      (data.body?.data || []).filter(r => r.symbol && r.instrument_name && r.instrument_type === 'Common Stock')
        .forEach(r => results.push({ symbol: r.symbol, name: r.instrument_name, exchange: r.exchange || '' }));
    } catch(e) {}
    try {
      const raw = await yfSearch(query);
      raw.filter(r => r.symbol && (r.shortname || r.longname) && r.quoteType === 'EQUITY')
        .forEach(r => { if (!results.find(x => x.symbol === r.symbol))
          results.push({ symbol: r.symbol, name: r.shortname || r.longname, exchange: r.exchange || '' }); });
    } catch(e) {}
    json(results.slice(0, 10)); return;
  }

  // /time_series
  if (path === '/time_series') {
    const symbol = q.symbol || '';
    if (!symbol) { json({ values: [] }); return; }
    if (getMarket(symbol) === 'US') {
      try {
        const data = await get(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&start_date=${q.start_date||''}&end_date=${q.end_date||''}&outputsize=365&order=ASC&apikey=${TD_KEY}`);
        if (data.body?.values?.length) { json(data.body); return; }
      } catch(e) {}
    }
    try {
      const vals = await yfHistorical(symbol, q.start_date || new Date(Date.now()-30*86400000).toISOString().slice(0,10), q.end_date || new Date().toISOString().slice(0,10));
      json({ values: vals });
    } catch(e) { json({ values: [] }); }
    return;
  }

  // /fx
  if (path === '/fx') {
    try {
      const raw = await yfQuote(['USDINR=X', 'USDGBP=X']);
      json(raw.map(d => ({ symbol: d.symbol, price: d.regularMarketPrice })));
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
    try { const d = await get(url); json(d.body || { data: [] }); }
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

server.listen(PORT, () => console.log(`FinWise proxy v4.0 on :${PORT}`));
