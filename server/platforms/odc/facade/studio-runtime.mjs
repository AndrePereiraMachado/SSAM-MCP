// C-49 (screen friction catalog of 27/10/2026, F-FT-31; ported from proto 4f94ef19): the Service Studio updated itself (11.55.91 on net8.0 to 11.55.94
// on net10.0) and the build of the connector (the bridge compiled against the Studio's own assemblies, studio-connect.mjs)
// failed with 1700 compiler errors; ssam_connect and ssam_doctor answered only "Connector build failed; Studio unchanged",
// and every session stopped for about 35 minutes. This module says why:
//   studioRuntime(dir)   what the installed Studio is: ServiceStudio.exe FileVersion (the PE's VS_FIXEDFILEINFO, read from the
//                        file, no process) and ServiceStudio.runtimeconfig.json (tfm and the frameworks it ships);
//   recordGoodBuild      after every connector build that succeeds, that runtime is recorded in
//                        <kernel>/.local/runtime-connect/last-good-build.json (from now on; before it, the connection record's
//                        studioVersion is the last Studio known to work);
//   connectorFailure     a failed build: STUDIO_UPDATED {from, to, runtime} when the Studio is not the one of the last good
//                        build, else CONNECTOR_BUILD_FAILED, both with the first compiler errors of the log and the action; it is
//                        kept in last-build-failure.json for ssam_doctor until a build succeeds again.
// On this line the connector already compiles for the runtime the Studio names (kernel/StudioRuntime.props, 27/10: net10.0
// from Service Studio 11.55.94 on), so the net8/net10 break of F-FT-31 no longer happens by itself; a build can still fail
// after an update (the runtime's reference pack missing on the machine, an API the Studio changed), and then this says why.
// Pure readers over files; nothing here starts a process or touches the Studio.
import fs from 'node:fs';
import path from 'node:path';

export const STUDIO_UPDATED = 'STUDIO_UPDATED';
export const CONNECTOR_BUILD_FAILED = 'CONNECTOR_BUILD_FAILED';
export const GOOD_BUILD_FILE = 'last-good-build.json';
export const FAILURE_FILE = 'last-build-failure.json';
export const runtimeConnectDir = root => path.join(root, '.local', 'runtime-connect');
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
};

// The installed Studio when nothing names it: the connection record's studioDir, ANVIL_STUDIO_DIR, else the default
// installation folder (the order of discovery.mjs o11StudioDir, without its registry read: no process here).
export function defaultStudioDir(env = process.env, record = null) {
  if (typeof record?.studioDir === 'string' && record.studioDir) return record.studioDir;
  if (env.ANVIL_STUDIO_DIR) return env.ANVIL_STUDIO_DIR;
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files';
  return path.join(programFiles, 'OutSystems', 'Service Studio 11', 'Service Studio');
}

// The FileVersion of a PE file from its VS_FIXEDFILEINFO (signature 0xFEEF04BD, then dwStrucVersion, dwFileVersionMS,
// dwFileVersionLS): "11.55.94.65328". Null when the file has none.
export function peFileVersion(file) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch { return null; }
  const at = bytes.lastIndexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]));
  if (at < 0 || at + 16 > bytes.length) return null;
  const ms = bytes.readUInt32LE(at + 8), ls = bytes.readUInt32LE(at + 12);
  return [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join('.');
}

// {dir, version, tfm, frameworks} of the Studio installed in dir, or null when it is no Studio folder.
export function studioRuntime(dir) {
  if (!dir) return null;
  const version = peFileVersion(path.join(dir, 'ServiceStudio.exe'));
  const config = readJson(path.join(dir, 'ServiceStudio.runtimeconfig.json'))?.runtimeOptions ?? null;
  if (!version && !config) return null;
  const listed = Array.isArray(config?.includedFrameworks) ? config.includedFrameworks : config?.framework ? [config.framework] : [];
  const frameworks = Object.fromEntries(listed.filter(f => f?.name).map(f => [f.name, f.version ?? null]));
  return { dir, version: version ?? null, tfm: typeof config?.tfm === 'string' ? config.tfm : null, ...(Object.keys(frameworks).length ? { frameworks } : {}) };
}

export const lastGoodBuild = root => readJson(path.join(runtimeConnectDir(root), GOOD_BUILD_FILE));
export const lastBuildFailure = root => readJson(path.join(runtimeConnectDir(root), FAILURE_FILE));

// After a connector build that succeeded: the Studio it was built for is the one known to work; an earlier failure is over.
export function recordGoodBuild(root, runtime, { what = 'bridge', now = new Date() } = {}) {
  if (!root || !runtime) return null;
  const record = { schema: 'ssam-studio-build/1', what, studio: { version: runtime.version, tfm: runtime.tfm, ...(runtime.frameworks ? { frameworks: runtime.frameworks } : {}), dir: runtime.dir }, builtAt: now.toISOString() };
  try {
    writeJson(path.join(runtimeConnectDir(root), GOOD_BUILD_FILE), record);
    fs.rmSync(path.join(runtimeConnectDir(root), FAILURE_FILE), { force: true });
  } catch { return null; /* a record that cannot be written never fails the connection */ }
  return record;
}

