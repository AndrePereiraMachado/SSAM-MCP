// Shared answers of the headless debugger tools (ssam_debug, ssam_debug_run, ssam_debug_invoke): the diagnostics rule
// their descriptions carry, and the structured refusals a failed sign-in becomes. A refusal names the user (masked), the
// identity provider, the environment and the exact next step instead of a bare private code; nothing ran when the
// sign-in failed, so the continuation repeats the same call once the user can sign in.

// Print-debugging in production data broke the AI answers of a live app (session dd2b79c0, 2026-10-05 00:50): the model
// wrote 'diag' rows into a business table and diagnostic text into a business output. The tools say so up front.
export const DIAGNOSTICS_RULE = 'Never write diagnostics into business tables or business outputs (no "diag" rows or marker records, '
  + 'no debug text in a business attribute or an output parameter): read the trace, the variables and the receipt (ssam_evidence) '
  + 'of this debugger and the Service Center error log instead.';

// The user typed in the private sign-in window, enough to tell which account it was and nothing more:
// app.user@example.com -> ap***r@example.com; Planner -> Pl***r; ab -> a***.
export function maskUser(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  const text = name.trim(), at = text.lastIndexOf('@');
  const local = at > 0 ? text.slice(0, at) : text, domain = at > 0 ? text.slice(at) : '';
  const masked = local.length <= 2 ? local.slice(0, 1) + '***' : local.slice(0, 2) + '***' + local.slice(-1);
  return (masked + domain).slice(0, 200);
}

// The private codes of an app-user sign-in that did not succeed (debug-app-user*.mjs, debug-o11-run.mjs,
// debug-o11-native-run.mjs), by reason.
const REASONS = {
  debug_app_user_authentication_rejected: 'rejected',
  debug_o11_native_login_rejected: 'rejected',
  debug_o11_run_native_entry_login_rejected: 'rejected',
  debug_app_user_challenge_required: 'challenge',
  debug_app_user_provider_unsupported: 'provider',
  debug_app_user_authentication_unavailable: 'unavailable',
  debug_app_user_authentication_failed: 'unavailable',
  debug_app_user_prompt_timeout: 'timeout',
};
export const SIGN_IN_FAILURES = Object.freeze(Object.keys(REASONS));

const appOf = runtimeUrl => {
  try { const url = new URL(runtimeUrl); return { host: url.hostname, app: url.pathname.split('/').filter(Boolean)[0] ?? null, origin: url.origin }; }
  catch { return { host: null, app: null, origin: null }; }
};

// The provider the sign-in went to: ODC apps sign in with the built-in provider only (debug-app-user-odc.mjs); O11 apps
// with the module's user provider (appDefinition userProviderName, "Users" unless the app has its own).
export function signInProvider(lane, userProvider = null) {
  if (lane === 'odc') return 'ODC built-in identity provider';
  return (userProvider || 'Users') + ' (O11 user provider of the app)';
}

// {ok:false, code:'DEBUG_APP_USER_SIGN_IN_FAILED', cause, user, provider, environment, app, next, continuation}.
// signIn: {lane, runtimeUrl, tenant?, userProvider?, user?}; repeat: the {tool, arguments} of the same call.
export function appUserSignInFailure(cause, signIn = {}, repeat = null) {
  const reason = REASONS[cause] ?? 'unavailable';
  const { host, app, origin } = appOf(signIn.runtimeUrl);
  const lane = signIn.lane === 'odc' ? 'odc' : 'o11';
  const provider = signIn.provider ?? signInProvider(lane, signIn.userProvider);
  const appUrl = origin && app ? origin + '/' + app + '/' : signIn.runtimeUrl ?? null;
  const environment = lane === 'odc' ? [host, signIn.tenant ? 'tenant ' + signIn.tenant : null].filter(Boolean).join(', ') || null : host;
  const user = typeof signIn.user === 'string' && signIn.user ? signIn.user : null;
  const who = user ? 'the app user ' + user : 'the app user typed in the App User Sign In window';
  const admin = lane === 'odc' ? 'the ODC Portal (Users)' : (signIn.userProvider && signIn.userProvider !== 'Users' ? 'the ' + signIn.userProvider + ' user provider'
    : 'the Users app' + (origin ? ' ' + origin + '/Users/' : ''));
  const repeatText = repeat?.tool ? 'repeat ' + repeat.tool + ' with the same arguments once' : 'repeat the same call once';
  const next = {
    rejected: `Sign in at ${appUrl ?? 'the app'} in a browser with that user. If it fails there too, reset its password in ${admin} or choose another end user with the app's roles; then ${repeatText} (the refused sign-in ran nothing).`,
    challenge: `The provider asks this user for one more step (a new password or MFA): complete it once at ${appUrl ?? 'the app'} in a browser, then ${repeatText}.`,
    provider: `This app signs in through another identity provider; the debugger signs in only with ${signInProvider(lane)}. Use an end user of that provider, or start ssam_debug op=watch and use the app yourself.`,
    unavailable: `The identity provider did not answer the sign-in (network or provider error). Check that ${appUrl ?? 'the app'} opens, then ${repeatText}.`,
    timeout: `Nobody typed the credentials in the App User Sign In window within 5 minutes; ${repeatText} and type them in that window.`,
  }[reason];
  const error = `${who} could not sign in to ${app ?? 'the app'} on ${environment ?? 'the environment'} (${provider}): ` + {
    rejected: 'the provider rejected the user name or password',
    challenge: 'the provider asked for an extra step (new password or MFA)',
    provider: 'the app uses an identity provider the debugger does not sign in with',
    unavailable: 'the identity provider did not answer',
    timeout: 'the sign-in window closed without credentials',
  }[reason];
  return { ok: false, code: 'DEBUG_APP_USER_SIGN_IN_FAILED', error, cause, user, provider, environment, app, ...(appUrl ? { appUrl } : {}), next,
    ...(repeat?.tool && reason !== 'provider' ? { continuation: { tool: repeat.tool, arguments: repeat.arguments ?? {}, why: 'the refused sign-in ran nothing; repeat once the user can sign in' } } : {}) };
}

