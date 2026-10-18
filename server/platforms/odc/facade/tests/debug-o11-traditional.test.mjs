import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { compileTraditionalPreparation, traditionalRequest, acquireTraditionalPreparation } from '../debug-o11-traditional.mjs';
import { originalTraditionalLoginForm, invokePrivateTraditional } from '../debug-o11-traditional-worker.mjs';
import { appUserBinding } from '../debug-app-user.mjs';

const native = JSON.parse(fs.readFileSync(new URL('./fixtures/debug-o11-traditional-native-reading.json', import.meta.url), 'utf8'));
const observed = JSON.parse(fs.readFileSync(new URL('./fixtures/debug-o11-traditional-form-observed.json', import.meta.url), 'utf8'));
const fixture = () => structuredClone(native.contract);
const hash = value => createHash('sha256').update(value).digest('hex');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const form = () => '<form method="post" action="Login.aspx">' + observed.forms[0].inputs.map(input =>
  '<input type="' + input.type + '" id="' + escape(input.id) + '" name="' + escape(input.name) + '" value="' +
  escape(input.type === 'hidden' ? 'synthetic-state' : input.label ?? '') + '">').join('') + '</form>';

test('Traditional native capture binds Preparation to its original screen and login User_Login', () => {
  const contract = fixture(), plan = compileTraditionalPreparation(contract);
  assert.equal(plan.entry.key, 'dEWwXGH7NkeApGZ+qJiYJQ.#Preparation');
  assert.equal(plan.entry.startNodeKey, 'Ve1jm59P106LICsn2yCOBA');
  assert.equal(plan.login.provider, 'Users'); assert.equal(plan.entry.roles[0].name, 'Registered');
  assert.equal(traditionalRequest(plan).url, contract.routes.urls.ContactsWeb);
  assert.throws(() => traditionalRequest(plan, { unknown: 1 }), /input_unknown/);
  contract.preparation.key = 'x'.repeat(22) + '.#Preparation';
  assert.throws(() => compileTraditionalPreparation(contract), /model_incomplete|model_binding_invalid/);
});

test('Observed O11 form uses OSVSTATE without EVENTVALIDATION and preserves original post controls', () => {
  const plan = compileTraditionalPreparation(fixture()), parsed = originalTraditionalLoginForm(form(), plan);
  assert.ok(parsed.fields.some(([name]) => name === '__OSVSTATE'));
  assert.ok(!parsed.fields.some(([name]) => name === '__EVENTVALIDATION'));
  assert.equal(parsed.username, observed.forms[0].inputs.find(i => i.type === 'text').name);
  assert.equal(parsed.submit[1], 'Log In');
  assert.throws(() => originalTraditionalLoginForm(form().replace('action="Login.aspx"', 'action="https://other.example/Login.aspx"'), plan), /form_route_changed/);
  assert.throws(() => originalTraditionalLoginForm(form().replaceAll('__OSVSTATE', '__OTHER'), plan), /form_state_unavailable/);
});

