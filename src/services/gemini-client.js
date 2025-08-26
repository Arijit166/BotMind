import { GoogleGenerativeAI } from '@google/generative-ai'; // 🟢 Correct library name
import { createModuleLogger } from '../utils/logger.js';
// ❌ REMOVE the direct import of config to avoid circular dependencies
// import config from '../../config.js';

export class GeminiClient {
    // 🟢 CORRECTED: Accept 'config' as a parameter in the constructor
    constructor(config) {
        this.config = config; // 🟢 Store the config object
        this.logger = createModuleLogger('GeminiClient');
        this.genAI = null;
        this.model = null;
        this.isInitialized = false;
        this.requestCount = 0;
        this.lastRequestTime = Date.now();
    }

    /**
     * Initialize Gemini AI client
     */
    async initialize() {
        try {
            // 🟢 CORRECTED: Access config from 'this.config'
            if (!this.config.gemini.apiKey) {
                throw new Error('Gemini API key is required');
            }

            this.genAI = new GoogleGenerativeAI(this.config.gemini.apiKey);
            this.model = this.genAI.getGenerativeModel({
                model: this.config.gemini.model,
                generationConfig: this.config.gemini.generationConfig,
                safetySettings: this.config.gemini.safetySettings
            });

            this.isInitialized = true;
            this.logger.info('✅ Gemini AI client initialized successfully');

        } catch (error) {
            this.logger.error('❌ Failed to initialize Gemini AI:', error.message);
            throw new Error(`Gemini initialization failed: ${error.message}`);
        }
    }

    /**
     * Generate response from Gemini
     */
    async generateResponse(prompt, context = [], options = {}) {
        try {
            if (!this.isInitialized) {
                throw new Error('Gemini client not initialized');
            }

            // Rate limiting check
            this.checkRateLimit();

            // Build the complete prompt with context and personality
            const fullPrompt = this.buildPrompt(prompt, context, options);

            // Generate response
            const result = await this.model.generateContent(fullPrompt);
            const response = await result.response;
            const text = response.text();

            this.requestCount++;
            this.lastRequestTime = Date.now();

            const cleanedText = this.cleanResponse(text);

            this.logger.info('🤖 Gemini response generated:', {
                promptLength: fullPrompt.length,
                responseLength: cleanedText.length,
                requestCount: this.requestCount
            });

            return cleanedText;

        } catch (error) {
            this.logger.error('❌ Gemini generation failed:', error.message);
            
            if (error.message.includes('SAFETY')) {
                return "🚫 I can't provide a response to that message due to safety guidelines. Please try rephrasing your question.";
            } else if (error.message.includes('QUOTA')) {
                return "⏳ I'm currently experiencing high demand. Please try again in a few moments.";
            } else if (error.message.includes('RATE_LIMIT')) {
                return "🐌 Please slow down! I need a moment to process your request.";
            }
            
            return "❌ I'm having trouble generating a response right now. Please try again.";
        }
    }

    /**
     * Build complete prompt with context and personality
     */
    buildPrompt(userMessage, context = [], options = {}) {
        const { isGroup = false, contactName = 'User', maxLength = 1000 } = options;
        
        let prompt = '';

        prompt += `You are ${this.config.bot.personality.description}\n\n`;
        prompt += `Your traits: ${this.config.bot.personality.traits.join(', ')}\n\n`;
        
        if (isGroup) {
            prompt += `This is a group chat message. Respond naturally and keep it concise (max ${this.config.groups.maxGroupResponseLength} characters).\n`;
        } else {
            prompt += `This is a private chat with ${contactName}. Be friendly and helpful.\n`;
        }

        if (context.length > 0) {
            prompt += '\nRecent conversation context:\n';
            context.forEach((msg) => {
                const role = msg.fromMe ? 'You' : (msg.senderName || 'User');
                prompt += `[${new Date(msg.timestamp).toLocaleTimeString()}] ${role}: ${msg.body}\n`;
            });
        }

        prompt += `\nCurrent message from ${contactName}: ${userMessage}\n\n`;
        prompt += 'Please respond naturally and helpfully. Keep your response under ' + maxLength + ' characters.';
        
        if (isGroup) {
            prompt += ' Since this is a group chat, be concise and engaging.';
        }

        return prompt;
    }

