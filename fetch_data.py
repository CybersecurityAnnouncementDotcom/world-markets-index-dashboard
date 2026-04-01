#!/usr/bin/env python3
"""Fetch current prices for all 20 global market indices using yfinance."""

import json
import sys
import yfinance as yf
from datetime import datetime

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

# Baseline prices from January 2, 2006 (or nearest trading day)
BASELINES = {
    "^GSPC": 1268.80,
    "000001.SS": 1180.96,
    "^N225": 16361.54,
    "^GDAXI": 5449.98,
    "^BSESN": 9390.14,
    "^FTSE": 5681.50,
    "^FCHI": 4754.92,
    "^GSPTSE": 11441.60,
    "^KS11": 1389.27,
    "^AXJO": 4776.00,
    "^BVSP": 33507.00,
    "FTSEMIB.MI": 35962.00,
    "^MXX": 17925.70,
    "^IBEX": 10786.69,
    "^JKSE": 1171.66,
    "^TASI.SR": 17165.66,
    "^AEX": 440.52,
    "XU100.IS": 397.90,
    "^TWII": 6462.03,
    "^SSMI": 7628.60,
}

# Scale factor to target S&P 500-like range (0-5000)
SCALE_FACTOR = 0.194715


def fetch_current_data():
    """Fetch current prices and compute composite index."""
    tickers = [c["ticker"] for c in COUNTRIES]
    
    try:
        data = yf.download(tickers, period="5d", group_by="ticker", progress=False, threads=True)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
    
    results = []
    composite = 0.0
    
    for c in COUNTRIES:
        ticker = c["ticker"]
        try:
            if len(tickers) == 1:
                ticker_data = data
            else:
                ticker_data = data[ticker]
            
            close_prices = ticker_data["Close"].dropna()
            if len(close_prices) == 0:
                continue
            
            current_price = float(close_prices.iloc[-1])
            prev_price = float(close_prices.iloc[-2]) if len(close_prices) > 1 else current_price
            
            baseline = BASELINES.get(ticker, current_price)
            normalized = (current_price / baseline) * c["weight"] * 5000 * SCALE_FACTOR
            change_pct = ((current_price - prev_price) / prev_price) * 100
            
            composite += normalized
            
            results.append({
                "country": c["country"],
                "ticker": ticker,
                "index": c["index"],
                "flag": c["flag"],
                "price": round(current_price, 2),
                "prev_price": round(prev_price, 2),
                "weight": c["weight"],
                "contribution": round(normalized, 2),
                "change_pct": round(change_pct, 2),
            })
        except Exception as e:
            # Skip this ticker but continue
            pass
    
    output = {
        "timestamp": datetime.utcnow().isoformat(),
        "composite": round(composite, 2),
        "countries": results,
    }
    
    print(json.dumps(output))


if __name__ == "__main__":
    fetch_current_data()
