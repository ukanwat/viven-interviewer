// A small MCP client for remote servers (Streamable HTTP + OAuth 2.1 with dynamic client
// registration and PKCE), enough to let a person connect a tool they use and let an agent read it.

export const PRESETS: { id: string; label: string; url: string; what: string }[] = [
  { id: 'notion', label: 'Notion', url: 'https://mcp.notion.com/mcp', what: 'pages and notes' },
  { id: 'granola', label: 'Granola', url: 'https://mcp.granola.ai/mcp', what: 'meeting notes' },
  { id: 'linear', label: 'Linear', url: 'https://mcp.linear.app/mcp', what: 'projects and issues' },
  { id: 'atlassian', label: 'Jira & Confluence', url: 'https://mcp.atlassian.com/v1/mcp', what: 'tickets and docs' },
  { id: 'clickup', label: 'ClickUp', url: 'https://mcp.clickup.com/mcp', what: 'tasks and docs' },
  { id: 'airtable', label: 'Airtable', url: 'https://mcp.airtable.com/mcp', what: 'bases' },
];

export type Tokens = { access: string; refresh?: string; expiresAt?: number };
export type OAuthClient = { tokenEndpoint: string; clientId: string; clientSecret?: string; resource: string };

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

// Public https servers only: the URL may come from the person.
export function serverUrl(raw: string): URL | undefined {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' || !u.hostname.includes('.') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/i.test(u.hostname)) return undefined;
    return u;
  } catch {
    return undefined;
  }
}

async function getJson(url: string) {
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  return r.ok ? ((await r.json()) as any) : undefined;
}

// Find the authorization server for an MCP server URL (RFC 9728, then RFC 8414).
async function discover(server: URL) {
  let metaUrl: string | undefined;
  const probe = await fetch(server, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => undefined);
  metaUrl = probe?.headers.get('www-authenticate')?.match(/resource_metadata="([^"]+)"/)?.[1];
  const path = server.pathname.replace(/\/$/, '');
  const prm =
    (metaUrl && (await getJson(metaUrl))) ??
    (await getJson(`${server.origin}/.well-known/oauth-protected-resource${path}`)) ??
    (await getJson(`${server.origin}/.well-known/oauth-protected-resource`));
  const issuer: string = prm?.authorization_servers?.[0] ?? server.origin;
  const iss = new URL(issuer);
  const ipath = iss.pathname.replace(/\/$/, '');
  const as =
    (await getJson(`${iss.origin}/.well-known/oauth-authorization-server${ipath}`)) ??
    (await getJson(`${iss.origin}/.well-known/openid-configuration${ipath}`)) ??
    (ipath ? await getJson(`${iss.origin}/.well-known/oauth-authorization-server`) : undefined);
  if (!as?.authorization_endpoint || !as?.token_endpoint) throw new Error('This server has no OAuth sign-in we can use.');
  if (!as.registration_endpoint) throw new Error('This server needs a pre-registered app; it does not let new apps sign in on their own.');
  return { as, resource: (prm?.resource as string) ?? server.href, scopes: (prm?.scopes_supported as string[] | undefined) ?? as.scopes_supported };
}

// Step 1: register ourselves with the server and build the sign-in URL.
export async function beginAuth(server: URL, redirectUri: string, state: string) {
  const { as, resource, scopes } = await discover(server);
  const reg = await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Viven interviewer',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!reg.ok) throw new Error(`Could not register with ${server.hostname} (HTTP ${reg.status}).`);
  const client: any = await reg.json();
  const verifier = randomToken(48);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const u = new URL(as.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource,
    ...(scopes?.length ? { scope: scopes.join(' ') } : {}),
  }).toString();
  const oauth: OAuthClient = { tokenEndpoint: as.token_endpoint, clientId: client.client_id, clientSecret: client.client_secret, resource };
  return { url: u.href, verifier, oauth };
}

async function tokenRequest(oauth: OAuthClient, params: Record<string, string>): Promise<Tokens> {
  const r = await fetch(oauth.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ ...params, client_id: oauth.clientId, ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}), resource: oauth.resource }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Sign-in failed (HTTP ${r.status}).`);
  const t: any = await r.json();
  return { access: t.access_token, refresh: t.refresh_token ?? params.refresh_token, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined };
}

// Step 2: swap the code from the redirect for tokens.
export const finishAuth = (oauth: OAuthClient, code: string, verifier: string, redirectUri: string) =>
  tokenRequest(oauth, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri });

export const refreshTokens = (oauth: OAuthClient, refresh: string) => tokenRequest(oauth, { grant_type: 'refresh_token', refresh_token: refresh });

export type McpTool = { name: string; description?: string; inputSchema: any; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } };

// JSON-RPC over Streamable HTTP. Replies come back as JSON or as a short SSE stream.
export class McpClient {
  private url: string;
  private token: string;
  private session?: string;
  private n = 0;
  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }
  private async rpc(method: string, params: unknown, notify = false): Promise<any> {
    const id = notify ? undefined : ++this.n;
    const r = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${this.token}`,
        'MCP-Protocol-Version': '2025-06-18',
        ...(this.session ? { 'Mcp-Session-Id': this.session } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(notify ? {} : { id }) }),
      signal: AbortSignal.timeout(30000),
    });
    this.session = r.headers.get('mcp-session-id') ?? this.session;
    if (r.status === 401) throw new Error('unauthorized');
    if (notify) return;
    if (!r.ok) throw new Error(`${method} failed (HTTP ${r.status})`);
    const text = await r.text();
    const msgs = (r.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => {
            try {
              return JSON.parse(l.slice(5));
            } catch {
              return undefined;
            }
          })
      : [JSON.parse(text)];
    const m = msgs.find((x) => x && x.id === id);
    if (!m) throw new Error(`${method}: no reply`);
    if (m.error) throw new Error(`${method}: ${m.error.message ?? 'error'}`);
    return m.result;
  }
  async connect() {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'viven-interviewer', version: '1' } });
    await this.rpc('notifications/initialized', {}, true);
  }
  async tools(): Promise<McpTool[]> {
    const all: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.rpc('tools/list', cursor ? { cursor } : {});
      all.push(...(r.tools ?? []));
      cursor = r.nextCursor;
    } while (cursor && all.length < 300);
    return all;
  }
  async call(name: string, args: unknown): Promise<string> {
    const r = await this.rpc('tools/call', { name, arguments: args ?? {} });
    const text = (r.content ?? []).map((c: any) => (c.type === 'text' ? c.text : c.type === 'resource' ? (c.resource?.text ?? '') : `[${c.type}]`)).join('\n');
    return r.isError ? `Error: ${text}` : text;
  }
}

// Reading only. Trust the server's own read-only hint; without one, go by the name.
export function isReadTool(t: McpTool) {
  if (t.annotations?.readOnlyHint === true) return true;
  if (t.annotations?.readOnlyHint === false || t.annotations?.destructiveHint) return false;
  const n = t.name.toLowerCase();
  if (/(create|update|delete|remove|send|post|write|edit|move|archive|add|set|insert|upload|duplicate|invite|comment|reply|draft|trigger|run|execute|enable|disable)/.test(n)) return false;
  return /(search|fetch|get|list|read|find|query|view|retrieve|lookup|show|describe)/.test(n);
}
