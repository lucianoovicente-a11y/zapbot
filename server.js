// =============================================================================
// ZAPPBOT 3D - SERVIDOR COMPLETO COM SISTEMA DE REVENDEDORES
// =============================================================================

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

const { MercadoPagoConfig, Payment } = require('mercadopago');
const crypto = require('crypto');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const multer = require('multer');
require('dotenv').config();

const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const BASE_DIR = __dirname;
const BOTS_DB_PATH = path.join(BASE_DIR, 'bots.json');
const USERS_DB_PATH = path.join(BASE_DIR, 'users.json');
const SETTINGS_DB_PATH = path.join(BASE_DIR, 'settings.json');
const GROUPS_DB_PATH = path.join(BASE_DIR, 'groups.json');
const CAMPAIGNS_DB_PATH = path.join(BASE_DIR, 'campaigns.json');
const CLIENTS_DB_PATH = path.join(BASE_DIR, 'clients.json');
const PAYMENTS_DB_PATH = path.join(BASE_DIR, 'payments.json');
const RESELLERS_DB_PATH = path.join(BASE_DIR, 'resellers.json');
const CHECKIN_DB_PATH = path.join(BASE_DIR, 'checkin.json');

const AUTH_SESSIONS_DIR = path.join(BASE_DIR, 'auth_sessions');
const SESSION_FILES_DIR = path.join(BASE_DIR, 'sessions');
const BOT_SCRIPT_PATH = path.join(BASE_DIR, 'index.js');
const CHECKIN_LOG_PATH = path.join(BASE_DIR, 'logs', 'checkin.log');

const pendingPayments = {};

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('backups')) fs.mkdirSync('backups');

const upload = multer({ dest: 'uploads/' });

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ? process.env.GOOGLE_CLIENT_ID.trim() : null;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ? process.env.GOOGLE_CLIENT_SECRET.trim() : null;
const CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || "/auth/google/callback";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PUBLIC_URL = process.env.PUBLIC_URL || null;

// =============================================================================
// CONFIGURAÇÃO GEMINI (ROTAÇÃO DE CHAVES)
// =============================================================================
const API_KEYS_GEMINI = process.env.API_KEYS_GEMINI ? process.env.API_KEYS_GEMINI.split('\n').map(k => k.trim()).filter(Boolean) : [];
let currentApiKeyIndex = 0;
let genAI = API_KEYS_GEMINI.length > 0 ? new GoogleGenerativeAI(API_KEYS_GEMINI[currentApiKeyIndex]) : null;
let supportModel = genAI ? genAI.getGenerativeModel({ model: "gemini-flash-latest", safetySettings: [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
] }) : null;

function switchToNextApiKey() {
    if (API_KEYS_GEMINI.length <= 1) return;
    currentApiKeyIndex = (currentApiKeyIndex + 1) % API_KEYS_GEMINI.length;
    console.log(`[SERVER] 🔄 Trocando API Key para index: ${currentApiKeyIndex}`);
    genAI = new GoogleGenerativeAI(API_KEYS_GEMINI[currentApiKeyIndex]);
    supportModel = genAI.getGenerativeModel({ model: "gemini-flash-latest", safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ] });
}

// =============================================================================
// PROMPTS DO SISTEMA (GEMINI)
// =============================================================================
const SUPPORT_SYSTEM_PROMPT = `
Você é o Assistente Inteligente do ZappBot 3D - Painel Futurista de Automação WhatsApp/Telegram.
Sua função é ajudar usuários e revendedores a configurar seus robôs, gerenciar clientes e campanhas de marketing.
Seja curto, direto, educado e use emojis quando apropriado.

FUNCIONALIDADES DO SISTEMA:
1. **Criação de Bots**: atendimento privado ou grupos
2. **Clientes e Campanhas**: CRM completo com envio de mensagens, Pix, cobranças
3. **Revenda**: Revendedores podem criar clientes e bots ilimitados
4. **Dashboard 3D**: Visualização futurista em tempo real

ATALHOS DE AÇÃO:
[ACTION:OPEN_CREATE] -> Criar novo bot
[ACTION:OPEN_RESELL] -> Área de revenda
[ACTION:OPEN_CLIENTS] -> Gerenciar clientes
[ACTION:OPEN_STATS] -> Ver estatísticas
[ACTION:OPEN_SETTINGS] -> Configurações
`;

const RESELLER_SYSTEM_PROMPT = `
Você é o assistente virtual de um Revendedor ZappBot. Seu papel é ajudar seus clientes a configurar e usar os bots de automação.
Sempre seja profissional, rápido e eficiente. Use o nome do revendedor quando mencionado.
`;

const CLIENT_SYSTEM_PROMPT = `
Você é o assistente do ZappBot, criado pelo seu revendedor. Seu objetivo é ajudar com dúvidas sobre如何使用 os bots de WhatsApp/Telegram.
Responda em portuguêsBR, seja claro e objetivo.
`;

// =============================================================================
// VERIFICAÇÃO E CRIAÇÃO DE ARQUIVOS BASE
// =============================================================================
function loadJSON(filePath, defaultData = {}) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(data);
        }
    } catch (e) { console.error(`Erro ao carregar ${filePath}:`, e.message); }
    return defaultData;
}

function saveJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

let botsData = loadJSON(BOTS_DB_PATH, {});
let usersData = loadJSON(USERS_DB_PATH, {});
let settingsData = loadJSON(SETTINGS_DB_PATH, {
    appName: 'ZappBot 3D', priceMonthly: 30, priceQuarterly: 80, 
    priceSemiannual: 150, priceYearly: 250,
    priceResell5: 100, priceResell10: 180, priceResell20: 300, priceResell30: 400,
    publicPrices: {}
});
settingsData.publicPrices = {
    priceMonthly: settingsData.priceMonthly,
    priceQuarterly: settingsData.priceQuarterly,
    priceSemiannual: settingsData.priceSemiannual,
    priceYearly: settingsData.priceYearly,
    priceResell5: settingsData.priceResell5,
    priceResell10: settingsData.priceResell10,
    priceResell20: settingsData.priceResell20,
    priceResell30: settingsData.priceResell30
};

let groupsData = loadJSON(GROUPS_DB_PATH, {});
let campaignsData = loadJSON(CAMPAIGNS_DB_PATH, []);
let clientsData = loadJSON(CLIENTS_DB_PATH, []);
let paymentsData = loadJSON(PAYMENTS_DB_PATH, []);
let resellersData = loadJSON(RESELLERS_DB_PATH, {});
let checkinData = loadJSON(CHECKIN_DB_PATH, {});

