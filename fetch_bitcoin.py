#!/usr/bin/env python3
"""Fetch current Bitcoin (BTC-USD) price using yfinance."""

import json
import sys
import yfinance as yf


def fetch_bitcoin():
    """Fetch current BTC-USD price."""
    try:
        btc = yf.Ticker("BTC-USD")

        # Try fast_info first (quickest)
        try:
            price = btc.fast_info.last_price
            if price and price > 0:
                print(json.dumps({"bitcoin_price": round(price, 2)}))
                return
        except Exception:
            pass

        # Fallback: recent history
        hist = btc.history(period="1d")
        if len(hist) > 0:
            price = float(hist["Close"].iloc[-1])
            print(json.dumps({"bitcoin_price": round(price, 2)}))
            return

        print(json.dumps({"error": "No BTC-USD data available"}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    fetch_bitcoin()
