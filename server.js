import http from 'http';
import https from 'https';
import { parse } from 'url';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

const PORT          = process.env.PORT           || 3001;
const TD_KEY        = process.env.TD_KEY         || 'be5cb92f2c744ed98fd46f787a62088d';
const FMP_KEY       = process.env.FMP_KEY        || '0QaZFReu3rNLGWHlfuYwehPHOX99PfC0';
const AV_KEY        = process.env.AV_KEY         || '7OLOGAUMV71P7X13';
const MARKETAUX_KEY = process.env.MARKETAUX_KEY  || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY  || '';
const ALLOWED       = process.env.ALLOWED_ORIGIN || '*';

const FMP  = 'https://financialmodelingprep.com/stable';
const TD   = 'https://api.twelvedata.com';
const AV   = 'https://www.alphavantage.co/query';

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
  const { body } = await get(`${FMP}/quote?symbol=${symbols.join(',')}&apikey=${FMP_KEY}`);
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

// Alpha Vantage quote — Indian stocks (BSE/NSE)
// AV uses RELIANCE.BSE format; we convert .NS/.BO to .BSE
function toAVSymbol(sym) {
  if (sym.endsWith('.NS')) return sym.replace('.NS', '.BSE');
  if (sym.endsWith('.BO')) return sym.replace('.BO', '.BSE');
  return sym;
}

