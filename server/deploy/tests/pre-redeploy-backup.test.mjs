// The licenses backup before a Redeploy (2026-11-01: the pre-deploy backup dumped the update_server's database, and
// `ssamctl.sh backup` with pg_dump 17 against PostgreSQL 18.6 wrote an empty file). Headless: a fake docker and a fake
// ssh; no container, no VPS.
// Run: node --test server/deploy/tests/pre-redeploy-backup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const coolify = fileURLToPath(new URL('../coolify/', import.meta.url));
const ssamctl = path.join(coolify, 'ssamctl.sh');
const wrapper = path.join(coolify, 'backup-before-redeploy.sh');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const slash = (p) => p.replaceAll('\\', '/');
const posix = (p) => process.platform === 'win32' ? slash(p).replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase()) : p;
const SECRET ='pw-never-printed-91';

const LICENSES = `--
-- PostgreSQL database dump
--
-- Dumped from database version 18.6
-- Dumped by pg_dump version 18.1
CREATE TABLE public.schema_migrations (
    version text NOT NULL
);
CREATE TABLE public.server_tokens (
    id text NOT NULL
);
COPY public.schema_migrations (version) FROM stdin;
0001
\\.
COPY public.server_tokens (id) FROM stdin;
tok_a
tok_b
\\.
`;
// The update_server's database: what the old pre-deploy backup dumped.
const WRONG = `-- Dumped from database version 17.5
CREATE TABLE public.releases (
    id text NOT NULL
);
`;

// The other two databases of the VPS: what their dumps must hold (the update_server's Prisma tables; Coolify's own).
const UPDATE_SERVER = `-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11
CREATE TABLE public._prisma_migrations (
    id text NOT NULL
);
CREATE TABLE public.apps (
    id text NOT NULL
);
CREATE TABLE public.artifacts (
    id text NOT NULL
);
CREATE TABLE public.releases (
    id text NOT NULL
);
`;
const COOLIFY = `-- Dumped from database version 15.19
-- Dumped by pg_dump version 15.19
${['applications', 'instance_settings', 'migrations', 'servers', 'services'].map((t) => `CREATE TABLE public.${t} (\n    id bigint NOT NULL\n);`).join('\n')}
`;
const ANON = 'a'.repeat(64);
// The live resource as the VPS has it (2026-11-09, docker inspect): the backends share server-state and friction, each
// has its own cache and Features; every backend mounts the ODC plugins read-only at a path with a space; the router
// has an anonymous cache; the console only server-state; proj_cache is a project volume nothing mounts any more.
const MOUNTS = [
  ['backend-new', '/data/server', 'proj_server-state'], ['backend-new', '/data/friction', 'proj_friction'],
  ['backend-new', '/data/odc-features', 'proj_features-new'], ['backend-new', '/data/cache', 'proj_cache-new'],
  ['backend-new', '/tmp/.local/share/OutSystems/ODC Studio/Plugins', 'proj_odc-model-plugins'],
  ['backend-old', '/data/server', 'proj_server-state'], ['backend-old', '/data/friction', 'proj_friction'],
  ['backend-old', '/data/odc-features', 'proj_features-old'], ['backend-old', '/data/cache', 'proj_cache-old'],
  ['backend-old', '/tmp/.local/share/OutSystems/ODC Studio/Plugins', 'proj_odc-model-plugins'],
  ['router', '/data/server', 'proj_server-state'], ['router', '/data/cache', ANON],
  ['console', '/data/server', 'proj_server-state'],
];
const NAMED = [...new Set(MOUNTS.map((m) => m[2]).filter((v) => v !== ANON)), 'proj_cache'];

