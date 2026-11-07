/** Owned, disposable local stack tooling. Never print Supabase's credential-bearing output. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ID = 'rematch-t1-20261105';
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const receiptPath = resolve(root, 'supabase/.temp/rematch-owner.json');
const dbName = `supabase_db_${PROJECT_ID}`;
const networkName = `rematch_loopback_${PROJECT_ID}`;
const ports = [54320, 54321, 54322, 54323, 54324, 54325, 54327, 8083];

export function sanitizeCliError(output: string): string {
  return output.split('\n')
    .filter((line) => /error|failed|fatal|detail|hint|sqlstate/i.test(line))
    .filter((line) => !/service.?role|api[ _-]?key|secret|token|password|authorization|(?:DB|DATABASE)_URL/i.test(line))
    .map((line) => line.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[redacted URL]')
      .replace(/\beyJ[\w.-]+/g, '[redacted JWT]')
      .replace(/\b(?:sb_|sk-)[\w-]+/g, '[redacted key]'))
    .slice(-20).join('\n');
}

function command(program: string, args: string[]): string {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    const diagnostic = sanitizeCliError(`${result.stderr ?? ''}\n${result.stdout ?? ''}`);
    throw new Error(`${program} ${args.slice(0, 2).join(' ')} failed (exit ${result.status ?? 'unavailable'})${diagnostic ? `\n${diagnostic}` : '; no safe diagnostic lines'}`);
  }
  return result.stdout;
}

function configCheck(): void {
  const dockerHost = process.env.DOCKER_HOST ?? command('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).trim();
  if (!dockerHost.startsWith('unix://')) throw new Error('Local Docker Unix socket required');
  const config = readFileSync(resolve(root, 'supabase/config.toml'), 'utf8');
  if (!new RegExp(`^project_id = "${PROJECT_ID}"$`, 'm').test(config)) throw new Error('Local project ID mismatch');
  if (existsSync(resolve(root, 'supabase/.temp/project-ref'))) throw new Error('Linked projects are forbidden for local tests');
  // CLI config environment overrides must not redirect owned operations.
  if (Object.keys(process.env).some((key) => key === 'SUPABASE_ENV' || key.startsWith('SUPABASE_DB_') || key === 'SUPABASE_PROJECT_ID' || key === 'SUPABASE_API_PORT')) {
    throw new Error('Supabase target overrides are forbidden for local tests');
  }
}

type Receipt = { projectId: string; root: string; containerId: string; networkId: string; stopped?: boolean; volumes: { name: string; createdAt: string }[] };
type Container = { Id: string; Name: string; State: { Running: boolean }; Config: { Labels: Record<string, string> }; Mounts: { Name?: string; Destination: string }[]; NetworkSettings: { Networks: Record<string, { NetworkID: string }>; Ports: Record<string, { HostIp: string; HostPort: string }[] | null> } };

function inspectDb(): Container {
  return JSON.parse(command('docker', ['inspect', dbName]))[0] as Container;
}

function checkContainer(container: Container, receipt: Receipt): void {
  if (receipt.projectId !== PROJECT_ID || receipt.root !== root || container.Id !== receipt.containerId ||
      container.Name !== `/${dbName}` || !container.State.Running ||
      container.Config.Labels['com.supabase.cli.project'] !== PROJECT_ID ||
      container.Config.Labels['com.supabase.cli.workdir'] !== root ||
      container.NetworkSettings.Networks[networkName]?.NetworkID !== receipt.networkId ||
      !container.Mounts.some((mount) => mount.Name === dbName && mount.Destination === '/var/lib/postgresql/data') ||
      !container.NetworkSettings.Ports['5432/tcp']?.some((port) => port.HostPort === '54322')) {
    throw new Error('Owned local database identity mismatch');
  }
}

function checkBindings(): void {
  const ids = command('docker', ['ps', '--filter', `label=com.supabase.cli.project=${PROJECT_ID}`, '--format', '{{.ID}}']).trim().split('\n');
  const containers = JSON.parse(command('docker', ['inspect', ...ids])) as Container[];
  for (const container of containers) {
    for (const bindings of Object.values(container.NetworkSettings.Ports)) {
      if (bindings?.some((binding) => binding.HostIp !== '127.0.0.1')) throw new Error(`Non-loopback published binding on ${container.Name}`);
    }
  }
}

function volumeIdentities(): Receipt['volumes'] {
  const names = command('docker', ['volume', 'ls', '--filter', `label=com.supabase.cli.project=${PROJECT_ID}`, '--format', '{{.Name}}']).trim().split('\n').filter(Boolean);
  return names.map((name) => {
    const [volume] = JSON.parse(command('docker', ['volume', 'inspect', name]));
    return { name: volume.Name as string, createdAt: volume.CreatedAt as string };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function assertLocalUrls(databaseUrl: string, apiUrl: string): void {
  let db: URL;
  let api: URL;
  try { db = new URL(databaseUrl); api = new URL(apiUrl); } catch { throw new Error('Invalid local connection URL'); }
  if (db.protocol !== 'postgresql:' || db.hostname !== '127.0.0.1' || db.port !== '54322' ||
      db.pathname !== '/postgres' || db.username !== 'postgres' || db.search || db.hash ||
      api.origin !== 'http://127.0.0.1:54321' || api.pathname !== '/' || api.username || api.password || api.search || api.hash) {
    throw new Error('Refusing a connection outside the owned loopback database');
  }
}

export function ownedLocalConnection(): { databaseUrl: string; apiUrl: string; serviceRoleKey: string } {
  configCheck();
  if (!existsSync(receiptPath)) throw new Error('Owned stack receipt missing; run the local start helper');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
  checkContainer(inspectDb(), receipt);
  const [network] = JSON.parse(command('docker', ['network', 'inspect', networkName]));
  if (network.Id !== receipt.networkId || network.Labels['rematch.owner'] !== root ||
      network.Options['com.docker.network.bridge.host_binding_ipv4'] !== '127.0.0.1') throw new Error('Owned loopback network identity mismatch');
  checkBindings();
  const output = command('supabase', ['status', '-o', 'env']);
  const values: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const match = /^([A-Z_]+)="(.*)"$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  const { DB_URL: databaseUrl, API_URL: apiUrl, SERVICE_ROLE_KEY: serviceRoleKey } = values;
  if (!databaseUrl || !apiUrl || !serviceRoleKey) throw new Error('Required local status fields missing');
  assertLocalUrls(databaseUrl, apiUrl);
  // Never silently ignore a caller asking to reset a different target.
  for (const [name, expected] of Object.entries({ DATABASE_URL: databaseUrl, SUPABASE_URL: apiUrl, SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey })) {
    if (process.env[name] !== undefined && process.env[name] !== expected) throw new Error(`Refusing mismatched ${name}`);
  }
  return { databaseUrl, apiUrl, serviceRoleKey };
}

async function portAvailable(port: number): Promise<void> {
  await new Promise<void>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Port ${port} unavailable; no existing process will be stopped`)));
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePort()));
  });
}

async function start(): Promise<void> {
  configCheck();
  const previous = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt : undefined;
  if (previous && !previous.stopped) { ownedLocalConnection(); console.log(`Owned stack already running: ${PROJECT_ID}`); return; }
  if (previous && (previous.projectId !== PROJECT_ID || previous.root !== root || !previous.volumes.length ||
    JSON.stringify(previous.volumes.sort((a, b) => a.name.localeCompare(b.name))) !== JSON.stringify(volumeIdentities()))) {
    throw new Error('Preserved owned volume identity mismatch');
  }
  const names = command('docker', ['ps', '-a', '--format', '{{.Names}}']).split('\n');
  const volumes = command('docker', ['volume', 'ls', '--format', '{{.Name}}']).split('\n');
  if ([...names, ...(previous ? [] : volumes)].some((name) => name.endsWith(`_${PROJECT_ID}`))) throw new Error('Project resources already exist without a matching ownership receipt; refusing adoption');
  for (const port of ports) await portAvailable(port);
  const networks = command('docker', ['network', 'ls', '--format', '{{.Name}}']).split('\n');
  if (!networks.includes(networkName)) {
    command('docker', ['network', 'create', '--label', `rematch.owner=${root}`, '-o', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', networkName]);
  }
  const [network] = JSON.parse(command('docker', ['network', 'inspect', networkName]));
  if (network.Labels['rematch.owner'] !== root || network.Options['com.docker.network.bridge.host_binding_ipv4'] !== '127.0.0.1') throw new Error('Owned loopback network mismatch');
  console.log(`Starting owned project ${PROJECT_ID}; required ports available`);
  command('supabase', ['start', '--network-id', networkName]);
  const container = inspectDb();
  const receipt: Receipt = { projectId: PROJECT_ID, root, containerId: container.Id, networkId: network.Id, volumes: volumeIdentities() };
  checkContainer(container, receipt);
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: previous ? 'w' : 'wx' });
  try {
    ownedLocalConnection();
  } catch (error) {
    // A newly created stack failing the post-start guards must not remain exposed.
    command('supabase', ['stop', '--project-id', PROJECT_ID]);
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, stopped: true }, null, 2) + '\n');
    throw error;
  }
  console.log(`Owned stack ready: ${PROJECT_ID}; API 54321, DB 54322, Studio 54323, Mailpit 54324, SMTP 54325`);
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === 'start') return start();
  if (action !== 'reset' && action !== 'types' && action !== 'stop') throw new Error('Use start, reset, types or stop');
  ownedLocalConnection();
  if (action === 'stop') {
    command('supabase', ['stop', '--project-id', PROJECT_ID]);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, stopped: true }, null, 2) + '\n');
    console.log(`Stopped only owned project ${PROJECT_ID}; database volumes preserved`);
  } else if (action === 'reset') {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
    command('supabase', ['db', 'reset', '--local', '--yes', '--network-id', networkName]);
    // CLI reset recreates both the DB container and its disposable DB volume.
    // Other volumes must keep their identities; never accept replacement during reads.
    const volumes = volumeIdentities();
    if (JSON.stringify(receipt.volumes.map((volume) => volume.name)) !== JSON.stringify(volumes.map((volume) => volume.name)) ||
      JSON.stringify(receipt.volumes.filter((volume) => volume.name !== dbName)) !== JSON.stringify(volumes.filter((volume) => volume.name !== dbName))) {
      throw new Error('Reset changed unrelated volume identities');
    }
    const replacement = inspectDb();
    const refreshed = { ...receipt, containerId: replacement.Id, volumes };
    checkContainer(replacement, refreshed);
    checkBindings();
    writeFileSync(receiptPath, JSON.stringify(refreshed, null, 2) + '\n');
    ownedLocalConnection();
    console.log(`Reset and migrations completed for owned project ${PROJECT_ID}`);
  } else {
    const types = command('supabase', ['gen', 'types', 'typescript', '--local', '--network-id', networkName]);
    if (!types.includes('export type Database')) throw new Error('CLI did not return database types');
    mkdirSync(resolve(root, 'worker/src'), { recursive: true });
    writeFileSync(resolve(root, 'worker/src/db.types.ts'), types.trimEnd() + '\n');
    console.log('Generated worker/src/db.types.ts from owned local database');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
}
