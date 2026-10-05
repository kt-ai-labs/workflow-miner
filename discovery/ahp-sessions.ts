import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_PROTOCOL_VERSIONS } from '@microsoft/agent-host-protocol';
import {
  AhpClient,
  type AhpTransport,
  type JsonRpcMessage,
  type TransportFrame,
} from '@microsoft/agent-host-protocol/client';
import WebSocket, { type RawData } from 'ws';

type EndpointEntry = {
  schemaVersion: 2;
  type: 'editor' | 'standalone';
  pid: number;
  instanceId: string;
  protocolVersion: string;
  connectionToken: string;
  endpoint:
    | { type: 'socket'; path: string }
    | { type: 'tcp'; host: string; port: number };
};

type Options = {
  userDataDir?: string;
  productName: string;
  includes: string[];
  excludes: string[];
  providers: string[];
  projects: string[];
  sort: 'modified' | 'created' | 'provider' | 'project' | 'title';
  json: boolean;
};

type SessionRow = {
  host: string;
  provider: string;
  project: string;
  title: string;
  createdAt: string;
  modifiedAt: string;
  workingDirectories: string[];
  resource: string;
};

class NodeWebSocketTransport implements AhpTransport {
  private readonly queue: Array<TransportFrame | null> = [];
  private waiter:
    | {
        resolve: (value: TransportFrame | null) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  private closed = false;
  private failure: Error | undefined;

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        const buffer = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer);
        this.push({ kind: 'binary', data: new Uint8Array(buffer) });
      } else {
        this.push({ kind: 'text', text: data.toString() });
      }
    });

    socket.on('close', () => {
      this.closed = true;
      this.push(null);
    });

    socket.on('error', error => {
      this.failure = error;
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter.reject(error);
      }
    });
  }

  static async connect(url: string): Promise<NodeWebSocketTransport> {
    const socket = new WebSocket(url);

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    return new NodeWebSocketTransport(socket);
  }

  async send(message: JsonRpcMessage | string): Promise<void> {
    const payload = typeof message === 'string' ? message : JSON.stringify(message);

    await new Promise<void>((resolve, reject) => {
      this.socket.send(payload, error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  recv(): Promise<TransportFrame | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift() ?? null);
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve(null);

    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  close(): void {
    if (!this.closed) this.socket.close();
  }

  private push(frame: TransportFrame | null): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve(frame);
    } else {
      this.queue.push(frame);
    }
  }
}

function usage(): never {
  console.log([
    'Usage: npm run discovery:ahp -- [options]',
    '',
    '  --user-data-dir <path>  Explicit VS Code user-data directory.',
    '  --product-name <name>   VS Code product directory name (default: Code).',
    '  --include <path>        Keep sessions under this path. Repeatable.',
    '  --exclude <path>        Remove sessions under this path. Repeatable.',
    '  --provider <id>         Filter provider. Repeatable.',
    '  --project <text>        Filter project display name. Repeatable.',
    '  --sort <field>          modified | created | provider | project | title.',
    '  --json                  Print JSON instead of a table.',
  ].join('\n'));
  process.exit(0);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    productName: 'Code',
    includes: [],
    excludes: [],
    providers: [],
    projects: [],
    sort: 'modified',
    json: false,
  };

  const valueAfter = (index: number): string => {
    const value = argv[index + 1];
    if (!value) throw new Error(argv[index] + ' requires a value');
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--help':
        usage();
      case '--user-data-dir':
        options.userDataDir = valueAfter(i++);
        break;
      case '--product-name':
        options.productName = valueAfter(i++);
        break;
      case '--include':
        options.includes.push(valueAfter(i++));
        break;
      case '--exclude':
        options.excludes.push(valueAfter(i++));
        break;
      case '--provider':
        options.providers.push(valueAfter(i++).toLowerCase());
        break;
      case '--project':
        options.projects.push(valueAfter(i++).toLowerCase());
        break;
      case '--sort': {
        const value = valueAfter(i++) as Options['sort'];
        if (!['modified', 'created', 'provider', 'project', 'title'].includes(value)) {
          throw new Error('Unsupported sort field: ' + value);
        }
        options.sort = value;
        break;
      }
      case '--json':
        options.json = true;
        break;
      default:
        throw new Error('Unknown argument: ' + argv[i]);
    }
  }

  return options;
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

function resolveUserDataPath(options: Options): string {
  if (options.userDataDir) return path.resolve(expandHome(options.userDataDir));

  if (process.env.VSCODE_PORTABLE) {
    return path.resolve(expandHome(process.env.VSCODE_PORTABLE), 'user-data');
  }

  if (process.env.VSCODE_APPDATA) {
    return path.resolve(expandHome(process.env.VSCODE_APPDATA), options.productName);
  }

  if (process.platform === 'win32') {
    const base =
      process.env.APPDATA ??
      (process.env.USERPROFILE
        ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming')
        : homedir());
    return path.join(base, options.productName);
  }

  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', options.productName);
  }

  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'),
    options.productName,
  );
}

