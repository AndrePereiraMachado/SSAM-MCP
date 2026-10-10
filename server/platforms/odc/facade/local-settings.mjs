// What belongs to THIS machine and stays out of Git: `.ssam-local.json` at the workspace root, written by
// scripts/setup-dev.ps1 with the person's ODC tenant and O11 host. It is read before tenants.json: its ODC tenant
// becomes the default tenant (known entry kept as is, unknown host added with its portal origin). Without the file
// nothing changes and tenants.json decides, as before. No side effects at import: lib.mjs and ssam.mjs both use it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostedContext } from './executor.mjs';

export const localSettingsFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.ssam-local.json');

const hostPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
// A bare host, also from an origin someone pasted ("https://x.outsystems.dev/"). Anything else is refused.
export function hostOf(value, field = 'host') {
  const text = String(value).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!hostPattern.test(text)) throw new Error('Invalid ' + field + ' in .ssam-local.json: ' + JSON.stringify(value) + ' (expected a host such as name.outsystems.dev)');
  return text;
}

// Hosted (executor.mjs) the settings of this machine are the owner's: a customer's call never sees them.
export function readLocalSettings(file = localSettingsFile) {
  if (hostedContext()) return null;
  if (!fs.existsSync(file)) return null;
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (error) { throw new Error('Invalid ' + file + ': ' + error.message); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ' + file + ': expected a JSON object');
  const optional = (name) => value[name] == null || value[name] === '' ? null : hostOf(value[name], name);
  return { file, odcTenant: optional('odcTenant'), o11Host: optional('o11Host') };
}

// tenants.json as the facade sees it on this machine.
export function withLocalTenant(config, local) {
  if (!local?.odcTenant) return config;
  const host = local.odcTenant;
  const known = config.tenants?.[host];
  const entry = known ?? { label: 'Tenant of this checkout (.ssam-local.json)', portalOrigin: 'https://' + host, studioAuthor: null, policyFile: null };
  return { ...config, default: host, tenants: { ...config.tenants, [host]: entry } };
}
