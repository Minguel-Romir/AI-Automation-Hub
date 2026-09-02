const express = require('express');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Apply rate limiting middleware
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});

// Apply the rate limiter to all requests
app.use(limiter);

app.use(express.json());

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// --- Constants / Config ---
const VERIFY_TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS) || 60_000; // 60s
const GENERATE_TIMEOUT_MS = Number(process.env.GENERATE_TIMEOUT_MS) || 120_000; // 120s
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const MODEL_NAME = process.env.LLAMA_MODEL || 'llama3.2';

// --- DATABASE SETUP ---
const dbPath = path.join(__dirname, 'conversations.db');
const db = new sqlite3.Database(dbPath);

// Promisified helpers for sqlite3 (avoids callback hell)
const runAsync = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve({ lastID: this.lastID, changes: this.changes });
    });
});
const allAsync = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if (err) return reject(err); resolve(rows); });
});
const getAsync = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { if (err) return reject(err); resolve(row); });
});

// Ensure DB tables exist
(async () => {
    try {
        await runAsync(`
            CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await runAsync(`
            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                symbol TEXT NOT NULL,
                direction TEXT DEFAULT 'long',
                entry_price REAL NOT NULL,
                quantity REAL NOT NULL,
                current_price REAL,
                exit_price REAL,
                pnl REAL,
                status TEXT DEFAULT 'open',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
    } catch (err) {
        console.error('Failed to initialize DB:', err);
        process.exit(1);
    }
})();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down, closing DB...');
    db.close(err => {
        if (err) console.error('Error closing DB', err);
        else console.log('DB closed.');
        process.exit();
    });
});

// --- HELPERS ---
const getHistory = async (userId, limit = 20) => {
    const rows = await allAsync(`SELECT role, content FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`, [userId, limit]);
    return rows.reverse();
};

const saveMessage = async (userId, role, content) => {
    const r = await runAsync(`INSERT INTO conversations (user_id, role, content) VALUES (?, ?, ?)`, [userId, role, content]);
    return r.lastID;
};