function invocation(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-traditional-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contract = fixture(), directory = path.join(root, '.local/debugger/operation'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'model.oml'); fs.writeFileSync(file, 'synthetic unit transport source');
  contract.binding.sourceSha256 = hash(fs.readFileSync(file)); contract.sourceContract = { path: file, sha256: contract.binding.sourceSha256 };
  const operationId = randomUUID(), sessionId = 'a'.repeat(32), binding = appUserBinding(contract.binding, sessionId);
  const lock = path.join(root, '.local/debugger/native-runs/o11', contract.binding.host, contract.binding.moduleKey + '.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, JSON.stringify({ operationId }));
  const descriptor = { credentialRef: randomUUID(), binding,
    expiresAt: new Date(Date.now() + 600000).toISOString(), state: 'credentials-entered' };
  const input = { root, directory, contract, operationId, scenarioId: 'scenario-0', timeoutSeconds: 5, context: 'app-user', descriptor, inputs: {} };
  const vault = async () => ({ ok: true, kind: 'credentials', binding, expiresAt: descriptor.expiresAt, username: 'fixture-user', password: 'fixture-password' });
  return { input, vault };
}

test('Traditional acquisition expands only owner parameters and original login controls, leaving layout getters outside its contract', async t => {
  const {input}=invocation(t), c=input.contract, reads=[], metadataReads=[];
  const proof=path.join(input.directory,'inventory.json');fs.writeFileSync(proof,JSON.stringify({host:c.binding.host}));
  const items=values=>({items:values,total:values.length,omitted:0});
  const owner={snapshot:c.sourceContract,target:c.binding,versionId:c.binding.revision,inventoryProof:{path:proof,sha256:hash(fs.readFileSync(proof))},readings:[c.loginAction]};
  const result=await acquireTraditionalPreparation({owner,entry:c.preparation,directory:input.directory,root:input.root},{
    lifecycle:{readTree:async(_base,selector)=>{reads.push(selector);const found=[c.preparation,...c.widgets].find(n=>'@'+n.key===selector);
      assert.ok(found,'layout must not be expanded: '+selector);return found;}},
    metadata:async selector=>{metadataReads.push(selector);const value=structuredClone(selector===c.screen.path?c.screen:c.login);
      value.propertyReferenceCollections={...value.propertyReferenceCollections,InputParameters:items([]),LocalVariables:items([]),Widgets:items(selector===c.login.path?c.widgets:[])};
      value.children=[];value.childrenOmitted=40;value.childrenTotal=40;return value;},
    routes:async()=>({screenRoutesSource:c.routes.source,screenRoutes:c.routes.urls,moduleIdentitySource:{source:'native-fixture'}})
  });
  assert.equal(result.plan.entry.key,c.preparation.key);assert.equal(metadataReads.length,2);
  assert.deepEqual(reads,['@'+c.preparation.key,...c.widgets.map(w=>'@'+w.key)]);
  assert.equal(result.contract.login.childrenProjection,'native-owner-input-and-local-parameters');
  assert.equal(result.contract.login.childrenOmitted,40,'omitted layout remains explicitly reported');
});

test('Traditional submits original login then one requested screen, with no automatic redirects or identity claims', async t => {
  const { input, vault } = invocation(t); const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options }); assert.equal(options.redirect, 'manual');
    if (requests.length === 1) return new Response(form(), { headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'OSSTATE=fixture; Secure; HttpOnly; Path=/HeadlessTrad_UI/' } });
    if (requests.length === 2) {
      const sent = new URLSearchParams(options.body); assert.equal([...sent.values()].includes('fixture-password'), true);
      return new Response('', { status: 302, headers: { Location: '/HeadlessTrad_UI/', 'Set-Cookie': 'OSAUTH=fixture; Secure; HttpOnly; Path=/HeadlessTrad_UI/' } });
    }
    assert.match(options.headers.Cookie, /OSAUTH=fixture/); return new Response('<html>screen</html>', { headers: { 'Content-Type': 'text/html' } });
  };
  const result = await invokePrivateTraditional(input, { vault, fetchImpl });
  assert.equal(result.ok, true); assert.equal(result.answered, true); assert.equal(result.memoryReferencesReleased, true);
  assert.equal(requests.length, 3); assert.equal(result.appUserIdentityProved, false); assert.equal(result.rolesProved, false);
  assert.equal(JSON.stringify(result).includes('fixture-password'), false);
  const replay = await invokePrivateTraditional(input, { vault, fetchImpl });
  assert.equal(replay.ok, false); assert.equal(requests.length, 3);
});

// ---- screen actions: original Button/Link postback, block Preparations ----
import { compileTraditionalScreenAction, compileTraditionalEntry, traditionalBlockPreparations } from '../debug-o11-traditional.mjs';
import { actionContract, button, link, block, k } from './fixtures/debug-o11-traditional-action-fixture.mjs';

test('Submit and Ajax Submit buttons resolve to their screen action; block Preparation keys are collected', () => {
  const submit = compileTraditionalScreenAction(actionContract());
  assert.equal(submit.schema, 'ssam-o11-traditional-entry/1');
  assert.equal(submit.screenAction.key, k('SaveAction')); assert.equal(submit.screenAction.method, 'Submit');
  assert.deepEqual(submit.screenAction.widget, { kind: 'ButtonWidget', key: k('SaveBtn'), name: 'SaveButton', label: 'Save' });
  assert.equal(submit.screenAction.methodSource, 'event.Method');
  assert.deepEqual(submit.preparations.map(p => [p.kind, p.key]), [['screen', 'dEWwXGH7NkeApGZ+qJiYJQ.#Preparation'], ['block', k('HeaderBlk') + '.#Preparation']]);
  assert.equal(submit.preparations[1].startNodeKey, k('HeaderStart'));
  assert.equal(submit.entry.url, actionContract().routes.urls.ContactsWeb, 'typed screen inputs still go through traditionalRequest');
  assert.equal(traditionalRequest(submit).method, 'GET');
  const ajax = compileTraditionalScreenAction(actionContract({ method: 'Ajax' }));
  assert.equal(ajax.screenAction.method, 'Ajax Submit'); assert.equal(ajax.screenAction.isCalledByAjax, true);
  const viaLink = compileTraditionalScreenAction(actionContract({ widgets: (screen, action) => [link(screen, action)] }));
  assert.equal(viaLink.screenAction.widget.kind, 'LinkWidget'); assert.equal(viaLink.screenAction.method, 'Submit');
  assert.equal(compileTraditionalEntry(actionContract()).screenAction.key, k('SaveAction'));
  assert.equal(compileTraditionalEntry(fixture()).screenAction, undefined);
  assert.deepEqual(traditionalBlockPreparations(actionContract()).map(p => p.blockKey), [k('HeaderBlk')]);
});

