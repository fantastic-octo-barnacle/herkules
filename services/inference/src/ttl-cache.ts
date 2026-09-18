/** A small in-process cache. Entries expire after `ttl` ms; the oldest write is evicted at `max`. */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; at: number }>();
  private readonly ttl: number;
  private readonly max: number;
  constructor(ttl: number, max = 1000) {
    this.ttl = ttl;
    this.max = max;
  }
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at >= this.ttl) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }
  /** `at` backdates an entry to when its value was read, not when it was stored. */
  set(key: K, value: V, at = Date.now()) {
    this.entries.delete(key);
    if (this.entries.size >= this.max) {
      for (const [k, e] of this.entries) if (Date.now() - e.at >= this.ttl) this.entries.delete(k);
      // Map iteration is insertion order, so the first key is the oldest write.
      if (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, { value, at });
  }
  delete(key: K) {
    this.entries.delete(key);
  }
  clear() {
    this.entries.clear();
  }
}