// Price helper (avoids internal HTTP loopback)
const fetchPriceFromBinance = async (symbol) => {
    const s = symbol.toUpperCase();
    try {
        const resp = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${s}USDT`);
        if (!resp.ok) throw new Error(`Binance ${resp.status}`);
        const j = await resp.json();
        return parseFloat(j.price);
    } catch (err) {
        console.warn('Price fetch failed, using fallback:', err.message);
        return 65000 + Math.random() * 1000; // deterministic-ish fallback for dev
    }
};

// Robust JSON extraction from possibly noisy AI output
function extractJsonFromText(text) {
    if (!text || typeof text !== 'string') return null;
    // Try direct parse
    try { return JSON.parse(text); } catch (e) {}

    // Try to find the first JSON object or array
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
        try { return JSON.parse(objectMatch[0]); } catch (e) {}
    }
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
        try { return JSON.parse(arrayMatch[0]); } catch (e) {}
    }
    return null;
}

// Simple input validators
function validateTradeInput({ symbol, entry_price, quantity }) {
    if (!symbol || typeof symbol !== 'string') throw new Error('Invalid symbol');
    if (isNaN(Number(entry_price)) || Number(entry_price) <= 0) throw new Error('Invalid entry_price');
    if (isNaN(Number(quantity)) || Number(quantity) <= 0) throw new Error('Invalid quantity');
}

// --- PING ---
app.get('/ping', (req, res) => {
    res.json({ status: 'ok', message: 'Server is reachable!' });
});

// --- TRADE API ---
app.get('/api/price/:symbol', async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    try {
        const price = await fetchPriceFromBinance(symbol);
        res.json({ symbol, price });
    } catch (err) {
        res.json({ symbol, price: 65000 + Math.random() * 1000 });
    }
});

app.get('/api/trades', async (req, res) => {
    const userId = req.query.userId || 'default_user';
    try {
        const trades = await allAsync(`SELECT id, symbol, direction, entry_price, quantity, current_price, pnl, status, created_at FROM trades WHERE user_id = ? ORDER BY created_at DESC`, [userId]);
        res.json({ success: true, trades });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/trades', async (req, res) => {
    const { userId = 'default_user', symbol, direction = 'long', entry_price, quantity } = req.body;
    try {
        validateTradeInput({ symbol, entry_price, quantity });
        const currentPrice = await fetchPriceFromBinance(symbol);
        const r = await runAsync(`INSERT INTO trades (user_id, symbol, direction, entry_price, quantity, current_price, pnl, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [userId, symbol, direction, entry_price, quantity, currentPrice, 0, 'open']);
        res.status(201).json({ success: true, id: r.lastID, message: 'Trade logged!' });
    } catch (err) {
        if (err.message && err.message.startsWith('Invalid')) {
            return res.status(400).json({ success: false, error: err.message });
        }
        console.error('/api/trades error', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// --- VERIFY TRADE (AI) ---
app.post('/api/verify-trade', async (req, res) => {
    const { prompt, tradeData } = req.body;
    const userId = req.body.userId || 'default_user';

    console.log('🧠 [Verify Trade] Received request, calling model...');

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

        const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: MODEL_NAME,
                prompt: prompt,
                stream: false,
                options: { temperature: 0.3, num_predict: 1024 }
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Model error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        // Ollama may return different shapes; try common fields
        const aiOutput = data.response || data.output || data.text || (data.message && data.message.content) || '';

        console.log('✅ [Verify Trade] Model responded.');

        let parsedResult = extractJsonFromText(aiOutput);
        if (!parsedResult) {
            console.warn('⚠️ Could not parse AI output as JSON; returning fallback.');
            parsedResult = {
                entry_assessment: 'Uncertain',
                risk_level: 'Medium',
                success_probability: 50,
                reasoning: 'The AI response could not be parsed. Please try again.',
                suggested_adjustment: 'Refine your trade parameters.',
                estimated_time: 'Unknown',
                pattern_advice: 'Monitor the market.',
                suggested_exits: [
                    { label: 'Conservative', price: 'N/A', probability: 50 },
                    { label: 'Moderate', price: 'N/A', probability: 40 },
                    { label: 'Aggressive', price: 'N/A', probability: 30 }
                ]
            };
        }

        // warn if missing fields but continue
        const requiredFields = ['entry_assessment', 'risk_level', 'success_probability', 'reasoning', 'suggested_adjustment', 'estimated_time', 'pattern_advice', 'suggested_exits'];
        requiredFields.forEach(f => { if (!(f in parsedResult)) console.warn(`Missing field in AI response: ${f}`); });

        const fullResult = {
            ...parsedResult,
            pattern: tradeData?.pattern || null,
            profit_converted: tradeData?.profitConverted || 0,
            estimated_hours: tradeData?.estimatedHours || 0,
            currency: tradeData?.currency || 'USD'
        };

        res.json({ success: true, result: fullResult });
    } catch (err) {
        console.error('❌ [Verify Trade] Error:', err && err.message ? err.message : err);
        if (err.name === 'AbortError') {
            res.status(504).json({ success: false, error: `Model request timed out after ${VERIFY_TIMEOUT_MS / 1000}s` });
        } else {
            res.status(500).json({ success: false, error: err.message || 'Internal server error' });
        }
    }
});

// --- SERVE REACT APP AT /verify ---
const frontendPath = path.join(__dirname, 'frontend', 'build');
app.use('/verify', express.static(frontendPath));
app.get('/verify*', (req, res) => res.sendFile(path.join(frontendPath, 'index.html')));

// --- WEB UI ---
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>AI Chat + Trade Log</title>
        <style>
            body { font-family: Arial; max-width: 800px; margin: 20px auto; background: #1e1e2e; color: #fff; padding: 0 20px; }
            h2 { color: #89b4fa; }
            .nav-link { display: flex; justify-content: flex-end; margin-bottom: 10px; }
            .nav-link a { color: #89b4fa; text-decoration: none; font-weight: bold; padding: 6px 12px; border: 1px solid #89b4fa; border-radius: 6px; transition: background 0.2s; }
            .nav-link a:hover { background: #89b4fa; color: #111; }
            #chat { height: 350px; overflow-y: scroll; border: 1px solid #444; padding: 10px; background: #2d2d44; border-radius: 8px; margin-bottom: 10px; }
            .user { text-align: right; color: #a6e3a1; }
            .ai { text-align: left; color: #89b4fa; }
            .message { margin: 10px 0; }
            input, button { padding: 10px; border: none; border-radius: 5px; font-size: 16px; }
            input { flex: 1; background: #313244; color: #fff; }
            button { background: #89b4fa; color: #111; font-weight: bold; cursor: pointer; margin-left: 10px; }
            .flex { display: flex; gap: 10px; margin-top: 10px; }
            .section { margin-top: 30px; padding-top: 20px; border-top: 1px solid #444; }
            .trade-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 15px 0; }
            .trade-form input, .trade-form select { padding: 8px; border-radius: 5px; border: none; background: #313244; color: #fff; }
            table { width: 100%; border-collapse: collapse; margin-top: 15px; }
            th, td { padding: 8px; text-align: left; border-bottom: 1px solid #444; }
            th { background: #2d2d44; }
            .profit { color: #a6e3a1; }
            .loss { color: #f38ba8; }
            .status-open { color: #f9e2af; }
            .status-closed { color: #6c7086; }
        </style>
    </head>
    <body>
        <div class="nav-link">
            <a href="/verify">📊 Trade Verifier</a>
        </div>

        <!-- CHAT SECTION -->
        <h2>🧠 AI Chat (Llama 3.2 - Offline)</h2>
        <div id="chat"></div>
        <div class="flex">
            <input id="prompt" placeholder="Type your message..." />
            <button id="sendBtn">Send</button>
        </div>

        <!-- TRADE LOG SECTION -->
        <div class="section">
            <h2>📊 Trade Log</h2>
            <div class="trade-form">
                <input type="text" id="t_symbol" placeholder="Symbol (e.g., BTC)" />
                <select id="t_direction">
                    <option value="long">Long</option>
                    <option value="short">Short</option>
                </select>
                <input type="number" id="t_entry" placeholder="Entry Price" step="any" />
                <input type="number" id="t_qty" placeholder="Quantity" step="any" />
                <button id="logTradeBtn">Log Trade</button>
                <button id="refreshBtn">↻ Refresh</button>
            </div>
            <div id="trade-summary"></div>
            <table id="trade-table">
                <thead>
                    <tr>
                        <th>Symbol</th>
                        <th>Dir</th>
                        <th>Entry</th>
                        <th>Qty</th>
                        <th>Current</th>
                        <th>PnL</th>
                        <th>Status</th>
                        <th>Date</th>
                    </tr>
                </thead>
                <tbody id="trade-body">
                    <tr><td colspan="8" style="text-align:center;">Loading trades...</td></tr>
                </tbody>
            </table>
        </div>

        <script>
            // Avoid innerHTML with untrusted content — use text nodes / textContent

            let userId = localStorage.getItem('chatUserId');
            if (!userId) { userId = 'user-' + Math.random().toString(36).substring(2, 10); localStorage.setItem('chatUserId', userId); }

            window.addEventListener('load', async () => { await loadChat(); await refreshTrades(); });

            async function createMessageElement(role, text) {
                const div = document.createElement('div');
                div.className = 'message ' + role;
                const strong = document.createElement('strong');
                strong.textContent = role === 'user' ? 'You:' : 'AI:';
                div.appendChild(strong);
                div.appendChild(document.createTextNode(' ' + text));
                return div;
            }

            async function loadChat() {
                try {
                    const res = await fetch('/history/' + userId);
                    const history = await res.json();
                    const chatDiv = document.getElementById('chat');
                    chatDiv.innerHTML = '';
                    history.forEach(msg => {
                        const div = document.createElement('div');
                        div.className = 'message ' + msg.role;
                        const strong = document.createElement('strong');
                        strong.textContent = msg.role === 'user' ? 'You:' : 'AI:';
                        div.appendChild(strong);
                        div.appendChild(document.createTextNode(' ' + msg.content));
                        chatDiv.appendChild(div);
                    });
                    chatDiv.scrollTop = chatDiv.scrollHeight;
                } catch (e) { console.log('No chat history.'); }
            }

            document.getElementById('sendBtn').addEventListener('click', send);
            document.getElementById('prompt').addEventListener('keyup', (e) => { if (e.key === 'Enter') send(); });

            async function send() {
                const input = document.getElementById('prompt');
                const chat = document.getElementById('chat');
                const prompt = input.value.trim();
                if (!prompt) return;

                chat.appendChild(await createMessageElement('user', prompt));
                input.value = '';
                chat.scrollTop = chat.scrollHeight;

                try {
                    const res = await fetch('/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, prompt }) });
                    const data = await res.json();
                    if (data.success) {
                        chat.appendChild(await createMessageElement('ai', data.output));
                        await loadChat(); // reload stored history to stay consistent
                    } else {
                        chat.appendChild(await createMessageElement('ai', 'Error: ' + (data.error || 'Unknown')));
                    }
                } catch (e) {
                    chat.appendChild(await createMessageElement('ai', 'Error: ' + e.message));
                }
                chat.scrollTop = chat.scrollHeight;
            }

            // Trade UI
            document.getElementById('logTradeBtn').addEventListener('click', logTrade);
            document.getElementById('refreshBtn').addEventListener('click', refreshTrades);

            async function logTrade() {
                const symbol = document.getElementById('t_symbol').value.trim().toUpperCase();
                const direction = document.getElementById('t_direction').value;
                const entry = parseFloat(document.getElementById('t_entry').value);
                const qty = parseFloat(document.getElementById('t_qty').value);
                if (!symbol || isNaN(entry) || isNaN(qty)) { alert('Please fill all fields correctly.'); return; }

                try {
                    const res = await fetch('/api/trades', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, symbol, direction, entry_price: entry, quantity: qty }) });
                    const data = await res.json();
                    if (data.success) { alert('Trade logged!'); refreshTrades(); }
                    else alert('Error: ' + (data.error || 'Unknown'));
                } catch (e) { alert('Network error.'); }
            }

            function makeCell(text, className) {
                const td = document.createElement('td');
                if (className) td.className = className;
                td.textContent = (text === null || text === undefined) ? '-' : String(text);
                return td;
            }

            async function refreshTrades() {
                try {
                    const res = await fetch('/api/trades?userId=' + userId);
                    const data = await res.json();
                    const tbody = document.getElementById('trade-body');
                    tbody.innerHTML = '';
                    if (!data.success || !data.trades || data.trades.length === 0) {
                        const tr = document.createElement('tr');
                        const td = document.createElement('td');
                        td.colSpan = 8; td.style.textAlign = 'center'; td.textContent = 'No trades yet.';
                        tr.appendChild(td); tbody.appendChild(tr); return;
                    }
                    let totalPnl = 0;
                    data.trades.forEach(t => {
                        const tr = document.createElement('tr');
                        const pnl = Number(t.pnl) || 0; totalPnl += pnl;
                        tr.appendChild(makeCell(t.symbol));
                        tr.appendChild(makeCell(t.direction));
                        tr.appendChild(makeCell(t.entry_price));
                        tr.appendChild(makeCell(t.quantity));
                        tr.appendChild(makeCell(t.current_price));
                        tr.appendChild(makeCell(pnl.toFixed(2), pnl >= 0 ? 'profit' : 'loss'));
                        tr.appendChild(makeCell(t.status, t.status === 'open' ? 'status-open' : 'status-closed'));
                        tr.appendChild(makeCell(new Date(t.created_at).toLocaleDateString()));
                        tbody.appendChild(tr);
                    });
                    const summary = document.getElementById('trade-summary');
                    summary.innerHTML = ''; // safe small HTML
                    const strong = document.createElement('strong');
                    strong.textContent = 'Total PnL:';
                    const span = document.createElement('span');
                    span.className = totalPnl >= 0 ? 'profit' : 'loss';
                    span.textContent = ' ' + totalPnl.toFixed(2);
                    summary.appendChild(strong); summary.appendChild(span);
                } catch (e) {
                    const tbody = document.getElementById('trade-body');
                    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;">Error loading trades.</td></tr>';
                }
            }
        </script>
    </body>
    </html>
    `);
});

// --- HISTORY ---
app.get('/history/:userId', async (req, res) => {
    try {
        const history = await getHistory(req.params.userId, 50);
        res.json(history);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- GENERATE (chat) ---
app.post('/generate', async (req, res) => {
    const { userId, prompt } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });

    try {
        await saveMessage(userId, 'user', prompt);
        const history = await getHistory(userId, 20);
        const messages = history.map(msg => ({ role: msg.role, content: msg.content }));

        console.log(`💻 [${MODEL_NAME}] Generating for user ${userId}: "${prompt}"`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);

        const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: MODEL_NAME, messages, stream: false, options: { num_predict: 256, temperature: 0.7 } }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Model error (${response.status}): ${errText}`);
        }

        const data = await response.json();
        const output = data.message && data.message.content ? data.message.content : (data.response || data.output || data.text || '');
        if (!output) throw new Error('Model returned an empty response.');

        await saveMessage(userId, 'assistant', output);
        console.log(`✅ [${MODEL_NAME}] Response sent.`);
        res.json({ success: true, output });
    } catch (err) {
        console.error('❌ [Generate] Error:', err && err.message ? err.message : err);
        if (err.name === 'AbortError') res.status(504).json({ success: false, error: `Model took too long (over ${GENERATE_TIMEOUT_MS / 1000}s).` });
        else res.status(500).json({ success: false, error: err.message || 'Internal server error' });
    }
});

// --- START SERVER ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🧠 AI Model: ${MODEL_NAME}`);
    console.log(`📊 Trade Log API enabled.`);
    console.log(`✅ Verify endpoint enabled at /api/verify-trade`);
    console.log(`🌐 React app served at /verify`);
    console.log(`⏰ Timeouts: verify=${VERIFY_TIMEOUT_MS}ms generate=${GENERATE_TIMEOUT_MS}ms`);
});
