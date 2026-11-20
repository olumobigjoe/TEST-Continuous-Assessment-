import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { openDb } from './db.js';
import { createApp, Clock } from './app.js';
import { seed } from './seed.js';
import { sweepExpired } from './attempts.js';

const PORT = Number(process.env.PORT ?? 4000);
const DEV = process.env.NODE_ENV !== 'production';
const dbFile = process.env.DB_FILE ?? path.resolve('data/test-management.sqlite');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const clock: Clock & { offset: number } = { offset: 0, now() { return Date.now() + this.offset; } };
const db = openDb(dbFile);
if (process.env.SEED !== 'false') seed(db, clock.now());

const app = createApp(db, clock, { devTools: DEV });

// Serve the built client in production
const clientDist = path.resolve('../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// Server-side auto-submit: every expired TEST session is closed even if the browser is gone.
setInterval(() => {
  const n = sweepExpired(db, clock.now());
  if (n) console.log(`[auto-submit] ${n} TEST session(s) submitted at deadline`);
}, 5_000);

app.listen(PORT, () => console.log(`TEST Management API on http://localhost:${PORT}`));
