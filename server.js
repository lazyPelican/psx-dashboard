const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const PSX_BASE = 'https://dps.psx.com.pk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// Persistent storage: portfolio + settings live in data/portfolio.json on disk
// so they survive browser cache clears, code updates, server restarts, and
// switching between localhost and a deployed origin.
// data/ is gitignored so it never gets pushed.
// On serverless platforms (Vercel) the project dir is read-only and only /tmp
// is writable (but ephemeral per-invocation). Locally we use ./data so the
// portfolio survives restarts. On Vercel the frontend localStorage is the
// real source of truth — the server endpoints just won't persist.
const IS_SERVERLESS = !!process.env.VERCEL;
const DATA_DIR = IS_SERVERLESS ? '/tmp/psx-data' : path.join(__dirname, 'data');
const PORTFOLIO_FILE = path.join(DATA_DIR, 'portfolio.json');
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
catch (err) { console.error('Could not create data dir:', err.message); }

function readPortfolio() {
  try {
    if (!fs.existsSync(PORTFOLIO_FILE)) return { trades: [], settings: null };
    const raw = fs.readFileSync(PORTFOLIO_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('readPortfolio failed:', err.message);
    return { trades: [], settings: null };
  }
}
function writePortfolio(data) {
  try {
    // Write to a temp file first then rename so a crash mid-write doesn't corrupt the file
    const tmp = PORTFOLIO_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, PORTFOLIO_FILE);
    return true;
  } catch (err) {
    console.error('writePortfolio failed:', err.message);
    return false;
  }
}

app.use(express.json({ limit: '5mb' }));

// --- In-memory cache ---
const cache = {};
function getCached(key, ttlMs) {
  const entry = cache[key];
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
  return null;
}
function setCache(key, data) {
  cache[key] = { data, ts: Date.now() };
}
function getStaleCache(key) {
  return cache[key]?.data || null;
}

