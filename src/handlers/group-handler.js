// src/handlers/group-handler.js
import { createModuleLogger } from '../utils/logger.js';

export class GroupHandler {
  constructor(config, { gemini, historyManager, stateManager, botGuard, logger }) {
    this.config = config;
    this.gemini = gemini;
    this.historyManager = historyManager;
    this.stateManager = stateManager;
    this.botGuard = botGuard;
    this.logger = logger || createModuleLogger('GroupHandler');
    this.commandPrefix = this.config.messages.commands.prefix;
    this.responses = this.config.messages.responses;
    this.mentionTriggers = this.config.groups.mentionTriggers || [];
    this.maxResponseLength = this.config.groups.maxGroupResponseLength || 800;
    this.respondOnlyWhenMentioned = this.config.groups.respondOnlyWhenMentioned;
  }

  /**
   * Handle incoming group messages
   */
  async handleMessage(message, chat, contact) {
    try {
      const contactName = contact.pushname || contact.name || contact.number;
      const messageText = message.body?.trim() || '';
      const groupName = chat.name || 'Unknown Group';

      this.logger.info('👥 Processing group message', {
        from: message.from,
        group: groupName,
        contact: contactName,
        messageLength: messageText.length,
        hasMedia: message.hasMedia,
        type: message.type
      });

      // Add message to history
      this.historyManager.addMessage(chat.id._serialized, message, {
        senderName: contactName,
        groupName: groupName
      });

      // Check if message is a command
      if (this.isCommand(messageText)) {
        return await this.handleGroupCommand(message, messageText, contact, chat);
      }

      // Check if bot is active
      const botState = this.stateManager.getState();
      if (!botState.isActive) {
        this.logger.debug('Bot is inactive, ignoring group message', {
          from: message.from,
          group: groupName
        });
        return;
      }

      // Check if bot should respond based on mention triggers
      const shouldRespond = await this.shouldRespondToMessage(message, chat);
      
      if (!shouldRespond) {
        this.logger.debug('Message does not trigger response', {
          from: message.from,
          group: groupName,
          messageText: messageText.substring(0, 50)
        });
        return;
      }

      // Apply rate limiting and bot guard checks
      const guardResult = await this.botGuard.checkMessage(message, chat, contact);
      if (!guardResult.allowed) {
        this.logger.warn('Group message blocked by bot guard', {
          reason: guardResult.reason,
          from: message.from,
          group: groupName
        });

        if (guardResult.shouldRespond) {
          await message.reply(guardResult.response);
        }
        return;
      }

      // Skip media messages for now (can be extended later)
      if (message.hasMedia) {
        await message.reply("📎 I see you shared media! I currently only respond to text messages in groups. Feel free to describe what you'd like to discuss!");
        return;
      }

      // Generate AI response for group
      await this.generateAndSendGroupResponse(message, chat, contact, messageText);

    } catch (error) {
      this.logger.error('Error handling group message', {
        error: error.message,
        messageId: message.id._serialized,
        from: message.from,
        group: chat.name
      });

      try {
        await message.reply(this.responses.error);
      } catch (replyError) {
        this.logger.error('Failed to send error reply in group', { 
          error: replyError.message 
        });
      }
    }
  }

