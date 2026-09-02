const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');


const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());


// --- DATABASE SETUP ---
const dbPath = path.join(__dirname, 'conversations.db');
const db = new sqlite3.Database(dbPath);


// --- EXISTING TABLE: conversations ---
db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);


// --- NEW TABLE: trades ---
db.run(`
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


// --- HELPERS (unchanged) ---
const getHistory = (userId, limit = 20) => {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT role, content FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
            [userId, limit],
            (err, rows) => { if (err) reject(err); else resolve(rows.reverse()); }
        );
    });
};


const saveMessage = (userId, role, content) => {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO conversations (user_id, role, content) VALUES (?, ?, ?)`,
            [userId, role, content],
            function(err) { if (err) reject(err); else resolve(this.lastID); }
        );
    });
};


// --- PING ENDPOINT (unchanged) ---
app.get('/ping', (req, res) => {
    res.json({ status: 'ok', message: 'Server is reachable!' });
});


// =============================================
//  TRADE API ENDPOINTS
// =============================================


// 1. FETCH LIVE PRICE (Binance - free)
app.get('/api/price/:symbol', async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    try {
        const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
        const data = await response.json();
        if (data.price) {
            res.json({ symbol, price: parseFloat(data.price) });
        } else {
            res.json({ symbol, price: 65000 + Math.random() * 1000 });
        }
    } catch (error) {
        res.json({ symbol, price: 65000 + Math.random() * 1000 });
    }
});


