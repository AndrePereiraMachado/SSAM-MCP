import { fail } from './errors.mjs';
import { isUuid, sha256 } from './write-journal.mjs';

export function nativeBuildScope(receipt) {
 const target=receipt?.identity?.target;
 if(receipt?.identity?.operationId!=='native-application-orchestration-service-api-v1:post:/build-operations'
  ||!isUuid(target?.environmentKey)||!isUuid(target?.applicationKey))
  fail('OPERATION_RECEIPT_MISMATCH','Native build reads require the initiating receipt with exact application and environment.');
 return {environmentKey:target.environmentKey,applicationKey:target.applicationKey};
}

export function packagingReceipt(journal,{operationUuid,tenant,buildKey}) {
 if(!operationUuid)return null;
 const r=journal.lookup(operationUuid);
 if(!isUuid(operationUuid)||!r||r.identity?.tenant!==tenant||r.identity.kind!=='odc-public'
  ||r.identity.operationId!=='build-operations-api-v1:post:/build-operations/{operationKey}/generated-code'
  ||r.identity.target?.operationKey!==buildKey||!['accepted','uncertain','confirmed'].includes(r.state))
  fail('OPERATION_RECEIPT_MISMATCH','The packaging receipt does not identify this exact tenant and build; nothing was downloaded.');
 return r;
}
export function confirmPackagingReceipt(journal,receipt,result) {
 if(!receipt||receipt.state==='confirmed')return receipt;
 if(result?.ok!==true||result.buildKey!==receipt.identity.target.operationKey||!Number.isInteger(result.byteLength)||result.byteLength<=0||!/^[a-f0-9]{64}$/.test(result.sha256??''))
  fail('OPERATION_IDENTITY_UNVERIFIED','No verified package download for the exact build; receipt unchanged.');
 return journal.reconcile(receipt,{state:'confirmed',observation:{operationId:'build-operations-api-v1:get:/build-operations/{operationKey}/generated-code',
   buildKey:result.buildKey,status:'Finished',downloadSha256:result.sha256,byteLength:result.byteLength}});
}

export function operationReceipt(journal, { operationUuid, tenant, spec, operationKey }) {
  if (!operationUuid) return null;
  if (!isUuid(operationUuid)) fail('INPUT_INVALID', 'operationUuid must be a UUID.');
  const receipt = journal.lookup(operationUuid);
  const timer = receipt?.identity.kind === 'odc-portal' && ['timers.pause','timers.resume'].includes(receipt.identity.operationId)
    && spec.start === 'deployments-api-v1:post:/deployment-operations' && receipt.timerActivation;
  const discoveringTimerKey = timer && receipt.state === 'uncertain' && !receipt.response?.DeploymentKey;
  if (!receipt || receipt.identity.tenant !== tenant
      || (!timer && (receipt.identity.kind !== 'odc-public' || receipt.identity.operationId !== spec.start))
      || (!discoveringTimerKey && receipt.response?.[timer ? 'DeploymentKey' : spec.key] !== operationKey)
      || !['accepted', 'uncertain', 'confirmed'].includes(receipt.state)) {
    fail('OPERATION_RECEIPT_MISMATCH', 'The receipt does not identify this tenant and operation; it was not changed.');
  }
  return receipt;
}
export function confirmOperationReceipt(journal, receipt, { spec, operationKey, data, terminal, failed, timerVerification }) {
  if (!receipt || !terminal || failed || receipt.state === 'confirmed') return receipt;
  if (data?.[spec.param] !== operationKey && data?.[spec.key] !== operationKey)
    fail('OPERATION_IDENTITY_UNVERIFIED', 'The terminal response did not identify the requested operation; receipt unchanged.');
  if (data.assetKey && receipt.identity.target?.assetKey && data.assetKey !== receipt.identity.target.assetKey)
    fail('OPERATION_IDENTITY_UNVERIFIED', 'The terminal response belongs to another asset; receipt unchanged.');
  if (spec.start === 'user-access-management-api-v1:post:/users/bulk') {
    const expected=receipt.identity.target?.records, observed=data.operations;
    if (!Array.isArray(expected) || !expected.length || !Array.isArray(observed) || observed.length!==expected.length
        || observed.some(x=>x.status!=='Inserted'||!isUuid(x.record?.key))
        || new Set(observed.map(x=>x.record.key)).size!==observed.length
        || new Set(expected.map(x=>x.email)).size!==expected.length
        || expected.some(x=>observed.filter(y=>y.record.email===x.email).length!==1))
      fail('OPERATION_IDENTITY_UNVERIFIED', 'The bulk result must identify every requested user as a distinct Inserted record; receipt unchanged.');
  }
  if(spec.start==='build-operations-api-v1:post:/build-operations') {
    for(const field of ['assetKey','assetRevision','buildType'])if(receipt.identity.target?.[field]!==undefined && data[field]!==receipt.identity.target[field])
      fail('OPERATION_IDENTITY_UNVERIFIED','The terminal build does not match its asset, revision and build type; receipt unchanged.');
    if(data.status!=='Finished')return receipt;
  }
  if(spec.start==='native-application-orchestration-service-api-v1:post:/build-operations'){
    for(const field of ['applicationKey','buildKey','revision','mobilePlatform','mobileVersionNumber','mobileVersionCode'])
      if(receipt.identity.target?.[field]===undefined||data[field]!==receipt.identity.target[field])
        fail('OPERATION_IDENTITY_UNVERIFIED','The native package result must match its application, build, revision, platform and version; receipt unchanged.');
    if(data.status!=='Finished')return receipt;
  }
  if(spec.start==='deployments-api-v1:post:/publish-operations') {
    for(const field of ['revision','operation'])if(receipt.identity.target?.[field]!==undefined&&data[field]!==receipt.identity.target[field])
      fail('OPERATION_IDENTITY_UNVERIFIED','The terminal publication does not match the requested revision and operation; receipt unchanged.');
  }
  if(spec.start==='deployments-api-v1:post:/deployment-operations' && receipt.identity.kind==='odc-public') {
    const target=receipt.identity.target;
    if(target?.operation!==undefined && data.operation!==target.operation
      ||target?.revision!==undefined && (!Array.isArray(data.revisions)||data.revisions.length!==1||data.revisions[0]!==target.revision)
      ||target?.buildKey!==undefined && data.buildKey!==target.buildKey)
      fail('OPERATION_IDENTITY_UNVERIFIED','The terminal deployment does not match the requested operation, revision and build; receipt unchanged.');
  }
  if (data.environmentKey && receipt.identity.target?.environmentKey && data.environmentKey !== receipt.identity.target.environmentKey)
    fail('OPERATION_IDENTITY_UNVERIFIED', 'The terminal response belongs to another environment; receipt unchanged.');
  if (receipt.timerActivation && (timerVerification?.confirmed !== true
      || JSON.stringify(timerVerification.target) !== JSON.stringify(receipt.timerActivation.target)))
    fail('TIMER_STATE_UNVERIFIED', 'The completed deployment has not yet proved the requested timer state; receipt unchanged.');
  if (receipt.timerActivation && (data.assetKey !== receipt.timerActivation.target.applicationKey
      || (data.environmentKey && data.environmentKey !== receipt.timerActivation.target.environmentKey)))
    fail('OPERATION_IDENTITY_UNVERIFIED', 'The configuration deployment did not identify the exact timer application and environment; receipt unchanged.');
  return journal.reconcile(receipt, {state:'confirmed',observation:{operationId:spec.read,operationKey,status:data[spec.field],dataSha256:sha256(JSON.stringify(data)),
    ...(timerVerification ? {timerVerification} : {})}});
}
