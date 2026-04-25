# linear-agent

OpenClaw plugin that bridges a Linear OAuth app to a local OpenClaw agent.
Receives `AgentSessionEvent` webhooks, dispatches the prompt to a configured
OpenClaw agent, and exposes a small set of `registerTool` factories so the
agent drives the Linear session lifecycle directly (final reply, error,
elicitation, external URL attachment).

## Routes

The plugin registers three HTTP routes under `/linear-agent` on your local
gateway. Externally they sit behind whatever ingress you use (Tailscale Funnel,
Cloudflare Tunnel, ngrok, raw reverse proxy, etc.); we'll call that base URL
`<public-base>` below.

| Method | Path                                | Purpose                                       |
|--------|-------------------------------------|-----------------------------------------------|
| GET    | `<public-base>/linear-agent/connect`  | Kick off Linear OAuth (`actor=app`)           |
| GET    | `<public-base>/linear-agent/callback` | Exchange code for tokens, persist to disk     |
| POST   | `<public-base>/linear-agent`          | `AgentSessionEvent` receiver (HMAC verified)  |

If your ingress strips a path prefix before forwarding to the gateway (e.g. a
shared host that namespaces users with `/<user>/*`), the public URL becomes
`<public-base>/<your-prefix>/linear-agent/...`. The plugin itself only sees
`/linear-agent/...`.

## Agent-callable tools

Registered via `api.registerTool`. They auto-appear only on agent runs that
originated from a Linear webhook (i.e. when a Linear session is bound to the
active `sessionKey`).

| Tool | Maps to | Use |
|------|---------|-----|
| `linear_post_thought`      | `AgentActivityCreateInput { type: "thought" }`      | Non-terminal: mid-run narration. Set `ephemeral: true` for fleeting status that the next activity replaces |
| `linear_post_action`       | `AgentActivityActionContent { action, parameter, result? }` | Non-terminal: structured "action" card. Post once without `result` to announce work-in-progress, then again with the same `action`+`parameter` and a filled-in `result` when done |
| `linear_post_response`     | `AgentActivityCreateInput { type: "response" }`     | Terminal: the agent's final reply for this turn |
| `linear_post_error`        | `AgentActivityCreateInput { type: "error" }`        | Terminal: surface a failure to the requester |
| `linear_post_elicitation`  | `AgentActivityCreateInput { type: "elicitation" }`  | Terminal: pause and ask the user for more info |
| `linear_update_issue`      | `IssueUpdateInput` (subset)                         | Update state, assignee/delegate, priority, labels, title/description, due date. `stateType` resolves to a stateId via the team's workflow states; `issueId` defaults to the bound issue |
| `linear_set_session_plan`  | `AgentSessionUpdateInput.plan`                      | Replace the agent's plan checklist for this session; each step has `content` and `status: pending\|inProgress\|completed\|canceled` |
| `linear_attach_external_url` | `AgentSessionUpdateInput.addedExternalUrls`       | Attach a PR/preview/dashboard URL; Linear renders it as a session button and tracks downstream updates |

## Prerequisites

