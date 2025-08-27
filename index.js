import dotenv from 'dotenv';
dotenv.config(); // Load environment variables first

// Import other modules AFTER loading environment variables
import { Bot } from './src/bot.js';
import { createModuleLogger } from './src/utils/logger.js';
import { getConfig } from './config.js'; // Assuming getConfig is in config.js

// Import http module for the web server
import http from 'http'; // 🟢 NEW: Import http module

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
        // 🟢 Using getConfig() to ensure config is fully loaded
        const config = getConfig(); 
        logger.info(`📋 Loaded config - Owner: ${config.bot.owner.name} (${config.bot.owner.number})`);
        
        // Create and start the bot
        const bot = new Bot();
        await bot.start();
        
        // 🟢 NEW: Start a simple HTTP server to satisfy Render's Web Service requirement
        const port = process.env.PORT || 3000; // Render provides the PORT env var
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('WhatsApp Bot is running and listening for messages!\n');
        });

        server.listen(port, () => {
            logger.info(`🌐 Web server listening on port ${port} (for Render health checks)`);
        });

        // Handle graceful shutdown
        process.on('SIGINT', async () => {
            logger.info('📴 Received SIGINT, shutting down gracefully...');
            server.close(() => { // 🟢 Close the HTTP server gracefully
                logger.info('🌐 Web server closed.');
            });
            await bot.stop();
            process.exit(0);
        });

        process.on('SIGTERM', async () => {
            logger.info('📴 Received SIGTERM, shutting down gracefully...');
            server.close(() => { // 🟢 Close the HTTP server gracefully
                logger.info('🌐 Web server closed.');
            });
            await bot.stop();
            process.exit(0);
        });

        process.on('uncaughtException', async (error) => {
            logger.error('💥 Uncaught Exception:', error);
            server.close(() => { // 🟢 Close the HTTP server gracefully
                logger.info('🌐 Web server closed due to uncaught exception.');
            });
            await bot.stop();
            process.exit(1);
        });

        process.on('unhandledRejection', async (reason, promise) => {
            logger.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
            server.close(() => { // 🟢 Close the HTTP server gracefully
                logger.info('🌐 Web server closed due to unhandled rejection.');
            });
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
