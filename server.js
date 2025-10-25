// server.js - IA ECONÔMICA (Gasta o mínimo possível)
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const OpenAI = require('openai');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurações
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'YOUR_SECRET_TOKEN'; // <-- MUDE AQUI
const AUTH_FOLDER = './baileys_auth';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sua-chave-aqui'; // <-- MUDE AQUI
const DB_FILE = './database.json';

// ESTRATÉGIA DE ECONOMIA:
// 1. Usa gpt-3.5-turbo (10x mais barato que GPT-4)
// 2. Mantém histórico curto (só últimas 6 mensagens)
// 3. Respostas limitadas a 150 tokens
// 4. Usa respostas prontas quando possível
// 5. IA só entra quando necessário

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

if (!fs.existsSync(AUTH_FOLDER)) {
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
}

// Estado WhatsApp
let sock = null;
let qrCode = null;
let qrCodeDataURL = null;
let isConnected = false;
let connectionAttempts = 0;
const MAX_ATTEMPTS = 3;

// Banco de dados
const database = {
  customers: new Map(),
  orders: new Map(),
  conversations: new Map(),
  aiConversations: new Map(),
  activeChats: new Map()
};

// Rate Limiting
const messageTimestamps = new Map();

// PRODUTOS (ATUALIZADO PARA AUTOGIRO)
const PRODUCTS = {
  vip: {
    id: 'vip',
    name: 'Comunidade VIP Autogiro',
    price: 79.90,
    description: 'Acesso a 40+ ofertas diárias de carros/motos até 40% abaixo da FIPE.',
    link: 'https://pay.kiwify.com.br/qAAxyjd' // SEU LINK ATUALIZADO
  }
};

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// ===== PERSISTÊNCIA DE DADOS =====
function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      database.customers = new Map(data.customers || []);
      database.orders = new Map(data.orders || []);
      database.conversations = new Map(data.conversations || []);
      console.log('💾 Database carregado');
    }
  } catch (error) {
    console.error('❌ Erro ao carregar DB:', error);
  }
}

function saveDatabase() {
  try {
    const data = {
      customers: Array.from(database.customers.entries()),
      orders: Array.from(database.orders.entries()),
      conversations: Array.from(database.conversations.entries())
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    console.log('💾 Database salvo');
  } catch (error) {
    console.error('❌ Erro ao salvar DB:', error);
  }
}

// Auto-save a cada 2 minutos
setInterval(saveDatabase, 120000);

// Salvar ao fechar
process.on('SIGINT', () => {
  console.log('\n🛑 Encerrando...');
  saveDatabase();
  process.exit(0);
});

// ===== RATE LIMITING =====
function checkRateLimit(phone) {
  const now = Date.now();
  const timestamps = messageTimestamps.get(phone) || [];
  
  // Remove mensagens antigas (>1 minuto)
  const recent = timestamps.filter(t => now - t < 60000);
  
  if (recent.length >= 10) {
    console.log(`⚠️ Rate limit: ${phone}`);
    return false;
  }
  
  recent.push(now);
  messageTimestamps.set(phone, recent);
  return true;
}

// ===== QR CODE =====
function qrToDataURL(qr) {
  return new Promise((resolve, reject) => {
    QRCode.toDataURL(qr, { width: 300, margin: 2 }, (err, url) => {
      if (err) reject(err);
      else resolve(url);
    });
  });
}

function clearAuth() {
  try {
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      fs.mkdirSync(AUTH_FOLDER, { recursive: true });
      console.log('🧹 Auth limpa');
    }
  } catch (error) {
    console.error('❌ Erro:', error);
  }
}

// ===== SISTEMA HÍBRIDO: RESPOSTAS PRONTAS + IA =====

