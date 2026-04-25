import type { LinearClient } from "@linear/sdk";
import type { OpenClawPluginToolContext } from "./types.js";
import type { WorkflowStateType } from "./linear.js";

export type TerminalKind = "response" | "error" | "elicitation";

export interface LinearBinding {
  linearSessionId: string;
  linearIssueId: string;
  linearIssueIdentifier: string;
  /** Linear team owning this issue. Used to resolve workflow state names. */
  linearTeamId: string;
  linear: LinearClient;
  viewerId?: string;
  /**
   * Set when the agent posts a response/error/elicitation. The webhook's
   * post-call fallback uses this to decide whether to post anything itself.
   */
  terminalPosted: boolean;
  /** Lazily filled by linear_update_issue when stateType is resolved. */
  stateIdByType: Map<WorkflowStateType, string>;
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
