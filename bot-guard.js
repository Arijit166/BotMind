import { createModuleLogger } from '../utils/logger.js';

export class BotGuard {
  // 🟢 CORRECTED: Accept 'config' as a parameter.
  constructor(config) {
    this.config = config;
    this.logger = createModuleLogger('BotGuard');
    
    // Use this.config to access properties
    // 🟢 CORRECTED: Changed 'config.guard' to 'config.state.default.rateLimit'
    this.rateLimitEnabled = this.config.state.default.rateLimit.enabled; 
    this.maxMessagesPerMinute = this.config.state.default.rateLimit.maxMessagesPerMinute;
    this.maxMessagesPerHour = this.config.state.default.rateLimit.maxMessagesPerHour;
    this.cooldownMessages = this.config.state.default.rateLimit.cooldownMessages;

    // Track user activity
    this.userActivity = new Map(); // userId -> { minuteCount, hourCount, lastMessageTime, warningCount }
    this.blockedUsers = new Map(); // userId -> { blockedUntil, reason }
    this.suspiciousPatterns = new Map(); // userId -> { spamCount, repeatCount, lastMessages }
    
    // Cleanup interval
    this.setupCleanupTimer();
  }

  /**
   * Main method to check if message should be processed
   */
  async checkMessage(message, chat, contact) {
    try {
      const userId = contact.id._serialized;
      const messageText = message.body?.trim() || '';
      const isGroup = chat.isGroup;
      const timestamp = Date.now();

      this.logger.debug('Checking message with bot guard', {
        userId,
        isGroup,
        messageLength: messageText.length,
        hasMedia: message.hasMedia
      });

      // Skip all checks for bot owner
      if (this.isOwner(userId)) {
        this.updateUserActivity(userId, messageText, timestamp);
        return {
          allowed: true,
          reason: 'owner_bypass',
          shouldRespond: false,
          response: null
        };
      }

      // Check if user is blocked
      const blockCheck = this.checkBlocked(userId);
      if (!blockCheck.allowed) {
        return blockCheck;
      }

      // Check rate limiting
      if (this.rateLimitEnabled) {
        const rateLimitCheck = this.checkRateLimit(userId, timestamp);
        if (!rateLimitCheck.allowed) {
          return rateLimitCheck;
        }
      }

      // Check for suspicious patterns
      const patternCheck = this.checkSuspiciousPatterns(userId, messageText, timestamp);
      if (!patternCheck.allowed) {
        return patternCheck;
      }

      // Check for spam content
      const spamCheck = this.checkSpamContent(messageText, isGroup);
      if (!spamCheck.allowed) {
        this.trackSuspiciousActivity(userId, 'spam_content');
        return spamCheck;
      }

      // Update user activity
      this.updateUserActivity(userId, messageText, timestamp);

      // Message passed all checks
      return {
        allowed: true,
        reason: null,
        shouldRespond: false,
        response: null
      };

    } catch (error) {
      this.logger.error('Error in bot guard check', {
        error: error.message,
        userId: contact?.id?._serialized
      });

      // On error, allow the message but log it
      return {
        allowed: true,
        reason: 'guard_error',
        shouldRespond: false,
        response: null
      };
    }
  }

