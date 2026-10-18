// app-profile.mjs: the port of kernel/scripts/configure_app_profile.py. Every test works in its own temp folder with a
// synthetic SSAM checkout (layout, facade entry, O11 lane CLI) and a fake node; user folders in `env` are temp ones.
// Parity: tests/fixtures/app-profile-python-*.{toml,json} are what the Python wrote once in a temp folder (paths as
// placeholders, -EncodedCommand decoded); the JS output must equal them except the server and hook commands.
import './fixtures/isolated-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { workspaceRoot } from '../workspace.mjs';
import { APP_PROFILE_MARKER, appProfileCli, configureAppProfile, containsHybridHook, parseToml, renderAppProfile, TomlDecodeError } from '../app-profile.mjs';

const fixtures = path.join(workspaceRoot, 'platforms', 'odc', 'facade', 'tests', 'fixtures');
const fixture = name => fs.readFileSync(path.join(fixtures, name), 'utf8');
const codexInput = fixture('app-profile-codex-config.toml');
const sha = text => createHash('sha256').update(text).digest('hex');
const fwd = p => p.replaceAll('\\', '/');
const decode = command => Buffer.from(command.split(' -EncodedCommand ')[1], 'base64').toString('utf16le');
const ps = p => "'" + p.replaceAll("'", "''") + "'";
const hookScript = (node, adapter, workspace) => '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & ' + ps(node) + ' '
  + ps(adapter) + ' app-hook' + (workspace ? ' --workspace ' + ps(workspace) : '') + '; exit $LASTEXITCODE';
const get = (map, ...keys) => keys.reduce((v, k) => v.get(k), map);

function setup(t, { codexConfig = codexInput } = {}) {
  const T = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'app-profile-')));
  t.after(() => fs.rmSync(T, { recursive: true, force: true }));
  const mk = (...p) => { const dir = path.join(T, ...p); fs.mkdirSync(dir, { recursive: true }); return dir; };
  const root = mk('ssam');
  fs.writeFileSync(path.join(root, '.ssam-workspace.json'), JSON.stringify({ schema: 'ssam-workspace/1', kernel: 'kernel', odc: 'platforms/odc', o11Lane: 'ss4' }));
  const adapter = path.join(mk('ssam', 'platforms', 'odc', 'facade'), 'ssam.mjs');
  fs.writeFileSync(adapter, '// fixture\n');
  const cli = path.join(mk('ssam', 'kernel', '.local', 'cli'), 'anvil.dll');
  fs.writeFileSync(cli, 'fixture');
  const node = path.join(mk('node'), 'node.exe');
  fs.writeFileSync(node, 'fixture');
  const codexHome = mk('codex');
  const codexFile = path.join(codexHome, 'config.toml');
  if (codexConfig != null) fs.writeFileSync(codexFile, codexConfig);
  const workspace = mk("app's project");
  const env = { USERPROFILE: mk('home'), HOME: path.join(T, 'home'), APPDATA: mk('appdata'), LOCALAPPDATA: mk('local'),
    ANVIL_AUTHORITY_DIR: mk('authority'), ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', CODEX_HOME: codexHome };
  return { T, root, kernel: path.join(root, 'kernel'), adapter, cli, node, codexHome, codexFile, workspace, env,
    output: path.join(workspace, '.codex', 'config.toml'), options: { workspaceRoot: root, codexHome, node, env, cwd: T } };
}
// Every file under a folder with its bytes, to prove what a call wrote.
function tree(dir) {
  const files = {};
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files[path.relative(dir, p)] = fs.readFileSync(p).toString('base64'); } };
  walk(dir);
  return files;
}

