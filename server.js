const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const { execSync, exec } = require("child_process");
const cors = require("cors");
const { rateLimiter } = require('./rate-limiter');

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
// ---------------------------------------------------------------------------
// Rate limiting — defense in depth (also rate-limited at nginx level)
// ---------------------------------------------------------------------------
const apiLimiter = rateLimiter({ windowMs: 60000, max: 60, message: 'Too many API requests. Please wait a moment.' });
const exportLimiter = rateLimiter({ windowMs: 60000, max: 5, message: 'Export rate limit exceeded. Please wait before exporting again.' });
const authLimiter = rateLimiter({ windowMs: 60000, max: 10, message: 'Too many auth attempts. Please wait.' });
const proLimiter = rateLimiter({ windowMs: 60000, max: 30, message: 'Pro API rate limit exceeded. Please wait.' });


// Database setup
const DB_PATH = path.join(__dirname, "data", "world_markets.db");
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.pragma("journal_mode = WAL");

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    value REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS country_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    country TEXT NOT NULL,
    ticker TEXT NOT NULL,
    price REAL NOT NULL,
    weight REAL NOT NULL,
    contribution REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_readings_timestamp ON readings(timestamp);
  CREATE INDEX IF NOT EXISTS idx_country_data_timestamp ON country_data(timestamp);
  CREATE TABLE IF NOT EXISTS bitcoin_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    price REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bitcoin_timestamp ON bitcoin_data(timestamp);
`);

// ---------------------------------------------------------------------------
// Auth helpers — nginx sets X-Auth-* headers from the auth_request subrequest
// ---------------------------------------------------------------------------

// API key validation helper — calls auth server at localhost:5010
// Passes this dashboard's Stripe product ID so the auth server verifies
// the user actually has a subscription covering this specific dashboard.
const DASHBOARD_PRODUCT_ID = 'prod_UGE7tfjecutQJD'; // World Markets Index

function validateApiKeyRemote(apiKey) {
  return new Promise((resolve) => {
    const url = `http://localhost:5010/auth/validate-key?key=${encodeURIComponent(apiKey)}&product=${encodeURIComponent(DASHBOARD_PRODUCT_ID)}`;
    require('http').get(url, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve({ valid: false }); }
      });
    }).on('error', () => resolve({ valid: false }));
  });
}

// API key cache: key -> { tier, email, expires }
const apiKeyCache = new Map();

/**
 * Middleware: require any authenticated user (Basic or Pro).
 * Method 1: nginx sets X-Auth-Plan-Tier (cookie-based flow — unchanged).
 * Method 2: X-API-Key header (direct programmatic access, validated via auth server).
 */
async function requireAuth(req, res, next) {
  // Method 1: nginx auth (existing cookie-based flow)
  const tier = req.headers['x-auth-plan-tier'];
  if (tier) {
    req.planTier = tier;
    return next();
  }

  // Method 2: API key (direct programmatic access)
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    // Check cache first
    const cached = apiKeyCache.get(apiKey);
    if (cached && cached.expires > Date.now()) {
      req.planTier = cached.tier;
      return next();
    }

    try {
      const data = await validateApiKeyRemote(apiKey);
      if (data.valid) {
        // Cache for 60 seconds
        apiKeyCache.set(apiKey, { tier: data.tier, email: data.email, expires: Date.now() + 60000 });
        req.planTier = data.tier;
        return next();
      }
    } catch(e) { /* auth server unreachable */ }

    return res.status(401).json({ error: 'Invalid API key' });
  }

  return res.status(401).json({ error: 'Authentication required. Access this dashboard through the website.' });
}

function requirePro(req, res, next) {
  if (!req.planTier) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (req.planTier !== 'pro') {
    return res.status(403).json({ error: 'Pro subscription required for API access. Upgrade at https://quantitativegenius.com' });
  }
  next();
}

