import fs from 'fs/promises';
import path from 'path';
import { createModuleLogger } from '../utils/logger.js';

export class HistoryManager {
  // 🟢 CORRECTED: Accept 'config' as a parameter.
  constructor(config) {
    this.logger = createModuleLogger('HistoryManager');
    this.config = config; // Store the passed-in config object
    this.chatHistories = new Map(); // chatId -> messages[]
    this.isEnabled = this.config.history.enabled; // Use the stored config
    this.maxMessagesPerChat = this.config.history.maxMessagesPerChat; // Use the stored config
    this.maxContextLength = this.config.history.maxContextLength; // Use the stored config
    this.cleanupInterval = null;

    // Setup cleanup timer
    this.setupCleanupTimer();
  }

  /**
   * Initialize the history manager
   */
  async initialize() {
    try {
      this.logger.info('🔧 Initializing history manager...');

      if (!this.isEnabled) {
        this.logger.info('📝 History manager disabled in config');
        return;
      }

      this.logger.info('✅ History manager initialized successfully', {
        maxMessagesPerChat: this.maxMessagesPerChat,
        maxContextLength: this.maxContextLength
      });

    } catch (error) {
      this.logger.error('Failed to initialize history manager', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Add a message to chat history
   */
  addMessage(chatId, message, metadata = {}) {
    try {
      if (!this.isEnabled) return;

      // Get or create chat history
      let chatHistory = this.chatHistories.get(chatId) || [];

      // Create standardized message object
      const historyMessage = {
        id: message.id?._serialized || `${Date.now()}_${Math.random()}`,
        body: message.body || '',
        from: message.from || chatId,
        fromMe: message.fromMe || false,
        timestamp: message.timestamp ? message.timestamp * 1000 : Date.now(), // Convert to milliseconds
        type: message.type || 'chat',
        hasMedia: message.hasMedia || false,
        senderName: metadata.senderName || 'Unknown',
        groupName: metadata.groupName || null,
        addedAt: Date.now()
      };

      // Add to history
      chatHistory.push(historyMessage);

      // Maintain size limit
      if (chatHistory.length > this.maxMessagesPerChat) {
        chatHistory = chatHistory.slice(-this.maxMessagesPerChat);
      }

      // Update chat history
      this.chatHistories.set(chatId, chatHistory);

      this.logger.debug('Message added to history', {
        chatId,
        messageId: historyMessage.id,
        totalMessages: chatHistory.length,
        senderName: historyMessage.senderName
      });

    } catch (error) {
      this.logger.error('Failed to add message to history', {
        error: error.message,
        chatId,
        messageId: message.id?._serialized
      });
    }
  }

  /**
   * Get conversation context for AI
   */
  getContextForAI(chatId, maxMessages = null) {
    try {
      if (!this.isEnabled) return [];

      const chatHistory = this.chatHistories.get(chatId) || [];
      const limit = maxMessages || this.maxContextLength;

      // Get recent messages (excluding current message)
      const recentMessages = chatHistory
        .slice(-limit - 1, -1) // Exclude the last message (current one)
        .filter(msg => msg.body && msg.body.trim().length > 0) // Only text messages
        .map(msg => ({
          body: msg.body,
          fromMe: msg.fromMe,
          senderName: msg.senderName,
          timestamp: msg.timestamp,
          type: msg.type
        }));

      this.logger.debug('Context retrieved for AI', {
        chatId,
        requestedLimit: limit,
        availableMessages: chatHistory.length,
        contextMessages: recentMessages.length
      });

      return recentMessages;

    } catch (error) {
      this.logger.error('Failed to get context for AI', {
        error: error.message,
        chatId
      });
      return [];
    }
  }

  /**
   * Get full chat history
   */
  getChatHistory(chatId, limit = null) {
    try {
      if (!this.isEnabled) return [];

      const chatHistory = this.chatHistories.get(chatId) || [];

      if (limit && limit > 0) {
        return chatHistory.slice(-limit);
      }

      return [...chatHistory]; // Return copy to prevent mutation

    } catch (error) {
      this.logger.error('Failed to get chat history', {
        error: error.message,
        chatId
      });
      return [];
    }
  }

  /**
   * Clear chat history
   */
  clearChatHistory(chatId) {
    try {
      const chatHistory = this.chatHistories.get(chatId) || [];
      const messageCount = chatHistory.length;

      this.chatHistories.delete(chatId);

      this.logger.info('Chat history cleared', {
        chatId,
        messagesCleared: messageCount
      });

      return messageCount;

    } catch (error) {
      this.logger.error('Failed to clear chat history', {
        error: error.message,
        chatId
      });
      return 0;
    }
  }

  /**
   * Clear all history
   */
  clearAllHistory() {
    try {
      const totalChats = this.chatHistories.size;
      const totalMessages = this.getTotalMessageCount();

      this.chatHistories.clear();

      this.logger.info('All chat history cleared', {
        chatsCleared: totalChats,
        messagesCleared: totalMessages
      });

      return { chats: totalChats, messages: totalMessages };

    } catch (error) {
      this.logger.error('Failed to clear all history', {
        error: error.message
      });
      return { chats: 0, messages: 0 };
    }
  }

  /**
   * Get statistics
   */
  getStatistics() {
    try {
      const totalChats = this.chatHistories.size;
      const totalMessages = this.getTotalMessageCount();
      const averageMessagesPerChat = totalChats > 0 ? Math.round(totalMessages / totalChats) : 0;

      // Get chat size distribution
      const chatSizes = Array.from(this.chatHistories.values()).map(history => history.length);
      const maxChatSize = chatSizes.length > 0 ? Math.max(...chatSizes) : 0;
      const minChatSize = chatSizes.length > 0 ? Math.min(...chatSizes) : 0;

      return {
        enabled: this.isEnabled,
        totalChats,
        totalMessages,
        averageMessagesPerChat,
        maxChatSize,
        minChatSize,
        memoryUsage: this.getMemoryUsageEstimate(),
        configuration: {
          maxMessagesPerChat: this.maxMessagesPerChat,
          maxContextLength: this.maxContextLength,
          cleanupInterval: this.config.history.cleanupIntervalMs // Use the stored config
        }
      };

    } catch (error) {
      this.logger.error('Failed to get statistics', {
        error: error.message
      });
      return {
        enabled: this.isEnabled,
        totalChats: 0,
        totalMessages: 0,
        averageMessagesPerChat: 0,
        error: error.message
      };
    }
  }

  /**
   * Get total message count across all chats
   */
  getTotalMessageCount() {
    let total = 0;
    for (const history of this.chatHistories.values()) {
      total += history.length;
    }
    return total;
  }

  /**
   * Estimate memory usage
   */
  getMemoryUsageEstimate() {
    try {
      let totalSize = 0;

      for (const [chatId, history] of this.chatHistories.entries()) {
        // Rough estimation: chatId + messages
        totalSize += chatId.length * 2; // Unicode characters

        for (const message of history) {
          totalSize += JSON.stringify(message).length * 2; // Rough estimate
        }
      }

      // Convert to KB
      return Math.round(totalSize / 1024);

    } catch (error) {
      this.logger.warn('Failed to estimate memory usage', {
        error: error.message
      });
      return 0;
    }
  }

  /**
   * Setup cleanup timer
   */
  setupCleanupTimer() {
    if (!this.isEnabled) return;

    // Run cleanup periodically
    this.cleanupInterval = setInterval(() => {
      this.performCleanup();
    }, this.config.history.cleanupIntervalMs); // Use the stored config

    this.logger.debug('History cleanup timer setup', {
      intervalMs: this.config.history.cleanupIntervalMs
    });
  }

  /**
   * Perform cleanup of old messages
   */
  performCleanup() {
    try {
      if (!this.isEnabled) return;

      const now = Date.now();
      const maxAge = this.config.history.maxChatAge; // Use the stored config
      let cleanedChats = 0;
      let cleanedMessages = 0;

      for (const [chatId, history] of this.chatHistories.entries()) {
        const originalLength = history.length;

        // Remove messages older than maxAge
        const filteredHistory = history.filter(msg => {
          const messageAge = now - msg.addedAt;
          return messageAge < maxAge;
        });

        if (filteredHistory.length === 0) {
          // Remove empty chats
          this.chatHistories.delete(chatId);
          cleanedChats++;
          cleanedMessages += originalLength;
        } else if (filteredHistory.length < originalLength) {
          // Update chat with filtered history
          this.chatHistories.set(chatId, filteredHistory);
          cleanedMessages += (originalLength - filteredHistory.length);
        }
      }

      if (cleanedChats > 0 || cleanedMessages > 0) {
        this.logger.info('History cleanup completed', {
          cleanedChats,
          cleanedMessages,
          remainingChats: this.chatHistories.size,
          remainingMessages: this.getTotalMessageCount()
        });
      }

    } catch (error) {
      this.logger.error('Failed to perform cleanup', {
        error: error.message
      });
    }
  }

  /**
   * Search messages in chat
   */
  searchInChat(chatId, query, limit = 10) {
    try {
      if (!this.isEnabled) return [];

      const chatHistory = this.chatHistories.get(chatId) || [];
      const queryLower = query.toLowerCase();

      const matches = chatHistory
        .filter(msg => msg.body.toLowerCase().includes(queryLower))
        .slice(-limit)
        .map(msg => ({
          id: msg.id,
          body: msg.body,
          senderName: msg.senderName,
          timestamp: msg.timestamp,
          fromMe: msg.fromMe
        }));

      this.logger.debug('Chat search completed', {
        chatId,
        query,
        matches: matches.length,
        totalMessages: chatHistory.length
      });

      return matches;

    } catch (error) {
      this.logger.error('Failed to search in chat', {
        error: error.message,
        chatId,
        query
      });
      return [];
    }
  }

  /**
   * Export chat history (for debugging/backup)
   */
  exportChatHistory(chatId) {
    try {
      const chatHistory = this.chatHistories.get(chatId) || [];

      return {
        chatId,
        messageCount: chatHistory.length,
        exportedAt: new Date().toISOString(),
        messages: chatHistory.map(msg => ({
          ...msg,
          timestamp: new Date(msg.timestamp).toISOString()
        }))
      };

    } catch (error) {
      this.logger.error('Failed to export chat history', {
        error: error.message,
        chatId
      });
      return null;
    }
  }

  /**
   * Clean shutdown
   */
  async shutdown() {
    try {
      this.logger.info('🔄 Shutting down history manager...');

      // Clear cleanup interval
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }

      // Get final statistics
      const stats = this.getStatistics();
      this.logger.info('📊 Final history statistics', stats);

      // Clear all data
      this.chatHistories.clear();

      this.logger.info('✅ History manager shutdown complete');

    } catch (error) {
      this.logger.error('❌ Error during history manager shutdown:', error.message);
    }
  }
}