import { wordsGiven } from '../destructive-operations.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { CookieJar as ToughCookieJar } from 'tough-cookie';
import { DownloadContextStore, downloadBinding } from './download-context.mjs';
import { parseSolutionPreparation } from './solution-preparation.mjs';
import { BridgeError, ProtocolError } from './errors.mjs';
import { CookieJar, LOGIN_PAGE, Transport, StudioWebTransport } from './http.mjs';
import { isProtectedScHtml } from './sso.mjs';
import { readCheckpoint } from '../read-budget.mjs';
import { validateSolutionPackage } from './solution-package.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = body => crypto.createHash('sha256').update(body).digest('hex');
const fail = message => { throw new ProtocolError(message, 'SC_DOWNLOAD_CONTEXT_UNAVAILABLE'); };
// The transports' own sign-in detections (http.mjs): direct session expired, SSO required, native session unauthenticated.
const signInRequired = error => error instanceof BridgeError && ['SC_AUTH_EXPIRED','SC_SSO_REQUIRED','WEB_SIGN_IN_REQUIRED'].includes(error.code);
const failureKind = error => {
  if (error?.code === 'READ_DEADLINE_EXCEEDED') return 'read-deadline';
  if (error instanceof ProtocolError) {
    if (/connection failed/.test(error.message)) return 'transport-failed';
    if (/exceeds its size limit/.test(error.message)) return 'response-too-large';
    if (/page instead of the file/.test(error.message)) return 'unexpected-html';
    if (/intact supported ZIP/.test(error.message)) return 'archive-integrity';
    const status = /^Service Center returned HTTP (\d{3})$/.exec(error.message);
    if (status) return 'http-' + status[1];
  }
  return 'unclassified';
};

// Called only on the tool's own authenticated SSO jar, never the Studio's jar.
export function ownedSsoJar(jar, host, {onUpdate=null} = {}) {
  return { header: url => jar.getCookieStringSync(url),
    store: (url, headers = []) => { for (const c of headers) jar.setCookieSync(c, url, { ignoreError:true }); if(headers.length)onUpdate?.(jar); },
    downloadState: () => {
      const state = jar.serializeSync();
      state.cookies = state.cookies.filter(c => c.domain && (host === c.domain || host.endsWith('.' + c.domain)));
      return { format:'tough-cookie', jar:state };
    } };
}

function snapshotSession(client) {
  if (client.http instanceof StudioWebTransport) return { kind:'native' };
  if (client.http.jar.downloadState) return { kind:'owned', ...client.http.jar.downloadState() };
  if (client.http.jar instanceof CookieJar) return { kind:'owned', format:'simple', cookies:[...client.http.jar.cookies] };
  fail('The authenticated transport cannot preserve its own download session; no new preparation is allowed');
}

function restoreSession(client, session, { transportOptions, onSource } = {}) {
  if (session?.kind === 'native') {
    if (!(client.http instanceof StudioWebTransport)) fail('The original native download session is unavailable; no preparation was repeated');
    return;
  }
  if (session?.kind !== 'owned') fail('Unknown private download session');
  const transport = new Transport(client.vault.host, transportOptions);
  if (session.format === 'tough-cookie') transport.jar = ownedSsoJar(ToughCookieJar.deserializeSync(session.jar), client.vault.host);
  else if (session.format === 'simple' && Array.isArray(session.cookies)) transport.jar.cookies = new Map(session.cookies);
  else fail('Unknown private download cookie format');
  transport.preauthenticated = true;
  transport.source = 'private-download-session';
  client.http = transport;
  onSource?.('private-download-session');
}

