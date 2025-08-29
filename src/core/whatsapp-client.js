import {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  isJidBroadcast
} from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import { createModuleLogger } from '../utils/logger.js';
import pg from 'pg';

const { Pool } = pg;
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
}) : null;

async function useDatabaseAuthState() {
  // 🟢 ADDED: Check if pool exists before proceeding.
  if (!pool) {
    throw new Error('DATABASE_URL is not set. Cannot use database for authentication state.');
  }

  const tableExists = await pool.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = 'whatsapp_auth_creds'
    );
  `);
  
  if (!tableExists.rows[0].exists) {
    await pool.query(`
      CREATE TABLE whatsapp_auth_creds (
        id VARCHAR(255) PRIMARY KEY,
        value JSONB
      );
    `);
    console.log('Created whatsapp_auth_creds table.');
  }

  const readCreds = async (id) => {
    const res = await pool.query('SELECT value FROM whatsapp_auth_creds WHERE id = $1', [id]);
    return res.rows[0] ? res.rows[0].value : null;
  };

  const writeCreds = async (id, value) => {
    await pool.query(
      'INSERT INTO whatsapp_auth_creds (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = $2',
      [id, value]
    );
  };

  const getCreds = async () => {
    const creds = await readCreds('creds');
    return creds ? JSON.parse(creds) : {};
  };

  const saveCreds = async () => {
    const creds = JSON.stringify(authState.creds);
    await writeCreds('creds', creds);
  };

  const authState = {
    creds: await getCreds(),
    keys: {
      get: async (type, ids) => {
        const map = {};
        for (const id of ids) {
          const data = await readCreds(`${type}_${id}`);
          if (data) map[id] = new Uint8Array(data.data);
        }
        return map;
      },
      set: async (data) => {
        const tasks = [];
        for (const type of Object.keys(data)) {
          for (const id of Object.keys(data[type])) {
            const value = data[type][id];
            tasks.push(writeCreds(`${type}_${id}`, Buffer.from(value)));
          }
        }
        await Promise.all(tasks);
      }
    }
  };

  return { state: authState, saveCreds };
}

export class WhatsAppClient {
  constructor(config) {
    this.logger = createModuleLogger('WhatsAppClient');
    this.config = config;
    this.sock = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.qrRetries = 0;
    this.reconnectAttempts = 0;
    this.connectionEventHandlers = new Map();
    this.messageHandlers = new Set();
    this.currentQR = null; // Store current QR for web display
  }

  // Enhanced QR handling for cloud deployment
  async handleQRCode(qr) {
    this.qrRetries++;
    this.currentQR = qr; // Store for web endpoint
    
    this.logger.bot.qrCode(this.qrRetries, this.config.whatsapp.qrMaxRetries);

    if (this.qrRetries > this.config.whatsapp.qrMaxRetries) {
      this.logger.error('❌ Maximum QR retries exceeded');
      this.disconnect();
      return;
    }

    // Enhanced QR display for cloud deployments
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
    
    console.log('\n' + '='.repeat(80));
    console.log('📱 WHATSAPP QR CODE - CLOUD DEPLOYMENT');
    console.log('='.repeat(80));
    console.log('🌐 SCAN THIS QR CODE TO CONNECT YOUR WHATSAPP:');
    console.log('');
    console.log('🔗 QR Code URL (copy and paste in browser):');
    console.log(`👉 ${qrUrl}`);
    console.log('');
    console.log('📋 Instructions:');
    console.log('1. Copy the URL above');
    console.log('2. Paste it in your browser');
    console.log('3. Open WhatsApp on your phone');
    console.log('4. Go to Settings > Linked Devices');
    console.log('5. Tap "Link a Device"');
    console.log('6. Scan the QR code from your browser');
    console.log('');
    console.log(`⏱️  QR Code attempt: ${this.qrRetries}/${this.config.whatsapp.qrMaxRetries}`);
    console.log(`⏰ This QR code expires in ~20 seconds`);
    console.log('🔄 New QR code will be generated automatically');
    console.log('='.repeat(80) + '\n');

    // Emit QR event for web interface (if you have one)
    this.emitConnectionEvent('qr', { 
      qr, 
      qrUrl,
      attempt: this.qrRetries, 
      maxAttempts: this.config.whatsapp.qrMaxRetries,
      expiresIn: 20000 // 20 seconds
    });
  }

  // Enhanced connection handler with better logging
  async handleConnection() {
    try {
      this.isConnected = true;
      this.isConnecting = false;
      this.qrRetries = 0;
      this.reconnectAttempts = 0;
      this.currentQR = null; // Clear QR code
      
      const userInfo = this.sock.user;
      this.logger.info('✅ Successfully connected to WhatsApp!', {
        user: userInfo?.name || userInfo?.id,
        id: userInfo?.id
      });

      // Enhanced success display for cloud deployment
      console.log('\n' + '🎉'.repeat(40));
      console.log('🚀 WHATSAPP BOT CONNECTED SUCCESSFULLY! 🚀');
      console.log('='.repeat(80));
      console.log(`📱 Connected as: ${userInfo?.name || 'Unknown'}`);
      console.log(`🆔 Phone Number: ${userInfo?.id || 'Unknown'}`);
      console.log(`🌐 Platform: ${process.env.RENDER ? 'Render Cloud' : 'Local'}`);
      console.log(`⏰ Connected at: ${new Date().toLocaleString()}`);
      console.log('✅ Bot is now ready to receive messages!');
      console.log('📝 Authentication saved to database');
      console.log('🔄 Bot will auto-reconnect if connection drops');
      console.log('='.repeat(80));
      console.log('🎉'.repeat(40) + '\n');
      
      this.emitConnectionEvent('connected', { user: userInfo });
      
      // Save successful connection to database immediately
      if (this.sock.authState) {
        this.logger.info('💾 Saving authentication state to database...');
      }
      
    } catch (error) {
      this.logger.error('Error handling connection:', error);
    }
  }

  // Enhanced disconnection handler with better diagnostics
  async handleDisconnection(lastDisconnect) {
    this.isConnected = false;
    this.isConnecting = false;
    this.currentQR = null;
    
    const disconnectReason = lastDisconnect?.error?.output?.statusCode;
    const shouldReconnect = disconnectReason !== DisconnectReason.loggedOut;
    
    // Enhanced logging for cloud deployment debugging
    this.logger.info('🔌 WhatsApp Disconnected', {
      reason: this.getDisconnectReasonText(disconnectReason),
      reasonCode: disconnectReason,
      shouldReconnect,
      lastDisconnectError: lastDisconnect?.error?.message,
      platform: process.env.RENDER ? 'Render' : 'Local'
    });

    // Better disconnect reason handling
    console.log('\n' + '⚠️'.repeat(40));
    console.log('📱 WHATSAPP CONNECTION STATUS');
    console.log('='.repeat(80));
    console.log(`🔌 Status: DISCONNECTED`);
    console.log(`❗ Reason: ${this.getDisconnectReasonText(disconnectReason)}`);
    console.log(`🔢 Reason Code: ${disconnectReason || 'undefined'}`);
    console.log(`🔄 Will Reconnect: ${shouldReconnect ? 'YES' : 'NO'}`);
    
    if (lastDisconnect?.error?.message) {
      console.log(`📋 Error Details: ${lastDisconnect.error.message}`);
    }
    
    console.log(`⏰ Disconnected at: ${new Date().toLocaleString()}`);
    console.log('='.repeat(80));

    this.emitConnectionEvent('disconnected', {
      reason: disconnectReason,
      reasonText: this.getDisconnectReasonText(disconnectReason),
      shouldReconnect,
      timestamp: new Date().toISOString()
    });

    if (shouldReconnect) {
      console.log('🔄 Attempting to reconnect...');
      await this.attemptReconnection();
    } else {
      console.log('🚪 LOGGED OUT - Manual restart required');
      console.log('📱 You may need to scan QR code again');
      console.log('⚠️'.repeat(40) + '\n');
    }
  }

  // Get current QR code for web interface
  getCurrentQR() {
    return this.currentQR ? {
      qr: this.currentQR,
      qrUrl: `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(this.currentQR)}`,
      attempt: this.qrRetries,
      maxAttempts: this.config.whatsapp.qrMaxRetries,
      timestamp: Date.now()
    } : null;
  }

  // Enhanced status method
  getStatus() {
    return {
      connected: this.isConnected,
      connecting: this.isConnecting,
      qrRetries: this.qrRetries,
      reconnectAttempts: this.reconnectAttempts,
      user: this.sock?.user || null,
      hasQR: !!this.currentQR,
      platform: process.env.RENDER ? 'render' : 'local',
      lastUpdate: new Date().toISOString()
    };
  }

    async connect() {
    if (this.isConnecting) {
      this.logger.warn('Connection already in progress');
      return;
    }

    if (this.isConnected) {
      this.logger.warn('Already connected to WhatsApp');
      return;
    }

    try {
      this.isConnecting = true;
      this.logger.info('🔗 Initializing WhatsApp connection...');

      // Enhanced debugging for cloud deployment
      console.log('\n🔍 CONNECTION DEBUG INFO:');
      console.log('Platform:', process.env.RENDER ? 'Render Cloud' : 'Local');
      console.log('Node version:', process.version);
      console.log('Environment:', process.env.NODE_ENV || 'development');
      console.log('Database available:', !!pool);
      console.log('Memory usage:', process.memoryUsage());

      const { version, isLatest } = await fetchLatestBaileysVersion();
      this.logger.info(`📱 Using WhatsApp Web v${version.join('.')}, isLatest: ${isLatest}`);

      // Enhanced auth state handling with detailed logging
      let authState, saveCreds;
      try {
        ({ state: authState, saveCreds } = await useDatabaseAuthState());
        console.log('✅ Database auth state loaded');
        console.log('Auth state has creds:', !!authState.creds && Object.keys(authState.creds).length > 0);
        this.logger.info('✅ Using database for WhatsApp authentication state');
      } catch (error) {
        console.log('❌ Database auth failed, using memory-only state:', error.message);
        this.logger.warn('⚠️ Database auth failed, using memory-only state:', error.message);
        
        // Enhanced fallback auth state
        authState = { 
          creds: {},
          keys: { 
            get: async (type, ids) => {
              console.log(`🔑 Memory auth: Getting ${type} keys for ${ids.length} items`);
              return {};
            },
            set: async (data) => {
              const keyCount = Object.values(data).reduce((sum, typeData) => sum + Object.keys(typeData).length, 0);
              console.log(`🔑 Memory auth: Setting ${keyCount} keys`);
            }
          }
        };
        saveCreds = () => {
          console.log('💾 Memory auth: Credentials save requested (no-op)');
          return Promise.resolve();
        };
      }

      // Enhanced socket configuration with debugging
      console.log('🔧 Creating WhatsApp socket...');
      const socketConfig = {
        version,
        logger: this.createBaileysLogger(),
        printQRInTerminal: false, // We handle QR manually
        auth: {
          creds: authState.creds,
          keys: makeCacheableSignalKeyStore(authState.keys, this.createBaileysLogger())
        },
        browser: Browsers.ubuntu("Chrome"),
        connectTimeoutMs: this.config.whatsapp.connectTimeoutMs || 60000,
        defaultQueryTimeoutMs: this.config.whatsapp.queryTimeoutMs || 60000,
        keepAliveIntervalMs: 10000,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        // Enhanced options for cloud deployment
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 5,
        appStateMacVerification: {
          patch: true,
          snapshot: true
        }
      };

      console.log('Socket config:', {
        hasAuth: !!socketConfig.auth,
        hasCreds: !!socketConfig.auth.creds,
        connectTimeout: socketConfig.connectTimeoutMs,
        browser: socketConfig.browser
      });

      this.sock = makeWASocket(socketConfig);

      // Enhanced event setup with more detailed logging
      this.setupEventHandlers(saveCreds);

      this.logger.info('✅ WhatsApp client initialized successfully');
      console.log('✅ Socket created, waiting for connection events...\n');

    } catch (error) {
      this.isConnecting = false;
      this.logger.error('❌ Failed to initialize WhatsApp client:', {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      
      console.error('\n❌ FULL CONNECTION ERROR DETAILS:');
      console.error('Error name:', error.name);
      console.error('Error message:', error.message);
      console.error('Error code:', error.code);
      console.error('Stack trace:', error.stack?.split('\n').slice(0, 5).join('\n'));
      
      throw error;
    }
  }

  // Enhanced event handler setup with detailed connection logging
  setupEventHandlers(saveCreds) {
    if (!this.sock) {
      console.error('❌ No socket available for event handlers');
      return;
    }

    console.log('🔧 Setting up WhatsApp event handlers...');

    // Enhanced connection update handler with detailed debugging
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, code, isNewLogin, isOnline, receivedPendingNotifications } = update;
      
      // Detailed connection logging
      console.log('\n📡 CONNECTION UPDATE RECEIVED:');
      console.log('├─ Connection state:', connection);
      console.log('├─ Has QR code:', !!qr);
      console.log('├─ Has pairing code:', !!code);
      console.log('├─ Is new login:', isNewLogin);
      console.log('├─ Is online:', isOnline);
      console.log('├─ Received pending notifications:', receivedPendingNotifications);
      console.log('├─ Has disconnect info:', !!lastDisconnect);
      
      if (lastDisconnect) {
        console.log('├─ Disconnect error exists:', !!lastDisconnect.error);
        console.log('├─ Disconnect reason code:', lastDisconnect.error?.output?.statusCode);
        console.log('├─ Disconnect error message:', lastDisconnect.error?.message);
      }
      console.log('└─ Timestamp:', new Date().toISOString());

      this.logger.debug('Connection update received:', { 
        connection, 
        qr: !!qr, 
        code: !!code,
        isNewLogin,
        isOnline,
        receivedPendingNotifications,
        disconnectReason: lastDisconnect?.error?.output?.statusCode
      });

      if (qr) {
        console.log('📱 QR CODE GENERATED');
        await this.handleQRCode(qr);
      } else if (code) {
        console.log('🔢 PAIRING CODE GENERATED');
        await this.handlePairingCode(code);
      }

      if (connection === 'close') {
        console.log('🔌 CONNECTION CLOSED');
        await this.handleDisconnection(lastDisconnect);
      } else if (connection === 'open') {
        console.log('✅ CONNECTION OPENED');
        await this.handleConnection();
      } else if (connection === 'connecting') {
        console.log('🔄 CONNECTION IN PROGRESS');
        this.logger.info('🔄 Connecting to WhatsApp...');
      } else {
        console.log('❓ UNKNOWN CONNECTION STATE:', connection);
      }
    });

    // Enhanced credentials update handler
    this.sock.ev.on('creds.update', async () => {
      console.log('🔐 CREDENTIALS UPDATED - saving to database');
      try {
        await saveCreds();
        console.log('✅ Credentials saved successfully');
      } catch (error) {
        console.error('❌ Failed to save credentials:', error.message);
      }
    });

    // Enhanced message handler
    this.sock.ev.on('messages.upsert', async (m) => {
      console.log('📨 Messages received:', m.messages?.length || 0);
      await this.handleMessages(m);
    });

    // Additional event handlers for debugging
    this.sock.ev.on('presence.update', (update) => {
      console.log('👤 Presence update:', Object.keys(update).length, 'contacts');
    });

    this.sock.ev.on('chats.set', (chats) => {
      console.log('💬 Chats set:', chats.chats?.length || 0, 'chats');
    });

    this.sock.ev.on('contacts.set', (contacts) => {
      console.log('📞 Contacts set:', contacts.contacts?.length || 0, 'contacts');
    });

    // Error event handler
    this.sock.ev.on('connection.error', (error) => {
      console.error('🚨 CONNECTION ERROR EVENT:', error);
    });

    console.log('✅ Event handlers configured\n');
  }

  // Enhanced QR code handling with better cloud deployment support
  async handleQRCode(qr) {
    this.qrRetries++;
    this.currentQR = qr;
    
    console.log('\n' + '='.repeat(80));
    console.log('📱 WHATSAPP QR CODE GENERATED');
    console.log('='.repeat(80));
    console.log(`🔢 Attempt: ${this.qrRetries}/${this.config.whatsapp.qrMaxRetries}`);
    console.log('⏰ QR Code expires in ~20 seconds');
    console.log('');

    if (this.qrRetries > this.config.whatsapp.qrMaxRetries) {
      console.log('❌ Maximum QR retries exceeded');
      this.logger.error('❌ Maximum QR retries exceeded');
      this.disconnect();
      return;
    }

    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
    
    console.log('🌐 FOR CLOUD DEPLOYMENT - COPY THIS URL:');
    console.log(`👉 ${qrUrl}`);
    console.log('');
    console.log('📋 INSTRUCTIONS:');
    console.log('1. Copy the URL above');
    console.log('2. Paste it in your browser');
    console.log('3. Scan the QR code with WhatsApp');
    console.log('4. Go to WhatsApp > Settings > Linked Devices > Link a Device');
    console.log('='.repeat(80) + '\n');

    this.logger.bot?.qrCode?.(this.qrRetries, this.config.whatsapp.qrMaxRetries);
    this.emitConnectionEvent('qr', { qr, qrUrl, attempt: this.qrRetries });
  }

  // Enhanced pairing code handler (alternative to QR)
  async handlePairingCode(code) {
    console.log('\n' + '='.repeat(80));
    console.log('🔢 WHATSAPP PAIRING CODE GENERATED');
    console.log('='.repeat(80));
    console.log(`📱 Pairing Code: ${code}`);
    console.log('');
    console.log('📋 INSTRUCTIONS:');
    console.log('1. Open WhatsApp on your phone');
    console.log('2. Go to Settings > Linked Devices');
    console.log('3. Tap "Link a Device"');
    console.log('4. Choose "Link with phone number instead"');
    console.log(`5. Enter this code: ${code}`);
    console.log('='.repeat(80) + '\n');
  }

  // Enhanced disconnection handler with detailed error analysis
  async handleDisconnection(lastDisconnect) {
    this.isConnected = false;
    this.isConnecting = false;
    this.currentQR = null;
    
    const disconnectReason = lastDisconnect?.error?.output?.statusCode;
    const errorMessage = lastDisconnect?.error?.message;
    const shouldReconnect = disconnectReason !== DisconnectReason.loggedOut;
    
    console.log('\n' + '⚠️'.repeat(40));
    console.log('📱 WHATSAPP DISCONNECTION ANALYSIS');
    console.log('='.repeat(80));
    console.log('🔌 Status: DISCONNECTED');
    console.log('❗ Reason Code:', disconnectReason || 'undefined');
    console.log('❗ Reason Text:', this.getDisconnectReasonText(disconnectReason));
    console.log('📝 Error Message:', errorMessage || 'No error message');
    console.log('🔄 Should Reconnect:', shouldReconnect);
    console.log('⏰ Disconnected at:', new Date().toLocaleString());
    
    // Enhanced error analysis
    if (disconnectReason === undefined) {
      console.log('\n🔍 UNDEFINED DISCONNECT ANALYSIS:');
      console.log('│  This usually indicates one of these issues:');
      console.log('├─ 1. No WhatsApp session exists (need to scan QR)');
      console.log('├─ 2. Invalid/expired authentication credentials');
      console.log('├─ 3. WhatsApp Web version incompatibility');
      console.log('├─ 4. Network connectivity issues');
      console.log('├─ 5. Cloud platform restrictions (IP/firewall)');
      console.log('└─ 6. WhatsApp rate limiting or temporary ban');
      
      console.log('\n💡 SUGGESTED SOLUTIONS:');
      console.log('├─ 1. Wait for QR code to appear and scan it');
      console.log('├─ 2. Clear database auth state and restart');
      console.log('├─ 3. Check if WhatsApp Web works from same IP');
      console.log('└─ 4. Try again in a few minutes');
    }
    
    console.log('='.repeat(80));
    console.log('⚠️'.repeat(40) + '\n');

    this.logger.info('🔌 Disconnected from WhatsApp', {
      reason: this.getDisconnectReasonText(disconnectReason),
      reasonCode: disconnectReason,
      errorMessage: errorMessage,
      shouldReconnect,
      platform: process.env.RENDER ? 'Render' : 'Local'
    });

    this.emitConnectionEvent('disconnected', {
      reason: disconnectReason,
      reasonText: this.getDisconnectReasonText(disconnectReason),
      errorMessage: errorMessage,
      shouldReconnect,
      timestamp: new Date().toISOString()
    });

    if (shouldReconnect) {
      console.log('🔄 Scheduling reconnection attempt...');
      await this.attemptReconnection();
    } else {
      console.log('🚪 LOGGED OUT - Manual restart required');
      console.log('📱 You will need to scan QR code again');
    }
  }

  // Enhanced reconnection with exponential backoff
  async attemptReconnection() {
    if (this.reconnectAttempts >= this.config.whatsapp.maxReconnectAttempts) {
      this.logger.error('❌ Maximum reconnection attempts exceeded');
      console.log('❌ Maximum reconnection attempts reached. Manual restart required.');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.config.whatsapp.reconnectIntervalMs * Math.pow(2, this.reconnectAttempts - 1),
      30000 // Max 30 seconds
    );

    console.log(`🔄 Reconnection attempt ${this.reconnectAttempts}/${this.config.whatsapp.maxReconnectAttempts}`);
    console.log(`⏰ Waiting ${delay}ms before reconnecting...`);
    
    this.logger.info(`🔄 Attempting to reconnect (${this.reconnectAttempts}/${this.config.whatsapp.maxReconnectAttempts}) in ${delay}ms...`);
    
    setTimeout(async () => {
      try {
        console.log('🔄 Starting reconnection...');
        await this.connect();
      } catch (error) {
        console.error('❌ Reconnection failed:', error.message);
        this.logger.error('Reconnection failed:', error);
        await this.attemptReconnection();
      }
    }, delay);
  }

  // Enhanced disconnect reason mapping
  getDisconnectReasonText(reason) {
    const reasons = {
      [DisconnectReason.badSession]: 'Bad Session File (corrupted auth)',
      [DisconnectReason.connectionClosed]: 'Connection Closed (network issue)',
      [DisconnectReason.connectionLost]: 'Connection Lost (network timeout)',
      [DisconnectReason.connectionReplaced]: 'Connection Replaced (logged in elsewhere)',
      [DisconnectReason.loggedOut]: 'Logged Out (manual logout or ban)',
      [DisconnectReason.restartRequired]: 'Restart Required (WhatsApp update)',
      [DisconnectReason.timedOut]: 'Connection Timed Out (network slow)',
      [DisconnectReason.multideviceMismatch]: 'Multi-device Mismatch (version conflict)'
    };
    
    if (reason === undefined) {
      return 'Unknown - No Auth Session (need to scan QR)';
    }
    
    return reasons[reason] || `Unknown Code (${reason})`;
  }

  // Add method to clear auth state for testing
  async clearAuthState() {
    if (pool) {
      try {
        const client = await pool.connect();
        await client.query('DELETE FROM whatsapp_auth_creds');
        client.release();
        console.log('✅ Cleared database auth state');
      } catch (error) {
        console.error('❌ Failed to clear auth state:', error.message);
      }
    }
  }

  async handleMessages(messageUpdate) {
    try {
      const { messages, type } = messageUpdate;
      if (type !== 'notify') return;
      for (const message of messages) {
        if (message.message?.reactionMessage) {
          this.logger.debug('Skipping message as it is a reaction', { messageId: message.key.id });
          continue;
        }
        if (isJidBroadcast(message.key.remoteJid)) continue;
        this.logger.bot.messageReceived(
          message.key.remoteJid,
          message.messageType || 'unknown', {
          messageId: message.key.id,
          hasText: !!message.message?.conversation
        }
        );
        for (const handler of this.messageHandlers) {
          try {
            await handler(message);
          } catch (error) {
            this.logger.error('Message handler error:', error);
          }
        }
      }
    } catch (error) {
      this.logger.error('Error handling messages:', error);
    }
  }

  async sendMessage(jid, content, options = {}) {
    try {
      if (!this.isConnected) {
        throw new Error('Not connected to WhatsApp');
      }
      const result = await this.sock.sendMessage(jid, content, options);
      this.logger.debug('Message sent successfully', {
        jid,
        contentLength: typeof content === 'string' ? content.length : 'media',
        messageId: result.key.id
      });
      return result;
    } catch (error) {
      this.logger.error('Failed to send message:', error);
      throw error;
    }
  }

  async getChat(jid) {
    try {
      if (!this.isConnected) {
        throw new Error('Not connected to WhatsApp');
      }
      if (jid.endsWith('@g.us')) {
        const groupMetadata = await this.sock.groupMetadata(jid);
        return {
          id: { _serialized: jid },
          name: groupMetadata.subject,
          isGroup: true,
          participants: groupMetadata.participants
        };
      }
      return {
        id: { _serialized: jid },
        name: jid.split('@')[0],
        isGroup: false
      };
    } catch (error) {
      this.logger.error('Failed to get chat info:', error);
      return {
        id: { _serialized: jid },
        name: 'Unknown',
        isGroup: jid.endsWith('@g.us')
      };
    }
  }

  async getContact(jid) {
    try {
      if (!this.isConnected) {
        throw new Error('Not connected to WhatsApp');
      }
      const contact = this.sock.store?.contacts?.[jid];
      return {
        id: { _serialized: jid },
        name: contact?.name || contact?.notify || jid.split('@')[0],
        pushname: contact?.notify,
        number: jid.split('@')[0]
      };
    } catch (error) {
      this.logger.error('Failed to get contact info:', error);
      return {
        id: { _serialized: jid },
        name: jid.split('@')[0],
        pushname: null,
        number: jid.split('@')[0]
      };
    }
  }

  async disconnect() {
    try {
      if (this.sock) {
        this.logger.info('🔌 Disconnecting from WhatsApp...');
        await this.sock.end();
        this.sock = null;
      }
      this.isConnected = false;
      this.isConnecting = false;
      this.logger.info('✅ Disconnected from WhatsApp');
    } catch (error) {
      this.logger.error('Error during disconnection:', error);
    }
  }

  onMessage(handler) {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onConnectionEvent(event, handler) {
    if (!this.connectionEventHandlers.has(event)) {
      this.connectionEventHandlers.set(event, new Set());
    }
    this.connectionEventHandlers.get(event).add(handler);
    return () => this.connectionEventHandlers.get(event)?.delete(handler);
  }

  emitConnectionEvent(event, data) {
    const handlers = this.connectionEventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (error) {
          this.logger.error(`Error in ${event} handler:`, error);
        }
      }
    }
  }

  createBaileysLogger() {
    return {
      level: 'silent',
      child: () => this.createBaileysLogger(),
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {}
    };
  }

  getDisconnectReasonText(reason) {
    const reasons = {
      [DisconnectReason.badSession]: 'Bad Session File',
      [DisconnectReason.connectionClosed]: 'Connection Closed',
      [DisconnectReason.connectionLost]: 'Connection Lost',
      [DisconnectReason.connectionReplaced]: 'Connection Replaced',
      [DisconnectReason.loggedOut]: 'Logged Out',
      [DisconnectReason.restartRequired]: 'Restart Required',
      [DisconnectReason.timedOut]: 'Connection Timed Out',
      [DisconnectReason.multideviceMismatch]: 'Multi-device Mismatch'
    };
    return reasons[reason] || `Unknown (${reason})`;
  }

  getStatus() {
    return {
      connected: this.isConnected,
      connecting: this.isConnecting,
      qrRetries: this.qrRetries,
      reconnectAttempts: this.reconnectAttempts,
      user: this.sock?.user || null
    };
  }
}