// The controlled app profile of the O11 lane in the facade's own process: a port of kernel/scripts/configure_app_profile.py
// with the same file, keys, refusals and idempotence (no backup: the Python keeps none). Only the two commands change:
// the MCP server `ssam_hybrid` is `node <root>/platforms/odc/facade/ssam.mjs app-mcp [--workspace <dir>]` and the
// hooks (UserPromptSubmit, PreToolUse) run `... ssam.mjs app-hook [--workspace <dir>]` inside the same PowerShell
// -EncodedCommand envelope. Neither takes --cli any more: the Node server runs the CLI of the O11 lane (o11LaneOf), so
// an explicit --cli is only compared with it. Never writes the global Codex configuration or hook trust; every folder
// comes from the options (Codex home, SSAM root, kernel, node, env, cwd), defaults resolved at run time.
//
// parseToml() is a port of CPython 3.12 Lib/tomllib/_parser.py (TOML 1.0) with the same acceptance and messages, so a
// configuration the Python refused is refused here. Tables are Maps: key order is kept, as in Python dicts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { workspaceRoot as installedRoot, resolveO11Lane } from './workspace.mjs';
import { o11LaneOf } from './o11-lane.mjs';

export const APP_PROFILE_MARKER = '# Managed by SSAM Hybrid: restricted app profile';
export const APP_PROFILE_TOOLS = ['context', 'propose', 'continue', 'status'];
const FEATURES_OFF = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'multi_agent', 'browser_use',
  'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'code_mode_host', 'workspace_dependencies'];
const USAGE = 'usage: ssam app-profile (--workspace <dir> | --out <file>) [--codex-home <dir>] [--cli <anvil.dll>] [--node <node.exe>] [--check]';

