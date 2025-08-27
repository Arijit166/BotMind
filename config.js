// Dynamic configuration that reads environment variables at runtime
export function getConfig() {
  return {
    bot: {
      // ✅ Corrected: Using environment variables for a personalized bot name
      name: process.env.BOT_NAME || "Arijit's AI Assistant",
      version: '1.0.0',
      owner: {
        // ✅ Added: New owner information for personalization
        number: process.env.BOT_OWNER_NUMBER || '',
        name: process.env.BOT_OWNER_NAME || 'Arijit',
        school: process.env.BOT_OWNER_SCHOOL || '', 
        college: process.env.BOT_OWNER_COLLEGE || '',
        residence: process.env.BOT_OWNER_RESIDENCE || '',
        study_year: process.env.BOT_OWNER_STUDY_YEAR || ''
      },
      personality: {
        description: "a helpful, friendly, and knowledgeable AI assistant",
        traits: [
          "helpful", "friendly", "knowledgeable", "concise",
          "professional", "empathetic", "patient"
        ]
      }
    },

    whatsapp: {
      // ✅ Corrected: Changed hardcoded session path to use an environment variable
      sessionPath: process.env.SESSION_PATH || '.wwebjs_auth',
      printQRInTerminal: true,
      defaultProtocolVersion: [2, 3000, 1015901307],
      connectTimeoutMs: 60000,
      authTimeoutMs: 60000,
      maxReconnectAttempts: 5,
      reconnectIntervalMs: 5000,
      qrMaxRetries: 5
    },

    gemini: {
      apiKey: process.env.GEMINI_API_KEY || '',
      model: 'gemini-2.5-flash',
      generationConfig: {
        temperature: 0.7,
        topK: 32,
        topP: 0.95,
        maxOutputTokens: 1000,
      },
      safetySettings: [
        {
          category: 'HARM_CATEGORY_HARASSMENT',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE',
        },
        {
          category: 'HARM_CATEGORY_HATE_SPEECH',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE',
        },
        {
          category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE',
        },
        {
          category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE',
        },
      ]
    },

    messages: {
      commands: {
        prefix: '/'
      },
      responses: {
        help: `🤖 *WhatsApp AI Bot Help*

*Available Commands:*
• /help - Show this help message
• /status - Check bot status
• /joke - Get a random joke
• /fact - Get an interesting fact
• /quote - Get an inspirational quote

*Owner Commands:*
• /on - Activate the bot
• /off - Deactivate the bot
• /clear - Clear chat history
• /stats - Get detailed statistics

*How to use:*
Just send me a message and I'll respond using AI! In groups, mention me or use my name to get my attention.

*Need help?* Contact my owner: ${process.env.BOT_OWNER_NAME || 'Owner'}`,

        error: "❌ Something went wrong. Please try again later.",
        unauthorized: "🚫 You don't have permission to use this command.",
        botActivated: "✅ Bot has been activated! I'm ready to chat.",
        botDeactivated: "😴 Bot has been deactivated. I'll take a break now.",
        alreadyOn: "✅ Bot is already active!",
        alreadyOff: "😴 Bot is already inactive!"
      }
    },

    groups: {
      enabled: true,
      respondOnlyWhenMentioned: true,
      maxGroupResponseLength: 800,
      mentionTriggers: ['bot', 'ai', 'assistant', 'help']
    },

    // ❌ REMOVED THE TOP-LEVEL rateLimit OBJECT
    // The rateLimit object is now only defined inside state.default

    state: {
      filePath: './data/bot-state.json',
      default: {
        isActive: true,
        lastToggled: new Date().toISOString(),
        toggledBy: null,
        totalMessages: 0,
        activeSince: new Date().toISOString(),
        version: '1.0.0',
        settings: {
          respondToGroups: true,
          mentionRequired: true,
          maxResponseLength: 1000,
          typingIndicator: true
        },
        statistics: {
          privateChats: 0,
          groupChats: 0,
          commandsProcessed: 0,
          errorsEncountered: 0,
          lastRestart: new Date().toISOString()
        },
        rateLimit: {
          enabled: true, // 🟢 ADDED HERE 🟢
          maxMessagesPerMinute: 10, // 🟢 ADDED HERE 🟢
          maxMessagesPerHour: 100, // 🟢 ADDED HERE 🟢
          cooldownMessages: [ // 🟢 ADDED HERE 🟢
            "🐌 Slow down there! Please wait a moment before sending another message.",
            "⏳ You're sending messages a bit too quickly. Take a breather!",
            "🛑 Hold on! Please wait a few seconds before your next message.",
            "💨 Whoa, slow down! Let's chat at a more relaxed pace."
          ],
          lastReset: new Date().toISOString(),
          requestCounts: {}
        }
      }
    },

    logging: {
      level: process.env.LOG_LEVEL || 'info',
      file: {
        enabled: true,
        filename: './logs/bot.log',
        maxSize: '10m',
        maxFiles: 5
      },
      console: {
        enabled: true,
        colorize: true
      }
    },

    history: {
      enabled: true,
      maxMessagesPerChat: 100,
      maxContextLength: 20,
      cleanupIntervalMs: 24 * 60 * 60 * 1000, // 24 hours
      maxChatAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    }
  };
}

// Export a default function that returns the config
export default getConfig;
