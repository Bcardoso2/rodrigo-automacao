// server.js - CORRIGIDO PARA EXIBIR QR NO FRONT
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
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurações
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'YOUR_SECRET_TOKEN';
const AUTH_FOLDER = './baileys_auth';

// Garantir que a pasta existe
if (!fs.existsSync(AUTH_FOLDER)) {
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
}

// Estado do WhatsApp - IMPORTANTE: qrCode agora armazena como data URL
let sock = null;
let qrCode = null;
let qrCodeDataURL = null; // NOVO: para o front-end
let isConnected = false;
let connectionAttempts = 0;
const MAX_ATTEMPTS = 3;

// Banco de dados
const database = {
  customers: new Map(),
  orders: new Map(),
  conversations: new Map()
};

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// Logger
const logger = pino({ level: 'info' });

// Função para converter QR em Data URL
function qrToDataURL(qr) {
  // O QR vem como string, vamos usar a biblioteca qrcode para converter
  const QRCode = require('qrcode');
  return new Promise((resolve, reject) => {
    QRCode.toDataURL(qr, { width: 300, margin: 2 }, (err, url) => {
      if (err) reject(err);
      else resolve(url);
    });
  });
}

// Limpar auth
function clearAuth() {
  try {
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      fs.mkdirSync(AUTH_FOLDER, { recursive: true });
      console.log('🧹 Autenticação limpa');
    }
  } catch (error) {
    console.error('❌ Erro ao limpar auth:', error);
  }
}

// Conectar ao WhatsApp
async function connectToWhatsApp() {
  try {
    connectionAttempts++;
    
    console.log(`\n🔄 Tentativa de conexão #${connectionAttempts}...`);
    
    if (connectionAttempts > MAX_ATTEMPTS) {
      console.log('⚠️ Muitas tentativas. Limpando auth...');
      clearAuth();
      connectionAttempts = 0;
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    
    let version;
    try {
      const versionInfo = await fetchLatestBaileysVersion();
      version = versionInfo.version;
      console.log('📦 Versão Baileys:', version.join('.'));
    } catch (error) {
      console.log('⚠️ Usando versão padrão');
      version = [2, 3000, 0];
    }

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: true,
      auth: state,
      browser: ['Robô Atendimento', 'Chrome', '1.0.0'],
      defaultQueryTimeoutMs: undefined,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 250,
      markOnlineOnConnect: true,
      syncFullHistory: false,
      getMessage: async (key) => ({ conversation: '' })
    });

    // EVENTO DE CONEXÃO
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // QR CODE GERADO - AGORA CONVERTE PARA DATA URL
      if (qr) {
        qrCode = qr;
        connectionAttempts = 0;
        
        // CONVERTER QR PARA DATA URL (base64) para exibir no HTML
        try {
          qrCodeDataURL = await qrToDataURL(qr);
          console.log('\n✅ ===== QR CODE GERADO =====');
          console.log('📱 Acesse: http://localhost:' + PORT + '/qr');
          console.log('⏰ QR expira em 60 segundos');
          console.log('🔄 Novo QR será gerado automaticamente\n');
        } catch (error) {
          console.error('❌ Erro ao converter QR:', error);
        }
      }

      if (connection === 'close') {
        isConnected = false;
        qrCode = null;
        qrCodeDataURL = null;
        
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log('\n❌ Conexão fechada');
        console.log('Código:', statusCode);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('⚠️ Deslogado. Limpando credenciais...');
          clearAuth();
        }

        if (shouldReconnect) {
          console.log('🔄 Reconectando em 3 segundos...\n');
          setTimeout(connectToWhatsApp, 3000);
        }
      } 
      else if (connection === 'connecting') {
        console.log('🔄 Conectando...');
      }
      else if (connection === 'open') {
        console.log('\n✅ ===== WHATSAPP CONECTADO =====');
        console.log('🎉 Bot funcionando!');
        console.log('📱 Número:', sock.user?.id);
        console.log('================================\n');
        
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

      console.log(`📩 Mensagem de ${from}: ${text}`);
      await handleIncomingMessage(from, text, msg);
    });

  } catch (error) {
    console.error('\n❌ ERRO:', error);
    console.log('🔄 Nova tentativa em 5 segundos...\n');
    setTimeout(connectToWhatsApp, 5000);
  }
}

