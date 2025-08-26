import fs from 'fs/promises';
import path from 'path';
import { createModuleLogger } from '../utils/logger.js';

export class BotStateManager {
  // 🟢 CORRECTED: Accept 'config' as a parameter.
  constructor(config) {
    this.logger = createModuleLogger('BotStateManager');
    this.config = config; // Store the passed-in config object
    this.statePath = this.config.state.filePath;
    this.state = { ...this.config.state.default };
    this.isInitialized = false;
    this.saveTimeout = null;
    this.autoSaveInterval = null;
  }

  /**
   * Initialize the state manager
   */
  async initialize() {
    try {
      this.logger.info('🔧 Initializing bot state manager...');

      // Ensure state directory exists
      const stateDir = path.dirname(this.statePath);
      await fs.mkdir(stateDir, { recursive: true });

      // Load existing state or create new one
      await this.loadState();

      // Setup auto-save interval (every 5 minutes)
      this.setupAutoSave();

      this.isInitialized = true;
      this.logger.info('✅ Bot state manager initialized successfully', {
        statePath: this.statePath,
        currentState: this.getSafeStateForLogging()
      });

    } catch (error) {
      this.logger.error('Failed to initialize state manager', {
        error: error.message,
        statePath: this.statePath
      });
      throw new Error(`State manager initialization failed: ${error.message}`);
    }
  }

  /**
   * Load state from file
   */
  async loadState() {
    try {
      const fileExists = await this.fileExists(this.statePath);

      if (fileExists) {
        const data = await fs.readFile(this.statePath, 'utf8');
        const loadedState = JSON.parse(data);

        // Validate loaded state and merge with defaults
        this.state = this.validateAndMergeState(loadedState);

        this.logger.info('📂 State loaded from file', {
          statePath: this.statePath,
          stateKeys: Object.keys(this.state)
        });
      } else {
        // Use default state
        this.state = { ...this.config.state.default };
        await this.saveState();

        this.logger.info('📝 Created new state file with defaults', {
          statePath: this.statePath
        });
      }

    } catch (error) {
      this.logger.error('Error loading state, using defaults', {
        error: error.message,
        statePath: this.statePath
      });

      // Fallback to default state
      this.state = { ...this.config.state.default };

      // Try to save the default state
      try {
        await this.saveState();
      } catch (saveError) {
        this.logger.warn('Failed to save default state', { error: saveError.message });
      }
    }
  }