async function avQuote(symbols) {
  const results = [];
  // AV free tier: one symbol at a time
  for (const sym of symbols) {
    try {
      const avSym = toAVSymbol(sym);
      const { body } = await get(`${AV}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(avSym)}&apikey=${AV_KEY}`);
      const q = body?.['Global Quote'];
      if (!q || !parseFloat(q['05. price'])) continue;
      const price = parseFloat(q['05. price']);
      const prevClose = parseFloat(q['08. previous close']);
      const change = parseFloat(q['09. change']);
      const changePct = parseFloat(q['10. change percent']?.replace('%',''));
      results.push({
        symbol: sym, // return original .NS/.BO symbol
        price,
        changesPercentage: changePct || 0,
        change: change || 0,
        open: parseFloat(q['02. open']) || price,
        dayHigh: parseFloat(q['03. high']) || price,
        dayLow: parseFloat(q['04. low']) || price,
        previousClose: prevClose || price,
        name: sym.replace('.NS','').replace('.BO',''),
        exchange: sym.endsWith('.NS') ? 'NSE' : 'BSE',
      });
    } catch(e) { console.warn('AV quote error:', sym, e.message); }
  }
  return results;
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
  if (path === '/health') { json({ ok: true, version: '5.1', apis: 'TD+FMP+AV+Marketaux' }); return; }

  // /debug-fmp — test FMP stable endpoints
  if (path === '/debug-fmp') {
    const symbol = q.symbol || 'AAPL';
    const results = {};
    const tests = {
      'profile':         `${FMP}/profile?symbol=${symbol}&apikey=${FMP_KEY}`,
      'quote':           `${FMP}/quote?symbol=${symbol}&apikey=${FMP_KEY}`,
      'ratios-ttm':      `${FMP}/ratios-ttm?symbol=${symbol}&apikey=${FMP_KEY}`,
      'key-metrics-ttm': `${FMP}/key-metrics-ttm?symbol=${symbol}&apikey=${FMP_KEY}`,
      'company-outlook': `${FMP}/company-outlook?symbol=${symbol}&apikey=${FMP_KEY}`,
      'search':          `${FMP}/search?query=${symbol}&limit=3&apikey=${FMP_KEY}`,
    };
    for (const [key, url] of Object.entries(tests)) {
      try {
        const { status, body } = await get(url);
        const item = Array.isArray(body) ? body[0] : (body?.profile || body);
        results[key] = { status, fields: item ? Object.keys(item) : [], snippet: JSON.stringify(item).slice(0, 300) };
      } catch(e) { results[key] = { error: e.message }; }
    }
    json(results); return;
  }

  // /quote?symbol=AAPL,RELIANCE.NS
  if (path === '/quote') {
    const symbols    = (q.symbol || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!symbols.length) { json([]); return; }
    const usSyms     = symbols.filter(s => getMarket(s) === 'US');
    const inSyms     = symbols.filter(s => getMarket(s) === 'IN');
    const globalSyms = symbols.filter(s => getMarket(s) !== 'US' && getMarket(s) !== 'IN');
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

    // Indian stocks → Alpha Vantage (free, BSE format)
    if (inSyms.length) {
      try {
        const avResults = await avQuote(inSyms);
        results.push(...avResults);
      } catch(e) { console.warn('AV error:', e.message); }
    }

    // Other global → FMP
    if (globalSyms.length) {
      try {
        const fmpResults = await fmpQuote(globalSyms);
        results.push(...fmpResults);
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
      const [profRes, ratioRes, keyRes, quoteRes] = await Promise.all([
        get(`${FMP}/profile?symbol=${encodeURIComponent(symbol)}&apikey=${FMP_KEY}`),
        get(`${FMP}/ratios-ttm?symbol=${encodeURIComponent(symbol)}&apikey=${FMP_KEY}`),
        get(`${FMP}/key-metrics-ttm?symbol=${encodeURIComponent(symbol)}&apikey=${FMP_KEY}`),
        get(`${FMP}/quote?symbol=${encodeURIComponent(symbol)}&apikey=${FMP_KEY}`),
      ]);

      const p = Array.isArray(profRes.body)  ? profRes.body[0]  : null;
      const r = Array.isArray(ratioRes.body) ? ratioRes.body[0] : null;
      const k = Array.isArray(keyRes.body)   ? keyRes.body[0]   : null;
      const q2 = Array.isArray(quoteRes.body) ? quoteRes.body[0] : null;

      if (!p) throw new Error(`FMP profile empty for ${symbol} — status:${profRes.status}`);

      const range = (p.range || '').split('-');
      const profile = {
        symbol,
        name:             p.companyName        || symbol,
        description:      p.description        || '',
        sector:           p.sector             || '',
        industry:         p.industry           || '',
        hq:               [p.city, p.state, p.country].filter(Boolean).join(', '),
        employees:        p.fullTimeEmployees   || null,
        website:          p.website            || '',
        exchange:         p.exchange           || '',
        marketCap:        p.marketCap,
        revenue:          null,
        logo:             p.image              || '',
        // Ratios — exact field names from ratios-ttm
        pe:               r?.priceToEarningsRatioTTM,
        pb:               r?.priceToBookRatioTTM,
        roe:              k?.returnOnEquityTTM,
        de:               r?.debtToEquityRatioTTM,
        grossMargin:      r?.grossProfitMarginTTM,
        currentRatio:     r?.currentRatioTTM,
        eps:              r?.netIncomePerShareTTM,
        forwardPE:        null,
        dividendYield:    r?.dividendYieldTTM,
        beta:             p.beta,
        fiftyTwoWeekHigh: q2?.yearHigh  || parseFloat(range[1]) || null,
        fiftyTwoWeekLow:  q2?.yearLow   || parseFloat(range[0]) || null,
        profitMargin:     r?.netProfitMarginTTM,
        revenueGrowth:    null,
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
      const { body } = await get(`${FMP}/search?query=${encodeURIComponent(query)}&limit=8&apikey=${FMP_KEY}`);      (Array.isArray(body) ? body : []).filter(r => r.symbol && r.name)
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
      const { body } = await get(`${FMP}/historical-price-eod/full?symbol=${encodeURIComponent(symbol)}&from=${q.start_date||''}&to=${q.end_date||''}&apikey=${FMP_KEY}`);
      const hist = body?.historical || [];
      json({ values: [...hist].reverse().map(d => ({ datetime: d.date, close: d.close })) });
    } catch(e) { json({ values: [] }); }
    return;
  }

  // /fx
  if (path === '/fx') {
    try {
      const { body } = await get(`${FMP}/quote?symbol=USDINR,USDGBP&apikey=${FMP_KEY}`);
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

  // /ai  — proxies Anthropic Claude API (keeps key server-side)
  if (path === '/ai') {
    if (!ANTHROPIC_KEY) { json({ error: 'ANTHROPIC_KEY not configured on server' }, 500); return; }
    // Read POST body
    let bodyStr = '';
    try {
      await new Promise((resolve, reject) => {
        req.on('data', d => bodyStr += d);
        req.on('end', resolve);
        req.on('error', reject);
      });
    } catch(e) { json({ error: 'failed to read request body' }, 400); return; }

    try {
      const payload = JSON.parse(bodyStr);
      // Forward to Anthropic
      const response = await new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const r = https.request({
          hostname: 'api.anthropic.com',
          path:     '/v1/messages',
          method:   'POST',
          headers: {
            'Content-Type':    'application/json',
            'x-api-key':       ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length':  Buffer.byteLength(body),
          },
        }, res => {
          let data = '';
          res.on('data', d => data += d);
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        r.on('error', reject);
        r.write(body);
        r.end();
      });
      res.writeHead(response.status, { ...cors(origin), 'Content-Type': 'application/json' });
      res.end(response.body);
    } catch(e) {
      console.error('AI proxy error:', e.message);
      json({ error: 'AI request failed' }, 502);
    }
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
