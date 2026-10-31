// ============================================
// MX League — Ultra-Fast In-Memory Cache
// ============================================
// Dead-simple TTL cache. Zero dependencies. Sub-millisecond reads.

class MemCache {
  constructor() {
    this._store = new Map();
  }

  /**
   * Get a cached value. Returns null if expired or missing.
   * @param {string} key
   */
  get(key) {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this._store.delete(key);
      return null;
    }
    return entry.value;
  }

  /**
   * Set a cached value with TTL in seconds.
   * @param {string} key
   * @param {*} value
   * @param {number} ttlSeconds
   */
  set(key, value, ttlSeconds) {
    this._store.set(key, {
      value,
      expiry: Date.now() + ttlSeconds * 1000
    });
  }

  /**
   * Invalidate a specific key or all keys matching a prefix.
   * @param {string} keyOrPrefix
   */
  invalidate(keyOrPrefix) {
    if (this._store.has(keyOrPrefix)) {
      this._store.delete(keyOrPrefix);
      return;
    }
    // Prefix invalidation (e.g., 'tournaments' clears 'tournaments:*')
    for (const k of this._store.keys()) {
      if (k.startsWith(keyOrPrefix)) {
        this._store.delete(k);
      }
    }
  }

  /** Clear everything */
  clear() {
    this._store.clear();
  }
}

// Singleton — shared across all routes
module.exports = new MemCache();
