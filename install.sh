#!/bin/bash

# =============================================================================
# ZAPPBOT 3D - INSTALADOR COMPLETO E SIMPLES
# Execute: sudo bash install.sh
# =============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

clear
echo -e "${CYAN}"
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║           ZAPPBOT 3D - INSTALADOR                       ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}[✗] Execute como root: sudo bash install.sh${NC}"
    exit 1
fi

echo ""
echo -e "${YELLOW}Digite seu domínio (ex: bot.seusite.com) ou ENTER para IP:${NC}"
read DOMAIN
echo -e "${YELLOW}Digite seu email para SSL:${NC}"
read EMAIL

IP=$(hostname -I | awk '{print $1}')

if [ -z "$DOMAIN" ]; then
    DOMAIN="$IP"
    USE_SSL="nao"
else
    USE_SSL="sim"
fi

echo -e "${BLUE}Instalando...${NC}"
sleep 1

# 1. PARAR TUDO
echo -e "${BLUE}[1/8] Parando serviços...${NC}"
pkill -f "node" 2>/dev/null || true
systemctl stop zappbot 2>/dev/null || true
systemctl stop nginx 2>/dev/null || true
echo -e "${GREEN}[✓] Parado${NC}"

# 2. NODE.JS
echo -e "${BLUE}[2/8] Node.js...${NC}"
if ! command -v node &> /dev/null; then
    cd /tmp
    wget -q https://nodejs.org/dist/v14.21.3/node-v14.21.3-linux-x64.tar.xz
    tar -xJf node-v14.21.3-linux-x64.tar.xz
    cp -r node-v14.21.3-linux-x64/* /usr/local/
    ln -sf /usr/local/bin/node /usr/bin/node
    ln -sf /usr/local/bin/npm /usr/bin/npm
    rm -rf node-v14.21.3-linux-x64*
fi
echo -e "${GREEN}[✓] Node.js $(node -v)${NC}"

# 3. ATUALIZAR E DEPENDENCIAS
echo -e "${BLUE}[3/8] Dependências...${NC}"
export DEBIAN_FRONTEND=noninteractive
apt update -qq
apt install -y -qq curl wget git unzip build-essential ca-certificates gnupg lsb-release sudo ufw nginx certbot python3-certbot-nginx
echo -e "${GREEN}[✓] OK${NC}"

# 4. PROJETO
echo -e "${BLUE}[4/8] Projeto...${NC}"
PROJECT_DIR="/var/www/zappbot"
rm -rf "$PROJECT_DIR"
mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"

# package.json
cat > package.json << 'EOF'
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
    "pino": "^9.1.0"
  }
}
EOF

# server.js
cat > server.js << 'SERVEREOF'
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(session({
    secret: process.env.SESSION_SECRET || 'zappbot_secret_123',
    store: new FileStore({ path: path.join(BASE_DIR, 'sessions') }),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(express.static(BASE_DIR));

const usersData = {
    admin: { username: 'admin', password: bcrypt.hashSync('admin', 10), isAdmin: true }
};
const botsData = {};

function saveJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Login
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (usersData[username] && await bcrypt.compare(password, usersData[username].password)) {
        req.session.user = { ...usersData[username], username };
        res.json({ success: true, user: req.session.user });
    } else {
        res.status(401).json({ success: false, message: 'Inválido' });
    }
});

app.post('/api/create-bot', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    const { sessionName, displayName, prompt } = req.body;
    if (!botsData[sessionName]) {
        botsData[sessionName] = {
            sessionName,
            displayName: displayName || sessionName,
            prompt: prompt || 'Você é um assistente amigável.',
            owner: req.session.user.username,
            status: 'Offline',
            platform: 'whatsapp',
            createdAt: new Date().toISOString()
        };
        io.emit('bots:updated', botsData);
    }
    res.json({ success: true });
});

app.post('/api/start-bot', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    const { sessionName } = req.body;
    const bot = botsData[sessionName];
    if (!bot) return res.json({ success: false });
    
    const SOCKET_URL = process.env.SOCKET_URL || `http://localhost:${PORT}`;
    const args = [
        'index.js', sessionName,
        Buffer.from(bot.prompt || '').toString('base64'),
        'W10=', 'null', 'W10=',
        'individual', bot.displayName || '', '0', 'whatsapp', '', ''
    ];
    
    const botProcess = spawn('node', args, {
        cwd: BASE_DIR,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, SOCKET_URL }
    });
    
    bot.processId = botProcess.pid;
    bot.status = 'Iniciando...';
    botsData[sessionName] = bot;
    io.emit('bots:updated', botsData);
    
    botProcess.stdout.on('data', async (data) => {
        const chunk = data.toString();
        io.to(`bot-${sessionName}`).emit('bot-log', { sessionName, log: chunk });
        
        if (chunk.includes('ONLINE')) {
            botsData[sessionName].status = 'Online';
            botsData[sessionName].qr = null;
            io.emit('bots:updated', botsData);
        } else if (chunk.includes('QR_CODE:')) {
            const match = chunk.match(/QR_CODE:(.+?)(?:\n|$)/);
            if (match && match[1]) {
                try {
                    const QRCode = require('qrcode');
                    const qr = await QRCode.toDataURL(match[1].trim(), { width: 300, margin: 2 });
                    botsData[sessionName].qr = qr;
                    botsData[sessionName].status = 'Aguardando QR Code';
                    io.emit('bots:updated', botsData);
                } catch (e) { console.error('QR Error:', e.message); }
            }
        }
    });
    
    botProcess.on('error', (err) => console.error('Bot Error:', err.message));
    res.json({ success: true });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(BASE_DIR, 'index.html'));
});

io.on('connection', (socket) => {
    socket.emit('bots:list', botsData);
    socket.on('join-bot', (name) => socket.join(`bot-${name}`));
    socket.on('create-bot', (data) => {
        if (!botsData[data.sessionName]) {
            botsData[data.sessionName] = {
                sessionName: data.sessionName,
                displayName: data.displayName || data.sessionName,
                prompt: data.prompt || 'Você é um assistente.',
                owner: req.session?.user?.username || 'admin',
                status: 'Offline',
                platform: data.platform || 'whatsapp',
                silenceTime: parseInt(data.silenceTime) || 0,
                createdAt: new Date().toISOString()
            };
            io.emit('bots:updated', botsData);
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n╔═══════════════════════════════════╗`);
    console.log(`║     ZAPPBOT 3D INICIADO         ║`);
    console.log(`╠═══════════════════════════════════╣`);
    console.log(`║  URL: http://0.0.0.0:${PORT}       ║`);
    console.log(`╚═══════════════════════════════════╝\n`);
});
SERVEREOF

# index.js (bot)
cat > index.js << 'INDEXEOF'
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const io = require('socket.io-client');

const nomeSessao = process.argv[2] || 'bot';
const promptSistema = Buffer.from(process.argv[3] || '', 'base64').toString('utf-8') || 'Olá! Sou um assistente virtual.';
const SOCKET_URL = process.env.SOCKET_URL || 'http://localhost:3000';

console.log(`[${nomeSessao}] Iniciando...`);

const socket = io(SOCKET_URL, { reconnection: true, reconnectionAttempts: 10 });

socket.on('connect', () => console.log(`[${nomeSessao}] Socket conectado`));
socket.on('connect_error', (err) => console.error(`[${nomeSessao}] Erro socket:`, err.message));

async function ligarBot() {
    console.log(`🚀 ${nomeSessao} conectando...`);
    
    const fs = require('fs');
    const authDir = './auth_sessions';
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
    
    const authPath = `${authDir}/auth_${nomeSessao}`;
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            auth: state,
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
                console.log(`[${nomeSessao}] Desconectado: ${code}`);
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
            console.log(`[${nomeSessao}] Mensagem: ${texto.substring(0, 30)}...`);
            
            await sock.sendPresenceUpdate('composing', jid);
            await new Promise(r => setTimeout(r, 1000));
            
            const resposta = `Olá! Recebi sua mensagem: "${texto.substring(0, 50)}..."\n\nSou o assistente virtual. Como posso ajudar?`;
            await sock.sendMessage(jid, { text: resposta }, { quoted: msg });
        });
        
    } catch (err) {
        console.error(`[${nomeSessao}] Erro:`, err.message);
        setTimeout(ligarBot, 5000);
    }
}

ligarBot();
INDEXEOF

# index.html (frontend completo)
cat > index.html << 'HTMLEOF'
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
        .btn-neon { background: linear-gradient(45deg, var(--primary), var(--secondary)); padding: 12px 24px; border-radius: 25px; border: none; color: white; font-weight: bold; cursor: pointer; transition: all 0.3s; }
        .btn-neon:hover { transform: scale(1.05); box-shadow: 0 0 30px var(--primary); }
        .input-glass { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.2); padding: 12px 16px; border-radius: 10px; color: white; width: 100%; }
        .input-glass:focus { outline: none; border-color: var(--primary); }
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); justify-content: center; align-items: center; z-index: 1000; }
        .modal.show { display: flex; }
        .modal-content { background: linear-gradient(135deg, rgba(20,20,40,0.95), rgba(10,10,30,0.95)); border: 1px solid var(--primary); border-radius: 20px; padding: 30px; max-width: 500px; width: 90%; max-height: 85vh; overflow-y: auto; }
        .status-online { background: #00ff88; box-shadow: 0 0 10px #00ff88; }
        .status-offline { background: #ff4444; box-shadow: 0 0 10px #ff4444; }
        .status-waiting { background: #ffaa00; box-shadow: 0 0 10px #ffaa00; }
        .qr-img { background: white; padding: 10px; border-radius: 10px; }
    </style>
</head>
<body>
    <div id="login-screen" class="min-h-screen flex items-center justify-center">
        <div class="glass rounded-2xl p-10 text-center max-w-md w-full mx-4">
            <h1 class="text-5xl font-bold neon-text mb-4">ZAPPBOT 3D</h1>
            <p class="text-gray-400 mb-8">Sistema de Automação Inteligente</p>
            <div class="space-y-4">
                <input type="text" id="username" class="input-glass" placeholder="Usuário" value="admin">
                <input type="password" id="password" class="input-glass" placeholder="Senha" value="admin">
                <button onclick="login()" class="btn-neon w-full text-lg">ENTRAR</button>
            </div>
        </div>
    </div>

    <div id="app" class="hidden">
        <nav class="fixed left-0 top-0 h-full w-64 glass border-r border-white/10 p-5">
            <h1 class="text-2xl font-bold neon-text mb-8">ZAPPBOT</h1>
            <div class="space-y-2">
                <div onclick="showPage('dashboard')" class="p-3 rounded-xl cursor-pointer hover:bg-white/10 transition flex items-center gap-3">
                    <i class="fas fa-home"></i> Dashboard
                </div>
                <div onclick="showPage('bots')" class="p-3 rounded-xl cursor-pointer hover:bg-white/10 transition flex items-center gap-3">
                    <i class="fas fa-robot"></i> Meus Bots
                </div>
            </div>
            <div class="absolute bottom-5">
                <button onclick="location.reload()" class="text-gray-400 hover:text-white text-sm">
                    <i class="fas fa-sign-out-alt mr-2"></i>Sair
                </button>
            </div>
        </nav>

        <main class="ml-64 p-8">
            <div id="page-dashboard" class="page">
                <h2 class="text-3xl font-bold mb-6">Dashboard</h2>
                <div class="grid grid-cols-3 gap-6">
                    <div class="glass rounded-2xl p-6 text-center">
                        <p class="text-5xl font-bold neon-text" id="stat-bots">0</p>
                        <p class="text-gray-400 mt-2">Bots Criados</p>
                    </div>
                    <div class="glass rounded-2xl p-6 text-center">
                        <p class="text-5xl font-bold text-green-400" id="stat-online">0</p>
                        <p class="text-gray-400 mt-2">Online</p>
                    </div>
                </div>
            </div>

            <div id="page-bots" class="page hidden">
                <div class="flex justify-between items-center mb-6">
                    <h2 class="text-3xl font-bold">Meus Bots</h2>
                    <button onclick="showCreateBot()" class="btn-neon">
                        <i class="fas fa-plus mr-2"></i>Novo Bot
                    </button>
                </div>
                <div id="bots-grid" class="grid grid-cols-2 gap-6"></div>
            </div>
        </main>
    </div>

    <div id="create-bot-modal" class="modal">
        <div class="modal-content">
            <div class="flex justify-between items-center mb-6">
                <h2 class="text-2xl font-bold neon-text">Criar Novo Bot</h2>
                <button onclick="closeCreateBot()" class="text-gray-400 hover:text-white text-xl">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="space-y-4">
                <div>
                    <label class="text-gray-400 text-sm block mb-1">Nome da Sessão</label>
                    <input type="text" id="bot-name" class="input-glass" placeholder="meu_bot">
                </div>
                <div>
                    <label class="text-gray-400 text-sm block mb-1">Nome do Bot</label>
                    <input type="text" id="bot-display" class="input-glass" placeholder="Assistente">
                </div>
                <div>
                    <label class="text-gray-400 text-sm block mb-1">Personalidade/Prompt</label>
                    <textarea id="bot-prompt" class="input-glass" rows="3" placeholder="Você é um assistente amigável..."></textarea>
                </div>
                <div class="flex gap-4 pt-2">
                    <button onclick="createBot()" class="btn-neon flex-1">Criar</button>
                    <button onclick="closeCreateBot()" class="input-glass px-6">Cancelar</button>
                </div>
            </div>
        </div>
    </div>

    <script>
        let socket, botsData = {};

        function login() {
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            }).then(r => r.json()).then(data => {
                if (data.success) {
                    document.getElementById('login-screen').classList.add('hidden');
                    document.getElementById('app').classList.remove('hidden');
                    initSocket();
                } else {
                    alert('Credenciais inválidas!');
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
            const displayName = document.getElementById('bot-display').value;
            const prompt = document.getElementById('bot-prompt').value;
            if (!sessionName) return alert('Nome é obrigatório!');
            socket.emit('create-bot', { sessionName, displayName, prompt });
            closeCreateBot();
        }

        function startBot(name) {
            socket.emit('join-bot', name);
            fetch('/api/start-bot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionName: name })
            });
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
                const qrImg = bot.qr && bot.qr.startsWith('data:') ? `<img src="${bot.qr}" class="qr-img mx-auto my-4" width="200">` : '';
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
                    <p class="text-gray-500 text-xs mb-4 truncate">${bot.prompt || ''}</p>
                    ${qrImg}
                    <button onclick="startBot('${bot.sessionName}')" class="btn-neon w-full">
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

        showPage('dashboard');
    </script>
</body>
</html>
HTMLEOF

# .env
cat > .env << EOF
SESSION_SECRET=zappbot_session_$(date +%s)
PUBLIC_URL=http://$DOMAIN
SOCKET_URL=http://$DOMAIN
PORT=3000
NODE_ENV=production
API_KEYS_GEMINI=SUA_CHAVE_AQUI
EOF

mkdir -p auth_sessions uploads backups logs sessions
chmod 777 auth_sessions uploads backups logs sessions

echo -e "${GREEN}[✓] Arquivos criados${NC}"

# 5. NPM
echo -e "${BLUE}[5/8] Instalando NPM...${NC}"
npm install --legacy-peer-deps 2>&1 | tail -3
echo -e "${GREEN}[✓] NPM OK${NC}"

# 6. NGINX
echo -e "${BLUE}[6/8] Nginx...${NC}"
rm -f /etc/nginx/sites-available/zappbot
rm -f /etc/nginx/sites-enabled/zappbot

cat > /etc/nginx/sites-available/zappbot << NGINX
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
        proxy_read_timeout 86400;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/zappbot /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
echo -e "${GREEN}[✓] Nginx OK${NC}"

# 7. SSL
echo -e "${BLUE}[7/8] SSL...${NC}"
if [ "$USE_SSL" = "sim" ] && [ -n "$EMAIL" ]; then
    ufw allow 443/tcp
    certbot --nginx -d "$DOMAIN" --email "$EMAIL" --agree-tos --non-interactive --redirect 2>/dev/null || echo "SSL needs DNS"
    echo "0 0 * * * certbot renew --quiet" >> /var/spool/cron/crontabs/root
    echo -e "${GREEN}[✓] SSL OK${NC}"
else
    echo -e "${YELLOW}[!] SSL pulado${NC}"
fi

# 8. FIREWALL E INICIAR
echo -e "${BLUE}[8/8] Iniciando...${NC}"
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3000/tcp
ufw --force enable

cat > /etc/systemd/system/zappbot.service << SYSTEMD
[Unit]
Description=ZappBot 3D
After=network.target

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
sleep 2

# TESTE
echo -e "${BLUE}Testando conexão...${NC}"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 2>/dev/null || echo "000")
echo -e "${YELLOW}HTTP Code: $HTTP_CODE${NC}"

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}[✓] Servidor respondendo!${NC}"
else
    echo -e "${YELLOW}[!] Verificando logs...${NC}"
    journalctl -u zappbot -n 5 --no-pager 2>/dev/null || cat /var/www/zappbot/*.log 2>/dev/null
fi

# FIM
PROTOCOL="https"
[ "$USE_SSL" = "nao" ] && PROTOCOL="http"

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}            INSTALAÇÃO CONCLUÍDA!${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}🌐 ACESSO:${NC}"
echo "   ${PROTOCOL}://${DOMAIN}"
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
