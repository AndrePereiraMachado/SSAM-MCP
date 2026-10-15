import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeLogText } from '../runtime/log-text.mjs';
import { Odc3PortalBroker } from '../runtime/odc3-context.mjs';
import { PORTAL_READS } from '../runtime/portal-routes.mjs';
import { redact } from '../runtime/errors.mjs';
const encoded = text => Buffer.from(text).toString('base64');

test('only native encoded fields of detail and related logs decode, preserving Unicode and plain stack traces', () => {
  for (const operation of ['monitoring.detail','monitoring.traceLogs']) {
    const row={Message:encoded('execução ✓'),ExceptionMessage:encoded('failure'),ConcatenatedMessageException:encoded('context'),StackTrace:'plain trace',InnerMessage:'unchanged'};
    const body={data:operation==='monitoring.detail'?{Log:row}:{RelatedLogList:{List:[row]}}};
    decodeLogText(body,operation);
    assert.deepEqual(row,{Message:'execução ✓',ExceptionMessage:'failure',ConcatenatedMessageException:'context',StackTrace:'plain trace',InnerMessage:'unchanged'});
  }
  const body={data:{LogsList:{List:[{Message:'YWJj'}]}}};
  assert.equal(decodeLogText(body,'monitoring.logs').data.LogsList.List[0].Message,'YWJj');
});

test('malformed, noncanonical, oversized and non-UTF8 encoded text fails without exposing content', () => {
  for(const value of ['private raw text','Zh==','/w==','YQ=', 'A'.repeat(1048580)])
    assert.throws(()=>decodeLogText({data:{Log:{Message:value}}},'monitoring.detail'),e=>e.code==='PORTAL_CONTRACT_CHANGED'&&!e.message.includes(value));
});

test('real broker decodes raw text before final projection so an encoded credential cannot escape', async () => {
  const broker=new Odc3PortalBroker();broker.authenticated=true;broker.credentialRegistry.add('fictional-private-value');
  broker.action=async()=>({data:{Log:{Message:encoded('token fictional-private-value'),ExceptionMessage:'',StackTrace:'plain'}}});
  const [module,view,action,discoveryView]=PORTAL_READS['monitoring.detail'];
  const response=await broker.readScreenservice({operationId:'monitoring.detail',target:broker.target,origin:broker.origin,readOnly:true,module,view,action,discoveryView});
  assert.equal(response.body.data.Log.Message,'token fictional-private-value');
  const output=redact(response,broker.credentialRegistry);
  assert.equal(output.body.data.Log.Message,'token [REDACTED]');
  assert.doesNotMatch(JSON.stringify(output),/fictional-private-value/);
});
