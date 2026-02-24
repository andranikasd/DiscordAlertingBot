import type { FastifyReply, FastifyRequest } from "fastify";

const AUTH_HEADER = "authorization";
const BEARER = "Bearer ";

function getAuthToken(req: FastifyRequest): string | undefined {
  const raw = req.headers[AUTH_HEADER];
  if (typeof raw !== "string") return undefined;
  if (raw.startsWith(BEARER)) return raw.slice(BEARER.length).trim();
  return raw.trim();
}

/**
 * Enforces `AUTH_TOKEN` when set. Returns `true` when authorized; otherwise sends 401 and returns `false`.
 */
export function requireAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  const token = process.env.AUTH_TOKEN?.trim();
  if (!token) return true;

  const provided = getAuthToken(req);
  if (provided !== token) {
    req.log.warn({ component: "auth", event: "rejected", path: req.url, method: req.method }, "request_rejected_auth");
    void reply.status(401).send({ error: "Unauthorized" });
    return false;
  }
  return true;
}

