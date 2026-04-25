import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  LINEAR_WEBHOOK_SIGNATURE_HEADER,
  LINEAR_WEBHOOK_TS_FIELD,
  LinearWebhookClient,
} from "@linear/sdk/webhooks";
import type { LinearClient } from "@linear/sdk";
import type { OpenClawPluginApi, PluginConfig } from "./types.js";
import { readConfig } from "./types.js";
import {
  readBody,
  readHeader,
  readObject,
  readString,
  sendJson,
} from "./util.js";
import {
  clearTokens,
  loadTokens,
  resolveTokenPath,
  saveTokens,
  type LinearTokens,
} from "./tokens.js";
import {
  createClient,
  fetchSessionActivities,
  fetchStateIdByType,
  fetchViewer,
  postActivity,
  refreshTokens,
  updateIssue,
  type PastActivitySummary,
} from "./linear.js";
import {
  deleteBinding,
  setBinding,
  type LinearBinding,
} from "./bindings.js";

const MAX_BODY = 2 * 1024 * 1024;
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const REFRESH_WINDOW_MS = 60_000;
const DEDUP_WINDOW_MS = 5_000;

type GatewayCall = (opts: Record<string, unknown>) => Promise<unknown>;
const callRef: { value?: GatewayCall } = {};

// Session-level dedup. Linear can fire both an AgentSessionEvent and a
// Comment webhook for the same prompt; within this window we treat repeats
// as duplicates.
const inflightSessions = new Map<string, number>();

// Cache webhook clients by secret so verify() stays fast.
const webhookClientCache = new Map<string, LinearWebhookClient>();
function getWebhookClient(secret: string): LinearWebhookClient {
  let c = webhookClientCache.get(secret);
  if (!c) {
    c = new LinearWebhookClient(secret);
    webhookClientCache.set(secret, c);
  }
  return c;
}

async function loadCallGateway(api: OpenClawPluginApi): Promise<GatewayCall> {
  if (callRef.value) return callRef.value;
  if (typeof api.callGateway === "function") {
    callRef.value = api.callGateway as GatewayCall;
    return callRef.value;
  }
  const argv1 = typeof process?.argv?.[1] === "string" ? process.argv[1] : "";
  const distDir = argv1 ? path.dirname(argv1) : "";
  if (!distDir || !fs.existsSync(distDir)) {
    throw new Error("callGateway not available and gateway dist directory not found");
  }
  const files = fs
    .readdirSync(distDir)
    .filter((name) => name.startsWith("call-") && name.endsWith(".js"))
    .sort((a, b) =>
      a.startsWith("call--") === b.startsWith("call--")
        ? 0
        : a.startsWith("call--")
          ? 1
          : -1,
    );
  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(path.join(distDir, file)).href);
      const fn =
        (mod?.n as ((...args: unknown[]) => unknown) | undefined) ??
        (mod?.callGateway as ((...args: unknown[]) => unknown) | undefined);
      if (typeof fn !== "function") continue;
      const auth = api.config?.gateway?.auth ?? {};
      const token = typeof auth.token === "string" ? auth.token.trim() : undefined;
      const password = typeof auth.password === "string" ? auth.password.trim() : undefined;
      const call: GatewayCall = (opts) =>
        fn({
          ...opts,
          token: (opts?.token as string | undefined) ?? token,
          password: (opts?.password as string | undefined) ?? password,
        }) as Promise<unknown>;
      callRef.value = call;
      return call;
    } catch (err) {
      api.logger?.debug?.(
        `linear-agent: callGateway import failed (${file}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  throw new Error("callGateway not available. Ensure the plugin is running inside an OpenClaw gateway process.");
}

function gcInflight(): void {
  const now = Date.now();
  for (const [k, exp] of inflightSessions) {
    if (now - exp > 5 * 60_000) inflightSessions.delete(k);
  }
}

async function ensureFreshToken(
  api: OpenClawPluginApi,
  tokenPath: string,
  clientId?: string,
  clientSecret?: string,
): Promise<LinearTokens | undefined> {
  const t = await loadTokens(tokenPath);
  if (!t) return undefined;
  if (!t.expiresAt || t.expiresAt > Date.now() + REFRESH_WINDOW_MS) return t;
  if (!t.refreshToken || !clientId || !clientSecret) return t;
  try {
    const r = await refreshTokens({
      refreshToken: t.refreshToken,
      clientId,
      clientSecret,
    });
    const now = Date.now();
    const next: LinearTokens = {
      ...t,
      accessToken: r.access_token,
      refreshToken: r.refresh_token ?? t.refreshToken,
      expiresAt: r.expires_in ? now + r.expires_in * 1000 : undefined,
      scope: r.scope ?? t.scope,
      tokenType: r.token_type ?? t.tokenType,
      updatedAt: now,
    };
    if (!next.viewerId || !next.workspaceId) {
      const viewer = await fetchViewer(createClient(next.accessToken)).catch(
        () => undefined,
      );
      if (viewer) {
        next.viewerId = viewer.viewerId;
        next.workspaceId = viewer.workspaceId;
        next.workspaceUrlKey = viewer.workspaceUrlKey || next.workspaceUrlKey;
      }
    }
    await saveTokens(tokenPath, next);
    return next;
  } catch (err) {
    api.logger.warn?.(
      `linear-agent: refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return t;
  }
}

