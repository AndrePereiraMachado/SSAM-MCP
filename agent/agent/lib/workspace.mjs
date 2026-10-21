// The agent's folder rules (docs/FASE2-AGENTE.md 6.2): which paths the server may name, by role, and how paths
// cross the channel. The server names files only as `agent:<rel>`; every other form is refused before any file
// access. Read: odc/snapshots, odc/journal, odc/lab, o11 and inbox. Write: the same but inbox. Everything else
// (agent/, bin/, private/, odc/studio/, odc/README.md, pack.json) is never readable nor writable by the server.
// The segment grammar is the wire's and the same on every system (the server's mirror refuses the same names); only the
// absolute paths follow the system: Windows (drive letter, '\', no case) and, on macOS, POSIX ('/', NFC; an absolute path
// names the agent folder only with the root and the prefix spelled exactly, case included, since a case-sensitive volume
// holds other folders in other cases; agent: paths take any case of a prefix and are written as the prefix spells it).
import fs from 'node:fs';
import path from 'node:path';
import { refuse } from './errors.mjs';

const win = path.win32;
export const WRITABLE = Object.freeze(['odc/snapshots', 'odc/journal', 'odc/lab', 'o11']);
export const READABLE = Object.freeze([...WRITABLE, 'inbox']);
// The folders `setup` creates under the agent root.
export const LAYOUT = Object.freeze(['odc/snapshots', 'odc/journal/staging', 'odc/lab', 'o11/journal/staging', 'o11/downloads',
  'inbox', 'private/authority', 'private/runtime-connect', 'private/tmp']);
// The ODC manifest fields the bridge reads as paths (studio/shared/Manifest.cs), with their role. Keys are matched
// without case, as the bridge's own deserializer does (PropertyNameCaseInsensitive).
export const MANIFEST_PATH_FIELDS = Object.freeze({ basepath: 'read', candidatepath: 'read', producerpath: 'read',
  builderreceipt: 'read', evidencedir: 'write' });

const DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])( *\..*)?$/i;
export const DOT_SEGMENT = /(^|[\\/])\.\.([\\/]|$)/;
const forbidden = message => refuse('PATH_FORBIDDEN', message);

