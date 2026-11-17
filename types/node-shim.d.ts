// Minimal ambient declarations for the Node.js globals this entry uses.
//
// The grader runs the forge with `node --experimental-strip-types`, which erases types without
// installing any package. There is no @types/node in the pod and no package install is allowed, so
// this file declares just enough of the runtime surface to keep `tsc --noEmit` clean. Nothing here
// runs: it is types only, and it is never imported.

declare const process: {
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
  version: string;
  platform: string;
};

declare const setTimeout: (handler: () => void, ms?: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;

declare class Buffer extends Uint8Array {
  static from(input: string | ArrayBuffer | ArrayBufferView | number[], encoding?: string): Buffer;
  static concat(list: Buffer[], totalLength?: number): Buffer;
  static alloc(size: number): Buffer;
  static allocUnsafe(size: number): Buffer;
  static compare(a: Buffer, b: Buffer): number;
  static byteLength(input: string | Buffer, encoding?: string): number;
  toString(encoding?: string, start?: number, end?: number): string;
  subarray(start?: number, end?: number): Buffer;
  slice(start?: number, end?: number): Buffer;
  write(string: string, offset?: number, encoding?: string): number;
  copy(target: Buffer, targetStart?: number, sourceStart?: number, sourceEnd?: number): number;
  equals(other: Buffer): boolean;
  compare(other: Buffer): number;
  readUInt32BE(offset?: number): number;
  writeUInt32BE(value: number, offset?: number): number;
  readUInt16BE(offset?: number): number;
  writeUInt16BE(value: number, offset?: number): number;
  readUInt8(offset?: number): number;
  writeUInt8(value: number, offset?: number): number;
  length: number;
}

declare class Headers {
  constructor(init?: Record<string, string> | Array<[string, string]>);
  set(key: string, value: string): void;
  get(key: string): string | null;
  has(key: string): boolean;
  delete(key: string): void;
  entries(): IterableIterator<[string, string]>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

declare class AbortSignal {
  static timeout(ms: number): AbortSignal;
  readonly aborted: boolean;
}

declare class Request {
  constructor(input: string, init?: {
    method?: string;
    headers?: Headers | Record<string, string>;
    body?: Buffer | string | null;
  });
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

declare class Response {
  constructor(body?: Buffer | string | null, init?: {
    status?: number;
    headers?: Headers | Record<string, string>;
  });
  readonly status: number;
  readonly ok: boolean;
  readonly statusText: string;
  readonly headers: Headers;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

declare function fetch(input: string, init?: {
  method?: string;
  headers?: Headers | Record<string, string>;
  body?: Buffer | string | null;
  signal?: AbortSignal;
}): Promise<Response>;

declare class URLSearchParams {
  constructor(init?: string);
  get(name: string): string | null;
  has(name: string): boolean;
  set(name: string, value: string): void;
  append(name: string, value: string): void;
  toString(): string;
  entries(): IterableIterator<[string, string]>;
}

declare class URL {
  constructor(input: string, base?: string);
  readonly origin: string;
  readonly protocol: string;
  readonly host: string;
  pathname: string;
  search: string;
  hash: string;
  readonly searchParams: URLSearchParams;
  toString(): string;
}

declare function structuredClone<T>(value: T): T;

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare module 'node:http' {
  import type { Buffer } from 'node:buffer';
  export interface IncomingMessage extends AsyncIterable<Buffer> {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
  }
  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string | number | string[]): void;
    end(chunk?: Buffer | string): void;
    writeHead(status: number, headers?: Record<string, string>): void;
  }
  export interface AddressInfo {
    port: number;
    address: string;
    family: string;
  }
  export interface Server {
    listen(port: number, hostname?: string, callback?: () => void): Server;
    address(): AddressInfo | string | null;
    close(callback?: () => void): void;
    once(event: string, listener: (...args: never[]) => void): Server;
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
}

declare module 'node:crypto' {
  import type { Buffer } from 'node:buffer';
  export function randomBytes(size: number): Buffer;
  export function createHash(algorithm: string): {
    update(data: Buffer | string): { digest(encoding: 'hex'): string; digest(): Buffer };
    digest(encoding: 'hex'): string;
    digest(): Buffer;
  };
  export function createHmac(algorithm: string, key: Buffer | string): {
    update(data: Buffer | string): { digest(encoding?: string): Buffer | string };
    digest(encoding?: string): Buffer | string;
  };
  export function timingSafeEqual(a: Buffer, b: Buffer): boolean;
}

declare module 'node:buffer' {
  export { Buffer };
  export const constants: Record<string, number>;
}

declare module 'node:zlib' {
  import type { Buffer } from 'node:buffer';
  export function deflateSync(data: Buffer, options?: { level?: number }): Buffer;
  export function inflateSync(data: Buffer): Buffer;
  export function deflateRawSync(data: Buffer, options?: { level?: number }): Buffer;
  export function inflateRawSync(data: Buffer): Buffer;
  export interface ZlibStream extends AsyncIterable<Buffer> {
    end(data?: Buffer | string): void;
    write(data: Buffer | string): boolean;
    on(event: string, listener: (...args: never[]) => void): ZlibStream;
    once(event: string, listener: (...args: never[]) => void): ZlibStream;
    close(): void;
  }
  export function createDeflate(options?: { level?: number; chunkSize?: number }): ZlibStream;
  export function createInflate(options?: { chunkSize?: number }): ZlibStream;
  export function createDeflateRaw(options?: { level?: number; chunkSize?: number }): ZlibStream;
  export function createInflateRaw(options?: { chunkSize?: number }): ZlibStream;
}

declare module 'node:url' {
  export class URL {
    constructor(input: string, base?: string);
    pathname: string;
    search: string;
    readonly searchParams: URLSearchParams;
    toString(): string;
  }
  export class URLSearchParams {
    constructor(init?: string);
    get(name: string): string | null;
    has(name: string): boolean;
    toString(): string;
  }
}
