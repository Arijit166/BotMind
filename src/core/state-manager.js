import fs from 'fs/promises';
import path from 'path';
import { createModuleLogger } from '../utils/logger.js';
import pg from 'pg'; // 🟢 ADDED: Import the pg library

// 🟢 ADDED: Set up the database connection pool if DATABASE_URL is available
const { Pool } = pg;
const pool = process.env.DATABASE_URL ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Required for Render
    }
}) : null;


export class BotStateManager {
    constructor(config) {
        this.logger = createModuleLogger('BotStateManager');
        this.config = config;
        this.statePath = this.config.state.filePath;
        this.state = { ...this.config.state.default };
        this.isInitialized = false;
        this.saveTimeout = null;
        this.autoSaveInterval = null;
    }

    /**
     * 🟡 MODIFIED: Initialize state from DB first, then fall back to file.
     */
    async initialize() {
        try {
            this.logger.info('🔧 Initializing bot state manager...');

            if (pool) {
                // Try to initialize from database first
                try {
                    await this._ensureTableExists();
                    await this._loadStateFromDB();
                    this.logger.info('✅ State loaded successfully from primary source (Database).');
                } catch (dbError) {
                    this.logger.error('❌ DB state initialization failed, falling back to file system.', dbError);
                    await this.loadState(); // Fallback to file
                }
            } else {
                // If no DATABASE_URL, use file system only
                this.logger.info('No DATABASE_URL found. Using file system for state management.');
                await this.loadState();
            }

            // Setup file-based auto-save (acts as a backup/cache)
            this.setupAutoSave();

            this.isInitialized = true;
            this.logger.info('✅ Bot state manager initialized successfully', {
                storageMode: pool ? 'Database with File Fallback' : 'File System Only',
                currentState: this.getSafeStateForLogging()
            });

        } catch (error) {
            this.logger.error('Failed to initialize state manager', { error: error.message });
            throw new Error(`State manager initialization failed: ${error.message}`);
        }
    }

    // 🟢 ADDED: New method to ensure the database table exists.
    async _ensureTableExists() {
        if (!pool) return;
        const client = await pool.connect();
        try {
            await client.query(`
                CREATE TABLE IF NOT EXISTS bot_state (
                    id INT PRIMARY KEY,
                    state JSONB
                );
            `);
            this.logger.debug('Database table "bot_state" is ready.');
        } finally {
            client.release();
        }
    }

    // 🟢 ADDED: New method to load state specifically from the database.
    async _loadStateFromDB() {
        if (!pool) return;
        const client = await pool.connect();
        try {
            const res = await client.query('SELECT state FROM bot_state WHERE id = 1');
            if (res.rows.length > 0) {
                this.state = this.validateAndMergeState(res.rows[0].state);
            } else {
                this.logger.info('No state found in DB. Using defaults and saving.');
                this.state = { ...this.config.state.default };
                await this._saveStateToDB();
            }
        } finally {
            client.release();
        }
    }

    // 🟢 ADDED: New method to save the current state to the database.
    async _saveStateToDB() {
        if (!pool) return;
        const client = await pool.connect();
        try {
            const stateWithMetadata = { ...this.state, lastSaved: new Date().toISOString() };
            const query = `
                INSERT INTO bot_state (id, state) VALUES (1, $1)
                ON CONFLICT (id) DO UPDATE SET state = $1;
            `;
            await client.query(query, [stateWithMetadata]);
            this.logger.debug('💾 State saved successfully to database.');
        } catch (error) {
            this.logger.error('Failed to save state to database', { error: error.message });
        } finally {
            client.release();
        }
    }


    /**
     * Load state from file (this is now a fallback method)
     */
    async loadState() {
        try {
            const stateDir = path.dirname(this.statePath);
            await fs.mkdir(stateDir, { recursive: true });
            const fileExists = await this.fileExists(this.statePath);

            if (fileExists) {
                const data = await fs.readFile(this.statePath, 'utf8');
                const loadedState = JSON.parse(data);
                this.state = this.validateAndMergeState(loadedState);
                this.logger.info('📂 State loaded from file (fallback).');
            } else {
                this.state = { ...this.config.state.default };
                await this.saveState(); // Save the new default state to file
                this.logger.info('📝 Created new state file with defaults (fallback).');
            }
        } catch (error) {
            this.logger.error('Error loading state from file, using defaults.', { error: error.message });
            this.state = { ...this.config.state.default };
        }
    }

