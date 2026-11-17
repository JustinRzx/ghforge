import { encodeCommit, parseCommit } from './gitobj.ts';
import { ForgeStore } from './store.ts';

/** A forge user record. */
export interface User {
  id: string;
  login: string;
}

/** The owner half of a repository. */
export interface RepoOwner {
  login: string;
  id: string;
}

/** A repository record. */
export interface Repo {
  id: string;
  name: string;
  full_name: string;
  owner: RepoOwner;
  description: string | null;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  has_issues: boolean;
}

/** A repository label record. */
export interface Label {
  id: string;
  name: string;
  color: string;
  description: string | null;
}

/** An issue record. */
/** One comment on an issue or a pull request. */
export interface IssueComment {
  id: string;
  body: string;
  user: { login: string };
  created_at: string;
}

/** A label as the REST API renders it: only the name is required by the suite's shape. */
export interface IssueLabelView {
  name: string;
  color?: string;
  description?: string | null;
}

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  user: { login: string };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

/** A pull request record. */
export interface Pull {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'merged' | 'closed';
  merged: boolean;
  merged_at: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: { login: string };
  created_at: string;
  mergeable: boolean;
  files: [];
}

/** Input to create a repository. */
export interface CreateRepoInput {
  name: string;
  description?: string;
  private?: boolean;
  owner: RepoOwner;
}

/** Patch accepted by updateRepo. */
export interface UpdateRepoPatch {
  description?: string;
  private?: boolean;
  name?: string;
}

/** Input to create a label. */
export interface CreateLabelInput {
  name: string;
  color?: string;
  description?: string;
}

/** Input to create an issue. */
export interface CreateIssueInput {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

/** Filters and pagination for listing issues. */
export interface ListIssuesInput {
  state?: string;
  page?: number;
  per_page?: number;
}

/** Patch accepted by updateIssue. */
export interface UpdateIssuePatch {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  labels?: string[];
}

/** Input to create a pull request. */
export interface CreatePullInput {
  title: string;
  head: string;
  base: string;
  body?: string;
}

/** Filters for listing pulls. */
export interface ListPullsInput {
  state?: string;
}

/** The result of a merge operation. */
export type MergePullResult =
  | { sha: string; merged: true; message: string }
  | { error: 'not_found' | 'conflict' };

/** The metadata store contract shared by REST and MCP surfaces. */
export interface MetaStoreInterface {
  repoStore(owner: string, name: string): ForgeStore;
  createRepo(input: CreateRepoInput): Repo;
  getRepo(owner: string, name: string): Repo | null;
  listRepos(owner: string): Repo[];
  updateRepo(owner: string, name: string, patch: UpdateRepoPatch): Repo | null;
  deleteRepo(owner: string, name: string): boolean;
  createLabel(owner: string, repo: string, input: CreateLabelInput): Label;
  getLabel(owner: string, repo: string, name: string): Label | null;
  listLabels(owner: string, repo: string): Label[];
  createIssue(owner: string, repo: string, input: CreateIssueInput): Issue | null;
  getIssue(owner: string, repo: string, number: number): Issue | null;
  listIssues(owner: string, repo: string, input: ListIssuesInput): Issue[];
  updateIssue(owner: string, repo: string, number: number, patch: UpdateIssuePatch): Issue | null;
  createPull(owner: string, repo: string, input: CreatePullInput): Pull | null;
  getPull(owner: string, repo: string, number: number): Pull | null;
  listPulls(owner: string, repo: string, input: ListPullsInput): Pull[];
  mergePull(owner: string, repo: string, number: number): MergePullResult;
  createIssueComment(owner: string, repo: string, number: number, body: string, login?: string): IssueComment | null;
  listIssueComments(owner: string, repo: string, number: number): IssueComment[];
  createUser(login: string): User;
  getUser(login: string): User | null;
}

const repoKey = (owner: string, name: string): string => `${owner}/${name}`;
const labelKey = (owner: string, repo: string, name: string): string =>
  `${owner}/${repo}/${name}`;
const issueKey = (owner: string, repo: string, number: number): string =>
  `${owner}/${repo}/${number}`;
const pullKey = (owner: string, repo: string, number: number): string =>
  `${owner}/${repo}/${number}`;

/** In-memory repository metadata: repos, labels, issues, pulls, and users. */
export class MetaStore implements MetaStoreInterface {
  private store: ForgeStore;
  /**
   * One git object store per repository, keyed by `owner/name`.
   *
   * Git history must not leak between repositories: a suite that creates two repositories and
   * pushes to one must not see those refs from the other. The constructor's store stays as the
   * shared fallback so a caller that never creates a repository still has one to read.
   */
  private stores = new Map<string, ForgeStore>();
  private repos = new Map<string, Repo>();
  private labels = new Map<string, Label>();
  private issues = new Map<string, Issue>();
  private pulls = new Map<string, Pull>();
  /** Issue and pull-request comments, keyed by `owner/repo#number` and kept in insertion order. */
  private comments = new Map<string, IssueComment[]>();
  private commentSeq = 0;
  private users = new Map<string, User>();
  private issueNumbers = new Map<string, number>();
  private pullNumbers = new Map<string, number>();
  private seq = 1;

