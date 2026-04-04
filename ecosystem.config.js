/**
 * PM2 Ecosystem Configuration for World Markets Index Dashboard
 * 
 * Usage on VPS:
 *   pm2 start ecosystem.config.js              # Start dashboard + daily export cron
 *   pm2 start ecosystem.config.js --only world-dashboard  # Dashboard only
 *   pm2 start ecosystem.config.js --only world-export-cron  # Export cron only
 *   pm2 delete world-export-cron               # Remove cron if not needed
 *
 * The export cron runs generate_exports.py daily at 23:55 UTC (4:55 PM PDT)
 * to capture the day's closing data. Files are saved to data/exports/ (VPS only,
 * not in GitHub).
 */

module.exports = {
  apps: [
    {
      name: 'world-dashboard',
      script: 'server.js',
      cwd: '/home/support/world-markets-index-dashboard',
      env: {
        PORT: 5001,
        NODE_ENV: 'production'
      },
      // PM2 auto-restart settings
      watch: false,
      max_memory_restart: '200M',
      // Logging
      error_file: '/home/support/world-markets-index-dashboard/logs/error.log',
      out_file: '/home/support/world-markets-index-dashboard/logs/out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    },
    {
      name: 'world-export-cron',
      script: 'generate_exports.py',
      cwd: '/home/support/world-markets-index-dashboard',
      interpreter: 'python3',
      // Run daily at 23:55 UTC (4:55 PM PDT / market close capture)
      cron_restart: '55 23 * * *',
      // Don't keep running — execute once then stop until next cron trigger
      autorestart: false,
      watch: false,
      // Logging
      error_file: '/home/support/world-markets-index-dashboard/logs/export-error.log',
      out_file: '/home/support/world-markets-index-dashboard/logs/export-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }
  ]
};