export class AppProfileError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// ---- paths, as pathlib sees them
const win = process.platform === 'win32';
// str(pathlib.Path(text)): '/' read as '\' on Windows, '.' parts and repeated or trailing separators dropped, '..' kept.
export function pathText(text) {
  const s = String(text);
  if (!win) { const parts = s.split('/').filter(p => p && p !== '.'); return (s.startsWith('/') ? '/' : '') + parts.join('/') || '.'; }
  const [, drive = '', root, rest] = /^(\\\\[^\\]+\\[^\\]+|[A-Za-z]:)?(\\?)(.*)$/s.exec(s.replace(/\//g, '\\'));
  return drive + root + rest.split('\\').filter(p => p && p !== '.').join('\\') || '.';
}
// Path.resolve() (strict=False): absolute, links of the longest existing prefix resolved, the rest appended.
export function resolvePath(text, cwd = process.cwd()) {
  const absolute = path.resolve(cwd, String(text));
  const tail = [];
  for (let head = absolute; ;) {
    try { return path.join(fs.realpathSync.native(head), ...tail); }
    catch { const parent = path.dirname(head); if (parent === head) return absolute; tail.unshift(path.basename(head)); head = parent; }
  }
}
// PureWindowsPath equality ignores case.
const samePath = (a, b) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
// Path.home(): USERPROFILE (then HOMEDRIVE+HOMEPATH) on Windows, HOME elsewhere.
const homeOf = env => (win ? env.USERPROFILE ?? (env.HOMEPATH != null ? (env.HOMEDRIVE ?? '') + env.HOMEPATH : os.homedir()) : env.HOME ?? os.homedir());
const stat = file => fs.statSync(file, { throwIfNoEntry: false });
const isFile = file => !!stat(file)?.isFile();
const isDir = file => !!stat(file)?.isDirectory();
// read_text(encoding='utf-8-sig'): strict UTF-8, one BOM dropped, universal newlines.
const readText = file => new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)).replace(/\r\n?/g, '\n');
const digest = file => (isFile(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);
function readToml(file) {
  if (!fs.existsSync(file)) return new Map();
  try { return parseToml(readText(file)); } catch (error) { if (error instanceof TomlDecodeError) error.file = file; throw error; }
}

// json.dumps(str(value).replace('\\', '/'), ensure_ascii=False) and a PowerShell single-quoted literal.
const quote = value => JSON.stringify(String(value).replaceAll('\\', '/'));
const psQuote = value => "'" + String(value).replaceAll("'", "''") + "'";

// Everything the Python took from its own location or process, from the options instead. `workspace` is the dedicated
// app project (--workspace); `workspaceRoot` is the SSAM checkout whose facade serves the app tools.
function profileContext(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const root = resolvePath(options.workspaceRoot ?? installedRoot, cwd);
  const layout = JSON.parse(fs.readFileSync(path.join(root, '.ssam-workspace.json'), 'utf8').replace(/^\uFEFF/, ''));
  const kernel = resolvePath(options.anvilRoot ?? env.ANVIL_ROOT ?? path.join(root, String(layout.kernel ?? 'kernel')), cwd);
  const lane = resolveO11Lane(env, layout).lane;
  const workspace = options.workspace != null ? resolvePath(options.workspace, cwd) : null;
  return { env, cwd, root, kernel, lane, workspace,
    codexHome: String(options.codexHome ?? env.CODEX_HOME ?? path.join(homeOf(env), '.codex')),
    configuration: options.out != null ? String(options.out) : workspace != null ? path.join(workspace, '.codex', 'config.toml') : null,
    adapter: resolvePath(path.join(root, 'platforms', 'odc', 'facade', 'ssam.mjs'), cwd),
    node: resolvePath(options.node ?? process.execPath, cwd),
    controller: resolvePath(o11LaneOf(lane, { root: kernel, workspace: root, env }).cli, cwd),
    cli: options.cli != null ? resolvePath(options.cli, cwd) : null };
}

// configure_app_profile.py render(), line for line; only the server and hook commands are the Node ones.
function render(c) {
  const existing = readToml(path.resolve(c.cwd, c.codexHome, 'config.toml'));
  const localAppData = c.env.LOCALAPPDATA !== undefined ? c.env.LOCALAPPDATA : path.join(homeOf(c.env), 'AppData', 'Local');
  const authority = pathText([localAppData, 'Anvil', 'authority'].filter(Boolean).join(path.sep));
  const scope = c.workspace != null ? ' --workspace ' + psQuote(c.workspace) : '';
  const hookScript = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & ' + psQuote(c.node) + ' '
    + psQuote(c.adapter) + ' app-hook' + scope + '; exit $LASTEXITCODE';
  const command = 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(hookScript, 'utf16le').toString('base64');
  const legacy = existing.has('sandbox_mode') || existing.has('sandbox_workspace_write');
  const lines = [APP_PROFILE_MARKER, 'approval_policy = "never"', 'web_search = "disabled"'];
  if (legacy)
    // Codex gives legacy sandbox settings precedence over named profiles. Override that setting explicitly.
    lines.push('sandbox_mode = "read-only"', '# Legacy read-only mode; private authority files are also protected by owner-only OS ACLs.');
  else
    lines.push('default_permissions = "ssam-app"', '', '[permissions.ssam-app]',
      'description = "SSAM app: only controlled task tools; no maintenance or direct writes"', 'extends = ":read-only"',
      '[permissions.ssam-app.filesystem]', `${quote(authority)} = "deny"`, `${quote(pathText(c.codexHome))} = "deny"`, `${quote(c.kernel)} = "deny"`,
      '[permissions.ssam-app.network]', 'enabled = false');
  lines.push('', '[windows]', 'sandbox = "elevated"', '', '[features]', ...FEATURES_OFF.map(name => `${name} = false`),
    'hooks = true', '[features.code_mode]', 'enabled = false');
  for (const name of pyIterate(existing.get('mcp_servers'), 'mcp_servers'))
    if (name !== 'ssam_hybrid') lines.push('', `[mcp_servers.${quote(name)}]`, 'enabled = false');
  lines.push('', '[mcp_servers.ssam_hybrid]', `command = ${quote(c.node)}`,
    'args = [' + quote(c.adapter) + ', "app-mcp"' + (c.workspace != null ? ', "--workspace", ' + quote(c.workspace) : '') + ']',
    'enabled = true', 'required = true', 'tool_timeout_sec = 600', 'enabled_tools = ["context", "propose", "continue", "status"]');
  for (const event of ['UserPromptSubmit', 'PreToolUse']) {
    lines.push('', `[[hooks.${event}]]`);
    if (event === 'PreToolUse') lines.push('matcher = ".*"');
    lines.push(`[[hooks.${event}.hooks]]`, 'type = "command"', 'command = ' + JSON.stringify(command), 'timeout = 30');
  }
  lines.push('', '# Review and trust these hooks through /hooks before using the app tools.',
    '# Without a host capture and one-use hook grant, the MCP server refuses execution.');
  return lines.join('\n') + '\n';
}
// `for name in existing.get('mcp_servers', {})`: a table yields its keys; a list or string its items; anything else fails.
function pyIterate(value, name) {
  if (value === undefined) return [];
  if (value instanceof Map) return [...value.keys()];
  if (Array.isArray(value) || typeof value === 'string') return [...value].map(String);
  throw new TypeError(`'${name}' is not iterable`);
}
export const renderAppProfile = options => render(profileContext(options));

// contains_hybrid_hook(): an SSAM hook anywhere in a hooks tree, plain or inside -EncodedCommand. The legacy Python
// hook (ssam_app.py) and the Node one (ssam.mjs app-hook) both count: either is a duplicate capture.
const hybridHookText = text => text.includes('ssam_app.py') || (text.includes('ssam.mjs') && text.includes('app-hook'));
function decodeEncodedCommand(text) {
  const b64 = text.trim(); // b64decode(validate=True), then strict UTF-16-LE
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4) return null;
  try { return new TextDecoder('utf-16le', { fatal: true }).decode(Buffer.from(b64, 'base64')); } catch { return null; }
}
export function containsHybridHook(entries) {
  if (entries instanceof Map) {
    const command = entries.has('command') ? entries.get('command') : '';
    if (typeof command === 'string') {
      if (hybridHookText(command)) return true;
      const at = command.indexOf(' -EncodedCommand ');
      if (at >= 0) { const script = decodeEncodedCommand(command.slice(at + ' -EncodedCommand '.length)); if (script != null && hybridHookText(script)) return true; }
    }
    return [...entries.values()].some(containsHybridHook);
  }
  return Array.isArray(entries) && entries.some(containsHybridHook);
}

