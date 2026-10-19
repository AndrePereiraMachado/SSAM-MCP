// The macOS facts the agent needs (docs/AGENTE-MAC.md), read only: nothing here writes outside the agent folder or touches
// a Studio. Every tool is the system's own, called by its absolute path, and every call is injectable (deps.run, deps.fs)
// so the rules are tested on any system.
//   Studios    an installed Studio is an application bundle (*.app) in /Applications or ~/Applications (two levels) whose
//              Contents hold the managed DLLs: ODC Studio has OutSystems.Model.dll; Service Studio 11 has
//              ServiceStudio.Framework.dll and OutSystems.Model.V1.dll and no OutSystems.Model.dll (the ODC Studio folder
//              also carries ServiceStudio.Framework.dll). The bundle and executable names are never assumed: the
//              executable is CFBundleExecutable of Info.plist.
//   version    the ProductVersion of the managed entry assembly (ODCStudio.dll, ServiceStudio.dll), the same four-number
//              build the Windows apphost carries; else CFBundleShortVersionString with CFBundleVersion.
//   processes  ps (C locale): a Studio process runs exactly <bundle>/Contents/MacOS/<CFBundleExecutable>.
//   start time the microseconds the O11 runtime hook compares (Process.StartTime of .NET on macOS: pbi_start_tvsec and
//              pbi_start_tvusec of proc_pidinfo), read by perl (sysctl kern.proc), osascript (proc_pidinfo) or
//              sysctl -b, each checked against the whole seconds of the kernel.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { productVersionOf } from './pe-version.mjs';