// The segments of a relative path, or PATH_FORBIDDEN: no drive, UNC, root, ':' (alternate data stream), NUL or
// control character, wildcard, '.'/'..' segment, segment ending in a dot or space, or device name.
export function segmentsOf(rel) {
  if (typeof rel !== 'string' || rel === '') throw forbidden('Empty path');
  if (/[\x00-\x1f<>"|?*:]/.test(rel)) throw forbidden(`Path ${JSON.stringify(rel)} has a forbidden character (drive, ':' stream, NUL, control or wildcard)`);
  if (/^[\\/]/.test(rel)) throw forbidden(`Path ${JSON.stringify(rel)} is absolute or UNC`);
  const parts = rel.replace(/[\\/]+$/, '').split(/[\\/]/);
  for (const segment of parts) {
    if (segment === '') throw forbidden(`Path ${JSON.stringify(rel)} has an empty segment`);
    if (segment === '.' || segment === '..') throw forbidden(`Path ${JSON.stringify(rel)} has a '.' or '..' segment`);
    if (/[. ]$/.test(segment)) throw forbidden(`Path ${JSON.stringify(rel)} has a segment ending in a dot or space`);
    if (DEVICE.test(segment)) throw forbidden(`Path ${JSON.stringify(rel)} names a device (${segment})`);
  }
  return parts;
}

// The allowed prefix that holds `parts` for the role, or null. A write must be strictly inside the prefix; a read may
// name the prefix folder itself (file.list agent:o11).
export function prefixOf(parts, role) {
  const lower = parts.map(part => part.toLowerCase());
  for (const prefix of role === 'write' ? WRITABLE : READABLE) {
    const head = prefix.split('/');
    if (head.every((part, i) => lower[i] === part) && (lower.length > head.length || (role !== 'write' && lower.length === head.length))) return prefix;
  }
  return null;
}

const inside = (child, parent) => { const c = child.toLowerCase(); const p = parent.toLowerCase(); return c === p || c.startsWith(p + '\\'); };

// macOS: POSIX paths compared in NFC (every APFS volume is normalization-insensitive) and WITH case (review B3): a volume
// can be case-sensitive, and there another case is another folder. agent: paths still take any case of a prefix: the
// agent writes the prefix as the prefix spells it.
const nfc = text => text.normalize('NFC');
const insidePosix = (child, parent) => { const c = nfc(child); const p = nfc(parent).replace(/\/$/, ''); return c === p || c.startsWith(p + '/'); };

// platform (tests): 'darwin' for the macOS rules, anything else the Windows ones. files (tests): {lstatSync, realpathSync}.
export function createWorkspace(root, { platform = process.platform, files = fs } = {}) {
  if (platform === 'darwin') return createPosixWorkspace(root, files);
  const base = win.resolve(root);
  const lowerBase = base.toLowerCase();
  let realBase = null;
  const realRoot = () => (realBase ??= fs.realpathSync.native(base));

  // Absolute path of `parts` when it is inside an allowed prefix for the role and its real path (links and junctions
  // resolved, from the nearest existing ancestor) stays inside that prefix.
  function confine(parts, role, original) {
    const prefix = prefixOf(parts, role);
    if (!prefix) throw forbidden(`${original} is outside the folders the server may ${role === 'write' ? 'write' : 'read'} (${(role === 'write' ? WRITABLE : READABLE).join(', ')})`);
    const target = win.join(base, ...parts);
    let existing = target; const tail = [];
    for (;;) {
      try { fs.lstatSync(existing); break; }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw forbidden(`${original} cannot be checked (${error.code})`); }
      const up = win.dirname(existing);
      if (up === existing) throw forbidden(`${original} has no existing folder`);
      tail.unshift(win.basename(existing)); existing = up;
    }
    let real;
    try { real = fs.realpathSync.native(existing); } catch { throw forbidden(`${original} goes through a broken link`); }
    if (!inside(win.join(real, ...tail), win.join(realRoot(), ...prefix.split('/')))) throw forbidden(`${original} leaves ${prefix} through a link or junction`);
    return target;
  }

  const workspace = {
    root: base,
    segmentsOf,
    // `agent:<rel>` -> absolute path, for a role ('read' | 'write'). Any other form: PATH_NOT_AGENT.
    resolve(value, role = 'read') {
      if (typeof value !== 'string' || !value.startsWith('agent:'))
        throw refuse('PATH_NOT_AGENT', `A path position takes agent:<relative path>, not ${typeof value === 'string' ? JSON.stringify(value) : typeof value}`);
      return confine(segmentsOf(value.slice('agent:'.length)), role, value);
    },
    // An absolute path seen in a bridge command line: allowed only under the root, in a prefix for the role.
    checkAbsolute(text, role = 'read') {
      if (DOT_SEGMENT.test(text)) throw forbidden(`${JSON.stringify(text)} has a '..' segment`);
      if (!/^[A-Za-z]:[\\/]/.test(text)) throw forbidden(`${JSON.stringify(text)} is not a path under the agent folder`);
      const normalized = win.normalize(text);
      if (!normalized.toLowerCase().startsWith(lowerBase + '\\')) throw forbidden(`${JSON.stringify(text)} is outside the agent folder`);
      return confine(segmentsOf(normalized.slice(base.length + 1)), role, text);
    },
    // An absolute path under the root, in a prefix for the role -> `agent:<rel>`; anything else -> null. Paths outside
    // the readable prefixes (bin\, private\, odc\studio\) stay as they are: the server would refuse them as agent: paths.
    toAgent(text, role = 'read') {
      if (typeof text !== 'string' || !/^[A-Za-z]:[\\/]/.test(text) || DOT_SEGMENT.test(text)) return null;
      const normalized = win.normalize(text);
      if (!normalized.toLowerCase().startsWith(lowerBase + '\\')) return null;
      let parts;
      try { parts = segmentsOf(normalized.slice(base.length + 1)); } catch { return null; }
      return prefixOf(parts, role) ? 'agent:' + parts.join('/') : null;
    },
    // Every string of a reply (any depth) that is an absolute path under the root becomes agent:<rel>. `paths` collects
    // the key path ([key|index, ...]) of each string rewritten: the server maps only those back, so any other text of
    // the reply, even one that starts with agent:, stays data.
    relativize(value, paths = null, keys = []) {
      if (typeof value === 'string') { const agent = workspace.toAgent(value); if (agent === null) return value; paths?.push(keys); return agent; }
      if (Array.isArray(value)) return value.map((item, index) => workspace.relativize(item, paths, [...keys, index]));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, workspace.relativize(item, paths, [...keys, key])]));
      return value;
    },
    // json:"agent-paths" on file.put: the 5 manifest path fields go from agent:<rel> to the confined absolute path.
    // An absolute (or any other non-agent) value there is refused; empty and null values and other fields stay.
    agentPathsIn(object) {
      for (const [key, value, role] of manifestFields(object)) {
        if (typeof value !== 'string' || !value.startsWith('agent:')) throw forbidden(`Manifest field ${key} must be agent:<relative path>, not ${JSON.stringify(value)}`);
        object[key] = workspace.resolve(value, role);
      }
      return object;
    },
    // json:"agent-paths" on file.get: the inverse, absolute path under the root -> agent:<rel>.
    agentPathsOut(object) {
      for (const [key, value, role] of manifestFields(object)) {
        if (typeof value === 'string' && value.startsWith('agent:')) { workspace.resolve(value, role); continue; }
        const agent = workspace.toAgent(value, role);
        if (!agent) throw forbidden(`Manifest field ${key} is not a path the server may see: ${JSON.stringify(value)}`);
        object[key] = agent;
      }
      return object;
    },
  };
  return workspace;
}

