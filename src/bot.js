/**
 * @fileoverview Main Bot class that handles WhatsApp message processing and interaction with the Gemini API.
 * @version 1.0.1
 * @author Your Name <your.email@example.com>
 */

// Import necessary modules
import { WhatsAppClient } from './core/whatsapp-client.js';
import { GeminiClient } from './services/gemini-client.js';
import { BotStateManager } from './core/state-manager.js';
import { HistoryManager } from './services/history-manager.js';
import { BotGuard } from './services/bot-guard.js';
import { MessageHandler } from './handlers/message-handler.js';
import { GroupHandler } from './handlers/group-handler.js';
import { createModuleLogger } from './utils/logger.js';
import { getConfig } from '../config.js';
import process from 'process';

/**
 * Main class for the WhatsApp bot.
 * It manages the bot's lifecycle, handles incoming messages, and orchestrates
 * the response generation using the Gemini API.
 */
export class Bot {
    constructor() {
        this.logger = createModuleLogger('Bot');
        this.isInitialized = false;
        this.isRunning = false;

        // Core components
        this.config = null;
        this.whatsappClient = null;
        this.geminiClient = null;
        this.stateManager = null;
        this.historyManager = null;
        this.botGuard = null;
        this.messageHandler = null;
        this.groupHandler = null;

        // Event handlers cleanup
        this.eventCleanupFunctions = [];

        // Graceful shutdown flag
        this.isShuttingDown = false;
    }

    /**
     * Initialize all bot components
     */
    async initialize() {
        try {
            if (this.isInitialized) {
                this.logger.warn('Bot already initialized');
                return;
            }

            // Get the configuration
            this.config = getConfig();

            this.logger.info('🚀 Initializing WhatsApp Bot...');
            this.logger.info(`📋 Bot Name: ${this.config.bot.name}`);
            this.logger.info(`👤 Owner: ${this.config.bot.owner.name} (${this.config.bot.owner.number})`);
            this.logger.info(`🤖 AI Model: ${this.config.gemini.model}`);

            // Validate required configuration
            await this.validateConfiguration();

            // Initialize components in a logical order
            this.logger.info('🔧 Initializing state manager...');
            this.stateManager = new BotStateManager(this.config);
            await this.stateManager.initialize();

            this.logger.info('📚 Initializing history manager...');
            this.historyManager = new HistoryManager(this.config);
            await this.historyManager.initialize();

            this.logger.info('🛡️ Initializing bot guard...');
            this.botGuard = new BotGuard(this.config);

            this.logger.info('🧠 Initializing Gemini AI client...');
            this.geminiClient = new GeminiClient(this.config);
            await this.geminiClient.initialize();

            // Initialize WhatsApp client with the config object
            this.logger.info('📱 Initializing WhatsApp client...');
            this.whatsappClient = new WhatsAppClient(this.config);

            // Initialize message handlers, passing the necessary components
            this.logger.info('💬 Initializing message handlers...');
            const handlerDependencies = {
                whatsapp: this.whatsappClient,
                gemini: this.geminiClient,
                historyManager: this.historyManager,
                stateManager: this.stateManager,
                botGuard: this.botGuard,
                logger: this.logger,
                bot: this // Pass the bot instance itself
            };

            this.messageHandler = new MessageHandler(this.config, handlerDependencies);
            this.groupHandler = new GroupHandler(this.config, handlerDependencies);

            this.isInitialized = true;
            this.logger.info('✅ Bot initialization completed successfully');

        } catch (error) {
            this.logger.error('❌ Bot initialization failed:', {
                message: error.message,
                stack: error.stack,
                name: error.name
            });
            await this.cleanup();
            throw error;
        }
    }

