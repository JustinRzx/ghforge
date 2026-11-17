import {
  hashObject,
  parseTree,
  parseCommit,
  type GitObjType,
  type TreeEntry,
} from './gitobj.ts';

/** An in-memory git object database and ref namespace. */
export class ForgeStore {
  private objects = new Map<string, { type: GitObjType; body: Buffer }>();
  private refs = new Map<string, string>();

  /** Stores an object body, returning its computed SHA-1 id. */
  putObject(type: GitObjType, body: Buffer): string {
    const sha = hashObject(type, body);
    if (!this.objects.has(sha)) {
      this.objects.set(sha, { type, body: Buffer.from(body) });
    }
    return sha;
  }

  /** Reports whether an object id exists in the store. */
  hasObject(sha: string): boolean {
    return this.objects.has(sha);
  }

  /** Returns the object for an id, or null if it is absent. */
  getObject(sha: string): { type: GitObjType; body: Buffer } | null {
    return this.objects.get(sha) ?? null;
  }

  /** Returns the raw stored value of a ref, or null if it is absent. */
  getRef(name: string): string | null {
    return this.refs.get(name) ?? null;
  }

  /** Sets a ref, allowing only new refs or fast-forward updates. */
  setRef(name: string, sha: string): void {
    const old = this.refs.get(name);
    if (old !== undefined && old !== sha) {
      const oldSha = old.startsWith('ref: ') ? this.resolveRef(old.slice(5).trim()) : old;
      const same = oldSha === sha;
      if (!same && !(oldSha !== null && this.isAncestor(oldSha, sha))) {
        throw new Error('non-fast-forward');
      }
    }
    this.refs.set(name, sha);
  }

  /** Removes a ref if it exists. */
  deleteRef(name: string): void {
    this.refs.delete(name);
  }

  /** Lists refs, optionally filtered by name prefix. */
  listRefs(prefix?: string): Array<{ name: string; sha: string }> {
    const result: Array<{ name: string; sha: string }> = [];
    for (const [name, sha] of this.refs) {
      if (prefix === undefined || name.startsWith(prefix)) {
        result.push({ name, sha });
      }
    }
    return result;
  }

  /** Resolves a ref name through symbolic `ref: ...` chains to an object id. */
  resolveRef(name: string): string | null {
    let current = this.refs.get(name);
    const seen = new Set<string>();
    while (current !== undefined) {
      if (!current.startsWith('ref: ')) {
        return current;
      }
      if (seen.has(current)) {
        return null;
      }
      seen.add(current);
      const target = current.slice(5).trim();
      current = this.refs.get(target);
    }
    return null;
  }

  /** Reports whether commit `a` is reachable from commit `b` through parents. */
  isAncestor(a: string, b: string): boolean {
    if (a === b) {
      return true;
    }
    const seen = new Set<string>();
    const stack = [b];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha)) {
        continue;
      }
      seen.add(sha);
      if (sha === a) {
        return true;
      }
      const obj = this.objects.get(sha);
      if (!obj || obj.type !== 'commit') {
        continue;
      }
      for (const parent of parseCommit(obj.body).parents) {
        stack.push(parent);
      }
    }
    return false;
  }

  /** Walks commits from a start id, returning ids in parent-first breadth order. */
  walkCommits(startSha: string, limit?: number): string[] {
    if (limit !== undefined && limit <= 0) {
      return [];
    }
    const result: string[] = [];
    const seen = new Set<string>();
    const queue = [startSha];
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (seen.has(sha)) {
        continue;
      }
      seen.add(sha);
      result.push(sha);
      if (limit !== undefined && result.length >= limit) {
        break;
      }
      const obj = this.objects.get(sha);
      if (!obj || obj.type !== 'commit') {
        continue;
      }
      for (const parent of parseCommit(obj.body).parents) {
        if (!seen.has(parent)) {
          queue.push(parent);
        }
      }
    }
    return result;
  }

  /** Reads and parses a tree object, returning entries or an empty array. */
  readTree(sha: string): TreeEntry[] {
    const obj = this.objects.get(sha);
    if (!obj || obj.type !== 'tree') {
      return [];
    }
    return parseTree(obj.body);
  }

  /** Reads a blob body, or null when the id is missing or not a blob. */
  readBlob(sha: string): Buffer | null {
    const obj = this.objects.get(sha);
    if (!obj || obj.type !== 'blob') {
      return null;
    }
    return obj.body;
  }
}