// A fake docker. DB_CONTAINER=0 means the licenses database is not a container on this host (only the pinned 17
// fallback); SERVER_NUM is its server_version_num; DUMP is the file its pg_dump writes. UPD_* and COOL_DUMP drive the
// update_server (container upd) and Coolify (coolify-db) databases, dumped with docker exec. VOLDIR is what every volume
// holds (EMPTY_STATE=1: server-state is empty); RUNNING is the state of the SSAM containers.
function fakeDocker(dir) {
  const mock = path.join(dir, 'docker.sh');
  fs.writeFileSync(path.join(dir, 'mounts.tsv'), MOUNTS.map((m) => m.join('\t')).join('\n') + '\n');
  fs.writeFileSync(mock, `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
for last in "$@"; do :; done
case "$*" in
*'ps -a'*'name=dbhost'*) [ "$DB_CONTAINER" = 1 ] && echo dbhost; exit 0;;
*'ps -a'*'ssam.default=true'*) echo backend-new;;
*'ps -a'*'ssam.backend=true'*) printf 'backend-new\\nbackend-old\\n';;
*'ps -a'*'com.docker.compose.project=proj'*) printf 'backend-new\\nbackend-old\\nrouter\\nconsole\\n';;
*'ps -a'*) echo backend-new;;
'ps --format {{.Names}}') printf 'backend-new\\nbackend-old\\nrouter\\nconsole\\ndbhost\\nupd\\ncoolify-db\\n'; [ "$UPD2" = 1 ] && echo upd2; exit 0;;
*'volume ls -q --filter name=proj_'*) printf 'proj_server-state\\nproj_cache\\nproj_friction\\nproj-other_x\\n';;
'volume inspect '*) exit 0;;
*'inspect'*'.Config.Env'*) case "$last" in
  upd|upd2) if [ "$UPD_MISSING" = 1 ]; then echo POSTGRES_DB=other; else echo POSTGRES_DB=update_server; fi; echo "POSTGRES_PASSWORD=${SECRET}";;
  dbhost) echo POSTGRES_DB=postgres; echo "POSTGRES_PASSWORD=${SECRET}";;
  coolify-db) echo POSTGRES_DB=coolify; echo "POSTGRES_PASSWORD=${SECRET}";;
  *) echo "SSAM_DATABASE_URL=postgres://ssam:${SECRET}@dbhost:5432/postgres";; esac;;
*'inspect'*'.NetworkSettings.Networks'*) echo coolify;;
*'inspect --format {{.Image}} dbhost'*) echo sha256:pg18image;;
*'inspect'*'eq .Type'*) awk -F '\\t' -v c="$last" '$1==c {printf "%s\\t%s\\n", $2, $3}' "$MOUNTS";;
*'inspect'*'eq .Destination'*) d=$(printf '%s' "$*" | sed -n 's/.*eq .Destination "\\([^"]*\\)".*/\\1/p'); awk -F '\\t' -v c="$last" -v d="$d" '$1==c && $2==d {print $3}' "$MOUNTS";;
*'inspect'*'com.docker.compose.project'*) echo proj;;
*'inspect'*'ssam.odc'*) case "$last" in backend-new) echo 1.7.30;; backend-old) echo 1.7.28;; *) echo;; esac;;
*'inspect'*'ssam.o11'*) case "$last" in backend-new) echo 11.55.94;; backend-old) echo 11.55.92;; *) echo;; esac;;
*'inspect'*'image.revision'*) echo 4b6b213;;
*'inspect'*'.State.Running'*) case "$last" in upd|upd2|coolify-db|dbhost) echo true;; router) echo "\${ROUTER_RUNNING:-\${RUNNING:-true}}";; *) echo "\${RUNNING:-true}";; esac;;
*'inspect'*'.Config.Image'*) case "$last" in upd|upd2) echo postgres:17-alpine;; coolify-db) echo postgres:15-alpine;; dbhost) echo postgres:18-alpine;; *) echo ssam-server:test;; esac;;
*'inspect'*'.Image'*) echo sha256:serverimage;;
'exec upd'*'--version'*) printf '%s\\n' "\${UPD_VERSIONS:-postgres (PostgreSQL) 17.11}" "\${UPD_PG_DUMP:-pg_dump (PostgreSQL) 17.11}";;
'exec coolify-db'*'--version'*) printf 'postgres (PostgreSQL) 15.19\\npg_dump (PostgreSQL) 15.19\\n';;
'exec upd'*'pg_dump -U'*) [ -n "$UPD_DUMP" ] && cat "$UPD_DUMP"; exit 0;;
'exec coolify-db'*'pg_dump -U'*) [ -n "$COOL_DUMP" ] && cat "$COOL_DUMP"; exit 0;;
*'run'*'show server_version_num'*) echo "$SERVER_NUM";;
*'run'*'postgres:17'*'pg_dump --version'*) echo 'pg_dump (PostgreSQL) 17.11';;
*'run'*'pg_dump --version'*) echo 'pg_dump (PostgreSQL) 18.1';;
*'run'*'pg_dump postgres:'*) [ -n "$DUMP" ] && cat "$DUMP"; exit "\${DUMP_EXIT:-0}";;
*'run'*'--entrypoint tar'*) echo volume-bytes;;
*'run'*'proj_server-state:/source:ro'*) if [ "$EMPTY_STATE" = 1 ]; then tar -cf - -C "$EMPTYDIR" .; else tar -cf - -C "$VOLDIR" .; fi;;
*'run'*':/source:ro'*) tar -cf - -C "$VOLDIR" .;;
*'run'*':/restore'*) cat > /dev/null;;
*) :;;
esac
`);
  return mock;
}
// A fake ssh: runs the remote command (the last argument) here, with stdin.
function fakeSsh(dir) {
  const mock = path.join(dir, 'ssh.sh');
  fs.writeFileSync(mock, '#!/bin/sh\nfor last in "$@"; do :; done\nexec sh -c "$last"\n');
  return mock;
}
function setup(dump, {db = '1', server = '180006', exit = '0', upd = UPDATE_SERVER, cool = COOLIFY, extra = {}} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-redeploy-'));
  const out = path.join(dir, 'out'); fs.mkdirSync(out);
  const write = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return slash(f); };
  const dumpFile = write('dump.sql', dump ?? '');
  const vol = path.join(dir, 'vol'); fs.mkdirSync(vol); fs.writeFileSync(path.join(vol, 'kernel.json'), '{}');
  const empty = path.join(dir, 'empty'); fs.mkdirSync(empty);
  const services = path.join(dir, 'services', 'proj'); fs.mkdirSync(services, {recursive: true});
  fs.writeFileSync(path.join(services, 'docker-compose.yml'), 'services: {}\n'); fs.writeFileSync(path.join(services, '.env'), `X=${SECRET}\n`);
  const env = {...process.env, DOCKER: `sh ${slash(fakeDocker(dir))}`, CALLS: slash(path.join(dir, 'calls')), DB_CONTAINER: db,
    SERVER_NUM: server, DUMP: dump === null ? '' : dumpFile, DUMP_EXIT: exit, MSYS_NO_PATHCONV: '1',
    UPD_DUMP: upd === null ? '' : write('upd.sql', upd), COOL_DUMP: cool === null ? '' : write('cool.sql', cool),
    MOUNTS: slash(path.join(dir, 'mounts.tsv')), VOLDIR: posix(vol), EMPTYDIR: posix(empty),
    SSAM_COOLIFY_SERVICES_DIR: posix(path.join(dir, 'services')), SSAM_BACKUP_MIN_FREE_GB: '0'};
  for (const k of ['PG_IMAGE', 'SSAM_BACKUP_DATABASES', 'SSAM_BACKUP_REQUIRE_DATABASE', 'BACKUP_KEEP_DAYS', 'SSAM_CONTAINER', 'SSAM_PROJECT', 'UPD2', 'UPD_MISSING', 'EMPTY_STATE', 'RUNNING', 'ROUTER_RUNNING', 'UPD_VERSIONS', 'UPD_PG_DUMP']) delete env[k];
  Object.assign(env, extra);
  return {dir, out, env, calls: () => fs.readFileSync(path.join(dir, 'calls'), 'utf8')};
}
const backup = (s) => spawnSync(bash, [slash(ssamctl), 'backup', slash(s.out)], {encoding: 'utf8', env: s.env});
const files = (s, re) => fs.readdirSync(s.out).filter((f) => re.test(f));

