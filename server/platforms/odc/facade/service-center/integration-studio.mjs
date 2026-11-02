// The environment reads of o11_extension through the connected Service Studio (contract I2 of
// docs/INTEGRACOES-GITSSAM.md): the Studio's own login (SSO included), never a credential file and never a prompt.
// - soap (ServiceStudio.asmx): ListExtensions, ListEspaces, DownloadExtension, GetConsumers;
// - integration-studio (IntegrationStudio.asmx, READ ONLY in the bridge): Handshake, GenerateSourceCodeStubs,
//   GetSourceCodeDependencies, UploadNeeded.
// Nothing here writes: the publication and the delete go through runServiceCenter (contract I1). Only exports that already
// exist are used (Resolver of auth.mjs, locateStudioBridge, field and items of studio-api.mjs).
import { Resolver, studioRunning } from './auth.mjs';
import { locateStudioBridge } from './bridge.mjs';
import { field, items } from './studio-api.mjs';
import { hostName } from './http.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { currentExecutor } from '../executor.mjs';
import { createHash } from 'node:crypto';

// F4 (PLANO-11H): hosted, a file of the environment comes back in the reply (base64, as the bridge answers without outFile:
// the agent and the hosted gate never take an outFile, o11-stage.mjs) and is written here, in the account's workspace, at the
// path the caller named; the answer keeps the shape of the local one ({bytes, sha256, meta, file}).
// F4 review M3: what a hosted server really takes inline. The agent's value is at most 16 MiB (agent.mjs MAX_VALUE_BYTES)
// and base64 adds a third, so about 12 MiB of file; the bridge's own limit (16 MiB before base64) is never the one reached.
export const HOSTED_INLINE_BYTES = 12 * 1024 * 1024;
export const HOSTED_FILE_TOO_LARGE = 'HOSTED_FILE_TOO_LARGE';
const tooLarge = operation => Object.assign(new Error(`The ${operation} answer of the environment is larger than a hosted SSAM server takes in one reply (about 12 MiB), so nothing was built or sent. `
  + 'Build this extension with an SSAM installed on the user\'s own Windows machine, where o11_extension has no such limit, or make it carry smaller libraries.'), { code: HOSTED_FILE_TOO_LARGE });
export async function binaryRead(call, surface, operation, args, outFile, { hosted = currentExecutor().hosted === true } = {}) {
  if (!hosted) return call(surface, operation, { ...args, outFile });
  let result;
  // Above the limit the bridge asks for args.outFile and the agent answers VALUE_TOO_LARGE: neither is a path here.
  try { result = await call(surface, operation, args); }
  catch (error) { if (error?.code === 'VALUE_TOO_LARGE' || /args\.outFile|VALUE_TOO_LARGE/.test(String(error?.message ?? ''))) throw tooLarge(operation); throw error; }
  if (!result || typeof result !== 'object') return result;
  if (typeof result.base64 !== 'string') { if (Number(result.bytes) > 0) throw tooLarge(operation); return result; }
  const { base64, ...rest } = result;
  const bytes = Buffer.from(base64, 'base64');
  // The sha256 the bridge computed over the bytes it read: what was written here must be those bytes.
  if (typeof result.sha256 === 'string' && createHash('sha256').update(bytes).digest('hex') !== result.sha256.toLowerCase())
    throw Object.assign(new Error(`The ${operation} answer came back changed (its sha256 does not match); nothing was built or sent.`), { code: 'HOSTED_FILE_CHANGED' });
  if (Number.isFinite(Number(result.bytes)) && Number(result.bytes) !== bytes.length)
    throw Object.assign(new Error(`The ${operation} answer came back incomplete; nothing was built or sent.`), { code: 'HOSTED_FILE_CHANGED' });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, bytes, { flag: 'wx' });
  return { ...rest, bytes: bytes.length, file: outFile };
}

export const SURFACE = 'integration-studio';
// The bridge manifest capability of the surface (written in Dispatch.cs by the restsoap lane, contract I3).
export const CAPABILITY = 'sc_api:integration-studio';
export const OPERATIONS = Object.freeze(['Handshake', 'GenerateSourceCodeStubs', 'GetSourceCodeDependencies', 'UploadNeeded', 'TranslateLogicalDatabaseToDbConnection']);

// A row of ListExtensions/ListEspaces: name, key, active version, id (the projection keeps the .NET member names).
export const row = r => ({ name: field(r, 'Name'), key: field(r, 'Key', 'SS_Key', 'ESpaceKey', 'ModuleKey', 'ExtensionKey'),
  versionId: field(r, 'Version_Id', 'VersionId', 'ExtensionVersionId'), id: field(r, 'Id', 'Extension_Id', 'ExtensionId', 'Espace_Id') });

// The reads of one environment. deps: locate (a bridge or null), root, env, running. Throws AuthRequired (with its
// continuation) when no signed-in Studio serves the host; never opens a prompt.
export async function studioReads(host, { locate, root, env, running } = {}) {
  host = hostName(host);
  const resolver = new Resolver(host, { session: 'studio', prompt: 'never', locate: locate ?? (() => locateStudioBridge({ root, env })),
    present: async () => false, running: running ?? (() => studioRunning()), opener: null });
  const auth = await resolver.resolve('api');
  const bridge = auth.bridge;
  const call = async (surface, operation, args) => (await bridge.api(host, surface, operation, args)).result ?? null;
  return {
    host, auth, bridge,
    capabilities: async () => bridge.capabilities(),
    extensions: async () => items(await call('soap', 'ListExtensions', {})).map(row),
    modules: async () => items(await call('soap', 'ListEspaces', {})).map(row),
    download: (extensionKey, versionId, outFile) => binaryRead(call, 'soap', 'DownloadExtension', { extensionKey, versionId }, outFile),
    consumers: (producerKey, elementKey = '') => call('soap', 'GetConsumers', { producerESpaceKey: producerKey, referenceableElementKey: elementKey }),
    handshake: (version, lastUpgradeVersion) => call(SURFACE, 'Handshake', { version, lastUpgradeVersion }),
    stubs: (file, outFile) => binaryRead(call, SURFACE, 'GenerateSourceCodeStubs', { file }, outFile),
    dependencies: outFile => binaryRead(call, SURFACE, 'GetSourceCodeDependencies', {}, outFile),
    uploadNeeded: (extensionKey, extensionHash) => call(SURFACE, 'UploadNeeded', { extensionKey, extensionHash }),
    databaseProvider: (extensionKey, logicalDatabase) => call(SURFACE, 'TranslateLogicalDatabaseToDbConnection', { extensionKey, logicalDatabase }),
  };
}