const posix = path.posix;
const execFileAsync = promisify(execFile);
// stdout of a system tool (a Buffer with encoding 'buffer').
export const runTool = async (file, args, options = {}) => (await execFileAsync(file, args, { timeout: 20000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', ...options })).stdout;

export const TOOLS = Object.freeze({ ps: '/bin/ps', plutil: '/usr/bin/plutil', ioreg: '/usr/sbin/ioreg', getconf: '/usr/bin/getconf', perl: '/usr/bin/perl',
  osascript: '/usr/bin/osascript', sysctl: '/usr/sbin/sysctl', lsof: '/usr/sbin/lsof', codesign: '/usr/bin/codesign', swVers: '/usr/bin/sw_vers' });
export const MAC_STUDIOS = Object.freeze({
  odc: Object.freeze({ name: 'ODC Studio', entry: 'ODCStudio', requires: Object.freeze(['OutSystems.Model.dll']), absent: Object.freeze([]) }),
  o11: Object.freeze({ name: 'Service Studio', entry: 'ServiceStudio', requires: Object.freeze(['ServiceStudio.Framework.dll', 'OutSystems.Model.V1.dll']), absent: Object.freeze(['OutSystems.Model.dll']) }),
});
const MARKERS = ['OutSystems.Model.dll', 'ServiceStudio.Framework.dll', 'OutSystems.Model.V1.dll'];
const NESTED = /\.(app|framework|bundle|plugin|appex|xpc|dSYM)$/i;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const homeOf = (env = process.env) => (env.HOME && env.HOME.startsWith('/') ? env.HOME : os.homedir());
export const applicationFolders = home => ['/Applications', posix.join(home, 'Applications')];

// The application bundles of the folders, two levels deep (/Applications/X.app, /Applications/Vendor/X.app). Links are
// never followed; a bundle is never entered.
export function findBundles(roots, { fs: f = fs, depth = 2 } = {}) {
  const out = [];
  const walk = (dir, level) => {
    let items;
    try { items = f.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      if (!item.isDirectory()) continue;
      const full = posix.join(dir, item.name);
      if (/\.app$/i.test(item.name)) out.push(full);
      else if (level < depth) walk(full, level + 1);
    }
  };
  for (const root of roots) walk(root, 1);
  return out;
}

// The folder of the managed DLLs inside a bundle (breadth first under Contents, four levels, nested bundles and frameworks
// skipped, at most `folders` folders read: a large application that is no Studio costs little): {dir, names}, or null
// when no marker DLL is there.
export function managedDirOf(bundle, { fs: f = fs, depth = 4, folders = 400 } = {}) {
  const queue = [[posix.join(bundle, 'Contents'), 0]];
  let read = 0;
  while (queue.length) {
    if (++read > folders) return null;
    const [dir, level] = queue.shift();
    let items;
    try { items = f.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const names = new Set(items.filter(item => !item.isDirectory()).map(item => item.name));
    if (MARKERS.some(marker => names.has(marker))) return { dir, names };
    if (level < depth) for (const item of items) if (item.isDirectory() && !NESTED.test(item.name) && item.name !== '_CodeSignature') queue.push([posix.join(dir, item.name), level + 1]);
  }
  return null;
}

// The lane of a managed folder, or null.
export function kindOfNames(names) {
  for (const [kind, studio] of Object.entries(MAC_STUDIOS)) if (studio.requires.every(n => names.has(n)) && studio.absent.every(n => !names.has(n))) return kind;
  return null;
}

const unescapeXml = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
// The string values of a plist in XML (the first value of each key) and the LSEnvironment dictionary.
export function plistStrings(xml) {
  const text = String(xml ?? '');
  const out = {};
  for (const match of text.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    const key = unescapeXml(match[1]);
    if (!(key in out)) out[key] = unescapeXml(match[2]);
  }
  const env = /<key>LSEnvironment<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text);
  const environment = {};
  if (env) for (const match of env[1].matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) environment[unescapeXml(match[1])] = unescapeXml(match[2]);
  return { strings: out, environment };
}
// Info.plist (XML, or binary through plutil).
export async function readPlist(file, { fs: f = fs, run = runTool } = {}) {
  const bytes = f.readFileSync(file);
  const xml = bytes.subarray(0, 6).toString('latin1') === 'bplist' ? await run(TOOLS.plutil, ['-convert', 'xml1', '-o', '-', file]) : bytes.toString('utf8');
  return plistStrings(xml);
}

const numbers = value => { const match = /^\s*(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:\.(\d{1,9}))?/.exec(String(value ?? '')); return match ? match.slice(1).filter(v => v !== undefined).map(Number) : null; };
// The version a bundle declares: CFBundleVersion when it already holds the four numbers of the short version, the short
// version with a numeric CFBundleVersion as its fourth number, else the short version.
export function plistVersion(short, build) {
  const three = numbers(short);
  if (!three) return numbers(build) ? String(build).trim() : null;
  const head = three.slice(0, 3).join('.');
  const full = numbers(build);
  if (full?.length === 4 && full.slice(0, 3).join('.') === head) return full.join('.');
  if (/^\s*\d{1,9}\s*$/.test(String(build ?? ''))) return head + '.' + String(build).trim();
  return three.join('.');
}

// One bundle: {bundle, kind, managedDir, executable, exePath, identifier, shortVersion, bundleVersion, entry, productVersion,
// version, versionSource, environment, runtimeConfig} or null when it is no Studio.
export async function inspectBundle(bundle, deps = {}) {
  const f = deps.fs ?? fs;
  const managed = managedDirOf(bundle, { fs: f });
  if (!managed) return null;
  const kind = kindOfNames(managed.names);
  if (!kind) return null;
  let plist = { strings: {}, environment: {} };
  try { plist = await readPlist(posix.join(bundle, 'Contents', 'Info.plist'), { fs: f, run: deps.run ?? runTool }); } catch { /* reported as missing values */ }
  const s = plist.strings;
  const configs = [...managed.names].filter(name => name.endsWith('.runtimeconfig.json')).sort();
  const preferred = MAC_STUDIOS[kind].entry;
  const entry = configs.includes(preferred + '.runtimeconfig.json') ? preferred
    : configs.length === 1 ? configs[0].slice(0, -'.runtimeconfig.json'.length)
    : s.CFBundleExecutable && managed.names.has(s.CFBundleExecutable + '.dll') ? s.CFBundleExecutable : null;
  const productVersion = entry && managed.names.has(entry + '.dll') ? productVersionOf(posix.join(managed.dir, entry + '.dll'), { readFile: f.readFileSync }) : null;
  const fromPlist = plistVersion(s.CFBundleShortVersionString, s.CFBundleVersion);
  const version = numbers(productVersion) ? productVersion : fromPlist;
  let runtimeConfig = null;
  if (entry && managed.names.has(entry + '.runtimeconfig.json')) {
    try { runtimeConfig = JSON.parse(f.readFileSync(posix.join(managed.dir, entry + '.runtimeconfig.json'), 'utf8').replace(/^﻿/, '')); } catch { runtimeConfig = { unreadable: true }; }
  }
  return { bundle, kind, managedDir: managed.dir, executable: s.CFBundleExecutable ?? null,
    exePath: s.CFBundleExecutable ? posix.join(bundle, 'Contents', 'MacOS', s.CFBundleExecutable) : null, identifier: s.CFBundleIdentifier ?? null,
    shortVersion: s.CFBundleShortVersionString ?? null, bundleVersion: s.CFBundleVersion ?? null, entry, productVersion, version,
    versionSource: numbers(productVersion) ? 'ProductVersion of ' + entry + '.dll' : fromPlist ? 'Info.plist' : null,
    environment: plist.environment, runtimeConfig };
}

// A bundle in /Applications or ~/Applications (two levels), the places an installer puts a Studio.
export function officialBundle(bundle, home) {
  const parent = posix.dirname(bundle);
  return applicationFolders(home).some(root => parent === root || posix.dirname(parent) === root);
}

// The installed Studios: [{...inspectBundle}] of the application folders, newest version first, /Applications first.
export async function installedBundles(deps = {}) {
  const home = deps.home ?? homeOf(deps.env);
  const roots = deps.roots ?? applicationFolders(home);
  const inspect = deps.inspect ?? (bundle => inspectBundle(bundle, deps));
  const found = [];
  for (const bundle of findBundles(roots, { fs: deps.fs ?? fs })) {
    const info = await Promise.resolve(inspect(bundle)).catch(() => null);
    if (info) found.push(info);
  }
  const rank = info => (info.bundle.startsWith('/Applications/') ? 0 : 1);
  const compare = (a, b) => { const x = numbers(a.version) ?? []; const y = numbers(b.version) ?? []; for (let i = 0; i < 4; i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (y[i] ?? -1) - (x[i] ?? -1); return rank(a) - rank(b); };
  return found.sort(compare);
}

// ps -axww -o pid=,lstart=,comm= (C locale) -> [{pid, startSeconds, exe}]. lstart is the local time of this machine.
export function parsePs(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s+(\S.*?)\s*$/.exec(line);
    if (!m) continue;
    const month = MONTHS.indexOf(m[2]);
    if (month < 0) continue;
    const startSeconds = Math.floor(new Date(Number(m[7]), month, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime() / 1000);
    out.push({ pid: Number(m[1]), startSeconds, exe: m[8] });
  }
  return out;
}
export const psText = async ({ run = runTool, env = process.env } = {}) =>
  run(TOOLS.ps, ['-axww', '-o', 'pid=,lstart=,comm='], { env: { ...env, LC_ALL: 'C', LANG: 'C' } });
// The bundle a process executable lives in (<bundle>.app/Contents/MacOS/<name>), or null.
export function bundleOfExe(exe) {
  const at = String(exe ?? '').lastIndexOf('.app/Contents/MacOS/');
  if (at < 0) return null;
  const name = exe.slice(at + '.app/Contents/MacOS/'.length);
  return name && !name.includes('/') ? exe.slice(0, at + 4) : null;
}

// The running Studio processes of a lane: [{pid, path, version, startSeconds, bundle, official}]. Only the bundle's own
// executable counts (helpers and other processes of the bundle do not). inspect (a cache): bundle -> inspectBundle result.
export async function studioProcesses(kind, deps = {}) {
  const home = deps.home ?? homeOf(deps.env);
  const seen = new Map();
  const inspect = deps.inspect ?? (bundle => inspectBundle(bundle, deps));
  const out = [];
  for (const p of parsePs(await (deps.ps ?? (() => psText(deps)))())) {
    const bundle = bundleOfExe(p.exe);
    if (!bundle) continue;
    if (!seen.has(bundle)) seen.set(bundle, await Promise.resolve(inspect(bundle)).catch(() => null));
    const info = seen.get(bundle);
    if (!info || info.kind !== kind || info.exePath !== p.exe) continue;
    out.push({ pid: p.pid, path: p.exe, version: info.version, startSeconds: p.startSeconds, bundle, official: officialBundle(bundle, home), info });
  }
  return out;
}

// The machine id source on macOS: IOPlatformUUID of the platform expert device (the counterpart of the Windows
// MachineGuid), or ''.
export async function platformUuid({ run = runTool } = {}) {
  try { return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(await run(TOOLS.ioreg, ['-rd1', '-c', 'IOPlatformExpertDevice']))?.[1] ?? ''; }
  catch { return ''; }
}

// The folders a .NET process of this user may use as Path.GetTempPath(): $TMPDIR, the per-user folder of
// confstr(_CS_DARWIN_USER_TEMP_DIR) (what launchd gives the apps) and /tmp. Each with a trailing slash, no repeats.
export async function tempFolders({ env = process.env, run = runTool } = {}) {
  const dirs = [];
  const add = dir => { if (typeof dir !== 'string' || !dir.startsWith('/')) return; const d = dir.replace(/\/+$/, '') + '/'; if (!dirs.includes(d)) dirs.push(d); };
  add(env.TMPDIR);
  try { add(String(await run(TOOLS.getconf, ['DARWIN_USER_TEMP_DIR'])).trim()); } catch { /* not macOS or no getconf */ }
  add('/tmp/');
  return dirs;
}

// ---- the start time with microseconds
const PERL = 'use strict; my $pid = shift; my $mib = pack("i4", 1, 14, 1, $pid); my $buf = "\\0" x 2048; my $len = pack("Q", 2048); '
  + 'if (syscall(202, $mib, 4, $buf, $len, 0, 0) != 0) { print "ERR $!\\n"; exit 2; } my $n = unpack("Q", $len); '
  + 'if ($n < 16) { print "ERR short $n\\n"; exit 3; } my ($s, $u) = unpack("q l", $buf); print "$s $u\\n";';
const JXA = "ObjC.import('Foundation'); ObjC.bindFunction('proc_pidinfo', ['int', ['int', 'int', 'long', 'void *', 'int']]); "
  + "ObjC.bindFunction('malloc', ['void *', ['long']]); ObjC.bindFunction('free', ['void', ['void *']]); "
  + 'function run(argv) { var pid = parseInt(argv[0], 10); var size = 136; var buffer = $.malloc(size); var n = $.proc_pidinfo(pid, 3, 0, buffer, size); '
  + "if (n !== size) { $.free(buffer); return 'ERR ' + n; } var data = $.NSData.dataWithBytesLength(buffer, size); "
  + 'var text = data.base64EncodedStringWithOptions(0).js; $.free(buffer); return text; }';
const valid = (sec, usec) => Number.isSafeInteger(sec) && sec > 0 && Number.isSafeInteger(usec) && usec >= 0 && usec < 1000000;
// name -> async (pid, {run}) -> {sec, usec}. perl and sysctl read kinfo_proc.kp_proc.p_starttime (a timeval at offset 0);
// osascript reads proc_bsdinfo.pbi_start_tvsec/pbi_start_tvusec (offsets 120 and 128), the fields .NET reads.
export const START_READERS = Object.freeze({
  perl: async (pid, { run = runTool } = {}) => {
    const out = String(await run(TOOLS.perl, ['-e', PERL, String(pid)])).trim();
    const m = /^(\d+) (\d+)$/.exec(out);
    if (!m) throw new Error('perl: ' + out.slice(0, 120));
    return { sec: Number(m[1]), usec: Number(m[2]) };
  },
  osascript: async (pid, { run = runTool } = {}) => {
    const out = String(await run(TOOLS.osascript, ['-l', 'JavaScript', '-e', JXA, String(pid)])).trim();
    if (!/^[A-Za-z0-9+/=]+$/.test(out)) throw new Error('osascript: ' + out.slice(0, 120));
    const b = Buffer.from(out, 'base64');
    if (b.length < 136 || b.readUInt32LE(12) !== Number(pid)) throw new Error('osascript: not the process ' + pid);
    return { sec: Number(b.readBigUInt64LE(120)), usec: Number(b.readBigUInt64LE(128)) };
  },
  sysctl: async (pid, { run = runTool } = {}) => {
    const b = await run(TOOLS.sysctl, ['-b', 'kern.proc.pid.' + pid], { encoding: 'buffer' });
    if (!Buffer.isBuffer(b) || b.length < 16) throw new Error('sysctl: no kinfo_proc');
    return { sec: Number(b.readBigInt64LE(0)), usec: b.readInt32LE(8) };
  },
});

// {sec, usec, readers, failures} of a process, every reader that answers checked against the others and against the
// kernel's whole seconds (expectedSeconds: the key of the diagnostic socket, or the ps start). Throws with every reason
// when no reader gives a checked value.
export async function startTime(pid, { expectedSeconds = null, readers = START_READERS, run = runTool } = {}) {
  const good = []; const failures = [];
  for (const [name, read] of Object.entries(readers)) {
    try {
      const value = await read(pid, { run });
      if (!valid(value?.sec, value?.usec)) { failures.push(name + ': not a time'); continue; }
      if (expectedSeconds !== null && value.sec !== Number(expectedSeconds)) { failures.push(`${name}: ${value.sec} s, the kernel says ${expectedSeconds} s`); continue; }
      good.push({ name, ...value });
    } catch (error) { failures.push(name + ': ' + String(error?.message ?? error).split('\n')[0].slice(0, 160)); }
  }
  if (good.length === 0) throw Object.assign(new Error('the start time of process ' + pid + ' with microseconds could not be read (' + failures.join('; ') + ')'), { failures });
  const first = good[0];
  const other = good.find(g => g.sec !== first.sec || g.usec !== first.usec);
  if (other) throw Object.assign(new Error(`the start time readers of process ${pid} disagree (${first.name} ${first.sec}.${first.usec}, ${other.name} ${other.sec}.${other.usec})`), { failures });
  return { sec: first.sec, usec: first.usec, readers: good.map(g => g.name), failures };
}

const EPOCH_TICKS = 621355968000000000n;
// The text .NET writes for Process.GetCurrentProcess().StartTime.ToUniversalTime().ToString("O") on macOS (Process.OSX.cs:
// DateTime.UnixEpoch + TimeSpan.FromSeconds(tvsec + tvusec / 1e6), FromSeconds = (long)(seconds * 1e7)), the same IEEE
// 754 double arithmetic in JavaScript. The O11 runtime hook compares exactly this text.
export function dotnetStartTimeText(sec, usec) {
  const ticks = BigInt(Math.trunc((Number(sec) + Number(usec) / 1000000) * 10000000));
  const whole = ticks / 10000000n;
  const fraction = ticks % 10000000n;
  return new Date(Number(whole) * 1000).toISOString().slice(0, 19) + '.' + fraction.toString().padStart(7, '0') + 'Z';
}
export const dotnetTicks = (sec, usec) => EPOCH_TICKS + BigInt(Math.trunc((Number(sec) + Number(usec) / 1000000) * 10000000));

// The files a process has mapped or open (lsof -Fn): managed assemblies are mapped from disk, so an Anvil bridge already
// loaded shows here. Throws when lsof cannot read the process.
export async function openFiles(pid, { run = runTool } = {}) {
  const text = String(await run(TOOLS.lsof, ['-n', '-P', '-w', '-a', '-p', String(pid), '-Fn']));
  return text.split(/\r?\n/).filter(line => line.startsWith('n/')).map(line => line.slice(1));
}

// The CPU types of a Mach-O file (thin or universal): ['arm64'], ['x86_64'], ['arm64', 'x86_64'] or [].
export function machOArchs(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const name = type => ({ 0x01000007: 'x86_64', 0x0100000c: 'arm64', 7: 'i386', 12: 'arm' }[type >>> 0] ?? '0x' + (type >>> 0).toString(16));
  if (b.length < 8) return [];
  if (b.readUInt32BE(0) === 0xcafebabe || b.readUInt32BE(0) === 0xcafebabf) {
    const count = b.readUInt32BE(4); const wide = b.readUInt32BE(0) === 0xcafebabf; const out = [];
    for (let i = 0; i < count && 8 + (i + 1) * (wide ? 32 : 20) <= b.length; i++) out.push(name(b.readUInt32BE(8 + i * (wide ? 32 : 20))));
    return out;
  }
  if (b.readUInt32LE(0) === 0xfeedfacf || b.readUInt32LE(0) === 0xfeedface) return [name(b.readUInt32LE(4))];
  return [];
}
