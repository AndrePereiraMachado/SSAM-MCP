// The app's own settings (not the agent's: those stay in <root>/private/config.json, written by the agent's setup):
// the agent root, start at login (on by default: the app opens with the computer, minimized to the tray), the update
// server, how often to ask it and whether an update installs by itself (on by default: no click needed). One JSON
// file in the app's user data folder; a missing or broken file means the defaults.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = Object.freeze({ root: null, autostart: true, updateUrl: null, updateCheckHours: 6, updateAutoInstall: true });
export const KEYS = Object.freeze(Object.keys(DEFAULTS));

// Why an update server URL is not usable, or null: https, or plain http only on this machine (a test server).
export function updateUrlProblem(url) {
  if (url === null || url === undefined || url === '') return null;
  let parsed;
  try { parsed = new URL(String(url)); } catch { return 'the update server address is not a valid URL: ' + url; }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return null;
  return 'the update server address must be https:// (the app only installs an update it fetched over TLS)';
}

export function normalize(input = {}) {
  const settings = { ...DEFAULTS };
  if (typeof input.root === 'string' && input.root.trim()) settings.root = input.root.trim();
  settings.autostart = input.autostart !== false;
  settings.updateAutoInstall = input.updateAutoInstall !== false;
  if (typeof input.updateUrl === 'string' && input.updateUrl.trim() && !updateUrlProblem(input.updateUrl.trim())) settings.updateUrl = input.updateUrl.trim().replace(/\/+$/, '');
  const hours = Number(input.updateCheckHours);
  if (Number.isFinite(hours) && hours >= 1 && hours <= 168) settings.updateCheckHours = Math.round(hours);
  return settings;
}

export function loadSettings(file) {
  try { return normalize(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))); } catch { return { ...DEFAULTS }; }
}

export function saveSettings(file, settings) {
  const value = normalize(settings);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporary, file);
  return value;
}

// The update server the app asks, by precedence: the environment (SSAM_UPDATE_URL, for a test), the setting, the one
// the build fixed (resources/app-update.yml, which electron-updater reads itself), or none (updates off).
export function resolveUpdateUrl({ env = {}, settings = DEFAULTS, build = null } = {}) {
  for (const [source, value] of [['env', env.SSAM_UPDATE_URL], ['settings', settings.updateUrl], ['build', build]]) {
    if (typeof value === 'string' && value.trim() && !updateUrlProblem(value.trim())) return { url: value.trim().replace(/\/+$/, ''), source };
  }
  return { url: null, source: null };
}
