// Absolute paths of this machine that the server names (file.upload) or the person approves (roots add): one grammar,
// checked before any file access (docs/FASE2-AGENTE.md 4.4). Windows: a drive letter path (X:\a\b), compared without
// case; macOS: a POSIX path (/a/b), compared in NFC with case. Refused (PATH_FORBIDDEN): a relative path or one that
// starts with ~, UNC, \\?\ and \\.\ paths, ':' outside the drive letter (an alternate data stream), control characters,
// wildcards, empty, '.' and '..' segments, a segment ending in a dot or a space, and device names (the grammar of
// workspace.mjs). The same rules are native/Ssam.Agent/LocalPaths.cs.
import path from 'node:path';
import { refuse } from './errors.mjs';
import { DEVICE } from './workspace.mjs';

// The extension a file must have, the server's rule (hosted local-upload.mjs): checked before any byte is read.
export const EXTENSION = /^\.[a-z0-9]{1,12}$/;
export const MAX_PATH_TEXT = 4096;
const forbidden = message => refuse('PATH_FORBIDDEN', message);
export const flavor = platform => (platform === 'darwin' ? path.posix : path.win32);
const quoted = text => JSON.stringify(String(text).length > 300 ? String(text).slice(0, 300) + '...' : String(text));

// {segments, normalized} of an absolute path of this system, or PATH_FORBIDDEN. folder: true accepts a trailing
// separator and the drive (or disk) root itself (the approval rules refuse that root with their own message).
export function parseLocalPath(text, { platform = process.platform, folder = false } = {}) {
  if (typeof text !== 'string' || text === '') throw forbidden('The path is empty');
  if (text.length > MAX_PATH_TEXT) throw forbidden(`The path has more than ${MAX_PATH_TEXT} characters`);
  const shown = quoted(text);
  if (text.startsWith('~')) throw forbidden(`${shown} starts with ~; give the full path`);
  if (/[\x00-\x1f\x7f]/.test(text)) throw forbidden(`${shown} has a control character`);
  let rest; let prefix; let separator;
  if (platform === 'darwin') {
    if (text.startsWith('//')) throw forbidden(`${shown} is a network path`);
    if (!text.startsWith('/')) throw forbidden(`${shown} is not an absolute path`);
    if (/[\\:*?<>|"]/.test(text)) throw forbidden(`${shown} has a forbidden character (backslash, ':', wildcard or quote)`);
    rest = text.slice(1); prefix = '/'; separator = '/';
  } else {
    if (/^[\\/]{2}/.test(text)) throw forbidden(`${shown} is a network (UNC) or device path`);
    if (!/^[A-Za-z]:[\\/]/.test(text)) throw forbidden(`${shown} is not an absolute path with a drive letter`);
    rest = text.slice(3);
    if (rest.includes(':')) throw forbidden(`${shown} has ':' outside the drive letter (an alternate data stream)`);
    if (/[*?<>|"]/.test(rest)) throw forbidden(`${shown} has a wildcard or a quote`);
    prefix = text[0].toUpperCase() + ':\\'; separator = '\\';
  }
  const body = folder ? rest.replace(/[\\/]$/, '') : rest;
  const segments = body === '' ? [] : body.split(platform === 'darwin' ? '/' : /[\\/]/);
  for (const segment of segments) {
    if (segment === '') throw forbidden(`${shown} has an empty segment`);
    if (segment === '.' || segment === '..') throw forbidden(`${shown} has a '.' or '..' segment`);
    if (/[. ]$/.test(segment)) throw forbidden(`${shown} has a segment ending in a dot or a space`);
    if (DEVICE.test(segment)) throw forbidden(`${shown} names a device (${segment})`);
  }
  if (!folder && segments.length === 0) throw forbidden(`${shown} names no file`);
  return { segments, normalized: prefix + segments.join(separator) };
}

// child equals parent or is under it: Windows without case and with a separator; macOS in NFC with case.
export function insidePath(child, parent, platform = process.platform) {
  if (platform === 'darwin') {
    const c = String(child).normalize('NFC'); const p = String(parent).normalize('NFC').replace(/\/+$/, '');
    return c === p || c.startsWith(p + '/') || p === '';
  }
  const c = String(child).toLowerCase(); const p = String(parent).toLowerCase().replace(/[\\/]+$/, '');
  return c === p || c.startsWith(p + '\\');
}

export const samePath = (a, b, platform = process.platform) => insidePath(a, b, platform) && insidePath(b, a, platform);
// A real path the system resolved to a network share (a UNC path, a mapped drive) on Windows.
export const networkPath = (real, platform = process.platform) => platform !== 'darwin' && /^[\\/]{2}/.test(String(real));
