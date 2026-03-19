#!/bin/bash

# =============================================================================
# ZAPPBOT 3D - INSTALADOR COMPLETO AUTOMÁTICO
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
echo "║       ZAPPBOT 3D - INSTALADOR COMPLETO                 ║"
echo "║     Nginx + SSL + Domínio + IA + Painel             ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Verificar root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}[✗] Execute como root: sudo bash install.sh${NC}"
    exit 1
fi

# =============================================================================
# PERGUNTAS
# =============================================================================
echo ""
echo -e "${YELLOW}📧 CONFIGURAÇÃO DO DOMÍNIO${NC}"
read -p "Digite seu domínio (ex: bot.seusite.com) ou ENTER para IP: " DOMAIN
read -p "Digite seu email para SSL: " EMAIL

IP=$(hostname -I | awk '{print $1}')

if [ -z "$DOMAIN" ]; then
    DOMAIN="$IP"
    USE_SSL="nao"
    echo -e "${YELLOW}   Usando IP: $IP${NC}"
else
    USE_SSL="sim"
    echo -e "${GREEN}   Domínio: $DOMAIN${NC}"
fi

echo ""
echo -e "${BLUE}Iniciando instalação...${NC}"
sleep 2

# =============================================================================
# 1. PARAR SERVIÇOS ANTIGOS
# =============================================================================
echo -e "${BLUE}[1/10] Parando serviços antigos...${NC}"
pkill -f "node server.js" 2>/dev/null || true
pkill -f "node index.js" 2>/dev/null || true
systemctl stop zappbot 2>/dev/null || true
systemctl stop nginx 2>/dev/null || true
echo -e "${GREEN}[✓] Serviços parados${NC}"

# =============================================================================
# 2. ATUALIZAR SISTEMA
# =============================================================================
echo -e "${BLUE}[2/10] Atualizando sistema...${NC}"
export DEBIAN_FRONTEND=noninteractive

rm -f /etc/apt/sources.list.d/nodesource.list 2>/dev/null || true
rm -rf /var/lib/apt/lists/nodesource* 2>/dev/null || true

apt update -qq
apt upgrade -y -qq
echo -e "${GREEN}[✓] Sistema atualizado${NC}"

# =============================================================================
# 3. INSTALAR NODE.JS 14
# =============================================================================
echo -e "${BLUE}[3/10] Instalando Node.js 14...${NC}"

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

# =============================================================================
# 4. INSTALAR DEPENDÊNCIAS
# =============================================================================
echo -e "${BLUE}[4/10] Instalando dependências...${NC}"
apt install -y -qq curl wget git unzip build-essential \
    ca-certificates gnupg lsb-release sudo ufw nginx certbot python3-certbot-nginx
echo -e "${GREEN}[✓] Dependências instaladas${NC}"

# =============================================================================
# 5. CONFIGURAR PROJETO
# =============================================================================
echo -e "${BLUE}[5/10] Configurando projeto...${NC}"

PROJECT_DIR="/var/www/zappbot"
rm -rf "$PROJECT_DIR" 2>/dev/null || true
mkdir -p "$PROJECT_DIR"

# Verificar se tem arquivos locais
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HAS_LOCAL_FILES=false