    /**
     * Start the bot
     */
    async start() {
        try {
            if (!this.isInitialized) {
                await this.initialize();
            }

            if (this.isRunning) {
                this.logger.warn('Bot is already running');
                return;
            }

            this.logger.info('🚀 Starting WhatsApp Bot...');

            // Setup WhatsApp client event handlers
            this.setupWhatsAppEventHandlers();

            // Ensure the whatsappClient is ready before connecting
            if (!this.whatsappClient) {
                throw new Error("WhatsApp client not initialized");
            }
            await this.whatsappClient.connect();

            this.isRunning = true;
            this.logger.info('✅ Bot started successfully');

            // Log current bot state
            const state = this.stateManager.getState();
            this.logger.info(`🤖 Bot is ${state.isActive ? 'ACTIVE' : 'INACTIVE'}`);

        } catch (error) {
            this.logger.error('❌ Failed to start bot:', {
                message: error.message,
                stack: error.stack,
                name: error.name
            });
            await this.cleanup();
            throw error;
        }
    }

    /**
     * Stop the bot
     */
    async stop() {
        try {
            if (this.isShuttingDown) {
                this.logger.warn('Bot is already shutting down');
                return;
            }

            this.isShuttingDown = true;
            this.logger.info('🔄 Shutting down bot...');

            // Clean up event handlers
            this.cleanupEventHandlers();

            // Disconnect WhatsApp client
            if (this.whatsappClient) {
                await this.whatsappClient.disconnect();
            }

            // Shutdown all components
            await this.cleanup();

            this.isRunning = false;
            this.isShuttingDown = false;
            this.logger.info('✅ Bot shutdown completed');
            
            // Terminate the Node.js process to prevent auto-restart
            this.logger.info('Exiting process gracefully...');
            process.exit(0);

        } catch (error) {
            this.logger.error('❌ Error during bot shutdown:', error);
            // Terminate the process with an error code if something goes wrong
            this.logger.error('Exiting process with error code 1');
            process.exit(1);
        }
    }
    
    /**
     * Setup WhatsApp client event handlers
     */
    setupWhatsAppEventHandlers() {
        if (!this.whatsappClient) {
            this.logger.error('WhatsApp client not initialized');
            return;
        }

        // Connection events
        const connectionHandler = this.whatsappClient.onConnectionEvent('connected', (data) => {
            this.handleWhatsAppConnected(data);
        });
        this.eventCleanupFunctions.push(connectionHandler);

        const disconnectionHandler = this.whatsappClient.onConnectionEvent('disconnected', (data) => {
            this.handleWhatsAppDisconnected(data);
        });
        this.eventCleanupFunctions.push(disconnectionHandler);

        const qrHandler = this.whatsappClient.onConnectionEvent('qr', (data) => {
            this.handleQRCode(data);
        });
        this.eventCleanupFunctions.push(qrHandler);

        // Message handler
        const messageHandler = this.whatsappClient.onMessage(async (message) => {
            await this.handleIncomingMessage(message);
        });
        this.eventCleanupFunctions.push(messageHandler);

        this.logger.debug('WhatsApp event handlers setup complete');
    }

    /**
     * Handle WhatsApp connection established
     */
    async handleWhatsAppConnected(data) {
        try {
            this.logger.info('🎉 WhatsApp connected successfully!', {
                user: data.user?.name || data.user?.id
            });

            // Update bot state if needed
            const state = this.stateManager.getState();
            if (!state.isActive) {
                this.logger.info('🤖 Bot is currently inactive. Use /on command to activate.');
            }

            // Send startup notification to owner (if configured)
            await this.sendStartupNotification(data.user);

        } catch (error) {
            this.logger.error('Error handling WhatsApp connection:', error);
        }
    }

    /**
     * Handle WhatsApp disconnection
     */
    async handleWhatsAppDisconnected(data) {
        try {
            this.logger.warn('📴 WhatsApp disconnected', {
                reason: data.reason,
                shouldReconnect: data.shouldReconnect
            });

            if (!data.shouldReconnect && !this.isShuttingDown) {
                this.logger.error('⚠️ WhatsApp logged out - bot restart required');
            }

        } catch (error) {
            this.logger.error('Error handling WhatsApp disconnection:', error);
        }
    }