async function psxFetch(urlPath) {
  const res = await fetch(`${PSX_BASE}${urlPath}`, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/json' },
    timeout: 15000
  });
  if (!res.ok) throw new Error(`PSX returned ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) return { type: 'json', data: await res.json() };
  return { type: 'html', data: await res.text() };
}

// --- HTML Parsers ---

function parseMarketWatch(html) {
  const rows = html.match(/<tr>(?=<td)[\s\S]*?<\/tr>/g) || [];
  return rows.map(row => {
    const symbolMatch = row.match(/data-search="([^"]+)"/);
    const titleMatch = row.match(/data-title="([^"]+)"/);
    const orders = [...row.matchAll(/data-order="([^"]+)"/g)].map(m => m[1]);
    const allTds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]*>/g, '').trim());

    if (!symbolMatch || orders.length < 9) return null;

    return {
      symbol: symbolMatch[1],
      name: titleMatch ? titleMatch[1] : symbolMatch[1],
      sectorCode: allTds[1] || '',
      listedIn: allTds[2] || '',
      ldcp: parseFloat(orders[1]) || 0,
      open: parseFloat(orders[2]) || 0,
      high: parseFloat(orders[3]) || 0,
      low: parseFloat(orders[4]) || 0,
      current: parseFloat(orders[5]) || 0,
      change: parseFloat(orders[6]) || 0,
      changePercent: parseFloat(orders[7]) || 0,
      volume: parseInt(orders[8]) || 0
    };
  }).filter(Boolean);
}

function parseIndices(html) {
  const results = [];
  const tables = html.match(/<table[\s\S]*?<\/table>/g) || [];
  tables.forEach(table => {
    const rows = table.match(/<tr>[\s\S]*?<\/tr>/g) || [];
    rows.forEach(row => {
      if (row.includes('<th')) return;
      const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]*>/g, '').trim());
      if (tds.length >= 6) {
        // Strip timestamp suffix from name (e.g. "HBLTTI (18-05-2026 18:30:00)" -> "HBLTTI")
        const cleanName = tds[0].replace(/\s*\([^)]*\)\s*$/, '').trim();
        results.push({
          name: cleanName,
          high: parseFloat(tds[1]?.replace(/,/g, '')) || 0,
          low: parseFloat(tds[2]?.replace(/,/g, '')) || 0,
          value: parseFloat(tds[3]?.replace(/,/g, '')) || 0,
          change: parseFloat(tds[4]?.replace(/,/g, '')) || 0,
          changePercent: parseFloat(tds[5]?.replace(/,/g, '').replace('%', '')) || 0
        });
      }
    });
  });
  return results;
}

// Helper — parse an HTML table into rows of [cells...]
function htmlTableToRows(tableHtml) {
  const rows = tableHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  return rows.map(row => {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)];
    return cells.map(m => m[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim());
  });
}

// Convert two-row "header + values" table to {colName: value}
function rowsToColumnMap(rows) {
  if (rows.length < 2) return {};
  const headers = rows[0];
  const values = rows[1];
  const out = {};
  headers.forEach((h, i) => { if (h && values[i]) out[h] = values[i]; });
  return out;
}

function parseCompanyPage(html, symbol) {
  const result = { symbol };

  // Name from <h1>
  const nameMatch = html.match(/<h1[^>]*>([^<]+)/);
  result.name = nameMatch ? nameMatch[1].trim() : symbol;

  // Business description — first long paragraph after BUSINESS DESCRIPTION label, otherwise first long P
  const businessIdx = html.indexOf('BUSINESS DESCRIPTION');
  if (businessIdx >= 0) {
    const slice = html.substring(businessIdx, businessIdx + 4000);
    const pm = slice.match(/<p[^>]*>([\s\S]{50,3000}?)<\/p>/);
    if (pm) {
      result.about = pm[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  if (!result.about) {
    const paras = (html.match(/<p[^>]*>([\s\S]{50,3000}?)<\/p>/g) || [])
      .map(p => p.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(p => !/terms of use|agreement|all numbers in thousands/i.test(p) && p.length > 50);
    result.about = paras[0] || '';
  }

  // Pull labeled fields — ADDRESS, WEBSITE, REGISTRAR, AUDITOR all use the same item__head/item__body pattern
  const labelValue = (label) => {
    // Look for the label then capture the next block of text (skips closing/opening tags)
    const re = new RegExp(label + '[\\s\\S]{0,150}?>([^<]{3,300})<', 'i');
    const m = html.match(re);
    if (!m) return '';
    return m[1].replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  };
  result.address = labelValue('>ADDRESS<');
  result.website = labelValue('>WEBSITE<');
  result.registrar = labelValue('>REGISTRAR<');
  result.auditor = labelValue('>AUDITOR<');
  result.fiscalYearEnd = labelValue('>Fiscal Year End<');

  // Financial tables — annual (table 4), quarterly (table 5), ratios (table 6)
  const tables = html.match(/<table[\s\S]*?<\/table>/g) || [];
  const annualTable = tables.find(t => /EPS/.test(t) && /\b20\d{2}\b[\s\S]*\b20\d{2}\b/.test(t) && !/Q[1-4]/.test(t));
  const quarterlyTable = tables.find(t => /EPS/.test(t) && /Q[1-4]/.test(t));
  const ratiosTable = tables.find(t => /Margin|PEG|EPS Growth/.test(t));

  if (annualTable) {
    const rows = htmlTableToRows(annualTable);
    result.financialsAnnual = rows;
  }
  if (quarterlyTable) {
    const rows = htmlTableToRows(quarterlyTable);
    result.financialsQuarterly = rows;
  }
  if (ratiosTable) {
    const rows = htmlTableToRows(ratiosTable);
    result.ratiosAnnual = rows;
  }

  // Build a flat ratios object using most recent year (first data column)
  if (result.ratiosAnnual && result.ratiosAnnual.length >= 2) {
    const headers = result.ratiosAnnual[0]; // e.g. ['', '2025', '2024', '2023', '2022']
    const latestCol = 1; // first year column
    result.ratiosLatest = {};
    for (let i = 1; i < result.ratiosAnnual.length; i++) {
      const row = result.ratiosAnnual[i];
      const label = row[0];
      const val = row[latestCol];
      if (label && val) result.ratiosLatest[label] = val;
    }
  }
  if (result.financialsAnnual && result.financialsAnnual.length >= 2) {
    result.financialsLatest = {};
    for (let i = 1; i < result.financialsAnnual.length; i++) {
      const row = result.financialsAnnual[i];
      if (row[0] && row[1]) result.financialsLatest[row[0]] = row[1];
    }
  }
  if (result.financialsQuarterly && result.financialsQuarterly.length >= 2) {
    result.financialsLatestQuarter = {};
    for (let i = 1; i < result.financialsQuarterly.length; i++) {
      const row = result.financialsQuarterly[i];
      if (row[0] && row[1]) result.financialsLatestQuarter[row[0]] = row[1];
    }
  }

  return result;
}

// Parse stockanalysis.com statistics page — all metrics in <table><tr><td>label</td><td>value</td></tr>
function parseStockAnalysisStatistics(html) {
  const stats = {};
  const tables = html.match(/<table[\s\S]*?<\/table>/g) || [];
  tables.forEach(table => {
    const rows = table.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
    rows.forEach(row => {
      const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m =>
        m[1].replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '').trim()
      );
      if (tds.length >= 2 && tds[0] && tds[1] && tds[1] !== 'n/a') {
        stats[tds[0]] = tds[1];
      }
    });
  });
  return stats;
}

// Parse stockanalysis.com dividend history page
function parseStockAnalysisDividends(html) {
  const result = { history: [], summary: '', stats: {} };

  // Extract the top stat cards. Each is rendered as a label immediately followed
  // by <div class="mt-0.5 ...">VALUE</div>. The label MUST be directly adjacent
  // (just whitespace / closing comment between it and the <div>) — otherwise we'd
  // match the same words inside the natural-language summary paragraph above.
  const statLabels = ['Dividend Yield', 'Annual Dividend', 'Ex-Dividend Date', 'Payout Frequency', 'Payout Ratio', 'Dividend Growth'];
  statLabels.forEach(label => {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Allow only whitespace, HTML comments, or simple inline tags between label and value div
    const re = new RegExp(esc + '\\s*(?:<!--[\\s\\S]*?-->\\s*)*<div class="mt-0\\.5[^"]*"[^>]*>([\\s\\S]*?)<\\/div>');
    const m = html.match(re);
    if (m) {
      const val = m[1].replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (val && val !== 'n/a') result.stats[label] = val;
    }
  });

  // Pull the natural-language summary paragraph if present.
  // It's a <p class="text-base md:text-lg"> containing "PSX:SYMBOL ..." or
  // a sentence about dividends. Find the first <p> after "dividend" keyword.
  const summaryMatch = html.match(/<p class="text-base[^"]*"[^>]*>([\s\S]*?)<\/p>/);
  if (summaryMatch) {
    const text = summaryMatch[1]
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Only keep it if it looks like a dividend sentence
    if (/dividend|paid|yield|ex-dividend/i.test(text)) {
      result.summary = text;
    }
  }

  // Find the dividend history table (has Ex-Div in headers)
  const tables = html.match(/<table[\s\S]*?<\/table>/g) || [];
  for (const table of tables) {
    if (!table.includes('Ex-Div') && !table.includes('Cash Amount')) continue;
    const rows = table.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
    rows.forEach(row => {
      if (row.includes('<th')) return;
      const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m =>
        m[1].replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '').trim()
      );
      if (tds.length >= 3) {
        result.history.push({
          exDate: tds[0],
          amount: tds[1],
          recordDate: tds[2] || '',
          payDate: tds[3] || ''
        });
      }
    });
    break;
  }
  return result;
}

async function saFetch(urlPath) {
  const res = await fetch(`https://stockanalysis.com${urlPath}`, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    timeout: 15000
  });
  if (!res.ok) throw new Error(`stockanalysis.com returned ${res.status}`);
  return await res.text();
}

