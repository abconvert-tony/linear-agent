import type { OpenClawPluginApi } from "./src/types.js";
import {
  createCallbackHandler,
  createConnectHandler,
} from "./src/oauth.js";
import { createWebhookHandler } from "./src/webhook.js";
import {
  createAttachExternalUrlTool,
  createPostActionTool,
  createPostThoughtTool,
  terminalToolFactories,
} from "./src/tools.js";

const BASE_PATH = "/linear-agent";

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
    api.registerTool(factory, { name, optional: true });
  }
  api.registerTool(createPostThoughtTool(api), {
    name: "linear_post_thought",
    optional: true,
  });
  api.registerTool(createPostActionTool(api), {
    name: "linear_post_action",
    optional: true,
  });
  api.registerTool(createAttachExternalUrlTool(api), {
    name: "linear_attach_external_url",
    optional: true,
  });

  api.logger.info?.(
    `linear-agent: routes registered under ${BASE_PATH} (connect, callback, webhook); tools: linear_post_{thought,action,response,error,elicitation}, linear_attach_external_url`,
  );
}