    /**
     * Save state to file (now a secondary/cache save)
     */
    async saveState() {
        try {
            if (this.saveTimeout) clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
            
            const stateDir = path.dirname(this.statePath);
            await fs.mkdir(stateDir, { recursive: true });
            
            const stateWithMetadata = {
                ...this.state,
                lastSaved: new Date().toISOString(),
                version: this.config.bot.version
            };
            
            const tempPath = `${this.statePath}.tmp`;
            await fs.writeFile(tempPath, JSON.stringify(stateWithMetadata, null, 2), 'utf8');
            await fs.rename(tempPath, this.statePath);
            
            this.logger.debug('💾 State saved successfully to file (cache/backup).');
        } catch (error) {
            this.logger.error('Failed to save state to file', { error: error.message });
            throw error;
        }
    }

    /**
     * Save state to file with debouncing
     */
    async saveStateDebounced(delayMs = 2000) {
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(async () => {
            try {
                await this.saveState();
            } catch (error) {
                this.logger.error('Debounced file save failed', { error: error.message });
            }
        }, delayMs);
    }

    /**
     * Get current state
     */
    getState() {
        return { ...this.state };
    }

    /**
     * 🟡 MODIFIED: Set state and save to both DB and file.
     */
    async setState(newState) {
        try {
            if (!newState || typeof newState !== 'object') {
                throw new Error('Invalid state object provided');
            }
            const oldState = { ...this.state };
            this.state = { ...this.state, ...newState };

            this.logger.info('🔄 State updated in memory', {
                changes: this.getStateChanges(oldState, this.state)
            });

            // Save to primary storage (DB) immediately
            if (pool) {
                await this._saveStateToDB();
            }

            // Also save to secondary storage (file) with debouncing
            await this.saveStateDebounced();

            return this.state;
        } catch (error) {
            this.logger.error('Failed to set state', { error: error.message, newState });
            throw error;
        }
    }


    /**
     * 🟡 MODIFIED: Clean shutdown for both DB and file logic.
     */
    async shutdown() {
        try {
            this.logger.info('🔄 Shutting down state manager...');
            if (this.autoSaveInterval) clearInterval(this.autoSaveInterval);
            if (this.saveTimeout) clearTimeout(this.saveTimeout);
            this.autoSaveInterval = null;
            this.saveTimeout = null;

            // Final save to both targets
            if (pool) {
                await this._saveStateToDB();
                await pool.end(); // Close DB connection pool
                this.logger.info('Database pool closed.');
            }
            await this.saveState(); // Final file save

            this.isInitialized = false;
            this.logger.info('✅ State manager shutdown complete');
        } catch (error) {
            this.logger.error('❌ Error during state manager shutdown:', error.message);
        }
    }

    // --- NO CHANGES NEEDED FOR THE METHODS BELOW ---
    // (resetState, toggleBot, incrementMessageCount, getUptime, getFormattedUptime, getStatistics,
    // backupState, restoreStateFromBackup, setupAutoSave, validateAndMergeState, fileExists,
    // getStateChanges, getSafeStateForLogging)

    async resetState() {
     try {
       const oldState = { ...this.state };
       this.state = {
         ...this.config.state.default,
         activeSince: new Date().toISOString()
       };
       await this.setState(this.state); // Use setState to save to both DB and file
       this.logger.info('🔄 State reset to defaults');
       return this.state;
     } catch (error) {
       this.logger.error('Failed to reset state', { error: error.message });
       throw error;
     }
    }

    async toggleBot(activate, toggledBy = null) {
     try {
       const wasActive = this.state.isActive;
       if (activate === wasActive) {
         return this.state;
       }
       await this.setState({
         isActive: activate,
         lastToggled: new Date().toISOString(),
         toggledBy: toggledBy,
         ...(activate && { activeSince: new Date().toISOString() })
       });
       this.logger.info(`🤖 Bot ${activate ? 'activated' : 'deactivated'}`);
       return this.state;
     } catch (error) {
       this.logger.error('Failed to toggle bot', { error: error.message });
       throw error;
     }
    }