function validateDestination(c, configuration) {
  if (samePath(resolvePath(configuration, c.cwd), resolvePath(path.join(c.codexHome, 'config.toml'), c.cwd)))
    throw new AppProfileError('Refusing to modify the global Codex configuration; select a dedicated workspace or optional profile', 'GLOBAL_CODEX_CONFIGURATION');
}

// write_managed(): only a file this generator wrote (marker first) is replaced; text mode, so os.EOL line ends.
function writeManaged(c, configuration, content) {
  const file = path.resolve(c.cwd, configuration);
  if (fs.existsSync(file) && !readText(file).startsWith(APP_PROFILE_MARKER))
    throw new AppProfileError('Refusing to replace a configuration not managed by SSAM Hybrid: ' + pathText(configuration), 'UNMANAGED_CONFIGURATION');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content.replace(/\n/g, os.EOL), 'utf8');
}

// check(): installed bytes only; no captures, permits, trust edits or Studio calls.
function check(c, configuration) {
  validateDestination(c, configuration);
  const projectConfig = c.workspace != null ? path.join(c.workspace, '.codex', 'config.toml') : null;
  const resolved = resolvePath(configuration, c.cwd);
  const reviewCopy = projectConfig != null && !samePath(resolved, projectConfig);
  const expected = render(c);
  const file = path.resolve(c.cwd, configuration);
  const exact = isFile(file) && readText(file) === expected;
  const files = { controller: c.controller, adapter: c.adapter, node: c.node };
  const problems = [];
  if (!exact) problems.push('Configuration is missing or differs from the generated setup');
  for (const [name, entry] of Object.entries(files)) if (!isFile(entry)) problems.push(name + ' file is missing: ' + entry);
  if (c.cli != null && !samePath(c.cli, c.controller)) problems.push('The app server runs the O11 lane CLI, not --cli: ' + c.controller);
  if (c.workspace != null && !isDir(c.workspace)) problems.push('Dedicated workspace does not exist');
  const current = readToml(path.resolve(c.cwd, c.codexHome, 'config.toml'));
  if (c.workspace != null && containsHybridHook(current.has('hooks') ? current.get('hooks') : new Map()))
    problems.push('Global SSAM hooks already exist; review duplicate capture before using project hooks');
  return { configured: !problems.length && !reviewCopy, reviewPrepared: !problems.length && reviewCopy, active: null,
    state: problems.length ? 'configuration-incomplete' : reviewCopy ? 'review-copy' : 'awaiting-client-proof',
    projectConfiguration: projectConfig, workspace: c.workspace, configuration: resolved, configurationSha256: digest(file),
    files: Object.fromEntries(Object.entries(files).map(([name, entry]) => [name, { path: entry, sha256: digest(entry) }])),
    tools: [...APP_PROFILE_TOOLS],
    capabilities: { existingModuleDelivery: true, createApplication: false, createModules: false },
    changesDefaultProfile: false, requiresHookTrust: true, problems,
    next: [c.workspace != null ? 'Open a NEW local task in the dedicated project; do not also select the ssam-app profile' : 'Select the ssam-app profile explicitly',
      'Review project trust and the exact hooks in the client; generated files do not grant trust',
      'A real UserPromptSubmit hook must supply task_id and the four MCP tools must be available',
      'Call context with the captured id to verify the requested lane and environment'],
    limitations: ['Static preflight does not prove MCP startup, trusted hooks, actual client capture or lane readiness',
      'Opening Service Studio or loading the Hybrid skill does not activate the controlled session',
      'Never ask the user to invent or locate a task_id; absent capture is an onboarding failure'] };
}

