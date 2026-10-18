// o11_extension: O11 .NET extensions (XIF) without Integration Studio and without its login (contract
// docs/INTEGRACOES-GITSSAM.md, lane xif). One call per change; every refusal comes before anything is sent, with every
// problem and what the next call needs.
//
// publish {host, spec|specFile, words?, operationId?, ...}, in this order:
//   1. the connected Studio for host (Resolver of the Service Center, session studio, never a prompt) and its bridge
//      capability sc_api:integration-studio: without it BRIDGE_TOO_OLD, before any kernel call or build;
//   2. identity by the exact name: ListExtensions + ListEspaces. none = create; one extension = edit (its active version is
//      downloaded as the base, keys kept, VersionId kept); a case variant or a duplicate = EXTENSION_AMBIGUOUS; a module
//      of that name = EXTENSION_NAME_TAKEN; expectedVersionId other than the active one = EXTENSION_VERSION_CHANGED;
//   3. the spec in the kernel (anvil xif check, every problem at once: XIF_SPEC_INVALID);
//   4. the model XIF (anvil xif build --stage model, the installed Integration Studio through Anvil.Xif.Engine), then the
//      Handshake with the engine version (XIF_ENGINE_INCOMPATIBLE with the server's text);
//   5. the stubs and the platform DLLs from the environment (bridge reads; a server error is XIF_STUBS_REFUSED); the DLLs
//      are cached under <anvilRoot>/.local/xif-deps/<host>/<platform>/<sha256>.zip (never committed nor packaged);
//   6. merge, compile and final XIF (anvil xif build --stage final), read again and audited by the kernel;
//   7. UploadNeeded: the same version already running = state already-running, nothing sent;
//   8. an edit that breaks the public contract: GetConsumers(extension, element) for each breaking element; a consumer the
//      words do not name = EXTENSION_BREAKS_CONSUMERS (D9, ssamRule); a failed read = EXTENSION_CONSUMERS_UNKNOWN;
//   9. the words naming the extension, or a standing publish grant that covers it (never for a breaking change); a
//      corporate or unregistered host needs confirmHost and words naming it. Missing: WORDS_REQUIRED, WORDS_MUST_NAME_TARGET,
//      CONFIRM_HOST_REQUIRED, already with xifSha256, contractDiff and consumers;
//  10. ONE extension-publish of the Service Center engine (contract I1) with --extension and --expected-version-id; the
//      answer is created | updated | already-running | uncertain. An uncertain publication is never sent again: the same
//      call with the same operationId reconciles by reading (UploadNeeded of the recorded hash).
// read {host, extension}: the active version downloaded and read by the kernel (spec, keys, versionId, signatureHash) plus
// its consumers. delete {host, extension, words}: the delete engine of the Service Center (contract I1), one implementation.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { anvilRoot } from './workspace.mjs';
import * as standingGrants from './standing-grants.mjs';
import { authorizationContext } from './authorization-context.mjs';
import { consumerNames } from './o11-publish.mjs';
import { CAPABILITY, studioReads } from './service-center/integration-studio.mjs';
import { hostClass as registeredHostClass } from './service-center/auth.mjs';
import { recordPublished, recordPublicationEnded, publicationOpen } from './producer-signatures.mjs';
import { DESTRUCTIVE_SUFFIX, tokenNames, wordsGiven } from './destructive-operations.mjs';

export const TOOL = 'o11_extension';
export const ACTIONS = Object.freeze(['read', 'publish', 'delete']);
export const STATES = Object.freeze(['created', 'updated', 'already-running', 'uncertain']);
const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const sha256 = data => createHash('sha256').update(data).digest('hex');
const fold = text => String(text ?? '').trim().toLowerCase();
const placeholder = words => !wordsGiven(words); // CX15 r7 (L-7): one predicate
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value?.ok === false ? { isError: true } : {}) });
const problem = (code, message, fix, extra = {}) => ({ code, message, fix, ...extra });
const refusal = (code, error, problems = [], extra = {}) => ({ ok: false, code, error, problems: problems.length ? problems : [problem(code, error, null)], ...extra });
const next = (tool, args, why) => ({ tool, arguments: args, why });

export const extensionSchema = z.object({
  action: z.enum(ACTIONS).describe('read: spec, keys, consumers and exported resources (local files and reusable DLL references); publish: create or edit from spec; delete: remove the extension'),
  host: z.string().trim().toLowerCase().max(253).regex(HOST, 'bare DNS name of the environment (no scheme, port or path)').describe('The O11 environment (bare host) the connected Studio is signed in to'),
  extension: z.string().trim().min(1).max(200).optional().describe('read and delete: the extension name, exactly as in the environment'),
  spec: z.record(z.string(), z.unknown()).optional().describe('publish: {name, description?, structures?, actions:[{name, isFunction?, inputs?, outputs?, body}], sources?:[{path:"Helpers.cs", text|file}], references?:["<absolute .NET Framework .dll>"] (plus every DLL they need), resources?:[{path, text|file, deploy}], remove?}; bodies use the declared names (or ss<Name>) and may call the classes of sources'),
  specFile: z.string().max(1024).optional().describe('publish: absolute path of a JSON file with the spec (in place of spec)'),
  referencesFrom: z.array(z.string().trim().regex(NAME).max(200)).max(20).optional().describe('publish: existing extensions on this host whose non-platform code-reference DLLs and license notices are reused automatically. Downloads, exports, checks dependency closure and records pinned source versions in this same call; no local paths needed.'),
  application: z.string().trim().min(1).max(200).optional().describe('publish, new extension: the application it joins'),
  applicationKey: z.string().trim().min(1).max(100).optional().describe('publish, new extension: the key of that application'),
  commitMessage: z.string().trim().min(1).max(2000).optional().describe('publish: the version comment'),
  consumers: z.boolean().optional().describe('publish: true also refreshes and publishes every consumer module, with the same words or a grant that covers each'),
  expectedVersionId: z.union([z.string().trim().min(1).max(20), z.number().int().nonnegative()]).optional().describe('publish: the active version the edit is based on ("none" for a new extension); another one is EXTENSION_VERSION_CHANGED'),
  words: z.string().max(4000).optional().describe('The user\'s own words, verbatim, naming the extension (and every consumer a breaking change or a delete affects); only their sha256 is kept'),
  authorizationContext: z.string().max(1024).optional().describe('Absolute proposal-bound human approval record: new fixture publication only, or exact-target deletion; never a standing grant or consumer cascade'),
  operationId: z.string().regex(UUID).optional().describe('publish/delete: a UUID; the same call repeated with it reconciles by reading and never sends again'),
  confirmHost: z.string().trim().toLowerCase().max(253).optional().describe('A corporate or unregistered environment: the same host again, and words that name it'),
  confirmationToken: z.string().trim().min(1).max(200).optional().describe('delete: the token of the preview the owner confirmed; without it the delete only previews (nothing sent)'),
  ownerRequest: z.string().max(4000).optional().describe('delete, preview call: the owner\'s request, verbatim (only its sha256 is kept; it never confirms)'),
}).strict();