// RESPOSTAS AUTOMÁTICAS (ATUALIZADO COM TOM HUMANO!)
const AUTO_RESPONSES = {
  saudacao: {
    keywords: ['oi', 'olá', 'ola', 'hey', 'bom dia', 'boa tarde', 'boa noite', 'ola'],
    response: (name) => `Opa, ${name ? name : 'tudo bem'}? 👋\n\nAqui é o assistente da *Autogiro*. Seja bem-vindo!\n\nNós ajudamos pessoas a encontrar carros e motos com até 40% abaixo da FIPE (sem ser leilão e com laudo aprovado!).\n\nComo posso te ajudar hoje? 😊`
  },

  info_produto: {
    keywords: ['produtos', 'produto', 'o que vende', 'opções', 'catalogo', 'preço', 'preco', 'valor', 'quanto custa', 'comprar', 'quero', 'link', 'assinar', 'vip', 'como funciona', 'me interessa'],
    response: () => `Claro! Nós temos a *Comunidade VIP Autogiro*. 💎\n\nFunciona assim: você entra no grupo e recebe mais de *40 ofertas todos os dias* de carros e motos com descontos absurdos (até 40% abaixo da FIPE).\n\n💰 O valor normal é R$ 199,90, mas hoje está por apenas *R$ 79,90 por mês*.\n\nE o melhor:\n✅ São carros bons (todos com Laudo Cautelar)\n✅ Nosso time negocia pra você\n✅ *Sem fidelidade*, você pode sair quando quiser.\n\nO link pra entrar é este aqui: \n${PRODUCTS.vip.link}\n\nFicou alguma dúvida? Só mandar!`
  },
  
  origem_carros: {
    keywords: ['de onde vem', 'fonte', 'origem', 'retomada', 'financiamento'],
    response: () => `Essa é a mágica do negócio! 🪄\n\nNós temos acesso direto à *fonte primária* de veículos de retomada de financiamento. São carros que nem chegam a ir para o mercado ou leilão, por isso o preço é tão bom. 🚗`
  },
  
  leilao_sinistro: {
    keywords: ['leilão', 'leilao', 'sinistro', 'batido', 'batida', 'problema'],
    response: () => `Aqui não! Pode ficar 100% tranquilo. \n\n*NÃO* trabalhamos com leilão nem com carros sinistrados (aqueles que já tiveram batidas feias ou problemas sérios).\n\nNosso foco é só em carro bom e de procedência. 👍`
  },

  seguranca: {
    keywords: ['seguro', 'garantia', 'laudo', 'cautelar', 'confiar', 'confiável', 'confiavel'],
    response: () => `Com certeza. Segurança aqui é regra número 1. 🛡️\n\nFunciona assim: *NENHUM* carro é comprado antes de ter um *Laudo Cautelar APROVADO*.\n\nVocê sempre recebe o laudo e todas as fotos antes de tomar qualquer decisão. Transparência total! 😉`
  },

  fidelidade: {
    keywords: ['fidelidade', 'contrato', 'cancelar', 'sem fidelidade', 'multa'],
    response: () => `Não, de jeito nenhum! 🥳\n\nAqui você tem liberdade total. Você pode cancelar a assinatura no momento que quiser, sem multa e sem nenhuma burocracia. O risco é zero. `
  },

  iniciante: {
    keywords: ['iniciante', 'ajuda', 'suporte', 'primeira vez', 'como faço'],
    response: () => `Com certeza! A comunidade é perfeita pra quem tá começando.\n\nVocê não fica sozinho. Temos um *atendimento humanizado* no WhatsApp que vai te pegar pela mão e ajudar em tudo: analisar o laudo, negociar o valor, até a entrega do carro. 🤝`
  },
  
  frequencia: {
    keywords: ['frequencia', 'quantas ofertas', 'quando', 'todo dia', 'horário'],
    response: () => `Toda semana, de *Terça a Sábado*, o grupo ferve! 🔥\n\nSão mais de 40 novas oportunidades todos os dias pra você analisar.`
  }
};


// Detectar intenção (sem custo de IA)
function detectIntent(message) {
  const lowerMsg = message.toLowerCase().trim();
  
  for (const [intent, data] of Object.entries(AUTO_RESPONSES)) {
    if (data.keywords.some(keyword => lowerMsg.includes(keyword))) {
      return intent;
    }
  }
  
  // Detectar se está escolhendo produto (não se aplica mais tanto, mas mantemos)
  if (/^[1-3]$/.test(lowerMsg)) {
    return 'escolha_produto';
  }
  
  return null; // Não identificado = vai para IA
}

