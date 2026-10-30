import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import(process.env.SSAM_TEST_STUDIO_IDENTITY ?? '../studio-identity.mjs');
for (const installed of ['11.55.93.65289', '11.55.92.65269']) {
  test(`mixed ODC 1.7.30 and Service Studio ${installed} explains the O11 update without blocking ODC`, () => {
    const identity = { lane: 'o11', installed, served: '11.55.94', relation: 'served-elsewhere', direction: null,
      policy: 'warn', ok: false, window: ['11.55.92', '11.55.93', '11.55.94'] };
    const refusal = api.studioRefusal(identity);
    assert.equal(refusal.code, 'STUDIO_VERSION_MISMATCH');
    assert.equal(refusal.cause, 'STUDIO_VERSION_CHANGED');
    assert.equal(refusal.outcome, 'not-sent');
    assert.deepEqual(refusal.continuation.arguments, {});
    assert.equal(refusal.continuation.tool, 'ssam_doctor');
    for (const text of [refusal.userMessage, refusal.error, api.studioWarningOf(identity).userMessage]) {
      assert.match(text, /Update Service Studio to 11\.55\.94/);
      assert.match(text, /ODC lane remains available/);
      assert.doesNotMatch(text, /being redirected/);
    }
    assert.equal(api.studioRefusal(api.studioIdentity('odc', '1.7.30.10980', {odc:'1.7.30',o11:'11.55.94'})), null);
  });
}
test('the mixed-machine instruction does not change other routing cases', () => {
  assert.equal(api.mixedStudioUpgrade({lane:'odc',relation:'served-elsewhere',installed:'1.7.29',served:'1.7.30'}),null);
  assert.equal(api.mixedStudioUpgrade({lane:'o11',relation:'served-elsewhere',installed:'11.55.94',served:'11.55.93'}),null);
});
