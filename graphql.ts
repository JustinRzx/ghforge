import type { ForgeStore } from './store.ts';
import type { MetaStoreInterface, Repo } from './meta.ts';

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
  kind: 'OBJECT' | 'ENUM' | 'SCALAR';
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
    fieldDef('mergeable', nonNull(BOOLEAN)),
    fieldDef('state', nonNull(STRING)),
    fieldDef('merged', nonNull(BOOLEAN)),
    fieldDef('files', nonNull(listOf(nonNull(STRING)))),
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

const SEARCH_TYPE: TypeDef = {
  kind: 'ENUM',
  name: 'SearchType',
  enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }, { name: 'PULL_REQUEST' }],
};

const QUERY_TYPE: TypeDef = {
  kind: 'OBJECT',
  name: 'Query',
  fields: [fieldDef('repository', namedType('OBJECT', 'Repository'))],
};

const SCHEMA_TYPES: TypeDef[] = [
  ISSUE_TYPE,
  PULL_REQUEST_TYPE,
  REPOSITORY_TYPE,
  SEARCH_TYPE,
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
    kind: 'OBJECT',
    name: 'IssueConnection',
    fields: [
      fieldDef('nodes', nonNull(listOf(nonNull(namedType('OBJECT', 'Issue'))))),
      fieldDef('totalCount', nonNull(INT)),
    ],
  },
  {
    kind: 'OBJECT',
    name: 'PullRequestConnection',
    fields: [
      fieldDef('nodes', nonNull(listOf(nonNull(namedType('OBJECT', 'PullRequest'))))),
      fieldDef('totalCount', nonNull(INT)),
    ],
  },
  {
    kind: 'OBJECT',
    name: 'Mutation',
    fields: [fieldDef('createPullRequest', namedType('OBJECT', 'CreatePullRequestPayload'))],
  },
  {
    kind: 'OBJECT',
    name: 'CreatePullRequestPayload',
    fields: [fieldDef('pullRequest', namedType('OBJECT', 'PullRequest'))],
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

interface ExecContext {
  store: ForgeStore;
  meta: MetaStoreInterface;
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
  for (const field of collectFields(typeName, selections, context)) {
    const responseKey = field.alias ?? field.name;
    result[responseKey] = executeField(parent, typeName, field, context, [...path, responseKey]);
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
): T[] | { nodes: T[]; totalCount: number } {
  if (
    info.selectionSet &&
    (hasField(info.selectionSet, context, 'nodes') ||
      hasField(info.selectionSet, context, 'totalCount'))
  ) {
    return { nodes: items, totalCount: items.length };
  }
  return items;
}

interface MetaInternals {
  repos?: Map<string, Repo>;
}

function findRepoById(meta: MetaStoreInterface, id: string): Repo | null {
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
  'Repository.id': (parent: Repo) => parent.id,
  'Repository.databaseId': (parent: Repo) => {
    const numeric = Number(parent.id);
    return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
  },
  'Repository.name': (parent: Repo) => parent.name,
  'Repository.nameWithOwner': (parent: Repo) => parent.full_name,
  'Repository.owner': (parent: Repo) => parent.owner,
  'Repository.defaultBranchRef': (_parent: Repo, _args, context) => ({
    name: 'main',
    target: {
      oid:
        context.store.resolveRef('refs/heads/main') ??
        context.store.getRef('refs/heads/main') ??
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
    return connectionResult(sortByNumber(issues, args.orderBy), info, context);
  },
  'Repository.pullRequests': (parent: Repo, args, context, info) => {
    const pulls = context.meta.listPulls(parent.owner.login, parent.name, {
      state: pullStateFilter(args.states),
    });
    return connectionResult(sortByNumber(pulls, args.orderBy), info, context);
  },
  'Repository.pullRequest': (parent: Repo, args, context) => {
    const number = Number(args.number);
    if (!Number.isInteger(number)) return null;
    return context.meta.getPull(parent.owner.login, parent.name, number);
  },
  'Issue.id': (parent: any) => parent.id,
  'Issue.state': (parent: any) => String(parent.state).toUpperCase(),
  'PullRequest.id': (parent: any) => parent.id,
  'PullRequest.headRefName': (parent: any) => parent.head?.ref ?? '',
  'PullRequest.baseRefName': (parent: any) => parent.base?.ref ?? '',
  'PullRequest.mergeable': (parent: any) => Boolean(parent.mergeable),
  'PullRequest.state': (parent: any) => {
    const state = String(parent.state).toLowerCase();
    return state === 'merged' ? 'MERGED' : state.toUpperCase();
  },
  'PullRequest.merged': (parent: any) => Boolean(parent.merged),
  'PullRequest.files': (parent: any) => (Array.isArray(parent.files) ? parent.files : []),
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

  const requestBody =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
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
    return new Response(
      JSON.stringify({
        errors: [
          {
            message: error instanceof Error ? error.message : String(error),
            path: [],
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  const operations = definitions.filter(
    (definition): definition is OperationDefinition => definition.kind === 'operation',
  );
  const fragments = new Map<string, FragmentDefinition>();
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
  }

  if (operations.length === 0) {
    return new Response(
      JSON.stringify({ errors: [{ message: 'No operation found', path: [] }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  const results = operations.map((operation) => {
    const context: ExecContext = {
      store,
      meta,
      variables: buildVariables(operation, providedVariables),
      fragments,
    };
    return executeOperation(operation, context);
  });

  const payload = results.length === 1 ? results[0] : results;
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
