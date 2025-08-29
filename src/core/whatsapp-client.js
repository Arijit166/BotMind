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

      const { version, isLatest } = await fetchLatestBaileysVersion();
      this.logger.info(`📱 Using WhatsApp Web v${version.join('.')}, isLatest: ${isLatest}`);

      // Try database auth state, fallback to memory
      let authState, saveCreds;
      try {
        ({ state: authState, saveCreds } = await useDatabaseAuthState());
        this.logger.info('✅ Using database for WhatsApp authentication state');
      } catch (error) {
        this.logger.warn('⚠️ Database auth failed, using memory-only state:', error.message);
        // Fallback to memory-only auth state
        authState = { creds: {}, keys: { get: async () => ({}), set: async () => {} } };
        saveCreds = () => Promise.resolve();
      }

      this.sock = makeWASocket({
        version,
        logger: this.createBaileysLogger(),
        printQRInTerminal: false,
        auth: {
          creds: authState.creds,
          keys: makeCacheableSignalKeyStore(authState.keys, this.createBaileysLogger())
        },
        browser: Browsers.ubuntu("Chrome"),
        connectTimeoutMs: this.config.whatsapp.connectTimeoutMs,
        defaultQueryTimeoutMs: undefined,
        keepAliveIntervalMs: 10000,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: true
      });

      this.setupEventHandlers(saveCreds);

      this.logger.info('✅ WhatsApp client initialized successfully');

    } catch (error) {
      this.isConnecting = false;
      this.logger.error('❌ Failed to initialize WhatsApp client:', {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      throw error;
    }
  }

  setupEventHandlers(saveCreds) {
    if (!this.sock) return;
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, code } = update;
      this.logger.debug('Connection update received:', { connection, qr: !!qr, code: !!code });

      if (qr) {
        this.handleQRCode(qr);
      } else if (code) {
        this.handlePairingCode(code);
      }

      if (connection === 'close') {
        await this.handleDisconnection(lastDisconnect);
      } else if (connection === 'open') {
        await this.handleConnection();
      } else if (connection === 'connecting') {
        this.logger.info('🔄 Connecting to WhatsApp...');
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async (m) => {
      await this.handleMessages(m);
    });

    this.sock.ev.on('presence.update', (update) => {
      this.logger.debug('Presence update:', update);
    });

    this.sock.ev.on('groups.upsert', (groups) => {
      this.logger.debug('Groups upserted:', groups.length);
    });

    this.sock.ev.on('contacts.upsert', (contacts) => {
      this.logger.debug('Contacts upserted:', contacts.length);
    });
  }

  async handleQRCode(qr) {
    this.qrRetries++;
    this.logger.bot.qrCode(this.qrRetries, this.config.whatsapp.qrMaxRetries);

    if (this.qrRetries > this.config.whatsapp.qrMaxRetries) {
      this.logger.error('❌ Maximum QR retries exceeded');
      this.disconnect();
      return;
    }

    console.log('\n' + '='.repeat(50));
    console.log('📱 WHATSAPP QR CODE');
    console.log('='.repeat(50));
    console.log('Scan this QR code with your WhatsApp mobile app:');
    console.log('1. Open WhatsApp on your phone');
    console.log('2. Go to Settings > Linked Devices');
    console.log('3. Tap "Link a Device"');
    console.log('4. Open the link below in a browser and scan it');
    console.log('='.repeat(50));
    console.log(`👉 Clickable QR link: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`);
    console.log('='.repeat(50));
    console.log(`QR Code attempt: ${this.qrRetries}/${this.config.whatsapp.qrMaxRetries}`);
    console.log('Waiting for scan...');
    console.log('='.repeat(50) + '\n');
    this.emitConnectionEvent('qr', { qr, attempt: this.qrRetries, filePath: null });
  }

  async handleConnection() {
    try {
      this.isConnected = true;
      this.isConnecting = false;
      this.qrRetries = 0;
      this.reconnectAttempts = 0;
      const userInfo = this.sock.user;
      this.logger.info('✅ Successfully connected to WhatsApp!', {
        user: userInfo?.name || userInfo?.id,
        id: userInfo?.id
      });

      console.log('\n' + '🎉'.repeat(20));
      console.log('🚀 WhatsApp Bot Connected Successfully!');
      console.log(`📱 Connected as: ${userInfo?.name || 'Unknown'}`);
      console.log(`🆔 Phone: ${userInfo?.id || 'Unknown'}`);
      console.log('✅ Bot is now ready to receive messages!');
      console.log('🎉'.repeat(20) + '\n');
      this.emitConnectionEvent('connected', { user: userInfo });
    } catch (error) {
      this.logger.error('Error handling connection:', error);
    }
  }

  async handleDisconnection(lastDisconnect) {
    this.isConnected = false;
    this.isConnecting = false;
    const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
    const disconnectReason = lastDisconnect?.error?.output?.statusCode;
    this.logger.info('🔌 Disconnected from WhatsApp', {
      reason: this.getDisconnectReasonText(disconnectReason),
      shouldReconnect
    });

    this.emitConnectionEvent('disconnected', {
      reason: disconnectReason,
      shouldReconnect
    });

    if (shouldReconnect) {
      await this.attemptReconnection();
    } else {
      this.logger.warn('❌ Logged out from WhatsApp. Please restart the bot to reconnect.');
      console.log('\n' + '⚠️'.repeat(20));
      console.log('🚪 You have been logged out of WhatsApp');
      console.log('🔄 Please restart the bot to reconnect');
      console.log('📱 You may need to scan the QR code again');
      console.log('⚠️'.repeat(20) + '\n');
    }
  }

  async attemptReconnection() {
    if (this.reconnectAttempts >= this.config.whatsapp.maxReconnectAttempts) {
      this.logger.error('❌ Maximum reconnection attempts exceeded');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.config.whatsapp.reconnectIntervalMs * this.reconnectAttempts;

    this.logger.info(`🔄 Attempting to reconnect (${this.reconnectAttempts}/${this.config.whatsapp.maxReconnectAttempts}) in ${delay}ms...`);
    setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        this.logger.error('Reconnection failed:', error);
        await this.attemptReconnection();
      }
    }, delay);
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