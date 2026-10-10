// User context for headless debugging on ODC, where server code cannot log a user in (the (System) Login is a client
// action). The target is copied (SSAMDebug_<Action>_AsUser) and, in the copy only, GetUserId() and Check<Role>Role()
// become inputs that the wrapper fills from the scenario. The default context is the developer's own ODC user with the
// application roles the platform really assigns to them in the stage (User Access Management API).

export const USER_INPUT = 'SSAMDebugUserId';
export const roleInput = role => 'SSAMDebugRole_' + role;
export const copyName = action => `SSAMDebug_${action}_AsUser`;
const ROLE_CALL = /\bCheck([A-Za-z_][A-Za-z0-9_]*)Role\(\s*((?:[^()]|\([^()]*\))*?)\s*\)/g;
const USER_CALL = /\bGetUserId\(\s*\)/g;
const EXPRESSION_PROPS = ['Condition', 'Value', 'Expression', 'ExceptionMessage', 'Message'];

// Text rewrite of one expression. Check<R>Role() -> SSAMDebugRole_<R>; Check<R>Role(u) -> (SSAMDebugRole_<R> and u = SSAMDebugUserId).
export function rewrite(text) {
  const roles = new Set();
  let out = text.replace(ROLE_CALL, (_, role, arg) => {
    roles.add(role);
    const user = arg.trim();
    return !user || /^GetUserId\(\s*\)$/.test(user) ? roleInput(role) : `(${roleInput(role)} and ${user} = ${USER_INPUT})`;
  });
  out = out.replace(USER_CALL, USER_INPUT);
  return { text: out, roles: [...roles], usesUser: out.includes(USER_INPUT), changed: out !== text };
}

// Every expression of an action tree (inspect, depth >= 3) that reads the user context, with its element key.
export function scan(tree) {
  const edits = [], roles = new Set(); let usesUser = false;
  const visit = node => {
    for (const prop of EXPRESSION_PROPS) {
      const text = node.properties?.[prop];
      if (typeof text !== 'string' || !text) continue;
      const r = rewrite(text);
      if (!r.changed) continue;
      edits.push({ key: node.key, kind: node.kind, label: node.label ?? '', prop, before: text, after: r.text });
      r.roles.forEach(x => roles.add(x)); usesUser ||= r.usesUser;
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const child of tree.children ?? []) visit(child);
  return { edits, roles: [...roles].sort(), usesUser, needed: edits.length > 0 };
}

// The copy holds the same expressions as the original: each edit is re-addressed to the copy's element whose text is
// identical (same kind, same property). An edit without exactly one match refuses the whole context.
export function rebind(originalScan, copyTree) {
  const candidates = [];
  const visit = node => {
    for (const prop of EXPRESSION_PROPS) if (typeof node.properties?.[prop] === 'string') candidates.push({ key: node.key, kind: node.kind, prop, text: node.properties[prop] });
    for (const child of node.children ?? []) visit(child);
  };
  for (const child of copyTree.children ?? []) visit(child);
  const used = new Set();
  return originalScan.edits.map(edit => {
    const match = candidates.filter(c => !used.has(c.key + '|' + c.prop) && c.kind === edit.kind && c.prop === edit.prop && c.text === edit.before);
    if (!match.length) throw new Error('debug_context_rebind_failed: ' + edit.kind + ' ' + edit.label);
    used.add(match[0].key + '|' + match[0].prop);
    return { ...edit, key: match[0].key };
  });
}

// Ops on the copy (already duplicated and renamed): context inputs, then the rewritten expressions by exact key.
export function copyOps(copyRef, scanned, edits, alias = '') {
  const ops = [];
  if (scanned.usesUser) ops.push(
    { op: 'create', parent: copyRef, type: 'IInputParameter', name: USER_INPUT, as: '$ctxUser' + alias },
    { op: 'set', target: '$ctxUser' + alias, prop: 'DataType', value: 'User Identifier' });
  scanned.roles.forEach((role, i) => ops.push(
    { op: 'create', parent: copyRef, type: 'IInputParameter', name: roleInput(role), as: `$ctxRole${alias}_${i}` },
    { op: 'set', target: `$ctxRole${alias}_${i}`, prop: 'DataType', value: 'Boolean' }));
  for (const e of edits) ops.push({ op: 'set', target: '@' + e.key, prop: e.prop, value: e.after });
  return ops;
}

// Wrapper inputs that carry the context into the copy (added to the request structure and passed to the call).
export function contextInputs(scanned, edits) {
  const list = [];
  if (scanned.usesUser) list.push({ name: USER_INPUT, jobType: 'User Identifier' });
  for (const role of scanned.roles) list.push({ name: roleInput(role), jobType: 'Boolean' });
  return list;
}

// Default context: the tenant's developer (studioAuthor) and the application roles the platform assigns to them in
// the stage. A scenario may name another user (email or key), or null for an anonymous call, and override roles.
export async function platformUser(portal, { email, key } = {}, { assetKey, environmentKey }) {
  let user;
  if (key) user = await portal.read('user-access-management-api-v1:get:/users/{key}', { path: { key } });
  else {
    const found = await portal.read('user-access-management-api-v1:get:/users', { query: { nameOrEmailContains: email, limit: 10 } });
    user = (found?.results ?? found ?? []).find(u => (u.email ?? '').toLowerCase() === String(email).toLowerCase());
  }
  if (!user?.key) throw new Error('debug_context_user_not_found: ' + (email ?? key));
  const assigned = await portal.read('user-access-management-api-v1:get:/users/{key}/application-roles', { path: { key: user.key }, query: { assetKey, environmentKey, limit: 100 } });
  const roles = Object.fromEntries((assigned?.results ?? assigned ?? []).filter(r => r.assetKey === assetKey && r.environmentKey === environmentKey).map(r => [r.name, true]));
  return { key: user.key, email: user.email, name: user.name, roles };
}

// Values the wrapper receives for one scenario: user key and one boolean per role the copy reads.
export function contextValues(scanned, user, override = {}) {
  const values = {};
  const who = override.user === null ? null : user;
  if (scanned.usesUser) values[USER_INPUT] = who?.key ?? '';
  for (const role of scanned.roles) values[roleInput(role)] = override.roles && role in override.roles ? !!override.roles[role] : !!who?.roles?.[role];
  return values;
}

// Resolve the whole batch before any action is invoked or a debugger is started. Missing identity/role reads
// must fail the batch: a screen's required roles are not evidence of the user's assigned roles.
export async function prepareScenarioContexts(scanned, scenarios, { defaultUser, loadUser }) {
  const users = new Map(), prepared = [];
  for (const scenario of scenarios) {
    if (!scanned) { prepared.push({ ...scenario, call: { body: scenario.inputs, as: null } }); continue; }
    let user = null;
    if (scenario.as?.user !== null) {
      const identity = scenario.as?.user ?? defaultUser;
      try {
        if (!users.has(identity)) users.set(identity, await loadUser(identity));
        user = users.get(identity);
        if (!user?.key) throw new Error('debug_context_unavailable');
      } catch {
        // Portal diagnostics can contain private transport details; expose only the context failure.
        throw new Error('debug_context_unavailable');
      }
    }
    const values = contextValues(scanned, user, scenario.as ?? {});
    prepared.push({ ...scenario, call: { body: { ...scenario.inputs, ...values }, as: {
      user: user ? (user.email ?? user.key) : null,
      roles: Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('SSAMDebugRole_')).map(([key, value]) => [key.slice(14), value])),
      ...(Object.keys(scenario.as?.roles ?? {}).length ? { simulated: true } : {}),
    } } });
  }
  return prepared;
}