test('new profile: writes only <workspace>/.codex/config.toml, managed, valid TOML, awaiting client proof', t => {
  const s = setup(t);
  const before = tree(s.T);
  const result = configureAppProfile({ ...s.options, workspace: s.workspace });
  const after = tree(s.T);
  assert.deepEqual(Object.keys(after).filter(f => !(f in before)), [path.relative(s.T, s.output)]);
  assert.deepEqual(Object.keys(before).filter(f => after[f] !== before[f]), []); // the global Codex config is untouched
  const bytes = fs.readFileSync(s.output, 'utf8');
  assert.ok(bytes.startsWith(APP_PROFILE_MARKER));
  assert.equal(bytes.includes('\r\n'), os.EOL === '\r\n'); // text mode, as Python's write_text
  parseToml(bytes);
  assert.equal(result.configured, true);
  assert.equal(result.reviewPrepared, false);
  assert.equal(result.active, null);
  assert.equal(result.state, 'awaiting-client-proof');
  assert.equal(result.requiresHookTrust, true);
  assert.equal(result.changesDefaultProfile, false);
  assert.equal(result.capabilities.createApplication, false);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.tools, ['context', 'propose', 'continue', 'status']);
  assert.equal(result.workspace, s.workspace);
  assert.equal(result.configuration, s.output);
  assert.equal(result.projectConfiguration, s.output);
  assert.equal(result.configurationSha256, sha(fs.readFileSync(s.output)));
  assert.deepEqual(result.files, { controller: { path: s.cli, sha256: sha('fixture') }, adapter: { path: s.adapter, sha256: sha('// fixture\n') },
    node: { path: s.node, sha256: sha('fixture') } });
});

test('existing profile: identical rewrite (idempotent), an edited one goes back to generated, an unmanaged one is kept', t => {
  const s = setup(t);
  configureAppProfile({ ...s.options, workspace: s.workspace });
  const first = fs.readFileSync(s.output);
  assert.equal(configureAppProfile({ ...s.options, workspace: s.workspace }).configured, true);
  assert.deepEqual(fs.readFileSync(s.output), first);
  fs.writeFileSync(s.output, fs.readFileSync(s.output, 'utf8').replace('required = true', 'required = false'));
  assert.equal(configureAppProfile({ ...s.options, workspace: s.workspace, check: true }).configured, false);
  configureAppProfile({ ...s.options, workspace: s.workspace });
  assert.deepEqual(fs.readFileSync(s.output), first);
  fs.writeFileSync(s.output, 'unmanaged = true\n');
  assert.throws(() => configureAppProfile({ ...s.options, workspace: s.workspace }),
    { code: 'UNMANAGED_CONFIGURATION', message: 'Refusing to replace a configuration not managed by SSAM Hybrid: ' + s.output });
  assert.equal(fs.readFileSync(s.output, 'utf8'), 'unmanaged = true\n');
});

test('ssam_hybrid server: node + ssam.mjs app-mcp, only the four tools, every other server disabled', t => {
  const s = setup(t);
  const text = renderAppProfile({ ...s.options, workspace: s.workspace });
  const doc = parseToml(text);
  const server = get(doc, 'mcp_servers', 'ssam_hybrid');
  assert.equal(server.get('command'), fwd(s.node));
  assert.deepEqual(server.get('args'), [fwd(s.adapter), 'app-mcp', '--workspace', fwd(s.workspace)]);
  assert.deepEqual([...server].filter(([k]) => !['command', 'args'].includes(k)),
    [['enabled', true], ['required', true], ['tool_timeout_sec', 600], ['enabled_tools', ['context', 'propose', 'continue', 'status']]]);
  // Python order and quoting quirks kept: names in file order, '\' read as '/', the old ssam_hybrid replaced.
  assert.deepEqual([...get(doc, 'mcp_servers').keys()], ['some_other_tool', 'odd name.with dot', 'back/slash', '123', 'ssam_hybrid']);
  for (const [name, entry] of get(doc, 'mcp_servers')) if (name !== 'ssam_hybrid') assert.deepEqual([...entry], [['enabled', false]]);
  for (const gone of ['ssam_app.py', '--cli', 'python']) assert.ok(!text.includes(gone), gone);
  assert.equal(get(doc, 'features', 'shell_tool'), false);
  assert.equal(get(doc, 'features', 'hooks'), true);
  assert.equal(doc.has('profile'), false);
});

