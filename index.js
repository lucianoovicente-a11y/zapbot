const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    delay,
    downloadMediaMessage,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    makeInMemoryStore,
    WAMessageStubType
} = require('@whiskeysockets/baileys');
const { Telegraf } = require('telegraf');
const pino = require('pino');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const fs = require('fs');
const io = require('socket.io-client');
const axios = require('axios');
const qrcode = require('qrcode');

// =================================================================================
// CLASSE AUXILIAR DE CACHE
// =================================================================================
class SimpleCache {
    constructor() {
        this.cache = new Map();
    }
    get(key) {
        return this.cache.get(key);
    }
    set(key, value) {
        this.cache.set(key, value);
    }
    del(key) {
        this.cache.delete(key);
    }
    flushAll() {
        this.cache.clear();
    }
}
const msgRetryCounterCache = new SimpleCache();

// Cache para evitar processamento duplo de tokens de ativação
const processedActivations = new Set();

// =================================================================================
// CONFIGURAÇÃO E ARGUMENTOS
// =================================================================================

const nomeSessao = process.argv[2];
const promptSistemaGlobal = Buffer.from(process.argv[3] || '', 'base64').toString('utf-8');
const ignoredIdentifiersArg = Buffer.from(process.argv[4] || 'W10=', 'base64').toString('utf-8'); 
let phoneNumberArg = (process.argv[5] && process.argv[5] !== 'null') ? process.argv[5] : null;
const authorizedGroupsArg = Buffer.from(process.argv[6] || 'W10=', 'base64').toString('utf-8'); 

const botType = process.argv[7] || 'individual'; 
const botNameGlobal = process.argv[8] || ''; 
const silenceTimeMinutesGlobal = parseInt(process.argv[9] || '0'); 
const platform = process.argv[10] || 'whatsapp';
const telegramToken = process.argv[11] || '';
const notificationNumber = process.argv[12] || '';

if (phoneNumberArg) {
    phoneNumberArg = phoneNumberArg.replace(/[^0-9]/g, '');
}

const modeloGemini = 'gemini-flash-latest'; 

// =================================================================================
// CONEXÃO SOCKET.IO
// =================================================================================

const SOCKET_URL = process.env.SOCKET_URL || 'http://localhost:3000';
console.log(`[${nomeSessao}] Conectando ao servidor: ${SOCKET_URL}`);
const socket = io(SOCKET_URL);
let currentSock = null; // Referência global para o socket do WhatsApp

socket.on('connect', () => {
    console.log(`[${nomeSessao}] Conectado ao servidor via Socket.IO.`);
});
socket.on('disconnect', () => {
    console.log(`[${nomeSessao}] Desconectado do servidor.`);
});
socket.on('connect_error', (err) => {
    console.error(`[${nomeSessao}] Erro de conexão Socket.IO:`, err.message);
});

// --- LISTENERS GLOBAIS ---

socket.on('bot:send-client-message', async (data) => {
    if (data.targetBot === nomeSessao) {
        if (!currentSock) {
            const errorMsg = `[${nomeSessao}] ERRO: Campanha ${data.campaignId} falhou. Bot não está conectado ao WhatsApp.`;
            console.error(errorMsg);
            socket.emit('campaign:feedback', { success: false, message: `Falha ao enviar: O robô ${nomeSessao} não está conectado.` });
            return;
        }
        try {
            const jid = `${data.clientNumber}@s.whatsapp.net`;
            await currentSock.sendMessage(jid, { text: data.message });
            console.log(`[${nomeSessao}] Mensagem da campanha ${data.campaignId} enviada para ${jid}`);
        } catch (e) {
            const errorMsg = `[${nomeSessao}] FALHA CRÍTICA ao enviar campanha para ${data.clientNumber}: ${e.message}`;
            console.error(errorMsg);
            socket.emit('campaign:feedback', { success: false, message: `Robô ${nomeSessao} falhou ao enviar para ${data.clientNumber}.` });
        }
    }
});

socket.on('bot:send-campaign-with-pix', async (data) => {
    if (data.targetBot === nomeSessao) {
        if (!currentSock) {
            console.error(`[${nomeSessao}] ERRO: Bot desconectado ao tentar enviar PIX.`);
            return;
        }
        try {
            const jid = `${data.clientNumber}@s.whatsapp.net`;
            const qrBuffer = Buffer.from(data.pixData.qr_code_base64, 'base64');
            await currentSock.sendMessage(jid, { image: qrBuffer, caption: data.message });
            await currentSock.sendMessage(jid, { text: data.pixData.qr_code });
            console.log(`[${nomeSessao}] Campanha com PIX enviada para ${jid}`);
        } catch (e) {
            console.error(`[${nomeSessao}] Erro ao enviar campanha com PIX para ${data.clientNumber}:`, e);
            socket.emit('campaign:feedback', { success: false, message: `Erro ao enviar PIX para ${data.clientNumber}.` });
        }
    }
});

socket.on('pix:generated-for-client', async (data) => {
    if (data.botSessionName === nomeSessao) {
        try {
            if (!currentSock) return;
            const { pixData, clientJid } = data;
            const qrBuffer = Buffer.from(pixData.qr_code_base64, 'base64');
            await currentSock.sendMessage(clientJid, { image: qrBuffer, caption: `✅ PIX Gerado! Você também pode usar o Copia e Cola abaixo:` });
            await currentSock.sendMessage(clientJid, { text: pixData.qr_code });
        } catch (e) {
            console.error(`[${nomeSessao}] Erro ao enviar PIX para ${data.clientJid}:`, e);
        }
    }
});

socket.on('pix:generation-failed', async (data) => {
    if (data.botSessionName === nomeSessao) {
        try {
            if (!currentSock) return;
            await currentSock.sendMessage(data.clientJid, { text: `❌ Não foi possível gerar o Pix. Motivo: ${data.message || 'Erro desconhecido.'}` });
        } catch (e) {
            console.error(`[${nomeSessao}] Erro ao enviar mensagem de falha PIX:`, e);
        }
    }
});

socket.on('group-settings-changed', (data) => {
    if (data.botSessionName === nomeSessao && data.groupId) {
        console.log(`[${nomeSessao}] Atualizando configurações locais para o grupo ${data.groupId}`);
        authorizedGroups[data.groupId] = {
            ...authorizedGroups[data.groupId],
            ...data.settings,
            expiresAt: data.settings.expiresAt ? new Date(data.settings.expiresAt) : null
        };
    }
});

socket.on('group-removed', (data) => {
    if (data.botSessionName === nomeSessao && data.groupId) {
        console.log(`[${nomeSessao}] ⚠️ ALERTA: Grupo ${data.groupId} removido do painel. Parando respostas imediatamente.`);
        delete authorizedGroups[data.groupId];
    }
});

