import { randomBytes } from 'node:crypto';
import { MetaStore } from './meta.ts';
import type { ForgeStore } from './store.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];
const SERVER_INFO = { name: 'ghforge', version: '1.0.0' };

interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

const TOOLS: ToolSchema[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Fetch a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository owner/repo' },
        state: { type: 'string', description: 'Issue state filter' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository owner/repo' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch ref' },
        base: { type: 'string', description: 'Base branch ref' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository owner/repo' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const tokenLogin = (): string => process.env.MAKEFUN_SHOP_LOGIN || 'owner';
const tokenValue = (): string => process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Builds a JSON-RPC 2.0 response object. */
function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** Builds a JSON-RPC 2.0 error response object. */
function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Matches a tool name case-insensitively as a suffix. */
function matchTool(name: string): ToolSchema | null {
  const lower = name.toLowerCase();
  for (const tool of TOOLS) {
    if (lower.endsWith(tool.name.toLowerCase())) {
      return tool;
    }
  }
  return null;
}

/** Maps call arguments onto schema property names case-insensitively. */
function mapArgs(args: unknown, tool: ToolSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const source = args as Record<string, unknown>;
    for (const key of Object.keys(tool.inputSchema.properties)) {
      if (key in source) {
        out[key] = source[key];
        continue;
      }
      const found = Object.keys(source).find((k) => k.toLowerCase() === key.toLowerCase());
      if (found !== undefined) out[key] = source[found];
    }
  }
  return out;
}

/** Extracts owner and repo from mapped args, resolving full_name when needed. */
function resolveRepo(mapped: Record<string, unknown>): {
  owner?: string;
  repo?: string;
  full_name?: string;
} {
  let owner = typeof mapped.owner === 'string' ? mapped.owner : undefined;
  let repo = typeof mapped.repo === 'string' ? mapped.repo : undefined;
  const fullName = typeof mapped.full_name === 'string' ? mapped.full_name : undefined;
  if (fullName !== undefined && (owner === undefined || repo === undefined)) {
    const [o, r] = fullName.split('/');
    if (o && r) {
      owner = o;
      repo = r;
    }
  }
  return { owner, repo, full_name: owner && repo ? `${owner}/${repo}` : undefined };
}

/** Invokes a tool against the shared stores and returns a tools/call result. */
function callTool(
  store: ForgeStore,
  meta: MetaStore,
  login: string,
  params: Record<string, unknown>,
): Record<string, unknown> | null {
  const rawName = params.name;
  if (typeof rawName !== 'string') {
    return { content: [{ type: 'text', text: 'Missing tool name' }], isError: true };
  }
  const tool = matchTool(rawName);
  if (!tool) {
    return null;
  }
  const mapped = mapArgs(params.arguments, tool);
  const user = meta.getUser(login) ?? meta.createUser(login);

  if (tool.name === 'create_repo') {
    const missing = tool.inputSchema.required.filter(
      (k) => mapped[k] === undefined || mapped[k] === null || mapped[k] === '',
    );
    if (missing.length > 0) {
      return errorContent(`Missing required argument: ${missing.join(', ')}`);
    }
    const repo = meta.createRepo({
      name: String(mapped.name),
      owner: { login: user.login, id: user.id },
    });
    return okContent(repo);
  }

  const { owner, repo } = resolveRepo(mapped);
  const missing = tool.inputSchema.required
    .filter((k) => k !== 'owner' && k !== 'repo')
    .filter((k) => mapped[k] === undefined || mapped[k] === null || mapped[k] === '');
  const missingRepo = owner === undefined || repo === undefined;

  if (missingRepo) {
    return errorContent('Missing required argument: owner, repo');
  }
  if (missing.length > 0) {
    return errorContent(`Missing required argument: ${missing.join(', ')}`);
  }

  switch (tool.name) {
    case 'get_repo':
      return okContent(meta.getRepo(owner as string, repo as string));
    case 'create_issue':
      return okContent(
        meta.createIssue(owner as string, repo as string, {
          title: String(mapped.title),
          body: typeof mapped.body === 'string' ? mapped.body : undefined,
        }),
      );
    case 'list_issues':
      return okContent(
        meta.listIssues(owner as string, repo as string, {
          state: typeof mapped.state === 'string' ? mapped.state : undefined,
        }),
      );
    case 'create_pull_request':
      return okContent(
        meta.createPull(owner as string, repo as string, {
          title: String(mapped.title),
          head: String(mapped.head),
          base: String(mapped.base),
          body: typeof mapped.body === 'string' ? mapped.body : undefined,
        }),
      );
    case 'merge_pull_request': {
      const number = Number(mapped.pull_number);
      if (!Number.isInteger(number)) {
        return errorContent('Missing required argument: pull_number');
      }
      return okContent(meta.mergePull(owner as string, repo as string, number));
    }
    default:
      return errorContent(`Unknown tool: ${tool.name}`);
  }
}

/** Builds a successful tools/call content result. */
function okContent(result: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
}

/** Builds a failed tools/call content result. */
function errorContent(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

interface DispatchOutcome {
  kind: 'response' | 'notification';
  body?: Record<string, unknown>;
  sessionId?: string;
}

/** Dispatches a single JSON-RPC request to the appropriate method handler. */
function dispatch(
  store: ForgeStore,
  meta: MetaStore,
  login: string,
  msg: Record<string, unknown>,
  headerVersion: string | undefined,
  sessionId: string | undefined,
): DispatchOutcome {
  const method = typeof msg.method === 'string' ? msg.method : undefined;
  const id = msg.id;
  const params = (msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params)
    ? msg.params
    : {}) as Record<string, unknown>;

  if (method === undefined) {
    return { kind: 'response', body: rpcError(null, -32600, 'Invalid Request') };
  }

  switch (method) {
    case 'initialize': {
      const nextSession = sessionId ?? randomBytes(16).toString('hex');
      const protocolVersion =
        (typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined) ??
        headerVersion ??
        '2025-11-25';
      return {
        kind: 'response',
        sessionId: nextSession,
        body: rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
      };
    }
    case 'notifications/initialized':
      return { kind: 'notification', sessionId };
    case 'tools/list':
      return { kind: 'response', sessionId, body: rpcResult(id, { tools: TOOLS }) };
    case 'server/discover':
      return {
        kind: 'response',
        sessionId,
        body: rpcResult(id, { supportedVersions: SUPPORTED_VERSIONS, serverInfo: SERVER_INFO }),
      };
    case 'ping':
      return { kind: 'response', sessionId, body: rpcResult(id, {}) };
    case 'tools/call': {
      const result = callTool(store, meta, login, params);
      if (result === null) {
        return {
          kind: 'response',
          sessionId,
          body: rpcError(id, -32602, `Unknown tool: ${String(params.name ?? '')}`),
        };
      }
      return { kind: 'response', sessionId, body: rpcResult(id, result) };
    }
    default:
      return { kind: 'response', sessionId, body: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}

/** Handles the MCP JSON-RPC endpoint over Streamable HTTP. */
export async function handleMcp(
  store: ForgeStore,
  meta: MetaStore,
  req: Request,
): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('{"message":"Method Not Allowed"}', {
      status: 405,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (req.headers.get('authorization') !== `Bearer ${tokenValue()}`) {
    return new Response('{"message":"Requires authentication"}', {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    bodyText = '';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return new Response(
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}',
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  const login = tokenLogin();
  const headerVersion = req.headers.get('MCP-Protocol-Version') ?? undefined;
  const incomingSession = req.headers.get('Mcp-Session-Id') ?? undefined;

  const processOne = (msg: unknown): DispatchOutcome => {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return { kind: 'response', body: rpcError(null, -32600, 'Invalid Request') };
    }
    return dispatch(store, meta, login, msg as Record<string, unknown>, headerVersion, incomingSession);
  };

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return new Response(
        '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}',
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    const responses: Record<string, unknown>[] = [];
    let sessionId = incomingSession;
    for (const item of parsed) {
      const outcome = processOne(item);
      if (outcome.sessionId) sessionId = outcome.sessionId;
      if (outcome.kind === 'response' && outcome.body) responses.push(outcome.body);
    }
    if (responses.length === 0) {
      return new Response(null, { status: 202 });
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    return new Response(JSON.stringify(responses), { status: 200, headers });
  }

  const outcome = processOne(parsed);
  if (outcome.kind === 'notification') {
    const headers: Record<string, string> = {};
    if (outcome.sessionId) headers['Mcp-Session-Id'] = outcome.sessionId;
    return new Response(null, { status: 202, headers });
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (outcome.sessionId) headers['Mcp-Session-Id'] = outcome.sessionId;
  return new Response(JSON.stringify(outcome.body), { status: 200, headers });
}
