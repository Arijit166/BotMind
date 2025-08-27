import { 
  makeWASocket,
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  isJidBroadcast
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode'; // 🟢 Changed from 'qrcode-terminal' to 'qrcode'
import fs from 'fs/promises';
import path from 'path'; // 🟢 Import path module
import { createModuleLogger } from '../utils/logger.js';

export class WhatsAppClient {
  /**
   * @param {object} config - The full configuration object passed from Bot.js
   */
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
  }

  /**
   * Initialize and connect to WhatsApp
   */
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

      // Ensure session directory exists
      await this.ensureSessionDirectory();

      // Get latest Baileys version
      const { version, isLatest } = await fetchLatestBaileysVersion();
      this.logger.info(`📱 Using WhatsApp Web v${version.join('.')}, isLatest: ${isLatest}`);

      // Initialize auth state
      const { state, saveCreds } = await useMultiFileAuthState(this.config.whatsapp.sessionPath);

      // Create socket
      this.sock = makeWASocket({
        version,
        logger: this.createBaileysLogger(),
        printQRInTerminal: false, // We'll handle QR manually
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.createBaileysLogger())
        },
        browser: Browsers.ubuntu("Chrome"),
        connectTimeoutMs: this.config.whatsapp.connectTimeoutMs,
        defaultQueryTimeoutMs: undefined,
        keepAliveIntervalMs: 10000,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: true
      });

      // Set up event handlers
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

  /**
   * Set up event handlers for WhatsApp connection
   */
  setupEventHandlers(saveCreds) {
    if (!this.sock) return;

    // Connection updates
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, code } = update;

      this.logger.debug('Connection update received:', { connection, qr: !!qr, code: !!code });

      // Handle QR code or pairing code
      if (qr) {
        this.handleQRCode(qr);
      } else if (code) {
        this.handlePairingCode(code);
      }

      // Handle connection status
      if (connection === 'close') {
        await this.handleDisconnection(lastDisconnect);
      } else if (connection === 'open') {
        await this.handleConnection();
      } else if (connection === 'connecting') {
        this.logger.info('🔄 Connecting to WhatsApp...');
      }
    });

    // Credentials update
    this.sock.ev.on('creds.update', saveCreds);

    // Message events
    this.sock.ev.on('messages.upsert', async (m) => {
      await this.handleMessages(m);
    });

    // Presence updates
    this.sock.ev.on('presence.update', (update) => {
      this.logger.debug('Presence update:', update);
    });

    // Group updates
    this.sock.ev.on('groups.upsert', (groups) => {
      this.logger.debug('Groups upserted:', groups.length);
    });

    // Contacts update
    this.sock.ev.on('contacts.upsert', (contacts) => {
      this.logger.debug('Contacts upserted:', contacts.length);
    });
  }

  /**
   * Handle QR code generation
   */
  async handleQRCode(qr) { // 🟢 Made async to use await for file operations
    this.qrRetries++;
    
    this.logger.bot.qrCode(this.qrRetries, this.config.whatsapp.qrMaxRetries);

    if (this.qrRetries > this.config.whatsapp.qrMaxRetries) {
      this.logger.error('❌ Maximum QR retries exceeded');
      this.disconnect();
      return;
    }

    // 🟢 NEW: Generate QR code as a PNG image file
    const qrFilePath = path.join(this.config.whatsapp.sessionPath, `qrcode_attempt_${this.qrRetries}.png`);
    try {
      await qrcode.toFile(qrFilePath, qr, {
        errorCorrectionLevel: 'H', // High error correction
        type: 'png',
        quality: 0.92,
        margin: 1,
        color: {
          dark: '#000',  // Black dots
          light: '#FFF' // White background
        }
      });
      this.logger.info(`✅ QR code saved to ${qrFilePath}`);
      this.logger.info(`Scan the QR code from the file: ${qrFilePath}`);
      console.log(`\nScan the QR code from the file: ${qrFilePath}\n`);
    } catch (error) {
      this.logger.error('❌ Failed to save QR code as image:', error);
      // Fallback to terminal display if file save fails
      // 🟢 REVERTED: Fallback to qrcode-terminal if file save fails
      qrcodeTerminal.generate(qr, { small: true });
    }

    // Emit QR event for external handlers
    this.emitConnectionEvent('qr', { qr, attempt: this.qrRetries, filePath: qrFilePath });
  }

  /**
   * 🟢 NEW: Handle pairing code generation (Link with Phone Number)
   */
  async handlePairingCode(code) {
    this.qrRetries++; // Use qrRetries for pairing code attempts as well
    this.logger.bot.qrCode(this.qrRetries, this.config.whatsapp.qrMaxRetries);

    if (this.qrRetries > this.config.whatsapp.qrMaxRetries) {
      this.logger.error('❌ Maximum pairing code retries exceeded');
      this.disconnect();
      return;
    }

    console.log('\n' + '='.repeat(50));
    console.log('🔢 WHATSAPP PAIRING CODE');
    console.log('='.repeat(50));
    console.log('Use this code to link your WhatsApp mobile app:');
    console.log('1. Open WhatsApp on your phone');
    console.log('2. Go to Settings > Linked Devices');
    console.log('3. Tap "Link with phone number"');
    console.log('4. Enter the 8-digit code below:');
    console.log('='.repeat(50));
    console.log(`\nYour 8-digit pairing code is: ${code}`); // 🟢 Display the code directly
    console.log('='.repeat(50));
    console.log(`Pairing code attempt: ${this.qrRetries}/${this.config.whatsapp.qrMaxRetries}`);
    console.log('Waiting for pairing...');
    console.log('='.repeat(50) + '\n');

    // Emit pairing code event for external handlers
    this.emitConnectionEvent('pairing_code', { code, attempt: this.qrRetries });
  }


  /**
   * Handle successful connection
   */
  async handleConnection() {
    try {
      this.isConnected = true;
      this.isConnecting = false;
      this.qrRetries = 0;
      this.reconnectAttempts = 0;

      // Get user info
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

      // Emit connection event
      this.emitConnectionEvent('connected', { user: userInfo });

    } catch (error) {
      this.logger.error('Error handling connection:', error);
    }
  }

  /**
   * Handle disconnection
   */
  async handleDisconnection(lastDisconnect) {
    this.isConnected = false;
    this.isConnecting = false;
    
    const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
    const disconnectReason = lastDisconnect?.error?.output?.statusCode;

    this.logger.info('🔌 Disconnected from WhatsApp', {
      reason: this.getDisconnectReasonText(disconnectReason),
      shouldReconnect
    });

    // Emit disconnection event
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

  /**
   * Attempt to reconnect
   */
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

  /**
   * Handle incoming messages
   */
  async handleMessages(messageUpdate) {
    try {
      const { messages, type } = messageUpdate;
      
      if (type !== 'notify') return;

      for (const message of messages) {
        // Skip if message is from bot itself
        if (message.key.fromMe) continue;

        // Skip broadcast messages
        if (isJidBroadcast(message.key.remoteJid)) continue;

        this.logger.bot.messageReceived(
          message.key.remoteJid, 
          message.messageType || 'unknown',
          {
            messageId: message.key.id,
            hasText: !!message.message?.conversation
          }
        );

        // Forward to message handlers
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

  /**
   * Send a message
   */
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

  /**
   * Get chat information
   */
  async getChat(jid) {
    try {
      if (!this.isConnected) {
        throw new Error('Not connected to WhatsApp');
      }

      // For group chats
      if (jid.endsWith('@g.us')) {
        const groupMetadata = await this.sock.groupMetadata(jid);
        return {
          id: { _serialized: jid },
          name: groupMetadata.subject,
          isGroup: true,
          participants: groupMetadata.participants
        };
      }

      // For individual chats
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

  /**
   * Get contact information
   */
  async getContact(jid) {
    try {
      if (!this.isConnected) {
        throw new Error('Not connected to WhatsApp');
      }

      // Try to get contact from store
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

  /**
   * Disconnect from WhatsApp
   */
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

  /**
   * Register message handler
   */
  onMessage(handler) {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  /**
   * Register connection event handler
   */
  onConnectionEvent(event, handler) {
    if (!this.connectionEventHandlers.has(event)) {
      this.connectionEventHandlers.set(event, new Set());
    }
    this.connectionEventHandlers.get(event).add(handler);
    
    return () => this.connectionEventHandlers.get(event)?.delete(handler);
  }

  /**
   * Emit connection event
   */
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

  /**
   * Utility methods
   */
  async ensureSessionDirectory() {
    try {
      await fs.mkdir(this.config.whatsapp.sessionPath, { recursive: true });
    } catch (error) {
      this.logger.error('Failed to create session directory:', error);
      throw error;
    }
  }

  createBaileysLogger() {
    return {
      level: 'silent', // Suppress Baileys logs
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

  /**
   * Get connection status
   */
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
