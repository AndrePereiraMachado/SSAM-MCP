// The production backup of the Coolify resource (ssamctl.sh backup: the daily cron and backup-before-redeploy.sh).
// 2026-11-01: the pre-deploy backup dumped the update_server's database, and `ssamctl.sh backup` with pg_dump 17 against
// PostgreSQL 18.6 wrote an empty file. 2026-11-09: the daily cron archived the retired ssam-prod volumes every night; the
// review of the fix asked for no secret on any command line, content floors, set-based retention, tar exit 1 tolerance.
// Headless: a fake docker (which runs the in-container tar scripts with a fake tar) and a fake ssh; no container, no VPS.
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
const SECRET = 'pw-never-printed-91';
const APP_KEY = 'base64:app-key-never-printed-77';

const LICENSES = `--
-- PostgreSQL database dump
--
-- Dumped from database version 18.6
-- Dumped by pg_dump version 18.6
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
// The licenses schema with no license: a recreated or reset database.
const LICENSES_EMPTY = LICENSES.replace(/COPY public\.server_tokens[\s\S]*$/, '');
// The update_server's database: what the old pre-deploy backup dumped.
const WRONG = `-- Dumped from database version 17.5
CREATE TABLE public.releases (
    id text NOT NULL
);
`;
// The other two databases of the VPS: their expected tables, and rows in the floor table (releases, servers).
const UPDATE_SERVER = `-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11
${['_prisma_migrations', 'apps', 'artifacts', 'releases'].map((t) => `CREATE TABLE public.${t} (\n    id text NOT NULL\n);`).join('\n')}
COPY public.releases (id) FROM stdin;
rel_1
\\.
`;
const COOLIFY = `-- Dumped from database version 15.19
-- Dumped by pg_dump version 15.19
${['applications', 'instance_settings', 'migrations', 'servers', 'services'].map((t) => `CREATE TABLE public.${t} (\n    id bigint NOT NULL\n);`).join('\n')}
COPY public.servers (id) FROM stdin;
0
\\.
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

