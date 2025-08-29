module.exports = {
  apps: [
    {
      name: 'parser-api',
      script: './src/server.js',
      cwd: '/opt/parser',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 8000,
        API_KEY: 'sk_parser_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2',
        HMAC_SECRET: 'hmac_secret_9876543210abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz',
        REDIS_HOST: '127.0.0.1',
        REDIS_PORT: '6379',
        REDIS_DB: '0',
	QUEUE_NAME: 'parse_jobs',
	QUEUE_PREFIX: 'bull'
      },
      error_file: '/var/log/parser/api-error.log',
      out_file: '/var/log/parser/api-out.log',
      log_file: '/var/log/parser/api-combined.log',
      time: true
    },
    {
      name: 'parser-worker',
      script: './src/worker.js',
      cwd: '/opt/parser',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
      env: {
        NODE_ENV: 'production',
        PORT: 8000,
        API_KEY: 'sk_parser_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2',
        HMAC_SECRET: 'hmac_secret_9876543210abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz',
        REDIS_HOST: '127.0.0.1',
        REDIS_PORT: '6379',
        REDIS_DB: '0',
	QUEUE_NAME: 'parse_jobs',
	QUEUE_PREFIX: 'bull'
      },
      error_file: '/var/log/parser/worker-error.log',
      out_file: '/var/log/parser/worker-out.log',
      log_file: '/var/log/parser/worker-combined.log',
      time: true
    }
  ]
};
