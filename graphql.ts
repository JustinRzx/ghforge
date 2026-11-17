import type { ForgeStore } from './store.ts';
import type { Issue, MetaStoreInterface, Pull, Repo } from './meta.ts';
import { parseCommit } from './gitobj.ts';

/**
 * GitHub hands out an opaque global id: base64 of `<Type>:<databaseId>`. The counter this forge
 * stores is the databaseId, and `node(id:)` decodes back to it, so a round trip is reproducible and
 * the id a caller reads is never the bare databaseId.
 */
function toGlobalId(type: string, id: string | number): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

function fromGlobalId(globalId: string): { type: string; id: string } | null {
  const decoded = Buffer.from(globalId, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator <= 0) return null;
  return { type: decoded.slice(0, separator), id: decoded.slice(separator + 1) };
}

type TypeKind = 'SCALAR' | 'OBJECT' | 'ENUM' | 'LIST' | 'NON_NULL';

interface TypeRef {
  kind: TypeKind;
  name: string | null;
  ofType: TypeRef | null;
}

interface FieldDef {
  name: string;
  type: TypeRef;
}

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INPUT_OBJECT';
  name: string;
  fields?: FieldDef[];
  enumValues?: Array<{ name: string }>;
}

type TokenKind = 'Name' | 'Number' | 'String' | 'Punct' | 'EOF';

interface Token {
  kind: TokenKind;
  value: string;
  number?: number;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ key: string; value: ValueNode }> };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

interface FieldNode {
  kind: 'field';
  name: string;
  alias?: string;
  arguments: ArgumentNode[];
  selectionSet?: Selection[];
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition?: string;
  selectionSet: Selection[];
}

type Selection = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface VariableDefinition {
  name: string;
  type: string;
  defaultValue?: ValueNode;
}

interface OperationDefinition {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name?: string;
  variables: VariableDefinition[];
  selectionSet: Selection[];
}

interface FragmentDefinition {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: Selection[];
}

type Definition = OperationDefinition | FragmentDefinition;

const PUNCTUATORS = new Set(['{', '}', '(', ')', '[', ']', ':', ',', '$', '!', '=']);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index]!;

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\uFEFF') {
      index += 1;
      continue;
    }

    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }

    if (char === ',') {
      index += 1;
      continue;
    }

    if (char === '.' && source.slice(index, index + 3) === '...') {
      tokens.push({ kind: 'Punct', value: '...' });
      index += 3;
      continue;
    }

    if (PUNCTUATORS.has(char)) {
      tokens.push({ kind: 'Punct', value: char });
      index += 1;
      continue;
    }

    if (char === '"') {
      let end = index + 1;
      while (end < source.length) {
        const current = source[end]!;
        if (current === '\\') {
          end += 2;
          continue;
        }
        if (current === '"') break;
        end += 1;
      }
      const raw = source.slice(index, end + 1);
      let value = raw.slice(1, -1);
      try {
        value = JSON.parse(raw) as string;
      } catch {
        value = raw.slice(1, -1);
      }
      tokens.push({ kind: 'String', value });
      index = end + 1;
      continue;
    }

    if (char === '-' || (char >= '0' && char <= '9')) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index));
      if (!match) throw new Error(`Unexpected character "${char}"`);
      tokens.push({ kind: 'Number', value: match[0], number: Number(match[0]) });
      index += match[0].length;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(index));
      if (!match) throw new Error(`Unexpected character "${char}"`);
      tokens.push({ kind: 'Name', value: match[0] });
      index += match[0].length;
      continue;
    }

    throw new Error(`Unexpected character "${char}"`);
  }

  tokens.push({ kind: 'EOF', value: '' });
  return tokens;
}

