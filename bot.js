const { Telegraf } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');


// --- CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const MY_USER_ID = parseInt(process.env.MY_USER_ID, 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'conversations.db');


// --- LOGGING ---
const LOG_FILE = path.join(__dirname, 'bot.log');
function logMessage(level, message, data = null) {
    const timestamp = new Date().toISOString();
    let logEntry = `[${timestamp}] [${level}] ${message}`;
    if (data) logEntry += ` | Data: ${JSON.stringify(data)}`;
    console.log(logEntry);
    fs.appendFileSync(LOG_FILE, logEntry + '\n');
}


// --- DATABASE SETUP (WITH NEW REQUESTS TABLE) ---
const db = new sqlite3.Database(DB_PATH);
db.run(`CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
db.run(`CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, description TEXT NOT NULL, due_time INTEGER NOT NULL, status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
db.run(`CREATE TABLE IF NOT EXISTS appointments (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, description TEXT NOT NULL, recurrence_type TEXT NOT NULL, recurrence_value TEXT NOT NULL, time TEXT NOT NULL, last_triggered_date TEXT, status TEXT DEFAULT 'active', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
db.run(`CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT PRIMARY KEY, reply_length INTEGER DEFAULT 10, ai_model TEXT DEFAULT 'llama3.2', updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);


// --- NEW: REQUESTS TABLE ---
db.run(`
    CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        endpoint TEXT,
        schedule TEXT DEFAULT 'daily',
        active INTEGER DEFAULT 1,
        last_run DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);


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


// --- IN-MEMORY STORES ---
const pendingConfirmations = new Map();
const pendingConflicts = new Map();


// --- DATABASE HELPERS (EXISTING) ---
const getHistory = (userId, limit = 10) => new Promise((resolve, reject) => db.all(`SELECT role, content FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`, [userId, limit], (err, rows) => { if (err) reject(err); else resolve(rows.reverse()); }));
const saveMessage = (userId, role, content) => new Promise((resolve, reject) => db.run(`INSERT INTO conversations (user_id, role, content) VALUES (?,?,?)`, [userId, role, content], function(err) { if (err) reject(err); else resolve(this.lastID); }));
const addTask = (userId, desc, due) => new Promise((resolve, reject) => db.run(`INSERT INTO tasks (user_id, description, due_time) VALUES (?,?,?)`, [userId, desc, due], function(err) { if (err) reject(err); else resolve(this.lastID); }));
const getTasksForDateRange = (userId, start, end) => new Promise((resolve, reject) => db.all(`SELECT id, description, due_time FROM tasks WHERE user_id = ? AND status='pending' AND due_time >= ? AND due_time <= ? ORDER BY due_time ASC`, [userId, start, end], (err, rows) => { if (err) reject(err); else resolve(rows); }));
const getTaskById = (userId, taskId) => new Promise((resolve, reject) => db.get(`SELECT id, description, due_time FROM tasks WHERE user_id = ? AND id = ? AND status='pending'`, [userId, taskId], (err, row) => { if (err) reject(err); else resolve(row); }));
const completeTask = (userId, taskId) => new Promise((resolve, reject) => db.run(`UPDATE tasks SET status='done' WHERE id=? AND user_id=?`, [taskId, userId], function(err) { if (err) reject(err); else resolve(this.changes); }));
const deleteTask = (userId, taskId) => new Promise((resolve, reject) => db.run(`DELETE FROM tasks WHERE id=? AND user_id=?`, [taskId, userId], function(err) { if (err) reject(err); else resolve(this.changes); }));
const updateTaskTime = (userId, taskId, newDue) => new Promise((resolve, reject) => db.run(`UPDATE tasks SET due_time = ? WHERE id=? AND user_id=?`, [newDue, taskId, userId], function(err) { if (err) reject(err); else resolve(this.changes); }));
const addAppointment = (userId, desc, type, value, time) => new Promise((resolve, reject) => db.run(`INSERT INTO appointments (user_id, description, recurrence_type, recurrence_value, time) VALUES (?,?,?,?,?)`, [userId, desc, type, value, time], function(err) { if (err) reject(err); else resolve(this.lastID); }));
const getActiveAppointments = (userId) => new Promise((resolve, reject) => db.all(`SELECT id, description, recurrence_type, recurrence_value, time, last_triggered_date FROM appointments WHERE user_id = ? AND status='active'`, [userId], (err, rows) => { if (err) reject(err); else resolve(rows); }));
const deleteAppointment = (userId, apptId) => new Promise((resolve, reject) => db.run(`UPDATE appointments SET status='inactive' WHERE id=? AND user_id=?`, [apptId, userId], function(err) { if (err) reject(err); else resolve(this.changes); }));
const updateLastTriggered = (apptId, date) => new Promise((resolve, reject) => db.run(`UPDATE appointments SET last_triggered_date=? WHERE id=?`, [date, apptId], function(err) { if (err) reject(err); else resolve(); }));
const getSettings = (userId) => new Promise((resolve, reject) => db.get(`SELECT reply_length, ai_model FROM user_settings WHERE user_id = ?`, [userId], (err, row) => { if (err) reject(err); else if (row) resolve(row); else resolve({ reply_length: 10, ai_model: 'llama3.2' }); }));
const updateSettings = (userId, len, model) => new Promise((resolve, reject) => db.run(`INSERT INTO user_settings (user_id, reply_length, ai_model) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET reply_length = excluded.reply_length, ai_model = excluded.ai_model, updated_at = CURRENT_TIMESTAMP`, [userId, len, model], function(err) { if (err) reject(err); else resolve(); }));
function getOrdinal(n) { if (n === 1 || n === 21 || n === 31) return n + 'st'; if (n === 2 || n === 22) return n + 'nd'; if (n === 3 || n === 23) return n + 'rd'; return n + 'th'; }


// --- NEW: REQUEST HELPERS ---
const addRequest = (userId, name, type, schedule = 'daily') => new Promise((resolve, reject) => {
    db.run(`INSERT INTO requests (user_id, name, type, schedule) VALUES (?,?,?,?)`, [userId, name, type, schedule], function(err) { if (err) reject(err); else resolve(this.lastID); });
});
const getActiveRequests = (userId) => new Promise((resolve, reject) => {
    db.all(`SELECT id, name, type, schedule, last_run FROM requests WHERE user_id = ? AND active = 1`, [userId], (err, rows) => { if (err) reject(err); else resolve(rows); });
});
const deleteRequest = (userId, id) => new Promise((resolve, reject) => {
    db.run(`UPDATE requests SET active = 0 WHERE id = ? AND user_id = ?`, [id, userId], function(err) { if (err) reject(err); else resolve(this.changes); });
});
const updateRequestLastRun = (id) => new Promise((resolve, reject) => {
    db.run(`UPDATE requests SET last_run = CURRENT_TIMESTAMP WHERE id = ?`, [id], function(err) { if (err) reject(err); else resolve(); });
});


// --- NEW: API FETCHERS ---
async function fetchCryptoPrice(symbol = 'BTC') {
    try {
        const response = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}USDT`);
        const data = await response.json();
        if (data.priceChange) {
            return `💰 ${symbol}: $${parseFloat(data.lastPrice).toFixed(2)} (24h: ${parseFloat(data.priceChangePercent).toFixed(2)}%)`;
        } else {
            return `⚠️ Could not fetch price for ${symbol}`;
        }
    } catch (error) {
        return `❌ Error fetching price for ${symbol}: ${error.message}`;
    }
}


