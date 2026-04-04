#!/usr/bin/env python3
"""
Daily Export Generator for World Markets Index Pro subscribers.
Reads from SQLite DB and writes CSV/JSON files to data/exports/.

Run via PM2 cron or manually:
  python3 generate_exports.py

Generates:
  data/exports/daily/YYYY-MM-DD.csv
  data/exports/daily/YYYY-MM-DD.json
  data/exports/world-markets-latest.csv
  data/exports/world-markets-latest.json
  data/exports/world-markets-history.csv
  data/exports/world-markets-history.json
"""

import sqlite3
import json
import csv
import os
from datetime import datetime, timedelta
from pathlib import Path

# Paths
SCRIPT_DIR = Path(__file__).parent
DB_PATH = SCRIPT_DIR / "data" / "world_markets.db"
EXPORT_DIR = SCRIPT_DIR / "data" / "exports"
DAILY_DIR = EXPORT_DIR / "daily"

# Ensure export directories exist
DAILY_DIR.mkdir(parents=True, exist_ok=True)


def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def get_daily_close_readings(conn):
    """Get one reading per calendar day (the last reading of each day)."""
    rows = conn.execute("""
        SELECT date(timestamp) as date,
               MAX(timestamp) as timestamp,
               value as composite_value
        FROM readings
        GROUP BY date(timestamp)
        ORDER BY date ASC
    """).fetchall()
    return [dict(r) for r in rows]


def get_latest_country_data(conn):
    """Get the most recent country breakdown."""
    latest = conn.execute(
        "SELECT timestamp FROM readings ORDER BY timestamp DESC LIMIT 1"
    ).fetchone()
    if not latest:
        return []
    rows = conn.execute(
        "SELECT country, ticker, price, weight, contribution "
        "FROM country_data WHERE timestamp = ? ORDER BY contribution DESC",
        (latest["timestamp"],)
    ).fetchall()
    return [dict(r) for r in rows]


def get_country_history(conn):
    """Get daily country-level data (last reading per day per country)."""
    rows = conn.execute("""
        SELECT date(cd.timestamp) as date,
               cd.country, cd.ticker, cd.price, cd.weight, cd.contribution
        FROM country_data cd
        INNER JOIN (
            SELECT date(timestamp) as d, MAX(timestamp) as max_ts
            FROM readings GROUP BY date(timestamp)
        ) latest ON cd.timestamp = latest.max_ts
        ORDER BY date ASC, cd.contribution DESC
    """).fetchall()
    return [dict(r) for r in rows]


def write_csv(filepath, rows, fieldnames):
    with open(filepath, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f"  Written: {filepath} ({len(rows)} rows)")


def write_json(filepath, data):
    with open(filepath, "w") as f:
        json.dump(data, f, indent=2)
    print(f"  Written: {filepath}")


def generate_daily_snapshot(conn, date_str=None):
    """Generate CSV/JSON for a specific date (defaults to today)."""
    if date_str is None:
        date_str = datetime.utcnow().strftime("%Y-%m-%d")

    # Get the last reading for this date
    reading = conn.execute("""
        SELECT MAX(timestamp) as timestamp, value as composite_value
        FROM readings WHERE date(timestamp) = ?
    """, (date_str,)).fetchone()

    if not reading or reading["composite_value"] is None:
        print(f"  No data for {date_str}, skipping daily snapshot")
        return

    # Get country data for that timestamp
    countries = conn.execute("""
        SELECT country, ticker, price, weight, contribution
        FROM country_data WHERE timestamp = ?
        ORDER BY contribution DESC
    """, (reading["timestamp"],)).fetchall()

    countries = [dict(c) for c in countries]

    # Daily CSV: one row per country + composite
    csv_rows = []
    for c in countries:
        csv_rows.append({
            "date": date_str,
            "country": c["country"],
            "ticker": c["ticker"],
            "price": c["price"],
            "weight": c["weight"],
            "contribution": c["contribution"],
        })
    csv_rows.append({
        "date": date_str,
        "country": "COMPOSITE",
        "ticker": "WMI",
        "price": round(reading["composite_value"], 2),
        "weight": 1.0,
        "contribution": round(reading["composite_value"], 2),
    })

    csv_path = DAILY_DIR / f"{date_str}.csv"
    write_csv(csv_path, csv_rows, ["date", "country", "ticker", "price", "weight", "contribution"])

    # Daily JSON
    json_data = {
        "date": date_str,
        "timestamp": reading["timestamp"],
        "composite_value": round(reading["composite_value"], 2),
        "countries": countries,
    }
    json_path = DAILY_DIR / f"{date_str}.json"
    write_json(json_path, json_data)

    return json_data


def generate_latest(conn):
    """Generate latest.csv and latest.json (symlink-like, always current)."""
    readings = get_daily_close_readings(conn)
    if not readings:
        print("  No readings found")
        return

    latest = readings[-1]
    countries = get_latest_country_data(conn)

    # Latest CSV
    csv_rows = []
    for c in countries:
        csv_rows.append({
            "date": latest["date"],
            "country": c["country"],
            "ticker": c["ticker"],
            "price": c["price"],
            "weight": c["weight"],
            "contribution": c["contribution"],
        })
    csv_rows.append({
        "date": latest["date"],
        "country": "COMPOSITE",
        "ticker": "WMI",
        "price": latest["composite_value"],
        "weight": 1.0,
        "contribution": latest["composite_value"],
    })

    write_csv(
        EXPORT_DIR / "world-markets-latest.csv",
        csv_rows,
        ["date", "country", "ticker", "price", "weight", "contribution"]
    )

    # Latest JSON
    write_json(EXPORT_DIR / "world-markets-latest.json", {
        "export_date": datetime.utcnow().isoformat(),
        "date": latest["date"],
        "timestamp": latest["timestamp"],
        "composite_value": latest["composite_value"],
        "countries": countries,
    })


def generate_history(conn):
    """Generate full history CSV/JSON (composite daily closes)."""
    readings = get_daily_close_readings(conn)

    # History CSV — one row per day, composite only
    write_csv(
        EXPORT_DIR / "world-markets-history.csv",
        readings,
        ["date", "timestamp", "composite_value"]
    )

    # History JSON
    write_json(EXPORT_DIR / "world-markets-history.json", {
        "export_date": datetime.utcnow().isoformat(),
        "record_count": len(readings),
        "data": readings,
    })

    # Also generate a detailed history with all countries per day
    country_history = get_country_history(conn)

    # Group by date
    by_date = {}
    for row in country_history:
        d = row["date"]
        if d not in by_date:
            by_date[d] = []
        by_date[d].append(row)

    # Detailed CSV — one row per country per day
    write_csv(
        EXPORT_DIR / "world-markets-history-detailed.csv",
        country_history,
        ["date", "country", "ticker", "price", "weight", "contribution"]
    )


def main():
    print(f"[{datetime.utcnow().isoformat()}] Generating World Markets Index exports...")
    print(f"  DB: {DB_PATH}")
    print(f"  Export dir: {EXPORT_DIR}")
    print()

    conn = get_db()

    try:
        # 1. Today's daily snapshot
        today = datetime.utcnow().strftime("%Y-%m-%d")
        print(f"1. Daily snapshot for {today}:")
        generate_daily_snapshot(conn, today)
        print()

        # 2. Latest files
        print("2. Latest files:")
        generate_latest(conn)
        print()

        # 3. Full history
        print("3. Full history:")
        generate_history(conn)
        print()

        print("Export generation complete.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
