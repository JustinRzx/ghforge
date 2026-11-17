import { createHash } from 'node:crypto';
import { deflate, inflate } from './zstream.ts';
import {
  hashObject,
  parseCommit,
  parseTree,
  type GitObjType,
} from './gitobj.ts';
import type { ForgeStore } from './store.ts';

/** The result of a smart-HTTP ref advertisement. */
export interface InfoRefsResult {
  status: number;
  body: Buffer;
  contentType: string;
}

interface AdvertisedRef {
  name: string;
  sha: string;
  raw: string | null;
}

interface PackObject {
  sha: string;
  type: GitObjType;
  body: Buffer;
}

interface PushCommand {
  old: string;
  new: string;
  ref: string;
}

interface RawPackEntry {
  start: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseSha?: string;
}

const ZERO_SHA = '0000000000000000000000000000000000000000';

const TYPE_BY_CODE: Record<number, GitObjType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

const CODE_BY_TYPE: Record<GitObjType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

/** Frames a payload as a git pkt-line with a four-byte hex length prefix. */
export function pktLine(s: string | Buffer): Buffer {
  const payload = typeof s === 'string' ? Buffer.from(s, 'utf8') : s;
  const length = payload.length + 4;
  if (length > 0xffff) {
    throw new Error('pkt-line payload too large');
  }
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

/** Returns the four-byte flush-packet marker. */
export function flushPkt(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** Returns the protocol-v2 delimiter-packet marker. */
export function delimPkt(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Parses a pkt-line stream, using null for flush and delimiter packets. */
export function parsePktLines(body: Buffer): Array<string | null> {
  const lines: Array<string | null> = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    const length = Number.parseInt(header, 16);
    if (!Number.isFinite(length) || length < 0) {
      throw new Error('malformed pkt-line length');
    }
    if (length === 0 || length === 1 || length === 2) {
      lines.push(null);
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) {
      throw new Error('truncated pkt-line');
    }
    lines.push(body.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  return lines;
}

function stripNewline(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

function resolvedRefs(store: ForgeStore, includeHead: boolean): AdvertisedRef[] {
  const result: AdvertisedRef[] = [];
  const seen = new Set<string>();
  if (includeHead) {
    const raw = store.getRef('HEAD');
    if (raw !== null) {
      const sha = store.resolveRef('HEAD');
      if (sha !== null) {
        result.push({ name: 'HEAD', sha, raw });
        seen.add('HEAD');
      }
    }
  }
  for (const entry of store.listRefs()) {
    if (seen.has(entry.name)) {
      continue;
    }
    const raw = store.getRef(entry.name);
    const sha = store.resolveRef(entry.name);
    if (sha === null) {
      continue;
    }
    result.push({ name: entry.name, sha, raw });
    seen.add(entry.name);
  }
  return result;
}

function peelSha(store: ForgeStore, sha: string): string | null {
  const obj = store.getObject(sha);
  if (obj === null || obj.type !== 'tag') {
    return null;
  }
  const firstLine = obj.body.toString('utf8').split('\n')[0];
  if (!firstLine.startsWith('object ')) {
    return null;
  }
  const peeled = firstLine.slice(7).trim();
  return /^[0-9a-f]{40}$/.test(peeled) ? peeled : null;
}

function uploadAdvertisement(store: ForgeStore, isV2: boolean): Buffer {
  if (isV2) {
    return Buffer.concat([
      pktLine('version 2\n'),
      pktLine('agent=ghforge/1.0\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow wait-for-done\n'),
      pktLine('object-format=sha1\n'),
      flushPkt(),
    ]);
  }

  const caps = 'side-band-64k ofs-delta symref=HEAD:refs/heads/main agent=ghforge/1.0';
  const refs = resolvedRefs(store, true);
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), flushPkt()];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_SHA} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.sha} ${ref.name}${suffix}\n`));
    });
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

function receiveAdvertisement(store: ForgeStore): Buffer {
  const caps = 'report-status side-band-64k delete-refs ofs-delta agent=ghforge/1.0';
  const refs = resolvedRefs(store, false);
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), flushPkt()];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_SHA} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.sha} ${ref.name}${suffix}\n`));
    });
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

