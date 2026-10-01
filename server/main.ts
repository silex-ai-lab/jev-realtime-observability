// Entrypoint: `npm run server`. DATABASE_URL → PostgreSQL; else PGlite under DATA_DIR (default .data/pg).
import { mkdirSync } from 'node:fs';
import { createApp } from './app.ts';
import { appOptionsFromEnv } from './config.ts';
import { openDb } from './storage/db.ts';

const opts = appOptionsFromEnv();
const dataDir = process.env.DATA_DIR ?? '.data/pg';
if (!process.env.DATABASE_URL) mkdirSync(dataDir, { recursive: true });
const db = await openDb(process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : { dataDir });
const app = await createApp({ ...opts, db });
const judge = app.judge?.served();
console.log(`jev-runtime-observability listening on ${app.url}`);
console.log(`authentication: ${opts.auth === 'keys' ? 'API keys required (AUTH_MODE=keys)' : 'OFF (AUTH_MODE=none): anyone who can reach this address has full access'}`);
console.log(`storage: ${db.kind}${db.kind === 'pglite' ? ` (${dataDir})` : ''}`);
console.log(`judge: ${app.judge ? `${app.judge.config.backend} → ${judge ? `${judge.run} (${judge.runtime ?? 'runtime unknown'})` : 'not reachable yet'}` : 'not configured'}`);
const stop = async () => { await app.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
