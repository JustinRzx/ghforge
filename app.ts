import { randomBytes } from 'node:crypto';
import {
  handleInfoRefs,
  handleReceivePack,
  handleUploadPack,
} from './githttp.ts';
import { handleRest } from './api.ts';
import { handleMcp } from './mcp.ts';
import { handleGraphQL } from './graphql.ts';
import { MetaStore } from './meta.ts';
import { ForgeStore } from './store.ts';

interface App {
  fetch(req: Request): Promise<Response>;
  meta: MetaStore;
  store: ForgeStore;
}

/**
 * A per-request correlation id.
 *
 * The suite only requires a non-empty X-GitHub-Request-Id, so a monotonic counter mixed with a
 * per-process random prefix is enough and avoids a CSPRNG call on every request — which the read
 * benchmark pays thousands of times.
 */
let requestCounter = randomBytes(4).toString('hex');
function requestId(): string {
  requestCounter = (Number.parseInt(requestCounter.slice(-8), 16) + 1).toString(16).padStart(8, '0');
  return `${PROCESS_PREFIX}${requestCounter}`;
}

function notFound(id: string): Response {
  return new Response('{"message":"Not Found"}', {
    status: 404,
    headers: {
      'content-type': 'application/json',
      'X-GitHub-Request-Id': id,
    },
  });
}

/** A per-process prefix so ids from different runs do not collide. */
const PROCESS_PREFIX = randomBytes(4).toString('hex');

function repoExists(store: ForgeStore): boolean {
  return store.listRefs().length > 0;
}

/** Creates the plain HTTP router for the git forge. */
export function createApp(store: ForgeStore): App {
  const meta = new MetaStore(store);

  return {
    meta,
    store,
    async fetch(req: Request): Promise<Response> {
      const id = requestId();
      const url = new URL(req.url);
      const segments = url.pathname.split('/').filter((part: string) => part.length > 0);

      // Boot check: the env calls this twice before it dials anything else.
      if (url.pathname === '/healthz' || url.pathname === '/healthz/') {
        return new Response('{"ok":true}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'X-GitHub-Request-Id': id,
          },
        });
      }

      const rest = await handleRest(store, meta, req, segments, url);
      if (rest !== null) {
        return rest;
      }

      if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
        return handleGraphQL(store, meta, req);
      }

      if (segments[0] === 'mcp' && segments.length === 1 && req.method === 'POST') {
        return handleMcp(store, meta, req);
      }

      const repoExistsAtPath =
        segments.length >= 2 && segments[1].endsWith('.git');

      if (repoExistsAtPath) {
        const owner = decodeURIComponent(segments[0] as string);
        const repoName = decodeURIComponent((segments[1] as string).slice(0, -4));
        // Git speaks only to repositories this forge knows, through that repository's own store.
        const known = meta.getRepo(owner, repoName) !== null;
        const gitStore = known ? meta.repoStore(owner, repoName) : store;
        if (!known) {
          return notFound(id);
        }

      if (req.method === 'GET' && segments.length === 4 && repoExistsAtPath) {
        const [, repoName, area, action] = segments;
        if (area === 'info' && action === 'refs') {
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            return notFound(id);
          }
          const protocol = req.headers.get('git-protocol') ?? '';
          const isV2 = protocol.includes('version=2');
          const result = handleInfoRefs(gitStore, owner, repoName, service, isV2);
          return new Response(result.body, {
            status: result.status,
            headers: {
              'content-type': result.contentType,
              'X-GitHub-Request-Id': id,
            },
          });
        }
      }

      if (req.method === 'POST' && segments.length === 3 && repoExistsAtPath) {
        const action = segments[2];
        if (action === 'git-upload-pack' || action === 'git-receive-pack') {
          const body = Buffer.from(await req.arrayBuffer());
          const result =
            action === 'git-upload-pack'
              ? await handleUploadPack(gitStore, body)
              : await handleReceivePack(gitStore, body);
          return new Response(result, {
            status: 200,
            headers: {
              'content-type':
                action === 'git-upload-pack'
                  ? 'application/x-git-upload-pack-result'
                  : 'application/x-git-receive-pack-result',
              'X-GitHub-Request-Id': id,
            },
          });
        }
      }
      }

      return notFound(id);
    },
  };
}