    /**
     * Handle QR code generation
     */
    async handleQRCode(data) {
        try {
            this.logger.info(`📱 QR Code generated (attempt ${data.attempt})`, {
                maxAttempts: this.config.whatsapp.qrMaxRetries
            });
        } catch (error) {
            this.logger.error('Error handling QR code:', error);
        }
    }

    /**
     * Handle incoming messages
     */
    async handleIncomingMessage(message) {
        try {
            // ⭐ NEW: Add an early check for message body and fromMe property
            if (message.key.fromMe || !message.message) {
                this.logger.debug('Ignoring empty or self-sent message', { messageId: message.key.id });
                return;
            }

            // Get chat and contact information
            const chat = await this.whatsappClient.getChat(message.key.remoteJid);
            const contact = await this.whatsappClient.getContact(message.key.participant || message.key.remoteJid);

            // Convert Baileys message format to our internal format
            const internalMessage = {
                id: { _serialized: message.key.id },
                body: message.message?.conversation ||
                    message.message?.extendedTextMessage?.text ||
                    message.message?.imageMessage?.caption ||
                    message.message?.videoMessage?.caption ||
                    '',
                from: message.key.remoteJid,
                fromMe: message.key.fromMe,
                timestamp: message.messageTimestamp,
                type: this.getMessageType(message),
                hasMedia: this.hasMedia(message),
                hasQuotedMsg: !!message.message?.extendedTextMessage?.contextInfo?.quotedMessage,
                mentionedIds: message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [],
                reply: async (content) => {
                    return await this.whatsappClient.sendMessage(message.key.remoteJid, content);
                }
            };

            // Ensure the message body is not empty after conversion
            if (!internalMessage.body.trim() && !internalMessage.hasMedia) {
                this.logger.debug('Ignoring message with no text or media after conversion.', { messageId: message.key.id });
                return;
            }
            
            // Route to appropriate handler
            if (chat.isGroup) {
                await this.groupHandler.handleMessage(internalMessage, chat, contact);
            } else {
                await this.messageHandler.handleMessage(internalMessage, chat, contact);
            }

        } catch (error) {
            this.logger.error('Error handling incoming message:', {
                error: error.message,
                messageId: message.key?.id,
                from: message.key?.remoteJid
            });
        }
    }
    /**
     * Send startup notification to owner
     */
    async sendStartupNotification(user) {
        try {
            if (!this.config.bot.owner.number) {
                return;
            }

            const ownerJid = `${this.config.bot.owner.number}@s.whatsapp.net`;
            const state = this.stateManager.getState();
            
            const message = `🤖 *${this.config.bot.name} Started*

✅ Bot is now online and ready!
📱 Connected as: ${user?.name || user?.id || 'Unknown'}
🔋 Status: ${state.isActive ? '🟢 ACTIVE' : '🔴 INACTIVE'}
⏰ Started: ${new Date().toLocaleString()}

${!state.isActive ? '💡 Use */on* to activate the bot' : ''}

Type */help* for available commands.`;

            await this.whatsappClient.sendMessage(ownerJid, { text: message });
            
            this.logger.info('📤 Startup notification sent to owner');

        } catch (error) {
            this.logger.warn('Failed to send startup notification:', error.message);
        }
    }

    /**
     * Validate configuration
     */
    async validateConfiguration() {
        const errors = [];
        const config = this.config;

        // Check required environment variables
        if (!config.gemini.apiKey) {
            errors.push('GEMINI_API_KEY is required');
        }

        if (!config.bot.owner.number) {
            errors.push('BOT_OWNER_NUMBER is required');
        }

        // Validate Gemini API key format (basic check)
        if (config.gemini.apiKey && !config.gemini.apiKey.startsWith('AIza')) {
            this.logger.warn('⚠️ Gemini API key format looks unusual - please verify it\'s correct');
        }

        // Validate phone number format
        if (config.bot.owner.number && !/^\d+$/.test(config.bot.owner.number.replace(/\D/g, ''))) {
            this.logger.warn('⚠️ Owner phone number format may be invalid');
        }

        if (errors.length > 0) {
            throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
        }

        this.logger.info('✅ Configuration validation passed');
    }

