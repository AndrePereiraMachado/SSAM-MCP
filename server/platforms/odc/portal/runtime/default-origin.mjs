// The Portal origin used when a caller names none: the corporate tenant of platforms/odc/tenants.json (the tenant the
// broker was first written for), read once. Every other tenant passes its own origin and gets its own vault entry. A
// folder without that file (a release, the hosted image: each customer brings its tenants) has no default, and a call
// that needs one is refused instead of guessing a tenant.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function corporateOrigin() {
  try {
    const tenants = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../tenants.json', import.meta.url)), 'utf8').replace(/^﻿/, '')).tenants ?? {};
    const corporate = Object.values(tenants).find(t => t && t.class === 'corporate' && typeof t.portalOrigin === 'string');
    return corporate?.portalOrigin ?? null;
  } catch { return null; }
}

export const DEFAULT_PORTAL_ORIGIN = corporateOrigin();
