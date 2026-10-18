import '../../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceName} from './measure/request-metrics.mjs';
import {privacyFindings} from './privacy.mjs';
const home=String.raw`C:\Users\synthetic-current`;
const roots=[String.raw`D:\Users\synthetic-other`,`/home/synthetic-other`,`/Users/synthetic-other`,String.raw`\\synthetic-server\Users\synthetic-other`,String.raw`\\synthetic-server\share\home\synthetic-other`,String.raw`\\synthetic-server\home$\synthetic-other`,String.raw`\\wsl.localhost\SyntheticLinux\home\synthetic-other`,home];
for(const [index,root]of roots.entries())test(`N3b home root family ${index+1}/8 uses a neutral marker`,()=>{
 assert.equal(workspaceName(root,{home}),'[user-home]');
 assert.equal(workspaceName(root+(root.startsWith('/')?'/':'\\'),{home}),'[user-home]');
});
test('N3b projects inside user homes keep only the project name',()=>{
 for(const root of roots)assert.equal(workspaceName(root+(root.startsWith('/')?'/':'\\')+'synthetic-project',{home}),'synthetic-project');
});
test('N3b prior path table and unrelated username segment remain stable',()=>{
 const rows=[[String.raw`\\synthetic-server\projects\ssam`,'ssam'],[String.raw`\\wsl.localhost\SyntheticLinux\home\synthetic-current\proj`,'proj'],[String.raw`\\synthetic-server\Users\synthetic-current\proj`,'proj'],['',''],[String.raw`D:\work\synthetic-current`,'[user-segment]'],[String.raw`C:\work\ssam`,'ssam'],['/srv/work/ssam','ssam'],[home,'[user-home]']];
 for(const [cwd,expected]of rows)assert.equal(workspaceName(cwd,{home}),expected);
});
test('N3b guard rejects a user segment identified by its source home root',()=>{
 for(const cwd of roots){const workspace=cwd.split(/[\\/]/).filter(Boolean).at(-1);assert.ok(privacyFindings({cwd,workspace}).some(f=>f.field==='workspace'&&f.label==='user-home'));}
});