// The macOS workspace: the same roles, prefixes and segment grammar; absolute paths are POSIX.
function createPosixWorkspace(root, files) {
  const P = path.posix;
  const base = P.resolve(root);
  const realOf = target => (files.realpathSync.native ? files.realpathSync.native(target) : files.realpathSync(target));
  let realBase = null;
  const realRoot = () => (realBase ??= realOf(base));

  function confine(parts, role, original) {
    const prefix = prefixOf(parts, role);
    if (!prefix) throw forbidden(`${original} is outside the folders the server may ${role === 'write' ? 'write' : 'read'} (${(role === 'write' ? WRITABLE : READABLE).join(', ')})`);
    const head = prefix.split('/');
    const target = P.join(base, ...head, ...parts.slice(head.length));
    let existing = target; const tail = [];
    for (;;) {
      try { files.lstatSync(existing); break; }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw forbidden(`${original} cannot be checked (${error.code})`); }
      const up = P.dirname(existing);
      if (up === existing) throw forbidden(`${original} has no existing folder`);
      tail.unshift(P.basename(existing)); existing = up;
    }
    let real;
    try { real = realOf(existing); } catch { throw forbidden(`${original} goes through a broken link`); }
    if (!insidePosix(P.join(real, ...tail), P.join(realRoot(), ...head))) throw forbidden(`${original} leaves ${prefix} through a link`);
    return target;
  }
  // The part of an absolute path under the root (as given, or its real path), or null; compared segment by segment, so
  // an NFD spelling of the root (longer than its NFC one) still cuts at the right place. The root must be spelled exactly
  // (case included): the bridge receives the text as it is (review B3).
  const under = text => {
    const segments = P.normalize(text).split('/');
    for (const top of [base, realRoot()]) {
      const head = top.replace(/\/$/, '').split('/');
      if (segments.length > head.length && head.every((part, i) => nfc(part) === nfc(segments[i]))) return segments.slice(head.length).join('/');
    }
    return null;
  };
  // The segments of the part under the root and its prefix for the role, with the prefix spelled exactly, or null.
  const exactPrefix = (rest, role) => {
    const parts = segmentsOf(rest);
    const prefix = prefixOf(parts, role);
    return prefix && parts.slice(0, prefix.split('/').length).join('/') === prefix ? { parts, prefix } : null;
  };
  const absolute = text => typeof text === 'string' && text.startsWith('/') && !text.startsWith('//') && !/[\x00-\x1f]/.test(text);

  const workspace = {
    root: base,
    segmentsOf,
    resolve(value, role = 'read') {
      if (typeof value !== 'string' || !value.startsWith('agent:'))
        throw refuse('PATH_NOT_AGENT', `A path position takes agent:<relative path>, not ${typeof value === 'string' ? JSON.stringify(value) : typeof value}`);
      return confine(segmentsOf(value.slice('agent:'.length)), role, value);
    },
    checkAbsolute(text, role = 'read') {
      if (DOT_SEGMENT.test(text)) throw forbidden(`${JSON.stringify(text)} has a '..' segment`);
      if (!absolute(text)) throw forbidden(`${JSON.stringify(text)} is not a path under the agent folder`);
      let rest = null;
      try { rest = under(text); } catch { rest = null; }
      if (!rest) throw forbidden(`${JSON.stringify(text)} is outside the agent folder (spelled exactly as ${base}, case included)`);
      const parts = segmentsOf(rest);
      const prefix = prefixOf(parts, role);
      if (prefix && parts.slice(0, prefix.split('/').length).join('/') !== prefix)
        throw forbidden(`${JSON.stringify(text)} spells ${prefix} in another case; on a case-sensitive volume that is another folder`);
      return confine(parts, role, text);
    },
    toAgent(text, role = 'read') {
      if (!absolute(text) || DOT_SEGMENT.test(text)) return null;
      let rest = null;
      try { rest = under(text); } catch { return null; }
      if (!rest) return null;
      let found;
      try { found = exactPrefix(rest, role); } catch { return null; }
      return found ? 'agent:' + found.parts.join('/') : null;
    },
    relativize(value, paths = null, keys = []) {
      if (typeof value === 'string') { const agent = workspace.toAgent(value); if (agent === null) return value; paths?.push(keys); return agent; }
      if (Array.isArray(value)) return value.map((item, index) => workspace.relativize(item, paths, [...keys, index]));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, workspace.relativize(item, paths, [...keys, key])]));
      return value;
    },
    agentPathsIn(object) {
      for (const [key, value, role] of manifestFields(object)) {
        if (typeof value !== 'string' || !value.startsWith('agent:')) throw forbidden(`Manifest field ${key} must be agent:<relative path>, not ${JSON.stringify(value)}`);
        object[key] = workspace.resolve(value, role);
      }
      return object;
    },
    agentPathsOut(object) {
      for (const [key, value, role] of manifestFields(object)) {
        if (typeof value === 'string' && value.startsWith('agent:')) { workspace.resolve(value, role); continue; }
        const agent = workspace.toAgent(value, role);
        if (!agent) throw forbidden(`Manifest field ${key} is not a path the server may see: ${JSON.stringify(value)}`);
        object[key] = agent;
      }
      return object;
    },
  };
  return workspace;
}

// [key, value, role] of the manifest path fields that hold a value ('' and null are left alone).
function manifestFields(object) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return [];
  return Object.entries(object).flatMap(([key, value]) => {
    const role = MANIFEST_PATH_FIELDS[key.toLowerCase()];
    return role && value !== null && value !== undefined && value !== '' ? [[key, value, role]] : [];
  });
}