    /**
     * Clean and format the response
     */
    cleanResponse(text) {
        if (!text) return "I'm not sure how to respond to that.";

        let cleaned = text
            .replace(/\*\*(.*?)\*\*/g, '*$1*') 
            .replace(/__(.*?)__/g, '_$1_') 
            .replace(/`(.*?)`/g, '$1') 
            .replace(/#{1,6}\s/g, '') 
            .replace(/^\s*[\-\*\+]\s/gm, '• ')
            .trim();

        if (cleaned.length > this.config.gemini.generationConfig.maxOutputTokens) {
            cleaned = cleaned.substring(0, this.config.gemini.generationConfig.maxOutputTokens - 3) + '...';
        }

        if (!cleaned || cleaned.length < 3) {
            return "I understand, but I'm not sure how to respond to that right now.";
        }

        return cleaned;
    }

    /**
     * Generate a summary of conversation history
     */
    async generateSummary(messages, maxLength = 200) {
        try {
            if (!messages || messages.length === 0) {
                return null;
            }

            const conversationText = messages.map(msg => {
                const role = msg.fromMe ? 'Assistant' : 'User';
                return `${role}: ${msg.body}`;
            }).join('\n');

            const summaryPrompt = `Please provide a brief summary of this conversation in ${maxLength} characters or less. Focus on the key topics and context:\n\n${conversationText}`;

            const summary = await this.generateResponse(summaryPrompt, [], { maxLength });
            
            return summary;

        } catch (error) {
            this.logger.error('Failed to generate conversation summary:', error.message);
            return null;
        }
    }

    /**
     * Check for rate limiting
     */
    checkRateLimit() {
        const now = Date.now();
        const timeDiff = now - this.lastRequestTime;
        
        if (timeDiff < 1000) {
            throw new Error('RATE_LIMIT: Please wait before sending another request');
        }

        if (timeDiff > 60 * 60 * 1000) {
            this.requestCount = 0;
        }

        if (this.requestCount > 100) {
            throw new Error('QUOTA: Hourly request limit reached');
        }
    }

    /**
     * Health check for Gemini API
     */
    async healthCheck() {
        try {
            if (!this.isInitialized) {
                return false;
            }

            const testPrompt = "Respond with just 'OK' to confirm you're working.";
            const result = await this.model.generateContent(testPrompt);
            const response = await result.response;
            const text = response.text();
            
            this.logger.info('🔍 Gemini health check:', { 
                success: true, 
                response: text.substring(0, 50) 
            });
            
            return true;

        } catch (error) {
            this.logger.error('❌ Gemini health check failed:', error.message);
            return false;
        }
    }

    /**
     * Get usage statistics
     */
    getUsageStats() {
        return {
            requestCount: this.requestCount,
            lastRequestTime: new Date(this.lastRequestTime).toISOString(),
            isInitialized: this.isInitialized,
            model: this.config.gemini.model,
            uptime: Date.now() - this.lastRequestTime
        };
    }

    /**
     * Generate response for specific command
     */
    async generateCommandResponse(command, args = [], options = {}) {
        try {
            let prompt = '';

            switch (command.toLowerCase()) {
                case 'help':
                    return this.config.messages.responses.help;
                    
                case 'status':
                    const stats = this.getUsageStats();
                    return `🤖 *Bot Status*\n\n✅ Active and ready\n📊 Requests processed: ${stats.requestCount}\n🧠 AI Model: ${stats.model}\n⏰ Last activity: ${new Date(stats.lastRequestTime).toLocaleTimeString()}`;
                    
                case 'joke':
                    prompt = 'Tell me a clean, family-friendly joke. Keep it short and funny.';
                    break;
                    
                case 'fact':
                    prompt = 'Share an interesting and educational fact. Make it engaging but not too long.';
                    break;
                    
                case 'quote':
                    prompt = 'Share an inspirational quote with attribution. Keep it motivating and positive.';
                    break;
                    
                default:
                    prompt = `Respond to the command "${command}" with arguments "${args.join(' ')}" in a helpful way.`;
            }

            return await this.generateResponse(prompt, [], options);

        } catch (error) {
            this.logger.error('Command response generation failed:', error.message);
            return "❌ I couldn't process that command right now. Please try again.";
        }
    }

    /**
     * Clean shutdown
     */
    async shutdown() {
        try {
            this.logger.info('🔄 Shutting down Gemini client...');
            this.isInitialized = false;
            this.model = null;
            this.genAI = null;
            this.logger.info('✅ Gemini client shutdown complete');
        } catch (error) {
            this.logger.error('❌ Error during Gemini shutdown:', error.message);
        }
    }
}