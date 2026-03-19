#!/bin/bash

# =============================================================================
# ZAPPBOT - INSTALADOR MANUAL (sem NodeSource)
# Execute: sudo bash install-manual.sh
# =============================================================================

set -e

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗"
echo "║         ZAPPBOT - INSTALADOR MANUAL (SEM NODESOURCE)          ║"
echo "╚═══════════════════════════════════════════════════════════════╝${NC}"

# Verificar root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}[✗] Execute como root: sudo bash install-manual.sh${NC}"
    exit 1
fi

echo -e "${BLUE}[►] Removendo repositórios quebrados...${NC}"
rm -f /etc/apt/sources.list.d/nodesource.list
rm -rf /var/lib/apt/lists/nodesource*
rm -f /usr/share/keyrings/nodesource.gpg

echo -e "${BLUE}[►] Atualizando apt...${NC}"
apt update

echo -e "${BLUE}[►] Instalando Node.js 14.x via binário...${NC}"
cd /tmp

# Baixar Node.js 14
wget -q https://nodejs.org/dist/v14.21.3/node-v14.21.3-linux-x64.tar.xz

# Extrair
tar -xJf node-v14.21.3-linux-x64.tar.xz

# Copiar para /usr/local
cp -r node-v14.21.3-linux-x64/* /usr/local/

# Criar symlinks
ln -sf /usr/local/bin/node /usr/bin/node
ln -sf /usr/local/bin/npm /usr/bin/npm
ln -sf /usr/local/bin/npx /usr/bin/npx

# Limpar
rm -rf node-v14.21.3-linux-x64*

echo -e "${GREEN}[✓] Node.js: $(node -v)${NC}"
echo -e "${GREEN}[✓] NPM: $(npm -v)${NC}"

echo -e "${BLUE}[►] Instalando dependências do sistema...${NC}"
apt install -y curl wget git unzip build-essential

echo -e "${BLUE}[►] Instalando PM2...${NC}"
npm install -g pm2

echo -e "${BLUE}[►] Instalando dependências do ZappBot...${NC}"
cd /var/www/zappbot
npm install --legacy-peer-deps

echo -e "${GREEN}"
echo "═══════════════════════════════════════════════════════════════"
echo "  INSTALAÇÃO MANUAL CONCLUÍDA!"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  Node.js: $(node -v)"
echo "  NPM: $(npm -v)"
echo ""
echo "  Para iniciar:"
echo "  cd /var/www/zappbot"
echo "  node server.js"
echo ""
echo -e "${NC}"
