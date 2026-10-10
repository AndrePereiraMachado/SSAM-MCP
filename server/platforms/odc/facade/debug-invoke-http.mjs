import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { workspaceRoot } from './workspace.mjs';
import { at, fail, filterOutput } from './debug-invoke-contract.mjs';
import { openOdcAppUserSession, validatePrivateDescriptor, publicWrapperBody } from './debug-app-user-worker.mjs';
const helper = fileURLToPath(new URL('./debug-invoke-vault.ps1', import.meta.url));
export function privateRequest(mode, planId, value, inputFile) {
  if (!/^[a-f0-9-]{36}$/.test(planId)) fail('invoke_invalid_plan');
  if (!['Seal', 'Open', 'Forget', 'Import'].includes(mode)) fail('invoke_invalid_private_operation');
  if (inputFile) {
    const resolved = path.resolve(inputFile), relative = path.relative(workspaceRoot, resolved);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) fail('invoke_private_input_in_workspace');
  }
  return new Promise((resolve, reject) => {
    // Normal inline PowerShell command, with the helper's public code only. No execution-policy changes.
    const literal = s => "'" + s.replace(/'/g, "''") + "'";
    let command = '& {\n' + fs.readFileSync(helper, 'utf8') + '\n} -Mode ' + literal(mode) + ' -PlanId ' + literal(planId);
    if (inputFile) command += ' -InputFile ' + literal(path.resolve(inputFile));
    const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')];
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout.setEncoding('utf8');
    let bytes = '', settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(new Error('invoke_private_request_unavailable')) : resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish(true); }, 15000);
    child.once('error', () => finish(true)); child.stdin.on('error', () => {});
    child.stdout.on('data', b => { bytes += b; if (Buffer.byteLength(bytes) > 4194304) { child.kill(); finish(true); } });
    child.once('close', code => {
      try {
        const answer = JSON.parse(bytes);
        if (code === 0) finish(null, answer);
        else if (answer.error === 'invoke_private_request_unavailable' && /^[a-z]+$/.test(answer.phase) && /^[A-Za-z]+$/.test(answer.failureType)) {
          if (!settled) { settled = true; clearTimeout(timer); reject(new Error(answer.error + ':' + answer.phase + ':' + answer.failureType)); }
        } else finish(true);
      } catch { finish(true); }
    });
    child.stdin.end(value ? JSON.stringify(value) : '');
  });
}
export function checkNativeRequest(native, identity, origin) {
  if (native.url !== origin + identity.entryPath || native.method !== 'POST' || !native.body || typeof native.body !== 'object' || !native.headers || typeof native.headers !== 'object') fail('invoke_private_request_scope_mismatch');
  const url = new URL(native.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('invoke_private_request_scope_mismatch');
  for (const [name, value] of Object.entries(native.headers)) if (!/^(content-type|authorization|cookie|origin|referer|x-csrf-?token|x-requested-with|outsystems-csrftoken)$/i.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) fail('invoke_private_header_rejected');
  if (!Object.keys(native.headers).some(name => /^(authorization|cookie)$/i.test(name))) fail('invoke_application_authentication_required');
}
export async function loadDebugAppSession(sessionId, plan) {
  if (!/^[a-f0-9]{32}$/.test(sessionId ?? '')) fail('invoke_app_user_session_required');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(workspaceRoot, '.local', 'debugger', sessionId, 'manifest.json'), 'utf8')); }
  catch { fail('invoke_app_user_session_required'); }
  const descriptor = validatePrivateDescriptor(manifest.appUser), binding = descriptor.binding;
  const producer = plan.target ?? plan.identity;
  if (binding.lane !== 'odc' || binding.sessionId !== sessionId || binding.moduleKey !== producer.moduleKey ||
      new URL(binding.runtimeUrl).origin !== plan.origin || !plan.identity.entryPath.startsWith('/' + binding.app + '/screenservices/')) fail('invoke_app_user_scope_mismatch');
  return openOdcAppUserSession(descriptor);
}

