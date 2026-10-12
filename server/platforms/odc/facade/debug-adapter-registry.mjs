// One registry of the debugger entry adapters of both lanes (req 17). Rows mirror
// the native dispatchers; tests/debug-adapter-registry.test.mjs scans
// debug-o11-native-run.mjs and debug-odc-native-run.mjs, so a new branch needs a
// row. Session admission and tool qualification text derive from these rows plus
// an evidence index of audit-file pins; nothing here is restated by hand elsewhere.
// interactive: true | false (refused, refusalCode) | 'excluded' | 'native-limit' | 'legacy'.
// dependsOn: keys of debug-foreign-pending.mjs (SC/Portal files the row needs at run time, port D7). While one is
// pending, an interactive row is 'unavailable': not admitted and described as such; it turns on when the file arrives.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pendingForeign } from './debug-foreign-pending.mjs';

const deep = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(deep); Object.freeze(value); } return value; };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HEX64 = /^[a-f0-9]{64}$/, PLACEHOLDER = /^(?:d{64}|e{64})$/;
export const INTERACTIVE = deep([true, false, 'excluded', 'native-limit', 'legacy']);
const row = (lane, adapter, label, runtime, entryKinds, contextModes, interactive, refusalCode, evidenceKeys, branches, extra = {}) =>
  ({ lane, adapter, label, runtime, entryKinds, contextModes, interactive, refusalCode, evidenceKeys, branches, ...extra });

const O11_BROKER = 'run:createO11NativeEntryBroker', O11_CHAIN = ['entry:server-stub', 'entry:data-action', 'entry:client-action', O11_BROKER];
const O11_SERVER_GATE = 'debug_o11_native_server_inspection_entry_required', ODC_SERVER_GATE = 'debug_odc_native_server_inspection_entry_required';
const LEGACY_REPLACEMENT = 'ssam_debug_server or ssam_debug_client (CLI: ssam debug server|client --stdio)';
const wrapper = lane => row(lane, 'rest-wrapper', "execution:'rest-wrapper'", 'server', ['server-action'], ['app-user'], 'legacy', null, [], [],
  { surface: 'ssam_debug_run', reason: 'one-shot wrapper publication, not interactive, live identity combination unproven; only for releasing or reconciling old leases', replacement: LEGACY_REPLACEMENT });

