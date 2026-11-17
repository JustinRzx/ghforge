import { deflateSync, inflateSync, createDeflate } from 'node:zlib';

/** Inflates a zlib-compressed buffer synchronously. */
export function inflate(data: Buffer): Buffer {
  return inflateSync(data);
}

/** Deflates a buffer synchronously at zlib level 6. */
export function deflate(data: Buffer): Buffer {
  return deflateSync(data, { level: 6 });
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
  const stream = createDeflate({ level: 6, chunkSize: 65515 });
  stream.end(data);
  for await (const chunk of stream) {
    yield chunk as Buffer;
  }
}
