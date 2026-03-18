#!/bin/bash

# =============================================================================
# ZAPPBOT - INSTALADOR COMPLETO PARA VPS (Ubuntu/Debian)
# Autor: ZappBot
# Versão: 1.0.0
# =============================================================================

set -e

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

print_banner() {
    echo -e "${CYAN}"
    echo "╔═══════════════════════════════════════════════════════════════╗"
    echo "║              ZAPPBOT - INSTALADOR COMPLETO VPS               ║"
    echo "║     Bot WhatsApp/Telegram + IA + Painel de Gestão           ║"
    echo "╚═══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

print_step() { echo -e "${BLUE}[►]${NC} $1"; }
print_success() { echo -e "${GREEN}[✓]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[!]${NC} $1"; }
print_error() { echo -e "${RED}[✗]${NC} $1"; }

# Verificar root
if [ "$EUID" -ne 0 ]; then
    print_error "Execute este script como ROOT (sudo bash install.sh)"
    exit 1
fi

print_banner

# =============================================================================
# 1. DETECTAR VERSÃO DO SISTEMA
# =============================================================================
print_step "Detectando sistema operacional..."

# Detectar versão do Ubuntu
if [ -f /etc/lsb-release ]; then
    OS_VERSION=$(lsb_release -rs 2>/dev/null)
    OS_CODENAME=$(lsb_release -cs 2>/dev/null)
else
    OS_VERSION=$(cat /etc/os-release | grep VERSION_ID | cut -d'"' -f2 | head -1)
    OS_CODENAME=$(cat /etc/os-release | grep VERSION_CODENAME | cut -d'"' -f2 | head -1)
fi
print_warning "Versão do sistema: $OS_VERSION ($OS_CODENAME)"

# =============================================================================
# 2. ATUALIZAR SISTEMA
# =============================================================================
print_step "Atualizando sistema..."
export DEBIAN_FRONTEND=noninteractive
apt update -y && apt upgrade -y
print_success "Sistema atualizado"

# =============================================================================
# 3. INSTALAR NODE.JS - COMPATIBILIDADE COM UBUNTU 18.04
# =============================================================================
print_step "Instalando Node.js..."

# Detectar libc6
LIBC_VERSION=$(ldd --version 2>/dev/null | head -1 | awk '{print $NF}')
print_warning "Versão do libc6: $LIBC_VERSION"

# Se Ubuntu 18.04 (bionic) ou libc6 < 2.28, usar Node 14
if [ "$OS_CODENAME" = "bionic" ] || [[ "$LIBC_VERSION" < "2.28" ]]; then
    print_warning "Sistema legado detectado (Ubuntu 18.04). Usando Node.js 14.x..."
    
    # Remover nodesource existente
    rm -f /etc/apt/sources.list.d/nodesource.list
    rm -rf /var/lib/apt/lists/nodesource*
    
    # Instalar Node.js 14.x (último compatível com libc6 2.27)
    curl -fsSL https://deb.nodesource.com/setup_14.x | bash -
    apt-get install -y nodejs
else
    # Ubuntu 20.04+ pode usar Node 18+
    if command -v node &> /dev/null; then
        print_warning "Node.js já instalado: $(node -v)"
    else
        # Tentar Node 20, se falhar usar 18
        if ! curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>/dev/null; then
            print_warning "Tentando Node.js 18.x..."
            curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
        fi
        apt-get install -y nodejs || {
            print_warning "Tentando Node.js 16..."
            curl -fsSL https://deb.nodesource.com/setup_16.x | bash -
            apt-get install -y nodejs
        }
    fi
fi

print_success "Node.js instalado: $(node -v)"
print_success "NPM instalado: $(npm -v)"

# =============================================================================
# 3. INSTALAR NGINX
# =============================================================================
print_step "Instalando Nginx..."

if command -v nginx &> /dev/null; then
    print_warning "Nginx já instalado"
else
    apt install -y nginx
fi

print_success "Nginx instalado: $(nginx -v 2>&1 | cut -d' ' -f3)"

# =============================================================================
# 4. INSTALAR FERRAMENTAS UTILITÁRIAS
# =============================================================================
print_step "Instalando ferramentas..."

apt install -y curl wget git unzip zip build-essential \
    software-properties-common ca-certificates gnupg lsb-release \
    redis-server ufw fail2ban htop

print_success "Ferramentas instaladas"

# =============================================================================
# 5. INSTALAR PM2 (Gerenciador de Processos)
# =============================================================================
print_step "Instalando PM2..."
npm install -g pm2
# pm2-logrotate não é mais necessário no PM2 mais recente
# O PM2 já tem log management integrado
print_success "PM2 instalado"

# =============================================================================
# 6. CRIAR DIRETÓRIO DO PROJETO
# =============================================================================
print_step "Configurando diretórios..."

PROJECT_DIR="/var/www/zappbot"
mkdir -p "$PROJECT_DIR"

# Definir diretório atual como local do projeto
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$SCRIPT_DIR" != "$PROJECT_DIR" ]; then
    cp -r "$SCRIPT_DIR"/* "$PROJECT_DIR/" 2>/dev/null || true
fi

cd "$PROJECT_DIR"
print_success "Diretório configurado: $PROJECT_DIR"

# =============================================================================
# 7. INSTALAR DEPENDÊNCIAS NPM
# =============================================================================
print_step "Instalando dependências do projeto..."

# Criar package.json se não existir
if [ ! -f "package.json" ]; then
    cat > package.json << 'PKGJSON'
{
  "name": "zappbot",
  "version": "1.0.0",
  "description": "Bot WhatsApp/Telegram com IA",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node server.js"
  },
  "dependencies": {
    "@google/generative-ai": "^0.21.0",
    "@whiskeysockets/baileys": "^6.6.0",
    "adm-zip": "^0.5.16",
    "archiver": "^7.0.1",
    "axios": "^1.7.0",
    "bcrypt": "^5.1.1",
    "cookie-parser": "^1.4.7",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "express-session": "^1.18.0",
    "mercadopago": "^2.0.11",
    "multer": "^1.4.5-lts.1",
    "node-cron": "^3.0.3",
    "passport": "^0.7.0",
    "passport-google-oauth20": "^2.0.0",
    "passport-local": "^1.0.0",
    "pino": "^9.1.0",
    "qrcode": "^1.5.4",
    "session-file-store": "^1.5.0",
    "socket.io": "^4.7.5",
    "socket.io-client": "^4.8.3",
    "telegraf": "^4.16.3"
  }
}
PKGJSON
fi

npm install --legacy-peer-deps
print_success "Dependências instaladas"

# =============================================================================
# 8. CRIAR ARQUIVO .ENV
# =============================================================================
print_step "Criando arquivo de configuração..."

if [ ! -f ".env" ]; then
    cat > .env << 'ENVFILE'
# ==========================================
# CONFIGURAÇÕES DO ZAPPBOT
# ==========================================

# Sessão
SESSION_SECRET=zappbot_session_secret_change_me

# URLs
PUBLIC_URL=http://localhost:3000
GOOGLE_CALLBACK_URL=/auth/google/callback

# Google OAuth (opcional)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# API Gemini (OBRIGATÓRIO para IA)
# Coloque suas chaves separadas por linha
API_KEYS_GEMINI=sua_chave_aqui

# Mercado Pago (opcional)
MP_ACCESS_TOKEN=
MP_WEBHOOK_SECRET=

# Configurações do Bot
DEFAULT_TRIAL_DAYS=3
ENVFILE
    print_warning "Arquivo .env criado - configure suas chaves!"
else
    print_warning "Arquivo .env já existe"
fi

# =============================================================================
# 9. CRIAR PASTAS NECESSÁRIAS
# =============================================================================
print_step "Criando pastas..."

mkdir -p auth_sessions
mkdir -p uploads
mkdir -p backups
mkdir -p logs

print_success "Pastas criadas"

# =============================================================================
# 10. CONFIGURAR NGINX
# =============================================================================
print_step "Configurando Nginx..."

DOMAIN=$(hostname -I | awk '{print $1}')
read -p "Digite seu domínio (ou Enter para usar IP): " INPUT_DOMAIN
if [ -n "$INPUT_DOMAIN" ]; then
    DOMAIN="$INPUT_DOMAIN"
fi

print_warning "Configurando Nginx para: $DOMAIN"

# Backup config padrão
cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak 2>/dev/null || true

# Criar config do site
cat > /etc/nginx/sites-available/zappbot << 'NGINXCONF'
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        
        # WebSocket support
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }

    # Arquivos estáticos
    location /uploads {
        alias /var/www/zappbot/uploads;
        add_header Cache-Control "public, max-age=31536000";
    }

    #SSL (comente se não tiver certificado)
    #listen 443 ssl http2;
    #ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    #ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
}
NGINXCONF

# Ativar site
ln -sf /etc/nginx/sites-available/zappbot /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

print_success "Nginx configurado para $DOMAIN"

# =============================================================================
# 11. CONFIGURAR FIREWALL
# =============================================================================
print_step "Configurando Firewall..."

#SSH
read -p "Porta SSH (padrão 22): " SSH_PORT
SSH_PORT=${SSH_PORT:-22}

ufw --force enable
ufw allow $SSH_PORT/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3000/tcp

print_success "Firewall configurado"

# =============================================================================
# 12. CONFIGURAR SWAP (se necessário)
# =============================================================================
print_step "Verificando memória..."

TOTAL_MEM=$(free -m | awk '/^Mem:/{print $2}')
if [ "$TOTAL_MEM" -lt 2048 ]; then
    print_warning "Pouca memória RAM detected. Criando swap..."
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    print_success "Swap criado"
fi

# =============================================================================
# 13. INICIAR BOT COM PM2
# =============================================================================
print_step "Iniciando ZappBot com PM2..."

cd /var/www/zappbot

# Parar se já estiver rodando
pm2 delete zappbot 2>/dev/null || true

# Iniciar
pm2 start server.js --name zappbot --time
pm2 save

print_success "ZappBot iniciado"

# =============================================================================
# 14. CONFIGURAR AUTO-INICIO
# =============================================================================
print_step "Configurando auto-início..."

pm2 startup | tail -n 1 > /tmp/pm2-startup.sh
chmod +x /tmp/pm2-startup.sh
bash /tmp/pm2-startup.sh 2>/dev/null || true

print_success "Auto-início configurado"

# =============================================================================
# 15. INSTALAR CERTIFICADO SSL (Let's Encrypt)
# =============================================================================
print_step "Verificando SSL..."

if [ -n "$INPUT_DOMAIN" ]; then
    read -p "Deseja instalar SSL gratuito? (s/n): " INSTALL_SSL
    if [ "$INSTALL_SSL" = "s" ]; then
        apt install -y certbot python3-certbot-nginx
        
        read -p "Seu email para Let's Encrypt: " USER_EMAIL
        
        certbot --nginx -d "$DOMAIN" --email "$USER_EMAIL" --agree-tos --non-interactive
        
        # Renovar automaticamente
        crontab -l > /tmp/crontab.bak
        echo "0 0 * * * certbot renew --quiet" >> /tmp/crontab.bak
        crontab /tmp/crontab.bak
        
        print_success "SSL instalado!"
    fi
fi

# =============================================================================
# RESUMO FINAL
# =============================================================================
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  INSTALAÇÃO CONCLUÍDA COM SUCESSO!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}📋 INFORMAÇÕES:${NC}"
echo "  • Pasta do projeto: /var/www/zappbot"
echo "  • URL: http://$DOMAIN"
echo "  • Painel: http://$DOMAIN"
echo ""
echo -e "${YELLOW}📝 PRÓXIMOS PASSOS:${NC}"
echo "  1. Edite o arquivo .env e adicione sua API KEY do Gemini"
echo "  2. Acesse o painel e crie seu usuário admin"
echo "  3. Configure o domínio e SSL no arquivo .env"
echo ""
echo -e "${YELLOW}📚 COMANDOS ÚTEIS:${NC}"
echo "  • Ver logs:     pm2 logs zappbot"
echo "  • Reiniciar:   pm2 restart zappbot"
echo "  • Parar:        pm2 stop zappbot"
echo "  • Status:       pm2 status"
echo ""
echo -e "${CYAN}Obrigado por usar ZappBot! 🚀${NC}"
echo ""