// --- Sector code to name mapping ---
const SECTOR_NAMES = {
  '0101': 'Automobile Assembler', '0102': 'Automobile Parts & Accessories',
  '0201': 'Cable & Electrical Goods', '0301': 'Cement',
  '0401': 'Chemical', '0501': 'Close-End Mutual Fund',
  '0601': 'Commercial Banks', '0701': 'Engineering',
  '0801': 'Fertilizer', '0802': 'Food & Personal Care Products',
  '0803': 'Glass & Ceramics', '0804': 'Insurance',
  '0805': 'Inv. Banks/Inv. Cos./Securities Cos.',
  '0806': 'Jute', '0807': 'Leasing Companies',
  '0808': 'Miscellaneous', '0809': 'Modarabas',
  '0810': 'Oil & Gas Exploration Companies',
  '0811': 'Oil & Gas Marketing Companies',
  '0812': 'Paper & Board', '0813': 'Pharmaceuticals',
  '0814': 'Power Generation & Distribution',
  '0815': 'Property', '0816': 'Refinery',
  '0817': 'Sugar & Allied Industries',
  '0818': 'Synthetic & Rayon',
  '0819': 'Technology & Communication',
  '0820': 'Textile Composite', '0821': 'Textile Spinning',
  '0822': 'Textile Weaving', '0823': 'Tobacco',
  '0824': 'Transport', '0825': 'Vanaspati & Allied Industries',
  '0826': 'Woollen', '0827': 'Synthetic & Rayon',
  '0828': 'Real Estate Investment Trust',
  '0829': 'Exchange Traded Funds',
  '0830': 'Textile (Other)', '0831': 'Textile Weaving',
  '0832': 'Tobacco', '0833': 'Transport',
  '0834': 'Vanaspati & Allied', '0835': 'Woollen',
  '0836': 'Real Estate Investment Trust',
  '0837': 'Exchange Traded Funds',
  '0838': 'Property', '0839': 'Miscellaneous Industries'
};