export const ADAPTERS = deep([
  // O11 (debug-o11-native-run.mjs: client gate ~499, server allow-list ~503-505, background ~513-665, traditional ~689, endpoints ~747)
  row('o11', 'client-action', 'client action', 'client', ['client-action'], ['app-user'], true, 'debug_o11_native_client_inspection_entry_required',
    ['o11-client-action-mcp', 'o11-client-action-cli'], ['entry:client-action', O11_BROKER]),
  row('o11', 'mounted-screen', 'mounted screen', 'client', ['screen'], ['app-user'], 'excluded', null, [], [],
    { absent: true, note: 'no O11 mounted dispatcher; run.lifecycle is outside the O11 run schema' }),
  row('o11', 'server-chain', 'server stub/DataAction chain', 'server', ['server-stub', 'data-action', 'client-action'], ['app-user'], true, O11_SERVER_GATE,
    ['o11-server-chain-mcp'], O11_CHAIN),
  row('o11', 'producer-consumer-group', 'producer/consumer group', 'server', ['server-stub', 'data-action', 'client-action', 'rest-method'], ['app-user'], true, O11_SERVER_GATE,
    ['o11-group-lifecycle-mcp', 'o11-group-provenance-mcp'], [...O11_CHAIN, 'entry:rest-method']),
  row('o11', 'service-chain', 'Service Action chain', 'server', ['rest-method', 'server-stub', 'data-action', 'client-action'], ['app-user'], true, O11_SERVER_GATE,
    ['o11-service-chain-mcp'], [...O11_CHAIN, 'entry:rest-method']),
  row('o11', 'rest-basic', 'REST Basic app-user', 'server', ['rest-method'], ['app-user'], true, 'debug_native_endpoint_context_explicit_required',
    ['o11-rest-basic-mcp', 'o11-rest-text-basic-mcp'], ['entry:rest-method']),
  row('o11', 'rest-anonymous', 'REST anonymous', 'server', ['rest-method'], ['anonymous'], true, 'debug_native_endpoint_context_explicit_required',
    ['o11-rest-anonymous-mcp'], ['entry:rest-method'], { note: 'cross-module anonymous trace refused: debug_native_endpoint_anonymous_cross_module_trace_unqualified' }),
  row('o11', 'rest-custom', 'REST Custom authentication', 'server', ['rest-method'], ['app-user'], false, 'debug_native_endpoint_custom_authentication_unqualified', [], ['entry:rest-method']),
  row('o11', 'soap-anonymous', 'SOAP anonymous', 'server', ['soap-method'], ['anonymous'], true, 'debug_native_endpoint_context_explicit_required',
    ['o11-soap-anonymous-mcp', 'o11-soap-settings-mcp'], ['entry:soap-method']),
  row('o11', 'native-background-timer', 'native-background Timer (original launcher)', 'server', ['timer-launch'], ['native-background'], true, O11_SERVER_GATE,
    ['o11-timer-mcp', 'o11-timer-cli'], ['run:runO11BptOriginalLaunch'], { requires: { launch: true, words: true } }),
  row('o11', 'bpt-original-launch', 'BPT original launch', 'server', ['process-launch'], ['native-background'], 'excluded', O11_SERVER_GATE, [], ['run:runO11BptOriginalLaunch']),
  row('o11', 'background-launch-plan', 'background launch plan (BPT process)', 'server', ['process-original-launch'], ['native-background'], false,
    'debug_native_background_bpt_original_launcher_contract_required', [], ['background:process-original-launch']),
  row('o11', 'timer-launch-plan', 'background launch plan (Timer wake)', 'server', ['timer-original-wake'], ['native-background'], false,
    'debug_native_background_timer_original_launcher_contract_required', [], ['background:timer-original-wake']),
  row('o11', 'native-background-direct', 'native-background direct Timer schedule', 'server', ['Timer', 'ServerAction'], ['native-background'], false, O11_SERVER_GATE,
    [], ['run:createNativeBackgroundAdapter']),
  row('o11', 'traditional-preparation', 'traditional Preparation', 'server', ['traditional-preparation'], ['app-user'], false, O11_SERVER_GATE, [], ['entry:traditional-preparation']),
  // Flip to qualified only after the LP-10 live proofs.
  row('o11', 'traditional-screen-action', 'traditional screen action postback', 'server', ['traditional-screen-action'], ['app-user'], false, O11_SERVER_GATE, [], ['entry:traditional-screen-action']),
  row('o11', 'native-background-run-now', 'native-background Timer (Service Center Run Now)', 'server', ['Timer'], ['native-background'], true, O11_SERVER_GATE, [],
    ['run:runO11TimerRunNowInteractive'], { requires: { words: true, trigger: 'service-center-run-now', launch: false } }),
  wrapper('o11'),
  // ODC (debug-odc-native-run.mjs: runNativeEntry ~206-239, endpoint/background adapters in prepareNativeEntry ~142-161)
  row('odc', 'client-action', 'client/screen action', 'client', ['ClientAction', 'ScreenAction'], ['app-user'], true, 'debug_odc_native_client_inspection_entry_required',
    ['odc-client-action-mcp', 'odc-client-action-cli'], ['run:runOdcNativeLive']),
  row('odc', 'mounted-screen', 'mounted default-route screen', 'client', ['screen'], ['app-user'], true, 'debug_odc_native_mount_runtime_required',
    ['odc-mount-mcp'], ['run:runOdcNativeMount'], { note: 'words and acknowledgeEffects are checked by the mount runner' }),
  row('odc', 'server-chain', 'server/DataAction chain', 'server', ['server-stub', 'data-action', 'screen-handler'], ['app-user'], true, ODC_SERVER_GATE,
    ['odc-server-chain-mcp', 'odc-server-chain-cli'], ['run:runOdcNativeLive']),
  row('odc', 'library-producer', 'Library producer frames', 'server', ['server-stub', 'data-action'], ['app-user'], true, ODC_SERVER_GATE,
    ['odc-library-producer-mcp'], ['run:runOdcNativeLive']),
  row('odc', 'service-producer', 'Service producer frames', 'server', ['server-stub', 'data-action'], ['app-user'], true, ODC_SERVER_GATE, [], ['run:runOdcNativeLive']),
  row('odc', 'rest-anonymous', 'REST anonymous', 'server', ['rest-method'], ['anonymous'], true, 'debug_native_endpoint_context_explicit_required',
    ['odc-rest-anonymous-mcp'], ['run:runOdcNativeEndpoint', 'adapter:rest-method']),
  row('odc', 'rest-basic', 'REST Basic', 'server', ['rest-method'], ['app-user'], false, 'debug_native_endpoint_basic_credentials_unavailable_after_odc_srp', [],
    ['run:runOdcNativeEndpoint', 'adapter:rest-method']),
  row('odc', 'rest-custom', 'REST Custom authentication', 'server', ['rest-method'], ['app-user'], false, 'debug_native_endpoint_custom_authentication_unqualified', [],
    ['run:runOdcNativeEndpoint', 'adapter:rest-method']),
  row('odc', 'timer-original-wake', 'Timer through an original Wake caller', 'server', ['timer'], ['native-background'], true, ODC_SERVER_GATE, [],
    ['adapter:timer-original-wake', 'run:runOdcTimerWake'], { requires: { launch: true, words: true, launchContextMode: 'app-user', launchInputs: 'empty', workflow: false },
      note: 'instance correlation: debug-odc-background-instance.mjs (read-only Portal developer session after the debugger stop)', dependsOn: ['timer-background'] }),
  row('odc', 'workflow-event', 'Workflow event', 'server', ['workflow-event'], ['native-background'], false, ODC_SERVER_GATE, [], ['adapter:workflow-event', 'run:runOdcWorkflowEvent'],
    { dependsOn: ['timer-background'] }),
  // Interactive inside ssam_debug_server with run.trigger 'portal-wake' (debug-odc-portal-wake-interactive.mjs); no live proof yet (LP-17).
  row('odc', 'portal-timer-wake', 'Portal Timer wake', 'server', ['timer'], ['native-background'], true, ODC_SERVER_GATE, [], ['trigger:odc-portal-timer-wake', 'run:runOdcNativeBackground'],
    { requires: { trigger: 'portal-wake', words: true, launch: false, workflow: false }, note: 'trace full; no launch, inputs, scenarios or context', dependsOn: ['timer-background'] }),
  row('odc', 'exposed-soap', 'exposed SOAP', 'server', ['soap-method'], [], 'native-limit', 'debug_native_endpoint_odc_exposed_soap_unavailable', [], ['adapter:soap-method'],
    { note: 'Consume/Expose SOAP are removed from the installed ODC DLLs; consumed SOAP runs through its original app caller' }),
  row('odc', 'ssam_debug_invoke', 'ssam_debug_invoke one-shot invocation', 'server', ['screenservices-entry'], ['app-user'], 'legacy', null, [], [],
    { surface: 'ssam_debug_invoke', reason: 'one-shot HTTP invocation, not interactive, live identity combination unproven', replacement: LEGACY_REPLACEMENT }),
  wrapper('odc'),
]);