// main(): validate the destination, write unless check, then the static preflight. options: workspace | out, codexHome,
// check, cli, node, workspaceRoot, anvilRoot, env, cwd. Refusals throw AppProfileError (or TomlDecodeError).
export function configureAppProfile(options = {}) {
  const c = profileContext(options);
  if (c.configuration == null) throw new AppProfileError('--out or --workspace is required', 'USAGE');
  validateDestination(c, c.configuration);
  if (!options.check) {
    const content = render(c);
    parseToml(content);
    writeManaged(c, c.configuration, content);
  }
  return check(c, c.configuration);
}

// `ssam app-profile ...`: the preflight JSON on stdout, exit 0 when configured or review-prepared, else 1; a refusal is
// {ok:false, code, error} on stderr with exit 1, a usage error exit 2 (argparse). deps: env, cwd, workspaceRoot, anvilRoot.
const FLAGS = { '--codex-home': 'codexHome', '--cli': 'cli', '--out': 'out', '--workspace': 'workspace', '--node': 'node' };
export function appProfileCli(args = [], deps = {}) {
  const usage = error => ({ stdout: '', stderr: JSON.stringify({ ok: false, code: 'USAGE', error, usage: USAGE }) + '\n', exitCode: 2 });
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '-h' || arg === '--help') return { stdout: USAGE + '\n', stderr: '', exitCode: 0 };
    if (arg === '--check') { options.check = true; continue; }
    const split = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = split > 0 ? arg.slice(0, split) : arg;
    if (!Object.hasOwn(FLAGS, name)) return usage('unrecognized arguments: ' + arg);
    const value = split > 0 ? arg.slice(split + 1) : args[++i];
    if (value === undefined || (split < 0 && String(value).startsWith('-'))) return usage('argument ' + name + ': expected one argument');
    options[FLAGS[name]] = String(value);
  }
  if (options.out == null && options.workspace == null) return usage('--out or --workspace is required');
  try {
    const result = configureAppProfile({ ...deps, ...options });
    return { stdout: JSON.stringify(result, null, 2) + '\n', stderr: '', exitCode: result.configured || result.reviewPrepared ? 0 : 1 };
  } catch (error) {
    return { stdout: '', stderr: JSON.stringify({ ok: false, code: typeof error.code === 'string' ? error.code : error instanceof TomlDecodeError ? 'INVALID_TOML' : 'APP_PROFILE_ERROR',
      error: error.message, ...(error.file ? { file: error.file } : {}) }) + '\n', exitCode: 1 };
  }
}

// ---- TOML 1.0: CPython 3.12 tomllib, function for function
export class TomlDecodeError extends Error {}
// A TOML date, date-time or local time (tomllib returns datetime objects; only the kind and text are kept).
export class TomlDate { constructor(kind, text) { this.kind = kind; this.text = text; } }

