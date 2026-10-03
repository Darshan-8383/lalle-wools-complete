/**
 * Copies the live database file to server/data/backups/ with a timestamp.
 * The whole store is a single file (server/data/store.sqlite), so this is
 * the entire backup — no separate dump tool needed.
 *
 * Usage: node scripts/backup-db.js
 *
 * For real production use, schedule this to run automatically:
 *   - Windows: Task Scheduler → run "node scripts/backup-db.js" daily
 *   - Linux/Mac: a cron entry, e.g. `0 3 * * * cd /path/to/app && node scripts/backup-db.js`
 * Also copy the backups/ folder off the server regularly (to cloud storage,
 * another machine, etc.) — a backup that lives on the same disk as the
 * original doesn't protect you if that disk fails.
 */
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'server', 'data', 'store.sqlite');
const BACKUP_DIR = path.join(__dirname, '..', 'server', 'data', 'backups');

if (!fs.existsSync(DB_FILE)) {
  console.error('No database file found yet at', DB_FILE, '— run the app at least once first.');
  process.exit(1);
}

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.join(BACKUP_DIR, `store-${stamp}.sqlite`);
fs.copyFileSync(DB_FILE, dest);
console.log(`✅ Backed up database to ${dest}`);

// Keep the last 30 backups, delete older ones.
const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.sqlite')).sort();
const excess = files.length - 30;
if (excess > 0) {
  for (const f of files.slice(0, excess)) fs.unlinkSync(path.join(BACKUP_DIR, f));
  console.log(`   Pruned ${excess} old backup(s), keeping the most recent 30.`);
}
