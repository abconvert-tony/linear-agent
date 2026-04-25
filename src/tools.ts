import type {
  AgentToolResult,
  OpenClawPluginApi,
  PluginAgentTool,
  PluginToolFactory,
} from "./types.js";
import {
  getBinding,
  type LinearBinding,
  type TerminalKind,
} from "./bindings.js";
import {
  createComment,
  fetchStateIdByType,
  postActivity,
  updateAgentSession,
  updateIssue,
  PLAN_STEP_STATUSES,
  WORKFLOW_STATE_TYPES,
  type IssuePatch,
  type PlanStep,
  type PlanStepStatus,
  type WorkflowStateType,
} from "./linear.js";

const BODY_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["body"],
  properties: {
    body: {
      type: "string",
      minLength: 1,
      description:
        "Markdown content to post to the active Linear agent session.",
    },
  },
} as const;

const POST_THOUGHT_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["body"],
  properties: {
    body: {
      type: "string",
      minLength: 1,
      description: "Markdown narration shown in the Linear session UI.",
    },
    ephemeral: {
      type: "boolean",
      description:
        "If true, the thought is removed once another activity is posted. Use for fleeting status (e.g. 'fetching repo state…') that the next activity replaces.",
    },
  },
} as const;

const POST_COMMENT_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["body"],
  properties: {
    body: {
      type: "string",
      minLength: 1,
      description:
        "Markdown body to post as a comment on the issue. Visible to everyone watching the issue, unlike agent activities which only render in the agent session panel.",
    },
    threadUnderSourceComment: {
      type: "boolean",
      default: true,
      description:
        "Thread the new comment under the comment that triggered this turn. Set false to post a top-level comment on the issue instead.",
    },
  },
} as const;

const POST_ACTION_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["action", "parameter"],
  properties: {
    action: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description:
        "Short verb describing what's being done (e.g. 'read_file', 'run_tests', 'open_pr').",
    },
    parameter: {
      type: "string",
      minLength: 1,
      description:
        "Human-readable argument for the action (e.g. a file path, an issue id, a search query). Required by Linear's schema.",
    },
    result: {
      type: "string",
      description:
        "Markdown summary of what the action returned. Omit on the first call to indicate work-in-progress; post a second action activity with the same action+parameter and the filled-in result when the work completes.",
    },
  },
} as const;

const UPDATE_ISSUE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    issueId: {
      type: "string",
      minLength: 1,
      description:
        "Linear issue UUID to update. Defaults to the issue bound to the active session.",
    },
    stateType: {
      type: "string",
      enum: [...WORKFLOW_STATE_TYPES],
      description:
        "Move the issue to the team's first workflow state of this type. Use this when you don't know the explicit stateId.",
    },
    stateId: {
      type: "string",
      minLength: 1,
      description:
        "Explicit workflow state UUID. Wins over stateType when both are set.",
    },
    assigneeId: {
      type: "string",
      minLength: 1,
      description: "Linear user UUID to assign the issue to.",
    },
    delegateId: {
      type: "string",
      minLength: 1,
      description:
        "Linear user UUID to delegate the issue to (typically an agent user).",
    },
    priority: {
      type: "integer",
      minimum: 0,
      maximum: 4,
      description: "0 = no priority, 1 = urgent, 2 = high, 3 = medium, 4 = low.",
    },
    addedLabelIds: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "Label UUIDs to add (does not replace existing labels).",
    },
    removedLabelIds: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "Label UUIDs to remove.",
    },
    title: {
      type: "string",
      minLength: 1,
      description: "Replace the issue title.",
    },
    description: {
      type: "string",
      description: "Replace the issue description (markdown).",
    },
    dueDate: {
      type: ["string", "null"],
      description:
        "TimelessDate in YYYY-MM-DD form. Pass null to clear an existing due date.",
    },
  },
} as const;

const SET_SESSION_PLAN_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["plan"],
  properties: {
    plan: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["content", "status"],
        properties: {
          content: {
            type: "string",
            minLength: 1,
            description: "Markdown step description shown in the Linear plan UI.",
          },
          status: {
            type: "string",
            enum: [...PLAN_STEP_STATUSES],
            description:
              "pending = not started, inProgress = active, completed = done, canceled = abandoned.",
          },
        },
      },
      description:
        "Full plan list — replaces any prior plan in this session. Re-post on each progression.",
    },
  },
} as const;