const ctrl = c => { const n = c.charCodeAt(0); return n < 32 || n === 127; };
const ILLEGAL_BASIC = c => ctrl(c) && c !== '\t';
const ILLEGAL_MULTILINE = c => ctrl(c) && c !== '\t' && c !== '\n';
const WS = c => c === ' ' || c === '\t';
const WS_NL = c => c === ' ' || c === '\t' || c === '\n';
const BARE = c => c !== undefined && /^[A-Za-z0-9_-]$/.test(c);
const KEY_INITIAL = c => BARE(c) || c === '"' || c === "'";
const ESCAPES = { '\\b': '\b', '\\t': '\t', '\\n': '\n', '\\f': '\f', '\\r': '\r', '\\"': '"', '\\\\': '\\' };
const MAX_KEY_PARTS = 1000; // sys.getrecursionlimit()
const FROZEN = 0, EXPLICIT_NEST = 1;
const TIME = '([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(?:\\.([0-9]{1,6})[0-9]*)?';
const RE_NUMBER = /0(?:x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|b[01](?:_?[01])*|o[0-7](?:_?[0-7])*)|[+-]?(?:0|[1-9](?:_?[0-9])*)((?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?)/y;
const RE_LOCALTIME = new RegExp(TIME, 'y');
const RE_DATETIME = new RegExp('([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])(?:[Tt ]' + TIME + '(?:([Zz])|([+-])([01][0-9]|2[0-3]):([0-5][0-9]))?)?', 'y');
class NoNest extends Error {}

// Python repr() of a str and of a key tuple, for the error messages.
const pyRepr = s => { const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/[\\\x00-\x1f\x7f]/g, c => ({ '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' })[c] ?? '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'))
    .replaceAll(q, '\\' + q) + q; };
const pyTuple = key => '(' + key.map(pyRepr).join(', ') + (key.length === 1 ? ',' : '') + ')';
function tomlError(src, pos, message) {
  let where = 'end of document';
  if (pos < src.length) {
    const line = src.slice(0, pos).split('\n').length;
    where = `line ${line}, column ${line === 1 ? pos + 1 : pos - src.lastIndexOf('\n', pos - 1)}`;
  }
  return new TomlDecodeError(`${message} (at ${where})`);
}
const skipChars = (src, pos, accept) => { while (pos < src.length && accept(src[pos])) pos++; return pos; };
function skipUntil(src, pos, expect, errorOn, errorOnEof) {
  let end = src.indexOf(expect, pos);
  if (end < 0) { end = src.length; if (errorOnEof) throw tomlError(src, end, `Expected ${pyRepr(expect)}`); }
  for (let i = pos; i < end; i++) if (errorOn(src[i])) throw tomlError(src, i, `Found invalid character ${pyRepr(src[i])}`);
  return end;
}
const skipComment = (src, pos) => (src[pos] === '#' ? skipUntil(src, pos + 1, '\n', ILLEGAL_BASIC, false) : pos);
function skipCommentsAndArrayWs(src, pos) {
  for (;;) { const before = pos; pos = skipComment(src, skipChars(src, pos, WS_NL)); if (pos === before) return pos; }
}

class Flags {
  constructor() { this.flags = new Map(); this.pending = new Map(); }
  static node() { return { flags: new Set(), recursive: new Set(), nested: new Map() }; }
  addPending(key, flag) { this.pending.set(JSON.stringify([key, flag]), [key, flag]); }
  finalizePending() { for (const [key, flag] of this.pending.values()) this.set(key, flag, false); this.pending.clear(); }
  unsetAll(key) {
    let cont = this.flags;
    for (const k of key.slice(0, -1)) { if (!cont.has(k)) return; cont = cont.get(k).nested; }
    cont.delete(key.at(-1));
  }
  set(key, flag, recursive) {
    let cont = this.flags;
    for (const k of key.slice(0, -1)) { if (!cont.has(k)) cont.set(k, Flags.node()); cont = cont.get(k).nested; }
    if (!cont.has(key.at(-1))) cont.set(key.at(-1), Flags.node());
    cont.get(key.at(-1))[recursive ? 'recursive' : 'flags'].add(flag);
  }
  is(key, flag) {
    if (!key.length) return false;
    let cont = this.flags;
    for (const k of key.slice(0, -1)) {
      if (!cont.has(k)) return false;
      const inner = cont.get(k);
      if (inner.recursive.has(flag)) return true;
      cont = inner.nested;
    }
    const stem = cont.get(key.at(-1));
    return !!stem && (stem.flags.has(flag) || stem.recursive.has(flag));
  }
}
function getOrCreateNest(dict, key, accessLists = true) {
  let cont = dict;
  for (const k of key) {
    if (!cont.has(k)) cont.set(k, new Map());
    cont = cont.get(k);
    if (accessLists && Array.isArray(cont)) cont = cont.at(-1);
    if (!(cont instanceof Map)) throw new NoNest();
  }
  return cont;
}
function appendNestToList(dict, key) {
  const cont = getOrCreateNest(dict, key.slice(0, -1));
  const last = key.at(-1);
  if (!cont.has(last)) { cont.set(last, [new Map()]); return; }
  if (!Array.isArray(cont.get(last))) throw new NoNest();
  cont.get(last).push(new Map());
}
const nest = (src, pos, fn) => { try { return fn(); } catch (error) { if (error instanceof NoNest) throw tomlError(src, pos, 'Cannot overwrite a value'); throw error; } };