// A separate inspection never advances the download state machine. In particular,
// inspecting a ready record must not submit its hidden Download form.
export async function solutionDownloadStatus(client, name, options = {}) {
  const {operationId,principal,store=new DownloadContextStore()}=options;
  if(!UUID.test(operationId??''))throw new ProtocolError('solution-download-status requires the original operationId UUID');
  const identity={host:client.vault.host,principal,solution:name,version:'current-running'};
  const record=await store.find(operationId,identity);
  if(!record)throw new ProtocolError('Download record not found for this UUID and identity','SC_DOWNLOAD_NOT_FOUND');
  const c=record.context;
  const result={solution:name,operationId,state:c.phase,recordRevision:record.revision,
    complete:false,remoteStateRefreshed:false,inspectedAt:new Date().toISOString(),
    reconciliationRequired:['reserved','downloading'].includes(c.phase)};
  if(record.origin)result.recordOrigin={path:record.origin.path,sha256:record.origin.sha256};
  if(c.version)result.version=c.version;
  if(c.preparation?.asyncOperationId)result.asyncOperationId=c.preparation.asyncOperationId;
  if(c.status)result.preparationStatus=Object.fromEntries(['asyncOperationId','state','errorCount','lastMessageId','terminal','completedSuccessfully','observedAt']
    .filter(k=>Object.hasOwn(c.status,k)).map(k=>[k,c.status[k]]));
  if(c.lastFailure)result.lastFailure={stage:c.lastFailure.stage,cause:c.lastFailure.cause};
  if(c.expired)result.expired={at:c.expired.at,stage:c.expired.stage,observed:c.expired.observed,sent:false};
  if(c.abandoned)result.abandoned={at:c.abandoned.at,previousPhase:c.abandoned.previousPhase,wordsSha256:c.abandoned.wordsSha256,sent:false};
  if(c.received)result.received={bytes:c.received.bytes,sha256:c.received.sha256,contentType:c.received.contentType};
  if(c.artifact){
    const a=c.artifact;
    let verified=false;
    try{const stat=fs.statSync(a.file);verified=stat.isFile()&&stat.size<=64*1024*1024&&stat.size===a.size&&hash(fs.readFileSync(a.file))===a.sha256;}catch{/* Missing artifact is an observed local state. */}
    result.artifact={file:a.file,sha256:a.sha256,size:a.size,verified};
    result.complete=c.phase==='complete'&&verified;
  }
  if(result.asyncOperationId)result.statusContinuation={tool:'o11_service_center_read',
    arguments:{action:'async-operation-status',host:identity.host,asyncOperationId:result.asyncOperationId,lastMessageId:String(c.cursor??-1)},
    why:'Read the existing preparation only. This does not prove that the final file was received.'};
  return result;
}

// Local only: the user's words close a stalled or uncertain record for good. Nothing is sent to Service Center; the UUID
// never advances again (a later download starts under a new one). The words are kept as sha256, with the question they
// answered and the time; the opaque form and session state is dropped from the new revision.
export async function solutionDownloadAbandon(client, name, options = {}) {
  const { operationId, principal, words, question = null, store = new DownloadContextStore(), now = () => new Date().toISOString() } = options;
  if (!UUID.test(operationId ?? '')) throw new ProtocolError('solution-download-abandon requires the original operationId UUID');
  if (!wordsGiven(words) || words.length > 2000) throw new ProtocolError( // CX15 r7 (M-3): one predicate
   'solution-download-abandon requires the user\'s words, verbatim');
  if (question !== null && (typeof question !== 'string' || question.length > 2000)) throw new ProtocolError('question is the text the user answered, at most 2000 characters');
  const identity = { host:client.vault.host, principal, solution:name, version:'current-running' };
  const record = await store.find(operationId, identity);
  if (!record) throw new ProtocolError('Download record not found for this UUID and identity', 'SC_DOWNLOAD_NOT_FOUND');
  const c = record.context;
  const answer = (context, revision, origin) => ({ ok:true, solution:name, operationId, state:'abandoned', previousPhase:context.abandoned.previousPhase,
    recordRevision:revision, abandonedAt:context.abandoned.at, wordsSha256:context.abandoned.wordsSha256, sent:false,
    ...(origin ? { recordOrigin:{ path:origin.path, sha256:origin.sha256 } } : {}) });
  if (c.phase === 'abandoned') return { ...answer(c, record.revision, record.origin), alreadyAbandoned:true };
  if (c.phase === 'complete') throw new ProtocolError('A completed download is not abandoned; its artifact stays verified', 'SC_DOWNLOAD_COMPLETE');
  const abandoned = { ...c, phase:'abandoned', abandoned:{ at:now(), previousPhase:c.phase, previousRevision:record.revision,
    wordsSha256:hash(Buffer.from(words, 'utf8')), ...(question ? { question } : {}), sent:false } };
  delete abandoned.session; delete abandoned.preparation; delete abandoned.request;
  const saved = await store.replace(operationId, identity, record.revision, abandoned);
  return answer(abandoned, saved.revision, saved.origin ?? record.origin);
}

