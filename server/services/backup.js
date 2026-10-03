/**
 * Automatic database backups.
 * The whole store is one SQLite file, so a backup is a timestamped copy of it.
 * Runs shortly after boot and then every 24h, keeping the newest KEEP copies.
 * NOTE: backups on the same disk don't protect you from losing the disk — copy
 * server/data/backups/ off the machine regularly (see README → Backups).
 */
const fs = require('fs');
const path = require('path');

const KEEP = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

function backupNow(dbFile) {
  if (!fs.existsSync(dbFile)) return null;
  const dir = path.join(path.dirname(dbFile), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `store-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  fs.copyFileSync(dbFile, dest);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sqlite')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) fs.unlinkSync(path.join(dir, f));
  return dest;
}

function startAutoBackup(dbFile) {
  const run = () => {
    try { const d = backupNow(dbFile); if (d) console.log(`[backup] saved ${path.basename(d)}`); }
    catch (err) { console.error('[backup] failed:', err.message); }
  };
  const first = setTimeout(run, 60 * 1000);
  const every = setInterval(run, DAY_MS);
  first.unref(); every.unref(); // never keep the process alive just for backups
  return () => { clearTimeout(first); clearInterval(every); };
}

module.exports = { backupNow, startAutoBackup };
