/**
 * A reply the router can hand back without building a `Response`.
 *
 * The app's own contract is tiny: a status, some headers and a body. Building a fetch `Response`
 * and then reading it back through `arrayBuffer()` costs a stream allocation and a full copy of the
 * body on every request -- measured at ~31 microseconds, which is the same order as the whole
 * handler for a small JSON reply, and a real memcpy for a git pack. A reply carries the same three
 * things directly, so `main.ts` can write it to the socket in one call.
 *
 * `Response` remains the return type for anything that genuinely needs one (the GraphQL and MCP
 * handlers build their own), so the router's return type is the union of the two.
 */
export interface ForgeReply {
  readonly forgeReply: true;
  readonly status: number;
  readonly headers: Record<string, string>;
  /** A string for JSON surfaces, a Buffer for the git pack surfaces. */
  readonly body: string | Buffer;
}

/** True for a reply this module made, so a caller can fast-path it. */
export function isForgeReply(value: unknown): value is ForgeReply {
  return typeof value === 'object' && value !== null && (value as ForgeReply).forgeReply === true;
}

/** Builds a reply from its status, headers and body. */
export function reply(
  status: number,
  headers: Record<string, string>,
  body: string | Buffer,
): ForgeReply {
  return { forgeReply: true, status, headers, body };
}
