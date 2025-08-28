import { createModuleLogger } from '../utils/logger.js';

export class MessageHandler {
  constructor(config, gemini, historyManager, stateManager, botGuard, logger) {
    this.config = config;
    this.gemini = gemini;
    this.historyManager = historyManager;
    this.stateManager = stateManager;
    this.botGuard = botGuard;
    this.logger = logger || createModuleLogger('MessageHandler');
    
    this.commandPrefix = this.config.messages.commands.prefix;
    this.responses = this.config.messages.responses;
  }

  /**
   * Handle incoming direct messages
   */
  async handleMessage(message, chat, contact) {
    try {
      const contactName = contact.pushname || contact.name || contact.number;
      const messageText = message.body?.trim() || '';

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
          await message.reply(guardResult.response);
        }
        return;
      }

      if (message.hasMedia) {
        await message.reply("📎 I received your media! However, I currently only respond to text messages. Please describe what you'd like to know!");
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
        await message.reply(this.responses.error);
      } catch (replyError) {
        this.logger.error('Failed to send error reply', { 
          error: replyError.message 
        });
      }
    }
  }

  /**
   * Handle bot commands
   */
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
            response = await this.toggleBot(true, contactNumber);
          }
          break;

        case 'off':
        case 'stop':
        case 'deactivate':
          if (!isOwner) {
            response = this.responses.unauthorized;
          } else {
            response = await this.toggleBot(false, contactNumber);
          }
          break;

        // 🟢 ADDED: New command to provide personalized information
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

      await message.reply(response);

    } catch (error) {
      this.logger.error('Error handling command', {
        error: error.message,
        command: messageText,
        from: message.from
      });

      await message.reply(this.responses.error);
    }
  }

  /**
   * Generate and send AI response
   */
  async generateAndSendResponse(message, chat, contact, messageText) {
    try {
      const contactName = contact.pushname || contact.name || 'User';
      
      // Get conversation context
      const context = this.historyManager.getContextForAI(chat.id._serialized);
      
      this.logger.debug('🧠 Generating AI response', {
        messageLength: messageText.length,
        contextMessages: context.length,
        from: message.from
      });

      // 🟢 ADDED: Create a custom prompt for the AI
      const prePrompt = this.createPersonalizationPrompt();

      // Generate response using Gemini
      const aiResponse = await this.gemini.generateResponse(messageText, context, {
        isGroup: false,
        contactName,
        prePrompt, // 🟢 PASS THE PRE-PROMPT TO GEMINI
        maxLength: this.config.gemini.generationConfig.maxOutputTokens
      });

      if (!aiResponse || aiResponse.trim().length === 0) {
        this.logger.warn('Empty AI response received', { from: message.from });
        await message.reply(" I'm not sure how to respond to that right now. Could you try rephrasing?");
        return;
      }

      // Send the response
      await message.reply(aiResponse);

      // Add bot response to history
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

      // Try to send a fallback response
      try {
        await message.reply("🤖 I'm having trouble processing your message right now. Please try again in a moment!");
      } catch (replyError) {
        this.logger.error('Failed to send fallback response', { 
          error: replyError.message 
        });
      }
    }
  }

  /**
   * 🟢 ADDED: New method to create a personalized pre-prompt
   */
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

  /**
   * Toggle bot on/off
   */
  async toggleBot(activate, toggledBy) {
    try {
      const currentState = this.stateManager.getState();
      
      if (activate && currentState.isActive) {
        return this.responses.alreadyOn;
      }
      
      if (!activate && !currentState.isActive) {
        return this.responses.alreadyOff;
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

      return activate ? this.responses.botActivated : this.responses.botDeactivated;

    } catch (error) {
      this.logger.error('Error toggling bot state', { 
        error: error.message,
        activate,
        toggledBy 
      });
      return this.responses.error;
    }
  }

  /**
   * Get formatted status response
   */
  async getStatusResponse() {
    try {
      const state = this.stateManager.getState();
      const stats = this.historyManager.getStatistics();
      const geminiStats = this.gemini.getUsageStats();

      const uptime = Math.floor((Date.now() - new Date(state.activeSince).getTime()) / 1000);
      const uptimeFormatted = this.formatUptime(uptime);

      return `🤖 *${this.config.bot.name} Status*

🔋 *State:* ${state.isActive ? '🟢 ACTIVE' : '🔴 INACTIVE'}
📊 *Messages Processed:* ${state.totalMessages}
⏰ *Uptime:* ${uptimeFormatted}
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

  /**
   * Get detailed bot statistics (owner only)
   */
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
• Average per Chat: ${historyStats.averageMessagesPerChat}

*AI Usage:*
• Requests Made: ${geminiStats.requestCount}
• Model: ${geminiStats.model}
• Last Request: ${new Date(geminiStats.lastRequestTime).toLocaleString()}

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

  /**
   * Helper methods
   */

  isCommand(text) {
    return text && text.startsWith(this.commandPrefix);
  }

  parseCommand(text) {
    const cleanText = text.substring(1).trim(); // Remove prefix
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
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    
    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    } else {
      return `${remainingSeconds}s`;
    }
  }
}