// Index code to listedIn tag mapping
// All known PSX index codes — each is matched against the stock's `listedIn` field
const INDEX_TAGS = {
  'KSE100': 'KSE100',
  'KSE100PR': 'KSE100PR',
  'KSE30': 'KSE30',
  'KMI30': 'KMI30',
  'KMIALLSHR': 'KMIALLSHR',
  'ALLSHR': 'ALLSHR',
  'BKTI': 'BKTI',
  'OGTI': 'OGTI',
  'PSXDIV20': 'PSXDIV20',
  'UPP9': 'UPP9',
  'NITPGI': 'NITPGI',
  'NBPPGI': 'NBPPGI',
  'MZNPI': 'MZNPI',
  'JSMFI': 'JSMFI',
  'ACI': 'ACI',
  'JSGBKTI': 'JSGBKTI',
  'MII30': 'MII30',
  'HBLTTI': 'HBLTTI'
};

// Sector groupings for sector indices
const SECTOR_INDEX_MAP = {
  'OILGAS': ['0810', '0811'],
  'CEMENT': ['0301'],
  'BANK': ['0601'],
  'TECH': ['0819'],
  'TEXTILE': ['0820', '0821', '0822'],
  'FERT': ['0801'],
  'AUTO': ['0101', '0102'],
  'POWER': ['0814'],
  'PHARMA': ['0813'],
  'CHEMICAL': ['0401'],
  'INSURANCE': ['0804'],
  'REFINERY': ['0816']
};

// --- API Routes ---