// Runtime capabilities that are not entries (described with the same statuses).
const cap = (lane, runtime, capability, label, interactive, refusalCode, evidenceKeys, extra = {}) =>
  ({ lane, runtime, capability, label, interactive, refusalCode, evidenceKeys, ...extra });
const SUSPEND = 'DebuggerAdapterV3.SuspendAllThreads throws InvalidOperationException on the client side of the installed DLLs';
export const CAPABILITIES = deep([
  cap('o11', 'client', 'manualPause', 'manual pause (mode native-next-node, cooperative)', true, null, ['o11-client-action-mcp', 'o11-client-action-cli']),
  cap('o11', 'client', 'immediate-suspension', 'immediate JavaScript suspension', 'native-limit', null, [], { limit: SUSPEND }),
  cap('o11', 'client', 'private-read', 'client private-read', true, null, ['o11-client-private-mcp'], { limit: 'Integer client function boundary into a Library' }),
  cap('odc', 'client', 'manualPause', 'manual pause (mode native-next-node, cooperative)', true, null, ['odc-client-action-mcp', 'odc-client-action-cli']),
  cap('odc', 'client', 'immediate-suspension', 'immediate JavaScript suspension', 'native-limit', null, [], { limit: SUSPEND }),
  cap('odc', 'client', 'private-read', 'client private-read', true, null, ['odc-client-private-mcp'], { limit: 'private value observability and change detection unproved' }),
]);