const ATTACH_EXTERNAL_URL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["label", "url"],
  properties: {
    label: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description:
        "Short button label shown in the Linear session UI (e.g. 'View PR', 'Preview deploy').",
    },
    url: {
      type: "string",
      minLength: 1,
      format: "uri",
      description:
        "Absolute https:// URL to the external resource (PR, deploy, dashboard, doc).",
    },
  },
} as const;

function textResult(text: string): AgentToolResult<{ ok: true }> {
  return { content: [{ type: "text", text }], details: { ok: true } };
}

function readNonEmptyString(
  params: Record<string, unknown>,
  key: string,
): string {
  const v = params[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return v.trim();
}

async function postTerminal(
  binding: LinearBinding,
  type: TerminalKind,
  body: string,
): Promise<void> {
  const ok = await postActivity(binding.linear, binding.linearSessionId, {
    type,
    body,
  });
  if (!ok) {
    throw new Error(`Linear rejected ${type} post for this session.`);
  }
  binding.terminalPosted = true;
}

interface TerminalSpec {
  name: string;
  label: string;
  description: string;
  type: TerminalKind;
  successText: string;
}

const TERMINAL_SPECS: TerminalSpec[] = [
  {
    name: "linear_post_response",
    label: "Linear: post response",
    type: "response",
    description:
      "Post the final response to the active Linear agent session and end this turn. Use exactly once when work for this prompt is complete; the body is shown to the requester as the agent's reply.",
    successText: "Response posted to Linear.",
  },
  {
    name: "linear_post_error",
    label: "Linear: post error",
    type: "error",
    description:
      "Post a terminal error message to the active Linear agent session. Use when the request cannot be completed and you want to surface the failure to the user instead of an opaque silence.",
    successText: "Error posted to Linear.",
  },
  {
    name: "linear_post_elicitation",
    label: "Linear: post elicitation",
    type: "elicitation",
    description:
      "Pause this turn and ask the requester for more information. The session resumes when the user replies; their reply arrives as the next prompted webhook.",
    successText: "Elicitation posted to Linear; awaiting user reply.",
  },
];

function createTerminalTool(spec: TerminalSpec): PluginToolFactory {
  return (ctx): PluginAgentTool | null => {
    const binding = getBinding(ctx);
    if (!binding) return null;
    return {
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: BODY_PARAMETERS,
      execute: async (_toolCallId, params) => {
        await postTerminal(binding, spec.type, readNonEmptyString(params, "body"));
        return textResult(spec.successText);
      },
    };
  };
}

export const terminalToolFactories: { name: string; factory: PluginToolFactory }[] =
  TERMINAL_SPECS.map((spec) => ({
    name: spec.name,
    factory: createTerminalTool(spec),
  }));

export function createPostThoughtTool(
  api: OpenClawPluginApi,
): PluginToolFactory {
  return (ctx): PluginAgentTool | null => {
    const binding = getBinding(ctx);
    if (!binding) return null;
    return {
      name: "linear_post_thought",
      label: "Linear: post thought",
      description:
        "Post a non-terminal narration to the active Linear agent session. Use for mid-run progress updates ('inspecting repo…', 'drafting reply…'). Does not end the turn — finish with linear_post_response/error/elicitation.",
      parameters: POST_THOUGHT_PARAMETERS,
      execute: async (_toolCallId, params) => {
        const body = readNonEmptyString(params, "body");
        const ephemeral = params.ephemeral === true;
        const ok = await postActivity(
          binding.linear,
          binding.linearSessionId,
          { type: "thought", body },
          ephemeral,
        );
        if (!ok) {
          throw new Error("Linear rejected thought post for this session.");
        }
        return textResult(
          ephemeral ? "Ephemeral thought posted." : "Thought posted.",
        );
      },
    };
  };
}

export function createPostCommentTool(
  api: OpenClawPluginApi,
): PluginToolFactory {
  return (ctx): PluginAgentTool | null => {
    const binding = getBinding(ctx);
    if (!binding) return null;
    return {
      name: "linear_post_comment",
      label: "Linear: post comment",
      description:
        "Post a real Linear comment on the bound issue. Use this when the requester needs to see the reply in the issue's comment thread (where they posted the @-mention) — agent activities only render in the agent session panel. By default the comment threads under the comment that triggered this turn; set threadUnderSourceComment=false for a top-level issue comment. Does not end the turn — still finish with linear_post_response/error/elicitation.",
      parameters: POST_COMMENT_PARAMETERS,
      execute: async (_toolCallId, params) => {
        if (!binding.linearIssueId) {
          throw new Error(
            "linear_post_comment: no issue bound to this session.",
          );
        }
        const body = readNonEmptyString(params, "body");
        const threadUnder = params.threadUnderSourceComment !== false;
        if (threadUnder && !binding.threadParentId) {
          throw new Error(
            "linear_post_comment: this session has no source comment to thread under. Pass threadUnderSourceComment=false to post a top-level comment on the issue.",
          );
        }
        const parentId = threadUnder ? binding.threadParentId : undefined;
        const result = await createComment(binding.linear, {
          issueId: binding.linearIssueId,
          parentId,
          body,
        });
        if (!result.ok) {
          throw new Error("Linear rejected the comment post for this issue.");
        }
        const idTail = result.commentId
          ? result.commentId.slice(0, 8)
          : "(no id returned)";
        return textResult(
          parentId
            ? `Comment posted (id=${idTail}) as a reply under parent ${parentId.slice(0, 8)}.`
            : `Top-level comment posted (id=${idTail}) on the issue.`,
        );
      },
    };
  };
}

export function createPostActionTool(
  api: OpenClawPluginApi,
): PluginToolFactory {
  return (ctx): PluginAgentTool | null => {
    const binding = getBinding(ctx);
    if (!binding) return null;
    return {
      name: "linear_post_action",
      label: "Linear: post action",
      description:
        "Post a non-terminal action activity describing a tool/operation the agent is performing. Linear renders this as a structured 'action' card with action+parameter+result. Call without `result` to announce work-in-progress, then call again with the same action+parameter and a filled-in `result` when complete.",
      parameters: POST_ACTION_PARAMETERS,
      execute: async (_toolCallId, params) => {
        const action = readNonEmptyString(params, "action");
        const parameter = readNonEmptyString(params, "parameter");
        const result =
          typeof params.result === "string" && params.result.trim().length > 0
            ? params.result
            : undefined;
        const ok = await postActivity(binding.linear, binding.linearSessionId, {
          type: "action",
          action,
          parameter,
          result,
        });
        if (!ok) {
          throw new Error("Linear rejected action post for this session.");
        }
        return textResult(
          result ? `Action posted: ${action} → result.` : `Action posted: ${action} (in progress).`,
        );
      },
    };
  };
}

function readOptionalString(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = params[key];
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringArray(
  params: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const v = params[key];
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string" && item.trim().length > 0) {
      out.push(item.trim());
    }
  }
  return out.length > 0 ? out : undefined;
}