// Market watch - all stocks
app.get('/api/market-watch', async (req, res) => {
  try {
    let data = getCached('market-watch', 30000);
    if (!data) {
      const result = await psxFetch('/market-watch');
      data = parseMarketWatch(result.data);
      data.forEach(s => { s.sectorName = SECTOR_NAMES[s.sectorCode] || s.sectorCode; });
      setCache('market-watch', data);
    }
    res.json({ status: 1, data });
  } catch (err) {
    const stale = getStaleCache('market-watch');
    if (stale) return res.json({ status: 1, data: stale, stale: true });
    res.status(502).json({ status: 0, error: 'Market data unavailable', detail: err.message });
  }
});

// Indices
app.get('/api/indices', async (req, res) => {
  try {
    let data = getCached('indices', 30000);
    if (!data) {
      const result = await psxFetch('/indices');
      data = parseIndices(result.data);
      setCache('indices', data);
    }
    res.json({ status: 1, data });
  } catch (err) {
    const stale = getStaleCache('indices');
    if (stale) return res.json({ status: 1, data: stale, stale: true });
    res.status(502).json({ status: 0, error: 'Indices data unavailable' });
  }
});

// Index constituents - stocks belonging to a specific index or sector
app.get('/api/index/:indexId', async (req, res) => {
  try {
    let allStocks = getCached('market-watch', 30000);
    if (!allStocks) {
      const result = await psxFetch('/market-watch');
      allStocks = parseMarketWatch(result.data);
      allStocks.forEach(s => { s.sectorName = SECTOR_NAMES[s.sectorCode] || s.sectorCode; });
      setCache('market-watch', allStocks);
    }

    const indexId = req.params.indexId.toUpperCase();
    let filtered;

    if (INDEX_TAGS[indexId]) {
      filtered = allStocks.filter(s => s.listedIn.includes(INDEX_TAGS[indexId]));
    } else if (SECTOR_INDEX_MAP[indexId]) {
      const codes = SECTOR_INDEX_MAP[indexId];
      filtered = allStocks.filter(s => codes.includes(s.sectorCode));
    } else {
      filtered = allStocks;
    }

    filtered.sort((a, b) => b.volume - a.volume);
    res.json({ status: 1, data: filtered });
  } catch (err) {
    res.status(502).json({ status: 0, error: 'Index data unavailable' });
  }
});

// Timeseries (eod or int)
app.get('/api/timeseries/:type/:symbol', async (req, res) => {
  const { type, symbol } = req.params;
  if (!['eod', 'int'].includes(type)) return res.status(400).json({ error: 'type must be eod or int' });

  const cacheKey = `ts-${type}-${symbol.toUpperCase()}`;
  const ttl = type === 'eod' ? 3600000 : 60000;

  try {
    let data = getCached(cacheKey, ttl);
    if (!data) {
      const result = await psxFetch(`/timeseries/${type}/${symbol.toUpperCase()}`);
      if (result.type === 'json' && result.data.status === 1) {
        const raw = result.data.data;
        if (type === 'eod') {
          data = raw.map(r => ({
            timestamp: r[0],
            date: new Date(r[0] * 1000).toISOString().split('T')[0],
            close: r[1],
            volume: r[2],
            open: r[3]
          }));
        } else {
          data = raw.map(r => ({
            timestamp: r[0],
            price: r[1],
            volume: r[2]
          }));
        }
        setCache(cacheKey, data);
      } else {
        throw new Error('Invalid response from PSX');
      }
    }
    res.json({ status: 1, data });
  } catch (err) {
    const stale = getStaleCache(cacheKey);
    if (stale) return res.json({ status: 1, data: stale, stale: true });
    res.status(502).json({ status: 0, error: 'Timeseries data unavailable' });
  }
});

