#!/bin/bash

# Script para atualizar o ZappBot na VPS
# Uso: ./update.sh

PROJECT_DIR="/var/www/zappbot"
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}[►] Atualizando ZappBot...${NC}"

cd "$PROJECT_DIR"

# Pull das atualizações
echo -e "${YELLOW}[►] Baixando atualizações do Git...${NC}"
git pull origin main || echo "Não é um repositório Git, pulando..."

# Reinstalar dependências se necessário
echo -e "${YELLOW}[►] Verificando dependências...${NC}"
npm install --legacy-peer-deps

# Reiniciar PM2
echo -e "${YELLOW}[►] Reiniciando o bot...${NC}"
pm2 restart zappbot

# Mostrar status
pm2 status

echo -e "${GREEN}[✓] ZappBot atualizado com sucesso!${NC}"