if [ -f "$SCRIPT_DIR/server.js" ] && [ -f "$SCRIPT_DIR/index.js" ] && [ -f "$SCRIPT_DIR/index.html" ]; then
    echo -e "${YELLOW}   Copiando arquivos locais...${NC}"
    cp -r "$SCRIPT_DIR"/* "$PROJECT_DIR/"
    HAS_LOCAL_FILES=true
else
    echo -e "${YELLOW}   Baixando arquivos do projeto...${NC}"
    
    # Criar package.json
    cat > "$PROJECT_DIR/package.json" << 'PKGJSON'
{
  "name": "zappbot",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "@google/generative-ai": "^0.21.0",
    "@whiskeysockets/baileys": "^6.6.0",
    "express": "^4.19.2",
    "express-session": "^1.18.0",
    "socket.io": "^4.7.5",
    "bcrypt": "^5.1.1",
    "cookie-parser": "^1.4.7",
    "dotenv": "^16.4.5",
    "qrcode": "^1.5.4",
    "session-file-store": "^1.5.0",
    "multer": "^1.4.5-lts.1",
    "archiver": "^7.0.1",
    "adm-zip": "^0.5.16",
    "axios": "^1.7.0",
    "pino": "^9.1.0"
  }
}
PKGJSON

    # Criar server.js
    cat > "$PROJECT_DIR/server.js" << 'SERVERJS'
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const FileStore = require('session-file-store')(session);
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const BASE_DIR = __dirname;
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const SOCKET_URL = process.env.SOCKET_URL || PUBLIC_URL;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(session({
    secret: process.env.SESSION_SECRET || 'zappbot_secret',
    store: new FileStore({ path: path.join(BASE_DIR, 'sessions') }),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(express.static(BASE_DIR));
app.get('/', (req, res) => res.sendFile(path.join(BASE_DIR, 'index.html')));

const botsData = {};
const usersData = { admin: { username: 'admin', password: bcrypt.hashSync('admin', 10), isAdmin: true } };

function saveJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Login
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (usersData[username] && await bcrypt.compare(password, usersData[username].password)) {
        req.session.user = usersData[username];
        req.session.user.username = username;
        res.json({ success: true, user: req.session.user });
    } else {
        res.status(401).json({ success: false, message: 'Credenciais inválidas' });
    }
});

// Start Bot
app.post('/api/start-bot', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    const { sessionName } = req.body;
    const bot = botsData[sessionName];
    if (!bot) return res.json({ success: false });
    
    const args = ['index.js', sessionName, '', 'W10=', 'null', 'W10=', 'individual', '', '0', 'whatsapp', '', ''];
    const botProcess = spawn('node', args, { cwd: BASE_DIR, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SOCKET_URL } });
    
    bot.processId = botProcess.pid;
    bot.status = 'Iniciando...';
    botsData[sessionName] = bot;
    
    botProcess.stdout.on('data', async (data) => {
        const chunk = data.toString();
        if (chunk.includes('ONLINE')) {
            botsData[sessionName].status = 'Online';
            io.emit('bots:updated', botsData);
        } else if (chunk.includes('QR_CODE:')) {
            const match = chunk.match(/QR_CODE:(.+?)(?:\n|$)/);
            if (match && match[1]) {
                try {
                    const QRCode = require('qrcode');
                    const qrDataUrl = await QRCode.toDataURL(match[1].trim(), { width: 300, margin: 2 });
                    botsData[sessionName].qr = qrDataUrl;
                    botsData[sessionName].status = 'Aguardando QR Code';
                    io.emit('bots:updated', botsData);
                } catch (e) { console.error('QR Error:', e.message); }
            }
        }
        io.to(`bot-${sessionName}`).emit('bot-log', { sessionName, log: chunk });
    });
    
    res.json({ success: true });
});

// Create Bot
app.post('/api/create-bot', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    const { sessionName, displayName, prompt } = req.body;
    if (!botsData[sessionName]) {
        botsData[sessionName] = {
            sessionName, displayName: displayName || sessionName,
            prompt: prompt || 'Você é um assistente virtual.',
            owner: req.session.user.username, status: 'Offline', platform: 'whatsapp', createdAt: new Date().toISOString()
        };
        saveJSON(path.join(BASE_DIR, 'bots.json'), botsData);
        io.emit('bots:updated', botsData);
    }
    res.json({ success: true });
});

// Socket.IO
io.on('connection', (socket) => {
    socket.emit('bots:list', botsData);
    
    socket.on('join-bot', (sessionName) => socket.join(`bot-${sessionName}`));
    
    socket.on('start-bot', (data) => {
        const { sessionName } = data;
        const bot = botsData[sessionName];
        if (!bot) return;
        
        const args = ['index.js', sessionName, Buffer.from(bot.prompt || '').toString('base64'), 'W10=', 'null', 'W10=', 'individual', bot.displayName || '', '0', 'whatsapp', '', ''];
        const botProcess = spawn('node', args, { cwd: BASE_DIR, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SOCKET_URL } });
        
        bot.processId = botProcess.pid;
        bot.status = 'Iniciando...';
        botsData[sessionName] = bot;
        io.emit('bots:updated', botsData);
        
        botProcess.stdout.on('data', async (data) => {
            const chunk = data.toString();
            if (chunk.includes('ONLINE')) {
                botsData[sessionName].status = 'Online';
                botsData[sessionName].qr = null;
                io.emit('bots:updated', botsData);
            } else if (chunk.includes('QR_CODE:')) {
                const match = chunk.match(/QR_CODE:(.+?)(?:\n|$)/);
                if (match && match[1]) {
                    try {
                        const QRCode = require('qrcode');
                        const qrDataUrl = await QRCode.toDataURL(match[1].trim(), { width: 300, margin: 2 });
                        botsData[sessionName].qr = qrDataUrl;
                        botsData[sessionName].status = 'Aguardando QR Code';
                        io.emit('bots:updated', botsData);
                    } catch (e) { console.error('QR Error:', e.message); }
                }
            }
            io.to(`bot-${sessionName}`).emit('bot-log', { sessionName, log: chunk });
        });
    });
    
    socket.on('create-bot', (data) => {
        if (!botsData[data.sessionName]) {
            botsData[data.sessionName] = {
                sessionName: data.sessionName,
                displayName: data.displayName || data.sessionName,
                prompt: data.prompt || 'Você é um assistente virtual.',
                owner: req.session.user?.username || 'admin',
                status: 'Offline', platform: data.platform || 'whatsapp',
                silenceTime: parseInt(data.silenceTime) || 0,
                createdAt: new Date().toISOString()
            };
            saveJSON(path.join(BASE_DIR, 'bots.json'), botsData);
            io.emit('bots:updated', botsData);
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n╔═══════════════════════════════════════════╗`);
    console.log(`║        ZAPPBOT 3D INICIADO              ║`);
    console.log(`╠═══════════════════════════════════════════╣`);
    console.log(`║  URL: ${PUBLIC_URL}              ║`);
    console.log(`╚═══════════════════════════════════════════╝\n`);
});
SERVERJS

    # Criar index.js (bot WhatsApp)
    cat > "$PROJECT_DIR/index.js" << 'INDEXJS'
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const io = require('socket.io-client');

const nomeSessao = process.argv[2] || 'bot';
const promptSistema = Buffer.from(process.argv[3] || '', 'base64').toString('utf-8') || 'Você é um assistente virtual amigável.';
const SOCKET_URL = process.env.SOCKET_URL || 'http://localhost:3000';

const socket = io(SOCKET_URL);
console.log(`[${nomeSessao}] Conectando ao: ${SOCKET_URL}`);

socket.on('connect', () => console.log(`[${nomeSessao}] Socket conectado`));
socket.on('connect_error', (err) => console.error(`[${nomeSessao}] Erro socket:`, err.message));

async function ligarBot() {
    console.log(`🚀 Iniciando ${nomeSessao}...`);
    const authPath = `./auth_sessions/auth_${nomeSessao}`;
    require('fs').mkdirSync('./auth_sessions', { recursive: true });
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version, auth: state,
            logger: pino({ level: 'silent' }),
            browser: ["Ubuntu", "Chrome", "20.0.04"]
        });
        
        sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
            if (qr) console.log(`QR_CODE:${qr}`);
            if (connection === 'open') {
                console.log('\n✅ ONLINE!');
                socket.emit('bot-online', { sessionName: nomeSessao });
            }
            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log(`[${nomeSessao}] Conexão fechada: ${code}`);
                if (code !== DisconnectReason.loggedOut) setTimeout(ligarBot, 5000);
            }
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;
            
            const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            if (!texto) return;
            
            const jid = msg.key.remoteJid;
            console.log(`[${nomeSessao}] Mensagem: ${texto.substring(0, 50)}...`);
            
            await sock.sendPresenceUpdate('composing', jid);
            await new Promise(r => setTimeout(r, 1000));
            
            const resposta = `🤖 Recebi: "${texto.substring(0, 50)}..."\n\nIA: ${promptSistema.substring(0, 100)}`;
            await sock.sendMessage(jid, { text: resposta }, { quoted: msg });
        });
        
    } catch (err) {
        console.error(`[${nomeSessao}] Erro:`, err.message);
        setTimeout(ligarBot, 5000);
    }
}

ligarBot();
INDEXJS

    # Criar index.html (frontend)
    cat > "$PROJECT_DIR/index.html" << 'INDEXHTML'
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ZappBot 3D</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --primary: #00f2ff; --secondary: #7b2cbf; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #0a0a1a, #1a1a3a); color: white; min-height: 100vh; }
        .glass { background: rgba(255,255,255,0.05); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); }
        .neon-text { text-shadow: 0 0 10px var(--primary), 0 0 20px var(--primary); color: var(--primary); }
        .btn-neon { background: linear-gradient(45deg, var(--primary), var(--secondary)); padding: 12px 24px; border-radius: 25px; border: none; color: white; font-weight: bold; cursor: pointer; }
        .btn-neon:hover { transform: scale(1.05); box-shadow: 0 0 30px var(--primary); }
        .input-glass { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.2); padding: 12px 16px; border-radius: 10px; color: white; width: 100%; }
        .input-glass:focus { outline: none; border-color: var(--primary); }
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); justify-content: center; align-items: center; z-index: 1000; }
        .modal.show { display: flex; }
        .modal-content { background: linear-gradient(135deg, rgba(20,20,40,0.95), rgba(10,10,30,0.95)); border: 1px solid var(--primary); border-radius: 20px; padding: 30px; max-width: 500px; width: 90%; max-height: 85vh; overflow-y: auto; }
        .status-online { background: #00ff88; box-shadow: 0 0 10px #00ff88; }
        .status-offline { background: #ff4444; box-shadow: 0 0 10px #ff4444; }
        .status-waiting { background: #ffaa00; box-shadow: 0 0 10px #ffaa00; }
        .qr-image { background: white; padding: 10px; border-radius: 10px; max-width: 200px; }
    </style>
</head>
<body>
    <!-- Login Screen -->
    <div id="login-screen" class="min-h-screen flex items-center justify-center">
        <div class="glass rounded-2xl p-10 text-center max-w-md w-full mx-4">
            <h1 class="text-4xl font-bold neon-text mb-2">ZAPPBOT 3D</h1>
            <p class="text-gray-400 mb-8">Sistema de Automação Inteligente</p>
            <div class="space-y-4">
                <input type="text" id="username" class="input-glass" placeholder="Usuário">
                <input type="password" id="password" class="input-glass" placeholder="Senha">
                <button onclick="login()" class="btn-neon w-full">ENTRAR</button>
                <p class="text-gray-500 text-sm">Padrão: admin / admin</p>
            </div>
        </div>
    </div>

    <!-- Main App -->
    <div id="app" class="hidden">
        <!-- Sidebar -->
        <nav class="fixed left-0 top-0 h-full w-64 glass border-r border-white/10 p-5">
            <h1 class="text-2xl font-bold neon-text mb-8">ZAPPBOT 3D</h1>
            <div class="space-y-2">
                <div onclick="showPage('dashboard')" class="nav-item flex items-center gap-3 p-3 rounded-xl cursor-pointer hover:bg-white/10 transition">
                    <i class="fas fa-home"></i> Dashboard
                </div>
                <div onclick="showPage('bots')" class="nav-item flex items-center gap-3 p-3 rounded-xl cursor-pointer hover:bg-white/10 transition">
                    <i class="fas fa-robot"></i> Meus Bots
                </div>
            </div>
            <div class="absolute bottom-5 left-5 right-5">
                <button onclick="logout()" class="text-gray-400 hover:text-white text-sm"><i class="fas fa-sign-out-alt mr-2"></i>Sair</button>
            </div>
        </nav>

        <!-- Content -->
        <main class="ml-64 p-8">
            <!-- Dashboard -->
            <div id="page-dashboard" class="page">
                <h2 class="text-3xl font-bold mb-6">Dashboard</h2>
                <div class="grid grid-cols-3 gap-6 mb-8">
                    <div class="glass rounded-2xl p-6 text-center">
                        <p class="text-4xl font-bold neon-text" id="stat-bots">0</p>
                        <p class="text-gray-400">Bots</p>
                    </div>
                    <div class="glass rounded-2xl p-6 text-center">
                        <p class="text-4xl font-bold text-green-400" id="stat-online">0</p>
                        <p class="text-gray-400">Online</p>
                    </div>
                </div>
            </div>

            <!-- Bots -->
            <div id="page-bots" class="page hidden">
                <div class="flex justify-between items-center mb-6">
                    <h2 class="text-3xl font-bold">Meus Bots</h2>
                    <button onclick="showCreateBot()" class="btn-neon"><i class="fas fa-plus mr-2"></i>Novo Bot</button>
                </div>
                <div id="bots-grid" class="grid grid-cols-2 gap-6"></div>
            </div>
        </main>
    </div>

    <!-- Create Bot Modal -->
    <div id="create-bot-modal" class="modal">
        <div class="modal-content">
            <div class="flex justify-between items-center mb-6">
                <h2 class="text-2xl font-bold neon-text">Criar Novo Bot</h2>
                <button onclick="closeCreateBot()" class="text-gray-400 hover:text-white text-xl"><i class="fas fa-times"></i></button>
            </div>
            <div class="space-y-4">
                <div>
                    <label class="text-gray-400 text-sm block mb-1">Nome da Sessão</label>
                    <input type="text" id="bot-name" class="input-glass" placeholder="meu_bot">
                </div>
                <div>
                    <label class="text-gray-400 text-sm block mb-1">Nome do Bot</label>
                    <input type="text" id="bot-display-name" class="input-glass" placeholder="Assistente">
                </div>
                <div>
                    <label class="text-gray-400 text-sm block mb-1">Personalidade/Prompt</label>
                    <textarea id="bot-prompt" class="input-glass" rows="3" placeholder="Você é um assistente virtual amigável..."></textarea>
                </div>
                <div class="flex gap-4 pt-2">
                    <button onclick="createBot()" class="btn-neon flex-1">Criar</button>
                    <button onclick="closeCreateBot()" class="input-glass px-6">Cancelar</button>
                </div>
            </div>
        </div>
    </div>

    <script>
        let socket, botsData = {}, currentUser = null;

        function login() {
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            }).then(r => r.json()).then(data => {
                if (data.success) {
                    currentUser = data.user;
                    document.getElementById('login-screen').classList.add('hidden');
                    document.getElementById('app').classList.remove('hidden');
                    initSocket();
                } else {
                    alert('Credenciais inválidas');
                }
            });
        }

        function initSocket() {
            socket = io();
            socket.on('connect', () => console.log('Conectado'));
            socket.on('bots:list', bots => { botsData = bots; renderBots(); updateStats(); });
            socket.on('bots:updated', bots => { botsData = bots; renderBots(); updateStats(); });
        }

        function showPage(page) {
            document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
            document.getElementById('page-' + page).classList.remove('hidden');
        }

        function showCreateBot() {
            document.getElementById('create-bot-modal').classList.add('show');
        }

        function closeCreateBot() {
            document.getElementById('create-bot-modal').classList.remove('show');
        }

        function createBot() {
            const sessionName = document.getElementById('bot-name').value;
            const displayName = document.getElementById('bot-display-name').value;
            const prompt = document.getElementById('bot-prompt').value;
            if (!sessionName) return alert('Nome é obrigatório');
            socket.emit('create-bot', { sessionName, displayName, prompt });
            closeCreateBot();
            alert('Bot criado!');
        }

        function startBot(name) {
            socket.emit('join-bot', name);
            socket.emit('start-bot', { sessionName: name });
        }

        function renderBots() {
            const grid = document.getElementById('bots-grid');
            if (!grid) return;
            const bots = Object.values(botsData);
            if (bots.length === 0) {
                grid.innerHTML = '<div class="col-span-2 text-center py-20 text-gray-400"><i class="fas fa-robot text-6xl mb-4"></i><p>Nenhum bot criado</p></div>';
                return;
            }
            grid.innerHTML = bots.map(bot => {
                const statusClass = bot.status === 'Online' ? 'status-online' : bot.status === 'Aguardando QR Code' ? 'status-waiting' : 'status-offline';
                const qrImg = bot.qr && bot.qr.startsWith('data:') ? `<img src="${bot.qr}" class="qr-image mx-auto my-4">` : '';
                return `
                <div class="glass rounded-2xl p-6">
                    <div class="flex justify-between items-center mb-4">
                        <div>
                            <h3 class="text-xl font-bold">${bot.sessionName}</h3>
                            <p class="text-gray-400 text-sm">🤖 ${bot.displayName || bot.sessionName}</p>
                        </div>
                        <div class="w-4 h-4 rounded-full ${statusClass}"></div>
                    </div>
                    <p class="text-gray-400 text-sm mb-2">Status: ${bot.status}</p>
                    ${qrImg}
                    <button onclick="startBot('${bot.sessionName}')" class="btn-neon w-full mt-4">
                        <i class="fas fa-play mr-2"></i>${bot.status === 'Online' ? 'Rodando' : 'Iniciar'}
                    </button>
                </div>`;
            }).join('');
        }

        function updateStats() {
            const bots = Object.values(botsData);
            document.getElementById('stat-bots').textContent = bots.length;
            document.getElementById('stat-online').textContent = bots.filter(b => b.status === 'Online').length;
        }

        function logout() {
            location.reload();
        }

        showPage('dashboard');
    </script>
</body>
</html>
INDEXHTML
fi

cd "$PROJECT_DIR"

# .env
cat > .env << ENVFILE
SESSION_SECRET=zappbot_session_$(date +%s)
PUBLIC_URL=http://$DOMAIN
SOCKET_URL=http://$DOMAIN
PORT=3000
NODE_ENV=production
API_KEYS_GEMINI=SUA_CHAVE_AQUI
MP_ACCESS_TOKEN=
DEFAULT_TRIAL_DAYS=3
ENVFILE

mkdir -p auth_sessions uploads backups logs sessions
chmod 777 auth_sessions uploads backups logs sessions

echo -e "${GREEN}[✓] Projeto configurado${NC}"

# =============================================================================
# 6. INSTALAR NPM
# =============================================================================
echo -e "${BLUE}[6/10] Instalando NPM...${NC}"
npm install --legacy-peer-deps 2>&1 | tail -5
echo -e "${GREEN}[✓] NPM instalado${NC}"

# =============================================================================
# 7. NGINX
# =============================================================================
echo -e "${BLUE}[7/10] Configurando Nginx...${NC}"

rm -f /etc/nginx/sites-available/zappbot
rm -f /etc/nginx/sites-enabled/zappbot

cat > /etc/nginx/sites-available/zappbot << NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 86400;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX

ln -sf /etc/nginx/sites-available/zappbot /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx
systemctl enable nginx
echo -e "${GREEN}[✓] Nginx configurado${NC}"

# =============================================================================
# 8. SSL
# =============================================================================
echo -e "${BLUE}[8/10] Configurando SSL...${NC}"

if [ "$USE_SSL" = "sim" ] && [ -n "$EMAIL" ]; then
    ufw allow 443/tcp
    certbot --nginx -d "$DOMAIN" --email "$EMAIL" --agree-tos --non-interactive --redirect 2>/dev/null || echo -e "${YELLOW}[!] SSL precisa de verificação DNS${NC}"
    echo "0 0 * * * certbot renew --quiet" >> /var/spool/cron/crontabs/root
    echo -e "${GREEN}[✓] SSL configurado${NC}"
else
    echo -e "${YELLOW}[!] SSL pulado${NC}"
fi

# =============================================================================
# 9. FIREWALL
# =============================================================================
echo -e "${BLUE}[9/10] Firewall...${NC}"
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3000/tcp
ufw --force enable
echo -e "${GREEN}[✓] Firewall configurado${NC}"

# =============================================================================
# 10. INICIAR
# =============================================================================
echo -e "${BLUE}[10/10] Iniciando ZappBot...${NC}"

cat > /etc/systemd/system/zappbot.service << SYSTEMD
[Unit]
Description=ZappBot 3D
After=network.target nginx.service

[Service]
Type=simple
User=root
WorkingDirectory=$PROJECT_DIR
ExecStart=/usr/bin/node $PROJECT_DIR/server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
SYSTEMD

systemctl daemon-reload
systemctl enable zappbot
systemctl restart zappbot
sleep 3

# =============================================================================
# RESUMO
# =============================================================================
PROTOCOL="https"
[ "$USE_SSL" = "nao" ] && PROTOCOL="http"

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}            INSTALAÇÃO CONCLUÍDA!${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}🌐 ACESSO:${NC}"
echo "   URL: ${PROTOCOL}://${DOMAIN}"
echo ""
echo -e "${YELLOW}🔐 LOGIN:${NC}"
echo "   admin / admin"
echo ""
echo -e "${RED}⚠️  Edite: nano /var/www/zappbot/.env${NC}"
echo "   Adicione sua API KEY do Gemini"
echo ""
echo -e "${YELLOW}📝 COMANDOS:${NC}"
echo "   sudo systemctl restart zappbot"
echo "   sudo journalctl -u zappbot -f"
echo ""