// Enviar mensagem
async function sendWhatsAppMessage(phone, message) {
  try {
    if (!isConnected || !sock) {
      console.error('❌ WhatsApp não conectado!');
      return false;
    }

    let formattedPhone = phone.replace(/[^\d]/g, '');
    if (!formattedPhone.startsWith('55')) {
      formattedPhone = '55' + formattedPhone;
    }
    const jid = formattedPhone + '@s.whatsapp.net';

    await sock.sendMessage(jid, { text: message });
    console.log(`✅ Mensagem enviada para ${phone}`);
    return true;
  } catch (error) {
    console.error(`❌ Erro ao enviar para ${phone}:`, error);
    return false;
  }
}

// Handler de mensagens
async function handleIncomingMessage(from, text, fullMessage) {
  const lowerText = text.toLowerCase().trim();

  if (lowerText === 'menu' || lowerText === 'ajuda') {
    const menuMessage = `*🤖 Menu de Atendimento*\n\n` +
      `1️⃣ *status* - Verificar status do pedido\n` +
      `2️⃣ *produtos* - Ver produtos disponíveis\n` +
      `3️⃣ *suporte* - Falar com atendente\n` +
      `4️⃣ *acesso* - Reenviar link de acesso\n\n` +
      `Digite a palavra-chave desejada.`;
    await sock.sendMessage(from, { text: menuMessage });
  }
  else if (lowerText.includes('status')) {
    await sock.sendMessage(from, { 
      text: '🔍 Verificando seu pedido...' 
    });
  }
  else if (lowerText.includes('produtos')) {
    await sock.sendMessage(from, { 
      text: '📦 Nossos produtos:\n\n1. Curso - R$ 197\n2. Mentoria - R$ 497\n3. VIP - R$ 997' 
    });
  }
  else if (lowerText.includes('suporte')) {
    await sock.sendMessage(from, { 
      text: '👤 Transferindo para atendente...' 
    });
  }
  else {
    await sock.sendMessage(from, { 
      text: `Olá! 👋\n\nRecebemos: "${text}"\n\nDigite *menu* para opções.` 
    });
  }
}

// Webhook functions
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
    country: customerData.country,
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

function generateMessage(eventType, customer, orderData) {
  const firstName = customer.firstName || 'Cliente';
  const productName = orderData.Product?.product_name || 'Produto';
  
  const messages = {
    order_approved: {
      text: `🎉 *Parabéns ${firstName}!*\n\n` +
        `Sua compra foi aprovada!\n\n` +
        `📦 *Produto:* ${productName}\n` +
        `🔖 *Pedido:* ${orderData.order_ref}\n\n` +
        `Acesso: ${orderData.access_url}`,
      actions: ['boas_vindas']
    }
  };
  return messages[eventType] || messages.order_approved;
}

async function startConversation(eventType, customer, orderData) {
  const conversationId = `${customer.email}_${Date.now()}`;
  const messageData = generateMessage(eventType, customer, orderData);
  
  const conversation = {
    id: conversationId,
    customer: customer.email,
    phone: customer.mobile,
    eventType,
    orderId: orderData.order_id,
    initialMessage: messageData.text,
    status: 'pending',
    createdAt: new Date(),
    messages: [{
      from: 'bot',
      text: messageData.text,
      timestamp: new Date()
    }]
  };
  
  database.conversations.set(conversationId, conversation);
  
  console.log('\n📱 NOVA CONVERSA:');
  console.log('Cliente:', customer.fullName);
  console.log('Telefone:', customer.mobile);
  
  if (customer.mobile && isConnected) {
    const sent = await sendWhatsAppMessage(customer.mobile, messageData.text);
    conversation.whatsappSent = sent;
    if (sent) console.log('✅ Mensagem enviada');
  }
  
  return conversation;
}

// ENDPOINTS

app.post('/webhook', async (req, res) => {
  try {
    const { signature } = req.query;
    
    if (!verifySignature(req.body, signature)) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
    
    const webhookData = req.body;
    const eventType = webhookData.webhook_event_type || 'order_approved';
    
    console.log(`\n🔔 Webhook: ${eventType}`);
    
    const customer = saveCustomer(webhookData.Customer, webhookData);
    saveOrder(webhookData);
    await startConversation(eventType, customer, webhookData);
    
    return res.status(200).json({ 
      status: 'ok',
      whatsapp_connected: isConnected
    });
  } catch (error) {
    console.error('❌ Erro:', error);
    return res.status(500).json({ error: error.message });
  }
});

