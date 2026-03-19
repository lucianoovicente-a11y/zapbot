const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    delay,
    downloadMediaMessage,
    makeCacheableSignalKeyStore,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');
const { Telegraf } = require('telegraf');
const pino = require('pino');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const fs = require('fs');
const io = require('socket.io-client');
const axios = require('axios');

class SimpleCache {
    constructor() { this.cache = new Map(); }
    get(key) { return this.cache.get(key); }
    set(key, value) { this.cache.set(key, value); }
    del(key) { this.cache.delete(key); }
    flushAll() { this.cache.clear(); }
}

const msgRetryCounterCache = new SimpleCache();
const processedActivations = new Set();

const nomeSessao = process.argv[2];
const promptSistemaGlobal = Buffer.from(process.argv[3] || '', 'base64').toString('utf-8');
const ignoredIdentifiersArg = Buffer.from(process.argv[4] || 'W10=', 'base64').toString('utf-8');
let phoneNumberArg = (process.argv[5] && process.argv[5] !== 'null') ? process.argv[5].replace(/[^0-9]/g, '') : null;
const authorizedGroupsArg = Buffer.from(process.argv[6] || 'W10=', 'base64').toString('utf-8');
const botType = process.argv[7] || 'individual';
const botNameGlobal = process.argv[8] || '';
const silenceTimeMinutesGlobal = parseInt(process.argv[9] || '0');
const platform = process.argv[10] || 'whatsapp';
const telegramToken = process.argv[11] || '';
const notificationNumber = process.argv[12] || '';

const modeloGemini = 'gemini-flash-latest';

const SOCKET_URL = process.env.SOCKET_URL || 'http://localhost:3000';
console.log(`[${nomeSessao}] Conectando ao: ${SOCKET_URL}`);
const socket = io(SOCKET_URL);
let currentSock = null;

socket.on('connect', () => console.log(`[${nomeSessao}] Socket conectado`));
socket.on('disconnect', () => console.log(`[${nomeSessao}] Socket desconectado`));
socket.on('connect_error', (err) => console.error(`[${nomeSessao}] Erro socket:`, err.message));

let ignoredIdentifiers = [];
try { ignoredIdentifiers = JSON.parse(ignoredIdentifiersArg); } catch (e) {}

let authorizedGroups = {};
try {
    JSON.parse(authorizedGroupsArg).forEach(group => {
        authorizedGroups[group.groupId] = {
            expiresAt: group.expiresAt ? new Date(group.expiresAt) : null,
            antiLink: group.antiLink === true,
            prompt: group.prompt || '',
            silenceTime: group.silenceTime || 0,
            botName: group.botName || '',
            isPaused: group.isPaused === true,
            welcomeEnabled: group.welcomeEnabled === true,
            welcomeMessage: group.welcomeMessage || '👋 Olá @user! Bem-vindo(a)!'
        };
    });
} catch (e) {}

const API_KEYS_STRING = process.env.API_KEYS_GEMINI;
if (!API_KEYS_STRING) {
    console.error("❌ ERRO: Nenhuma API KEY do Gemini encontrada.");
    process.exit(1);
}
const API_KEYS = API_KEYS_STRING.split('\n').filter(k => k.trim());
let currentApiKeyIndex = 0;

const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

let genAI = new GoogleGenerativeAI(API_KEYS[currentApiKeyIndex]);
let model = genAI.getGenerativeModel({ model: modeloGemini, safetySettings });

const historicoConversa = {};
const MAX_HISTORICO = 20;

function switchApiKey() {
    currentApiKeyIndex = (currentApiKeyIndex + 1) % API_KEYS.length;
    genAI = new GoogleGenerativeAI(API_KEYS[currentApiKeyIndex]);
    model = genAI.getGenerativeModel({ model: modeloGemini, safetySettings });
}

async function processarComGemini(jid, input) {
    if (!input || !input.trim()) return "";
    
    for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
        try {
            if (!historicoConversa[jid]) historicoConversa[jid] = [];
            
            const chatHistory = [
                { role: "user", parts: [{ text: `System: ${promptSistemaGlobal || 'Você é um assistente virtual.'}` }] },
                { role: "model", parts: [{ text: "Entendido." }] },
                ...historicoConversa[jid]
            ];
            
            const chat = model.startChat({ history: chatHistory });
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000));
            const result = await Promise.race([chat.sendMessage(input), timeoutPromise]);
            
            if (!result?.response) throw new Error("Resposta vazia");
            
            const resposta = result.response.text().trim();
            historicoConversa[jid].push({ role: "user", parts: [{ text: input }] });
            historicoConversa[jid].push({ role: "model", parts: [{ text: resposta }] });
            if (historicoConversa[jid].length > MAX_HISTORICO) historicoConversa[jid] = historicoConversa[jid].slice(-MAX_HISTORICO);
            
            return resposta;
        } catch (err) {
            const msg = err.toString();
            if (msg.includes('429') || msg.includes('fetch failed') || msg.includes('Timeout')) {
                switchApiKey();
            } else {
                return "";
            }
        }
    }
    return "";
}

