FROM node:20-alpine

# Instalar dependências do sistema
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git \
    curl

# Criar diretório
WORKDIR /var/www/zappbot

# Copiar package files
COPY package*.json ./

# Instalar dependências Node
RUN npm install --legacy-peer-deps

# Copiar código fonte
COPY . .

# Criar diretórios necessários
RUN mkdir -p uploads logs backups auth_sessions

# Expor porta
EXPOSE 3000

# Iniciar aplicação
CMD ["node", "server.js"]