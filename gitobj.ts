import { createHash } from 'node:crypto';
import { deflate, inflate } from './zstream.ts';

/** The four canonical git object types. */
export type GitObjType = 'blob' | 'tree' | 'commit' | 'tag';

/** A single entry in a git tree object. */
export interface TreeEntry {
  /** Octal file mode, e.g. "100644" or "40000". */
  mode: string;
  /** Entry basename. */
  name: string;
  /** 40-character lowercase hex object id. */
  sha: string;
}

/** The parsed contents of a git commit object. */
export interface CommitObject {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Builds the canonical `<type> <length>\0` header for an object body. */
function objectHeader(type: GitObjType, body: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${type} ${body.length}\0`, 'utf8'),
    body,
  ]);
}

/** Computes the SHA-1 hex object id of a git object. */
export function hashObject(type: GitObjType, body: Buffer): string {
  return createHash('sha1').update(objectHeader(type, body)).digest('hex');
}

/** Encodes a git object as a zlib-deflated header plus body. */
export function encodeObject(type: GitObjType, body: Buffer): Buffer {
  return deflate(objectHeader(type, body));
}

/** Decodes a zlib-deflated git object into its type and body. */
export function decodeObject(raw: Buffer): { type: GitObjType; body: Buffer } {
  const data = inflate(raw);
  const nul = data.indexOf(0);
  if (nul < 0) {
    throw new Error('malformed git object header');
  }
  const header = data.subarray(0, nul).toString('utf8');
  const space = header.indexOf(' ');
  if (space < 0) {
    throw new Error('malformed git object header');
  }
  const type = header.slice(0, space) as GitObjType;
  if (type !== 'blob' && type !== 'tree' && type !== 'commit' && type !== 'tag') {
    throw new Error(`unknown git object type: ${type}`);
  }
  const size = Number(header.slice(space + 1));
  const body = data.subarray(nul + 1);
  if (!Number.isInteger(size) || size !== body.length) {
    throw new Error('git object size mismatch');
  }
  return { type, body };
}

/** Parses the raw body of a git tree into ordered entries. */
export function parseTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) {
      throw new Error('malformed tree entry mode');
    }
    const rawMode = body.subarray(offset, space).toString('utf8');
    const nul = body.indexOf(0, space + 1);
    if (nul < 0) {
      throw new Error('malformed tree entry name');
    }
    const name = body.subarray(space + 1, nul).toString('utf8');
    const shaStart = nul + 1;
    const shaEnd = shaStart + 20;
    if (shaEnd > body.length) {
      throw new Error('truncated tree entry sha');
    }
    const sha = body.subarray(shaStart, shaEnd).toString('hex');
    entries.push({ mode: rawMode.replace(/^0+(?=\d)/, ''), name, sha });
    offset = shaEnd;
  }
  return entries;
}

/** Compares tree entry names the way git sorts them. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const aKey = a.mode === '40000' || a.mode === '040000' ? `${a.name}/` : a.name;
  const bKey = b.mode === '40000' || b.mode === '040000' ? `${b.name}/` : b.name;
  return Buffer.compare(Buffer.from(aKey, 'utf8'), Buffer.from(bKey, 'utf8'));
}

/** Encodes tree entries into a git tree body, sorted by git's ordering. */
export function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const mode = entry.mode.replace(/^0+(?=\d)/, '');
    parts.push(
      Buffer.from(`${mode} ${entry.name}\0`, 'utf8'),
      Buffer.from(entry.sha, 'hex'),
    );
  }
  return Buffer.concat(parts);
}

/** Parses a git commit body into its tree, parents, identities, and message. */
export function parseCommit(body: Buffer): CommitObject {
  const text = body.toString('utf8');
  const separator = text.indexOf('\n\n');
  const headerText = separator < 0 ? text : text.slice(0, separator);
  const message = separator < 0 ? '' : text.slice(separator + 2);

  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';

  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) {
      tree = line.slice(5);
    } else if (line.startsWith('parent ')) {
      parents.push(line.slice(7));
    } else if (line.startsWith('author ')) {
      author = line.slice(7);
    } else if (line.startsWith('committer ')) {
      committer = line.slice(10);
    }
  }

  return { tree, parents, author, committer, message };
}

/** Encodes a commit object into its canonical git body. */
export function encodeCommit(c: CommitObject): Buffer {
  const lines = [
    `tree ${c.tree}`,
    ...c.parents.map((parent) => `parent ${parent}`),
    `author ${c.author}`,
    `committer ${c.committer}`,
  ];
  return Buffer.from(`${lines.join('\n')}\n\n${c.message}`, 'utf8');
}
