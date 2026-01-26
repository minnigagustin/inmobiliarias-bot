// ecosystem.config.js - PM2 Configuration
// Run with: pm2 start ecosystem.config.js

module.exports = {
  apps: [
    // Web Server (Express + Socket.IO)
    {
      name: 'br-web',
      script: 'server.js',
      instances: 1, // Single instance for Socket.IO state
      exec_mode: 'fork', // Fork mode (not cluster) for WebSocket compatibility
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/pm2-web-error.log',
      out_file: './logs/pm2-web-out.log',
      merge_logs: true,
      // Auto restart on failure
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000, // 5 seconds between restarts
      // Graceful shutdown
      kill_timeout: 10000,
      wait_ready: true,
      listen_timeout: 30000,
    },

    // WhatsApp Client
    {
      name: 'br-whatsapp',
      script: 'index.js',
      instances: 1, // Only 1 instance per WhatsApp session
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '800M', // WhatsApp client uses more memory
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/pm2-whatsapp-error.log',
      out_file: './logs/pm2-whatsapp-out.log',
      merge_logs: true,
      // Auto restart on failure with exponential backoff
      autorestart: true,
      max_restarts: 5,
      restart_delay: 10000, // 10 seconds between restarts
      exp_backoff_restart_delay: 1000, // Exponential backoff starting at 1s
      // Graceful shutdown
      kill_timeout: 30000, // WhatsApp needs more time to clean up
    },
  ],

  // Deployment configuration (optional)
  deploy: {
    production: {
      user: 'deploy',
      host: ['your-server-ip'],
      ref: 'origin/main',
      repo: 'git@github.com:your-user/br-whatsapp-bot.git',
      path: '/var/www/br-whatsapp-bot',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production',
      'pre-setup': '',
    },
  },
};