// The first distinct compiler errors of a build log: {code, message, at} (the file name and position, never the whole path).
const ERROR_LINE = /^(?<file>.*?)(?:\((?<pos>\d+,\d+)\))?\s*:\s*(?:error|erro)\s+(?<code>[A-Z]+\d+)\s*:\s*(?<message>.*?)(?:\s+\[[^\]]*\])?\s*$/i;
export function firstBuildErrors(text, max = 5) {
  const out = []; const seen = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = ERROR_LINE.exec(line.trim());
    if (!m) continue;
    const key = m.groups.code + ' ' + m.groups.message;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ code: m.groups.code, message: m.groups.message.slice(0, 300), at: path.win32.basename(m.groups.file.trim()) + (m.groups.pos ? '(' + m.groups.pos + ')' : '') });
    if (out.length >= max) break;
  }
  return out;
}
export const countBuildErrors = text => String(text ?? '').split(/\r?\n/).filter(l => ERROR_LINE.test(l.trim())).length;

const label = s => s ? (s.version ?? 'unknown version') + (s.tfm ? ' (' + s.tfm + ')' : '') : 'unknown';
// The diagnosis of a failed connector build. last: the last good build ({studio}) or, before any, the connection record
// ({studioVersion}); runtime: studioRuntime of the Studio it was built for.
export function connectorFailure({ what = 'bridge', log, logText, runtime, last = null, record = null } = {}) {
  const from = last?.studio ? { version: last.studio.version ?? null, tfm: last.studio.tfm ?? null }
    : record?.studioVersion ? { version: String(record.studioVersion), tfm: record.studioRuntime?.tfm ?? null } : null;
  const to = runtime ? { version: runtime.version, tfm: runtime.tfm } : null;
  const sameVersion = (a, b) => !a || !b || String(a).split('.').slice(0, 3).join('.') === String(b).split('.').slice(0, 3).join('.');
  const updated = !!(from && to && (!sameVersion(from.version, to.version) || (from.tfm && to.tfm && from.tfm !== to.tfm)));
  const errors = firstBuildErrors(logText);
  const count = countBuildErrors(logText);
  const major = /^net(\d+)/.exec(to?.tfm ?? '')?.[1] ?? null;
  const action = updated
    ? 'The Service Studio changed under SSAM. The connector compiles for the runtime the Studio names (kernel/StudioRuntime.props' + (to?.tfm ? ': ' + to.tfm : '') + ')'
      + (major ? ', against that runtime\'s reference pack (packs\\Microsoft.NETCore.App.Ref\\' + major + '.x, which the .NET ' + major + ' SDK installs on this machine)' : '')
      + ': the integrator reads the log and installs that SDK or updates SSAM to a build that supports Service Studio ' + label(to)
      + ', then ssam_connect {lane:"o11"} again. Nothing was attached; the Studio is unchanged and needs no restart.'
    : 'The connector does not build for Service Studio ' + label(to) + ': the integrator reads the log and fixes the build, then ssam_connect {lane:"o11"} again. Nothing was attached; the Studio is unchanged.';
  const first = errors[0] ? ' First error: ' + errors[0].code + ' ' + errors[0].message + ' @ ' + errors[0].at + '.' : '';
  const error = updated
    ? 'Service Studio was updated from ' + label(from) + ' to ' + label(to) + ' and the connector (' + what + ') no longer builds against it (' + count + ' compiler error' + (count === 1 ? '' : 's') + ').' + first
    : 'Connector build failed (' + what + ', ' + count + ' compiler error' + (count === 1 ? '' : 's') + ') for Service Studio ' + label(to) + '; Studio unchanged.' + first;
  return { code: updated ? STUDIO_UPDATED : CONNECTOR_BUILD_FAILED, what, error, ...(updated ? { studio: { from, to, runtime: to.tfm } } : { studio: { to } }),
    errors, errorCount: count, log, action };
}

export function recordBuildFailure(root, diagnosis, { now = new Date() } = {}) {
  try { writeJson(path.join(runtimeConnectDir(root), FAILURE_FILE), { schema: 'ssam-studio-build-failure/1', ...diagnosis, at: now.toISOString() }); } catch { /* the answer still says it */ }
}

// ssam_doctor: the Studio installed now against the last good build, and the last failed build when it is still the
// latest word. Null when there is nothing to say.
export function connectorHealth(root, { record = null, runtime = studioRuntime(defaultStudioDir(process.env, record)), last = lastGoodBuild(root), failure = lastBuildFailure(root) } = {}) {
  const from = last?.studio ?? (record?.studioVersion ? { version: String(record.studioVersion), tfm: record.studioRuntime?.tfm ?? null } : null);
  const drift = from && runtime && (String(from.version ?? '').split('.').slice(0, 3).join('.') !== String(runtime.version ?? '').split('.').slice(0, 3).join('.')
    || (from.tfm && runtime.tfm && from.tfm !== runtime.tfm));
  if (!failure && !drift) return null;
  return { ...(runtime ? { studio: { version: runtime.version, tfm: runtime.tfm } } : {}), ...(from ? { lastGoodBuild: { version: from.version ?? null, tfm: from.tfm ?? null, ...(last?.builtAt ? { at: last.builtAt } : {}) } } : {}),
    ...(drift ? { studioChanged: true } : {}),
    ...(failure ? { lastFailure: { code: failure.code, error: failure.error, errors: failure.errors ?? [], log: failure.log ?? null, action: failure.action ?? null, at: failure.at ?? null } } : {}) };
}
