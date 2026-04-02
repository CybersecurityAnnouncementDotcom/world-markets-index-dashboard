const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const { execSync, exec } = require("child_process");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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
`);

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

// API: Get current composite value + all country data
app.get("/api/composite", (req, res) => {
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
app.get("/api/history", (req, res) => {
  try {
    const range = req.query.range || "1Y";
    let query;
    const now = new Date();

    switch (range) {
      case "1H":
        // Last 60 readings (minute-by-minute)
        query = db
          .prepare("SELECT * FROM readings ORDER BY timestamp DESC LIMIT 60")
          .all()
          .reverse();
        break;
      case "1D":
        // Today's readings
        const today = now.toISOString().split("T")[0];
        query = db
          .prepare("SELECT * FROM readings WHERE timestamp >= ? ORDER BY timestamp ASC")
          .all(today);
        // If no intraday data, get last 2 days
        if (query.length < 2) {
          query = db
            .prepare(
              "SELECT * FROM readings ORDER BY timestamp DESC LIMIT 10"
            )
            .all()
            .reverse();
        }
        break;
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
            `SELECT MIN(timestamp) as timestamp, ROUND(AVG(value), 2) as value
             FROM readings WHERE timestamp >= ?
             GROUP BY strftime('%Y-%W', timestamp)
             ORDER BY timestamp ASC`
          )
          .all(yearAgo);
        break;
      }
      case "MAX":
        query = db
          .prepare(
            `SELECT MIN(timestamp) as timestamp, ROUND(AVG(value), 2) as value
             FROM readings
             GROUP BY strftime('%Y-%W', timestamp)
             ORDER BY timestamp ASC`
          )
          .all();
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
// Issue 4 fix: use raw (ungrouped) data for 1H/1D/1W; weekly averages only for 1Y/MAX
app.get("/api/country-history", (req, res) => {
  try {
    const range = req.query.range || "MAX";
    const now = new Date();
    let rows;

    if (range === '1H') {
      // Last 60 raw readings aligned with composite
      rows = db.prepare(`
        SELECT r.timestamp,
          MAX(CASE WHEN cd.country='USA' THEN cd.price END) as usa_price,
          MAX(CASE WHEN cd.country='China' THEN cd.price END) as china_price
        FROM (SELECT * FROM readings ORDER BY timestamp DESC LIMIT 60) r
        LEFT JOIN country_data cd ON cd.timestamp = r.timestamp AND cd.country IN ('USA','China')
        GROUP BY r.timestamp
        ORDER BY r.timestamp ASC
      `).all();

    } else if (range === '1D') {
      // Today's raw readings (or last 10 if no intraday data)
      const today = now.toISOString().split('T')[0];
      rows = db.prepare(`
        SELECT r.timestamp,
          MAX(CASE WHEN cd.country='USA' THEN cd.price END) as usa_price,
          MAX(CASE WHEN cd.country='China' THEN cd.price END) as china_price
        FROM readings r
        LEFT JOIN country_data cd ON cd.timestamp = r.timestamp AND cd.country IN ('USA','China')
        WHERE r.timestamp >= ?
        GROUP BY r.timestamp
        ORDER BY r.timestamp ASC
      `).all(today);
      if (rows.length < 2) {
        rows = db.prepare(`
          SELECT r.timestamp,
            MAX(CASE WHEN cd.country='USA' THEN cd.price END) as usa_price,
            MAX(CASE WHEN cd.country='China' THEN cd.price END) as china_price
          FROM (SELECT * FROM readings ORDER BY timestamp DESC LIMIT 10) r
          LEFT JOIN country_data cd ON cd.timestamp = r.timestamp AND cd.country IN ('USA','China')
          GROUP BY r.timestamp
          ORDER BY r.timestamp ASC
        `).all();
      }

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
        SELECT MIN(r.timestamp) as timestamp,
          ROUND(AVG(CASE WHEN cd.country='USA' THEN cd.price END), 2) as usa_price,
          ROUND(AVG(CASE WHEN cd.country='China' THEN cd.price END), 2) as china_price
        FROM readings r
        LEFT JOIN country_data cd ON cd.timestamp = r.timestamp AND cd.country IN ('USA','China')
        WHERE r.timestamp >= ?
        GROUP BY strftime('%Y-%W', r.timestamp)
        ORDER BY timestamp ASC
      `).all(yearAgo);

    } else {
      // MAX: weekly averages across all data
      rows = db.prepare(`
        SELECT MIN(r.timestamp) as timestamp,
          ROUND(AVG(CASE WHEN cd.country='USA' THEN cd.price END), 2) as usa_price,
          ROUND(AVG(CASE WHEN cd.country='China' THEN cd.price END), 2) as china_price
        FROM readings r
        LEFT JOIN country_data cd ON cd.timestamp = r.timestamp AND cd.country IN ('USA','China')
        GROUP BY strftime('%Y-%W', r.timestamp)
        ORDER BY timestamp ASC
      `).all();
    }

    res.json({ range, data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: All countries with current data
app.get("/api/countries", (req, res) => {
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

// API: Store new reading
app.post("/api/readings", (req, res) => {
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

      // Duplicate prevention: only store if >0.5 point change
      if (Math.abs(value - lastReading.value) < 0.5) {
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

// Serve the dashboard
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`World Markets Dashboard running on port ${PORT}`);

  // Initial fetch after 5 seconds
  setTimeout(fetchAndStore, 5000);

  // Refresh every 60 seconds
  setInterval(fetchAndStore, 60000);
});
