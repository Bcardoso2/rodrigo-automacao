// server.js
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

// Garantir que a pasta de autenticação existe
if (!fs.existsSync(AUTH_FOLDER)) {
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
}

// Estado do WhatsApp
let sock = null;
let qrCode = null;
let isConnected = false;

// Banco de dados em memória (use MongoDB/PostgreSQL em produção)
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

// Função para conectar ao WhatsApp
async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: true,
      auth: state,
      defaultQueryTimeoutMs: undefined,
    });

    // Evento de atualização de conexão
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCode = qr;
        console.log('\n📱 QR Code gerado! Acesse /qr para escanear\n');
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error instanceof Boom) &&
          lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;

        console.log('❌ Conexão fechada. Reconectando...', shouldReconnect);
        isConnected = false;

        if (shouldReconnect) {
          await connectToWhatsApp();
        }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp conectado com sucesso!');
        isConnected = true;
        qrCode = null;
      }
    });

    // Salvar credenciais quando atualizadas
    sock.ev.on('creds.update', saveCreds);

    // Evento de mensagens recebidas
    sock.ev.on('messages.upsert', async ({ messages }) => {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const text = msg.message.conversation || 
                   msg.message.extendedTextMessage?.text || '';

      console.log(`📩 Mensagem recebida de ${from}: ${text}`);

      // Aqui você pode adicionar lógica de resposta automática
      await handleIncomingMessage(from, text, msg);
    });

  } catch (error) {
    console.error('❌ Erro ao conectar WhatsApp:', error);
    setTimeout(connectToWhatsApp, 5000);
  }
}

// Função para enviar mensagem no WhatsApp
async function sendWhatsAppMessage(phone, message) {
  try {
    if (!isConnected || !sock) {
      console.error('❌ WhatsApp não está conectado!');
      return false;
    }

    // Formatar número (adicionar @s.whatsapp.net se necessário)
    let formattedPhone = phone.replace(/[^\d]/g, '');
    
    // Adicionar código do país se não tiver
    if (!formattedPhone.startsWith('55')) {
      formattedPhone = '55' + formattedPhone;
    }
    
    const jid = formattedPhone + '@s.whatsapp.net';

    await sock.sendMessage(jid, { text: message });
    console.log(`✅ Mensagem enviada para ${phone}`);
    return true;

  } catch (error) {
    console.error(`❌ Erro ao enviar mensagem para ${phone}:`, error);
    return false;
  }
}

// Função para lidar com mensagens recebidas
async function handleIncomingMessage(from, text, fullMessage) {
  const lowerText = text.toLowerCase().trim();

  // Comandos básicos
  if (lowerText === 'menu' || lowerText === 'ajuda') {
    const menuMessage = `*🤖 Menu de Atendimento*\n\n` +
      `1️⃣ *status* - Verificar status do pedido\n` +
      `2️⃣ *produtos* - Ver produtos disponíveis\n` +
      `3️⃣ *suporte* - Falar com atendente\n` +
      `4️⃣ *acesso* - Reenviar link de acesso\n\n` +
      `Digite o número ou palavra-chave desejada.`;
    
    await sock.sendMessage(from, { text: menuMessage });
  }
  else if (lowerText.includes('status')) {
    await sock.sendMessage(from, { 
      text: '🔍 Verificando seu pedido, aguarde um momento...' 
    });
    // Aqui você buscaria no banco de dados
  }
  else if (lowerText.includes('produtos')) {
    await sock.sendMessage(from, { 
      text: '📦 Nossos produtos:\n\n1. Curso Completo - R$ 197\n2. Mentoria - R$ 497\n3. Pacote VIP - R$ 997' 
    });
  }
  else if (lowerText.includes('suporte')) {
    await sock.sendMessage(from, { 
      text: '👤 Você será transferido para um atendente humano em breve!' 
    });
  }
  else {
    // Resposta padrão
    await sock.sendMessage(from, { 
      text: `Olá! 👋\n\nRecebemos sua mensagem: "${text}"\n\nDigite *menu* para ver as opções disponíveis.` 
    });
  }
}

