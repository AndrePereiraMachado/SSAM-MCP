import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ProtocolError} from './errors.mjs';
import {sha256,fingerprint,utc} from './util.mjs';

export class OwnerSelectionStore {
  constructor(root,identity) {
    if (!root || !identity?.host || !identity?.principal) throw new ProtocolError('Owner selection capture requires an export directory and authenticated identity');
    this.root=path.join(root,'owner-selections');this.identity=fingerprint(identity);
  }
  save(modules) {
    const record={schema:'ssam-owner-selection/1',identity:this.identity,capturedAt:utc(),modules};
    const bytes=JSON.stringify(record),id=crypto.randomUUID()+'-'+sha256(bytes);
    fs.mkdirSync(this.root,{recursive:true});fs.writeFileSync(path.join(this.root,id+'.json'),bytes,{flag:'wx'});
    return {id,capturedAt:record.capturedAt};
  }
  read(id) {
    if(typeof id!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}-[a-f0-9]{64}$/.test(id))throw new ProtocolError('Invalid owner selection capture ID');
    const file=path.join(this.root,id+'.json');
    if(!fs.existsSync(file)||fs.statSync(file).size>4*1024*1024)throw new ProtocolError('Owner selection capture is missing or too large');
    const bytes=fs.readFileSync(file,'utf8');
    if(sha256(bytes)!==id.slice(-64))throw new ProtocolError('Owner selection capture hash changed');
    const record=JSON.parse(bytes);
    if(record.schema!=='ssam-owner-selection/1'||record.identity!==this.identity)throw new ProtocolError('Owner selection capture identity changed');
    return record;
  }
}
