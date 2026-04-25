# linear-agent

Minimal OpenClaw plugin that turns your local gateway into a Linear agent. Installed today at
`~/.openclaw/extensions/linear-agent` from this source.

Routes registered under `/tony/webhook/linear`:

| Method | Path                              | Purpose                                         |
|--------|-----------------------------------|-------------------------------------------------|
| GET    | `/tony/webhook/linear/connect`    | Kick off OAuth (`actor=app`)                    |
| GET    | `/tony/webhook/linear/callback`   | Exchange code for tokens, persist to disk       |
| POST   | `/tony/webhook/linear`            | `AgentSessionEvent` receiver (HMAC verified)    |

Public URL (Tailscale funnel): `https://abconvert-spark.tailc2b7f2.ts.net/tony/webhook/linear`.

## Setup

### 1. Register a Linear OAuth application

Linear → Settings → API → OAuth applications → *New application*.

- Redirect URI: `https://abconvert-spark.tailc2b7f2.ts.net/tony/webhook/linear/callback`
- Webhook URL: `https://abconvert-spark.tailc2b7f2.ts.net/tony/webhook/linear`
- Enable webhooks, subscribe to *Agent session events*
- Copy the client id, client secret, and webhook signing secret

Admin permissions on the workspace are required to install with `actor=app`.

### 2. Configure the plugin

Edit `~/.openclaw/openclaw.json` and set `plugins.entries.linear-agent.config`:

```json
{
  "plugins": {
    "entries": {
      "linear-agent": {
        "enabled": true,
        "config": {
          "agentId": "dev",
          "linearClientId": "<from Linear>",
          "linearClientSecret": "<from Linear>",
          "linearWebhookSecret": "<from Linear>",
          "linearRedirectUri": "https://abconvert-spark.tailc2b7f2.ts.net/tony/webhook/linear/callback"
        }
      }
    }
  }
}
```

Optional keys: `linearScopes` (defaults to `read,write,app:assignable,app:mentionable`),
`linearTokenStorePath` (defaults to `~/.openclaw/workspace/.pi/linear-agent-tokens.json`).

OpenClaw supports `${ENV_VAR}` interpolation in config — use it for the secrets if you'd rather
keep them in `~/.openclaw/.env`.

### 3. Restart the gateway

```
./start-gateway.sh   # or however you boot it
```

Confirm routes load (look for `linear-agent: routes registered under /tony/webhook/linear`).

### 4. Install the agent into your Linear workspace

Open `http://localhost:12000/tony/webhook/linear/connect` (or the public URL) in a browser.
Approve in Linear. On success the tokens are written to the token-store path (0600) and you'll
see `Linear agent installed. You can close this tab.`

### 5. Try it

Mention or delegate to the agent in a Linear issue. You should see:

1. Webhook POST with `linear-signature` arrives (HMAC-SHA256 verified against
   `linearWebhookSecret`; stale payloads are rejected by signature mismatch).
2. An immediate `thought` activity (`on it — <IDENT>: <title>`) posted back via GraphQL.
3. The OpenClaw agent runs with the issue context as its prompt.
4. On completion, the agent's reply is posted back as a `response` activity.

## Local development

```
npm install
npm run build
openclaw plugins install .   # first time; then edits need `npm run build` + gateway restart
```

## Notes / known gaps

- This is intentionally minimal. For richer agent-side capabilities (issue create/update,
  delegation, proactive sessions, plan steps) see the earlier, much larger `linear-agent-bridge`
  plugin that was uninstalled from this machine — its install dir may still linger at
  `~/.openclaw/extensions/linear-agent-bridge/` and should be removed manually.
- No first-class `registerTool` API on this version of the OpenClaw plugin SDK — agents act on
  Linear by having the plugin read their final reply and post it as an activity. If you later
  want the agent to call Linear mid-turn, register an authenticated HTTP sub-route and teach the
  agent to `curl` it (that's what the old bridge did for `create_issue` etc.).
- `plugins.allow` is empty on this machine; OpenClaw warns about auto-discovered plugins. Add
  `"allow": ["linear-agent"]` under `plugins` in `openclaw.json` to pin trust.