async function fetchWorldNews(query = 'crypto') {
    const API_KEY = process.env.WORLD_NEWS_API_KEY || 'YOUR_API_KEY_HERE';
    try {
        const response = await fetch(`https://api.worldnewsapi.com/search-news?api-key=${API_KEY}&text=${query}&number=3`);
        const data = await response.json();
        if (data.news && data.news.length > 0) {
            const headlines = data.news.slice(0, 3).map(n => `- ${n.title}`).join('\n');
            return `📰 Latest news on "${query}":\n${headlines}`;
        } else {
            return `📭 No news found for "${query}"`;
        }
    } catch (error) {
        return `❌ Error fetching news: ${error.message}`;
    }
}


// --- NEW: RUN ALL REQUESTS AND GENERATE DIGEST ---
async function runAllRequests(userId) {
    const requests = await getActiveRequests(userId);
    if (requests.length === 0) return '📭 No active requests. Add one with /addrequest.';
    let digest = '';
    for (const req of requests) {
        let result = '';
        if (req.type === 'price') {
            result = await fetchCryptoPrice(req.name);
        } else if (req.type === 'news') {
            result = await fetchWorldNews(req.name);
        } else {
            result = `⚠️ Unknown request type: ${req.type}`;
        }
        digest += result + '\n\n';
        await updateRequestLastRun(req.id);
    }
    return digest;
}


// --- CONFLICT DETECTION (UNCHANGED) ---
const checkConflicts = async (userId, dueTime, bufferMinutes = 30) => {
    const start = dueTime - (bufferMinutes * 60 * 1000);
    const end = dueTime + (bufferMinutes * 60 * 1000);
    return await getTasksForDateRange(userId, start, end);
};


const displayConflictWarning = (conflicts, newDescription, newDateStr, newTimeStr) => {
    let warning = `⚠️ *Conflict Detected!*\nYou already have:\n`;
    conflicts.forEach(t => {
        const d = new Date(t.due_time);
        warning += `   ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')} - ${t.description}\n`;
    });
    warning += `\nYou are trying to book: "${newDescription}" at ${newDateStr} ${newTimeStr}.`;
    warning += `\n\nReply /forceconfirm to override and save anyway.`;
    warning += `\nReply /cancel to discard.`;
    return warning;
};


// --- DATE/TIME PARSER (UNCHANGED) ---
function parseNaturalDate(text) {
    let targetDate = new Date();
    let matched = false;
    if (text.includes('tomorrow')) { targetDate.setDate(targetDate.getDate() + 1); matched = true; } 
    else if (text.includes('today')) { matched = true; } 
    else if (text.includes('next week')) { targetDate.setDate(targetDate.getDate() + 7); matched = true; }
    const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})|(\d{1,2}\s+[A-Za-z]+)/);
    if (dateMatch && !matched) { const parsed = new Date(dateMatch[0]); if (!isNaN(parsed.getTime())) { targetDate = parsed; matched = true; } }
    let hour = 12, minute = 0;
    const timeMatch = text.match(/(\d{1,2}):(\d{2})\s*(am|pm)?|(\d{1,2})\s*(am|pm)/i);
    if (timeMatch) {
        if (timeMatch[1] && timeMatch[2]) {
            hour = parseInt(timeMatch[1]); minute = parseInt(timeMatch[2]);
            if (timeMatch[3] && timeMatch[3].toLowerCase() === 'pm' && hour < 12) hour += 12;
            if (timeMatch[3] && timeMatch[3].toLowerCase() === 'am' && hour === 12) hour = 0;
        } else if (timeMatch[4] && timeMatch[5]) {
            hour = parseInt(timeMatch[4]);
            if (timeMatch[5].toLowerCase() === 'pm' && hour < 12) hour += 12;
            if (timeMatch[5].toLowerCase() === 'am' && hour === 12) hour = 0;
        }
        matched = true;
    }
    if (!matched) return null;
    targetDate.setHours(hour, minute, 0, 0);
    if (isNaN(targetDate.getTime())) return null;
    return targetDate;
}


