import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fail } from './errors.mjs';
import { DEFAULT_PORTAL_ORIGIN } from './default-origin.mjs';

const run = promisify(execFile);
export const apiClientCredentialHelper = fileURLToPath(new URL('./windows-api-client-credential.ps1', import.meta.url));
const bundledPowerShell = path.resolve(path.dirname(process.execPath), '../../native/powershell/pwsh.exe');
export const apiClientPowerShell = existsSync(bundledPowerShell) ? bundledPowerShell : 'pwsh.exe';

// origin selects the tenant's Credential Manager entry (SSAM/ODC3/<host>/APIClient); the default is the entry of the
// corporate tenant of tenants.json (default-origin.mjs), the one the host used before tenants were parameterized.
export async function windowsApiClientCredential(mode, origin = DEFAULT_PORTAL_ORIGIN) {
  if (process.platform !== 'win32') return { available: false, target: 'odc3-api-client' };
  try {
    const { stdout } = await run(apiClientPowerShell,
      ['-NoProfile', '-NonInteractive', '-File', apiClientCredentialHelper, '-Mode', mode, '-Origin', origin],
      { windowsHide: true, timeout: 15000, maxBuffer: 12000 });
    return JSON.parse(stdout.replace(/^\uFEFF/, ''));
  } catch {
    fail('API_CLIENT_VAULT_UNAVAILABLE', 'The ODC3 API Client credential store could not be accessed.');
  }
}

// Status only: neither secret nor client identity is marshalled to stdout.
export async function windowsApiClientFixtureStatus(host,operationUuid){
 if(process.platform!=='win32')fail('API_CLIENT_VAULT_UNAVAILABLE','Fixture vault status requires the managed Windows host.');
 if(!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host??'')||!host.includes('.')
  ||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationUuid??''))fail('INPUT_INVALID','Exact host and canonical fixture operation UUID are required.');
 try{
  const {stdout}=await run(apiClientPowerShell,['-NoProfile','-NonInteractive','-File',apiClientCredentialHelper,'-Mode','status','-Origin','https://'+host,'-FixtureOperationUuid',operationUuid],
   {windowsHide:true,timeout:15000,maxBuffer:2000});
  const value=JSON.parse(stdout.replace(/^\uFEFF/,''));
  const entry='SSAM/ODC3/'+host+'/APIClientFixture/'+operationUuid;
  if(typeof value.available!=='boolean'||value.target!=='odc3-api-client-fixture'||value.fixtureOperationUuid!==operationUuid||value.entry!==entry)throw new Error();
  return {available:value.available,target:entry,operationUuid};
 }catch{fail('API_CLIENT_VAULT_UNAVAILABLE','The exact fixture credential presence could not be verified. No private value was exposed.');}
}

export async function resolvePublicApiEnvironment(env = process.env, credentialProvider = windowsApiClientCredential) {
  const configuredId = typeof env.ODC_CLIENT_ID === 'string' && env.ODC_CLIENT_ID.length > 0;
  const configuredSecret = typeof env.ODC_CLIENT_SECRET === 'string' && env.ODC_CLIENT_SECRET.length > 0;
  if (configuredId !== configuredSecret) fail('CONFIGURATION_INVALID', 'ODC API Client configuration is incomplete.');
  if (configuredId) return { ...env };
  const status = await credentialProvider('status');
  if (status?.available !== true) return { ...env };
  const credential = await credentialProvider('read');
  if (credential?.available !== true || typeof credential.clientId !== 'string' || !credential.clientId
    || typeof credential.clientSecret !== 'string' || !credential.clientSecret) {
    fail('API_CLIENT_VAULT_INCOMPLETE', 'The stored ODC3 API Client credential is incomplete.');
  }
  return { ...env, ODC_CLIENT_ID: credential.clientId, ODC_CLIENT_SECRET: credential.clientSecret };
}
