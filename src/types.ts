import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Trusted runtime context handed to a plugin tool factory by the gateway.
 * sessionKey is the binding lookup key written by the webhook handler.
 * Mirrors the `OpenClawPluginToolContext` shape from openclaw's plugin SDK.
 */
export interface OpenClawPluginToolContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  agentDir?: string;
  workspaceDir?: string;
  messageChannel?: string;
}

export type ToolParameterSchema = Record<string, unknown>;

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface AgentToolResult<TDetails = unknown> {
  content: ToolTextContent[];
  details: TDetails;
  terminate?: boolean;
}

/**
 * Minimal cross-section of the SDK's AgentTool needed at runtime.
 * Avoids depending on @mariozechner/pi-agent-core / typebox.
 */
export interface PluginAgentTool {
  name: string;
  label: string;
  description: string;
  parameters: ToolParameterSchema;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<AgentToolResult>;
}

export type PluginToolFactory = (
  ctx: OpenClawPluginToolContext,
) => PluginAgentTool | PluginAgentTool[] | null | undefined;

export interface OpenClawPluginApi {
  pluginConfig?: Record<string, unknown>;
  config?: { gateway?: { auth?: { token?: string; password?: string } } };
  logger: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  callGateway?: (opts: Record<string, unknown>) => Promise<unknown>;
  registerHttpRoute: (opts: {
    path: string;
    auth: "plugin" | "gateway";
    match?: "exact" | "prefix";
    replaceExisting?: boolean;
    handler: (
      req: IncomingMessage,
      res: ServerResponse,
    ) => void | Promise<void>;
  }) => void;
  registerTool: (
    tool: PluginAgentTool | PluginToolFactory,
    opts?: { name?: string; names?: string[]; optional?: boolean },
  ) => void;
}

export interface PluginConfig {
  agentId?: string;
  linearClientId?: string;
  linearClientSecret?: string;
  linearRedirectUri?: string;
  linearWebhookSecret?: string;
  linearScopes?: string;
  linearTokenStorePath?: string;
  startOnCreate: boolean;
  delegateOnCreate: boolean;
  historyLimit: number;
  strictAddressing: boolean;
  mentionHandle?: string;
}

export function readConfig(pluginConfig?: Record<string, unknown>): PluginConfig {
  const c = pluginConfig ?? {};
  const s = (k: string): string | undefined => {
    const v = c[k];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const b = (k: string, dflt: boolean): boolean => {
    const v = c[k];
    return typeof v === "boolean" ? v : dflt;
  };
  const n = (k: string, dflt: number): number => {
    const v = c[k];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : dflt;
  };
  return {
    agentId: s("agentId"),
    linearClientId: s("linearClientId"),
    linearClientSecret: s("linearClientSecret"),
    linearRedirectUri: s("linearRedirectUri"),
    linearWebhookSecret: s("linearWebhookSecret"),
    linearScopes: s("linearScopes"),
    linearTokenStorePath: s("linearTokenStorePath"),
    startOnCreate: b("startOnCreate", true),
    delegateOnCreate: b("delegateOnCreate", true),
    historyLimit: n("historyLimit", 20),
    strictAddressing: b("strictAddressing", false),
    mentionHandle: s("mentionHandle"),
  };
}