class Parser {
  private position = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parseDocument(): Definition[] {
    const definitions: Definition[] = [];
    while (this.peek().kind !== 'EOF') {
      if (this.isPunct('{')) {
        definitions.push({
          kind: 'operation',
          operation: 'query',
          variables: [],
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation') {
        definitions.push(this.parseOperation(keyword));
      } else if (keyword === 'fragment') {
        definitions.push(this.parseFragment());
      } else {
        throw new Error(`Unexpected definition "${keyword}"`);
      }
    }
    return definitions;
  }

  private parseOperation(operation: 'query' | 'mutation'): OperationDefinition {
    let name: string | undefined;
    if (this.peek().kind === 'Name') name = this.expectName();
    const variables = this.isPunct('(') ? this.parseVariableDefinitions() : [];
    return {
      kind: 'operation',
      operation,
      name,
      variables,
      selectionSet: this.parseSelectionSet(),
    };
  }

  private parseFragment(): FragmentDefinition {
    const name = this.expectName();
    const on = this.expectName();
    if (on !== 'on') throw new Error('Expected "on" in fragment definition');
    const typeCondition = this.expectName();
    return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    this.expectPunct('(');
    const definitions: VariableDefinition[] = [];
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.isPunct('=')) {
        this.advance();
        defaultValue = this.parseValue();
      }
      definitions.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return definitions;
  }

  private parseType(): string {
    let type: string;
    if (this.isPunct('[')) {
      this.advance();
      type = `[${this.parseType()}]`;
    } else {
      type = this.expectName();
    }
    if (this.isPunct('!')) {
      this.advance();
      type += '!';
    }
    return type;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.isPunct('}')) selections.push(this.parseSelection());
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.isPunct('...')) {
      this.advance();
      if (this.peek().kind === 'Name' && this.peek().value === 'on') {
        this.advance();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'Name') {
        return { kind: 'spread', name: this.expectName() };
      }
      return { kind: 'inline', selectionSet: this.parseSelectionSet() };
    }

    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.isPunct(':')) {
      this.advance();
      alias = first;
      name = this.expectName();
    }
    const args = this.isPunct('(') ? this.parseArguments() : [];
    const selectionSet = this.isPunct('{') ? this.parseSelectionSet() : undefined;
    return { kind: 'field', name, alias, arguments: args, selectionSet };
  }

  private parseArguments(): ArgumentNode[] {
    this.expectPunct('(');
    const args: ArgumentNode[] = [];
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.peek();

    if (token.kind === 'Punct' && token.value === '$') {
      this.advance();
      return { kind: 'variable', name: this.expectName() };
    }

    if (token.kind === 'Punct' && token.value === '[') {
      this.advance();
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }

    if (token.kind === 'Punct' && token.value === '{') {
      this.advance();
      const fields: Array<{ key: string; value: ValueNode }> = [];
      while (!this.isPunct('}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields.push({ key, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }

    if (token.kind === 'String') {
      this.advance();
      return { kind: 'string', value: token.value };
    }

    if (token.kind === 'Number') {
      this.advance();
      return { kind: 'number', value: token.number ?? Number(token.value) };
    }

    if (token.kind === 'Name') {
      this.advance();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }

    throw new Error('Expected a value');
  }

  private peek(): Token {
    return this.tokens[this.position]!;
  }

  private advance(): Token {
    const token = this.tokens[this.position]!;
    this.position += 1;
    return token;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'Punct' && token.value === value;
  }

  private expectPunct(value: string): void {
    if (!this.isPunct(value)) throw new Error(`Expected "${value}"`);
    this.advance();
  }

  private expectName(): string {
    const token = this.peek();
    if (token.kind !== 'Name') throw new Error('Expected a name');
    this.advance();
    return token.value;
  }
}

function namedType(kind: TypeKind, name: string): TypeRef {
  return { kind, name, ofType: null };
}

function nonNull(ofType: TypeRef): TypeRef {
  return { kind: 'NON_NULL', name: null, ofType };
}

function listOf(ofType: TypeRef): TypeRef {
  return { kind: 'LIST', name: null, ofType };
}

function fieldDef(name: string, type: TypeRef): FieldDef {
  return { name, type };
}

const STRING = namedType('SCALAR', 'String');
const INT = namedType('SCALAR', 'Int');
const BOOLEAN = namedType('SCALAR', 'Boolean');

const ISSUE_TYPE: TypeDef = {
  kind: 'OBJECT',
  name: 'Issue',
  fields: [
    fieldDef('id', nonNull(STRING)),
    fieldDef('number', nonNull(INT)),
    fieldDef('title', nonNull(STRING)),
    fieldDef('state', nonNull(STRING)),
    fieldDef('body', STRING),
  ],
};

const PULL_REQUEST_TYPE: TypeDef = {
  kind: 'OBJECT',
  name: 'PullRequest',
  fields: [
    fieldDef('id', nonNull(STRING)),
    fieldDef('number', nonNull(INT)),
    fieldDef('headRefName', nonNull(STRING)),
    fieldDef('baseRefName', nonNull(STRING)),
    fieldDef('mergeable', namedType('ENUM', 'MergeableState')),
    fieldDef('state', nonNull(STRING)),
    fieldDef('merged', nonNull(BOOLEAN)),
    fieldDef('files', nonNull(namedType('OBJECT', 'PullRequestChangedFileConnection'))),
  ],
};

const REPOSITORY_TYPE: TypeDef = {
  kind: 'OBJECT',
  name: 'Repository',
  fields: [
    fieldDef('id', nonNull(STRING)),
    fieldDef('databaseId', INT),
    fieldDef('name', nonNull(STRING)),
    fieldDef('nameWithOwner', nonNull(STRING)),
    fieldDef('owner', namedType('OBJECT', 'User')),
    fieldDef('defaultBranchRef', namedType('OBJECT', 'Ref')),
    fieldDef('viewerPermission', nonNull(STRING)),
    fieldDef('hasIssuesEnabled', nonNull(BOOLEAN)),
    fieldDef('issue', namedType('OBJECT', 'Issue')),
    fieldDef('issues', namedType('OBJECT', 'IssueConnection')),
    fieldDef('pullRequests', namedType('OBJECT', 'PullRequestConnection')),
    fieldDef('pullRequest', namedType('OBJECT', 'PullRequest')),
  ],
};

const INPUT_TYPES: TypeDef[] = [
  {
    kind: 'INPUT_OBJECT',
    name: 'CreateIssueInput',
    fields: [
      fieldDef('repositoryId', nonNull(STRING)),
      fieldDef('title', nonNull(STRING)),
      fieldDef('body', STRING),
      fieldDef('labelIds', listOf(nonNull(STRING))),
    ],
  },
  {
    kind: 'INPUT_OBJECT',
    name: 'CloseIssueInput',
    fields: [fieldDef('issueId', nonNull(STRING))],
  },
  {
    kind: 'INPUT_OBJECT',
    name: 'CreatePullRequestInput',
    fields: [
      fieldDef('repositoryId', nonNull(STRING)),
      fieldDef('baseRefName', nonNull(STRING)),
      fieldDef('headRefName', nonNull(STRING)),
      fieldDef('title', nonNull(STRING)),
      fieldDef('body', STRING),
    ],
  },
  {
    kind: 'INPUT_OBJECT',
    name: 'MergePullRequestInput',
    fields: [
      fieldDef('pullRequestId', nonNull(STRING)),
      fieldDef('mergeMethod', STRING),
    ],
  },
  {
    kind: 'INPUT_OBJECT',
    name: 'AddCommentInput',
    fields: [
      fieldDef('subjectId', nonNull(STRING)),
      fieldDef('body', nonNull(STRING)),
    ],
  },
];

const SEARCH_TYPE: TypeDef = {
  kind: 'ENUM',
  name: 'SearchType',
  enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }, { name: 'PULL_REQUEST' }],
};

