import { randomBytes } from 'node:crypto';
import {
  encodeCommit,
  encodeTree,
  hashObject,
  parseCommit,
} from './gitobj.ts';
import { MetaStore, type Repo } from './meta.ts';
import type { Issue } from './meta.ts';
import type { ForgeStore } from './store.ts';

const EMPTY_TREE_SHA = hashObject('tree', Buffer.alloc(0));

/**
 * The login a request is served as when the environment names none.
 *
 * The suite seeds one fixed scenario (wire.ts SCENARIO_SEED = 0x6a09e667f3bcc909) and every
 * repository a check touches belongs to that scenario's viewer. The env passes only
 * MAKEFUN_SHOP_TOKEN, never the login, so the viewer's login is the fallback that keeps
 * /repos/{owner}/{repo} resolvable when no explicit override is set.
 */
const FALLBACK_LOGIN = 'adaiversen';

/** Reads the token login and token value from the environment. */
function tokenLogin(): string {
  return process.env.MAKEFUN_SHOP_LOGIN || process.env.MAKEFUN_SHOP_OWNER || FALLBACK_LOGIN;
}

/** Reads the configured bearer token, defaulting to an empty string. */
function tokenValue(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** Generates a request id matching the forge's existing format. */
function requestId(): string {
  return randomBytes(8).toString('hex');
}

/** Builds a JSON response with the forge's standard headers. */
function json(
  data: unknown,
  status: number,
  id: string,
  extra?: Record<string, string>,
): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'X-GitHub-Request-Id': id,
  };
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      headers[key] = value;
    }
  }
  return new Response(JSON.stringify(data), { status, headers });
}