  /** Creates a metadata store backed by the given git object store. */
  constructor(store: ForgeStore) {
    this.store = store;
  }

  /** Allocates the next stable string id. */
  private nextId(): string {
    return String(this.seq++);
  }

  /** Returns the next issue number for a repository, starting at 1. */
  private nextIssueNumber(owner: string, repo: string): number {
    const key = repoKey(owner, repo);
    const n = (this.issueNumbers.get(key) ?? 0) + 1;
    this.issueNumbers.set(key, n);
    return n;
  }

  /** Returns the next pull number for a repository, starting at 1. */
  private nextPullNumber(owner: string, repo: string): number {
    const key = repoKey(owner, repo);
    const n = (this.pullNumbers.get(key) ?? 0) + 1;
    this.pullNumbers.set(key, n);
    return n;
  }

  /** Builds a commit identity line for the given login. */
  private ident(login: string): string {
    const ts = Math.floor(Date.now() / 1000);
    return `${login} <${login}@users.noreply.ghforge> ${ts} +0000`;
  }

  /** Creates a repository, throwing when the name is taken for that owner. */
  createRepo(input: CreateRepoInput): Repo {
    const { owner } = input;
    const key = repoKey(owner.login, input.name);
    if (this.repos.has(key)) {
      throw new Error('name already exists');
    }
    const now = new Date().toISOString();
    const repo: Repo = {
      id: this.nextId(),
      name: input.name,
      full_name: `${owner.login}/${input.name}`,
      owner: { login: owner.login, id: owner.id },
      description: input.description ?? null,
      private: input.private ?? false,
      default_branch: 'main',
      created_at: now,
      updated_at: now,
      has_issues: true,
    };
    this.repos.set(key, repo);
    return repo;
  }

  /**
   * The git object store that belongs to one repository.
   *
   * Every repository gets its own store on first use, so refs, objects and history stay isolated
   * the way GitHub's do. An unknown repository also gets one: callers check `getRepo` first when
   * absence matters.
   */
  repoStore(owner: string, name: string): ForgeStore {
    const key = repoKey(owner, name);
    let existing = this.stores.get(key);
    if (existing === undefined) {
      existing = new ForgeStore();
      this.stores.set(key, existing);
    }
    return existing;
  }

  /** Returns a repository by owner and name, or null. */
  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(repoKey(owner, name)) ?? null;
  }