// A fake docker. Licenses: the container dbhost (DB_CONTAINER=0: not a container here, so the remote path with the
// pinned 17 client; SERVER_NUM is its server_version_num), dumped from DUMP (exit DUMP_EXIT); DB_URL_DB is the database
// the URL names. update_server (container upd) and Coolify (coolify-db) dump UPD_DUMP and COOL_DUMP. Every in-container
// tar script (`--entrypoint sh ... -c <script>`) really runs, with a fake tar that archives VOLDIR (EMPTYDIR for an empty
// server-state) and exits TAR_EXIT1_VOLUME -> 1, TAR_FAIL_VOLUME -> 2, TAR_STATE_RC for the kernels state copy.
function fakeDocker(dir) {
  const mock = path.join(dir, 'docker.sh');
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'tar'), `#!/bin/sh
case "$*" in *z*) "$REALTAR" -czf - -C "$SRC" .;; *) "$REALTAR" -cf - -C "$SRC" .;; esac
exit "\${TAR_RC:-0}"
`);
  fs.writeFileSync(path.join(dir, 'mounts.tsv'), MOUNTS.map((m) => m.join('\t')).join('\n') + '\n');
  fs.writeFileSync(mock, `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
for last in "$@"; do :; done
script=; prev=; vol=
for a in "$@"; do [ "$prev" = -c ] && [ -z "$script" ] && script=$a; case "$a" in *:/source:ro) vol=\${a%%:*};; esac; prev=$a; done
REALTAR=$(command -v tar); export REALTAR
runtar() { SRC=$1 TAR_RC=$2 PATH="$FAKEBIN:$PATH" sh -c "$script"; }
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
  *) echo "SSAM_DATABASE_URL=postgres://ssam:${SECRET}@dbhost:5432/\${DB_URL_DB:-postgres}";; esac;;
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
'exec dbhost'*'--version'*) printf 'postgres (PostgreSQL) 18.6\\npg_dump (PostgreSQL) 18.6\\n';;
'exec upd'*'--version'*) printf '%s\\n' "\${UPD_VERSIONS:-postgres (PostgreSQL) 17.11}" "\${UPD_PG_DUMP:-pg_dump (PostgreSQL) 17.11}";;
'exec coolify-db'*'--version'*) printf 'postgres (PostgreSQL) 15.19\\npg_dump (PostgreSQL) 15.19\\n';;
'exec dbhost'*'pg_dump -U'*) [ -n "$DUMP" ] && cat "$DUMP"; exit "\${DUMP_EXIT:-0}";;
'exec upd'*'pg_dump -U'*) [ -n "$UPD_DUMP" ] && cat "$UPD_DUMP"; exit 0;;
'exec coolify-db'*'pg_dump -U'*) [ -n "$COOL_DUMP" ] && cat "$COOL_DUMP"; exit 0;;
*'run'*'show server_version_num'*) [ -n "$SSAM_DATABASE_URL" ] || exit 9; echo "$SERVER_NUM";;
*'run'*'postgres:17'*'pg_dump --version'*) echo 'pg_dump (PostgreSQL) 17.11';;
*'run'*'pg_dump --version'*) echo 'pg_dump (PostgreSQL) 18.1';;
*'run'*'exec pg_dump --no-owner'*) [ -n "$SSAM_DATABASE_URL" ] || exit 9; [ -n "$DUMP" ] && cat "$DUMP"; exit "\${DUMP_EXIT:-0}";;
*'run'*'/source/state:ro'*) runtar "$VOLDIR" "\${TAR_STATE_RC:-0}";;
*'run'*':/source:ro'*) src=$VOLDIR; [ "$vol" = proj_server-state ] && [ "$EMPTY_STATE" = 1 ] && src=$EMPTYDIR
  rc=0; [ "$vol" = "$TAR_EXIT1_VOLUME" ] && rc=1; [ "$vol" = "$TAR_FAIL_VOLUME" ] && rc=2; runtar "$src" "$rc";;
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
  const vol = path.join(dir, 'vol'); fs.mkdirSync(path.join(vol, 'customers', 'tok_a'), {recursive: true});
  fs.writeFileSync(path.join(vol, 'kernel.json'), '{}'); fs.writeFileSync(path.join(vol, 'customers', 'tok_a', 'w.json'), '{}');
  const empty = path.join(dir, 'empty'); fs.mkdirSync(empty);
  const services = path.join(dir, 'services', 'proj'); fs.mkdirSync(services, {recursive: true});
  fs.writeFileSync(path.join(services, 'docker-compose.yml'), 'services: {}\n'); fs.writeFileSync(path.join(services, '.env'), `X=${SECRET}\n`);
  const sourceEnv = write('coolify-source.env', `APP_KEY=${APP_KEY}\n`);
  fakeDocker(dir);
  const env = {...process.env, DOCKER: `sh ${slash(path.join(dir, 'docker.sh'))}`, CALLS: slash(path.join(dir, 'calls')), DB_CONTAINER: db,
    SERVER_NUM: server, DUMP: dump === null ? '' : dumpFile, DUMP_EXIT: exit, MSYS_NO_PATHCONV: '1',
    UPD_DUMP: upd === null ? '' : write('upd.sql', upd), COOL_DUMP: cool === null ? '' : write('cool.sql', cool),
    MOUNTS: slash(path.join(dir, 'mounts.tsv')), VOLDIR: posix(vol), EMPTYDIR: posix(empty), FAKEBIN: posix(path.join(dir, 'bin')),
    SSAM_COOLIFY_SERVICES_DIR: posix(path.join(dir, 'services')), SSAM_COOLIFY_SOURCE_ENV: posix(sourceEnv), SSAM_BACKUP_MIN_FREE_GB: '0'};
  for (const k of ['PG_IMAGE', 'SSAM_BACKUP_DATABASES', 'SSAM_BACKUP_REQUIRE_DATABASE', 'BACKUP_KEEP_DAYS', 'SSAM_CONTAINER', 'SSAM_PROJECT',
    'SSAM_DATABASE_URL', 'SSAM_BACKUP_KEEP_SETS', 'SSAM_BACKUP_ALLOW_SHRINK', 'SSAM_BACKUP_STATE_REQUIRED', 'SSAM_BACKUP_MIN_RATIO']) delete env[k];
  Object.assign(env, extra);
  return {dir, out, env, calls: () => fs.readFileSync(path.join(dir, 'calls'), 'utf8')};
}
const backup = (s, ...args) => spawnSync(bash, [slash(ssamctl), 'backup', ...args, slash(s.out)], {encoding: 'utf8', env: s.env});
const files = (s, re) => fs.readdirSync(s.out).filter((f) => re.test(f));
const gunzip = (f) => zlib.gunzipSync(fs.readFileSync(f)).toString();
const run = (s, command) => spawnSync(bash, ['-c', command], {encoding: 'utf8', env: s.env});
function manifestOf(s, archive) {
  const r = run(s, `tar --force-local -xzf "${posix(archive)}" -O manifest.tsv`);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split('\n').slice(1).map((l) => l.split('\t'));
}
const noSecret = (s, ...texts) => {
  for (const t of [...texts, s.calls()]) { assert.ok(!t.includes(SECRET), 'the database password was printed or put on a command line'); assert.ok(!t.includes(APP_KEY), 'the APP_KEY was printed'); }
};
// A failed run leaves nothing in the folder: no orphan dump, no staging or work folder, no partial file.
const nothingLeft = (s) => assert.deepEqual(fs.readdirSync(s.out), []);

test('backup dumps the licenses with the pg_dump inside their own container, over the local socket', () => {
  const s = setup(LICENSES);
  try {
    const r = backup(s);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const [dump] = files(s, /^ssam-tokens-.*\.sql\.gz$/);
    assert.ok(dump, 'no ssam-tokens dump');
    assert.match(gunzip(path.join(s.out, dump)), /CREATE TABLE public\.server_tokens/);
    assert.equal(files(s, /\.partial|^\.set-/).length, 0);
    const dumps = s.calls().split('\n').filter((l) => /^exec dbhost sh -c exec pg_dump -U/.test(l));
    assert.equal(dumps.length, 1);
    assert.doesNotMatch(s.calls(), /postgres:17|exec pg_dump --no-owner/);
    assert.match(r.stdout, /licenses database: container dbhost, PostgreSQL 18 dumped by pg_dump 18, .*server_tokens rows: 2/);
    noSecret(s, r.stdout, r.stderr);
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('backup refuses loudly a dump of another database, before the volumes are copied', () => {
  const s = setup(WRONG);
  try {
    const r = backup(s);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /BACKUP_DUMP_NO_LICENSE_TABLES: the licenses dump \(dbhost\) has no table server_tokens/);
    nothingLeft(s);
    assert.doesNotMatch(s.calls(), /\/source:ro|exec upd|exec coolify-db/);
    noSecret(s, r.stdout, r.stderr);
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('backup refuses an empty dump, a failed pg_dump, a licenses database with no license, and a URL naming another database', () => {
  for (const [dump, opts, code] of [['', {}, /BACKUP_DUMP_EMPTY/], [LICENSES, {exit: '1'}, /BACKUP_DUMP_FAILED/],
    [LICENSES_EMPTY, {}, /BACKUP_DUMP_NO_ROWS: the licenses dump \(dbhost\) has 0 rows in server_tokens/],
    [LICENSES, {extra: {DB_URL_DB: 'other'}}, /BACKUP_DB_MISMATCH: the database named in SSAM_DATABASE_URL of backend-new is not the POSTGRES_DB of its container dbhost/]]) {
    const s = setup(dump, opts);
    try {
      const r = backup(s);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, code);
      assert.match(r.stderr, /backup: FAILED \(exit 2\)/);
      nothingLeft(s);
      noSecret(s, r.stdout, r.stderr);
    } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
  }
});

test('a remote licenses database: the URL only in the environment, and a pg_dump older than the server is refused', () => {
  const s = setup(LICENSES, {db: '0'});
  try {
    const r = backup(s);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /BACKUP_PG_DUMP_TOO_OLD: pg_dump 17 cannot dump a PostgreSQL 18 server/);
    assert.doesNotMatch(s.calls(), /exec pg_dump --no-owner/);
    assert.match(s.calls(), /run --rm -i --network coolify .* -e SSAM_DATABASE_URL postgres:17\.11-alpine\S* sh -c exec psql "\$SSAM_DATABASE_URL"/);
    nothingLeft(s);
    noSecret(s, r.stdout, r.stderr);
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('the same fallback client still dumps a remote server of its own major version, with the URL in its environment', () => {
  const s = setup(LICENSES.replace(/version 18\.6/g, 'version 17.5'), {db: '0', server: '170005'});
  try {
    const r = backup(s);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(s.calls(), /-e SSAM_DATABASE_URL postgres:17\.11-alpine\S* sh -c exec pg_dump --no-owner --no-privileges "\$SSAM_DATABASE_URL"/);
    assert.match(r.stdout, /licenses database: remote, PostgreSQL 17 dumped by pg_dump 17, .*server_tokens rows: 2/);
    noSecret(s, r.stdout, r.stderr);
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
        assert.match(s.calls(), /run .*proj_server-state:\/source\/state:ro .*--entrypoint sh sha256:serverimage -c tar -czf - -C \/source state friction/);
      } else {
        assert.match(r.stderr, /BACKUP_DUMP_NO_LICENSE_TABLES/);
        assert.deepEqual(fs.readdirSync(dir).filter((f) => /^ssam-(tokens|state)-/.test(f)), []);
      }
      noSecret(s, r.stdout, r.stderr);
    } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
  }
});

test('backup-before-redeploy keeps the kernels state copy on tar exit 1 and stops with a code on any other failure', () => {
  for (const [rc, status] of [['1', 0], ['2', 2]]) {
    const s = setup(LICENSES, {extra: {TAR_STATE_RC: rc}});
    try {
      const env = {...s.env, SSAM_SSH: `sh ${slash(fakeSsh(s.dir))} root@vps`, SSAM_BACKUP_BASE: posix(s.out)};
      const r = spawnSync(bash, [slash(wrapper), 'online'], {encoding: 'utf8', env});
      assert.equal(r.status, status, r.stdout + r.stderr);
      const dir = path.join(s.out, 'pre-online');
      const state = fs.readdirSync(dir).filter((f) => /^state-/.test(f));
      if (status === 0) {
        assert.match(r.stderr, /a file changed while it was read \(online copy, tar exit 1\); kept/);
        assert.equal(state.filter((f) => /^state-.*\.tar\.gz$/.test(f)).length, 1);
        assert.equal(state.filter((f) => /\.sha256$/.test(f)).length, 1);
      } else {
        assert.match(r.stderr, /BACKUP_STATE_FAILED: the kernels state copy of backend-new failed/);
        assert.deepEqual(state, []);
      }
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

// --- The complete set: three databases, the Coolify definition with its APP_KEY, every volume of the resource. ---

test('backup writes the licenses, update_server and Coolify dumps, each with its own major, and every volume of the resource', () => {
  const s = setup(LICENSES);
  try {
    const r = backup(s);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = fs.readdirSync(s.out);
    const stamp = out.find((f) => /^ssam-state-.*\.tar\.gz$/.test(f)).slice('ssam-state-'.length, -'.tar.gz'.length);
    for (const f of [`ssam-tokens-${stamp}.sql.gz`, `ssam-db-update_server-${stamp}.sql.gz`, `ssam-db-coolify-${stamp}.sql.gz`,
      `ssam-service-${stamp}.tar.gz`, `ssam-state-${stamp}.tar.gz`]) {
      assert.ok(out.includes(f), `missing ${f}`);
      assert.ok(out.includes(f + '.sha256'), `missing ${f}.sha256`);
    }
    assert.deepEqual(out.filter((f) => /\.partial|^\.ssam-window-|^\.set-/.test(f)), [], 'work files left behind');
    assert.match(gunzip(path.join(s.out, `ssam-db-update_server-${stamp}.sql.gz`)), /CREATE TABLE public\.releases/);
    assert.match(gunzip(path.join(s.out, `ssam-db-coolify-${stamp}.sql.gz`)), /CREATE TABLE public\.instance_settings/);
    const calls = s.calls();
    assert.match(calls, /^exec dbhost sh -c exec pg_dump -U/m);
    assert.match(calls, /^exec upd sh -c exec pg_dump -U/m);
    assert.match(calls, /^exec coolify-db sh -c exec pg_dump -U/m);
    assert.doesNotMatch(calls, /postgres:17\.11-alpine/);
    assert.match(r.stdout, /update_server database: container upd, PostgreSQL 17 dumped by pg_dump 17, .*releases rows: 1/);
    assert.match(r.stdout, /coolify database: container coolify-db, PostgreSQL 15 dumped by pg_dump 15, .*servers rows: 1/);
    // The Coolify definition: the resource's compose and .env, and Coolify's own .env (APP_KEY), never printed.
    const service = run(s, `tar -tzf "${posix(path.join(s.out, `ssam-service-${stamp}.tar.gz`))}"`).stdout.split('\n').filter(Boolean).sort();
    assert.deepEqual(service, ['coolify-source.env', 'proj/.env', 'proj/docker-compose.yml']);
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
    const info = fs.readFileSync(archive + '.info', 'utf8');
    for (const re of [/^created \d{8}T\d{6}Z$/m, /^project proj$/m, /^mode online$/m, /^containers +backend-new backend-old router console$/m,
      new RegExp(`^skipped-anonymous-volumes +${ANON}$`, 'm'), /^state-files 2$/m, /^state-bytes \d+$/m,
      /^databases licenses=ssam-tokens-\S+ update_server=ssam-db-update_server-\S+ coolify=ssam-db-coolify-\S+$/m,
      /^service ssam-service-/m]) assert.match(info, re);
    assert.match(r.stdout, /backup: OK /);
    noSecret(s, r.stdout, r.stderr, info);
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('backup refuses an update_server or Coolify dump of another major, of another database, empty, without rows or ambiguous, leaving no orphan', () => {
  const cases = [
    [{extra: {UPD_PG_DUMP: 'pg_dump (PostgreSQL) 18.1'}}, /BACKUP_PG_DUMP_MAJOR: the update_server container upd has PostgreSQL 17 and pg_dump 18/],
    [{upd: UPDATE_SERVER.replace('-- Dumped by pg_dump version 17.11', '-- Dumped by pg_dump version 16.4')}, /BACKUP_PG_DUMP_MAJOR: the update_server dump says server 17, pg_dump 16/],
    [{upd: LICENSES.replace(/18\.6/g, '17.11')}, /BACKUP_DUMP_NO_EXPECTED_TABLES: the update_server dump \(upd\) has no table releases/],
    [{upd: UPDATE_SERVER.replace(/COPY public\.releases[\s\S]*$/, '')}, /BACKUP_DUMP_NO_ROWS: the update_server dump \(upd\) has 0 rows in releases/],
    [{cool: ''}, /BACKUP_DUMP_EMPTY: pg_dump of the coolify database wrote nothing/],
    [{extra: {UPD2: '1'}}, /BACKUP_DB_NOT_FOUND: expected one running postgres container with POSTGRES_DB=update_server, found upd upd2/],
    [{extra: {UPD_MISSING: '1'}}, /BACKUP_DB_NOT_FOUND: .*found none/],
  ];
  for (const [opts, code] of cases) {
    const s = setup(LICENSES, opts);
    try {
      const r = backup(s);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, code);
      // The licenses dump made before the failure went with the staging folder: no orphan for a later restore to pick.
      nothingLeft(s);
      assert.doesNotMatch(s.calls(), /:\/source:ro/);
      noSecret(s, r.stdout, r.stderr);
    } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
  }
});

test('a volume copy with tar exit 1 is kept; tar exit 2 stops the backup and cleans the staging and work folders', () => {
  for (const [extra, status] of [[{TAR_EXIT1_VOLUME: 'proj_cache-new'}, 0], [{TAR_FAIL_VOLUME: 'proj_cache-old'}, 2]]) {
    const s = setup(LICENSES, {extra});
    try {
      const r = backup(s);
      assert.equal(r.status, status, r.stdout + r.stderr);
      if (status === 0) {
        assert.match(r.stderr, /backup: a file changed while it was read \(online copy, tar exit 1\); kept/);
        assert.equal(files(s, /^ssam-state-.*\.tar\.gz\.info$/).length, 1);
        assert.deepEqual(files(s, /^\.set-|^\.ssam-window-|\.partial/), []);
      } else {
        assert.match(r.stderr, /BACKUP_VOLUME_FAILED: the copy of volume proj_cache-old failed/);
        assert.match(r.stderr, /backup: FAILED \(exit 2\)/);
        nothingLeft(s);
      }
    } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
  }
});

test('backup refuses an empty or reset server-state, a shrunk one, a disk without room, and a missing Coolify APP_KEY', () => {
  const previous = (s, files, bytes) => {
    fs.writeFileSync(path.join(s.out, 'ssam-state-20261101T033000Z.tar.gz.info'), `created 20261101T033000Z\nstate-files ${files}\nstate-bytes ${bytes}\ndatabases licenses=x\n`);
  };
  const cases = [
    [{EMPTY_STATE: '1'}, null, /BACKUP_STATE_EMPTY: the server-state volume proj_server-state is empty/],
    [{SSAM_BACKUP_STATE_REQUIRED: 'kernel.json customers/ machine-pins.json'}, null, /BACKUP_STATE_EMPTY: the server-state volume proj_server-state has no machine-pins.json/],
    [{}, [1000, 1], /BACKUP_SHRANK: server-state has 2 files \/ \d+ bytes, the previous set 1000 \/ 1 \(below 50%\)/],
    [{}, [1, 99999999], /BACKUP_SHRANK: .*the previous set 1 \/ 99999999/],
    [{SSAM_BACKUP_MIN_FREE_GB: '99999999'}, null, /BACKUP_DISK_LOW: .* GiB free, the backup needs 99999999 GiB; nothing was written/],
    [{SSAM_COOLIFY_SOURCE_ENV: '/nonexistent/.env'}, null, /BACKUP_SERVICE_FAILED: no \/nonexistent\/\.env \(Coolify's APP_KEY\)/],
  ];
  for (const [extra, prev, code] of cases) {
    const s = setup(LICENSES, {extra});
    try {
      if (prev) previous(s, ...prev);
      const r = backup(s, '--keep-days', '1');
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, code);
      assert.deepEqual(fs.readdirSync(s.out).filter((f) => !/^ssam-state-20261101T033000Z/.test(f)), []);
      if (prev) assert.ok(fs.existsSync(path.join(s.out, 'ssam-state-20261101T033000Z.tar.gz.info')), 'a refused run pruned');
      noSecret(s, r.stdout, r.stderr);
    } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
  }
  // An intended clean-up is accepted once with SSAM_BACKUP_ALLOW_SHRINK=1.
  const s = setup(LICENSES, {extra: {SSAM_BACKUP_ALLOW_SHRINK: '1'}});
  try { previous(s, 1000, 1); assert.equal(backup(s).status, 0); } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('backup without SSAM_DATABASE_URL is refused unless the server is a tokens.json one', () => {
  const s = setup(LICENSES);
  try {
    const mock = path.join(s.dir, 'docker.sh');
    fs.writeFileSync(mock, fs.readFileSync(mock, 'utf8').replace(/echo "SSAM_DATABASE_URL=[^"]*"/, 'echo SSAM_RUNTIME_DIR=/data/server'));
    const refused = backup(s);
    assert.equal(refused.status, 2, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /BACKUP_NO_DATABASE_URL/);
    s.env.SSAM_BACKUP_REQUIRE_DATABASE = '0'; s.env.SSAM_BACKUP_DATABASES = '';
    const r = backup(s);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(fs.readFileSync(path.join(s.out, files(s, /\.tar\.gz\.info$/)[0]), 'utf8'), /^databases none$/m);
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

// Old sets on disk: complete ones (an .info with a databases line), a legacy backup.sh one, an orphan dump.
function oldSet(s, stamp, {complete = true, days = 30} = {}) {
  const when = Date.now() / 1000 - days * 86400;
  const names = [`ssam-state-${stamp}.tar.gz`, `ssam-state-${stamp}.tar.gz.sha256`, `ssam-tokens-${stamp}.sql.gz`, `ssam-db-coolify-${stamp}.sql.gz`, `ssam-service-${stamp}.tar.gz`];
  for (const f of names) fs.writeFileSync(path.join(s.out, f), 'x');
  fs.writeFileSync(path.join(s.out, `ssam-state-${stamp}.tar.gz.info`), complete ? `created ${stamp}\nstate-files 2\nstate-bytes 1\ndatabases licenses=ssam-tokens-${stamp}.sql.gz\n` : `created ${stamp}\nproject ssam-prod\nmode stopped\n`);
  for (const f of [...names, `ssam-state-${stamp}.tar.gz.info`]) fs.utimesSync(path.join(s.out, f), when, when);
  return [...names, `ssam-state-${stamp}.tar.gz.info`];
}

test('retention keeps the 7 newest complete sets whatever their age, removes older sets whole, orphans and legacy sets by age', () => {
  const s = setup(LICENSES);
  try {
    // A cron that failed for weeks: eight complete sets, all 30+ days old; a legacy set; an orphan dump; other files.
    const complete = Array.from({length: 8}, (_, i) => `202609${String(10 + i).padStart(2, '0')}T033001Z`);
    const sets = Object.fromEntries(complete.map((st, i) => [st, oldSet(s, st, {days: 40 - i})]));
    const legacy = oldSet(s, '20261020T033001Z', {complete: false, days: 20});
    const orphan = 'ssam-tokens-20261021T033001Z.sql.gz'; fs.writeFileSync(path.join(s.out, orphan), 'x');
    const old = Date.now() / 1000 - 30 * 86400; fs.utimesSync(path.join(s.out, orphan), old, old);
    const kept = ['cron.log', 'coolify-tokens-20261001T014201Z.sql.gz'];
    for (const f of kept) { fs.writeFileSync(path.join(s.out, f), 'x'); fs.utimesSync(path.join(s.out, f), old, old); }
    fs.mkdirSync(path.join(s.out, 'pre-r44')); fs.writeFileSync(path.join(s.out, 'pre-r44', 'licenses.sql.gz'), 'x');
    fs.utimesSync(path.join(s.out, 'pre-r44', 'licenses.sql.gz'), old, old);
    // A failed run removes nothing.
    s.env.UPD2 = '1';
    assert.equal(backup(s, '--keep-days', '14').status, 2);
    for (const f of Object.values(sets).flat()) assert.ok(fs.existsSync(path.join(s.out, f)), `a failed run removed ${f}`);
    delete s.env.UPD2;
    const r = backup(s, '--keep-days', '14');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // The new set + the 6 newest old complete sets stay; the 2 oldest go whole, with the legacy set and the orphan.
    for (const st of complete.slice(2)) for (const f of sets[st]) assert.ok(fs.existsSync(path.join(s.out, f)), `removed ${f} of a protected set`);
    for (const st of complete.slice(0, 2)) for (const f of sets[st]) assert.ok(!fs.existsSync(path.join(s.out, f)), `kept ${f}`);
    for (const f of [...legacy, orphan]) assert.ok(!fs.existsSync(path.join(s.out, f)), `kept ${f}`);
    for (const f of kept) assert.ok(fs.existsSync(path.join(s.out, f)), `removed ${f}`);
    assert.ok(fs.existsSync(path.join(s.out, 'pre-r44', 'licenses.sql.gz')), 'removed a pre-redeploy backup');
    assert.equal(files(s, /^ssam-state-.*\.tar\.gz\.info$/).length, 7);
    assert.match(r.stdout, /removed .*ssam-state-20260910T033001Z\.tar\.gz \(set 20260910T033001Z, older than 14 days, not among the 7 newest complete sets\)/);
  } finally { fs.rmSync(s.dir, {recursive: true, force: true}); }
});

test('restore puts every archived volume back, router, console and unmounted ones included, only with all stopped', () => {
  const s = setup(LICENSES);
  try {
    assert.equal(backup(s).status, 0);
    const archive = path.join(s.out, files(s, /^ssam-state-.*\.tar\.gz$/)[0]);
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
