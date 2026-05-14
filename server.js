require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const countries = require('./data/countries.json');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Build lookup tables from countries data
const numericToAlpha2 = {};
const countryNames = {};
for (const c of countries) {
  numericToAlpha2[String(parseInt(c.iso3n, 10))] = c.iso2;
  countryNames[c.iso2] = c.name;
}

// In-memory state
const state = { mentions: {}, headlines: [], countryHeadlines: {}, countrySources: {}, lastUpdated: null };

const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'newslocator-internal';

// Called by monitor process
app.post('/internal/update', (req, res) => {
  if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) {
    return res.status(403).end();
  }
  const { mentions, headlines, countryHeadlines, countrySources } = req.body;
  state.mentions = mentions || {};
  state.headlines = headlines || [];
  state.countryHeadlines = countryHeadlines || {};
  state.countrySources = countrySources || {};
  state.lastUpdated = new Date().toISOString();
  io.emit('newsUpdate', state);
  res.json({ ok: true });
});

// Public endpoints
app.get('/api/state', (_req, res) => res.json(state));
app.get('/api/countries', (_req, res) => res.json({ numericToAlpha2, countryNames }));

io.on('connection', (socket) => {
  socket.emit('newsUpdate', state);
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
});