const QUERY_TYPE: TypeDef = {
  kind: 'OBJECT',
  name: 'Query',
  fields: [
    fieldDef('repository', namedType('OBJECT', 'Repository')),
    fieldDef('viewer', namedType('OBJECT', 'User')),
    // The Relay node read: an opaque global id resolves to the object it names.
    fieldDef('node', namedType('OBJECT', 'Node')),
  ],
};

/** The interface every node-resolvable object implements; only `id` is common. */
const NODE_TYPE: TypeDef = {
  kind: 'OBJECT',
  name: 'Node',
  fields: [fieldDef('id', nonNull(STRING))],
};

const SCHEMA_TYPES: TypeDef[] = [
  ...INPUT_TYPES,
  ISSUE_TYPE,
  PULL_REQUEST_TYPE,
  REPOSITORY_TYPE,
  SEARCH_TYPE,
  NODE_TYPE,
  QUERY_TYPE,
];

const INTERNAL_TYPES: TypeDef[] = [
  {
    kind: 'OBJECT',
    name: 'User',
    fields: [fieldDef('id', nonNull(STRING)), fieldDef('login', nonNull(STRING))],
  },
  {
    kind: 'OBJECT',
    name: 'Ref',
    fields: [
      fieldDef('name', nonNull(STRING)),
      fieldDef('target', namedType('OBJECT', 'GitObject')),
    ],
  },
  {
    kind: 'OBJECT',
    name: 'GitObject',
    fields: [fieldDef('oid', nonNull(STRING))],
  },
  {
    kind: 'ENUM',
    name: 'MergeableState',
    enumValues: [{ name: 'MERGEABLE' }, { name: 'CONFLICTING' }, { name: 'UNKNOWN' }],
  },
  {
    kind: 'OBJECT',
    name: 'PageInfo',
    fields: [
      fieldDef('hasNextPage', nonNull(BOOLEAN)),
      fieldDef('endCursor', namedType('SCALAR', 'String')),
    ],
  },
  {
    kind: 'OBJECT',
    name: 'IssueConnection',
    fields: [
      fieldDef('nodes', nonNull(listOf(nonNull(namedType('OBJECT', 'Issue'))))),
      fieldDef('totalCount', nonNull(INT)),
      fieldDef('pageInfo', nonNull(namedType('OBJECT', 'PageInfo'))),
    ],
  },
  {
    kind: 'OBJECT',
    name: 'PullRequestConnection',
    fields: [
      fieldDef('nodes', nonNull(listOf(nonNull(namedType('OBJECT', 'PullRequest'))))),
      fieldDef('totalCount', nonNull(INT)),
      fieldDef('pageInfo', nonNull(namedType('OBJECT', 'PageInfo'))),
    ],
  },
  {
    kind: 'OBJECT',
    name: 'PullRequestChangedFile',
    fields: [fieldDef('path', nonNull(STRING))],
  },
  {
    kind: 'OBJECT',
    name: 'PullRequestChangedFileConnection',
    fields: [
      fieldDef('nodes', nonNull(listOf(nonNull(namedType('OBJECT', 'PullRequestChangedFile'))))),
      fieldDef('totalCount', nonNull(INT)),
      fieldDef('pageInfo', nonNull(namedType('OBJECT', 'PageInfo'))),
    ],
  },
  {
    kind: 'OBJECT',
    name: 'Mutation',
    fields: [
      fieldDef('createPullRequest', namedType('OBJECT', 'CreatePullRequestPayload')),
      fieldDef('mergePullRequest', namedType('OBJECT', 'MergePullRequestPayload')),
      fieldDef('createIssue', namedType('OBJECT', 'CreateIssuePayload')),
      fieldDef('closeIssue', namedType('OBJECT', 'CloseIssuePayload')),
      fieldDef('addComment', namedType('OBJECT', 'AddCommentPayload')),
    ],
  },
  {
    kind: 'OBJECT',
    name: 'CreatePullRequestPayload',
    fields: [fieldDef('pullRequest', namedType('OBJECT', 'PullRequest'))],
  },
  {
    kind: 'OBJECT',
    name: 'MergePullRequestPayload',
    fields: [fieldDef('pullRequest', namedType('OBJECT', 'PullRequest'))],
  },
  {
    kind: 'OBJECT',
    name: 'CreateIssuePayload',
    fields: [fieldDef('issue', namedType('OBJECT', 'Issue'))],
  },
  {
    kind: 'OBJECT',
    name: 'CloseIssuePayload',
    fields: [fieldDef('issue', namedType('OBJECT', 'Issue'))],
  },
  {
    kind: 'OBJECT',
    name: 'AddCommentPayload',
    fields: [fieldDef('commentEdge', namedType('OBJECT', 'IssueCommentEdge'))],
  },
  {
    kind: 'OBJECT',
    name: 'IssueCommentEdge',
    fields: [fieldDef('node', namedType('OBJECT', 'IssueComment'))],
  },
  {
    kind: 'OBJECT',
    name: 'IssueComment',
    fields: [
      fieldDef('id', nonNull(STRING)),
      fieldDef('body', nonNull(STRING)),
    ],
  },
  {
    kind: 'OBJECT',
    name: '__Schema',
    fields: [
      fieldDef('queryType', namedType('OBJECT', '__Type')),
      fieldDef('types', listOf(nonNull(namedType('OBJECT', '__Type')))),
    ],
  },
  {
    kind: 'OBJECT',
    name: '__Type',
    fields: [
      fieldDef('kind', STRING),
      fieldDef('name', STRING),
      fieldDef('ofType', namedType('OBJECT', '__Type')),
      fieldDef('fields', listOf(nonNull(namedType('OBJECT', '__TypeField')))),
      fieldDef('enumValues', listOf(nonNull(namedType('OBJECT', '__EnumValue')))),
    ],
  },
  {
    kind: 'OBJECT',
    name: '__TypeField',
    fields: [
      fieldDef('name', STRING),
      fieldDef('type', namedType('OBJECT', '__Type')),
    ],
  },
  {
    kind: 'OBJECT',
    name: '__EnumValue',
    fields: [fieldDef('name', STRING)],
  },
];

