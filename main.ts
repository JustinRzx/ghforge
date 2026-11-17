// The entry <-> env lifecycle: bind an ephemeral port, tell the env the port, then poll until the
// env says the trial is over and exit 0. The suite scores the forge that app.ts builds; this file is
// only the lifecycle around it.
//
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing to talk to, so the
//      program exits 1 at once.
//   2. Create the app and listen(0): the kernel picks a free port. Never bind 8080 -- the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address the request came
//      from plus N as the base URL and dials it from then on. A 409 means another entry already
//      registered; this process keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env answers at once
//      ({"done": false} while the suite runs), so this is a poll, not a long-held request.
//   5. Close the server and exit 0. The harness then stops the env, which writes the export the
//      scorer reads.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createApp } from './app.ts';
import { ForgeStore } from './store.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** The body of a request that carries none, so a read never allocates a Buffer. */
const EMPTY_BODY = Buffer.alloc(0);

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

/** A promise that settles after `ms` milliseconds. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from RETRY_INITIAL_MS, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/** POST the bound port until the env accepts it. 409 means a first register already won. */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/**
 * Adapts one node:http request to the fetch Request the app expects.
 *
 * The app only ever reads a request's method, url, headers and body, so this builds a plain object
 * with that shape instead of a real fetch Request: constructing one costs two allocations and a
 * header-map copy per call, which dominates a benchmark that issues thousands of small requests.
 */
function toRequest(req: IncomingMessage, body: Buffer): Request {
  const method = req.method ?? 'GET';
  const raw = req.headers;
  const headers = {
    get(name: string): string | null {
      const value = raw[name.toLowerCase()];
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) return value.join(',');
      return null;
    },
  };

  return {
    method,
    // The synthetic URL keeps the caller's own Host (address AND port), so anything the app derives
    // from `url.origin` -- a pagination Link header above all -- stays on the entry's origin. A
    // hardcoded host drops the port and the suite refuses a Link that leaves its origin.
    url: `http://${raw.host ?? '127.0.0.1'}${req.url ?? '/'}`,
    headers,
    arrayBuffer: async (): Promise<ArrayBuffer> =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    text: async (): Promise<string> => body.toString('utf8'),
    json: async (): Promise<unknown> => JSON.parse(body.toString('utf8')),
  } as unknown as Request;
}

/** Adapt one node:http request to a fetch Response, so the app stays framework-free. */
async function handle(appFetch: (req: Request) => Promise<Response>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const method = req.method ?? 'GET';
    let body = EMPTY_BODY;
    if (method !== 'GET' && method !== 'HEAD') {
      const chunks: import('node:buffer').Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as import('node:buffer').Buffer);
      body = chunks.length === 0 ? EMPTY_BODY : Buffer.concat(chunks);
    }

    const request = toRequest(req, body);

    const response = await appFetch(request);
    res.statusCode = response.status;
    for (const [key, value] of response.headers) res.setHeader(key, value);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: err instanceof Error ? err.message : 'internal error' }));
  }
}

/** Bound the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const { fetch: appFetch } = createApp(new ForgeStore());
  const server = createServer((req, res) => {
    void handle(appFetch, req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