// 2. GET ALL TRADES
app.get('/api/trades', async (req, res) => {
    const userId = req.query.userId || 'default_user';
    try {
        const trades = await new Promise((resolve, reject) => {
            db.all(
                `SELECT id, symbol, direction, entry_price, quantity, current_price, pnl, status, created_at 
                 FROM trades WHERE user_id = ? ORDER BY created_at DESC`,
                [userId],
                (err, rows) => { if (err) reject(err); else resolve(rows); }
            );
        });
        res.json({ success: true, trades });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// 3. LOG A NEW TRADE
app.post('/api/trades', async (req, res) => {
    const { userId = 'default_user', symbol, direction, entry_price, quantity } = req.body;
    if (!symbol || !entry_price || !quantity) {
        return res.status(400).json({ error: 'Symbol, Entry Price, and Quantity required.' });
    }
    try {
        const priceRes = await fetch(`http://localhost:${PORT}/api/price/${symbol}`);
        const priceData = await priceRes.json();
        const currentPrice = priceData.price || entry_price;


        const result = await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO trades (user_id, symbol, direction, entry_price, quantity, current_price, pnl, status) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, symbol, direction || 'long', entry_price, quantity, currentPrice, 0, 'open'],
                function(err) { if (err) reject(err); else resolve(this.lastID); }
            );
        });
        res.json({ success: true, id: result, message: 'Trade logged!' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// =============================================
//  NEW: VERIFY TRADE ENDPOINT (Calls Llama 3.2)
// =============================================
app.post('/api/verify-trade', async (req, res) => {
    const { prompt, tradeData } = req.body;
    const userId = req.body.userId || 'default_user';


    console.log('🧠 [Verify Trade] Received request, calling Llama 3.2...');


    try {
        const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';


        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);


        const response = await fetch(`${ollamaHost}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'llama3.2',
                prompt: prompt,
                stream: false,
                options: {
                    temperature: 0.3,
                    num_predict: 1024
                }
            }),
            signal: controller.signal
        });


        clearTimeout(timeoutId);


        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Ollama error (${response.status}): ${errorText}`);
        }


        const data = await response.json();
        const aiOutput = data.response;


        console.log('✅ [Verify Trade] Llama 3.2 responded.');


        let parsedResult;
        try {
            const jsonMatch = aiOutput.match(/\{[\s\S]*\}/);
            const jsonString = jsonMatch ? jsonMatch[0] : aiOutput;
            parsedResult = JSON.parse(jsonString);


            const requiredFields = ['entry_assessment', 'risk_level', 'success_probability', 'reasoning', 'suggested_adjustment', 'estimated_time', 'pattern_advice', 'suggested_exits'];
            for (const field of requiredFields) {
                if (!(field in parsedResult)) {
                    console.warn(`⚠️ Missing field in AI response: ${field}`);
                }
            }


        } catch (parseError) {
            console.error('❌ Failed to parse AI response:', parseError.message);
            parsedResult = {
                entry_assessment: "Uncertain",
                risk_level: "Medium",
                success_probability: 50,
                reasoning: "The AI response could not be parsed. Please try again.",
                suggested_adjustment: "Refine your trade parameters.",
                estimated_time: "Unknown",
                pattern_advice: "Monitor the market.",
                suggested_exits: [
                    { label: "Conservative", price: "N/A", probability: 50 },
                    { label: "Moderate", price: "N/A", probability: 40 },
                    { label: "Aggressive", price: "N/A", probability: 30 }
                ]
            };
        }


        const fullResult = {
            ...parsedResult,
            pattern: tradeData?.pattern || null,
            profit_converted: tradeData?.profitConverted || 0,
            estimated_hours: tradeData?.estimatedHours || 0,
            currency: tradeData?.currency || 'USD'
        };


        res.json({
            success: true,
            result: fullResult
        });


    } catch (error) {
        console.error('❌ [Verify Trade] Error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
});


// =============================================
//  SERVE REACT APP (Trade Verifier) AT /verify
// =============================================
const frontendPath = path.join(__dirname, 'frontend', 'build');


// Serve static assets from the React build
app.use('/verify', express.static(frontendPath));


// For any route under /verify, serve index.html (so React Router works)
app.get('/verify*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});


// =============================================
//  WEB UI (Chat + Trade Log) – with a link to /verify
// =============================================
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
            <button onclick="send()">Send</button>
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
                <button onclick="logTrade()">Log Trade</button>
                <button onclick="refreshTrades()">↻ Refresh</button>
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
            // --- CHAT LOGIC (unchanged) ---
            let userId = localStorage.getItem('chatUserId');
            if (!userId) {
                userId = 'user-' + Math.random().toString(36).substring(2, 10);
                localStorage.setItem('chatUserId', userId);
            }


            window.onload = async function() {
                await loadChat();
                await refreshTrades();
            };


            async function loadChat() {
                try {
                    const res = await fetch('/history/' + userId);
                    const history = await res.json();
                    const chatDiv = document.getElementById('chat');
                    chatDiv.innerHTML = '';
                    history.forEach(msg => {
                        const div = document.createElement('div');
                        div.className = 'message ' + msg.role;
                        div.innerHTML = '<strong>' + (msg.role === 'user' ? 'You' : 'AI') + ':</strong> ' + msg.content;
                        chatDiv.appendChild(div);
                    });
                    chatDiv.scrollTop = chatDiv.scrollHeight;
                } catch (e) {
                    console.log('No chat history.');
                }
            }


            async function send() {
                const input = document.getElementById('prompt');
                const chat = document.getElementById('chat');
                const prompt = input.value.trim();
                if (!prompt) return;


                chat.innerHTML += \`<div class="message user"><strong>You:</strong> \${prompt}</div>\`;
                input.value = '';
                chat.scrollTop = chat.scrollHeight;


                try {
                    const res = await fetch('/generate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId, prompt })
                    });
                    const data = await res.json();
                    if (data.success) {
                        chat.innerHTML += \`<div class="message ai"><strong>AI:</strong> \${data.output}</div>\`;
                    } else {
                        chat.innerHTML += \`<div class="message ai"><strong>Error:</strong> \${data.error}</div>\`;
                    }
                } catch (e) {
                    chat.innerHTML += \`<div class="message ai"><strong>Error:</strong> \${e.message}</div>\`;
                }
                chat.scrollTop = chat.scrollHeight;
            }


            document.getElementById('prompt').addEventListener('keyup', (e) => {
                if (e.key === 'Enter') send();
            });


            // --- TRADE LOG LOGIC ---
            async function logTrade() {
                const symbol = document.getElementById('t_symbol').value.trim().toUpperCase();
                const direction = document.getElementById('t_direction').value;
                const entry = parseFloat(document.getElementById('t_entry').value);
                const qty = parseFloat(document.getElementById('t_qty').value);
                if (!symbol || isNaN(entry) || isNaN(qty)) {
                    alert('Please fill all fields correctly.');
                    return;
                }
                try {
                    const res = await fetch('/api/trades', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId, symbol, direction, entry_price: entry, quantity: qty })
                    });
                    const data = await res.json();
                    if (data.success) {
                        alert('Trade logged!');
                        refreshTrades();
                    } else {
                        alert('Error: ' + data.error);
                    }
                } catch (e) {
                    alert('Network error.');
                }
            }


            async function refreshTrades() {
                try {
                    const res = await fetch('/api/trades?userId=' + userId);
                    const data = await res.json();
                    const tbody = document.getElementById('trade-body');
                    if (!data.success || data.trades.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;">No trades yet.</td></tr>';
                        return;
                    }
                    let html = '';
                    let totalPnl = 0;
                    data.trades.forEach(t => {
                        const pnl = t.pnl || 0;
                        totalPnl += pnl;
                        const pnlClass = pnl >= 0 ? 'profit' : 'loss';
                        const statusClass = t.status === 'open' ? 'status-open' : 'status-closed';
                        const date = new Date(t.created_at).toLocaleDateString();
                        html += \`<tr>
                            <td>\${t.symbol}</td>
                            <td>\${t.direction}</td>
                            <td>\${t.entry_price}</td>
                            <td>\${t.quantity}</td>
                            <td>\${t.current_price || '-'}</td>
                            <td class="\${pnlClass}">\${pnl.toFixed(2)}</td>
                            <td class="\${statusClass}">\${t.status}</td>
                            <td>\${date}</td>
                        </tr>\`;
                    });
                    tbody.innerHTML = html;
                    document.getElementById('trade-summary').innerHTML = \`<strong>Total PnL:</strong> <span class="\${totalPnl >= 0 ? 'profit' : 'loss'}">\${totalPnl.toFixed(2)}</span>\`;
                } catch (e) {
                    document.getElementById('trade-body').innerHTML = '<tr><td colspan="8" style="text-align:center;">Error loading trades.</td></tr>';
                }
            }
        </script>
    </body>
    </html>
    `);
});


// --- HISTORY ENDPOINT (unchanged) ---
app.get('/history/:userId', async (req, res) => {
    try {
        const history = await getHistory(req.params.userId, 50);
        res.json(history);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// --- GENERATE ENDPOINT (unchanged) ---
app.post('/generate', async (req, res) => {
    const { userId, prompt } = req.body;


    if (!userId) {
        return res.status(400).json({ error: 'userId required' });
    }
    if (!prompt) {
        return res.status(400).json({ error: 'Prompt required' });
    }


    try {
        await saveMessage(userId, 'user', prompt);
        const history = await getHistory(userId, 20);
        const messages = history.map(msg => ({
            role: msg.role,
            content: msg.content
        }));


        console.log(`💻 [Llama 3.2] Generating for user ${userId}: "${prompt}"`);


        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minutes


        const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
        const response = await fetch(`${ollamaHost}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'llama3.2',
                messages: messages,
                stream: false,
                options: {
                    num_predict: 256,
                    temperature: 0.7
                }
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);


        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Ollama error (${response.status}): ${errorText}`);
        }


        const data = await response.json();
        if (!data.message || !data.message.content) {
            throw new Error('Ollama returned an empty response.');
        }


        const output = data.message.content;
        await saveMessage(userId, 'assistant', output);
        console.log(`✅ [Llama 3.2] Response sent.`);
        res.json({ success: true, output: output });


    } catch (error) {
        console.error('❌ [Llama 3.2] Error:', error.message);
        if (error.name === 'AbortError') {
            res.status(504).json({ success: false, error: '⏳ Llama 3.2 took too long (over 2 mins).' });
        } else {
            res.status(500).json({ success: false, error: error.message });
        }
    }
});


// --- START SERVER ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🧠 AI Model: Llama 3.2 (Offline)`);
    console.log(`📊 Trade Log API enabled.`);
    console.log(`✅ Verify endpoint enabled at /api/verify-trade`);
    console.log(`🌐 React app served at /verify`);
    console.log(`⏰ Timeout: 2 minutes`);