socket.on('ignored-list-updated', (data) => {
    if (data.sessionName === nomeSessao) {
        ignoredIdentifiers = data.ignoredIdentifiers;
        console.log(`[${nomeSessao}] Lista de ignorados atualizada via servidor.`);
    }
});

socket.on('group-activation-result', async (data) => {
    if (data.botSessionName === nomeSessao && data.groupId) {
        if (!currentSock) return;
        if (!currentSock) return;
const msg = data.success 
    ? '✅ Grupo ativado e vinculado a este bot!\n\nPara saber comandos deste grupo, envie !menu' 
    : `❌ Falha: ${data.message}`;
        await currentSock.sendMessage(data.groupId, { text: msg });
        if(data.success) {
            // Inicializa com padrões se não vier do servidor
            authorizedGroups[data.groupId] = { 
                expiresAt: new Date(data.expiresAt), 
                antiLink: false, 
                prompt: '', 
                silenceTime: 0, 
                botName: '', 
                isPaused: false,
                welcomeEnabled: false,
                welcomeMessage: '👋 Olá @user! Bem-vindo(a) ao grupo!'
            };
        }
    }
});

// =================================================================================
// VARIÁVEIS DE ESTADO
// =================================================================================

const pausados = {};
const lastResponseTimes = {};

let ignoredIdentifiers = [];
try { ignoredIdentifiers = JSON.parse(ignoredIdentifiersArg); } catch (e) { console.error("Erro parse ignored:", e); }

let authorizedGroups = {};
try {
    const groupsArray = JSON.parse(authorizedGroupsArg);
    groupsArray.forEach(group => {
        authorizedGroups[group.groupId] = {
            expiresAt: group.expiresAt ? new Date(group.expiresAt) : null,
            antiLink: group.antiLink === true,
            prompt: group.prompt || '',
            silenceTime: group.silenceTime !== undefined ? parseInt(group.silenceTime) : 0,
            botName: group.botName || '',
            isPaused: group.isPaused === true,
            // Configurações de Boas Vindas
            welcomeEnabled: group.welcomeEnabled === true,
            welcomeMessage: group.welcomeMessage || '👋 Olá @user! Bem-vindo(a) ao grupo!'
        };
    });
} catch (e) {
    console.error('❌ Erro ao ler grupos:', e);
}

// =================================================================================
// CONFIGURAÇÃO GEMINI (IA)
// =================================================================================

const API_KEYS_STRING = process.env.API_KEYS_GEMINI;
if (!API_KEYS_STRING) {
    console.error("❌ ERRO FATAL: Nenhuma API KEY do Gemini encontrada nas variáveis de ambiente.");
    process.exit(1);
}

const API_KEYS = API_KEYS_STRING.split('\n').map(k => k.trim()).filter(Boolean);
console.log(`[DEBUG] Total de API Keys carregadas: ${API_KEYS.length}`);

let currentApiKeyIndex = 0;

const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

let genAI = new GoogleGenerativeAI(API_KEYS[currentApiKeyIndex]);
let model = genAI.getGenerativeModel({ model: modeloGemini, safetySettings });

const logger = pino({ level: 'silent' }); 

const historicoConversa = {};
const MAX_HISTORICO_POR_USUARIO = 20;

function switchToNextApiKey() {
    currentApiKeyIndex = (currentApiKeyIndex + 1) % API_KEYS.length;
    console.log(`[${nomeSessao}] 🔄 Trocando API Key para index: ${currentApiKeyIndex}`);
    genAI = new GoogleGenerativeAI(API_KEYS[currentApiKeyIndex]);
    model = genAI.getGenerativeModel({ model: modeloGemini, safetySettings });
}

async function processarComGemini(jid, input, isAudio = false, promptEspecifico = null) {
    console.log(`[DEBUG IA] Iniciando processamento para ${jid}. Input: "${input.substring(0, 20)}..."`);
    
    if (isAudio) {
        console.log(`[DEBUG IA] Audio detectado - não suportado, enviando mensagem padrão`);
        return "Desculpe, no momento não consigo processar mensagens de áudio. Por favor, envie sua mensagem em texto.";
    }
    
    for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
        try {
            if (!historicoConversa[jid]) historicoConversa[jid] = [];
            
            const promptFinal = promptEspecifico || promptSistemaGlobal;

            const chatHistory = [
                { role: "user", parts: [{ text: `System Instruction:\n${promptFinal}` }] },
                { role: "model", parts: [{ text: "Entendido.." }] },
                ...historicoConversa[jid]
            ];

            let resposta = "";
            
            const chat = model.startChat({ history: chatHistory });
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout Gemini")), 15000));
            const apiPromise = chat.sendMessage(input);
            const result = await Promise.race([apiPromise, timeoutPromise]);
            
            if (!result || !result.response) throw new Error("Resposta vazia");
            resposta = result.response.text().trim();
            historicoConversa[jid].push({ role: "user", parts: [{ text: input }] });

            console.log(`[DEBUG IA] Resposta gerada: "${resposta.substring(0, 20)}..."`);
            historicoConversa[jid].push({ role: "model", parts: [{ text: resposta }] });
            if (historicoConversa[jid].length > MAX_HISTORICO_POR_USUARIO) historicoConversa[jid] = historicoConversa[jid].slice(-MAX_HISTORICO_POR_USUARIO);
            
            return resposta;

        } catch (err) {
            const errorMsg = err.toString();
            console.error(`[DEBUG IA] Erro na tentativa ${attempt}:`, errorMsg);
            if (errorMsg.includes('429') || errorMsg.includes('fetch failed') || errorMsg.includes('Timeout')) {
                switchToNextApiKey();
            } else {
                return ""; 
            }
        }
    }
    return "";
}

// =================================================================================
// FUNÇÕES AUXILIARES
// =================================================================================

function areJidsSameUser(jid1, jid2) {
    if (!jid1 || !jid2) return false;
    return jidNormalizedUser(jid1) === jidNormalizedUser(jid2);
}

async function isGroupAdminWA(sock, jid, participant) {
    try {
        const metadata = await sock.groupMetadata(jid);
        const admin = metadata.participants.find(p => {
            return areJidsSameUser(p.id, participant) && (p.admin === 'admin' || p.admin === 'superadmin');
        });
        return !!admin;
    } catch (e) { 
        return false; 
    }
}

async function isBotAdminWA(sock, jid) {
    try {
        const me = sock.user || sock.authState.creds.me;
        if (!me) return false;

        const myJid = jidNormalizedUser(me.id);
        const myLid = me.lid ? jidNormalizedUser(me.lid) : null;
        const metadata = await sock.groupMetadata(jid);
        
        const amIAdmin = metadata.participants.find(p => {
            if (p.admin !== 'admin' && p.admin !== 'superadmin') return false;
            const pJid = jidNormalizedUser(p.id);
            if (myLid && pJid === myLid) return true;
            if (pJid === myJid) return true;
            return false;
        });

        return !!amIAdmin;
    } catch (e) { return false; }
}