async function resolveStateId(
  binding: LinearBinding,
  params: Record<string, unknown>,
): Promise<string | undefined> {
  const explicit = readOptionalString(params, "stateId");
  if (explicit) return explicit;

  const raw = readOptionalString(params, "stateType");
  if (!raw) return undefined;
  if (!WORKFLOW_STATE_TYPES.includes(raw as WorkflowStateType)) {
    throw new Error(
      `stateType must be one of ${WORKFLOW_STATE_TYPES.join(", ")}.`,
    );
  }
  const stateType = raw as WorkflowStateType;

  const cached = binding.stateIdByType.get(stateType);
  if (cached) return cached;

  if (!binding.linearTeamId) {
    throw new Error(
      "stateType cannot be resolved: no team id is bound to this session.",
    );
  }
  const resolved = await fetchStateIdByType(
    binding.linear,
    binding.linearTeamId,
    stateType,
  );
  if (!resolved) {
    throw new Error(`No '${stateType}' workflow state exists for this team.`);
  }
  binding.stateIdByType.set(stateType, resolved);
  return resolved;
}

export function createUpdateIssueTool(
  api: OpenClawPluginApi,
): PluginToolFactory {
  return (ctx): PluginAgentTool | null => {
    const binding = getBinding(ctx);
    if (!binding) return null;
    return {
      name: "linear_update_issue",
      label: "Linear: update issue",
      description:
        "Update fields on a Linear issue (state, assignee, delegate, priority, labels, title, description, due date). Defaults to the issue bound to this session when issueId is omitted. Pass `stateType` (e.g. 'started', 'completed') to move the issue without knowing the explicit state UUID.",
      parameters: UPDATE_ISSUE_PARAMETERS,
      execute: async (_toolCallId, params) => {
        const issueId =
          readOptionalString(params, "issueId") ?? binding.linearIssueId;
        if (!issueId) {
          throw new Error(
            "issueId is required (no issue is bound to this session).",
          );
        }

        const patch: IssuePatch = {};
        const stateId = await resolveStateId(binding, params);
        if (stateId) patch.stateId = stateId;

        const assigneeId = readOptionalString(params, "assigneeId");
        if (assigneeId) patch.assigneeId = assigneeId;
        const delegateId = readOptionalString(params, "delegateId");
        if (delegateId) patch.delegateId = delegateId;
        if (typeof params.priority === "number") {
          patch.priority = params.priority;
        }
        const added = readStringArray(params, "addedLabelIds");
        if (added) patch.addedLabelIds = added;
        const removed = readStringArray(params, "removedLabelIds");
        if (removed) patch.removedLabelIds = removed;
        const title = readOptionalString(params, "title");
        if (title) patch.title = title;
        if (typeof params.description === "string") {
          patch.description = params.description;
        }
        if (params.dueDate === null) {
          patch.dueDate = null;
        } else {
          const dueDate = readOptionalString(params, "dueDate");
          if (dueDate) patch.dueDate = dueDate;
        }

        const ok = await updateIssue(binding.linear, issueId, patch);
        if (!ok) {
          throw new Error(
            "Linear rejected the issue update (or no fields were changed).",
          );
        }
        return textResult(`Issue ${issueId} updated.`);
      },
    };
  };
}

