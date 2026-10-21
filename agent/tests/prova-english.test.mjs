import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseArgs,agentTarget} from '../scripts/prova-verbos.mjs';
test('proof CLI: all six validation messages are English',t=>{
 for(const [args,pattern] of [[['--unknown'],/Unknown option/],[['--root'],/requires a value/],[[],/Usage:.*agent folder/],[['--root','x','--host','https://invalid'],/DNS name.*without/],[['--root','x','--publish'],/requires --module/]]) assert.throws(()=>parseArgs(args),pattern);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'proof-cli-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.mkdirSync(path.join(dir,'private','authority'),{recursive:true});
 fs.writeFileSync(path.join(dir,'private','authority','bridge.key'),'');
 fs.writeFileSync(path.join(dir,'private','o11-connection.json'),'{"port":null}');
 assert.throws(()=>agentTarget(dir),/No agent O11 connection.*run ssam_connect/);
});
