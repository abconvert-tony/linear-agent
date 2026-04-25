import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface LinearTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
  viewerId?: string;
  workspaceId?: string;
  workspaceUrlKey?: string;
  createdAt: number;
  updatedAt: number;
}

export function resolveTokenPath(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  return path.join(
    os.homedir(),
    ".openclaw",
    "workspace",
    ".pi",
    "linear-agent-tokens.json",
  );
}

export async function loadTokens(
  p: string,
): Promise<LinearTokens | undefined> {
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<LinearTokens>;
    if (typeof parsed?.accessToken !== "string") return undefined;
    const str = (k: keyof LinearTokens): string | undefined =>
      typeof parsed[k] === "string" ? (parsed[k] as string) : undefined;
    const num = (k: keyof LinearTokens): number | undefined =>
      typeof parsed[k] === "number" ? (parsed[k] as number) : undefined;
    return {
      accessToken: parsed.accessToken,
      refreshToken: str("refreshToken"),
      expiresAt: num("expiresAt"),
      scope: str("scope"),
      tokenType: str("tokenType"),
      viewerId: str("viewerId"),
      workspaceId: str("workspaceId"),
      workspaceUrlKey: str("workspaceUrlKey"),
      createdAt: num("createdAt") ?? Date.now(),
      updatedAt: num("updatedAt") ?? Date.now(),
    };
  } catch {
    return undefined;
  }
}

export async function saveTokens(p: string, t: LinearTokens): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  await fs.writeFile(p, JSON.stringify(t, null, 2), { mode: 0o600 });
  await fs.chmod(p, 0o600).catch(() => {});
}

export async function clearTokens(p: string): Promise<void> {
  await fs.rm(p, { force: true });
}
