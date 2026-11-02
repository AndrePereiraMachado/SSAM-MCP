import { EventEmitter } from 'node:events';
export function privateChild() {
 const child=new EventEmitter(); child.stdout=new EventEmitter(); child.exitCode=null; child.unref=()=>{};
 child.finish=(value={ok:true,saved:true,remembered:true,profile:'0'.repeat(64)})=>{child.stdout.emit('data',Buffer.from(JSON.stringify(value)));child.stdout.emit('end');child.exitCode=0;child.emit('close',0);};
 return child;
}
export function completedPrivateChild(){const child=privateChild();queueMicrotask(()=>child.finish());return child;}