test('UserPromptSubmit/PreToolUse hooks: the encoded PowerShell runs ssam.mjs app-hook', t => {
  const s = setup(t);
  const doc = parseToml(renderAppProfile({ ...s.options, workspace: s.workspace }));
  assert.deepEqual([...get(doc, 'hooks').keys()], ['UserPromptSubmit', 'PreToolUse']);
  for (const event of ['UserPromptSubmit', 'PreToolUse']) {
    const entries = get(doc, 'hooks', event);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].get('matcher'), event === 'PreToolUse' ? '.*' : undefined);
    const [hook] = entries[0].get('hooks');
    assert.equal(hook.get('type'), 'command');
    assert.equal(hook.get('timeout'), 30);
    assert.match(hook.get('command'), /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/]+=*$/);
    assert.equal(decode(hook.get('command')), hookScript(s.node, s.adapter, s.workspace));
  }
  assert.equal(containsHybridHook(get(doc, 'hooks')), true);
});

test('--workspace reaches the server and the hooks (relative resolved by cwd); absent from the optional profile', t => {
  const s = setup(t);
  const relative = parseToml(renderAppProfile({ ...s.options, workspace: "app's project" }));
  assert.deepEqual(get(relative, 'mcp_servers', 'ssam_hybrid', 'args').slice(2), ['--workspace', fwd(s.workspace)]);
  const profile = renderAppProfile({ ...s.options, out: path.join(s.T, 'profile', 'ssam-app.toml') });
  const doc = parseToml(profile);
  assert.deepEqual(get(doc, 'mcp_servers', 'ssam_hybrid', 'args'), [fwd(s.adapter), 'app-mcp']);
  for (const event of ['UserPromptSubmit', 'PreToolUse'])
    assert.equal(decode(get(doc, 'hooks', event)[0].get('hooks')[0].get('command')), hookScript(s.node, s.adapter, null));
  assert.ok(!profile.includes('--workspace'));
  const result = configureAppProfile({ ...s.options, out: path.join(s.T, 'profile', 'ssam-app.toml') });
  assert.equal(result.configured, true);
  assert.equal(result.workspace, null);
  assert.equal(result.projectConfiguration, null);
  assert.equal(result.next[0], 'Select the ssam-app profile explicitly');
});

test('the Python refusals: global configuration (absent or managed), no destination, invalid TOML', t => {
  const s = setup(t);
  for (const content of [null, APP_PROFILE_MARKER + '\n']) {
    if (content == null) fs.rmSync(s.codexFile); else fs.writeFileSync(s.codexFile, content);
    for (const out of process.platform === 'win32' ? [s.codexFile, s.codexFile.toUpperCase()] : [s.codexFile]) for (const check of [false, true])
      assert.throws(() => configureAppProfile({ ...s.options, out, check }),
        { code: 'GLOBAL_CODEX_CONFIGURATION', message: 'Refusing to modify the global Codex configuration; select a dedicated workspace or optional profile' });
    assert.equal(fs.existsSync(s.codexFile) ? fs.readFileSync(s.codexFile, 'utf8') : null, content);
  }
  // A Codex home inside the workspace makes the project file the global one.
  assert.throws(() => configureAppProfile({ ...s.options, codexHome: path.join(s.workspace, '.codex'), workspace: s.workspace }), { code: 'GLOBAL_CODEX_CONFIGURATION' });
  assert.throws(() => configureAppProfile({ ...s.options }), { code: 'USAGE', message: '--out or --workspace is required' });
  fs.writeFileSync(s.codexFile, 'a = 1 b = 2\n');
  assert.throws(() => configureAppProfile({ ...s.options, workspace: s.workspace }),
    error => error instanceof TomlDecodeError && error.message === 'Expected newline or end of document after a statement (at line 1, column 7)' && error.file === s.codexFile);
  assert.equal(fs.existsSync(s.output), false);
});

