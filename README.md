# 🤖 ZAPPBOT - Bot WhatsApp + Telegram com IA

Sistema completo de automação de mensagens com inteligência artificial Gemini, painel de gestão, CRM e campanhas.

## ✨ Funcionalidades

- **Bot WhatsApp** com IA Gemini (atendimento automático)
- **Bot Telegram** com comandos completos
- **Painel de Gestão** Web (criar, editar, excluir bots)
- **CRM de Clientes** (gestão de clientes e contatos)
- **Campanhas** (avisos e cobranças automáticas)
- **Suporte via IA** (chat de ajuda no painel)
- **Pagamentos Pix** via Mercado Pago

## 📋 Requisitos

- Ubuntu 20.04+ ou Debian 11+
- Node.js 18+
- 2GB RAM mínimo
- Domínio (opcional para SSL)

## 🚀 Instalação Rápida

### 1. Na sua VPS, clone ou faça upload dos arquivos:

```bash
cd /var/www
git clone https://github.com/seu-repo/zappbot.git
cd zappbot
```

### 2. Execute o instalador:

```bash
sudo bash install.sh
```

O instalador vai:
- Instalar Node.js e dependências
- Criar a estrutura de pastas
- Configurar o PM2
- (Opcional) Configurar Nginx + SSL

### 3. Configure o arquivo .env:

```bash
nano .env
```

Preencha com suas API Keys do Gemini:
```
API_KEYS_GEMINI=
AIzaSy................
```

### 4. Acesse o painel:

- Sem domínio: http://seu-ip:3000
- Com domínio: https://seu-dominio

## 📝 Configuração Inicial

1. Acesse o painel pela primeira vez
2. Crie seu usuário admin (primeiro usuário é sempre admin)
3. Configure as API Keys do Gemini nas configurações
4. Comece a criar seus bots!

## 🔧 Comandos Úteis

```bash
# Ver logs em tempo real
pm2 logs zappbot

# Reiniciar o bot
pm2 restart zappbot

# Ver status
pm2 status

# Parar o bot
pm2 stop zappbot

# Ver consumo de memória
pm2 monit
```

## 🔐 Variáveis de Ambiente

| Variável | Descrição | Obrigatório |
|----------|-----------|--------------|
| `API_KEYS_GEMINI` | Keys do Gemini (1 por linha) | Sim |
| `SESSION_SECRET` | Chave de segurança | Sim |
| `GOOGLE_CLIENT_ID` | ID do Google OAuth | Não |
| `GOOGLE_CLIENT_SECRET` | Secret do Google OAuth | Não |
| `MP_ACCESS_TOKEN` | Token do Mercado Pago | Não |
| `PUBLIC_URL` | URL pública do painel | Não |

## 📦 Estrutura de Arquivos

```
zappbot/
├── index.js          # Motor do bot (WhatsApp/Telegram)
├── server.js         # Servidor do painel
├── index.html        # Frontend principal
├── clients.html      # Página de clientes
├── client-routes.js  # Rotas de clientes/campanhas
├── sw.js             # Service Worker
├── package.json      # Dependências Node
├── install.sh        # Script de instalação
├── .env             # Variáveis de ambiente
└── auth_sessions/   # Pastas de sessões dos bots
```

## 🆘 Problemas Comuns

**Bot não conecta:**
- Verifique as API Keys do Gemini
- Verifique os logs: `pm2 logs zappbot`

**QR Code não aparece:**
- Aguarde alguns segundos após iniciar
- Verifique se a porta 3000 está acessível

**Mensagens não chegam:**
- Verifique se o bot está "Online" no painel
- Cheque o prompt do bot nas configurações

## 📄 Licença

MIT License - Use como quiser!

---

Desenvolvido com ❤️ usando Baileys, Telegraf e Gemini AI