// ---- the kernel (anvil xif ...): one JSON per command, the refusal shape of the kernel kept as it is.
async function kernel(ctx, args) {
  const result = await ctx.runAnvil(['xif', ...args], { timeoutMs: 900000 });
  const data = result?.envelope?.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  return refusal('XIF_KERNEL_FAILED', String(result?.envelope?.error ?? (result?.stderr ?? []).join(' ') ?? 'the kernel answered nothing').slice(0, 400) || 'the kernel answered nothing',
    [problem('XIF_KERNEL_FAILED', 'anvil xif ' + args[0] + ' did not answer JSON', 'Rebuild the kernel with scripts\\setup-dev.ps1; nothing was sent.')]);
}

// ---- the Studio reads: a failure of the Resolver keeps its code and continuation.
function authRefusal(error) {
  if (typeof error?.answer === 'function') { const answer = error.answer(); return { ...answer, ok: false, problems: [problem(answer.code, answer.error ?? error.message, null)] }; }
  return refusal(error?.code ?? 'STUDIO_UNAVAILABLE', String(error?.message ?? error).slice(0, 400), [], error?.extra?.continuation ? { continuation: error.extra.continuation } : {});
}
const readFailure = (error, what) => refusal(error?.code ?? 'REMOTE_ERROR', `${what}: ${String(error?.message ?? error).slice(0, 300)}; nothing was sent.`);

function identity(name, extensions, modules) {
  const variants = extensions.filter(r => fold(r.name) === fold(name));
  const exact = variants.filter(r => r.name === name);
  if (variants.length > 1 || (variants.length === 1 && exact.length === 0))
    return { refused: refusal('EXTENSION_AMBIGUOUS', `The environment has ${variants.length} extension(s) named like '${name}': ${variants.map(v => v.name).join(', ')}.`,
      [problem('EXTENSION_AMBIGUOUS', 'Names compare without case in O11; the name does not identify one extension.', 'Use the exact name of one of them in spec.name: ' + variants.map(v => v.name).join(', ') + '.')],
      { candidates: variants.map(v => ({ name: v.name, key: v.key })) }) };
  const module = modules.find(m => fold(m.name) === fold(name));
  if (module)
    return { refused: refusal('EXTENSION_NAME_TAKEN', `'${module.name}' is a module (eSpace) of this environment.`,
      [problem('EXTENSION_NAME_TAKEN', 'An extension cannot take the name of an existing module.', 'Choose another name in spec.name.')]) };
  return { current: exact[0] ?? null };
}

const closest = (name, rows) => rows.map(r => r.name).filter(Boolean)
  .map(n => [n, [...fold(name)].filter((c, i) => fold(n)[i] === c).length - Math.abs(n.length - name.length)]).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n);

// The platform DLLs of the environment, cached by platform version and content.
async function dependencies(ctx, reads, platform, work) {
  const dir = path.join(ctx.root, '.local', 'xif-deps', reads.host, String(platform || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_'));
  const cached = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^[0-9a-f]{64}\.zip$/.test(f)).sort() : [];
  for (const file of cached) {
    const full = path.join(dir, file);
    if (sha256(fs.readFileSync(full)) === file.slice(0, 64)) return { zip: full, cached: true };
  }
  const out = path.join(work, 'deps.zip');
  let answer;
  try { answer = await reads.dependencies(out); }
  catch (error) { return { refused: stubsRefused('GetSourceCodeDependencies', error?.message ?? String(error), []) }; }
  if (!(answer?.bytes > 0) || answer?.meta?.errors > 0 || !fs.existsSync(out))
    return { refused: stubsRefused('GetSourceCodeDependencies', 'the server answered no dependencies', answer?.meta?.messages ?? []) };
  const content = fs.readFileSync(out);
  const target = path.join(dir, sha256(content) + '.zip');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(target)) fs.copyFileSync(out, target);
  return { zip: target, cached: false };
}

const stubsRefused = (operation, text, messages) => refusal('XIF_STUBS_REFUSED', `The environment refused ${operation}: ${String(text).slice(0, 300)}; nothing was sent.`,
  [problem('XIF_STUBS_REFUSED', String(text).slice(0, 300), 'Fix the spec where the server messages point (or the platform version); nothing was sent.')],
  { messages: (messages ?? []).slice(0, 20) });