// tomllib.loads(): a Map per table, arrays as arrays.
export function parseToml(text) {
  const src = String(text).replaceAll('\r\n', '\n');
  const data = new Map();
  const flags = new Flags();
  let pos = 0;
  let header = [];
  for (;;) {
    pos = skipChars(src, pos, WS);
    if (pos >= src.length) break;
    const char = src[pos];
    if (char === '\n') { pos++; continue; }
    if (KEY_INITIAL(char)) pos = skipChars(src, keyValueRule(src, pos, data, flags, header), WS);
    else if (char === '[') {
      flags.finalizePending();
      [pos, header] = src[pos + 1] === '[' ? createListRule(src, pos, data, flags) : createDictRule(src, pos, data, flags);
      pos = skipChars(src, pos, WS);
    } else if (char !== '#') throw tomlError(src, pos, 'Invalid statement');
    pos = skipComment(src, pos);
    if (pos >= src.length) break;
    if (src[pos] !== '\n') throw tomlError(src, pos, 'Expected newline or end of document after a statement');
    pos++;
  }
  return data;
}
function createDictRule(src, pos, data, flags) {
  let key;
  [pos, key] = parseKey(src, skipChars(src, pos + 1, WS));
  if (flags.is(key, EXPLICIT_NEST) || flags.is(key, FROZEN)) throw tomlError(src, pos, `Cannot declare ${pyTuple(key)} twice`);
  flags.set(key, EXPLICIT_NEST, false);
  nest(src, pos, () => getOrCreateNest(data, key));
  if (!src.startsWith(']', pos)) throw tomlError(src, pos, "Expected ']' at the end of a table declaration");
  return [pos + 1, key];
}
function createListRule(src, pos, data, flags) {
  let key;
  [pos, key] = parseKey(src, skipChars(src, pos + 2, WS));
  if (flags.is(key, FROZEN)) throw tomlError(src, pos, `Cannot mutate immutable namespace ${pyTuple(key)}`);
  flags.unsetAll(key); // the namespace now points to a new empty list item...
  flags.set(key, EXPLICIT_NEST, false); // ...but this key is still closed to the table syntax
  nest(src, pos, () => appendNestToList(data, key));
  if (!src.startsWith(']]', pos)) throw tomlError(src, pos, "Expected ']]' at the end of an array declaration");
  return [pos + 2, key];
}
function keyValueRule(src, pos, data, flags, header) {
  let key, value;
  [pos, key, value] = parseKeyValuePair(src, pos);
  const absParent = [...header, ...key.slice(0, -1)];
  for (let i = 1; i < key.length; i++) {
    const contKey = [...header, ...key.slice(0, i)];
    if (flags.is(contKey, EXPLICIT_NEST)) throw tomlError(src, pos, `Cannot redefine namespace ${pyTuple(contKey)}`);
    flags.addPending(contKey, EXPLICIT_NEST);
  }
  if (flags.is(absParent, FROZEN)) throw tomlError(src, pos, `Cannot mutate immutable namespace ${pyTuple(absParent)}`);
  const table = nest(src, pos, () => getOrCreateNest(data, absParent));
  if (table.has(key.at(-1))) throw tomlError(src, pos, 'Cannot overwrite a value');
  if (value instanceof Map || Array.isArray(value)) flags.set([...header, ...key], FROZEN, true);
  table.set(key.at(-1), value);
  return pos;
}
function parseKeyValuePair(src, pos) {
  let key, value;
  [pos, key] = parseKey(src, pos);
  if (src[pos] !== '=') throw tomlError(src, pos, "Expected '=' after a key in a key/value pair");
  [pos, value] = parseValue(src, skipChars(src, pos + 1, WS));
  return [pos, key, value];
}
function parseKey(src, pos) {
  let part;
  [pos, part] = parseKeyPart(src, pos);
  const key = [part];
  pos = skipChars(src, pos, WS);
  while (src[pos] === '.') {
    [pos, part] = parseKeyPart(src, skipChars(src, pos + 1, WS));
    key.push(part);
    if (key.length > MAX_KEY_PARTS) throw new RangeError(`TOML key has more than the allowed ${MAX_KEY_PARTS} parts`);
    pos = skipChars(src, pos, WS);
  }
  return [pos, key];
}
function parseKeyPart(src, pos) {
  const char = src[pos];
  if (BARE(char)) { const end = skipChars(src, pos, BARE); return [end, src.slice(pos, end)]; }
  if (char === "'") return parseLiteralStr(src, pos);
  if (char === '"') return parseBasicStr(src, pos + 1, false);
  throw tomlError(src, pos, 'Invalid initial character for a key part');
}
function parseArray(src, pos) {
  const array = [];
  pos = skipCommentsAndArrayWs(src, pos + 1);
  if (src.startsWith(']', pos)) return [pos + 1, array];
  for (;;) {
    let value;
    [pos, value] = parseValue(src, pos);
    array.push(value);
    pos = skipCommentsAndArrayWs(src, pos);
    const c = src.slice(pos, pos + 1);
    if (c === ']') return [pos + 1, array];
    if (c !== ',') throw tomlError(src, pos, 'Unclosed array');
    pos = skipCommentsAndArrayWs(src, pos + 1);
    if (src.startsWith(']', pos)) return [pos + 1, array];
  }
}
function parseInlineTable(src, pos) {
  const dict = new Map();
  const flags = new Flags();
  pos = skipChars(src, pos + 1, WS);
  if (src.startsWith('}', pos)) return [pos + 1, dict];
  for (;;) {
    let key, value;
    [pos, key, value] = parseKeyValuePair(src, pos);
    if (flags.is(key, FROZEN)) throw tomlError(src, pos, `Cannot mutate immutable namespace ${pyTuple(key)}`);
    const table = nest(src, pos, () => getOrCreateNest(dict, key.slice(0, -1), false));
    if (table.has(key.at(-1))) throw tomlError(src, pos, `Duplicate inline table key ${pyRepr(key.at(-1))}`);
    table.set(key.at(-1), value);
    pos = skipChars(src, pos, WS);
    const c = src.slice(pos, pos + 1);
    if (c === '}') return [pos + 1, dict];
    if (c !== ',') throw tomlError(src, pos, 'Unclosed inline table');
    if (value instanceof Map || Array.isArray(value)) flags.set(key, FROZEN, true);
    pos = skipChars(src, pos + 1, WS);
  }
}
function parseBasicStrEscape(src, pos, multiline) {
  const id = src.slice(pos, pos + 2);
  pos += 2;
  if (multiline && (id === '\\ ' || id === '\\\t' || id === '\\\n')) {
    // Line ending backslash: skip whitespace to the next non-whitespace; non-whitespace before the newline is an error.
    if (id !== '\\\n') {
      pos = skipChars(src, pos, WS);
      if (pos >= src.length) return [pos, ''];
      if (src[pos] !== '\n') throw tomlError(src, pos, "Unescaped '\\' in a string");
      pos++;
    }
    return [skipChars(src, pos, WS_NL), ''];
  }
  if (id === '\\u') return parseHexChar(src, pos, 4);
  if (id === '\\U') return parseHexChar(src, pos, 8);
  if (Object.hasOwn(ESCAPES, id)) return [pos, ESCAPES[id]];
  throw tomlError(src, pos, "Unescaped '\\' in a string");
}
function parseHexChar(src, pos, length) {
  const hex = src.slice(pos, pos + length);
  if (hex.length !== length || !/^[0-9A-Fa-f]*$/.test(hex)) throw tomlError(src, pos, 'Invalid hex value');
  pos += length;
  const code = parseInt(hex, 16);
  if (!(code <= 55295 || (code >= 57344 && code <= 1114111))) throw tomlError(src, pos, 'Escaped character is not a Unicode scalar value');
  return [pos, String.fromCodePoint(code)];
}
function parseLiteralStr(src, pos) {
  const start = pos + 1;
  const end = skipUntil(src, start, "'", ILLEGAL_BASIC, true);
  return [end + 1, src.slice(start, end)];
}
function parseMultilineStr(src, pos, literal) {
  pos += 3;
  if (src.startsWith('\n', pos)) pos++;
  let result;
  const delim = literal ? "'" : '"';
  if (literal) {
    const end = skipUntil(src, pos, "'''", ILLEGAL_MULTILINE, true);
    result = src.slice(pos, end);
    pos = end + 3;
  } else [pos, result] = parseBasicStr(src, pos, true);
  // At most two extra delimiters when the closing sequence is 4 or 5 long.
  if (!src.startsWith(delim, pos)) return [pos, result];
  if (!src.startsWith(delim, pos + 1)) return [pos + 1, result + delim];
  return [pos + 2, result + delim + delim];
}
function parseBasicStr(src, pos, multiline) {
  const errorOn = multiline ? ILLEGAL_MULTILINE : ILLEGAL_BASIC;
  let result = '';
  let start = pos;
  for (;;) {
    if (pos >= src.length) throw tomlError(src, pos, 'Unterminated string');
    const char = src[pos];
    if (char === '"') {
      if (!multiline) return [pos + 1, result + src.slice(start, pos)];
      if (src.startsWith('"""', pos)) return [pos + 3, result + src.slice(start, pos)];
      pos++;
      continue;
    }
    if (char === '\\') {
      let escaped;
      result += src.slice(start, pos);
      [pos, escaped] = parseBasicStrEscape(src, pos, multiline);
      result += escaped;
      start = pos;
      continue;
    }
    if (errorOn(char)) throw tomlError(src, pos, `Illegal character ${pyRepr(char)}`);
    pos++;
  }
}
const validDate = (y, m, d) => y >= 1 && d <= [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const sticky = (re, src, pos) => { re.lastIndex = pos; return re.exec(src); };
function parseValue(src, pos) {
  const char = src[pos];
  if (char === '"') return src.startsWith('"""', pos) ? parseMultilineStr(src, pos, false) : parseBasicStr(src, pos + 1, false);
  if (char === "'") return src.startsWith("'''", pos) ? parseMultilineStr(src, pos, true) : parseLiteralStr(src, pos);
  if (char === 't' && src.startsWith('true', pos)) return [pos + 4, true];
  if (char === 'f' && src.startsWith('false', pos)) return [pos + 5, false];
  if (char === '[') return parseArray(src, pos);
  if (char === '{') return parseInlineTable(src, pos);
  const datetime = sticky(RE_DATETIME, src, pos);
  if (datetime) {
    if (!validDate(Number(datetime[1]), Number(datetime[2]), Number(datetime[3]))) throw tomlError(src, pos, 'Invalid date or datetime');
    return [pos + datetime[0].length, new TomlDate(datetime[4] === undefined ? 'date' : 'datetime', datetime[0])];
  }
  const time = sticky(RE_LOCALTIME, src, pos);
  if (time) return [pos + time[0].length, new TomlDate('time', time[0])];
  // Integers and plain floats; after dates and times, which also start with digits.
  const number = sticky(RE_NUMBER, src, pos);
  if (number) { const value = Number(number[0].replaceAll('_', '')); return [pos + number[0].length, number[1] ? value : value + 0]; } // int -0 is 0
  const three = src.slice(pos, pos + 3);
  if (three === 'inf' || three === 'nan') return [pos + 3, three === 'inf' ? Infinity : NaN];
  const four = src.slice(pos, pos + 4);
  if (['-inf', '+inf', '-nan', '+nan'].includes(four)) return [pos + 4, four.endsWith('inf') ? (four[0] === '-' ? -Infinity : Infinity) : NaN];
  throw tomlError(src, pos, 'Invalid value');
}