// Company profile
app.get('/api/company/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cacheKey = `company-${symbol}`;

  try {
    let data = getCached(cacheKey, 86400000);
    if (!data) {
      const result = await psxFetch(`/company/${symbol}`);
      data = parseCompanyPage(result.data, symbol);
      setCache(cacheKey, data);
    }
    res.json({ status: 1, data });
  } catch (err) {
    res.status(502).json({ status: 0, error: 'Company data unavailable' });
  }
});

// Fundamentals from stockanalysis.com
app.get('/api/fundamentals/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cacheKey = `fund-${symbol}`;
  try {
    let data = getCached(cacheKey, 86400000);
    if (!data) {
      const html = await saFetch(`/quote/psx/${symbol}/statistics/`);
      data = parseStockAnalysisStatistics(html);
      if (Object.keys(data).length === 0) throw new Error('No fundamentals parsed');
      setCache(cacheKey, data);
    }
    res.json({ status: 1, data });
  } catch (err) {
    const stale = getStaleCache(cacheKey);
    if (stale) return res.json({ status: 1, data: stale, stale: true });
    res.status(502).json({ status: 0, error: 'Fundamentals unavailable', detail: err.message });
  }
});

// Dividends from stockanalysis.com
app.get('/api/dividends/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cacheKey = `div-${symbol}`;
  try {
    let data = getCached(cacheKey, 21600000);
    if (!data) {
      const html = await saFetch(`/quote/psx/${symbol}/dividend/`);
      data = parseStockAnalysisDividends(html);
      setCache(cacheKey, data);
    }
    res.json({ status: 1, data });
  } catch (err) {
    const stale = getStaleCache(cacheKey);
    if (stale) return res.json({ status: 1, data: stale, stale: true });
    res.status(502).json({ status: 0, error: 'Dividend data unavailable', detail: err.message });
  }
});

// Sector summary - computed from market-watch data
app.get('/api/sector-summary', async (req, res) => {
  try {
    let allStocks = getCached('market-watch', 60000);
    if (!allStocks) {
      const result = await psxFetch('/market-watch');
      allStocks = parseMarketWatch(result.data);
      allStocks.forEach(s => { s.sectorName = SECTOR_NAMES[s.sectorCode] || s.sectorCode; });
      setCache('market-watch', allStocks);
    }

    const sectors = {};
    allStocks.forEach(s => {
      if (!sectors[s.sectorCode]) {
        sectors[s.sectorCode] = { name: s.sectorName, code: s.sectorCode, stocks: 0, totalVolume: 0, gainers: 0, losers: 0, unchanged: 0 };
      }
      const sec = sectors[s.sectorCode];
      sec.stocks++;
      sec.totalVolume += s.volume;
      if (s.change > 0) sec.gainers++;
      else if (s.change < 0) sec.losers++;
      else sec.unchanged++;
    });

    res.json({ status: 1, data: Object.values(sectors).sort((a, b) => b.totalVolume - a.totalVolume) });
  } catch (err) {
    res.status(502).json({ status: 0, error: 'Sector data unavailable' });
  }
});

// Static files
// ── Portfolio persistence ──────────────────────────────────────────
// GET → returns the saved {trades, settings} object (empty trades if no file yet)
// PUT → overwrites the file with the supplied {trades, settings}
app.get('/api/portfolio', (req, res) => {
  res.json({ status: 1, data: readPortfolio() });
});
app.put('/api/portfolio', (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.trades)) {
    return res.status(400).json({ status: 0, error: 'Invalid payload: trades must be an array' });
  }
  const ok = writePortfolio({ trades: body.trades, settings: body.settings || null });
  if (!ok) return res.status(500).json({ status: 0, error: 'Failed to write portfolio file' });
  res.json({ status: 1, data: { trades: body.trades.length } });
});

app.use(express.static(path.join(__dirname)));

// Fallback to app.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});

// Only start the HTTP listener when run directly (i.e. `node server.js`).
// On serverless platforms (Vercel) the file is imported and the app is wrapped
// as a function — we just export the app there.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PSX Dashboard running at http://localhost:${PORT}`);
  });
}

module.exports = app;
