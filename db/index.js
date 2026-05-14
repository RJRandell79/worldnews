const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../data/newslocator.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at   TEXT NOT NULL,
    mentions      TEXT NOT NULL,
    headlines     TEXT NOT NULL,
    country_headlines TEXT NOT NULL,
    country_sources   TEXT NOT NULL
  );
`);

const stmtInsert = db.prepare(`
  INSERT INTO snapshots (captured_at, mentions, headlines, country_headlines, country_sources)
  VALUES (?, ?, ?, ?, ?)
`);

// Keep only the last 48 rows — 24 h at 30-min intervals
const stmtPrune = db.prepare(`
  DELETE FROM snapshots
  WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT 48)
`);

const stmtLatest = db.prepare(
  `SELECT * FROM snapshots ORDER BY id DESC LIMIT 1`
);

// For sparklines: just id, captured_at, mentions
const stmtHistory = db.prepare(
  `SELECT captured_at, mentions FROM snapshots ORDER BY id ASC`
);

function saveSnapshot(state) {
  stmtInsert.run(
    state.lastUpdated,
    JSON.stringify(state.mentions),
    JSON.stringify(state.headlines),
    JSON.stringify(state.countryHeadlines),
    JSON.stringify(state.countrySources),
  );
  stmtPrune.run();
}

function getLatestSnapshot() {
  const row = stmtLatest.get();
  if (!row) return null;
  return {
    mentions:         JSON.parse(row.mentions),
    headlines:        JSON.parse(row.headlines),
    countryHeadlines: JSON.parse(row.country_headlines),
    countrySources:   JSON.parse(row.country_sources),
    lastUpdated:      row.captured_at,
  };
}

function getMentionHistory() {
  return stmtHistory.all().map(r => ({
    capturedAt: r.captured_at,
    mentions:   JSON.parse(r.mentions),
  }));
}

module.exports = { saveSnapshot, getLatestSnapshot, getMentionHistory };