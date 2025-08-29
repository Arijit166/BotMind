import dotenv from 'dotenv';
import pg from 'pg';

// Ensure environment variables are loaded
dotenv.config();

const { Pool } = pg;

// Debug function to check environment variables
function debugEnvironment() {
    console.log('🔍 Environment Debug:');
    console.log('NODE_ENV:', process.env.NODE_ENV);
    console.log('DATABASE_URL exists:', !!process.env.DATABASE_URL);
    console.log('DATABASE_URL length:', process.env.DATABASE_URL?.length || 0);
    
    // Log first and last 10 characters for debugging (safe)
    if (process.env.DATABASE_URL) {
        const dbUrl = process.env.DATABASE_URL;
        console.log('DATABASE_URL preview:', 
            dbUrl.substring(0, 10) + '...' + dbUrl.substring(dbUrl.length - 10)
        );
    }
}

// Call debug function in development
if (process.env.NODE_ENV !== 'production') {
    debugEnvironment();
}

let pool = null;

if (process.env.DATABASE_URL) {
    try {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? {
                rejectUnauthorized: false
            } : false, // No SSL for local development
            // Additional connection options for better reliability
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000,
        });

        // Test the connection
        pool.connect((err, client, release) => {
            if (err) {
                console.error('❌ Database connection test failed:', err.message);
                pool = null;
            } else {
                console.log('✅ Database connection test successful');
                release();
            }
        });

    } catch (error) {
        console.error('❌ Failed to create database pool:', error.message);
        pool = null;
    }
} else {
    console.warn('⚠️ DATABASE_URL not found. Database features will be disabled.');
}

export { pool };