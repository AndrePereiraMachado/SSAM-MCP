// prazos B (production test of 2026-10-12, screens delivery 03:37-03:42 UTC): the producers a consumer job references were
// always captured from the ENVIRONMENT (C27 captureProducers: the kernel's StudioProducerAuthority reads the referenceable
// catalog, the module catalog and the signature through the Studio's own login, then re-attests twice: about a dozen SOAP
// calls of 2.5-3.6 s each from the Studio's PC), even when the producer was open, unchanged, in the same Studio. On the
// owner's mobile uplink those calls took 89.8 s, 31.2 s, 10.5 s and a 60 s cut (the Studio's WCF SendTimeout), and the
// delivery failed twice before the model bound the open producer by hand (o11_studio snapshot + producers), which delivered
// at once.
//
// openProducerBindings binds each referenced producer that is open in the selected Studio, in the consumer's environment,
// with no unsaved change, no publication running and no dialog, by a capture of its tab taken by key (list_open_modules,
// then snapshot_module {module_key}: bridge C41, a build read that neither selects the tab nor takes the Studio lock). That
// capture is what the Studio itself compiles the producer from; the open, unmodified tab is the version this Studio last
// opened or published. A producer that is not open, is open with changes, opens twice, or whose capture fails keeps the
// environment capture (C27), and the explicit choices of the call (producers, captureProducers, "published") are never
// overridden. Never a refusal of its own: any failure here leaves the producer to the environment capture.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const stampOf = date => date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
const lower = value => String(value ?? '').toLowerCase();

// Why an open tab cannot stand for its producer (null when it can).
export function tabRefusal(tab, environment) {
  if (typeof tab?.key !== 'string' || !tab.key) return 'no-key';
  if (tab.hasOpenedActiveESpace === false || tab.serverSilentMode === true) return 'opening';
  if (tab.isModified !== false) return 'modified';
  if (tab.serverOperation) return 'server-operation';
  if (Array.isArray(tab.pendingDialogs) && tab.pendingDialogs.length) return 'dialog';
  if (environment && tab.environment && lower(tab.environment) !== lower(environment)) return 'other-environment';
  return null;
}

// names: the producers the job references that the call left to the environment capture ("Name"; "Binding=Producer" and
// System are left to the environment). consumer: the module delivered (its tab names the environment when the call does
// not). Answers {bound: {Name: path}, fromStudio: [{producer, key, path}], skipped: [{producer, reason}]}.
export async function openProducerBindings(names, { bridge, local, consumer = null, environment = null, now = () => new Date(), signal } = {}) {
  const bound = {}; const fromStudio = []; const skipped = [];
  const wanted = (names ?? []).map(String).filter(name => name && !name.includes('=') && lower(name) !== 'system');
  for (const name of (names ?? []).map(String)) if (!wanted.includes(name)) skipped.push({ producer: name, reason: 'environment-producer' });
  if (!wanted.length || typeof bridge !== 'function') return { bound, fromStudio, skipped };
  let listed;
  try { listed = await bridge().ok('list_open_modules', {}, { timeoutMs: 10000, ...(signal ? { signal } : {}) }); }
  catch (error) {
    if (error?.code === 'CANCELLED') throw error;
    for (const name of wanted) skipped.push({ producer: name, reason: 'not-listed' });
    return { bound, fromStudio, skipped };
  }
  const tabs = (Array.isArray(listed?.modules) ? listed.modules : []).filter(m => typeof m?.name === 'string' && m.hasESpace !== false);
  const consumerTabs = consumer ? tabs.filter(m => lower(m.name) === lower(consumer)) : [];
  const environments = [...new Set(tabs.map(m => lower(m.environment)).filter(Boolean))];
  const target = environment ?? (consumerTabs.length === 1 ? consumerTabs[0].environment : null) ?? (environments.length === 1 ? environments[0] : null);
  for (const name of wanted) {
    const same = tabs.filter(m => lower(m.name) === lower(name) && (!target || !m.environment || lower(m.environment) === lower(target)));
    if (same.length !== 1) { skipped.push({ producer: name, reason: same.length ? 'ambiguous' : 'not-open' }); continue; }
    if (!target) { skipped.push({ producer: name, reason: 'environment-unknown' }); continue; }
    const tab = same[0];
    const refused = tabRefusal(tab, target);
    if (refused) { skipped.push({ producer: name, reason: refused }); continue; }
    const file = path.join(local, 'snapshots', 'producer-' + tab.name.replace(/[^\w.-]/g, '_') + '-' + stampOf(now()) + '-' + randomUUID().slice(0, 8) + '.oml');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const data = await bridge().ok('snapshot_module', { path: file, module_key: tab.key }, signal ? { signal } : undefined);
      if (data?.key && data.key !== tab.key) { skipped.push({ producer: name, reason: 'another-module' }); continue; }
      const captured = typeof data?.path === 'string' && data.path ? data.path : file;
      if (!isFile(captured)) { skipped.push({ producer: name, reason: 'no-capture' }); continue; }
      bound[name] = captured;
      fromStudio.push({ producer: name, key: tab.key, path: captured });
    } catch (error) {
      if (error?.code === 'CANCELLED') throw error;
      skipped.push({ producer: name, reason: 'capture-failed' });
    }
  }
  return { bound, fromStudio, skipped };
}