  /**
   * Handle group commands
   */
  async handleGroupCommand(message, messageText, contact, chat) {
    try {
      const command = this.parseCommand(messageText);
      const contactNumber = this.extractPhoneNumber(contact.id._serialized);
      const isOwner = this.isOwner(contactNumber);
      const groupName = chat.name || 'Unknown Group';

      this.logger.info('🔧 Processing group command', {
        command: command.name,
        args: command.args,
        isOwner,
        from: message.from,
        group: groupName
      });

      let response = '';

      switch (command.name.toLowerCase()) {
        case 'help':
          response = `🤖 *${this.config.bot.name} - Group Commands*\n\n*Available Commands:*\n/help - Show this help\n/status - Check bot status\n\n*How to interact:*\n• Mention me with @${this.config.bot.owner.number}\n• Use keywords: ${this.mentionTriggers.slice(1).join(', ')}\n• Start message with "${this.config.bot.name.split(' ')[0]}"\n\n*Note:* I only respond when mentioned in groups!`;
          break;

        case 'status':
          response = await this.getGroupStatusResponse();
          break;

        case 'on':
        case 'start':
        case 'activate':
          if (!isOwner) {
            response = "🚫 Only my owner can activate me!";
          } else {
            response = await this.toggleBot(true, contactNumber);
          }
          break;

        case 'off':
        case 'stop':
        case 'deactivate':
          if (!isOwner) {
            response = "🚫 Only my owner can deactivate me!";
          } else {
            response = await this.toggleBot(false, contactNumber);
          }
          break;

        case 'joke':
          if (this.stateManager.getState().isActive) {
            response = await this.gemini.generateCommandResponse('joke', command.args, {
              isGroup: true,
              contactName: contact.pushname || contact.name,
              maxLength: this.maxResponseLength
            });
          } else {
            response = "😴 I'm currently inactive. My owner can activate me with /on";
          }
          break;

        case 'fact':
          if (this.stateManager.getState().isActive) {
            response = await this.gemini.generateCommandResponse('fact', command.args, {
              isGroup: true,
              contactName: contact.pushname || contact.name,
              maxLength: this.maxResponseLength
            });
          } else {
            response = "😴 I'm currently inactive. My owner can activate me with /on";
          }
          break;

        case 'quote':
          if (this.stateManager.getState().isActive) {
            response = await this.gemini.generateCommandResponse('quote', command.args, {
              isGroup: true,
              contactName: contact.pushname || contact.name,
              maxLength: this.maxResponseLength
            });
          } else {
            response = "😴 I'm currently inactive. My owner can activate me with /on";
          }
          break;

        default:
          response = `❓ Unknown command: *${command.name}*\n\nSend */help* to see available commands in groups.`;
      }

      await message.reply(response);

    } catch (error) {
      this.logger.error('Error handling group command', {
        error: error.message,
        command: messageText,
        from: message.from,
        group: chat.name
      });

      await message.reply("❌ Something went wrong processing that command.");
    }
  }

  /**
   * Determine if bot should respond to the message
   */
  async shouldRespondToMessage(message, chat) {
    try {
      const messageText = message.body?.trim().toLowerCase() || '';
      
      if (!this.respondOnlyWhenMentioned) {
        // If configured to respond to all messages, return true
        return true;
      }

      // Check for direct mentions (@number)
      if (message.mentionedIds && message.mentionedIds.length > 0) {
        const ownerWAId = `${this.config.bot.owner.number}@c.us`;
        const isMentioned = message.mentionedIds.some(id => id === ownerWAId);
        
        if (isMentioned) {
          this.logger.debug('Bot mentioned directly', {
            from: message.from,
            mentionedIds: message.mentionedIds
          });
          return true;
        }
      }

      // Check for mention triggers in message text
      for (const trigger of this.mentionTriggers) {
        if (messageText.includes(trigger.toLowerCase())) {
          this.logger.debug('Message contains mention trigger', {
            trigger,
            from: message.from,
            messagePreview: messageText.substring(0, 50)
          });
          return true;
        }
      }

      // Check if message starts with bot name
      const botNameWords = this.config.bot.name.toLowerCase().split(' ');
      const firstBotWord = botNameWords[0];
      
      if (messageText.startsWith(firstBotWord)) {
        this.logger.debug('Message starts with bot name', {
          botName: firstBotWord,
          from: message.from
        });
        return true;
      }

      // Check if it's a reply to one of bot's messages
      if (message.hasQuotedMsg) {
        const quotedMsg = await message.getQuotedMessage();
        if (quotedMsg && quotedMsg.fromMe) {
          this.logger.debug('Message is reply to bot message', {
            from: message.from,
            quotedMsgId: quotedMsg.id._serialized
          });
          return true;
        }
      }

      return false;

    } catch (error) {
      this.logger.error('Error checking if should respond', {
        error: error.message,
        from: message.from
      });
      return false;
    }
  }

