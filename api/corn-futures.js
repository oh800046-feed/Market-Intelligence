const https = require('https');
const zlib = require('zlib');

const ALLOWED_SYMBOLS = new Set([
  'ZCU26.CBT','ZCZ26.CBT','ZCH27.CBT','ZCK27.CBT','ZCN27.CBT','ZCU27.CBT','ZCZ27.CBT',
  'ZM=F','ZMU26.CBT','ZMV26.CBT','ZMZ26.CBT','ZMF27.CBT','ZMH27.CBT','ZMK27.CBT','ZMN27.CBT','ZMQ27.CBT','ZMU27.CBT','ZMV27.CBT','ZMZ27.CBT',
  'ZW=F','ZWU26.CBT','ZWZ26.CBT','ZWH27.CBT','ZWK27.CBT','ZWN27.CBT','ZWU27.CBT','ZWZ27.CBT',
  'KRW=X','USDKRW=X','CL=F','BZ=F','BALTIC_DRY_INDEX','US_CORN_ENDING_STOCKS','KR_LIVESTOCK_TRENDS',
  'KR_COMPETITOR_DISCLOSURES','KR_ANIMAL_DISEASE_STATUS'
]);

const COMPETITOR_COMPANIES = [
  { name: '팜스코', stockCode: '036580', corpCode: '00260408' },
  { name: '선진', stockCode: '136490', corpCode: '00855093' },
  { name: '팜스토리', stockCode: '027710', corpCode: '00192499' },
  { name: '한일사료', stockCode: '005860', corpCode: '00162911' },
  { name: '이지바이오', stockCode: '353810', corpCode: '01480568' },
  { name: '이지홀딩스', stockCode: '035810', corpCode: '00242378' },
];

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

async function getYahooChart(symbol, range, interval) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastError;
  for (const host of hosts) {
    const url = 'https://' + host + '/v8/finance/chart/' + encodeURIComponent(symbol)
      + '?range=' + encodeURIComponent(range) + '&interval=' + encodeURIComponent(interval);
    try {
      const json = await getJson(url);
      const result = json.chart && json.chart.result && json.chart.result[0];
      if (result) return result;
      lastError = new Error('No chart result from ' + host);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Yahoo Finance chart failed');
}

function getText(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 market-dashboard' },
      timeout: 12000,
      family: 4,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error('Text request failed: ' + response.statusCode));
          return;
        }
        resolve(body);
      });
    });
    request.on('timeout', () => request.destroy(new Error('Text request timeout')));
    request.on('error', reject);
  });
}

function getBuffer(url, redirectCount) {
  const redirects = Number(redirectCount || 0);
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 market-dashboard' },
      timeout: 12000,
      family: 4,
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 5) {
        response.resume();
        getBuffer(new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error('Binary request failed: ' + response.statusCode));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => { chunks.push(chunk); });
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('timeout', () => request.destroy(new Error('Binary request timeout')));
    request.on('error', reject);
  });
}

function extractZipText(buffer, targetName) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP end record not found');
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < totalEntries; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replace(/\\/g, '/');
    if (name.toLowerCase() === targetName.toLowerCase()) {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Invalid ZIP local entry');
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return compressed.toString('utf8');
      if (method === 8) return zlib.inflateRawSync(compressed).toString('utf8');
      throw new Error('Unsupported ZIP compression method: ' + method);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('ZIP entry not found: ' + targetName);
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDiseasePosts(html, listUrl) {
  const tbody = (String(html).match(/<tbody>([\s\S]*?)<\/tbody>/i) || [null, String(html)])[1];
  const posts = [];
  const pattern = /<a[^>]+href="([^"]*\/artclView\.do)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<td[^>]*class="tbl_date"[^>]*>\s*([^<]+)\s*<\/td>/gi;
  let match;
  while ((match = pattern.exec(tbody))) {
    posts.push({
      title: decodeHtml(match[2]),
      published: decodeHtml(match[3]).replace(/\./g, '-'),
      url: new URL(decodeHtml(match[1]), listUrl).href,
    });
  }
  if (!posts.length) throw new Error('Disease post list not found');
  return posts;
}

