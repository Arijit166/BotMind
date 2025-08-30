import {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  isJidBroadcast
} from '@whiskeysockets/baileys';
import { createModuleLogger } from '../utils/logger.js';
import pkg from '@whiskeysockets/baileys';
import pg from 'pg';

const { initAuthCreds } = pkg;
const { Pool } = pg;
let pool = null;

async function connectToDatabase() {
  console.log('DB: Attempting to connect to the database...');
  if (!process.env.DATABASE_URL) {
    console.warn('⚠️ DATABASE_URL environment variable is not set. Database features will be disabled.');
    return null;
  }
  
  try {
    const tempPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    });
    const client = await tempPool.connect();
    client.release();
    console.log('✅ Database connection test successful.');
    return tempPool;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    return null;
  }
}

async function useDatabaseAuthState() {
    if (!pool) {
        throw new Error('Database is not available. Cannot use database for authentication state.');
    }

    try {
        const testClient = await pool.connect();
        console.log('DB: Successfully connected to PostgreSQL client.');

        const tableCheckQuery = `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'whatsapp_auth_creds');`;
        const tableExistsResult = await testClient.query(tableCheckQuery);

        if (!tableExistsResult?.rows?.[0]?.exists) {
            console.log('DB: whatsapp_auth_creds table does not exist. Creating it...');
            const createTableQuery = `CREATE TABLE whatsapp_auth_creds (id VARCHAR(255) PRIMARY KEY, value JSONB);`;
            await testClient.query(createTableQuery);
            console.log('DB: Created whatsapp_auth_creds table.');
        } else {
            console.log('DB: whatsapp_auth_creds table already exists.');
        }
        
        testClient.release();

        const readCreds = async (id) => {
            const client = await pool.connect();
            try {
                const res = await client.query('SELECT value FROM whatsapp_auth_creds WHERE id = $1', [id]);
                if (res.rows.length === 0) {
                    return null;
                }
                const value = res.rows[0].value;
                if (value === null || value === undefined) {
                    console.warn(`DB: Found null/undefined value for key ${id}`);
                    return null;
                }
                return value;
            } catch (error) {
                console.error(`DB: Error reading credentials for ${id}:`, error.message);
                return null;
            } finally {
                client.release();
            }
        };

        const writeCreds = async (id, value) => {
            if (value === null || value === undefined) {
                console.warn(`DB: Skipping write for key ${id} - value is null/undefined`);
                return;
            }
            
            const client = await pool.connect();
            try {
                let processedValue;
                if (typeof value === 'string') {
                    processedValue = value;
                } else {
                    try {
                        processedValue = JSON.stringify(value);
                    } catch (error) {
                        console.warn(`DB: Failed to stringify value for key ${id}:`, error.message);
                        return;
                    }
                }
                
                const query = `INSERT INTO whatsapp_auth_creds (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = $2;`;
                await client.query(query, [id, processedValue]);
            } catch (error) {
                console.error(`DB: Error writing credentials for ${id}:`, error.message);
            } finally {
                client.release();
            }
        };

        const getCreds = async () => {
            const client = await pool.connect();
            try {
                const res = await client.query('SELECT value FROM whatsapp_auth_creds WHERE id = $1', ['creds']);
                if (res.rows.length === 0) {
                    console.log('DB: No credentials found, creating fresh auth state.');
                    const initialCreds = initAuthCreds();
                    console.log('DB: Fresh credentials initialized with registrationId:', initialCreds.registrationId);
                    await writeCreds('creds', initialCreds);
                    return initialCreds;
                } else {
                    console.log('DB: Found existing credentials in database');
                    const creds = res.rows[0].value;
                    const hasValidSession = !!(creds.me || creds.signedIdentityKey?.public || creds.registrationId);
                    console.log('DB: Session validity check:', {
                        hasMe: !!creds.me,
                        hasIdentityKey: !!creds.signedIdentityKey?.public,
                        hasRegistrationId: !!creds.registrationId,
                        hasValidSession
                    });
                    
                    if (hasValidSession) {
                        console.log('DB: Using existing valid session');
                        return creds;
                    } else {
                        console.log('DB: Existing credentials incomplete, creating fresh ones');
                        const freshCreds = initAuthCreds();
                        await writeCreds('creds', freshCreds);
                        return freshCreds;
                    }
                }
            } catch (error) {
                console.error('DB: Error in getCreds:', error);
                console.log('DB: Using fallback fresh credentials due to error');
                return initAuthCreds();
            } finally {
                client.release();
            }
        };

        const authState = {
            creds: await getCreds(),
            keys: {
                get: async (type, ids) => {
                    const map = {};
                    try {
                        const results = await Promise.all(ids.map(async (id) => {
                            const key = `${type}_${id}`;
                            const data = await readCreds(key);
                            return { id, data };
                        }));
                        
                        results.forEach(({ id, data }) => {
                            if (data && typeof data === 'string' && data.length > 0) {
                                try {
                                    map[id] = Buffer.from(data, 'base64');
                                } catch (error) {
                                    console.warn(`DB: Failed to decode key ${type}_${id}:`, error.message);
                                }
                            }
                        });
                        
                        console.log(`DB: Retrieved ${Object.keys(map).length}/${ids.length} keys for type ${type}`);
                        return map;
                    } catch (error) {
                        console.error(`DB: Error getting keys for type ${type}:`, error.message);
                        return {};
                    }
                },
                set: async (data) => {
                    if (!data || typeof data !== 'object') {
                        console.warn('DB: Invalid data provided to keys.set');
                        return;
                    }
                    
                    const tasks = [];
                    let savedKeys = 0;
                    
                    for (const type of Object.keys(data)) {
                        if (!data[type] || typeof data[type] !== 'object') continue;
                        
                        for (const id of Object.keys(data[type])) {
                            const value = data[type][id];
                            
                            if (value && (value instanceof Uint8Array || Buffer.isBuffer(value))) {
                                try {
                                    const base64Value = Buffer.from(value).toString('base64');
                                    tasks.push(writeCreds(`${type}_${id}`, base64Value));
                                    savedKeys++;
                                } catch (error) {
                                    console.warn(`DB: Failed to encode key ${type}_${id}:`, error.message);
                                }
                            }
                        }
                    }
                    
                    if (tasks.length > 0) {
                        await Promise.all(tasks);
                        console.log(`DB: Saved ${savedKeys} keys to database`);
                    }
                }
            }
        };

        const saveCreds = async () => {
            try {
                await writeCreds('creds', authState.creds);
                console.log('DB: Credentials saved successfully');
            } catch (error) {
                console.error('DB: Failed to save credentials:', error.message);
            }
        };

        console.log('DB: useDatabaseAuthState function completed successfully.');
        return { state: authState, saveCreds };

    } catch (error) {
        console.error('DB: Error in useDatabaseAuthState:', error);
        throw error;
    }
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
        this.currentQR = null;
    }

    async connect() {
        if (this.isConnecting || this.isConnected) return;

        try {
            this.isConnecting = true;
            this.logger.info('🔗 Initializing WhatsApp connection...');
            
            if (!pool) {
                pool = await connectToDatabase();
            }

            if (!pool) {
                throw new Error('Database connection required but not available');
            }

            const { version, isLatest } = await fetchLatestBaileysVersion();
            this.logger.info(`📱 Using WhatsApp Web v${version.join('.')}, isLatest: ${isLatest}`);
            
            const { state: authState, saveCreds } = await useDatabaseAuthState();
            this.logger.info('✅ Using database for authentication state.');
            
            const socketConfig = {
                version,
                logger: this.createBaileysLogger(),
                printQRInTerminal: false,
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
                retryRequestDelayMs: 250,
                maxMsgRetryCount: 5,
                appStateMacVerification: {
                    patch: true,
                    snapshot: true
                }
            };
            
            this.sock = makeWASocket(socketConfig);
            this.setupEventHandlers(saveCreds);
            this.logger.info('✅ WhatsApp client initialized successfully (Database storage)');
        } catch (error) {
            this.isConnecting = false;
            this.logger.error('❌ Failed to initialize WhatsApp client:', { message: error.message });
            throw error;
        }
    }

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

    async forceNewSession() {
        console.log('🔄 Forcing new session generation...');
        await this.clearAuthState();
        
        if (this.sock) {
            await this.disconnect();
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        await this.connect();
    }
    
    setupEventHandlers(saveCreds) {
        if (!this.sock) {
            console.error('❌ No socket available for event handlers');
            return;
        }
        
        console.log('🔧 Setting up WhatsApp event handlers...');
        
        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr, code, isNewLogin, isOnline, receivedPendingNotifications } = update;
            
            console.log('\n📡 CONNECTION UPDATE RECEIVED:');
            console.log('├─ Connection state:', connection);
            console.log('├─ Has QR code:', !!qr);
            console.log('├─ Has pairing code:', !!code);
            console.log('├─ Is new login:', isNewLogin);
            console.log('├─ Is online:', isOnline);
            console.log('├─ Received pending notifications:', receivedPendingNotifications);
            console.log('└─ Timestamp:', new Date().toISOString());
            
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
            }
        });

        this.sock.ev.on('creds.update', async () => {
            console.log('🔐 CREDENTIALS UPDATED - saving to database');
            try {
                await saveCreds();
                console.log('✅ Credentials saved successfully');
            } catch (error) {
                console.error('❌ Failed to save credentials:', error.message);
            }
        });

        this.sock.ev.on('messages.upsert', async (m) => {
            console.log('📨 Messages received:', m.messages?.length || 0);
            await this.handleMessages(m);
        });

        console.log('✅ Event handlers configured\n');
    }

    async handleQRCode(qr) {
        this.qrRetries++;
        this.currentQR = qr;
        this.logger.bot.qrCode(this.qrRetries, this.config.whatsapp.qrMaxRetries);
        
        if (this.qrRetries > this.config.whatsapp.qrMaxRetries) {
            this.logger.error('❌ Maximum QR retries exceeded');
            this.disconnect();
            return;
        }
        
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
        
        console.log('\n' + '='.repeat(80));
        console.log('📱 WHATSAPP QR CODE - DATABASE SESSION');
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
        
        this.emitConnectionEvent('qr', { 
            qr, 
            qrUrl,
            attempt: this.qrRetries, 
            maxAttempts: this.config.whatsapp.qrMaxRetries,
            expiresIn: 20000
        });
    }

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

    async handleConnection() {
        try {
            this.isConnected = true;
            this.isConnecting = false;
            this.qrRetries = 0;
            this.reconnectAttempts = 0;
            this.currentQR = null;
            
            const userInfo = this.sock.user;
            this.logger.info('✅ Successfully connected to WhatsApp!', {
                user: userInfo?.name || userInfo?.id,
                id: userInfo?.id
            });
            
            console.log('\n' + '🎉'.repeat(40));
            console.log('🚀 WHATSAPP BOT CONNECTED SUCCESSFULLY! 🚀');
            console.log('='.repeat(80));
            console.log(`📱 Connected as: ${userInfo?.name || 'Unknown'}`);
            console.log(`🆔 Phone Number: ${userInfo?.id || 'Unknown'}`);
            console.log(`🗄️ Storage: Database`);
            console.log(`⏰ Connected at: ${new Date().toLocaleString()}`);
            console.log('✅ Bot is now ready to receive messages!');
            console.log('📝 Authentication saved to database');
            console.log('🔄 Bot will auto-reconnect if connection drops');
            console.log('='.repeat(80));
            console.log('🎉'.repeat(40) + '\n');
            
            this.emitConnectionEvent('connected', { user: userInfo });
        } catch (error) {
            this.logger.error('Error handling connection:', error);
        }
    }

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
        console.log('='.repeat(80));
        console.log('⚠️'.repeat(40) + '\n');
        
        this.logger.info('🔌 Disconnected from WhatsApp', {
            reason: this.getDisconnectReasonText(disconnectReason),
            reasonCode: disconnectReason,
            errorMessage: errorMessage,
            shouldReconnect
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

    async attemptReconnection() {
        if (this.reconnectAttempts >= this.config.whatsapp.maxReconnectAttempts) {
            this.logger.error('❌ Maximum reconnection attempts exceeded');
            console.log('❌ Maximum reconnection attempts reached. Manual restart required.');
            return;
        }
        
        this.reconnectAttempts++;
        const delay = Math.min(
            this.config.whatsapp.reconnectIntervalMs * Math.pow(2, this.reconnectAttempts - 1),
            30000
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