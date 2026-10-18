import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {routeTools} from '../tool-routing.mjs';
for(const lane of ['o11','odc'])for(const [action,intent]of [
 ['open','abrir preview local da tela'],['open',`preview ${lane} sem publicar`],['open','ver a tela em design time'],
 ['list','listar perfis de preview'],['status','status do preview local'],['refresh','atualizar o preview local'],['stop','encerrar preview']]){
 test(`discover ${lane} ${action}: ${intent}`,()=>{const result=routeTools({lane,intent}).tools[0];assert.equal(result?.tool,'ssam_preview');assert.equal(result?.verb,action);});
}
test('native merge preview remains a separate operation',()=>{
 const results=routeTools({lane:'odc',intent:'preview do manifesto antes do merge'}).tools;
 assert.ok(!results.some(x=>x.tool==='ssam_preview'));assert.ok(results.length>0);
});