// An Error thrown by a sign-in carries its private code as message and, when known, signIn {lane, runtimeUrl, user...}.
export function signInFailureOf(error, fallback = {}, repeat = null) {
  const cause = /^[a-z0-9_]+/.exec(error?.message ?? '')?.[0];
  if (!cause || !Object.hasOwn(REASONS, cause)) return null;
  return appUserSignInFailure(cause, { ...fallback, ...(error.signIn ?? {}) }, repeat);
}

// A tool answer {ok:false, error:<private code>, ...} keeps its own fields (sessionId, receiptPath, report state...) and
// gains the structured sign-in failure when its code is one; any other answer passes unchanged.
export function withSignInFailure(result, signIn = {}, repeat = null) {
  if (!result || typeof result !== 'object' || result.ok !== false || !Object.hasOwn(REASONS, result.error ?? '')) return result;
  const user = typeof result.signInUser === 'string' ? result.signInUser : undefined;
  const { error: cause, signInUser, ...rest } = result;
  const failure = appUserSignInFailure(cause, { ...signIn, ...(user ? { user } : {}) }, repeat);
  return { ...rest, ...failure };
}

// O11 start without native SSO (o11Auth), without a developer credentials file and without SSAM_O11_* signs the debugger
// in with nothing: the native worker answered only debug_native_error (InvalidOperationException) after the app user had
// typed the credentials (session dd2b79c0, 2026-10-05 02:15). Refused before the window opens, with the exact next step.
export function legacyDeveloperAuth(env = process.env) {
  return ['SSAM_O11_HOST', 'SSAM_O11_USERNAME', 'SSAM_O11_PASSWORD'].every(name => typeof env[name] === 'string' && env[name] !== '');
}
export function developerAuthRequired(input) {
  const { host } = appOf(input.runtimeUrl);
  return { ok: false, code: 'DEBUG_DEVELOPER_AUTH_REQUIRED', error: 'The O11 debugger signs in through the connected Studio (native SSO) with o11Auth '
    + '{applicationKey, publishedVersionId, publishedProof}; this start has neither o11Auth nor legacy developer credentials, so nothing was started '
    + 'and no sign-in window opened.', environment: host, module: input.module,
  next: 'Run ssam_debug_run with lane o11 and execution native-entry for the action to debug: it signs the app user in, takes the published proof of '
      + input.module + ' itself and traces the server (trace nodes or full). To keep ssam_debug start, pass o11Auth from the tracePlan.server '
      + 'of ssam_debug_run op=prepare (applicationKey, publishedVersionId, publishedProof).',
  continuation: { tool: 'ssam_debug_run', arguments: { op: 'prepare', lane: 'o11', execution: 'native-entry', host, module: input.module, moduleKey: input.moduleKey,
    applicationKey: '<application key of ' + input.module + '>', runtimeUrl: input.runtimeUrl, action: '<the action to debug>', trace: 'nodes' },
  why: 'native-entry gets the Studio SSO and the published proof in the same flow' } };
}

// Codes the native worker (kernel/debug) gives a failed start, with the code of the answer and what the person does next.
export const NATIVE_FAILURES = Object.freeze({
  debug_developer_credentials_required: ['DEBUG_DEVELOPER_AUTH_REQUIRED',
    'no developer login: pass o11Auth (native SSO through the connected Studio) or use ssam_debug_run execution=native-entry'],
  debug_credential_target_mismatch: ['DEBUG_DEVELOPER_AUTH_REQUIRED', 'the developer credentials belong to another environment than the runtime URL'],
  debug_authentication_failed: ['DEBUG_DEVELOPER_SIGN_IN_FAILED',
    'Service Center refused the developer login of the debugger; check the developer user and password of that environment'],
  debug_native_error: ['DEBUG_NATIVE_ERROR', 'the native debugger failed without a classified cause; read its receipt (ssam_evidence) before another start'],
});

// A native start answer {ok:false, error, receiptPath?} gains code, next and, when there is a receipt, its ssam_evidence read.
export function nativeFailure(result, input = {}) {
  if (!result || typeof result !== 'object' || result.ok !== false || !Object.hasOwn(NATIVE_FAILURES, result.error ?? '')) return result;
  const [code, next] = NATIVE_FAILURES[result.error];
  const { host } = appOf(input.runtimeUrl);
  return { ...result, code, cause: result.error, ...(host ? { environment: host } : {}), next,
    ...(result.receiptPath ? { continuation: { tool: 'ssam_evidence', arguments: { file: result.receiptPath }, why: 'the receipt keeps the final state of the native session' } } : {}) };
}
