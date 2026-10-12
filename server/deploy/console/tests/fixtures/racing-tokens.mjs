// Test double of two writers racing on tokens.json without a lock (the module of prod-20261011-ed0f94b and an
// ssam-admin at the same instant): the verbs of fake-tokens.mjs, then, when globalThis.SSAM_TEST_RACE names the verb,
// "lose:<verb>" puts back the file as the other writer read it before the verb (its rename lands last: the verb's change
// is gone) and "tear:<verb>" leaves half of the new file (both writers truncated the same temp file). Never shipped.
import fs from 'node:fs';
import { createTokenStore as createFake } from './fake-tokens.mjs';

export function createTokenStore(dir, opts) {
  const store = createFake(dir, opts);
  const race = verb => (...args) => {
    const mode = globalThis.SSAM_TEST_RACE;
    const before = fs.existsSync(store.file) ? fs.readFileSync(store.file) : null;
    const result = store[verb](...args);
    if (mode === `lose:${verb}` && before) fs.writeFileSync(store.file, before);
    if (mode === `tear:${verb}`) { const after = fs.readFileSync(store.file); fs.writeFileSync(store.file, after.subarray(0, Math.floor(after.length / 2))); }
    return result;
  };
  return { ...store, issue: race('issue'), revoke: race('revoke'), agentRotate: race('agentRotate'), renew: race('renew'), setLanes: race('setLanes') };
}