// Handler de escolha de produto
function handleProductSelection(choice, customerData = {}) {
  // Adaptado para produto único
  const product = PRODUCTS.vip;
  
  const name = customerData.firstName ? ` ${customerData.firstName}` : '';
  
  return `🎯 *${product.name}*${name}!\n\n` +
    `${product.description}\n\n` +
    `💰 Investimento: *R$ ${product.price}*\n` +
    `🔗 *Link de pagamento:*\n${product.link}\n\n` +
    `✅ Acesso liberado automaticamente após aprovação!\n` +
    `🛡️ Sem fidelidade - cancele quando quiser!\n\n` +
    `Qualquer dúvida, estou aqui! 😊`;
}

// Gerar resposta automática
function getAutoResponse(intent, customerData = {}, message = '') {
  if (intent === 'escolha_produto') {
    // Se digitou "1", "2" ou "3", apenas mande o link principal
    return handleProductSelection('1', customerData);
  }
  
  const responseData = AUTO_RESPONSES[intent];
  if (!responseData) return null;
  
  return responseData.response(customerData.firstName);
}

// ===== IA ECONÔMICA (só quando necessário) =====

// Prompt CURTO para economizar tokens (ATUALIZADO AUTOGIRO)
const AI_SYSTEM_PROMPT = `Você é um especialista em vendas da Autogiro. Seja breve, direto e confiável.

PRODUTO ÚNICO:
- Nome: Comunidade VIP Autogiro
- Preço: R$ 79,90/mês (Promocional)
- O que é: Acesso a 40+ ofertas diárias de carros/motos (até 40% abaixo da FIPE).
- NÃO É LEILÃO. É retomada de financiamento (fonte primária).
- É SEGURO. Tudo tem Laudo Cautelar antes da compra.
- NÃO TEM FIDELIDADE. Cancela quando quiser.

OBJETIVO: Tirar dúvidas e convencer o cliente a assinar.

REGRAS IMPORTANTES:
- Seja consultivo e gere confiança.
- Respostas curtas (máximo 3-4 linhas).
- Reforce sempre: "Não é leilão" e "Tem laudo cautelar".
- Se cliente estiver pronto para comprar, envie: [LINK_VIP]
- Use emojis de forma profissional (🚗, 🛡️, 💎, ✅, 💰).`;

// Chamar IA (APENAS quando necessário)
async function getAIResponse(customerPhone, customerMessage, customerData = {}) {
  try {
    console.log('💰 Chamando IA (custo estimado: $0.0001)');
    
    // Histórico CURTO (últimas 6 msgs = economia!)
    let history = database.aiConversations.get(customerPhone) || [];
    if (history.length > 6) {
      history = history.slice(-6);
    }

    // Contexto mínimo
    let context = customerData.firstName ? `Cliente: ${customerData.firstName}` : '';
    
    history.push({
      role: 'user',
      content: context ? `${context}\n${customerMessage}` : customerMessage
    });

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo', // 10x mais barato que GPT-4!
      messages: [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        ...history
      ],
      temperature: 0.7,
      max_tokens: 150, // Respostas curtas = economia
      presence_penalty: 0.3,
      frequency_penalty: 0.3
    });

    const aiResponse = completion.choices[0].message.content;
    
    history.push({
      role: 'assistant',
      content: aiResponse
    });

    database.aiConversations.set(customerPhone, history);

    // Substituir placeholders por links
    let response = aiResponse
      .replace(/\[LINK_VIP\]/g, PRODUCTS.vip.link)
      .replace(/\[LINK_CURSO\]/g, PRODUCTS.vip.link) // Fallback
      .replace(/\[LINK_MENTORIA\]/g, PRODUCTS.vip.link); // Fallback

    return response;

  } catch (error) {
    console.error('❌ Erro IA:', error.message);
    return 'Desculpe, tive um problema técnico. Pode repetir sua pergunta? 😅';
  }
}

