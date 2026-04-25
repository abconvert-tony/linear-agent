import type { IncomingMessage, ServerResponse } from "node:http";

const DEFAULT_MAX_BODY = 2 * 1024 * 1024;

export type ReadBodyResult =
  | { ok: true; body: Buffer }
  | { ok: false; status: number; error: string };

export async function readBody(
  req: IncomingMessage,
  limit: number = DEFAULT_MAX_BODY,
): Promise<ReadBodyResult> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > limit) {
      return { ok: false, status: 413, error: "Payload too large" };
    }
    chunks.push(buf);
  }
  return { ok: true, body: Buffer.concat(chunks, total) };
}

export function readHeader(
  req: IncomingMessage,
  name: string,
): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return typeof v === "string" ? v : undefined;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.end(body);
}

export function parseQuery(url: string | undefined): URLSearchParams {
  if (!url) return new URLSearchParams();
  const i = url.indexOf("?");
  return new URLSearchParams(i >= 0 ? url.slice(i + 1) : "");
}

export function readString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function readObject(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}
