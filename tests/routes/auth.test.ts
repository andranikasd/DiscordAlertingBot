import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requireAuth } from "../../src/routes/auth.js";
import type { FastifyRequest, FastifyReply } from "fastify";

let savedToken: string | undefined;

beforeEach(() => {
  savedToken = process.env.AUTH_TOKEN;
  delete process.env.AUTH_TOKEN;
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.AUTH_TOKEN;
  else process.env.AUTH_TOKEN = savedToken;
});

function makeReq(authHeader?: string): FastifyRequest {
  return {
    headers: authHeader !== undefined ? { authorization: authHeader } : {},
    url: "/test",
    method: "GET",
    log: { warn: vi.fn() },
  } as unknown as FastifyRequest;
}

function makeReply() {
  const send = vi.fn();
  const status = vi.fn(() => ({ send }));
  return { status, send } as unknown as FastifyReply & { status: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
}

describe("requireAuth", () => {
  it("returns true when AUTH_TOKEN is not set (auth disabled)", () => {
    const reply = makeReply();
    expect(requireAuth(makeReq(), reply)).toBe(true);
    expect((reply as unknown as { status: ReturnType<typeof vi.fn> }).status).not.toHaveBeenCalled();
  });

  it("returns true when token matches Bearer prefix", () => {
    process.env.AUTH_TOKEN = "my-secret";
    expect(requireAuth(makeReq("Bearer my-secret"), makeReply())).toBe(true);
  });

  it("returns true when token matches without Bearer prefix", () => {
    process.env.AUTH_TOKEN = "my-secret";
    expect(requireAuth(makeReq("my-secret"), makeReply())).toBe(true);
  });

  it("trims whitespace around provided token", () => {
    process.env.AUTH_TOKEN = "trimmed";
    expect(requireAuth(makeReq("Bearer trimmed  "), makeReply())).toBe(true);
  });

  it("returns false and sends 401 when wrong token", () => {
    process.env.AUTH_TOKEN = "correct";
    const reply = makeReply();
    const result = requireAuth(makeReq("Bearer wrong"), reply);
    expect(result).toBe(false);
    expect((reply as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(401);
  });

  it("returns false and sends 401 when no token provided but AUTH_TOKEN is set", () => {
    process.env.AUTH_TOKEN = "required";
    const reply = makeReply();
    const result = requireAuth(makeReq(), reply);
    expect(result).toBe(false);
    expect((reply as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(401);
  });

  it("returns false when authorization header is a non-string type", () => {
    process.env.AUTH_TOKEN = "token";
    // Simulate a multi-value header (array) - falls through to undefined
    const req = {
      headers: { authorization: ["a", "b"] },
      url: "/",
      method: "GET",
      log: { warn: vi.fn() },
    } as unknown as FastifyRequest;
    const reply = makeReply();
    expect(requireAuth(req, reply)).toBe(false);
  });
});