// A new preparation starts only without an operationId, under a UUID minted here. A caller's UUID resumes an existing
// record (in the shared store or a legacy per-app copy) and is refused when none exists: a record kept where this
// process cannot see it must never look new. create:true is the solution-publish path, whose UUID is its own journal
// reservation.
export async function solutionDownload(client, name, options = {}) {
  const { principal, store = new DownloadContextStore(), create = false } = options;
  const minted = options.operationId == null;
  const operationId = minted ? crypto.randomUUID() : options.operationId;
  if (!UUID.test(operationId)) throw new ProtocolError('solution-download takes the operationId UUID of an existing download; omit it to start a new one');
  if (!client.exports) throw new ProtocolError('Downloads need a local export folder');
  const identity = { host:client.vault.host, principal, solution:name, version:'current-running' };
  downloadBinding(identity); // Refuse unidentified sessions before any export.
  const continuation = { tool:'o11_service_center_read', arguments:{action:'solution-download',host:identity.host,solution:name,operationId},
    why:'Resume the same download record; do not mint a replacement UUID for an uncertain send.' };
  const inspectContinuation={...continuation,arguments:{...continuation.arguments,action:'solution-download-status'},
    why:'Inspect the existing private download record without sending a form or starting another preparation.'};
  const restart = { tool:'o11_service_center_read', arguments:{action:'solution-download',host:identity.host,solution:name},
    why:'Start a new download under a new UUID. The expired one is closed: its final form was never sent.' };
  const expiredAnswer = context => ({...summary(context),continuation:restart,ok:false,code:'SC_DOWNLOAD_SESSION_EXPIRED',sent:false,
    expired:context.expired,error:'The private download session expired before the final form was sent. This UUID is closed; start a new download.'});
  const summary = context => ({ solution:name, operationId, state:context.phase, ...(context.version ? {version:context.version} : {}),
    ...(context.preparation ? {asyncOperationId:context.preparation.asyncOperationId} : {}),
    ...(context.status ? {preparationStatus:context.status} : {}), complete:false, continuation });
  let record = await store.find(operationId, identity);
  let context = record?.context;
  let stage = 'context';
  try {
    if (!record) {
      if (!minted && !create) throw new ProtocolError('No download record exists for this operationId in any store; nothing was sent. '
        + 'Omit operationId to start a new download.', 'SC_DOWNLOAD_NOT_FOUND');
      const request = await client.solutionDownloadRequest(name);
      // Confirm session persistence before the preparation could be sent.
      context = {phase:'preparation-ready',version:request.version,request,session:snapshotSession(client),createdAt:new Date().toISOString()};
      record = await store.create(operationId, identity, context);
    }
    if (context.phase === 'preparation-ready') {
      restoreSession(client,context.session,options);
      const readyContext = context;
      try { readCheckpoint('solution-preparation-reservation'); }
      catch (error) {
        if (error?.code !== 'READ_DEADLINE_EXCEEDED') throw error;
        return {...summary(context),ok:false,code:'READ_DEADLINE_EXCEEDED',sent:false,
          error:'Preparation was not sent. Resume this same UUID with a fresh read budget.'};
      }
      context = {...context,phase:'reserved'};
      record = await store.replace(operationId,identity,record.revision,context);
      try { readCheckpoint('solution-preparation'); }
      catch (error) {
        if (error?.code !== 'READ_DEADLINE_EXCEEDED') throw error;
        record = await store.replace(operationId,identity,record.revision,readyContext);
        context = readyContext;
        return {...summary(context),ok:false,code:'READ_DEADLINE_EXCEEDED',sent:false,
          error:'Preparation was not sent. Resume this same UUID with a fresh read budget.'};
      }
      stage = 'preparation-request';
      const request = context.request;
      const response = await client.http.fetch(request.url, request.fields, 'solution');
      if (!response[1].includes('text/html')) return await complete(response[2]);
      const preparation = parseSolutionPreparation(response, name, client.http);
      context = {...context,phase:'prepared',preparation,session:snapshotSession(client),cursor:-1};
      delete context.request;
      record = await store.replace(operationId,identity,record.revision,context);
      return summary(context);
    }
    if (context.phase === 'complete') {
      const artifact = context.artifact;
      if (!artifact?.file || !fs.existsSync(artifact.file) || hash(fs.readFileSync(artifact.file)) !== artifact.sha256)
        fail('The completed download artifact is unavailable or changed; preparation was not repeated');
      return {...summary(context),...artifact,complete:true,continuation:undefined};
    }
    if (['reserved','downloading'].includes(context.phase))
      return {...summary(context),continuation:inspectContinuation,ok:false,code:'SC_DOWNLOAD_SEND_UNCERTAIN',...(context.lastFailure ? {status:context.lastFailure} : {}),error:'A send was reserved but its outcome was not durably recorded. Reconcile the existing operation; preparation was not repeated.'};
    if (context.phase === 'failed') return {...summary(context),ok:false,code:'SC_DOWNLOAD_PREPARATION_FAILED'};
    if (context.phase === 'abandoned') return {...summary(context),continuation:undefined,ok:false,code:'SC_DOWNLOAD_ABANDONED',
      error:'This download was abandoned by the user and is never resumed. Omit operationId to start a new one.'};
    if (context.phase === 'expired') return expiredAnswer(context);
    if (!['prepared','ready'].includes(context.phase)) fail('Unknown private download phase');
    restoreSession(client,context.session,options);
    if (context.phase === 'prepared') {
      stage = 'preparation-status';
      const status = await client.asyncOperationStatus(context.preparation.asyncOperationId,context.cursor);
      context = {...context,status,cursor:status.lastMessageId,
        phase:status.completedSuccessfully ? 'ready' : status.terminal ? 'failed' : 'prepared',session:snapshotSession(client)};
      record = await store.replace(operationId,identity,record.revision,context);
      return {...summary(context),...(context.phase === 'failed' ? {ok:false,code:'SC_DOWNLOAD_PREPARATION_FAILED'} : {})};
    }
    // Probe the original session before the final POST; no reauthentication and
    // no fallback to a new session after a protected form has been prepared.
    // A positively observed sign-in page closes the record: its form belongs to the
    // dead session, nothing was sent, and only a new download can go on.
    stage = 'session-probe';
    let page;
    try { page = await client.http.fetch('Home.aspx'); }
    catch (error) { if (signInRequired(error)) return await expire(error.code); throw error; }
    const home = page[2].toString('utf8');
    if (LOGIN_PAGE.test(home)) return await expire('SC_AUTH_EXPIRED');
    if (!isProtectedScHtml(home)) fail('Original download session expired; no final form was submitted');
    const readyContext = context;
    readCheckpoint('solution-download-reservation');
    context = {...context,phase:'downloading'};
    record = await store.replace(operationId,identity,record.revision,context);
    // Only this synchronous checkpoint proves that fetch has not been invoked.
    // A timeout thrown by fetch itself cannot authorize resetting a reservation.
    try { readCheckpoint('solution-download'); }
    catch (error) {
      if (error?.code !== 'READ_DEADLINE_EXCEEDED') throw error;
      record = await store.replace(operationId,identity,record.revision,readyContext);
      context = readyContext;
      return {...summary(context),ok:false,code:'READ_DEADLINE_EXCEEDED',sent:false,
        error:'The final download was not sent. Resume this same UUID with a fresh read budget.'};
    }
    stage = 'final-download-request';
    const response = await client.http.fetch(context.preparation.url,context.preparation.fields,'binary');
    context.received = {bytes:response[2].length,sha256:hash(response[2]),contentType:response[1]};
    return await complete(response[2]);
  } catch (error) {
    if (!record) throw error;
    const status = {stage,cause:failureKind(error)};
    try { await store.replace(operationId,identity,record.revision,{...context,lastFailure:status}); }
    catch { /* The previous reservation remains authoritative; never reset it. */ }
    throw new BridgeError(error instanceof ProtocolError ? error.code : 'SC_DOWNLOAD_LOCAL_FAILURE',
      'Download did not complete. The reserved UUID must be reconciled; no automatic preparation retry was made.', {continuation:inspectContinuation,status});
  }

  async function expire(observed) {
    const expired = {...context,phase:'expired',expired:{at:new Date().toISOString(),stage:'session-probe',observed,sent:false}};
    delete expired.session; delete expired.preparation; delete expired.request;
    record = await store.replace(operationId,identity,record.revision,expired);
    context = expired;
    return expiredAnswer(expired);
  }

  async function complete(body) {
    stage = 'archive-validation';
    const archive = validateSolutionPackage(body);
    stage = 'artifact-save';
    const artifact = {...client.save(name.replace(/[^A-Za-z0-9_.-]/g,'_').slice(0,60),'osp',body),archive};
    const saved = {...context,phase:'complete',artifact,completedAt:new Date().toISOString()};
    // Completed records no longer need live authentication or opaque form state.
    delete saved.session; delete saved.preparation; delete saved.request;
    stage = 'completion-record';
    await store.replace(operationId,identity,record.revision,saved);
    return {...summary(saved),...artifact,complete:true,continuation:undefined,observedAt:saved.completedAt};
  }
}