// Seed evidence index: audit files under .local/debugger, pinned by file sha256.
// The R19 manifest may pass its own index with the same shape:
// { key: { lane, transport: 'mcp'|'cli', path (relative to .local/debugger), sha256, live?, operationId?, sessionId? } }.
const ev = (lane, transport, file, sha256, ids = {}) => ({ lane, transport, path: file, sha256, live: true, ...ids });
export const SEED_EVIDENCE = deep({
  'o11-client-action-mcp': ev('o11', 'mcp', 'client-pause-o11/audit.json', 'e1f59eca6a98f82930133038f3690eea8253587c09b0a197adc9a1ab9f3c91a3',
    { operationId: 'cf40f4f3-1499-4501-be76-0fe88b3262e5', sessionId: 'c8a2d1f2-9c25-40d4-8a87-c549f7b349ba' }),
  'o11-client-action-cli': ev('o11', 'cli', 'client-pause-o11/audit-cli.json', '3092c9613114eb81d76a590df2105b91bc548af8571404891c5d70c604857af2',
    { operationId: 'be4eacd5-c553-485f-bfcd-f5831ba0aacf', sessionId: '492dc669-6ef7-436f-89ff-e4990985f7e8' }),
  'o11-client-private-mcp': ev('o11', 'mcp', 'o11-client-private-boundary-proof/audit.json', '4a2ac6d65545a00014d2ed52f8e469a3e574a9fcffca15dcf5f68e50f9ef086e',
    { operationId: '62af18e9-6953-4d30-a49b-c7bfabeca966', sessionId: '273ca76a-1d4f-4b29-8239-790982717368' }),
  'o11-server-chain-mcp': ev('o11', 'mcp', 'item5-o11-data/audit.json', 'a39e4a9c14494b6175bbd58a0db1e9b182a1a78ff1f9e3d6033cc1950242b277',
    { sessionId: 'c351f9ff-4c68-408a-b399-429e23faaf25' }),
  'o11-group-lifecycle-mcp': ev('o11', 'mcp', 'o11-identity-group-current/audit-observed-threads.json', 'ee45fbc1d2b3945c848ca91d20326e54d072f569d67b250ab8c73e599c4134ae',
    { operationId: '47aabe66-6d0b-4d90-801c-2d536d18fdca', sessionId: '3e13c464-bbb1-404e-8155-92def2b0e5fe' }),
  'o11-group-provenance-mcp': ev('o11', 'mcp', 'o11-identity-group-current/audit-live-provenance.json', '93cb0129e53eb65360b3a1790fba46c6883d7b73b2fdc12cbf7c4c79ad897b1c',
    { operationId: 'deb2b28d-ceb1-4238-b413-b06448f4f599', sessionId: '13fe5cb5-2088-42ba-ab2c-7a75639afe27' }),
  'o11-service-chain-mcp': ev('o11', 'mcp', 'o11-boundary-20261009/audit-service-interactive.json', '1795098d708a465419ce63ae73dca31bc844a316c3d92da0660cdab47f149b2c',
    { sessionId: 'd513ee24-0a85-4635-9669-91481eb4063c' }),
  'o11-rest-basic-mcp': ev('o11', 'mcp', 'o11-rest-basic-proof/audit.json', '1880032b400e728540f071ae7f884c956083c916fd9af4e81ef5734eead1a9ab',
    { operationId: 'bd657f70-85ac-4949-8e2c-c77f6c3cdb9e', sessionId: '58fcfc7d-3ea3-455e-bb27-7d7acb620697' }),
  'o11-rest-text-basic-mcp': ev('o11', 'mcp', 'o11-rest-text-proof/audit.json', 'b4b92a97bc472b425f9d840780ad824c9538d1c9a77163bb72f17b855465f585',
    { operationId: '6b00d5ab-1121-41f3-92ec-967c4aad78bf', sessionId: 'f0316374-3659-4643-b9a0-5998324fff72' }),
  'o11-rest-anonymous-mcp': ev('o11', 'mcp', 'vault-app-proof-20261007/public-o11-rest-interactive-audit.json', '84d31bc777f485eb39587860c7ff9fd295bed6db9aebe5021f584ef67fa33da4',
    { operationId: '303cfcaf-3771-42e2-ba7b-32fc8c381cfb' }),
  'o11-soap-anonymous-mcp': ev('o11', 'mcp', 'vault-app-proof-20261007/public-o11-soap-interactive-audit.json', 'b519103778198aaa1c6e2aaa9a51606a945d022f7b56277cc744cf2cfffd4cf1',
    { operationId: '94fffe66-9cdc-459c-8fe1-d49f7939805f' }),
  'o11-soap-settings-mcp': ev('o11', 'mcp', 'o11-site-soap-proof/audit.json', '6001cbecdbd057995c231745f491061d9bf4bd19f0df6e4702537e08d71745e2',
    { operationId: 'f42ed88e-e6b6-4d1e-84d3-76e1015cc168', sessionId: 'feaad5ba-6aa6-4782-8e4c-7dbf2bce3aa2' }),
  'o11-timer-mcp': ev('o11', 'mcp', 'vault-app-proof-20261007/public-o11-timer-interactive-audit.json', '00e55fb263bafe5d6add19cc516f9244d120776604abce74883feb064730961b',
    { operationId: '34dd6d0e-5943-46f0-acdc-b46b4e52de5c' }),
  'o11-timer-cli': ev('o11', 'cli', 'item17-cli/manual-pause-audit.json', 'd0cd5e7064434b174825a7350d2acbdb085e37e00526b5f20c8721effd8afbb2',
    { operationId: '58a1481e-d005-4148-9345-cac071d10f16', sessionId: '588a24f9-26c8-4b27-abc2-6f5639fcff13' }),
  'odc-client-action-mcp': ev('odc', 'mcp', 'client-pause-odc/audit-authorized.json', 'b2209753380c15f149097cdcce476f56808df4a7958f5678cc569c5ccf49515a',
    { operationId: 'cb2f6e99-1093-41e2-b7c2-c59a5e29fb2e', sessionId: '272d5f67-5f51-48e2-9144-22c183b9ab47' }),
  'odc-client-action-cli': ev('odc', 'cli', 'client-pause-odc/audit-cli-v2.json', '41f0f9fff5a00b3e7bee9506dd01667bfd89b4a3d969301598ea56e9ff4038c4',
    { operationId: '51083929-7294-4f3d-a07a-ce1afc4fc604', sessionId: '5472f210-87dc-4e23-8167-baa757349722' }),
  'odc-client-private-mcp': ev('odc', 'mcp', 'item12-client-private/audit.json', '12da277323661e54f0758f01921b0de8e82b3f567c4450d7aec6c6cea3aab438',
    { operationId: '230dc03a-b389-4800-9dcb-171962f85632', sessionId: '6425f5f4-f1bd-4915-9b64-b633f2ae02c9' }),
  'odc-mount-mcp': ev('odc', 'mcp', 'client-pause-odc/mounted-lifecycle/live-mount-r3d/audit.json', '31f2439563a8a28ead3584d632fde8fff761af5596b87ad9e0b6816cd27e3bf1',
    { operationId: '92088a26-b29b-45cb-9257-cb99f51c4535', sessionId: '71af6779-e610-4242-af9a-6d6c326b5e8e' }),
  'odc-server-chain-mcp': ev('odc', 'mcp', 'vault-app-proof-20261007/public-server-frames-audit.json', 'c80e7c500fe561120177a222a93d2934f25121b16b522d06d4bf1242983001c4',
    { operationId: 'f8d9a276-512f-4d9f-b235-6ca49fa1f468' }),
  'odc-server-chain-cli': ev('odc', 'cli', 'item17-cli/server-odc-audit.json', '5b623168abcaa7760d584b5f3f257f29a00e3f6c0c3915dbbfbafd780e47cd36',
    { operationId: '3dd20df2-63f3-4dcd-9101-1bc2a121f291' }),
  'odc-library-producer-mcp': ev('odc', 'mcp', 'vault-app-proof-20261007/public-static-server-audit.json', 'ceb9cba14b255bd16573bee3a6f25d16b666f31a989f226935cf53e7915b16d8',
    { operationId: '460c155d-af2f-4cb3-ab96-11c710da6c40' }),
  'odc-rest-anonymous-mcp': ev('odc', 'mcp', 'new-o11-soap-20261009/audit-odc-v2.json', '3cb851a29fdd8a7641a955196fbffc42c788ffb9b3cfd537f14a32eb89268f1e',
    { sessionId: '5dba6a43-2b43-4f05-a3e1-86cf60e4de67' }),
});

