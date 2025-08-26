import dotenv from 'dotenv';
dotenv.config();   // Load environment variables first

// Import other modules AFTER loading environment variables
import { Bot } from './src/bot.js';
import { createModuleLogger } from './src/utils/logger.js';

const logger = createModuleLogger('Main');

async function main() {
  try {
    logger.info('🚀 Starting WhatsApp Bot...');
   
    // Validate required environment variables
    const requiredEnvVars = ['GEMINI_API_KEY', 'BOT_OWNER_NUMBER'];
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
   
    if (missingVars.length > 0) {
      logger.error('❌ Missing required environment variables:', missingVars);
      logger.info('Please check your .env file and ensure all required variables are set.');
      process.exit(1);
    }

    // Debug log to verify env vars are loaded
    logger.info(`📋 Loaded config - Owner: ${process.env.BOT_OWNER_NAME} (${process.env.BOT_OWNER_NUMBER})`);
    
    // Create and start the bot
    const bot = new Bot();
    await bot.start();
   
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('📴 Received SIGINT, shutting down gracefully...');
      await bot.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('📴 Received SIGTERM, shutting down gracefully...');
      await bot.stop();
      process.exit(0);
    });

    process.on('uncaughtException', async (error) => {
      logger.error('💥 Uncaught Exception:', error);
      await bot.stop();
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason, promise) => {
      logger.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
      await bot.stop();
      process.exit(1);
    });

  } catch (error) {
    logger.error('❌ Failed to start bot:', error);
    process.exit(1);
  }
}

// Start the application
main().catch((error) => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});