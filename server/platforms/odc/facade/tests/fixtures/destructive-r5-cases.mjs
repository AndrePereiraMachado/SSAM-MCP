// CX15 r5: the validation refusals of the reviewer's probe (C:\t\revisoes\cx15-4\verify-0\probe-v0.mjs: C1-C4, E1-E6, D1-D3),
// with the owner's words W in every place a refusal used to echo them. Used by the N-1 test and the family test.
const U = '00000000-0000-4000-8000-000000000001';
export const N1_CASES = (oml, W) => ({
  C1_o11_data_batch_op_authorization: ['o11_data', { module: 'ZZMod', oml, request: { batch: [{ step: 's1', operation: 'insert', entity: 'ZZEnt', records: [{ Name: 'x' }], authorization: W }] } }],
  C1b_o11_data_batch_level_authorization: ['o11_data', { module: 'ZZMod', oml, request: { authorization: W, batch: [{ step: 's1', operation: 'insert', entity: 'ZZEnt', records: [{ Name: 'x' }] }] } }],
  C2_o11_data_delete_ownerRequest: ['o11_data', { module: 'ZZMod', oml, request: { operation: 'delete', entity: 'ZZEnt', ids: ['1'], ownerRequest: W } }],
  C3_odc_asset_delete_ownerRequest: ['odc_asset_delete', { tenant: 'personal-zzv0.outsystems.dev', assetKey: 12345, ownerRequest: W }],
  C3b_odc_asset_delete_authorize: ['odc_asset_delete', { tenant: 'personal-zzv0.outsystems.dev', assetKey: 12345, authorize: W, confirmationToken: 'zz-token', operationUuid: U }],
  C4_odc_receipt_reconcile_authorize: ['odc_receipt', { operationUuid: 'not-a-uuid', reconcile: { state: 'confirmed', read: { operationId: 'zzRead' }, authorize: W } }],
  E1_o11_env_update_app_nothing: ['o11_environment', { action: 'update-app', app: 'ZZApp', authorize: W }],
  E2_o11_env_create_app_missing_name: ['o11_environment', { action: 'create-app', modules: [{ name: 'ZZApp_CS', kind: 'Service' }], authorize: W }],
  E3_o11_env_create_module_bad_name: ['o11_environment', { action: 'create-module', app: 'ZZApp', name: '1bad', kind: 'Service', authorize: W }],
  E4_studio_create_app_trailing_space: ['studio_create_app', { action: 'create', name: 'ZZApp ', kind: 'reactive', tenant: 'personal-zzv0.outsystems.dev', authorize: W }],
  E5_studio_create_app_relative_icon: ['studio_create_app', { action: 'create', name: 'ZZApp', kind: 'reactive', icon: 'icon.png', tenant: 'personal-zzv0.outsystems.dev', authorize: W }],
  E6_o11_env_delete_app_token_bad_app: ['o11_environment', { action: 'delete-app', confirmationToken: 'zz-token', app: '--bad', authorize: W }],
  E6b_o11_env_delete_app_token_blank_host: ['o11_environment', { action: 'delete-app', confirmationToken: 'zz-token', app: 'ZZApp', host: ' ', authorize: W }],
  E6c_o11_env_delete_app_preview_ownerRequest: ['o11_environment', { action: 'delete-app', app: '--bad', ownerRequest: W }],
  D1_o11_data_many_problems: ['o11_data', { module: 1, oml: 2, request: { batch: [{ step: 's1', operation: 'insert', entity: 3, records: [{ Name: 'x' }], authorization: W }, { step: 's2', operation: 'zap', entity: 4 }] } }],
  D2_odc_receipt_two_problems: ['odc_receipt', { operationUuid: 'not-a-uuid', reconcile: { state: 'zz', read: { operationId: 'zzRead' }, authorize: W } }],
  D3_odc_asset_delete_many_problems: ['odc_asset_delete', { tenant: 7, assetKey: 12345, auth: 'zz', operationUuid: 'nope', ownerRequest: W }],
});
// CX15 r6 (M-2): the studio_command forms of the review (C:\t\revisoes\cx15-5\verify-1\probe\repro-m2.mjs), with the words W.
export const M2_CASES = (manifest, W) => ({
  'R1 args as one text (authorize)': { command: 'authorize', args: `${manifest} publish ${W}` },
  'R2 pid "studio" (authorize args)': { command: 'authorize', args: [manifest, 'publish', W], pid: 'studio' },
  'R3 a number in args (data-insert --authorize)': { command: 'data-insert', args: ['SynthOrders', 'SynthCustomer', '--records-file', 'r.json', '--authorize', W, 3] },
  'R4 empty command (words in args)': { command: '', args: ['data-insert', 'SynthOrders', 'SynthCustomer', '--authorize', W] },
  'R5 words in command text, pid "x"': { command: 'data-update SynthOrders SynthCustomer --records-file r.json --authorize ' + W, pid: 'x' },
  'R6 --authorize=<words>, unknown field': { command: 'data-insert', args: ['SynthOrders', 'SynthCustomer', '--authorize=' + W], module: 'SynthApp' },
  'R7 long line (inline records ~12 KB), pid "studio"': { command: 'data-insert', args: ['SynthOrders', 'SynthCustomer', '--records',
    JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ Name: 'Synth customer ' + i, City: 'Synthville', Code: 'SC' + i }))), '--authorize', W], pid: 'studio' },
});
