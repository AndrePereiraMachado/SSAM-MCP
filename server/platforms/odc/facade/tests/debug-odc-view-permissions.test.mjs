import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readOdcViewPermissionDeclaration} from '../debug-odc-view-permissions.mjs';
const prefix=`import {x as auth} from './_oschunk-SDK.js';import {d as app} from './_oschunk-APP.js';var Controller=`;
const source=body=>prefix+`class Controller {static checkPermissions(){${body}}}`;
const read=body=>readOdcViewPermissionDeclaration(source(body),prefix.length);
test('native role declaration preserves imported role identity without claiming access',()=>{
 const p=read('auth.ensureUserHasRole({roles:[app.roles.Required]});');
 assert.equal(p.declarationKind,'native-role-check');assert.equal(p.permissionsValidated,false);
 assert.deepEqual(p.roleReferences,[{name:'Required',file:'./_oschunk-APP.js',export:'d'}]);
});
test('an empty block check is distinct from a validated screen permission',()=>{
 const p=read('');assert.equal(p.declarationKind,'empty-own-check');assert.equal(p.permissionsValidated,false);
});
test('unknown effects, role fabrication, dynamic references and empty lists refuse',()=>{
 for(const body of ['auth.ensureUserHasRole({roles:[app.roles.Required]});send();','auth.ensureUserHasRole({roles:[{}]});','auth.ensureUserHasRole({roles:[app.roles[getName()]]});','auth.ensureUserHasRole({roles:[]});','other({roles:[app.roles.Required]});','auth.ensureUserHasRole({roles:[app.roles.Required],skip:true});'])assert.throws(()=>read(body),/view_permissions_/);
});
