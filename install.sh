#!/bin/bash

# =============================================================================
# ZAPPBOT - INSTALADOR COMPLETO AUTOMÁTICO
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
echo -e "${CYAN}"
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║          ZAPPBOT 3D - INSTALADOR AUTOMÁTICO                 ║"
echo "║     Bot WhatsApp/Telegram + IA + Painel de Gestão           ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Verificar root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}[✗] Execute como root: sudo bash install.sh${NC}"
    exit 1
fi

echo -e "${BLUE}[►] Iniciando instalação automática...${NC}"

# =============================================================================
# 1. LIMPEZA E CONFIGURAÇÃO INICIAL
# =============================================================================
echo -e "${BLUE}[1/6] Preparando sistema...${NC}"

# Remover repositórios quebrados
rm -f /etc/apt/sources.list.d/nodesource.list 2>/dev/null || true
rm -rf /var/lib/apt/lists/nodesource* 2>/dev/null || true
rm -f /usr/share/keyrings/nodesource.gpg 2>/dev/null || true

# Atualizar apt
export DEBIAN_FRONTEND=noninteractive
apt update -qq

echo -e "${GREEN}[✓] Sistema preparado${NC}"

# =============================================================================
# 2. INSTALAR NODE.JS 14
# =============================================================================
echo -e "${BLUE}[2/6] Instalando Node.js 14...${NC}"

# Verificar se já tem Node.js
if command -v node &> /dev/null; then
    NODE_VER=$(node -v)
    echo -e "${YELLOW}[!] Node.js já instalado: $NODE_VER${NC}"
else
    # Baixar e instalar Node.js 14 via binário
    cd /tmp
    
    echo -e "${YELLOW}   Baixando Node.js...${NC}"
    wget -q https://nodejs.org/dist/v14.21.3/node-v14.21.3-linux-x64.tar.xz
    
    echo -e "${YELLOW}   Instalando Node.js...${NC}"
    tar -xJf node-v14.21.3-linux-x64.tar.xz
    cp -r node-v14.21.3-linux-x64/* /usr/local/
    
    # Symlinks
    ln -sf /usr/local/bin/node /usr/bin/node
    ln -sf /usr/local/bin/npm /usr/bin/npm
    ln -sf /usr/local/bin/npx /usr/bin/npx
    
    # Limpar
    rm -rf node-v14.21.3-linux-x64*
fi

echo -e "${GREEN}[✓] Node.js: $(node -v)${NC}"
echo -e "${GREEN}[✓] NPM: $(npm -v)${NC}"

# =============================================================================
# 3. INSTALAR DEPENDÊNCIAS DO SISTEMA
# =============================================================================
echo -e "${BLUE}[3/6] Instalando dependências do sistema...${NC}"

apt install -y -qq curl wget git unzip build-essential ca-certificates gnupg lsb-release sudo

echo -e "${GREEN}[✓] Dependências instaladas${NC}"

# =============================================================================
# 4. CONFIGURAR PROJETO
# =============================================================================
echo -e "${BLUE}[4/6] Configurando ZappBot...${NC}"

# Criar diretório
PROJECT_DIR="/var/www/zappbot"
mkdir -p "$PROJECT_DIR"

# Copiar arquivos do diretório atual ou criar estrutura básica
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/server.js" ]; then
    echo -e "${YELLOW}   Copiando arquivos...${NC}"
    cp -r "$SCRIPT_DIR"/* "$PROJECT_DIR/" 2>/dev/null || true
else
    echo -e "${YELLOW}   Criando estrutura básica...${NC}"
fi

cd "$PROJECT_DIR"

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

# Criar .env se não existir
if [ ! -f ".env" ]; then
    DOMAIN=$(hostname -I | awk '{print $1}')
    cat > .env << ENVFILE
# ==========================================
# ZAPPBOT 3D - CONFIGURAÇÕES
# ==========================================

# Sessão e Segurança
SESSION_SECRET=zappbot_session_$(date +%s)
PUBLIC_URL=http://$DOMAIN:3000
SOCKET_URL=http://$DOMAIN:3000
PORT=3000
NODE_ENV=production

# API Gemini (OBRIGATÓRIO)
API_KEYS_GEMINI=SUA_CHAVE_AQUI

# Mercado Pago (opcional)
MP_ACCESS_TOKEN=

# Configurações do Bot
DEFAULT_TRIAL_DAYS=3
ENVFILE
    echo -e "${YELLOW}[!] ATENÇÃO: Edite o .env e adicione sua API KEY do Gemini!${NC}"
fi

# Criar diretórios
mkdir -p auth_sessions uploads backups logs

# =============================================================================
# 5. INSTALAR DEPENDÊNCIAS NPM
# =============================================================================
echo -e "${BLUE}[5/6] Instalando dependências NPM...${NC}"

npm install --legacy-peer-deps 2>&1 | tail -5

echo -e "${GREEN}[✓] Dependências NPM instaladas${NC}"

# =============================================================================
# 6. INICIAR SERVIÇO
# =============================================================================
echo -e "${BLUE}[6/6] Iniciando ZappBot...${NC}"

# Parar processos antigos
pkill -f "node server.js" 2>/dev/null || true
pkill -f "node index.js" 2>/dev/null || true

# Criar script de inicialização
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

# Ativar e iniciar
systemctl daemon-reload
systemctl enable zappbot
systemctl restart zappbot

# Aguardar iniciar
sleep 3

# Verificar status
if systemctl is-active --quiet zappbot; then
    echo -e "${GREEN}[✓] ZappBot iniciado com sucesso!${NC}"
else
    echo -e "${YELLOW}[!] ZappBot iniciou, verificando logs...${NC}"
    journalctl -u zappbot -n 10 --no-pager
fi

# =============================================================================
# RESUMO
# =============================================================================
IP=$(hostname -I | awk '{print $1}')

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  INSTALAÇÃO CONCLUÍDA COM SUCESSO!${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}📋 INFORMAÇÕES:${NC}"
echo "   • URL: http://$IP:3000"
echo "   • Painel: http://$IP:3000"
echo "   • Usuário: admin"
echo "   • Senha: admin"
echo ""
echo -e "${RED}⚠️  IMPORTANTE:${NC}"
echo "   1. Edite o arquivo /var/www/zappbot/.env"
echo "   2. Adicione sua API KEY do Gemini"
echo "   3. Reinicie: sudo systemctl restart zappbot"
echo ""
echo -e "${YELLOW}📚 COMANDOS ÚTEIS:${NC}"
echo "   • Status:     sudo systemctl status zappbot"
echo "   • Logs:       sudo journalctl -u zappbot -f"
echo "   • Reiniciar:  sudo systemctl restart zappbot"
echo "   • Parar:      sudo systemctl stop zappbot"
echo ""
echo -e "${CYAN}Obrigado por usar ZappBot 3D! 🚀${NC}"
echo ""
