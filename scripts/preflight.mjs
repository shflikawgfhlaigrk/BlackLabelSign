import { readFile, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const namesOnly = items => (Array.isArray(items) ? items : [])
  .map(item => typeof item?.name === 'string' ? item.name.slice(0, 160) : null).filter(Boolean).sort();
const unknown = reason => ({ state: 'UNKNOWN', reason });
const localUUID = '00000000-0000-0000-0000-000000000000';

export function assessPrivateConfig(config) {
  const failures = [];
  if (config?.name !== 'bl-sign-private-review') failures.push('private Worker name must be explicit');
  if (config?.account_id) failures.push('local template must not select a remote account');
  if (config?.workers_dev !== false || config?.preview_urls !== false) failures.push('public Worker previews must be disabled');
  if (!Array.isArray(config?.routes) || config.routes.length) failures.push('local template must have no routes');
  if (config?.triggers?.crons?.length) failures.push('automatic delivery schedules must be absent');
  if (config?.services?.length) failures.push('local template must not call service bindings');
  const allBindings = [...(config?.d1_databases || []), ...(config?.r2_buckets || []), ...(config?.send_email || [])];
  if (allBindings.some(binding => binding.remote !== false)) failures.push('every data and email binding must be explicitly local');
  const db = config?.d1_databases?.find(binding => binding.binding === 'DB');
  if (!db || db.database_id !== localUUID || db.database_name !== 'bl-sign-private-review') failures.push('DB must use the private local placeholder');
  const docs = config?.r2_buckets?.find(binding => binding.binding === 'DOCS');
  if (!docs || docs.bucket_name !== 'bl-sign-private-review-docs') failures.push('DOCS must use private local storage');
  if (config?.assets?.binding !== 'ASSETS' || config.assets.run_worker_first !== true) failures.push('ASSETS must pass application routes through the Worker');
  const email = config?.send_email?.find(binding => binding.name === 'EMAIL');
  if (!email || !email.allowed_destination_addresses?.length ||
      email.allowed_destination_addresses.some(address => typeof address !== 'string' || !address.endsWith('@example.invalid'))) {
    failures.push('EMAIL must be restricted to synthetic local inbox addresses');
  }
  try {
    const origin = new URL(config.vars.PUBLIC_ORIGIN);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
        !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
        origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
  } catch { failures.push('PUBLIC_ORIGIN must be a bare loopback origin'); }
  if (config?.dev?.ip !== '127.0.0.1') failures.push('development server must bind to loopback');
  return { state: failures.length ? 'INVALID' : 'LOCAL_ONLY', failures };
}

export function matchesSignRoutePattern(pattern) {
  if (typeof pattern !== 'string' || /[\s\\?#]/.test(pattern)) return false;
  // Worker routes allow an optional HTTP(S) scheme and path wildcards. The
  // authority must be exact: neither hostname prefixes nor URL credentials
  // establish that a route belongs to BL Sign.
  const parts = /^(?:(https?):\/\/)?([^/]+)(\/.*)?$/i.exec(pattern);
  if (!parts || parts[2].toLowerCase() !== 'sign.blacklabeltec.com') return false;
  try {
    const route = new URL(`${parts[1] || 'https'}://${parts[2]}${parts[3] || '/'}`);
    return ['http:', 'https:'].includes(route.protocol) && route.hostname === 'sign.blacklabeltec.com' &&
      !route.port && !route.username && !route.password && !route.search && !route.hash;
  } catch { return false; }
}

export function summarizeCache(snapshot) {
  if (!snapshot?.data) return unknown('installed Cloudflare cache unavailable');
  const data = snapshot.data;
  const worker = (data.workers || []).find(item => item.id === 'bl-sign');
  const routes = (data.routes || []).filter(item => matchesSignRoutePattern(item.pattern));
  return {
    state: snapshot.stale ? 'STALE' : 'CACHED_METADATA',
    checkedAt: Number.isFinite(snapshot.checked_at) ? new Date(snapshot.checked_at * 1000).toISOString() : null,
    ageSeconds: Number.isFinite(snapshot.age_seconds) ? snapshot.age_seconds : null,
    worker: worker ? { name: worker.id, createdOn: worker.created_on, modifiedOn: worker.modified_on } : null,
    databaseNames: (data.d1 || []).filter(item => String(item.name || '').startsWith('bl-sign')).map(item => item.name),
    bucketNames: (data.r2 || []).filter(item => String(item.name || '').startsWith('bl-sign')).map(item => item.name),
    routeWorkers: [...new Set(routes.map(item => item.worker).filter(Boolean))].sort(),
    wrapperPreservationRequired: true,
    liveBindingAndSecretState: 'UNKNOWN',
    note: 'Inventory metadata does not prove application, migration, authentication, or mail delivery readiness.',
  };
}

export function codeFingerprints(bytes, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  if (!boundary) return [{ name: 'worker-content', sha256: sha256(bytes), bytes: bytes.length }];
  return bytes.toString('latin1').split(`--${boundary[1] || boundary[2]}`).flatMap(part => {
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) return [];
    const headers = part.slice(0, split);
    const filename = /filename="([^"\r\n]+)"/i.exec(headers)?.[1] || /(?:^|;)\s*name="([^"\r\n]+)"/i.exec(headers)?.[1];
    if (!filename) return [];
    let body = part.slice(split + 4);
    if (body.endsWith('\r\n')) body = body.slice(0, -2);
    const bodyBytes = Buffer.from(body, 'latin1');
    return [{ name: filename.slice(0, 160), sha256: sha256(bodyBytes), bytes: bodyBytes.length }];
  });
}

export async function liveMetadata(env = process.env, fetcher = fetch) {
  const account = env.CLOUDFLARE_ACCOUNT_ID || '';
  const token = env.CLOUDFLARE_API_TOKEN || '';
  const worker = env.CLOUDFLARE_WORKER_NAME || 'bl-sign';
  if (!/^[a-f0-9]{32}$/.test(account) || !token) return unknown('explicit metadata credentials are not supplied; no credential files are read');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(worker)) return unknown('invalid explicit Worker name');
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}`;
  async function boundedBytes(response) {
    const maximum = 8 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maximum) throw new Error('bounded response limit');
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    let total = 0;
    const chunks = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maximum) { await reader.cancel(); throw new Error('bounded response limit'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, total);
  }
  async function get(suffix, raw = false) {
    try {
      const response = await fetcher(base + suffix, {
        method: 'GET', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return unknown(`metadata GET returned HTTP ${response.status}`);
      const bytes = await boundedBytes(response);
      if (raw) {
        return { state: 'METADATA_READ', modules: codeFingerprints(bytes, response.headers.get('content-type')) };
      }
      const data = JSON.parse(bytes.toString('utf8'));
      return data.success === false ? unknown('metadata API did not confirm success') : { state: 'METADATA_READ', result: data.result };
    } catch { return unknown('metadata network, authentication, or parsing unavailable'); }
  }
  const [settings, secrets, deployments, code] = await Promise.all([
    get('/settings'), get('/secrets'), get('/deployments'), get('', true),
  ]);
  const safeSettings = settings.state === 'METADATA_READ' ? {
    state: settings.state,
    compatibilityDate: settings.result?.compatibility_date || null,
    bindings: (settings.result?.bindings || []).map(binding => ({
      name: typeof binding.name === 'string' ? binding.name.slice(0, 160) : null,
      type: typeof binding.type === 'string' ? binding.type.slice(0, 100) : null,
    })),
  } : settings;
  const secretNames = secrets.state === 'METADATA_READ' ? { state: secrets.state, names: namesOnly(secrets.result) } : secrets;
  const safeDeployments = deployments.state === 'METADATA_READ' ? {
    state: deployments.state,
    deployments: (Array.isArray(deployments.result) ? deployments.result : deployments.result?.deployments || []).slice(0, 10).map(item => ({
      id: item.id || null, createdOn: item.created_on || null,
      versions: (item.versions || []).map(version => ({ id: version.version_id || version.id || null, percentage: version.percentage ?? null })),
    })),
  } : deployments;
  return { state: 'METADATA_ONLY', worker, settings: safeSettings, secrets: secretNames, deployments: safeDeployments, code,
    testInbox: unknown('no approved recipient receipt or inbox message was read'),
    journey: unknown('metadata does not exercise a customer journey') };
}

async function sourceFingerprints(root) {
  const paths = ['schema.sql'];
  for (const directory of ['src', 'migrations']) {
    for (const item of await readdir(resolve(root, directory), { withFileTypes: true })) {
      if (item.isFile() && /\.(js|mjs|sql)$/.test(item.name)) paths.push(`${directory}/${item.name}`);
    }
  }
  for (const path of ['public/landing.html', 'public/me.html', 'public/assets/editor.js', 'public/assets/sign.js']) paths.push(path);
  return Promise.all(paths.sort().map(async path => {
    const actual = await realpath(resolve(root, path));
    const rel = relative(root, actual);
    if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('source path escapes repository');
    const bytes = await readFile(actual);
    return { path, sha256: sha256(bytes), bytes: bytes.length };
  }));
}

export async function runPreflight({ root, env = process.env, live = false, cacheSnapshot } = {}) {
  root = await realpath(root || resolve(fileURLToPath(new URL('..', import.meta.url))));
  const template = JSON.parse(await readFile(resolve(root, 'config/templates/wrangler.private.example.json'), 'utf8'));
  let snapshot = cacheSnapshot;
  if (snapshot === undefined) {
    const read = spawnSync('blp', ['cloudflare', '--json'], { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    try { snapshot = read.status === 0 ? JSON.parse(read.stdout) : null; } catch { snapshot = null; }
  }
  return {
    status: 'NOT DONE', scope: 'read-only preflight; private source and service metadata',
    privateConfig: assessPrivateConfig(template),
    requiredPublicSecret: { name: 'SESSION_SECRET', localEnvironmentPresent: Boolean(env.SESSION_SECRET), productionPresence: 'UNKNOWN' },
    optionalSecrets: ['ADMIN_TOKEN', 'ESTATE_BRIDGE_TOKEN'],
    requiredBindings: ['DB', 'DOCS', 'ASSETS', 'EMAIL'],
    sources: await sourceFingerprints(root),
    cloudflareCache: summarizeCache(snapshot),
    production: live ? await liveMetadata(env) : unknown('live metadata not requested'),
    prerequisites: [
      'final source schema and every migration applied to the isolated review store',
      'integrated fresh-browser lifecycle, security and recovery evidence for this exact source',
      'PUBLIC_ORIGIN links and HTTPS cookie behavior verified at the review route',
      'for live email: onboarded sender domain, supported binding, approved recipient and independently observed inbox receipt',
      'founder acceptance before any public configuration change or release',
    ],
    noSideEffects: true,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--live')) {
    process.stderr.write('Usage: node scripts/preflight.mjs [--live]\n');
    process.exitCode = 2;
  } else {
    try {
      const report = await runPreflight({ live: args.includes('--live') });
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      if (report.privateConfig.state !== 'LOCAL_ONLY') process.exitCode = 1;
    } catch {
      process.stdout.write(JSON.stringify({ status: 'NOT DONE', state: 'UNKNOWN', reason: 'preflight source or template unavailable', noSideEffects: true }) + '\n');
      process.exitCode = 1;
    }
  }
}