// ---- receipts: one file per operationId, written before the send; an uncertain one is reconciled, never resent.
const receiptFile = (ctx, operationId) => path.join(ctx.root, '.local', 'xif', 'receipts', operationId + '.json');
function readReceipt(ctx, operationId) { try { return JSON.parse(fs.readFileSync(receiptFile(ctx, operationId), 'utf8')); } catch { return null; } }
function writeReceipt(ctx, receipt) {
  const file = receiptFile(ctx, receipt.operationId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...receipt, at: ctx.now().toISOString() }, null, 2));
}

function wordsFor(ctx, input, name) {
  const resolved = standingGrants.wordsFor({ authorize: input.words, lane: 'o11', module: name, app: input.application ?? null, verb: 'publish' }, ctx.grants, { file: ctx.grantsFile });
  return { words: placeholder(resolved.words) ? '' : resolved.words, authorization: resolved.authorization ?? null };
}

function referenceContinuation(ctx, work, name, actions) {
  const job = { description: `Reference the extension ${name} (published by o11_extension) from a consumer module.`,
    ops: [{ op: 'reference', producer: name, elements: actions.map(a => 'IServerActionSignature:' + a) }] };
  const file = path.join(work, 'reference-' + name + '.json');
  try { fs.mkdirSync(work, { recursive: true }); fs.writeFileSync(file, JSON.stringify(job, null, 2)); } catch { /* the job stays inline in referenceJob */ }
  return { referenceJob: job, continuation: next('ssam_job', { lane: 'o11', job: file, base: '<consumer .oml snapshot>', captureProducers: [name] },
    'reference the extension in the consumer module (the runner captures its signature read-only); then o11_deliver and o11_publish of the consumer with the user\'s words') };
}

