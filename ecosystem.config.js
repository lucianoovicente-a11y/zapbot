module.exports = {
  apps: [{
    name: 'zappbot',
    script: 'server.js',
    cwd: '/var/www/zappbot',
    
    // Configurações de instância
    instances: 1,
    exec_mode: 'fork',
    
    // Variáveis de ambiente
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    
    // Configurações de reinício
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    
    // Logs
    out_file: '/var/www/zappbot/logs/out.log',
    error_file: '/var/www/zappbot/logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    
    // Configurações de memória
    max_memory_restart: '1G',
    
    // Graceful shutdown
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 3000,
    
    // Configurações de restart
    watch: false,
    ignore_watch: ['node_modules', 'auth_sessions', 'logs', 'backups']
  }]
}