// ---- static dispatcher scan (parity test and R19) ----------------------------------------------------------
export const DISPATCHERS = deep({ o11: 'debug-o11-native-run.mjs', odc: 'debug-odc-native-run.mjs' });
const IMPORTS = [
  [/const \{ ([^}]+) \} = await import\('\.\/[^']+'\)/g, m => m[1].split(',').map(s => s.trim()).filter(n => /^run[A-Z]|^create\w*Adapter$/.test(n)).map(n => 'run:' + n)],
  [/\(await import\('\.\/[^']+'\)\)\.(create\w*Broker)\b/g, m => ['run:' + m[1]]],
];
const PATTERNS = deep({
  o11: [
    [/\[((?:'[a-z-]+',?\s*)+)\]\.includes\(resolution\.entry\??\.entry\)/g, m => m[1].match(/[a-z-]+/g).map(k => 'entry:' + k)],
    [/resolution\.entry\??\.entry [!=]== '([a-z-]+)'/g, m => ['entry:' + m[1]]],
    [/kind: timerWake \? '([a-z-]+)' : '([a-z-]+)'/g, m => ['background:' + m[1], 'background:' + m[2]]],
    ...IMPORTS],
  odc: [
    [/adapter\??\.(kind|trigger) === '([a-z-]+)'/g, m => [(m[1] === 'kind' ? 'adapter:' : 'trigger:') + m[2]]],
    [/adapter = \{ kind: '([a-z-]+)'/g, m => ['adapter:' + m[1]]],
    ...IMPORTS],
});
export function dispatcherBranches(lane, source) {
  const found = new Set();
  for (const [pattern, ids] of PATTERNS[lane] ?? []) for (const match of source.matchAll(pattern)) ids(match).forEach(id => found.add(id));
  return [...found].sort();
}

// ---- session admission (serverSessionSchema / clientSessionSchema read these) -------------------------------
const MESSAGES = deep({
  server: 'server inspection requires native-entry trace:full; explicit anonymous context requires an original endpoint',
  client: 'client inspection needs an original native-entry run with trace:none' });
const satisfies = (requires = {}, run) => (!requires.launch || !!run.launch) && (!requires.words || !!run.words?.trim()) &&
  (!requires.launchContextMode || run.launch?.contextMode === requires.launchContextMode) &&
  (requires.launchInputs !== 'empty' || Object.keys(run.launch?.inputs ?? {}).length === 0) && (requires.workflow !== false || !run.workflow) &&
  (!requires.trigger || run.trigger === requires.trigger) && (requires.launch !== false || run.launch === undefined);
export function admissionRules(lane, runtime, rows = ADAPTERS) {
  if (!['o11', 'odc'].includes(lane) || !['client', 'server'].includes(runtime)) throw new Error('debug_adapter_registry_scope_invalid');
  const scoped = rows.filter(r => r.lane === lane && r.runtime === runtime), admitted = scoped.filter(r => r.interactive === true && !pendingForeign(r.dependsOn).length);
  const trace = runtime === 'server' ? 'full' : 'none', message = MESSAGES[runtime];
  const refuse = () => ({ ok: false, code: 'debug_' + runtime + '_session_run_not_admitted', message });
  const ok = matches => ({ ok: true, adapters: matches.map(r => r.adapter) });
  return deep({ lane, runtime, execution: 'native-entry', trace, message, contextModes: [...new Set(admitted.flatMap(r => r.contextModes))],
    adapters: admitted.map(r => ({ adapter: r.adapter, entryKinds: r.entryKinds, contextModes: r.contextModes, ...(r.requires ? { requires: r.requires } : {}) })),
    refusals: scoped.filter(r => !admitted.includes(r)).map(r => (r.interactive === true
      ? { adapter: r.adapter, interactive: 'unavailable', refusalCode: 'debug_adapter_dependency_pending', pendingDependencies: pendingForeign(r.dependsOn) }
      : { adapter: r.adapter, interactive: r.interactive, refusalCode: r.refusalCode })),
    admit(run) {
      if (!run || run.op !== 'run' || run.execution && run.execution !== 'native-entry' || run.trace && run.trace !== trace) return refuse();
      // Entry kinds resolve at run time; the client gate admits any context and the runner refuses non app-user entries.
      if (runtime === 'client') return ok(admitted);
      const mode = run.contextMode ?? 'app-user';
      if (mode === 'app-user') return ok(admitted.filter(r => r.contextModes.includes('app-user')));
      if (run.lane !== lane) return refuse(); // a non-default context needs the explicit lane
      const matches = admitted.filter(r => r.contextModes.includes(mode) && satisfies(r.requires, run));
      return matches.length ? ok(matches) : refuse();
    } });
}

// ---- qualification text (tool descriptions, docs, R19) ------------------------------------------------------
const usable = (entry, lane) => !!entry && entry.live !== false && ['mcp', 'cli'].includes(entry.transport) && HEX64.test(entry.sha256 ?? '') &&
  !PLACEHOLDER.test(entry.sha256) && (!entry.lane || entry.lane === lane) && typeof entry.path === 'string';
function status(r, evidenceIndex) {
  const evidence = r.evidenceKeys.filter(key => usable(evidenceIndex?.[key], r.lane)).map(key => ({ key, ...evidenceIndex[key] }));
  const transports = [...new Set(evidence.map(e => e.transport))].sort();
  const pending = r.interactive === true ? pendingForeign(r.dependsOn) : [];
  const state = r.interactive !== true ? (r.interactive === false ? 'not-interactive' : r.interactive) : pending.length ? 'unavailable'
    : transports.length === 2 ? 'live-mcp-cli' : transports[0] === 'mcp' ? 'live-mcp' : transports[0] === 'cli' ? 'live-cli' : 'pending';
  return { state, transports, evidence: evidence.map(e => ({ key: e.key, path: e.path, sha256: e.sha256, transport: e.transport })), ...(pending.length ? { pending } : {}) };
}
export function qualificationRows(lane, runtime, evidenceIndex = SEED_EVIDENCE, rows = ADAPTERS) {
  return rows.filter(r => r.lane === lane && (!runtime || r.runtime === runtime)).map(r => {
    const s = status(r, evidenceIndex);
    return { lane: r.lane, adapter: r.adapter, label: r.label, runtime: r.runtime, interactive: r.interactive, refusalCode: r.refusalCode,
      status: s.state, transports: s.transports, evidence: s.evidence, ...(r.absent ? { absent: true } : {}), ...(s.pending ? { pendingDependencies: s.pending } : {}) };
  });
}
const HEADINGS = deep([['live-mcp-cli', 'Live-qualified on MCP and CLI'], ['live-mcp', 'Live-qualified on MCP (CLI proof pending)'],
  ['live-cli', 'Live-qualified on CLI (MCP proof pending)'], ['pending', 'Implemented, live qualification pending'],
  ['not-interactive', 'Not interactive, refused with the code shown'], ['native-limit', 'Native limit'], ['excluded', 'Excluded, not claimed'],
  ['legacy', 'Legacy, not interactive and not counted'], ['unavailable', 'Unavailable in this build until the SC/Portal lane delivers its files']]);
const PHRASE = deep({ 'live-mcp-cli': 'live-qualified on MCP and CLI', 'live-mcp': 'live-qualified on MCP (CLI proof pending)',
  'live-cli': 'live-qualified on CLI (MCP proof pending)', pending: 'live qualification pending', 'native-limit': 'native limit', excluded: 'excluded',
  unavailable: 'unavailable in this build until the SC/Portal lane delivers its files' });
export function describeQualification(lane, runtime, evidenceIndex = SEED_EVIDENCE, rows = ADAPTERS, capabilities = CAPABILITIES) {
  const scoped = rows.filter(r => r.lane === lane && (!runtime || r.runtime === runtime));
  const label = r => r.label + (r.absent ? ' (absent)' : '') + (r.refusalCode && ['not-interactive', 'native-limit', 'excluded'].includes(status(r, evidenceIndex).state) ? ' (' + r.refusalCode + ')' : '')
    + (status(r, evidenceIndex).pending ? ' (pending: ' + status(r, evidenceIndex).pending.join(', ') + ')' : '');
  const out = [(lane === 'o11' ? 'O11' : 'ODC') + (runtime ? ' ' + runtime : '') + ' adapters (generated from debug-adapter-registry and its evidence index).'];
  for (const [state, heading] of HEADINGS) {
    const hits = scoped.filter(r => status(r, evidenceIndex).state === state);
    if (hits.length) out.push(heading + ': ' + hits.map(label).join('; ') + '.');
  }
  for (const c of capabilities.filter(c => c.lane === lane && (!runtime || c.runtime === runtime)))
    out.push('Capability ' + c.label + ': ' + PHRASE[status(c, evidenceIndex).state] + (c.limit ? ' (limit: ' + c.limit + ')' : '') + '.');
  return out.join(' ');
}
export function legacyNotice(adapter) {
  const r = ADAPTERS.find(x => x.adapter === adapter && x.interactive === 'legacy');
  if (!r) throw new Error('debug_adapter_registry_not_legacy');
  return 'LEGACY ' + r.label + ': ' + r.reason + '; not counted in the debugger matrix. Interactive debugging uses ' + r.replacement + '.';
}
// Prefix for every refusal of a legacy surface (ssam_debug_invoke schema, execution:'rest-wrapper' in debugRun).
export function legacyPrefix(adapter) {
  const r = ADAPTERS.find(x => x.adapter === adapter && x.interactive === 'legacy');
  if (!r) throw new Error('debug_adapter_registry_not_legacy');
  return 'legacy ' + (r.adapter === 'rest-wrapper' ? "execution:'rest-wrapper'" : r.adapter) + ' (not interactive): ';
}

// Read-only pin check of an evidence index against .local/debugger (R19 and the seed test).
export function verifyEvidence(index = SEED_EVIDENCE, { root } = {}) {
  const base = path.resolve(root, '.local', 'debugger');
  return Object.fromEntries(Object.entries(index).map(([key, entry]) => {
    const file = path.resolve(base, entry?.path ?? ''), relative = path.relative(base, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return [key, { ok: false, reason: 'outside-root' }];
    if (!HEX64.test(entry.sha256 ?? '') || PLACEHOLDER.test(entry.sha256)) return [key, { ok: false, reason: 'synthetic-or-invalid-pin' }];
    let actual; try { actual = sha(fs.readFileSync(file)); } catch { return [key, { ok: false, reason: 'missing' }]; }
    return [key, actual === entry.sha256 ? { ok: true } : { ok: false, reason: 'hash-mismatch', actual }];
  }));
}
