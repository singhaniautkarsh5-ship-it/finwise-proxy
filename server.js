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

const PORT          = process.env.PORT            || 3001;
const TD_KEY        = process.env.TD_KEY          || 'be5cb92f2c744ed98fd46f787a62088d';
const MARKETAUX_KEY = process.env.MARKETAUX_KEY   || '';
const ALLOWED       = process.env.ALLOWED_ORIGIN  || '*';

// ── CORS ──────────────────────────────────────────────────────
function cors(origin) {
  return {
    'Access-Control-Allow-Origin':  ALLOWED === '*' ? (origin || '*') : ALLOWED,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

// ── Generic HTTPS fetch with redirect support ─────────────────
function fetchJSON(targetUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const makeRequest = (reqUrl, redirectCount = 0) => {
      const opts = new URL(reqUrl);
      const req = https.get({
        hostname: opts.hostname,
        path:     opts.pathname + opts.search,
        headers:  {
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept':          'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'identity',
          'Origin':          'https://finance.yahoo.com',
          'Referer':         'https://finance.yahoo.com/',
          ...extraHeaders,
        },
      }, res => {
        // Follow redirects
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && redirectCount < 3) {
          makeRequest(res.headers.location, redirectCount + 1);
          return;
        }
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
          catch(e) { resolve({ status: res.statusCode, body: { _raw: body.slice(0, 300) } }); }
        });
      });
      req.on('error', reject);
      req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    };
    makeRequest(targetUrl);
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

// ── Yahoo Finance crumb (needed for v10 quoteSummary) ─────────
let yfCrumb = null;
let yfCookie = null;

async function getYahooCrumb() {
  if (yfCrumb && yfCookie) return { crumb: yfCrumb, cookie: yfCookie };
  try {
    // Step 1: get cookie from Yahoo Finance homepage
    const cookieRes = await new Promise((resolve, reject) => {
      const req = https.get({
        hostname: 'finance.yahoo.com',
        path: '/',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html',
        }
      }, res => { resolve(res); res.resume(); });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    });
    const rawCookie = (cookieRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    // Step 2: get crumb using that cookie
    const crumbRes = await fetchJSON('https://query2.finance.yahoo.com/v1/test/getcrumb', { 'Cookie': rawCookie });
    if (typeof crumbRes.body === 'string' && crumbRes.body.length > 0) {
      yfCrumb  = crumbRes.body;
      yfCookie = rawCookie;
      return { crumb: yfCrumb, cookie: yfCookie };
    }
  } catch(e) { console.warn('Crumb fetch failed:', e.message); }
  return null;
}