    /**
     * Get message type from Baileys message
     */
    getMessageType(message) {
        if (message.message?.conversation) return 'chat';
        if (message.message?.extendedTextMessage) return 'chat';
        if (message.message?.imageMessage) return 'image';
        if (message.message?.videoMessage) return 'video';
        if (message.message?.audioMessage) return 'audio';
        if (message.message?.documentMessage) return 'document';
        if (message.message?.stickerMessage) return 'sticker';
        return 'unknown';
    }

    /**
     * Check if message has media
     */
    hasMedia(message) {
        return !!(
            message.message?.imageMessage ||
            message.message?.videoMessage ||
            message.message?.audioMessage ||
            message.message?.documentMessage ||
            message.message?.stickerMessage
        );
    }

    /**
     * Clean up event handlers
     */
    cleanupEventHandlers() {
        this.logger.debug('Cleaning up event handlers');
        
        for (const cleanup of this.eventCleanupFunctions) {
            try {
                cleanup();
            } catch (error) {
                this.logger.warn('Error cleaning up event handler:', error.message);
            }
        }
        
        this.eventCleanupFunctions = [];
    }

    /**
     * Cleanup all components
     */
    async cleanup() {
        try {
            this.logger.debug('Starting component cleanup...');

            // Cleanup in reverse order of initialization
            if (this.geminiClient) {
                await this.geminiClient.shutdown();
                this.geminiClient = null;
            }

            if (this.botGuard) {
                await this.botGuard.shutdown();
                this.botGuard = null;
            }

            if (this.historyManager) {
                await this.historyManager.shutdown();
                this.historyManager = null;
            }

            if (this.stateManager) {
                await this.stateManager.shutdown();
                this.stateManager = null;
            }

            // Clear handlers
            this.messageHandler = null;
            this.groupHandler = null;
            this.whatsappClient = null;

            this.isInitialized = false;
            this.logger.debug('Component cleanup completed');

        } catch (error) {
            this.logger.error('Error during cleanup:', error);
        }
    }

    /**
     * Get bot status
     */
    getStatus() {
        try {
            const config = this.config;
            const whatsappStatus = this.whatsappClient?.getStatus() || { connected: false };
            const botState = this.stateManager?.getState() || { isActive: false };
            const geminiStats = this.geminiClient?.getUsageStats() || { requestCount: 0 };
            const historyStats = this.historyManager?.getStatistics() || { totalChats: 0 };
            const guardStats = this.botGuard?.getStatistics() || { activeUsers: 0 };

            return {
                bot: {
                    initialized: this.isInitialized,
                    running: this.isRunning,
                    active: botState.isActive,
                    version: config.bot.version,
                    uptime: this.stateManager?.getFormattedUptime() || '0s'
                },
                whatsapp: whatsappStatus,
                ai: {
                    model: config.gemini.model,
                    requests: geminiStats.requestCount,
                    initialized: this.geminiClient?.isInitialized || false
                },
                stats: {
                    totalMessages: botState.totalMessages || 0,
                    totalChats: historyStats.totalChats,
                    activeUsers: guardStats.activeUsers,
                    blockedUsers: guardStats.blockedUsers
                }
            };

        } catch (error) {
            this.logger.error('Error getting bot status:', error);
            return {
                error: error.message,
                initialized: this.isInitialized,
                running: this.isRunning
            };
        }
    }

    /**
     * Health check
     */
    async healthCheck() {
        try {
            const status = this.getStatus();
            const issues = [];

            if (!status.bot.initialized) {
                issues.push('Bot not initialized');
            }

            if (!status.whatsapp.connected) {
                issues.push('WhatsApp not connected');
            }

            if (!status.ai.initialized) {
                issues.push('AI client not initialized');
            }

            return {
                healthy: issues.length === 0,
                issues,
                status
            };

        } catch (error) {
            return {
                healthy: false,
                issues: [`Health check failed: ${error.message}`],
                error: error.message
            };
        }
    }
}