  /**
   * Check if user is the bot owner (should bypass most restrictions)
   */
  isOwner(userId) {
    try {
      const phoneNumber = userId.split('@')[0];
      const cleanOwnerNumber = this.config.bot.owner.number?.replace(/\D/g, ''); // Use this.config
      const cleanUserNumber = phoneNumber.replace(/\D/g, '');
      
      return cleanOwnerNumber && cleanOwnerNumber === cleanUserNumber;
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if user is currently blocked
   */
  checkBlocked(userId) {
    const blockInfo = this.blockedUsers.get(userId);
    
    if (!blockInfo) {
      return { allowed: true };
    }

    // Check if block has expired
    if (Date.now() > blockInfo.blockedUntil) {
      this.blockedUsers.delete(userId);
      this.logger.info('User unblocked (expired)', { 
        userId, 
        reason: blockInfo.reason 
      });
      return { allowed: true };
    }

    this.logger.bot.rateLimit(userId, 'blocked_user_attempt');

    return {
      allowed: false,
      reason: 'user_blocked',
      shouldRespond: false,
      response: null
    };
  }

  /**
   * Check rate limiting
   */
  checkRateLimit(userId, timestamp) {
    const activity = this.userActivity.get(userId) || {
      minuteCount: 0,
      hourCount: 0,
      lastMessageTime: 0,
      warningCount: 0,
      minuteReset: timestamp + 60000, // Reset in 1 minute
      hourReset: timestamp + 3600000 // Reset in 1 hour
    };

    // Reset counters if time has passed
    if (timestamp > activity.minuteReset) {
      activity.minuteCount = 0;
      activity.minuteReset = timestamp + 60000;
    }

    if (timestamp > activity.hourReset) {
      activity.hourCount = 0;
      activity.hourReset = timestamp + 3600000;
    }

    // Check minute limit
    if (activity.minuteCount >= this.maxMessagesPerMinute) {
      activity.warningCount++;
      this.userActivity.set(userId, activity);

      this.logger.bot.rateLimit(userId, 'minute_limit_exceeded');

      // Block user if they repeatedly hit rate limits
      if (activity.warningCount >= 3) {
        this.blockUser(userId, 10 * 60 * 1000, 'repeated_rate_limit_violations'); // 10 minutes
      }

      return {
        allowed: false,
        reason: 'rate_limit_minute',
        shouldRespond: true,
        response: this.getRandomCooldownMessage()
      };
    }

    // Check hour limit
    if (activity.hourCount >= this.maxMessagesPerHour) {
      this.logger.bot.rateLimit(userId, 'hour_limit_exceeded');

      this.blockUser(userId, 60 * 60 * 1000, 'hourly_rate_limit_exceeded'); // 1 hour

      return {
        allowed: false,
        reason: 'rate_limit_hour',
        shouldRespond: true,
        response: "You've reached the hourly message limit. Please try again later."
      };
    }

    return { allowed: true };
  }

  /**
   * Check for suspicious messaging patterns
   */
  checkSuspiciousPatterns(userId, messageText, timestamp) {
    const patterns = this.suspiciousPatterns.get(userId) || {
      spamCount: 0,
      repeatCount: 0,
      lastMessages: [],
      lastSpamTime: 0
    };

    // Check for repeated identical messages
    const recentMessages = patterns.lastMessages.filter(msg => 
      timestamp - msg.timestamp < 300000 // Last 5 minutes
    );

    const identicalCount = recentMessages.filter(msg => 
      msg.text === messageText
    ).length;

    if (identicalCount >= 2) { // Third identical message in 5 minutes
      patterns.repeatCount++;
      
      this.logger.warn('User sending repeated messages', {
        userId,
        messageText: messageText.substring(0, 50),
        identicalCount: identicalCount + 1
      });

      if (patterns.repeatCount >= 3) {
        this.blockUser(userId, 30 * 60 * 1000, 'repeated_identical_messages'); // 30 minutes
        
        return {
          allowed: false,
          reason: 'repeated_messages',
          shouldRespond: true,
          response: "Please avoid sending the same message repeatedly. You've been temporarily restricted."
        };
      }

      return {
        allowed: false,
        reason: 'repeated_messages',
        shouldRespond: true,
        response: "I notice you're sending similar messages. Please vary your messages to continue chatting."
      };
    }

    // Check message frequency (rapid fire messages)
    if (patterns.lastMessages.length > 0) {
      const lastMessage = patterns.lastMessages[patterns.lastMessages.length - 1];
      const timeDiff = timestamp - lastMessage.timestamp;
      
      if (timeDiff < 2000) { // Less than 2 seconds between messages
        patterns.spamCount++;
        
        if (patterns.spamCount >= 5) {
          this.logger.warn('User sending messages too rapidly', {
            userId,
            spamCount: patterns.spamCount,
            timeDiff
          });

          this.blockUser(userId, 15 * 60 * 1000, 'rapid_fire_messaging'); // 15 minutes
          
          return {
            allowed: false,
            reason: 'rapid_messaging',
            shouldRespond: true,
            response: "Please slow down! You're sending messages too quickly. Take a moment to breathe."
          };
        }
      } else if (timeDiff > 10000) { // Reset spam count if more than 10 seconds
        patterns.spamCount = Math.max(0, patterns.spamCount - 1);
      }
    }

    // Update patterns
    patterns.lastMessages.push({
      text: messageText,
      timestamp: timestamp
    });

    // Keep only last 10 messages for pattern analysis
    if (patterns.lastMessages.length > 10) {
      patterns.lastMessages = patterns.lastMessages.slice(-10);
    }

    this.suspiciousPatterns.set(userId, patterns);

    return { allowed: true };
  }

  /**
   * Check for spam content
   */
  checkSpamContent(messageText, isGroup) {
    if (!messageText || messageText.length < 10) {
      return { allowed: true };
    }

    const text = messageText.toLowerCase();
    
    // Define spam patterns
    const spamPatterns = [
      /(.)\1{10,}/, // Repeated characters (11+ times)
      /(.{1,3})\1{5,}/, // Repeated short sequences
      /(https?:\/\/[^\s]+){3,}/, // Multiple URLs
      /click here|free money|win now|urgent|limited time/gi, // Common spam phrases
      /[!@#$%^&*]{5,}/, // Excessive special characters
      /\b(buy|sell|cheap|discount|offer).{0,20}(now|today|urgent)\b/gi // Commercial spam
    ];

    for (const pattern of spamPatterns) {
      if (pattern.test(text)) {
        this.logger.warn('Spam content detected', {
          pattern: pattern.toString(),
          messagePreview: messageText.substring(0, 100)
        });

        return {
          allowed: false,
          reason: 'spam_content',
          shouldRespond: !isGroup, // Don't respond to spam in groups to avoid clutter
          response: "Your message appears to be spam. Please send meaningful messages."
        };
      }
    }

    // Check message length (extremely long messages might be spam)
    if (messageText.length > 2000) {
      this.logger.warn('Extremely long message detected', {
        length: messageText.length,
        messagePreview: messageText.substring(0, 100)
      });

      return {
        allowed: false,
        reason: 'message_too_long',
        shouldRespond: true,
        response: "Your message is quite long. Please break it into smaller parts for better conversation."
      };
    }

    return { allowed: true };
  }

  /**
   * Update user activity tracking
   */
  updateUserActivity(userId, messageText, timestamp) {
    const activity = this.userActivity.get(userId) || {
      minuteCount: 0,
      hourCount: 0,
      lastMessageTime: 0,
      warningCount: 0,
      minuteReset: timestamp + 60000,
      hourReset: timestamp + 3600000
    };

    activity.minuteCount++;
    activity.hourCount++;
    activity.lastMessageTime = timestamp;

    this.userActivity.set(userId, activity);
  }

  /**
   * Track suspicious activity for repeat offenders
   */
  trackSuspiciousActivity(userId, reason) {
    const patterns = this.suspiciousPatterns.get(userId) || {
      spamCount: 0,
      repeatCount: 0,
      lastMessages: [],
      lastSpamTime: 0,
      violations: []
    };

    patterns.violations = patterns.violations || [];
    patterns.violations.push({
      reason,
      timestamp: Date.now()
    });

    // Remove old violations (older than 24 hours)
    patterns.violations = patterns.violations.filter(v => 
      Date.now() - v.timestamp < 24 * 60 * 60 * 1000
    );

    // Block user if too many violations
    if (patterns.violations.length >= 5) {
      this.blockUser(userId, 24 * 60 * 60 * 1000, 'repeated_violations'); // 24 hours
    }

    this.suspiciousPatterns.set(userId, patterns);
  }

  /**
   * Block a user temporarily
   */
  blockUser(userId, durationMs, reason) {
    const blockedUntil = Date.now() + durationMs;
    
    this.blockedUsers.set(userId, {
      blockedUntil,
      reason,
      blockedAt: Date.now()
    });

    this.logger.info('User blocked temporarily', {
      userId,
      reason,
      durationMs,
      blockedUntil: new Date(blockedUntil).toISOString()
    });
  }

  /**
   * Manually unblock a user (for owner use)
   */
  unblockUser(userId) {
    const wasBlocked = this.blockedUsers.has(userId);
    this.blockedUsers.delete(userId);
    
    if (wasBlocked) {
      this.logger.info('User manually unblocked', { userId });
      return true;
    }
    
    return false;
  }

  /**
   * Get random cooldown message
   */
  getRandomCooldownMessage() {
    // 🟢 CORRECTED: Use this.config to get the messages.
    const messages = this.config.state.default.rateLimit.cooldownMessages;
    return messages[Math.floor(Math.random() * messages.length)];
  }

  /**
   * Setup cleanup timer to remove old data
   */
  setupCleanupTimer() {
    // Clean up old data every hour
    // 🟢 CORRECTED: Changed 'config.guard' to 'config.history'
    setInterval(() => {
      this.cleanupOldData();
    }, this.config.history.cleanupIntervalMs); 
  }

  /**
   * Clean up old tracking data
   */
  cleanupOldData() {
    const now = Date.now();
    const oneDayAgo = now - (24 * 60 * 60 * 1000);
    
    // Clean up old user activity
    for (const [userId, activity] of this.userActivity.entries()) {
      if (activity.lastMessageTime < oneDayAgo) {
        this.userActivity.delete(userId);
      }
    }
    
    // Clean up old suspicious patterns
    for (const [userId, patterns] of this.suspiciousPatterns.entries()) {
      if (patterns.lastMessages.length === 0 || 
          patterns.lastMessages[patterns.lastMessages.length - 1].timestamp < oneDayAgo) {
        this.suspiciousPatterns.delete(userId);
      }
    }
    
    // Remove expired blocks
    for (const [userId, blockInfo] of this.blockedUsers.entries()) {
      if (now > blockInfo.blockedUntil) {
        this.blockedUsers.delete(userId);
      }
    }
    
    this.logger.debug('Cleanup completed', {
      activeUsers: this.userActivity.size,
      suspiciousPatterns: this.suspiciousPatterns.size,
      blockedUsers: this.blockedUsers.size
    });
  }

  /**
   * Get statistics
   */
  getStatistics() {
    return {
      activeUsers: this.userActivity.size,
      blockedUsers: this.blockedUsers.size,
      suspiciousPatterns: this.suspiciousPatterns.size,
      rateLimitEnabled: this.rateLimitEnabled,
      limits: {
        messagesPerMinute: this.maxMessagesPerMinute,
        messagesPerHour: this.maxMessagesPerHour
      }
    };
  }

  /**
   * Clean shutdown
   */
  async shutdown() {
    this.logger.info('🔄 Shutting down bot guard...');
    
    // Clear all timers and data
    this.userActivity.clear();
    this.blockedUsers.clear();
    this.suspiciousPatterns.clear();
    
    this.logger.info('✅ Bot guard shutdown complete');
  }
}