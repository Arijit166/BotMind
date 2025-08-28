import { createModuleLogger } from '../utils/logger.js';
import pkg from 'baileys';
const { MessageMedia } = pkg;

export class MessageHandler {
  constructor(config, { whatsapp, gemini, historyManager, stateManager, botGuard, logger, bot }) {
    this.config = config;
    this.whatsappClient = whatsapp;
    this.gemini = gemini;
    this.historyManager = historyManager;
    this.stateManager = stateManager;
    this.botGuard = botGuard;
    this.logger = logger || createModuleLogger('MessageHandler');
    this.bot = bot;
    
    this.commandPrefix = this.config.messages.commands.prefix;
    this.responses = this.config.messages.responses;
  }

  async handleMessage(message, chat, contact) {
    try {
      const contactName = contact.pushname || contact.name || contact.number;
      const messageText = message.body?.trim() || '';

      // 🟢 START: NEW LOGIC TO HANDLE MESSAGES SENT TO SELF
      if (message.fromMe) {
        this.logger.debug('Message is from the bot\'s own number (fromMe: true). Checking for owner command.');
        const contactNumber = this.extractPhoneNumber(message.from);
        const isOwner = this.isOwner(contactNumber);
        
        // Only process if it's a command from the owner. Ignore all other "fromMe" messages.
        if (isOwner && this.isCommand(messageText)) {
            this.logger.info('✅ Owner command detected from self-chat. Processing...');
            return await this.handleCommand(message, messageText, contact);
        } else {
            this.logger.debug('Ignoring non-command or non-owner message from self-chat.');
            return;
        }
      }
      // 🟢 END: NEW LOGIC

      this.logger.info('📨 Processing direct message', {
        from: message.from,
        contact: contactName,
        messageLength: messageText.length,
        hasMedia: message.hasMedia,
        type: message.type
      });

      this.historyManager.addMessage(chat.id._serialized, message, {
        senderName: contactName
      });

      if (this.isCommand(messageText)) {
        return await this.handleCommand(message, messageText, contact);
      }

      const botState = this.stateManager.getState();
      if (!botState.isActive) {
        this.logger.debug('Bot is inactive, ignoring message', {
          from: message.from,
          messageText: messageText.substring(0, 50)
        });
        return;
      }

      const guardResult = await this.botGuard.checkMessage(message, chat, contact);
      if (!guardResult.allowed) {
        this.logger.warn('Message blocked by bot guard', {
          reason: guardResult.reason,
          from: message.from
        });
        if (guardResult.shouldRespond) {
          await message.reply({ text: guardResult.response });
        }
        return;
      }

      if (message.hasMedia) {
        await message.reply({ text: "📎 I received your media! However, I currently only respond to text messages. Please describe what you'd like to know!" });
        return;
      }

      await this.generateAndSendResponse(message, chat, contact, messageText);
    } catch (error) {
      this.logger.error('Error handling direct message', {
        error: error.message,
        messageId: message.id._serialized,
        from: message.from
      });
      try {
        await message.reply({ text: this.responses.error });
      } catch (replyError) {
        this.logger.error('Failed to send error reply', {
          error: replyError.message
        });
      }
    }
  }

  // ... THE REST OF THE FILE (handleCommand, toggleBot, etc.) REMAINS EXACTLY THE SAME ...
  // (The full code is included below for simplicity)

