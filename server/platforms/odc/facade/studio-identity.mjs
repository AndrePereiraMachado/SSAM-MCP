// The identity of the user's Studio against the Studio the hosted server serves, per lane (A-M1 + E1 + E2 of the minimal
// multi-version proposal, C:\t\multiver\minimo\PROPOSTA.md; docs/FASE2-AGENTE.md 7). ONE function decides
// (studioIdentity); the hub (agent-hub.mjs compatibility and the studio-version-unserved event), the hosted gate
// (hosted/policy.mjs: the refusal, studioBuildDiffers and studioNotServed) and the start (ssam.mjs startupKernel) read it.
//   - The user's Studio: the ProductVersion of ODCStudio.exe / ServiceStudio.exe the agent reports (Hello
//     studios.<lane>.installed.version, pong.versions), four numbers (1.7.28.10873).
//   - The server's: kernel.builds[lane], the FileVersion of ServiceStudio.Framework.dll of the image's Studio folder
//     (kernel-image.mjs imageKernel), else the ProductVersion of this machine's Studio (detectKernel); only a build with the
//     lane's three numbers counts. A server that knows no build of its own compares three numbers, as before.
//   - Another three-part version is never served. Older: STUDIO_UPDATE_REQUIRED (update the Studio). Newer:
//     STUDIO_VERSION_NOT_SERVED_YET (the server does not serve it yet, the owner was notified, never roll the Studio back).
//   - The same three numbers and another build, or a version without its fourth number: kernel.json studioBuildPolicy
//     decides, per lane or for both: "warn" (the default, owner option D-M2a: served, every answer carries
//     studioWarning studioBuildDiffers) or "refuse" (D-M2b: refused by direction like another version; a version without
//     its build is STUDIO_BUILD_UNKNOWN). Any other value refuses (fails closed) and the start names it.
//   - A version the agent could not read: STUDIO_VERSION_UNKNOWN. No Studio installed: STUDIO_NOT_INSTALLED (the hub's).
// The refusal is ONE answer with everything: code STUDIO_VERSION_MISMATCH (the code of the family, unchanged), the cause
// (what to do), both builds, what still works (the server-only tools), "nothing ran", userMessage for the user (shown as it
// is) and error for the model. B3 of round 3 (owner rule of 2026-10-15): every text SSAM emits is English, with no
// bilingual line, so both are English; they stay two texts, one per reader. Codes and field names are English.

export const BUILD_POLICIES = Object.freeze(['warn', 'refuse']);
export const DEFAULT_BUILD_POLICY = 'warn';
const LANES = ['odc', 'o11'];
const STUDIO = { odc: 'ODC Studio', o11: 'Service Studio' };
// The server-only tools the texts name (the field stillWorks of the gate's refusal lists them all from hosted/tools.json).
export const SERVER_ONLY_EXAMPLES = Object.freeze({
  odc: Object.freeze(['ssam_discover', 'ssam_reference', 'ssam_map', 'ssam_job', 'odc_search_operations']),
  o11: Object.freeze(['ssam_discover', 'ssam_reference', 'ssam_map', 'o11_job', 'o11_inspect']),
});