export function createWebhookHandler(api: OpenClawPluginApi) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end();
      return;
    }
    const read = await readBody(req, MAX_BODY);
    if (!read.ok) {
      sendJson(res, read.status, { ok: false, error: read.error });
      return;
    }
    const raw = read.body;
    const cfg = readConfig(api.pluginConfig);
    const sig = readHeader(req, LINEAR_WEBHOOK_SIGNATURE_HEADER);
    const delivery = readHeader(req, "linear-delivery");

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      return;
    }

    if (cfg.linearWebhookSecret) {
      try {
        // SDK verify() throws on HMAC mismatch or stale timestamp (>60s).
        getWebhookClient(cfg.linearWebhookSecret).verify(
          raw,
          sig ?? "",
          payload[LINEAR_WEBHOOK_TS_FIELD] as number | string | undefined,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        api.logger.warn?.(`linear-agent: webhook rejected (${msg})`);
        res.statusCode = 401;
        res.end("Unauthorized");
        return;
      }
    } else {
      api.logger.warn?.(
        "linear-agent: no linearWebhookSecret configured; accepting without signature check",
      );
    }

    sendJson(res, 202, { ok: true });
    queueMicrotask(() => {
      processEvent(api, cfg, payload, delivery).catch((err) => {
        api.logger.warn?.(
          `linear-agent: handler error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
  };
}

async function processEvent(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  payload: Record<string, unknown>,
  delivery: string | undefined,
): Promise<void> {
  const type = readString(payload.type) ?? "";
  api.logger.info?.(
    `linear-agent: event type=${type} delivery=${delivery ?? "-"}`,
  );

  if (type === "PermissionChange" || type === "OAuthApp") {
    await handlePermissionEvent(api, cfg, payload);
    return;
  }
  if (type === "AppUserNotification") return;
  if (type !== "AgentSessionEvent") return;

  const data = readObject(payload.data) ?? payload;
  const sessionObj = readObject(data.agentSession);
  const sessionId =
    readString(data.agentSessionId) ?? readString(sessionObj?.id) ?? "";
  const issue = readObject(data.issue) ?? readObject(sessionObj?.issue);
  const issueId = readString(issue?.id) ?? "";
  const identifier = readString(issue?.identifier) ?? "";
  const title = readString(issue?.title) ?? "";
  const url = readString(issue?.url) ?? "";
  const description = readString(issue?.description) ?? "";
  const teamId = readString(readObject(issue?.team)?.id) ?? "";
  const action = resolveAction(data, payload);

  const agentActivity = readObject(data.agentActivity);
  const activityContent = readObject(agentActivity?.content);
  const promptContext = readString(data.promptContext) ?? "";
  const prompt =
    readString(agentActivity?.body) ??
    readString(activityContent?.body) ??
    readString(data.prompt) ??
    readString(readObject(data.comment)?.body) ??
    "";
  const signal =
    readString(agentActivity?.signal) ?? readString(data.signal) ?? "";
  const activityActorId =
    readString(readObject(agentActivity?.sourceComment)?.userId) ??
    readString(readObject(data.actor)?.id) ??
    "";

  // Cheap skips first — no token load for events we'll drop.
  if (!action && signal !== "stop") {
    api.logger.info?.("linear-agent: event has no actionable action");
    return;
  }
  if (cfg.strictAddressing && action === "prompted") {
    if (!cfg.mentionHandle) {
      api.logger.warn?.(
        "linear-agent: strict-addressing skip — strictAddressing is on but mentionHandle is not configured",
      );
      return;
    }
    if (!isAddressed(prompt, cfg.mentionHandle)) {
      api.logger.info?.(
        `linear-agent: strict-addressing skip session=${sessionId.slice(0, 8)} (no @${cfg.mentionHandle} mention)`,
      );
      return;
    }
  }

  const tokenPath = resolveTokenPath(cfg.linearTokenStorePath);
  const tokens = await ensureFreshToken(
    api,
    tokenPath,
    cfg.linearClientId,
    cfg.linearClientSecret,
  );
  if (!tokens) {
    api.logger.warn?.(
      "linear-agent: no access token saved — visit /linear-agent/connect to install",
    );
    return;
  }
  const linear = createClient(tokens.accessToken);

  // Skip activities authored by this app (prevents feedback loops).
  if (
    tokens.viewerId &&
    activityActorId &&
    activityActorId === tokens.viewerId
  ) {
    api.logger.info?.("linear-agent: skipping self-authored activity");
    return;
  }

  // Stop signal: acknowledge and halt; no agent run.
  if (signal === "stop") {
    if (sessionId) {
      const target =
        identifier || title ? `${identifier} ${title}`.trim() : "this request";
      await postActivity(linear, sessionId, {
        type: "response",
        body: `Stop received — halting work on ${target}.`,
      }).catch(() => {});
      inflightSessions.delete(sessionId);
    }
    return;
  }

  if (!action) {
    return;
  }

  gcInflight();
  if (sessionId && inflightSessions.has(sessionId)) {
    const elapsed = Date.now() - (inflightSessions.get(sessionId) ?? 0);
    if (action !== "prompted" || elapsed < DEDUP_WINDOW_MS) {
      api.logger.info?.(
        `linear-agent: dedup skip session=${sessionId.slice(0, 8)} action=${action} elapsed=${elapsed}ms`,
      );
      return;
    }
  }
  if (sessionId) inflightSessions.set(sessionId, Date.now());

  // 10-second ack: first thought goes out immediately.
  if (sessionId) {
    postActivity(
      linear,
      sessionId,
      {
        type: "thought",
        body: buildThoughtText(action, identifier, title),
      },
      true,
    ).catch(() => {});
  }

  if (action === "created") {
    applyIssuePolicies(api, cfg, linear, tokens, {
      issueId,
      issue,
      teamId,
    }).catch((err) => {
      api.logger.warn?.(
        `linear-agent: issue policy failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  let history: PastActivitySummary[] = [];
  if (action === "prompted" && sessionId && cfg.historyLimit > 0) {
    history = await fetchSessionActivities(
      linear,
      sessionId,
      cfg.historyLimit,
    ).catch(() => []);
  }

  let call: GatewayCall;
  try {
    call = await loadCallGateway(api);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    api.logger.warn?.(`linear-agent: ${msg}`);
    if (sessionId) {
      await postActivity(linear, sessionId, {
        type: "error",
        body: `Agent run failed: ${msg}`,
      }).catch(() => {});
      inflightSessions.delete(sessionId);
    }
    return;
  }

  const agentId = cfg.agentId ?? "dev";
  const sessionKey = `agent:${agentId}:linear:${sessionId || identifier || "unknown"}`;
  const message = buildMessage({
    action,
    identifier,
    title,
    url,
    description,
    prompt,
    promptContext,
    history,
  });

  const binding: LinearBinding = {
    linearSessionId: sessionId,
    linearIssueId: issueId,
    linearIssueIdentifier: identifier,
    linearTeamId: teamId,
    linear,
    viewerId: tokens.viewerId,
    terminalPosted: false,
    stateIdByType: new Map(),
  };
  if (sessionId) setBinding(sessionKey, binding);

  try {
    const result = await call({
      method: "agent",
      params: {
        message,
        agentId,
        sessionKey,
        label: identifier || title || "linear",
        idempotencyKey: delivery,
      },
      expectFinal: true,
      timeoutMs: AGENT_TIMEOUT_MS,
    });
    if (!binding.terminalPosted && sessionId) {
      const text = extractReply(result);
      const fallback = text
        ? { type: "response" as const, body: text }
        : { type: "error" as const, body: "Agent finished without posting a response. Please retry." };
      if (!text) {
        api.logger.warn?.(
          "linear-agent: agent did not call a terminal tool and no fallback text was extractable",
        );
      }
      await postActivity(linear, sessionId, fallback).catch(() => {});
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    api.logger.warn?.(`linear-agent: agent dispatch failed: ${msg}`);
    if (sessionId && !binding.terminalPosted) {
      await postActivity(linear, sessionId, {
        type: "error",
        body: `Agent run failed: ${msg}`,
      }).catch(() => {});
    }
  } finally {
    deleteBinding(sessionKey);
    if (sessionId) inflightSessions.delete(sessionId);
  }
}

function resolveAction(
  data: Record<string, unknown>,
  payload: Record<string, unknown>,
): "created" | "prompted" | "" {
  const raw = (readString(data.action) ?? readString(payload.action) ?? "")
    .trim()
    .toLowerCase();
  if (raw === "create" || raw === "created") return "created";
  if (raw === "prompt" || raw === "prompted") return "prompted";
  // AgentSessionEvent carrying an agentActivity is a prompted event.
  if (readObject(data.agentActivity)) return "prompted";
  return "";
}

function isAddressed(prompt: string, normalizedHandle: string): boolean {
  return prompt.toLowerCase().includes(`@${normalizedHandle}`);
}

function buildThoughtText(
  action: "created" | "prompted",
  identifier: string,
  title: string,
): string {
  const target =
    identifier || title ? `${identifier} ${title}`.trim() : "Linear issue";
  if (action === "prompted")
    return `Update received on ${target}. Continuing work.`;
  return `On it — ${target}.`;
}

async function handlePermissionEvent(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  const action = (readString(payload.action) ?? "").toLowerCase();
  const tokenPath = resolveTokenPath(cfg.linearTokenStorePath);
  if (action === "revoke" || action === "revoked" || action === "uninstall") {
    await clearTokens(tokenPath);
    api.logger.warn?.(
      `linear-agent: tokens cleared after ${payload.type ?? "permission"} event (action=${action})`,
    );
    return;
  }
  api.logger.info?.(
    `linear-agent: ${payload.type ?? "permission"} event (action=${action || "?"}) — no-op`,
  );
}

async function applyIssuePolicies(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  linear: LinearClient,
  tokens: LinearTokens,
  input: {
    issueId: string;
    issue: Record<string, unknown> | undefined;
    teamId: string;
  },
): Promise<void> {
  const { issueId, issue, teamId } = input;
  if (!issueId) return;

  const patch: { stateId?: string; delegateId?: string } = {};

  if (cfg.startOnCreate) {
    const state = readObject(issue?.state);
    const stateType = (readString(state?.type) ?? "").toLowerCase();
    const terminal =
      stateType === "started" ||
      stateType === "completed" ||
      stateType === "canceled";
    if (!terminal && teamId) {
      const stateId = await fetchStateIdByType(linear, teamId, "started");
      if (stateId) patch.stateId = stateId;
    }
  }

  if (cfg.delegateOnCreate && tokens.viewerId) {
    const existingDelegate = readString(readObject(issue?.delegate)?.id) ?? "";
    if (!existingDelegate) patch.delegateId = tokens.viewerId;
  }

  if (!patch.stateId && !patch.delegateId) return;
  const ok = await updateIssue(linear, issueId, patch);
  if (!ok) {
    api.logger.warn?.(
      `linear-agent: issueUpdate rejected (issue=${issueId.slice(0, 8)})`,
    );
  }
}

function formatHistory(history: PastActivitySummary[]): string {
  if (history.length === 0) return "";
  return history
    .map((a) => `- [${a.type}] ${a.body.slice(0, 500)}`)
    .join("\n");
}

function buildMessage(input: {
  action: "created" | "prompted";
  identifier: string;
  title: string;
  url: string;
  description: string;
  prompt: string;
  promptContext: string;
  history: PastActivitySummary[];
}): string {
  const lines: string[] = [];
  const target = `${input.identifier || "(no id)"} ${input.title || ""}`.trim();
  lines.push(`Linear agent session (${input.action}) — ${target}`);
  if (input.url) lines.push(`URL: ${input.url}`);

  if (input.action === "created") {
    // Linear pre-renders a complete <issue>/<primary-directive-thread>/<guidance>
    // XML in promptContext. Use it verbatim and skip duplicate fields.
    if (input.promptContext) {
      lines.push(`\n${input.promptContext}`);
    } else {
      if (input.description)
        lines.push(`\nIssue description:\n${input.description}`);
      if (input.prompt) lines.push(`\nPrompt:\n${input.prompt}`);
    }
  } else {
    // "prompted": Linear sends only the new user turn — original issue context
    // arrived during "created" and is captured in session history. Don't
    // re-include description or promptContext (the latter isn't sent here).
    const hist = formatHistory(input.history);
    if (hist) lines.push(`\nPrior session activity:\n${hist}`);
    if (input.prompt) lines.push(`\nNew message:\n${input.prompt}`);
  }

  lines.push(
    "\nRespond concisely. Your final message will be posted back to Linear as an agent activity.",
  );
  return lines.join("\n");
}

function extractReply(result: unknown): string {
  const o = readObject(result);
  if (!o) return "";
  const inner = readObject(o.result);
  const payloadsRaw = inner?.payloads;
  if (Array.isArray(payloadsRaw)) {
    const texts: string[] = [];
    for (const p of payloadsRaw) {
      const po = readObject(p);
      if (po && typeof po.text === "string" && po.text.trim()) {
        texts.push(po.text.trimEnd());
      }
    }
    if (texts.length > 0) return texts.join("\n\n");
  }
  if (typeof o.summary === "string" && o.summary.trim()) return o.summary;
  if (typeof o.reply === "string") return o.reply;
  if (typeof o.text === "string") return o.text;
  if (typeof o.message === "string") return o.message;
  if (inner) {
    if (typeof inner.reply === "string") return inner.reply;
    if (typeof inner.text === "string") return inner.text;
  }
  return "";
}
