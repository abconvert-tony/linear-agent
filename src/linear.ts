import { LinearClient } from "@linear/sdk";

const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

export { LinearClient };

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export function createClient(accessToken: string): LinearClient {
  return new LinearClient({ accessToken });
}

export async function exchangeCode(input: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
  const r = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(
      `Token exchange failed (${r.status}): ${text.slice(0, 300)}`,
    );
  }
  return (await r.json()) as TokenResponse;
}

export async function refreshTokens(input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
  const r = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(
      `Token refresh failed (${r.status}): ${text.slice(0, 300)}`,
    );
  }
  return (await r.json()) as TokenResponse;
}

export interface ViewerInfo {
  viewerId: string;
  workspaceId: string;
  workspaceUrlKey: string;
}

export async function fetchViewer(
  client: LinearClient,
): Promise<ViewerInfo | undefined> {
  const [viewer, org] = await Promise.all([client.viewer, client.organization]);
  if (!viewer?.id || !org?.id) return undefined;
  return {
    viewerId: viewer.id,
    workspaceId: org.id,
    workspaceUrlKey: org.urlKey ?? "",
  };
}

export async function fetchStartedStateId(
  client: LinearClient,
  teamId: string,
): Promise<string | undefined> {
  if (!teamId) return undefined;
  const states = await client.workflowStates({
    filter: {
      team: { id: { eq: teamId } },
      type: { eq: "started" },
    },
  });
  const nodes = states.nodes ?? [];
  if (nodes.length === 0) return undefined;
  const sorted = [...nodes].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0),
  );
  return sorted[0]?.id;
}

export interface IssuePatch {
  stateId?: string;
  delegateId?: string;
}

export async function updateIssue(
  client: LinearClient,
  issueId: string,
  input: IssuePatch,
): Promise<boolean> {
  if (!issueId || (!input.stateId && !input.delegateId)) return false;
  const payload = await client.updateIssue(issueId, input);
  return payload.success === true;
}

export type ActivityContent =
  | { type: "thought"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string }
  | { type: "elicitation"; body: string }
  | { type: "action"; action: string; parameter?: string; result?: string };

export async function postActivity(
  client: LinearClient,
  sessionId: string,
  content: ActivityContent,
  ephemeral?: boolean,
): Promise<boolean> {
  const input: Record<string, unknown> = {
    agentSessionId: sessionId,
    content,
  };
  if (ephemeral) input.ephemeral = true;
  const payload = await client.createAgentActivity(
    input as Parameters<LinearClient["createAgentActivity"]>[0],
  );
  return payload.success === true;
}

export interface ExternalUrlInput {
  label: string;
  url: string;
}

export interface AgentSessionPatch {
  addedExternalUrls?: ExternalUrlInput[];
  removedExternalUrls?: string[];
}

export async function updateAgentSession(
  client: LinearClient,
  sessionId: string,
  input: AgentSessionPatch,
): Promise<boolean> {
  if (
    !sessionId ||
    (!input.addedExternalUrls?.length && !input.removedExternalUrls?.length)
  ) {
    return false;
  }
  const payload = await client.updateAgentSession(
    sessionId,
    input as Parameters<LinearClient["updateAgentSession"]>[1],
  );
  return payload.success === true;
}

export interface PastActivitySummary {
  type: string;
  body: string;
}

export async function fetchSessionActivities(
  client: LinearClient,
  sessionId: string,
  first: number,
): Promise<PastActivitySummary[]> {
  if (!sessionId || first <= 0) return [];
  const session = await client.agentSession(sessionId);
  const conn = await session.activities({ first });
  const out: PastActivitySummary[] = [];
  for (const a of conn.nodes ?? []) {
    const c = a.content as Record<string, unknown> | undefined;
    if (!c) continue;
    const typename = (c.__typename as string | undefined) ?? "";
    const type = typename.replace(/^AgentActivity/, "").replace(/Content$/, "").toLowerCase();
    const body =
      (typeof c.body === "string" && c.body) ||
      (typeof c.result === "string" && c.result) ||
      (typeof c.action === "string" && c.action) ||
      "";
    if (!type || !body) continue;
    out.push({ type, body });
  }
  return out;
}