async function handleReschedule(ctx, taskId, newDateObj) {
    const userId = ctx.from.id.toString();
    const task = await getTaskById(userId, taskId);
    if (!task) return ctx.reply(`❌ Meeting #${taskId} not found or already completed.`);
    const newDue = newDateObj.getTime();
    const dateStr = newDateObj.toISOString().split('T')[0];
    const timeStr = newDateObj.getHours().toString().padStart(2, '0') + ':' + newDateObj.getMinutes().toString().padStart(2, '0');
    const conflicts = await checkConflicts(userId, newDue);
    if (conflicts.length > 0) {
        pendingConflicts.set(userId, { type: 'reschedule', taskId: taskId, newDue: newDue, description: task.description, dateStr, timeStr });
        const warning = await displayConflictWarning(conflicts, task.description, dateStr, timeStr);
        return ctx.reply(warning);
    }
    await updateTaskTime(userId, taskId, newDue);
    ctx.reply(`✅ Rescheduled: "${task.description}" to ${dateStr} at ${timeStr}`);
}


// --- COMMANDS (EXISTING + NEW REQUEST COMMANDS) ---
bot.command('start', ctx => ctx.reply('📅 AI + Calendar Bot ready! Use /help'));
bot.command('help', ctx => ctx.reply(`📋 *Commands:*\n/help - Menu\n/clear - Clear chat\n/ping - Test server\n/setreply [num] - AI reply length\n\n📅 *Schedule:*\nType: "Meet John tomorrow 3pm" (AI Parser + Confirmation)\n/schedule [YYYY-MM-DD] [HH:MM] [desc]\n/today - Recap\n/week - Week recap\n\n🔄 *Manage:*\n/reschedule [id] [date] [time]\n/canceltask [id]\n/forceconfirm - Override conflict\n\n🔄 *Recurring:*\n/addweekly, /addmonthly, /appointments, /stopappt\n\n📰 *Requests:*\n/addrequest [price|news] [name] - e.g., /addrequest price BTC\n/listrequests - Show all your active requests\n/removerequest [id] - Remove a request\n\n📊 *Trading:*\n/trades - Show your last 5 trades\n/verify SYMBOL ENTRY TP SL - AI analysis of a trade setup`));


bot.command('clear', async ctx => { const userId = ctx.from.id.toString(); await db.run(`DELETE FROM conversations WHERE user_id=?`, [userId]); ctx.reply('🧹 Cleared.'); });


bot.command('ping', async (ctx) => {
    const startTime = Date.now();
    try {
        const res = await fetch('http://server:3000/ping');
        const data = await res.json();
        const latency = Date.now() - startTime;
        await ctx.reply(`✅ ${data.message} (Response time: ${latency}ms)`);
        logMessage('INFO', 'Ping successful', { latency });
    } catch (e) {
        await ctx.reply(`❌ Server unreachable: ${e.message}`);
        logMessage('ERROR', 'Ping failed', { error: e.message });
    }
});


bot.command('setreply', async (ctx) => {
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) return ctx.reply('Usage: /setreply 20');
    const len = parseInt(parts[1]);
    if (isNaN(len) || len < 1 || len > 200) return ctx.reply('Number between 1-200.');
    await updateSettings(ctx.from.id.toString(), len, null);
    ctx.reply(`✅ Reply length set to ${len} tokens.`);
});


bot.command('reschedule', async (ctx) => {
    const parts = ctx.message.text.split(' ');
    if (parts.length < 4) return ctx.reply('⚠️ Usage: /reschedule 1 tomorrow 15:30');
    const taskId = parseInt(parts[1]);
    if (isNaN(taskId)) return ctx.reply('⚠️ Invalid Task ID.');
    const dateTimeText = parts.slice(2).join(' ');
    const parsedDate = parseNaturalDate(dateTimeText);
    if (!parsedDate) return ctx.reply('⚠️ Could not parse date/time. Use "tomorrow 3pm" or "2026-08-10 14:30".');
    await handleReschedule(ctx, taskId, parsedDate);
});


bot.command('schedule', async (ctx) => {
    const userId = ctx.from.id.toString();
    const parts = ctx.message.text.split(' ');
    if (parts.length < 4) return ctx.reply('⚠️ Usage: /schedule 2026-08-10 15:30 "Team meeting"');
    const dateStr = parts[1];
    const timeStr = parts[2];
    const description = parts.slice(3).join(' ');
    if (!dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) return ctx.reply('⚠️ Invalid date. Use YYYY-MM-DD.');
    if (!timeStr.match(/^\d{1,2}:\d{2}$/)) return ctx.reply('⚠️ Invalid time. Use HH:MM (24h).');
    const dueDate = new Date(`${dateStr}T${timeStr}:00`);
    if (isNaN(dueDate.getTime())) return ctx.reply('⚠️ Invalid date/time format.');
    const dueTime = dueDate.getTime();


    const conflicts = await checkConflicts(userId, dueTime);
    if (conflicts.length > 0) {
        pendingConflicts.set(userId, { type: 'schedule', description, dueTime, dateStr, timeStr });
        const warning = await displayConflictWarning(conflicts, description, dateStr, timeStr);
        return ctx.reply(warning);
    }


    await addTask(userId, description, dueTime);
    ctx.reply(`✅ Meeting scheduled: "${description}" on ${dateStr} at ${timeStr}`);
    logMessage('INFO', 'Meeting scheduled', { userId, description, dateStr, timeStr });
});


