const https = require('https');

const ALLOWED_SYMBOLS = new Set([
  'ZCU26.CBT','ZCZ26.CBT','ZCH27.CBT','ZCK27.CBT','ZCN27.CBT','ZCU27.CBT','ZCZ27.CBT'
]);

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(body));
}

function normalize(result, interval) {
  const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
  const timestamps = result.timestamp || [];
  if (!quote || !timestamps.length) return [];
  return timestamps.map((ts, i) => {
    const iso = new Date(ts * 1000).toISOString();
    return {
      d: interval === '1h' ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10),
      o: Number(quote.open && quote.open[i]),
      h: Number(quote.high && quote.high[i]),
      l: Number(quote.low && quote.low[i]),
      c: Number(quote.close && quote.close[i]),
      v: Number((quote.volume && quote.volume[i]) || 0),
    };
  }).filter((row) => [row.o, row.h, row.l, row.c].every((n) => Number.isFinite(n) && n > 0));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 corn-futures-dashboard' },
      timeout: 12000,
      family: 4,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error('Yahoo Finance request failed: ' + response.statusCode));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(err); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Yahoo Finance timeout')));
    request.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.end();
    return;
  }

  const query = req.query || {};
  const symbol = String(query.symbol || '').toUpperCase();
  const interval = String(query.interval || '1d').toLowerCase();
  const requestedRange = String(query.range || '').toLowerCase();
  if (!ALLOWED_SYMBOLS.has(symbol)) return send(res, 400, { error: 'Unsupported symbol' });
  if (!['1d', '1h'].includes(interval)) return send(res, 400, { error: 'Unsupported interval' });

  const range = interval === '1h' ? '60d' : (requestedRange || '1y');
  const safeRange = interval === '1h' ? '60d' : (['1mo','3mo','6mo','1y','2y'].includes(range) ? range : '1y');
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=' + encodeURIComponent(safeRange) + '&interval=' + encodeURIComponent(interval);

  try {
    const json = await getJson(url);
    const result = json.chart && json.chart.result && json.chart.result[0];
    if (!result) return send(res, 502, { error: 'No chart result' });
    const rows = normalize(result, interval);
    return send(res, 200, {
      symbol: result.meta && result.meta.symbol || symbol,
      name: result.meta && result.meta.longName || symbol,
      interval,
      range: safeRange,
      updated: result.meta && result.meta.regularMarketTime ? new Date(result.meta.regularMarketTime * 1000).toISOString().slice(0, 16).replace('T', ' ') : new Date().toISOString().slice(0, 16).replace('T', ' '),
      source: 'Yahoo Finance delayed via server API',
      rows,
    });
  } catch (err) {
    return send(res, 500, { error: 'API proxy failed', detail: String(err && err.message || err) });
  }
};