test('Navigate, external, ambiguous, unread or inconsistent methods are refused before any request', () => {
  assert.throws(() => compileTraditionalScreenAction(actionContract({ method: 'Navigate' })), /traditional_action_method_unsupported/);
  assert.throws(() => compileTraditionalScreenAction(actionContract({ destinationPath: 'Reference:Other/WebScreen:X/ScreenAction:Save' })), /traditional_action_destination_external/);
  assert.throws(() => compileTraditionalScreenAction(actionContract({ destinationPath: 'WebFlow:MainFlow/WebScreen:ContactDetailWeb/ScreenAction:Save' })), /traditional_action_destination_external/);
  assert.throws(() => compileTraditionalScreenAction(actionContract({ widgets: (screen, action) => [button(screen, action), button(screen, action, { id: 'SaveBtn2', name: 'SaveButton2' })] })), /traditional_action_widget_ambiguous/);
  assert.throws(() => compileTraditionalScreenAction(actionContract({ widgets: () => [] })), /traditional_action_widget_unresolved/);
  assert.throws(() => compileTraditionalScreenAction(actionContract({ method: 'Ajax', ajax: 'False' })), /traditional_action_method_inconsistent/);
  assert.throws(() => compileTraditionalScreenAction(actionContract({ method: null, ajax: 'True' })), /traditional_action_method_unread/);
  const inferred = compileTraditionalScreenAction(actionContract({ method: null, ajax: 'False' }));
  assert.equal(inferred.screenAction.method, 'Submit'); assert.equal(inferred.screenAction.methodSource, 'ScreenAction.IsCalledByAjax=False');
  const foreignBlock = actionContract({ blocks: screen => { const b = block(screen); b.preparation.key = k('Other') + '.#Preparation'; return [b]; } });
  assert.throws(() => compileTraditionalScreenAction(foreignBlock), /traditional_model_binding_invalid|traditional_model_incomplete/);
  const otherOwner = actionContract({ widgets: (screen, action) => [button(screen, action, { owner: { kind: 'WebScreen', name: 'X', key: k('Foreign'), path: 'WebFlow:X/WebScreen:X' } })] });
  assert.throws(() => compileTraditionalScreenAction(otherOwner), /traditional_action_widget_unresolved/);
});

import { acquireTraditionalScreenAction } from '../debug-o11-traditional.mjs';
test('screen-action acquisition reads only the action, Button/Link widgets and same-module blocks with their Preparations', async t => {
  const { input } = invocation(t), base = actionContract(), c = input.contract;
  Object.assign(base, { binding: c.binding, sourceContract: c.sourceContract });
  const proof = path.join(input.directory, 'inventory.json'); fs.writeFileSync(proof, JSON.stringify({ host: c.binding.host }));
  const items = values => ({ items: values, total: values.length, omitted: 0 }), ref = n => ({ kind: n.kind, key: n.key, name: n.name, path: n.path });
  const header = base.blocks[0], producer = structuredClone(header);
  producer.instance.key = k('ProducerInst'); producer.instance.propertyReferences.SourceBlock = { kind: 'WebBlock', key: k('OsuiBlk'), name: 'Card', path: 'Reference:OutSystemsUIWeb/WebBlockSignature:Card' };
  const nodes = [base.preparation, base.action, ...base.actionWidgets, ...c.widgets, header.instance, producer.instance, header.preparation];
  const reads = [], metadataReads = [];
  const owner = { snapshot: c.sourceContract, target: c.binding, versionId: c.binding.revision, inventoryProof: { path: proof, sha256: hash(fs.readFileSync(proof)) }, readings: [c.loginAction] };
  const result = await acquireTraditionalScreenAction({ owner, entry: { key: base.action.key, path: base.action.path }, directory: input.directory, root: input.root }, {
    lifecycle: { readTree: async (_base, selector) => { reads.push(selector); const found = nodes.find(n => '@' + n.key === selector); assert.ok(found, 'unexpected read ' + selector); return structuredClone(found); } },
    metadata: async selector => { metadataReads.push(selector);
      const value = structuredClone(selector === base.screen.path ? base.screen : selector === header.block.path ? header.block : c.login);
      value.propertyReferenceCollections = { ...value.propertyReferenceCollections, InputParameters: items([]), LocalVariables: items([]),
        Widgets: items(selector === base.screen.path ? [...base.actionWidgets, header.instance, producer.instance].map(ref) : selector === c.login.path ? c.widgets.map(ref) : []) };
      return value; },
    routes: async () => ({ screenRoutesSource: c.routes.source, screenRoutes: c.routes.urls, moduleIdentitySource: { source: 'native-fixture' } }) });
  assert.equal(result.plan.screenAction.key, base.action.key); assert.equal(result.contract.schema, 'ssam-o11-traditional-action-source/1');
  assert.deepEqual(result.plan.preparations.map(p => p.kind), ['screen', 'block']);
  assert.deepEqual(metadataReads, [base.screen.path, header.block.path, c.login.path]);
  assert.ok(!reads.includes('@' + k('OsuiBlk') + '.#Preparation'), 'producer block Preparation is never read');
  await assert.rejects(acquireTraditionalScreenAction({ owner, entry: { key: k('X'), path: 'WebFlow:Common/WebBlock:Header/ScreenAction:Toggle' }, directory: input.directory, root: input.root }, {}),
    /traditional_block_action_host_unresolved/);
});