/** Builds a smart-HTTP ref advertisement for the given service. */
export function handleInfoRefs(
  store: ForgeStore,
  _owner: string,
  _repo: string,
  service: string,
  isV2: boolean,
): InfoRefsResult {
  if (service === 'git-receive-pack') {
    return {
      status: 200,
      body: receiveAdvertisement(store),
      contentType: 'application/x-git-receive-pack-advertisement',
    };
  }
  return {
    status: 200,
    body: uploadAdvertisement(store, isV2),
    contentType: 'application/x-git-upload-pack-advertisement',
  };
}

function collectReachable(store: ForgeStore, roots: Iterable<string>): Map<string, PackObject> {
  const result = new Map<string, PackObject>();
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) {
      continue;
    }
    seen.add(sha);
    const obj = store.getObject(sha);
    if (obj === null) {
      continue;
    }
    result.set(sha, { sha, type: obj.type, body: obj.body });
    if (obj.type === 'commit') {
      let commit;
      try {
        commit = parseCommit(obj.body);
      } catch {
        continue;
      }
      stack.push(commit.tree);
      for (const parent of commit.parents) {
        stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      let entries;
      try {
        entries = parseTree(obj.body);
      } catch {
        continue;
      }
      for (const entry of entries) {
        stack.push(entry.sha);
      }
    } else if (obj.type === 'tag') {
      const line = obj.body.toString('utf8').split('\n')[0];
      if (line.startsWith('object ')) {
        stack.push(line.slice(7).trim());
      }
    }
  }
  return result;
}

function encodePackEntry(type: GitObjType, body: Buffer): Buffer {
  const typeCode = CODE_BY_TYPE[type];
  let size = body.length;
  const header: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) {
    first |= 0x80;
  }
  header.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) {
      byte |= 0x80;
    }
    header.push(byte);
  }
  return Buffer.concat([Buffer.from(header), deflate(body)]);
}

function buildPack(store: ForgeStore, wants: string[], haves: string[]): Buffer {
  const wanted = collectReachable(store, wants);
  const excluded = collectReachable(store, haves);
  const objects = [...wanted.values()].filter((obj) => !excluded.has(obj.sha));

  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);

  const parts: Buffer[] = [header];
  for (const obj of objects) {
    parts.push(encodePackEntry(obj.type, obj.body));
  }
  const body = Buffer.concat(parts);
  const checksum = createHash('sha1').update(body).digest();
  return Buffer.concat([body, checksum]);
}