async function publish(input, ctx) {
  let spec = input.spec ?? null;
  if (!spec && input.specFile) {
    if (!path.isAbsolute(input.specFile) || !fs.existsSync(input.specFile))
      return refusal('XIF_SPEC_INVALID', 'specFile is not an existing absolute file.', [problem('XIF_SPEC_FILE', 'specFile must be an absolute JSON file.', 'Give the absolute path of the spec JSON, or pass spec.', { path: 'specFile' })]);
    try { spec = JSON.parse(fs.readFileSync(input.specFile, 'utf8').replace(/^﻿/, '')); }
    catch (error) { return refusal('XIF_SPEC_INVALID', 'specFile is not valid JSON: ' + error.message, [problem('XIF_SPEC_SHAPE', 'specFile is not valid JSON.', 'Fix the JSON.', { path: 'specFile' })]); }
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec))
    return refusal('XIF_SPEC_INVALID', 'publish needs spec (or specFile).', [problem('XIF_SPEC_REQUIRED', 'spec is required.', 'Pass spec {name, actions:[...]} (o11_extension read gives the current one).', { path: 'spec' })]);
  const name = typeof spec.name === 'string' && NAME.test(spec.name) ? spec.name : null;
  const host = input.host;
  const work = path.join(ctx.root, '.local', 'xif', 'work', host, name ?? 'unnamed', ctx.now().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));

  // A repeated call of an operation already sent: read, never send again.
  const previous = input.operationId ? readReceipt(ctx, input.operationId) : null;

  // 1. The connected Studio and its bridge (no kernel call before this).
  let reads;
  try { reads = await ctx.reads(host); } catch (error) { return authRefusal(error); }
  let capabilities;
  try { capabilities = await reads.capabilities(); } catch (error) { return readFailure(error, 'the bridge manifest could not be read'); }
  if (!capabilities?.has?.(CAPABILITY))
    return refusal('BRIDGE_TOO_OLD', 'The Service Studio bridge loaded in this Studio has no integration-studio surface; nothing was built or sent.',
      [problem('BRIDGE_TOO_OLD', `The bridge does not announce ${CAPABILITY}.`, 'Close the Service Studio and open it again through the "Service Studio (SSAM)" shortcut, then reconnect with ssam_connect {lane:"o11"}.')],
      { continuation: next('ssam_connect', { lane: 'o11' }, 'reconnect after reopening the Studio through the "Service Studio (SSAM)" shortcut; the new bridge applies to the next Studio opened') });

  if (previous) return reconcile(previous, reads, ctx);
  if (!name) {
    // The kernel names every problem of the spec at once (the name among them).
    fs.mkdirSync(work, { recursive: true });
    const specFile = path.join(work, 'spec.json'); fs.writeFileSync(specFile, JSON.stringify(spec));
    const checked = await kernel(ctx, ['check', '--spec', specFile]);
    return checked.ok === false ? checked : refusal('XIF_SPEC_INVALID', 'spec.name is not a valid extension name.', [problem('XIF_SPEC_IDENTIFIER', 'spec.name is not valid.', 'Use a name that starts with a letter and has only letters, digits and _.', { path: 'name' })]);
  }

  // 2. Identity.
  let extensions, modules;
  try { [extensions, modules] = await Promise.all([reads.extensions(), reads.modules()]); }
  catch (error) { return readFailure(error, 'the extensions and modules of the environment could not be read'); }
  const found = identity(name, extensions, modules);
  if (found.refused) return found.refused;
  const current = found.current;
  const observedVersion = current?.versionId ?? null;
  if (input.expectedVersionId != null && String(input.expectedVersionId) !== String(observedVersion ?? 'none'))
    return refusal('EXTENSION_VERSION_CHANGED', `The active version of ${name} is ${observedVersion ?? 'none'}, not ${input.expectedVersionId}; nothing was built or sent.`,
      [problem('EXTENSION_VERSION_CHANGED', 'The extension changed since the version the edit was based on.', 'Read it again (o11_extension read) and rebuild the spec on the active version.')],
      { observed: { versionId: observedVersion }, continuation: next(TOOL, { action: 'read', host, extension: name }, 'read the active version before editing') });
  fs.mkdirSync(work, { recursive: true });
  let base = null;
  if (current) {
    base = path.join(work, 'base', name + '.xif');
    try { await reads.download(current.key, current.versionId, base); }
    catch (error) { return readFailure(error, `the active version of ${name} could not be downloaded`); }
    if (!fs.existsSync(base)) return refusal('EXTENSION_READ_FAILED', `The active version of ${name} came back empty; nothing was sent.`);
  }

  // Resolve libraries from the same live environment inside the delivery, not by asking the caller to move DLLs.
  const imported = await importReferences(input.referencesFrom ?? [], spec, input.host, ctx, reads, extensions);
  if (imported.ok === false) return imported;
  spec = imported.spec;

  // 3. The spec, every problem at once.
  const specFile = path.join(work, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const baseArgs = base ? ['--base', base] : [];
  const checked = await kernel(ctx, ['check', '--spec', specFile, ...baseArgs]);
  if (checked.ok === false) return checked;
  // K1-f: what the kernel accepted in another shape (sources, references or resources as one object) goes to the receipt.
  const normalized = { ...(Array.isArray(checked.specNormalized) && checked.specNormalized.length ? { specNormalized: checked.specNormalized } : {}),
    ...(imported.sources.length ? { referenceSources: imported.sources } : {}) };

  // 4. The model, then the handshake with the engine version.
  const model = await kernel(ctx, ['build', '--stage', 'model', '--spec', specFile, ...baseArgs, '--work', work]);
  if (model.ok === false) return model;
  // The Handshake of the real Integration Studio (WebServicesFacade.Handshake): its product version, then its
  // Config.LastUpgradeVersion (11.0.0.200 in 11.14). The product version in both was refused as an incompatible tool.
  const version = model.engine?.version ?? null;
  const lastUpgradeVersion = model.engine?.lastUpgradeVersion ?? null;
  if (!version || !lastUpgradeVersion)
    return refusal('XIF_ENGINE_UNAVAILABLE', 'The Integration Studio engine did not report its product and last-upgrade versions; nothing was sent.',
      [problem('XIF_ENGINE_UNAVAILABLE', 'The model answer has no engine.version or engine.lastUpgradeVersion.', 'Rebuild the engine with scripts\\setup-dev.ps1.')]);
  let shake;
  try { shake = await reads.handshake(version, lastUpgradeVersion); }
  catch (error) { return readFailure(error, 'the Integration Studio handshake failed'); }
  if (shake?.ok !== true)
    return refusal('XIF_ENGINE_INCOMPATIBLE', `The environment refused the installed Integration Studio ${version ?? ''}: ${shake?.error ?? 'no reason given'}; nothing was sent.`,
      [problem('XIF_ENGINE_INCOMPATIBLE', String(shake?.error ?? 'The handshake was refused.'), `Install the Integration Studio of this platform (${shake?.platform ?? 'see the environment'}) and point ANVIL_INTEGRATION_STUDIO_DIR at it.`)],
      { platform: shake?.platform ?? null });

  // 5. Stubs and platform DLLs.
  const stubsZip = path.join(work, 'stubs.zip');
  let stubs;
  try { stubs = await reads.stubs(model.xif, stubsZip); }
  catch (error) { return stubsRefused('GenerateSourceCodeStubs', error?.message ?? String(error), []); }
  if (!(stubs?.bytes > 0) || stubs?.meta?.errors > 0 || !fs.existsSync(stubsZip))
    return stubsRefused('GenerateSourceCodeStubs', (stubs?.meta?.messages ?? []).find(m => m?.type === 'Error')?.message ?? 'the server answered no stubs', stubs?.meta?.messages ?? []);
  const deps = await dependencies(ctx, reads, shake.platform, work);
  if (deps.refused) return deps.refused;

  // 6. Merge, compile, final XIF (read again and audited by the kernel).
  const final = await kernel(ctx, ['build', '--stage', 'final', '--spec', specFile, '--model', model.xif, '--stubs', stubsZip, '--deps', deps.zip, ...baseArgs, '--work', work]);
  if (final.ok === false) return final;
  const summary = { extension: name, extensionKey: final.key, xif: final.xif, xifSha256: final.xifSha256, dllSha256: final.dllSha256, contractDiff: final.contractDiff ?? null, ...normalized };

  // 7. Already running?
  let needed;
  try { needed = await reads.uploadNeeded(final.key, final.hash); }
  catch (error) { return readFailure(error, 'UploadNeeded failed'); }
  if (needed?.needs === false && needed.equalVersionId > 0 && needed.equalVersionId === needed.runningVersionId)
    return { ok: true, state: 'already-running', ...summary, extensionId: needed.extensionId ?? current?.id ?? null, versionId: needed.runningVersionId, consumers: {},
      ...referenceContinuation(ctx, work, name, (spec.actions ?? []).map(a => a?.name).filter(Boolean)) };

  // 8. A breaking edit: who consumes each breaking element.
  const breaking = Boolean(final.contractDiff?.breaking);
  const consumers = {};
  if (breaking) {
    for (const element of final.contractDiff.breakingElements ?? []) {
      try { consumers[element.name] = consumerNames(await reads.consumers(current.key, element.key ?? ''), name); }
      catch (error) {
        return refusal('EXTENSION_CONSUMERS_UNKNOWN', `The consumers of ${name}.${element.name} could not be read (${String(error?.message ?? error).slice(0, 200)}); nothing was sent.`,
          [problem('EXTENSION_CONSUMERS_UNKNOWN', 'A breaking change is never sent without its consumers known.', 'Repeat the call when the environment answers GetConsumers.', { ssamRule: true })],
          { ...summary, consumers });
      }
    }
  }
  const affected = [...new Set(Object.values(consumers).flat())].sort((a, b) => a.localeCompare(b));

  // 9. Authorization.
  const { words, authorization } = wordsFor(ctx, input, name);
  let contextual;
  if (input.authorizationContext) {
    if (current || input.application || input.applicationKey || input.consumers)
      return refusal('AUTHORIZATION_CONTEXT_INVALID', 'Context publication covers a new standalone fixture only; nothing was sent.');
    try { contextual = authorizationContext(input.authorizationContext, words, {lane:'o11',host,operation:'extension-publish',targets:[name],constraints:{createOnly:true}}); }
    catch (error) { return refusal(error.code, error.message); }
  }
  const repeat = { action: 'publish', host, spec: input.spec ? '<the same spec>' : undefined, specFile: input.specFile, referencesFrom: input.referencesFrom, words: '<the user\'s words naming ' + name + (affected.length ? ' and ' + affected.join(', ') : '') + '>' };
  const because = { ...summary, consumers };
  if (!wordsGiven(words) || (authorization && breaking))
    return refusal('WORDS_REQUIRED', breaking && authorization ? `A breaking change of ${name} needs the user's own words; a standing grant never covers it. Nothing was sent.`
      : `Publishing ${name} needs the user's own words naming it (or a standing publish grant that covers it). Nothing was sent.`,
    [problem('WORDS_REQUIRED', 'No words authorize this publication.', `Ask the user and pass their words verbatim in words; they name ${name}${affected.length ? ' and every consumer: ' + affected.join(', ') : ''}.`, breaking ? { ssamRule: true } : {})],
    { ...because, repeat: JSON.parse(JSON.stringify(repeat)) });
  if (!authorization && !contextual && !standingGrants.namesApp(words, name))
    return refusal('WORDS_MUST_NAME_TARGET', `The words do not name ${name}. Nothing was sent.`,
      [problem('WORDS_MUST_NAME_TARGET', `The user's words must name the extension ${name} as a whole word.`, `Words that name ${name}.`)], { ...because, repeat: JSON.parse(JSON.stringify(repeat)) });
  const unnamed = affected.filter(consumer => !standingGrants.namesApp(words, consumer));
  if (unnamed.length)
    return refusal('EXTENSION_BREAKS_CONSUMERS', `The change breaks ${name} for ${unnamed.join(', ')}; the words do not name them. Nothing was sent.`,
      [problem('EXTENSION_BREAKS_CONSUMERS', `Consumers that would break: ${unnamed.join(', ')}.`, `Words that also name ${unnamed.join(', ')} (they must be refreshed and republished), or keep the contract compatible.`, { ssamRule: true })],
      { ...because, repeat: JSON.parse(JSON.stringify(repeat)) });
  const kind = ctx.hostClass(host);
  if (kind === 'read-only') return refusal('HOST_READ_ONLY', `${host} is registered read-only; nothing is published there.`, [], because);
  if (kind !== 'personal') {
    const label = fold(host.split('.')[0]);
    if (input.confirmHost !== host || (!fold(words).includes(label) && !fold(words).includes(fold(host))))
      return refusal('CONFIRM_HOST_REQUIRED', `${host} is a ${kind} environment: the publication needs confirmHost=${host} and words that name it. Nothing was sent.`,
        [problem('CONFIRM_HOST_REQUIRED', `${host} is not a personal environment.`, `Pass confirmHost: "${host}" and words that name ${host.split('.')[0]}.`)], { ...because, repeat: JSON.parse(JSON.stringify({ ...repeat, confirmHost: host })) });
  }

  // 10. One publication (contract I1).
  const operationId = input.operationId ?? randomUUID();
  const created = !current;
  writeReceipt(ctx, { operationId, state: 'sending', host, extension: name, key: final.key, hash: final.hash, xifSha256: final.xifSha256, created,
    xif: final.xif, referenceSources: imported.sources,
    wordsSha256: sha256(words), ...(authorization?.grantId ? { grantId: authorization.grantId } : {}) });
  const argv = ['extension-publish', '--host=' + host, '--xif-file=' + final.xif, '--extension=' + name, '--expected-version-id=' + (observedVersion ?? 'none'),
    ...(input.applicationKey ? ['--application-key=' + input.applicationKey] : input.application ? ['--application=' + input.application] : []),
    ...(input.commitMessage ? ['--commit-message=' + input.commitMessage] : []),
    '--words=' + words, '--operation-id=' + operationId, '--execute', ...(input.confirmHost ? ['--confirm-host=' + input.confirmHost] : []),
    ...(contextual ? ['--authorization-context=' + input.authorizationContext] : [])];
  let sent;
  // F5 (producer-signatures.mjs): the extension is a producer; no observation of it made before the end of this
  // publication counts (an uncertain one stays running for the ledger).
  const publication = recordPublished(path.join(ctx.root, '.local', 'producer-cache'), { environment: host, module: name, key: final.key ?? null, source: TOOL, id: operationId });
  try { sent = await ctx.serviceCenter(argv); } catch (error) { sent = { ok: false, state: 'uncertain', error: String(error?.message ?? error) }; }
  const outcome = interpret(sent, { name, created, operationId, summary, current, host });
  if (!publicationOpen(outcome)) recordPublicationEnded(publication);
  writeReceipt(ctx, { operationId, state: outcome.state ?? (outcome.ok === false ? 'refused' : 'unknown'), host, extension: name, key: final.key, hash: final.hash,
    xifSha256: final.xifSha256, xif: final.xif, referenceSources: imported.sources, created, versionId: outcome.versionId ?? null, extensionId: outcome.extensionId ?? null, wordsSha256: sha256(words) });
  if (!STATES.includes(outcome.state) || outcome.state === 'uncertain') return { ...outcome, consumers };
  const answer = { ...outcome, consumers, ...(contextual ? {authorization:{source:'human-context',context:contextual}} : authorization ? { authorization } : {}), ...referenceContinuation(ctx, work, name, (spec.actions ?? []).map(a => a?.name).filter(Boolean)) };
  if (!input.consumers) return answer;
  const cascade = await ctx.publishConsumersOf({ producer: { name, key: final.key, environment: host }, words, authorization, message: input.commitMessage }, ctx.publishDeps);
  return { ...answer, consumerPublications: cascade?.consumers ?? [], ...(cascade?.ok === false ? { ok: false, code: cascade.code, error: cascade.error, continuation: cascade.continuation ?? answer.continuation } : {}) };
}

