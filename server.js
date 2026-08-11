const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = 3000;
app.use(express.json());

// --- DATABASE SETUP ---
const dbPath = path.join(__dirname, 'conversations.db');
const db = new sqlite3.Database(dbPath);

db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// --- HELPERS ---
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

// --- PING ENDPOINT ---
app.get('/ping', (req, res) => {
    res.json({ status: 'ok', message: 'Server is reachable!' });
});

// --- SERVE WEB UI ---
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>AI Chat - Llama 3.2</title>
        <style>
            body { font-family: Arial; max-width: 600px; margin: 50px auto; background: #1e1e2e; color: #fff; }
            #chat { height: 400px; overflow-y: scroll; border: 1px solid #444; padding: 10px; background: #2d2d44; border-radius: 8px; margin-bottom: 10px; }
            .user { text-align: right; color: #a6e3a1; }
            .ai { text-align: left; color: #89b4fa; }
            .message { margin: 10px 0; }
            input, button { padding: 10px; border: none; border-radius: 5px; font-size: 16px; }
            input { flex: 1; background: #313244; color: #fff; }
            button { background: #89b4fa; color: #111; font-weight: bold; cursor: pointer; margin-left: 10px; }
            .flex { display: flex; }
        </style>
    </head>
    <body>
        <h2>🧠 AI Chat (Llama 3.2 - Offline)</h2>
        <div id="chat"></div>
        <div class="flex">
            <input id="prompt" placeholder="Type your message..." />
            <button onclick="send()">Send</button>
        </div>
        <script>
            let userId = localStorage.getItem('chatUserId');
            if (!userId) {
                userId = 'user-' + Math.random().toString(36).substring(2, 10);
                localStorage.setItem('chatUserId', userId);
            }

            window.onload = async function() {
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
                    console.log('No existing history found, starting fresh.');
                }
            };

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
                        body: JSON.stringify({ userId: userId, prompt: prompt })
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
        </script>
    </body>
    </html>
    `);
});

// --- HISTORY ENDPOINT ---
app.get('/history/:userId', async (req, res) => {
    try {
        const history = await getHistory(req.params.userId, 50);
        res.json(history);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- GENERATE ENDPOINT (ONLY Llama 3.2) ---
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

// --- START SERVER (FIXED BIND ADDRESS) ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🧠 AI Model: Llama 3.2 (Offline)`);
    console.log(`⏰ Timeout: 2 minutes`);
});