// The leading numbers of a version, as numbers ("1.7.28.10873 (x)" -> [1, 7, 28, 10873]), or null below three.
const numbersOf = value => {
  const m = /^\s*(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:\.(\d{1,9}))?/.exec(String(value ?? ''));
  return m ? m.slice(1).filter(v => v !== undefined).map(Number) : null;
};
export const threePart = value => { const n = numbersOf(value); return n ? n.slice(0, 3).join('.') : null; };
export const fourPart = value => { const n = numbersOf(value); return n?.length === 4 ? n.join('.') : null; };
// -1, 0 or 1 over the first count numbers.
const compare = (a, b, count) => { for (let i = 0; i < count; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };

// kernel.json studioBuildPolicy: "warn" | "refuse" for both lanes, or {odc, o11} per lane (a missing lane is "warn").
export function buildPolicyOf(value) {
  let invalid = false;
  const one = v => {
    if (v === undefined || v === null) return DEFAULT_BUILD_POLICY;
    const word = typeof v === 'string' ? v.trim().toLowerCase() : null;
    if (BUILD_POLICIES.includes(word)) return word;
    invalid = true;
    return 'refuse';
  };
  const perLane = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (value !== undefined && value !== null && typeof value !== 'string' && !perLane) { invalid = true; return { odc: 'refuse', o11: 'refuse', invalid }; }
  const out = Object.fromEntries(LANES.map(lane => [lane, one(perLane ? value[lane] : value)]));
  return { ...out, invalid };
}
// The served build of a lane: four numbers with the lane's three, else null.
export const servedBuildOf = (kernel, lane) => {
  const build = fourPart(kernel?.builds?.[lane]);
  return build && threePart(build) === threePart(kernel?.[lane]) ? build : null;
};

// installed: the Hello's studios.<lane>.installed ({dir, version}), its version alone, or null (no Studio installed).
// -> {lane, installed, served, relation, direction, policy, ok, warn} or null when the server has no kernel for the lane.
//   relation: same | build-differs | build-unknown | older | newer | unknown (unreadable) | not-installed
//   ok: the server serves this Studio (warn: served with studioBuildDiffers).
export function studioIdentity(lane, installed, kernel) {
  const three = threePart(kernel?.[lane]);
  if (!three) return null;
  const build = servedBuildOf(kernel, lane);
  const policy = buildPolicyOf(kernel?.studioBuildPolicy)[lane];
  const served = build ?? three;
  const out = (relation, version, { direction = null, ok = false, warn = false } = {}) => ({ lane, installed: version, served, relation, direction, policy, ok, warn });
  if (installed === null || installed === undefined) return out('not-installed', null);
  const raw = typeof installed === 'string' ? installed : installed?.version;
  const numbers = numbersOf(raw);
  if (!numbers) return out('unknown', null);
  const version = numbers.join('.');
  const byVersion = compare(numbers, three.split('.').map(Number), 3);
  if (byVersion < 0) return out('older', version, { direction: 'older' });
  if (byVersion > 0) return out('newer', version, { direction: 'newer' });
  if (!build) return out('same', version, { ok: true });
  if (numbers.length < 4) return out('build-unknown', version, policy === 'warn' ? { ok: true, warn: true } : {});
  const byBuild = compare(numbers, build.split('.').map(Number), 4);
  if (byBuild === 0) return out('same', version, { ok: true });
  const direction = byBuild < 0 ? 'older' : 'newer';
  return out('build-differs', version, policy === 'warn' ? { direction, ok: true, warn: true } : { direction });
}

// The cause of a Studio the server does not serve (what the user does), or null when it is served or not installed.
export function causeOf(identity) {
  if (!identity || identity.ok || identity.relation === 'not-installed') return null;
  if (identity.relation === 'unknown') return 'STUDIO_VERSION_UNKNOWN';
  if (identity.relation === 'build-unknown') return 'STUDIO_BUILD_UNKNOWN';
  return identity.direction === 'older' ? 'STUDIO_UPDATE_REQUIRED' : 'STUDIO_VERSION_NOT_SERVED_YET';
}

// The version numbers of the Hello's Studios, for the log: never the folder, never another text ("?" when unreadable).
export function studioVersions(studios) {
  return Object.fromEntries(LANES.map(lane => {
    const installed = studios?.[lane]?.installed;
    if (!installed) return [lane, null];
    const numbers = numbersOf(installed.version);
    return [lane, numbers ? numbers.join('.') : '?'];
  }));
}

// ---- the texts, one place for the hub, the gate and the warnings. B3 (owner rule of 2026-10-15): every text in English,
// no bilingual line: `user` is the userMessage (for the person, shown as it is), `en` the error (for the model).
const listOf = names => names.join(', ');
function words(identity) {
  const S = STUDIO[identity.lane];
  const { installed, served } = identity;
  const three = threePart(served);
  const examples = listOf(SERVER_ONLY_EXAMPLES[identity.lane]);
  const still = {
    user: `Meanwhile, the server-only tools (${examples}) keep working, with a warning.`,
    en: `Server-only tools (${examples}) still work, with the studioNotServed warning.`,
  };
  const nothing = { user: 'Nothing ran on your Studio.', en: 'Nothing ran on the user\'s Studio.' };
  const notified = {
    user: 'the SSAM owner was already notified (the server recorded this request)',
    en: 'the owner was notified (server event studio-version-unserved)',
  };
  const wait = {
    user: `Do not roll ${S} back to the previous version and do not reinstall the agent: once the server is updated, repeat the request.`,
    en: 'Do not roll the Studio back and do not reinstall the agent; repeat the call once the server is updated.',
  };
  let user, en;
  switch (`${identity.relation}:${identity.direction}`) {
    case 'older:older':
      user = `The ${S} on this computer (${installed}) is older than the ${S} the SSAM server serves (${served}). Update ${S} to ${served} and open it again; then repeat the request. Reinstalling the agent does not fix this.`;
      en = `This SSAM server serves ${S} ${served}; the user's machine has ${S} ${installed}, which is older: update ${S} to ${served} and reopen it; no agent package changes that.`;
      break;
    case 'newer:newer':
      user = `The ${S} on this computer (${installed}) is newer than the ${S} the SSAM server serves today (${served}). The server does not have this version yet; ${notified.user}. ${wait.user}`;
      en = `This SSAM server serves ${S} ${served}; the user's machine has ${S} ${installed}, which is newer: the server does not serve this version yet; ${notified.en}. ${wait.en}`;
      break;
    case 'build-differs:older':
      user = `The ${S} on this computer is build ${installed}; the SSAM server serves build ${served} (same version ${three}, another build), and the owner set the server to serve no other build. Update ${S} (the server serves build ${served}) and open it again; then repeat the request.`;
      en = `This SSAM server serves ${S} build ${served}; the user's machine has ${S} build ${installed} (same version ${three}, another build), which is older, and kernel.json studioBuildPolicy "refuse" serves no other build: update ${S} to build ${served} and reopen it.`;
      break;
    case 'build-differs:newer':
      user = `The ${S} on this computer is build ${installed}; the SSAM server serves build ${served} (same version ${three}, another build), and the owner set the server to serve no other build. The server does not have this build yet; ${notified.user}. ${wait.user}`;
      en = `This SSAM server serves ${S} build ${served}; the user's machine has ${S} build ${installed} (same version ${three}, another build), which is newer, and kernel.json studioBuildPolicy "refuse" serves no other build: the server does not serve this build yet; ${notified.en}. ${wait.en}`;
      break;
    case 'build-unknown:null':
      user = `The agent reported version ${installed} of the ${S} on this computer without its build (the 4 numbers), and the SSAM server serves only build ${served}. Without the build there is no way to confirm it is the same Studio as the server's. Talk to the SSAM owner.`;
      en = `This SSAM server serves ${S} build ${served}; the agent reports the user's ${S} as ${installed}, without its build, and kernel.json studioBuildPolicy "refuse" serves no unconfirmed build. Ask the server owner.`;
      break;
    default: // unknown
      user = `The agent could not read the version of the ${S} on this computer, and the SSAM server serves only ${S} ${served}. Check that ${S} is installed and repeat in a few minutes; if it persists, talk to the SSAM owner.`;
      en = `This SSAM server serves ${S} ${served}; the agent could not read the version of the user's ${S}. Ask the user to check the ${S} installation and repeat in a few minutes; if it persists, ask the server owner.`;
  }
  const why = identity.direction === 'older'
    ? `Show the user the userMessage as it is: they update ${S} to ${served} and reopen it, then repeat this call. ssam_doctor shows both builds. Server-only tools still work.`
    : identity.direction === 'newer'
      ? 'Show the user the userMessage as it is: nothing to do on their machine until the server owner updates the server; never ask the user to roll the Studio back or to reinstall the agent. ssam_doctor shows both builds. Server-only tools still work.'
      : 'Show the user the userMessage as it is. ssam_doctor shows the versions the agent reports. Server-only tools still work.';
  return { user: `${user} ${nothing.user} ${still.user}`, en: `${en} ${nothing.en} ${still.en}`, why };
}

// The one refusal of a Studio the server does not serve, or null when it is served (or not installed: the hub's own).
export function studioRefusal(identity, { stillWorks = null } = {}) {
  const cause = causeOf(identity);
  if (!cause) return null;
  const list = Array.isArray(stillWorks) && stillWorks.length ? [...stillWorks] : [...SERVER_ONLY_EXAMPLES[identity.lane]];
  const w = words(identity);
  return { ok: false, code: 'STUDIO_VERSION_MISMATCH', cause, lane: identity.lane, installed: identity.installed, served: [identity.served],
    relation: identity.relation, policy: identity.policy, outcome: 'not-sent', stillWorks: list,
    error: w.en, userMessage: w.user, continuation: { tool: 'ssam_doctor', arguments: {}, why: w.why } };
}

// The warning an answer carries for the lane's Studio: studioBuildDiffers when another build is served (policy "warn");
// studioNotServed when a tool ran (a server-only tool, a state report) while the Studio is not served; null otherwise.
export function studioWarningOf(identity) {
  if (!identity) return null;
  const S = STUDIO[identity.lane];
  const { lane, installed, served, relation, policy } = identity;
  const three = threePart(served);
  if (identity.warn) {
    const unknown = relation === 'build-unknown';
    return { code: 'studioBuildDiffers', lane, installed, served, relation, policy,
      userMessage: unknown
        ? `Warning: the agent reported the ${S} on this computer as ${installed}, without its build, and the SSAM server uses the kernel of build ${served}. There is no way to confirm it is the same build; the SSAM owner decided to serve it this way for now. Check the result in ${S} before publishing.`
        : `Warning: the ${S} on this computer is build ${installed} and the SSAM server uses the kernel of build ${served} (same version ${three}, another build). The SSAM owner decided to serve this case with a warning; this combination is not proven. Check the result in ${S} before publishing.`,
      error: unknown
        ? `Warning: the agent reports the user's ${S} as ${installed}, without its build; this SSAM server runs the kernel of build ${served}. The owner serves an unconfirmed build with a warning (kernel.json studioBuildPolicy "warn"). Check the result in the Studio before publishing.`
        : `Warning: the user's ${S} is build ${installed}; this SSAM server runs the kernel of build ${served} (same version ${three}, another build). The owner serves this pair with a warning (kernel.json studioBuildPolicy "warn"); the pair is not proven. Check the result in the Studio before publishing.` };
  }
  const cause = causeOf(identity);
  if (!cause) return null;
  const todo = identity.direction === 'older'
    ? { user: `To use the Studio tools, update ${S} to ${served}.`, en: `To use the Studio tools, the user updates ${S} to ${served}.` }
    : identity.direction === 'newer'
      ? { user: `The server does not have this version yet; the SSAM owner was already notified. Do not roll ${S} back.`, en: 'The server does not serve this version yet; the owner was notified. Never ask the user to roll the Studio back.' }
      : { user: 'Talk to the SSAM owner if it persists.', en: 'Ask the server owner if it persists.' };
  const shown = installed ?? 'version not read';
  return { code: 'studioNotServed', lane, cause, installed, served, relation, policy,
    userMessage: `Warning: this tool ran on the server only, with the kernel of ${S} ${served}, but the ${S} on this computer (${shown}) is not served by this server, and the tools that touch ${S} are refused. ${todo.user}`,
    error: `Warning: this tool ran on the server only, with the kernel of ${S} ${served}, but the user's ${S} ${installed ?? '(version unread)'} is not served by this server (${cause}); tools that touch the ${S} are refused. ${todo.en}` };
}
