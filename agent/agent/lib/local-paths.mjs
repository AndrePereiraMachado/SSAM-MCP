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
  const c = ordinalUpper(String(child)); const p = ordinalUpper(String(parent).replace(/[\\/]+$/, ''));
  return c === p || c.startsWith(p + '\\');
}

// Windows compares names ordinally without case: each character by its simple upper-case mapping, nothing else (the
// .NET StringComparison.OrdinalIgnoreCase of native/Ssam.Agent/LocalPaths.cs). No Unicode case folding: the Kelvin sign,
// the Angstrom sign and the Ohm sign stay distinct from K, Å and Ω, as NTFS keeps them distinct folders.
// .NET maps by the simple upper case of UnicodeData, never from a non-ASCII character to ASCII (dotless i and long s stay);
// JavaScript only offers the full mapping, so the few letters whose full upper case is several characters (Greek with
// ypogegrammeni) get their simple one here. tests/native/upload.test.mjs checks every character pair against .NET.
const upperChar = ch => {
  const code = ch.codePointAt(0);
  if (code >= 0x1f80 && code <= 0x1faf) return (code & 0xf) < 8 ? String.fromCodePoint(code + 8) : ch;
  if (code === 0x1fb3) return '\u1fbc';
  if (code === 0x1fc3) return '\u1fcc';
  if (code === 0x1ff3) return '\u1ffc';
  const up = ch.toUpperCase();
  if ([...up].length !== 1 || (code > 0x7f && up.codePointAt(0) <= 0x7f)) return ch;
  return up;
};
export function ordinalUpper(text) {
  let out = '';
  for (const ch of text) out += upperChar(ch);
  return out;
}

export const samePath = (a, b, platform = process.platform) => insidePath(a, b, platform) && insidePath(b, a, platform);
// A real path the system resolved to a network share (a UNC path, a mapped drive) on Windows.
export const networkPath = (real, platform = process.platform) => platform !== 'darwin' && /^[\\/]{2}/.test(String(real));