function sideband(data: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const max = 65500;
  for (let offset = 0; offset < data.length; offset += max) {
    const chunk = data.subarray(offset, Math.min(offset + max, data.length));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return chunks;
}

function parseWantHave(lines: string[], prefix: 'want' | 'have'): string[] {
  const result: string[] = [];
  for (const line of lines) {
    if (!line.startsWith(`${prefix} `)) {
      continue;
    }
    const sha = line.slice(prefix.length + 1).trim().split(/\s+/)[0];
    if (/^[0-9a-f]{40}$/.test(sha)) {
      result.push(sha);
    }
  }
  return result;
}

function buildLsRefs(store: ForgeStore, lines: string[]): Buffer {
  const symrefs = lines.includes('symrefs');
  const peel = lines.includes('peel');
  const prefixes = lines
    .filter((line) => line.startsWith('ref-prefix '))
    .map((line) => line.slice('ref-prefix '.length).trim());

  const parts: Buffer[] = [];
  for (const ref of resolvedRefs(store, true)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) {
      continue;
    }
    let line = `${ref.sha} ${ref.name}`;
    if (symrefs && ref.raw !== null && ref.raw.startsWith('ref: ')) {
      line += ` symref-target:${ref.raw.slice(5).trim()}`;
    }
    if (peel) {
      const peeled = peelSha(store, ref.sha);
      if (peeled !== null) {
        line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

function buildFetchV2(store: ForgeStore, lines: string[]): Buffer {
  const wants = parseWantHave(lines, 'want');
  const haves = parseWantHave(lines, 'have');
  const pack = buildPack(store, wants, haves);
  return Buffer.concat([pktLine('packfile\n'), ...sideband(pack), flushPkt()]);
}

function buildFetchV0(store: ForgeStore, lines: string[]): Buffer {
  const wants = parseWantHave(lines, 'want');
  const haves = parseWantHave(lines, 'have');
  const pack = buildPack(store, wants, haves);
  return Buffer.concat([pktLine('NAK\n'), ...sideband(pack), flushPkt()]);
}

/** Handles a git-upload-pack POST body, supporting both protocol v0 and v2. */
export async function handleUploadPack(store: ForgeStore, body: Buffer): Promise<Buffer> {
  const parsed = parsePktLines(body);
  const lines = parsed
    .filter((line): line is string => line !== null)
    .map(stripNewline);

  const commandLine = lines.find((line) => line.startsWith('command='));
  if (commandLine !== undefined) {
    const command = commandLine.slice('command='.length).trim();
    if (command === 'ls-refs') {
      return buildLsRefs(store, lines);
    }
    if (command === 'fetch') {
      return buildFetchV2(store, lines);
    }
    return flushPkt();
  }
  return buildFetchV0(store, lines);
}

function parseReceiveRequest(body: Buffer): { commands: PushCommand[]; caps: Set<string>; pack: Buffer } {
  const commands: PushCommand[] = [];
  let caps = new Set<string>();
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    const length = Number.parseInt(header, 16);
    if (!Number.isFinite(length) || length < 0) {
      throw new Error('malformed pkt-line length');
    }
    if (length === 0 || length === 1 || length === 2) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) {
      throw new Error('truncated pkt-line');
    }
    const text = stripNewline(body.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;

    let commandText = text;
    if (commands.length === 0) {
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        commandText = text.slice(0, nul);
        caps = new Set(text.slice(nul + 1).trim().split(/\s+/).filter(Boolean));
      }
    }
    const fields = commandText.split(' ');
    if (fields.length < 3) {
      continue;
    }
    commands.push({
      old: fields[0],
      new: fields[1],
      ref: fields.slice(2).join(' '),
    });
  }
  return { commands, caps, pack: body.subarray(offset) };
}

function inflateAt(data: Buffer, offset: number, end: number): { output: Buffer; next: number } {
  const remaining = data.subarray(offset, end);
  const output = inflate(remaining);
  let low = 2;
  let high = remaining.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      inflate(remaining.subarray(0, mid));
      high = mid;
    } catch {
      low = mid + 1;
    }
  }
  return { output, next: offset + low };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let byte = delta[offset++];
    let value = byte & 0x7f;
    let shift = 7;
    while ((byte & 0x80) !== 0) {
      byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    return value;
  };

  const baseSize = readVarint();
  if (baseSize !== base.length) {
    throw new Error('delta base size mismatch');
  }
  const resultSize = readVarint();
  const result = Buffer.allocUnsafe(resultSize);
  let outOffset = 0;

  while (offset < delta.length) {
    const opcode = delta[offset++];
    if ((opcode & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if ((opcode & 0x01) !== 0) copyOffset += delta[offset++];
      if ((opcode & 0x02) !== 0) copyOffset += delta[offset++] * 2 ** 8;
      if ((opcode & 0x04) !== 0) copyOffset += delta[offset++] * 2 ** 16;
      if ((opcode & 0x08) !== 0) copyOffset += delta[offset++] * 2 ** 24;
      if ((opcode & 0x10) !== 0) copySize += delta[offset++];
      if ((opcode & 0x20) !== 0) copySize += delta[offset++] * 2 ** 8;
      if ((opcode & 0x40) !== 0) copySize += delta[offset++] * 2 ** 16;
      if (copySize === 0) {
        copySize = 0x10000;
      }
      base.copy(result, outOffset, copyOffset, copyOffset + copySize);
      outOffset += copySize;
    } else if (opcode !== 0) {
      const length = opcode & 0x7f;
      delta.copy(result, outOffset, offset, offset + length);
      outOffset += length;
      offset += length;
    } else {
      throw new Error('invalid delta opcode');
    }
  }

  if (outOffset !== resultSize) {
    throw new Error('delta result size mismatch');
  }
  return result;
}

function readPack(data: Buffer): PackObject[] {
  if (data.length < 32 || data.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('bad pack header');
  }
  const version = data.readUInt32BE(4);
  if (version !== 2 && version !== 3) {
    throw new Error('unsupported pack version');
  }
  const count = data.readUInt32BE(8);
  const end = data.length - 20;
  const checksum = data.subarray(end);
  const actual = createHash('sha1').update(data.subarray(0, end)).digest();
  if (!actual.equals(checksum)) {
    throw new Error('pack checksum mismatch');
  }

  let offset = 12;
  const raw: RawPackEntry[] = [];
  for (let index = 0; index < count; index++) {
    const start = offset;
    let byte = data[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = data[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }

    let baseOffset: number | undefined;
    let baseSha: string | undefined;
    if (typeCode === 6) {
      let baseByte = data[offset++];
      let distance = baseByte & 0x7f;
      while ((baseByte & 0x80) !== 0) {
        baseByte = data[offset++];
        distance = (distance + 1) * 128 + (baseByte & 0x7f);
      }
      baseOffset = start - distance;
    } else if (typeCode === 7) {
      baseSha = data.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (TYPE_BY_CODE[typeCode] === undefined) {
      throw new Error(`unsupported pack object type ${typeCode}`);
    }

    const { output, next } = inflateAt(data, offset, end);
    offset = next;
    if (output.length !== size) {
      throw new Error('pack object size mismatch');
    }
    raw.push({ start, typeCode, size, data: output, baseOffset, baseSha });
  }
  if (offset !== end) {
    throw new Error('pack trailing data');
  }

  const byOffset = new Map<number, PackObject>();
  const bySha = new Map<string, PackObject>();
  const resolved = new Set<number>();

  for (const entry of raw) {
    const type = TYPE_BY_CODE[entry.typeCode];
    if (type !== undefined) {
      const obj: PackObject = { sha: hashObject(type, entry.data), type, body: entry.data };
      byOffset.set(entry.start, obj);
      bySha.set(obj.sha, obj);
      resolved.add(entry.start);
    }
  }

  let progress = true;
  while (progress) {
    progress = false;
    for (const entry of raw) {
      if (resolved.has(entry.start)) {
        continue;
      }
      let base: PackObject | undefined;
      if (entry.typeCode === 6 && entry.baseOffset !== undefined) {
        base = byOffset.get(entry.baseOffset);
      } else if (entry.typeCode === 7 && entry.baseSha !== undefined) {
        base = bySha.get(entry.baseSha);
      }
      if (base === undefined) {
        continue;
      }
      const body = applyDelta(base.body, entry.data);
      const obj: PackObject = { sha: hashObject(base.type, body), type: base.type, body };
      byOffset.set(entry.start, obj);
      bySha.set(obj.sha, obj);
      resolved.add(entry.start);
      progress = true;
    }
  }

  if (resolved.size !== raw.length) {
    throw new Error('delta base missing');
  }
  return raw.map((entry) => byOffset.get(entry.start) as PackObject);
}

function receiveResponse(unpackLine: string, results: string[]): Buffer {
  const inner = Buffer.concat([
    pktLine(unpackLine),
    ...results.map((line) => pktLine(line)),
    flushPkt(),
  ]);
  return Buffer.concat([...sideband(inner), flushPkt()]);
}

/** Handles a git-receive-pack POST body, unpacking and applying pushes. */
export async function handleReceivePack(store: ForgeStore, body: Buffer): Promise<Buffer> {
  let parsed;
  try {
    parsed = parseReceiveRequest(body);
  } catch {
    return receiveResponse('unpack error\n', []);
  }

  const { commands, caps, pack } = parsed;

  let objects: PackObject[] = [];
  if (pack.length > 0) {
    try {
      objects = readPack(pack);
    } catch {
      return receiveResponse(
        'unpack error\n',
        commands.map((command) => `ng ${command.ref} unpacker error\n`),
      );
    }
  }

  for (const obj of objects) {
    store.putObject(obj.type, obj.body);
  }

  const results: string[] = [];
  for (const command of commands) {
    if (command.new === ZERO_SHA) {
      if (!caps.has('delete-refs')) {
        results.push(`ng ${command.ref} deletion prohibited\n`);
        continue;
      }
      store.deleteRef(command.ref);
      results.push(`ok ${command.ref}\n`);
      continue;
    }

    if (command.old !== ZERO_SHA && !store.isAncestor(command.old, command.new)) {
      results.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }

    try {
      store.setRef(command.ref, command.new);
      results.push(`ok ${command.ref}\n`);
    } catch {
      results.push(`ng ${command.ref} non-fast-forward\n`);
    }
  }

  return receiveResponse('unpack ok\n', results);
}