function validEntry(value: unknown): value is EndpointEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<EndpointEntry>;
  if (entry.schemaVersion !== 2) return false;
  if (entry.type !== 'editor' && entry.type !== 'standalone') return false;
  if (typeof entry.pid !== 'number') return false;
  if (typeof entry.instanceId !== 'string') return false;
  if (typeof entry.protocolVersion !== 'string') return false;
  if (typeof entry.connectionToken !== 'string') return false;
  if (!entry.endpoint || typeof entry.endpoint !== 'object') return false;

  return entry.endpoint.type === 'socket'
    ? typeof entry.endpoint.path === 'string'
    : entry.endpoint.type === 'tcp' &&
        typeof entry.endpoint.host === 'string' &&
        typeof entry.endpoint.port === 'number';
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function discoverEndpoints(userDataDir: string): Promise<EndpointEntry[]> {
  const root = path.join(userDataDir, 'agent-host', 'local-endpoint');
  const entriesDir = path.join(root, 'entries');
  const found: EndpointEntry[] = [];

  try {
    for (const name of await readdir(entriesDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const value = JSON.parse(await readFile(path.join(entriesDir, name), 'utf8')) as unknown;
        if (validEntry(value) && processAlive(value.pid)) found.push(value);
      } catch {
        // One bad entry must not hide valid hosts.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  try {
    const legacy = JSON.parse(await readFile(path.join(root, 'metadata.json'), 'utf8')) as unknown;
    if (Array.isArray(legacy)) {
      for (const value of legacy) {
        if (validEntry(value) && processAlive(value.pid)) found.push(value);
      }
    }
  } catch {
    // Legacy registry is optional.
  }

  const unique = new Map<string, EndpointEntry>();
  for (const entry of found) {
    unique.set([entry.type, entry.pid, entry.instanceId].join(':'), entry);
  }
  return [...unique.values()];
}

function endpointUrl(entry: EndpointEntry): string {
  const token = encodeURIComponent(entry.connectionToken);
  if (entry.endpoint.type === 'tcp') {
    return 'ws://' + entry.endpoint.host + ':' + entry.endpoint.port + '/?tkn=' + token;
  }
  return 'ws+unix:' + entry.endpoint.path + ':/?tkn=' + token;
}

function localPath(uri: string): string {
  if (!uri.startsWith('file:')) return uri;
  try {
    return path.resolve(fileURLToPath(uri));
  } catch {
    return uri;
  }
}

function normalized(value: string): string {
  const result = path.resolve(expandHome(value));
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

function under(candidate: string, root: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  const child = normalized(candidate);
  const parent = normalized(root);
  return child === parent || child.startsWith(parent + path.sep);
}

function matches(row: SessionRow, options: Options): boolean {
  if (
    options.providers.length > 0 &&
    !options.providers.includes(row.provider.toLowerCase())
  ) {
    return false;
  }

  if (
    options.projects.length > 0 &&
    !options.projects.some(project => row.project.toLowerCase().includes(project))
  ) {
    return false;
  }

  if (
    options.includes.length > 0 &&
    !row.workingDirectories.some(directory =>
      options.includes.some(include => under(directory, include)),
    )
  ) {
    return false;
  }

  if (
    row.workingDirectories.some(directory =>
      options.excludes.some(exclude => under(directory, exclude)),
    )
  ) {
    return false;
  }

  return true;
}

function sortRows(rows: SessionRow[], sort: Options['sort']): SessionRow[] {
  const result = [...rows];
  result.sort((a, b) => {
    if (sort === 'created') return b.createdAt.localeCompare(a.createdAt);
    if (sort === 'provider') return a.provider.localeCompare(b.provider);
    if (sort === 'project') return a.project.localeCompare(b.project);
    if (sort === 'title') return a.title.localeCompare(b.title);
    return b.modifiedAt.localeCompare(a.modifiedAt);
  });
  return result;
}

async function sessionsFromHost(
  entry: EndpointEntry,
  host: string,
): Promise<SessionRow[]> {
  const transport = await NodeWebSocketTransport.connect(endpointUrl(entry));
  const client = new AhpClient(transport, { requestTimeoutMs: 15_000 });
  client.connect();

  try {
    await client.initialize({
      clientId: 'workflow-miner-discovery-' + process.pid,
      protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    });

    const sessions: SessionRow[] = [];
    let cursor: string | undefined;

    do {
      const result = await client.request('listSessions', {
        channel: 'ahp-root://',
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });

      for (const session of result.items) {
        sessions.push({
          host,
          provider: session.provider,
          project: session.project?.displayName ?? '',
          title: session.title,
          createdAt: session.createdAt,
          modifiedAt: session.modifiedAt,
          workingDirectories: (session.workingDirectories ?? []).map(localPath),
          resource: session.resource,
        });
      }

      cursor = result.nextCursor;
    } while (cursor);

    return sessions;
  } finally {
    await client.shutdown();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const userDataDir = resolveUserDataPath(options);
  const endpoints = await discoverEndpoints(userDataDir);

  if (endpoints.length === 0) {
    throw new Error(
      'No live VS Code Agent Host endpoints found under ' +
        userDataDir +
        '. Open VS Code with Agent Host available or pass --user-data-dir.',
    );
  }

  const rows: SessionRow[] = [];
  for (const [index, entry] of endpoints.entries()) {
    const host = entry.type + ':' + entry.pid + ':' + (index + 1);
    try {
      rows.push(...(await sessionsFromHost(entry, host)));
    } catch (error) {
      console.error(
        'Failed to query ' +
          host +
          ' (AHP ' +
          entry.protocolVersion +
          '): ' +
          (error as Error).message,
      );
    }
  }

  const filtered = sortRows(rows.filter(row => matches(row, options)), options.sort);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          userDataDir,
          hostsDiscovered: endpoints.length,
          sessionsDiscovered: rows.length,
          sessionsMatched: filtered.length,
          sessions: filtered,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log('VS Code user data: ' + userDataDir);
  console.log('Agent Host endpoints: ' + endpoints.length);
  console.log('Sessions discovered: ' + rows.length);
  console.log('Sessions matched: ' + filtered.length);

  console.table(
    filtered.map(row => ({
      host: row.host,
      provider: row.provider,
      project: row.project,
      modified: row.modifiedAt,
      title: row.title,
      directories: row.workingDirectories.join(', '),
    })),
  );
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
