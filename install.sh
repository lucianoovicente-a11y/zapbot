#!/bin/bash

# =============================================================================
# ZAPPBOT 3D - INSTALADOR COMPLETO (SOBRESCREVE TUDO)
# Execute: sudo bash install.sh
# =============================================================================

set -e

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Banner
clear
echo -e "${CYAN}"
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║          ZAPPBOT 3D - INSTALADOR AUTOMÁTICO               ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Verificar root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}[✗] Execute como root: sudo bash install.sh${NC}"
    exit 1
fi

echo -e "${BLUE}[1/8] Parando serviços antigos...${NC}"
pkill -f "node server.js" 2>/dev/null || true
pkill -f "node index.js" 2>/dev/null || true
systemctl stop zappbot 2>/dev/null || true
echo -e "${GREEN}[✓] Serviços antigos parados${NC}"

echo -e "${BLUE}[2/8] Preparando sistema...${NC}"
export DEBIAN_FRONTEND=noninteractive

# Remover repositórios quebrados
rm -f /etc/apt/sources.list.d/nodesource.list 2>/dev/null || true
rm -rf /var/lib/apt/lists/nodesource* 2>/dev/null || true
rm -f /usr/share/keyrings/nodesource.gpg 2>/dev/null || true

# Atualizar
apt update -qq
apt upgrade -y -qq

echo -e "${GREEN}[✓] Sistema atualizado${NC}"

echo -e "${BLUE}[3/8] Instalando Node.js 14...${NC}"

# Verificar se já tem Node
if command -v node &> /dev/null; then
    echo -e "${YELLOW}   Node.js já existe: $(node -v)${NC}"
else
    cd /tmp
    echo -e "${YELLOW}   Baixando Node.js 14...${NC}"
    wget -q https://nodejs.org/dist/v14.21.3/node-v14.21.3-linux-x64.tar.xz
    tar -xJf node-v14.21.3-linux-x64.tar.xz
    cp -r node-v14.21.3-linux-x64/* /usr/local/
    ln -sf /usr/local/bin/node /usr/bin/node
    ln -sf /usr/local/bin/npm /usr/bin/npm
    ln -sf /usr/local/bin/npx /usr/bin/npx
    rm -rf node-v14.21.3-linux-x64*
fi

echo -e "${GREEN}[✓] Node.js: $(node -v)${NC}"
echo -e "${GREEN}[✓] NPM: $(npm -v)${NC}"

echo -e "${BLUE}[4/8] Instalando dependências...${NC}"
apt install -y -qq curl wget git unzip build-essential \
    ca-certificates gnupg lsb-release sudo ufw

echo -e "${GREEN}[✓] Dependências instaladas${NC}"

echo -e "${BLUE}[5/8] Configurando projeto...${NC}"

# Criar diretório
PROJECT_DIR="/var/www/zappbot"
rm -rf "$PROJECT_DIR" 2>/dev/null || true
mkdir -p "$PROJECT_DIR"

# Copiar arquivos
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/server.js" ]; then
    cp -r "$SCRIPT_DIR"/* "$PROJECT_DIR/"
else
    echo -e "${RED}[✗] Arquivos do projeto não encontrados!${NC}"
    exit 1
fi

cd "$PROJECT_DIR"

# Criar package.json
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

# Criar .env
IP=$(hostname -I | awk '{print $1}')
cat > .env << ENVFILE
SESSION_SECRET=zappbot_session_$(date +%s)
PUBLIC_URL=http://$IP:3000
SOCKET_URL=http://$IP:3000
PORT=3000
NODE_ENV=production
API_KEYS_GEMINI=SUA_CHAVE_AQUI
MP_ACCESS_TOKEN=
DEFAULT_TRIAL_DAYS=3
ENVFILE

# Criar diretórios
mkdir -p auth_sessions uploads backups logs

echo -e "${GREEN}[✓] Projeto configurado${NC}"

echo -e "${BLUE}[6/8] Instalando NPM...${NC}"
npm install --legacy-peer-deps 2>&1 | tail -3
echo -e "${GREEN}[✓] NPM instalado${NC}"

echo -e "${BLUE}[7/8] Configurando firewall e inicialização...${NC}"

# Liberar firewall
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3000/tcp
ufw --force enable

# Criar serviço systemd
cat > /etc/systemd/system/zappbot.service << SYSTEMD
[Unit]
Description=ZappBot 3D Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$PROJECT_DIR
ExecStart=/usr/bin/node $PROJECT_DIR/server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SYSTEMD

# Recarregar systemd
systemctl daemon-reload
systemctl enable zappbot

# Iniciar
systemctl restart zappbot
sleep 3

echo -e "${GREEN}[✓] Serviço configurado${NC}"

echo -e "${BLUE}[8/8] Verificando instalação...${NC}"

# Verificar se está rodando
if systemctl is-active --quiet zappbot; then
    echo -e "${GREEN}[✓] ZappBot está rodando!${NC}"
else
    echo -e "${YELLOW}[!] Verificando status...${NC}"
    systemctl status zappbot --no-pager | head -10
fi

# Testar conexão
sleep 2
if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 | grep -q "200\|302"; then
    echo -e "${GREEN}[✓] Servidor respondendo!${NC}"
else
    echo -e "${YELLOW}[!] Tentando iniciar diretamente...${NC}"
    cd "$PROJECT_DIR"
    node server.js &
    sleep 3
fi

# =============================================================================
# RESUMO
# =============================================================================
IP=$(hostname -I | awk '{print $1}')

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}          INSTALAÇÃO CONCLUÍDA COM SUCESSO!${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}🌐 ACESSO:${NC}"
echo "   URL: http://$IP:3000"
echo ""
echo -e "${YELLOW}🔐 LOGIN:${NC}"
echo "   Usuário: admin"
echo "   Senha: admin"
echo ""
echo -e "${RED}⚠️  PRÓXIMO PASSO:${NC}"
echo "   1. Edite: nano /var/www/zappbot/.env"
echo "   2. Adicione sua API KEY do Gemini em API_KEYS_GEMINI"
echo "   3. Reinicie: sudo systemctl restart zappbot"
echo ""
echo -e "${YELLOW}📝 COMANDOS:${NC}"
echo "   Status:   sudo systemctl status zappbot"
echo "   Logs:     sudo journalctl -u zappbot -f"
echo "   Reiniciar: sudo systemctl restart zappbot"
echo ""
echo -e "${CYAN}Obrigado por usar ZappBot 3D! 🚀${NC}"
echo ""