// Verificar assinatura do webhook
function verifySignature(body, signature) {
  const calculatedSignature = crypto
    .createHmac('sha1', WEBHOOK_SECRET)
    .update(JSON.stringify(body))
    .digest('hex');
  
  return signature === calculatedSignature;
}

// Salvar cliente
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

// Salvar pedido
function saveOrder(orderData) {
  database.orders.set(orderData.order_id, {
    ...orderData,
    savedAt: new Date()
  });
}

// Gerar mensagem personalizada por evento
function generateMessage(eventType, customer, orderData) {
  const firstName = customer.firstName || 'Cliente';
  const productName = orderData.Product?.product_name || 'Produto';
  
  const messages = {
    abandoned_cart: {
      text: `Olá ${firstName}! 👋\n\n` +
        `Vi que você deixou o *${productName}* no carrinho.\n\n` +
        `Posso te ajudar a finalizar sua compra? 😊\n` +
        `Se tiver alguma dúvida sobre o produto, estou aqui!\n\n` +
        `_Digite *sim* para continuar ou *duvida* se tiver perguntas._`,
      actions: ['oferecer_desconto', 'responder_duvidas']
    },
    
    order_approved: {
      text: `🎉 *Parabéns ${firstName}!*\n\n` +
        `Sua compra foi *aprovada com sucesso*!\n\n` +
        `📦 *Produto:* ${productName}\n` +
        `🔖 *Pedido:* ${orderData.order_ref}\n\n` +
        `✅ Você já pode acessar clicando aqui:\n` +
        `${orderData.access_url}\n\n` +
        `Precisa de ajuda? Digite *ajuda* a qualquer momento!`,
      actions: ['enviar_boas_vindas', 'tutorial']
    },
    
    pix_created: {
      text: `Olá ${firstName}! 😊\n\n` +
        `Seu *PIX* foi gerado com sucesso!\n\n` +
        `📦 *Produto:* ${productName}\n` +
        `⏰ *Válido até:* ${orderData.pix_expiration}\n\n` +
        `🔑 *Código PIX:*\n\`\`\`${orderData.pix_code}\`\`\`\n\n` +
        `Após o pagamento, você receberá acesso *imediatamente*! ⚡`,
      actions: ['acompanhar_pagamento']
    },
    
    billet_created: {
      text: `Olá ${firstName}! 📃\n\n` +
        `Seu *boleto* foi gerado!\n\n` +
        `📦 *Produto:* ${productName}\n` +
        `📅 *Vencimento:* ${orderData.boleto_expiry_date}\n\n` +
        `🔗 *Link do boleto:*\n${orderData.boleto_URL}\n\n` +
        `📊 *Código de barras:*\n\`${orderData.boleto_barcode}\`\n\n` +
        `Posso te ajudar com algo? Digite *ajuda*`,
      actions: ['lembrete_vencimento']
    },
    
    order_rejected: {
      text: `Olá ${firstName}! 😕\n\n` +
        `Infelizmente seu pagamento *não foi aprovado*.\n\n` +
        `❌ *Motivo:* ${orderData.card_rejection_reason || 'Não especificado'}\n\n` +
        `Mas não se preocupe! Posso te ajudar:\n\n` +
        `1️⃣ Tentar outro cartão\n` +
        `2️⃣ Pagar com PIX (desconto!)\n` +
        `3️⃣ Parcelar no boleto\n\n` +
        `Digite o *número* da opção desejada.`,
      actions: ['oferecer_alternativas']
    },
    
    subscription_renewed: {
      text: `Olá ${firstName}! 🔄\n\n` +
        `Sua assinatura de *${productName}* foi renovada com sucesso!\n\n` +
        `💳 *Valor:* R$ ${(orderData.Commissions.charge_amount / 100).toFixed(2)}\n` +
        `📅 *Próxima cobrança:* ${orderData.Subscription?.next_payment}\n\n` +
        `Obrigado por continuar conosco! ❤️`,
      actions: ['agradecer']
    },
    
    subscription_canceled: {
      text: `Olá ${firstName}! 😢\n\n` +
        `Sua assinatura de *${productName}* foi cancelada.\n\n` +
        `Sentiremos muito sua falta!\n\n` +
        `Pode me contar o motivo? Gostaríamos de melhorar!\n\n` +
        `_Sua opinião é muito importante para nós._`,
      actions: ['feedback', 'reativacao']
    },
    
    subscription_late: {
      text: `Olá ${firstName}! ⚠️\n\n` +
        `Detectamos um problema no pagamento da sua assinatura de *${productName}*.\n\n` +
        `Para não perder o acesso, você pode:\n\n` +
        `1️⃣ Atualizar forma de pagamento\n` +
        `2️⃣ Pagar com PIX\n` +
        `3️⃣ Falar com suporte\n\n` +
        `Digite o *número* da opção.`,
      actions: ['recuperar_pagamento']
    }
  };
  
  return messages[eventType] || messages.order_approved;
}