test('Preparation acquisition reads same-module blocks rendered by the screen, nested ones included, never producer blocks', async t => {
  const { input } = invocation(t), c = input.contract;
  const outer = block(c.screen, { id: 'Outer' }), inner = block(c.screen, { id: 'Inner', owner: outer.block }), producer = block(c.screen, { id: 'Card' });
  producer.instance.propertyReferences.SourceBlock = { kind: 'WebBlockSignature', key: k('CardBlk'), name: 'Card', path: 'Reference:OutSystemsUIWeb/WebBlockSignature:Card' };
  const again = structuredClone(outer.instance); again.key = k('OuterAgain');  // a second instance of a block is read once
  const proof = path.join(input.directory, 'inventory.json'); fs.writeFileSync(proof, JSON.stringify({ host: c.binding.host }));
  const items = values => ({ items: values, total: values.length, omitted: 0 }), ref = n => ({ kind: n.kind, key: n.key, name: n.name, path: n.path });
  const nodes = [c.preparation, ...c.widgets, outer.instance, inner.instance, producer.instance, again, outer.preparation, inner.preparation], reads = [], metadataReads = [];
  const widgetsOf = { [c.screen.path]: [outer.instance, producer.instance, again], [outer.block.path]: [inner.instance], [inner.block.path]: [], [c.login.path]: c.widgets };
  const owner = { snapshot: c.sourceContract, target: c.binding, versionId: c.binding.revision, inventoryProof: { path: proof, sha256: hash(fs.readFileSync(proof)) }, readings: [c.loginAction] };
  const result = await acquireTraditionalPreparation({ owner, entry: c.preparation, directory: input.directory, root: input.root }, {
    lifecycle: { readTree: async (_base, selector) => { reads.push(selector); const found = nodes.find(n => '@' + n.key === selector); assert.ok(found, 'unexpected read ' + selector); return structuredClone(found); } },
    metadata: async selector => { metadataReads.push(selector);
      const value = structuredClone([c.screen, outer.block, inner.block, c.login].find(n => n.path === selector));
      value.propertyReferenceCollections = { ...value.propertyReferenceCollections, InputParameters: items([]), LocalVariables: items([]), Widgets: items(widgetsOf[selector].map(ref)) };
      return value; },
    routes: async () => ({ screenRoutesSource: c.routes.source, screenRoutes: c.routes.urls, moduleIdentitySource: { source: 'native-fixture' } }) });
  assert.deepEqual(result.plan.preparations.map(p => [p.kind, p.key]), [['screen', c.preparation.key], ['block', k('OuterBlk') + '.#Preparation'], ['block', k('InnerBlk') + '.#Preparation']]);
  assert.deepEqual(metadataReads, [c.screen.path, outer.block.path, inner.block.path, c.login.path]);
  assert.ok(!reads.some(r => r.includes(k('CardBlk'))), 'producer block Preparation is never read');
  assert.equal(reads.filter(r => r === '@' + k('OuterBlk') + '.#Preparation').length, 1);
});

test('A missing reply to original login keeps uncertainty and never sends the requested screen', async t => {
  const { input, vault } = invocation(t); let sent = 0;
  const result = await invokePrivateTraditional(input, { vault, fetchImpl: async () => {
    if (++sent === 1) return new Response(form(), { headers: { 'Content-Type': 'text/html' } }); throw new Error('connection lost');
  } });
  assert.equal(sent, 2); assert.equal(result.uncertain, true); assert.equal(result.loginSubmitted, true);
  assert.equal(result.loginAnswered, false); assert.equal(result.sent, false); assert.equal(result.memoryReferencesReleased, true);
  const replay = await invokePrivateTraditional(input, { vault, fetchImpl: async () => { sent++; throw Error('must not send'); } });
  assert.equal(replay.uncertain, true); assert.match(replay.error, /scenario_already_submitted/); assert.equal(sent, 2);
});