async function getHwpxPreview(post) {
  const articleHtml = await getText(post.url);
  const downloadMatch = articleHtml.match(/href="([^"]+\/download\.do)"/i);
  if (!downloadMatch) throw new Error('Disease attachment not found');
  const downloadUrl = new URL(decodeHtml(downloadMatch[1]), post.url).href;
  const archive = await getBuffer(downloadUrl);
  return { post, downloadUrl, text: extractZipText(archive, 'Preview/PrvText.txt') };
}

function getDiseaseRows(previewText, year) {
  const shortYear = String(year).slice(-2);
  return String(previewText || '').split(/\r?\n/).map((line) => {
    const cells = [...line.matchAll(/<([^>]*)>/g)].map((match) => decodeHtml(match[1]));
    return cells.length >= 7 && /^\d+차$/.test(cells[0]) && cells[2].includes(shortYear) ? cells : null;
  }).filter(Boolean);
}

let animalDiseaseCache;

async function getAnimalDiseaseStatus() {
  const now = new Date();
  if (animalDiseaseCache && animalDiseaseCache.expires > now.getTime()) return animalDiseaseCache.data;
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = kstNow.getUTCFullYear();
  const fallback = {
    asf: {
      count: 24,
      period: year + '년 누계',
      published: '2026-03-20',
      detail: '강원 2 · 경기 7 · 전남 4 · 전북 2 · 충남 3 · 경남 5 · 경북 1',
      url: 'https://www.mafra.go.kr/bbs/FMD-AI2/404/577369/artclView.do',
      status: 'fallback',
    },
    fmd: {
      count: 9,
      period: year + '년 누계',
      published: '2026-07-03',
      detail: '인천 강화 1 · 경기 고양 2 · 경북 예천 6',
      url: 'https://www.mafra.go.kr/bbs/FMD-AI2/389/578352/artclView.do',
      status: 'fallback',
    },
  };
  const asfTask = (async () => {
    const listUrl = 'https://www.mafra.go.kr/FMD-AI2/2145/subview.do';
    const posts = parseDiseasePosts(await getText(listUrl), listUrl);
    const latest = posts[0];
    const titleCount = latest.title.match(/~\s*(\d+)차/);
    const preview = await getHwpxPreview(latest).catch(() => null);
    const textCount = preview && preview.text.match(/[‘’']?\d{2}년\s*총\s*(\d+)건\s*발생/);
    const detailMatch = preview && preview.text.match(/총\s*\d+건\s*발생\s*:\s*([^\r\n]+)/);
    const count = Number(textCount && textCount[1] || titleCount && titleCount[1]);
    if (!Number.isFinite(count)) throw new Error('ASF count not found');
    return {
      count,
      period: year + '년 누계',
      published: latest.published,
      detail: detailMatch ? detailMatch[1].trim().replace(/,\s*/g, ' · ') : fallback.asf.detail,
      url: latest.url,
      status: 'live',
    };
  })();
  const fmdTask = (async () => {
    const listUrl = 'https://www.mafra.go.kr/FMD-AI2/2216/subview.do';
    const posts = parseDiseasePosts(await getText(listUrl), listUrl)
      .filter((post) => post.published.startsWith(String(year) + '-'))
      .slice(0, 20);
    if (!posts.length) throw new Error('Current-year FMD posts not found');
    const previews = await Promise.all(posts.map((post) => getHwpxPreview(post)));
    const occurrenceGroups = new Map();
    previews.forEach((preview) => {
      const postGroups = new Map();
      getDiseaseRows(preview.text, year).forEach((cells) => {
        const key = [cells[2].replace(/\D/g, ''), cells[3], cells[4]].join('|').replace(/\s+/g, '');
        if (!postGroups.has(key)) postGroups.set(key, []);
        postGroups.get(key).push(cells);
      });
      postGroups.forEach((rows, key) => {
        const previous = occurrenceGroups.get(key);
        if (!previous || rows.length > previous.length) occurrenceGroups.set(key, rows);
      });
    });
    if (!occurrenceGroups.size) throw new Error('FMD occurrence rows not found');
    const locationCounts = new Map();
    let count = 0;
    occurrenceGroups.forEach((rows) => {
      count += rows.length;
      const location = [rows[0][3], rows[0][4]].filter(Boolean).join(' ');
      if (location) locationCounts.set(location, (locationCounts.get(location) || 0) + rows.length);
    });
    return {
      count,
      period: year + '년 누계',
      published: posts[0].published,
      detail: [...locationCounts].map(([location, value]) => location + ' ' + value).join(' · '),
      url: posts[0].url,
      status: 'live',
    };
  })();
  const [asfResult, fmdResult] = await Promise.allSettled([asfTask, fmdTask]);
  const data = {
    symbol: 'KR_ANIMAL_DISEASE_STATUS',
    status: asfResult.status === 'fulfilled' && fmdResult.status === 'fulfilled' ? 'live' : 'partial',
    checkedAt: now.toISOString(),
    source: 'Ministry of Agriculture, Food and Rural Affairs official disease occurrence disclosures',
    asf: asfResult.status === 'fulfilled' ? asfResult.value : { ...fallback.asf, detailError: String(asfResult.reason && asfResult.reason.message || asfResult.reason) },
    fmd: fmdResult.status === 'fulfilled' ? fmdResult.value : { ...fallback.fmd, detailError: String(fmdResult.reason && fmdResult.reason.message || fmdResult.reason) },
    risk: {
      count: 32,
      unit: '시·군',
      published: '2026-05-19',
      detail: 'ASF 역학조사 중간결과의 고위험 권역 지정 스냅샷',
      url: 'https://www.mafra.go.kr/bbs/home/792/597424/download.do',
      status: 'snapshot',
    },
  };
  animalDiseaseCache = { expires: now.getTime() + 15 * 60 * 1000, data };
  return data;
}

function dateCompact(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function formatDartDate(value) {
  const text = String(value || '');
  return text.length === 8 ? text.slice(0, 4) + '-' + text.slice(4, 6) + '-' + text.slice(6, 8) : text;
}

async function getLatestHalfYearDisclosure(company, apiKey, year, endDate) {
  const params = new URLSearchParams({
    crtfc_key: apiKey,
    corp_code: company.corpCode,
    bgn_de: String(year) + '0101',
    end_de: endDate,
    last_reprt_at: 'Y',
    pblntf_ty: 'A',
    pblntf_detail_ty: 'A002',
    sort: 'date',
    sort_mth: 'desc',
    page_no: '1',
    page_count: '100',
  });
  const json = await getJson('https://opendart.fss.or.kr/api/list.json?' + params.toString());
  if (json.status === '013') return { ...company, filing: null };
  if (json.status !== '000') {
    throw new Error('OpenDART ' + String(json.status || 'unknown') + ': ' + String(json.message || 'request failed'));
  }
  const filing = Array.isArray(json.list) && json.list.length ? json.list[0] : null;
  if (!filing) return { ...company, filing: null };
  return {
    ...company,
    filing: {
      reportName: String(filing.report_nm || '반기보고서'),
      receiptDate: formatDartDate(filing.rcept_dt),
      receiptNo: String(filing.rcept_no || ''),
      submitter: String(filing.flr_nm || ''),
      note: String(filing.rm || ''),
      url: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=' + encodeURIComponent(String(filing.rcept_no || '')),
    },
  };
}

async function getCompetitorDisclosures() {
  const apiKey = String(process.env.DART_API_KEY || process.env.OPENDART_API_KEY || '').trim();
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = kstNow.getUTCFullYear();
  if (!apiKey) {
    return {
      symbol: 'KR_COMPETITOR_DISCLOSURES',
      status: 'key_required',
      year,
      checkedAt: now.toISOString(),
      source: 'OpenDART disclosure search API',
      companies: COMPETITOR_COMPANIES,
      message: 'Set DART_API_KEY in Vercel Environment Variables.',
    };
  }
  const companies = await Promise.all(
    COMPETITOR_COMPANIES.map((company) => getLatestHalfYearDisclosure(company, apiKey, year, dateCompact(kstNow)))
  );
  return {
    symbol: 'KR_COMPETITOR_DISCLOSURES',
    status: 'live',
    year,
    checkedAt: now.toISOString(),
    source: 'OpenDART disclosure search API',
    companies,
  };
}

async function getBalticDryIndex() {
  const [historyJson, latestJson] = await Promise.all([
    getJson('https://www.balticdryindex.com/data/history.json'),
    getJson('https://www.balticdryindex.com/data/latest.json').catch(() => null),
  ]);
  const rows = (Array.isArray(historyJson) ? historyJson : (historyJson && historyJson.series) || [])
    .filter((row) => row && row.date && Number.isFinite(Number(row.bdi ?? row.value)))
    .map((row) => {
      const value = Number(row.bdi ?? row.value);
      return { d: String(row.date).slice(0, 10), o: value, h: value, l: value, c: value, v: 0 };
    })
    .sort((a, b) => a.d.localeCompare(b.d));
  if (latestJson && latestJson.date && latestJson.bdi && Number.isFinite(Number(latestJson.bdi.value))) {
    const day = String(latestJson.date).slice(0, 10);
    const value = Number(latestJson.bdi.value);
    const lastIndex = rows.findIndex((row) => row.d === day);
    const latestRow = { d: day, o: value, h: value, l: value, c: value, v: 0 };
    if (lastIndex >= 0) rows[lastIndex] = latestRow;
    else rows.push(latestRow);
    rows.sort((a, b) => a.d.localeCompare(b.d));
  }
  if (!rows.length) throw new Error('BDI history not found');
  const last = rows[rows.length - 1];
  return {
    symbol: 'BALTIC_DRY_INDEX',
    name: 'Baltic Dry Index',
    interval: '1d',
    range: 'history',
    updated: (latestJson && latestJson.updated ? latestJson.date + ' ' + latestJson.updated : last.d),
    source: 'BalticDryIndex.com history JSON / Baltic Exchange daily index',
    rows,
  };
}

async function getUsdaCornEndingStocks() {
  const fallback = {
    reportDate: '2026-08-12',
    pageDate: '2026-08-14',
    valueBnBu: 1.653,
    valueMmt: 42,
    priorBnBu: 1.790,
  };
  let latest = { ...fallback };
  try {
    const text = (await getText('https://www.ers.usda.gov/topics/crops/corn-and-other-feed-grains/market-outlook')).replace(/\s+/g, ' ');
    const updated = text.match(/Updated:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    const stock = text.match(/corn[^.]{0,220}ending stocks[^.]{0,220}to\s+([\d.]+)\s+million\s+metric\s+tons/i)
      || text.match(/Corn sees the largest decrease[^.]{0,220}to\s+([\d.]+)\s+million/i);
    if (updated) {
      latest.pageDate = updated[3] + '-' + String(updated[1]).padStart(2, '0') + '-' + String(updated[2]).padStart(2, '0');
    }
    if (stock) {
      const mmt = Number(stock[1]);
      if (Number.isFinite(mmt) && mmt > 0) {
        latest.valueMmt = mmt;
        latest.valueBnBu = mmt * 39.36825 / 1000;
      }
    }
  } catch (err) {
    // Keep the dashboard populated if the USDA page is temporarily unavailable.
  }
  return {
    symbol: 'US_CORN_ENDING_STOCKS',
    name: 'U.S. Corn Ending Stocks 2026/27',
    interval: '1d',
    range: 'latest',
    updated: latest.pageDate,
    source: 'USDA ERS Corn and Other Feed Grains Market Outlook / WASDE',
    unit: 'bn bu',
    rows: [
      { d: '2026-07-10', o: latest.priorBnBu, h: latest.priorBnBu, l: latest.priorBnBu, c: latest.priorBnBu, v: 0 },
      { d: latest.reportDate, o: latest.valueBnBu, h: latest.valueBnBu, l: latest.valueBnBu, c: latest.valueBnBu, v: 0 },
    ],
  };
}

function metricPercent(text, pattern) {
  const match = text.match(pattern);
  const value = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(value)) throw new Error('Livestock metric not found');
  return value;
}

function metricHeadcount(text, pattern) {
  const match = text.match(pattern);
  if (!match) throw new Error('Livestock headcount not found');
  const tenThousands = Number(String(match[1]).replace(/,/g, ''));
  const thousands = Number(String(match[2] || 0).replace(/,/g, ''));
  const value = tenThousands * 10000 + thousands * 1000;
  if (!Number.isFinite(value)) throw new Error('Invalid livestock headcount');
  return value;
}

const AQUACULTURE_FALLBACK = {
  year: 2025,
  published: '2026-03-20',
  sourceUrl: 'https://mods.go.kr/board.es?act=view&bid=225&list_no=444154&mid=a10301010000',
  productionValue: 12.1,
  stocking: 19.1,
  feedAmount: -4.6,
};

async function getKoreanAquacultureTrends(listHtml) {
  try {
    const html = listHtml || await getText('https://mods.go.kr/board.es?bid=225&mid=a10301080400');
    const releases = [...html.matchAll(/list_no=(\d+)[\s\S]{0,1800}?((?:20)\d{2})년\s*어류양식동향조사 결과(?:\(잠정\))?[\s\S]{0,1000}?<strong>게시일<\/strong><span>(\d{4}-\d{2}-\d{2})<\/span>/g)];
    if (!releases.length) throw new Error('Latest aquaculture release not found');
    const release = releases[0];
    const sourceUrl = 'https://mods.go.kr/board.es?act=view&bid=225&list_no=' + release[1] + '&mid=a10301010000';
    const detailHtml = await getText(sourceUrl);
    const bodyMatch = detailHtml.match(/<div class="board_content">([\s\S]*?)<\/div>/i);
    if (!bodyMatch) throw new Error('Aquaculture release body not found');
    const text = bodyMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const productionValue = metricPercent(text, /생산금액\s*\([^)]*,\s*(-?\d+(?:\.\d+)?)%\)/);
    const stocking = metricPercent(text, /입식(?:마릿수)?\s*\((-?\d+(?:\.\d+)?)%\)/);
    const feedDecrease = metricPercent(text, /\(먹이를 준 양\)[\s\S]{0,180}?\((-?\d+(?:\.\d+)?)%\)\s*감소/);
    return { year: Number(release[2]), published: release[3], sourceUrl, productionValue, stocking, feedAmount: -Math.abs(feedDecrease), status: 'live' };
  } catch (err) {
    return { ...AQUACULTURE_FALLBACK, status: 'fallback', detail: String(err && err.message || err) };
  }
}

async function getKoreanLivestockTrends() {
  const fallback = {
    year: 2026,
    quarter: 2,
    referenceDate: '2026-06-01',
    published: '2026-07-24',
    sourceUrl: 'https://mods.go.kr/board.es?act=view&bid=225&list_no=446117&mid=a10301010000',
    metrics: { cattle: -4.9, dairy: -1.6, swine: -2.2, layers: 1.6, broiler: 1.0, duck: -9.5 },
    headcounts: { cattle: 3289000, dairy: 365000, swine: 10658000, layers: 78985000, broiler: 110898000, duck: 9451000 },
  };
  try {
    const listUrl = 'https://mods.go.kr/board.es?bid=225&mid=a10301080400';
    const listHtml = await getText(listUrl);
    const releases = [...listHtml.matchAll(/list_no=(\d+)[\s\S]{0,1800}?((?:20)\d{2})년\s*(\d)분기\s*가축동향조사 결과 보도자료[\s\S]{0,1000}?<strong>게시일<\/strong><span>(\d{4}-\d{2}-\d{2})<\/span>/g)];
    if (!releases.length) throw new Error('Latest livestock release not found');
    const release = releases[0];
    const listNo = release[1];
    const year = Number(release[2]);
    const quarter = Number(release[3]);
    const published = release[4];
    const sourceUrl = 'https://mods.go.kr/board.es?act=view&bid=225&list_no=' + listNo + '&mid=a10301010000';
    const detailHtml = await getText(sourceUrl);
    const bodyMatch = detailHtml.match(/<div class="board_content">([\s\S]*?)<\/div>/i);
    if (!bodyMatch) throw new Error('Livestock release body not found');
    const text = bodyMatch[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&middot;|&#183;/gi, '·')
      .replace(/\s+/g, ' ')
      .trim();
    const monthMatch = text.match(/(\d{1,2})월\s*1일\s*기준/);
    const referenceDate = year + '-' + String(monthMatch ? monthMatch[1] : quarter * 3).padStart(2, '0') + '-01';
    const aquaculture = await getKoreanAquacultureTrends(listHtml);
    return {
      symbol: 'KR_LIVESTOCK_TRENDS',
      name: 'Korea Livestock Trend Survey',
      year,
      quarter,
      period: year + '년 ' + quarter + '분기',
      referenceDate,
      updated: published,
      published,
      source: '국가데이터처 가축동향조사',
      sourceUrl,
      status: 'live',
      metrics: {
        cattle: metricPercent(text, /\(한[^)]*육우\)[\s\S]{0,180}?\((-?\d+(?:\.\d+)?)%\)/),
        dairy: metricPercent(text, /\(젖\s*소\)[\s\S]{0,180}?\((-?\d+(?:\.\d+)?)%\)/),
        swine: metricPercent(text, /\(돼\s*지\)[\s\S]{0,180}?\((-?\d+(?:\.\d+)?)%\)/),
        layers: metricPercent(text, /\(산란계\)[\s\S]{0,180}?\((-?\d+(?:\.\d+)?)%\)/),
        broiler: metricPercent(text, /\(육용계\)[\s\S]{0,180}?\((-?\d+(?:\.\d+)?)%\)/),
        duck: metricPercent(text, /\(오\s*리\)[\s\S]{0,180}?\((-?\d+(?:\.\d+)?)%\)/),
      },
      headcounts: {
        cattle: metricHeadcount(text, /\(한[^)]*육우\)\s*([\d,]+)만\s*([\d,]+)천\s*마리/),
        dairy: metricHeadcount(text, /\(젖\s*소\)\s*([\d,]+)만\s*([\d,]+)천\s*마리/),
        swine: metricHeadcount(text, /\(돼\s*지\)\s*([\d,]+)만\s*([\d,]+)천\s*마리/),
        layers: metricHeadcount(text, /\(산란계\)\s*([\d,]+)만\s*([\d,]+)천\s*마리/),
        broiler: metricHeadcount(text, /\(육용계\)\s*([\d,]+)만\s*([\d,]+)천\s*마리/),
        duck: metricHeadcount(text, /\(오\s*리\)\s*([\d,]+)만\s*([\d,]+)천\s*마리/),
      },
      aquaculture,
    };
  } catch (err) {
    return {
      symbol: 'KR_LIVESTOCK_TRENDS',
      name: 'Korea Livestock Trend Survey',
      period: fallback.year + '년 ' + fallback.quarter + '분기',
      updated: fallback.published,
      source: '국가데이터처 가축동향조사',
      status: 'fallback',
      detail: String(err && err.message || err),
      aquaculture: { ...AQUACULTURE_FALLBACK, status: 'fallback' },
      ...fallback,
    };
  }
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

  if (symbol === 'US_CORN_ENDING_STOCKS') {
    try {
      return send(res, 200, await getUsdaCornEndingStocks());
    } catch (err) {
      return send(res, 500, { error: 'USDA proxy failed', detail: String(err && err.message || err) });
    }
  }

  if (symbol === 'KR_LIVESTOCK_TRENDS') {
    try {
      return send(res, 200, await getKoreanLivestockTrends());
    } catch (err) {
      return send(res, 500, { error: 'Korean livestock proxy failed', detail: String(err && err.message || err) });
    }
  }

  if (symbol === 'BALTIC_DRY_INDEX') {
    try {
      return send(res, 200, await getBalticDryIndex());
    } catch (err) {
      return send(res, 500, { error: 'BDI proxy failed', detail: String(err && err.message || err) });
    }
  }

  if (symbol === 'KR_COMPETITOR_DISCLOSURES') {
    try {
      return send(res, 200, await getCompetitorDisclosures());
    } catch (err) {
      return send(res, 502, { error: 'OpenDART proxy failed', detail: String(err && err.message || err) });
    }
  }

  if (symbol === 'KR_ANIMAL_DISEASE_STATUS') {
    try {
      return send(res, 200, await getAnimalDiseaseStatus());
    } catch (err) {
      return send(res, 502, { error: 'Animal disease proxy failed', detail: String(err && err.message || err) });
    }
  }

  const range = interval === '1h' ? '60d' : (requestedRange || '1y');
  const safeRange = interval === '1h' ? '60d' : (['1mo','3mo','6mo','1y','2y'].includes(range) ? range : '1y');
  try {
    const result = await getYahooChart(symbol, safeRange, interval);
    const rows = normalize(result, interval);
    if (!rows.length) return send(res, 502, { error: 'No valid chart rows' });
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
