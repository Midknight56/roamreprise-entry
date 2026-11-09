-- Shared by the apps using this database. Charges reserve neurons before a call runs.
CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app TEXT NOT NULL,
  day TEXT NOT NULL,
  neurons REAL NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_calls_app_day ON ai_calls (app, day);
CREATE INDEX IF NOT EXISTS ai_calls_day ON ai_calls (day);
