import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../../../../kernel/src/Anvil.Core/Kernel/UploadValidationRuntime.js', import.meta.url), 'utf8');
const validate = new Function(source + '\nreturn ssamValidateUpload;')();
test('upload validates actual binary size, extension and malformed data', () => {
  assert.equal(validate(btoa('1234'), 'report.PDF', 4, '.pdf,.txt').valid, true);
  assert.equal(validate(btoa('12345'), 'report.pdf', 4, '.pdf').valid, false);
  assert.equal(validate(btoa('123'), 'report.exe', 4, '.pdf').valid, false);
  assert.equal(validate('???', 'report.pdf', 4, '.pdf').valid, false);
  assert.equal(validate('', '', 4, '.pdf').valid, true);
});