// ===== ROTEADOR INTELIGENTE (decide: AUTO ou IA) =====
async function getSmartResponse(customerPhone, customerMessage, customerData = {}) {
  // 1. Tenta resposta automática PRIMEIRO (SEM CUSTO!)
  const intent = detectIntent(customerMessage);
  
  if (intent) {
    const autoResponse = getAutoResponse(intent, customerData, customerMessage);
    if (autoResponse) {
      console.log('✅ Resposta automática (custo: R$ 0,00)');
      return autoResponse;
    }
  }

  // 2. Se não achou, usa IA (COM CUSTO MÍNIMO)
  console.log('🤖 Usando IA para conversa...');
  return await getAIResponse(customerPhone, customerMessage, customerData);
}

// ===== HANDLER DE MENSAGENS =====
async function handleIncomingMessage(from, text, fullMessage) {
  try {
    const cleanPhone = from.replace('@s.whatsapp.net', '');
    
    // Rate limiting
    if (!checkRateLimit(cleanPhone)) {
      await sock.sendMessage(from, { 
        text: 'Por favor, aguarde um momento antes de enviar mais mensagens. 😊' 
      });
      return;
    }
    
    // Buscar dados do cliente
    let customerData = {};
    for (const customer of database.customers.values()) {
      if (customer.mobile && customer.mobile.replace(/\D/g, '').includes(cleanPhone)) {
        customerData = customer;
        break;
      }
    }

    console.log(`\n📨 Mensagem de ${customerData.firstName || cleanPhone}`);
    console.log(`💬 "${text}"`);

    // Marcar como digitando
    await sock.sendPresenceUpdate('composing', from);

    // Obter resposta inteligente
    const response = await getSmartResponse(cleanPhone, text, customerData);

    // Aguardar 1-2 segundos (parece humano)
    await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));

    // Enviar resposta
    await sock.sendMessage(from, { text: response });
    
    console.log(`✅ Respondido: "${response.substring(0, 50)}..."`);

    // Salvar conversa
    const conversation = database.conversations.get(from) || {
      phone: cleanPhone,
      messages: [],
      createdAt: new Date()
    };
    
    conversation.messages.push(
      { from: 'customer', text, timestamp: new Date() },
      { from: 'bot', text: response, timestamp: new Date() }
    );
    
    database.conversations.set(from, conversation);

  } catch (error) {
    console.error('❌ Erro ao responder:', error);
    try {
      await sock.sendMessage(from, { 
        text: 'Ops, tive um problema. Pode tentar de novo? 😅' 
      });
    } catch (e) {}
  }
}

// ===== CONECTAR WHATSAPP =====
async function connectToWhatsApp() {
  try {
    connectionAttempts++;
    console.log(`\n🔄 Conexão #${connectionAttempts}...`);
    
    if (connectionAttempts > MAX_ATTEMPTS) {
      console.log('⚠️ Limpando auth...');
      clearAuth();
      connectionAttempts = 0;
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    
    let version;
    try {
      const versionInfo = await fetchLatestBaileysVersion();
      version = versionInfo.version;
      console.log('📦 Baileys:', version.join('.'));
    } catch (error) {
      version = [2, 3000, 0];
    }

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: true,
      auth: state,
      browser: ['Robô Autogiro', 'Chrome', '1.0.0'],
      defaultQueryTimeoutMs: undefined,
      getMessage: async (key) => ({ conversation: '' })
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCode = qr;
        connectionAttempts = 0;
        try {
          qrCodeDataURL = await qrToDataURL(qr);
          console.log('\n✅ QR CODE GERADO');
          console.log('📱 http://localhost:' + PORT + '/qr\n');
        } catch (error) {
          console.error('❌ Erro QR:', error);
        }
      }

      if (connection === 'close') {
        isConnected = false;
        qrCode = null;
        qrCodeDataURL = null;
        
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (statusCode === DisconnectReason.loggedOut) {
          clearAuth();
        }

        if (shouldReconnect) {
          setTimeout(connectToWhatsApp, 3000);
        }
      } 
      else if (connection === 'open') {
        console.log('\n✅ WHATSAPP CONECTADO');
        console.log('📱', sock.user?.id);
        console.log('🤖 Bot IA Autogiro ativo!\n');
        
        isConnected = true;
        qrCode = null;
        qrCodeDataURL = null;
        connectionAttempts = 0;
      }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async ({ messages }) => {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const text = msg.message.conversation || 
                   msg.message.extendedTextMessage?.text || '';

      if (text) {
        await handleIncomingMessage(from, text, msg);
      }
    });

  } catch (error) {
    console.error('\n❌ Erro:', error);
    setTimeout(connectToWhatsApp, 5000);
  }
}

