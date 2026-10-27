import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../../../../kernel/src/Anvil.Core/Kernel/TemporalRuntime.js',import.meta.url),'utf8');
const format=new Function(source+'\nreturn ssamFormatTemporal;')();
test('client-local values retain their fields regardless of target timezone',()=>{
  for(const zone of ['UTC','America/Sao_Paulo','Asia/Tokyo']) assert.equal(format('2026-10-23T12:00:00Z','client-local',zone,'dd/MM/yyyy HH:mm'),'23/10/2026 12:00');
});
test('date-only values do not become the previous day',()=>assert.equal(format('2026-10-23','date','America/Sao_Paulo','dd/MM/yyyy'),'23/10/2026'));
test('instants convert once and respect DST boundaries',()=>{
  assert.equal(format('2026-10-23T12:00:00Z','instant','America/Sao_Paulo','HH:mm'),'09:00');
  assert.equal(format('2026-03-08T06:59:00Z','instant','America/New_York','HH:mm'),'01:59');
  assert.equal(format('2026-03-08T07:01:00Z','instant','America/New_York','HH:mm'),'03:01');
});
test('ambiguous and invalid values cannot silently become plausible dates',()=>{
  assert.throws(()=>format('2026-10-23T12:00:00','instant','UTC','HH:mm'));
  assert.throws(()=>format('2026-02-30','date','UTC','dd/MM/yyyy'));
  assert.throws(()=>format('2026-02-30T12:00:00Z','instant','UTC','dd/MM/yyyy'));
  assert.throws(()=>format('2026-10-23T12:00:00-03:00','client-local','UTC','HH:mm'));
  assert.throws(()=>format('2026-10-23','date','UTC','unknown'));
});