// ==========================================
// CRIAR USUÁRIO ADMIN PADRÃO
// ==========================================
const DEFAULT_ADMIN_USER = 'admin';
const DEFAULT_ADMIN_PASS = 'admin';

function createDefaultAdmin() {
    if (!usersData[DEFAULT_ADMIN_USER]) {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // 1 ano
        
        usersData[DEFAULT_ADMIN_USER] = {
            username: DEFAULT_ADMIN_USER,
            password: hash(DEFAULT_ADMIN_PASS),
            isAdmin: true,
            role: 'admin',
            botLimit: 999,
            createdAt: now.toISOString(),
            expiresAt: expiresAt.toISOString(),
            bots: [],
            parentReseller: null,
            trialDays: 365,
            isActive: true
        };
        
        console.log(`[ADMIN] Usuario admin criado (admin/admin)`);
        saveJSON(USERS_DB_PATH, usersData);
        
        // Log do check-in
        logCheckin('SYSTEM', 'Admin criado automaticamente');
    } else {
        // Verificar se o admin tem os campos necessários
        if (!usersData[DEFAULT_ADMIN_USER].expiresAt) {
            const now = new Date();
            usersData[DEFAULT_ADMIN_USER].expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
            saveJSON(USERS_DB_PATH, usersData);
        }
    }
}

function logCheckin(username, action) {
    const now = new Date();
    const logEntry = `[${now.toISOString()}] ${username}: ${action}\n`;
    
    // Salvar no log de check-in
    if (!fs.existsSync('logs')) fs.mkdirSync('logs');
    fs.appendFileSync(CHECKIN_LOG_PATH, logEntry);
    
    // Salvar no array de check-ins
    if (!checkinData[username]) checkinData[username] = [];
    checkinData[username].push({
        timestamp: now.toISOString(),
        action: action
    });
    
    // Manter apenas últimos 100 check-ins por usuário
    if (checkinData[username].length > 100) {
        checkinData[username] = checkinData[username].slice(-100);
    }
    
    saveJSON(CHECKIN_DB_PATH, checkinData);
}

createDefaultAdmin();

setInterval(() => {
    saveJSON(BOTS_DB_PATH, botsData);
    saveJSON(USERS_DB_PATH, usersData);
    saveJSON(SETTINGS_DB_PATH, settingsData);
    saveJSON(GROUPS_DB_PATH, groupsData);
    saveJSON(CAMPAIGNS_DB_PATH, campaignsData);
    saveJSON(CLIENTS_DB_PATH, clientsData);
    saveJSON(PAYMENTS_DB_PATH, paymentsData);
    saveJSON(RESELLERS_DB_PATH, resellersData);
    saveJSON(CHECKIN_DB_PATH, checkinData);
}, 30000);

function authUser(username, password) {
    if (usersData[username]) {
        if (usersData[username].password === hash(password)) return usersData[username];
    }
    return null;
}

function hash(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function ensureDirectory(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDirectory(AUTH_SESSIONS_DIR);
ensureDirectory(SESSION_FILES_DIR);

// =============================================================================
// MIDDLEWARES
// =============================================================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(BASE_DIR)));

const sessionMiddleware = session({
    store: new FileStore({ path: SESSION_FILES_DIR }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
});
app.use(sessionMiddleware);

const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);
io.use(wrap(sessionMiddleware));

// ==========================================
// ROTAS DE AUTENTICAÇÃO
// ==========================================
app.get('/login', (req, res) => {
    res.sendFile(path.join(BASE_DIR, 'index.html'));
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = authUser(username, password);
    
    if (user) {
        // Verificar se a conta ainda é válida
        if (user.expiresAt && new Date(user.expiresAt) < new Date()) {
            return res.json({ success: false, message: 'Sua assinatura expirou. Entre em contato com o administrador.' });
        }
        
        req.session.user = user;
        logCheckin(username, 'Login');
        res.json({ success: true, user });
    } else {
        res.json({ success: false, message: 'Usuário ou senha inválidos' });
    }
});

app.get('/logout', (req, res) => {
    if (req.session.user) {
        logCheckin(req.session.user.username, 'Logout');
    }
    req.session.destroy();
    res.redirect('/');
});

// Check-in
app.get('/api/checkin', (req, res) => {
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    res.json(checkinData);
});

app.post('/api/checkin', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Não autenticado' });
    }
    const { action } = req.body;
    logCheckin(req.session.user.username, action || 'Ação não especificada');
    res.json({ success: true });
});

// Admin: Reset senha de usuário
app.post('/api/user/change-credentials-admin', (req, res) => {
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    
    const { username, newPassword } = req.body;
    if (!usersData[username]) {
        return res.json({ success: false, message: 'Usuário não encontrado' });
    }
    
    usersData[username].password = hash(newPassword);
    saveJSON(USERS_DB_PATH, usersData);
    logCheckin(req.session.user.username, `Resetou senha de ${username}`);
    
    res.json({ success: true });
});

// =============================================================================
// ROTAS PRINCIPAIS
// =============================================================================

