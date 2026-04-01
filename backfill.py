#!/usr/bin/env python3
"""Backfill historical composite index data from January 2006 to present."""

import sqlite3
import os
import sys
import yfinance as yf
import pandas as pd
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "world_markets.db")

COUNTRIES = [
    {"country": "USA", "ticker": "^GSPC", "weight": 0.245, "index": "S&P 500", "flag": "🇺🇸"},
    {"country": "China", "ticker": "000001.SS", "weight": 0.143, "index": "SSE Composite", "flag": "🇨🇳"},
    {"country": "Japan", "ticker": "^N225", "weight": 0.082, "index": "Nikkei 225", "flag": "🇯🇵"},
    {"country": "Germany", "ticker": "^GDAXI", "weight": 0.061, "index": "DAX", "flag": "🇩🇪"},
    {"country": "India", "ticker": "^BSESN", "weight": 0.061, "index": "BSE Sensex", "flag": "🇮🇳"},
    {"country": "UK", "ticker": "^FTSE", "weight": 0.051, "index": "FTSE 100", "flag": "🇬🇧"},
    {"country": "France", "ticker": "^FCHI", "weight": 0.041, "index": "CAC 40", "flag": "🇫🇷"},
    {"country": "Canada", "ticker": "^GSPTSE", "weight": 0.031, "index": "S&P/TSX", "flag": "🇨🇦"},
    {"country": "South Korea", "ticker": "^KS11", "weight": 0.031, "index": "KOSPI", "flag": "🇰🇷"},
    {"country": "Australia", "ticker": "^AXJO", "weight": 0.031, "index": "ASX 200", "flag": "🇦🇺"},
    {"country": "Brazil", "ticker": "^BVSP", "weight": 0.031, "index": "Bovespa", "flag": "🇧🇷"},
    {"country": "Italy", "ticker": "FTSEMIB.MI", "weight": 0.031, "index": "FTSE MIB", "flag": "🇮🇹"},
    {"country": "Mexico", "ticker": "^MXX", "weight": 0.020, "index": "IPC", "flag": "🇲🇽"},
    {"country": "Spain", "ticker": "^IBEX", "weight": 0.020, "index": "IBEX 35", "flag": "🇪🇸"},
    {"country": "Indonesia", "ticker": "^JKSE", "weight": 0.020, "index": "IDX Composite", "flag": "🇮🇩"},
    {"country": "Saudi Arabia", "ticker": "^TASI.SR", "weight": 0.020, "index": "Tadawul", "flag": "🇸🇦"},
    {"country": "Netherlands", "ticker": "^AEX", "weight": 0.020, "index": "AEX", "flag": "🇳🇱"},
    {"country": "Turkey", "ticker": "XU100.IS", "weight": 0.020, "index": "BIST 100", "flag": "🇹🇷"},
    {"country": "Taiwan", "ticker": "^TWII", "weight": 0.020, "index": "TAIEX", "flag": "🇹🇼"},
    {"country": "Switzerland", "ticker": "^SSMI", "weight": 0.020, "index": "SMI", "flag": "🇨🇭"},
]


def init_db(conn):
    """Create tables if they don't exist."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            value REAL NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS country_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            country TEXT NOT NULL,
            ticker TEXT NOT NULL,
            price REAL NOT NULL,
            weight REAL NOT NULL,
            contribution REAL NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_readings_timestamp ON readings(timestamp)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_country_data_timestamp ON country_data(timestamp)")
    conn.commit()


def backfill():
    """Download historical data and compute composite for each trading day."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    init_db(conn)
    
    # Check if we already have data
    existing = conn.execute("SELECT COUNT(*) FROM readings").fetchone()[0]
    if existing > 0:
        print(f"Database already has {existing} readings. Clearing for fresh backfill...")
        conn.execute("DELETE FROM readings")
        conn.execute("DELETE FROM country_data")
        conn.commit()
    
    tickers = [c["ticker"] for c in COUNTRIES]
    
    print("Downloading historical data from 2006-01-01... This may take a minute.")
    sys.stdout.flush()
    
    try:
        data = yf.download(
            tickers,
            start="2006-01-01",
            group_by="ticker",
            progress=True,
            threads=True,
            auto_adjust=True,
        )
    except Exception as e:
        print(f"Error downloading data: {e}")
        sys.exit(1)
    
    print("Data downloaded. Processing...")
    sys.stdout.flush()
    
    # Extract close prices for each ticker
    close_data = {}
    for c in COUNTRIES:
        ticker = c["ticker"]
        try:
            ticker_close = data[ticker]["Close"].dropna()
            close_data[ticker] = ticker_close
        except Exception as e:
            print(f"Warning: Could not get data for {ticker} ({c['country']}): {e}")
    
    # Get baseline prices (first available price for each ticker)
    baselines = {}
    for ticker, series in close_data.items():
        if len(series) > 0:
            baselines[ticker] = float(series.iloc[0])
            print(f"  {ticker}: baseline = {baselines[ticker]:.2f} on {series.index[0].strftime('%Y-%m-%d')}")
    
    # Get all unique dates across all tickers
    all_dates = set()
    for series in close_data.values():
        all_dates.update(series.index)
    all_dates = sorted(all_dates)
    
    print(f"\nProcessing {len(all_dates)} trading days...")
    sys.stdout.flush()
    
    # For each date, compute composite value
    batch_readings = []
    batch_country = []
    last_prices = {}
    
    for i, date in enumerate(all_dates):
        date_str = date.strftime("%Y-%m-%d")
        
        # Skip weekends
        if date.weekday() >= 5:
            continue
        
        composite = 0.0
        has_data = False
        
        for c in COUNTRIES:
            ticker = c["ticker"]
            if ticker not in close_data or ticker not in baselines:
                continue
            
            series = close_data[ticker]
            
            # Get price for this date, or use last known price
            if date in series.index:
                price = float(series.loc[date])
                # Handle potential MultiIndex or Series
                if hasattr(price, '__iter__'):
                    price = float(list(price)[0]) if len(list(price)) > 0 else None
                if price is not None and price > 0:
                    last_prices[ticker] = price
            
            price = last_prices.get(ticker)
            if price is None or price <= 0:
                continue
            
            baseline = baselines[ticker]
            contribution = (price / baseline) * c["weight"] * 5000
            composite += contribution
            has_data = True
            
            batch_country.append((date_str, c["country"], ticker, round(price, 2), c["weight"], round(contribution, 2)))
        
        if has_data and composite > 0:
            batch_readings.append((date_str, round(composite, 2)))
        
        if (i + 1) % 500 == 0:
            print(f"  Processed {i + 1}/{len(all_dates)} days...")
            sys.stdout.flush()
    
    # Bulk insert
    print(f"\nInserting {len(batch_readings)} readings into database...")
    sys.stdout.flush()
    
    conn.executemany("INSERT INTO readings (timestamp, value) VALUES (?, ?)", batch_readings)
    conn.executemany(
        "INSERT INTO country_data (timestamp, country, ticker, price, weight, contribution) VALUES (?, ?, ?, ?, ?, ?)",
        batch_country
    )
    conn.commit()
    
    # Print summary
    if batch_readings:
        print(f"\nBackfill complete!")
        print(f"  Total readings: {len(batch_readings)}")
        print(f"  Date range: {batch_readings[0][0]} to {batch_readings[-1][0]}")
        print(f"  First composite value: {batch_readings[0][1]}")
        print(f"  Latest composite value: {batch_readings[-1][1]}")
    else:
        print("No data was inserted!")
    
    conn.close()


if __name__ == "__main__":
    backfill()
