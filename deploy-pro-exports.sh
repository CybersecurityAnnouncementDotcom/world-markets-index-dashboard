#!/bin/bash
# ============================================================================
# World Markets Index — Pro Export System Deployment
# Run on VPS as user 'support' via Google Cloud browser SSH
# ============================================================================
# What this deploys:
#   1. Updated server.js with file-serving Pro API endpoints
#   2. generate_exports.py — daily export generator (CSV/JSON)
#   3. ecosystem.config.js — PM2 cron config for daily export generation
#   4. Creates data/exports/ directory structure
#
# After running, Pro subscribers get:
#   - /api/export/csv, /api/export/json (existing, now serve pre-generated files)
#   - /api/pro/latest    — latest composite + country breakdown
#   - /api/pro/history   — full daily history (JSON or CSV)
#   - /api/pro/daily/:date — specific day snapshot
#   - /api/pro/dates     — list available export dates
# ============================================================================

set -e

echo "=== World Markets Index Pro Export Deployment ==="
echo "Date: $(date)"
echo ""

# Step 1: Pull latest code
echo "--- Step 1: Pull latest code ---"
cd /home/support/world-markets-index-dashboard
git pull origin main
echo ""

# Step 2: Create export directories
echo "--- Step 2: Create export directories ---"
mkdir -p data/exports/daily
mkdir -p logs
echo "  Created: data/exports/"
echo "  Created: data/exports/daily/"
echo "  Created: logs/"
echo ""

# Step 3: Restart dashboard with updated server.js
echo "--- Step 3: Restart dashboard ---"
pm2 restart world-dashboard || pm2 restart 4
echo ""

# Step 4: Run initial export generation
echo "--- Step 4: Generate initial exports ---"
python3 generate_exports.py
echo ""

# Step 5: Start the export cron (daily at 23:55 UTC)
echo "--- Step 5: Set up PM2 export cron ---"
# Delete if already exists (idempotent)
pm2 delete world-export-cron 2>/dev/null || true
pm2 start ecosystem.config.js --only world-export-cron
pm2 save
echo ""

# Step 6: Verify
echo "--- Step 6: Verification ---"
echo "PM2 processes:"
pm2 list
echo ""

echo "Export files:"
ls -la data/exports/ 2>/dev/null || echo "  (none yet)"
echo ""
ls -la data/exports/daily/ 2>/dev/null || echo "  (no daily files yet)"
echo ""

echo "API health check (localhost):"
curl -s http://localhost:5001/api/composite -H "X-Auth-Plan-Tier: pro" | head -c 200
echo ""
echo ""

echo "Pro API check:"
curl -s http://localhost:5001/api/pro/latest -H "X-Auth-Plan-Tier: pro" | head -c 300
echo ""
echo ""

echo "Export endpoint check:"
curl -s http://localhost:5001/api/export/json?range=MAX -H "X-Auth-Plan-Tier: pro" | head -c 200
echo ""
echo ""

echo "=== Deployment complete ==="
echo "Daily exports will run at 23:55 UTC (4:55 PM PDT)"
echo "Files saved to: /home/support/world-markets-index-dashboard/data/exports/"
