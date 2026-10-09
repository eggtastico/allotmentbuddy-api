const fs = require('node:fs');
const path = require('node:path');

/**
 * Spending the AI allowance carefully. The key is on OpenRouter's free tier: 50 free-model
 * requests a day, shared by every user of every AI feature. So identical grow-guide requests are
 * answered from a cache, and each user has a daily cap so no one account can use the lot.
 */

/** A grow guide's cache key: the same plants in any order, case or spacing ask the same thing. */
function guideKey(plants) {
  return String(plants)
    .split(/[\n,]+/)
    .map((p) => p.replace(/^[\s\-*•\d.]+/, '').trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('|');
}

/** Grow guides by plant list, kept on disk so a restart doesn't lose them, for `ttlMs`. */
function createGuideCache(file, ttlMs, now = () => Date.now()) {
  let entries = {};
  try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* starts empty */ }
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(entries));
    } catch (err) { console.error('[ai-budget] cache not saved:', err.message); }
  };
  return {
    get(key) {
      const e = entries[key];
      return e && now() - e.at < ttlMs ? e.reply : null;
    },
    set(key, reply) {
      for (const [k, e] of Object.entries(entries)) if (now() - e.at >= ttlMs) delete entries[k];
      entries[key] = { reply, at: now() };
      save();
    },
  };
}

/** At most `limit` AI requests per user per UTC day (the day OpenRouter's allowance resets on). */
function createUserCap(limit, now = () => Date.now()) {
  const counts = new Map(); // `${day}|${userId}` → requests
  const day = () => new Date(now()).toISOString().slice(0, 10);
  return {
    limit,
    used: (userId) => counts.get(`${day()}|${userId}`) ?? 0,
    /** Count one request if the user has any left; false if they don't. */
    take(userId) {
      const d = day();
      for (const k of counts.keys()) if (!k.startsWith(`${d}|`)) counts.delete(k);
      const key = `${d}|${userId}`;
      const n = counts.get(key) ?? 0;
      if (n >= limit) return false;
      counts.set(key, n + 1);
      return true;
    },
  };
}

module.exports = { guideKey, createGuideCache, createUserCap };