    async incrementMessageCount() {
     try {
       const newCount = (this.state.totalMessages || 0) + 1;
       this.state.totalMessages = newCount; // Update in memory first
       if (newCount % 10 === 0) { // Only save every 10 messages
         await this.setState({ totalMessages: newCount });
       }
       return newCount;
     } catch (error) {
       this.logger.error('Failed to increment message count', { error: error.message });
       return this.state.totalMessages || 0;
     }
    }

    getUptime() {
     try {
       const activeSince = new Date(this.state.activeSince);
       return Date.now() - activeSince.getTime();
     } catch (error) {
       return 0;
     }
    }

    getFormattedUptime() {
     const uptimeMs = this.getUptime();
     const seconds = Math.floor(uptimeMs / 1000);
     const days = Math.floor(seconds / 86400);
     const hours = Math.floor((seconds % 86400) / 3600);
     const minutes = Math.floor((seconds % 3600) / 60);
     const remainingSeconds = seconds % 60;
     if (days > 0) return `${days}d ${hours}h ${minutes}m`;
     if (hours > 0) return `${hours}h ${minutes}m`;
     if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
     return `${remainingSeconds}s`;
    }

    getStatistics() {
     try {
       const uptime = this.getUptime();
       const messagesPerHour = uptime > 0 ? Math.round((this.state.totalMessages * 3600000) / uptime) : 0;
       return {
         isActive: this.state.isActive,
         totalMessages: this.state.totalMessages || 0,
         messagesPerHour,
         uptime: { milliseconds: uptime, formatted: this.getFormattedUptime() },
         activeSince: this.state.activeSince,
         lastToggled: this.state.lastToggled,
         toggledBy: this.state.toggledBy,
         lastSaved: this.state.lastSaved || 'never',
         version: this.state.version || this.config.bot.version
       };
     } catch (error) {
       this.logger.error('Failed to generate statistics', { error: error.message });
       return { error: error.message };
     }
    }

    async backupState() {
     try {
       const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
       const backupPath = `${this.statePath}.backup.${timestamp}`;
       await fs.copyFile(this.statePath, backupPath);
       this.logger.info('📋 State backed up successfully', { backupPath });
       return backupPath;
     } catch (error) {
       this.logger.error('Failed to backup state', { error: error.message });
       throw error;
     }
    }

    async restoreStateFromBackup(backupPath) {
     try {
       const backupExists = await this.fileExists(backupPath);
       if (!backupExists) throw new Error('Backup file does not exist');
       await this.backupState();
       const backupData = await fs.readFile(backupPath, 'utf8');
       const backupState = JSON.parse(backupData);
       this.state = this.validateAndMergeState(backupState);
       await this.setState(this.state); // Save to both DB and file
       this.logger.info('🔄 State restored from backup');
       return this.state;
     } catch (error) {
       this.logger.error('Failed to restore state from backup', { error: error.message });
       throw error;
     }
    }

    setupAutoSave() {
     this.autoSaveInterval = setInterval(async () => {
       try {
         await this.saveState(); // This saves to the file only
         this.logger.debug('🔄 Auto-save (file) completed');
       } catch (error) {
         this.logger.warn('Auto-save (file) failed', { error: error.message });
       }
     }, 5 * 60 * 1000);
     this.logger.debug('⏰ Auto-save timer setup (5 minute interval)');
    }

    validateAndMergeState(loadedState) {
     const defaultState = this.config.state.default;
     const mergedState = { ...defaultState };
     Object.keys(defaultState).forEach(key => {
       if (loadedState.hasOwnProperty(key) && typeof loadedState[key] === typeof defaultState[key]) {
         mergedState[key] = loadedState[key];
       }
     });
     ['lastToggled', 'activeSince'].forEach(dateField => {
       if (mergedState[dateField] && isNaN(new Date(mergedState[dateField]))) {
         mergedState[dateField] = new Date().toISOString();
       }
     });
     return mergedState;
    }

    async fileExists(filePath) {
     try {
       await fs.access(filePath);
       return true;
     } catch {
       return false;
     }
    }

    getStateChanges(oldState, newState) {
     const changes = {};
     Object.keys(newState).forEach(key => {
       if (oldState[key] !== newState[key]) {
         changes[key] = { from: oldState[key], to: newState[key] };
       }
     });
     return changes;
    }

    getSafeStateForLogging(state = this.state) {
     const { ...safeState } = state;
     return safeState;
    }
}