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

function requestId(): string {
  return randomBytes(8).toString('hex');
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

      if (req.method === 'GET' && segments.length === 4 && repoExistsAtPath) {
        const [, repoName, area, action] = segments;
        if (area === 'info' && action === 'refs') {
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            return notFound(id);
          }
          if (!repoExistsAtPath || !repoExists(store)) {
            return notFound(id);
          }
          const owner = decodeURIComponent(segments[0]);
          const repo = decodeURIComponent(repoName.slice(0, -4));
          const protocol = req.headers.get('git-protocol') ?? '';
          const isV2 = protocol.includes('version=2');
          const result = handleInfoRefs(store, owner, repo, service, isV2);
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
          if (!repoExists(store)) {
            return notFound(id);
          }
          const body = Buffer.from(await req.arrayBuffer());
          const result =
            action === 'git-upload-pack'
              ? await handleUploadPack(store, body)
              : await handleReceivePack(store, body);
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

      return notFound(id);
    },
  };
}
