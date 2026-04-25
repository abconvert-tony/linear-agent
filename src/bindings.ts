import type { LinearClient } from "@linear/sdk";
import type { OpenClawPluginToolContext } from "./types.js";

export type TerminalKind = "response" | "error" | "elicitation";

export interface LinearBinding {
  linearSessionId: string;
  linearIssueId: string;
  linearIssueIdentifier: string;
  linear: LinearClient;
  viewerId?: string;
  /**
   * Set when the agent posts a response/error/elicitation. The webhook's
   * post-call fallback uses this to decide whether to post anything itself.
   */
  terminalPosted: boolean;
}

const bindings = new Map<string, LinearBinding>();

export function setBinding(sessionKey: string, binding: LinearBinding): void {
  bindings.set(sessionKey, binding);
}

export function deleteBinding(sessionKey: string): void {
  bindings.delete(sessionKey);
}

export function getBinding(
  ctx: OpenClawPluginToolContext,
): LinearBinding | undefined {
  return ctx.sessionKey ? bindings.get(ctx.sessionKey) : undefined;
}