// Country metadata (for flag emojis, GDP, etc.)
const COUNTRY_META = {
  USA: { flag: "🇺🇸", gdp: "$28.78T", ppp: "$28.78T", index: "S&P 500" },
  China: { flag: "🇨🇳", gdp: "$18.53T", ppp: "$35.29T", index: "SSE Composite" },
  Japan: { flag: "🇯🇵", gdp: "$4.39T", ppp: "$6.72T", index: "Nikkei 225" },
  Germany: { flag: "🇩🇪", gdp: "$4.59T", ppp: "$5.68T", index: "DAX" },
  India: { flag: "🇮🇳", gdp: "$3.94T", ppp: "$14.59T", index: "BSE Sensex" },
  UK: { flag: "🇬🇧", gdp: "$3.50T", ppp: "$4.03T", index: "FTSE 100" },
  France: { flag: "🇫🇷", gdp: "$3.13T", ppp: "$3.87T", index: "CAC 40" },
  Canada: { flag: "🇨🇦", gdp: "$2.24T", ppp: "$2.42T", index: "S&P/TSX" },
  "South Korea": { flag: "🇰🇷", gdp: "$1.72T", ppp: "$2.83T", index: "KOSPI" },
  Australia: { flag: "🇦🇺", gdp: "$1.79T", ppp: "$1.72T", index: "ASX 200" },
  Brazil: { flag: "🇧🇷", gdp: "$2.17T", ppp: "$4.02T", index: "Bovespa" },
  Italy: { flag: "🇮🇹", gdp: "$2.26T", ppp: "$3.07T", index: "FTSE MIB" },
  Mexico: { flag: "🇲🇽", gdp: "$1.79T", ppp: "$3.17T", index: "IPC" },
  Spain: { flag: "🇪🇸", gdp: "$1.58T", ppp: "$2.21T", index: "IBEX 35" },
  Indonesia: { flag: "🇮🇩", gdp: "$1.42T", ppp: "$4.39T", index: "IDX Composite" },
  "Saudi Arabia": { flag: "🇸🇦", gdp: "$1.11T", ppp: "$2.15T", index: "Tadawul" },
  Netherlands: { flag: "🇳🇱", gdp: "$1.09T", ppp: "$1.23T", index: "AEX" },
  Turkey: { flag: "🇹🇷", gdp: "$1.11T", ppp: "$3.60T", index: "BIST 100" },
  Taiwan: { flag: "🇹🇼", gdp: "$0.79T", ppp: "$1.65T", index: "TAIEX" },
  Switzerland: { flag: "🇨🇭", gdp: "$0.91T", ppp: "$0.75T", index: "SMI" },
};

// GET /api/user-tier
app.get('/api/user-tier', apiLimiter, requireAuth, (req, res) => {
  res.json({ tier: req.planTier });
});

