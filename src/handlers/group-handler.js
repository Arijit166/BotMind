import { createModuleLogger } from '../utils/logger.js';

export class GroupHandler {
    constructor(config, { whatsapp, gemini, historyManager, stateManager, botGuard, logger, bot }) {
        this.config = config;
        this.whatsappClient = whatsapp;
        this.gemini = gemini;
        this.historyManager = historyManager;
        this.stateManager = stateManager;
        this.botGuard = botGuard;
        this.logger = logger || createModuleLogger('GroupHandler');
        this.bot = bot; // Store the bot instance
        this.commandPrefix = this.config.messages.commands.prefix;
        this.responses = this.config.messages.responses;
        this.mentionTriggers = this.config.groups.mentionTriggers || [];
        this.maxResponseLength = this.config.groups.maxGroupResponseLength || 800;
        this.respondOnlyWhenMentioned = this.config.groups.respondOnlyWhenMentioned;
        this.alwaysPersonalizeInGroups = this.config.groups.alwaysPersonalizeInGroups || false; 
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

            // Determine if bot should respond based on mention triggers
            const shouldRespondExplicitly = await this.shouldRespondToMessage(message, chat);
            
            // If configured to respond only when mentioned, and it wasn't, then return
            if (this.respondOnlyWhenMentioned && !shouldRespondExplicitly) {
                this.logger.debug('Message does not trigger response and respondOnlyWhenMentioned is true', {
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
            await this.generateAndSendGroupResponse(message, chat, contact, messageText, shouldRespondExplicitly);
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
                        await this.toggleBot(message, true, contactNumber);
                        return;
                    }
                    break;

                case 'off':
                case 'stop':
                case 'deactivate':
                    if (!isOwner) {
                        response = "🚫 Only my owner can deactivate me!";
                    } else {
                        await this.toggleBot(message, false, contactNumber);
                        return;
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
            
            if (response && typeof response === 'string') {
                await message.reply({ text: response });
            }

        } catch (error) {
            this.logger.error('Error handling group command', {
                error: error.message,
                command: messageText,
                from: message.from,
                group: chat.name
            });

            await message.reply({ text: "❌ Something went wrong processing that command." });
        }
    }

    async shouldRespondToMessage(message, chat) {
        try {
            const messageText = message.body?.trim().toLowerCase() || '';
            
            if (!this.respondOnlyWhenMentioned) {
                return true;
            }

            if (message.mentionedIds && message.mentionedIds.length > 0) {
                const ownerPhoneNumber = this.config.bot.owner.number;
                
                const isMentioned = message.mentionedIds.some(mentionedJid => {
                    const mentionedNumber = mentionedJid.split('@')[0];
                    return mentionedNumber === ownerPhoneNumber;
                });
                
                if (isMentioned) {
                    this.logger.debug('Bot mentioned directly by number/username', {
                        from: message.from,
                        mentionedIds: message.mentionedIds
                    });
                    return true;
                }
            }

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

            const botNameWords = this.config.bot.name.toLowerCase().split(' ');
            const firstBotWord = botNameWords[0];
            
            if (messageText.startsWith(firstBotWord)) {
                this.logger.debug('Message starts with bot name', {
                    botName: firstBotWord,
                    from: message.from
                });
                return true;
            }

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

    async generateAndSendGroupResponse(message, chat, contact, messageText, shouldRespondExplicitly) {
        try {
            const contactName = contact.pushname || contact.name || 'User';
            const groupName = chat.name || 'Group';
            
            const context = this.historyManager.getContextForAI(chat.id._serialized, Math.floor(this.maxResponseLength / 2));
            
            this.logger.debug('🧠 Generating group AI response', {
                messageLength: messageText.length,
                contextMessages: context.length,
                from: message.from,
                group: groupName
            });

            let cleanMessageText = messageText;
            for (const trigger of this.mentionTriggers) {
                const regex = new RegExp(trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                cleanMessageText = cleanMessageText.replace(regex, '').trim();
            }

            if (cleanMessageText.length < 3) {
                cleanMessageText = messageText;
            }

            const prePrompt = shouldRespondExplicitly || this.config.groups.alwaysPersonalizeInGroups 
                                ? this.createPersonalizationPrompt() 
                                : '';

            const aiResponse = await this.gemini.generateResponse(cleanMessageText, context, {
                isGroup: true,
                contactName,
                groupName,
                prePrompt,
                maxLength: this.maxResponseLength
            });

            if (!aiResponse || aiResponse.trim().length === 0) {
                this.logger.warn('Empty AI response received for group', { 
                    from: message.from,
                    group: groupName 
                });
                await message.reply({ text: "🤔 I'm not sure how to respond to that. Could you be more specific?" });
                return;
            }

            let finalResponse = aiResponse;
            if (finalResponse.length > this.maxResponseLength) {
                finalResponse = finalResponse.substring(0, this.maxResponseLength - 3) + '...';
            }

            await message.reply({ text: finalResponse });

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

            try {
                await message.reply({ text: "🤖 I'm having trouble processing that message in the group. Please try again!" });
            } catch (replyError) {
                this.logger.error('Failed to send fallback response in group', { 
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

            this.logger.info(`🔄 Bot ${activate ? 'activated' : 'deactivated'} in group`, {
                toggledBy,
                timestamp: new Date().toISOString()
            });
            
            response = activate ? this.responses.botActivated : this.responses.botDeactivated;
            await message.reply({ text: response });

            if (!activate) {
                this.logger.info('Bot deactivated. Initiating shutdown from group command.');
                setTimeout(() => this.stopBot(), 1000);
            }

            return;

        } catch (error) {
            this.logger.error('Error toggling bot state in group', { 
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