- A running OpenClaw gateway (see the [OpenClaw docs](https://docs.openclaw.ai))
  with an agent in `agents.list[]` ready to handle Linear events.
- A public ingress for that gateway (Tailscale Funnel, Cloudflare Tunnel, ngrok,
  reverse proxy, etc.) — Linear webhooks and the OAuth callback both need a
  reachable URL.

## Setup

### 1. Register a Linear OAuth application

Linear → *Settings* → *API* → *OAuth applications* → *New application*.

- **Redirect URI:** `<public-base>/linear-agent/callback`
- **Webhook URL:** `<public-base>/linear-agent`
- Enable webhooks; subscribe to **Agent session events**
- **Allowed scopes:** must be a superset of whatever you set in
  `linearScopes` later. The default `linearScopes` is
  `read,write,app:assignable,app:mentionable`; if the Linear app isn't
  configured with `app:assignable` and `app:mentionable`, OAuth silently
  grants fewer scopes and `delegateOnCreate` later fails.
- Copy the client id, client secret, and webhook signing secret

Admin permissions on the workspace are required to install with `actor=app`.

If your ingress strips a path prefix (e.g. shared host with `/<user>/*`), the
**Redirect URI** registered above, the `linearRedirectUri` config in step 2,
and the **Webhook URL** must all include that prefix
(`<public-base>/<your-prefix>/linear-agent/...`). The plugin itself only sees
`/linear-agent/...` after the prefix is stripped.

### 2. Configure the plugin

Edit `~/.openclaw/openclaw.json` and set `plugins.entries.linear-agent.config`:

```json
{
  "plugins": {
    "allow": ["linear-agent"],
    "entries": {
      "linear-agent": {
        "enabled": true,
        "config": {
          "agentId": "dev",
          "linearClientId": "${LINEAR_CLIENT_ID}",
          "linearClientSecret": "${LINEAR_CLIENT_SECRET}",
          "linearWebhookSecret": "${LINEAR_WEBHOOK_SECRET}",
          "linearRedirectUri": "<public-base>/linear-agent/callback"
        }
      }
    }
  }
}
```

`${ENV_VAR}` interpolation is supported — keep secrets in `~/.openclaw/.env`
rather than the JSON.

The `agentId` here must match the `id` of an entry in `agents.list[]` — that's
the OpenClaw agent the plugin will dispatch Linear events to. Step 2b uses the
same id.

Optional config keys: `linearScopes` (default `read,write,app:assignable,app:mentionable`),
`linearTokenStorePath` (default `~/.openclaw/workspace/.pi/linear-agent-tokens.json`),
`historyLimit` (default 20), `startOnCreate`, `delegateOnCreate`,
`strictAddressing` + `mentionHandle` (only run prompted events that explicitly
@-mention the agent; useful when humans and the agent share an issue thread).

### 2b. Allow the plugin's tools on the bound agent

Plugin-registered tools are gated by the gateway's tool policy. The configured
agent (`agentId`) must have `group:plugins` in its allowlist, otherwise the
`linear_*` tools are filtered out before the model sees them and the run will
fall back to the plain-text reply path.

The simplest setup — a single `alsoAllow` on the agent and no global
`tools.allow` filter:

```json
{
  "tools": { "profile": "full" },
  "agents": {
    "list": [
      {
        "id": "dev",
        "tools": { "alsoAllow": ["exec", "group:plugins"] }
      }
    ]
  }
}
```

Gotcha: a global `tools.allow: ["exec"]` (or any other narrow list) acts as an
AND filter applied *before* the agent step, so it strips plugin tools even if
the agent's `alsoAllow` includes `group:plugins`. Either drop the global
`tools.allow` (as above) or extend it to `["exec", "group:plugins"]`.

### 3. Restart the gateway

Look for the load line:

```
linear-agent: routes registered under /linear-agent (connect, callback, webhook); tools: linear_post_{thought,action,response,error,elicitation}, linear_update_issue, linear_set_session_plan, linear_attach_external_url
```

### 4. Install the agent into your Linear workspace

Open `<public-base>/linear-agent/connect` in a browser. Approve in Linear.
Tokens write to the configured store path (`0600`). You'll see
*"Linear agent installed. You can close this tab."*

### 5. Try it

Mention or delegate to the agent in a Linear issue. Expected sequence:

1. Webhook POST arrives with `linear-signature`; HMAC-SHA256 verified against
   `linearWebhookSecret`. Stale or unsigned payloads are rejected.
2. Plugin posts a quick `thought` activity (latency ack).
3. The configured OpenClaw agent runs with the issue + prompt + recent session
   activities as its message.
4. The agent calls one of the `linear_post_*` tools as its terminal step;
   that becomes the visible reply. If it produced a PR, it should also call
   `linear_attach_external_url` first.
5. If the agent ends without calling a terminal tool, the plugin falls back
   to extracting reply text and posting it as a `response`, or posts a generic
   error if nothing is extractable.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Webhook returns `401` | Wrong or missing `linearWebhookSecret`; the value must match the signing secret on the Linear app. |
| Webhook never fires | The Linear app isn't subscribed to **Agent session events**, or the public webhook URL doesn't reach the gateway. |
| Agent runs but `linear_*` tools aren't callable | The bound agent's tool policy is filtering them out. See step 2b — `group:plugins` must be in the agent's allowlist, and any narrow global `tools.allow` will AND-filter plugin tools out before the agent step. |
| `delegateOnCreate` / scope-related errors | The Linear app's allowed scopes don't include what you requested via `linearScopes`. Add `app:assignable` and `app:mentionable` to the app and re-install. |
| OAuth refresh fails / tokens disappear | A `PermissionChange` or `OAuthApp` revoke/uninstall event arrived; the plugin clears the token store on those. Re-run `<public-base>/linear-agent/connect`. |
| Replies arrive as plain text instead of structured activities | The agent didn't call a terminal `linear_post_*` tool, so the plugin fell back to extracting reply text. Usually means the tools weren't visible — see the policy row above. |

## Sharing this plugin with teammates

The plugin works as a stand-alone OpenClaw extension. Two distribution paths:

### A. Git clone + local install

```bash
# Teammate
git clone <this-repo-url> linear-agent
cd linear-agent
npm install && npm run build
openclaw plugins install ./linear-agent       # copy
# or, for live edits during development:
openclaw plugins install -l ./linear-agent    # symlink
```

### B. npm

`prepublishOnly` already runs the build. Publish with `npm publish`, then:

```bash
openclaw plugins install <package-name>          # latest
openclaw plugins install <package-name> --pin    # record exact resolved version
```

What does **not** travel with the code (each teammate sets up themselves):

- Their own Linear OAuth app (or a shared one) and the three secrets.
- Their own public ingress (`<public-base>` above) — Linear webhooks need a
  reachable URL.
- The OAuth redirect and webhook URLs registered on the Linear app must match
  their public ingress.

## Local development

```bash
npm install
npm run build
openclaw plugins install -l .   # link this directory
# edit, then: npm run build && restart the gateway
```

## Token store

OAuth tokens persist at `~/.openclaw/workspace/.pi/linear-agent-tokens.json`
(override via `linearTokenStorePath`). On `PermissionChange`/`OAuthApp` revoke
or uninstall events the file is cleared automatically.
