const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// API Key OpenAI (disimpan di environment variable)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-3b9860d2cb0a419397618b4b7e2fe553";
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

// Endpoint untuk health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        message: 'AI Assistant Backend is running',
        timestamp: new Date().toISOString()
    });
});

// Endpoint untuk mendapatkan informasi model
app.get('/api/models', (req, res) => {
    res.json({
        available_models: [
            {
                id: "gpt-3.5-turbo",
                name: "GPT-3.5 Turbo",
                description: "Model cepat dan efisien untuk kebanyakan tugas",
                max_tokens: 4096
            },
            {
                id: "gpt-4",
                name: "GPT-4",
                description: "Model paling canggih untuk tugas kompleks",
                max_tokens: 8192
            }
        ],
        default_model: "gpt-3.5-turbo"
    });
});

// Endpoint utama untuk chat
app.post('/api/chat', async (req, res) => {
    try {
        const { messages, model = "gpt-3.5-turbo", temperature = 0.7, max_tokens = 1000 } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({
                error: "Messages array is required"
            });
        }

        console.log(`Processing chat request with ${messages.length} messages`);

        const response = await axios.post(
            OPENAI_API_URL,
            {
                model: model,
                messages: messages,
                temperature: parseFloat(temperature),
                max_tokens: parseInt(max_tokens)
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENAI_API_KEY}`
                },
                timeout: 30000 // 30 detik timeout
            }
        );

        const aiResponse = response.data.choices[0].message;
        
        res.json({
            success: true,
            response: aiResponse,
            usage: response.data.usage,
            model: response.data.model
        });

    } catch (error) {
        console.error('Error in /api/chat:', error.message);
        
        let statusCode = 500;
        let errorMessage = 'Internal server error';
        
        if (error.response) {
            // Error dari OpenAI API
            statusCode = error.response.status;
            errorMessage = error.response.data.error?.message || 'OpenAI API error';
        } else if (error.request) {
            // Tidak dapat terhubung ke OpenAI API
            errorMessage = 'Cannot connect to AI service';
        }
        
        res.status(statusCode).json({
            success: false,
            error: errorMessage,
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Endpoint untuk streaming (opsional)
app.post('/api/chat/stream', async (req, res) => {
    try {
        const { messages, model = "gpt-3.5-turbo", temperature = 0.7 } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({
                error: "Messages array is required"
            });
        }

        // Set headers untuk SSE (Server-Sent Events)
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const response = await axios.post(
            OPENAI_API_URL,
            {
                model: model,
                messages: messages,
                temperature: parseFloat(temperature),
                stream: true
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENAI_API_KEY}`
                },
                responseType: 'stream'
            }
        );

        // Teruskan stream dari OpenAI ke client
        response.data.pipe(res);

    } catch (error) {
        console.error('Error in /api/chat/stream:', error.message);
        res.status(500).json({
            success: false,
            error: 'Streaming error'
        });
    }
});

// Endpoint untuk batch processing (banyak pertanyaan sekaligus)
app.post('/api/chat/batch', async (req, res) => {
    try {
        const { queries, model = "gpt-3.5-turbo" } = req.body;

        if (!queries || !Array.isArray(queries)) {
            return res.status(400).json({
                error: "Queries array is required"
            });
        }

        // Batasi jumlah query
        const limitedQueries = queries.slice(0, 5);
        
        const promises = limitedQueries.map(async (query) => {
            try {
                const response = await axios.post(
                    OPENAI_API_URL,
                    {
                        model: model,
                        messages: [
                            { role: "system", content: "Jawablah pertanyaan dengan singkat dan jelas." },
                            { role: "user", content: query }
                        ],
                        temperature: 0.5,
                        max_tokens: 500
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${OPENAI_API_KEY}`
                        }
                    }
                );

                return {
                    query: query,
                    response: response.data.choices[0].message.content,
                    success: true
                };
            } catch (error) {
                return {
                    query: query,
                    error: error.message,
                    success: false
                };
            }
        });

        const results = await Promise.all(promises);
        
        res.json({
            success: true,
            results: results,
            total_processed: results.length
        });

    } catch (error) {
        console.error('Error in /api/chat/batch:', error.message);
        res.status(500).json({
            success: false,
            error: 'Batch processing error'
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        success: false,
        error: 'Something went wrong!',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
    console.log(`API Key status: ${OPENAI_API_KEY ? 'Loaded' : 'Not found'}`);
    console.log(`Mode: ${process.env.NODE_ENV || 'development'}`);
});