const TYPE_DEFS = new Map<string, TypeDef>(
  [...SCHEMA_TYPES, ...INTERNAL_TYPES].map((type) => [type.name, type]),
);

const CONNECTION_ELEMENT_TYPES: Record<string, string> = {
  IssueConnection: 'Issue',
  PullRequestConnection: 'PullRequest',
};

/**
 * The login the bearer token acts as.
 *
 * The env passes only MAKEFUN_SHOP_TOKEN, never the login, so this falls back to the fixed
 * scenario's viewer login (see api.ts FALLBACK_LOGIN) unless an override is set.
 */
const tokenLogin = (): string =>
  process.env.MAKEFUN_SHOP_LOGIN || process.env.MAKEFUN_SHOP_OWNER || 'adaiversen';

interface ExecContext {
  store: ForgeStore;
  meta: MetaStoreInterface;
  /** The login the bearer token acts as: `viewer` resolves to this account. */
  login: string;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDefinition>;
}

interface ResolveInfo {
  typeName: string;
  fieldName: string;
  selectionSet: Selection[] | undefined;
}

type Resolver = (
  parent: any,
  args: Record<string, unknown>,
  context: ExecContext,
  info: ResolveInfo,
) => unknown;

class ExecutionError extends Error {
  readonly path: Array<string | number>;

  constructor(message: string, path: Array<string | number>) {
    super(message);
    this.path = path;
  }
}

function evaluateValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return Object.prototype.hasOwnProperty.call(variables, node.name)
        ? variables[node.name]
        : null;
    case 'string':
      return node.value;
    case 'number':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => evaluateValue(value, variables));
    case 'object':
      return Object.fromEntries(
        node.fields.map((entry) => [entry.key, evaluateValue(entry.value, variables)]),
      );
  }
}

function evaluateArguments(
  args: ArgumentNode[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const arg of args) result[arg.name] = evaluateValue(arg.value, variables);
  return result;
}

function buildVariables(
  operation: OperationDefinition,
  provided: Record<string, unknown>,
): Record<string, unknown> {
  const variables: Record<string, unknown> = {};
  for (const definition of operation.variables) {
    if (Object.prototype.hasOwnProperty.call(provided, definition.name)) {
      variables[definition.name] = provided[definition.name];
    } else if (definition.defaultValue) {
      variables[definition.name] = evaluateValue(definition.defaultValue, variables);
    } else {
      variables[definition.name] = null;
    }
  }
  return variables;
}

function typeMatches(typeName: string, condition: string | undefined): boolean {
  return condition === undefined || condition === typeName;
}

function collectFields(
  typeName: string,
  selections: Selection[],
  context: ExecContext,
  seen: Set<string> = new Set<string>(),
): FieldNode[] {
  const fields: FieldNode[] = [];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      fields.push(selection);
    } else if (selection.kind === 'spread') {
      if (seen.has(selection.name)) continue;
      seen.add(selection.name);
      const fragment = context.fragments.get(selection.name);
      if (fragment && typeMatches(typeName, fragment.typeCondition)) {
        fields.push(...collectFields(typeName, fragment.selectionSet, context, seen));
      }
    } else if (typeMatches(typeName, selection.typeCondition)) {
      fields.push(...collectFields(typeName, selection.selectionSet, context, seen));
    }
  }
  return fields;
}

function hasField(selections: Selection[], context: ExecContext, name: string): boolean {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === name) return true;
    } else if (selection.kind === 'spread') {
      const fragment = context.fragments.get(selection.name);
      if (fragment && hasField(fragment.selectionSet, context, name)) return true;
    } else if (hasField(selection.selectionSet, context, name)) {
      return true;
    }
  }
  return false;
}

function unwrapNamed(type: TypeRef): string | null {
  let current: TypeRef | null = type;
  while (current && (current.kind === 'LIST' || current.kind === 'NON_NULL')) {
    current = current.ofType;
  }
  return current ? current.name : null;
}

function childTypeFor(typeName: string, fieldName: string): string | null {
  if (typeName === 'Query' && fieldName === '__type') return '__Type';
  if (typeName === 'Query' && fieldName === '__schema') return '__Schema';
  const type = TYPE_DEFS.get(typeName);
  const field = type?.fields?.find((entry) => entry.name === fieldName);
  return field ? unwrapNamed(field.type) : null;
}

function toExecutionError(error: unknown, path: Array<string | number>): ExecutionError {
  if (error instanceof ExecutionError) return error;
  return new ExecutionError(error instanceof Error ? error.message : String(error), path);
}