function areJidsSameUser(jid1, jid2) {
    return jidNormalizedUser(jid1) === jidNormalizedUser(jid2);
}

async function isGroupAdminWA(sock, jid, participant) {
    try {
        const metadata = await sock.groupMetadata(jid);
        return metadata.participants.some(p => areJidsSameUser(p.id, participant) && (p.admin === 'admin' || p.admin === 'superadmin'));
    } catch (e) { return false; }
}

async function isBotAdminWA(sock, jid) {
    try {
        const me = sock.user || sock.authState.creds.me;
        if (!me) return false;
        const myJid = jidNormalizedUser(me.id);
        const myLid = me.lid ? jidNormalizedUser(me.lid) : null;
        const metadata = await sock.groupMetadata(jid);
        return metadata.participants.some(p => {
            if (p.admin !== 'admin' && p.admin !== 'superadmin') return false;
            const pJid = jidNormalizedUser(p.id);
            return (myLid && pJid === myLid) || pJid === myJid;
        });
    } catch (e) { return false; }
}

const pausados = {};
const lastResponseTimes = {};

// ==================== TELEGRAM ====================
if (platform === 'telegram') {
    if (!telegramToken) { console.error('❌ Token do Telegram não fornecido.'); process.exit(1); }
    
    const bot = new Telegraf(telegramToken);
    
    (async () => {
        try {
            const commands = [
                { command: 'id', description: 'Mostrar ID' },
                { command: 'menu', description: 'Menu de comandos' },
                { command: 'ping', description: 'Verificar status' },
                { command: 'stop', description: 'Pausar bot' }
            ];
            await bot.telegram.setMyCommands(commands);
            await bot.launch({ dropPendingUpdates: true });
            console.log('\n✅ ONLINE! Bot Telegram ativo!');
            socket.emit('bot-online', { sessionName: nomeSessao });
        } catch (err) { console.error('Erro Telegram:', err); process.exit(1); }
    })();

    bot.on('message', async (ctx) => {
        const texto = ctx.message.text || ctx.message.caption || '';
        if (!texto) return;
        
        const chatId = ctx.chat.id.toString();
        const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
        
        if (texto.match(/^[\/!]stop(\d*)$/i)) {
            const match = texto.match(/^[\/!]stop(\d*)$/i);
            const minutos = match[1] ? parseInt(match[1]) : 10;
            pausados[chatId] = Date.now() + (minutos * 60 * 1000);
            try { await ctx.deleteMessage(); } catch(e) {}
            return;
        }
        
        if (texto.match(/^[\/!]menu$/i)) {
            const menu = `🤖 *MENU*\n\n!ping - Verificar\n!stop - Pausar 10min\n\nDigite sua mensagem para conversar!`;
            await ctx.reply(menu, { parse_mode: 'Markdown' });
            return;
        }
        
        if (texto.match(/^[\/!]ping$/i)) {
            await ctx.reply('🏓 Pong!');
            return;
        }
        
        if (pausados[chatId] && Date.now() < pausados[chatId]) return;
        
        if (botType === 'group' && !authorizedGroups[chatId]) return;
        
        try {
            await ctx.sendChatAction('typing');
            const resposta = await processarComGemini(chatId, texto);
            if (resposta) await ctx.reply(resposta, { reply_to_message_id: ctx.message.message_id });
        } catch (e) {
            console.error('Erro ao responder Telegram:', e.message);
        }
    });
    
    process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(0); });
    process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });

} else {
    // ==================== WHATSAPP ====================
    const logger = pino({ level: 'silent' });
    
    async function ligarBot() {
        console.log(`🚀 Iniciando ${nomeSessao} (WhatsApp)...`);
        
        const authDir = './auth_sessions';
        if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
        
        const authPath = `./auth_sessions/auth_${nomeSessao}`;
        
        try {
            const { state, saveCreds, clearState } = await useMultiFileAuthState(authPath);
            const { version } = await fetchLatestBaileysVersion();
            console.log(`[${nomeSessao}] Baileys v${version.join('.')}`);

            const sock = makeWASocket({
                version,
                auth: state,
                logger,
                syncFullHistory: false,
                markOnlineOnConnect: true,
                browser: ["Ubuntu", "Chrome", "20.0.04"],
                msgRetryCounterCache,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
            });

            currentSock = sock;

            if (phoneNumberArg && !sock.authState.creds.registered) {
                setTimeout(async () => {
                    try {
                        const code = await sock.requestPairingCode(phoneNumberArg);
                        console.log(`PAIRING_CODE:${code}`);
                    } catch (err) { console.error(`Erro Pairing:`, err); }
                }, 4000);
            }

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                
                if (qr && !phoneNumberArg) {
                    console.log(`QR_CODE:${qr}`);
                }
                
                if (connection === 'close') {
                    currentSock = null;
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    console.log(`[${nomeSessao}] Conexão fechada. Código: ${statusCode}`);
                    
                    if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession) {
                        console.log(`[${nomeSessao}] Sessão invalidada. Limpando...`);
                        await clearState();
                        setTimeout(ligarBot, 3000);
                    } else {
                        setTimeout(ligarBot, 5000);
                    }
                }
                
                if (connection === 'open') {
                    console.log('\n✅ ONLINE! Bot conectado!');
                    socket.emit('bot-online', { sessionName: nomeSessao });
                }
            });

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('group-participants.update', async (notification) => {
                if (notification.action === 'add' && botType === 'group') {
                    const { id, participants } = notification;
                    if (!authorizedGroups[id] || authorizedGroups[id].isPaused || !authorizedGroups[id].welcomeEnabled) return;
                    
                    for (const participant of participants) {
                        try {
                            const myId = sock.user?.id || sock.authState.creds.me?.id;
                            if (areJidsSameUser(participant, myId)) continue;
                            const template = authorizedGroups[id].welcomeMessage.replace(/@user/g, `@${participant.split('@')[0]}`);
                            await sock.sendMessage(id, { text: template, mentions: [participant] });
                        } catch (e) {}
                    }
                }
            });

            sock.ev.on('messages.upsert', async ({ messages, type }) => {
                if (type !== 'notify') return;
                const msg = messages[0];
                if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.fromMe) return;

                const jid = msg.key.remoteJid;
                const isGroup = jid.endsWith('@g.us');
                const sender = msg.key.participant || jid;
                const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || 
                              msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || '';

                if (!texto) return;

                if (texto.match(/^!menu$/i)) {
                    await sock.sendMessage(jid, { text: '🤖 Menu:\n\n!menu - Este menu\n!ping - Verificar\n!stop - Pausar' }, { quoted: msg });
                    return;
                }

                if (texto.match(/^!ping$/i)) {
                    await sock.sendMessage(jid, { text: '🏓 Pong!', quoted: msg });
                    return;
                }

                const stopMatch = texto.match(/^!stop(\d*)$/i);
                if (stopMatch) {
                    const minutos = stopMatch[1] ? parseInt(stopMatch[1]) : 10;
                    pausados[jid] = Date.now() + (minutos * 60 * 1000);
                    return;
                }

                if (isGroup && texto.includes('/ativar?token=')) {
                    const token = texto.match(/token=([a-zA-Z0-9-]+)/)?.[1];
                    if (token && !processedActivations.has(token)) {
                        processedActivations.add(token);
                        setTimeout(() => processedActivations.delete(token), 60000);
                        const meta = await sock.groupMetadata(jid);
                        socket.emit('group-activation-request', { groupId: jid, groupName: meta.subject, activationToken: token, botSessionName: nomeSessao });
                    }
                    return;
                }

                if (isGroup && botType === 'group') {
                    if (!authorizedGroups[jid]) return;
                    if (authorizedGroups[jid].expiresAt && new Date() > authorizedGroups[jid].expiresAt) return;
                    if (authorizedGroups[jid].isPaused) return;

                    if (authorizedGroups[jid].antiLink) {
                        const linkRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|(wa\.me\/[^\s]+)/gi;
                        if (linkRegex.test(texto)) {
                            const botAdm = await isBotAdminWA(sock, jid);
                            const senderAdm = await isGroupAdminWA(sock, jid, sender);
                            if (botAdm && !senderAdm) {
                                await sock.groupParticipantsUpdate(jid, [sender], 'remove');
                            }
                        }
                    }
                }

                if (isGroup && botType === 'individual') return;

                if (ignoredIdentifiers.some(i => sender.includes(i.value))) return;

                if (silenceTimeMinutesGlobal > 0) {
                    const lastTime = lastResponseTimes[jid] || 0;
                    if ((Date.now() - lastTime) < (silenceTimeMinutesGlobal * 60 * 1000)) return;
                }

                try {
                    await sock.sendPresenceUpdate('composing', jid);
                    await delay(1000);
                    
                    const promptToUse = (authorizedGroups[jid]?.prompt) || promptSistemaGlobal;
                    const resposta = await processarComGemini(jid, texto);
                    
                    if (resposta) {
                        await sock.sendMessage(jid, { text: resposta }, { quoted: msg });
                        lastResponseTimes[jid] = Date.now();
                    }
                } catch (e) {
                    console.error(`[${nomeSessao}] Erro ao responder:`, e.message);
                }
            });

        } catch (err) {
            console.error(`[${nomeSessao}] Erro ao iniciar:`, err.message);
            setTimeout(ligarBot, 5000);
        }
    }

    ligarBot().catch(err => { console.error("Erro fatal:", err); process.exit(1); });
}

process.on('uncaughtException', (err) => console.error('Exceção:', err));
process.on('unhandledRejection', (reason) => console.error('Rejeição:', reason));