// The Service Center answer of extension-publish (contract I1) as this tool's states.
function interpret(sent, { name, created, operationId, summary, current, host }) {
  if (sent?.ok === false && sent.code === 'EXTENSION_VERSION_CHANGED')
    return { ...sent, ok: false, ...summary, operationId, continuation: next(TOOL, { action: 'read', host, extension: name }, 'the extension changed since the read; read it again before editing') };
  const state = sent?.state ?? sent?.result?.state;
  const versionId = sent?.extensionVersionId ?? sent?.result?.extensionVersionId ?? null;
  const extensionId = sent?.extensionId ?? sent?.result?.extensionId ?? current?.id ?? null;
  if (state === 'confirmed') return { ok: true, state: created ? 'created' : 'updated', ...summary, extensionId, versionId, operationId };
  if (state === 'rejected')
    return refusal('EXTENSION_PUBLISH_REJECTED', `The environment rejected the publication of ${name}: ${(sent.errors ?? [])[0] ?? 'see messages'}.`,
      (sent.errors ?? []).map(e => problem('EXTENSION_PUBLISH_REJECTED', String(e), 'Fix the extension where the message points, then publish again with the user\'s words.')),
      { ...summary, operationId, messages: sent.messages ?? [] });
  if (state === 'uncertain' || state === 'accepted-unverified' || sent?.code === 'UNCERTAIN' || sent?.outcome === 'uncertain')
    return { ok: false, state: 'uncertain', code: 'EXTENSION_PUBLISH_UNCERTAIN', ...summary, extensionId, versionId, operationId,
      error: `The publication of ${name} has no confirmed end; it is never sent again. The same call with this operationId reconciles by reading.`,
      problems: [problem('EXTENSION_PUBLISH_UNCERTAIN', 'The answer of the publication was lost or not confirmed.', 'Call o11_extension publish again with the same operationId: it reads the environment and never sends twice.')],
      continuation: next(TOOL, { action: 'publish', host, operationId, spec: '<the same spec>' }, 'reconciles by reading the environment; never sends again') };
  if (sent?.ok === false) return { ...sent, ok: false, problems: sent.problems ?? [problem(sent.code ?? 'EXTENSION_PUBLISH_REFUSED', String(sent.error ?? 'refused'), null)], ...summary, operationId };
  return { ok: false, state: 'uncertain', code: 'EXTENSION_PUBLISH_UNCERTAIN', ...summary, operationId, error: `The Service Center answered no state for ${name}; it is never sent again.`,
    problems: [problem('EXTENSION_PUBLISH_UNCERTAIN', 'No state came back.', 'Call again with the same operationId to reconcile by reading.')] };
}