export function createSetSessionPlanTool(
  api: OpenClawPluginApi,
): PluginToolFactory {
  return (ctx): PluginAgentTool | null => {
    const binding = getBinding(ctx);
    if (!binding) return null;
    return {
      name: "linear_set_session_plan",
      label: "Linear: set session plan",
      description:
        "Set the agent's execution plan for the active Linear session. Linear renders the plan as a checklist in the session UI. The whole plan is replaced on each call — re-post the full list with updated statuses as work progresses.",
      parameters: SET_SESSION_PLAN_PARAMETERS,
      execute: async (_toolCallId, params) => {
        if (!Array.isArray(params.plan) || params.plan.length === 0) {
          throw new Error("plan must be a non-empty array");
        }
        const plan: PlanStep[] = params.plan.map((raw, i) => {
          if (!raw || typeof raw !== "object") {
            throw new Error(`plan[${i}] must be an object`);
          }
          const step = raw as Record<string, unknown>;
          const content = readOptionalString(step, "content");
          if (!content) {
            throw new Error(`plan[${i}].content is required`);
          }
          const status = readOptionalString(step, "status") as
            | PlanStepStatus
            | undefined;
          if (!status || !PLAN_STEP_STATUSES.includes(status)) {
            throw new Error(
              `plan[${i}].status must be one of ${PLAN_STEP_STATUSES.join(", ")}`,
            );
          }
          return { content, status };
        });
        const ok = await updateAgentSession(
          binding.linear,
          binding.linearSessionId,
          { plan },
        );
        if (!ok) {
          throw new Error("Linear rejected the session plan update.");
        }
        return textResult(`Plan posted (${plan.length} step${plan.length === 1 ? "" : "s"}).`);
      },
    };
  };
}

export function createAttachExternalUrlTool(
  api: OpenClawPluginApi,
): PluginToolFactory {
  return (ctx): PluginAgentTool | null => {
    const binding = getBinding(ctx);
    if (!binding) return null;
    return {
      name: "linear_attach_external_url",
      label: "Linear: attach external URL",
      description:
        "Attach an external URL (e.g. a pull request, preview deployment, dashboard) to the active Linear agent session. Linear renders this as a button in the session UI and uses it to surface future updates (PR review state, build status). Call additively as you produce artifacts; existing URLs are preserved.",
      parameters: ATTACH_EXTERNAL_URL_PARAMETERS,
      execute: async (_toolCallId, params) => {
        const label = readNonEmptyString(params, "label");
        const url = readNonEmptyString(params, "url");
        const ok = await updateAgentSession(
          binding.linear,
          binding.linearSessionId,
          { addedExternalUrls: [{ label, url }] },
        );
        if (!ok) {
          api.logger.warn?.(
            `linear-agent: agentSessionUpdate(addedExternalUrls) returned success=false (session=${binding.linearSessionId.slice(0, 8)})`,
          );
          throw new Error("Linear rejected the external URL update.");
        }
        return textResult(`Attached ${label} → ${url}`);
      },
    };
  };
}
