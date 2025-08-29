import dotenv from 'dotenv';
dotenv.config();

import { Bot } from './src/bot.js';
import { createModuleLogger } from './src/utils/logger.js';
import { getConfig } from './config.js';
import http from 'http';

const logger = createModuleLogger('Main');

async function main() {
    try {
        logger.info('🚀 Starting WhatsApp Bot...');

        const requiredEnvVars = ['GEMINI_API_KEY', 'BOT_OWNER_NUMBER'];
        const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
        
        if (missingVars.length > 0) {
            logger.error('❌ Missing required environment variables:', missingVars);
            logger.info('Please check your .env file and ensure all required variables are set.');
            process.exit(1);
        }

        const config = getConfig(); 
        logger.info(`📋 Loaded config - Owner: ${config.bot.owner.name} (${config.bot.owner.number})`);
        
        const bot = new Bot(config);
        await bot.start();
        
        const port = process.env.PORT || 3000;
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('WhatsApp Bot is running and listening for messages!\n');
        });

        server.listen(port, () => {
            logger.info(`🌐 Web server listening on port ${port} (for Render health checks)`);
        });

        process.on('SIGINT', async () => {
            logger.info('📴 Received SIGINT, shutting down gracefully...');
            server.close(() => {
                logger.info('🌐 Web server closed.');
            });
            await bot.stop();
            process.exit(0);
        });

        process.on('SIGTERM', async () => {
            logger.info('📴 Received SIGTERM, shutting down gracefully...');
            server.close(() => {
                logger.info('🌐 Web server closed.');
            });
            await bot.stop();
            process.exit(0);
        });

        process.on('uncaughtException', async (error) => {
            logger.error('💥 Uncaught Exception:', error);
            server.close(() => {
                logger.info('🌐 Web server closed due to uncaught exception.');
            });
            await bot.stop();
            process.exit(1);
        });

        process.on('unhandledRejection', async (reason, promise) => {
            logger.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
            server.close(() => {
                logger.info('🌐 Web server closed due to unhandled rejection.');
            });
            await bot.stop();
            process.exit(1);
        });

    } catch (error) {
        // 🟢 MODIFIED: Log the full error object to get the stack trace
        logger.error('❌ Failed to start bot:', error);
        process.exit(1);
    }
}

main().catch((error) => {
    // 🟢 MODIFIED: Log the full error object here as well
    console.error('💥 Fatal error:', error);
    process.exit(1);
});