// The same operationId again: the recorded hash read through UploadNeeded. Running = the publication happened; otherwise
// it stays uncertain. Never a second send.
async function reconcile(receipt, reads, ctx) {
  const base = { extension: receipt.extension, extensionKey: receipt.key, xifSha256: receipt.xifSha256, xif: receipt.xif,
    referenceSources: receipt.referenceSources, operationId: receipt.operationId, reconciled: true, sent: false };
  if (['created', 'updated', 'already-running'].includes(receipt.state))
    return { ok: true, state: receipt.state, ...base, extensionId: receipt.extensionId ?? null, versionId: receipt.versionId ?? null };
  if (receipt.state === 'refused') return refusal('OPERATION_REFUSED', `The operation ${receipt.operationId} was refused before; use a new operationId for a new publication.`, [], base);
  let needed = null;
  try { needed = await reads.uploadNeeded(receipt.key, receipt.hash); } catch { needed = null; }
  if (needed?.needs === false && needed.equalVersionId > 0 && needed.equalVersionId === needed.runningVersionId) {
    const state = receipt.created ? 'created' : 'updated';
    writeReceipt(ctx, { ...receipt, state, versionId: needed.runningVersionId, extensionId: needed.extensionId ?? null });
    return { ok: true, state, ...base, extensionId: needed.extensionId ?? null, versionId: needed.runningVersionId };
  }
  return { ok: false, state: 'uncertain', code: 'EXTENSION_PUBLISH_UNCERTAIN', ...base,
    error: `The environment does not show ${receipt.extension} at the published hash yet; nothing was sent again.`,
    problems: [problem('EXTENSION_PUBLISH_UNCERTAIN', 'The publication is not confirmed by the environment.', 'Check the extension in the Service Center; repeat this call later with the same operationId (it only reads).')] };
}

