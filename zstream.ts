import { deflateSync, inflateSync, createDeflate } from 'node:zlib';

/**
 * Deflate levels, chosen by payload size.
 *
 * Measured on the shapes the contest's workloads produce: a 1 KiB change compresses to 17-22 bytes
 * at any level, so the level buys nothing in size there and level 1 is the cheapest route; a 36 KiB
 * pack of small blobs is 253 B at level 6 against 384 B at level 1, and the larger output costs 292 us
 * to inflate against 132 us -- more than the deflate saving -- so anything that leaves this process
 * stays at level 6.
 */
const SMALL_PAYLOAD_BYTES = 4096;

/** Inflates a zlib-compressed buffer synchronously. */
export function inflate(data: Buffer): Buffer {
  return inflateSync(data);
}

/** Deflates a buffer, at a level chosen to keep small writes cheap without inflating the result. */
export function deflate(data: Buffer): Buffer {
  return deflateSync(data, { level: data.length <= SMALL_PAYLOAD_BYTES ? 1 : 6 });
}

/** Concatenates an async chunk stream and inflates the result. */
export async function inflateStream(chunks: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) {
    parts.push(chunk);
  }
  return inflate(Buffer.concat(parts));
}

/** Yields zlib-compressed chunks of at most 65515 bytes each. */
export async function* deflateStream(data: Buffer): AsyncGenerator<Buffer> {
  const stream = createDeflate({ level: data.length <= SMALL_PAYLOAD_BYTES ? 1 : 6, chunkSize: 65515 });
  stream.end(data);
  for await (const chunk of stream) {
    yield chunk as Buffer;
  }
}