// API: Get current composite value + all country data
app.get("/api/composite", apiLimiter, requireAuth, (req, res) => {
  try {
    // Get latest reading
    const latest = db
      .prepare("SELECT * FROM readings ORDER BY timestamp DESC LIMIT 1")
      .get();

    // Get previous reading for daily change
    const readings = db
      .prepare("SELECT * FROM readings ORDER BY timestamp DESC LIMIT 2")
      .all();

    let dailyChange = 0;
    let dailyChangePct = 0;
    if (readings.length >= 2) {
      dailyChange = readings[0].value - readings[1].value;
      dailyChangePct = (dailyChange / readings[1].value) * 100;
    }

    // Get latest country data
    const latestTimestamp = latest ? latest.timestamp : null;
    let countries = [];
    if (latestTimestamp) {
      countries = db
        .prepare(
          "SELECT * FROM country_data WHERE timestamp = ? ORDER BY contribution DESC"
        )
        .all(latestTimestamp);
    }

    // Enrich with metadata
    countries = countries.map((c) => ({
      ...c,
      ...(COUNTRY_META[c.country] || {}),
    }));

    // Calculate per-country change from previous day
    if (readings.length >= 2) {
      const prevTimestamp = readings[1].timestamp;
      const prevCountries = db
        .prepare("SELECT * FROM country_data WHERE timestamp = ?")
        .all(prevTimestamp);
      const prevMap = {};
      prevCountries.forEach((pc) => {
        prevMap[pc.country] = pc;
      });
      countries = countries.map((c) => {
        const prev = prevMap[c.country];
        const changePct =
          prev && prev.price > 0
            ? ((c.price - prev.price) / prev.price) * 100
            : 0;
        return { ...c, change_pct: Math.round(changePct * 100) / 100 };
      });
    }

    res.json({
      composite: latest ? latest.value : 0,
      timestamp: latest ? latest.timestamp : null,
      dailyChange: Math.round(dailyChange * 100) / 100,
      dailyChangePct: Math.round(dailyChangePct * 100) / 100,
      countries,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Historical readings
app.get("/api/history", apiLimiter, requireAuth, (req, res) => {
  try {
    const range = req.query.range || "1Y";
    let query;
    const now = new Date();

    switch (range) {
      case "1H": {
        // Readings from the last 60 minutes only
        const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
        query = db
          .prepare("SELECT * FROM readings WHERE timestamp >= ? ORDER BY timestamp ASC")
          .all(hourAgo);
        break;
      }
      case "1D": {
        // Readings from the last 24 hours only
        const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
        query = db
          .prepare("SELECT * FROM readings WHERE timestamp >= ? ORDER BY timestamp ASC")
          .all(dayAgo);
        break;
      }
      case "1W":
        const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0];
        query = db
          .prepare(
            "SELECT * FROM readings WHERE timestamp >= ? ORDER BY timestamp ASC"
          )
          .all(weekAgo);
        break;
      case "1Y": {
        const yearAgo = new Date(
          now.getFullYear() - 1,
          now.getMonth(),
          now.getDate()
        )
          .toISOString()
          .split("T")[0];
        query = db
          .prepare(
            `SELECT MAX(timestamp) as timestamp, ROUND(AVG(value), 2) as value
             FROM readings WHERE timestamp >= ?
             GROUP BY strftime('%Y-%W', timestamp)
             ORDER BY timestamp ASC`
          )
          .all(yearAgo);
        // Append the very latest reading so the chart reaches today
        const latestFor1Y = db.prepare("SELECT timestamp, value FROM readings ORDER BY timestamp DESC LIMIT 1").get();
        if (latestFor1Y && (query.length === 0 || query[query.length - 1].timestamp !== latestFor1Y.timestamp)) {
          query.push(latestFor1Y);
        }
        break;
      }
      case "MAX":
        query = db
          .prepare(
            `SELECT MAX(timestamp) as timestamp, ROUND(AVG(value), 2) as value
             FROM readings
             GROUP BY strftime('%Y-%W', timestamp)
             ORDER BY timestamp ASC`
          )
          .all();
        // Append the very latest reading so the chart reaches today
        const latestForMAX = db.prepare("SELECT timestamp, value FROM readings ORDER BY timestamp DESC LIMIT 1").get();
        if (latestForMAX && (query.length === 0 || query[query.length - 1].timestamp !== latestForMAX.timestamp)) {
          query.push(latestForMAX);
        }
        break;
      default:
        query = db
          .prepare("SELECT * FROM readings ORDER BY timestamp DESC LIMIT 365")
          .all()
          .reverse();
    }

    res.json({ range, data: query });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Historical country prices for chart overlay (USA/China)
app.get("/api/country-history", apiLimiter, requireAuth, (req, res) => {
  try {
    const range = req.query.range || "MAX";
    const now = new Date();
    let rows;

    if (range === '1H') {
      // Readings from the last 60 minutes only
      const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
      rows = db.prepare(`
        SELECT r.timestamp,
          MAX(CASE WHEN cd.country='USA' THEN cd.price END) as usa_price,
          MAX(CASE WHEN cd.country='China' THEN cd.price END) as china_price
        FROM readings r
        LEFT JOIN country_data cd ON cd.timestamp = r.timestamp AND cd.country IN ('USA','China')
        WHERE r.timestamp >= ?
        GROUP BY r.timestamp
        ORDER BY r.timestamp ASC
      `).all(hourAgo);

    } else if (range === '1D') {
      // Readings from the last 24 hours only
      const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
      rows = db.prepare(`
        SELECT r.timestamp,
          MAX(CASE WHEN cd.country='USA' THEN cd.price END) as usa_price,
          MAX(CASE WHEN cd.country='China' THEN cd.price END) as china_price
        FROM readings r
        LEFT JOIN country_data cd ON cd.timestamp = r.timestamp AND cd.country IN ('USA','China')
        WHERE r.timestamp >= ?
        GROUP BY r.timestamp
        ORDER BY r.timestamp ASC
      `).all(dayAgo);

    } else if (range === '1W') {
      // Raw readings from the past 7 days
      const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      rows = db.prepare(`
        SELECT r.timestamp,
          MAX(CASE WHEN cd.country='USA' THEN cd.price END) as usa_price,
          MAX(CASE WHEN cd.country='China' THEN cd.price END) as china_price
        FROM readings r
        LEFT JOIN country_data cd ON cd.timestamp = r.timestamp AND cd.country IN ('USA','China')
        WHERE r.timestamp >= ?
        GROUP BY r.timestamp
        ORDER BY r.timestamp ASC
      `).all(weekAgo);

    } else if (range === '1Y') {
      // Weekly averages for past year
      const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()).toISOString().split('T')[0];
      rows = db.prepare(`
        SELECT MAX(r.timestamp) as timestamp,
          ROUND(AVG(CASE WHEN cd.country='USA' THEN cd.price END), 2) as usa_price,
          ROUND(AVG(CASE WHEN cd.country='China' THEN cd.price END), 2) as china_price
        FROM readings r
        LEFT JOIN country_data cd ON cd.timestamp = r.timestamp AND cd.country IN ('USA','China')
        WHERE r.timestamp >= ?
        GROUP BY strftime('%Y-%W', r.timestamp)
        ORDER BY timestamp ASC
      `).all(yearAgo);
      // Append latest reading so chart extends to today
      const latestCH1Y = db.prepare(`
        SELECT r.timestamp,
          MAX(CASE WHEN cd.country='USA' THEN cd.price END) as usa_price,
          MAX(CASE WHEN cd.country='China' THEN cd.price END) as china_price
        FROM (SELECT * FROM readings ORDER BY timestamp DESC LIMIT 1) r
        LEFT JOIN country_data cd ON cd.timestamp = r.timestamp AND cd.country IN ('USA','China')
        GROUP BY r.timestamp
      `).get();
      if (latestCH1Y && (rows.length === 0 || rows[rows.length - 1].timestamp !== latestCH1Y.timestamp)) {
        rows.push(latestCH1Y);
      }

    } else {
      // MAX: weekly averages across all data
      rows = db.prepare(`
        SELECT MAX(r.timestamp) as timestamp,
          ROUND(AVG(CASE WHEN cd.country='USA' THEN cd.price END), 2) as usa_price,
          ROUND(AVG(CASE WHEN cd.country='China' THEN cd.price END), 2) as china_price
        FROM readings r
        LEFT JOIN country_data cd ON cd.timestamp = r.timestamp AND cd.country IN ('USA','China')
        GROUP BY strftime('%Y-%W', r.timestamp)
        ORDER BY timestamp ASC
      `).all();
      // Append latest reading so chart extends to today
      const latestCHMAX = db.prepare(`
        SELECT r.timestamp,
          MAX(CASE WHEN cd.country='USA' THEN cd.price END) as usa_price,
          MAX(CASE WHEN cd.country='China' THEN cd.price END) as china_price
        FROM (SELECT * FROM readings ORDER BY timestamp DESC LIMIT 1) r
        LEFT JOIN country_data cd ON cd.timestamp = r.timestamp AND cd.country IN ('USA','China')
        GROUP BY r.timestamp
      `).get();
      if (latestCHMAX && (rows.length === 0 || rows[rows.length - 1].timestamp !== latestCHMAX.timestamp)) {
        rows.push(latestCHMAX);
      }
    }

    res.json({ range, data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Historical Bitcoin prices
app.get("/api/bitcoin-history", apiLimiter, requireAuth, (req, res) => {
  try {
    const range = req.query.range || "MAX";
    const now = new Date();
    let rows;

    if (range === '1H') {
      const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
      const dateFloor = hourAgo.split('T')[0];
      rows = db.prepare('SELECT timestamp, price FROM bitcoin_data WHERE timestamp >= ? OR timestamp = ? ORDER BY timestamp ASC').all(hourAgo, dateFloor);
    } else if (range === '1D') {
      const dayAgoDate = new Date(now - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      rows = db.prepare('SELECT timestamp, price FROM bitcoin_data WHERE timestamp >= ? ORDER BY timestamp ASC').all(dayAgoDate);
    } else if (range === '1W') {
      const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      rows = db.prepare('SELECT timestamp, price FROM bitcoin_data WHERE timestamp >= ? ORDER BY timestamp ASC').all(weekAgo);
    } else if (range === '1Y') {
      const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()).toISOString().split('T')[0];
      rows = db.prepare(`
        SELECT MAX(timestamp) as timestamp, ROUND(AVG(price), 2) as price
        FROM bitcoin_data WHERE timestamp >= ?
        GROUP BY strftime('%Y-%W', timestamp)
        ORDER BY timestamp ASC
      `).all(yearAgo);
      const latest = db.prepare('SELECT timestamp, price FROM bitcoin_data ORDER BY timestamp DESC LIMIT 1').get();
      if (latest && (rows.length === 0 || rows[rows.length - 1].timestamp !== latest.timestamp)) {
        rows.push(latest);
      }
    } else {
      // MAX
      rows = db.prepare(`
        SELECT MAX(timestamp) as timestamp, ROUND(AVG(price), 2) as price
        FROM bitcoin_data
        GROUP BY strftime('%Y-%W', timestamp)
        ORDER BY timestamp ASC
      `).all();
      const latest = db.prepare('SELECT timestamp, price FROM bitcoin_data ORDER BY timestamp DESC LIMIT 1').get();
      if (latest && (rows.length === 0 || rows[rows.length - 1].timestamp !== latest.timestamp)) {
        rows.push(latest);
      }
    }

    res.json({ readings: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: All countries with current data
app.get("/api/countries", apiLimiter, requireAuth, (req, res) => {
  try {
    const latest = db
      .prepare("SELECT timestamp FROM readings ORDER BY timestamp DESC LIMIT 1")
      .get();

    if (!latest) {
      return res.json({ countries: [] });
    }

    let countries = db
      .prepare(
        "SELECT * FROM country_data WHERE timestamp = ? ORDER BY contribution DESC"
      )
      .all(latest.timestamp);

    countries = countries.map((c) => ({
      ...c,
      ...(COUNTRY_META[c.country] || {}),
    }));

    res.json({ timestamp: latest.timestamp, countries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Store new reading (internal only — called by fetch script on localhost)
app.post("/api/readings", (req, res) => {
  // Only allow from localhost
  const ip = req.ip || req.connection.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'Internal endpoint' });
  }
  try {
    const { timestamp, value, countries } = req.body;

    if (!timestamp || !value) {
      return res.status(400).json({ error: "timestamp and value required" });
    }

    // Glitch protection: reject >20% drop from previous
    const lastReading = db
      .prepare("SELECT * FROM readings ORDER BY timestamp DESC LIMIT 1")
      .get();
    if (lastReading) {
      const dropPct =
        ((lastReading.value - value) / lastReading.value) * 100;
      if (dropPct > 20) {
        return res.status(400).json({
          error: `Rejected: ${dropPct.toFixed(1)}% drop from previous value`,
        });
      }

      // Duplicate prevention: only store if >0.01 point change
      if (Math.abs(value - lastReading.value) < 0.01) {
        return res.json({ status: "skipped", reason: "value unchanged" });
      }
    }

    db.prepare("INSERT INTO readings (timestamp, value) VALUES (?, ?)").run(
      timestamp,
      value
    );

    // Store country data if provided
    if (countries && Array.isArray(countries)) {
      const stmt = db.prepare(
        "INSERT INTO country_data (timestamp, country, ticker, price, weight, contribution) VALUES (?, ?, ?, ?, ?, ?)"
      );
      const insertMany = db.transaction((items) => {
        for (const c of items) {
          stmt.run(
            timestamp,
            c.country,
            c.ticker,
            c.price,
            c.weight,
            c.contribution
          );
        }
      });
      insertMany(countries);
    }

    res.json({ status: "ok", value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Pro-only: CSV/JSON export endpoints
// Serve pre-generated files from data/exports/ when available,
// fall back to live DB queries if files don't exist yet.
// ---------------------------------------------------------------------------

const EXPORT_DIR = path.join(__dirname, 'data', 'exports');
const DAILY_DIR = path.join(EXPORT_DIR, 'daily');

// Helper: try to serve a pre-generated file, return false if not found
function tryServeFile(filePath, contentType, downloadName, res) {
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('X-Export-Source', 'pre-generated');
    return res.sendFile(filePath);
  }
  return false;
}

// --- JSON export ---
app.get('/api/export/json', exportLimiter, requireAuth, requirePro, (req, res) => {
  try {
    const range = req.query.range || 'MAX';

    // Try pre-generated files first
    if (range === 'MAX') {
      const file = path.join(EXPORT_DIR, 'world-markets-history.json');
      if (fs.existsSync(file)) return tryServeFile(file, 'application/json', 'world-markets-index-MAX.json', res);
    }

    // Check for today's daily snapshot
    const today = new Date().toISOString().split('T')[0];
    if (range === '1D' || range === 'latest') {
      const file = path.join(DAILY_DIR, `${today}.json`);
      if (fs.existsSync(file)) return tryServeFile(file, 'application/json', `world-markets-index-${today}.json`, res);
    }

    // Latest snapshot
    const latestFile = path.join(EXPORT_DIR, 'world-markets-latest.json');
    if (range === 'latest' && fs.existsSync(latestFile)) {
      return tryServeFile(latestFile, 'application/json', 'world-markets-latest.json', res);
    }

    // Fallback: live DB query
    const now = new Date();
    let since = '1900-01-01T00:00:00.000Z';
    switch (range) {
      case '1W': since = new Date(now - 7 * 86400000).toISOString(); break;
      case '1M': since = new Date(now - 30 * 86400000).toISOString(); break;
      case '1Y': since = new Date(now - 365 * 86400000).toISOString(); break;
      case 'MAX': default: since = '1900-01-01T00:00:00.000Z';
    }

    // Daily-only readings (1 row per calendar day, matching CSV pattern)
    const readings = db.prepare(`
      SELECT date(timestamp) as date, MAX(timestamp) as timestamp, value as composite_value
      FROM readings WHERE timestamp >= ? GROUP BY date(timestamp) ORDER BY date ASC
    `).all(since);

    // Get bitcoin prices by date
    const btcRows = db.prepare(`
      SELECT date(timestamp) as date, price
      FROM bitcoin_data WHERE timestamp >= ?
      GROUP BY date(timestamp)
      HAVING timestamp = MAX(timestamp)
      ORDER BY date ASC
    `).all(since);
    const btcByDate = {};
    for (const row of btcRows) btcByDate[row.date] = row.price;

    // Add bitcoin_price to each reading
    const dataWithBtc = readings.map(r => ({
      ...r,
      bitcoin_price: btcByDate[r.date] != null ? btcByDate[r.date] : null
    }));

    const latestTs = readings.length > 0 ? readings[readings.length - 1].timestamp : null;
    let countries = [];
    if (latestTs) {
      countries = db.prepare(
        'SELECT country, ticker, price, weight, contribution FROM country_data WHERE timestamp = ? ORDER BY contribution DESC'
      ).all(latestTs);
    }

    res.setHeader('Content-Disposition', `attachment; filename="world-markets-index-${range}.json"`);
    res.setHeader('X-Export-Source', 'live-query');
    res.json({ export_date: new Date().toISOString(), range, record_count: dataWithBtc.length, data: dataWithBtc, latest_countries: countries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CSV export ---
app.get('/api/export/csv', exportLimiter, requireAuth, requirePro, (req, res) => {
  try {
    const range = req.query.range || 'MAX';

    // Try pre-generated files first
    if (range === 'MAX') {
      const file = path.join(EXPORT_DIR, 'world-markets-history.csv');
      if (fs.existsSync(file)) return tryServeFile(file, 'text/csv', 'world-markets-index-MAX.csv', res);
    }

    const today = new Date().toISOString().split('T')[0];
    if (range === '1D' || range === 'latest') {
      const file = path.join(DAILY_DIR, `${today}.csv`);
      if (fs.existsSync(file)) return tryServeFile(file, 'text/csv', `world-markets-index-${today}.csv`, res);
    }

    const latestFile = path.join(EXPORT_DIR, 'world-markets-latest.csv');
    if (range === 'latest' && fs.existsSync(latestFile)) {
      return tryServeFile(latestFile, 'text/csv', 'world-markets-latest.csv', res);
    }

    // Fallback: live DB query — includes per-country columns
    const now = new Date();
    let since = '1900-01-01T00:00:00.000Z';
    switch (range) {
      case '1W': since = new Date(now - 7 * 86400000).toISOString(); break;
      case '1M': since = new Date(now - 30 * 86400000).toISOString(); break;
      case '1Y': since = new Date(now - 365 * 86400000).toISOString(); break;
      case 'MAX': default: since = '1900-01-01T00:00:00.000Z';
    }

    // Get daily close readings (one per calendar day)
    const readings = db.prepare(`
      SELECT date(timestamp) as date, MAX(timestamp) as timestamp, value as composite_value
      FROM readings WHERE timestamp >= ? GROUP BY date(timestamp) ORDER BY date ASC
    `).all(since);

    // Get distinct countries in weight order
    const countries = db.prepare(`
      SELECT DISTINCT country FROM country_data ORDER BY weight DESC
    `).all().map(r => r.country);

    // Get all country data for the time range, keyed by timestamp
    const countryRows = db.prepare(`
      SELECT cd.timestamp, cd.country, cd.price
      FROM country_data cd
      INNER JOIN (
        SELECT date(timestamp) as d, MAX(timestamp) as max_ts
        FROM readings WHERE timestamp >= ? GROUP BY date(timestamp)
      ) latest ON cd.timestamp = latest.max_ts
      ORDER BY cd.timestamp ASC
    `).all(since);

    // Build lookup: timestamp -> { country: price }
    const countryByTs = {};
    for (const row of countryRows) {
      if (!countryByTs[row.timestamp]) countryByTs[row.timestamp] = {};
      countryByTs[row.timestamp][row.country] = row.price;
    }

    // Get bitcoin prices by date
    const btcRows = db.prepare(`
      SELECT date(timestamp) as date, price
      FROM bitcoin_data WHERE timestamp >= ?
      GROUP BY date(timestamp)
      HAVING timestamp = MAX(timestamp)
      ORDER BY date ASC
    `).all(since);
    const btcByDate = {};
    for (const row of btcRows) btcByDate[row.date] = row.price;

    // Build CSV header
    const countryHeaders = countries.map(c => `"${c}"`).join(',');
    let csv = `date,timestamp,composite_value${countries.length ? ',' + countryHeaders : ''},bitcoin_price\n`;

    // Build CSV rows
    for (const r of readings) {
      const cData = countryByTs[r.timestamp] || {};
      const countryValues = countries.map(c => cData[c] != null ? cData[c] : '').join(',');
      const btcPrice = btcByDate[r.date] != null ? btcByDate[r.date] : '';
      csv += `${r.date},${r.timestamp},${r.composite_value}${countries.length ? ',' + countryValues : ''},${btcPrice}\n`;
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="world-markets-index-${range}.csv"`);
    res.setHeader('X-Export-Source', 'live-query');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Pro API: Structured data endpoints for programmatic access
// ---------------------------------------------------------------------------

// GET /api/pro/latest — Latest composite + all country data (JSON)
app.get('/api/pro/latest', proLimiter, requireAuth, requirePro, (req, res) => {
  try {
    // Try pre-generated file
    const file = path.join(EXPORT_DIR, 'world-markets-latest.json');
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      data.source = 'pre-generated';
      return res.json(data);
    }

    // Fallback: live query
    const latest = db.prepare('SELECT timestamp, value as composite_value FROM readings ORDER BY timestamp DESC LIMIT 1').get();
    if (!latest) return res.json({ error: 'No data available' });

    const countries = db.prepare(
      'SELECT country, ticker, price, weight, contribution FROM country_data WHERE timestamp = ? ORDER BY contribution DESC'
    ).all(latest.timestamp);

    res.json({
      date: latest.timestamp.split('T')[0],
      timestamp: latest.timestamp,
      composite_value: latest.composite_value,
      countries,
      source: 'live-query'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pro/history — Full daily history (JSON)
app.get('/api/pro/history', proLimiter, requireAuth, requirePro, (req, res) => {
  try {
    const format = req.query.format || 'json';

    // Try pre-generated file
    if (format === 'json') {
      const file = path.join(EXPORT_DIR, 'world-markets-history.json');
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        data.source = 'pre-generated';
        return res.json(data);
      }
    }
    if (format === 'csv') {
      const file = path.join(EXPORT_DIR, 'world-markets-history.csv');
      if (fs.existsSync(file)) {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="world-markets-history.csv"');
        return res.sendFile(file);
      }
    }

    // Fallback: live query (daily close readings)
    const readings = db.prepare(`
      SELECT date(timestamp) as date, MAX(timestamp) as timestamp, value as composite_value
      FROM readings GROUP BY date(timestamp) ORDER BY date ASC
    `).all();

    // Get bitcoin prices by date
    const btcRows = db.prepare(`
      SELECT date(timestamp) as date, price
      FROM bitcoin_data
      GROUP BY date(timestamp)
      HAVING timestamp = MAX(timestamp)
      ORDER BY date ASC
    `).all();
    const btcByDate = {};
    for (const row of btcRows) btcByDate[row.date] = row.price;

    if (format === 'csv') {
      let csv = 'date,timestamp,composite_value,bitcoin_price\n';
      for (const r of readings) {
        const btcPrice = btcByDate[r.date] != null ? btcByDate[r.date] : '';
        csv += `${r.date},${r.timestamp},${r.composite_value},${btcPrice}\n`;
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="world-markets-history.csv"');
      return res.send(csv);
    }

    const dataWithBtc = readings.map(r => ({
      ...r,
      bitcoin_price: btcByDate[r.date] != null ? btcByDate[r.date] : null
    }));

    res.json({
      export_date: new Date().toISOString(),
      record_count: dataWithBtc.length,
      data: dataWithBtc,
      source: 'live-query'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pro/daily/:date — Specific day snapshot (JSON/CSV)
app.get('/api/pro/daily/:date', proLimiter, requireAuth, requirePro, (req, res) => {
  try {
    const dateStr = req.params.date; // YYYY-MM-DD
    const format = req.query.format || 'json';

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }

    // Try pre-generated file
    const ext = format === 'csv' ? 'csv' : 'json';
    const file = path.join(DAILY_DIR, `${dateStr}.${ext}`);
    if (fs.existsSync(file)) {
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="world-markets-${dateStr}.csv"`);
        return res.sendFile(file);
      }
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      data.source = 'pre-generated';
      return res.json(data);
    }

    // Fallback: live query for that date
    const reading = db.prepare(`
      SELECT MAX(timestamp) as timestamp, value as composite_value
      FROM readings WHERE date(timestamp) = ?
    `).get(dateStr);

    if (!reading || !reading.composite_value) {
      return res.status(404).json({ error: `No data for ${dateStr}` });
    }

    const countries = db.prepare(`
      SELECT country, ticker, price, weight, contribution
      FROM country_data WHERE timestamp = ? ORDER BY contribution DESC
    `).all(reading.timestamp);

    if (format === 'csv') {
      let csv = 'date,country,ticker,price,weight,contribution\n';
      for (const c of countries) {
        csv += `${dateStr},${c.country},${c.ticker},${c.price},${c.weight},${c.contribution}\n`;
      }
      csv += `${dateStr},COMPOSITE,WMI,${reading.composite_value},1.0,${reading.composite_value}\n`;
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="world-markets-${dateStr}.csv"`);
      return res.send(csv);
    }

    res.json({
      date: dateStr,
      timestamp: reading.timestamp,
      composite_value: reading.composite_value,
      countries,
      source: 'live-query'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pro/dates — List all available daily export dates
app.get('/api/pro/dates', proLimiter, requireAuth, requirePro, (req, res) => {
  try {
    // Try from pre-generated directory
    if (fs.existsSync(DAILY_DIR)) {
      const files = fs.readdirSync(DAILY_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort();
      if (files.length > 0) {
        return res.json({ dates: files, count: files.length, source: 'pre-generated' });
      }
    }

    // Fallback: query DB for unique dates
    const dates = db.prepare('SELECT DISTINCT date(timestamp) as date FROM readings ORDER BY date ASC').all();
    res.json({ dates: dates.map(d => d.date), count: dates.length, source: 'live-query' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch data using Python script
function fetchAndStore() {
  const scriptPath = path.join(__dirname, "fetch_data.py");
  exec(`python3 "${scriptPath}"`, { timeout: 120000 }, (err, stdout, stderr) => {
    if (err) {
      console.error("Fetch error:", err.message);
      return;
    }
    try {
      const data = JSON.parse(stdout);
      if (data.error) {
        console.error("Python error:", data.error);
        return;
      }

      // POST to our own API
      const http = require("http");
      const postData = JSON.stringify({
        timestamp: data.timestamp,
        value: data.composite,
        countries: data.countries,
      });

      const options = {
        hostname: "localhost",
        port: PORT,
        path: "/api/readings",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      };

      const req = http.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          console.log(
            `[${new Date().toISOString()}] Fetch result: ${body}`
          );
        });
      });
      req.on("error", (e) =>
        console.error("POST error:", e.message)
      );
      req.write(postData);
      req.end();
    } catch (parseErr) {
      console.error("Parse error:", parseErr.message);
    }
  });
}

// Fetch Bitcoin data via Yahoo Finance JSON API (native Node.js, no Python)
function fetchAndStoreBitcoin() {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?interval=1d&range=1d';
  const https = require('https');
  const options = { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 };
  https.get(url, options, (resp) => {
    let body = '';
    resp.on('data', (chunk) => body += chunk);
    resp.on('end', () => {
      try {
        const json = JSON.parse(body);
        const meta = json.chart.result[0].meta;
        const price = parseFloat(meta.regularMarketPrice);
        if (!price || price <= 0) {
          console.error('Bitcoin: invalid price from Yahoo');
          return;
        }

        // Glitch protection: reject >30% drop from previous
        const lastBtc = db.prepare("SELECT price FROM bitcoin_data ORDER BY timestamp DESC LIMIT 1").get();
        if (lastBtc) {
          const dropPct = ((lastBtc.price - price) / lastBtc.price) * 100;
          if (dropPct > 30) {
            console.log(`[Bitcoin] Rejected: ${dropPct.toFixed(1)}% drop from previous`);
            return;
          }
          // Duplicate prevention: skip if change < 1.0
          if (Math.abs(price - lastBtc.price) < 1.0) {
            return;
          }
        }

        const timestamp = new Date().toISOString();
        db.prepare("INSERT INTO bitcoin_data (timestamp, price) VALUES (?, ?)").run(timestamp, price);
        console.log(`[${timestamp}] Bitcoin: $${price}`);
      } catch (parseErr) {
        console.error("Bitcoin parse error:", parseErr.message);
      }
    });
  }).on('error', (err) => {
    console.error('Bitcoin fetch error:', err.message);
  });
}

// ---------------------------------------------------------------------------
// Auth proxy: forward /api/auth/* to auth server at localhost:5010
// Avoids cross-origin issues when dashboard fetches API key endpoints
// ---------------------------------------------------------------------------

function proxyToAuth(method) {
  return (req, res) => {
    const authPath = req.path.replace('/api/auth', '/auth');
    const options = {
      hostname: 'localhost',
      port: 5010,
      path: authPath,
      method: method,
      headers: { cookie: req.headers.cookie || '' },
    };
    const proxyReq = require('http').request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        res.status(proxyRes.statusCode);
        if (proxyRes.headers['set-cookie']) {
          res.setHeader('set-cookie', proxyRes.headers['set-cookie']);
        }
        res.setHeader('Content-Type', 'application/json');
        res.send(data);
      });
    });
    proxyReq.on('error', () => {
      res.status(502).json({ error: 'Auth server unreachable' });
    });
    proxyReq.end();
  };
}

app.get('/api/auth/api-key-status', authLimiter, proxyToAuth('GET'));
app.post('/api/auth/api-key', authLimiter, proxyToAuth('POST'));
app.delete('/api/auth/api-key', authLimiter, proxyToAuth('DELETE'));

// Serve the dashboard
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
app.listen(PORT, '127.0.0.1', "0.0.0.0", () => {
  console.log(`World Markets Dashboard running on port ${PORT}`);

  // Initial fetch after 5 seconds
  setTimeout(fetchAndStore, 5000);

  // Refresh every 60 seconds
  setInterval(fetchAndStore, 60000);

  // Bitcoin: initial fetch staggered 30s after main fetch, then every 60 seconds
  setTimeout(fetchAndStoreBitcoin, 35000);
  setInterval(fetchAndStoreBitcoin, 60000);
});