app.get('/', (req, res) => {
    res.sendFile(path.join(BASE_DIR, 'index.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(BASE_DIR, 'index.html'));
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = authUser(username, password);
    if (user) {
        req.session.user = user;
        res.json({ success: true, user });
    } else {
        res.json({ success: false, message: 'Usuário ou senha inválidos' });
    }
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/api/user', (req, res) => {
    if (req.session.user) res.json(req.session.user);
    else res.status(401).json({ error: 'Não autenticado' });
});

// =============================================================================
// API DE REGISTRO (AUTO-REGISTRO)
// =============================================================================
app.post('/api/register', async (req, res) => {
    const { username, password, referrer, role } = req.body;
    
    if (!username || !password) {
        return res.json({ success: false, message: 'Preencha todos os campos' });
    }
    
    if (username.length < 3) {
        return res.json({ success: false, message: 'Nome de usuário deve ter no mínimo 3 caracteres' });
    }
    
    if (password.length < 4) {
        return res.json({ success: false, message: 'Senha deve ter no mínimo 4 caracteres' });
    }
    
    if (usersData[username]) {
        return res.json({ success: false, message: 'Usuário já existe' });
    }
    
    const isFirstUser = Object.keys(usersData).length === 0;
    
    // Verificar referenciador
    let botLimit = role === 'reseller' ? 50 : 1;
    let parentReseller = null;
    
    if (referrer && usersData[referrer]) {
        const referrerUser = usersData[referrer];
        if (referrerUser.role === 'reseller' || referrerUser.isAdmin) {
            parentReseller = referrer;
            botLimit = referrerUser.botLimit || (role === 'reseller' ? 50 : 1);
            
            // Atualizar stats do reseller
            if (!resellersData[referrer]) resellersData[referrer] = { clients: [], totalRevenue: 0 };
            resellersData[referrer].clients.push(username);
        }
    }
    
    // Primeiro usuário é sempre admin
    const userRole = isFirstUser ? 'admin' : role;
    
    usersData[username] = {
        username,
        password: hash(password),
        isAdmin: isFirstUser,
        role: userRole,
        botLimit: isFirstUser ? 999 : botLimit,
        createdAt: new Date().toISOString(),
        expiresAt: isFirstUser ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() : null,
        bots: [],
        parentReseller,
        trialDays: 0,
        isActive: isFirstUser
    };
    
    saveJSON(USERS_DB_PATH, usersData);
    logCheckin(username, `Registro como ${userRole}`);
    
    res.json({ success: true, message: 'Conta criada com sucesso!' });
});

// API ATIVAR PLANO
app.post('/api/user/activate-plan', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ success: false, message: 'Não autenticado' });
    }
    
    const { planType, days } = req.body;
    const username = req.session.user.username;
    
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    
    // Definir limite de bots baseado no plano
    let botLimit = 1;
    if (planType === 'monthly') botLimit = 5;
    if (planType === 'yearly') botLimit = 10;
    
    usersData[username].expiresAt = expiresAt;
    usersData[username].trialDays = days;
    usersData[username].isActive = true;
    usersData[username].botLimit = botLimit;
    usersData[username].planType = planType;
    
    req.session.user = usersData[username];
    
    saveJSON(USERS_DB_PATH, usersData);
    logCheckin(username, `Ativou plano ${planType} (${days} dias)`);
    
    res.json({ success: true, expiresAt });
});

// =============================================================================
// API ADMIN - GERENCIAR USUÁRIOS E REVENDEDORES
// =============================================================================
app.get('/api/admin/users', (req, res) => {
    if (!req.session.user || (!req.session.user.isAdmin && req.session.user.role !== 'reseller')) {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    
    const currentUser = req.session.user;
    let users = Object.values(usersData);
    
    // Revendedores veem apenas seus clientes
    if (currentUser.role === 'reseller') {
        users = users.filter(u => u.parentReseller === currentUser.username);
    }
    
    res.json(users);
});

app.post('/api/admin/create-reseller', (req, res) => {
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    
    const { username, password, botLimit } = req.body;
    
    if (usersData[username]) {
        return res.json({ success: false, message: 'Usuário já existe' });
    }
    
    usersData[username] = {
        username,
        password: hash(password),
        isAdmin: false,
        role: 'reseller',
        botLimit: botLimit || 50,
        createdAt: new Date().toISOString(),
        bots: [],
        parentReseller: 'admin'
    };
    
    resellersData[username] = { clients: [], totalRevenue: 0 };
    res.json({ success: true, message: 'Revendedor criado!' });
});

app.post('/api/admin/update-user', (req, res) => {
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    
    const { username, botLimit, role } = req.body;
    if (usersData[username]) {
        if (botLimit !== undefined) usersData[username].botLimit = botLimit;
        if (role) usersData[username].role = role;
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'Usuário não encontrado' });
    }
});

app.post('/api/admin/delete-user', (req, res) => {
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    
    const { username } = req.body;
    if (username === req.session.user.username) {
        return res.json({ success: false, message: 'Não pode excluir a si mesmo' });
    }
    
    // Deletar bots do usuário
    Object.keys(botsData).forEach(botKey => {
        if (botsData[botKey].owner === username) {
            stopBotProcess(botKey);
            delete botsData[botKey];
        }
    });
    
    // Remover da lista de clientes do reseller
    if (usersData[username]?.parentReseller && resellersData[usersData[username].parentReseller]) {
        resellersData[usersData[username].parentReseller].clients = 
            resellersData[usersData[username].parentReseller].clients.filter(c => c !== username);
    }
    
    delete usersData[username];
    res.json({ success: true });
});