  async handleCommand(message, messageText, contact) {
    try {
      const command = this.parseCommand(messageText);
      const contactNumber = this.extractPhoneNumber(contact.id._serialized);
      const isOwner = this.isOwner(contactNumber);

      this.logger.info('🔧 Processing command', {
        command: command.name,
        args: command.args,
        isOwner,
        from: message.from
      });

      let response = '';

      if (command.name.toLowerCase() === 'image') {
        if (!this.stateManager.getState().isActive) {
          response = "😴 Bot is currently inactive. Use /on to activate.";
        } else if (command.args.length === 0) {
          response = "🖼️ Please provide a prompt for the image, e.g., `/image a majestic lion`.";
        } else {
          await message.reply({ text: "⌛ Generating your image... this may take a moment." });
          const prompt = command.args.join(' ');
          try {
            const imageUrl = await this.imageClient.generateImage(prompt);
            await message.reply({ 
              image: { url: imageUrl }, 
              caption: `🖼️ Here is your image, generated with the prompt: *"${prompt}"*` 
            });
            return;
          } catch (err) {
            this.logger.error('Error generating or sending image', { error: err.message, prompt });
            response = "❌ I'm sorry, I couldn't generate that image right now.";
          }
        }
      } else {
        switch (command.name.toLowerCase()) {
          case 'help':
            response = this.responses.help;
            break;
          case 'status':
            response = await this.getStatusResponse();
            break;
          case 'on':
          case 'start':
          case 'activate':
            if (!isOwner) {
              response = this.responses.unauthorized;
            } else {
              await this.toggleBot(message, true, contactNumber);
              return;
            }
            break;
          case 'off':
          case 'stop':
          case 'deactivate':
            if (!isOwner) {
              response = this.responses.unauthorized;
            } else {
              await this.toggleBot(message, false, contactNumber);
              return;
            }
            break;
          case 'about':
            const owner = this.config.bot.owner;
            response = `
👨🏻‍💻 *About Me*
I am an AI assistant created by ${owner.name}.
I live in ${owner.residence}.
📚 *Education*
My owner is a ${owner.study_year} student at ${owner.college}.
He previously attended ${owner.school}.
            `.trim();
            break;
          case 'joke':
            if (this.stateManager.getState().isActive) {
              response = await this.gemini.generateCommandResponse('joke', command.args, {
                contactName: contact.pushname || contact.name,
                maxLength: 500
              });
            } else {
              response = "😴 Bot is currently inactive. Use /on to activate.";
            }
            break;
          case 'fact':
            if (this.stateManager.getState().isActive) {
              response = await this.gemini.generateCommandResponse('fact', command.args, {
                contactName: contact.pushname || contact.name,
                maxLength: 600
              });
            } else {
              response = "😴 Bot is currently inactive. Use /on to activate.";
            }
            break;
          case 'quote':
            if (this.stateManager.getState().isActive) {
              response = await this.gemini.generateCommandResponse('quote', command.args, {
                contactName: contact.pushname || contact.name,
                maxLength: 400
              });
            } else {
              response = "😴 Bot is currently inactive. Use /on to activate.";
            }
            break;
          case 'clear':
            if (isOwner) {
              const cleared = this.historyManager.clearChatHistory(message.from);
              response = `🗑️ Cleared ${cleared} messages from our chat history.`;
            } else {
              response = this.responses.unauthorized;
            }
            break;
          case 'stats':
            if (isOwner) {
              response = await this.getBotStatistics();
            } else {
              response = this.responses.unauthorized;
            }
            break;
          default:
            response = `❓ Unknown command: *${command.name}*\n\nSend */help* to see available commands.`;
        }
      }

      if (response) {
        await message.reply({ text: response });
      }
    } catch (error) {
      this.logger.error('Error handling command', {
        error: error.message,
        command: messageText,
        from: message.from
      });
      await message.reply({ text: this.responses.error });
    }
  }

  async generateAndSendResponse(message, chat, contact, messageText) {
    try {
      const contactName = contact.pushname || contact.name || 'User';
      const context = this.historyManager.getContextForAI(chat.id._serialized);
      this.logger.debug('🧠 Generating AI response', {
        messageLength: messageText.length,
        contextMessages: context.length,
        from: message.from
      });
      const prePrompt = this.createPersonalizationPrompt();
      const aiResponse = await this.gemini.generateResponse(messageText, context, {
        isGroup: false,
        contactName,
        prePrompt,
        maxLength: this.config.gemini.generationConfig.maxOutputTokens
      });
      if (!aiResponse || aiResponse.trim().length === 0) {
        this.logger.warn('Empty AI response received', { from: message.from });
        await message.reply({ text: " I'm not sure how to respond to that right now. Could you try rephrasing?" });
        return;
      }
      await message.reply({ text: aiResponse });
      this.historyManager.addMessage(chat.id._serialized, {
        id: { _serialized: `bot_${Date.now()}` },
        body: aiResponse,
        from: chat.id._serialized,
        fromMe: true,
        timestamp: Date.now() / 1000,
        type: 'chat',
        hasMedia: false
      }, {
        senderName: this.config.bot.name
      });
      this.logger.info('✅ AI response sent successfully', {
        responseLength: aiResponse.length,
        to: message.from
      });
    } catch (error) {
      this.logger.error('Error generating AI response', {
        error: error.message,
        from: message.from,
        messageText: messageText.substring(0, 100)
      });
      try {
        await message.reply({ text: "🤖 I'm having trouble processing your message right now. Please try again in a moment!" });
      } catch (replyError) {
        this.logger.error('Failed to send fallback response', {
          error: replyError.message
        });
      }
    }
  }

  createPersonalizationPrompt() {
    const owner = this.config.bot.owner;
    return `
You are an AI assistant and companion named ${this.config.bot.name}.
Your primary role is to be a helpful and friendly companion.
Your owner is named ${owner.name}.
You know the following information about your owner:
- Owner's Name: ${owner.name}
- Owner's School: ${owner.school}
- Owner's College: ${owner.college}
- Owner's Residence: ${owner.residence}
- Owner's Year of Study: ${owner.study_year}

When the user asks about your owner, use this information to provide a detailed and accurate response. Do not invent details that are not provided.
    `.trim();
  }