// ===== WEBHOOK FUNCTIONS =====
function verifySignature(body, signature) {
  const calculatedSignature = crypto
    .createHmac('sha1', WEBHOOK_SECRET)
    .update(JSON.stringify(body))
    .digest('hex');
  return signature === calculatedSignature;
}

function saveCustomer(customerData, orderData) {
  const customerId = customerData.email;
  const customer = {
    email: customerData.email,
    fullName: customerData.full_name,
    firstName: customerData.first_name,
    mobile: customerData.mobile,
    cpf: customerData.CPF,
    lastOrder: orderData.order_id,
    createdAt: database.customers.has(customerId) 
      ? database.customers.get(customerId).createdAt 
      : new Date(),
    updatedAt: new Date(),
    orders: [
      ...(database.customers.get(customerId)?.orders || []),
      orderData.order_id
    ]
  };
  database.customers.set(customerId, customer);
  return customer;
}

function saveOrder(orderData) {
  database.orders.set(orderData.order_id, {
    ...orderData,
    savedAt: new Date()
  });
}

// ATUALIZADO COM LINK DE SUPORTE
function generateMessage(eventType, customer, orderData) {
  const firstName = customer.firstName || 'Cliente';
  const productName = orderData.Product?.product_name || 'Comunidade VIP';
  
  // Link direto para o seu Robô de Suporte Autogiro
  const linkSuporte = 'https://wa.me/5512996232861'; 

  const messages = {
    order_approved: {
      text: `🎉 *Parabéns ${firstName}!*\n\n` +
        `Sua compra da *${productName}* foi aprovada!\n\n` +
        
        // 1. Link de Acesso à Plataforma (vem da Kiwify)
        `✅ *Acesse a plataforma aqui:*\n${orderData.access_url || 'Em breve você receberá o acesso por e-mail'}\n\n` + 
        
        `--- \n\n` +
        
        // 2. Link para o Robô de Suporte
        `🤖 *SUPORTE AUTOGIRO*\n` +
        `Agora, para qualquer dúvida sobre o produto ou sobre as ofertas, por favor, chame nosso *Robô de Suporte*.\n\n` +
        `*Acesse o link:*\n👉 ${linkSuporte}\n\n` +
        `Basta clicar e enviar um "Olá" para o nosso time de suporte! 👋`
    },
    abandoned_cart: {
      text: `Oi ${firstName}! 👋\n\n` +
        `Vi que você deixou *${productName}* no carrinho.\n\n` +
        `Posso te ajudar com alguma dúvida? 😊`
    }
  };
  return messages[eventType] || messages.order_approved;
}


async function sendWhatsAppMessage(phone, message) {
  try {
    if (!isConnected || !sock) {
      console.log('⚠️ WhatsApp não conectado');
      return false;
    }

    let formattedPhone = phone.replace(/[^\d]/g, '');
    if (!formattedPhone.startsWith('55')) {
      formattedPhone = '55' + formattedPhone;
    }
    const jid = formattedPhone + '@s.whatsapp.net';

    await sock.sendMessage(jid, { text: message });
    console.log(`✅ Enviado para ${phone}`);
    return true;
  } catch (error) {
    console.error(`❌ Erro envio:`, error.message);
    return false;
  }
}

