#!/bin/bash

# =====================================================
# ZAPPBOT - INSTALADOR AUTOMÁTICO PARA VPS
# Compatible com Ubuntu 20.04+ / Debian 11+
# =====================================================

set -e

# obter diretório onde o script está
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

print_banner() {
    echo -e "${CYAN}"
    echo "╔═══════════════════════════════════════════════════════╗"
    echo "║           ZAPPBOT - INSTALADOR AUTOMÁTICO             ║"
    echo "║      Bot WhatsApp + Telegram + Painel Unificado      ║"
    echo "╚═══════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

print_step() {
    echo -e "${BLUE}[►]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[!]${NC} $1"
}

print_error() {
    echo -e "${RED}[✗]${NC} $1"
}

# Verificar se é root
if [ "$EUID" -ne 0 ]; then
    print_error "Este script deve ser executado como ROOT"
    echo "Execute: sudo bash install.sh"
    exit 1
fi

print_banner
print_step "Iniciando instalação em: $SCRIPT_DIR"

# =====================================================
# PASSO 1: Atualizar Sistema
# =====================================================
print_step "Atualizando sistema..."
apt update -qq
apt upgrade -y -qq
print_success "Sistema atualizado"

# =====================================================
# PASSO 2: Instalar Dependências do Sistema
# =====================================================
print_step "Instalando dependências do sistema..."

apt install -y -qq curl wget git nano unzip zip \
    software-properties-common \
    build-essential python3 ffmpeg \
    certbot python3-certbot-nginx \
    ufw ca-certificates gnupg lsb-release 2>/dev/null

print_success "Dependências do sistema instaladas"

# =====================================================
# PASSO 3: Instalar Node.js
# =====================================================
print_step "Instalando Node.js 22.x..."

if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
    apt install -y -qq nodejs
    print_success "Node.js $(node -v) instalado"
else
    print_warning "Node.js já instalado: $(node -v)"
fi

# =====================================================
# PASSO 4: Criar estrutura de diretórios
# =====================================================
print_step "Criando estrutura de diretórios..."

mkdir -p uploads sessions auth_sessions database

# Criar arquivos JSON
for db_file in users bots groups settings payments clients campaigns; do
    if [ ! -f "${db_file}.json" ]; then
        if [ "$db_file" = "payments" ] || [ "$db_file" = "clients" ] || [ "$db_file" = "campaigns" ]; then
            echo "[]" > "${db_file}.json"
        else
            echo "{}" > "${db_file}.json"
        fi
    fi
done

chmod -R 777 uploads sessions auth_sessions *.json 2>/dev/null || true
print_success "Estrutura de diretórios criada"

# =====================================================
# PASSO 5: Configurar .env
# =====================================================
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
        print_warning "Arquivo .env criado a partir do exemplo"
        print_warning "Configure suas API Keys do Gemini antes de iniciar!"
    else
        echo "# ZAPPBOT Configuration" > .env
        echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
        echo "" >> .env
        echo "# API Keys do Gemini (uma por linha):" >> .env
        echo "API_KEYS_GEMINI=" >> .env
        print_warning "Arquivo .env criado - Configure suas API Keys!"
    fi
else
    print_warning "Arquivo .env já existe"
fi

# =====================================================
# PASSO 6: Instalar dependências Node.js
# =====================================================
print_step "Instalando dependências Node.js..."

rm -rf node_modules package-lock.json 2>/dev/null || true
npm install --silent 2>&1 | tail -3

if [ -d "node_modules" ]; then
    print_success "Dependências Node.js instaladas"
else
    print_error "Falha ao instalar dependências"
    exit 1
fi

# =====================================================
# PASSO 7: PM2 - Gerenciador de Processos
# =====================================================
print_step "Configurando PM2..."

if ! command -v pm2 &> /dev/null; then
    npm install -g pm2 --silent
    print_success "PM2 instalado"
else
    print_warning "PM2 já está instalado"
fi

# =====================================================
# PASSO 8: Nginx (Opcional)
# =====================================================
echo ""
read -p "Deseja configurar Nginx com SSL? (s/N): " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Ss]$ ]]; then
    print_step "Configurando Nginx..."
    
    read -p "Digite seu domínio (ex: bot.seusite.com): " DOMAIN
    read -p "Digite seu email para SSL: " EMAIL
    
    if [ -z "$DOMAIN" ]; then
        print_error "Domínio não pode estar vazio"
        exit 1
    fi
    
    # Criar configuração Nginx
    cat > /etc/nginx/sites-available/zappbot << EOF
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
    }
    
    location ~ /\.well-known {
        allow all;
    }
}
EOF

    ln -sf /etc/nginx/sites-available/zappbot /etc/nginx/sites-enabled/
    rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
    nginx -t && systemctl reload nginx
    
    print_success "Nginx configurado"
    
    # SSL
    if [ -n "$EMAIL" ]; then
        print_step "Instalando certificado SSL..."
        certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect 2>/dev/null || true
        print_success "SSL configurado"
    else
        print_warning "Email não fornecido - SSL não será configurado"
    fi
fi

# =====================================================
# PASSO 9: Iniciar aplicação com PM2
# =====================================================
print_step "Iniciando aplicação com PM2..."

pm2 stop server.js 2>/dev/null || true
pm2 delete server.js 2>/dev/null || true

pm2 start server.js --name "zappbot" --wait-ready --listen-timeout 10000
pm2 save

# =====================================================
# PASSO 10: Firewall (Opcional)
# =====================================================
echo ""
read -p "Deseja configurar firewall (ufw)? (s/N): " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Ss]$ ]]; then
    print_step "Configurando firewall..."
    ufw --force enable 2>/dev/null || true
    ufw allow 22/tcp 2>/dev/null || true
    ufw allow 80/tcp 2>/dev/null || true
    ufw allow 443/tcp 2>/dev/null || true
    ufw allow 3000/tcp 2>/dev/null || true
    print_success "Firewall configurado"
fi

# =====================================================
# RESUMO FINAL
# =====================================================
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════╗"
echo "║               INSTALAÇÃO CONCLUÍDA!                    ║"
echo "╚═══════════════════════════════════════════════════════╝${NC}"
echo ""
echo "📋 PRÓXIMOS PASSOS:"
echo "   1. Configure o arquivo .env com suas API Keys do Gemini"
echo "   2. Reinicie o bot: pm2 restart zappbot"
echo "   3. Acesse o painel: http://localhost:3000"
echo ""
echo "📝 COMANDOS ÚTEIS:"
echo "   - Ver logs:       pm2 logs zappbot"
echo "   - Ver status:    pm2 status"
echo "   - Reiniciar:      pm2 restart zappbot"
echo "   - Parar:         pm2 stop zappbot"
echo "   - Monitor:        pm2 monit"
echo ""

if [ -n "$DOMAIN" ]; then
    echo "🌐 Acesse: https://$DOMAIN"
fi

echo ""
echo "⚠️  Lembre-se de configurar as API Keys do Gemini no arquivo .env!"
echo ""