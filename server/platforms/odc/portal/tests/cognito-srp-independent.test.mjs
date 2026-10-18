import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, getDiffieHellman, hkdfSync } from 'node:crypto';
import { cognitoLogin } from '../runtime/cognito-login.mjs';

// Independent synthetic SERVER verifier. No Cognito helper, JSBN, AWS crypto,
// real credential, vault or network is used to calculate the expected proof.
// Cognito's 3072-bit group is RFC 3526 group 15 (Node/OpenSSL modp15).
const N = BigInt('0x' + getDiffieHellman('modp15').getPrime('hex')), g = 2n;
const sha = value => createHash('sha256').update(value).digest();
const number = bytes => BigInt('0x' + bytes.toString('hex'));
function bytes(value) {
  assert.ok(value >= 0n);
  let hex = value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  if (parseInt(hex.slice(0, 2), 16) >= 128) hex = '00' + hex;
  return Buffer.from(hex, 'hex');
}
function pow(base, exponent) {
  let result = 1n; base %= N;
  while (exponent > 0n) {
    if (exponent & 1n) result = result * base % N;
    base = base * base % N; exponent >>= 1n;
  }
  return result;
}

test('SDK SRP matches an independent server verifier with alias, canonical identity, Unicode and signed padding', { timeout: 15000 }, async () => {
  const config = { Region: 'us-east-2', PoolKey: 'us-east-2_SyntheticPool', AmplifyClientKey: 'syntheticclient123', AuthFlow: 'USER_SRP_AUTH' };
  const alias = 'Alias+case@example.invalid', canonical = 'é-native-synthetic-user', password = '  Sênha-e\u0301-🔒-漢字  ';
  const poolName = 'SyntheticPool', salt = 0x80fedcba9876543210fedcba987654321n;
  const b = 0xedcba987654321ff01020304050607080910111213141516171819202122232425n;
  const k = number(sha(Buffer.concat([bytes(N), bytes(g)])));
  const x = number(sha(Buffer.concat([bytes(salt), sha(Buffer.from(poolName + canonical + ':' + password, 'utf8'))])));
  const verifier = pow(g, x), B = (k * verifier + pow(g, b)) % N;
  const secretBlock = Buffer.from('synthetic-secret-block\0\u0080\u00ff', 'utf8'), session = 'synthetic-session-must-survive';
  let A, proofVerified = false, retainedFailure, result;
  const calls = [], diagnosticEvents = [];
  const token = Buffer.from('{"alg":"none"}').toString('base64url') + '.'
    + Buffer.from(JSON.stringify({ sub: 'synthetic-subject', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url') + '.synthetic';
  try {
    result = await cognitoLogin({ config, username: alias, password, signal: AbortSignal.timeout(14000), observer: event => diagnosticEvents.push(event),
      request: async (url, options) => {
        try {
          assert.equal(url, 'https://cognito-idp.us-east-2.amazonaws.com/');
          assert.equal(options.method, 'POST'); assert.equal(options.headers['Content-Type'], 'application/x-amz-json-1.1');
          // Exercise the same JSON wire round-trip as the app request transport.
          const body = JSON.parse(JSON.stringify(options.body));
          assert.ok(!JSON.stringify(body).includes(password));
          assert.equal(body.ClientId, config.AmplifyClientKey);
          const operation = options.headers['X-Amz-Target'].split('.').at(-1); calls.push(operation);
          if (operation === 'InitiateAuth') {
            assert.equal(calls.length, 1); assert.equal(body.AuthFlow, 'USER_SRP_AUTH');
            assert.equal(body.AuthParameters.USERNAME, alias); assert.match(body.AuthParameters.SRP_A, /^[a-f0-9]+$/i);
            A = BigInt('0x' + body.AuthParameters.SRP_A); assert.ok(A > 0n && A < N);
            return { status: 200, text: JSON.stringify({ ChallengeName: 'PASSWORD_VERIFIER', Session: session,
              ChallengeParameters: { USER_ID_FOR_SRP: canonical, SRP_B: B.toString(16), SALT: salt.toString(16), SECRET_BLOCK: secretBlock.toString('base64') } }) };
          }
          assert.equal(operation, 'RespondToAuthChallenge'); assert.equal(calls.length, 2);
          assert.equal(body.ChallengeName, 'PASSWORD_VERIFIER'); assert.equal(body.Session, session);
          const response = body.ChallengeResponses;
          assert.deepEqual(Object.keys(response).sort(), ['PASSWORD_CLAIM_SECRET_BLOCK', 'PASSWORD_CLAIM_SIGNATURE', 'TIMESTAMP', 'USERNAME']);
          assert.equal(response.USERNAME, canonical); assert.notEqual(response.USERNAME, alias);
          assert.equal(response.PASSWORD_CLAIM_SECRET_BLOCK, secretBlock.toString('base64'));
          assert.match(response.TIMESTAMP, /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12][0-9]|3[01]) [0-2][0-9]:[0-5][0-9]:[0-5][0-9] UTC [0-9]{4}$/);
          assert.ok(Math.abs(Date.parse(response.TIMESTAMP) - Date.now()) < 5000);
          const u = number(sha(Buffer.concat([bytes(A), bytes(B)])));
          // Server formula differs from the SDK client's (B - k*g^x)^(a+u*x).
          const S = pow(A * pow(verifier, u) % N, b);
          const key = Buffer.from(hkdfSync('sha256', bytes(S), bytes(u), Buffer.from('Caldera Derived Key', 'utf8'), 16));
          const signed = Buffer.concat([Buffer.from(poolName, 'utf8'), Buffer.from(canonical, 'utf8'), secretBlock, Buffer.from(response.TIMESTAMP, 'utf8')]);
          const signature = createHmac('sha256', key).update(signed).digest('base64');
          assert.equal(response.PASSWORD_CLAIM_SIGNATURE, signature);
          // Negative controls: this verifier is sensitive to signed identity and bytes.
          assert.notEqual(signature, createHmac('sha256', key).update(Buffer.concat([Buffer.from(poolName + alias, 'utf8'), secretBlock, Buffer.from(response.TIMESTAMP, 'utf8')])).digest('base64'));
          assert.notEqual(signature, createHmac('sha256', key).update(Buffer.concat([signed, Buffer.from([0])])).digest('base64'));
          proofVerified = true;
          return { status: 200, text: JSON.stringify({ AuthenticationResult: { AccessToken: token, IdToken: token, RefreshToken: 'synthetic-refresh-only' } }) };
        } catch (error) { retainedFailure = error; throw error; }
      },
    });
  } catch (error) { throw retainedFailure ?? error; }
  assert.equal(proofVerified, true); assert.deepEqual(calls, ['InitiateAuth', 'RespondToAuthChallenge']);
  assert.deepEqual(diagnosticEvents, []); assert.equal(result.AccessToken, token); assert.equal(result.IdToken, token);
});
