import type { OpenClawPluginApi } from "./src/types.js";
import { readConfig } from "./src/types.js";
import {
  createCallbackHandler,
  createConnectHandler,
} from "./src/oauth.js";
import { createWebhookHandler, ensureFreshToken } from "./src/webhook.js";
import { resolveTokenPath } from "./src/tokens.js";
import {
  createAttachExternalUrlTool,
  createPostActionTool,
  createPostCommentTool,
  createPostThoughtTool,
  createSetSessionPlanTool,
  createUpdateIssueTool,
  terminalToolFactories,
} from "./src/tools.js";

const BASE_PATH = "/linear-agent";
const BACKGROUND_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const BACKGROUND_REFRESH_WINDOW_MS = 10 * 60 * 1000;

export default function register(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: `${BASE_PATH}/connect`,
    auth: "plugin",
    handler: createConnectHandler(api),
  });
  api.registerHttpRoute({
    path: `${BASE_PATH}/callback`,
    auth: "plugin",
    handler: createCallbackHandler(api),
  });
  api.registerHttpRoute({
    path: BASE_PATH,
    auth: "plugin",
    handler: createWebhookHandler(api),
  });

  for (const { name, factory } of terminalToolFactories) {
    api.registerTool(factory, { name });
  }
  api.registerTool(createPostThoughtTool(api), {
    name: "linear_post_thought",
  });
  api.registerTool(createPostActionTool(api), {
    name: "linear_post_action",
  });
  api.registerTool(createPostCommentTool(api), {
    name: "linear_post_comment",
  });
  api.registerTool(createUpdateIssueTool(api), {
    name: "linear_update_issue",
  });
  api.registerTool(createSetSessionPlanTool(api), {
    name: "linear_set_session_plan",
  });
  api.registerTool(createAttachExternalUrlTool(api), {
    name: "linear_attach_external_url",
  });

  startBackgroundRefresh(api);

  api.logger.info?.(
    `linear-agent: routes registered under ${BASE_PATH} (connect, callback, webhook); tools: linear_post_{thought,action,comment,response,error,elicitation}, linear_update_issue, linear_set_session_plan, linear_attach_external_url`,
  );
}

function startBackgroundRefresh(api: OpenClawPluginApi): void {
  const tick = async (): Promise<void> => {
    const cfg = readConfig(api.pluginConfig);
    if (!cfg.linearClientId || !cfg.linearClientSecret) return;
    const tokenPath = resolveTokenPath(cfg.linearTokenStorePath);
    const before = Date.now();
    const t = await ensureFreshToken(
      api,
      tokenPath,
      cfg.linearClientId,
      cfg.linearClientSecret,
      BACKGROUND_REFRESH_WINDOW_MS,
    );
    if (t?.updatedAt && t.updatedAt >= before) {
      api.logger.info?.(
        `linear-agent: background refresh ok (expiresAt=${t.expiresAt ? new Date(t.expiresAt).toISOString() : "unknown"})`,
      );
    }
  };
  const onError = (err: unknown): void => {
    api.logger.warn?.(
      `linear-agent: background refresh tick failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  };
  tick().catch(onError);
  const timer = setInterval(() => {
    tick().catch(onError);
  }, BACKGROUND_REFRESH_INTERVAL_MS);
  timer.unref?.();
}