bot.command('confirm', async (ctx) => {
    const userId = ctx.from.id.toString();
    const pending = pendingConfirmations.get(userId);
    if (!pending) return ctx.reply('❌ You have no pending booking to confirm.');
    const conflicts = await checkConflicts(userId, pending.dueTime);
    if (conflicts.length > 0) {
        pendingConflicts.set(userId, { type: 'confirm', pendingData: pending });
        const warning = await displayConflictWarning(conflicts, pending.description, pending.dateStr, pending.timeStr);
        pendingConfirmations.delete(userId);
        return ctx.reply(warning);
    }
    await addTask(userId, pending.description, pending.dueTime);
    pendingConfirmations.delete(userId);
    
    const nextTasks = await getTasksForDateRange(userId, Date.now(), Date.now() + 7 * 86400000);
    const nextThree = nextTasks.slice(0, 3);
    let followUp = `✅ Confirmed! "${pending.description}" booked.\n\n*📅 Next Upcoming:*\n`;
    if (nextThree.length === 0) {
        followUp += `✨ No other appointments scheduled in the next 7 days.`;
    } else {
        nextThree.forEach(t => {
            const d = new Date(t.due_time);
            const dateStr = d.toISOString().split('T')[0];
            const timeStr = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
            followUp += `   ${dateStr} ${timeStr} - ${t.description}\n`;
        });
    }
    await ctx.reply(followUp);
    logMessage('INFO', 'Booking confirmed', { userId, description: pending.description });
});


bot.command('forceconfirm', async (ctx) => {
    const userId = ctx.from.id.toString();
    const conflict = pendingConflicts.get(userId);
    if (!conflict) return ctx.reply('❌ No pending conflict to override.');
    if (conflict.type === 'schedule' || conflict.type === 'confirm') {
        const data = conflict.type === 'schedule' ? conflict : conflict.pendingData;
        await addTask(userId, data.description, data.dueTime);
        ctx.reply(`✅ Override confirmed! "${data.description}" booked.`);
        logMessage('INFO', 'Conflict override confirmed', { userId, description: data.description });
    } else if (conflict.type === 'reschedule') {
        await updateTaskTime(userId, conflict.taskId, conflict.newDue);
        ctx.reply(`✅ Override confirmed! Rescheduled.`);
        logMessage('INFO', 'Reschedule override confirmed', { userId, taskId: conflict.taskId });
    }
    pendingConflicts.delete(userId);
});


bot.command('cancel', async (ctx) => {
    const userId = ctx.from.id.toString();
    if (pendingConfirmations.has(userId)) { pendingConfirmations.delete(userId); return ctx.reply('❌ Booking cancelled.'); }
    if (pendingConflicts.has(userId)) { pendingConflicts.delete(userId); return ctx.reply('❌ Conflict override cancelled.'); }
    ctx.reply('❌ No pending action to cancel.');
});


bot.command('today', async (ctx) => {
    const userId = ctx.from.id.toString();
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endOfDay = startOfDay + 86400000 - 1;
    const todayStr = now.toISOString().split('T')[0];
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const todayName = days[now.getDay()].toLowerCase();
    let reply = `📅 *Schedule for ${todayStr}:*\n\n`;
    const tasks = await getTasksForDateRange(userId, startOfDay, endOfDay);
    if (tasks.length > 0) { reply += `*📌 Meetings:*\n`;
        tasks.forEach(t => { const d = new Date(t.due_time);
            reply += `   ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')} - ${t.description} (ID: ${t.id})\n`; }); }
    const apps = await getActiveAppointments(userId);
    const todayMatches = apps.filter(a => { if (a.recurrence_type === 'weekly') return a.recurrence_value.toLowerCase() === todayName; if (a.recurrence_type === 'monthly') return parseInt(a.recurrence_value) === now.getDate(); return false; });
    if (todayMatches.length > 0) { reply += `\n*🔄 Recurring:*\n`;
        todayMatches.forEach(a => { const label = a.recurrence_type === 'weekly' ? `Every ${a.recurrence_value}` : `Day ${a.recurrence_value}`;
            reply += `   ${a.time} - ${a.description} (${label})\n`; }); }
    if (tasks.length === 0 && todayMatches.length === 0) reply += `✨ No meetings today. Enjoy your day!`;
    ctx.reply(reply);
});


