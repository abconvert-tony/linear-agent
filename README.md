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
| `linear_post_response`     | `AgentActivityCreateInput { type: "response" }`     | Terminal: the agent's final reply for this turn |
| `linear_post_error`        | `AgentActivityCreateInput { type: "error" }`        | Terminal: surface a failure to the requester |
| `linear_post_elicitation`  | `AgentActivityCreateInput { type: "elicitation" }`  | Terminal: pause and ask the user for more info |
| `linear_attach_external_url` | `AgentSessionUpdateInput.addedExternalUrls` | Attach a PR/preview/dashboard URL; Linear renders it as a session button and tracks downstream updates |

## Setup

### 1. Register a Linear OAuth application

Linear → *Settings* → *API* → *OAuth applications* → *New application*.

- **Redirect URI:** `<public-base>/linear-agent/callback`
- **Webhook URL:** `<public-base>/linear-agent`
- Enable webhooks; subscribe to **Agent session events**
- Copy the client id, client secret, and webhook signing secret

Admin permissions on the workspace are required to install with `actor=app`.

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

Optional config keys: `linearScopes` (default `read,write,app:assignable,app:mentionable`),
`linearTokenStorePath` (default `~/.openclaw/workspace/.pi/linear-agent-tokens.json`),
`historyLimit` (default 20), `startOnCreate`, `delegateOnCreate`.

### 3. Restart the gateway

Look for the load line:

```
linear-agent: routes registered under /linear-agent (connect, callback, webhook); tools: linear_post_{response,error,elicitation}, linear_attach_external_url
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