// Iniciar conversa automática via WhatsApp
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
    suggestedActions: messageData.actions,
    status: 'pending',
    createdAt: new Date(),
    messages: [
      {
        from: 'bot',
        text: messageData.text,
        timestamp: new Date()
      }
    ]
  };
  
  database.conversations.set(conversationId, conversation);
  
  console.log('\n📱 NOVA CONVERSA INICIADA:');
  console.log('Cliente:', customer.fullName);
  console.log('Email:', customer.email);
  console.log('Telefone:', customer.mobile);
  console.log('Evento:', eventType);
  
  // Enviar mensagem via WhatsApp
  if (customer.mobile && isConnected) {
    const sent = await sendWhatsAppMessage(customer.mobile, messageData.text);
    conversation.whatsappSent = sent;
    conversation.whatsappSentAt = new Date();
    
    if (sent) {
      console.log('✅ Mensagem enviada via WhatsApp');
    } else {
      console.log('❌ Falha ao enviar via WhatsApp');
    }
  } else if (!customer.mobile) {
    console.log('⚠️ Cliente sem telefone cadastrado');
  } else if (!isConnected) {
    console.log('⚠️ WhatsApp desconectado');
  }
  
  console.log('-----------------------------------\n');
  
  return conversation;
}

// Endpoint principal do webhook
app.post('/webhook', async (req, res) => {
  try {
    const { signature } = req.query;
    
    if (!verifySignature(req.body, signature)) {
      console.error('❌ Assinatura inválida!');
      return res.status(400).json({ error: 'Invalid signature' });
    }
    
    const webhookData = req.body;
    const eventType = webhookData.webhook_event_type || 'abandoned_cart';
    
    console.log(`\n🔔 Webhook recebido: ${eventType}`);
    console.log(`Pedido: ${webhookData.order_ref}`);
    console.log(`Cliente: ${webhookData.Customer.email}`);
    
    const customer = saveCustomer(webhookData.Customer, webhookData);
    console.log('✅ Cliente salvo/atualizado');
    
    saveOrder(webhookData);
    console.log('✅ Pedido salvo');
    
    await startConversation(eventType, customer, webhookData);
    
    return res.status(200).json({ 
      status: 'ok',
      message: 'Webhook processado',
      whatsapp_connected: isConnected
    });
    
  } catch (error) {
    console.error('❌ Erro:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Endpoint para QR Code
app.get('/qr', (req, res) => {
  if (qrCode) {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>QR Code WhatsApp</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body {
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          }
          .container {
            background: white;
            padding: 2rem;
            border-radius: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
            text-align: center;
          }
          h1 { color: #25D366; margin-bottom: 1rem; }
          p { color: #666; margin-bottom: 2rem; }
          #qr { margin: 2rem 0; }
          .status { 
            background: #e8f5e9; 
            color: #2e7d32; 
            padding: 0.5rem 1rem; 
            border-radius: 5px;
            margin-top: 1rem;
          }
        </style>
        <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js"></script>
      </head>
      <body>
        <div class="container">
          <h1>📱 Conectar WhatsApp</h1>
          <p>Escaneie o QR Code abaixo com seu WhatsApp</p>
          <div id="qr"></div>
          <div class="status">✅ QR Code gerado com sucesso!</div>
          <p style="font-size: 12px; color: #999; margin-top: 1rem;">
            Esta página será atualizada automaticamente a cada 5 segundos
          </p>
        </div>
        <script>
          const qrText = ${JSON.stringify(qrCode)};
          QRCode.toCanvas(
            document.getElementById('qr'),
            qrText,
            { width: 300, margin: 2 },
            (error) => {
              if (error) console.error(error);
            }
          );
          setTimeout(() => location.reload(), 5000);
        </script>
      </body>
      </html>
    `);
  } else if (isConnected) {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>WhatsApp Conectado</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body {
            font-family: Arial, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          }
          .container {
            background: white;
            padding: 3rem;
            border-radius: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
            text-align: center;
          }
          h1 { color: #25D366; margin-bottom: 1rem; }
          .emoji { font-size: 4rem; margin: 1rem 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="emoji">✅</div>
          <h1>WhatsApp Conectado!</h1>
          <p>Seu robô está funcionando perfeitamente.</p>
        </div>
      </body>
      </html>
    `);
  } else {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Aguardando QR Code</title>
        <meta http-equiv="refresh" content="3">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body {
            font-family: Arial, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          }
          .container {
            background: white;
            padding: 3rem;
            border-radius: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
            text-align: center;
          }
          .spinner {
            border: 4px solid #f3f3f3;
            border-top: 4px solid #25D366;
            border-radius: 50%;
            width: 50px;
            height: 50px;
            animation: spin 1s linear infinite;
            margin: 2rem auto;
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>⏳ Gerando QR Code...</h1>
          <div class="spinner"></div>
          <p>Aguarde enquanto preparamos a conexão</p>
        </div>
      </body>
      </html>
    `);
  }
});

// Status do sistema
app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    whatsapp: {
      connected: isConnected,
      hasQrCode: !!qrCode
    },
    database: {
      customers: database.customers.size,
      orders: database.orders.size,
      conversations: database.conversations.size
    },
    uptime: process.uptime(),
    timestamp: new Date()
  });
});

// Demais endpoints...
app.get('/customers', (req, res) => {
  const customers = Array.from(database.customers.values());
  res.json({ total: customers.length, customers });
});

app.get('/conversations', (req, res) => {
  const conversations = Array.from(database.conversations.values());
  res.json({ total: conversations.length, conversations });
});

app.get('/customers/:email', (req, res) => {
  const customer = database.customers.get(req.params.email);
  if (!customer) {
    return res.status(404).json({ error: 'Cliente não encontrado' });
  }
  res.json(customer);
});

app.head('/webhook', (req, res) => res.status(200).send());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Página inicial
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Robô de Atendimento</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
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
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 1rem;
          margin-top: 2rem;
        }
        .link-card {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 1.5rem;
          border-radius: 10px;
          text-decoration: none;
          text-align: center;
          transition: transform 0.2s;
        }
        .link-card:hover { transform: translateY(-5px); }
        .link-card h3 { margin-bottom: 0.5rem; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🤖 Robô de Atendimento WhatsApp</h1>
        <p>Sistema ativo e funcionando!</p>
        
        <div class="status-card">
          <h3>📊 Status do Sistema</h3>
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
            <span>Pedidos</span>
            <span>${database.orders.size}</span>
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
            <p>Status Detalhado</p>
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

// Iniciar servidor e WhatsApp
app.listen(PORT, () => {
  console.log(`
  🤖 Robô de Atendimento Iniciado!
  
  📡 Servidor: http://localhost:${PORT}
  🔐 Webhook Secret: ${WEBHOOK_SECRET ? '✅' : '❌'}
  
  📱 Para conectar o WhatsApp:
  → Acesse: http://localhost:${PORT}/qr
  
  Iniciando conexão WhatsApp...
  `);
  
  connectToWhatsApp();
});

process.on('uncaughtException', (error) => {
  console.error('❌ Erro não tratado:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Promise rejeitada:', error);
});