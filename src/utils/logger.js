import winston from 'winston';
import chalk from 'chalk';

// Default logging configuration (fallback)
const DEFAULT_CONFIG = {
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: {
      filename: './logs/bot.log',
      maxSize: '10m',
      maxFiles: 5
    },
    console: {
      enabled: true,
      colorize: true
    }
  }
};

// Get logging config dynamically
const getLoggingConfig = () => {
  try {
    // Try to get config from environment or use defaults
    return {
      level: process.env.LOG_LEVEL || DEFAULT_CONFIG.logging.level,
      file: {
        filename: DEFAULT_CONFIG.logging.file.filename,
        maxSize: DEFAULT_CONFIG.logging.file.maxSize,
        maxFiles: DEFAULT_CONFIG.logging.file.maxFiles
      }
    };
  } catch (error) {
    return DEFAULT_CONFIG.logging;
  }
};

// Custom format for console logging with colors and emojis
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, module, ...meta }) => {
    const colors = {
      error: chalk.red,
      warn: chalk.yellow,
      info: chalk.blue,
      debug: chalk.gray
    };

    const emojis = {
      error: '❌',
      warn: '⚠️',
      info: 'ℹ️',
      debug: '🔍'
    };

    const colorFn = colors[level] || chalk.white;
    const emoji = emojis[level] || '';
    const moduleStr = module ? chalk.cyan(`[${module}]`) : '';
    
    let logMessage = `${chalk.gray(timestamp)} ${emoji} ${colorFn(level.toUpperCase())} ${moduleStr} ${message}`;
    
    // Add metadata if present
    if (Object.keys(meta).length > 0) {
      logMessage += `\n${chalk.gray(JSON.stringify(meta, null, 2))}`;
    }
    
    return logMessage;
  })
);

// File format for structured logging
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Get dynamic config
const loggingConfig = getLoggingConfig();

// Create main logger
const logger = winston.createLogger({
  level: loggingConfig.level,
  format: fileFormat,
  transports: [
    // File transport
    new winston.transports.File({
      filename: loggingConfig.file.filename,
      maxsize: loggingConfig.file.maxSize,
      maxFiles: loggingConfig.file.maxFiles,
      format: fileFormat
    }),
    
    // Console transport
    new winston.transports.Console({
      format: consoleFormat
    })
  ],
  
  // Handle uncaught exceptions
  exceptionHandlers: [
    new winston.transports.File({ filename: './logs/exceptions.log' })
  ],
  
  // Handle unhandled rejections
  rejectionHandlers: [
    new winston.transports.File({ filename: './logs/rejections.log' })
  ]
});

// Specialized loggers for different components
export const createModuleLogger = (moduleName) => {
  return {
    error: (message, meta = {}) => logger.error(message, { module: moduleName, ...meta }),
    warn: (message, meta = {}) => logger.warn(message, { module: moduleName, ...meta }),
    info: (message, meta = {}) => logger.info(message, { module: moduleName, ...meta }),
    debug: (message, meta = {}) => logger.debug(message, { module: moduleName, ...meta }),
    
    // Specialized logging methods
    logWithContext: (level, message, context = {}) => {
      logger.log(level, message, { module: moduleName, ...context });
    },
    
    errorWithContext: (message, error, context = {}) => {
      logger.error(message, { 
        module: moduleName, 
        error: error.message,
        stack: error.stack,
        ...context 
      });
    },

    // Bot-specific logging helpers
    bot: {
      connection: (status, details = {}) => {
        logger.info(`🔗 Connection ${status}`, { module: moduleName, ...details });
      },
      
      qrCode: (attempt, maxAttempts) => {
        logger.info(`📱 QR Code generated (attempt ${attempt}/${maxAttempts})`, { module: moduleName });
      },
      
      messageReceived: (from, type, details = {}) => {
        logger.info(`📨 Message received`, { 
          module: moduleName, 
          from, 
          type, 
          ...details 
        });
      },
      
      messageSent: (to, length, details = {}) => {
        logger.info(`📤 Message sent`, { 
          module: moduleName, 
          to, 
          length, 
          ...details 
        });
      },
      
      rateLimit: (userId, reason) => {
        logger.warn(`🚦 Rate limit applied`, { 
          module: moduleName, 
          userId, 
          reason 
        });
      },
      
      error: (operation, error, context = {}) => {
        logger.error(`❌ Bot error in ${operation}`, { 
          module: moduleName, 
          error: error.message,
          stack: error.stack,
          ...context 
        });
      }
    }
  };
};

// Ensure log directory exists
import fs from 'fs/promises';
import path from 'path';

const ensureLogDirectory = async () => {
  try {
    const logDir = path.dirname(loggingConfig.file.filename);
    await fs.mkdir(logDir, { recursive: true });
  } catch (error) {
    console.error('Failed to create log directory:', error);
  }
};

// Initialize logging
ensureLogDirectory();

export default logger;