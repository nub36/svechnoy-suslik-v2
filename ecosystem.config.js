/**
 * PM2 process definitions for svechnoy-suslik-v2.
 *
 * VPS target: /root/svechnoy-suslik-v2, web on port 3000.
 *
 * Deploy:
 *   cd /root/svechnoy-suslik-v2
 *   npm ci
 *   npm run build            # tsc -> dist/ + next build
 *   npm run db:migrate && npm run db:seed
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *
 * SINGLE WRITER: exactly one instance of each worker (fork mode, instances: 1).
 * Running two copies of a worker would break the single-writer guarantee.
 */

module.exports = {
  apps: [
    {
      name: 'svechnoy-suslik-v2-web',
      cwd: __dirname,
      script: 'node_modules/next/dist/bin/next',
      args: 'start -H 0.0.0.0 -p 3000',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      max_memory_restart: '700M',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        TRADING_MODE: 'FORWARD_TEST',
      },
      error_file: 'logs/web.err.log',
      out_file: 'logs/web.out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'svechnoy-suslik-v2-market',
      cwd: __dirname,
      script: 'dist/workers/market.worker.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        MARKET_LOOP_MS: '15000',
        TRADING_MODE: 'FORWARD_TEST',
      },
      error_file: 'logs/market.err.log',
      out_file: 'logs/market.out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'svechnoy-suslik-v2-strategy',
      cwd: __dirname,
      script: 'dist/workers/strategy.worker.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        STRATEGY_LOOP_MS: '20000',
        TRADING_MODE: 'FORWARD_TEST',
      },
      error_file: 'logs/strategy.err.log',
      out_file: 'logs/strategy.out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'svechnoy-suslik-v2-outcome',
      cwd: __dirname,
      script: 'dist/workers/outcome.worker.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        OUTCOME_LOOP_MS: '20000',
        TRADING_MODE: 'FORWARD_TEST',
      },
      error_file: 'logs/outcome.err.log',
      out_file: 'logs/outcome.out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