function executeField(
  parent: unknown,
  typeName: string,
  field: FieldNode,
  context: ExecContext,
  path: Array<string | number>,
): unknown {
  if (field.name === '__typename') return typeName;

  const args = evaluateArguments(field.arguments, context.variables);
  const resolver = RESOLVERS[`${typeName}.${field.name}`];
  let value: unknown;

  try {
    if (resolver) {
      value = resolver(parent, args, context, {
        typeName,
        fieldName: field.name,
        selectionSet: field.selectionSet,
      });
    } else if (parent !== null && typeof parent === 'object') {
      const record = parent as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, field.name) && !RESOLVERS[`${typeName}.${field.name}`]) {
        throw new ExecutionError(`Cannot query field "${field.name}" on type "${typeName}".`, path);
      }
      value = record[field.name];
    } else {
      value = null;
    }
  } catch (error) {
    throw toExecutionError(error, path);
  }

  if (field.selectionSet) {
    if (value === null || value === undefined) return null;
    const declaredType = childTypeFor(typeName, field.name) ?? typeName;
    const childType = Array.isArray(value)
      ? CONNECTION_ELEMENT_TYPES[declaredType] ?? declaredType
      : declaredType;
    try {
      return executeSelectionSet(value, childType, field.selectionSet, context, path);
    } catch (error) {
      throw toExecutionError(error, path);
    }
  }

  return value === undefined ? null : value;
}

function executeSelectionSet(
  parent: unknown,
  typeName: string,
  selections: Selection[],
  context: ExecContext,
  path: Array<string | number>,
): unknown {
  if (Array.isArray(parent)) {
    return parent.map((item, index) =>
      executeSelectionSet(item, typeName, selections, context, [...path, index]),
    );
  }

  const result: Record<string, unknown> = {};
  // An interface-typed field (`node`) resolves to a concrete object: dispatch on the object's own
  // `__typename` so an inline fragment (`... on Repository { ... }`) selects that type's fields and
  // resolvers instead of the interface's.
  const declared = parent !== null && typeof parent === 'object'
    ? (parent as Record<string, unknown>).__typename
    : undefined;
  const effective = typeof declared === 'string' && declared !== '' ? declared : typeName;
  for (const field of collectFields(effective, selections, context)) {
    const responseKey = field.alias ?? field.name;
    result[responseKey] = executeField(parent, effective, field, context, [...path, responseKey]);
  }
  return result;
}

function executeOperation(
  operation: OperationDefinition,
  context: ExecContext,
): Record<string, unknown> {
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  const errors: Array<{ message: string; path: Array<string | number> }> = [];

  for (const field of collectFields(rootType, operation.selectionSet, context)) {
    const responseKey = field.alias ?? field.name;
    try {
      data[responseKey] = executeField(null, rootType, field, context, [responseKey]);
    } catch (error) {
      const executionError = toExecutionError(error, [responseKey]);
      errors.push({ message: executionError.message, path: executionError.path });
    }
  }

  return errors.length > 0 ? { errors } : { data };
}

function lookupType(name: string): Record<string, unknown> | null {
  const type = TYPE_DEFS.get(name);
  if (!type) return null;
  return {
    kind: type.kind,
    name: type.name,
    fields: type.fields
      ? type.fields.map((entry) => ({ name: entry.name, type: entry.type }))
      : null,
    enumValues: type.enumValues ? type.enumValues.map((entry) => ({ name: entry.name })) : null,
  };
}

function stateFilter(states: unknown): string | undefined {
  if (!Array.isArray(states) || states.length === 0) return undefined;
  const values = states
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toUpperCase());
  const hasOpen = values.includes('OPEN');
  const hasClosed = values.includes('CLOSED');
  if (hasOpen && !hasClosed) return 'open';
  if (hasClosed && !hasOpen) return 'closed';
  return undefined;
}

function pullStateFilter(states: unknown): string | undefined {
  if (!Array.isArray(states) || states.length === 0) return undefined;
  const values = states
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toUpperCase());
  if (values.length === 1) {
    if (values[0] === 'OPEN') return 'open';
    if (values[0] === 'CLOSED') return 'closed';
    if (values[0] === 'MERGED') return 'merged';
  }
  return undefined;
}

function sortByNumber<T extends { number: number }>(items: T[], orderBy: unknown): T[] {
  const sorted = [...items];
  let direction = 'DESC';
  if (orderBy && typeof orderBy === 'object' && !Array.isArray(orderBy)) {
    const value = (orderBy as Record<string, unknown>).direction;
    if (typeof value === 'string') direction = value.toUpperCase();
  }
  sorted.sort((a, b) =>
    direction === 'ASC'
      ? a.number - b.number || b.number - a.number
      : b.number - a.number || b.number - a.number,
  );
  return sorted;
}

function connectionResult<T>(
  items: T[],
  info: ResolveInfo,
  context: ExecContext,
  args: Record<string, unknown> = {},
): T[] | { nodes: T[]; totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  // Cursor paging: the cursor is the item's position in the ordered list, so `after` resumes exactly
  // where the previous page stopped and `endCursor` is stable for the same data.
  const first = typeof args.first === 'number' ? args.first : null;
  const after = typeof args.after === 'string' && args.after !== '' ? Number(args.after) : null;
  const start = after !== null && Number.isFinite(after) ? after + 1 : 0;
  const page = first === null ? items.slice(start) : items.slice(start, start + first);
  const hasNextPage = first !== null && start + first < items.length;
  const pageInfo = {
    hasNextPage,
    endCursor: page.length === 0 ? null : String(start + page.length - 1),
  };
  if (
    info.selectionSet &&
    (hasField(info.selectionSet, context, 'nodes') ||
      hasField(info.selectionSet, context, 'totalCount') ||
      hasField(info.selectionSet, context, 'pageInfo'))
  ) {
    return { nodes: page, totalCount: items.length, pageInfo };
  }
  return page;
}