  async toggleBot(message, activate, toggledBy) {
    try {
      const currentState = this.stateManager.getState();
      let response = '';

      if (activate && currentState.isActive) {
        response = this.responses.alreadyOn;
        await message.reply({ text: response });
        return;
      }
      if (!activate && !currentState.isActive) {
        response = this.responses.alreadyOff;
        await message.reply({ text: response });
        return;
      }
      await this.stateManager.setState({
        isActive: activate,
        lastToggled: new Date().toISOString(),
        toggledBy
      });
      this.logger.info(`🔄 Bot ${activate ? 'activated' : 'deactivated'}`, {
        toggledBy,
        timestamp: new Date().toISOString()
      });
      response = activate ? this.responses.botActivated : this.responses.botDeactivated;
      await message.reply({ text: response });
      if (!activate) {
        this.logger.info('Bot deactivated. Initiating shutdown.');
        setTimeout(() => this.stopBot(), 1000);
      }
      return;
    } catch (error) {
      this.logger.error('Error toggling bot state', {
        error: error.message,
        activate,
        toggledBy
      });
      await message.reply({ text: this.responses.error });
    }
  }
  
  async stopBot() {
    this.logger.info('Handler is requesting bot shutdown...');
    if (this.bot && typeof this.bot.stop === 'function') {
      await this.bot.stop();
    } else {
      this.logger.error('Main bot instance is not available. Forcing exit.');
      process.exit(1);
    }
  }

  async getStatusResponse() {
    try {
      const state = this.stateManager.getState();
      const stats = this.historyManager.getStatistics();
      const geminiStats = this.gemini.getUsageStats();
      const uptime = this.stateManager.getFormattedUptime();
      return `🤖 *${this.config.bot.name} Status*
🔋 *State:* ${state.isActive ? '🟢 ACTIVE' : '🔴 INACTIVE'}
📊 *Messages Processed:* ${state.totalMessages}
⏰ *Uptime:* ${uptime}
🧠 *AI Requests:* ${geminiStats.requestCount}
💬 *Active Chats:* ${stats.totalChats}
📈 *Total History:* ${stats.totalMessages} messages
*Last Toggled:* ${new Date(state.lastToggled).toLocaleString()}
*Owner:* ${this.config.bot.owner.name}`;
    } catch (error) {
      this.logger.error('Error generating status response', { error: error.message });
      return "❌ Unable to retrieve status information.";
    }
  }

  async getBotStatistics() {
    try {
      const state = this.stateManager.getState();
      const historyStats = this.historyManager.getStatistics();
      const geminiStats = this.gemini.getUsageStats();
      const memoryUsage = process.memoryUsage();
      return `📊 *Detailed Bot Statistics*
*Bot Status:*
• State: ${state.isActive ? '🟢 Active' : '🔴 Inactive'}
• Total Messages: ${state.totalMessages}
• Active Since: ${new Date(state.activeSince).toLocaleString()}
*Chat History:*
• Total Chats: ${historyStats.totalChats}
• Total Messages: ${historyStats.totalMessages}
• Average per Chat: ${historyStats.averageMessagesPerChat.toFixed(2)}
*AI Usage:*
• Requests Made: ${geminiStats.requestCount}
• Model: ${this.config.gemini.model}
• Last Request: ${geminiStats.lastRequestTime ? new Date(geminiStats.lastRequestTime).toLocaleString() : 'N/A'}
*System Info:*
• Memory Used: ${Math.round(memoryUsage.rss / 1024 / 1024)}MB
• Node.js: ${process.version}
• Platform: ${process.platform}
• Uptime: ${this.formatUptime(process.uptime())}`;
    } catch (error) {
      this.logger.error('Error generating statistics', { error: error.message });
      return "❌ Unable to retrieve statistics.";
    }
  }

  isCommand(text) {
    return text && text.startsWith(this.commandPrefix);
  }

  parseCommand(text) {
    const cleanText = text.substring(1).trim();
    const parts = cleanText.split(/\s+/);
    return {
      name: parts[0] || '',
      args: parts.slice(1)
    };
  }

  isOwner(phoneNumber) {
    if (!phoneNumber || !this.config.bot.owner.number) return false;
    const cleanOwnerNumber = this.config.bot.owner.number.replace(/\D/g, '');
    const cleanUserNumber = phoneNumber.replace(/\D/g, '');
    return cleanOwnerNumber === cleanUserNumber;
  }

  extractPhoneNumber(whatsappId) {
    return whatsappId.split('@')[0];
  }

  formatUptime(seconds) {
    const secs = Math.floor(seconds);
    const days = Math.floor(secs / 86400);
    const hours = Math.floor((secs % 86400) / 3600);
    const minutes = Math.floor((secs % 3600) / 60);
    const remainingSeconds = secs % 60;
    
    let parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (remainingSeconds > 0 || parts.length === 0) parts.push(`${remainingSeconds}s`);
    
    return parts.join(' ');
  }
}