test('optional profile over a legacy configuration: read-only sandbox_mode, no named permissions', t => {
  const s = setup(t, { codexConfig: 'sandbox_mode = "workspace-write"\n' + codexInput });
  const doc = parseToml(renderAppProfile({ ...s.options, out: path.join(s.T, 'profile.toml') }));
  assert.equal(doc.get('sandbox_mode'), 'read-only');
  assert.equal(doc.has('permissions'), false);
  assert.equal(doc.has('default_permissions'), false);
  assert.deepEqual(get(doc, 'mcp_servers', 'ssam_hybrid', 'args'), [fwd(s.adapter), 'app-mcp']);
});

test('check: missing, edited or without controller is not ready; review copy; --cli compared with the lane CLI', t => {
  const s = setup(t);
  let result = configureAppProfile({ ...s.options, workspace: s.workspace, check: true });
  assert.equal(result.configured, false);
  assert.equal(result.state, 'configuration-incomplete');
  assert.deepEqual(result.problems, ['Configuration is missing or differs from the generated setup']);
  assert.equal(fs.existsSync(s.output), false);
  configureAppProfile({ ...s.options, workspace: s.workspace });
  assert.deepEqual(configureAppProfile({ ...s.options, workspace: s.workspace, check: true, cli: s.cli }).problems, []);
  assert.deepEqual(configureAppProfile({ ...s.options, workspace: s.workspace, check: true, cli: path.join(s.T, 'other.dll') }).problems,
    ['The app server runs the O11 lane CLI, not --cli: ' + s.cli]);
  fs.rmSync(s.cli); // the lane then names its Release build, as the server would (o11LaneOf)
  result = configureAppProfile({ ...s.options, workspace: s.workspace, check: true });
  assert.deepEqual(result.problems, ['controller file is missing: ' + path.join(s.kernel, 'src', 'Anvil.Cli', 'bin', 'Release', 'net8.0', 'anvil.dll')]);
  assert.equal(result.files.controller.sha256, null);
  fs.writeFileSync(s.cli, 'fixture');
  const review = path.join(s.T, 'review.toml');
  result = configureAppProfile({ ...s.options, workspace: s.workspace, out: review });
  assert.equal(result.reviewPrepared, true);
  assert.equal(result.configured, false);
  assert.equal(result.state, 'review-copy');
  assert.equal(result.configuration, review);
});

test('global SSAM hooks (Python or Node, plain or encoded) are a duplicate capture; the global file is untouched', t => {
  const s = setup(t);
  const nodeHook = get(parseToml(renderAppProfile({ ...s.options, workspace: s.workspace })), 'hooks', 'UserPromptSubmit')[0].get('hooks')[0].get('command');
  const pythonHook = 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from("& 'python.exe' -B 'C:\\x\\scripts\\ssam_app.py' --hook", 'utf16le').toString('base64');
  for (const command of [nodeHook, pythonHook, 'python -B C:/x/scripts/ssam_app.py --hook', 'node C:/x/ssam.mjs app-hook']) {
    fs.writeFileSync(s.codexFile, codexInput + '\n[[hooks.UserPromptSubmit]]\n[[hooks.UserPromptSubmit.hooks]]\ntype = "command"\ncommand = ' + JSON.stringify(command) + '\n');
    const original = fs.readFileSync(s.codexFile);
    const result = configureAppProfile({ ...s.options, workspace: s.workspace });
    assert.equal(result.configured, false);
    assert.deepEqual(result.problems, ['Global SSAM hooks already exist; review duplicate capture before using project hooks']);
    assert.deepEqual(fs.readFileSync(s.codexFile), original);
    assert.equal(configureAppProfile({ ...s.options, out: path.join(s.T, 'p.toml') }).configured, true); // optional profile: not checked, as in Python
  }
  assert.equal(containsHybridHook(parseToml('[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ncommand = "powershell.exe -EncodedCommand !!"')), false);
});