interface MetaInternals {
  repos?: Map<string, Repo>;
  pulls?: Map<string, Pull>;
  issues?: Map<string, Issue>;
}

/** The repository a pull request belongs to, read from the store's `owner/repo/number` key. */
function locatePull(meta: MetaStoreInterface, pull: unknown): { owner: string; repo: string } | null {
  const internals = meta as unknown as MetaInternals;
  if (!(internals.pulls instanceof Map)) return null;
  const target = pull as { id?: unknown };
  for (const [key, candidate] of internals.pulls) {
    if (candidate === pull || (target.id !== undefined && candidate.id === target.id)) {
      const parts = key.split('/');
      if (parts[0] && parts[1]) return { owner: parts[0], repo: parts[1] };
    }
  }
  return null;
}

/** The tree object a branch name points at, or null. */
function treeOfRef(store: ForgeStore, ref: unknown): string | null {
  if (typeof ref !== 'string' || ref === '') return null;
  const sha = store.resolveRef(`refs/heads/${ref}`);
  if (sha === null) return null;
  const obj = store.getObject(sha);
  if (obj === null || obj.type !== 'commit') return null;
  try {
    return parseCommit(obj.body).tree;
  } catch {
    return null;
  }
}

/** Every path whose blob differs between two trees, walked recursively. */
function changedPaths(
  store: ForgeStore,
  baseTree: string | null,
  headTree: string | null,
): string[] {
  const out: string[] = [];
  const childMap = (
    tree: string | null,
  ): Map<string, { mode: string; sha: string }> => {
    if (tree === null) return new Map();
    try {
      return new Map(store.readTree(tree).map((entry) => [entry.name, entry]));
    } catch {
      return new Map();
    }
  };
  const isDir = (entry: { mode: string } | undefined): boolean =>
    entry !== undefined && (entry.mode === '40000' || entry.mode === '040000');
  const walk = (base: string | null, head: string | null, prefix: string): void => {
    const left = childMap(base);
    const right = childMap(head);
    for (const name of new Set<string>([...left.keys(), ...right.keys()])) {
      const l = left.get(name);
      const r = right.get(name);
      const path = prefix === '' ? name : `${prefix}/${name}`;
      if (isDir(l) || isDir(r)) {
        walk(isDir(l) ? (l as { sha: string }).sha : null, isDir(r) ? (r as { sha: string }).sha : null, path);
        continue;
      }
      if (l === undefined || r === undefined || l.sha !== r.sha) out.push(path);
    }
  };
  walk(baseTree, headTree, '');
  return out.sort();
}

/**
 * Locates a pull request from the global id a mutation input carries.
 *
 * GitHub hands out opaque global ids; this forge mints `<owner>/<name>#<number>` shaped ones
 * (see pullGlobalId), and falls back to scanning so an id minted any other way still resolves.
 */
function findPullById(meta: MetaStoreInterface, id: string): { owner: string; repo: string; number: number } | null {
  // A mutation input carries the opaque global id the caller read from us, so decode it back to the
  // stored databaseId before matching; anything that is not a global id is matched as given.
  const decoded = fromGlobalId(id);
  if (decoded !== null && decoded.type === 'PullRequest') id = decoded.id;
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(id);
  if (match) {
    const owner = match[1] as string;
    const repo = match[2] as string;
    const number = Number.parseInt(match[3] as string, 10);
    if (meta.getPull(owner, repo, number)) return { owner, repo, number };
  }
  // The map key is `owner/repo/number`, so the owning repository comes from the key.
  const internals = meta as unknown as MetaInternals;
  if (internals.pulls instanceof Map) {
    for (const [key, pull] of internals.pulls) {
      if (pull.id === id) {
        const parts = key.split('/');
        const owner = parts[0] ?? '';
        const repo = parts[1] ?? '';
        if (owner && repo) return { owner, repo, number: pull.number };
      }
    }
  }
  return null;
}

/** Locates an issue from the global id a mutation input carries; same id shape as pulls. */
function findIssueById(meta: MetaStoreInterface, id: string): { owner: string; repo: string; number: number } | null {
  const decoded = fromGlobalId(id);
  if (decoded !== null && decoded.type === 'Issue') id = decoded.id;
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(id);
  if (match) {
    const owner = match[1] as string;
    const repo = match[2] as string;
    const number = Number.parseInt(match[3] as string, 10);
    if (meta.getIssue(owner, repo, number)) return { owner, repo, number };
  }
  const internals = meta as unknown as MetaInternals;
  if (internals.issues instanceof Map) {
    for (const [key, issue] of internals.issues) {
      if (issue.id === id) {
        const parts = key.split('/');
        const owner = parts[0] ?? '';
        const repo = parts[1] ?? '';
        if (owner && repo) return { owner, repo, number: issue.number };
      }
    }
  }
  return null;
}

function findRepoById(meta: MetaStoreInterface, id: string): Repo | null {
  const decoded = fromGlobalId(id);
  if (decoded !== null && decoded.type === 'Repository') id = decoded.id;
  const internals = meta as unknown as MetaInternals;
  if (internals.repos) {
    for (const repo of internals.repos.values()) {
      if (repo.id === id) return repo;
    }
  }
  if (id.includes('/')) {
    const [owner, name] = id.split('/', 2);
    if (owner && name) return meta.getRepo(owner, name);
  }
  return null;
}

