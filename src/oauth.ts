import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import type { OpenClawPluginApi } from "./types.js";
import { readConfig } from "./types.js";
import { createClient, exchangeCode, fetchViewer } from "./linear.js";
import { resolveTokenPath, saveTokens } from "./tokens.js";
import { parseQuery, sendText } from "./util.js";

const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const DEFAULT_SCOPES = "read,write,app:assignable,app:mentionable";
const STATE_TTL_MS = 10 * 60 * 1000;

const stateStore = new Map<string, number>();

function gcStates(): void {
  const now = Date.now();
  for (const [k, exp] of stateStore) {
    if (exp < now) stateStore.delete(k);
  }
}

export function createConnectHandler(api: OpenClawPluginApi) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET");
      res.end();
      return;
    }
    const cfg = readConfig(api.pluginConfig);
    if (!cfg.linearClientId || !cfg.linearRedirectUri) {
      sendText(
        res,
        500,
        "linear-agent not configured: linearClientId and linearRedirectUri required",
      );
      return;
    }
    gcStates();
    const state = crypto.randomBytes(16).toString("hex");
    stateStore.set(state, Date.now() + STATE_TTL_MS);
    const url = new URL(LINEAR_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: cfg.linearClientId,
      redirect_uri: cfg.linearRedirectUri,
      response_type: "code",
      scope: cfg.linearScopes?.trim() || DEFAULT_SCOPES,
      actor: "app",
      state,
    }).toString();
    res.statusCode = 302;
    res.setHeader("Location", url.toString());
    res.end();
    api.logger.info?.("linear-agent: redirecting to Linear authorize");
  };
}

export function createCallbackHandler(api: OpenClawPluginApi) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET");
      res.end();
      return;
    }
    const cfg = readConfig(api.pluginConfig);
    const q = parseQuery(req.url);
    const err = q.get("error");
    if (err) {
      sendText(
        res,
        400,
        `OAuth error: ${err} — ${q.get("error_description") ?? ""}`,
      );
      return;
    }
    const code = q.get("code") ?? "";
    const state = q.get("state") ?? "";
    if (!code) {
      sendText(res, 400, "Missing code");
      return;
    }
    gcStates();
    const exp = stateStore.get(state);
    if (!exp || exp < Date.now()) {
      sendText(res, 400, "Invalid or expired state");
      return;
    }
    stateStore.delete(state);
    if (
      !cfg.linearClientId ||
      !cfg.linearClientSecret ||
      !cfg.linearRedirectUri
    ) {
      sendText(res, 500, "linear-agent not fully configured");
      return;
    }
    try {
      const t = await exchangeCode({
        code,
        redirectUri: cfg.linearRedirectUri,
        clientId: cfg.linearClientId,
        clientSecret: cfg.linearClientSecret,
      });
      const now = Date.now();
      const viewer = await fetchViewer(createClient(t.access_token)).catch(
        () => undefined,
      );
      await saveTokens(resolveTokenPath(cfg.linearTokenStorePath), {
        accessToken: t.access_token,
        refreshToken: t.refresh_token,
        expiresAt: t.expires_in ? now + t.expires_in * 1000 : undefined,
        scope: t.scope,
        tokenType: t.token_type,
        viewerId: viewer?.viewerId,
        workspaceId: viewer?.workspaceId,
        workspaceUrlKey: viewer?.workspaceUrlKey,
        createdAt: now,
        updatedAt: now,
      });
      sendText(
        res,
        200,
        "Linear agent installed. You can close this tab.",
      );
      api.logger.info?.(
        `linear-agent: token saved (scope=${t.scope ?? ""}, workspace=${viewer?.workspaceUrlKey ?? "?"}, viewer=${viewer?.viewerId ?? "?"})`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      api.logger.error?.(`linear-agent: token exchange failed: ${msg}`);
      sendText(res, 500, `Token exchange failed: ${msg}`);
    }
  };
}
