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
   * Top-level comment id to use as `parentId` when posting a threaded reply.
   * Linear only supports one level of threading, so this is resolved from the
   * triggering comment to its thread root at webhook time. Empty for sessions
   * started by issue assignment with no associated comment.
   */
  threadParentId?: string;
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
