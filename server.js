import http from 'http';
import https from 'https';
import { parse } from 'url';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import * as yfModule from "yahoo-finance2";

const PORT          = process.env.PORT           || 3001;
const TD_KEY        = process.env.TD_KEY         || 'be5cb92f2c744ed98fd46f787a62088d';
const MARKETAUX_KEY = process.env.MARKETAUX_KEY  || '';
const ALLOWED       = process.env.ALLOWED_ORIGIN || '*';

// yahoo-finance2 v2 exports differently depending on bundler —
// handle both named and default export patterns
const yahooFinance = yfModule.default?.default ?? yfModule.default ?? yfModule;

function cors(origin) {
  return {
    'Access-Control-Allow-Origin':  ALLOWED === '*' ? (origin || '*') : ALLOWED,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      headers:  { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve(null); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
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

  if (path === '/health') {
    const d = yfModule.default;
    json({
      ok: true, version: '3.4',
      moduleKeys: Object.keys(yfModule),
      defaultKeys: d ? Object.keys(d).slice(0, 8) : null,
      defaultDefaultKeys: d?.default ? Object.keys(d.default).slice(0, 8) : null,
      hasQuote: typeof yahooFinance.quote,
      hasSummary: typeof yahooFinance.quoteSummary,
    });
    return;
  }

  // /quote?symbol=AAPL,RELIANCE.NS
  if (path === '/quote') {
    const symbols    = (q.symbol || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!symbols.length) { json([]); return; }
    const usSyms     = symbols.filter(s => getMarket(s) === 'US');
    const globalSyms = symbols.filter(s => getMarket(s) !== 'US');
    const results    = [];

    if (usSyms.length) {
      try {
        const data  = await fetchJSON(`https://api.twelvedata.com/quote?symbol=${usSyms.join(',')}&apikey=${TD_KEY}`);
        const items = usSyms.length === 1 ? [data] : Object.values(data || {});
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

    if (globalSyms.length) {
      try {
        const raw = await yahooFinance.quote(globalSyms.length === 1 ? globalSyms[0] : globalSyms);
        const arr = Array.isArray(raw) ? raw : [raw];
        arr.filter(d => d?.regularMarketPrice).forEach(d => results.push({
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
    console.log(`[profile] ${symbol} — using quoteSummary`);
    try {
      const r  = await yahooFinance.quoteSummary(symbol, {
        modules: ['assetProfile', 'summaryDetail', 'price', 'financialData', 'defaultKeyStatistics'],
      });
      console.log(`[profile] ${symbol} raw keys:`, Object.keys(r || {}));
      const p  = r.assetProfile         || {};
      const sd = r.summaryDetail         || {};
      const pr = r.price                 || {};
      const fd = r.financialData         || {};
      const ks = r.defaultKeyStatistics  || {};
      const profile = {
        symbol,
        name:             pr.shortName || pr.longName || symbol,
        description:      p.longBusinessSummary || '',
        sector:           p.sector   || '',
        industry:         p.industry || '',
        hq:               [p.city, p.state, p.country].filter(Boolean).join(', '),
        employees:        p.fullTimeEmployees || null,
        website:          p.website  || '',
        exchange:         pr.exchangeName || '',
        marketCap:        pr.marketCap || sd.marketCap,
        revenue:          fd.totalRevenue,
        pe:               ks.trailingPE  || sd.trailingPE,
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
      console.log(`[profile] ${symbol} ok — pe:${profile.pe} sector:${profile.sector} name:${profile.name}`);
      json(profile);
    } catch(e) {
      console.error(`[profile] ${symbol} FAILED:`, e.message, e.stack?.split('\n')[1]);
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
      const data = await fetchJSON(`https://api.twelvedata.com/symbol_search?symbol=${encodeURIComponent(query)}&outputsize=6&apikey=${TD_KEY}`);
      (data?.data || []).filter(r => r.symbol && r.instrument_name && r.instrument_type === 'Common Stock')
        .forEach(r => results.push({ symbol: r.symbol, name: r.instrument_name, exchange: r.exchange || '' }));
    } catch(e) {}
    try {
      const data = await yahooFinance.search(query, { quotesCount: 8, newsCount: 0 });
      (data.quotes || []).filter(r => r.symbol && (r.shortname || r.longname) && r.quoteType === 'EQUITY')
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
        const data = await fetchJSON(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&start_date=${q.start_date||''}&end_date=${q.end_date||''}&outputsize=365&order=ASC&apikey=${TD_KEY}`);
        if (data?.values?.length) { json(data); return; }
      } catch(e) {}
    }
    try {
      const from = new Date(q.start_date || Date.now() - 30*86400000);
      const to   = new Date(q.end_date   || Date.now());
      const data = await yahooFinance.historical(symbol, { period1: from, period2: to, interval: '1d' });
      json({ values: (data || []).map(d => ({ datetime: d.date.toISOString().slice(0,10), close: d.close })) });
    } catch(e) { json({ values: [] }); }
    return;
  }

  // /fx
  if (path === '/fx') {
    try {
      const raw = await yahooFinance.quote(['USDINR=X', 'USDGBP=X']);
      json((Array.isArray(raw) ? raw : [raw]).map(d => ({ symbol: d.symbol, price: d.regularMarketPrice })));
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
    try { json(await fetchJSON(url) || { data: [] }); }
    catch(e) { json({ error: 'news failed' }, 502); }
    return;
  }

  json({ error: 'not found' }, 404);
});

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

server.listen(PORT, () => console.log(`FinWise proxy v3.2 on :${PORT}`));
