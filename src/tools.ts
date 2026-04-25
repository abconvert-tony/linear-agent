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
import { postActivity, updateAgentSession } from "./linear.js";

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