test('backup dumps the licenses with the database container own image and checks the license tables', () => {
  const s = setup(LICENSES);
  try {
    const r = backup(s);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const [dump] = files(s, /^ssam-tokens-.*\.sql\.gz$/);
    assert.ok(dump, 'no ssam-tokens dump');
    assert.match(zlib.gunzipSync(fs.readFileSync(path.join(s.out, dump))).toString(), /CREATE TABLE public\.server_tokens/);
    assert.equal(files(s, /\.partial/).length, 0);
    const dumps = s.calls().split('\n').filter((l) => / pg_dump postgres:/.test(l));
    assert.equal(dumps.length, 1);
    assert.match(dumps[0], /sha256:pg18image/);
    assert.doesNotMatch(dumps[0], /postgres:17/);
    assert.match(r.stdout, /PostgreSQL 18 dumped by pg_dump 18, .*server_tokens rows: 2/);
    assert.ok(!(r.stdout + r.stderr).includes(SECRET), 'the database password was printed');
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('backup refuses loudly a dump of another database, before the volumes are copied', () => {
  const s = setup(WRONG);
  try {
    const r = backup(s);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /BACKUP_DUMP_NO_LICENSE_TABLES: the dump has no table server_tokens/);
    assert.deepEqual(files(s, /^ssam-(tokens|state)-/), []);
    assert.doesNotMatch(s.calls(), /--entrypoint tar|\/source:ro|exec upd|exec coolify-db/);
    assert.ok(!(r.stdout + r.stderr).includes(SECRET));
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('backup refuses an empty dump and a failed pg_dump', () => {
  for (const [dump, exit, code] of [['', '0', /BACKUP_DUMP_EMPTY/], [LICENSES, '1', /BACKUP_DUMP_FAILED/]]) {
    const s = setup(dump, {exit});
    try {
      const r = backup(s);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, code);
      assert.deepEqual(files(s, /^ssam-(tokens|state)-|\.partial/), []);
    } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
  }
});

test('backup refuses a pg_dump older than the server instead of writing an empty file', () => {
  const s = setup(LICENSES, {db: '0'});
  try {
    const r = backup(s);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /BACKUP_PG_DUMP_TOO_OLD: pg_dump 17 cannot dump a PostgreSQL 18 server/);
    assert.doesNotMatch(s.calls(), / pg_dump postgres:/);
    assert.deepEqual(files(s, /^ssam-(tokens|state)-/), []);
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('the same fallback client still dumps a server of its own major version', () => {
  const s = setup(LICENSES, {db: '0', server: '170005'});
  try {
    const r = backup(s);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(s.calls(), /postgres:17\.11-alpine.* pg_dump postgres:/);
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('backup-before-redeploy runs ssamctl backup of its own folder over ssh and requires the licenses', () => {
  for (const [dump, status] of [[LICENSES, 0], [WRONG, 2]]) {
    const s = setup(dump);
    try {
      const env = {...s.env, SSAM_SSH: `sh ${slash(fakeSsh(s.dir))} root@vps`, SSAM_BACKUP_BASE: posix(s.out)};
      const r = spawnSync(bash, [slash(wrapper), 'test-label'], {encoding: 'utf8', env});
      assert.equal(r.status, status, r.stdout + r.stderr);
      const dir = path.join(s.out, 'pre-test-label');
      if (status === 0) {
        assert.match(r.stdout, /OK: licenses .*ssam-tokens-.*\.sql\.gz \(\d+ bytes, PostgreSQL 18\.6\), window .*ssam-state-.*kernels state .*\/state-.*, update_server .*ssam-db-update_server-.*, coolify .*ssam-db-coolify-/);
        assert.equal(fs.readdirSync(dir).filter((f) => /^ssam-tokens-.*\.sql\.gz$/.test(f)).length, 1);
        // The layout rollback-kernels.sh reads: server-state and friction of the default backend.
        assert.equal(fs.readdirSync(dir).filter((f) => /^state-.*\.tar\.gz$/.test(f)).length, 1);
        assert.match(s.calls(), /run .*proj_server-state:\/source\/state:ro .*--entrypoint tar sha256:serverimage -czf - -C \/source state friction/);
      } else {
        assert.match(r.stderr, /BACKUP_DUMP_NO_LICENSE_TABLES/);
        assert.deepEqual(fs.readdirSync(dir).filter((f) => /^ssam-(tokens|state)-/.test(f)), []);
      }
      assert.ok(!(r.stdout + r.stderr).includes(SECRET));
    } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
  }
});

test('backup-before-redeploy refuses a server without SSAM_DATABASE_URL and a bad label', () => {
  const s = setup(LICENSES);
  try {
    const mock = path.join(s.dir, 'docker.sh');
    fs.writeFileSync(mock, fs.readFileSync(mock, 'utf8').replace(/echo "SSAM_DATABASE_URL=[^"]*"/, 'echo SSAM_RUNTIME_DIR=/data/server'));
    const env = {...s.env, SSAM_SSH: `sh ${slash(fakeSsh(s.dir))} root@vps`, SSAM_BACKUP_BASE: posix(s.out)};
    const r = spawnSync(bash, [slash(wrapper), 'x1'], {encoding: 'utf8', env});
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /BACKUP_NO_DATABASE_URL/);
    const bad = spawnSync(bash, [slash(wrapper), 'x;rm'], {encoding: 'utf8', env});
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /usage/);
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

// --- The complete backup (daily cron and pre-redeploy, 2026-11-09): three databases, every volume of the resource. ---
const backupArgs = (s, ...args) => spawnSync(bash, [slash(ssamctl), 'backup', ...args, slash(s.out)], {encoding: 'utf8', env: s.env});
const gunzip = (f) => zlib.gunzipSync(fs.readFileSync(f)).toString();
function manifestOf(s, archive) {
  const x = path.join(s.dir, 'x'); fs.mkdirSync(x, {recursive: true});
  const r = spawnSync(bash, ['-c', `tar --force-local -xzf "${posix(archive)}" -C "${posix(x)}" manifest.tsv && cat "${posix(x)}/manifest.tsv"`], {encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split('\n').slice(1).map((l) => l.split('\t'));
}

test('backup writes the licenses, update_server and Coolify dumps, each with its own major, and every volume of the resource', () => {
  const s = setup(LICENSES);
  try {
    const r = backupArgs(s);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = fs.readdirSync(s.out);
    const stamp = out.find((f) => /^ssam-state-.*\.tar\.gz$/.test(f)).slice('ssam-state-'.length, -'.tar.gz'.length);
    for (const f of [`ssam-tokens-${stamp}.sql.gz`, `ssam-db-update_server-${stamp}.sql.gz`, `ssam-db-coolify-${stamp}.sql.gz`,
      `ssam-service-${stamp}.tar.gz`, `ssam-state-${stamp}.tar.gz`]) {
      assert.ok(out.includes(f), `missing ${f}`);
      assert.ok(out.includes(f + '.sha256'), `missing ${f}.sha256`);
    }
    assert.deepEqual(out.filter((f) => /\.partial|^\.ssam-window-/.test(f)), [], 'work files left behind');
    // Licenses: the image of the licenses container (18), never the pinned 17; the other two: pg_dump INSIDE their container.
    assert.match(gunzip(path.join(s.out, `ssam-tokens-${stamp}.sql.gz`)), /CREATE TABLE public\.server_tokens/);
    assert.match(gunzip(path.join(s.out, `ssam-db-update_server-${stamp}.sql.gz`)), /CREATE TABLE public\.releases/);
    assert.match(gunzip(path.join(s.out, `ssam-db-coolify-${stamp}.sql.gz`)), /CREATE TABLE public\.instance_settings/);
    const calls = s.calls();
    assert.match(calls, /run .*sha256:pg18image pg_dump postgres:/);
    assert.doesNotMatch(calls, /postgres:17\.11-alpine/);
    assert.match(calls, /^exec upd sh -c exec pg_dump -U/m);
    assert.match(calls, /^exec coolify-db sh -c exec pg_dump -U/m);
    assert.match(r.stdout, /update_server database: container upd, PostgreSQL 17 dumped by pg_dump 17/);
    assert.match(r.stdout, /coolify database: container coolify-db, PostgreSQL 15 dumped by pg_dump 15/);
    // Every named volume once (shared server-state and plugins included), the unmounted project volume, no anonymous one.
    const copies = calls.split('\n').filter((l) => /:\/source:ro /.test(l)).map((l) => l.match(/-v (\S+):\/source:ro/)[1]);
    assert.deepEqual([...copies].sort(), [...NAMED].sort());
    assert.match(calls, /run --rm --init --security-opt no-new-privileges:true --cap-drop ALL --user 10001:10001 --network none -v proj_server-state:\/source:ro/);
    const archive = path.join(s.out, `ssam-state-${stamp}.tar.gz`);
    const rows = manifestOf(s, archive);
    assert.ok(rows.some(([c, , , d, v]) => c === 'backend-old' && d === '/tmp/.local/share/OutSystems/ODC Studio/Plugins' && v === 'proj_odc-model-plugins'));
    assert.ok(rows.some(([c, odc, o11, d, v]) => c === 'router' && odc === '-' && o11 === '-' && d === '/data/server' && v === 'proj_server-state'));
    assert.ok(rows.some(([c, , , d, v]) => c === 'console' && d === '/data/server' && v === 'proj_server-state'));
    assert.ok(rows.some(([c, , , d, v]) => c === '-' && d === '-' && v === 'proj_cache'));
    assert.ok(!rows.some((row) => row[4] === ANON || row[4] === 'proj-other_x'));
    assert.equal(new Set(rows.map((row) => row[5])).size, NAMED.length);
    // The .info: key value lines (the console collector), complete set, anonymous volumes named, no secret anywhere.
    const info = fs.readFileSync(archive + '.info', 'utf8');
    for (const re of [/^created \d{8}T\d{6}Z$/m, /^project proj$/m, /^mode online$/m, /^containers +backend-new backend-old router console$/m,
      new RegExp(`^skipped-anonymous-volumes +${ANON}$`, 'm'),
      /^databases licenses=ssam-tokens-\S+ update_server=ssam-db-update_server-\S+ coolify=ssam-db-coolify-\S+$/m,
      /^service ssam-service-/m]) assert.match(info, re);
    assert.match(r.stdout, /backup: OK /);
    assert.ok(!(r.stdout + r.stderr + info).includes(SECRET), 'a secret was printed');
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('backup refuses an update_server or Coolify dump of another major, of another database, or empty', () => {
  const cases = [
    [{extra: {UPD_PG_DUMP: 'pg_dump (PostgreSQL) 18.1'}}, /BACKUP_PG_DUMP_MAJOR: the update_server container upd has PostgreSQL 17 and pg_dump 18/],
    [{upd: UPDATE_SERVER.replace('-- Dumped by pg_dump version 17.11', '-- Dumped by pg_dump version 16.4')}, /BACKUP_PG_DUMP_MAJOR: the update_server dump says server 17, pg_dump 16/],
    [{upd: LICENSES.replace(/18\.[16]/g, '17.11')}, /BACKUP_DUMP_NO_EXPECTED_TABLES: the update_server dump \(upd\) has no table releases/],
    [{cool: ''}, /BACKUP_DUMP_EMPTY: pg_dump of the coolify database wrote nothing/],
    [{extra: {UPD2: '1'}}, /BACKUP_DB_NOT_FOUND: expected one running postgres container with POSTGRES_DB=update_server, found upd upd2/],
    [{extra: {UPD_MISSING: '1'}}, /BACKUP_DB_NOT_FOUND: .*found none/],
  ];
  for (const [opts, code] of cases) {
    const s = setup(LICENSES, opts);
    try {
      const r = backupArgs(s);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, code);
      // Nothing that looks like a complete set: no window archive, no .info, no partial file, no volume copied.
      assert.deepEqual(fs.readdirSync(s.out).filter((f) => /^ssam-state-|\.partial/.test(f)), []);
      assert.doesNotMatch(s.calls(), /:\/source:ro/);
      assert.ok(!(r.stdout + r.stderr).includes(SECRET));
    } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
  }
});

test('backup refuses an empty server-state and a disk without room, and leaves no archive', () => {
  for (const [extra, code] of [[{EMPTY_STATE: '1'}, /BACKUP_STATE_EMPTY: the server-state volume proj_server-state is empty/],
    [{SSAM_BACKUP_MIN_FREE_GB: '99999999'}, /BACKUP_DISK_LOW: .* GiB free, the backup needs 99999999 GiB; nothing was written/]]) {
    const s = setup(LICENSES, {extra});
    try {
      const r = backupArgs(s);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, code);
      assert.deepEqual(fs.readdirSync(s.out).filter((f) => /^ssam-state-|\.partial|^\.ssam-window-/.test(f)), []);
    } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
  }
});

test('backup without SSAM_DATABASE_URL is refused unless the server is a tokens.json one', () => {
  const s = setup(LICENSES);
  try {
    const mock = path.join(s.dir, 'docker.sh');
    fs.writeFileSync(mock, fs.readFileSync(mock, 'utf8').replace(/echo "SSAM_DATABASE_URL=[^"]*"/, 'echo SSAM_RUNTIME_DIR=/data/server'));
    const refused = backupArgs(s);
    assert.equal(refused.status, 2, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /BACKUP_NO_DATABASE_URL/);
    s.env.SSAM_BACKUP_REQUIRE_DATABASE = '0'; s.env.SSAM_BACKUP_DATABASES = '';
    const r = backupArgs(s);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(fs.readFileSync(path.join(s.out, fs.readdirSync(s.out).find((f) => f.endsWith('.tar.gz.info'))), 'utf8'), /^databases none$/m);
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('retention removes only this folder\'s sets older than --keep-days, after a good run', () => {
  const s = setup(LICENSES);
  try {
    const old = Date.now() / 1000 - 30 * 86400;
    const oldFiles = ['ssam-state-20261001T033001Z.tar.gz', 'ssam-state-20261001T033001Z.tar.gz.sha256', 'ssam-state-20261001T033001Z.tar.gz.info',
      'ssam-tokens-20261001T033001Z.sql.gz', 'ssam-db-coolify-20261001T033001Z.sql.gz', 'ssam-service-20261001T033001Z.tar.gz'];
    const kept = ['cron.log', 'coolify-tokens-20261001T014201Z.sql.gz'];
    for (const f of [...oldFiles, ...kept]) { fs.writeFileSync(path.join(s.out, f), 'x'); fs.utimesSync(path.join(s.out, f), old, old); }
    fs.mkdirSync(path.join(s.out, 'pre-r44')); fs.writeFileSync(path.join(s.out, 'pre-r44', 'licenses.sql.gz'), 'x');
    fs.utimesSync(path.join(s.out, 'pre-r44', 'licenses.sql.gz'), old, old);
    // A failed run removes nothing.
    s.env.UPD2 = '1';
    assert.equal(backupArgs(s, '--keep-days', '14').status, 2);
    for (const f of oldFiles) assert.ok(fs.existsSync(path.join(s.out, f)), `a failed run removed ${f}`);
    delete s.env.UPD2;
    const r = backupArgs(s, '--keep-days', '14');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const f of oldFiles) assert.ok(!fs.existsSync(path.join(s.out, f)), `kept ${f}`);
    for (const f of kept) assert.ok(fs.existsSync(path.join(s.out, f)), `removed ${f}`);
    assert.ok(fs.existsSync(path.join(s.out, 'pre-r44', 'licenses.sql.gz')), 'removed a pre-redeploy backup');
    assert.equal(fs.readdirSync(s.out).filter((f) => /^ssam-state-.*\.tar\.gz$/.test(f)).length, 1);
    assert.match(r.stdout, /removed .*ssam-state-20261001T033001Z\.tar\.gz \(older than 14 days\)/);
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('restore puts every archived volume back, router, console and unmounted ones included, only with all stopped', () => {
  const s = setup(LICENSES);
  try {
    assert.equal(backupArgs(s).status, 0);
    const archive = path.join(s.out, fs.readdirSync(s.out).find((f) => /^ssam-state-.*\.tar\.gz$/.test(f)));
    const restore = () => spawnSync(bash, [slash(ssamctl), 'restore', slash(archive)], {encoding: 'utf8', env: s.env});
    s.env.RUNNING = 'false'; s.env.ROUTER_RUNNING = 'true';
    const refused = restore();
    assert.equal(refused.status, 2, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /stop all archived containers/);
    assert.doesNotMatch(s.calls(), /:\/restore /);
    s.env.ROUTER_RUNNING = 'false';
    const r = restore();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const restored = s.calls().split('\n').filter((l) => /:\/restore /.test(l)).map((l) => l.match(/-v (\S+):\/restore/)[1]);
    assert.deepEqual([...restored].sort(), [...NAMED].sort());
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('backup.sh --online refuses a compose project with no running server instead of archiving stale volumes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-sh-'));
  try {
    const mock = path.join(dir, 'docker.sh');
    fs.writeFileSync(mock, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CALLS"\nexit 0\n');
    const envFile = path.join(dir, '.env'); fs.writeFileSync(envFile, 'COMPOSE_PROJECT_NAME=ssam-prod\nBACKUP_KEEP_DAYS=14\n');
    const out = path.join(dir, 'out'); fs.mkdirSync(out);
    const r = spawnSync(bash, [slash(fileURLToPath(new URL('../backup.sh', import.meta.url))), '--online', '--dir', posix(out)],
      {encoding: 'utf8', env: {...process.env, DOCKER: `sh ${slash(mock)}`, CALLS: slash(path.join(dir, 'calls')), SSAM_ENV_FILE: posix(envFile)}});
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /BACKUP_SERVER_NOT_RUNNING: --online but the compose project ssam-prod has no running ssam-server/);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'calls'), 'utf8'), /run --rm --no-deps/);
    assert.deepEqual(fs.readdirSync(out), []);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