app.post('/api/admin/set-user-days', (req, res) => {
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    
    const { username, days } = req.body;
    if (usersData[username]) {
        const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
        usersData[username].trialExpiresAt = expiresAt;
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

// =============================================================================
// API - BOTS
// =============================================================================
app.get('/api/bots', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    
    const user = req.session.user;
    let bots = {};
    
    Object.keys(botsData).forEach(key => {
        const bot = botsData[key];
        if (user.isAdmin || bot.owner === user.username || 
            (user.role === 'reseller' && usersData[bot.owner]?.parentReseller === user.username)) {
            bots[key] = bot;
        }
    });
    
    res.json(bots);
});

app.post('/api/create-bot', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    
    const { sessionName, prompt, owner, botType, platform, token } = req.body;
    const user = req.session.user;
    
    // Verificar limite
    const userBots = Object.values(botsData).filter(b => b.owner === (owner || user.username)).length;
    const limit = usersData[owner || user.username]?.botLimit || user.botLimit || 5;
    
    if (userBots >= limit && !user.isAdmin) {
        return res.json({ success: false, message: `Limite de bots atingido (${limit})` });
    }
    
    if (botsData[sessionName]) {
        return res.json({ success: false, message: 'Bot já existe' });
    }
    
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    
    botsData[sessionName] = {
        sessionName,
        prompt: prompt || '',
        owner: owner || user.username,
        botType: botType || 'individual',
        platform: platform || 'whatsapp',
        token: token || '',
        status: 'Offline',
        createdAt: now.toISOString(),
        trialExpiresAt: expiresAt.toISOString(),
        isTrial: true,
        activated: false,
        ignoredIdentifiers: [],
        silenceTime: 0,
        notificationNumber: ''
    };
    
    res.json({ success: true });
});

app.post('/api/start-bot', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    
    const { sessionName, phoneNumber } = req.body;
    const bot = botsData[sessionName];
    
    if (!bot) return res.json({ success: false, message: 'Bot não encontrado' });
    
    const ignoredJson = JSON.stringify(bot.ignoredIdentifiers || []);
    const promptBase64 = Buffer.from(bot.prompt || '').toString('base64');
    const groupsJson = JSON.stringify([]);
    
    const args = [
        BOT_SCRIPT_PATH,
        sessionName,
        promptBase64,
        Buffer.from(ignoredJson).toString('base64'),
        phoneNumber || 'null',
        groupsJson,
        bot.botType || 'individual',
        '',
        bot.silenceTime?.toString() || '0',
        bot.platform || 'whatsapp',
        bot.token || '',
        bot.notificationNumber || ''
    ];
    
    const botProcess = spawn('node', args, {
        cwd: BASE_DIR,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    
    bot.processId = botProcess.pid;
    bot.status = 'Iniciando...';
    bot.activated = true;
    
    botProcess.stdout.on('data', (data) => {
        const output = data.toString();
        if (output.includes('ONLINE')) {
            botsData[sessionName].status = 'Online';
        } else if (output.includes('QR_CODE:')) {
            botsData[sessionName].status = 'Aguardando QR Code';
            botsData[sessionName].qr = output.split('QR_CODE:')[1].trim();
        } else if (output.includes('PAIRING_CODE:')) {
            botsData[sessionName].status = 'Aguardando QR Code';
            botsData[sessionName].qr = 'PAIRING_CODE:' + output.split('PAIRING_CODE:')[1].trim();
        }
        
        io.to(`bot-${sessionName}`).emit('bot-log', { sessionName, log: output });
    });
    
    botProcess.stderr.on('data', (data) => {
        io.to(`bot-${sessionName}`).emit('bot-log', { sessionName, log: '[ERRO] ' + data.toString() });
    });
    
    botProcess.on('close', (code) => {
        botsData[sessionName].status = 'Offline';
        botsData[sessionName].processId = null;
    });
    
    res.json({ success: true });
});

app.post('/api/stop-bot', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    
    const { sessionName } = req.body;
    const bot = botsData[sessionName];
    
    if (bot && bot.processId) {
        try {
            process.kill(-bot.processId);
            process.kill(bot.processId);
        } catch (e) { console.error('Erro ao parar bot:', e); }
    }
    
    botsData[sessionName].status = 'Offline';
    res.json({ success: true });
});

app.post('/api/delete-bot', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    
    const { sessionName } = req.body;
    if (botsData[sessionName]) {
        stopBotProcess(sessionName);
        delete botsData[sessionName];
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

function stopBotProcess(sessionName) {
    const bot = botsData[sessionName];
    if (bot && bot.processId) {
        try {
            process.kill(-bot.processId);
            process.kill(bot.processId);
        } catch (e) {}
    }
}

app.post('/api/update-bot', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    
    const { sessionName, newPrompt, botType, botName, silenceTime, notificationNumber } = req.body;
    
    if (botsData[sessionName]) {
        if (newPrompt !== undefined) botsData[sessionName].prompt = newPrompt;
        if (botType !== undefined) botsData[sessionName].botType = botType;
        if (botName !== undefined) botsData[sessionName].botName = botName;
        if (silenceTime !== undefined) botsData[sessionName].silenceTime = silenceTime;
        if (notificationNumber !== undefined) botsData[sessionName].notificationNumber = notificationNumber;
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

// =============================================================================
// API - GRUPOS (BOT TIPO GRUPO)
// =============================================================================
app.get('/api/groups', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    
    const user = req.session.user;
    let groups = {};
    
    Object.keys(groupsData).forEach(key => {
        const group = groupsData[key];
        if (user.isAdmin || group.owner === user.username) {
            groups[key] = group;
        }
    });
    
    res.json(groups);
});

app.post('/api/generate-activation-link', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    
    const { botSessionName } = req.body;
    const token = crypto.randomBytes(16).toString('hex');
    const activationLink = `${PUBLIC_URL || 'http://localhost:3000'}/ativar?token=${token}`;
    
    if (!settingsData.activationLinks) settingsData.activationLinks = {};
    settingsData.activationLinks[token] = {
        botSessionName,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    };
    
    res.json({ activationLink });
});

app.get('/ativar', (req, res) => {
    const { token } = req.query;
    const linkData = settingsData.activationLinks?.[token];
    
    if (!linkData || new Date(linkData.expiresAt) < new Date()) {
        return res.send('Link expirado ou inválido');
    }
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Ativar Grupo</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="bg-gradient-to-br from-purple-900 to-blue-900 min-h-screen flex items-center justify-center">
            <div class="bg-white/10 backdrop-blur-lg rounded-2xl p-8 text-center">
                <h1 class="text-3xl font-bold text-white mb-4">🤖 Ativar Grupo</h1>
                <p class="text-white/80 mb-6">Nome do Bot: ${linkData.botSessionName}</p>
                <div class="bg-white/20 rounded-lg p-4 mb-4">
                    <code class="text-white text-lg">/ativar?token=${token}</code>
                </div>
                <p class="text-white/60 text-sm">Copie este link e envie no grupo que deseja ativar</p>
            </div>
        </body>
        </html>
    `);
});

app.post('/api/group-activation-request', (req, res) => {
    const { groupId, groupName, activationToken, botSessionName } = req.body;
    
    const linkData = settingsData.activationLinks?.[activationToken];
    if (!linkData || linkData.botSessionName !== botSessionName) {
        return res.json({ success: false, message: 'Token inválido' });
    }
    
    const groupKey = `${botSessionName}_${groupId}`;
    if (groupsData[groupKey]) {
        return res.json({ success: false, message: 'Grupo já ativado' });
    }
    
    groupsData[groupKey] = {
        groupId,
        groupName,
        botSessionName,
        owner: botsData[botSessionName]?.owner || 'unknown',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        status: 'active',
        isPaused: false,
        prompt: '',
        silenceTime: 0,
        botName: '',
        antiLink: false,
        welcomeEnabled: false,
        welcomeMessage: '👋 Olá @user! Bem-vindo(a) ao grupo!'
    };
    
    res.json({ success: true, expiresAt: groupsData[groupKey].expiresAt });
});

app.post('/api/update-group-settings', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    
    const { groupId, settings } = req.body;
    
    if (groupsData[groupId]) {
        groupsData[groupId] = { ...groupsData[groupId], ...settings };
        
        io.emit('group-settings-changed', { 
            groupId, 
            botSessionName: groupsData[groupId].botSessionName,
            settings 
        });
        
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

app.post('/api/delete-group', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    
    const { groupId } = req.body;
    if (groupsData[groupId]) {
        const botSessionName = groupsData[groupId].botSessionName;
        delete groupsData[groupId];
        io.emit('group-removed', { groupId, botSessionName });
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

// =============================================================================
// API - CLIENTES E CAMPANHAS (GERENCIADOR CRM)
// =============================================================================
app.get('/api/clients', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    res.json(clientsData);
});

app.post('/api/clients', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    
    const { clients } = req.body;
    const owner = req.session.user.username;
    
    clients.forEach(client => {
        const existing = clientsData.find(c => c.phone === client.phone && c.owner === owner);
        if (!existing) {
            clientsData.push({ ...client, id: Date.now() + Math.random(), owner, createdAt: new Date().toISOString() });
        }
    });
    
    res.json({ success: true, message: `${clients.length} cliente(s) adicionado(s)` });
});

app.get('/api/campaigns', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    res.json(campaignsData);
});

app.post('/api/campaigns', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    
    const campaign = req.body;
    campaign.id = Date.now();
    campaign.createdAt = new Date().toISOString();
    campaign.status = 'pending';
    campaign.owner = req.session.user.username;
    
    campaignsData.push(campaign);
    res.json({ success: true, id: campaign.id });
});

app.get('/api/payments', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    res.json(paymentsData);
});

// =============================================================================
// API - GERENCIAMENTO DE USUÁRIOS (ADMIN)
// =============================================================================

// Trocar nome de usuário ou senha
app.post('/api/user/change-credentials', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    
    const { currentPassword, newUsername, newPassword } = req.body;
    const user = req.session.user;
    
    // Verificar senha atual
    if (user.password !== hash(currentPassword)) {
        return res.json({ success: false, message: 'Senha atual incorreta' });
    }
    
    // Trocar nome de usuário
    if (newUsername && newUsername !== user.username) {
        if (usersData[newUsername]) {
            return res.json({ success: false, message: 'Nome de usuário já existe' });
        }
        
        // Atualizar dados
        const userData = usersData[user.username];
        delete usersData[user.username];
        userData.username = newUsername;
        usersData[newUsername] = userData;
        user.username = newUsername;
        req.session.user = user;
        
        logCheckin(newUsername, 'Alterou nome de usuario');
    }
    
    // Trocar senha
    if (newPassword) {
        usersData[user.username].password = hash(newPassword);
        req.session.user.password = hash(newPassword);
        logCheckin(user.username, 'Alterou senha');
    }
    
    saveJSON(USERS_DB_PATH, usersData);
    res.json({ success: true, message: 'Credenciais atualizadas!' });
});

// Admin: Definir tempo contratado de um usuário
app.post('/api/admin/set-user-expiry', (req, res) => {
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    
    const { username, days } = req.body;
    if (!usersData[username]) {
        return res.json({ success: false, message: 'Usuário não encontrado' });
    }
    
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    usersData[username].expiresAt = expiresAt;
    usersData[username].trialDays = days;
    usersData[username].isActive = days > 0;
    
    saveJSON(USERS_DB_PATH, usersData);
    logCheckin(req.session.user.username, `Definiu ${days} dias para ${username}`);
    
    res.json({ success: true, expiresAt });
});

// Admin: Ver todos os usuários com detalhes
app.get('/api/admin/users-detail', (req, res) => {
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    
    const usersList = Object.values(usersData).map(u => ({
        username: u.username,
        role: u.role,
        isAdmin: u.isAdmin,
        botLimit: u.botLimit,
        createdAt: u.createdAt,
        expiresAt: u.expiresAt,
        isActive: u.isActive,
        trialDays: u.trialDays || 0,
        botsCount: Object.values(botsData).filter(b => b.owner === u.username).length,
        checkins: (checkinData[u.username] || []).slice(-10)
    }));
    
    res.json(usersList);
});

// Admin: Atualizar limite de bots de um usuário
app.post('/api/admin/set-user-botlimit', (req, res) => {
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    
    const { username, botLimit } = req.body;
    if (!usersData[username]) {
        return res.json({ success: false, message: 'Usuário não encontrado' });
    }
    
    usersData[username].botLimit = parseInt(botLimit);
    saveJSON(USERS_DB_PATH, usersData);
    logCheckin(req.session.user.username, `Alterou limite de bots de ${username} para ${botLimit}`);
    
    res.json({ success: true });
});

// Admin: Alterar role de um usuário
app.post('/api/admin/set-user-role', (req, res) => {
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    
    const { username, role } = req.body;
    if (!usersData[username]) {
        return res.json({ success: false, message: 'Usuário não encontrado' });
    }
    
    usersData[username].role = role;
    usersData[username].isAdmin = role === 'admin';
    saveJSON(USERS_DB_PATH, usersData);
    logCheckin(req.session.user.username, `Alterou role de ${username} para ${role}`);
    
    res.json({ success: true });
});

// Admin: Logs de Check-in
app.get('/api/admin/checkin-logs', (req, res) => {
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    
    const logs = [];
    Object.keys(checkinData).forEach(username => {
        checkinData[username].forEach(entry => {
            logs.push({
                username,
                ...entry
            });
        });
    });
    
    // Ordenar por timestamp (mais recente primeiro)
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    res.json(logs.slice(0, 500)); // Últimos 500
});

// =============================================================================
// API - CONFIGURAÇÕES
// =============================================================================
app.get('/api/settings', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Não autenticado' });
    
    const publicSettings = { 
        appName: settingsData.appName,
        publicPrices: settingsData.publicPrices,
        googleAuthEnabled: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)
    };
    res.json(publicSettings);
});

app.post('/api/save-settings', (req, res) => {
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    
    settingsData = { ...settingsData, ...req.body };
    settingsData.publicPrices = {
        priceMonthly: settingsData.priceMonthly,
        priceQuarterly: settingsData.priceQuarterly,
        priceSemiannual: settingsData.priceSemiannual,
        priceYearly: settingsData.priceYearly,
        priceResell5: settingsData.priceResell5,
        priceResell10: settingsData.priceResell10,
        priceResell20: settingsData.priceResell20,
        priceResell30: settingsData.priceResell30
    };
    
    res.json({ success: true });
});

app.get('/api/admin/settings', (req, res) => {
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    res.json(settingsData);
});

app.post('/api/admin/upload-icons', upload.single('icon'), (req, res) => {
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    
    if (!req.file) {
        return res.json({ success: false, message: 'Nenhum arquivo enviado' });
    }
    
    const ext = path.extname(req.file.originalname);
    const dest = path.join(BASE_DIR, req.file.fieldname === 'icon512' ? 'icon-512x512.png' : 'icon-192x192.png');
    fs.renameSync(req.file.path, dest);
    
    res.json({ success: true, message: 'Ícone atualizado!' });
});

app.post('/api/admin/save-settings-full', upload.fields([{ name: 'icon512', maxCount: 1 }, { name: 'icon192', maxCount: 1 }]), (req, res) => {
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    
    try {
        const body = req.body;
        
        settingsData.appName = body.appName || settingsData.appName;
        settingsData.publicUrl = body.publicUrl;
        settingsData.contactEmail = body.contactEmail;
        settingsData.supportWhatsapp = body.supportWhatsapp;
        settingsData.colorPrimary = body.colorPrimary;
        settingsData.colorSecondary = body.colorSecondary;
        settingsData.colorBg = body.colorBg;
        settingsData.planFreeDays = parseInt(body.planFreeDays) || 1;
        settingsData.priceMonthly = parseFloat(body.priceMonthly) || 30;
        settingsData.priceYearly = parseFloat(body.priceYearly) || 250;
        settingsData.priceResell5 = parseFloat(body.priceResell5) || 100;
        settingsData.priceResell10 = parseFloat(body.priceResell10) || 180;
        settingsData.priceResell20 = parseFloat(body.priceResell20) || 300;
        settingsData.priceResell30 = parseFloat(body.priceResell30) || 400;
        
        settingsData.publicPrices = {
            priceMonthly: settingsData.priceMonthly,
            priceQuarterly: settingsData.priceQuarterly || 80,
            priceSemiannual: settingsData.priceSemiannual || 150,
            priceYearly: settingsData.priceYearly,
            priceResell5: settingsData.priceResell5,
            priceResell10: settingsData.priceResell10,
            priceResell20: settingsData.priceResell20,
            priceResell30: settingsData.priceResell30
        };
        
        if (req.files?.icon512) {
            const dest = path.join(BASE_DIR, 'icon-512x512.png');
            fs.renameSync(req.files.icon512[0].path, dest);
        }
        if (req.files?.icon192) {
            const dest = path.join(BASE_DIR, 'icon-192x192.png');
            fs.renameSync(req.files.icon192[0].path, dest);
        }
        
        saveJSON(SETTINGS_DB_PATH, settingsData);
        logCheckin(req.session.user.username, 'Atualizou configurações do sistema');
        
        res.json({ success: true, message: 'Configurações salvas!' });
    } catch (e) {
        console.error('Erro ao salvar settings:', e);
        res.json({ success: false, message: e.message });
    }
});

// =============================================================================
// API - BACKUP
// =============================================================================
app.get('/api/admin/backup', (req, res) => {
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    
    const backupName = `zappbot-backup-${new Date().toISOString().split('T')[0]}.zip`;
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    res.attachment(backupName);
    archive.pipe(res);
    
    archive.file(BOTS_DB_PATH, { name: 'bots.json' });
    archive.file(USERS_DB_PATH, { name: 'users.json' });
    archive.file(SETTINGS_DB_PATH, { name: 'settings.json' });
    archive.file(GROUPS_DB_PATH, { name: 'groups.json' });
    archive.file(CLIENTS_DB_PATH, { name: 'clients.json' });
    archive.file(CAMPAIGNS_DB_PATH, { name: 'campaigns.json' });
    archive.file(PAYMENTS_DB_PATH, { name: 'payments.json' });
    
    archive.finalize();
});

app.post('/api/admin/restore', upload.single('backupFile'), (req, res) => {
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }
    
    if (!req.file) {
        return res.json({ success: false, message: 'Nenhum arquivo enviado' });
    }
    
    try {
        const zip = new AdmZip(req.file.path);
        const entries = zip.getEntries();
        
        entries.forEach(entry => {
            const filePath = path.join(BASE_DIR, entry.entryName);
            fs.writeFileSync(filePath, entry.getData());
        });
        
        botsData = loadJSON(BOTS_DB_PATH, {});
        usersData = loadJSON(USERS_DB_PATH, {});
        settingsData = loadJSON(SETTINGS_DB_PATH, {});
        groupsData = loadJSON(GROUPS_DB_PATH, {});
        clientsData = loadJSON(CLIENTS_DB_PATH, []);
        campaignsData = loadJSON(CAMPAIGNS_DB_PATH, []);
        
        res.json({ success: true, message: 'Backup restaurado com sucesso!' });
    } catch (e) {
        res.json({ success: false, message: 'Erro ao restaurar: ' + e.message });
    }
});

// =============================================================================
// API - MERCADO PAGO
// =============================================================================
app.post('/api/create-payment', async (req, res) => {
    const { planType, sessionName, groupId } = req.body;
    
    const prices = settingsData.publicPrices || {};
    const amounts = {
        monthly: prices.priceMonthly || 30,
        quarterly: prices.priceQuarterly || 80,
        semiannual: prices.priceSemiannual || 150,
        yearly: prices.priceYearly || 250,
        resell_5: prices.priceResell5 || 100,
        resell_10: prices.priceResell10 || 180,
        resell_20: prices.priceResell20 || 300,
        resell_30: prices.priceResell30 || 400
    };
    
    const amount = amounts[planType] || 30;
    
    try {
        const mp = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN || '' });
        const payment = new Payment(mp);
        
        const result = await payment.create({
            body: {
                transaction_amount: amount,
                description: `ZappBot - ${planType}`,
                payment_method_id: 'pix',
                payer: { email: 'cliente@example.com' }
            }
        });
        
        if (result.point_of_interaction?.transaction_data?.qr_code) {
            paymentsData.push({
                id: result.id,
                planType,
                sessionName,
                groupId,
                amount,
                status: 'pending',
                createdAt: new Date().toISOString()
            });
            
            res.json({
                success: true,
                amount: amount,
                qr_code: result.point_of_interaction.transaction_data.qr_code,
                qr_code_base64: result.point_of_interaction.transaction_data.qr_code_base64
            });
        } else {
            res.json({ success: false, error: 'Erro ao gerar Pix' });
        }
    } catch (e) {
        console.error('Erro Mercado Pago:', e.message);
        
        // Modo teste (sem Mercado Pago real)
        const mockQrCode = `00020126580014br.gov.bcb.pix0136${Date.now()}520400005303986540${amount.toFixed(2)}5802BR5925ZAPPBOT 3D6009SAO PAULO6108030090006304`;
        const mockBase64 = Buffer.from(mockQrCode).toString('base64');
        
        res.json({
            success: true,
            amount: amount,
            qr_code: mockQrCode,
            qr_code_base64: mockBase64
        });
    }
});

// =============================================================================
// API - SUPORTE COM GEMINI (CHATBOT)
// =============================================================================
app.post('/api/support-chat', async (req, res) => {
    if (!supportModel) {
        return res.json({ response: 'Configure a API Key do Gemini para usar o assistente.' });
    }
    
    const { message, context } = req.body;
    const user = req.session.user;
    
    // Selecionar prompt baseado no tipo de usuário
    let systemPrompt = SUPPORT_SYSTEM_PROMPT;
    if (user.role === 'reseller') {
        systemPrompt = RESELLER_SYSTEM_PROMPT;
    } else if (user.role === 'cliente') {
        systemPrompt = CLIENT_SYSTEM_PROMPT;
    }
    
    // Adicionar contexto do usuário
    const contextInfo = `
    Usuário: ${user.username}
    Função: ${user.role}
    Bots: ${Object.keys(botsData).filter(k => botsData[k].owner === user.username).length}
    Limite de Bots: ${user.botLimit || 5}
    `;
    
    try {
        const chat = supportModel.startChat({
            history: [
                { role: 'user', parts: [{ text: systemPrompt + '\n\n' + contextInfo }] },
                { role: 'model', parts: [{ text: 'Entendido. Estou pronto para ajudar!' }] }
            ]
        });
        
        const result = await chat.sendMessage(message);
        const response = result.response.text();
        
        // Detectar ações
        const actions = [];
        if (response.includes('[ACTION:')) {
            const matches = response.match(/\[ACTION:([^\]]+)\]/g);
            if (matches) {
                matches.forEach(m => actions.push(m.replace('[ACTION:', '').replace(']', '')));
            }
        }
        
        res.json({ response, actions });
    } catch (e) {
        console.error('Erro Gemini:', e.message);
        switchToNextApiKey();
        res.json({ response: 'Desculpe, ocorreu um erro. Tente novamente.' });
    }
});

// =============================================================================
// SOCKET.IO
// =============================================================================
io.on('connection', (socket) => {
    const user = socket.request.session.user;
    
    if (!user) {
        socket.disconnect();
        return;
    }
    
    console.log(`[SOCKET] Usuário conectado: ${user.username}`);
    
    // Enviar dados iniciais
    socket.emit('bots:list', botsData);
    socket.emit('settings:update', settingsData.publicPrices);
    
    if (user.isAdmin || user.role === 'reseller') {
        socket.emit('clients:list', clientsData);
        socket.emit('campaigns:list', campaignsData);
    }
    
    // Listeners de bots
    socket.on('join-bot', (sessionName) => {
        socket.join(`bot-${sessionName}`);
    });
    
    socket.on('create-bot', (data) => {
        if (!botsData[data.sessionName]) {
            const now = new Date();
            const expiresAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
            
            botsData[data.sessionName] = {
                sessionName: data.sessionName,
                prompt: data.prompt || '',
                owner: data.owner || user.username,
                botType: data.botType || 'individual',
                platform: data.platform || 'whatsapp',
                token: data.token || '',
                status: 'Offline',
                createdAt: now.toISOString(),
                trialExpiresAt: expiresAt.toISOString(),
                isTrial: true,
                activated: false
            };
            
            io.emit('bots:updated', botsData);
        }
    });
    
    socket.on('start-bot', (data) => {
        const { sessionName, phoneNumber } = data;
        const bot = botsData[sessionName];
        
        if (!bot) return;
        
        const ignoredJson = JSON.stringify(bot.ignoredIdentifiers || []);
        const promptBase64 = Buffer.from(bot.prompt || '').toString('base64');
        const groupsJson = JSON.stringify([]);
        
        const args = [
            BOT_SCRIPT_PATH,
            sessionName,
            promptBase64,
            Buffer.from(ignoredJson).toString('base64'),
            phoneNumber || 'null',
            groupsJson,
            bot.botType || 'individual',
            '',
            (bot.silenceTime || 0).toString(),
            bot.platform || 'whatsapp',
            bot.token || '',
            bot.notificationNumber || ''
        ];
        
        console.log(`[BOT ${sessionName}] Iniciando processo com args:`, args);
        
        const botProcess = spawn('node', args, {
            cwd: BASE_DIR,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        console.log(`[BOT ${sessionName}] Processo iniciado com PID: ${botProcess.pid}`);
        
        bot.processId = botProcess.pid;
        bot.status = 'Iniciando...';
        bot.activated = true;
        
        botProcess.on('error', (err) => {
            console.error(`[BOT ${sessionName}] Erro ao iniciar processo:`, err.message);
        });
        
        botProcess.stdout.on('data', async (data) => {
            const output = data.toString();
            console.log(`[BOT ${sessionName}] stdout: ${output.substring(0, 100)}`);
            if (output.includes('ONLINE')) {
                botsData[sessionName].status = 'Online';
                botsData[sessionName].qr = null;
                io.emit('bots:updated', botsData);
                io.to(`bot-${sessionName}`).emit('bot-online', { sessionName });
            } else if (output.includes('QR_CODE:')) {
                const qrString = output.split('QR_CODE:')[1].split('\n')[0].trim();
                console.log(`[BOT ${sessionName}] QR Code detectado: ${qrString.substring(0, 50)}...`);
                try {
                    const QRCode = require('qrcode');
                    const qrDataUrl = await QRCode.toDataURL(qrString, { width: 300, margin: 2 });
                    botsData[sessionName].qr = qrDataUrl;
                } catch (e) {
                    console.error(`[BOT ${sessionName}] Erro ao gerar QR:`, e.message);
                    botsData[sessionName].qr = qrString;
                }
                botsData[sessionName].status = 'Aguardando QR Code';
                io.emit('bots:updated', botsData);
                console.log(`[BOT ${sessionName}] Emitindo bots:updated com QR`);
            } else if (output.includes('PAIRING_CODE:')) {
                botsData[sessionName].status = 'Aguardando QR Code';
                botsData[sessionName].qr = 'PAIRING_CODE:' + output.split('PAIRING_CODE:')[1].trim();
                io.emit('bots:updated', botsData);
            }
            
            io.to(`bot-${sessionName}`).emit('bot-log', { sessionName, log: output });
        });
        
        botProcess.stderr.on('data', (data) => {
            io.to(`bot-${sessionName}`).emit('bot-log', { sessionName, log: '[ERRO] ' + data.toString() });
        });
        
        botProcess.on('close', (code) => {
            botsData[sessionName].status = 'Offline';
            botsData[sessionName].processId = null;
            io.emit('bots:updated', botsData);
        });
        
        io.emit('bots:updated', botsData);
    });
    
    socket.on('stop-bot', (data) => {
        const bot = botsData[data.sessionName];
        if (bot && bot.processId) {
            try {
                process.kill(-bot.processId);
                process.kill(bot.processId);
            } catch (e) {}
        }
        botsData[data.sessionName].status = 'Offline';
        io.emit('bots:updated', botsData);
    });
    
    socket.on('delete-bot', (data) => {
        const bot = botsData[data.sessionName];
        if (bot && bot.processId) {
            try {
                process.kill(-bot.processId);
                process.kill(bot.processId);
            } catch (e) {}
        }
        delete botsData[data.sessionName];
        io.emit('bots:updated', botsData);
    });
    
    socket.on('update-bot', (data) => {
        if (botsData[data.sessionName]) {
            if (data.newPrompt !== undefined) botsData[data.sessionName].prompt = data.newPrompt;
            if (data.botType !== undefined) botsData[data.sessionName].botType = data.botType;
            if (data.silenceTime !== undefined) botsData[data.sessionName].silenceTime = data.silenceTime;
            if (data.notificationNumber !== undefined) botsData[data.sessionName].notificationNumber = data.notificationNumber;
            io.emit('bots:updated', botsData);
        }
    });
    
    // Listeners de grupos
    socket.on('group-activation-request', (data) => {
        const { groupId, groupName, activationToken, botSessionName } = data;
        
        const linkData = settingsData.activationLinks?.[activationToken];
        if (!linkData || linkData.botSessionName !== botSessionName) {
            socket.emit('group-activation-result', { success: false, message: 'Token inválido' });
            return;
        }
        
        const groupKey = `${botSessionName}_${groupId}`;
        if (groupsData[groupKey]) {
            socket.emit('group-activation-result', { success: false, message: 'Grupo já ativado' });
            return;
        }
        
        groupsData[groupKey] = {
            groupId,
            groupName,
            botSessionName,
            owner: botsData[botSessionName]?.owner || 'unknown',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            status: 'active',
            isPaused: false,
            prompt: '',
            silenceTime: 0,
            botName: '',
            antiLink: false,
            welcomeEnabled: false,
            welcomeMessage: '👋 Olá @user! Bem-vindo(a) ao grupo!'
        };
        
        socket.emit('group-activation-result', { 
            success: true, 
            groupId, 
            botSessionName,
            expiresAt: groupsData[groupKey].expiresAt 
        });
    });
    
    // Listeners de clientes
    socket.on('clients:get', () => {
        socket.emit('clients:list', clientsData);
    });
    
    socket.on('clients:add', (data) => {
        const owner = user.username;
        data.clients.forEach(client => {
            const existing = clientsData.find(c => c.phone === client.phone && c.owner === owner);
            if (!existing) {
                clientsData.push({ ...client, id: Date.now() + Math.random(), owner, createdAt: new Date().toISOString() });
            }
        });
        io.emit('clients:list', clientsData);
    });
    
    // Listeners de campanhas
    socket.on('campaigns:get', () => {
        socket.emit('campaigns:list', campaignsData);
    });
    
    socket.on('campaigns:create', (data) => {
        const campaign = {
            ...data,
            id: Date.now(),
            createdAt: new Date().toISOString(),
            status: 'pending',
            owner: user.username
        };
        campaignsData.push(campaign);
        io.emit('campaigns:list', campaignsData);
    });
    
    // Suporte (Chat Gemini)
    socket.on('support-chat-message', async (msg) => {
        if (!supportModel) {
            socket.emit('support-chat-response', { text: 'Configure a API Key do Gemini nas configurações.' });
            return;
        }
        
        let systemPrompt = SUPPORT_SYSTEM_PROMPT;
        if (user.role === 'reseller') systemPrompt = RESELLER_SYSTEM_PROMPT;
        else if (user.role === 'cliente') systemPrompt = CLIENT_SYSTEM_PROMPT;
        
        const contextInfo = `\nUsuário: ${user.username}\nFunção: ${user.role}\n`;
        
        try {
            const chat = supportModel.startChat({
                history: [
                    { role: 'user', parts: [{ text: systemPrompt + contextInfo }] },
                    { role: 'model', parts: [{ text: 'Entendido!' }] }
                ]
            });
            
            const result = await chat.sendMessage(msg);
            const response = result.response.text();
            
            let action = null;
            if (response.includes('[ACTION:')) {
                const match = response.match(/\[ACTION:([^\]]+)\]/);
                if (match) action = match[1];
            }
            
            socket.emit('support-chat-response', { text: response.replace(/\[ACTION:[^\]]+\]/g, '').trim(), action });
        } catch (e) {
            console.error('Erro Gemini:', e.message);
            switchToNextApiKey();
            socket.emit('support-chat-response', { text: 'Desculpe, ocorreu um erro. Tente novamente.' });
        }
    });
    
    socket.on('clear-support-history', () => {
        // Limpar contexto se necessário
    });
});

// =============================================================================
// INICIAR SERVIDOR
// =============================================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║            ZAPPBOT 3D - SERVIDOR INICIADO                  ║
╠═══════════════════════════════════════════════════════════╣
║  URL: http://localhost:${PORT}                               ║
║  Usuários: ${Object.keys(usersData).length}                                      ║
║  Bots: ${Object.keys(botsData).length}                                        ║
║  API Keys Gemini: ${API_KEYS_GEMINI.length}                                   ║
╚═══════════════════════════════════════════════════════════╝
    `);
});