export function appSessionHeaders(native, plan, sessionId, session) {
  const binding = session?.binding, producer = plan.target ?? plan.identity;
  if (!binding || binding.lane !== 'odc' || binding.sessionId !== sessionId || binding.moduleKey !== producer.moduleKey || new URL(binding.runtimeUrl).origin !== plan.origin ||
      !plan.identity.entryPath.startsWith('/' + binding.app + '/screenservices/') || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now() ||
      typeof session.accessToken !== 'string' || !session.accessToken || /[\x00-\x1f\x7f]/.test(session.accessToken)) fail('invoke_app_user_scope_mismatch');
  // A captured envelope may belong to another login. Only the current session supplies identity; do not
  // carry its old cookies or CSRF values alongside the fresh native bearer.
  return { ...Object.fromEntries(Object.entries(native.headers).filter(([name]) => !/authorization|cookie|csrf/i.test(name))), Authorization: 'Bearer ' + session.accessToken };
}

export async function runHeadlessHttp(plan, request, { load = privateRequest, loadAppUser = loadDebugAppSession, fetchHttp = fetch } = {}) {
  let native, appSession, headers, body;
  try {
    native = await load('Open', plan.planId); checkNativeRequest(native, plan.identity, plan.origin);
    appSession = await loadAppUser(request.sessionId, plan);
    headers = appSessionHeaders(native, plan, request.sessionId, appSession);
    body = structuredClone(native.body);
    for (const [pointer, value] of Object.entries(request.inputs)) {
      const keys = pointer.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
      let owner = body; for (const key of keys.slice(0, -1)) owner = owner[key]; owner[keys.at(-1)] = value;
    }
  } catch (error) {
    return { state: 'not-sent', transport: 'headless-http', error: /^(?:invoke|debug_app_user)_[a-z_]+$/.test(error.message ?? '') ? error.message : 'invoke_app_user_authentication_required' };
  }
  const privateValues = [appSession.accessToken, appSession.idToken, appSession.refreshToken, ...Object.entries(native.headers).filter(([name]) => /authorization|cookie|csrf/i.test(name)).map(([, value]) => value)];
  const started = performance.now();
  let response;
  try {
    // A single send. Redirects are refused; authentication cannot leave the recorded application origin.
    response = await fetchHttp(native.url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(request.timeoutSeconds * 1000) });
    let text = '', size = 0; const reader = response.body.getReader(), decoder = new TextDecoder();
    while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 4194304) { await reader.cancel(); fail('invoke_response_limit'); } text += decoder.decode(chunk.value, { stream: true }); }
    text += decoder.decode();
    let data; try { data = JSON.parse(text); } catch { /* No raw HTML/login/error page output. */ }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { state: 'invalid-response', transport: 'headless-http', httpStatus: response.status,
      isJson: data !== undefined, error: 'invoke_invalid_response', outputs: {}, elapsedMs: Math.round(performance.now() - started) };
    const outputs = {};
    for (const pointer of request.outputPaths.length ? request.outputPaths : plan.outputPaths) {
      try { outputs[pointer] = filterOutput(at(data, pointer), pointer.split('/').at(-1)); } catch { outputs[pointer] = '[unavailable]'; }
    }
    const success = data?.data?.Success ?? data?.data?.success ?? data?.Success ?? data?.success;
    return { state: 'completed', transport: 'headless-http', httpStatus: response.status, isJson: data !== undefined, appUser: { userKey: appSession.userKey, source: 'session-sign-in' },
      businessSuccess: data?.exception ? false : typeof success === 'boolean' ? success : null,
      responseKeys: data && typeof data === 'object' ? Object.keys(publicWrapperBody(data, privateValues)).slice(0, 50) : [],
      outputs: publicWrapperBody(outputs, privateValues), exception: publicWrapperBody(filterOutput(data?.exception ?? null), privateValues), elapsedMs: Math.round(performance.now() - started) };
  } catch { return { state: 'uncertain', transport: 'headless-http', httpStatus: response?.status ?? null, error: 'invoke_request_outcome_uncertain' }; }
  finally { for (const name of Object.keys(headers)) headers[name] = ''; privateValues.fill(''); }
}