async function importReferences(names, original, host, ctx, reads, extensions) {
  if (!names.length) return { spec: original, sources: [] };
  const documents = await Promise.all([...new Set(names)].map(extension => read({ host, extension }, ctx, reads, extensions)));
  const failed = documents.filter(d => d.ok === false);
  if (failed.length) return refusal('XIF_REFERENCE_SOURCE_FAILED', 'A library source could not be read; nothing was built or sent.',
    failed.flatMap(d => d.problems ?? [problem(d.code, d.error, null)]));
  const spec = structuredClone(original);
  const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
  const references = list(spec.references), resources = list(spec.resources), sources = [];
  const seen = new Map();
  for (const file of references) {
    if (typeof file !== 'string' || !fs.existsSync(file)) continue; // the spec checker reports malformed author references
    seen.set(path.basename(file).toLowerCase(), { file, hash: sha256(fs.readFileSync(file)) });
  }
  for (const d of documents) {
    if (!d.exported || !Array.isArray(d.exported.references) || !Array.isArray(d.exported.resources))
      return refusal('XIF_REFERENCE_EXPORT_UNAVAILABLE', 'The kernel did not export the library resources; nothing was built or sent.',
        [problem('XIF_REFERENCE_EXPORT_UNAVAILABLE', d.extension, 'Update the CLI so xif read supports --resources-out.')]);
    for (const file of d.exported.references) {
      const hash = sha256(fs.readFileSync(file)), key = path.basename(file).toLowerCase(), previous = seen.get(key);
      if (previous && previous.hash !== hash)
        return refusal('XIF_REFERENCE_CONFLICT', `Different libraries have the same filename ${path.basename(file)}; nothing was built or sent.`,
          [problem('XIF_REFERENCE_CONFLICT', 'DLL contents differ.', 'Use source extensions with compatible library versions.')]);
      if (!previous) { references.push(file); seen.set(key, { file, hash }); }
    }
    // Preserve redistribution notices automatically, under the source name to avoid collisions.
    for (const r of d.exported.resources.filter(r => /license|notice|copying/i.test(r.path))) {
      const target = 'Licenses\\' + d.extension + '\\' + r.path;
      if (resources.some(r => String(r?.path).toLowerCase() === target.toLowerCase()))
        return refusal('XIF_REFERENCE_CONFLICT', `A supplied resource collides with ${target}; nothing was built or sent.`);
      resources.push({ path: target, file: r.file, deploy: 'Ignore' });
    }
    sources.push({ extension: d.extension, versionId: d.versionId, xifSha256: d.xifSha256, references: d.exported.references.length });
  }
  spec.references = references;
  spec.resources = resources;
  return { spec, sources };
}