bot.command('week', async (ctx) => {
    const userId = ctx.from.id.toString();
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 7);
    endOfWeek.setHours(23, 59, 59, 999);
    const tasks = await getTasksForDateRange(userId, startOfWeek.getTime(), endOfWeek.getTime());
    const apps = await getActiveAppointments(userId);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    let reply = `📅 *Week of ${startOfWeek.toISOString().split('T')[0]}*\n\n`;
    const taskMap = {};
    tasks.forEach(t => { const d = new Date(t.due_time);
        const key = d.toISOString().split('T')[0]; if (!taskMap[key]) taskMap[key] = [];
        taskMap[key].push(t); });
    for (let i = 0; i < 7; i++) {
        const day = new Date(startOfWeek);
        day.setDate(startOfWeek.getDate() + i);
        const dayStr = day.toISOString().split('T')[0];
        const dayName = days[i];
        reply += `*${dayName} (${dayStr})*\n`;
        if (taskMap[dayStr] && taskMap[dayStr].length > 0) { taskMap[dayStr].forEach(t => { const d = new Date(t.due_time);
                reply += `   ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')} - ${t.description}\n`; }); }
        const dayNameLower = dayName.toLowerCase();
        const dayNumber = day.getDate();
        const dayMatches = apps.filter(a => { if (a.recurrence_type === 'weekly') return a.recurrence_value.toLowerCase() === dayNameLower; if (a.recurrence_type === 'monthly') return parseInt(a.recurrence_value) === dayNumber; return false; });
        dayMatches.forEach(a => { reply += `   ${a.time} - ${a.description} (${a.recurrence_type})\n`; });
        if (!taskMap[dayStr] && dayMatches.length === 0) reply += `   (No meetings)\n`;
        reply += `\n`;
    }
    ctx.reply(reply);
});


bot.command('canceltask', async (ctx) => {
    const userId = ctx.from.id.toString();
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) return ctx.reply('⚠️ Usage: /canceltask 1');
    const id = parseInt(parts[1]);
    if (isNaN(id)) return ctx.reply('Please provide a valid ID.');
    const changes = await deleteTask(userId, id);
    ctx.reply(changes > 0 ? `✅ Meeting #${id} cancelled.` : `❌ Meeting #${id} not found.`);
});


bot.command('addweekly', async ctx => {
    const parts = ctx.message.text.split(' ');
    if (parts.length < 4) return ctx.reply('Usage: /addweekly Monday 10:00 "Desc"');
    const day = parts[1];
    const time = parts[2];
    const desc = parts.slice(3).join(' ');
    if (!['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].includes(day.toLowerCase())) return ctx.reply('Invalid day.');
    if (!time.match(/^\d{1,2}:\d{2}$/)) return ctx.reply('Invalid time (HH:MM).');
    await addAppointment(ctx.from.id.toString(), desc, 'weekly', day.toLowerCase(), time);
    ctx.reply(`✅ Weekly: Every ${day} at ${time} -> "${desc}"`);
});


bot.command('addmonthly', async ctx => {
    const parts = ctx.message.text.split(' ');
    if (parts.length < 4) return ctx.reply('Usage: /addmonthly 15 14:30 "Desc"');
    const date = parseInt(parts[1]);
    const time = parts[2];
    const desc = parts.slice(3).join(' ');
    if (isNaN(date) || date < 1 || date > 31) return ctx.reply('Invalid date (1-31).');
    if (!time.match(/^\d{1,2}:\d{2}$/)) return ctx.reply('Invalid time (HH:MM).');
    await addAppointment(ctx.from.id.toString(), desc, 'monthly', date.toString(), time);
    ctx.reply(`✅ Monthly: Every ${getOrdinal(date)} at ${time} -> "${desc}"`);
});


bot.command('appointments', async ctx => {
    const apps = await getActiveAppointments(ctx.from.id.toString());
    if (apps.length === 0) return ctx.reply('📭 No recurring appointments.');
    let reply = '📅 *Recurring Appointments:*\n';
    apps.forEach(a => { const label = a.recurrence_type === 'weekly' ? `Every ${a.recurrence_value}` : `Day ${a.recurrence_value}`;
        reply += `\n${a.id}. ${label} at ${a.time} -> "${a.description}"`; });
    ctx.reply(reply);
});


bot.command('stopappt', async ctx => {
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) return ctx.reply('Usage: /stopappt 1');
    const id = parseInt(parts[1]);
    if (isNaN(id)) return ctx.reply('Valid ID please.');
    const changes = await deleteAppointment(ctx.from.id.toString(), id);
    ctx.reply(changes > 0 ? `✅ Appointment #${id} cancelled.` : `❌ Not found.`);
});


// ===================== NEW REQUEST COMMANDS =====================
bot.command('addrequest', async (ctx) => {
    const userId = ctx.from.id.toString();
    const parts = ctx.message.text.split(' ');
    if (parts.length < 3) {
        return ctx.reply('⚠️ Usage: /addrequest [price|news] [name]\nExamples:\n/addrequest price BTC\n/addrequest news "crypto market"');
    }
    const type = parts[1].toLowerCase();
    const name = parts.slice(2).join(' ');
    if (!['price', 'news'].includes(type)) {
        return ctx.reply('⚠️ Type must be "price" or "news".');
    }
    try {
        const id = await addRequest(userId, name, type);
        ctx.reply(`✅ Request added! (ID: ${id})\nType: ${type}\nName: ${name}\nI will fetch this daily.`);
        logMessage('INFO', 'Request added', { userId, type, name });
    } catch (error) {
        ctx.reply('❌ Failed to add request.');
        logMessage('ERROR', 'Failed to add request', { error: error.message });
    }
});


bot.command('listrequests', async (ctx) => {
    const userId = ctx.from.id.toString();
    try {
        const requests = await getActiveRequests(userId);
        if (requests.length === 0) {
            return ctx.reply('📭 You have no active requests. Add one with /addrequest.');
        }
        let reply = '📋 *Your Active Requests:*\n';
        requests.forEach(r => {
            const lastRun = r.last_run ? ` (last: ${new Date(r.last_run).toLocaleDateString()})` : ' (never run)';
            reply += `\n${r.id}. ${r.name} (${r.type})${lastRun}`;
        });
        ctx.reply(reply);
    } catch (error) {
        ctx.reply('❌ Failed to fetch requests.');
        logMessage('ERROR', 'Failed to list requests', { error: error.message });
    }
});


bot.command('removerequest', async (ctx) => {
    const userId = ctx.from.id.toString();
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) {
        return ctx.reply('⚠️ Usage: /removerequest [id]');
    }
    const id = parseInt(parts[1]);
    if (isNaN(id)) {
        return ctx.reply('⚠️ Please provide a valid numeric ID.');
    }
    try {
        const changes = await deleteRequest(userId, id);
        if (changes > 0) {
            ctx.reply(`✅ Request #${id} removed.`);
            logMessage('INFO', 'Request removed', { userId, id });
        } else {
            ctx.reply(`❌ Request #${id} not found or already inactive.`);
        }
    } catch (error) {
        ctx.reply('❌ Failed to remove request.');
        logMessage('ERROR', 'Failed to remove request', { error: error.message });
    }
});


