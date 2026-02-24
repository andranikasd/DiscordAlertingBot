import { Redis } from "ioredis";
import type { StoredAlert } from "../types/alert.js";

const TTL_SEC = 60 * 60 * 24 * 7; // 7 days

function alertKey(alertId: string, resource?: string): string {
  return `alert:${alertId}:${resource ?? "default"}`;
}

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    client = new Redis(url, { maxRetriesPerRequest: 3 });
  }
  return client;
}

export async function getStoredAlert(
  alertId: string,
  resource?: string
): Promise<StoredAlert | null> {
  const redis = getRedis();
  const raw = await redis.get(alertKey(alertId, resource));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredAlert;
  } catch {
    return null;
  }
}

/**
 * Persist alert state. Callers are responsible for setting updatedAt in `data`; this function
 * does NOT inject its own timestamp so that escalation timing (which must not reset updatedAt)
 * and other callers that supply a specific time (acknowledgedAt, resolvedAt) work correctly.
 */
export async function setStoredAlert(
  alertId: string,
  resource: string | undefined,
  data: StoredAlert
): Promise<void> {
  const redis = getRedis();
  const key = alertKey(alertId, resource);
  await redis.setex(key, TTL_SEC, JSON.stringify(data));
}

export async function deleteStoredAlert(alertId: string, resource?: string): Promise<void> {
  const redis = getRedis();
  await redis.del(alertKey(alertId, resource));
}

/**
 * Return all alert state keys (used by the escalation loop).
 * Uses SCAN to avoid blocking Redis — KEYS is O(N) and should never be used in production.
 */
export async function getStoredAlertKeys(): Promise<string[]> {
  const redis = getRedis();
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", "alert:*", "COUNT", 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}