// ── Yahoo Finance profile — full financials + ratios ─────────
async function yahooProfile(symbol) {
  const modules = 'assetProfile,summaryProfile,price,financialData,defaultKeyStatistics,summaryDetail';

  // Try v11 first (no crumb needed)
  try {
    const url = `https://query2.finance.yahoo.com/v11/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&corsDomain=finance.yahoo.com`;
    const { body } = await fetchJSON(url);
    const r = body?.quoteSummary?.result?.[0];
    if (r) return extractYahooProfile(symbol, r);
  } catch(e) {}

  // Fallback: v10 with crumb
  try {
    const auth = await getYahooCrumb();
    if (auth) {
      const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(auth.crumb)}`;
      const { body } = await fetchJSON(url, { 'Cookie': auth.cookie });
      const r = body?.quoteSummary?.result?.[0];
      if (r) return extractYahooProfile(symbol, r);
    }
  } catch(e) {}

  console.warn('yahooProfile: all attempts failed for', symbol);
  return null;
}

function extractYahooProfile(symbol, r) {
  const p  = r.assetProfile         || {};
  const sp = r.summaryProfile        || {};
  const pr = r.price                 || {};
  const fd = r.financialData         || {};
  const ks = r.defaultKeyStatistics  || {};
  const sd = r.summaryDetail         || {};
  const raw = v => (v?.raw !== undefined ? v.raw : (typeof v === 'number' ? v : null));
  return {
    symbol,
    name:             pr.shortName || pr.longName || symbol,
    description:      p.longBusinessSummary  || sp.longBusinessSummary || '',
    sector:           p.sector    || sp.sector   || '',
    industry:         p.industry  || sp.industry || '',
    hq:               [p.city||sp.city, p.state||sp.state, p.country||sp.country].filter(Boolean).join(', '),
    employees:        raw(p.fullTimeEmployees) || raw(sp.fullTimeEmployees) || null,
    website:          p.website   || sp.website  || '',
    exchange:         pr.exchangeName || '',
    marketCap:        raw(pr.marketCap)        || raw(sd.marketCap),
    revenue:          raw(fd.totalRevenue),
    pe:               raw(ks.trailingPE)        || raw(sd.trailingPE),
    pb:               raw(ks.priceToBook),
    roe:              raw(fd.returnOnEquity),
    de:               raw(fd.debtToEquity),
    grossMargin:      raw(fd.grossMargins),
    currentRatio:     raw(fd.currentRatio),
    eps:              raw(ks.trailingEps),
    forwardPE:        raw(ks.forwardPE),
    dividendYield:    raw(sd.dividendYield)     || raw(sd.trailingAnnualDividendYield),
    beta:             raw(sd.beta)              || raw(ks.beta),
    fiftyTwoWeekHigh: raw(sd.fiftyTwoWeekHigh),
    fiftyTwoWeekLow:  raw(sd.fiftyTwoWeekLow),
    profitMargin:     raw(fd.profitMargins),
    revenueGrowth:    raw(fd.revenueGrowth),
  };
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
  // Always uses Yahoo Finance — free, global, has all ratios
  if (path === '/profile') {
    const symbol = q.symbol || '';
    if (!symbol) { json({ error: 'symbol required' }, 400); return; }
    console.log(`[profile] fetching ${symbol}`);
    const profile = await yahooProfile(symbol);
    if (profile) {
      console.log(`[profile] ${symbol} ok — pe:${profile.pe} roe:${profile.roe} sector:${profile.sector}`);
      json(profile); return;
    }
    console.warn(`[profile] ${symbol} failed — returning stub`);
    json({ symbol, name: symbol, description: 'Data unavailable', sector: '', industry: '' });
    return;
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

  // /news?symbols=AAPL,MSFT&type=company|sector|market&sector=Technology&country=US
  if (path === '/news') {
    const type    = q.type    || 'company';
    const symbols = q.symbols || '';
    const sector  = q.sector  || '';
    const country = q.country || '';
    if (!MARKETAUX_KEY) { json({ error: 'MARKETAUX_KEY not set on server' }, 500); return; }
    try {
      let apiUrl;
      if (type === 'company' && symbols) {
        // Filter by specific ticker symbols
        apiUrl = `https://api.marketaux.com/v1/news/all?symbols=${encodeURIComponent(symbols)}&filter_entities=true&language=en&limit=8&api_token=${MARKETAUX_KEY}`;
      } else if (type === 'sector' && sector) {
        // Filter by industry/sector keyword
        apiUrl = `https://api.marketaux.com/v1/news/all?industries=${encodeURIComponent(sector)}&filter_entities=true&language=en&limit=8&api_token=${MARKETAUX_KEY}`;
      } else if (type === 'market' && country) {
        // Filter by country
        apiUrl = `https://api.marketaux.com/v1/news/all?countries=${encodeURIComponent(country)}&filter_entities=true&language=en&limit=8&api_token=${MARKETAUX_KEY}`;
      } else {
        // General market news fallback
        apiUrl = `https://api.marketaux.com/v1/news/all?filter_entities=true&language=en&limit=8&api_token=${MARKETAUX_KEY}`;
      }
      const { status, body } = await fetchJSON(apiUrl);
      res.writeHead(status, { ...cors(origin), 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    } catch(e) {
      json({ error: 'news fetch failed' }, 502);
    }
    return;
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