const RESOLVERS: Record<string, Resolver> = {
  // gh opens almost every session with viewer { login }: it must be the login the token acts as.
  'Query.viewer': (_parent, _args, context) => {
    const login = context.login;
    if (typeof login !== 'string' || login === '') return null;
    return context.meta.getUser(login) ?? context.meta.createUser(login);
  },
  'Query.node': (_parent, args, context) => {
    const globalId = typeof args.id === 'string' ? args.id : '';
    const decoded = fromGlobalId(globalId);
    if (decoded === null) return null;
    if (decoded.type === 'Repository') {
      const repo = findRepoById(context.meta, decoded.id);
      return repo === null ? null : { ...repo, __typename: 'Repository' };
    }
    if (decoded.type === 'Issue') {
      const located = findIssueById(context.meta, decoded.id);
      if (located === null) return null;
      const issue = context.meta.getIssue(located.owner, located.repo, located.number);
      return issue === null ? null : { ...issue, __typename: 'Issue' };
    }
    if (decoded.type === 'PullRequest') {
      const located = findPullById(context.meta, decoded.id);
      if (located === null) return null;
      const pull = context.meta.getPull(located.owner, located.repo, located.number);
      return pull === null ? null : { ...pull, __typename: 'PullRequest' };
    }
    return null;
  },
  'Query.repository': (_parent, args, context) => {
    const owner = typeof args.owner === 'string' ? args.owner : '';
    const name = typeof args.name === 'string' ? args.name : '';
    if (!owner || !name) return null;
    return context.meta.getRepo(owner, name);
  },
  'Query.__type': (_parent, args) => {
    const name = typeof args.name === 'string' ? args.name : '';
    return name ? lookupType(name) : null;
  },
  'Query.__schema': () => ({
    queryType: { name: 'Query' },
    types: SCHEMA_TYPES.map((type) => ({ kind: type.kind, name: type.name })),
  }),
  'Repository.id': (parent: Repo) => toGlobalId('Repository', parent.id),
  'Repository.databaseId': (parent: Repo) => {
    const numeric = Number(parent.id);
    return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
  },
  'Repository.name': (parent: Repo) => parent.name,
  'Repository.nameWithOwner': (parent: Repo) => parent.full_name,
  'Repository.owner': (parent: Repo) => parent.owner,
  'Repository.defaultBranchRef': (parent: Repo, _args, context) => ({
    name: parent.default_branch,
    target: {
      // The ref lives in this repository's own store, not the shared one.
      oid:
        context.meta.repoStore(parent.owner.login, parent.name).resolveRef(`refs/heads/${parent.default_branch}`) ??
        '',
    },
  }),
  'Repository.viewerPermission': () => 'ADMIN',
  'Repository.hasIssuesEnabled': () => true,
  'Repository.issue': (parent: Repo, args, context) => {
    const number = Number(args.number);
    if (!Number.isInteger(number)) return null;
    return context.meta.getIssue(parent.owner.login, parent.name, number);
  },
  'Repository.issues': (parent: Repo, args, context, info) => {
    const issues = context.meta.listIssues(parent.owner.login, parent.name, {
      state: stateFilter(args.states),
      page: 1,
      per_page: 10000,
    });
    return connectionResult(sortByNumber(issues, args.orderBy), info, context, args);
  },
  'Repository.pullRequests': (parent: Repo, args, context, info) => {
    const pulls = context.meta.listPulls(parent.owner.login, parent.name, {
      state: pullStateFilter(args.states),
    });
    return connectionResult(sortByNumber(pulls, args.orderBy), info, context, args);
  },
  'Repository.pullRequest': (parent: Repo, args, context) => {
    const number = Number(args.number);
    if (!Number.isInteger(number)) return null;
    return context.meta.getPull(parent.owner.login, parent.name, number);
  },
  'Issue.id': (parent: any) => toGlobalId('Issue', parent.id),
  'Issue.state': (parent: any) => String(parent.state).toUpperCase(),
  'PullRequest.id': (parent: any) => toGlobalId('PullRequest', parent.id),
  'PullRequest.headRefName': (parent: any) => parent.head?.ref ?? '',
  'PullRequest.baseRefName': (parent: any) => parent.base?.ref ?? '',
  // The schema's mergeable is the MergeableState enum, not a boolean: an entry that has no head or
  // base cannot be judged, which is UNKNOWN; otherwise the recorded bit decides.
  'PullRequest.mergeable': (parent: any) => {
    const head = parent?.head?.sha;
    const base = parent?.base?.sha;
    if (head === undefined || head === '' || base === undefined || base === '') return 'UNKNOWN';
    return parent.mergeable === true ? 'MERGEABLE' : 'CONFLICTING';
  },
  'PullRequest.state': (parent: any) => {
    // The recorded bit is the truth: a merged pull is MERGED even though its REST state closes.
    if (parent?.merged === true) return 'MERGED';
    const state = String(parent?.state ?? '').toLowerCase();
    return state === 'merged' ? 'MERGED' : state.toUpperCase();
  },
  'PullRequest.merged': (parent: any) => Boolean(parent.merged),
  'PullRequest.files': (parent: any, args, context, info) => {
    const located = locatePull(context.meta, parent);
    if (located === null) return connectionResult([], info, context, args);
    // The tree of each branch lives in this repository's own store, so the diff is real: a pull whose
    // head changed a path lists that path and nothing the two branches already share.
    const store = context.meta.repoStore(located.owner, located.repo);
    const paths = changedPaths(store, treeOfRef(store, parent?.base?.ref), treeOfRef(store, parent?.head?.ref));
    return connectionResult(paths.map((path) => ({ path })), info, context, args);
  },
  'Mutation.mergePullRequest': (_parent, args, context) => {
    const input = args.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { pullRequest: null };
    }
    const values = input as Record<string, unknown>;
    const pullId = typeof values.pullRequestId === 'string' ? values.pullRequestId : String(values.pullRequestId ?? '');
    const located = findPullById(context.meta, pullId);
    if (!located) return { pullRequest: null };
    const result = context.meta.mergePull(located.owner, located.repo, located.number);
    if ('error' in result) return { pullRequest: null };
    return { pullRequest: context.meta.getPull(located.owner, located.repo, located.number) };
  },

  'Mutation.createIssue': (_parent, args, context) => {
    const input = args.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { issue: null };
    }
    const values = input as Record<string, unknown>;
    const repositoryId = typeof values.repositoryId === 'string' ? values.repositoryId : String(values.repositoryId ?? '');
    const repo = findRepoById(context.meta, repositoryId);
    if (!repo) return { issue: null };
    const title = typeof values.title === 'string' ? values.title : '';
    if (title === '') return { issue: null };
    const issue = context.meta.createIssue(repo.owner.login, repo.name, {
      title,
      body: typeof values.body === 'string' ? values.body : undefined,
    });
    return { issue };
  },

  'Mutation.closeIssue': (_parent, args, context) => {
    const input = args.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { issue: null };
    }
    const values = input as Record<string, unknown>;
    const issueId = typeof values.issueId === 'string' ? values.issueId : String(values.issueId ?? '');
    const located = findIssueById(context.meta, issueId);
    if (!located) return { issue: null };
    const issue = context.meta.updateIssue(located.owner, located.repo, located.number, { state: 'closed' });
    return { issue };
  },

  'Mutation.addComment': (_parent, args, context) => {
    const input = args.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { commentEdge: null };
    }
    const values = input as Record<string, unknown>;
    const subjectId = typeof values.subjectId === 'string' ? values.subjectId : String(values.subjectId ?? '');
    const body = typeof values.body === 'string' ? values.body : '';
    if (body === '') return { commentEdge: null };

    // A comment subject is either an issue or a pull request; both are addressed by global id.
    const issue = findIssueById(context.meta, subjectId);
    if (issue) {
      const comment = context.meta.createIssueComment(issue.owner, issue.repo, issue.number, body);
      if (!comment) return { commentEdge: null };
      return { commentEdge: { node: { id: toGlobalId('IssueComment', comment.id), body: comment.body } } };
    }
    const pull = findPullById(context.meta, subjectId);
    if (pull) {
      const comment = context.meta.createIssueComment(pull.owner, pull.repo, pull.number, body);
      if (!comment) return { commentEdge: null };
      return { commentEdge: { node: { id: toGlobalId('IssueComment', comment.id), body: comment.body } } };
    }
    return { commentEdge: null };
  },

  'Mutation.createPullRequest': (_parent, args, context) => {
    const input = args.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { pullRequest: null };
    }
    const values = input as Record<string, unknown>;
    const repositoryId = typeof values.repositoryId === 'string' ? values.repositoryId : String(values.repositoryId ?? '');
    const repo = findRepoById(context.meta, repositoryId);
    if (!repo) return { pullRequest: null };
    const title = typeof values.title === 'string' ? values.title : '';
    const head = typeof values.headRefName === 'string' ? values.headRefName : '';
    const base = typeof values.baseRefName === 'string' ? values.baseRefName : '';
    if (!title || !head || !base) return { pullRequest: null };
    const pull = context.meta.createPull(repo.owner.login, repo.name, {
      title,
      head,
      base,
      body: typeof values.body === 'string' ? values.body : undefined,
    });
    return { pullRequest: pull };
  },
};