test('no path outside the given folders: Codex home, workspace, checkout, node and LOCALAPPDATA come from the options', t => {
  const s = setup(t);
  const doc = parseToml(renderAppProfile({ ...s.options, workspace: s.workspace }));
  const found = [...get(doc, 'permissions', 'ssam-app', 'filesystem').keys(), get(doc, 'mcp_servers', 'ssam_hybrid', 'command'),
    ...get(doc, 'mcp_servers', 'ssam_hybrid', 'args'),
    ...['UserPromptSubmit', 'PreToolUse'].flatMap(e => [...decode(get(doc, 'hooks', e)[0].get('hooks')[0].get('command')).matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replaceAll("''", "'")))];
  const absolute = found.filter(p => /^([A-Za-z]:[\\/]|\/)/.test(p));
  assert.equal(absolute.length, 12); // 3 denied folders, node, adapter and workspace in args, node/adapter/workspace in each hook
  for (const p of absolute) assert.ok(fwd(p).toLowerCase().startsWith(fwd(s.T).toLowerCase() + '/'), p);
  assert.deepEqual([...get(doc, 'permissions', 'ssam-app', 'filesystem').keys()],
    [fwd(path.join(s.env.LOCALAPPDATA, 'Anvil', 'authority')), fwd(s.codexHome), fwd(s.kernel)]);
  // Defaults resolved at run time: node is this process's, the Codex home is CODEX_HOME of the given env.
  const defaults = parseToml(renderAppProfile({ workspaceRoot: s.root, env: s.env, cwd: s.T, workspace: s.workspace }));
  assert.equal(get(defaults, 'mcp_servers', 'ssam_hybrid', 'command'), fwd(fs.realpathSync.native(process.execPath)));
  assert.ok(get(defaults, 'permissions', 'ssam-app', 'filesystem').has(fwd(s.codexHome)));
});

test('Python parity: same structure and keys; only the server and hook commands change', t => {
  const s = setup(t);
  fs.mkdirSync(path.join(s.T, 'codex-legacy'));
  fs.writeFileSync(path.join(s.T, 'codex-legacy', 'config.toml'), 'sandbox_mode = "workspace-write"\n' + codexInput);
  const swap = text => [[s.adapter, '<SSAM>'], [s.kernel, '<KERNEL>'], [s.node, '<NODE>'], [s.T, '<T>']].reduce((v, [from, to]) =>
    v.replaceAll(from, to).replaceAll(fwd(from), to), text);
  const normalize = text => swap(text.replace(/-EncodedCommand ([A-Za-z0-9+/=]+)"/g, (_, b64) => '-EncodedCommand {' + Buffer.from(b64, 'base64').toString('utf16le') + '}"'));
  // The only intended change, written once: python -B ssam_app.py --cli <dll> [--workspace W] --hook -> node ssam.mjs app-mcp|app-hook [--workspace W].
  const toNode = line => line.replace(/^command = "<PYTHON>"$/, 'command = "<NODE>"')
    .replace(/^args = \["-B", "<KERNEL>\/scripts\/ssam_app\.py", "--cli", "<T>\/anvil\.dll"(.*)\]$/, 'args = ["<SSAM>", "app-mcp"$1]')
    .replace(/& '<PYTHON>' -B '<KERNEL>\\scripts\\ssam_app\.py' --cli '<T>\\anvil\.dll'(.*) --hook;/, "& '<NODE>' '<SSAM>' app-hook$1;");
  const cases = { project: { workspace: s.workspace }, legacy: { codexHome: path.join(s.T, 'codex-legacy'), out: path.join(s.T, 'profile', 'ssam-app.toml') },
    profile: { out: path.join(s.T, 'profile2', 'ssam-app.toml') } };
  for (const [name, extra] of Object.entries(cases)) {
    const python = fixture(`app-profile-python-${name}.toml`).split('\n');
    const options = { ...s.options, ...extra };
    configureAppProfile(options);
    const js = normalize(fs.readFileSync(path.resolve(s.T, extra.out ?? s.output), 'utf8').replace(/\r\n/g, '\n')).split('\n');
    assert.deepEqual(js, python.map(toNode), name);
    const changed = python.filter(line => toNode(line) !== line);
    assert.equal(changed.length, 4, name); // server command, server args, two hook commands
  }
  // The preflight report: the same keys and values; files name node instead of python.
  const deep = v => (typeof v === 'string' ? swap(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'sha256' || k === 'configurationSha256' ? (x ? '<sha>' : null) : deep(x)])) : v);
  const { files: pyFiles, ...python } = JSON.parse(fixture('app-profile-python-check.json'));
  const { files: jsFiles, ...js } = deep(configureAppProfile({ ...s.options, workspace: s.workspace, check: true }));
  assert.deepEqual(js, python);
  assert.deepEqual(Object.keys(jsFiles), ['controller', 'adapter', 'node']);
  assert.deepEqual(Object.keys(pyFiles), ['controller', 'adapter', 'python']);
});