// ===================== NEW TRADING COMMANDS =====================


// --- /trades: Show last 5 trades ---
bot.command('trades', async (ctx) => {
    const userId = ctx.from.id.toString();
    try {
        const res = await fetch(`http://server:3000/api/trades?userId=${userId}`);
        const data = await res.json();
        if (!data.success || data.trades.length === 0) {
            return ctx.reply('📭 No trades logged yet.');
        }
        const trades = data.trades.slice(0, 5);
        let reply = '📊 *Your Recent Trades:*\n';
        trades.forEach(t => {
            const pnl = t.pnl || 0;
            const emoji = pnl >= 0 ? '✅' : '❌';
            reply += `\n${emoji} *${t.symbol}* (${t.direction})\n`;
            reply += `   Entry: ${t.entry_price} | Current: ${t.current_price || 'N/A'}\n`;
            reply += `   PnL: ${pnl.toFixed(2)} | Status: ${t.status}\n`;
        });
        await ctx.reply(reply);
    } catch (error) {
        logMessage('ERROR', 'Trades command failed', { error: error.message });
        ctx.reply('❌ Failed to fetch trades.');
    }
});


// --- /verify: AI analysis of a trade setup ---
bot.command('verify', async (ctx) => {
    const text = ctx.message.text;
    const parts = text.split(' ');
    if (parts.length < 5) {
        return ctx.reply('⚠️ Usage: /verify SYMBOL ENTRY TP SL\nExample: /verify BTC 65000 67000 64000');
    }
    const symbol = parts[1].toUpperCase();
    const entry = parseFloat(parts[2]);
    const tp = parseFloat(parts[3]);
    const sl = parseFloat(parts[4]);
    if (isNaN(entry) || isNaN(tp) || isNaN(sl)) {
        return ctx.reply('⚠️ Please provide valid numbers.');
    }


    await ctx.reply('🤔 Analyzing trade...');


    try {
        const prompt = `Analyze a trade for ${symbol} at entry ${entry}, target ${tp}, stop ${sl}. Return JSON with entry_assessment, risk_level, success_probability, reasoning, suggested_adjustment, estimated_time, pattern_advice, suggested_exits.`;
        const res = await fetch('http://server:3000/api/verify-trade', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, tradeData: { pattern: 'N/A', profitConverted: 0, estimatedHours: 0, currency: 'USD' } })
        });
        const data = await res.json();
        if (!data.success) {
            return ctx.reply('❌ Verification failed.');
        }
        const result = data.result;
        let reply = `📊 *AI Analysis for ${symbol}*\n\n`;
        reply += `📌 *Entry Assessment:* ${result.entry_assessment}\n`;
        reply += `⚠️ *Risk Level:* ${result.risk_level}\n`;
        reply += `🎯 *Success Probability:* ${result.success_probability}%\n`;
        reply += `💡 *Reasoning:* ${result.reasoning}\n`;
        reply += `🔧 *Suggested Adjustment:* ${result.suggested_adjustment}\n`;
        reply += `⏱️ *Estimated Time:* ${result.estimated_time}\n`;
        reply += `📈 *Pattern Advice:* ${result.pattern_advice}\n`;
        reply += `\n*Suggested Exits:*\n`;
        result.suggested_exits.forEach(e => {
            reply += `   - ${e.label}: ${e.price} (${e.probability}%)\n`;
        });
        await ctx.reply(reply);
        logMessage('INFO', 'Verify command successful', { symbol, entry, tp, sl });
    } catch (error) {
        logMessage('ERROR', 'Verify command failed', { error: error.message });
        ctx.reply('❌ Error analyzing trade.');
    }
});


// ===================== END NEW TRADING COMMANDS =====================


