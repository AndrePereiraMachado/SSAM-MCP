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

// A fake docker. DB_CONTAINER=0 means the database is not a container on this host (only the pinned 17 fallback);
// SERVER_NUM is the server's server_version_num; DUMP is the file pg_dump writes.
function fakeDocker(dir) {
  const mock = path.join(dir, 'docker.sh');
  fs.writeFileSync(mock, `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
*'ps -a'*'name=dbhost'*) [ "$DB_CONTAINER" = 1 ] && echo dbhost; exit 0;;
*'ps -a'*'ssam.default=true'*) echo backend-new;;
*'ps -a'*'ssam.backend=true'*) echo backend-new;;
*'ps -a'*) echo backend-new;;
*'inspect'*'.Config.Env'*) echo "SSAM_DATABASE_URL=postgres://ssam:${SECRET}@dbhost:5432/ssam";;
*'inspect'*'.NetworkSettings.Networks'*) echo coolify;;
*'inspect --format {{.Image}} dbhost'*) echo sha256:pg18image;;
*'inspect'*'.Mounts'*) echo volume-x;;
*'inspect'*'ssam.odc'*) echo 1.7.30;;
*'inspect'*'ssam.o11'*) echo 11.55.94;;
*'inspect'*'image.revision'*) echo 4b6b213;;
*'inspect'*'.State.Running'*) echo true;;
*'inspect'*'.Config.Image'*) echo ssam-server:test;;
*'inspect'*'.Image'*) echo sha256:serverimage;;
*'run'*'show server_version_num'*) echo "$SERVER_NUM";;
*'run'*'postgres:17'*'pg_dump --version'*) echo 'pg_dump (PostgreSQL) 17.11';;
*'run'*'pg_dump --version'*) echo 'pg_dump (PostgreSQL) 18.1';;
*'run'*'pg_dump postgres:'*) [ -n "$DUMP" ] && cat "$DUMP"; exit "\${DUMP_EXIT:-0}";;
*'run'*'--entrypoint tar'*) echo volume-bytes;;
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
function setup(dump, {db = '1', server = '180006', exit = '0'} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-redeploy-'));
  const out = path.join(dir, 'out'); fs.mkdirSync(out);
  const dumpFile = path.join(dir, 'dump.sql'); fs.writeFileSync(dumpFile, dump);
  const env = {...process.env, DOCKER: `sh ${slash(fakeDocker(dir))}`, CALLS: slash(path.join(dir, 'calls')), DB_CONTAINER: db,
    SERVER_NUM: server, DUMP: dump === null ? '' : slash(dumpFile), DUMP_EXIT: exit, MSYS_NO_PATHCONV: '1'};
  delete env.PG_IMAGE;
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
    assert.doesNotMatch(s.calls(), /--entrypoint tar/);
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
        assert.match(r.stdout, /OK: licenses .*ssam-tokens-.*\.sql\.gz \(\d+ bytes, PostgreSQL 18\.6\), volumes .*ssam-state-/);
        assert.equal(fs.readdirSync(dir).filter((f) => /^ssam-tokens-.*\.sql\.gz$/.test(f)).length, 1);
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
