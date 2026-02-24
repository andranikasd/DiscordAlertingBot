import { getRedis } from "./redis.js";

const DEDUP_KEY_PREFIX = "dedup:";

function dedupKey(fingerprint: string): string {
  return `${DEDUP_KEY_PREFIX}${fingerprint}`;
}

/**
 * Returns true if this fingerprint was already seen within ttlMs (duplicate).
 * Otherwise records and returns false. Uses Redis for consistency across restarts.
 */
export async function isDuplicate(fingerprint: string, ttlMs: number): Promise<boolean> {
  const redis = getRedis();
  const key = dedupKey(fingerprint);
  const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
  const exists = await redis.get(key);
  if (exists !== null) return true;
  await redis.setex(key, ttlSec, "1");
  return false;
}

/** Remove suppress for this fingerprint so the next identical alert is delivered immediately. */
export async function clearDedup(fingerprint: string): Promise<void> {
  const redis = getRedis();
  await redis.del(dedupKey(fingerprint));
}

/** Set or extend dedup TTL to ttlMs from now (e.g. after ack to enforce min 10m suppress). */
export async function setDedupTtl(fingerprint: string, ttlMs: number): Promise<void> {
  const redis = getRedis();
  const key = dedupKey(fingerprint);
  const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
  await redis.setex(key, ttlSec, "1");
}