// --- NATURAL LANGUAGE SCHEDULING PARSER (UNCHANGED) ---
async function handleNaturalLanguageScheduling(ctx) {
    const userId = ctx.from.id.toString();
    const text = ctx.message.text;
    const parsedDate = parseNaturalDate(text);
    if (!parsedDate) return false;


    let description = text.replace(/\b(tomorrow|today|next week|am|pm)\b/gi, '').replace(/\d{1,2}:\d{2}\s*(am|pm)?/gi, '').replace(/\d{4}-\d{2}-\d{2}/gi, '').replace(/\d{1,2}\s+[A-Za-z]+/gi, '').trim();
    if (!description || description.length < 2) description = "Meeting";


    const dateStr = parsedDate.toISOString().split('T')[0];
    const timeStr = parsedDate.getHours().toString().padStart(2, '0') + ':' + parsedDate.getMinutes().toString().padStart(2, '0');


    pendingConfirmations.set(userId, {
        description: description,
        dueTime: parsedDate.getTime(),
        dateStr: dateStr,
        timeStr: timeStr
    });


    await ctx.reply(
        `📅 *Please Confirm:*\n` +
        `Meeting: "${description}"\n` +
        `Date: ${dateStr}\n` +
        `Time: ${timeStr}\n\n` +
        `Reply with /confirm to save, /cancel to discard.`
    );
    return true;
}


// --- SMART SCHEDULING INTERCEPTION (UNCHANGED) ---
async function handleScheduleQuery(ctx, text) {
    const userId = ctx.from.id.toString();
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endOfDay = startOfDay + 86400000 - 1;
    const tasks = await getTasksForDateRange(userId, startOfDay, endOfDay);
    const apps = await getActiveAppointments(userId);
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const todayName = days[now.getDay()].toLowerCase();
    let reply = `📅 *Your Schedule for ${now.toISOString().split('T')[0]}:*\n\n`;
    if (tasks.length === 0) {
        reply += `✨ No meetings scheduled for today. Enjoy your day!`;
    } else {
        reply += `*📌 Meetings Today:*\n`;
        tasks.forEach(t => {
            const d = new Date(t.due_time);
            reply += `   ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')} - ${t.description} (ID: ${t.id})\n`;
        });
        const todayMatches = apps.filter(a => {
            if (a.recurrence_type === 'weekly') return a.recurrence_value.toLowerCase() === todayName;
            if (a.recurrence_type === 'monthly') return parseInt(a.recurrence_value) === now.getDate();
            return false;
        });
        if (todayMatches.length > 0) {
            reply += `\n*🔄 Recurring:*\n`;
            todayMatches.forEach(a => reply += `   ${a.time} - ${a.description}\n`);
        }
    }
    await ctx.reply(reply);
    return true;
}


// --- MAIN AI HANDLER (UNCHANGED) ---
bot.on('text', async (ctx) => {
    const userId = ctx.from.id.toString();
    const text = ctx.message.text;


    // Pending confirmations (Scheduling)
    if (pendingConfirmations.has(userId)) {
        const lower = text.toLowerCase();
        if (lower === 'yes' || lower === 'confirm') {
            return bot.telegram.call('sendMessage', { chat_id: ctx.chat.id, text: '/confirm' });
        } else if (lower === 'no' || lower === 'cancel') {
            pendingConfirmations.delete(userId);
            return ctx.reply('❌ Booking cancelled.');
        }
    }
    if (pendingConflicts.has(userId)) {
        const lower = text.toLowerCase();
        if (lower === 'yes' || lower === 'forceconfirm') {
            return bot.telegram.call('sendMessage', { chat_id: ctx.chat.id, text: '/forceconfirm' });
        } else if (lower === 'no' || lower === 'cancel') {
            pendingConflicts.delete(userId);
            return ctx.reply('❌ Conflict override cancelled.');
        }
    }


    // Natural Language Scheduling (Booking)
    const schedulingKeywords = ['schedule', 'meeting', 'book', 'appointment', 'call', 'tomorrow', 'today', 'next week'];
    const hasKeyword = schedulingKeywords.some(word => text.toLowerCase().includes(word));
    const hasTime = /\d{1,2}:\d{2}/.test(text) || /\d{1,2}\s*(am|pm)/i.test(text);
    if (hasKeyword || hasTime) {
        const handled = await handleNaturalLanguageScheduling(ctx);
        if (handled) return;
    }


    // Smart Schedule Query (e.g., "What's my schedule?" )
    const scheduleQueries = ['what is my schedule', 'what do i have', 'show my appointments', 'my calendar', 'whats on my calendar', 'do i have any meetings', 'whats next', 'upcoming appointments', 'today\'s schedule', 'what am i doing today'];
    const isScheduleQuery = scheduleQueries.some(phrase => text.toLowerCase().includes(phrase));
    if (isScheduleQuery) {
        await handleScheduleQuery(ctx, text);
        return;
    }


    // --- FALLBACK: AI Chat (Llama 3.2) ---
    try {
        await saveMessage(userId, 'user', text);
        await ctx.reply('🤔 Thinking...');


        console.log('💻 Routing to Llama 3.2...');


        const serverUrl = process.env.SERVER_URL || 'http://localhost:3000';
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 180000); // 3 minutes


        const response = await fetch(`${serverUrl}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, prompt: text }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);


        if (response.status === 504) {
            const err = await response.json();
            await ctx.reply(`⏳ ${err.error || 'Llama 3.2 took too long.'}`);
            return;
        }


        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Server error (${response.status}): ${err}`);
        }


        const data = await response.json();
        if (data.success) {
            await ctx.reply(data.output);
            logMessage('INFO', 'AI Response sent (Llama 3.2)', { userId });
        } else {
            await ctx.reply("Error: " + data.error);
        }
    } catch (error) {
        logMessage('ERROR', 'AI Handler crash', { userId, error: error.message });
        if (error.name === 'AbortError') {
            await ctx.reply('⏳ Llama 3.2 took too long (over 3 minutes).');
        } else {
            await ctx.reply('❌ AI Server is offline. Please check your Docker containers (`docker ps`).');
        }
    }
});


