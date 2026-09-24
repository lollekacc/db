class RollingWindowRateLimiter {
  constructor({ windowMs = 60_000, maxEntries = 10_000 } = {}) {
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  consume(key, limit, now = Date.now()) {
    if (this.entries.size >= this.maxEntries) {
      for (const [entryKey, entry] of this.entries) {
        if (entry.resetAt <= now) this.entries.delete(entryKey);
      }
    }
    let entry = this.entries.get(key);
    if (!entry && this.entries.size >= this.maxEntries) {
      return { allowed: false, limit, remaining: 0, resetAt: now + this.windowMs };
    }
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(key, entry);
    }
    entry.count += 1;
    return {
      allowed: entry.count <= limit,
      limit,
      remaining: Math.max(limit - entry.count, 0),
      resetAt: entry.resetAt,
    };
  }
}

module.exports = {
  RollingWindowRateLimiter,
};
