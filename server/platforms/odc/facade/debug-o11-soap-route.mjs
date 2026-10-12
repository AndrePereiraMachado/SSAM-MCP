import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { selectedO11DebugReader } from './debug-o11-reader.mjs';

// Qualified from OpenWebServiceDocumentation.InnerExecute in the installed
// 11.55.91.65258 SDK. A different SDK must qualify its original command first.
const SOURCE = 'ServiceStudio.Commands.WebServiceCommands.OpenWebServiceDocumentation';
const SDK_SHA256 = '3c9b480fdf8d8bb1b82320f653ebad540173b75e7925ce7f1387c4d3a3454653';
export function originalO11SoapDocumentationRoute(binding, service, { reader = selectedO11DebugReader() } = {}) {
  const fail = () => { throw new Error('debug_native_endpoint_soap_documentation_command_unqualified'); };
  if (binding.lane !== 'o11' || service.kind !== 'WebService' || !/^[A-Za-z_][A-Za-z0-9_]{0,198}$/.test(service.name ?? '') || !reader.runtimeDir) fail();
  const assemblyPath = path.join(reader.runtimeDir, 'ServiceStudio.BuiltInBehaviors.dll');
  let sha256; try { sha256 = createHash('sha256').update(fs.readFileSync(assemblyPath)).digest('hex'); } catch { fail(); }
  if (sha256 !== SDK_SHA256) fail();
  const base = new URL(binding.runtimeUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' + binding.module + '/') fail();
  return { url: base.origin + '/' + binding.module + '/' + service.name + '.asmx',
    source: SOURCE, assembly: { path: assemblyPath, sha256 }, readerGeneration: reader.generation };
}