// --- BACKGROUND SERVICES ---
// Health check (UNCHANGED)
setInterval(async () => {
    try {
        const res = await fetch('http://server:3000/ping');
        if (!res.ok) throw new Error('HTTP ' + res.status);
    } catch (error) {
        logMessage('ERROR', 'Health Check: Server offline', { error: error.message });
        await bot.telegram.sendMessage(MY_USER_ID, '🔴 *CRITICAL ALERT*: The AI Server (Container) is offline!\nPlease check `docker logs ai-server` or restart with `docker-compose restart server`.');
    }
}, 300000);


// --- DAILY RECAP (8 AM) WITH DIGEST ---
setInterval(async () => {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const lastRunFile = path.join(__dirname, '.daily_recap_run');
    let lastRunDate = '';
    try {
        if (fs.existsSync(lastRunFile)) {
            lastRunDate = fs.readFileSync(lastRunFile, 'utf8').trim();
        }
    } catch (e) {}
    const todayStr = now.toISOString().split('T')[0];


    if (hour === 8 && minute === 0 && lastRunDate !== todayStr) {
        try {
            const userId = MY_USER_ID.toString();


            // 1. Schedule Recap (existing)
            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            const endOfDay = startOfDay + 86400000 - 1;
            const tasks = await getTasksForDateRange(userId, startOfDay, endOfDay);
            const apps = await getActiveAppointments(userId);
            const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
            const todayName = days[now.getDay()].toLowerCase();
            let reply = `☀️ *Good Morning! Your Schedule for ${todayStr}:*\n\n`;
            if (tasks.length > 0) {
                reply += `*📌 Meetings:*\n`;
                tasks.forEach(t => { const d = new Date(t.due_time);
                    reply += `   ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')} - ${t.description}\n`; });
            }
            const todayMatches = apps.filter(a => { if (a.recurrence_type === 'weekly') return a.recurrence_value.toLowerCase() === todayName; if (a.recurrence_type === 'monthly') return parseInt(a.recurrence_value) === now.getDate(); return false; });
            if (todayMatches.length > 0) {
                reply += `\n*🔄 Recurring:*\n`;
                todayMatches.forEach(a => { reply += `   ${a.time} - ${a.description}\n`; });
            }
            if (tasks.length === 0 && todayMatches.length === 0) {
                reply += `✨ No meetings today. Enjoy your day!`;
            }


            // 2. Run all active requests and append digest
            const digest = await runAllRequests(userId);
            if (digest && !digest.includes('No active requests')) {
                reply += `\n\n📊 *Daily Digest:*\n${digest}`;
            }


            await bot.telegram.sendMessage(userId, reply);
            fs.writeFileSync(lastRunFile, todayStr);
            logMessage('INFO', 'Daily recap with digest sent', { date: todayStr });
        } catch (e) {
            logMessage('ERROR', 'Daily recap failed', { error: e.message });
        }
    }
}, 60000);


// --- TASK/APPOINTMENT REMINDERS (UNCHANGED) ---
setInterval(async () => {
    const userId = MY_USER_ID.toString();
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const currentTimeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    try {
        const apps = await getActiveAppointments(userId);
        for (const a of apps) {
            let shouldTrigger = false;
            if (a.recurrence_type === 'weekly') { const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']; if (days[now.getDay()].toLowerCase() === a.recurrence_value.toLowerCase()) shouldTrigger = true; } else if (a.recurrence_type === 'monthly') { if (now.getDate().toString() === a.recurrence_value) shouldTrigger = true; }
            if (shouldTrigger && a.last_triggered_date !== todayStr && currentTimeStr === a.time) {
                await bot.telegram.sendMessage(userId, `⏰ RECURRING REMINDER: "${a.description}"`);
                await updateLastTriggered(a.id, todayStr);
                logMessage('INFO', 'Recurring reminder sent', { description: a.description });
            }
        }
    } catch (e) { logMessage('ERROR', 'Scheduler error (recurring)', { error: e.message }); }
    try {
        const tasks = await getTasksForDateRange(userId, 0, Date.now() + 60000);
        for (const t of tasks) {
            await bot.telegram.sendMessage(userId, `⏰ REMINDER: "${t.description}"`);
            await completeTask(userId, t.id);
            logMessage('INFO', 'One-time reminder sent', { description: t.description });
        }
    } catch (e) { logMessage('ERROR', 'Scheduler error (tasks)', { error: e.message }); }
}, 30000);


// --- LAUNCH BOT ---
bot.launch({
    polling: {
        timeout: 300 // 5 minutes
    }
});


logMessage('INFO', 'Bot started successfully (Llama 3.2 Offline + Request System + Trading Commands)', { userId: MY_USER_ID });
console.log("🤖 Bot running with Llama 3.2 (Offline) + Request System + Trading Commands!");
console.log("💻 All messages → Llama 3.2 (local)");
console.log("📰 /addrequest, /listrequests, /removerequest commands active");
console.log("📊 /trades, /verify commands active");
console.log("⏰ Polling timeout set to 300 seconds (5 minutes).");
console.log("📁 Logs saved to: bot.log");