async function read(input, ctx, connected = null, listed = null) {
  const name = input.extension;
  if (!name) return refusal('EXTENSION_REQUIRED', 'read needs extension (its exact name).', [problem('EXTENSION_REQUIRED', 'extension is required.', 'Pass extension: "<Name>".', { path: 'extension' })]);
  let reads;
  try { reads = connected ?? await ctx.reads(input.host); } catch (error) { return authRefusal(error); }
  let extensions;
  try { extensions = listed ?? await reads.extensions(); } catch (error) { return readFailure(error, 'the extensions could not be read'); }
  const variants = extensions.filter(r => fold(r.name) === fold(name));
  const exact = variants.filter(r => r.name === name);
  if (variants.length > 1 || (variants.length === 1 && !exact.length))
    return refusal('EXTENSION_AMBIGUOUS', `The environment has ${variants.length} extension(s) named like '${name}': ${variants.map(v => v.name).join(', ')}.`,
      [problem('EXTENSION_AMBIGUOUS', 'The name does not identify one extension.', 'Use the exact name of one of them.')], { candidates: variants.map(v => ({ name: v.name, key: v.key })) });
  if (!exact.length)
    return refusal('EXTENSION_NOT_FOUND', `No extension named ${name} in ${input.host}.`, [problem('EXTENSION_NOT_FOUND', `${name} is not an extension of this environment.`, 'Closest names: ' + (closest(name, extensions).join(', ') || 'none') + '.')]);
  const row = exact[0];
  const work = path.join(ctx.root, '.local', 'xif', 'read', input.host, name, ctx.now().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
  const file = path.join(work, name + '-v' + row.versionId + '.xif');
  try { await reads.download(row.key, row.versionId, file); } catch (error) { return readFailure(error, `the active version of ${name} could not be downloaded`); }
  const document = await kernel(ctx, ['read', '--xif', file, '--resources-out', path.join(work, 'resources')]);
  if (document.ok === false) return document;
  let consumers;
  try { consumers = consumerNames(await reads.consumers(row.key, ''), name); } catch { consumers = 'unknown'; }
  return { ok: true, extension: name, extensionKey: row.key, extensionId: row.id ?? null, versionId: row.versionId ?? null, xif: file, xifSha256: document.sha256,
    hash: document.hash, signatureHash: document.signatureHash, spec: document.spec, resources: document.resources, exported: document.exported, consumers,
    continuation: next(TOOL, { action: 'publish', host: input.host, spec: '<this spec, changed>', expectedVersionId: String(row.versionId ?? 'none'), words: '<the user\'s words naming ' + name + '>' }, 'edit the spec and publish in one call') };
}

// delete: the Service Center delete engine in two calls (CX15). Without confirmationToken: the preview of the extension
// (its consumers, the token; nothing sent). With it: the owner's words given after the preview, naming the extension and
// every consumer, with the count. The extension may be named again with the token only when the token lists it.
async function remove(input, ctx, extra = {}) {
  const name = input.extension;
  const token = typeof input.confirmationToken === 'string' && input.confirmationToken.trim() ? input.confirmationToken.trim() : null;
  if (!name && !token) return refusal('EXTENSION_REQUIRED', 'delete needs extension (its exact name).', [problem('EXTENSION_REQUIRED', 'extension is required.', 'Pass extension: "<Name>".', { path: 'extension' })]);
  // A standing grant never covers a delete: only the user's own words, given after the preview.
  const words = typeof input.words === 'string' && !placeholder(input.words) ? input.words : '';
  if (token && name && tokenNames(token, name, { root: ctx.destructiveRoot }) === false)
    return refusal('PREVIEW_OTHER_TARGET', `The confirmationToken does not list the extension ${name}; nothing was sent.`,
      [problem('PREVIEW_OTHER_TARGET', `The token's preview is of another target, not ${name}.`, `The token of a preview of ${name}, or a new preview.`)]);
  if (token && name && input.authorizationContext) {
    try { authorizationContext(input.authorizationContext,words,{lane:'o11',host:input.host,operation:'delete',targets:[name]}); }
    catch (error) { return refusal(error.code,error.message); }
  }
  const argv = ['delete', '--host=' + input.host, ...(token ? ['--confirmation-token=' + token] : ['--target=extension:' + name]), ...(words ? ['--words=' + words] : []),
    ...(input.ownerRequest ? ['--owner-request=' + input.ownerRequest] : []),
    ...(input.confirmHost ? ['--confirm-host=' + input.confirmHost] : []), ...(input.operationId ? ['--operation-id=' + input.operationId] : []),
    ...(token && input.authorizationContext ? ['--authorization-context=' + input.authorizationContext] : [])];
  let result;
  try { result = await ctx.serviceCenter(argv, { tool: TOOL, ...extra }); } catch (error) { return refusal('DELETE_FAILED', String(error?.message ?? error).slice(0, 300)); }
  if (!result || typeof result !== 'object') return refusal('DELETE_FAILED', 'The Service Center answered nothing.');
  return result.state === 'previewed' ? { ...result, continuation: next(TOOL, { action: 'delete', host: input.host, confirmationToken: result.confirmationToken,
    words: result.repeat?.words ?? "<the owner's reply after seeing this list>", ...(input.confirmHost ? { confirmHost: input.confirmHost } : {}) },
  // CX15 r3 (CT-7): an extension is deleted without a backup (.xif): next says it and so does this step.
  `show the owner this exact list${/WITHOUT a backup/.test(result.next ?? '') ? ' and what goes WITHOUT a backup (next)' : ''} and ask; the execution needs this token and the owner's reply, with the number of items`) } : result;
}

// deps: root, env, now, runAnvil (the O11 CLI runner), serviceCenter (runServiceCenter of service-center/index.mjs),
// reads(host) (default studioReads with deps.locate), grants, grantsFile, hostClass(host), publishConsumersOf, publishDeps.
export function createO11Extension(deps = {}) {
  const root = deps.root ?? anvilRoot;
  const ctx = {
    root, env: deps.env ?? process.env, now: deps.now ?? (() => new Date()), destructiveRoot: deps.destructiveRoot,
    runAnvil: deps.runAnvil ?? (async () => ({ ok: false, envelope: null, stderr: ['no O11 CLI runner'] })),
    serviceCenter: deps.serviceCenter ?? (async (argv, scDeps) => (await import('./service-center/index.mjs')).runServiceCenter(argv, scDeps ?? {})),
    reads: deps.reads ?? (host => studioReads(host, { locate: deps.locate, root, env: deps.env })),
    grants: deps.grants ?? standingGrants, grantsFile: deps.grantsFile,
    hostClass: deps.hostClass ?? (host => registeredHostClass(host)),
    publishConsumersOf: deps.publishConsumersOf ?? (async (request, publishDeps) => (await import('./o11-publish.mjs')).publishConsumersOf(request, publishDeps ?? {})),
    publishDeps: deps.publishDeps ?? {},
  };
  return async (input, extra = {}) => {
    const parsed = extensionSchema.safeParse(input ?? {});
    if (!parsed.success) return refusal('BAD_REQUEST', 'o11_extension arguments: ' + parsed.error.issues.map(i => i.path.join('.') + ': ' + i.message).join('; '));
    const value = parsed.data;
    if (value.action === 'read') return read(value, ctx);
    if (value.action === 'delete') return remove(value, ctx, extra);
    return publish(value, ctx);
  };
}

export function registerO11Extension(server, deps = {}) {
  const run = createO11Extension(deps);
  server.registerTool(TOOL, {
    title: 'O11 .NET extension without Integration Studio',
    description: '[o11] A .NET extension (XIF) of an O11 environment, built here and published through the connected Service Studio\'s own '
      + 'session; no Integration Studio login and no credential file. read {host, extension}: the current spec (structures, actions, '
      + 'parameter keys, bodies), versionId, signatureHash and consumers. Read also exports resources into a new private local folder: '
      + 'exported.resources has path, file, sha256, deploy and codeReference; exported.references gives the non-platform DLL paths for '
      + 'a new spec.references. Keep relevant license resources in spec.resources and let the spec check verify the dependency closure. '
      + 'For an end-to-end publication use referencesFrom:["ExistingExtension"]: it acquires that extension\'s library DLLs '
      + 'and license notices inside this call, with source versions and hashes in referenceSources. No manual DLL paths are needed. '
      + 'publish {host, spec, words}: one call creates or edits it (what the '
      + 'spec names is created or updated in place by name, keys kept; remove lists what goes); every problem comes back at once before '
      + 'anything is sent (XIF_SPEC_INVALID, XIF_COMPILE_FAILED, XIF_STUBS_REFUSED...). The answer is created, updated, already-running '
      + 'or uncertain (never sent again: the same call with the same operationId reconciles by reading). An edit that breaks consumers '
      + 'needs words naming each of them (EXTENSION_BREAKS_CONSUMERS); a standing grant covers additive publishes only. consumers:true '
      + 'authorizationContext binds verbatim human approval to an exact proposal: a new standalone fixture publication, or an exact-target deletion. '
      + 'then refreshes and publishes each consumer. delete {host, extension}: the preview (its consumers, a confirmationToken). ' + DESTRUCTIVE_SUFFIX
      + ' The execution, delete {host, confirmationToken, words}: the words name the extension and every consumer. '
      + 'Then reference it from a module with ssam_job (continuation) and o11_deliver/o11_publish.',
    inputSchema: extensionSchema, annotations,
  }, async (input, ctx) => {
    // CX15: the client's cancellation reaches the delete engine of delete (it stops before its next item).
    try { return reply(await run(input ?? {}, ctx?.mcpReq?.signal ? { signal: ctx.mcpReq.signal } : {})); }
    catch (error) { return reply(refusal('EXTENSION_ERROR', String(error?.message ?? error).slice(0, 400))); }
  });
}