// =================================================================================
// LÓGICA TELEGRAM
// =================================================================================
if (platform === 'telegram') {
    if (!telegramToken) { console.error('❌ Token do Telegram não fornecido.'); process.exit(1); }
    const bot = new Telegraf(telegramToken);
    
    (async () => {
        try {
            const commands = [
                { command: 'id', description: 'Mostrar ID do Chat' },
                { command: 'menu', description: 'Mostrar todos os comandos' },
                { command: 'ping', description: 'Verificar status' },
                { command: 'stop', description: 'Pausar bot (ex: /stop10)' },
                { command: 'stopsempre', description: 'Ignorar usuário atual' }
            ];

            if (botType === 'group') {
                commands.push(
                    { command: 'config', description: 'Ver configurações do grupo' },
                    { command: 'boasvindas', description: 'Ligar/Desligar boas vindas' },
                    { command: 'msgboasvindas', description: 'Definir mensagem de boas vindas' },
                    { command: 'ban', description: 'Banir usuário' },
                    { command: 'kick', description: 'Expulsar usuário' },
                    { command: 'mute', description: 'Mutar usuário' },
                    { command: 'unmute', description: 'Desmutar usuário' },
                    { command: 'promover', description: 'Promover a Admin' },
                    { command: 'rebaixar', description: 'Remover Admin' },
                    { command: 'antilink', description: 'Configurar Anti-Link' },
                    { command: 'todos', description: 'Chamar todos' },
                    { command: 'apagar', description: 'Apagar mensagem respondida' },
                    { command: 'fixar', description: 'Fixar mensagem' },
                    { command: 'desfixar', description: 'Desfixar mensagem' },
                    { command: 'titulo', description: 'Alterar título do grupo' },
                    { command: 'descricao', description: 'Alterar descrição' },
                    { command: 'link', description: 'Pegar link do grupo' },
                    { command: 'reset', description: 'Reiniciar memória da IA' }
                );
            }

            await bot.telegram.setMyCommands(commands);
            console.log(`[${nomeSessao}] Comandos do Telegram registrados.`);

            await bot.launch({ dropPendingUpdates: true });
            console.log('\nONLINE!'); 
            socket.emit('bot-online', { sessionName: nomeSessao });
        } catch (err) { console.error('Erro Telegram:', err); process.exit(1); }
    })();

    socket.off('group-activation-result');
    socket.on('group-activation-result', async (data) => {
        if (data.botSessionName === nomeSessao && data.groupId) {
            const msg = data.success ? '✅ Grupo ativado com sucesso!' : `❌ Falha: ${data.message}`;
            try {
                await bot.telegram.sendMessage(data.groupId, msg);
                if(data.success) {
                    authorizedGroups[data.groupId] = { 
                        expiresAt: new Date(data.expiresAt), 
                        antiLink: false, 
                        prompt: '', 
                        silenceTime: 0, 
                        botName: '', 
                        isPaused: false,
                        welcomeEnabled: false,
                        welcomeMessage: '👋 Olá @user! Bem-vindo(a) ao grupo!'
                    };
                }
            } catch (e) { console.error('Erro ao enviar msg Telegram:', e); }
        }
    });
    
    bot.command('id', (ctx) => {
        ctx.reply(`ID deste chat: \`${ctx.chat.id}\``, { parse_mode: 'Markdown' });
    });

    // --- BOAS VINDAS TELEGRAM ---
    bot.on('new_chat_members', async (ctx) => {
        const chatId = ctx.chat.id.toString();
        
        if (botType === 'group') {
            if (!authorizedGroups[chatId]) return;
            if (authorizedGroups[chatId].expiresAt && new Date() > authorizedGroups[chatId].expiresAt) return;
            if (authorizedGroups[chatId].isPaused) return;
            
            // Verifica se boas vindas está ativado
            if (!authorizedGroups[chatId].welcomeEnabled) return;
        }

        const newMembers = ctx.message.new_chat_members;
        const welcomeTemplate = authorizedGroups[chatId]?.welcomeMessage || '👋 Olá @user! Bem-vindo(a) ao grupo!';

        for (const member of newMembers) {
            if (member.is_bot) continue; 
            const name = member.first_name || 'Novo Membro';
            // Substitui @user pelo nome
            const finalMsg = welcomeTemplate.replace(/@user/g, `*${name}*`);
            
            try {
                await ctx.reply(finalMsg, { parse_mode: 'Markdown' });
            } catch (e) {
                console.error(`[${nomeSessao}] Erro ao enviar boas vindas Telegram:`, e);
            }
        }
    });

    bot.on('message', async (ctx) => {
        // --- ANTI-BOT LOOP PROTECTION (TELEGRAM) ---
        // Se a mensagem vier de um bot, ignoramos imediatamente.
        if (ctx.from && ctx.from.is_bot) return;

        const texto = ctx.message.text || ctx.message.caption || '';
        if(!texto && !ctx.message.voice && !ctx.message.audio) return;
        
        const chatId = ctx.chat.id.toString();
        const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
        const senderName = ctx.from.first_name || 'User';
        const userId = ctx.from.id.toString();
        const isAudio = !!(ctx.message.voice || ctx.message.audio);
        
        // Se for apenas áudio sem texto
        if (isAudio && !texto) {
            console.log(`[${nomeSessao}] Áudio recebido sem texto de ${chatId}`);
            await ctx.reply('🎤 Recebi seu áudio! Infelizmente ainda não consigo processar mensagens de voz. Por favor, envie sua mensagem em texto.');
            return;
        }

        // --- COMANDO !stopsempre (Ignorar Permanente) ---
        if (texto.match(/^[\/!]stopsempre$/i)) {
            let nameToIgnore = null;
            let canExecute = false;

            if (isGroup) {
                const member = await ctx.getChatMember(userId);
                if (member.status === 'administrator' || member.status === 'creator') {
                     if (ctx.message.reply_to_message) {
                         nameToIgnore = ctx.message.reply_to_message.from.first_name;
                         canExecute = true;
                     }
                }
            } else {
                nameToIgnore = ctx.chat.first_name;
                canExecute = true;
            }
            
            if (canExecute && nameToIgnore) {
                if (!ignoredIdentifiers.some(i => i.type === 'name' && i.value.toLowerCase() === nameToIgnore.toLowerCase())) {
                    ignoredIdentifiers.push({ type: 'name', value: nameToIgnore });
                    socket.emit('bot-update-ignored', { sessionName: nomeSessao, type: 'name', value: nameToIgnore });
                    console.log(`[${nomeSessao}] 🚫 Usuário ${nameToIgnore} ignorado permanentemente.`);
                }
                try { await ctx.deleteMessage(); } catch(e) {}
                return;
            }
        }

        // --- COMANDO !stop (Manual Pause Temporário) ---
        const stopMatch = texto.match(/^[\/!]stop(\d*)$/i);
        if (stopMatch) {
            let isAuth = true;
            if (isGroup) {
                const member = await ctx.getChatMember(userId);
                isAuth = member.status === 'administrator' || member.status === 'creator';
            }
            if (isAuth) {
                const minutos = stopMatch[1] ? parseInt(stopMatch[1]) : 10;
                pausados[chatId] = Date.now() + (minutos * 60 * 1000);
                try { await ctx.deleteMessage(); } catch(e) {}
                return;
            }
        }

        // --- VERIFICAÇÃO DE PAUSA ---
        if (pausados[chatId] && Date.now() < pausados[chatId]) return;

        // 1. Verificar Link de Ativação
        if (isGroup && texto.includes('/ativar?token=')) {
            const token = texto.match(/token=([a-zA-Z0-9-]+)/)?.[1];
            if (token) {
                // --- CORREÇÃO: Evitar processamento duplo ---
                if (processedActivations.has(token)) return;
                processedActivations.add(token);
                setTimeout(() => processedActivations.delete(token), 60000); // Limpa após 1 min

                console.log(`[${nomeSessao}] Link de ativação detectado no grupo Telegram ${chatId}`);
                const groupTitle = ctx.chat.title || 'Grupo Telegram';
                socket.emit('group-activation-request', { groupId: chatId, groupName: groupTitle, activationToken: token, botSessionName: nomeSessao });
                return; 
            }
        }

        // 2. Lógica de Autorização de Grupo
        let groupConfig = null;
        if (botType === 'group') {
            if (!isGroup || !authorizedGroups[chatId]) return;
            if (authorizedGroups[chatId].expiresAt && new Date() > authorizedGroups[chatId].expiresAt) return;
            groupConfig = authorizedGroups[chatId];
            if (groupConfig.isPaused) return;
        } else if (isGroup) {
            return;
        }

        // 3. Lógica de Administração
        if (isGroup && botType === 'group') {
            if (groupConfig && groupConfig.antiLink) {
                const linkRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|(t\.me\/[^\s]+)/gi;
                if (linkRegex.test(texto)) {
                    try {
                        const member = await ctx.getChatMember(userId);
                        const senderIsAdm = member.status === 'administrator' || member.status === 'creator';
                        if (!senderIsAdm) {
                            await ctx.deleteMessage();
                            await ctx.kickChatMember(userId);
                            await ctx.reply('🚫 *Anti-Link:* Links não são permitidos aqui.', { parse_mode: 'Markdown' });
                            return;
                        }
                    } catch (e) { console.error('Erro antilink telegram:', e); }
                }
            }

            if (texto.startsWith('!') || texto.startsWith('/') || texto.startsWith('.')) {
                const args = texto.trim().split(/ +/);
                let rawCmd = args.shift().toLowerCase();
                if (rawCmd.startsWith('/') || rawCmd.startsWith('!') || rawCmd.startsWith('.')) rawCmd = rawCmd.substring(1);
                const comando = rawCmd.split('@')[0];

                try {
                    const member = await ctx.getChatMember(userId);
                    const senderIsAdm = member.status === 'administrator' || member.status === 'creator';

                    if (comando === 'ping') {
                        const start = Date.now();
                        const msg = await ctx.reply('🏓 Pong!');
                        const end = Date.now();
                        await ctx.telegram.editMessageText(chatId, msg.message_id, null, `🏓 Pong! Latência: ${end - start}ms`);
                        return;
                    }

                    if (comando === 'menu' || comando === 'ajuda') {
                        let menu = `🤖 *MENU DE COMANDOS*\n\n`;
                        menu += `👤 *Comandos Públicos:*\n`;
                        menu += `/menu - Exibe esta lista detalhada de comandos.\n`;
                        menu += `/ping - Verifica se o bot está online e a latência.\n`;
                        menu += `/stop - Pausa o bot por 10 minutos (interrompe respostas da IA).\n`;
                        menu += `/stopsempre - Faz o bot ignorar você ou o usuário respondido permanentemente.\n`;

                        if (senderIsAdm) {
                            menu += `\n👮 *Administração (Apenas Admins):*\n`;
                            menu += `/config - Ver configurações atuais.\n`;
                            menu += `/boasvindas <on/off> - Ativa/Desativa boas vindas.\n`;
                            menu += `/msgboasvindas <texto> - Define msg (use @user).\n`;
                            menu += `/ban (responda) - Bane o usuário da mensagem respondida.\n`;
                            menu += `/kick (responda) - Remove (expulsa) o usuário.\n`;
                            menu += `/apagar (responda) - Apaga a mensagem respondida (se o bot for admin).\n`;
                            menu += `/fixar (responda) - Fixa a mensagem no topo do grupo.\n`;
                            menu += `/desfixar - Desfixa a mensagem.\n`;
                            menu += `/todos - Marca todos os membros do grupo.\n`;
                            menu += `/antilink <on/off> - Ativa ou desativa a remoção automática de links.\n`;
                            menu += `/reset - Limpa a memória de conversa da IA neste chat.\n`;
                        }
                        await ctx.reply(menu, { parse_mode: 'Markdown' });
                        return;
                    }

                    if (senderIsAdm) {
                         const replyTo = ctx.message.reply_to_message;
                         const targetUser = replyTo ? replyTo.from : null;
                         switch (comando) {
                            case 'config':
                                let cfg = `⚙️ *Configurações do Grupo*\n\n`;
                                cfg += `🛡️ Anti-Link: *${authorizedGroups[chatId].antiLink ? 'ON' : 'OFF'}*\n`;
                                cfg += `👋 Boas Vindas: *${authorizedGroups[chatId].welcomeEnabled ? 'ON' : 'OFF'}*\n`;
                                cfg += `📝 Msg Boas Vindas: _${authorizedGroups[chatId].welcomeMessage || 'Padrão'}_\n`;
                                cfg += `🔇 Tempo Silêncio: ${authorizedGroups[chatId].silenceTime} min\n`;
                                await ctx.reply(cfg, { parse_mode: 'Markdown' });
                                return;

                            case 'boasvindas':
                                if(!args[0]) return ctx.reply('Use: /boasvindas on ou off');
                                authorizedGroups[chatId].welcomeEnabled = (args[0].toLowerCase() === 'on');
                                socket.emit('update-group-settings', {groupId:chatId, settings:{welcomeEnabled: authorizedGroups[chatId].welcomeEnabled}});
                                await ctx.reply(`👋 Boas Vindas: *${args[0].toUpperCase()}*`, { parse_mode: 'Markdown' });
                                return;

                            case 'msgboasvindas':
                                if(!args.length) return ctx.reply('Digite a mensagem. Use @user para marcar.');
                                const novaMsg = args.join(' ');
                                authorizedGroups[chatId].welcomeMessage = novaMsg;
                                socket.emit('update-group-settings', {groupId:chatId, settings:{welcomeMessage: novaMsg}});
                                await ctx.reply(`✅ Mensagem de boas vindas atualizada!`);
                                return;

                            case 'ban': if (!targetUser) return ctx.reply('❌ Responda msg.'); await ctx.kickChatMember(targetUser.id); await ctx.reply('✅ Banido.'); return;
                            case 'kick': if (!targetUser) return ctx.reply('❌ Responda msg.'); await ctx.unbanChatMember(targetUser.id); await ctx.reply('✅ Expulso.'); return;
                            case 'apagar': if (!replyTo) return ctx.reply('❌ Responda msg.'); await ctx.deleteMessage(replyTo.message_id); await ctx.deleteMessage(); return;
                            case 'fixar': if (!replyTo) return ctx.reply('❌ Responda msg.'); await ctx.pinChatMessage(replyTo.message_id); return;
                            case 'desfixar': await ctx.unpinChatMessage(); await ctx.reply('✅ Desfixada.'); return;
                            case 'todos': await ctx.reply('📢 *Atenção todos!*', { parse_mode: 'Markdown' }); return;
                            case 'antilink': if(!args[0]) return ctx.reply('Use: /antilink on/off'); authorizedGroups[chatId].antiLink = (args[0]=='on'); socket.emit('update-group-settings', {groupId:chatId, settings:{antiLink:authorizedGroups[chatId].antiLink}}); await ctx.reply(`AntiLink: ${args[0]}`); return;
                            case 'reset': historicoConversa[chatId]=[]; await ctx.reply('🧠 Memória reiniciada.'); return;
                         }
                    }
                } catch (e) { console.error('Erro comando telegram:', e); }
            }
        }

        // 4. Verificação de Ignorados (Nome)
        if (ignoredIdentifiers.some(i => i.type === 'name' && senderName.toLowerCase() === i.value.toLowerCase())) return;

        // 5. Lógica de Silêncio e Chamada por Nome
        let shouldRespond = true;
        const botName = (groupConfig && groupConfig.botName) ? groupConfig.botName : botNameGlobal;
        const isNameCalled = botName && texto.toLowerCase().includes(botName.toLowerCase());
        const silenceTime = (groupConfig && groupConfig.silenceTime !== undefined) ? groupConfig.silenceTime : silenceTimeMinutesGlobal;

        if (silenceTime > 0) {
            const lastTime = lastResponseTimes[chatId] || 0;
            const timeDiffMinutes = (Date.now() - lastTime) / (1000 * 60);
            if (!isNameCalled && timeDiffMinutes < silenceTime) shouldRespond = false;
        }

        if (!shouldRespond) return;

        // 6. Processamento IA
        try {
            ctx.sendChatAction('typing'); 

            const promptToUse = (groupConfig && groupConfig.prompt) ? groupConfig.prompt : promptSistemaGlobal;
            const resposta = await processarComGemini(chatId, texto, false, promptToUse);
            
            if(resposta && resposta.trim().length > 0) {
                await ctx.reply(resposta, { reply_to_message_id: ctx.message.message_id });
                lastResponseTimes[chatId] = Date.now();
            }
        } catch (e) {
            console.error("Erro ao responder no Telegram:", e.message);
        }
    });
    
    bot.catch((err, ctx) => {
        console.log(`Erro Telegram para ${ctx.updateType}`, err);
    });

    process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(0); });
    process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });

} else {
    // =================================================================================
    // LÓGICA WHATSAPP
    // =================================================================================
    async function ligarBot() {
        console.log(`🚀 Iniciando ${nomeSessao} (WhatsApp)...`);
        
        const fs = require('fs');
        const authPath = `./auth_sessions/auth_${nomeSessao}`;
        
        // Verificar se existe sessão antiga
        if (fs.existsSync(authPath)) {
            console.log(`[${nomeSessao}] Sessão anterior detectada em ${authPath}`);
        }
        
        const { state, saveCreds, clearState } = await useMultiFileAuthState(authPath);
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[${nomeSessao}] Usando Baileys v${version.join('.')}, ${isLatest ? 'última' : 'não última'} versão`);

        const sock = makeWASocket({
            version, 
            logger, 
            auth: state,
            syncFullHistory: false, 
            markOnlineOnConnect: true,
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            msgRetryCounterCache,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 5000,
        });

        currentSock = sock;

        if (phoneNumberArg && !sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(phoneNumberArg);
                    console.log(`PAIRING_CODE:${code}`);
                } catch (err) { console.error(`Erro Pairing Code:`, err); }
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
                console.log(`[${nomeSessao}] Razão: ${lastDisconnect?.error?.message || 'Desconhecida'}`);
                
                // Verificar tipo de desconexão
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log(`[${nomeSessao}] ❌ Sessão invalidada. Deletando sessão e reiniciando...`);
                    await clearState();
                    setTimeout(ligarBot, 3000);
                } else if (statusCode === DisconnectReason.badSession) {
                    console.log(`[${nomeSessao}] ❌ Sessão corrompida. Deletando e reiniciando...`);
                    await clearState();
                    setTimeout(ligarBot, 3000);
                } else if (statusCode === DisconnectReason.restartRequired) {
                    console.log(`[${nomeSessao}] Reinício necessário...`);
                    setTimeout(ligarBot, 3000);
                } else {
                    console.log(`[${nomeSessao}] Tentando reconectar em 5 segundos...`);
                    setTimeout(ligarBot, 5000);
                }
            }
            
            if (connection === 'open') {
                console.log('\n✅ ONLINE! Bot conectado ao WhatsApp!'); 
                socket.emit('bot-online', { sessionName: nomeSessao });
                try {
                    const user = sock.user;
                    if (user) {
                        const name = user.name || user.id.split(':')[0];
                        console.log(`[${nomeSessao}] Bot identificado como: ${name}`);
                        socket.emit('bot-identified', { sessionName: nomeSessao, publicName: name });
                    }
                } catch (e) {
                    console.error('Erro ao enviar nome do bot:', e);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // --- BOAS VINDAS WHATSAPP ---
        sock.ev.on('group-participants.update', async (notification) => {
            const { id, participants, action } = notification;
            
            // Apenas se for adição de membro
            if (action === 'add') {
                if (botType === 'group') {
                    if (!authorizedGroups[id]) return;
                    if (authorizedGroups[id].expiresAt && new Date() > authorizedGroups[id].expiresAt) return;
                    if (authorizedGroups[id].isPaused) return;
                    
                    // Verifica se boas vindas está ativado
                    if (!authorizedGroups[id].welcomeEnabled) return;
                }

                const welcomeTemplate = authorizedGroups[id]?.welcomeMessage || '👋 Olá @user! Bem-vindo(a) ao grupo!';

                for (const participant of participants) {
                    try {
                        const myId = sock.user?.id || sock.authState.creds.me?.id;
                        if (areJidsSameUser(participant, myId)) continue;

                        // Substitui @user pela menção real
                        const text = welcomeTemplate.replace(/@user/g, `@${participant.split('@')[0]}`);
                        
                        await sock.sendMessage(id, {
                            text: text,
                            mentions: [participant]
                        });
                    } catch (e) {
                        console.error(`[${nomeSessao}] Erro ao enviar boas vindas WhatsApp:`, e);
                    }
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const msg = messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            // --- TRAVA DE SEGURANÇA: NÃO LER PRÓPRIAS MENSAGENS ---
            if (msg.key.fromMe) return;

            // --- ANTI-BOT LOOP PROTECTION (PADRÃO DA INDÚSTRIA) ---
            // Bots baseados em Baileys (maioria do mercado) geram IDs começando com BAE5.
            // Se detectarmos isso, ignoramos a mensagem para evitar loop infinito.
            if (msg.key.id && msg.key.id.startsWith('BAE5') && msg.key.id.length === 16) {
                return;
            }

            const jid = msg.key.remoteJid;
            const isGroup = jid.endsWith('@g.us');
            const sender = msg.key.participant || jid;

            let texto = msg.message.conversation || msg.message.extendedTextMessage?.text || 
                        msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || '';
            let isAudio = !!msg.message.audioMessage;
            
            // Se for apenas áudio sem texto, enviar mensagem e retornar
            if (isAudio && !texto) {
                console.log(`[${nomeSessao}] Áudio recebido sem texto de ${jid}`);
                await sock.sendMessage(jid, { text: '🎤 Recebi seu áudio! Infelizmente ainda não consigo processar mensagens de voz. Por favor, envie sua mensagem em texto.' }, { quoted: msg });
                return;
            }
            
            // Se não tiver texto e não for áudio, ignorar
            if (!texto && !isAudio) return;

            // --- LÓGICA DE COBRANÇA (PIX) ---
            if (texto.trim().toUpperCase().startsWith('PAGAR-')) {
                const campaignId = texto.trim().substring(6).trim();
                
                if (campaignId) {
                    console.log(`[${nomeSessao}] Cliente ${jid} solicitou PIX para campanha ${campaignId}`);
                    await sock.sendMessage(jid, { text: '⏳ Um momento, estou gerando seu código PIX...' });
                    socket.emit('client:request-pix', {
                        campaignId: campaignId,
                        clientJid: jid,
                        botSessionName: nomeSessao
                    });
                    return; 
                }
            }

            // =========================================================================
            // INTERCEPÇÃO DE COMANDOS
            // =========================================================================
            
            if (texto.toLowerCase() === '!stopsempre') {
                let valueToIgnore = null;
                if (msg.key.fromMe) {
                    if (isGroup) {
                         const context = msg.message?.extendedTextMessage?.contextInfo;
                         if (context?.participant) {
                             const pJid = jidNormalizedUser(context.participant);
                             valueToIgnore = pJid.split('@')[0];
                         }
                    } else {
                        const target = jidNormalizedUser(jid);
                        valueToIgnore = target.split('@')[0];
                    }
                } else {
                    const target = jidNormalizedUser(sender);
                    valueToIgnore = target.split('@')[0];
                }
                
                if (valueToIgnore) {
                    const exists = ignoredIdentifiers.some(i => i.type === 'number' && i.value === valueToIgnore);
                    
                    if (!exists) {
                        ignoredIdentifiers.push({ type: 'number', value: valueToIgnore });
                        socket.emit('bot-update-ignored', { sessionName: nomeSessao, type: 'number', value: valueToIgnore });
                        console.log(`[${nomeSessao}] 🚫 Número ${valueToIgnore} adicionado à lista de ignorados.`);
                    }
                    
                    try {
                        const key = { remoteJid: jid, fromMe: msg.key.fromMe, id: msg.key.id, participant: msg.key.participant };
                        await sock.sendMessage(jid, { delete: key });
                    } catch (e) {}
                }
                return;
            }

            const stopMatch = texto.match(/^!stop(\d*)$/i);
            if (stopMatch) {
                let isAuth = false;
                if (msg.key.fromMe) isAuth = true;
                else if (isGroup) isAuth = await isGroupAdminWA(sock, jid, sender);
                else if (!isGroup && !msg.key.fromMe) isAuth = true; 

                if (isAuth) {
                    const minutos = stopMatch[1] ? parseInt(stopMatch[1]) : 10;
                    const duracaoMs = minutos * 60 * 1000;
                    pausados[jid] = Date.now() + duracaoMs;

                    console.log(`[${nomeSessao}] 🔇 Pausado manualmente por ${minutos} min em ${jid}.`);

                    try {
                        const key = { remoteJid: jid, fromMe: msg.key.fromMe, id: msg.key.id, participant: msg.key.participant };
                        await sock.sendMessage(jid, { delete: key });
                    } catch (e) {}
                    return; 
                }
            }

            if (pausados[jid] && Date.now() < pausados[jid]) return;

            if (isGroup && texto.includes('/ativar?token=')) {
                const token = texto.match(/token=([a-zA-Z0-9-]+)/)?.[1];
                if (token) {
                    // --- CORREÇÃO: Evitar processamento duplo ---
                    if (processedActivations.has(token)) return;
                    processedActivations.add(token);
                    setTimeout(() => processedActivations.delete(token), 60000); // Limpa após 1 min

                    console.log(`[${nomeSessao}] Link de ativação detectado no grupo ${jid}`);
                    
                    // Reage com ampulheta para indicar processamento
                    await sock.sendMessage(jid, { react: { text: "⏳", key: msg.key } });
                    
                    const meta = await sock.groupMetadata(jid);
                    socket.emit('group-activation-request', { groupId: jid, groupName: meta.subject, activationToken: token, botSessionName: nomeSessao });
                    return; 
                }
            }

            let groupConfig = null;
            if (botType === 'group') {
                if (!isGroup || !authorizedGroups[jid]) return;
                if (authorizedGroups[jid].expiresAt && new Date() > authorizedGroups[jid].expiresAt) return;
                groupConfig = authorizedGroups[jid];
                if (groupConfig.isPaused) return;
            } else if (isGroup) {
                return;
            }

            if (isGroup && botType === 'group') {
                if (groupConfig && groupConfig.antiLink) {
                    const linkRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|(wa\.me\/[^\s]+)/gi;
                    if (linkRegex.test(texto)) {
                        const botIsAdm = await isBotAdminWA(sock, jid);
                        const senderIsAdm = await isGroupAdminWA(sock, jid, sender);

                        if (botIsAdm && !senderIsAdm) {
                            await sock.sendMessage(jid, { delete: msg.key });
                            await sock.groupParticipantsUpdate(jid, [sender], 'remove');
                            await sock.sendMessage(jid, { text: '🚫 *Anti-Link:* Links não são permitidos aqui.' });
                            return; 
                        }
                    }
                }

                if (texto.startsWith('!') || texto.startsWith('/') || texto.startsWith('.')) {
                    const args = texto.slice(1).trim().split(/ +/);
                    const comando = args.shift().toLowerCase();
                    const senderIsAdm = await isGroupAdminWA(sock, jid, sender);
                    const botIsAdm = await isBotAdminWA(sock, jid);

                    if (comando === 'ping') {
                        const start = Date.now();
                        await sock.sendMessage(jid, { text: `🏓 Pong! Latência: ${start - (msg.messageTimestamp * 1000)}ms` }, { quoted: msg });
                        return;
                    }

                    if (comando === 'menu' || comando === 'ajuda') {
                        let menu = `🤖 *MENU DE COMANDOS*\n\n`;
                        menu += `👤 *Comandos Públicos:*\n`;
                        menu += `!ping - Verifica latência do bot.\n`;
                        menu += `!stop - Pausa a IA por 10min.\n`;
                        menu += `!stopsempre - Ignora o usuário permanentemente.\n`;

                        if (senderIsAdm) {
                            menu += `\n👮 *Administração (Apenas Admins):*\n`;
                            menu += `!config - Ver configurações atuais.\n`;
                            menu += `!boasvindas <on/off> - Ativa/Desativa boas vindas.\n`;
                            menu += `!msgboasvindas <texto> - Define msg (use @user).\n`;
                            menu += `!ban @user - Remove um membro.\n`;
                            menu += `!kick @user - O mesmo que banir.\n`;
                            menu += `!promover @user - Torna um usuário administrador.\n`;
                            menu += `!rebaixar @user - Tira o admin de um usuário.\n`;
                            menu += `!apagar (responda) - Apaga a mensagem respondida.\n`;
                            menu += `!fechar - Fecha o grupo (só admins enviam).\n`;
                            menu += `!abrir - Abre o grupo.\n`;
                            menu += `!todos - Marca todos os membros do grupo.\n`;
                            menu += `!titulo <nome> - Muda o nome do grupo.\n`;
                            menu += `!descricao <texto> - Muda a descrição.\n`;
                            menu += `!link - Pega o link de convite.\n`;
                            menu += `!antilink <on/off> - Liga/Desliga proteção de links.\n`;
                            menu += `!reset - Limpa a memória da conversa com a IA.\n`;
                            menu += `!sair - O bot sai do grupo.\n`;
                        }
                        await sock.sendMessage(jid, { text: menu }, { quoted: msg });
                        return;
                    }

                    if (senderIsAdm) {
                        let targetUser = null;
                        const mentions = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
                        if (mentions && mentions.length > 0) targetUser = mentions[0];
                        else if (msg.message.extendedTextMessage?.contextInfo?.participant) targetUser = msg.message.extendedTextMessage.contextInfo.participant;
                        else if (args[0]) {
                            const potentialNum = args[0].replace(/[^0-9]/g, '');
                            if (potentialNum.length >= 10) targetUser = potentialNum + '@s.whatsapp.net';
                        }

                        switch (comando) {
                            case 'config':
                                let cfg = `⚙️ *Configurações do Grupo*\n\n`;
                                cfg += `🛡️ Anti-Link: *${authorizedGroups[jid].antiLink ? 'ON' : 'OFF'}*\n`;
                                cfg += `👋 Boas Vindas: *${authorizedGroups[jid].welcomeEnabled ? 'ON' : 'OFF'}*\n`;
                                cfg += `📝 Msg Boas Vindas: _${authorizedGroups[jid].welcomeMessage || 'Padrão'}_\n`;
                                cfg += `🔇 Tempo Silêncio: ${authorizedGroups[jid].silenceTime} min\n`;
                                await sock.sendMessage(jid, { text: cfg }, { quoted: msg });
                                return;

                            case 'boasvindas':
                                if(!args[0]) return sock.sendMessage(jid, { text: 'Use: !boasvindas on ou !boasvindas off' });
                                const welcomeState = args[0].toLowerCase() === 'on';
                                authorizedGroups[jid].welcomeEnabled = welcomeState;
                                socket.emit('update-group-settings', {groupId:jid, settings:{welcomeEnabled: welcomeState}});
                                await sock.sendMessage(jid, { text: `👋 Boas Vindas agora está: *${welcomeState ? 'LIGADO' : 'DESLIGADO'}*` });
                                return;

                            case 'msgboasvindas':
                                if(!args.length) return sock.sendMessage(jid, { text: 'Digite a mensagem. Use @user para marcar o novo membro.' });
                                const novaMsg = args.join(' ');
                                authorizedGroups[jid].welcomeMessage = novaMsg;
                                socket.emit('update-group-settings', {groupId:jid, settings:{welcomeMessage: novaMsg}});
                                await sock.sendMessage(jid, { text: `✅ Mensagem de boas vindas atualizada!` });
                                return;

                            case 'ban':
                            case 'banir':
                            case 'kick':
                                if (!botIsAdm) return sock.sendMessage(jid, { text: '❌ Preciso ser ADM.' }, { quoted: msg });
                                if (!targetUser) return sock.sendMessage(jid, { text: '❌ Marque alguém ou responda.' }, { quoted: msg });
                                await sock.groupParticipantsUpdate(jid, [targetUser], 'remove');
                                await sock.sendMessage(jid, { text: '✅ Usuário removido.' });
                                return;

                            case 'promover':
                            case 'admin':
                                if (!botIsAdm) return sock.sendMessage(jid, { text: '❌ Preciso ser ADM.' }, { quoted: msg });
                                if (!targetUser) return sock.sendMessage(jid, { text: '❌ Marque alguém ou responda.' }, { quoted: msg });
                                await sock.groupParticipantsUpdate(jid, [targetUser], 'promote');
                                await sock.sendMessage(jid, { text: '✅ Usuário promovido.' });
                                return;

                            case 'rebaixar':
                                if (!botIsAdm) return sock.sendMessage(jid, { text: '❌ Preciso ser ADM.' }, { quoted: msg });
                                if (!targetUser) return sock.sendMessage(jid, { text: '❌ Marque alguém ou responda.' }, { quoted: msg });
                                await sock.groupParticipantsUpdate(jid, [targetUser], 'demote');
                                await sock.sendMessage(jid, { text: '✅ ADM removido.' });
                                return;

                            case 'apagar':
                            case 'del':
                                if (!botIsAdm) return sock.sendMessage(jid, { text: '❌ Preciso ser ADM.' }, { quoted: msg });
                                if (!msg.message.extendedTextMessage?.contextInfo?.stanzaId) return sock.sendMessage(jid, { text: '❌ Responda a mensagem.' }, { quoted: msg });
                                const key = {
                                    remoteJid: jid,
                                    fromMe: false,
                                    id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                                    participant: msg.message.extendedTextMessage.contextInfo.participant
                                };
                                await sock.sendMessage(jid, { delete: key });
                                return;

                            case 'fechar':
                                if (!botIsAdm) return sock.sendMessage(jid, { text: '🔒 Grupo fechado.' }, { quoted: msg });
                                await sock.groupSettingUpdate(jid, 'announcement');
                                await sock.sendMessage(jid, { text: '🔒 Grupo fechado.' });
                                return;

                            case 'abrir':
                                if (!botIsAdm) return sock.sendMessage(jid, { text: '🔓 Grupo aberto.' }, { quoted: msg });
                                await sock.groupSettingUpdate(jid, 'not_announcement');
                                await sock.sendMessage(jid, { text: '🔓 Grupo aberto.' });
                                return;
                            
                            case 'todos':
                            case 'everyone':
                                if (!botIsAdm) return; 
                                const groupMeta = await sock.groupMetadata(jid);
                                const mentionsAll = groupMeta.participants.map(p => p.id);
                                await sock.sendMessage(jid, { text: '📢 *Atenção todos!*', mentions: mentionsAll });
                                return;

                            case 'titulo':
                                if (!botIsAdm) return sock.sendMessage(jid, { text: '❌ Preciso ser ADM.' }, { quoted: msg });
                                if (!args.length) return sock.sendMessage(jid, { text: '❌ Digite o novo nome.' }, { quoted: msg });
                                await sock.groupUpdateSubject(jid, args.join(' '));
                                await sock.sendMessage(jid, { text: '✅ Nome alterado.' });
                                return;

                            case 'descricao':
                                if (!botIsAdm) return sock.sendMessage(jid, { text: '❌ Preciso ser ADM.' }, { quoted: msg });
                                if (!args.length) return sock.sendMessage(jid, { text: '❌ Digite a descrição.' }, { quoted: msg });
                                await sock.groupUpdateDescription(jid, args.join(' '));
                                await sock.sendMessage(jid, { text: '✅ Descrição alterada.' });
                                return;

                            case 'link':
                                if (!botIsAdm) return sock.sendMessage(jid, { text: '❌ Preciso ser ADM.' }, { quoted: msg });
                                const code = await sock.groupInviteCode(jid);
                                await sock.sendMessage(jid, { text: `🔗 Link: https://chat.whatsapp.com/${code}` }, { quoted: msg });
                                return;

                            case 'reset':
                                historicoConversa[jid] = [];
                                await sock.sendMessage(jid, { text: '🧠 Memória da IA reiniciada.' }, { quoted: msg });
                                return;

                            case 'sair':
                                await sock.sendMessage(jid, { text: '👋 Adeus!' });
                                await sock.groupLeave(jid);
                                return;

                            case 'antilink':
                                if (!args[0]) return sock.sendMessage(jid, { text: 'Use: !antilink on ou !antilink off' });
                                const novoEstado = args[0].toLowerCase() === 'on';
                                authorizedGroups[jid].antiLink = novoEstado;
                                socket.emit('update-group-settings', { groupId: jid, settings: { antiLink: novoEstado } });
                                await sock.sendMessage(jid, { text: `🛡️ Anti-Link agora está: *${novoEstado ? 'LIGADO' : 'DESLIGADO'}*` });
                                return;
                        }
                    }
                }
            }

            if (ignoredIdentifiers.some(i => (i.type === 'number' && sender.includes(i.value)) || (i.type === 'name' && msg.pushName?.toLowerCase() === i.value.toLowerCase()))) return;

            let shouldRespond = true;
            const myId = sock.user?.id || sock.authState.creds.me?.id;
            const isMentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.some(m => areJidsSameUser(m, myId));
            const isQuoted = msg.message.extendedTextMessage?.contextInfo?.participant && areJidsSameUser(msg.message.extendedTextMessage.contextInfo.participant, myId);
            const botName = (groupConfig && groupConfig.botName) ? groupConfig.botName : botNameGlobal;
            const isNameCalled = botName && texto.toLowerCase().includes(botName.toLowerCase());
            const silenceTime = (groupConfig && groupConfig.silenceTime !== undefined) ? groupConfig.silenceTime : silenceTimeMinutesGlobal;

            if (silenceTime > 0) {
                const lastTime = lastResponseTimes[jid] || 0;
                const timeDiffMinutes = (Date.now() - lastTime) / (1000 * 60);
                if (!isMentioned && !isQuoted && !isNameCalled && timeDiffMinutes < silenceTime) shouldRespond = false;
            }

            if (!shouldRespond) return;

            try {
                console.log(`[DEBUG] Mensagem recebida de ${jid}. Enviando 'composing'...`);
                await sock.readMessages([msg.key]);
                await sock.sendPresenceUpdate('composing', jid);
                await delay(1000); 
                
                const promptToUse = (groupConfig && groupConfig.prompt) ? groupConfig.prompt : promptSistemaGlobal;
                const resposta = await processarComGemini(jid, texto, false, promptToUse);
                
                if (resposta && resposta.trim().length > 0) {
                    await sock.sendMessage(jid, { text: resposta }, { quoted: msg });
                    lastResponseTimes[jid] = Date.now();

                    if (notificationNumber) {
                        try {
                            const adminJid = notificationNumber.replace(/\D/g, '') + '@s.whatsapp.net';
                            const clientName = msg.pushName || sender.split('@')[0];
                            const msgNotif = `🔔 O cliente ${clientName} mandou uma mensagem e eu respondi.`;
                            await sock.sendMessage(adminJid, { text: msgNotif });
                        } catch (errNotif) { console.error(`[ERRO NOTIFICAÇÃO]`, errNotif); }
                    }
                }
                await sock.sendPresenceUpdate('paused', jid);
            } catch (e) { 
                console.error('[ERRO CRÍTICO NO LOOP]:', e.message); 
                await sock.sendPresenceUpdate('paused', jid);
            }
        });
    }

    ligarBot().catch(err => { console.error("Erro fatal:", err); process.exit(1); });
}

process.on('uncaughtException', (err) => { console.error('Exceção não tratada:', err); });
process.on('unhandledRejection', (reason, promise) => { console.error('Rejeição não tratada:', reason); });


