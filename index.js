require('dotenv').config();
const express = require('express');
const app = express(); 
app.use(express.json());

const { Pool } = require('pg');
const { createClient } = require('redis');
const PORT = process.env.PORT || 3000;

// --- Database & Cache Connection ---
const pgPool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

const redisClient = createClient({
    url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));



// --- Base62 Conversion Logic ---
const BASE62_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function toBase62(num) {
    if (num === 0) return BASE62_CHARS[0];
    let sb = '';
    while (num > 0) {
        sb = BASE62_CHARS[num % 62] + sb;
        num = Math.floor(num / 62);
    }
    return sb;
}

//API Endpoints


// 1. Shorten URL Endpoint
app.post('/api/v1/shorten', async (req, res) => {
    const { long_url } = req.body;
    if (!long_url) {
        return res.status(400).json({ error: 'long_url is required' });
    }

    try {
        const result = await pgPool.query(
            'INSERT INTO urls (long_url) VALUES ($1) RETURNING id',
            [long_url]
        );
        const id = result.rows[0].id;
        const shortKey = toBase62(id);

        // Store the short_key back in the database for easier lookups
        await pgPool.query('UPDATE urls SET short_key = $1 WHERE id = $2', [shortKey, id]);

        res.status(201).json({ short_url: `http://localhost:${PORT}/${shortKey}` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// 2. Redirect Endpoint
app.get('/:shortKey', async (req, res) => {
    const { shortKey } = req.params;

    try {
        // Step 1: Check cache first
        const cachedUrl = await redisClient.get(shortKey);
        if (cachedUrl) {
            console.log('Cache hit!');
            return res.redirect(301, cachedUrl);
        }

        // Step 2: If not in cache, query the database
        console.log('Cache miss!');
        const result = await pgPool.query('SELECT long_url FROM urls WHERE short_key = $1', [shortKey]);

        if (result.rows.length === 0) {
            return res.status(404).send('Not Found');
        }

        const longUrl = result.rows[0].long_url;

        // Step 3: Store the result in the cache for future requests
        // Set it to expire in 1 hour (3600 seconds)
        await redisClient.set(shortKey, longUrl, { EX: 3600 });

        res.redirect(301, longUrl);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Start Server and Connect Services ---
const startServer = async () => {
    try {
        await redisClient.connect();
        console.log('Connected to Redis successfully!');

        // Initialize DB Table
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS urls (
                id BIGSERIAL PRIMARY KEY,
                long_url TEXT NOT NULL,
                short_key VARCHAR(10) UNIQUE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Database table checked/created successfully!');

        app.listen(PORT, () => {
            console.log(`Server is running on http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
};

startServer();