/**
 * Executes a minimal GraphQL request against the in-memory forge metadata and
 * git object store. Only POST requests carrying the configured bearer token
 * are accepted. The response is a standard `Response` containing JSON.
 */
export async function handleGraphQL(
  store: ForgeStore,
  meta: MetaStoreInterface,
  req: Request,
): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ message: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    });
  }

  const authorization = req.headers.get('authorization') ?? '';
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  if (!token || authorization !== `Bearer ${token}`) {
    return new Response(JSON.stringify({ message: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ message: 'Problems parsing JSON' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  // One `{query, variables}` object to one payload object. A batched request is an ARRAY of those
  // objects and answers an ARRAY of payloads, position for position, so the caller can pair them up.
  const runBody = (candidate: unknown): unknown => {
    const requestBody =
      candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>)
        : {};
    const query = typeof requestBody.query === 'string' ? requestBody.query : '';
    const providedVariables =
      requestBody.variables &&
      typeof requestBody.variables === 'object' &&
      !Array.isArray(requestBody.variables)
        ? (requestBody.variables as Record<string, unknown>)
        : {};

    let definitions: Definition[];
    try {
      definitions = new Parser(tokenize(query)).parseDocument();
    } catch (error) {
      return {
        errors: [
          {
            message: error instanceof Error ? error.message : String(error),
            path: [],
          },
        ],
      };
    }

    const operations = definitions.filter(
      (definition): definition is OperationDefinition => definition.kind === 'operation',
    );
    const fragments = new Map<string, FragmentDefinition>();
    for (const definition of definitions) {
      if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    }

    if (operations.length === 0) {
      return { errors: [{ message: 'No operation found', path: [] }] };
    }

    const results = operations.map((operation) => {
      const context: ExecContext = {
        store,
        meta,
        login: tokenLogin(),
        variables: buildVariables(operation, providedVariables),
        fragments,
      };
      return executeOperation(operation, context);
    });

    return results.length === 1 ? results[0] : results;
  };

  const batch = Array.isArray(body);
  const payload = batch ? (body as unknown[]).map((entry) => runBody(entry)) : runBody(body);
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
