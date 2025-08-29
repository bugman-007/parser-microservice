set -Eeuo pipefail

#!/bin/bash
# production-deploy.sh - Complete Production Deployment Script

set -e

echo "🚀 SilkCards Parser Microservice - Production Deployment"
echo "========================================================"

# Configuration
SERVICE_USER="parser"
SERVICE_HOME="/opt/parser"
LOG_DIR="/var/log/parser"
SERVICE_NAME="silkcards-parser"

# Create service user if doesn't exist
if ! id "$SERVICE_USER" &>/dev/null; then
    echo "📝 Creating service user: $SERVICE_USER"
    sudo useradd -r -s /bin/bash -d $SERVICE_HOME -m $SERVICE_USER
fi

# Create directory structure
echo "📁 Setting up directory structure..."
sudo mkdir -p $SERVICE_HOME
sudo mkdir -p $SERVICE_HOME/src
sudo mkdir -p $SERVICE_HOME/uploads
sudo mkdir -p $SERVICE_HOME/logs
sudo mkdir -p $LOG_DIR
sudo mkdir -p /etc/$SERVICE_NAME

# Copy application files
echo "📦 Installing application files..."
sudo cp -r src/* $SERVICE_HOME/src/
sudo cp package.json $SERVICE_HOME/
sudo cp .env.production $SERVICE_HOME/.env

# Set permissions
sudo chown -R $SERVICE_USER:$SERVICE_USER $SERVICE_HOME
sudo chown -R $SERVICE_USER:$SERVICE_USER $LOG_DIR
sudo chmod +x $SERVICE_HOME/src/scripts/*.sh

# Install Node.js dependencies
echo "📦 Installing Node.js dependencies..."
cd $SERVICE_HOME
sudo -u $SERVICE_USER npm install --production

# Install system dependencies
echo "📦 Installing system dependencies..."
sudo apt-get update
sudo apt-get install -y \
    redis-server \
    nginx \
    poppler-utils \
    ghostscript \
    imagemagick \
    inkscape \
    logrotate

# Configure Redis for production
echo "⚙️ Configuring Redis..."

# --- Redis include dir guard (Ubuntu 22.04 + Redis 6/7 safe) ---
REDIS_CONF="/etc/redis/redis.conf"
REDIS_INCLUDE_DIR="/etc/redis/redis.conf.d"

# ensure the drop-in directory exists
sudo mkdir -p "$REDIS_INCLUDE_DIR"

# ensure the main redis.conf includes the drop-in directory (append once)
if ! sudo grep -qE "^include[[:space:]]+$REDIS_INCLUDE_DIR/\*\.conf" "$REDIS_CONF"; then
  echo "include $REDIS_INCLUDE_DIR/*.conf" | sudo tee -a "$REDIS_CONF" >/dev/null
fi
# ---------------------------------------------------------------

# now write your drop-in config safely
sudo tee "$REDIS_INCLUDE_DIR/parser.conf" > /dev/null << 'EOF'
# Parser microservice Redis configuration
maxmemory 512mb
maxmemory-policy allkeys-lru
save 60 1000
appendonly yes
appendfsync everysec
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
EOF

# Configure ImageMagick policy
echo "⚙️ Configuring ImageMagick..."
sudo sed -i 's/<policy domain="coder" rights="none" pattern="PDF" \/>/<policy domain="coder" rights="read|write" pattern="PDF" \/>/g' /etc/ImageMagick-6/policy.xml

# Create systemd services
echo "⚙️ Creating systemd services..."

# API Service
sudo tee /etc/systemd/system/silkcards-parser-api.service > /dev/null << EOF
[Unit]
Description=SilkCards Parser API Server
Documentation=https://github.com/silkcards/parser-microservice
After=network.target redis-server.service
Requires=redis-server.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$SERVICE_HOME
Environment=NODE_ENV=production
EnvironmentFile=$SERVICE_HOME/.env
ExecStartPre=/bin/sleep 5
ExecStart=/usr/bin/node src/server.js
ExecReload=/bin/kill -HUP \$MAINPID
KillMode=mixed
KillSignal=SIGINT
TimeoutStopSec=30
Restart=always
RestartSec=10
StartLimitInterval=60
StartLimitBurst=3

# Logging
StandardOutput=append:$LOG_DIR/api.log
StandardError=append:$LOG_DIR/api-error.log
SyslogIdentifier=silkcards-api

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$SERVICE_HOME/uploads $LOG_DIR
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

# Resource limits
LimitNOFILE=65536
MemoryMax=2G
CPUQuota=400%

[Install]
WantedBy=multi-user.target
EOF

# Worker Service
sudo tee /etc/systemd/system/silkcards-parser-worker.service > /dev/null << EOF
[Unit]
Description=SilkCards Parser Queue Worker
Documentation=https://github.com/silkcards/parser-microservice
After=network.target redis-server.service silkcards-parser-api.service
Requires=redis-server.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$SERVICE_HOME
Environment=NODE_ENV=production
EnvironmentFile=$SERVICE_HOME/.env
ExecStartPre=/bin/sleep 10
ExecStart=/usr/bin/node src/worker.js
ExecReload=/bin/kill -HUP \$MAINPID
KillMode=mixed
KillSignal=SIGINT
TimeoutStopSec=60
Restart=always
RestartSec=15
StartLimitInterval=120
StartLimitBurst=5

# Logging
StandardOutput=append:$LOG_DIR/worker.log
StandardError=append:$LOG_DIR/worker-error.log
SyslogIdentifier=silkcards-worker

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$SERVICE_HOME/uploads $LOG_DIR

# Resource limits
LimitNOFILE=65536
MemoryMax=3G
CPUQuota=600%

[Install]
WantedBy=multi-user.target
EOF

# Health check service
sudo tee /etc/systemd/system/silkcards-parser-healthcheck.service > /dev/null << EOF
[Unit]
Description=SilkCards Parser Health Monitor
After=silkcards-parser-api.service silkcards-parser-worker.service

[Service]
Type=oneshot
User=$SERVICE_USER
WorkingDirectory=$SERVICE_HOME
ExecStart=/usr/bin/node src/scripts/health-check.js
EOF

# Health check timer
sudo tee /etc/systemd/system/silkcards-parser-healthcheck.timer > /dev/null << EOF
[Unit]
Description=Run SilkCards Parser Health Check every 5 minutes
Requires=silkcards-parser-healthcheck.service

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
Unit=silkcards-parser-healthcheck.service

[Install]
WantedBy=timers.target
EOF

# Cleanup service
sudo tee /etc/systemd/system/silkcards-parser-cleanup.service > /dev/null << EOF
[Unit]
Description=SilkCards Parser File Cleanup
After=silkcards-parser-api.service

[Service]
Type=oneshot
User=$SERVICE_USER
WorkingDirectory=$SERVICE_HOME
ExecStart=/usr/bin/node src/scripts/cleanup.js
EOF

# Cleanup timer (daily)
sudo tee /etc/systemd/system/silkcards-parser-cleanup.timer > /dev/null << EOF
[Unit]
Description=Run SilkCards Parser Cleanup daily at 2 AM
Requires=silkcards-parser-cleanup.service

[Timer]
OnCalendar=daily
Persistent=true
Unit=silkcards-parser-cleanup.service

[Install]
WantedBy=timers.target
EOF

# Configure log rotation
echo "📋 Configuring log rotation..."
sudo tee /etc/logrotate.d/silkcards-parser > /dev/null << EOF
$LOG_DIR/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 644 $SERVICE_USER $SERVICE_USER
    postrotate
        systemctl reload silkcards-parser-api silkcards-parser-worker 2>/dev/null || true
    endscript
}
EOF

# Configure Nginx reverse proxy
echo "🔧 Configuring Nginx..."
sudo tee /etc/nginx/sites-available/silkcards-parser > /dev/null << EOF
# SilkCards Parser Nginx Configuration
upstream parser_backend {
    server 127.0.0.1:8000;
    keepalive 32;
}

# Rate limiting
limit_req_zone \$binary_remote_addr zone=api:10m rate=10r/s;
limit_req_zone \$binary_remote_addr zone=upload:10m rate=2r/s;

server {
    listen 80;
    server_name _;
    
    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    
    # Request size limits
    client_max_body_size 100M;
    client_body_timeout 60s;
    client_header_timeout 60s;
    
    # Health check (no rate limit)
    location /health {
        proxy_pass http://parser_backend;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        
        # Health check specific timeouts
        proxy_connect_timeout 5s;
        proxy_send_timeout 10s;
        proxy_read_timeout 10s;
    }
    
    # Upload endpoints
    location /jobs {
        limit_req zone=upload burst=5 nodelay;
        
        proxy_pass http://parser_backend;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        
        # Upload timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 600s;
        proxy_read_timeout 600s;
        proxy_request_buffering off;
    }
    
    # All other endpoints
    location / {
        limit_req zone=api burst=10 nodelay;
        
        proxy_pass http://parser_backend;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        
        # Standard timeouts
        proxy_connect_timeout 30s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }
    
    # Access logs
    access_log $LOG_DIR/nginx-access.log;
    error_log $LOG_DIR/nginx-error.log;
}
EOF

# Enable Nginx site
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/silkcards-parser /etc/nginx/sites-enabled/

# Test Nginx configuration
sudo nginx -t

# Configure firewall
echo "🔥 Configuring firewall..."
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 8000/tcp
sudo ufw --force enable

# Reload systemd and enable services
echo "⚙️ Enabling services..."
sudo systemctl daemon-reload
sudo systemctl enable redis-server
sudo systemctl enable nginx
sudo systemctl enable silkcards-parser-api
sudo systemctl enable silkcards-parser-worker
sudo systemctl enable silkcards-parser-healthcheck.timer
sudo systemctl enable silkcards-parser-cleanup.timer

# Start services
echo "🚀 Starting services..."
sudo systemctl start redis-server
sudo systemctl start nginx
sudo systemctl start silkcards-parser-api
sudo systemctl start silkcards-parser-worker
sudo systemctl start silkcards-parser-healthcheck.timer
sudo systemctl start silkcards-parser-cleanup.timer

# Wait for services to start
sleep 10

# Verify services
echo "✅ Verifying services..."
sudo systemctl is-active silkcards-parser-api || echo "❌ API service failed to start"
sudo systemctl is-active silkcards-parser-worker || echo "❌ Worker service failed to start"
sudo systemctl is-active redis-server || echo "❌ Redis failed to start"
sudo systemctl is-active nginx || echo "❌ Nginx failed to start"

# Test health endpoint
if curl -f http://localhost/health > /dev/null 2>&1; then
    echo "✅ Health check passed"
else
    echo "❌ Health check failed"
fi

echo ""
echo "🎉 Production deployment completed!"
echo ""
echo "Services Status:"
echo "• API Server: systemctl status silkcards-parser-api"
echo "• Worker: systemctl status silkcards-parser-worker" 
echo "• Redis: systemctl status redis-server"
echo "• Nginx: systemctl status nginx"
echo ""
echo "Logs:"
echo "• API: journalctl -u silkcards-parser-api -f"
echo "• Worker: journalctl -u silkcards-parser-worker -f"
echo "• Files: tail -f $LOG_DIR/*.log"
echo ""
echo "Health Check: curl http://$(hostname -I | awk '{print $1}')/health"
echo ""
echo "All services will automatically start on boot!"