  /**
   * Generate and send AI response in group
   */
  async generateAndSendGroupResponse(message, chat, contact, messageText) {
    try {
      const contactName = contact.pushname || contact.name || 'User';
      const groupName = chat.name || 'Group';
      
      // Get limited conversation context for groups (less context to avoid spam)
      const context = this.historyManager.getContextForAI(chat.id._serialized, Math.floor(this.maxResponseLength / 2));
      
      this.logger.debug('🧠 Generating group AI response', {
        messageLength: messageText.length,
        contextMessages: context.length,
        from: message.from,
        group: groupName
      });

      // Clean the message text by removing mention triggers
      let cleanMessageText = messageText;
      for (const trigger of this.mentionTriggers) {
        const regex = new RegExp(trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        cleanMessageText = cleanMessageText.replace(regex, '').trim();
      }

      // If message is too short after cleaning, use original
      if (cleanMessageText.length < 3) {
        cleanMessageText = messageText;
      }

      // Generate response using Gemini with group-specific options
      const aiResponse = await this.gemini.generateResponse(cleanMessageText, context, {
        isGroup: true,
        contactName,
        groupName,
        maxLength: this.maxResponseLength
      });

      if (!aiResponse || aiResponse.trim().length === 0) {
        this.logger.warn('Empty AI response received for group', { 
          from: message.from,
          group: groupName 
        });
        await message.reply("🤔 I'm not sure how to respond to that. Could you be more specific?");
        return;
      }

      // Ensure response isn't too long for groups
      let finalResponse = aiResponse;
      if (finalResponse.length > this.maxResponseLength) {
        finalResponse = finalResponse.substring(0, this.maxResponseLength - 3) + '...';
      }

      // Send the response
      await message.reply(finalResponse);

      // Add bot response to history
      this.historyManager.addMessage(chat.id._serialized, {
        id: { _serialized: `bot_group_${Date.now()}` },
        body: finalResponse,
        from: chat.id._serialized,
        fromMe: true,
        timestamp: Date.now() / 1000,
        type: 'chat',
        hasMedia: false
      }, {
        senderName: this.config.bot.name,
        groupName: groupName
      });

      this.logger.info('✅ Group AI response sent successfully', {
        responseLength: finalResponse.length,
        to: message.from,
        group: groupName
      });

    } catch (error) {
      this.logger.error('Error generating group AI response', {
        error: error.message,
        from: message.from,
        group: chat.name,
        messageText: messageText.substring(0, 100)
      });

      // Try to send a fallback response
      try {
        await message.reply("🤖 I'm having trouble processing that message in the group. Please try again!");
      } catch (replyError) {
        this.logger.error('Failed to send fallback response in group', { 
          error: replyError.message 
        });
      }
    }
  }

  /**
   * Toggle bot on/off (same as MessageHandler)
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

      this.logger.info(`🔄 Bot ${activate ? 'activated' : 'deactivated'} in group`, {
        toggledBy,
        timestamp: new Date().toISOString()
      });

      return activate ? this.responses.botActivated : this.responses.botDeactivated;

    } catch (error) {
      this.logger.error('Error toggling bot state in group', { 
        error: error.message,
        activate,
        toggledBy 
      });
      return this.responses.error;
    }
  }

  /**
   * Get group-specific status response
   */
  async getGroupStatusResponse() {
    try {
      const state = this.stateManager.getState();
      const stats = this.historyManager.getStatistics();

      const uptime = Math.floor((Date.now() - new Date(state.activeSince).getTime()) / 1000);
      const uptimeFormatted = this.formatUptime(uptime);

      return `🤖 *${this.config.bot.name} Group Status*

🔋 *State:* ${state.isActive ? '🟢 ACTIVE' : '🔴 INACTIVE'}
📊 *Messages:* ${state.totalMessages}
⏰ *Uptime:* ${uptimeFormatted}
💬 *Active Chats:* ${stats.totalChats}

*Group Features:*
• Mention Required: ${this.respondOnlyWhenMentioned ? '✅' : '❌'}
• Max Response: ${this.maxResponseLength} chars
• Triggers: ${this.mentionTriggers.join(', ')}

*Owner:* ${this.config.bot.owner.name}`;

    } catch (error) {
      this.logger.error('Error generating group status response', { error: error.message });
      return "❌ Unable to retrieve status information.";
    }
  }

  /**
   * Helper methods (same as MessageHandler)
   */
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