async function startConversation(eventType, customer, orderData) {
  const messageData = generateMessage(eventType, customer, orderData);
  
  console.log('\n📱 NOVO EVENTO:', eventType);
  console.log('Cliente:', customer.fullName);
  
  if (customer.mobile && isConnected) {
    await sendWhatsAppMessage(customer.mobile, messageData.text);
  } else {
    console.log('⚠️ Telefone não disponível ou WhatsApp offline');
  }
}

// ===== ENDPOINTS =====
app.post('/webhook', async (req, res) => {
  try {
    const { signature } = req.query;
    
    if (!verifySignature(req.body, signature)) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
    
    const webhookData = req.body;
    const eventType = webhookData.webhook_event_type || 'order_approved';
    
    const customer = saveCustomer(webhookData.Customer, webhookData);
    saveOrder(webhookData);
    await startConversation(eventType, customer, webhookData);
    
    return res.status(200).json({ 
      status: 'ok',
      whatsapp_connected: isConnected
    });
  } catch (error) {
    console.error('❌ Webhook error:', error);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/qr', (req, res) => {
  if (qrCodeDataURL) {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>QR Code WhatsApp</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="refresh" content="5">
        <style>
          body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:linear-gradient(135deg,#25D366,#128C7E);margin:0}
          .container{background:#fff;padding:2rem;border-radius:20px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3)}
          h1{color:#25D366;margin-bottom:1rem}
          img{width:300px;height:300px;border-radius:10px}
          .timer{color:#666;margin-top:1rem;font-size:14px}
        </style>
      </head>
      <body>
        <div class="container">
          <h1>📱 QR Code WhatsApp</h1>
          <p>Escaneie com seu celular</p>
          <img src="${qrCodeDataURL}">
          <p class="timer">⏰ Atualizando em <span id="t">5</span>s</p>
        </div>
        <script>
          let s=5;setInterval(()=>{s--;document.getElementById('t').textContent=s;if(s<=0)location.reload()},1000);
        </script>
      </body>
      </html>
    `);
  } else if (isConnected) {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Conectado</title><meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:linear-gradient(135deg,#25D366,#128C7E);margin:0}.box{background:#fff;padding:3rem;border-radius:20px;text-align:center}h1{color:#25D366;font-size:2rem}.emoji{font-size:5rem}</style>
      </head>
      <body><div class="box"><div class="emoji">✅</div><h1>WhatsApp Conectado!</h1><p>Bot IA Autogiro ativo</p></div></body>
      </html>
    `);
  } else {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Aguardando...</title><meta http-equiv="refresh" content="2"><meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:linear-gradient(135deg,#667eea,#764ba2);margin:0}.box{background:#fff;padding:3rem;border-radius:20px;text-align:center}.spinner{border:4px solid #f3f3f3;border-top:4px solid #667eea;border-radius:50%;width:50px;height:50px;animation:spin 1s linear infinite;margin:2rem auto}@keyframes spin{100%{transform:rotate(360deg)}}</style>
      </head>
      <body><div class="box"><h1>⏳ Gerando QR...</h1><div class="spinner"></div></div></body>
      </html>
    `);
  }
});

app.post('/clear-auth', (req, res) => {
  clearAuth();
  res.json({ success: true, message: 'Auth limpa com sucesso' });
});

app.get('/status', (req, res) => {
  res.json({
    whatsapp_connected: isConnected,
    customers: database.customers.size,
    conversations: database.conversations.size,
    ai_conversations: database.aiConversations.size,
    uptime: process.uptime()
  });
});

app.get('/stats', (req, res) => {
  let totalMsgs = 0;
  let aiMsgs = 0;
  
  for (const conv of database.aiConversations.values()) {
    aiMsgs += conv.length;
  }
  
  for (const conv of database.conversations.values()) {
    totalMsgs += conv.messages?.length || 0;
  }
  
  const autoMsgs = totalMsgs - aiMsgs;
  const savings = totalMsgs > 0 ? (autoMsgs / totalMsgs * 100).toFixed(1) : '0.0';
  
  res.json({
    total_messages: totalMsgs,
    auto_responses: autoMsgs,
    ai_responses: aiMsgs,
    cost_savings: `${savings}%`,
    estimated_cost: `${(aiMsgs * 0.0001).toFixed(4)}`, // Custo estimado baixo
    customers_count: database.customers.size
  });
});

app.get('/conversations', (req, res) => {
  const convList = [];
  for (const [phone, conv] of database.conversations.entries()) {
    convList.push({
      phone: conv.phone,
      message_count: conv.messages?.length || 0,
      last_message: conv.messages?.[conv.messages.length - 1]?.timestamp || null
    });
  }
  res.json({ conversations: convList });
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Robô IA Autogiro</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;padding:2rem}
        .container{max-width:800px;margin:0 auto;background:#fff;border-radius:20px;padding:2rem;box-shadow:0 10px 30px rgba(0,0,0,.3)}
        h1{color:#333;margin-bottom:1rem}
        .status{background:#f5f5f5;padding:1rem;border-radius:10px;margin:1rem 0}
        .item{display:flex;justify-content:space-between;padding:.5rem 0;border-bottom:1px solid #ddd}
        .item:last-child{border:none}
        .badge{padding:.25rem .75rem;border-radius:20px;font-size:.875rem}
        .success{background:#4caf50;color:#fff}
        .danger{background:#f44336;color:#fff}
        .links{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1rem;margin-top:2rem}
        a{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;padding:1.5rem;border-radius:12px;text-decoration:none;text-align:center;display:block;transition:transform .2s}
        a:hover{transform:translateY(-5px)}
        .info{background:#e3f2fd;padding:1rem;border-radius:10px;margin-top:1rem;font-size:.875rem}
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🤖 Robô IA Autogiro</h1>
        <p>Sistema híbrido: Respostas automáticas + IA conversacional</p>
        
        <div class="status">
          <div class="item">
            <span>WhatsApp</span>
            <span class="badge ${isConnected ? 'success' : 'danger'}">
              ${isConnected ? '✅ Online' : '❌ Offline'}
            </span>
          </div>
          <div class="item">
            <span>Clientes</span>
            <span>${database.customers.size}</span>
          </div>
          <div class="item">
            <span>Conversas IA</span>
            <span>${database.aiConversations.size}</span>
          </div>
          <div class="item">
            <span>Conversas Total</span>
            <span>${database.conversations.size}</span>
          </div>
        </div>
        
        <div class="info">
          <strong>💡 Como funciona:</strong><br>
          • Respostas automáticas para perguntas comuns (GRÁTIS)<br>
          • IA conversacional para dúvidas complexas (custo mínimo)<br>
          • Sistema econômico com gpt-3.5-turbo
        </div>
        
        <div class="links">
          <a href="/qr">📱 Conectar</a>
          <a href="/status">📊 Status</a>
          <a href="/stats">💰 Economia</a>
          <a href="/conversations">💬 Conversas</a>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Carregar database ao iniciar
loadDatabase();

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║    🤖 ROBÔ IA AUTOGIRO - ECONÔMICO   ║
  ╚══════════════════════════════════════╝
  
  📡 Servidor: http://localhost:${PORT}
  📱 QR Code: http://localhost:${PORT}/qr
  💰 Stats: http://localhost:${PORT}/stats
  💬 Conversas: http://localhost:${PORT}/conversations
  
  💡 ESTRATÉGIA DE ECONOMIA:
  ✅ Respostas automáticas (grátis)
  ✅ IA apenas quando necessário
  ✅ gpt-3.5-turbo (10x mais barato)
  ✅ Histórico curto (economia de tokens)
  ✅ Rate limiting (10 msgs/min)
  ✅ Persistência em arquivo JSON
  
  🚀 PRONTO PARA USO!
  `);
  
  // Conectar ao WhatsApp
  connectToWhatsApp();
});