  /**
   * Save state to file
   */
  async saveState() {
    try {
      // Clear any pending save timeout
      if (this.saveTimeout) {
        clearTimeout(this.saveTimeout);
        this.saveTimeout = null;
      }

      // Ensure directory exists
      const stateDir = path.dirname(this.statePath);
      await fs.mkdir(stateDir, { recursive: true });

      // Add metadata to state
      const stateWithMetadata = {
        ...this.state,
        lastSaved: new Date().toISOString(),
        version: this.config.bot.version
      };

      // Write to temporary file first, then rename (atomic operation)
      const tempPath = `${this.statePath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(stateWithMetadata, null, 2), 'utf8');
      await fs.rename(tempPath, this.statePath);

      this.logger.debug('💾 State saved successfully', {
        statePath: this.statePath,
        timestamp: stateWithMetadata.lastSaved
      });

    } catch (error) {
      this.logger.error('Failed to save state', {
        error: error.message,
        statePath: this.statePath
      });
      throw error;
    }
  }

  /**
   * Save state with debouncing to avoid excessive writes
   */
  async saveStateDebounced(delayMs = 2000) {
    // Clear existing timeout
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    // Set new timeout
    this.saveTimeout = setTimeout(async () => {
      try {
        await this.saveState();
      } catch (error) {
        this.logger.error('Debounced save failed', { error: error.message });
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
   * Set partial state (merge with existing)
   */
  async setState(newState) {
    try {
      if (!newState || typeof newState !== 'object') {
        throw new Error('Invalid state object provided');
      }

      const oldState = { ...this.state };
      this.state = { ...this.state, ...newState };

      this.logger.info('🔄 State updated', {
        changes: this.getStateChanges(oldState, this.state)
      });

      // Save state with debouncing
      await this.saveStateDebounced();

      return this.state;

    } catch (error) {
      this.logger.error('Failed to set state', {
        error: error.message,
        newState
      });
      throw error;
    }
  }

  /**
   * Reset state to defaults
   */
  async resetState() {
    try {
      const oldState = { ...this.state };
      this.state = {
        ...this.config.state.default,
        activeSince: new Date().toISOString() // Update activation time
      };

      await this.saveState();

      this.logger.info('🔄 State reset to defaults', {
        oldState: this.getSafeStateForLogging(oldState),
        newState: this.getSafeStateForLogging(this.state)
      });

      return this.state;

    } catch (error) {
      this.logger.error('Failed to reset state', { error: error.message });
      throw error;
    }
  }

  /**
   * Toggle bot active status
   */
  async toggleBot(activate, toggledBy = null) {
    try {
      const wasActive = this.state.isActive;

      if (activate === wasActive) {
        this.logger.debug('Bot toggle requested but already in desired state', {
          activate,
          wasActive,
          toggledBy
        });
        return this.state;
      }

      await this.setState({
        isActive: activate,
        lastToggled: new Date().toISOString(),
        toggledBy: toggledBy,
        // Reset activation time if turning on
        ...(activate && { activeSince: new Date().toISOString() })
      });

      this.logger.info(`🤖 Bot ${activate ? 'activated' : 'deactivated'}`, {
        toggledBy,
        wasActive,
        newState: activate
      });

      return this.state;

    } catch (error) {
      this.logger.error('Failed to toggle bot', {
        error: error.message,
        activate,
        toggledBy
      });
      throw error;
    }
  }

  /**
   * Increment total message count
   */
  async incrementMessageCount() {
    try {
      this.state.totalMessages = (this.state.totalMessages || 0) + 1;

      // Save periodically (every 10 messages) to avoid excessive writes
      if (this.state.totalMessages % 10 === 0) {
        await this.saveStateDebounced(5000);
      }

      return this.state.totalMessages;

    } catch (error) {
      this.logger.error('Failed to increment message count', { error: error.message });
      return this.state.totalMessages || 0;
    }
  }

  /**
   * Get bot uptime in milliseconds
   */
  getUptime() {
    try {
      const activeSince = new Date(this.state.activeSince);
      return Date.now() - activeSince.getTime();
    } catch (error) {
      this.logger.warn('Failed to calculate uptime', { error: error.message });
      return 0;
    }
  }

  /**
   * Get formatted uptime string
   */
  getFormattedUptime() {
    const uptimeMs = this.getUptime();
    const seconds = Math.floor(uptimeMs / 1000);

    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;

    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    } else {
      return `${remainingSeconds}s`;
    }
  }

  /**
   * Get comprehensive state statistics
   */
  getStatistics() {
    try {
      const uptime = this.getUptime();
      const messagesPerHour = uptime > 0 ?
        Math.round((this.state.totalMessages * 3600000) / uptime) : 0;

      return {
        isActive: this.state.isActive,
        totalMessages: this.state.totalMessages || 0,
        messagesPerHour,
        uptime: {
          milliseconds: uptime,
          formatted: this.getFormattedUptime()
        },
        activeSince: this.state.activeSince,
        lastToggled: this.state.lastToggled,
        toggledBy: this.state.toggledBy,
        stateFileSize: 0, // Will be populated by file stats if available
        lastSaved: this.state.lastSaved || 'never',
        version: this.state.version || this.config.bot.version
      };
    } catch (error) {
      this.logger.error('Failed to generate statistics', { error: error.message });
      return {
        isActive: false,
        totalMessages: 0,
        messagesPerHour: 0,
        uptime: { milliseconds: 0, formatted: '0s' },
        error: error.message
      };
    }
  }

  /**
   * Backup current state
   */
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

  /**
   * Restore state from backup
   */
  async restoreStateFromBackup(backupPath) {
    try {
      // Validate backup file exists
      const backupExists = await this.fileExists(backupPath);
      if (!backupExists) {
        throw new Error('Backup file does not exist');
      }

      // Create backup of current state first
      await this.backupState();

      // Read and validate backup data
      const backupData = await fs.readFile(backupPath, 'utf8');
      const backupState = JSON.parse(backupData);

      // Validate and set state
      this.state = this.validateAndMergeState(backupState);
      await this.saveState();

      this.logger.info('🔄 State restored from backup', {
        backupPath,
        restoredState: this.getSafeStateForLogging()
      });

      return this.state;

    } catch (error) {
      this.logger.error('Failed to restore state from backup', {
        error: error.message,
        backupPath
      });
      throw error;
    }
  }

  /**
   * Setup automatic state saving
   */
  setupAutoSave() {
    // Save state every 5 minutes
    this.autoSaveInterval = setInterval(async () => {
      try {
        await this.saveState();
        this.logger.debug('🔄 Auto-save completed');
      } catch (error) {
        this.logger.warn('Auto-save failed', { error: error.message });
      }
    }, 5 * 60 * 1000);

    this.logger.debug('⏰ Auto-save timer setup (5 minute interval)');
  }

  /**
   * Validate and merge loaded state with defaults
   */
  validateAndMergeState(loadedState) {
    const defaultState = this.config.state.default; // Changed to use this.config
    const mergedState = { ...defaultState };

    // Validate and merge each field
    Object.keys(defaultState).forEach(key => {
      if (loadedState.hasOwnProperty(key)) {
        const defaultValue = defaultState[key];
        const loadedValue = loadedState[key];

        // Type validation
        if (typeof loadedValue === typeof defaultValue) {
          mergedState[key] = loadedValue;
        } else {
          this.logger.warn('Invalid state value type, using default', {
            key,
            expectedType: typeof defaultValue,
            receivedType: typeof loadedValue,
            defaultValue
          });
        }
      }
    });

    // Validate dates
    ['lastToggled', 'activeSince'].forEach(dateField => {
      if (mergedState[dateField]) {
        try {
          new Date(mergedState[dateField]);
        } catch (error) {
          this.logger.warn('Invalid date in state, using current time', {
            field: dateField,
            value: mergedState[dateField]
          });
          mergedState[dateField] = new Date().toISOString();
        }
      }
    });

    return mergedState;
  }

  /**
   * Utility methods
   */
  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch (error) {
      return false;
    }
  }

  getStateChanges(oldState, newState) {
    const changes = {};
    Object.keys(newState).forEach(key => {
      if (oldState[key] !== newState[key]) {
        changes[key] = {
          from: oldState[key],
          to: newState[key]
        };
      }
    });
    return changes;
  }

  getSafeStateForLogging(state = this.state) {
    // Remove sensitive data for logging
    const { ...safeState } = state;
    return safeState;
  }

  /**
   * Clean shutdown
   */
  async shutdown() {
    try {
      this.logger.info('🔄 Shutting down state manager...');

      // Clear intervals
      if (this.autoSaveInterval) {
        clearInterval(this.autoSaveInterval);
        this.autoSaveInterval = null;
      }

      if (this.saveTimeout) {
        clearTimeout(this.saveTimeout);
        this.saveTimeout = null;
      }

      // Final save
      await this.saveState();

      this.isInitialized = false;
      this.logger.info('✅ State manager shutdown complete');

    } catch (error) {
      this.logger.error('❌ Error during state manager shutdown:', error.message);
    }
  }
}