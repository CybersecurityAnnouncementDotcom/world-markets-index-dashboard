#!/usr/bin/env python3
"""Backfill historical Bitcoin (BTC-USD) data from July 2010 to present."""

import sqlite3
import os
import sys
import yfinance as yf
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "world_markets.db")


def init_db(conn):
    """Create bitcoin_data table if it doesn't exist."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS bitcoin_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            price REAL NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_bitcoin_timestamp ON bitcoin_data(timestamp)")
    conn.commit()


def backfill():
    """Download full BTC-USD history and insert into bitcoin_data table."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    existing = conn.execute("SELECT COUNT(*) FROM bitcoin_data").fetchone()[0]
    print(f"Existing bitcoin_data rows: {existing}")

    print("Downloading BTC-USD history from 2010-07-13...")
    sys.stdout.flush()

    try:
        btc = yf.Ticker("BTC-USD")
        hist = btc.history(start="2010-07-13", interval="1d")
    except Exception as e:
        print(f"Error downloading BTC-USD data: {e}")
        sys.exit(1)

    if hist.empty:
        print("No data returned from yfinance.")
        sys.exit(1)

    print(f"Downloaded {len(hist)} rows. Inserting into database...")
    sys.stdout.flush()

    batch = []
    for date, row in hist.iterrows():
        date_str = date.strftime("%Y-%m-%d")
        price = round(float(row["Close"]), 2)
        if price > 0:
            batch.append((date_str, price))

    conn.executemany(
        "INSERT OR IGNORE INTO bitcoin_data (timestamp, price) VALUES (?, ?)",
        batch
    )
    conn.commit()

    total = conn.execute("SELECT COUNT(*) FROM bitcoin_data").fetchone()[0]
    print(f"\nBackfill complete!")
    print(f"  Total bitcoin_data rows: {total}")
    if batch:
        print(f"  Date range: {batch[0][0]} to {batch[-1][0]}")
        print(f"  First price: ${batch[0][1]:,.2f}")
        print(f"  Latest price: ${batch[-1][1]:,.2f}")

    conn.close()


if __name__ == "__main__":
    backfill()