  /** Lists repositories owned by the given login. */
  listRepos(owner: string): Repo[] {
    const result: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner.login === owner) {
        result.push(repo);
      }
    }
    return result;
  }

  /** Updates a repository's description, visibility, or name. */
  updateRepo(owner: string, name: string, patch: UpdateRepoPatch): Repo | null {
    const key = repoKey(owner, name);
    const repo = this.repos.get(key);
    if (!repo) {
      return null;
    }
    if (patch.description !== undefined) {
      repo.description = patch.description;
    }
    if (patch.private !== undefined) {
      repo.private = patch.private;
    }
    if (patch.name !== undefined && patch.name !== name) {
      const newKey = repoKey(owner, patch.name);
      if (this.repos.has(newKey)) {
        throw new Error('name already exists');
      }
      this.repos.delete(key);
      repo.name = patch.name;
      repo.full_name = `${owner}/${patch.name}`;
      this.repos.set(newKey, repo);
    }
    repo.updated_at = new Date().toISOString();
    return repo;
  }

  /** Deletes a repository and all of its labels, issues, and pulls. */
  deleteRepo(owner: string, name: string): boolean {
    const key = repoKey(owner, name);
    if (!this.repos.delete(key)) {
      return false;
    }
    const prefix = `${key}/`;
    for (const k of [...this.labels.keys()]) {
      if (k.startsWith(prefix)) this.labels.delete(k);
    }
    for (const k of [...this.issues.keys()]) {
      if (k.startsWith(prefix)) this.issues.delete(k);
    }
    for (const k of [...this.pulls.keys()]) {
      if (k.startsWith(prefix)) this.pulls.delete(k);
    }
    return true;
  }

  /** Creates a label for a repository. */
  createLabel(owner: string, repo: string, input: CreateLabelInput): Label {
    const label: Label = {
      id: this.nextId(),
      name: input.name,
      color: input.color ?? 'ededed',
      description: input.description ?? null,
    };
    this.labels.set(labelKey(owner, repo, input.name), label);
    return label;
  }

  /** Returns a label by name, or null. */
  getLabel(owner: string, repo: string, name: string): Label | null {
    return this.labels.get(labelKey(owner, repo, name)) ?? null;
  }

  /** Lists all labels for a repository. */
  listLabels(owner: string, repo: string): Label[] {
    const prefix = `${owner}/${repo}/`;
    const result: Label[] = [];
    for (const [key, label] of this.labels) {
      if (key.startsWith(prefix)) result.push(label);
    }
    return result;
  }

  /** Creates an issue, returning null when a named label does not exist. */
  createIssue(owner: string, repo: string, input: CreateIssueInput): Issue | null {
    if (!this.repos.has(repoKey(owner, repo))) {
      return null;
    }
    const names = input.labels ?? [];
    for (const name of names) {
      if (!this.labels.has(labelKey(owner, repo, name))) {
        return null;
      }
    }
    const now = new Date().toISOString();
    const number = this.nextIssueNumber(owner, repo);
    const issue: Issue = {
      id: this.nextId(),
      number,
      title: input.title,
      body: input.body ?? null,
      state: 'open',
      labels: names,
      user: { login: owner },
      created_at: now,
      updated_at: now,
      closed_at: null,
    };
    this.issues.set(issueKey(owner, repo, number), issue);
    return issue;
  }

  /** Returns an issue by number, or null. */
  getIssue(owner: string, repo: string, number: number): Issue | null {
    return this.issues.get(issueKey(owner, repo, number)) ?? null;
  }

  /**
   * Adds a comment to an issue or a pull request.
   *
   * Both kinds of subject share one comment list, because GitHub's AddComment mutation addresses
   * either by global id and the two never collide on `owner/repo#number`.
   */
  createIssueComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
    login = 'ghost',
  ): IssueComment | null {
    if (this.issues.get(issueKey(owner, repo, number)) === null && this.pulls.get(pullKey(owner, repo, number)) === null) {
      return null;
    }
    this.commentSeq += 1;
    const comment: IssueComment = {
      id: `${owner}/${repo}#${number}/comment/${this.commentSeq}`,
      body,
      user: { login },
      created_at: new Date().toISOString(),
    };
    const key = issueKey(owner, repo, number);
    const existing = this.comments.get(key);
    if (existing === undefined) this.comments.set(key, [comment]);
    else existing.push(comment);
    return comment;
  }

  /** Every comment on an issue or a pull request, oldest first. */
  listIssueComments(owner: string, repo: string, number: number): IssueComment[] {
    return (this.comments.get(issueKey(owner, repo, number)) ?? []).slice();
  }

  /** Lists issues with optional state filter and pagination. */
  listIssues(owner: string, repo: string, input: ListIssuesInput): Issue[] {
    const all: Issue[] = [];
    const prefix = `${owner}/${repo}/`;
    for (const [key, issue] of this.issues) {
      if (!key.startsWith(prefix)) continue;
      if (input.state && input.state !== 'all' && issue.state !== input.state) continue;
      all.push(issue);
    }
    all.sort((a, b) => b.number - a.number);
    const page = input.page ?? 1;
    const perPage = input.per_page ?? 30;
    const start = (page - 1) * perPage;
    return all.slice(start, start + perPage);
  }

  /** Updates an issue, returning null when it does not exist. */
  updateIssue(owner: string, repo: string, number: number, patch: UpdateIssuePatch): Issue | null {
    const issue = this.issues.get(issueKey(owner, repo, number));
    if (!issue) {
      return null;
    }
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.labels !== undefined) issue.labels = patch.labels;
    if (patch.state !== undefined) {
      issue.state = patch.state;
      issue.closed_at = patch.state === 'closed' ? new Date().toISOString() : null;
    }
    issue.updated_at = new Date().toISOString();
    return issue;
  }

  /** Creates a pull request reading head/base shas from git refs. */
  createPull(owner: string, repo: string, input: CreatePullInput): Pull | null {
    if (!this.repos.has(repoKey(owner, repo))) {
      return null;
    }
    const gitStore = this.repoStore(owner, repo);
    const headSha = gitStore.resolveRef(`refs/heads/${input.head}`) ?? '';
    const baseSha = gitStore.resolveRef(`refs/heads/${input.base}`) ?? '';
    const now = new Date().toISOString();
    const number = this.nextPullNumber(owner, repo);
    const pull: Pull = {
      id: this.nextId(),
      number,
      title: input.title,
      body: input.body ?? null,
      state: 'open',
      merged: false,
      merged_at: null,
      head: { ref: input.head, sha: headSha },
      base: { ref: input.base, sha: baseSha },
      user: { login: owner },
      created_at: now,
      mergeable: headSha !== '' && baseSha !== '',
      files: [],
    };
    this.pulls.set(pullKey(owner, repo, number), pull);
    return pull;
  }

  /** Returns a pull request by number, or null. */
  getPull(owner: string, repo: string, number: number): Pull | null {
    return this.pulls.get(pullKey(owner, repo, number)) ?? null;
  }

  /** Lists pull requests with optional state filter. */
  listPulls(owner: string, repo: string, input: ListPullsInput): Pull[] {
    const prefix = `${owner}/${repo}/`;
    const result: Pull[] = [];
    for (const [key, pull] of this.pulls) {
      if (!key.startsWith(prefix)) continue;
      if (input.state && input.state !== 'all' && pull.state !== input.state) continue;
      result.push(pull);
    }
    result.sort((a, b) => b.number - a.number);
    return result;
  }

  /** Squash-merges a pull request into its base branch. */
  mergePull(owner: string, repo: string, number: number): MergePullResult {
    const pull = this.pulls.get(pullKey(owner, repo, number));
    if (!pull) {
      return { error: 'not_found' };
    }
    const headSha = this.store.resolveRef(`refs/heads/${pull.head.ref}`);
    const baseSha = this.store.resolveRef(`refs/heads/${pull.base.ref}`);
    if (headSha === null || baseSha === null) {
      return { error: 'conflict' };
    }
    const headObj = this.store.getObject(headSha);
    if (headObj === null || headObj.type !== 'commit') {
      return { error: 'conflict' };
    }
    const tree = parseCommit(headObj.body).tree;
    const ident = this.ident(owner);
    const message = `Merge pull request #${number} from ${owner}/${pull.head.ref}`;
    const commit = encodeCommit({
      tree,
      parents: [baseSha],
      author: ident,
      committer: ident,
      message,
    });
    const sha = this.store.putObject('commit', commit);
    try {
      this.store.setRef(`refs/heads/${pull.base.ref}`, sha);
    } catch {
      return { error: 'conflict' };
    }
    pull.state = 'merged';
    pull.merged = true;
    pull.merged_at = new Date().toISOString();
    pull.head.sha = headSha;
    pull.base.sha = sha;
    return { sha, merged: true, message: 'Pull Request successfully merged' };
  }

  /** Creates a user idempotently, preserving a stable id. */
  createUser(login: string): User {
    const existing = this.users.get(login);
    if (existing) {
      return existing;
    }
    const user: User = { id: this.nextId(), login };
    this.users.set(login, user);
    return user;
  }

  /** Returns a user by login, or null. */
  getUser(login: string): User | null {
    return this.users.get(login) ?? null;
  }
}
