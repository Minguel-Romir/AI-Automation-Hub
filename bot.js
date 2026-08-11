const { Telegraf } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// --- CONFIGURATION (READ FROM ENVIRONMENT) ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const MY_USER_ID = parseInt(process.env.MY_USER_ID, 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'conversations.db');

// --- VALIDATE SECRETS ---
if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN is not set in environment variables.');
    process.exit(1);
}
if (!MY_USER_ID) {
    console.error('❌ MY_USER_ID is not set in environment variables.');
    process.exit(1);
}

// --- LOGGING ---
const LOG_FILE = path.join(__dirname, 'bot.log');
function logMessage(level, message, data = null) {
    const timestamp = new Date().toISOString();
    let logEntry = `[${timestamp}] [${level}] ${message}`;
    if (data) logEntry += ` | Data: ${JSON.stringify(data)}`;
    console.log(logEntry);
    fs.appendFileSync(LOG_FILE, logEntry + '\n');
}

// --- DATABASE SETUP ---
const db = new sqlite3.Database(DB_PATH);
db.run(`CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
db.run(`CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, description TEXT NOT NULL, due_time INTEGER NOT NULL, status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
db.run(`CREATE TABLE IF NOT EXISTS appointments (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, description TEXT NOT NULL, recurrence_type TEXT NOT NULL, recurrence_value TEXT NOT NULL, time TEXT NOT NULL, last_triggered_date TEXT, status TEXT DEFAULT 'active', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
db.run(`CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT PRIMARY KEY, reply_length INTEGER DEFAULT 10, ai_model TEXT DEFAULT 'llama3.2', updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

// --- BOT INIT ---
const bot = new Telegraf(BOT_TOKEN);

// --- SECURITY ---
bot.use((ctx, next) => {
    if (ctx.from.id !== MY_USER_ID) {
        logMessage('WARN', 'Unauthorized access attempt', { userId: ctx.from.id });
        return ctx.reply('⛔ Unauthorized.');
    }
    return next();
});

// --- (The rest of your bot logic remains exactly the same) ---
// ... [all the command handlers, helpers, and background services stay unchanged] ...

// --- LAUNCH BOT ---
bot.launch({
    polling: {
        timeout: 300 // 5 minutes
    }
});

logMessage('INFO', 'Bot started successfully (Llama 3.2 Offline)', { userId: MY_USER_ID });
console.log("🤖 Bot running with Llama 3.2 (Offline)!");
console.log("💻 All messages → Llama 3.2 (local)");
console.log("⏰ Polling timeout set to 300 seconds (5 minutes).");
console.log("📁 Logs saved to: bot.log");
