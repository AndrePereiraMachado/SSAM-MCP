// Offline OdcAccess for debugger tests: a fake Studio answers portal-call from
// the test callback. No bridge, vault, tenant, browser or network is reached.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Catalog } from '../../../portal/runtime/catalog.mjs';
import { OdcAccess } from '../../../portal/runtime/access.mjs';
import { WriteJournal } from '../../../portal/runtime/write-journal.mjs';

export const PERSONAL = 'personal-test.outsystems.dev';
const catalog = new Catalog();
export function odcAccessHarness(t, { portalCall, ...options } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-odc-access-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = new Map(), sent = []; let n = 0;
  const studio = { running: async () => true, call: async args => {
    if (args[0] === 'auth-status') return { ok: true, bridge: 'v32', portalWindows: [], capabilities: ['portal-session:headless'],
      sessions: [{ host: PERSONAL, loggedIn: true, user: 'dev@example.test' }] };
    if (args[0] === 'portal-call') { const request = requests.get(args[1]); sent.push(request); return portalCall(request); }
    return { ok: false, error: 'Unknown command' };
  } };
  const access = new OdcAccess({ catalog, studio, tenants: { default: PERSONAL, tenants: { [PERSONAL]: { class: 'personal', portalOrigin: 'https://' + PERSONAL } } },
    vault: { apiClient: async () => ({ available: false }), portal: async () => ({ available: false }), bridge: async () => { throw new Error('vault_not_used'); } },
    prompt: { apiClient: async () => ({ opened: false }), portal: async () => ({ opened: false }) }, portalBroker: () => ({}),
    journal: () => {}, receipts: new WriteJournal(path.join(dir, 'receipts')), sleep: async () => {},
    requestFile: json => { const file = path.join(dir, 'req-' + (++n) + '.json'); requests.set(file, json); return file; }, ...options });
  return { access, sent, dir };
}