test('ssam app-profile CLI: the Python exit codes (0 ready, 1 refused/incomplete, 2 usage) and the preflight JSON', t => {
  const s = setup(t);
  const deps = { env: s.env, cwd: s.T, workspaceRoot: s.root };
  let out = appProfileCli(['--workspace', s.workspace, '--node', s.node], deps);
  assert.equal(out.exitCode, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).configured, true);
  assert.ok(fs.readFileSync(s.output, 'utf8').includes(`"${fwd(s.codexHome)}" = "deny"`)); // CODEX_HOME of env
  out = appProfileCli(['--workspace=' + s.workspace, '--node=' + s.node, '--check', '--codex-home', s.codexHome], deps);
  assert.equal(out.exitCode, 0);
  assert.equal(JSON.parse(out.stdout).state, 'awaiting-client-proof');
  out = appProfileCli(['--workspace', s.workspace, '--check'], deps); // another node: differs from the generated file
  assert.equal(out.exitCode, 1);
  assert.equal(JSON.parse(out.stdout).state, 'configuration-incomplete');
  out = appProfileCli(['--out', s.codexFile], deps);
  assert.equal(out.exitCode, 1);
  assert.equal(JSON.parse(out.stderr).code, 'GLOBAL_CODEX_CONFIGURATION');
  for (const args of [[], ['--check'], ['--workspace'], ['--out', '--check'], ['--bogus', 'x']]) {
    out = appProfileCli(args, deps);
    assert.equal(out.exitCode, 2, args.join(' '));
    assert.equal(JSON.parse(out.stderr).code, 'USAGE');
  }
  assert.equal(appProfileCli(['--help'], deps).exitCode, 0);
});