// ENDPOINT QR CODE - CORRIGIDO PARA USAR DATA URL
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
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
            padding: 20px;
          }
          .container {
            background: white;
            padding: 2.5rem;
            border-radius: 24px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
            max-width: 450px;
            width: 100%;
            animation: slideUp 0.4s ease;
          }
          @keyframes slideUp {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
          }
          h1 {
            color: #25D366;
            font-size: 1.8rem;
            margin-bottom: 0.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
          }
          .subtitle {
            color: #666;
            margin-bottom: 2rem;
            font-size: 0.95rem;
          }
          .qr-wrapper {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 16px;
            margin: 1.5rem 0;
            display: inline-block;
          }
          .qr-wrapper img {
            display: block;
            width: 280px;
            height: 280px;
            border-radius: 8px;
          }
          .status {
            background: linear-gradient(135deg, #4caf50 0%, #45a049 100%);
            color: white;
            padding: 12px 20px;
            border-radius: 12px;
            font-weight: 600;
            margin: 1.5rem 0;
            display: inline-block;
            box-shadow: 0 4px 12px rgba(76, 175, 80, 0.3);
          }
          .instructions {
            background: #f8f9fa;
            padding: 1.5rem;
            border-radius: 12px;
            text-align: left;
            margin-top: 1.5rem;
          }
          .instructions h3 {
            color: #333;
            font-size: 1rem;
            margin-bottom: 1rem;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .instructions ol {
            margin: 0;
            padding-left: 1.5rem;
            color: #555;
          }
          .instructions li {
            margin: 0.75rem 0;
            line-height: 1.5;
          }
          .timer {
            color: #888;
            font-size: 0.9rem;
            margin-top: 1.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
          }
          .countdown {
            font-weight: 700;
            color: #25D366;
            font-size: 1.1rem;
          }
          @media (max-width: 480px) {
            .container { padding: 1.5rem; }
            h1 { font-size: 1.5rem; }
            .qr-wrapper img { width: 240px; height: 240px; }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>
            <span>📱</span>
            Conectar WhatsApp
          </h1>
          <p class="subtitle">Escaneie o QR Code com seu celular</p>
          
          <div class="qr-wrapper">
            <img src="${qrCodeDataURL}" alt="QR Code WhatsApp">
          </div>
          
          <div class="status">✅ QR Code Ativo</div>
          
          <div class="instructions">
            <h3>📋 Como conectar:</h3>
            <ol>
              <li>Abra o <strong>WhatsApp</strong> no celular</li>
              <li>Toque em <strong>Menu (⋮)</strong> ou <strong>Configurações</strong></li>
              <li>Toque em <strong>Aparelhos conectados</strong></li>
              <li>Toque em <strong>"Conectar um aparelho"</strong></li>
              <li>Aponte a câmera para este QR Code</li>
            </ol>
          </div>
          
          <div class="timer">
            ⏰ Atualizando em <span class="countdown" id="countdown">5</span>s
          </div>
        </div>
        
        <script>
          let seconds = 5;
          const countdownEl = document.getElementById('countdown');
          const interval = setInterval(() => {
            seconds--;
            countdownEl.textContent = seconds;
            if (seconds <= 0) {
              clearInterval(interval);
              location.reload();
            }
          }, 1000);
        </script>
      </body>
      </html>
    `);
  } 
  else if (isConnected) {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>WhatsApp Conectado</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
          }
          .container {
            background: white;
            padding: 3rem;
            border-radius: 24px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
            animation: bounce 2s ease infinite;
          }
          @keyframes bounce {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-10px); }
          }
          .emoji { font-size: 5rem; margin-bottom: 1rem; }
          h1 { color: #25D366; font-size: 2rem; margin-bottom: 1rem; }
          p { color: #666; font-size: 1.1rem; }
          .status-badge {
            background: #4caf50;
            color: white;
            padding: 8px 20px;
            border-radius: 20px;
            display: inline-block;
            margin-top: 1.5rem;
            font-weight: 600;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="emoji">✅</div>
          <h1>WhatsApp Conectado!</h1>
          <p>Seu robô está ativo e funcionando.</p>
          <div class="status-badge">🟢 Online</div>
        </div>
      </body>
      </html>
    `);
  } 
  else {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Gerando QR Code...</title>
        <meta http-equiv="refresh" content="2">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          }
          .container {
            background: white;
            padding: 3rem;
            border-radius: 24px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
          }
          h1 { color: #333; margin-bottom: 1.5rem; }
          .spinner {
            border: 4px solid #f3f3f3;
            border-top: 4px solid #667eea;
            border-radius: 50%;
            width: 60px;
            height: 60px;
            animation: spin 1s linear infinite;
            margin: 2rem auto;
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
          .attempt { color: #999; font-size: 0.9rem; margin-top: 1rem; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>⏳ Gerando QR Code...</h1>
          <div class="spinner"></div>
          <p>Aguarde enquanto iniciamos a conexão</p>
          <p class="attempt">Tentativa ${connectionAttempts}/${MAX_ATTEMPTS}</p>
        </div>
      </body>
      </html>
    `);
  }
});

app.post('/clear-auth', (req, res) => {
  clearAuth();
  res.json({ success: true, message: 'Auth limpa' });
});

app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    whatsapp: {
      connected: isConnected,
      hasQrCode: !!qrCodeDataURL,
      attempts: connectionAttempts
    },
    database: {
      customers: database.customers.size,
      orders: database.orders.size,
      conversations: database.conversations.size
    },
    uptime: process.uptime()
  });
});

app.get('/customers', (req, res) => {
  const customers = Array.from(database.customers.values());
  res.json({ total: customers.length, customers });
});

app.get('/conversations', (req, res) => {
  const conversations = Array.from(database.conversations.values());
  res.json({ total: conversations.length, conversations });
});

app.head('/webhook', (req, res) => res.status(200).send());
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Robô WhatsApp</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          padding: 2rem;
        }
        .container {
          max-width: 800px;
          margin: 0 auto;
          background: white;
          border-radius: 20px;
          padding: 2rem;
          box-shadow: 0 10px 30px rgba(0,0,0,0.3);
        }
        h1 { color: #333; margin-bottom: 1rem; }
        .status-card {
          background: #f5f5f5;
          padding: 1rem;
          border-radius: 10px;
          margin: 1rem 0;
        }
        .status-item {
          display: flex;
          justify-content: space-between;
          padding: 0.5rem 0;
          border-bottom: 1px solid #ddd;
        }
        .status-item:last-child { border-bottom: none; }
        .badge {
          padding: 0.25rem 0.75rem;
          border-radius: 20px;
          font-size: 0.875rem;
        }
        .badge.success { background: #4caf50; color: white; }
        .badge.danger { background: #f44336; color: white; }
        .links {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 1rem;
          margin-top: 2rem;
        }
        .link-card {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 1.5rem;
          border-radius: 12px;
          text-decoration: none;
          text-align: center;
          transition: transform 0.2s;
        }
        .link-card:hover { transform: translateY(-5px); }
        .link-card h3 { font-size: 2rem; margin-bottom: 0.5rem; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🤖 Robô de Atendimento WhatsApp</h1>
        <p>Sistema ativo!</p>
        
        <div class="status-card">
          <h3>📊 Status</h3>
          <div class="status-item">
            <span>WhatsApp</span>
            <span class="badge ${isConnected ? 'success' : 'danger'}">
              ${isConnected ? '✅ Conectado' : '❌ Desconectado'}
            </span>
          </div>
          <div class="status-item">
            <span>Clientes</span>
            <span>${database.customers.size}</span>
          </div>
          <div class="status-item">
            <span>Conversas</span>
            <span>${database.conversations.size}</span>
          </div>
        </div>
        
        <div class="links">
          <a href="/qr" class="link-card">
            <h3>📱</h3>
            <p>Conectar WhatsApp</p>
          </a>
          <a href="/status" class="link-card">
            <h3>📊</h3>
            <p>Status</p>
          </a>
          <a href="/customers" class="link-card">
            <h3>👥</h3>
            <p>Clientes</p>
          </a>
          <a href="/conversations" class="link-card">
            <h3>💬</h3>
            <p>Conversas</p>
          </a>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Iniciar
app.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════════╗
  ║   🤖 ROBÔ DE ATENDIMENTO WHATSAPP     ║
  ╚════════════════════════════════════════╝
  
  📡 Servidor: http://localhost:${PORT}
  📱 QR Code: http://localhost:${PORT}/qr
  
  ⏳ Iniciando WhatsApp...
  `);
  
  connectToWhatsApp();
});

process.on('uncaughtException', (error) => {
  console.error('❌ Erro:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Promise rejeitada:', error);
});