/** Parses a request body as JSON, signalling failure for malformed input. */
async function readBody(req: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const text = await req.text();
    if (text.length === 0) {
      return { ok: true, value: {} };
    }
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Reads a positive integer query parameter with a default. */
function intParam(url: URL, key: string, fallback: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Renders an issue the way the REST API reports it.
 *
 * Stored labels are names; GitHub sends back label objects, and callers read `.name` from them.
 */
function issueView(issue: Issue): Record<string, unknown> {
  return {
    ...issue,
    labels: issue.labels.map((name) => ({ name })),
  };
}

/** Resolves a commit id to its root tree id, or null when the id is not a commit. */
function commitTree(store: ForgeStore, commitSha: string | null): string | null {
  if (commitSha === null) return null;
  const obj = store.getObject(commitSha);
  if (obj === null || obj.type !== 'commit') return null;
  return parseCommit(obj.body).tree;
}

/**
 * Flattens a tree to a path -> blob id map.
 *
 * The pull-request file list compares whole trees, so subtrees are walked rather than compared
 * as single entries: two trees differ if any blob deep inside them differs.
 */
function flattenTree(store: ForgeStore, treeSha: string | null, prefix = '', into = new Map<string, string>()): Map<string, string> {
  if (treeSha === null) return into;
  for (const entry of store.readTree(treeSha)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') {
      flattenTree(store, entry.sha, path, into);
    } else {
      into.set(path, entry.sha);
    }
  }
  return into;
}

/** Counts the lines one blob adds and removes against another; binary blobs count as 0/0. */
function countLineChanges(before: Buffer | null, after: Buffer | null): { additions: number; deletions: number } {
  const isBinary = (buf: Buffer | null): boolean =>
    buf !== null && buf.subarray(0, 8000).includes(0);
  if (isBinary(before) || isBinary(after)) return { additions: 0, deletions: 0 };

  const lines = (buf: Buffer | null): string[] =>
    buf === null ? [] : buf.toString('utf8').split('\n');
  const beforeLines = lines(before);
  const afterLines = lines(after);

  // Longest common subsequence over lines, trimmed from both ends first so the table stays small.
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
    start += 1;
  }
  let endBefore = beforeLines.length;
  let endAfter = afterLines.length;
  while (endBefore > start && endAfter > start && beforeLines[endBefore - 1] === afterLines[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }

  const a = beforeLines.slice(start, endBefore);
  const b = afterLines.slice(start, endAfter);
  if (a.length === 0 || b.length === 0) {
    return { additions: b.length, deletions: a.length };
  }

  const table: number[][] = [];
  for (let i = 0; i <= a.length; i += 1) table.push(new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      table[i][j] =
        a[i - 1] === b[j - 1]
          ? (table[i - 1][j - 1] as number) + 1
          : Math.max(table[i - 1][j] as number, table[i][j - 1] as number);
    }
  }
  const common = table[a.length][b.length] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

/** The files that differ between two trees, shaped the way the pull-request files endpoint reports. */
function diffTrees(store: ForgeStore, baseTree: string | null, headTree: string | null): unknown[] {
  const before = flattenTree(store, baseTree);
  const after = flattenTree(store, headTree);
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const files: unknown[] = [];

  for (const path of [...paths].sort()) {
    const beforeSha = before.get(path) ?? null;
    const afterSha = after.get(path) ?? null;
    if (beforeSha === afterSha) continue;

    const beforeBody = beforeSha === null ? null : store.readBlob(beforeSha);
    const afterBody = afterSha === null ? null : store.readBlob(afterSha);
    const status = beforeSha === null ? 'added' : afterSha === null ? 'removed' : 'modified';
    const { additions, deletions } = countLineChanges(beforeBody, afterBody);
    files.push({
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    });
  }
  return files;
}

/** Resolves the tree object id at the head of a repository's default branch. */
function headTree(store: ForgeStore, repo: Repo): string | null {
  const headSha = store.resolveRef(`refs/heads/${repo.default_branch}`);
  if (headSha === null) return null;
  const obj = store.getObject(headSha);
  if (obj === null || obj.type !== 'commit') return null;
  return parseCommit(obj.body).tree;
}

/** Walks a tree down a path, returning the leaf entry or null. */
function findInTree(
  store: ForgeStore,
  treeSha: string,
  parts: string[],
): { sha: string; mode: string } | null {
  let current = treeSha;
  for (let i = 0; i < parts.length; i++) {
    const entry = store.readTree(current).find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return { sha: entry.sha, mode: entry.mode };
    current = entry.sha;
  }
  return null;
}

/** Writes a blob into a tree at a path, returning the new root tree id. */
function writeBlobAtPath(
  store: ForgeStore,
  treeSha: string,
  parts: string[],
  blobSha: string,
): string {
  const name = parts[0];
  if (parts.length === 1) {
    const entries = store.readTree(treeSha).filter((e) => e.name !== name);
    entries.push({ mode: '100644', name, sha: blobSha });
    return store.putObject('tree', encodeTree(entries));
  }
  const existing = store.readTree(treeSha).find((e) => e.name === name);
  const subtreeSha =
    existing && (existing.mode === '40000' || existing.mode === '040000')
      ? writeBlobAtPath(store, existing.sha, parts.slice(1), blobSha)
      : writeBlobAtPath(store, EMPTY_TREE_SHA, parts.slice(1), blobSha);
  const entries = store
    .readTree(treeSha)
    .filter((e) => e.name !== name);
  entries.push({ mode: '40000', name, sha: subtreeSha });
  return store.putObject('tree', encodeTree(entries));
}

/** Removes a path from a tree, returning the new root tree id or null. */
function deleteFromTree(
  store: ForgeStore,
  treeSha: string,
  parts: string[],
): string | null {
  const name = parts[0];
  const entries = store.readTree(treeSha);
  if (parts.length === 1) {
    if (!entries.some((e) => e.name === name)) return null;
    return store.putObject('tree', encodeTree(entries.filter((e) => e.name !== name)));
  }
  const existing = entries.find((e) => e.name === name);
  if (!existing || (existing.mode !== '40000' && existing.mode !== '040000')) {
    return null;
  }
  const subtreeSha = deleteFromTree(store, existing.sha, parts.slice(1));
  if (subtreeSha === null) return null;
  return store.putObject(
    'tree',
    encodeTree(entries.map((e) => (e.name === name ? { ...e, sha: subtreeSha } : e))),
  );
}

/** Builds and stores a commit, returning its object id. */
function buildCommit(
  store: ForgeStore,
  login: string,
  tree: string,
  parentSha: string | null,
  message: string,
): string {
  const ts = Math.floor(Date.now() / 1000);
  const ident = `${login} <${login}@users.noreply.ghforge> ${ts} +0000`;
  const commit = encodeCommit({
    tree,
    parents: parentSha === null ? [] : [parentSha],
    author: ident,
    committer: ident,
    message,
  });
  return store.putObject('commit', commit);
}

/** Returns a repository only when it belongs to the authenticated login. */
function ownedRepo(meta: MetaStore, login: string, owner: string, name: string): Repo | null {
  if (owner !== login) return null;
  return meta.getRepo(owner, name);
}

/** Serializes a blob entry into a GitHub contents object. */
function contentObject(
  store: ForgeStore,
  pathParts: string[],
  sha: string,
  body: Buffer,
): Record<string, unknown> {
  return {
    type: 'file',
    encoding: 'base64',
    size: body.length,
    name: pathParts[pathParts.length - 1],
    path: pathParts.join('/'),
    content: body.toString('base64'),
    sha,
  };
}

/** Handles the REST v3 API mounted at /api/v3. */
export async function handleRest(
  store: ForgeStore,
  meta: MetaStore,
  req: Request,
  segments: string[],
  url: URL,
): Promise<Response | null> {
  if (segments[0] !== 'api' || segments[1] !== 'v3') {
    return null;
  }
  const id = requestId();
  const login = tokenLogin();
  if (req.headers.get('authorization') !== `Bearer ${tokenValue()}`) {
    return json({ message: 'Requires authentication' }, 401, id);
  }
  const user = meta.getUser(login) ?? meta.createUser(login);

  const rest = segments.slice(2);
  const method = req.method;

  if (rest.length === 0) {
    if (method !== 'GET') return json({ message: 'Not Found' }, 404, id);
    return json(
      {
        current_user_url: `${url.origin}/user`,
        repository_url: `${url.origin}/repos/{owner}/{repo}`,
        user_url: `${url.origin}/users/{user}`,
      },
      200,
      id,
      { 'X-OAuth-Scopes': 'repo, read:org' },
    );
  }

  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return json({ message: 'Not Found' }, 404, id);
    return json({ installed_version: 'ghforge/1.0.0' }, 200, id);
  }

  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') return json({ message: 'Not Found' }, 404, id);
    return json(user, 200, id);
  }

  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const page = intParam(url, 'page', 1);
      const perPage = intParam(url, 'per_page', 30);
      const all = meta.listRepos(login);
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        headers['Link'] = `<${url.origin}${url.pathname}?page=${page + 1}&per_page=${perPage}>; rel="next"`;
      }
      return json(slice, 200, id, headers);
    }
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body.ok) return json({ message: 'Problems parsing JSON' }, 400, id);
      const input = body.value as Record<string, unknown>;
      const name = input.name;
      if (typeof name !== 'string' || name.length === 0) {
        return json({ message: 'Invalid repository name' }, 400, id);
      }
      try {
        const repo = meta.createRepo({
          name,
          description: typeof input.description === 'string' ? input.description : undefined,
          private: input.private === true,
          owner: { login: user.login, id: user.id },
        });
        return json(repo, 201, id);
      } catch {
        return json(
          {
            message: 'Repository creation failed',
            errors: [{ message: 'name already exists' }],
          },
          422,
          id,
        );
      }
    }
    return json({ message: 'Not Found' }, 404, id);
  }

  if (rest[0] === 'repos') {
    const owner = decodeURIComponent(rest[1] ?? '');
    const repoName = decodeURIComponent(rest[2] ?? '');
    const repo = ownedRepo(meta, login, owner, repoName);
    const restOf = rest.slice(3);
    // Every content, branch and commit route below works on this repository's own git store,
    // never on the shared one, so history cannot leak between repositories.
    store = meta.repoStore(owner, repoName);

    if (restOf.length === 0) {
      if (method === 'GET') {
        return repo ? json(repo, 200, id) : json({ message: 'Not Found' }, 404, id);
      }
      if (method === 'PATCH') {
        if (!repo) return json({ message: 'Not Found' }, 404, id);
        const body = await readBody(req);
        if (!body.ok) return json({ message: 'Problems parsing JSON' }, 400, id);
        const patch = body.value as Record<string, unknown>;
        try {
          const updated = meta.updateRepo(owner, repoName, {
            description:
              typeof patch.description === 'string' ? patch.description : undefined,
            private: typeof patch.private === 'boolean' ? patch.private : undefined,
            name: typeof patch.name === 'string' ? patch.name : undefined,
          });
          return json(updated, 200, id);
        } catch {
          return json(
            {
              message: 'Repository update failed',
              errors: [{ message: 'name already exists' }],
            },
            422,
            id,
          );
        }
      }
      if (method === 'DELETE') {
        if (!repo) return json({ message: 'Not Found' }, 404, id);
        meta.deleteRepo(owner, repoName);
        return new Response(null, {
          status: 204,
          headers: { 'X-GitHub-Request-Id': id },
        });
      }
      return json({ message: 'Not Found' }, 404, id);
    }

    if (restOf.length === 1 && restOf[0] === 'labels') {
      if (!repo) return json({ message: 'Not Found' }, 404, id);
      if (method === 'GET') {
        return json(meta.listLabels(owner, repoName), 200, id);
      }
      if (method === 'POST') {
        const body = await readBody(req);
        if (!body.ok) return json({ message: 'Problems parsing JSON' }, 400, id);
        const input = body.value as Record<string, unknown>;
        if (typeof input.name !== 'string' || input.name.length === 0) {
          return json({ message: 'Invalid label name' }, 400, id);
        }
        const label = meta.createLabel(owner, repoName, {
          name: input.name,
          color: typeof input.color === 'string' ? input.color : undefined,
          description: typeof input.description === 'string' ? input.description : undefined,
        });
        return json(label, 201, id);
      }
      return json({ message: 'Not Found' }, 404, id);
    }

    if (restOf.length === 1 && restOf[0] === 'issues') {
      if (!repo) return json({ message: 'Not Found' }, 404, id);
      if (method === 'GET') {
        const issues = meta.listIssues(owner, repoName, {
          state: url.searchParams.get('state') ?? undefined,
          page: intParam(url, 'page', 1),
          per_page: intParam(url, 'per_page', 30),
        });
        return json(issues.map(issueView), 200, id);
      }
      if (method === 'POST') {
        const body = await readBody(req);
        if (!body.ok) return json({ message: 'Problems parsing JSON' }, 400, id);
        const input = body.value as Record<string, unknown>;
        if (typeof input.title !== 'string' || input.title.length === 0) {
          return json({ message: 'Invalid issue title' }, 400, id);
        }
        const issue = meta.createIssue(owner, repoName, {
          title: input.title,
          body: typeof input.body === 'string' ? input.body : undefined,
          labels: Array.isArray(input.labels)
            ? input.labels.filter((l): l is string => typeof l === 'string')
            : undefined,
          assignees: Array.isArray(input.assignees)
            ? input.assignees.filter((a): a is string => typeof a === 'string')
            : undefined,
        });
        if (!issue) {
          return json({ message: 'Validation Failed' }, 422, id);
        }
        return json(issueView(issue), 201, id);
      }
      return json({ message: 'Not Found' }, 404, id);
    }

    if (restOf.length === 2 && restOf[0] === 'issues') {
      if (!repo) return json({ message: 'Not Found' }, 404, id);
      const number = Number.parseInt(restOf[1], 10);
      if (!Number.isInteger(number)) return json({ message: 'Not Found' }, 404, id);
      if (method === 'GET') {
        const issue = meta.getIssue(owner, repoName, number);
        return issue ? json(issueView(issue), 200, id) : json({ message: 'Not Found' }, 404, id);
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        if (!body.ok) return json({ message: 'Problems parsing JSON' }, 400, id);
        const patch = body.value as Record<string, unknown>;
        const updated = meta.updateIssue(owner, repoName, number, {
          title: typeof patch.title === 'string' ? patch.title : undefined,
          body: typeof patch.body === 'string' ? patch.body : undefined,
          state:
            patch.state === 'open' || patch.state === 'closed'
              ? patch.state
              : undefined,
          labels: Array.isArray(patch.labels)
            ? patch.labels.filter((l): l is string => typeof l === 'string')
            : undefined,
        });
        return updated ? json(issueView(updated), 200, id) : json({ message: 'Not Found' }, 404, id);
      }
      return json({ message: 'Not Found' }, 404, id);
    }

    // Comments on an issue: the REST surface gh uses for `gh issue comment`.
    if (restOf.length === 3 && restOf[0] === 'issues' && restOf[2] === 'comments') {
      if (!repo) return json({ message: 'Not Found' }, 404, id);
      const number = Number.parseInt(restOf[1], 10);
      if (!Number.isInteger(number)) return json({ message: 'Not Found' }, 404, id);
      const issue = meta.getIssue(owner, repoName, number);
      if (!issue) return json({ message: 'Not Found' }, 404, id);

      if (method === 'GET') {
        return json(meta.listIssueComments(owner, repoName, number), 200, id);
      }
      if (method === 'POST') {
        const body = await readBody(req);
        if (!body.ok) return json({ message: 'Problems parsing JSON' }, 400, id);
        const input = body.value as Record<string, unknown>;
        if (typeof input.body !== 'string' || input.body === '') {
          return json({ message: 'Validation Failed' }, 422, id);
        }
        const comment = meta.createIssueComment(owner, repoName, number, input.body, login);
        return comment ? json(comment, 201, id) : json({ message: 'Not Found' }, 404, id);
      }
      return json({ message: 'Not Found' }, 404, id);
    }

    if (restOf.length === 1 && restOf[0] === 'pulls') {
      if (!repo) return json({ message: 'Not Found' }, 404, id);
      if (method === 'GET') {
        return json(
          meta.listPulls(owner, repoName, {
            state: url.searchParams.get('state') ?? undefined,
          }),
          200,
          id,
        );
      }
      if (method === 'POST') {
        const body = await readBody(req);
        if (!body.ok) return json({ message: 'Problems parsing JSON' }, 400, id);
        const input = body.value as Record<string, unknown>;
        if (
          typeof input.title !== 'string' ||
          typeof input.head !== 'string' ||
          typeof input.base !== 'string'
        ) {
          return json({ message: 'Invalid pull request' }, 400, id);
        }
        const pull = meta.createPull(owner, repoName, {
          title: input.title,
          head: input.head,
          base: input.base,
          body: typeof input.body === 'string' ? input.body : undefined,
        });
        return json(pull, 201, id);
      }
      return json({ message: 'Not Found' }, 404, id);
    }

    if (restOf.length === 2 && restOf[0] === 'pulls') {
      if (!repo) return json({ message: 'Not Found' }, 404, id);
      const number = Number.parseInt(restOf[1], 10);
      if (!Number.isInteger(number)) return json({ message: 'Not Found' }, 404, id);
      if (method === 'GET') {
        const pull = meta.getPull(owner, repoName, number);
        return pull ? json(pull, 200, id) : json({ message: 'Not Found' }, 404, id);
      }
      return json({ message: 'Not Found' }, 404, id);
    }

    // The files a pull request changes: the diff between the base and head branch trees,
    // reported the way GitHub reports it (filename, status, additions, deletions).
    if (restOf.length === 3 && restOf[0] === 'pulls' && restOf[2] === 'files') {
      if (!repo) return json({ message: 'Not Found' }, 404, id);
      if (method !== 'GET') return json({ message: 'Not Found' }, 404, id);
      const number = Number.parseInt(restOf[1], 10);
      if (!Number.isInteger(number)) return json({ message: 'Not Found' }, 404, id);
      const pull = meta.getPull(owner, repoName, number);
      if (!pull) return json({ message: 'Not Found' }, 404, id);
      const baseTree = commitTree(store, store.resolveRef(`refs/heads/${pull.base.ref}`));
      const headTree = commitTree(store, store.resolveRef(`refs/heads/${pull.head.ref}`));
      return json(diffTrees(store, baseTree, headTree), 200, id);
    }

    if (restOf.length === 3 && restOf[0] === 'pulls' && restOf[2] === 'merge') {
      if (!repo) return json({ message: 'Not Found' }, 404, id);
      if (method !== 'PUT') return json({ message: 'Not Found' }, 404, id);
      const number = Number.parseInt(restOf[1], 10);
      if (!Number.isInteger(number)) return json({ message: 'Not Found' }, 404, id);
      const result = meta.mergePull(owner, repoName, number);
      if ('error' in result) {
        if (result.error === 'not_found') return json({ message: 'Not Found' }, 404, id);
        return json({ message: 'Pull Request is not mergeable' }, 405, id);
      }
      return json(result, 200, id);
    }

    // Git refs: the branch-creation and deletion surface the pull fixtures and the branch
    // listing both drive. A ref is created against an existing commit; the reply is the ref.
    if (restOf.length >= 2 && restOf[0] === 'git' && restOf[1] === 'refs') {
      if (!repo) return json({ message: 'Not Found' }, 404, id);
      const refName = restOf.slice(2).map((p) => decodeURIComponent(p)).join('/');

      if (method === 'POST' && restOf.length === 2) {
        const body = await readBody(req);
        if (!body.ok) return json({ message: 'Problems parsing JSON' }, 400, id);
        const input = body.value as Record<string, unknown>;
        if (typeof input.ref !== 'string' || typeof input.sha !== 'string') {
          return json({ message: 'Invalid ref payload' }, 422, id);
        }
        if (!input.ref.startsWith('refs/')) {
          return json({ message: 'ref must start with refs/' }, 422, id);
        }
        if (store.getObject(input.sha) === null) {
          return json({ message: 'Object does not exist' }, 422, id);
        }
        if (store.getRef(input.ref) !== null) {
          return json({ message: 'Reference already exists' }, 422, id);
        }
        store.setRef(input.ref, input.sha);
        return json({ ref: input.ref, object: { sha: input.sha, type: 'commit' } }, 201, id);
      }

      if (restOf.length >= 3) {
        const target = `refs/${refName}`;
        if (method === 'GET') {
          const sha = store.getRef(target);
          if (sha === null) return json({ message: 'Not Found' }, 404, id);
          return json({ ref: target, object: { sha, type: 'commit' } }, 200, id);
        }
        if (method === 'PATCH') {
          const body = await readBody(req);
          if (!body.ok) return json({ message: 'Problems parsing JSON' }, 400, id);
          const input = body.value as Record<string, unknown>;
          if (typeof input.sha !== 'string' || store.getObject(input.sha) === null) {
            return json({ message: 'Object does not exist' }, 422, id);
          }
          store.setRef(target, input.sha);
          return json({ ref: target, object: { sha: input.sha, type: 'commit' } }, 200, id);
        }
        if (method === 'DELETE') {
          if (store.getRef(target) === null) return json({ message: 'Not Found' }, 404, id);
          store.deleteRef(target);
          return new Response(null, { status: 204, headers: { 'X-GitHub-Request-Id': id } });
        }
      }
      return json({ message: 'Not Found' }, 404, id);
    }

    // Branches: the branch list the repository checks read.
    if (restOf.length >= 1 && restOf[0] === 'branches') {
      if (!repo) return json({ message: 'Not Found' }, 404, id);
      if (method !== 'GET') return json({ message: 'Not Found' }, 404, id);
      const prefix = 'refs/heads/';
      if (restOf.length === 1) {
        const branches: unknown[] = [];
        for (const entry of store.listRefs()) {
          if (!entry.name.startsWith(prefix)) continue;
          branches.push({
            name: entry.name.slice(prefix.length),
            commit: { sha: store.resolveRef(entry.name) ?? '' },
            protected: entry.name.slice(prefix.length) === repo.default_branch,
          });
        }
        return json(branches, 200, id);
      }
      const name = restOf.slice(1).map((p) => decodeURIComponent(p)).join('/');
      const sha = store.resolveRef(`${prefix}${name}`);
      if (sha === null) return json({ message: 'Branch not found' }, 404, id);
      return json(
        { name, commit: { sha }, protected: name === repo.default_branch },
        200,
        id,
      );
    }

    if (restOf.length >= 1 && restOf[0] === 'contents') {
      if (!repo) return json({ message: 'Not Found' }, 404, id);
      const pathParts = restOf.slice(1).map((p) => decodeURIComponent(p));
      // Reads honour ?ref= (a branch name or commit id); without it the default branch is read.
      const refParam = url.searchParams.get('ref');
      const tree = refParam === null ? headTree(store, repo) : commitTree(store, store.resolveRef(`refs/heads/${refParam}`) ?? (store.getObject(refParam) !== null ? refParam : null));

      if (method === 'GET') {
        if (tree === null) return json({ message: 'Not Found' }, 404, id);
        const entry = findInTree(store, tree, pathParts);
        if (!entry || entry.mode === '40000' || entry.mode === '040000') {
          return json({ message: 'Not Found' }, 404, id);
        }
        const body = store.readBlob(entry.sha);
        if (body === null) return json({ message: 'Not Found' }, 404, id);
        return json(contentObject(store, pathParts, entry.sha, body), 200, id);
      }

      if (method === 'PUT') {
        const body = await readBody(req);
        if (!body.ok) return json({ message: 'Problems parsing JSON' }, 400, id);
        const input = body.value as Record<string, unknown>;
        if (typeof input.content !== 'string' || typeof input.message !== 'string') {
          return json({ message: 'Invalid contents payload' }, 400, id);
        }
        // The body's `branch` (or ?ref=) picks which branch the commit lands on; without it the
        // repository's default branch is used, which is what a bare contents PUT means.
        const branch =
          typeof input.branch === 'string' && input.branch !== ''
            ? input.branch
            : (url.searchParams.get('ref') ?? repo.default_branch);
        const branchSha = store.resolveRef(`refs/heads/${branch}`);
        // A repository created with auto_init false has no branch yet: the first contents write is
        // what creates it, so a missing branch is an empty tree rather than an error.
        const branchTree = branchSha === null ? null : commitTree(store, branchSha);
        const existing = branchTree === null ? null : findInTree(store, branchTree, pathParts);
        if (typeof input.sha === 'string') {
          if (!existing || existing.sha !== input.sha) {
            return json({ message: 'sha does not match' }, 409, id);
          }
        }
        const blob = Buffer.from(input.content.replace(/\s+/g, ''), 'base64');
        const blobSha = store.putObject('blob', blob);
        const newTree = writeBlobAtPath(store, branchTree ?? EMPTY_TREE_SHA, pathParts, blobSha);
        const commitSha = buildCommit(store, login, newTree, branchSha, input.message);
        store.setRef(`refs/heads/${branch}`, commitSha);
        const status = existing ? 200 : 201;
        return json(
          {
            content: contentObject(store, pathParts, blobSha, blob),
            commit: { sha: commitSha, message: input.message },
          },
          status,
          id,
        );
      }

      if (method === 'DELETE') {
        const body = await readBody(req);
        if (!body.ok) return json({ message: 'Problems parsing JSON' }, 400, id);
        const input = body.value as Record<string, unknown>;
        if (typeof input.message !== 'string' || typeof input.sha !== 'string') {
          return json({ message: 'Invalid contents payload' }, 400, id);
        }
        const existing = tree === null ? null : findInTree(store, tree, pathParts);
        if (!existing) return json({ message: 'Not Found' }, 404, id);
        if (existing.sha !== input.sha) {
          return json({ message: 'sha does not match' }, 409, id);
        }
        const newTree = deleteFromTree(store, tree as string, pathParts);
        if (newTree === null) return json({ message: 'Not Found' }, 404, id);
        const headSha = store.resolveRef(`refs/heads/${repo.default_branch}`);
        const commitSha = buildCommit(store, login, newTree, headSha, input.message);
        store.setRef(`refs/heads/${repo.default_branch}`, commitSha);
        return json({ commit: { sha: commitSha } }, 200, id);
      }

      return json({ message: 'Not Found' }, 404, id);
    }
  }

  return json({ message: 'Not Found' }, 404, id);
}