test('TOML: the tomllib acceptance and messages (sample; 148 cases compared with Python 3.12)', () => {
  const plain = v => (v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)])) : Array.isArray(v) ? v.map(plain) : v);
  assert.deepEqual(plain(parseToml("[projects.'C:\\Users\\x']\ntrust_level = \"trusted\"\n[a]\nb.c = 1\nd = { e = [1, 0x1F, 1e3, \"\\u00e9\"] }\n[[f]]\n[[f]]\ng = '''\nx'''")),
    { projects: { 'C:\\Users\\x': { trust_level: 'trusted' } }, a: { b: { c: 1 }, d: { e: [1, 31, 1000, 'é'] } }, f: [{}, { g: 'x' }] });
  assert.deepEqual(plain(parseToml('[fruit]\napple.color = "red"\n[fruit.apple.texture]\nsmooth = true\r\n')), { fruit: { apple: { color: 'red', texture: { smooth: true } } } });
  assert.equal(parseToml('x = 2020-02-29').get('x').kind, 'date');
  const refused = {
    '= 1': 'Invalid statement (at line 1, column 1)',
    'a = 1\na = 2': 'Cannot overwrite a value (at end of document)',
    '[a]\nb = 1\n[a]': "Cannot declare ('a',) twice (at line 3, column 3)",
    '[fruit]\napple.color = "red"\n[fruit.apple]': "Cannot declare ('fruit', 'apple') twice (at line 3, column 13)",
    'a = {b = 1}\na.c = 2': "Cannot mutate immutable namespace ('a',) (at end of document)",
    '[a]\n[[a]]': 'Cannot overwrite a value (at line 2, column 4)',
    '[a.b.c]\nz=1\n[a]\nb.c.t = 1': "Cannot redefine namespace ('a', 'b', 'c') (at end of document)",
    'x = 2021-02-30': 'Invalid date or datetime (at line 1, column 5)',
    'x = 012': 'Expected newline or end of document after a statement (at line 1, column 6)',
    'x = "\\uD800"': 'Escaped character is not a Unicode scalar value (at line 1, column 12)',
    'x = "del\u007f"': "Illegal character '\\x7f' (at line 1, column 9)",
    "x = 'lit\nnl'": "Found invalid character '\\n' (at line 1, column 9)",
    'x = { a = 1,\n b = 2 }': 'Invalid initial character for a key part (at line 1, column 13)',
    'x = { a = 1, a = 2 }': "Duplicate inline table key 'a' (at line 1, column 19)",
    'x = [1 2]': 'Unclosed array (at line 1, column 8)',
    'a = 1\rb = 2': 'Expected newline or end of document after a statement (at line 1, column 6)',
    '\ufeffa = 1': 'Invalid statement (at line 1, column 1)',
  };
  for (const [text, message] of Object.entries(refused)) assert.throws(() => parseToml(text), error => error instanceof TomlDecodeError && error.message === message, text);
});

// The commands as written, against the real facade (offline: tools/list and an event that never reaches the host).
const smokeEnv = s => ({ ...process.env, ...s.env });

test('the written server really starts: node <checkout>/platforms/odc/facade/ssam.mjs app-mcp lists the four tools', async t => {
  const s = setup(t);
  const doc = parseToml(renderAppProfile({ codexHome: s.codexHome, env: s.env, cwd: s.T, workspace: s.workspace }));
  const server = get(doc, 'mcp_servers', 'ssam_hybrid');
  const env = smokeEnv(s);
  const client = new Client({ name: 'app-profile-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: server.get('command'), args: server.get('args'), env, stderr: 'ignore' }));
  try { assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['context', 'continue', 'propose', 'status']); }
  finally { await client.close(); }
});

test('the written hook really runs: PowerShell -> ssam.mjs app-hook reads the event on stdin and returns exit 2', { skip: process.platform !== 'win32' }, t => {
  const s = setup(t);
  const doc = parseToml(renderAppProfile({ codexHome: s.codexHome, env: s.env, cwd: s.T, workspace: s.workspace }));
  const command = get(doc, 'hooks', 'UserPromptSubmit')[0].get('hooks')[0].get('command');
  const env = smokeEnv(s);
  // An event the hook does not handle: refused before any host call (runHook), so no CLI or Studio is involved.
  const run = spawnSync(command, { shell: true, input: JSON.stringify({ hook_event_name: 'Stop', cwd: s.workspace }), env, encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 2, run.stderr);
  assert.ok(run.stderr.includes('SSAM could not capture the original user request: Unsupported SSAM hook event'), run.stderr);
  assert.equal(run.stdout, '');
});
