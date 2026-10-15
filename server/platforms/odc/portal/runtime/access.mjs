import {evaluationRunsInput} from './evaluation-runs-input.mjs';
import {API_CLIENT_CREATE,API_CLIENT_DELETE,apiClientPrivateProof} from './api-client-fixture.mjs';
import {apiClientWriteApproval} from './api-client-pending-cleanup.mjs';
import {windowsApiClientFixtureStatus} from './api-client-credential.mjs';
import {API_CLIENT_VAULT_STATUS,apiClientVaultStatus} from './api-client-vault-status.mjs';
import {apiClientInventoryInput,collectApiClientInventory,apiClientAbsent} from './api-client-inventory.mjs';
import {mobileExtensibilityReadInput} from './mobile-extensibility-read.mjs';
import {alternateConnectionsInput,alternateConnectionsResult} from './alternate-connections.mjs';
import {privateKnowledgeDownloader} from './private-knowledge-download.mjs';
import {privateMobileDownloader,MOBILE_FILE_DOWNLOAD} from './private-mobile-download.mjs';
import {knowledgeFileDownloadPlan,KNOWLEDGE_FILE_DOWNLOAD} from './knowledge-file-download-plan.mjs';
import {MOBILE_FILE_UPLOAD,MOBILE_FILE_CONVERT,MOBILE_FILE_SAVE,mobileBinaryUploadApproval,mobileBinaryUploadTarget,mobileUploadObservation} from './mobile-binary-upload.mjs';
import {mobileBinarySaveApproval,mobileBinarySaveObservation,MOBILE_EXTENSIBILITY_GET} from './mobile-binary-save.mjs';
import {binarySetting,ownedBinaryLibrary} from './mobile-binary-library.mjs';
import {guardrailBaselineInput} from './guardrail-baseline-read.mjs';
import {BASELINE_SAVE,BASELINE_READ,baselineApproval,baselineObservation} from './guardrail-baseline-write.mjs';
import {GUARDRAILS_SAVE,GUARDRAILS_READ,guardrailsApproval,guardrailObservation,guardrailHash} from './guardrails.mjs';
import {datasetDependencies} from './dataset-dependencies.mjs';
import {stageRenameApproval,stageRenameObservation,STAGES,STAGE_BATCH_RENAME} from './stage-rename.mjs';
import {environmentDefaultsApproval,environmentDefaultsObservation,ENV_DEFAULTS_GET,ENV_DEFAULTS_PATCH} from './environment-defaults.mjs';
import {configurationVaultPlan} from './configuration-vault-plan.mjs';
import {mobileExtensibilityVaultPlan} from './mobile-extensibility-vault-plan.mjs';
import {MOBILE_EXTENSIBILITY_PATCH} from './mobile-extensibility.mjs';
import {A2A_TEST,A2A_SAVE,a2aConnectionApproval} from './a2a-connection-approval.mjs';
import {CUSTOM_SEARCH_TEST,CUSTOM_SEARCH_SAVE,customSearchConnectionApproval} from './custom-search-connection-approval.mjs';
import {customSearchConnectionObservation} from './custom-search-connection-observation.mjs';
import {customSearchDeleteApproval} from './custom-search-delete-approval.mjs';
import {A2A_DISCOVER,a2aDiscoveryApproval,a2aDiscoveryOutcome,a2aDiscoveryContinuation} from './a2a-discovery.mjs';
import {a2aConnectionPlan,rejectRedactedA2aCard} from './a2a-connection-plan.mjs';
import {readA2aCleanupMetadata,readA2aProvisionalState} from './a2a-cleanup-metadata.mjs';
import {connectionDeleteObservation} from './connection-delete-observation.mjs';
import {portfolioRenameApproval,portfolioRenameObservation,PORTFOLIOS} from './portfolio-rename.mjs';
import {organizationRenameApproval,organizationRenameObservation,ORGANIZATION_GET,ORGANIZATION_RENAME} from './organization-rename.mjs';
import {settingsConfigurationApproval} from './settings-configuration-approval.mjs';
import {mobileConfigurationApproval} from './mobile-configuration-approval.mjs';
import {nativeMobileBuildApproval,NATIVE_MOBILE_BUILD} from './native-mobile-build-approval.mjs';
import {mobileConfigurationExpectation,verifyMobileConfiguration} from './mobile-configuration-proof.mjs';
import {readAssetConsumers} from './asset-consumers.mjs';
import {KB_CREATE,KB_DELETE,knowledgeBaseApproval,knowledgeBaseObservation} from './knowledge-base.mjs';
import { AI_TRIAL_CREATE, AI_TRIAL_DELETE, aiModelInventoryInput, aiModelTrialApproval, observeAiModelTrial } from './ai-model-trial.mjs';
import {knowledgeBaseReadInput,knowledgeFilePage,knowledgeFileDetailInput} from './knowledge-file-read.mjs';
import {KB_UPLOAD,knowledgeFileApproval,knowledgeFileObservation,knowledgeFileDetailObservation} from './knowledge-file-upload.mjs';
import {ownedConsumerDeletionApproval} from './owned-consumer-deletion-approval.mjs';
import {groupRoleAssignmentApproval,groupRoleAssignmentObservation} from './group-role-assignment-approval.mjs';
import {applicationRoleOverlapApproval,applicationRoleOverlapObservation} from './application-role-overlap.mjs';
import {readUserRoleUnion} from './user-role-union.mjs';
import {applicationRoleAssignmentApproval,applicationRoleAssignmentObservation} from './application-role-assignment-approval.mjs';
import { emptyRoleAssignmentApproval } from './empty-role-assignment-approval.mjs';
import {LIBRARY_PUBLISH,libraryPublicationApproval,LIBRARY_RELEASE,libraryReleaseApproval,verifyLibraryRelease} from './library-release-approval.mjs';
import {ASSET_DEPLOYMENT,assetDeploymentApproval} from './asset-deployment-approval.mjs';
import { externalLibraryStepApproval,externalLibraryDiscardApproval } from './external-library-approval.mjs';
import { groupMembershipApproval } from './group-membership-approval.mjs';
import { inactiveUserApproval, USER_BULK_CREATE } from './inactive-user-approval.mjs';
import { organizationRoleApproval } from './organization-role-approval.mjs';
import { groupApproval } from './group-approval.mjs';
import { assetCreationApproval } from './asset-creation-approval.mjs';
import { ipFilterApproval,IP_FILTER_DELETE } from './ip-filter-approval.mjs';
import {ipFilterDeleteScope,ipFilterDeleteObservation} from './ip-filter-delete-observation.mjs';
import { assetRevisionApproval,verifyRevisionPatch } from './asset-revision-approval.mjs';
import {stageAssetUpload,ASSET_UPLOAD} from './asset-upload.mjs';
import { downloadAssetSource,downloadGeneratedCode,downloadNativePackage,verifiedSourceUri } from './asset-source-download.mjs';
import { prepareSourceRevision } from './asset-source-revision.mjs';
import { assetBuildApproval, generatedCodeApproval, GENERATED_CODE } from './asset-build-approval.mjs';
import path from 'node:path';
// Tenant-aware access to the ODC public APIs and the internal Portal, with the authentication resolver of CONTRATO.md
// (per call, per tenant): the ODC Studio session first (bridge v32 portal-call / portal-session), then the credential in
// the Windows vault, and the private Windows prompt only when the tenant has nothing stored (no browser ever). Every read leaves a journal line; every
// write needs the user's words (only their sha256 is kept), an operationUuid, a receipt reserved before the send, the
// tenant guard, and is never resent: an uncertain outcome is reconciled by a read (odc_receipt).
// All collaborators are injected (lib.mjs wires the live ones; tests pass fakes of the bridge, vault and prompt).
import crypto from 'node:crypto';
import { authorizationContext as readAuthorizationContext } from '../../facade/authorization-context.mjs';
import { boundedRead, readCheckpoint, readOptions } from '../../facade/read-budget.mjs';
import { prepareRequest } from './request.mjs';
import { assetFilterComparison } from './asset-filter-comparison.mjs';
import { readCatalogPage } from './quality-pattern-pagination.mjs';
import { agentListPage,agentListInput,collectAgentClientPages } from './agent-list-page.mjs';
import { operationReceipt, confirmOperationReceipt,packagingReceipt,confirmPackagingReceipt,nativeBuildScope } from './operation-receipt.mjs';
import { prepareTimerActivation, verifyTimerActivation, validateTimerDeployment } from './timer-activation.mjs';
import { timerRunState } from './timer-run-state.mjs';
import { executeMcpImport, observeMcpImport, planMcpImport } from './mcp-import.mjs';
import { readPendingTimer } from './timer-pending-state.mjs';
import { readTimerDeployment } from './timer-deployment-state.mjs';
import { fail, publicError, redactValues } from './errors.mjs';
import { projectForAgent, trustedProjection } from './agent-projection.mjs';
import { DEPLOY, OPERATION_STATUS, TARGET_NAMES, effectOf, readable } from './effects.mjs';
import { isUuid, sha256, fingerprint } from './write-journal.mjs';
import { withOperationLog } from './operation-log.mjs';
import { PortalReadAdapter } from './portal-read.mjs';
import { StudioPortalBroker } from './studio-portal.mjs';
import { privatePortalSender } from './private-portal.mjs';
import { connectionDetailInput, projectConnectionDetail, projectConnectionTestStatus } from './connection-detail.mjs';
import {a2aConnectionObservation} from './a2a-connection-observation.mjs';
import {a2aDeleteApproval} from './a2a-delete-approval.mjs';
import { CONNECTION_NAME_AVAILABILITY_READS, connectionNameAvailabilityInput, connectionNameAvailabilityResult } from './connection-name-availability.mjs';
import { connectionHeaderPlan } from './connection-header-plan.mjs';
import { editConnectionHeader } from './connection-header-edit.mjs';
import { datasetCreationOutcome, datasetReconciliationInput, datasetCreationObservation } from './dataset-receipt.mjs';
import {EVALUATION_CREATE,EVALUATION_RUN,EVALUATION_DELETE,evaluationCreateApproval,evaluationOperationApproval,observeEvaluationCreation} from './evaluation-fixture.mjs';
import { DATASET_DELETE, datasetDeleteApproval } from './dataset-delete-approval.mjs';
import { DATASET_CREATE, datasetCreateApproval } from './dataset-create-approval.mjs';
import { dbConnectionApproval, dbDeleteApproval, dbEntityApproval } from './db-connection-approval.mjs';
import {entityUpdate} from './db-entity-contract.mjs';
import { prepareTimerWake, timerWakeInput, TIMER_CONFIGURATION, TIMER_APPLICATION_REVISION } from './portal-timer.mjs';
import { compareApplicationConfigurations } from './configuration-comparison.mjs';
import { timerConfigurationApproval } from './timer-configuration-approval.mjs';
import { PORTAL_READS, PORTAL_WRITES, checkSecretRefs, dbSecretTarget, envelope, rawInput, routeOf, routesModule, settingSecretTarget } from './portal-routes.mjs';

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const TYPED_PORTAL_READS = new Set(['monitoring.stages', 'monitoring.applications', 'monitoring.logs', 'monitoring.errors', 'monitoring.detail',
  'monitoring.trace', 'monitoring.traceLogs', 'monitoring.traceSummary', 'monitoring.traces', 'connections.providers', 'connections.list']);
// Failures that prove the request never left: the receipt settles as not-sent and the target is free again.
const NOT_SENT = new Set(['BRIDGE_ROOT_UNAVAILABLE', 'REQUEST_FILE_UNAVAILABLE', 'STUDIO_BUSY', 'INPUT_INVALID', 'OPERATION_NOT_FOUND', 'WRITE_BLOCKED', 'AUTH_NOT_CONFIGURED', 'AUTH_FAILED', 'AUTH_DISCOVERY_FAILED',
  'AUTH_DISCOVERY_INVALID', 'AUTH_AUTHORITY_BLOCKED', 'AUTH_RESPONSE_INVALID', 'LOCAL_RATE_LIMIT', 'REQUEST_TOO_LARGE', 'CONTRACT_UNSUPPORTED',
  'CONTRACT_INVALID', 'CONFIGURATION_INVALID', 'STUDIO_NOT_SIGNED_IN', 'HEADLESS_AUTH_UNAVAILABLE', 'NOT_ALLOWED', 'BAD_REQUEST', 'HOST_MISMATCH', 'WEB_SIGN_IN_REQUIRED',
  'PORTAL_ORIGIN_DENIED', 'PORTAL_OPERATION_NOT_FOUND', 'PORTAL_ROUTE_UNMAPPED', 'DB_CREDENTIAL_REQUIRED', 'SECRET_IN_ARGUMENTS', 'STUDIO_REQUIRED']);
const PORTAL_NOT_SENT = new Set(['PORTAL_AUTH_REQUIRED', 'PORTAL_ACCESS_DENIED', 'PORTAL_CONTRACT_CHANGED']);
const ASSET_GET = 'asset-repository-api-v1:get:/assets/{assetKey}';
const ASSET_CONSUMERS = 'dependency-management-api-v1:get:/assets/{assetKey}/consumers';
const MAX_WAIT_SECONDS = 600;
// odc_portal_routes answers stay short: beyond these, truncated says so and next names view/match to narrow.
export const MAX_ROUTE_SCREENS = 80, MAX_ROUTE_ACTIONS = 120;
const pick = (object, keys) => Object.fromEntries(keys.filter(k => object?.[k] !== undefined && object[k] !== null && typeof object[k] !== 'object').map(k => [k, object[k]]));

// hosted (the SSAM server answering a customer, facade/executor.mjs): only the customer's ODC Studio session is a path.
// auth "api-client" and "portal-credential" are refused (HOSTED_STUDIO_SESSION_ONLY), "auto" means the Studio session,
// no prompt ever opens (HOSTED_PROMPT_UNAVAILABLE), and the vault of the server is never asked: a secret named by
// secretRefs is read by the customer's bridge from the customer's vault.
export class OdcAccess {
  constructor({ catalog, tenants, studio, vault, prompt, portalBroker, journal = () => {}, receipts, requestFile, policyOf = () => null,
    defaultTenant, profiles = null, fixtureVaultStatus=windowsApiClientFixtureStatus, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, maxRequestBytes = 8 * 1024 * 1024, hosted = false }) {
    Object.assign(this, { catalog, tenants: tenants ?? { tenants: {} }, studio, vault, prompt, portalBroker, journal, receipts, requestFile, policyOf, sleep, now, maxRequestBytes, hosted });
    this.defaultTenant = defaultTenant ?? this.tenants.default;
    this.studioBrokers = new Map(); this.prompts = new Map(); this.cached = null;
    this.profiles = profiles;
    this.fixtureVaultStatus=fixtureVaultStatus;
    this.profileSessions = new Map();
  }

  // ---- tenants and the Studio
  a2aConnectionPlan({discoveryOperationUuid,tenant,...input}) {
    rejectRedactedA2aCard(input.card);
    if(input.configurationType==='url'&&!discoveryOperationUuid)
      fail('A2A_DISCOVERY_REQUIRED','URL mode requires discoveryOperationUuid of a confirmed A2A discovery receipt. Prepare the plan from that receipt without copying the displayed card.');
    if(!discoveryOperationUuid)return a2aConnectionPlan(input);
    const discovery=isUuid(discoveryOperationUuid)?this.receipts?.lookup(discoveryOperationUuid):null;
    const expected=discovery?.reconciliation?.a2aDiscovery;
    let agentUrl;try{agentUrl=new URL(input.agentUrl).href;}catch{agentUrl=null;}
    if(discovery?.state!=='confirmed'||discovery.identity?.kind!=='odc-portal'
      ||discovery.identity.operationId!==A2A_DISCOVER||!HOST.test(discovery.identity.tenant??'')
      ||tenant!==undefined&&tenant!==discovery.identity.tenant||!discovery.response?.card
      ||fingerprint(discovery.response.card)!==discovery.response.cardSha256
      ||expected?.name!==input.name||expected?.stageKey!==input.stage?.Key||expected?.agentUrl!==agentUrl)
      fail('A2A_DISCOVERY_INVALID','The confirmed A2A discovery receipt must match the tenant, connection name, stage and agent base URL. No request was sent.');
    if(input.card!==undefined&&fingerprint(input.card)!==fingerprint(discovery.response.card))
      fail('A2A_DISCOVERY_CARD_MISMATCH','The supplied card differs from the confirmed discovery receipt. Omit card and prepare the plan using discoveryOperationUuid.');
    return {...a2aConnectionPlan({...input,card:discovery.response.card},{receiptCard:true}),discoveryOperationUuid};
  }

  tenantInfo(host) {
    const entry = this.tenants.tenants?.[host];
    return { host, known: Boolean(entry), class: entry?.class ?? 'unknown', readOnly: entry?.readOnly === true, label: entry?.label ?? null };
  }
  async pickTenant(tenant) {
    if (tenant !== undefined) {
      const host = String(tenant).trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '');
      if (!HOST.test(host)) fail('INPUT_INVALID', 'tenant must be a host name such as personal-xxxx.outsystems.dev.');
      return host;
    }
    const signedIn = (await this.studioState()).sessions.filter(s => s.loggedIn);
    if (signedIn.length === 1) return signedIn[0].host;
    if (signedIn.length > 1) fail('TENANT_REQUIRED', 'The ODC Studio holds several sessions; pass tenant: ' + signedIn.map(s => s.host).join(', '));
    if (!this.defaultTenant) fail('TENANT_REQUIRED', 'Pass tenant.');
    return this.defaultTenant;
  }
  // The Studio as the facade sees it: running, bridge v32 answering auth-status, and its sessions per host (no secret).
  async studioState() {
    readCheckpoint('authentication');
    if (this.cached && this.now() - this.cached.at < 3000) return this.cached.value;
    let value;
    if (!(await this.studio.running().catch(() => false))) value = { running: false, connected: false, sessions: [], portalWindows: [] };
    else {
      try {
        const answer = await this.studio.call(['auth-status']);
        value = answer?.ok === true && Array.isArray(answer.sessions)
          ? { running: true, connected: true, bridge: answer.bridge ?? null, portalWindows: Array.isArray(answer.portalWindows) ? answer.portalWindows.map(w => pick(w, ['host', 'signedIn'])) : [],
              // The current v32 lists portal-call:secretRefs / portal-session:secretRefs; the first v32 has no capabilities.
              capabilities: Array.isArray(answer.capabilities) ? answer.capabilities.filter(c => typeof c === 'string').slice(0, 50) : [],
              sessions: answer.sessions.map(s => ({ host: String(s.host ?? '').toLowerCase(), loggedIn: s.loggedIn === true, user: s.user ?? s.email ?? null,
                tokenValidUntil: s.tokenValidUntil ?? null, ...(Array.isArray(s.permissions) ? { permissions: s.permissions.filter(p => typeof p === 'string').slice(0, 200) } : {}) })) }
          : { running: true, connected: false, sessions: [], portalWindows: [], hint: 'The attached bridge does not answer auth-status: attach bridge v32 or later (studio_attach).' };
      } catch { value = { running: true, connected: false, sessions: [], portalWindows: [], hint: 'The ODC Studio is open but its bridge did not answer: studio_attach (bridge v32 or later).' }; }
    }
    this.cached = { at: this.now(), value };
    return value;
  }
  session(state, host) { return state.sessions.find(s => s.host === host && s.loggedIn) ?? null; }

  // ---- resolver: public REST
  async resolvePublic(host, auth = 'auto') {
    if (!['auto', 'studio', 'api-client'].includes(auth)) fail('INPUT_INVALID', 'auth must be auto, studio or api-client.');
    if (this.hosted && auth === 'api-client') return hostedOnlyStudio(host, 'api-client');
    const studio = await this.studioState();
    const session = this.session(studio, host);
    if (this.hosted) return session ? { path: 'studio', host, user: session.user } : studioRefusal(studio, host, {}, true);
    if (auth !== 'api-client') {
      if (session) return { path: 'studio', host, user: session.user };
      if (auth === 'studio' || studio.running) {
        const vaultAvailable = await this.apiClientAvailable(host);
        return studioRefusal(studio, host, { vaultAvailable, ...(vaultAvailable ? { continuation: 'Repeat with auth:"api-client" to use the API Client stored in the vault.' } : {}) });
      }
    }
    if (await this.apiClientAvailable(host)) return { path: 'vault', host };
    if (session) return refusal('AUTH_NOT_CONFIGURED', 'No API Client in the vault for ' + host + '; the Studio session is the path for this tenant (auth:"auto").', { host });
    return this.openPrompt('api-client', host);
  }
  async apiClientAvailable(host) { return (await this.vault.apiClient(host).catch(() => ({ available: false })))?.available === true; }

  // ---- resolver: internal Portal
  async resolvePortal(host, auth = 'auto') {
    if (!['auto', 'studio', 'portal-credential'].includes(auth)) fail('INPUT_INVALID', 'auth must be auto, studio or portal-credential.');
    if (this.hosted && auth === 'portal-credential') return hostedOnlyStudio(host, 'portal-credential');
    const studio = await this.studioState();
    const session = this.session(studio, host);
    if (this.hosted && !session) return studioRefusal(studio, host, {}, true);
    if (auth !== 'portal-credential') {
      if (session) {
        if (studio.capabilities?.includes('portal-session:headless')) {
          const broker = this.studioBroker(host);
          const status = await broker.session('status');
          if (status?.ok === true && status.signedIn === true)
            return { path: 'studio-http', host, user: status.studioUser ?? session.user, broker };
        }
        if (auth === 'studio') return refusal('HEADLESS_AUTH_UNAVAILABLE',
          'The attached Studio has no authenticated headless Portal transport. No Portal window was opened.', { host });
        // Hosted, no credential profile, private sender or private download of the server is ever used.
        if (this.profiles && !this.hosted) {
          const resolved = await this.resolveProfilePortal(host, session.user);
          if (resolved.ok !== false && studio.capabilities?.includes('portal-private-call:headless:secretRefs')
              && typeof session.user === 'string' && session.user.trim()
              && String(resolved.user ?? '').trim().toLowerCase() === session.user.trim().toLowerCase())
            resolved.privateSender = privatePortalSender({ host, principal: session.user, optionalCsrf: studio.capabilities.includes('portal-private-call:optional-csrf'),
              mobileUpload:studio.capabilities.includes('portal-private-call:mobile-upload'),
              mobileVaultUpload:Number(/^v(\d+)$/.exec(studio.bridge??'')?.[1]??0)>=77,
              mobileBase64:Number(/^v(\d+)$/.exec(studio.bridge??'')?.[1]??0)>=82,
              apiClientVault:studio.capabilities.includes('portal-private-call:api-client-vault'),
              bridge: args => this.studio.call(args), requestFile: json => this.requestFile(json) });
          if(resolved.ok!==false&&studio.capabilities?.includes('portal-private-call:knowledge-download')
            &&typeof session.user==='string'&&session.user.trim()&&String(resolved.user??'').trim().toLowerCase()===session.user.trim().toLowerCase())
            resolved.privateKnowledgeDownload=privateKnowledgeDownloader({host,principal:session.user,bridge:args=>this.studio.call(args),requestFile:json=>this.requestFile(json)});
          if(resolved.ok!==false&&studio.capabilities?.includes('portal-private-call:mobile-download')
            &&typeof session.user==='string'&&session.user.trim()&&String(resolved.user??'').trim().toLowerCase()===session.user.trim().toLowerCase())
            resolved.privateMobileDownload=privateMobileDownloader({host,principal:session.user,bridge:args=>this.studio.call(args),requestFile:json=>this.requestFile(json)});
          return resolved;
        }
        return refusal(studio.capabilities?.includes('portal-session:headless') ? 'PORTAL_AUTH_REQUIRED' : 'HEADLESS_AUTH_UNAVAILABLE',
          'No authenticated headless Portal session is available; no window was opened.', { host });
      }
      if (auth === 'studio' || studio.running) {
        const credential = await this.portalCredentialAvailable(host);
        return studioRefusal(studio, host, { portalCredentialAvailable: credential, ...(credential ? { continuation: 'Repeat with auth:"portal-credential" to use the Portal account stored in the vault.' } : {}) });
      }
    }
    if (this.profiles && !this.hosted) return this.resolveProfilePortal(host, session?.user ?? null);
    const broker = await this.vaultBroker(host);
    if (broker.available) {
      if (broker.authenticated) return { path: 'vault', host, broker };
      return refusal('PORTAL_AUTH_REQUIRED', 'The Portal session from the vault credential is not open: call odc_portal_login.',
        { host, continuation: { tool: 'odc_portal_login', arguments: { tenant: host, auth: 'portal-credential' }, why: 'Signs in with the Portal account stored in the vault; then repeat.' } });
    }
    if (session) return refusal('AUTH_NOT_CONFIGURED', 'No Portal account in the vault for ' + host + '; an authenticated headless session is required (auth:"auto").', { host });
    return this.openPrompt('portal', host);
  }
  // Status only: whether the entry exists (Portal account, DB/<database> or Setting/<setting>), never its value.
  async portalCredentialAvailable(host, database, setting) { return (await this.vault.portal(host, database, setting).catch(() => ({ available: false })))?.available === true; }
  studioBroker(host) {
    if (!this.studioBrokers.has(host)) this.studioBrokers.set(host, new StudioPortalBroker({ host, bridge: args => this.studio.call(args), requestFile: json => this.requestFile(json) }));
    return this.studioBrokers.get(host);
  }
  async resolveProfilePortal(host, principal, { force = false } = {}) {
    if (this.hosted) return hostedOnlyStudio(host, 'portal-credential');
    const interactive = false;
    const selected = await this.profiles.resolve({ lane: 'odc', host, principal }, { interactive, force });
    // Nothing stored for this tenant (no profile and no SSAM/ODC3/<host>/Portal entry): the private prompt stores the
    // Portal account; an entry that exists, of any principal, is never overwritten through it.
    if (!selected.ok && selected.code === 'AUTH_REQUIRED' && !force && !(await this.portalCredentialAvailable(host)))
      return this.openPrompt('portal', host);
    if (!selected.ok) return refusal(selected.code, selected.reason ?? 'Private credential selection was cancelled.',
      { host, stage: 'authentication', candidateCount: selected.candidateCount, resumable: selected.resumable === true });
    const broker = await this.vaultBroker(host, selected);
    if (!broker.authenticated) {
      const result = await broker.authenticate();
      if (!result?.ok) {
        // Never silently try another profile after a rejected login. MFA/SSO challenges remain explicit.
        const code = result?.error?.code ?? result?.code ?? 'PORTAL_AUTH_FAILED';
        const needsSelection = ['PORTAL_AUTH_REQUIRED', 'PORTAL_AUTH_FAILED', 'PORTAL_LOGIN_REJECTED', 'AUTH_FAILED', 'COGNITO_NOT_AUTHORIZED'].includes(code);
        if (needsSelection)
          await this.profiles.resolve({ lane: 'odc', host, principal }, { interactive, force: true });
        return refusal(code, needsSelection ? 'The selected profile was unavailable or rejected. Choose or add a profile privately; nothing was resubmitted.'
          : 'The selected profile could not authenticate without interaction; no window was opened.',
          { host, stage: 'authentication', auth: { path: 'vault', host, user: selected.principal },
            ...(result?.authentication ? { authentication: pick(result.authentication, ['stage', 'cognitoEnabled', 'srpConfigured', 'redirectAvailable']) } : {}),
            ...(result?.error?.identityStage || result?.error?.identityHttpStatus ? { identity: pick(result.error, ['identityStage', 'identityHttpStatus']) } : {}),
            ...(result?.error?.code === 'PORTAL_LOGIN_PROVIDER_UNSUPPORTED' ? { provider: pick(result.error, ['reason', 'providerOrigin', 'providerPath', 'message']) } : {}),
            continuation: { tool: 'odc_portal_login', arguments: { tenant: host, auth: 'portal-credential' },
              why: needsSelection ? 'Finish the private profile selection and authenticate once.' : 'An authenticated headless session is required; the tool does not launch interactive SSO/MFA.' } });
      }
    }
    this.profileSessions.set(host, { principal, selected, broker });
    return { path: 'vault', host, user: selected.principal, broker };
  }
  async vaultBroker(host, profile = null) {
    const broker = this.portalBroker(host, profile);
    // Status only (never the secret); rechecked so a newly provisioned entry is visible next call.
    if (!broker.initializedAt || !broker.available) { await broker.initialize(); broker.initializedAt = this.now(); }
    return broker;
  }

  // The helper owns the form and confirms its live native window. No timestamp means "open".
  // Only concurrent calls share a promise; later calls always recheck and recover the actual window.
  // Hosted (servidor/fase4): no credential window ever opens on the server (HOSTED_PROMPT_UNAVAILABLE), whatever the action.
  async openPrompt(kind, host, database, setting, action = 'ensure') {
    if (this.hosted) return refusal('HOSTED_PROMPT_UNAVAILABLE', 'No credential prompt opens in hosted mode for ' + host + ': only what the user\'s own ODC Studio session '
      + '(and its vault, read by its bridge) already holds is used.', { host, kind });
    const opener = kind === 'api-client' ? this.prompt?.apiClient : this.prompt?.portal;
    if (typeof opener !== 'function')
      return refusal('AUTH_NOT_CONFIGURED', 'No Studio session and no stored credential for ' + host + '; no private prompt is available here.', { host, kind });
    const key = kind + ':' + host + ':' + (database ?? '') + ':' + (setting ?? '') + ':' + action;
    let pending = this.prompts.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() => kind === 'api-client' ? opener(host, action) : opener(host, database, setting, action));
      this.prompts.set(key, pending);
    }
    let window;
    try { window = await pending; } catch { window = { state: 'failed', code: 'CREDENTIAL_PROMPT_UNAVAILABLE' }; }
    finally { if (this.prompts.get(key) === pending) this.prompts.delete(key); }
    if (window?.state === 'cancelled') return refusal('CREDENTIAL_PROMPT_CANCELLED', 'The private credential dialog was cancelled. Use odc_portal_login action prompt to reopen it.', { host, kind, resumable: true, window });
    if (action === 'focus' && window?.visible === true && window?.foreground !== true)
      window = { ...window, code: 'CREDENTIAL_FOCUS_DENIED' };
    if (window?.visible !== true || window?.state !== 'visible' || window?.code) return refusal(window?.code ?? 'CREDENTIAL_PROMPT_WINDOW_UNAVAILABLE',
      'The private credential window could not be confirmed' + (window?.code === 'CREDENTIAL_FOCUS_DENIED' ? ' in the foreground.' : ' as visible.'),
      { host, kind, resumable: true, window: { state: window?.state ?? 'failed', visible: window?.visible === true, foreground: window?.foreground === true },
        continuation: { tool: 'odc_portal_login', arguments: { tenant: host, action: 'focus' }, why: 'Recover and focus the owned private prompt, verifying its live window.' } });
    return refusal(window.opened ? 'CREDENTIAL_PROMPT_OPENED' : 'CREDENTIAL_PROMPT_PENDING',
      'A live private credential window for ' + host + ' is verified visible. Enter credentials there, never in chat; repeat the original call after saving.',
      { host, kind, resumable: true, auth: { path: 'prompt', host }, window });
  }

  // ---- public REST
  async nativePackage({tenant,operationKey,operationUuid}) {
    let host;
    try {
      host=await this.pickTenant(tenant);
      const receipt=this.receipts.lookup(operationUuid);
      if(!receipt||receipt.identity?.tenant!==host||receipt.identity.kind!=='odc-public')
        fail('OPERATION_RECEIPT_MISMATCH','The native build receipt does not belong to this tenant.');
      const resolved=await this.resolvePublic(host,'api-client');
      if(resolved.ok===false)return resolved;
      const result=await downloadNativePackage({bridge:await this.vault.bridge(host),receipt,operationKey,
        directory:path.join(this.receipts.dir,'..','downloads','native-packages')});
      this.journal({tool:'portal',command:'native package download',outcome:'ok',note:'['+host+'] '+operationKey+' sha256='+result.sha256});
      return {...result,tenant:host,auth:authOf(resolved)};
    }catch(error){return {ok:false,...(host?{tenant:host}:{}),error:publicError(error)};}
  }
  async generatedCode({tenant,buildKey,operationUuid}) {
    let host;
    try {
      host=await this.pickTenant(tenant);
      const receipt=packagingReceipt(this.receipts,{operationUuid,tenant:host,buildKey});
      const resolved=await this.resolvePublic(host,'api-client');
      if(resolved.ok===false)return resolved;
      const result=await downloadGeneratedCode({bridge:await this.vault.bridge(host),buildKey,
        directory:path.join(this.receipts.dir,'..','downloads','generated-code')});
      this.journal({tool:'portal',command:'generated code download',outcome:'ok',note:'['+host+'] '+buildKey+' sha256='+result.sha256});
      const confirmed=confirmPackagingReceipt(this.receipts,receipt,result);
      return {...result,tenant:host,auth:authOf(resolved),...(confirmed?{receipt:receiptOf(confirmed)}:{})};
    }catch(error){return {ok:false,...(host?{tenant:host}:{}),error:publicError(error)};}
  }
  async assetRevision(input) {
    let host;
    try {
      host=await this.pickTenant(input.tenant);
      const existing=this.receipts.lookup(input.operationUuid);
      if(existing){
        if(existing.identity?.tenant!==host||existing.identity?.target?.assetKey!==input.assetKey||existing.identity.operationId!=='asset-repository-api-v1:post:/assets')
          fail('OPERATION_UUID_REUSED','This receipt belongs to another operation.');
        return answerExisting(existing,existing.identity.operationId,host);
      }
      const prepared=await prepareSourceRevision({input,host,directory:path.join(this.receipts.dir,'..','downloads','asset-sources'),
        lookup:id=>this.receipts.lookup(id),read:assetKey=>this.read({tenant:host,auth:'api-client',operationId:'asset-repository-api-v1:get:/assets/{assetKey}',path:{assetKey}})});
      if(input.uploadFormat==='source-uri'){
        const uri=await verifiedSourceUri({bridge:await this.vault.bridge(host),assetKey:input.assetKey,
          revisionNumber:input.expectedRevision,expectedSha256:input.expectedSha256});
        prepared.body={fileUri:uri};prepared.contentType='application/json';
      }
      const result=await this.write({tenant:host,auth:'api-client',operationId:'asset-repository-api-v1:post:/assets',
        body:prepared.body,contentType:prepared.contentType,authorize:input.authorize,operationUuid:input.operationUuid,confirmTenant:input.confirmTenant},
        {preparedSourceRevision:prepared});
      if(!result.ok)return result;
      const assetKey=result.data?.assetKey??result.data?.applicationKey,revision=result.data?.revision;
      if(assetKey!==input.assetKey||!Number.isInteger(revision)||revision<input.expectedRevision)
        return {...result,revisionCreatedVerified:false,revisionOutcome:'unverified-response'};
      const after=await this.read({tenant:host,auth:'api-client',operationId:'asset-repository-api-v1:get:/assets/{assetKey}/revisions/{revisionNumber}',path:{assetKey,revisionNumber:revision}});
      const verified=after.ok&&after.data?.assetKey===assetKey&&after.data?.revision===revision;
      const created=verified&&revision>input.expectedRevision;
      const settled=verified?this.receipts.reconcile(this.receipts.lookup(input.operationUuid),{state:'confirmed',observation:{operationId:after.operationId,assetKey,revision,status:after.status,newRevision:created}}):null;
      return {...result,revisionCreatedVerified:created,revisionOutcome:verified?(created?'new-revision':'existing-revision'):'read-back-unverified',...(settled?{receipt:receiptOf(settled)}:{})};
    }catch(error){return {ok:false,...(host?{tenant:host}:{}),error:publicError(error)};}
  }
  async assetSource({tenant,assetKey,revisionNumber,auth='api-client',kind='source'}) {
    let host;
    try {
      if(auth!=='api-client')fail('CONTRACT_UNSUPPORTED','Source download currently requires the explicitly selected API Client transport.');
      if(!['source','icon','signature'].includes(kind))fail('INPUT_INVALID','Asset download kind must be source, icon or signature.');
      host=await this.pickTenant(tenant);
      const resolved=await this.resolvePublic(host,auth);
      if(resolved.ok===false)return {...resolved,sent:false};
      const result=await downloadAssetSource({bridge:await this.vault.bridge(host),assetKey,revisionNumber,kind,
        directory:path.join(this.receipts.dir,'..','downloads',kind==='source'?'asset-sources':'asset-'+kind+'s')});
      this.journal({tool:'portal',command:'asset source download',outcome:'ok',note:'['+host+'] '+assetKey+' r'+revisionNumber+' sha256='+result.sha256});
      return {...result,tenant:host,auth:authOf(resolved)};
    }catch(error){return {ok:false,...(host?{tenant:host}:{}),error:publicError(error)};}
  }
  async read(input) { return projectForAgent(() => boundedRead({ scope: 'odc-public', input }, () => this.readWithinBudget(input))); }
  async readWithinBudget({ tenant, auth = 'auto', operationId, ...input }) {
    const start = new Date(this.now()).toISOString();
    let host;
    try {
      host = await this.pickTenant(tenant);
      const { operation } = this.catalog.get(operationId);
      if (!readable(operation)) fail('WRITE_BLOCKED', 'This operation changes the tenant: use odc_write with the user\'s words.');
      prepareRequest(this.catalog, operationId, input, this.config(host));
      const resolved = await this.resolvePublic(host, auth);
      if (resolved.ok === false) return { ...resolved, operationId, tenant: host };
      const sendRead = request => this.send(host, resolved, operationId, request, { write: false });
      const output = await readUserRoleUnion(operationId,input,request=>readCatalogPage(operationId,request,sendRead));
      const filterComparison = assetFilterComparison(operationId, input, output);
      this.journal({ start, tool: 'portal', command: 'read ' + operationId, outcome: output.ok ? 'ok' : 'native_error', note: noteOf(host, resolved, output) });
      return { ...output, tenant: host, auth: authOf(resolved),
        ...(filterComparison ? {filterComparison} : {}),
        ...(output.ok && operationId === TIMER_CONFIGURATION
          ? { configurationComparison: compareApplicationConfigurations(output.data) } : {}) };
    } catch (error) {
      this.journal({ start, tool: 'portal', command: 'read ' + operationId, outcome: 'error', note: '[' + (host ?? '?') + '] ' + (error.code ?? 'error') });
      return { ok: false, operationId, ...(host ? { tenant: host } : {}), error: publicError(error) };
    }
  }

  // secretRefs, like portalWrite's, is not a tool argument: only configurations passes it, for secret setting values
  // (SSAM/ODC3/<host>/Setting/<name> at /settings/<i>/value), and only the Studio path (bridge portal-call) sends it.
  async write(input, options) { return projectForAgent(() => this.writeRaw(input, options)); }

  async writeRaw({ tenant, auth = 'auto', operationId, authorize, operationUuid, confirmTenant, ...input }, { secretRefs = [], authorizationContext, timerConfigurationContext, settingsConfigurationContext, mobileConfigurationContext, assetCreationContext, assetRevisionContext, revisionPrecondition, preparedSourceRevision, assetBuildContext, ipFilterContext, groupContext, organizationRoleContext, portfolioRenameContext, organizationRenameContext, stageRenameContext, environmentDefaultsContext, inactiveUserContext, groupMembershipContext, emptyRoleAssignmentContext, applicationRoleAssignmentContext, applicationRoleOverlapContext, groupRoleAssignmentContext, groupOriginOperationUuid, userOriginOperationUuid, originOperationUuid, externalLibraryParent, externalLibraryDiscard } = {}) {
    const start = new Date(this.now()).toISOString();
    let host, receipt;
    try {
      host = await this.pickTenant(tenant);
      const info = this.tenantInfo(host);
      const { operation } = this.catalog.get(operationId);
      const effect = effectOf(operation, input.body);
      if (effect === 'read' || effect === 'search-post') fail('USE_ODC_READ', 'This operation does not change the tenant: use odc_read.');
      const policy = this.policyOf(host);
      if (policy && !policy.has(operationId)) fail('WRITE_BLOCKED', 'The tenant policy file does not list this operation.');
      if(preparedSourceRevision?.uploadFormat==='staged' && policy && !policy.has(ASSET_UPLOAD))
        fail('WRITE_BLOCKED','The tenant policy file does not allow the upload stage.');
      const request = prepareRequest(this.catalog, operationId, input, this.config(host));
      const refs = checkSecretRefs(host, secretRefs, input.body, { kind: 'Setting' }).map(({ pointer, target, field }) => ({ pointer, target, field }));
      precheck(authorize, operationUuid);
      const identity = { kind: 'odc-public', tenant: host, operationId, target: { ...(input.path ?? {}), ...pick(input.body, ['assetKey', 'applicationKey', 'agentKey', 'environmentKey', 'key', 'name', 'email', 'isActive', 'addToBuiltInIdentityProvider']),...(operationId===NATIVE_MOBILE_BUILD?pick(input.body,['buildKey','revision','mobilePlatform','mobileVersionNumber','mobileVersionCode']):{}),...([STAGE_BATCH_RENAME,ENV_DEFAULTS_PATCH].includes(operationId)?{bodySha256:fingerprint(input.body)}:{}),...(operationId===USER_BULK_CREATE&&Array.isArray(input.body?.records)?{records:input.body.records.map(r=>pick(r,['name','email','isActive','addToBuiltInIdentityProvider']))}:{}),...(operationId==='build-operations-api-v1:post:/build-operations'?pick(input.body,['assetRevision','buildType']):{}),...([LIBRARY_PUBLISH,ASSET_DEPLOYMENT].includes(operationId)?pick(input.body,['revision','operation','buildKey']):{}),...(preparedSourceRevision?{assetKey:preparedSourceRevision.assetKey}:{}) } };
      // Asset creation names are nested in the native request. Preserve them in
      // the receipt so later own-fixture operations can verify live identity.
      // Revision uploads share this POST but have no creation details.
      if(operationId==='asset-repository-api-v1:post:/assets' && typeof input.body?.assetCreationDetails?.assetName==='string')
        identity.target.name=input.body.assetCreationDetails.assetName;
      // One organization per tenant: its lock must not vary with the proposed
      // name. The separate request fingerprint binds that mutable body.
      if(operationId===ORGANIZATION_RENAME)identity.target={organization:true};
      const requestSha256 = fingerprint({ method: request.method, path: request.url.pathname,
        query: request.url.search, body: input.body ?? null, secretRefs: refs });
      const existing = this.receipts.lookup(operationUuid, identity, requestSha256);
      if (existing) {

        if(existing.reconciliation?.applicationRoleOverlap&&['accepted','uncertain'].includes(existing.state)){
          if(existing.authorization?.wordsSha256!==sha256(authorize))fail('AUTHORIZATION_CONTEXT_INVALID','Reconciliation requires the original authorization.');
          const proof=await this.reconcileApplicationRoleOverlap(existing,auth);
          return {...answerExisting(proof.receipt,operationId,host),readBack:proof.readBack};
        }
        if(existing.reconciliation?.groupRoleAssignment&&['accepted','uncertain'].includes(existing.state)){
          if(existing.authorization?.wordsSha256!==sha256(authorize))fail('AUTHORIZATION_CONTEXT_INVALID','Reconciliation requires the original authorization.');
          const proof=await this.reconcileGroupRoleAssignment(existing,auth);
          return {...answerExisting(proof.receipt,operationId,host),readBack:proof.readBack};
        }
        if(existing.reconciliation?.applicationRoleAssignment&&['accepted','uncertain'].includes(existing.state)){
          if(existing.authorization?.wordsSha256!==sha256(authorize))fail('AUTHORIZATION_CONTEXT_INVALID','Reconciliation requires the original authorization.');
          const proof=await this.reconcileApplicationRoleAssignment(existing,auth);
          return {...answerExisting(proof.receipt,operationId,host),readBack:proof.readBack};
        }

        if(existing.reconciliation?.environmentDefaults&&['accepted','uncertain'].includes(existing.state)){
          if(existing.authorization?.wordsSha256!==sha256(authorize))fail('AUTHORIZATION_CONTEXT_INVALID','Reconciliation requires the original authorization.');
          const proof=await this.reconcileEnvironmentDefaults(existing,auth);
          return {...answerExisting(proof.receipt,operationId,host),readBack:proof.readBack};
        }
        if(existing.reconciliation?.stageRename&&['accepted','uncertain'].includes(existing.state)){
          if(existing.authorization?.wordsSha256!==sha256(authorize))fail('AUTHORIZATION_CONTEXT_INVALID','Reconciliation requires the original authorization.');
          const proof=await this.reconcileStageRename(existing,auth);
          return {...answerExisting(proof.receipt,operationId,host),readBack:proof.readBack};
        }
        if(existing.reconciliation?.portfolioRename&&['accepted','uncertain'].includes(existing.state)){
          if(existing.authorization?.wordsSha256!==sha256(authorize))fail('AUTHORIZATION_CONTEXT_INVALID','Reconciliation requires the original authorization.');
          const proof=await this.reconcilePortfolioRename(existing,auth);
          return {...answerExisting(proof.receipt,operationId,host),readBack:proof.readBack};
        }
        if(existing.reconciliation?.organizationRename&&['accepted','uncertain'].includes(existing.state)){
          if(existing.authorization?.wordsSha256!==sha256(authorize))fail('AUTHORIZATION_CONTEXT_INVALID','Reconciliation requires the original authorization.');
          const proof=await this.reconcileOrganizationRename(existing,auth);
          return {...answerExisting(proof.receipt,operationId,host),readBack:proof.readBack};
        }
        if(existing.reconciliation?.mobileConfiguration && ['accepted','uncertain'].includes(existing.state)) {
          const proof=await this.reconcileMobileConfiguration(existing,auth);
          return {...answerExisting(proof.receipt,operationId,host),readBack:proof.readBack};
        }
        return answerExisting(existing, operationId, host);
      }
        if (revisionPrecondition && !assetRevisionContext) fail('AUTHORIZATION_CONTEXT_INVALID', 'Revision preconditions require a bound approval context. Nothing was sent.');
      if (!externalLibraryDiscard && !externalLibraryParent && !authorizationContext && !timerConfigurationContext && !settingsConfigurationContext && !mobileConfigurationContext && !assetCreationContext && !assetRevisionContext && !preparedSourceRevision && !assetBuildContext && !ipFilterContext && !groupContext && !organizationRoleContext && !portfolioRenameContext && !organizationRenameContext && !stageRenameContext && !environmentDefaultsContext && !inactiveUserContext && !groupMembershipContext && !emptyRoleAssignmentContext && !applicationRoleAssignmentContext && !groupRoleAssignmentContext && !applicationRoleOverlapContext) guardTenant(info, authorize, confirmTenant);
      else if (authorizationContext && operationId !== 'asset-repository-api-v1:delete:/assets/{assetKey}') fail('AUTHORIZATION_CONTEXT_INVALID', 'Context approval is currently supported only by the typed asset deletion.');
      const resolved = await this.resolvePublic(host, auth);
      if (resolved.ok === false) return { ...resolved, operationId, tenant: host, sent: false };
      if (refs.length && resolved.path !== 'studio') fail('STUDIO_REQUIRED', secretStudioRequired(host));
      let approval = timerConfigurationContext ? await timerConfigurationApproval({file:timerConfigurationContext,words:authorize,host,operationId,input,
        read:(id,path)=>this.read({tenant:host,auth,operationId:id,path}),
        pending:({applicationKey,environmentKey,timerKey})=>this.portalRead({tenant:host,operationId:'timers.pendingConfiguration',
          input:{screenVariables:{appid:applicationKey,stageid:environmentKey,id:timerKey,_appidInDataFetchStatus:1,_stageidInDataFetchStatus:1,_idInDataFetchStatus:1}}})}) : null;
      if(settingsConfigurationContext)approval=await settingsConfigurationApproval({file:settingsConfigurationContext,words:authorize,host,operationId,input,originOperationUuid,secretRefs:refs,
        lookup:id=>this.receipts.lookup(id),read:(id,path)=>this.send(host,resolved,id,{path},{write:false})});
      if(mobileConfigurationContext)approval=await mobileConfigurationApproval({file:mobileConfigurationContext,words:authorize,host,operationId,input,originOperationUuid,secretRefs:refs,
        lookup:id=>this.receipts.lookup(id),read:(id,path)=>this.send(host,resolved,id,{path},{write:false})});
      if (assetCreationContext) approval = await assetCreationApproval({file:assetCreationContext,words:authorize,host,operationId,input,
        readTemplate:async assetKey=>{
          const asset=await this.send(host,resolved,'asset-repository-api-v1:get:/assets/{assetKey}',{path:{assetKey}},{write:false});
          if(!asset.ok || !Number.isInteger(asset.data?.revision) || asset.data.revision<1)return {ok:false};
          const metadata=await this.send(host,resolved,'asset-repository-api-v1:get:/assets/{assetKey}/revisions/{revisionNumber}/metadata',
            {path:{assetKey,revisionNumber:asset.data.revision}},{write:false});
          return {ok:metadata.ok===true,data:{...asset.data,templateType:metadata.data?.templateType}};
        },
        read:query=>this.send(host,resolved,'asset-repository-api-v1:get:/assets',{query},{write:false})});
      if (assetRevisionContext) approval = await assetRevisionApproval({file:assetRevisionContext,words:authorize,host,operationId,input,
        precondition:revisionPrecondition,lookup:id=>this.receipts.lookup(id),
        readNotes:path=>this.send(host,resolved,'asset-repository-api-v1:get:/assets/{assetKey}/revisions/{revisionNumber}/release-notes',{path},{write:false}),
        read:path=>this.send(host,resolved,'asset-repository-api-v1:get:/assets/{assetKey}/revisions/{revisionNumber}',{path},{write:false})});
      if(assetBuildContext&&operationId===ASSET_DEPLOYMENT)approval=await assetDeploymentApproval({file:assetBuildContext,words:authorize,host,input,originOperationUuid,lookup:id=>this.receipts.lookup(id),read:(id,path)=>this.send(host,resolved,id,{path},{write:false})});
      else if(assetBuildContext&&operationId===NATIVE_MOBILE_BUILD)approval=await nativeMobileBuildApproval({file:assetBuildContext,words:authorize,host,input,originOperationUuid,lookup:id=>this.receipts.lookup(id),read:(id,args)=>this.send(host,resolved,id,args,{write:false})});
      else if(assetBuildContext)approval=await (operationId===LIBRARY_PUBLISH?libraryPublicationApproval:operationId===GENERATED_CODE?generatedCodeApproval:assetBuildApproval)({file:assetBuildContext,words:authorize,host,operationId,input,originOperationUuid,
        lookup:id=>this.receipts.lookup(id),read:path=>this.send(host,resolved,operationId===GENERATED_CODE?'build-operations-api-v1:get:/build-operations/{operationKey}':'asset-repository-api-v1:get:/assets/{assetKey}/revisions/{revisionNumber}',{path},{write:false})});
      if(preparedSourceRevision){
        if(operationId!=='asset-repository-api-v1:post:/assets')fail('AUTHORIZATION_CONTEXT_INVALID','Source revision approval is restricted to asset revision creation.');
        approval=preparedSourceRevision.approval;
      }
      if(ipFilterContext)approval=await ipFilterApproval({file:ipFilterContext,words:authorize,host,operationId,input,originOperationUuid,
        lookup:id=>this.receipts.lookup(id),read:(id,path)=>this.send(host,resolved,id,{path},{write:false})});
      if(groupContext)approval=await groupApproval({file:groupContext,words:authorize,host,operationId,input,originOperationUuid,
        lookup:id=>this.receipts.lookup(id),read:(id,path,query)=>this.send(host,resolved,id,{path,...(query?{query}:{})},{write:false})});
      if(organizationRoleContext)approval=await organizationRoleApproval({file:organizationRoleContext,words:authorize,host,operationId,input,originOperationUuid,
        lookup:id=>this.receipts.lookup(id),read:(id,path,query)=>this.send(host,resolved,id,{path,...(query?{query}:{})},{write:false})});
      const portfolioPrepared=portfolioRenameContext?await portfolioRenameApproval({file:portfolioRenameContext,words:authorize,host,operationId,input,
        read:id=>this.send(host,resolved,id,{}, {write:false})}):null;
      if(portfolioPrepared)approval=portfolioPrepared.approval;
      const organizationPrepared=organizationRenameContext?await organizationRenameApproval({file:organizationRenameContext,words:authorize,host,operationId,input,
        read:id=>this.send(host,resolved,id,{}, {write:false})}):null;
      if(organizationPrepared)approval=organizationPrepared.approval;
      const stagePrepared=stageRenameContext?await stageRenameApproval({file:stageRenameContext,words:authorize,host,operationId,input,
        read:id=>this.send(host,resolved,id,{}, {write:false})}):null;
      if(stagePrepared)approval=stagePrepared.approval;
      const defaultsPrepared=environmentDefaultsContext?await environmentDefaultsApproval({file:environmentDefaultsContext,words:authorize,host,operationId,input,
        read:(id,path)=>this.send(host,resolved,id,{path},{write:false})}):null;
      if(defaultsPrepared)approval=defaultsPrepared.approval;
      if(inactiveUserContext)approval=await inactiveUserApproval({file:inactiveUserContext,words:authorize,host,operationId,input,originOperationUuid,
        lookup:id=>this.receipts.lookup(id),read:(id,path,query)=>this.send(host,resolved,id,{path,...(query?{query}:{})},{write:false})});
      if(groupMembershipContext)approval=await groupMembershipApproval({file:groupMembershipContext,words:authorize,host,operationId,input,originOperationUuid,userOriginOperationUuid,
        lookup:id=>this.receipts.lookup(id),read:(id,path,query)=>this.send(host,resolved,id,{path,...(query?{query}:{})},{write:false})});
      if(applicationRoleOverlapContext)approval=await applicationRoleOverlapApproval({file:applicationRoleOverlapContext,words:authorize,host,operationId,input,originOperationUuid,groupOriginOperationUuid,userOriginOperationUuid,
        lookup:id=>this.receipts.lookup(id),read:(id,path,query)=>this.send(host,resolved,id,{path,...(query?{query}:{})},{write:false})});
      if(groupRoleAssignmentContext)approval=await groupRoleAssignmentApproval({file:groupRoleAssignmentContext,words:authorize,host,operationId,input,originOperationUuid,groupOriginOperationUuid,userOriginOperationUuid,
        lookup:id=>this.receipts.lookup(id),read:(id,path,query)=>this.send(host,resolved,id,{path,...(query?{query}:{})},{write:false})});
      if(applicationRoleAssignmentContext)approval=await applicationRoleAssignmentApproval({file:applicationRoleAssignmentContext,words:authorize,host,operationId,input,originOperationUuid,userOriginOperationUuid,
        lookup:id=>this.receipts.lookup(id),read:(id,path,query)=>this.send(host,resolved,id,{path,...(query?{query}:{})},{write:false})});
      if(emptyRoleAssignmentContext)approval=await emptyRoleAssignmentApproval({file:emptyRoleAssignmentContext,words:authorize,host,operationId,input,originOperationUuid,userOriginOperationUuid,
        lookup:id=>this.receipts.lookup(id),read:(id,path,query)=>this.send(host,resolved,id,{path,...(query?{query}:{})},{write:false})});
      if(externalLibraryParent) {
        approval=externalLibraryStepApproval({parentOperationUuid:externalLibraryParent,lookup:id=>this.receipts.lookup(id),words:authorize,host,operationId,operationUuid,input});
        guardTenant(info,authorize,confirmTenant,approval);
      }
      if(externalLibraryDiscard) {
        approval=await externalLibraryDiscardApproval({...externalLibraryDiscard,words:authorize,host,operationId,input,
          lookup:id=>this.receipts.lookup(id),readJob:key=>this.read({tenant:host,auth,operationId:'external-library-generation-api-v1:get:/generation-operations/{operationKey}',path:{operationKey:key}})});
        guardTenant(info,authorize,confirmTenant,approval);
      }
      if (effect === 'destructive' && !(operationId===ASSET_DEPLOYMENT&&assetBuildContext&&approval) && !externalLibraryDiscard && !externalLibraryParent && !ipFilterContext && !groupContext && !organizationRoleContext && !portfolioRenameContext && !organizationRenameContext && !stageRenameContext && !environmentDefaultsContext && !inactiveUserContext && !groupMembershipContext && !emptyRoleAssignmentContext && !applicationRoleAssignmentContext && !groupRoleAssignmentContext && !applicationRoleOverlapContext) {
        const names = await this.targetNames(host, resolved, operation, input);
        approval = readAuthorizationContext(authorizationContext, authorize, { lane: 'odc', host, operation: operationId, targets: [names[0]] });
        if (!approval) guardTarget(authorize, names);
      }
      if (authorizationContext || timerConfigurationContext || settingsConfigurationContext || mobileConfigurationContext || assetCreationContext || assetRevisionContext || preparedSourceRevision || assetBuildContext || ipFilterContext || groupContext || organizationRoleContext || portfolioRenameContext || organizationRenameContext || stageRenameContext || environmentDefaultsContext || inactiveUserContext || groupMembershipContext || emptyRoleAssignmentContext || applicationRoleAssignmentContext || groupRoleAssignmentContext || applicationRoleOverlapContext) guardTenant(info, authorize, confirmTenant, approval);
      const wordsSha256 = sha256(authorize);
      receipt = this.receipts.reserve({ operationUuid, identity, wordsSha256, requestSha256,
        ...(applicationRoleOverlapContext?{reconciliation:{applicationRoleOverlap:approval.applicationRoleOverlapExpectation}}:{}),
        ...(groupRoleAssignmentContext?{reconciliation:{groupRoleAssignment:approval.groupRoleExpectation}}:{}),
        ...(applicationRoleAssignmentContext?{reconciliation:{applicationRoleAssignment:approval.applicationRoleExpectation}}:{}),
        ...(mobileConfigurationContext ? {reconciliation:{mobileConfiguration:approval.extensibilityExpectation??mobileConfigurationExpectation(input.body)}} : {}),
        ...(stagePrepared?{reconciliation:{stageRename:{expected:stagePrepared.expected,before:stagePrepared.before}}}:{}),
        ...(defaultsPrepared?{reconciliation:{environmentDefaults:{expected:defaultsPrepared.expected,before:defaultsPrepared.before}}}:{}),
        ...(portfolioPrepared?{reconciliation:{portfolioRename:{expected:portfolioPrepared.expected,before:portfolioPrepared.before}}}:{}),
        ...(organizationPrepared?{reconciliation:{organizationRename:{expected:organizationPrepared.expected,before:organizationPrepared.before}}}:{}),
        plan: { ...(approval ? { authorizationContext: approval } : {}), method: request.method, path: request.url.pathname, query: request.url.search, bodySha256: input.body === undefined ? null : sha256(JSON.stringify(input.body)),
          ...(refs.length ? { secretRefs: refs } : {}) } });
      let output;
      // confirmTenant: the bridge v32 confirms every write host but the default one; the guard above already decided.
      try {
        if(preparedSourceRevision?.uploadFormat==='staged'){
          if(resolved.path!=='vault')fail('CONTRACT_UNSUPPORTED','Staged source upload requires the private API Client.');
          const bytes=Buffer.from(input.body.$base64,'base64');
          const sourceDigest=crypto.createHash('sha256').update(bytes).digest('hex');
          const staged=await stageAssetUpload({bridge:await this.vault.bridge(host),bytes,expectedSha256:sourceDigest,
            onStage:async stage=>{this.receipts.settle(receipt,{state:'sending',uploadStage:stage});}});
          if(!staged.ok)output={ok:false,operationId,...(staged.status?{status:staged.status}:{}),thrown:staged.state==='uncertain',
            error:{code:'ASSET_UPLOAD_INCOMPLETE',message:'The staged upload did not finish; no asset revision POST was sent.',stage:staged.stage}};
          else{
            input.body={fileUri:staged.fileUri};input.contentType='application/json';
            this.receipts.settle(receipt,{state:'sending',uploadStage:{phase:'revision-submitted',sha256:sourceDigest,byteLength:bytes.length}});
          }
        }
        if(!output)output = await this.send(host, resolved, operationId, input, { write: true, operationUuid: receipt.operationUuid, authorizeSha256: wordsSha256, confirmTenant: host, secretRefs: refs });
      }
      catch (error) { output = { ok: false, operationId, error: publicError(error), thrown: true }; }
      if (output.error) Object.assign(output, secretRefsHint(output.error, host));
      let state = outcomeOf(output);
      this.receipts.settle(receipt, { state, auth: resolved.path, status: output.status ?? null, errorCode: output.error?.code ?? null, response: pick(output.data, ['key', 'orgRoleKey', 'buildKey', 'analysisKey', 'operationKey', 'assetKey', 'status']) });
      if(applicationRoleOverlapContext&&['accepted','uncertain'].includes(state)){
        const proof=await this.reconcileApplicationRoleOverlap(receipt,auth);receipt=proof.receipt;state=receipt.state;output={...output,readBack:proof.readBack};
        if(state==='confirmed'){output.ok=true;if(output.error){output.writeError=output.error;delete output.error;}}
      }
      if(groupRoleAssignmentContext&&['accepted','uncertain'].includes(state)){
        const proof=await this.reconcileGroupRoleAssignment(receipt,auth);receipt=proof.receipt;state=receipt.state;output={...output,readBack:proof.readBack};
        if(state==='confirmed'){output.ok=true;if(output.error){output.writeError=output.error;delete output.error;}}
      }
      if(applicationRoleAssignmentContext&&['accepted','uncertain'].includes(state)){
        const proof=await this.reconcileApplicationRoleAssignment(receipt,auth);receipt=proof.receipt;state=receipt.state;output={...output,readBack:proof.readBack};
        if(state==='confirmed'){output.ok=true;if(output.error){output.writeError=output.error;delete output.error;}}
      }
      if(stagePrepared&&['accepted','uncertain'].includes(state)){
        const proof=await this.reconcileStageRename(receipt,auth);receipt=proof.receipt;state=receipt.state;output={...output,readBack:proof.readBack};
        if(state==='confirmed'){output.ok=true;if(output.error){output.writeError=output.error;delete output.error;}}
      }
      if(defaultsPrepared&&['accepted','uncertain'].includes(state)){
        const proof=await this.reconcileEnvironmentDefaults(receipt,auth);receipt=proof.receipt;state=receipt.state;output={...output,readBack:proof.readBack};
        if(state==='confirmed'){output.ok=true;if(output.error){output.writeError=output.error;delete output.error;}}
      }
      if(portfolioPrepared&&['accepted','uncertain'].includes(state)){
        const proof=await this.reconcilePortfolioRename(receipt,auth);receipt=proof.receipt;state=receipt.state;output={...output,readBack:proof.readBack};
        if(state==='confirmed'){output.ok=true;if(output.error){output.writeError=output.error;delete output.error;}}
      }
      if(organizationPrepared&&['accepted','uncertain'].includes(state)){
        const proof=await this.reconcileOrganizationRename(receipt,auth);receipt=proof.receipt;state=receipt.state;output={...output,readBack:proof.readBack};
        if(state==='confirmed'){output.ok=true;if(output.error){output.writeError=output.error;delete output.error;}}
      }
      if(mobileConfigurationContext && ['accepted','uncertain'].includes(state)){
        const proof=await this.reconcileMobileConfiguration(receipt,auth);
        receipt=proof.receipt;state=receipt.state;output={...output,readBack:proof.readBack};
      }
      if(assetRevisionContext && state==='accepted'){
        try{
          const readBack=await verifyRevisionPatch({path:input.path,body:input.body,
            read:path=>this.send(host,resolved,'asset-repository-api-v1:get:/assets/{assetKey}/revisions/{revisionNumber}',{path},{write:false}),
            readNotes:path=>this.send(host,resolved,'asset-repository-api-v1:get:/assets/{assetKey}/revisions/{revisionNumber}/release-notes',{path},{write:false})});
          output={...output,readBack};
          if(readBack.verified){receipt=this.receipts.reconcile(receipt,{state:'confirmed',observation:readBack});state='confirmed';}
        }catch{
          receipt=this.receipts.lookup(operationUuid,identity)??receipt;
          state=receipt.state;
          output={...output,readBack:{verified:false,reason:'verification-unavailable'}};
        }
      }
      this.journal({ start, tool: 'portal', command: 'write ' + operationId, outcome: state, note: noteOf(host, resolved, output) + ' words=sha256:' + wordsSha256.slice(0, 12) + ' receipt=' + receipt.operationUuid
        + (refs.length ? ' secretRefs=' + refs.length : '') });
      return { ...output, tenant: host, effect, auth: authOf(resolved), receipt: receiptOf(receipt),
        ...(refs.length ? { secretRefs: { count: refs.length, entries: [...new Set(refs.map(r => r.target))], resolvedBy: 'bridge, inside the ODC Studio' } } : {}),
        ...(state === 'uncertain' ? { reconcile: reconcileHint(operationId, host, receipt) } : {}) };
    } catch (error) {
      this.journal({ start, tool: 'portal', command: 'write ' + operationId, outcome: 'refused', note: '[' + (host ?? '?') + '] ' + (error.code ?? 'error') });
      return { ok: false, operationId, ...(host ? { tenant: host } : {}), sent: false, error: publicError(error), ...(receipt ? { receipt: receiptOf(receipt) } : {}) };
    }
  }

  async reconcileApplicationRoleOverlap(receipt,auth){
    let readBack;
    try{
      readBack=await applicationRoleOverlapObservation(receipt.reconciliation?.applicationRoleOverlap,
        (operationId,path,query)=>this.read({tenant:receipt.identity.tenant,auth,operationId,path,...(query?{query}:{})}));
      if(readBack.verified)receipt=this.receipts.reconcile(receipt,{state:'confirmed',observation:readBack});
    }catch{readBack={verified:false,reason:'verification-unavailable'};}
    return{receipt,readBack};
  }

  async reconcileGroupRoleAssignment(receipt,auth){
    let readBack;
    try{
      readBack=await groupRoleAssignmentObservation(receipt.reconciliation?.groupRoleAssignment,
        (operationId,path,query)=>this.read({tenant:receipt.identity.tenant,auth,operationId,path,...(query?{query}:{})}));
      if(readBack.verified)receipt=this.receipts.reconcile(receipt,{state:'confirmed',observation:readBack});
    }catch{readBack={verified:false,reason:'verification-unavailable'};}
    return{receipt,readBack};
  }

  async reconcileApplicationRoleAssignment(receipt,auth){
    let readBack;
    try{
      readBack=await applicationRoleAssignmentObservation(receipt.reconciliation?.applicationRoleAssignment,
        (operationId,path,query)=>this.read({tenant:receipt.identity.tenant,auth,operationId,path,...(query?{query}:{})}));
      if(readBack.verified)receipt=this.receipts.reconcile(receipt,{state:'confirmed',observation:readBack});
    }catch{readBack={verified:false,reason:'verification-unavailable'};}
    return{receipt,readBack};
  }

  async reconcileMobileConfiguration(receipt,auth){
    let readBack;
    try{
      const {tenant,operationId,target}=receipt.identity;
      const seen=await this.read({tenant,auth,operationId:operationId.replace(':patch:',':get:'),
        path:{applicationKey:target.applicationKey,environmentKey:target.environmentKey}});
      readBack=verifyMobileConfiguration(receipt,seen);
      if(readBack.verified)receipt=this.receipts.reconcile(receipt,{state:'confirmed',observation:readBack});
    }catch{readBack={verified:false,reason:'verification-unavailable'};}
    return {receipt,readBack};
  }

  config(host) { return { origin: 'https://' + host, maxRequestBytes: this.maxRequestBytes }; }

  // One public request through the resolved path. The Studio path writes the request file of the contract
  // (portal-call) and maps the bridge answer to the OdcBridge shape; the vault path is the existing OdcBridge.
  async send(host, resolved, operationId, input, { write, operationUuid, authorizeSha256, confirmTenant, secretRefs = [] }) {
    readCheckpoint('transport');
    if (resolved.path === 'vault') {
      if (secretRefs.length) fail('STUDIO_REQUIRED', secretStudioRequired(host));
      return (await this.vault.bridge(host)).execute(operationId, input, write ? 'write' : 'read');
    }
    const request = prepareRequest(this.catalog, operationId, input, this.config(host));
    let body, bodyBase64, contentType = request.headers['content-type'];
    if (request.body instanceof FormData) {
      const encoded = new Response(request.body);
      bodyBase64 = Buffer.from(await encoded.arrayBuffer()).toString('base64'); contentType = encoded.headers.get('content-type');
    } else if (Buffer.isBuffer(request.body)) bodyBase64 = request.body.toString('base64');
    else if (typeof request.body === 'string') body = JSON.parse(request.body);
    let file;
    try { file = await this.requestFile({ operationId, apiId: request.api.id, method: request.method, basePath: request.api.basePath,
      path: request.url.pathname.slice(request.api.basePath.length), query: request.url.search.replace(/^\?/, ''),
      ...(contentType ? { contentType } : {}), ...(body !== undefined ? { body } : {}), ...(bodyBase64 ? { bodyBase64 } : {}),
      write, ...(write ? { operationUuid, authorizeSha256, confirmTenant } : {}), ...(write && secretRefs.length ? { secretRefs } : {}) }); }
    catch (error) {
      if (!['BRIDGE_ROOT_UNAVAILABLE', 'REQUEST_FILE_UNAVAILABLE'].includes(error?.code)) throw error;
      return { ok: false, operationId, sent: false, error: publicError(error) };
    }
    const answer = await this.studio.call(['portal-call', file, '--tenant', host]);
    return studioAnswer(answer, operationId, host);
  }

  async reconcileStageRename(receipt,auth){
    const result=await this.read({tenant:receipt.identity.tenant,auth,operationId:STAGES});
    const readBack=stageRenameObservation(receipt.reconciliation.stageRename.expected,result);
    if(readBack.verified&&['accepted','uncertain'].includes(receipt.state))this.receipts.reconcile(receipt,{state:'confirmed',observation:readBack});
    return {receipt:this.receipts.lookup(receipt.operationUuid),readBack};
  }

  async reconcileEnvironmentDefaults(receipt,auth){
    const result=await this.read({tenant:receipt.identity.tenant,auth,operationId:ENV_DEFAULTS_GET,path:{environmentKey:receipt.identity.target.environmentKey}});
    const readBack=environmentDefaultsObservation(receipt.reconciliation.environmentDefaults.expected,result);
    if(readBack.verified&&['accepted','uncertain'].includes(receipt.state))this.receipts.reconcile(receipt,{state:'confirmed',observation:readBack});
    return {receipt:this.receipts.lookup(receipt.operationUuid),readBack};
  }

  async reconcilePortfolioRename(receipt,auth){
    const result=await this.read({tenant:receipt.identity.tenant,auth,operationId:PORTFOLIOS});
    const readBack=portfolioRenameObservation(receipt.reconciliation.portfolioRename.expected,result);
    if(readBack.verified&&['accepted','uncertain'].includes(receipt.state))this.receipts.reconcile(receipt,{state:'confirmed',observation:readBack});
    return {receipt:this.receipts.lookup(receipt.operationUuid),readBack};
  }

  async reconcileOrganizationRename(receipt,auth){
    const result=await this.read({tenant:receipt.identity.tenant,auth,operationId:ORGANIZATION_GET});
    const readBack=organizationRenameObservation(receipt.reconciliation.organizationRename.expected,result);
    if(readBack.verified&&['accepted','uncertain'].includes(receipt.state))this.receipts.reconcile(receipt,{state:'confirmed',observation:readBack});
    return {receipt:this.receipts.lookup(receipt.operationUuid),readBack};
  }

  // Names the user's words must contain to delete or undeploy: the target's own name (read first) or its key.
  async targetNames(host, resolved, operation, input) {
    // Role revocation names the assigned application role, not the user account.
    // Resolve that name by its exact live role key; a mismatched or ambiguous
    // read must not authorize a different role with the same display label.
    if (operation.id === 'user-access-management-api-v1:delete:/users/{key}/application-roles/{roleKey}') {
      const roleKey = input.path?.roleKey;
      const read = 'user-access-management-api-v1:get:/application-roles';
      const seen = await this.send(host, resolved, read, { query: { key: roleKey } }, { write: false }).catch(() => null);
      this.journal({ tool: 'portal', command: 'read ' + read, outcome: seen?.ok ? 'ok' : 'native_error', note: '[' + host + '] role name before revocation' });
      const rows = seen?.ok && Array.isArray(seen.data?.results) ? seen.data.results : [];
      const match = rows.length === 1 && rows[0].key === roleKey ? rows[0] : null;
      return [...(typeof match?.name === 'string' && match.name.trim() ? [match.name] : []), roleKey].filter(v => typeof v === 'string');
    }
    const asset = operation.id === DEPLOY;
    const spec = asset ? { read: 'asset-repository-api-v1:get:/assets/{assetKey}', fields: ['name'] } : TARGET_NAMES[operation.id];
    const path = asset ? { assetKey: input.body?.assetKey } : input.path ?? {};
    const keys = asset ? [input.body?.assetKey] : Object.values(input.path ?? {}).slice(-1);
    const names = [];
    if (spec && Object.values(path).every(v => v !== undefined)) {
      const seen = await this.send(host, resolved, spec.read, { path }, { write: false }).catch(() => null);
      this.journal({ tool: 'portal', command: 'read ' + spec.read, outcome: seen?.ok ? 'ok' : 'native_error', note: '[' + host + '] target name before a destructive write' });
      if (seen?.ok) for (const field of spec.fields) if (typeof seen.data?.[field] === 'string' && seen.data[field]) names.push(seen.data[field]);
    }
    return [...names, ...keys.filter(k => typeof k === 'string' || typeof k === 'number').map(String)];
  }

  // ---- receipts: show one, or reconcile an uncertain one by a read the user confirms
  async receipt({ operationUuid, reconcile }) {
    if (!isUuid(operationUuid)) return { ok: false, error: { code: 'INPUT_INVALID', message: 'operationUuid must be a UUID.' } };
    const existing = this.receipts.lookup(operationUuid);
    if (!existing) return { ok: false, error: { code: 'RECEIPT_NOT_FOUND', message: 'No write with this operationUuid.' } };
    if (!reconcile) return { ok: true, receipt: receiptOf(existing), identity: existing.identity,
      ...(existing.state==='confirmed'&&existing.identity?.operationId===A2A_DISCOVER
        ?{continuation:a2aDiscoveryContinuation(existing.operationUuid,existing.reconciliation?.a2aDiscovery)}:{}) };
    try {
      const { state, read, authorize } = reconcile;
      if (typeof authorize !== 'string' || authorize.trim().length < 8) fail('AUTHORIZATION_REQUIRED', 'Reconciling a write needs the user\'s words that state what the read showed.');
      const tenant = existing.identity.tenant;
      if(existing.identity.operationId===IP_FILTER_DELETE){
        const scope=ipFilterDeleteScope(existing,reconcile);
        if(existing.state==='confirmed')return {ok:true,receipt:receiptOf(existing)};
        if(!['accepted','uncertain'].includes(existing.state))fail('RECEIPT_NOT_RECONCILABLE','Only accepted or uncertain IP filter deletions can be reconciled.');
        const seen=await this.read({tenant,...read});
        const observation=ipFilterDeleteObservation(scope,seen);
        if(observation.verified)this.receipts.reconcile(existing,{state:'confirmed',observation});
        return {ok:observation.verified,receipt:receiptOf(this.receipts.lookup(operationUuid)),readBack:observation,read:seen};
      }
      if(existing.reconciliation?.aiModelTrial){
        const scope=existing.reconciliation.aiModelTrial;
        if(state!=='confirmed'||sha256(authorize)!==existing.authorization.wordsSha256||read?.operationId!=='aiModels.list'||!read.input
          ||fingerprint(read.input)!==fingerprint(aiModelInventoryInput(scope.portfolioKey)))
          fail('AI_MODEL_SCOPE_UNVERIFIED','Trial reconciliation requires original authorization and the exact recorded portfolio inventory.');
        if(existing.state==='confirmed')return {ok:true,receipt:receiptOf(existing)};
        if(!['accepted','uncertain'].includes(existing.state))fail('RECEIPT_NOT_RECONCILABLE','Only accepted or uncertain trial receipts can be reconciled.');
        const observation=await observeAiModelTrial(existing,(operationId,input)=>this.portalRead({tenant,auth:read.auth??'auto',operationId,input}));
        if(observation.verified)this.receipts.reconcile(existing,{state:'confirmed',observation});
        return {ok:observation.verified,receipt:receiptOf(this.receipts.lookup(operationUuid)),readBack:observation};
      }
      if(existing.reconciliation?.mobileBinarySave){
        const e=existing.reconciliation.mobileBinarySave;
        if(state!=='confirmed'||sha256(authorize)!==existing.authorization.wordsSha256||read?.tenant&&read.tenant!==tenant
          ||read?.operationId!==MOBILE_EXTENSIBILITY_GET||fingerprint(read?.path)!==fingerprint({applicationKey:e.applicationKey,environmentKey:e.environmentKey}))
          fail('MOBILE_BINARY_SAVE_UNVERIFIED','Binary save reconciliation requires original authorization and the exact recorded application/stage.');
        if(existing.state==='confirmed')return {ok:true,receipt:receiptOf(existing)};
        if(!['accepted','uncertain'].includes(existing.state))fail('RECEIPT_NOT_RECONCILABLE','Only accepted or uncertain native binary saves can be reconciled.');
        const proof=await this.reconcileMobileBinarySave(existing,read.auth??'auto');return {ok:proof.readBack.verified,receipt:receiptOf(proof.receipt),readBack:proof.readBack};
      }
      if(existing.reconciliation?.guardrailBaseline){
        if(state!=='confirmed'||sha256(authorize)!==existing.authorization.wordsSha256||read?.tenant&&read.tenant!==tenant
          ||read?.operationId!==BASELINE_READ||!read?.input||guardrailHash(read.input)!==guardrailHash(existing.reconciliation.guardrailBaseline.readInput))
          fail('GUARDRAIL_BASELINE_UNVERIFIED','Baseline reconciliation requires original authorization and its exact recorded stage/portfolio read.');
        if(existing.state==='confirmed')return {ok:true,receipt:receiptOf(existing)};
        if(!['accepted','uncertain'].includes(existing.state))fail('RECEIPT_NOT_RECONCILABLE','Only accepted or uncertain baseline saves can be reconciled.');
        const proof=await this.reconcileGuardrailBaseline(existing,read.auth??'auto');
        return {ok:proof.readBack.verified,receipt:receiptOf(proof.receipt),readBack:proof.readBack};
      }
      if(existing.reconciliation?.guardrails){
        if(state!=='confirmed'||sha256(authorize)!==existing.authorization.wordsSha256||read?.tenant&&read.tenant!==tenant
          ||read?.operationId!==GUARDRAILS_READ||!read?.input||guardrailHash(read.input)!==guardrailHash(existing.reconciliation.guardrails.readInput))
          fail('GUARDRAIL_BASELINE_UNVERIFIED','Guardrail reconciliation requires original authorization and its exact recorded read scope.');
        if(existing.state==='confirmed')return {ok:true,receipt:receiptOf(existing)};
        if(!['accepted','uncertain'].includes(existing.state))fail('RECEIPT_NOT_RECONCILABLE','Only an accepted or uncertain guardrail save can be reconciled.');
        const proof=await this.reconcileGuardrails(existing,read.auth??'auto');
        return {ok:proof.readBack.verified,receipt:receiptOf(proof.receipt),readBack:proof.readBack};
      }
      if([EVALUATION_CREATE,EVALUATION_DELETE].includes(existing.identity.operationId)){
        if(state!=='confirmed'||sha256(authorize)!==existing.authorization.wordsSha256||read?.tenant&&read.tenant!==tenant)
          fail('EVALUATION_BASELINE_UNVERIFIED','Evaluation reconciliation needs its original authorization and exact tenant.');
        if(existing.state==='confirmed')return {ok:true,receipt:receiptOf(existing)};
        let observation;
        if(existing.identity.operationId===EVALUATION_CREATE){
          observation=await observeEvaluationCreation(existing,(operationId,input)=>this.portalRead({tenant,auth:read?.auth??'auto',operationId,input}));
          if(observation.verified)existing.response={...existing.response,EvalId:observation.evaluationId};
        }else{
          const scope=existing.reconciliation?.evaluationDeletion;
          if(!scope||read?.operationId!=='agents.evaluation'||read?.input?.screenVariables?.id!==scope.evaluationId||read.input.screenVariables.portfolioId!==scope.portfolioKey)
            fail('EVALUATION_BASELINE_UNVERIFIED','Deletion reconciliation must read the exact owned evaluation.');
          const seen=await this.portalRead({tenant,auth:read.auth??'auto',operationId:'agents.evaluation',input:read.input});
          observation={verified:seen.ok===true&&seen.data?.NotFound===true,evaluationId:scope.evaluationId,notFound:seen.data?.NotFound===true};
        }
        if(!observation.verified)return {ok:false,receipt:receiptOf(existing),readBack:observation};
        const settled=this.receipts.reconcile(existing,{state:'confirmed',observation});return {ok:true,receipt:receiptOf(settled),readBack:observation};
      }
      if(existing.identity.operationId===EVALUATION_RUN){
        const p=read?.input?.inputParameters;
        if(state!=='confirmed'||sha256(authorize)!==existing.authorization.wordsSha256||read?.operationId!=='agents.evaluationRunStatus'
          ||read?.tenant&&read.tenant!==tenant||p?.EvaluationId!==existing.identity.target.evaluationId
          ||!isUuid(existing.response?.EvaluationRunId)||p?.EvaluationRunId!==existing.response.EvaluationRunId)
          fail('EVALUATION_RUN_IDENTITY_UNVERIFIED','Reconcile only the returned run UUID and its exact evaluation using the original authorization.');
        if(existing.state==='confirmed')return {ok:true,receipt:receiptOf(existing)};
        const seen=await this.portalRead({tenant,auth:read.auth??'auto',operationId:read.operationId,input:read.input});
        if(seen.ok!==true||seen.data?.HasFinished!==true||!['COMPLETED','FAIL','CANCELLED'].includes(seen.data?.Status))
          return {ok:false,code:'EVALUATION_RUN_PENDING',receipt:receiptOf(existing),read:seen};
        const settled=this.receipts.reconcile(existing,{state:'confirmed',observation:{evaluationId:p.EvaluationId,runId:p.EvaluationRunId,status:seen.data.Status,completionConfirmed:true,caseSuccessNotInferred:true}});
        return {ok:true,receipt:receiptOf(settled),read:seen};
      }
      if(existing.identity.operationId===DATASET_CREATE){
        const scope=datasetReconciliationInput(existing,reconcile);
        if(existing.state==='confirmed')return {ok:true,receipt:receiptOf(existing)};
        if(!['accepted','uncertain'].includes(existing.state))fail('RECEIPT_NOT_RECONCILABLE','Only accepted or uncertain dataset creates can be reconciled.');
        const seen=await this.portalRead({tenant,auth:read.auth??'auto',operationId:'agents.dataset',input:{screenVariables:read.input.screenVariables}});
        const observation=datasetCreationObservation(scope,seen);
        if(!observation.verified)return {ok:false,receipt:receiptOf(existing),readBack:observation};
        existing.response={...existing.response,DatasetId:observation.datasetId};
        const settled=this.receipts.reconcile(existing,{state:'confirmed',observation});
        return {ok:true,receipt:receiptOf(settled),readBack:observation};
      }
      if(existing.reconciliation?.mobileConfiguration){
        const {operationId,target}=existing.identity;
        if(state!=='confirmed'||sha256(authorize)!==existing.authorization.wordsSha256
          ||read?.operationId!==operationId.replace(':patch:',':get:')
          ||read?.tenant&&read.tenant!==tenant
          ||read?.path?.applicationKey!==target.applicationKey||read?.path?.environmentKey!==target.environmentKey)
          fail('MOBILE_CONFIGURATION_UNVERIFIED','Reconciliation must use the original authorization and exact mobile configuration target.');
        if(existing.state==='confirmed')return {ok:true,receipt:receiptOf(existing)};
        if(!['accepted','uncertain'].includes(existing.state))fail('RECEIPT_NOT_RECONCILABLE','Only accepted or uncertain mobile writes can be reconciled.');
        const proof=await this.reconcileMobileConfiguration(existing,read.auth??'auto');
        return {ok:proof.readBack.verified,receipt:receiptOf(proof.receipt),readBack:proof.readBack};
      }
      if(existing.timerActivation){
        if(state!=='confirmed' || sha256(authorize)!==existing.authorization.wordsSha256 || read?.operationId!=='timers.info')
          fail('TIMER_STATE_UNVERIFIED','Timer reconciliation requires its original authorization and typed timer state proof.');
        const t=existing.timerActivation,vars=read.input?.screenVariables;
        if(vars?.appid!==t.target.applicationKey || vars?.stageid!==t.target.environmentKey || vars?.id!==t.target.timerKey)
          fail('TIMER_STATE_UNVERIFIED','The reconciliation read must identify the exact timer, application and environment.');
        const portalRead=(operationId,screenVariables)=>this.portalRead({tenant,operationId,input:{screenVariables}});
        const scope=await portalRead('timers.deploymentStatus',vars),key=scope.data?.DeploymentKey;
        if(!scope.ok || !isUuid(key))fail('TIMER_STATE_UNVERIFIED','The scoped deployment key is unavailable.');
        const deployment=await this.read({tenant,auth:read.auth??'auto',operationId:OPERATION_STATUS.deployment.read,path:{operationKey:key}});
        if(!deployment.ok)fail('TIMER_STATE_UNVERIFIED','The configuration deployment could not be read.');
        validateTimerDeployment(existing,key,deployment.data);
        if(scope.data.HasOngoingDeployments!==false || deployment.data.status!=='Finished')
          return {ok:false,code:'TIMER_DEPLOYMENT_PENDING',receipt:receiptOf(existing),deployment,continuation:{tool:'odc_receipt',arguments:{operationUuid,reconcile},why:'The original deployment has not completed; read again without resending.'}};
        const verified=await verifyTimerActivation(t,{configuration:path=>this.read({tenant,operationId:TIMER_CONFIGURATION,path}),portalRead,deploymentKey:key});
        const settled=this.receipts.reconcile(existing,{state:'confirmed',observation:{operationId:'timers.info',deploymentKey:key,verified,discoveredKey:!existing.response?.DeploymentKey,operationSha256:sha256(JSON.stringify(deployment.data))}});
        return {ok:true,receipt:receiptOf(settled),timerVerification:verified};
      }
      const seen = existing.identity.kind === 'odc-portal' ? await this.portalRead({ tenant, ...read }) : await this.read({ tenant, ...read });
      if (!seen.ok) return { ok: false, error: { code: 'RECONCILE_READ_FAILED', message: 'The reconciliation read did not succeed; the receipt is unchanged.' }, read: seen };
      const settled = this.receipts.reconcile(existing, { state, observation: { operationId: read.operationId, status: seen.status ?? null,
        dataSha256: sha256(JSON.stringify(seen.data ?? seen.rows ?? null)), wordsSha256: sha256(authorize) } });
      return { ok: true, receipt: receiptOf(settled), read: seen };
    } catch (error) { return { ok: false, error: publicError(error), receipt: receiptOf(existing) }; }
  }

  async mobileFileDownloadWithinBudget({host,auth,input}) {
    const bad=()=>fail('MOBILE_DOWNLOAD_SCOPE_UNVERIFIED','Persisted file read requires a confirmed own binary save, upload and creation, and exact fresh application/setting metadata. No URL was requested.');
    if(!input||Object.keys(input).join(',')!=='saveOperationUuid'||!isUuid(input.saveOperationUuid))bad();
    const saved=this.receipts.lookup(input.saveOperationUuid),e=saved?.reconciliation?.mobileBinarySave;
    if(saved?.state!=='confirmed'||saved.identity?.tenant!==host||saved.identity.operationId!==MOBILE_FILE_SAVE||!e
      ||!isUuid(saved.authorization?.source?.threadId)||!isUuid(saved.authorization?.source?.messageId)||!/^[a-f0-9]{64}$/.test(saved.authorization?.wordsSha256??''))bad();
    const upload=this.receipts.lookup(e.uploadOperationUuid),origin=this.receipts.lookup(e.originOperationUuid),u=upload?.reconciliation?.mobileBinaryUpload;
    const sameGrant=r=>r?.authorization?.source&&saved.authorization?.source&&r.authorization.source.threadId===saved.authorization.source.threadId&&r.authorization.source.messageId===saved.authorization.source.messageId&&r.authorization.wordsSha256===saved.authorization.wordsSha256;
    if(upload?.state!=='confirmed'||upload.identity?.tenant!==host||upload.identity.operationId!==(u?.transportMode==='base64'?MOBILE_FILE_CONVERT:MOBILE_FILE_UPLOAD)||!u||!sameGrant(upload)
      ||origin?.state!=='confirmed'||origin.identity?.tenant!==host||origin.identity.operationId!=='asset-repository-api-v1:post:/assets'||origin.response?.assetKey!==e.applicationKey||!sameGrant(origin)
      ||!['applicationKey','environmentKey','settingKey','portfolioKey','originOperationUuid'].every(k=>isUuid(e[k])&&e[k]===u[k])
      ||e.transportMode!==u.transportMode||!mobileUploadObservation(u,{UploadProof:upload.response?.mobileUploadProof},e.uploadOperationUuid)
      ||upload.response?.mobileUploadProof?.objectUri!==e.objectUri||upload.response.mobileUploadProof.contentVerified!==true||upload.response.mobileUploadProof.signedUriExposed!==false)bad();
    if(e.isSecret===true)fail('MOBILE_SECRET_PERSISTED_READ_UNSUPPORTED','Secret binary settings hide their persisted URL and metadata. The existing temporary-content proof does not prove persisted bytes; no download was requested.');
    const resolved=await this.resolvePortal(host,auth);if(resolved.ok===false)return {...resolved,tenant:host,operationId:MOBILE_FILE_DOWNLOAD};
    if(typeof resolved.privateMobileDownload!=='function'||typeof resolved.broker?.downloadMobileFile!=='function')fail('HEADLESS_AUTH_UNAVAILABLE','A bridge with private persisted mobile-file download and matching authenticated profile is required. No URL was requested.');
    const asset=await this.read({tenant:host,auth:'api-client',operationId:'asset-repository-api-v1:get:/assets/{assetKey}',path:{assetKey:e.applicationKey}});
    if(!asset.ok||asset.data?.assetKey!==e.applicationKey||asset.data.assetType!=='MobileApplication'||asset.data.portfolioKey!==e.portfolioKey)bad();
    if(e.libraryKey){
      if(e.libraryKey!==u.libraryKey||e.libraryRevision!==u.libraryRevision||e.libraryOriginOperationUuid!==u.libraryOriginOperationUuid)bad();
      await ownedBinaryLibrary({scope:e,origin,host,lookup:id=>this.receipts.lookup(id),read:(operationId,path)=>this.read({tenant:host,auth:'api-client',operationId,path})});
    }else if(u.libraryKey||e.libraryOriginOperationUuid||u.libraryOriginOperationUuid)bad();
    const current=await this.read({tenant:host,auth:'api-client',operationId:MOBILE_EXTENSIBILITY_GET,path:{applicationKey:e.applicationKey,environmentKey:e.environmentKey}});
    const field=binarySetting(current.data,e),native=await this.portalRead({tenant:host,auth,operationId:'mobileExtensibility.setting',input:{screenVariables:e.screenVariables}});
    if(!mobileBinarySaveObservation(e,current,native).verified||!field?.name)bad();
    const expectedContent={settingName:field.name,filename:e.metadata.Name+'.'+e.metadata.Filetype,filetype:e.metadata.Filetype,byteLength:u.byteLength,sha256:u.contentSha256,uploadObjectUri:e.objectUri,...(e.libraryKey?{libraryRevision:e.libraryRevision}:{})};
    const result=await resolved.broker.downloadMobileFile({input:{screenVariables:e.screenVariables},expectedContent,privateDownload:resolved.privateMobileDownload,signal:readOptions('mobile-download').signal});
    const proof=result?.data?.FileDownloadProof;
    if(!proof||!isUuid(proof.downloadId)||proof.applicationKey!==e.applicationKey||proof.environmentKey!==e.environmentKey||proof.settingKey!==e.settingKey||proof.sha256!==u.contentSha256||proof.byteLength!==u.byteLength||proof.filename!==expectedContent.filename
      ||proof.contentReadBackVerified!==true||proof.persistedObjectVerified!==true||proof.signedUriExposed!==false||typeof proof.file!=='string'||!path.isAbsolute(proof.file)||path.basename(proof.file)!=='mobile-file-'+proof.downloadId+'.bin')bad();
    if(e.libraryKey?proof.libraryKey!==e.libraryKey||proof.libraryRevision!==e.libraryRevision:proof.libraryKey!==undefined||proof.libraryRevision!==undefined)bad();
    const safe=Object.fromEntries(['downloadId','applicationKey','environmentKey','settingKey','file','filename','mimeType','byteLength','sha256','contentReadBackVerified','persistedObjectVerified','signedUriExposed',...(e.libraryKey?['libraryKey','libraryRevision']:[])].map(k=>[k,proof[k]]));
    this.journal({start:new Date(this.now()).toISOString(),tool:'portal',command:'portal-read '+MOBILE_FILE_DOWNLOAD,outcome:'ok',note:'['+host+'] persisted binary content verified'});
    return {ok:true,tenant:host,operationId:MOBILE_FILE_DOWNLOAD,data:{FileDownloadProof:safe},verificationScope:'persisted-downloaded-content',physicalBlobDeletionVerified:false};
  }
  async knowledgeFileDownloadWithinBudget({host,auth,input}) {
    const bad=()=>fail('KNOWLEDGE_DOWNLOAD_SCOPE_UNVERIFIED','File download requires a private upload receipt, same-grant base creation and exact fresh source/file scope. No download request was sent.');
    if(!input||Object.keys(input).length!==2||!isUuid(input.uploadOperationUuid)||!isUuid(input.fileId))bad();
    const receipt=this.receipts.lookup(input.uploadOperationUuid),e=receipt?.reconciliation?.knowledgeFile;
    if(!receipt||receipt.identity?.tenant!==host||receipt.identity.operationId!==KB_UPLOAD||!['accepted','confirmed','uncertain'].includes(receipt.state)||!isUuid(e?.originOperationUuid))bad();
    const origin=this.receipts.lookup(e.originOperationUuid);
    if(!origin||origin.state!=='confirmed'||origin.identity?.tenant!==host||origin.identity.operationId!==KB_CREATE||origin.response?.KnowledgeBaseId!==e.knowledgeBaseId
      ||!origin.authorization?.source||!receipt.authorization?.source||!isUuid(receipt.authorization.source.threadId)||!isUuid(receipt.authorization.source.messageId)
      ||!/^([a-f0-9]{64})$/.test(receipt.authorization.wordsSha256??'')||!/^([a-f0-9]{64})$/.test(receipt.authorization.proposalSha256??'')
      ||origin.authorization.source.threadId!==receipt.authorization.source.threadId||origin.authorization.source.messageId!==receipt.authorization.source.messageId
      ||origin.authorization.wordsSha256!==receipt.authorization.wordsSha256||origin.authorization.proposalSha256!==receipt.authorization.proposalSha256)bad();
    const resolved=await this.resolvePortal(host,auth);if(resolved.ok===false)return{...resolved,tenant:host,operationId:KNOWLEDGE_FILE_DOWNLOAD};
    if(typeof resolved.privateKnowledgeDownload!=='function'||typeof resolved.broker?.downloadKnowledgeFile!=='function')
      fail('HEADLESS_AUTH_UNAVAILABLE','Bridge v66 or later and a matching authenticated private profile are required for typed file download. No URL is requested.');
    const read=(operationId,input)=>this.portalRead({tenant:host,auth,operationId,input});
    const scope={knowledgeBaseId:e.knowledgeBaseId,environmentKey:e.environmentKey,portfolioKey:e.screenVariables?.ActivePortfolioKey};
    const base=await read('knowledgeBases.detail',scope),b=base.data?.KnowledgeBaseDetails;
    if(!base.ok||base.data?.NotFound!==false||b?.KnowledgeBaseId!==e.knowledgeBaseId||b?.Name!==origin.reconciliation?.knowledgeBase?.name)bad();
    const sources=await read('knowledgeBases.dataSources',scope),list=sources.data?.DataSources?.List;
    if(!sources.ok||!Array.isArray(list)||list.filter(s=>s.DataSourceId===e.dataSourceId).length!==1)bad();
    const vars={KnowledgeBaseId:e.knowledgeBaseId,_knowledgeBaseIdInDataFetchStatus:1,Id:e.dataSourceId,_idInDataFetchStatus:1,stageid:e.environmentKey,_stageidInDataFetchStatus:1,ActivePortfolioKey:scope.portfolioKey};
    const stages=await read('knowledgeBases.sourceStages',{screenVariables:vars}),selected=stages.data?.Environments?.List?.filter(s=>s.Key===e.environmentKey);
    if(!stages.ok||stages.data?.NotFound_KB!==false||stages.data?.KnowledgeBaseDetails?.Name!==b.Name||stages.data.KnowledgeBaseDetails.PortfolioKey!==b.PortfolioKey||selected?.length!==1)bad();
    vars.SelectedStage=selected[0];const source=await read('knowledgeBases.dataSource',{screenVariables:vars});
    if(source.data?.DataSource?.Name!==list.find(s=>s.DataSourceId===e.dataSourceId).Name)bad();
    Object.assign(vars,{SearchKeyword:'',StartIndex:0,FileStatusFilter:{List:[]},SortAttribute:'',SortDirection:''});
    const files=await read('knowledgeBases.files',{screenVariables:vars}),plan=knowledgeFileDownloadPlan({expected:{...e,screenVariables:vars},fileId:input.fileId,base,source,files});
    const native=await resolved.broker.downloadKnowledgeFile({input:plan.input,expectedContent:plan.expectedContent,privateDownload:resolved.privateKnowledgeDownload,signal:readOptions('knowledge-download').signal});
    const proof=native?.data?.FileDownloadProof;
    if(!proof||!isUuid(proof.downloadId)||proof.fileId!==input.fileId||proof.sha256!==e.contentSha256||proof.byteLength!==e.byteLength||proof.filename!==e.filename||proof.mimeType!==e.mimeType
      ||typeof proof.file!=='string'||!path.isAbsolute(proof.file)||path.basename(proof.file)!=='knowledge-file-'+proof.downloadId+'.bin'
      ||proof.contentReadBackVerified!==true||proof.ingestionVerified!==false||proof.signedUriExposed!==false)
      fail('KNOWLEDGE_DOWNLOAD_UNVERIFIED','Native private file read did not prove the recorded content.');
    if(['accepted','uncertain'].includes(receipt.state))this.receipts.reconcile(receipt,{state:'confirmed',observation:{operationId:KNOWLEDGE_FILE_DOWNLOAD,fileId:input.fileId,sha256:proof.sha256,byteLength:proof.byteLength,contentReadBackVerified:true,ingestionVerified:false}});
    const safe=Object.fromEntries(['downloadId','fileId','file','filename','mimeType','byteLength','sha256','contentReadBackVerified','ingestionVerified','signedUriExposed'].map(k=>[k,proof[k]]));
    this.journal({start:new Date(this.now()).toISOString(),tool:'portal',command:'portal-read '+KNOWLEDGE_FILE_DOWNLOAD,outcome:'ok',note:'['+host+'] private content hash verified; ingestion not proved'});
    return{ok:true,tenant:host,operationId:KNOWLEDGE_FILE_DOWNLOAD,auth:{path:resolved.path,host},data:{FileDownloadProof:safe},uploadReceipt:receiptOf(this.receipts.lookup(receipt.operationUuid)),verificationScope:'downloaded-content',ingestionVerified:false};
  }

  // ---- internal Portal
  async portalRead(input) { return projectForAgent(() => boundedRead({ scope: 'odc-portal', input }, () => this.portalReadWithinBudget(input))); }
  async portalReadWithinBudget({ tenant, auth = 'auto', operationId, input = {}, maxPages = 3 }) {
    const start = new Date(this.now()).toISOString();
    let host;
    try {
      host = await this.pickTenant(tenant);
      if(operationId===API_CLIENT_VAULT_STATUS){
        // Hosted, the vault of the SSAM server is never probed.
        if (this.hosted) return refusal('HOSTED_STUDIO_SESSION_ONLY', 'The API Client fixture status reads the vault of the SSAM server, which is never used in hosted mode.', { host });
        const result=await apiClientVaultStatus({host,input,lookup:id=>this.receipts.lookup(id),
          writesDir:path.join(path.dirname(this.receipts.dir),'writes'),session:this.session(await this.studioState(),host),probe:this.fixtureVaultStatus});
        this.journal({start,tool:'portal',command:'portal-read '+operationId,outcome:'ok',note:'['+host+'] exact local fixture destination presence observed; no credential exposed'});
        return result;
      }
      if(operationId===KNOWLEDGE_FILE_DOWNLOAD)return await this.knowledgeFileDownloadWithinBudget({host,auth,input});
      if(operationId===MOBILE_FILE_DOWNLOAD)return await this.mobileFileDownloadWithinBudget({host,auth,input});
      routeOf(operationId, false);
      if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) fail('INPUT_INVALID', 'maxPages must be an integer from 1 to 10.');
      const resolved = await this.resolvePortal(host, auth);
      if (resolved.ok === false) return { ...resolved, operationId, tenant: host,
        ...(resolved.resumable ? { continuation: { tool: 'odc_portal_read', arguments: { tenant: host, auth, operationId, input, maxPages }, why: 'Finish the private profile selection, then repeat this read.' } } : {}) };
      let output;
      if (operationId === 'connections.detail') {
        const body = await resolved.broker.callScreenservice({ operationId, write: false, input: connectionDetailInput(input) });
        output = envelope(operationId, { data: projectConnectionDetail(body?.data, input) });
      } else if (TYPED_PORTAL_READS.has(operationId)) {
        const adapter = new PortalReadAdapter({ target: 'odc3', origin: resolved.broker.origin, broker: resolved.broker, timeoutMs: 30000 });
        output = await adapter.execute({ operationId, input });
        if (output.ok && operationId === 'monitoring.traces' && output.nextPageAvailable) {
          const offset = Number(output.pagination.NextPageOffset);
          output = { ...output, continuation: offset <= 10000 ? {
            tool: 'odc_portal_read', arguments: { tenant: host, auth, operationId, input: { ...input, offset } },
            why: 'Continue the same trace search with identical scope and filters.'
          } : { tool: 'odc_portal_read', arguments: { tenant: host, auth, operationId },
            why: 'The next offset exceeds the supported limit; narrow the time window instead.' } };
        }
        if (output.ok && ['monitoring.logs', 'monitoring.errors'].includes(operationId)) {
          let pages = 1, page = output;
          const rows = [...output.rows];
          let dropped = output.droppedOutOfScope ?? 0;
          while (page.nextPageAvailable && !page.truncated && pages < maxPages) {
            readCheckpoint('transport');
            const next = await adapter.execute({ operationId, input: { ...input, offset: page.pagination.NextPageOffset } });
            if (!next.ok) { output = { ...next, partial: true, rows, count: rows.length, pages, complete: false }; break; }
            page = next; pages++; rows.push(...next.rows); dropped += next.droppedOutOfScope ?? 0;
          }
          if (output.ok) output = { ...page, rows, count: rows.length, pages, complete: !page.nextPageAvailable && !page.truncated && dropped === 0,
            ...(dropped ? { droppedOutOfScope: dropped, note: 'Out-of-scope rows were excluded; an empty result does not prove absence of logs.' } : {}),
            ...(page.nextPageAvailable ? { continuation: { tool: 'odc_portal_read', arguments: { tenant: host, auth, operationId, maxPages,
              input: { ...input, offset: page.pagination.NextPageOffset } }, why: 'Continue with the same application, environment and filters.' } } : {}) };
        }
      } else {
        let raw = rawInput(operationId==='connections.alternateInventory'?alternateConnectionsInput(input):['knowledgeBases.detail','knowledgeBases.dataSources'].includes(operationId)
          && Object.hasOwn(input,'knowledgeBaseId') ? knowledgeBaseReadInput(input) : input);
        raw=agentListInput(operationId,raw);
        if(operationId==='apiClients.list')apiClientInventoryInput(raw);
        if(operationId==='apiClients.detail'&&(!isUuid(raw.screenVariables?.id)||raw.screenVariables._idInDataFetchStatus!==1
          ||Object.keys(raw.screenVariables).sort().join(',')!=='_idInDataFetchStatus,id'
          ||Object.keys(raw.inputParameters).length||Object.keys(raw.clientVariables).length))fail('INPUT_INVALID','API Client detail requires only the exact id UUID and _idInDataFetchStatus=1.');
        if(['mobileExtensibility.stages','mobileExtensibility.revision','mobileExtensibility.setting'].includes(operationId))raw=await mobileExtensibilityReadInput(operationId,raw,(operationId,input)=>resolved.broker.callScreenservice({operationId,write:false,input}));
        if(operationId==='guardrails.baseline')raw=await guardrailBaselineInput(raw,(operationId,input)=>resolved.broker.callScreenservice({operationId,write:false,input}));
        if(operationId==='agents.evaluationRuns')raw=await evaluationRunsInput(raw,input=>this.portalRead({tenant:host,auth,operationId:'agents.evaluations',input,maxPages:10}));
        if(operationId==='agents.evaluationOngoingRun'){
          const s=raw.screenVariables;
          if(!isUuid(s?.id)||!isUuid(s?.portfolioId))fail('INPUT_INVALID','The current evaluation UUID and portfolio UUID are required.');
          const variables={id:s.id,_idInDataFetchStatus:1,portfolioId:s.portfolioId,_portfolioIdInDataFetchStatus:1};
          const detail=await this.portalRead({tenant:host,auth,operationId:'agents.evaluation',input:{screenVariables:variables}});
          if(detail.ok!==true||detail.data?.NotFound!==false||detail.data?.Evaluation?.EvalId!==s.id||detail.data.Evaluation.PortfolioKey!==s.portfolioId)
            fail('EVALUATION_BASELINE_UNVERIFIED','The ongoing-run dependency must come from the exact current evaluation.');
          raw={...raw,screenVariables:{...variables,GetEvaluation:{...detail.data,DataFetchStatus:1}}};
        }
        if (CONNECTION_NAME_AVAILABILITY_READS.has(operationId)) connectionNameAvailabilityInput(raw);
        const body = await resolved.broker.callScreenservice({ operationId, write: false, input: raw });
        output = envelope(operationId, operationId === 'connections.testStatus' ? { data: projectConnectionTestStatus(body?.data) } : body);
        if(output.ok&&operationId==='apiClients.list'){
          const {nextInput,...inventory}=await collectApiClientInventory({raw,result:output,maxPages,read:async input=>{
            readCheckpoint('transport');return envelope(operationId,await resolved.broker.callScreenservice({operationId,write:false,input}));
          }});
          output={...output,...inventory,...(nextInput?{continuation:{tool:'odc_portal_read',arguments:{tenant:host,auth,operationId,input:nextInput,maxPages},why:'Continue with the same API Client filters; native zero pagination counters are not used.'}}:{})};
        }
        if(output.ok&&operationId==='connections.alternateInventory')output={...output,data:alternateConnectionsResult(input,output.data)};
        if(output.ok&&operationId==='agents.datasetEvaluations')output={...output,dependencyState:await datasetDependencies({datasetId:raw.screenVariables?.DatasetId,native:output.data,read:(id,input,maxPages)=>this.portalRead({tenant:host,auth,operationId:id,input,...(maxPages?{maxPages}:{})})})};
        if(output.ok&&operationId==='knowledgeBases.files')
          output={...output,pagination:knowledgeFilePage(output.data,{offset:raw.screenVariables?.StartIndex??0})};
        if (output.ok && CONNECTION_NAME_AVAILABILITY_READS.has(operationId))
          output = { ...output, nameAvailability: connectionNameAvailabilityResult(raw, output.data) };
        if(output.ok&&['agents.datasets','agents.evaluations','agents.evaluationRuns','agents.evaluationHistory'].includes(operationId)&&Number(output.data?.Page?.Limit)===0&&output.data?.MaxRecords!==undefined){
          const collected=await collectAgentClientPages({operationId,data:output.data,input:raw,maxPages,read:async nextInput=>{
            readCheckpoint('transport');return envelope(operationId,await resolved.broker.callScreenservice({operationId,write:false,input:nextInput}));
          }});
          const {nextInput,...pageInfo}=collected;
          output={...output,...pageInfo,...(nextInput?{continuation:{tool:'odc_portal_read',arguments:{tenant:host,auth,operationId,input:nextInput,maxPages},why:'Continue the same native list scope; rows are aggregated separately from the unchanged wire data.'}}:{})};
        }else if (output.ok) output = { ...output, ...agentListPage(operationId, output.data, raw) };
      }
      if(operationId==='timers.latestDeployment'&&output.ok){
        const deploymentState=await readTimerDeployment(input,output.data,{
          asset:path=>this.read({tenant:host,operationId:'asset-repository-api-v1:get:/assets/{assetKey}',path}),
          deployments:query=>this.read({tenant:host,operationId:'portfolio-api-v2:get:/deployed-assets',query}),
          revision:path=>this.read({tenant:host,operationId:TIMER_APPLICATION_REVISION,path}),
        });
        output={...output,deploymentState};
      }
      if(operationId==='timers.pendingConfiguration'&&output.ok){
        const configurationState=await readPendingTimer(input,{
          configuration:path=>this.read({tenant:host,operationId:TIMER_CONFIGURATION,path}),
          application:path=>this.read({tenant:host,operationId:TIMER_APPLICATION_REVISION,path}),
          portalRead:async(id,screenVariables)=>envelope(id,await resolved.broker.callScreenservice({operationId:id,input:{screenVariables},write:false})),
        });
        output={...output,configurationState,warning:output.warning+' The native pending list alone does not prove absence. configurationState compares only the selected timer; application-wide absence and atomicity are not proven.'};
      }
      this.journal({ start, tool: 'portal', command: 'portal-read ' + operationId, outcome: output.ok ? 'ok' : 'native_error', note: '[' + host + '] auth=' + resolved.path + (output.ok ? '' : ' ' + (output.error?.code ?? '')) });
      return { ...output, ...(operationId==='timers.currentRun'&&output.ok?{executionState:timerRunState(output.data)}:{}), tenant: host, auth: authOf(resolved) };
    } catch (error) {
      this.journal({ start, tool: 'portal', command: 'portal-read ' + operationId, outcome: 'error', note: '[' + (host ?? '?') + '] ' + (error.code ?? 'error') });
      return { ok: false, operationId, ...(host ? { tenant: host } : {}), error: publicError(error) };
    }
  }

  // secretRefs is not a tool argument: only the typed helpers of this class pass it, naming vault entries
  // (SSAM/ODC3/<host>/DB/<name>) and the empty placeholders of the input they fill. Only the bridge reads the value,
  // inside the ODC Studio, for the Studio Portal window; any other path is refused before the reservation (CONTRATO.md,
  // wave 2 item 1: a secret value never passes through this process).
  async reconcileA2aConnection(receipt,auth){
    let readBack;
    try{
      const observed=await this.portalRead({tenant:receipt.identity.tenant,auth,operationId:'connections.detail',
        input:{connectionId:receipt.reconciliation.a2aConnection.connectionId,providerId:'a2a'}});
      readBack=a2aConnectionObservation(receipt,observed);
      if(readBack.verified)receipt=this.receipts.reconcile(receipt,{state:'confirmed',observation:readBack});
    }catch(error){readBack={verified:false,error:publicError(error)};}
    return {receipt,readBack};
  }
  async reconcileCustomSearchConnection(receipt,auth){
    let readBack;
    try{
      const observed=await this.portalRead({tenant:receipt.identity.tenant,auth,operationId:'connections.detail',
        input:{connectionId:receipt.reconciliation.customSearchConnection.connectionId,providerId:'customAISearch'}});
      readBack=customSearchConnectionObservation(receipt,observed);
      if(readBack.verified)receipt=this.receipts.reconcile(receipt,{state:'confirmed',observation:readBack});
    }catch(error){readBack={verified:false,error:publicError(error)};}
    return {receipt,readBack};
  }
  async reconcileKnowledgeFile(receipt,auth){
    let readBack;
    try{
      const result=await this.portalRead({tenant:receipt.identity.tenant,auth,operationId:'knowledgeBases.files',
        input:{screenVariables:receipt.reconciliation.knowledgeFile.screenVariables}});
      readBack=knowledgeFileObservation(receipt,result);
      if(readBack.verified){
        const detail=await this.portalRead({tenant:receipt.identity.tenant,auth,operationId:'knowledgeBases.fileDetail',
          input:knowledgeFileDetailInput(receipt.reconciliation.knowledgeFile,readBack.fileId)});
        const detailProof=knowledgeFileDetailObservation(receipt,readBack.fileId,detail);
        readBack={...readBack,detail:detailProof,ingestionVerified:detailProof.ingestionVerified,
          indexedContentCountsVerified:detailProof.indexedContentCountsVerified===true};
      }
      if(readBack.verified)receipt=this.receipts.reconcile(receipt,{state:'confirmed',observation:readBack});
    }catch(error){readBack={verified:false,error:publicError(error)};}
    return {receipt,readBack};
  }
  async reconcileKnowledgeBase(receipt,auth){
    let readBack;
    try{
      const observed=await this.portalRead({tenant:receipt.identity.tenant,auth,operationId:'knowledgeBases.list',input:{}});
      readBack=knowledgeBaseObservation(receipt,observed);
      if(readBack.verified)receipt=this.receipts.reconcile(receipt,{state:'confirmed',observation:readBack});
    }catch(error){readBack={verified:false,error:publicError(error)};}
    return {receipt,readBack};
  }
  async reconcileGuardrails(receipt,auth){
    let readBack;
    try{readBack=guardrailObservation(receipt,await this.portalRead({tenant:receipt.identity.tenant,auth,operationId:GUARDRAILS_READ,input:receipt.reconciliation.guardrails.readInput}));
      if(readBack.verified){receipt.response={...receipt.response,SavedGuardrailId:readBack.guardrailId};receipt=this.receipts.reconcile(receipt,{state:'confirmed',observation:readBack});}
    }catch{readBack=guardrailObservation(receipt,null);}
    return {receipt,readBack};
  }
  async reconcileGuardrailBaseline(receipt,auth){
    let readBack;
    try{readBack=baselineObservation(receipt,await this.portalRead({tenant:receipt.identity.tenant,auth,operationId:BASELINE_READ,input:receipt.reconciliation.guardrailBaseline.readInput}));
      if(readBack.verified){receipt.response={...receipt.response,Id:readBack.guardrailId};receipt=this.receipts.reconcile(receipt,{state:'confirmed',observation:readBack});}
    }catch{readBack=baselineObservation(receipt,null);}
    return {receipt,readBack};
  }
  async reconcileMobileBinarySave(receipt,auth){
    const e=receipt.reconciliation.mobileBinarySave,tenant=receipt.identity.tenant;
    let readBack={verified:false,reason:'read-back-unavailable'};
    try{const current=await this.read({tenant,auth:'api-client',operationId:MOBILE_EXTENSIBILITY_GET,path:{applicationKey:e.applicationKey,environmentKey:e.environmentKey}});
      const native=await this.portalRead({tenant,auth,operationId:'mobileExtensibility.setting',input:{screenVariables:e.screenVariables}});
      readBack=mobileBinarySaveObservation(e,current,native);
    }catch{}
    if(readBack.verified)this.receipts.reconcile(receipt,{state:'confirmed',observation:readBack});
    return {receipt:this.receipts.lookup(receipt.operationUuid),readBack};
  }
  async reconcileApiClientDeletion(receipt,auth){
    const expected=receipt.reconciliation?.apiClientFixture;
    let inventory;try{if(receipt.state!=='confirmed')inventory=await this.portalRead({tenant:receipt.identity.tenant,auth,operationId:'apiClients.list',maxPages:10,
      input:{screenVariables:{StartIndex:0,MaxRecords:100,Filter:{NameContains:'',Status:''}}}});}catch{}
    const previous=receipt.reconciliations?.at(-1)?.observation;
    const verified=receipt.state==='confirmed'?previous?.verified===true&&previous.scope==='complete-unfiltered-api-client-inventory'
      &&previous.key===expected?.key&&previous.name===expected?.name&&previous.inventoryComplete===true:apiClientAbsent(expected,inventory);
    const readBack={verified,key:expected?.key,name:expected?.name,
      scope:'complete-unfiltered-api-client-inventory',inventoryComplete:verified||inventory?.complete===true,vaultCleanupConfirmed:false};
    if(verified&&['accepted','uncertain'].includes(receipt.state))this.receipts.reconcile(receipt,{state:'confirmed',observation:readBack});
    if(verified)readBack.vaultCleanupConfirmed=await this.cleanupApiClientFixtureVault(this.receipts.lookup(receipt.operationUuid));
    return {receipt:this.receipts.lookup(receipt.operationUuid),readBack};
  }
  async cleanupApiClientFixtureVault(receipt){
    if(receipt?.state!=='confirmed')return false;
    if(receipt.vaultCleanup?.vaultRemoved===true)return true;
    const expected=receipt.reconciliation?.apiClientFixture,host=receipt.identity?.tenant;
    try{
      const studio=await this.studioState(),session=this.session(studio,host);
      if(!session?.user||!studio.capabilities?.includes('portal-api-client-fixture-cleanup'))return false;
      const file=await this.requestFile({schema:'ssam-api-client-fixture-cleanup/1',creationOperationUuid:expected.creationOperationUuid,
        deletionOperationUuid:receipt.operationUuid,authorizeSha256:receipt.authorization.wordsSha256});
      const result=await this.studio.call(['portal-api-client-fixture-cleanup',file,'--tenant',host]);
      if(result?.ok!==true||result.host!==host||String(result.user??'').toLowerCase()!==session.user.toLowerCase()
        ||result.key!==expected.key||result.name!==expected.name||result.creationOperationUuid!==expected.creationOperationUuid
        ||result.deletionOperationUuid!==receipt.operationUuid||result.vaultRemoved!==true||result.remoteDeletionVerified!==true||result.rawValueExposed!==false)return false;
      const proof=pick(result,['host','user','key','name','creationOperationUuid','deletionOperationUuid','vaultRemoved','remoteDeletionVerified','rawValueExposed']);
      this.receipts.settle(receipt,{state:'confirmed',vaultCleanup:proof});return true;
    }catch{return false;}
  }
  async portalWrite(input, options) { return projectForAgent(() => OdcAccess.prototype.portalWriteRaw.call(this, input, options)); }

  async portalWriteRaw({ tenant, auth = 'auto', operationId, input = {}, authorize, operationUuid, confirmTenant, target, authorizationContext, vaultFile }, { secretRefs = [], preparedConnectionApproval, preparedMcpImport, preparedEntityImport, preparedHeaderEdit, externalLibraryParent } = {}) {
    const start = new Date(this.now()).toISOString();
    let host, receipt;
    try {
      host = await this.pickTenant(tenant);
      const info = this.tenantInfo(host);
      routeOf(operationId, true);
      const effect = PORTAL_WRITES[operationId].effect;
      const activation = ['timers.pause','timers.resume'].includes(operationId);
      let raw = operationId === 'timers.run' || activation ? timerWakeInput(rawInput(input)) : rawInput(input);
      if(vaultFile!==undefined){
        if(![MOBILE_FILE_UPLOAD,MOBILE_FILE_CONVERT].includes(operationId)||typeof vaultFile!=='string'||!/^[A-Za-z0-9_.-]{1,64}$/.test(vaultFile)||secretRefs.length)
          fail('INPUT_INVALID','vaultFile names one Setting vault entry for the native mobile binary upload only.');
        secretRefs=[{pointer:'/inputParameters/'+(operationId===MOBILE_FILE_CONVERT?'BinaryData':'FileContent'),target:'SSAM/ODC3/'+host+'/Setting/'+vaultFile,field:'password'}];
      }
      const refs = checkSecretRefs(host, secretRefs, raw,{kind:vaultFile!==undefined?'SettingFile':'DB'});
      if([GUARDRAILS_SAVE,BASELINE_SAVE].includes(operationId)&&refs.length)fail('INPUT_INVALID','Guardrail policy writes do not accept secretRefs.');
      precheck(authorize, operationUuid);
      const binarySaveTarget=operationId===MOBILE_FILE_SAVE?{applicationKey:raw.inputParameters?.ApplicationKey,environmentKey:raw.inputParameters?.EnvironmentKey,settingKey:raw.inputParameters?.ExtensibilitySettingInfo?.Setting?.Key}:null;
      if(binarySaveTarget&&(!Object.values(binarySaveTarget).every(isUuid)||refs.length))fail('INPUT_INVALID','Native binary save needs exact UUIDs and no secretRefs.');
      const timerTarget = operationId === 'timers.run' || activation ? { environmentKey: raw.inputParameters.StageKey,
        applicationKey: raw.inputParameters.ApplicationKey, timerKey: raw.inputParameters.TimerKey } : null;
      const identity = { kind: 'odc-portal', tenant: host, operationId, target: operationId===API_CLIENT_CREATE?{apiClientFixtureName:raw.inputParameters?.OIDCClientCreate?.Name}:operationId===API_CLIENT_DELETE?{apiClientKey:raw.inputParameters?.Key}:binarySaveTarget??([MOBILE_FILE_UPLOAD,MOBILE_FILE_CONVERT].includes(operationId)?mobileBinaryUploadTarget(authorizationContext):operationId===BASELINE_SAVE
        ?{environmentKey:raw.inputParameters?.EnvironmentId,portfolioKey:raw.inputParameters?.PortfolioKey}
        :operationId===GUARDRAILS_SAVE
        ?{applicationKey:raw.inputParameters?.AppId,environmentKey:raw.inputParameters?.EnvironmentId,agentElementId:raw.inputParameters?.AgentElementId}
        :[EVALUATION_RUN,EVALUATION_DELETE].includes(operationId)?{evaluationId:raw.inputParameters?.EvaluationId}:timerTarget ?? target ?? { inputSha256: sha256(JSON.stringify(raw.inputParameters)) }) };
      const existing = this.receipts.lookup(operationUuid, identity);
      if (existing) {
        if([API_CLIENT_CREATE,API_CLIENT_DELETE].includes(operationId)&&existing.authorization?.wordsSha256!==sha256(authorize))fail('AUTHORIZATION_CONTEXT_INVALID','API Client receipts require their original human authorization.');
        if(operationId===API_CLIENT_DELETE&&existing.reconciliation?.apiClientFixture&&['accepted','uncertain','confirmed'].includes(existing.state)){
          const proof=await this.reconcileApiClientDeletion(existing,auth);
          return {...answerExisting(proof.receipt,operationId,host),ok:proof.readBack.verified,deletionConfirmed:proof.readBack.verified,readBack:proof.readBack,
            ...(!proof.readBack.verified?{error:{code:'API_CLIENT_DELETE_UNVERIFIED',message:'A complete unfiltered inventory did not prove absence. Reconcile the original receipt; never resend.'}}:{})};
        }
        if(existing.reconciliation?.customSearchDeletion&&['accepted','uncertain'].includes(existing.state)){
          if(existing.authorization?.wordsSha256!==sha256(authorize))fail('AUTHORIZATION_CONTEXT_INVALID','Cleanup reconciliation requires original authorization.');
          const result=await this.dbDeleteReadBack(host,auth,{...existing.reconciliation.customSearchDeletion,operationUuid},answerExisting(existing,operationId,host));
          if(result.receipt?.state==='confirmed'&&result.error){result.writeError=result.error;delete result.error;}
          if(result.continuation)result.continuation={tool:'odc_portal_write',arguments:{tenant:host,auth,operationId,input,authorize,operationUuid,confirmTenant},why:'Read-only reconciliation of this deletion UUID; never resend.'};
          return result;
        }
        if(existing.reconciliation?.mobileBinarySave&&['accepted','uncertain'].includes(existing.state)){
          if(existing.authorization?.wordsSha256!==sha256(authorize))fail('AUTHORIZATION_CONTEXT_INVALID','Binary save reconciliation requires original authorization.');
          const proof=await this.reconcileMobileBinarySave(existing,auth);return {...answerExisting(proof.receipt,operationId,host),readBack:proof.readBack};
        }
        if([MOBILE_FILE_UPLOAD,MOBILE_FILE_CONVERT].includes(operationId)&&existing.authorization?.wordsSha256!==sha256(authorize))fail('AUTHORIZATION_CONTEXT_INVALID','Upload receipt requires the original authorization.');
        if(existing.reconciliation?.guardrailBaseline&&['accepted','uncertain'].includes(existing.state)){
          if(existing.authorization?.wordsSha256!==sha256(authorize))fail('AUTHORIZATION_CONTEXT_INVALID','Reconciliation requires original authorization.');
          const proof=await this.reconcileGuardrailBaseline(existing,auth);
          return {...answerExisting(proof.receipt,operationId,host),readBack:proof.readBack};
        }
        if(existing.reconciliation?.guardrails&&['accepted','uncertain'].includes(existing.state)){
          if(existing.authorization?.wordsSha256!==sha256(authorize))fail('AUTHORIZATION_CONTEXT_INVALID','Reconciliation requires original authorization.');
          const proof=await this.reconcileGuardrails(existing,auth);
          return {...answerExisting(proof.receipt,operationId,host),readBack:proof.readBack};
        }
        if(existing.reconciliation?.evaluation&&['accepted','uncertain'].includes(existing.state)){
          if(existing.authorization?.wordsSha256!==sha256(authorize))fail('AUTHORIZATION_CONTEXT_INVALID','Reconciliation requires the original authorization.');
          const readBack=await observeEvaluationCreation(existing,(id,input)=>this.portalRead({tenant:host,auth,operationId:id,input}));
          if(readBack.verified){existing.response={...existing.response,EvalId:readBack.evaluationId};this.receipts.reconcile(existing,{state:'confirmed',observation:readBack});}
          return {...answerExisting(this.receipts.lookup(operationUuid),operationId,host),readBack};
        }
        if (existing.reconciliation?.aiModelTrial && ['accepted', 'uncertain'].includes(existing.state)) {
          if (existing.authorization?.wordsSha256 !== sha256(authorize)) fail('AUTHORIZATION_CONTEXT_INVALID', 'Reconciliation requires the original authorization.');
          const readBack = await observeAiModelTrial(existing, (id, input) => this.portalRead({ tenant: host, auth, operationId: id, input }));
          if (readBack.verified) this.receipts.reconcile(existing, { state: 'confirmed', observation: readBack });
          return { ...answerExisting(this.receipts.lookup(operationUuid), operationId, host), readBack };
        }
        if(existing.reconciliation?.knowledgeFile&&['accepted','uncertain'].includes(existing.state)){
          if(existing.authorization?.wordsSha256!==sha256(authorize))fail('AUTHORIZATION_CONTEXT_INVALID','Reconciliation requires the original authorization.');
          const proof=await this.reconcileKnowledgeFile(existing,auth);
          return {...answerExisting(proof.receipt,operationId,host),readBack:proof.readBack};
        }
        if([CUSTOM_SEARCH_TEST,CUSTOM_SEARCH_SAVE].includes(operationId)&&existing.authorization?.wordsSha256!==sha256(authorize))
          fail('AUTHORIZATION_CONTEXT_INVALID','Custom search receipt requires original authorization.');
        if(operationId===CUSTOM_SEARCH_SAVE&&existing.reconciliation?.customSearchConnection&&['accepted','uncertain'].includes(existing.state)){
          const proof=await this.reconcileCustomSearchConnection(existing,auth);
          return {...answerExisting(proof.receipt,operationId,host),readBack:proof.readBack};
        }
        if([A2A_TEST,A2A_SAVE,A2A_DISCOVER].includes(operationId)&&existing.authorization?.wordsSha256!==sha256(authorize))
          fail('AUTHORIZATION_CONTEXT_INVALID','A2A receipt reconciliation requires the original authorization.');
        if(operationId===A2A_SAVE&&existing.reconciliation?.a2aConnection&&['accepted','uncertain'].includes(existing.state)){
          const proof=await this.reconcileA2aConnection(existing,auth);
          return {...answerExisting(proof.receipt,operationId,host),readBack:proof.readBack};
        }
        if(existing.reconciliation?.knowledgeBase&&['accepted','uncertain'].includes(existing.state)){
          if(existing.authorization?.wordsSha256!==sha256(authorize))fail('AUTHORIZATION_CONTEXT_INVALID','Reconciliation requires the original authorization.');
          const proof=await this.reconcileKnowledgeBase(existing,auth);
          return {...answerExisting(proof.receipt,operationId,host),readBack:proof.readBack};
        }
        return answerExisting(existing, operationId, host);
      }
      const discoveryPrepared=operationId===A2A_DISCOVER?await a2aDiscoveryApproval({file:authorizationContext,words:authorize,host,raw,
        read:(id,input)=>this.portalRead({tenant:host,auth,operationId:id,input})}):null;
      const a2aPrepared=[A2A_TEST,A2A_SAVE].includes(operationId)?await a2aConnectionApproval({file:authorizationContext,words:authorize,host,operationId,raw,
        lookup:id=>this.receipts.lookup(id),read:(id,input)=>this.portalRead({tenant:host,auth,operationId:id,input})}):null;
      const customSearchPrepared=[CUSTOM_SEARCH_TEST,CUSTOM_SEARCH_SAVE].includes(operationId)?await customSearchConnectionApproval({file:authorizationContext,words:authorize,host,operationId,raw,
        lookup:id=>this.receipts.lookup(id),read:(id,input)=>this.portalRead({tenant:host,auth,operationId:id,input}),
        readPublic:(id,path)=>this.read({tenant:host,auth:'api-client',operationId:id,path})}):null;
      const customSearchDeletion=operationId==='connections.delete'&&raw.inputParameters?.ProviderId==='customAISearch'
        ?await customSearchDeleteApproval({file:authorizationContext,words:authorize,host,raw,lookup:id=>this.receipts.lookup(id),
          read:(id,input)=>this.portalRead({tenant:host,auth,operationId:id,input}),
          readPublic:(id,path)=>this.read({tenant:host,auth:'api-client',operationId:id,path}),
          dependencies:assetKey=>readAssetConsumers(assetKey,(id,input)=>this.read({tenant:host,auth:'api-client',operationId:id,...input}))}):null;
      const connectionApproval = customSearchDeletion?.approval ?? customSearchPrepared?.approval ?? discoveryPrepared?.approval ?? a2aPrepared?.approval ?? (operationId==='connections.relationalSave'&&preparedHeaderEdit ? preparedHeaderEdit.approval : authorizationContext && ['connections.relationalTest', 'connections.relationalSave'].includes(operationId)
        ? dbConnectionApproval(authorizationContext, authorize, { host, operationId, raw, target })
        : ['connections.delete', 'connections.importEntities'].includes(operationId) ? preparedConnectionApproval : null);
      const nativeLibraryApproval=operationId===LIBRARY_RELEASE ? await libraryReleaseApproval({file:authorizationContext,words:authorize,host,raw,
        lookup:id=>this.receipts.lookup(id),read:(id,path)=>this.read({tenant:host,auth:'api-client',operationId:id,path})}) : null;
      const libraryApproval=nativeLibraryApproval ?? (externalLibraryParent ? externalLibraryStepApproval({parentOperationUuid:externalLibraryParent,
        lookup:id=>this.receipts.lookup(id),words:authorize,host,operationId,operationUuid,input:raw}) : null);
      const datasetApproval=operationId===DATASET_DELETE ? await datasetDeleteApproval({file:authorizationContext,words:authorize,host,raw,
        lookup:id=>this.receipts.lookup(id),read:(id,screenVariables)=>this.portalRead({tenant:host,auth,operationId:id,input:{screenVariables}})})
        : operationId===DATASET_CREATE&&authorizationContext ? await datasetCreateApproval({file:authorizationContext,words:authorize,host,raw,
          readAsset:assetKey=>this.read({tenant:host,operationId:'asset-repository-api-v1:get:/assets/{assetKey}',path:{assetKey}}),
          readApps:PortfolioKey=>this.portalRead({tenant:host,auth,operationId:'agents.agenticApps',input:{screenVariables:{PortfolioKey,_portfolioKeyInDataFetchStatus:1}}})}) : null;
      const kbApproval=[KB_CREATE,KB_DELETE].includes(operationId)?await knowledgeBaseApproval({file:authorizationContext,words:authorize,host,operationId,raw,
        lookup:id=>this.receipts.lookup(id),read:(id,screenVariables)=>this.portalRead({tenant:host,auth,operationId:id,input:{screenVariables}})}):null;
      const filePrepared=operationId===KB_UPLOAD?await knowledgeFileApproval({file:authorizationContext,words:authorize,host,raw,
        lookup:id=>this.receipts.lookup(id),read:(id,input)=>this.portalRead({tenant:host,auth,operationId:id,input})}):null;
      const mobileFilePrepared=[MOBILE_FILE_UPLOAD,MOBILE_FILE_CONVERT].includes(operationId)?await mobileBinaryUploadApproval({file:authorizationContext,words:authorize,host,raw,operationId,secretRefs:refs.map(({pointer,target,field})=>({pointer,target,field})),
        lookup:id=>this.receipts.lookup(id),read:(operationId,path)=>this.read({tenant:host,auth:'api-client',operationId,path}),
        portalRead:(operationId,input)=>this.portalRead({tenant:host,auth,operationId,input})}):null;
      const mobileSavePrepared=operationId===MOBILE_FILE_SAVE?await mobileBinarySaveApproval({file:authorizationContext,words:authorize,host,raw,
        lookup:id=>this.receipts.lookup(id),read:(operationId,path)=>this.read({tenant:host,auth:'api-client',operationId,path}),
        portalRead:(operationId,input)=>this.portalRead({tenant:host,auth,operationId,input})}):null;
      const aiTrialApproval = [AI_TRIAL_CREATE, AI_TRIAL_DELETE].includes(operationId) ? await aiModelTrialApproval({ file: authorizationContext, words: authorize, host, operationId, raw,
        lookup: id => this.receipts.lookup(id), read: (id, input) => this.portalRead({ tenant: host, auth, operationId: id, input }) }) : null;
      const evaluationPrepared=operationId===EVALUATION_CREATE&&authorizationContext?await evaluationCreateApproval({file:authorizationContext,words:authorize,host,raw,
        lookup:id=>this.receipts.lookup(id),read:(id,input)=>this.portalRead({tenant:host,auth,operationId:id,input})}):null;
      const evaluationOperation=[EVALUATION_RUN,EVALUATION_DELETE].includes(operationId)?await evaluationOperationApproval({file:authorizationContext,words:authorize,host,raw,operationId,
        lookup:id=>this.receipts.lookup(id),read:(id,input)=>this.portalRead({tenant:host,auth,operationId:id,input})}):null;
      const guardrailsPrepared=operationId===GUARDRAILS_SAVE?await guardrailsApproval({file:authorizationContext,words:authorize,host,raw,
        lookup:id=>this.receipts.lookup(id),readAsset:assetKey=>this.read({tenant:host,auth:'api-client',operationId:'asset-repository-api-v1:get:/assets/{assetKey}',path:{assetKey}}),
        read:(id,input)=>this.portalRead({tenant:host,auth,operationId:id,input})}):null;
      if(guardrailsPrepared)raw={...raw,inputParameters:{...raw.inputParameters,Policies:guardrailsPrepared.expected.policies}};
      const baselinePrepared=operationId===BASELINE_SAVE?await baselineApproval({file:authorizationContext,words:authorize,host,raw,
        lookup:id=>this.receipts.lookup(id),read:(id,input)=>this.portalRead({tenant:host,auth,operationId:id,input})}):null;
      const apiClientPrepared=[API_CLIENT_CREATE,API_CLIENT_DELETE].includes(operationId)?await apiClientWriteApproval({file:authorizationContext,words:authorize,host,operationId,operationUuid,raw,lookup:id=>this.receipts.lookup(id),
        readInventory:()=>this.portalRead({tenant:host,auth,operationId:'apiClients.list',input:{screenVariables:{StartIndex:0,MaxRecords:100,Filter:{NameContains:'',Status:''}}},maxPages:10}),
        readDetail:key=>this.portalRead({tenant:host,auth,operationId:'apiClients.detail',input:{screenVariables:{id:key,_idInDataFetchStatus:1}}})}):null;
      const fixtureApproval=apiClientPrepared?.approval ?? mobileSavePrepared?.approval ?? mobileFilePrepared?.approval ?? filePrepared?.approval ?? aiTrialApproval ?? evaluationPrepared?.approval ?? evaluationOperation?.approval ?? guardrailsPrepared?.approval ?? baselinePrepared?.approval;
      if (libraryApproval || datasetApproval || kbApproval || fixtureApproval) guardTenant(info,authorize,confirmTenant,libraryApproval ?? datasetApproval ?? kbApproval ?? fixtureApproval);
      else if (!authorizationContext) guardTenant(info, authorize, confirmTenant);
      else if (operationId !== 'timers.run' && !activation && !connectionApproval) fail('AUTHORIZATION_CONTEXT_INVALID', 'The contextual approval does not cover this typed Portal operation.');
      if (connectionApproval || libraryApproval || datasetApproval || kbApproval || fixtureApproval) guardTenant(info, authorize, confirmTenant, connectionApproval ?? libraryApproval ?? datasetApproval ?? kbApproval ?? fixtureApproval);
      else guardPortalTarget(effect, authorize, target);
      const resolved = await this.resolvePortal(host, auth);
      if (resolved.ok === false) return { ...resolved, operationId, tenant: host, sent: false };
      if(operationId===API_CLIENT_CREATE&&resolved.privateSender?.apiClientVault!==true)fail('HEADLESS_AUTH_UNAVAILABLE','API Client creation requires a bridge with private vault capture. Nothing was reserved or sent.');
      if([MOBILE_FILE_UPLOAD,MOBILE_FILE_CONVERT,MOBILE_FILE_SAVE].includes(operationId)&&resolved.privateSender?.mobileUpload!==true)fail('HEADLESS_AUTH_UNAVAILABLE','Private mobile upload/save requires a capable attached bridge. Nothing was sent.');
      if((operationId===MOBILE_FILE_CONVERT||mobileSavePrepared?.expected.transportMode==='base64')&&resolved.privateSender?.mobileBase64!==true)fail('HEADLESS_AUTH_UNAVAILABLE','Private native Base64 conversion/save requires bridge v82 or later. Nothing was sent.');
      if(mobileFilePrepared?.expected.isSecret&&resolved.privateSender?.mobileVaultUpload!==true)fail('HEADLESS_AUTH_UNAVAILABLE','Vault binary upload requires bridge v77 or later for content verification before send. Nothing was sent.');
      if (refs.length && resolved.path !== 'studio-http' && typeof resolved.privateSender !== 'function') fail('STUDIO_REQUIRED', secretStudioRequired(host));
      const timerDependencies = {
        configuration: path => this.read({ tenant: host, operationId: TIMER_CONFIGURATION, path }),
        application: path => this.read({ tenant: host, operationId: TIMER_APPLICATION_REVISION, path }),
        portalRead: async (id, screenVariables) => envelope(id, await resolved.broker.callScreenservice({ operationId: id, input: { screenVariables }, write: false })),
      };
      const timer = timerTarget ? activation ? await prepareTimerActivation(raw, operationId === 'timers.resume', timerDependencies)
        : await prepareTimerWake(raw, timerDependencies) : null;
      const approval = timer ? readAuthorizationContext(authorizationContext, authorize, { lane: 'odc', host, operation: operationId,
        environmentKey: timer.target.environmentKey, targets: [timer.before.applicationName, timer.before.timerName] }) : connectionApproval ?? libraryApproval ?? datasetApproval ?? kbApproval ?? fixtureApproval;
      if (approval) guardTenant(info, authorize, confirmTenant, approval);
      if (timer && !approval) {
        const appNamed = namesWhole(authorize, timer.before.applicationName) || namesWhole(authorize, timer.target.applicationKey);
        const timerNamed = namesWhole(authorize, timer.before.timerName) || namesWhole(authorize, timer.target.timerKey);
        if (!appNamed || !timerNamed) fail('TIMER_TARGET_NOT_NAMED', 'Timer execution needs authorization naming both the application and timer (or their exact keys).');
      }
      if (activation && timer.alreadyApplied) return {ok:true,operationId,tenant:host,auth:authOf(resolved),noOp:true,
        before:timer.before,desiredActive:timer.desiredActive,configurationConfirmed:true,atomicityProven:false};
      if (activation) raw = timer.input;
      const wordsSha256 = sha256(authorize);
      const secrets = refs.length ? { count: refs.length, entries: [...new Set(refs.map(r => r.target))], resolvedBy: 'bridge, inside the ODC Studio' } : null;
      receipt = this.receipts.reserve({ operationUuid, identity, wordsSha256,
        ...(apiClientPrepared?{reconciliation:{apiClientFixture:apiClientPrepared.expected}}:{}),
        ...(mobileFilePrepared?{reconciliation:{mobileBinaryUpload:mobileFilePrepared.expected}}:{}),
        ...(mobileSavePrepared?{reconciliation:{mobileBinarySave:mobileSavePrepared.expected}}:{}),
        ...(baselinePrepared?{reconciliation:{guardrailBaseline:baselinePrepared.expected}}:{}),
        ...(guardrailsPrepared?{reconciliation:{guardrails:guardrailsPrepared.expected}}:{}),
        ...(operationId===EVALUATION_RUN||[API_CLIENT_CREATE,API_CLIENT_DELETE].includes(operationId)?{once:true}:{}),
        ...(operationId===EVALUATION_DELETE?{reconciliation:{evaluationDeletion:{evaluationId:evaluationOperation.evaluationId,portfolioKey:evaluationOperation.portfolioKey}}}:{}),
        ...(evaluationPrepared?{reconciliation:{evaluation:evaluationPrepared.expected}}:{}),
        ...(aiTrialApproval ? { reconciliation: { aiModelTrial: { portfolioKey: aiTrialApproval.constraints.portfolioKey,
          ...(operationId === AI_TRIAL_DELETE ? { key: raw.inputParameters.AIModelId } : { trialId: raw.inputParameters.TrialId }) } } } : {}),
        ...(filePrepared?{reconciliation:{knowledgeFile:filePrepared.expected}}:{}),
        ...(a2aPrepared?{reconciliation:{a2aConnection:a2aPrepared.expected}}:{}),
        ...(customSearchPrepared?{reconciliation:{customSearchConnection:customSearchPrepared.expected}}:{}),
        ...(customSearchDeletion?{reconciliation:{customSearchDeletion:customSearchDeletion.expected}}:{}),
        ...(discoveryPrepared?{reconciliation:{a2aDiscovery:discoveryPrepared.expected}}:{}),
        ...(kbApproval?{reconciliation:{knowledgeBase:operationId===KB_CREATE?{name:raw.inputParameters.KnowledgeBaseCreate.Name}:{key:raw.inputParameters.KnowledgeBaseId}}}:{}),
        ...(operationId === 'connections.relationalSave' && preparedHeaderEdit ? { reconciliation: { connectionHeader: preparedHeaderEdit.expected } } : {}),
        ...(operationId === 'connections.importActions' && preparedMcpImport ? { reconciliation: { mcpImport: preparedMcpImport } } : {}),
        ...(operationId === 'connections.importEntities' && preparedEntityImport ? { reconciliation: { entityImport: preparedEntityImport } } : {}),
        plan: { ...(approval ? { authorizationContext: approval } : {}), operationId, inputSha256: sha256(JSON.stringify(raw)), secretRefs: refs.map(({ pointer, target: entry, field }) => ({ pointer, target: entry, field })),
          ...(timer ? { before: timer.before } : {}) } });
      if (activation) this.receipts.settle(receipt, {state:'sending',timerActivation:{before:timer.before,target:timer.target,desiredActive:timer.desiredActive}});
      let output, state;
      try {
        const body = await resolved.broker.callScreenservice({ operationId, write: true, input: raw, secretRefs: refs.map(({ pointer, target: entry, field }) => ({ pointer, target: entry, field })),
          operationUuid: receipt.operationUuid, authorizeSha256: wordsSha256, confirmTenant: host, privateSender: resolved.privateSender,
          ...(mobileSavePrepared?{mobileUploadOperationUuid:mobileSavePrepared.expected.uploadOperationUuid,mobileObjectUri:mobileSavePrepared.expected.objectUri}:{}),
          ...(mobileFilePrepared?.expected.isSecret?{mobileExpectedContent:{sha256:mobileFilePrepared.expected.contentSha256,byteLength:mobileFilePrepared.expected.byteLength}}:{}) });
        output = envelope(operationId, body); state = 'accepted';
        if(operationId===API_CLIENT_CREATE)output={...output,data:{ApiClientProof:apiClientPrivateProof(output.data?.ApiClientProof,{operationUuid,name:apiClientPrepared.expected.name})}};
        if(operationId===MOBILE_FILE_SAVE)state='uncertain';
        if([MOBILE_FILE_UPLOAD,MOBILE_FILE_CONVERT].includes(operationId)){
          const proof=mobileUploadObservation(mobileFilePrepared.expected,output.data,operationUuid);state=proof?'confirmed':'uncertain';
          if(proof)output={...output,data:{UploadProof:proof}};
          else output={...output,ok:false,error:{code:'MOBILE_BINARY_UPLOAD_UNVERIFIED',message:'Upload did not return its private content proof. Inspect the original receipt; never resend.'}};
        }
        if([GUARDRAILS_SAVE,BASELINE_SAVE].includes(operationId))state='uncertain';
        if(operationId===KB_UPLOAD&&output.data?.HasError!==false){
          state=output.data?.HasError===true?'rejected':'uncertain';
          output={...output,ok:false,error:{code:'KNOWLEDGE_FILE_UPLOAD_UNVERIFIED',message:'The native upload did not confirm acceptance. Inspect the receipt and file inventory; never resend.'}};
        }
        if(operationId===A2A_DISCOVER){
          try{output={...output,data:a2aDiscoveryOutcome(body.data),continuation:a2aDiscoveryContinuation(operationUuid,discoveryPrepared.expected)};state='confirmed';}
          catch(error){output={ok:false,operationId,error:publicError(error)};state='uncertain';}
        }
        if(operationId===A2A_TEST&&!isUuid(output.data?.Out_ConnectionId)){
          state='uncertain';output={...output,ok:false,error:{code:'A2A_CONNECTION_IDENTITY_UNVERIFIED',message:'The test did not return its exact connection identity. Reconcile; never resend.'}};
        }
        if(operationId===CUSTOM_SEARCH_TEST&&!isUuid(output.data?.Out_ConnectionId)){
          state='uncertain';output={...output,ok:false,error:{code:'CUSTOM_SEARCH_IDENTITY_UNVERIFIED',message:'The test did not return its exact identity. Reconcile; never resend.'}};
        }
        if(operationId===KB_CREATE&&!isUuid(output.data?.KnowledgeBaseId)){
          state='uncertain';output={...output,ok:false,error:{code:'KNOWLEDGE_BASE_IDENTITY_UNVERIFIED',message:'Creation did not return its exact identity. Reconcile; never resend.'}};
        }
        if (operationId === AI_TRIAL_CREATE && !isUuid(output.data?.AIModelId)) {
          state = 'uncertain'; output = { ...output, ok: false, error: { code: 'AI_MODEL_IDENTITY_UNVERIFIED',
            message: 'Creation did not return the exact model identity. Reconcile the inventory; never resend.' } };
        }
        if (operationId === 'agents.datasetCreate') {
          const outcome = datasetCreationOutcome(output.data); state = outcome.state;
          if (outcome.error) output = {...output,ok:false,error:outcome.error};
        }
        // The current evaluation wrapper intentionally returns no identity.
        // Keep the target lock until a scoped persisted read proves the result.
        if(operationId===EVALUATION_CREATE)state='uncertain';
        if(operationId===EVALUATION_RUN){
          if(output.data?.BlockedByOngoingRun===true){state='rejected';output={...output,ok:false,error:{code:'EVALUATION_RUN_BLOCKED',message:'The Portal refused this run because another run is ongoing. Do not retry the bounded fixture.'}};}
          else if(output.data?.BlockedByOngoingRun!==false||!isUuid(output.data?.EvaluationRunId)){state='uncertain';output={...output,ok:false,error:{code:'EVALUATION_RUN_IDENTITY_UNVERIFIED',message:'The run identity was not confirmed. Inspect native runs and the original receipt; never resend.'}};}
        }
        if(operationId===EVALUATION_DELETE)state='uncertain';
        if(operationId===LIBRARY_RELEASE && output.data?.IsValid!==true){
          state=output.data?.IsValid===false?'rejected':'uncertain';
          output={...output,ok:false,error:{code:state==='rejected'?'LIBRARY_RELEASE_REJECTED':'LIBRARY_RELEASE_UNVERIFIED',message:'The native release did not confirm validation. Read the exact revision; never resend this receipt.'}};
        }
        if (activation && !isUuid(output.data?.DeploymentKey)) {
          state='uncertain';output={...output,ok:false,error:{code:'TIMER_DEPLOYMENT_KEY_UNVERIFIED',message:'The save response did not identify its deployment. Reconcile; never repeat SaveAndApply.'}};
        }
      } catch (error) {
        const failure = publicError(error);
        // Without `sent`, the failure came before the POST (metadata, session, refusal by the window).
        state = failure.sent ? (failure.status >= 400 && failure.status < 500 ? 'rejected' : 'uncertain') : NOT_SENT.has(failure.code) || PORTAL_NOT_SENT.has(failure.code) ? 'not-sent' : 'uncertain';
        output = { ok: false, operationId, internalContract: true, error: failure, ...secretRefsHint(failure, host) };
      }
      this.receipts.settle(receipt, { state, auth: resolved.path, errorCode: output.error?.code ?? null,
        ...([API_CLIENT_CREATE,API_CLIENT_DELETE].includes(operationId)&&output.error?{requestFailure:{
          ...(typeof output.error.code==='string'&&/^[A-Z][A-Z0-9_]{0,80}$/.test(output.error.code)?{code:output.error.code}:{}),
          ...(Number.isInteger(output.error.status)&&output.error.status>=100&&output.error.status<=599?{status:output.error.status}:{}),
          ...(typeof output.error.remoteCode==='string'&&/^OS-[A-Z0-9-]{1,80}$/.test(output.error.remoteCode)?{remoteCode:output.error.remoteCode}:{}),
          ...(typeof output.error.remoteCauseCode==='string'&&/^OS-[A-Z0-9]{2,12}-\d{3,8}$/.test(output.error.remoteCauseCode)?{remoteCauseCode:output.error.remoteCauseCode}:{}),
          ...(['SecurityException','InvalidArgumentException','CommunicationException','DatabaseException','UserException'].includes(output.error.remoteType)?{remoteType:output.error.remoteType}:{}),
          ...(typeof output.error.sent==='boolean'?{sent:output.error.sent}:{})}}:{}),
        response: operationId === 'agents.datasetCreate' ? datasetCreationOutcome(output.data).response
          : {...pick(output.data, ['Out_ConnectionId', 'ConnectionId', 'Key', 'Id', 'DeploymentKey','KnowledgeBaseId','cardSha256','AIModelId','EvaluationRunId','BlockedByOngoingRun','SavedGuardrailId']),
            ...(operationId===API_CLIENT_CREATE&&state==='accepted'?{ApiClientProof:output.data.ApiClientProof}:{}),
            ...([MOBILE_FILE_UPLOAD,MOBILE_FILE_CONVERT].includes(operationId)&&state==='confirmed'?{mobileUploadProof:output.data.UploadProof}:{}),
            ...(operationId===KB_UPLOAD?{uploadAccepted:output.data?.HasError===false}:{}),
            ...(operationId===A2A_DISCOVER&&state==='confirmed'?{card:structuredClone(output.data.card)}:{})} });
      if(operationId===API_CLIENT_DELETE&&apiClientPrepared&&['accepted','uncertain'].includes(state)){
        const proof=await this.reconcileApiClientDeletion(receipt,auth);receipt=proof.receipt;state=receipt.state;
        output={...output,ok:proof.readBack.verified,deletionConfirmed:proof.readBack.verified,readBack:proof.readBack};
        if(proof.readBack.verified){const {error,...confirmed}=output;output={...confirmed,...(error?{writeError:error}:{})};}
        else output={...output,...(output.error?{writeError:output.error}:{}),error:{code:'API_CLIENT_DELETE_UNVERIFIED',message:'A complete unfiltered inventory did not prove absence. Reconcile the original receipt; never resend.'}};
      }
      if(mobileSavePrepared&&['accepted','uncertain'].includes(state)){
        const proof=await this.reconcileMobileBinarySave(receipt,auth);receipt=proof.receipt;state=receipt.state;output={...output,readBack:proof.readBack};
        if(state==='confirmed'){const {error,...proved}=output;output={...proved,ok:true,...(error?{writeError:error}:{})};}
        else output={...output,ok:false,error:{code:'MOBILE_BINARY_SAVE_UNVERIFIED',message:'The exact binary setting was not observed. Reconcile the original receipt; never resend.'}};
      }
      if(guardrailsPrepared&&['accepted','uncertain'].includes(state)){
        const proof=await this.reconcileGuardrails(receipt,auth);receipt=proof.receipt;state=receipt.state;output={...output,readBack:proof.readBack};
        if(state==='confirmed'){const {error,...proved}=output;output={...proved,ok:true,...(error?{writeError:error}:{})};}
        else output={...output,ok:false,error:{code:'GUARDRAIL_SAVE_UNVERIFIED',message:'The exact saved guardrail was not observed. Reconcile the original receipt; never resend.'}};
      }
      if(baselinePrepared&&['accepted','uncertain'].includes(state)){
        const proof=await this.reconcileGuardrailBaseline(receipt,auth);receipt=proof.receipt;state=receipt.state;output={...output,readBack:proof.readBack};
        if(state==='confirmed'){const {error,...proved}=output;output={...proved,ok:true,...(error?{writeError:error}:{})};}
        else output={...output,ok:false,error:{code:'GUARDRAIL_BASELINE_SAVE_UNVERIFIED',message:'The exact administrative baseline was not observed. Reconcile the original receipt; never resend.'}};
      }
      if(evaluationPrepared&&['accepted','uncertain'].includes(state)){
        let observation;try{observation=await observeEvaluationCreation(receipt,(id,input)=>this.portalRead({tenant:host,auth,operationId:id,input}));}
        catch{observation={verified:false,reason:'read-back-unavailable'};}
        output={...output,readBack:observation};
        if(observation.verified){receipt.response={...receipt.response,EvalId:observation.evaluationId};receipt=this.receipts.reconcile(receipt,{state:'confirmed',observation});state='confirmed';const {error,...proved}=output;output={...proved,ok:true,...(error?{writeError:error}:{})};}
        else output={...output,ok:false,error:{code:'EVALUATION_CREATION_UNVERIFIED',message:'Read the exact original receipt and evaluation; never repeat creation.'}};
      }
      if(customSearchDeletion&&['accepted','uncertain'].includes(state)){
        const result=await this.dbDeleteReadBack(host,auth,{...customSearchDeletion.expected,operationUuid},{...output,receipt:receiptOf(receipt)});
        receipt=this.receipts.lookup(operationUuid);state=receipt.state;output={...result};
        if(state==='confirmed'&&output.error){output.writeError=output.error;delete output.error;}
        if(result.continuation)output.continuation={tool:'odc_portal_write',arguments:{tenant:host,auth,operationId,input,authorize,operationUuid,confirmTenant},why:'Read-only reconciliation of this deletion UUID; never resend.'};
      }
      if(operationId===CUSTOM_SEARCH_SAVE&&customSearchPrepared&&['accepted','uncertain'].includes(state)){
        const proof=await this.reconcileCustomSearchConnection(receipt,auth);receipt=proof.receipt;state=receipt.state;
        output={...output,readBack:proof.readBack};
        if(state==='confirmed'){const {error,...confirmed}=output;output={...confirmed,ok:true,...(error?{writeError:error}:{})};}
        else output={...output,ok:false,error:{code:'CUSTOM_SEARCH_SAVE_UNVERIFIED',message:'The saved search configuration was not observed. Reconcile the original receipt; never resend.'}};
      }
      if(operationId===A2A_SAVE&&a2aPrepared&&['accepted','uncertain'].includes(state)){
        const proof=await this.reconcileA2aConnection(receipt,auth);receipt=proof.receipt;state=receipt.state;
        output={...output,readBack:proof.readBack};
        if(state==='confirmed'){
          const {error,...confirmed}=output;
          output={...confirmed,ok:true,...(error?{writeError:error}:{})};
        }
      }
      if (aiTrialApproval && ['accepted', 'uncertain'].includes(state)) {
        let observation;
        try { observation = await observeAiModelTrial(receipt, (id, input) => this.portalRead({ tenant: host, auth, operationId: id, input })); }
        catch { observation = { verified: false, reason: 'read-back-unavailable' }; }
        output = { ...output, readBack: observation };
        if (observation.verified) { receipt = this.receipts.reconcile(receipt, { state: 'confirmed', observation }); state = 'confirmed'; }
      }
      if(kbApproval&&['accepted','uncertain'].includes(state)){
        const proof=await this.reconcileKnowledgeBase(receipt,auth);receipt=proof.receipt;state=receipt.state;
        output={...output,readBack:proof.readBack};
      }
      if(filePrepared&&['accepted','uncertain'].includes(state)){
        const proof=await this.reconcileKnowledgeFile(receipt,auth);receipt=proof.receipt;state=receipt.state;
        output={...output,readBack:proof.readBack};
      }
      if(operationId===LIBRARY_RELEASE && state==='accepted'){
        let verified=false;
        try {verified=await verifyLibraryRelease(raw.inputParameters,(id,path)=>this.read({tenant:host,auth:'api-client',operationId:id,path}));}catch{}
        output={...output,releaseConfirmed:verified};
        if(verified){receipt=this.receipts.reconcile(receipt,{state:'confirmed',observation:{assetKey:raw.inputParameters.ApplicationKey,revision:raw.inputParameters.Revision,tag:raw.inputParameters.Version,releaseNotesVerified:true}});state='confirmed';}
      }
      if(operationId===DATASET_DELETE && state==='accepted'){
        let absent=false;
        try {const observed=await this.portalRead({tenant:host,auth,operationId:'agents.dataset',input:{screenVariables:{id:raw.inputParameters.DatasetId,_idInDataFetchStatus:1}}});
          absent=observed.ok===true&&observed.data?.NotFound===true;}catch{}
        output={...output,deletionConfirmed:absent};
        if(absent){receipt=this.receipts.reconcile(receipt,{state:'confirmed',observation:{datasetId:raw.inputParameters.DatasetId,notFound:true}});state='confirmed';}
      }
      if(operationId===EVALUATION_DELETE&&['accepted','uncertain'].includes(state)){
        const observed=await this.portalRead({tenant:host,auth,operationId:'agents.evaluation',input:{screenVariables:{id:evaluationOperation.evaluationId,_idInDataFetchStatus:1,portfolioId:evaluationOperation.portfolioKey,_portfolioIdInDataFetchStatus:1}}});
        const absent=observed.ok===true&&observed.data?.NotFound===true;
        output={...output,deletionConfirmed:absent};
        if(absent){receipt=this.receipts.reconcile(receipt,{state:'confirmed',observation:{evaluationId:evaluationOperation.evaluationId,notFound:true}});state='confirmed';output={...output,ok:true};}
      }
      this.journal({ start, tool: 'portal', command: 'portal-write ' + operationId, outcome: state, note: '[' + host + '] auth=' + resolved.path + ' words=sha256:' + wordsSha256.slice(0, 12) + ' receipt=' + receipt.operationUuid
        + (secrets ? ' secretRefs=' + secrets.count : '') });
      return { ...output, tenant: host, effect, auth: authOf(resolved), receipt: receiptOf(receipt), ...(secrets ? { secretRefs: { ...secrets, resolutionConfirmed: output.ok === true } } : {}),
        ...(activation ? {before:timer.before,desiredActive:timer.desiredActive,configurationConfirmed:false,atomicityProven:false,
          ...(isUuid(output.data?.DeploymentKey) ? {continuation:{tool:'odc_operation_status',arguments:{tenant:host,auth:'studio',kind:'deployment',operationKey:output.data.DeploymentKey,operationUuid:receipt.operationUuid,waitSeconds:0},why:'Follow the native configuration deployment and verify the timer before confirming this receipt.'}} : {})} : timer ? { before: timer.before, executionConfirmed: false, completionConfirmed: false,
          continuation: { tool: 'odc_portal_read', arguments: { tenant: host, auth, ...timer.observation },
            why: 'Observe the requested timer; acceptance does not prove execution or completion. Never repeat Wake to obtain evidence.' } } : {}),
        ...(state === 'uncertain' ? { reconcile: activation ? 'Read timers.deploymentStatus for this exact timer scope, then follow its key using odc_operation_status with this operationUuid. Alternatively reconcile with odc_receipt and the original authorization plus this timer info read. Never resend SaveAndApply.' : 'Read the target (odc_portal_read, e.g. connections.list) and settle with odc_receipt {operationUuid, reconcile}; never resend.',
          ...(activation ? {continuation:{tool:'odc_portal_read',arguments:{tenant:host,auth,operationId:'timers.deploymentStatus',input:{screenVariables:{appid:timer.target.applicationKey,stageid:timer.target.environmentKey,id:timer.target.timerKey,_appidInDataFetchStatus:1,_stageidInDataFetchStatus:1,_idInDataFetchStatus:1}}},why:'Discover the scoped deployment key; a subsequent operation status with this receipt UUID validates identity and the write time window before confirming.'}} : {}) } : {}) };
    } catch (error) {
      try {
        this.journal({ start, tool: 'portal', command: 'portal-write ' + operationId, outcome: receipt ? 'local-error-after-reservation' : 'refused', note: '[' + (host ?? '?') + '] ' + (error.code ?? 'error') });
      } catch { /* Failure logging cannot erase a reserved/possibly sent write. */ }
      if (receipt) {
        // A local failure while settling/logging after reservation cannot prove
        // that the remote POST was never sent. Preserve the durable receipt.
        let durable;
        try { durable = this.receipts.lookup(receipt.operationUuid); } catch { /* reconcile from disk/target later */ }
        durable ??= { ...receipt, state: 'uncertain' };
        return { ok: false, operationId, tenant: host, error: publicError(error), receipt: receiptOf(durable),
          reconcile: 'A local error occurred after reservation. Inspect this receipt and read the target; never resend the write to obtain evidence.' };
      }
      return { ok: false, operationId, ...(host ? { tenant: host } : {}), sent: false, error: publicError(error), ...(receipt ? { receipt: receiptOf(receipt) } : {}) };
    }
  }

  // odc_portal_routes: capture of an unmapped route for the live proof (PORTAL_GAPS). The screens and screenservice
  // actions a Portal module names in its own scripts, read through the same session as odc_portal_read (GETs only,
  // nothing called). The module is checked before any tenant, session or prompt is touched (never authentication,
  // identity or api). Short answer: {ok, tenant, module, view?, screens, actions:[{action, mapped}], truncated, next?}.
  async portalRoutes({ tenant, auth = 'auto', module, view, match }) {
    const start = new Date(this.now()).toISOString();
    let host;
    try {
      const name = routesModule(module);
      host = await this.pickTenant(tenant);
      const resolved = await this.resolvePortal(host, auth);
      if (resolved.ok === false) return { ...resolved, tenant: host };
      const found = await resolved.broker.metadata.routes(name, { view, match });
      const mapped = new Set([...Object.values(PORTAL_READS).map(r => r[2]), ...Object.values(PORTAL_WRITES).map(w => w.route[2])]);
      const actions = found.actions.slice(0, MAX_ROUTE_ACTIONS).map(action => ({ action, mapped: mapped.has(action) }));
      const truncated = found.truncated === true || found.actions.length > MAX_ROUTE_ACTIONS || found.screens.length > MAX_ROUTE_SCREENS;
      const next = [...(truncated ? ['More than shown: narrow with view (one screen) or match (part of the action name).'] : []),
        ...(actions.some(a => !a.mapped) ? ['Names only, nothing was called. Validate the complete contract before mapping a write, then prove it with the user\'s words on a named harmless target in this selected tenant.'] : [])];
      this.journal({ start, tool: 'portal', command: 'portal-routes ' + name, outcome: 'ok', note: '[' + host + '] auth=' + resolved.path + ' actions=' + found.actions.length });
      return { ok: true, tenant: host, module: name, ...(view ? { view } : {}), screens: found.screens.slice(0, MAX_ROUTE_SCREENS), actions, truncated,
        ...(next.length ? { next: next.join(' ') } : {}) };
    } catch (error) {
      this.journal({ start, tool: 'portal', command: 'portal-routes ' + String(module ?? '').slice(0, 64), outcome: 'error', note: '[' + (host ?? '?') + '] ' + (error.code ?? 'error') });
      return { ok: false, ...(host ? { tenant: host } : {}), error: publicError(error) };
    }
  }

  // Headless login by default; prompt/focus explicitly recover only the owned credential form.
  async portalLogin(input) {
    return boundedRead({ scope: 'odc-portal-login', input }, () => this.portalLoginWithinBudget(input), { timeoutMs: input.action === undefined || input.action === 'open' ? 90000 : 29000 });
  }
  async portalLoginWithinBudget({ tenant, auth = 'auto', action = 'open', profile, authorize }) {
    readCheckpoint('authentication');
    try {
      const host = await this.pickTenant(tenant);
      if (!['open', 'status', 'close', 'select-profile', 'prompt', 'focus'].includes(action)) fail('INPUT_INVALID', 'action must be open, status, close, select-profile, prompt or focus.');
      if(action!=='select-profile'&&(profile!==undefined||authorize!==undefined))fail('INPUT_INVALID','Profile selection fields require action select-profile.');
      if (this.hosted && auth === 'portal-credential') return hostedOnlyStudio(host, 'portal-credential');
      // servidor/fase4-24 (R3): a credential profile of the SSAM server is never selected for a customer, whatever auth says.
      if (this.hosted && action === 'select-profile') return refusal('HOSTED_STUDIO_SESSION_ONLY', 'action:"select-profile" selects a credential profile of the SSAM server\'s vault, '
        + 'which is never used in hosted mode: the Portal runs only through the headless session of the user\'s own ODC Studio (auth "auto" or "studio").', { host });
      // servidor/fase4-25: the private credential window (prompt, focus) never opens on the hosted server.
      if (this.hosted && (action === 'prompt' || action === 'focus')) return refusal('HOSTED_PROMPT_UNAVAILABLE', 'action:"' + action + '" opens or focuses the private credential window '
        + 'of the machine that runs SSAM, which never happens in hosted mode: the Portal runs only through the headless session of the user\'s own ODC Studio (auth "auto" or "studio").', { host, action });
      const studio = await this.studioState();
      const session = this.session(studio, host);
      if (this.hosted && !session) return studioRefusal(studio, host, {}, true);
      if (action === 'prompt' || action === 'focus') {
        if (await this.portalCredentialAvailable(host)) {
          const selected = await this.profiles?.resolve({ lane: 'odc', host, principal: session?.user ?? null }, { interactive: false });
          if (selected?.ok === true) return { ok: true, tenant: host, credentialConfigured: true, windowCreated: false };
          return refusal('CREDENTIAL_SELECTION_REQUIRED', 'A Portal credential exists. Select its compatible profile; it was not overwritten.', { host });
        }
        return this.openPrompt('portal', host, undefined, undefined, 'focus');
      }
      if (action === 'status' && !this.profileSessions.has(host) && this.prompt?.status) {
        const window = await this.prompt.status(host);
        if (window.state !== 'absent') return { ok: true, tenant: host, signedIn: false, window };
      }
      if(action==='select-profile') {
        if(auth!=='portal-credential'||!this.profiles?.select||!profile)fail('INPUT_INVALID','Profile selection requires portal-credential, an existing profile and the private metadata broker.');
        const selected=await this.profiles.select({lane:'odc',host,principal:session?.user??null},{...profile,authorize});
        return {...selected,tenant:host,authenticationPerformed:false,configurationOnly:true};
      }
      const activeProfile = this.profileSessions.get(host);
      if (action !== 'open' && auth !== 'studio' && activeProfile && (activeProfile.principal ?? null) === (session?.user ?? null)) {
        if (action === 'close') {
          activeProfile.broker.authenticated = false;
          await activeProfile.broker.jar?.removeAllCookies?.();
          this.profileSessions.delete(host);
          return { ok: true, tenant: host, closed: true, auth: { path: 'vault', host, user: activeProfile.selected.principal } };
        }
        return { ok: true, tenant: host, auth: { path: 'vault', host, user: activeProfile.selected.principal }, session: safeSession(activeProfile.broker.status()) };
      }
      if (this.profiles && action === 'open' && auth !== 'studio') {
        const resolved = await this.resolvePortal(host, auth);
        if (resolved.ok === false) return resolved;
        return { ok: true, tenant: host, signedIn: true, auth: authOf(resolved) };
      }
      if (auth !== 'portal-credential' && session) {
        if (!studio.capabilities?.includes('portal-session:headless'))
          return refusal('HEADLESS_AUTH_UNAVAILABLE', 'The attached Studio has no headless Portal session transport. No window was opened or closed.', { host });
        const answer = await this.studioBroker(host).session(action);
        if (answer?.ok !== true) return refusal(answer?.code ?? 'PORTAL_AUTH_REQUIRED', 'The headless Portal session is unavailable.', { host });
        return { ok: true, tenant: host, auth: { path: 'studio-http', host, user: answer.studioUser ?? session.user },
          session: pick(answer, ['signedIn', 'closed']), windowCreated: false };
      }
      if (auth === 'studio' || (auth === 'auto' && studio.running)) {
        return studioRefusal(studio, host, { portalCredentialAvailable: await this.portalCredentialAvailable(host) });
      }
      const broker = await this.vaultBroker(host);
      if (action === 'status') {
        // Keep legacy operatorAction fields out of headless status answers.
        const { operatorAction, explanation, ...state } = safeSession(broker.status());
        return { ok: true, tenant: host, auth: { path: 'vault', host }, session: state, ...(broker.available ? {} : { continuation: { tool: 'odc_portal_login',
          arguments: { tenant: host, auth, action: 'open' }, why: 'A compatible credential must be provisioned privately before headless authentication can run.' } }) };
      }
      if (action === 'close') { broker.authenticated = false; await broker.jar?.removeAllCookies?.(); return { ok: true, tenant: host, closed: true }; }
      if (broker.available) { const login = await broker.authenticate(); return { ...safeSession(login), tenant: host, auth: { path: 'vault', host } }; }
      if (session) return refusal('AUTH_NOT_CONFIGURED', 'No Portal account in the vault for ' + host + '; an authenticated headless session is required (auth:"auto").', { host });
      return this.openPrompt('portal', host);
    } catch (error) { return { ok: false, error: publicError(error) }; }
  }

  // ---- what each tenant would use right now, without prompting or sending anything
  async authStatus({ tenant } = {}) {
    const studio = await this.studioState();
    const hosts = tenant !== undefined ? [await this.pickTenant(tenant)]
      : [...new Set([...Object.keys(this.tenants.tenants ?? {}), ...studio.sessions.map(s => s.host)])];
    const entries = [];
    for (const host of hosts) {
      const session = this.session(studio, host);
      const window = studio.portalWindows.find(w => w.host === host) ?? null;
      const studioEntry = session ? { loggedIn: true, user: session.user, tokenValidUntil: session.tokenValidUntil, ...(session.permissions ? { permissions: session.permissions } : {}) } : null;
      const noSession = studio.connected ? 'STUDIO_NOT_SIGNED_IN' : 'STUDIO_NOT_CONNECTED';
      if (this.hosted) {
        // The vault columns: never read in hosted mode (only the customer's Studio session is a path).
        entries.push({ ...this.tenantInfo(host), studio: studioEntry, apiClient: { available: null, hosted: 'unavailable in hosted mode' },
          portal: { studioWindow: window, account: { available: null, hosted: 'unavailable in hosted mode' } },
          resolves: { public: session ? 'studio' : noSession, portal: session ? (studio.capabilities?.includes('portal-session:headless') ? 'studio-http' : 'HEADLESS_AUTH_UNAVAILABLE') : noSession } });
        continue;
      }
      const apiClient = await this.apiClientAvailable(host);
      const portalAccount = await this.portalCredentialAvailable(host);
      entries.push({ ...this.tenantInfo(host), studio: studioEntry,
        apiClient: { available: apiClient, entry: 'SSAM/ODC3/' + host + '/APIClient' }, portal: { studioWindow: window, account: { available: portalAccount, entry: 'SSAM/ODC3/' + host + '/Portal' } },
        resolves: { public: session ? 'studio' : studio.running ? (studio.connected ? 'STUDIO_NOT_SIGNED_IN' : 'STUDIO_NOT_CONNECTED') : apiClient ? 'vault' : 'AUTH_NOT_CONFIGURED',
          portal: session ? (studio.capabilities?.includes('portal-session:headless') ? 'studio-http' : 'vault-profile-required') : studio.running ? (studio.connected ? 'STUDIO_NOT_SIGNED_IN' : 'STUDIO_NOT_CONNECTED') : portalAccount ? 'vault' : 'AUTH_NOT_CONFIGURED' } });
    }
    return { ok: true, studio: { running: studio.running, connected: studio.connected, bridge: studio.bridge ?? null,
      ...(studio.connected ? { capabilities: studio.capabilities ?? [],
        secretRefs: (studio.capabilities ?? []).includes('portal-private-call:headless:secretRefs')
          || ((studio.capabilities ?? []).includes('portal-session:secretRefs') && (studio.capabilities ?? []).includes('portal-call:secretRefs')),
        privateHttpSecretRefs: (studio.capabilities ?? []).includes('portal-private-call:headless:secretRefs'),
        nativeHttpSecretRefs: (studio.capabilities ?? []).includes('portal-session:secretRefs') && (studio.capabilities ?? []).includes('portal-call:secretRefs') } : {}),
      ...(studio.hint ? { hint: studio.hint } : {}) },
      order: this.hosted ? 'Hosted: only the headless session of the user\'s own ODC Studio; no vault, API Client, credential profile or prompt of the server. Writes always need the user\'s words.'
        : 'Headless Studio session first, then a compatible stored Windows credential profile, then (nothing stored) the private Windows prompt in its own window; never a browser. Writes always need the user\'s words.',
      tenants: entries, secretsExposed: false };
  }

  // ---- typed helpers
  // One read per call, or a bounded wait until a terminal state; the start POST is never repeated.
  async operationStatus({ tenant, auth = 'auto', kind, operationKey, operationUuid, waitSeconds = 0, messages = false }) {
    const spec = OPERATION_STATUS[kind];
    if (!spec) return { ok: false, error: { code: 'INPUT_INVALID', message: 'kind must be one of ' + Object.keys(OPERATION_STATUS).join(', ') } };
    const tracked = operationReceipt(this.receipts, {operationUuid, tenant: operationUuid ? await this.pickTenant(tenant) : tenant, spec, operationKey});
    const scope = kind==='native-build'?{query:nativeBuildScope(tracked)}:{};
    const deadline = this.now() + Math.min(Math.max(Number(waitSeconds) || 0, 0), MAX_WAIT_SECONDS) * 1000;
    let read, reads = 0;
    while (true) {
      read = await this.read({ tenant, auth, operationId: spec.read, path: { [spec.param]: operationKey },...scope }); reads++;
      if (!read.ok || spec.terminal.includes(read.data?.[spec.field]) || this.now() >= deadline) break;
      await this.sleep(Math.min(5000, Math.max(deadline - this.now(), 0)));
    }
    if (!read.ok) return { ...read, kind, operationKey };
    const status = read.data?.[spec.field] ?? null, terminal = spec.terminal.includes(status);
    if(tracked?.timerActivation)validateTimerDeployment(tracked,operationKey,read.data);
    const timerVerification = tracked?.timerActivation && terminal && !spec.failed.includes(status) ? await verifyTimerActivation(tracked.timerActivation, {
      deploymentKey:operationKey,
      configuration:path=>this.read({tenant:read.tenant,auth,operationId:TIMER_CONFIGURATION,path}),
      portalRead:(operationId,screenVariables)=>this.portalRead({tenant:read.tenant,operationId,input:{screenVariables}}),
    }) : null;
    const settled = confirmOperationReceipt(this.receipts, tracked, {spec, operationKey, data:read.data, terminal, failed:spec.failed.includes(status),timerVerification});
    const log = messages && spec.messages ? await this.read({ tenant, auth, operationId: spec.messages, path: { [spec.param]: operationKey },...scope }) : null;
    // publish, build and deployment also answer `log`: the messages in the shape of the Studio's publish-log (type, text,
    // element, stage) with counts, and a failed one the continuation that says what to fix (operation-log.mjs).
    return withOperationLog({ ok: true, tenant: read.tenant, auth: read.auth, kind, operationKey, status, terminal, failed: spec.failed.includes(status), reads, data: read.data,
      ...(settled ? {receipt:receiptOf(settled)} : {}),
      ...(timerVerification ? {timerVerification} : {}),
      ...(log ? { messages: log.ok ? log.data : { error: log.error } } : {}),
      ...(terminal ? {} : { continuation: { tool: 'odc_operation_status', arguments: { tenant: read.tenant, auth, kind, operationKey, ...(operationUuid ? {operationUuid} : {}), waitSeconds: Math.max(Number(waitSeconds) || 0, 60) },
        why: 'Not terminal yet (' + status + '): follow it again; the POST that started it is never repeated.' } }) });
  }

  // Deploy (or undeploy, apply configs) between stages, then follow the operation to a terminal state.
  async deploy({ tenant, auth = 'auto', assetKey, environmentKey, revision, buildKey, operation = 'Deploy', authorize, operationUuid, confirmTenant, waitSeconds = 300, authorizationContext, originOperationUuid }) {
    const body = { operation, assetKey, environmentKey, ...(revision !== undefined ? { revision } : {}), ...(buildKey ? { buildKey } : {}) };
    const started = await this.write({ tenant, auth, operationId: DEPLOY, body, authorize, operationUuid, confirmTenant }, originOperationUuid ? {settingsConfigurationContext:authorizationContext,originOperationUuid} : {timerConfigurationContext:authorizationContext});
    const key = started.data?.key ?? started.receipt?.response?.key;
    if (!started.ok || !key || !waitSeconds) return { ...started, ...(started.ok && !key ? { warning: 'The answer carries no operation key; find it with odc_read deployments-api-v1:get:/deployment-operations.' } : {}) };
    const deployment = await this.operationStatus({ tenant: started.tenant, auth, kind: 'deployment', operationKey: key, waitSeconds, messages: true });
    if (!deployment.failed) return { ...started, deployment };
    // The deployment was accepted and ended in FinishedWithError: refused with every message and what to fix. The POST
    // is never repeated; a new deployment, after the fix, needs the user's words and a new operationUuid.
    return { ...started, ok: false, code: 'DEPLOYMENT_FAILED', sent: true, error: deployment.log?.summary ?? 'Deployment ' + key + ' ended in ' + deployment.status + '.',
      deployment, ...(deployment.continuation ? { continuation: deployment.continuation } : {}) };
  }

  // App, agent or stage configurations (settings, timers, integrations). set by name resolves keys from the current
  // configuration; a secret setting is never set from arguments: vaultSettings {Name: vault entry} names the entry
  // SSAM/ODC3/<host>/Setting/<entry> (typed by the user in the private prompt) and the bridge reads it inside the ODC
  // Studio right before the PATCH (portal-call secretRefs at /settings/<i>/value). The answer reads back what the
  // server now holds (a secret value is never compared: the server redacts it).
  async configurations({ tenant, auth = 'auto', action = 'get', scope = 'application', environmentKey, assetKey, revision, settings, vaultSettings, vaultConfigurations, patch, authorize, operationUuid, confirmTenant, authorizationContext, originOperationUuid }) {
    const ids = CONFIGURATIONS[scope];
    if (!ids) return { ok: false, error: { code: 'INPUT_INVALID', message: 'scope must be application, agent, environment or mobile-extensibility.' } };
    const mobile=scope==='mobile-extensibility';
    if(mobile&&(revision!==undefined||action==='set'&&(!originOperationUuid||!authorizationContext)))return {ok:false,sent:false,error:{code:'INPUT_INVALID',message:'Mobile extensibility has no revision selector; writes require the own fixture origin and exact contextual approval.'}};
    const path = { environmentKey, ...(scope === 'environment' ? {} : { [ids.param]: assetKey }) };
    const get = () => this.read({ tenant, auth, operationId: scope !== 'environment' && revision !== undefined ? ids.revision : ids.get,
      path: { ...path, ...(scope !== 'environment' && revision !== undefined ? { baselineRevision: String(revision) } : {}) } });
    if (action === 'get') return get();
    if (action !== 'set') return { ok: false, error: { code: 'INPUT_INVALID', message: 'action must be get or set.' } };
    let body = patch ? structuredClone(patch) : {};
    const secrets = vaultSettings && typeof vaultSettings === 'object' ? Object.entries(vaultSettings) : [];
    const secretRefs = [];
    const nestedSelectors=vaultConfigurations??[];
    if(!Array.isArray(nestedSelectors)||nestedSelectors.length>32)return {ok:false,sent:false,error:{code:'INPUT_INVALID',message:'vaultConfigurations must be a bounded array.'}};
    let nestedLocations=[];
    let host;
    if (secrets.length || nestedSelectors.length) {
      try { host = await this.pickTenant(tenant); } catch (error) { return { ok: false, error: publicError(error) }; }
      for (const [name, entry] of secrets) if (!/^[A-Za-z0-9_.-]{1,64}$/.test(String(entry))) return { ok: false, error: { code: 'INPUT_INVALID', message: 'vaultSettings maps a setting name to its vault entry name SSAM/ODC3/<tenant>/Setting/<entry> ([A-Za-z0-9_.-], up to 64): ' + name } };
      // Before any prompt or read: only the Studio session sends a secretRefs PATCH (the bridge reads the vault there).
      if (auth === 'api-client' || !this.session(await this.studioState(), host)) return { ...refusal('STUDIO_REQUIRED', secretStudioRequired(host), { host }), sent: false };
      // Hosted the entry lives in the customer's vault: their bridge checks it (secret_ref_missing), never this server.
      for (const entry of [...secrets.map(([,entry])=>entry),...nestedSelectors.map(s=>s?.entry)]) {
        if(typeof entry!=='string'||!/^[A-Za-z0-9_.-]{1,64}$/.test(entry))return {ok:false,sent:false,error:{code:'INPUT_INVALID',message:'Invalid vault entry selector.'}};
        if (this.hosted) continue;
        if (!(await this.portalCredentialAvailable(host, undefined, String(entry)))) return { ...(await this.openPrompt('portal', host, undefined, String(entry))), credentialEntry: settingSecretTarget(host, entry) };
      }
    }
    if ((settings && typeof settings === 'object') || secrets.length || (Array.isArray(body.settings) && body.settings.length)) {
      const current = await this.read({ tenant, auth, operationId: ids.get, path });
      if (!current.ok) return current;
      const known = Array.isArray(current.data?.settings) ? current.data.settings : [];
      body.settings = [...(body.settings ?? [])];
      // The raw patch never carries a secret value either.
      const raw = body.settings.find(s => known.find(k => k.key === s?.key)?.isSecret === true && (!mobile||Object.hasOwn(s,'value')) && s.value !== null);
      if (raw) return { ok: false, error: { code: 'SECRET_IN_ARGUMENTS', message: 'A secret setting value is never a tool argument (patch.settings): use an existing private credential entry through vaultSettings.', settingKey: raw.key } };
      for (const [name, value] of Object.entries(settings ?? {})) {
        const setting = known.find(s => s.name === name || s.key === name);
        if (!setting) return { ok: false, error: { code: 'SETTING_NOT_FOUND', message: 'No setting named ' + name + ' in the current configuration.' } };
        if (setting.isSecret) return { ok: false, error: { code: 'SECRET_IN_ARGUMENTS', message: 'A secret setting value is never a tool argument: use an existing private entry through vaultSettings {"' + name + '": "<vault entry>"} (the bridge reads it inside the ODC Studio).', setting: name } };
        body.settings.push({ key: setting.key, value: String(value) });
      }
      for (const [name, entry] of secrets) {
        if(mobile&&known.filter(s=>s.name===name||s.key===name).length!==1)return {ok:false,sent:false,error:{code:'SETTING_NOT_FOUND',message:'Mobile vault setting must resolve to one exact field.'}};
        const setting = known.find(s => s.name === name || s.key === name);
        if (!setting) return { ok: false, error: { code: 'SETTING_NOT_FOUND', message: 'No setting named ' + name + ' in the current configuration.' } };
        // A vault value only goes to a setting the server keeps secret: anything else would come back in plain reads.
        if (setting.isSecret !== true) return { ok: false, error: { code: 'INPUT_INVALID', message: 'Setting ' + name + ' is not secret: pass its value in settings.' } };
        secretRefs.push({ pointer: '/settings/' + body.settings.length + '/value', target: settingSecretTarget(host, entry), field: 'password' });
        body.settings.push({ key: setting.key, value: '' });
      }
    }
    if (!mobile&&['timers','integrations','libraries','systemConfigurations'].some(group => Array.isArray(body[group]) && body[group].length)) {
      const current = await this.read({tenant,auth,operationId:ids.get,path});
      if (!current.ok) return {ok:false,sent:false,error:{code:'CONFIGURATION_PREREQUISITE_UNAVAILABLE',stage:'configuration',
        causeCode:['STUDIO_NOT_SIGNED_IN','STUDIO_NOT_CONNECTED','AUTH_REQUIRED','NOT_ALLOWED','PORTAL_TIMEOUT'].includes(current.error?.code)
          ? current.error.code : 'READ_FAILED',message:'The configuration metadata could not be read. Nothing was sent.'}};
      if (nestedConfigurations(body,current.data).some(e => e.observed?.isSecret === true && e.value !== null))
        return {ok:false,sent:false,error:{code:'SECRET_IN_ARGUMENTS',message:'Secret nested configuration values cannot be supplied through a raw patch.'}};
    }
    if(nestedSelectors.length){
      if(scope==='environment')return {ok:false,sent:false,error:{code:'INPUT_INVALID',message:'Nested vault selectors require an app or agent.'}};
      const current=await this.read({tenant,auth,operationId:ids.get,path});if(!current.ok)return current;
      try{const plan=(mobile?mobileExtensibilityVaultPlan:configurationVaultPlan)(host,current.data,body,nestedSelectors);body=plan.body;secretRefs.push(...plan.refs);nestedLocations=plan.locations;}catch(error){return {ok:false,sent:false,error:publicError(error)};}
    }
    if(mobile)return this.write({tenant,auth,operationId:ids.patch,path,body,authorize,operationUuid,confirmTenant},{secretRefs,mobileConfigurationContext:authorizationContext,originOperationUuid});
    if (scope !== 'environment' && body.key === undefined) body = { key: assetKey, ...body };
    const written = await this.write({ tenant, auth, operationId: ids.patch, path, body, authorize, operationUuid, confirmTenant }, { secretRefs, ...(originOperationUuid ? {settingsConfigurationContext:authorizationContext,originOperationUuid} : {timerConfigurationContext:authorizationContext}) });
    if (!written.ok) return written;
    const after = await this.read({ tenant: written.tenant, auth, operationId: ids.get, path });
    const secretKeys = new Set(secretRefs.filter(r=>r.pointer.startsWith('/settings/')).map(r => body.settings[Number(r.pointer.split('/')[2])].key));
    const expected = (body.settings ?? []).filter(s => !secretKeys.has(s.key)).map(s => ({ key: s.key, value: s.value,
      observed: (after.data?.settings ?? []).find(r => r.key === s.key) }));
    const vaultPointers=new Set(nestedLocations.map(l=>l.pointer));
    const nestedAll=nestedConfigurations(body,after.data);
    const nested=nestedAll.filter(e=>!vaultPointers.has(e.pointer));
    const verified = after.ok && expected.length + nested.length > 0 && expected.every(e => e.observed
      && (e.observed.isSecret ? e.value === null && ['EnvironmentLevelDefault','ApplicationLevelDefault','LibraryLevelDefault'].includes(e.observed.valueOrigin) : e.value === null ? ['EnvironmentLevelDefault','ApplicationLevelDefault','LibraryLevelDefault'].includes(e.observed.valueOrigin)
        : String(e.observed.value) === String(e.value)))
      && nested.every(e => e.observed && (e.value === null ? ['EnvironmentLevelDefault','ApplicationLevelDefault','LibraryLevelDefault'].includes(e.observed.valueOrigin) : !e.observed.isSecret && String(e.observed.value) === String(e.value)));
    let receipt = written.receipt;
    if (verified && receipt?.state === 'accepted') {
      this.receipts.reconcile(this.receipts.lookup(receipt.operationUuid), { state: 'confirmed', observation: { operationId: ids.get, readBack: true } });
      receipt = { ...receipt, state: 'confirmed' };
    }
    return { ...written, ...(receipt ? { receipt } : {}), readBack: after.ok ? { verified, settings: expected.map(e => ({ key: e.key, name: e.observed?.name ?? null, value: e.observed?.value ?? null, origin: e.observed?.valueOrigin ?? null, ...(e.observed?.isSecret ? {valueVerified:false,resetMetadataVerified:e.value===null&&['EnvironmentLevelDefault','ApplicationLevelDefault','LibraryLevelDefault'].includes(e.observed.valueOrigin)} : {}) })),
      ...(nested.length ? { configs: nested.map(e => ({ group: e.group, parent: e.parent, key: e.key, name: e.observed?.name ?? null,
        value: e.observed?.isSecret ? null : e.observed?.value ?? null, origin: e.observed?.valueOrigin ?? null, ...(e.observed?.isSecret?{valueVerified:false,resetMetadataVerified:e.value===null&&['EnvironmentLevelDefault','ApplicationLevelDefault','LibraryLevelDefault'].includes(e.observed.valueOrigin)}:{}) })) } : {}),
      ...(nestedLocations.length?{vaultConfigurations:nestedLocations.map(l=>({...l,present:Boolean(nestedAll.find(e=>e.pointer===l.pointer)?.observed),valueVerified:false}))}:{}),
      ...(secretKeys.size ? { vaultSettings: [...secretKeys].map(key => ({ key, present: Boolean((after.data?.settings ?? []).find(r => r.key === key)), valueVerified: false })) } : {}) } : { error: after.error } };
  }

  // DELETE /assets/{assetKey}: the words must name the asset (its name read first, or its key) and every consumer of it
  // (dependency-management GET /assets/{assetKey}/consumers, read before anything is reserved: an app or library that
  // would break is named by the user or bound to an explicit same-proposal owned
  // fixture approval); a read afterwards confirms it is gone.
  async assetDelete({ tenant, auth = 'auto', assetKey, authorize, operationUuid, confirmTenant, authorizationContext }) {
    const operationId = 'asset-repository-api-v1:delete:/assets/{assetKey}';
    let dependencyCheck;
    // A repeated operationUuid answers its receipt through write(), with no new read.
    let existing = null;
    try { existing = isUuid(operationUuid) ? this.receipts.lookup(operationUuid) : null; } catch { existing = null; }
    if (!existing) {
      const start = new Date(this.now()).toISOString();
      let host;
      try {
        host = await this.pickTenant(tenant);
        precheck(authorize, operationUuid);
        if (!authorizationContext) guardTenant(this.tenantInfo(host), authorize, confirmTenant);
        else if (this.tenantInfo(host).readOnly) fail('TENANT_READ_ONLY', 'The tenant is read-only.');
        const resolved = await this.resolvePublic(host, auth);
        if (resolved.ok === false) return { ...resolved, operationId, tenant: host, sent: false };
        const dependents = await this.dependentsOf(host, resolved, assetKey);
        if (!dependents.ok) return { ok: false, code: dependents.code, operationId, tenant: host, sent: false, error: { code: dependents.code, message: dependents.message } };
        dependencyCheck={checkedEnvironments:dependents.checkedEnvironments,includesPublishingDefault:dependents.includesPublishingDefault,consumerNamesObserved:dependents.consumers.length};
        const approval = readAuthorizationContext(authorizationContext, authorize, { lane: 'odc', host, operation: operationId, targets: [dependents.name] });
        if (authorizationContext) guardTenant(this.tenantInfo(host), authorize, confirmTenant, approval);
        const ownedApproval=ownedConsumerDeletionApproval({file:authorizationContext,words:authorize,host,assetKey,dependents,lookup:id=>this.receipts.lookup(id)});
        if(ownedApproval)dependencyCheck.ownedConsumerApproval={consumerSetSha256:ownedApproval.constraints.consumerSetSha256,contextSha256:ownedApproval.sha256};
        const missing = ownedApproval ? [] : dependents.consumers.filter(c => !namesWhole(authorize, c.name));
        if (missing.length) {
          this.journal({ start, tool: 'portal', command: 'write ' + operationId, outcome: 'refused', note: '[' + host + '] CONSUMERS_WOULD_BREAK ' + missing.length });
          const message = (dependents.name ?? assetKey) + ' has consumers that would break: ' + missing.map(c => c.name).join(', ') + '. Nothing was reserved or deleted.';
          return { ok: false, code: 'CONSUMERS_WOULD_BREAK', operationId, tenant: host, sent: false, error: { code: 'CONSUMERS_WOULD_BREAK', message },
            asset: { key: assetKey, name: dependents.name }, consumers: dependents.consumers.map(c => c.name),
            problems: missing.map(c => ({ code: 'CONSUMERS_WOULD_BREAK', target: c.name, message: c.name + ' consumes ' + (dependents.name ?? assetKey) + ' and would break.',
              fix: 'Repeat with words that also name ' + c.name + ' (the user\'s own words naming the asset and every consumer), or remove the dependency from ' + c.name + ' first.', ssamRule: true })) };
        }
      } catch (error) {
        this.journal({ start, tool: 'portal', command: 'write ' + operationId, outcome: 'refused', note: '[' + (host ?? '?') + '] ' + (error.code ?? 'error') });
        return { ok: false, operationId, ...(host ? { tenant: host } : {}), sent: false, error: publicError(error) };
      }
    }
    const deleted = await this.write({ tenant, auth, operationId, path: { assetKey }, authorize, operationUuid, confirmTenant }, { authorizationContext });
    if (!deleted.ok || deleted.existingReceipt) return deleted;
    const after = await this.read({ tenant: deleted.tenant, auth, operationId: 'asset-repository-api-v1:get:/assets/{assetKey}', path: { assetKey } });
    const gone = !after.ok && after.status === 404;
    const settled = gone ? this.receipts.reconcile(this.receipts.lookup(deleted.receipt.operationUuid), { state: 'confirmed', observation: { operationId: 'asset-repository-api-v1:get:/assets/{assetKey}', status: 404 } }) : null;
    return { ...deleted, ...(settled ? {receipt:receiptOf(settled)} : {}), ...(dependencyCheck?{dependencyCheck}:{}), readBack: { gone, status: after.status ?? null } };
  }

  // The asset's name and the apps and libraries that consume it, both read with the resolved session before anything
  // that depends on them. An unreadable consumers answer is DEPENDENCY_CHECK_UNAVAILABLE: nothing is deleted blind.
  async dependentsOf(host, resolved, assetKey) {
    const result=await readAssetConsumers(assetKey,(operationId,input)=>this.send(host,resolved,operationId,input,{write:false}));
    this.journal({tool:'portal',command:'read '+ASSET_CONSUMERS,outcome:result.ok?'ok':'native_error',note:'['+host+'] consumers across environments before a destructive write'});
    return result;
  }

  // External database connections through the internal Portal (Connections app). The database account lives in the
  // vault entry SSAM/ODC3/<host>/DB/<name> and reaches the request only inside the session that sends it (secretRefs).
  async mcpImport(input) {
    let host;
    try {
      host = await this.pickTenant(input.tenant);
      return { ...await executeMcpImport({ ...input, tenant: host }, {
        read: (operationId, request) => this.portalRead({ tenant: host, auth: input.auth ?? 'auto', operationId, input: request }),
        write: (request, options) => this.portalWrite(request, options), receipts: this.receipts,
      }), tenant: host };
    } catch (error) { return { ok: false, ...(host ? { tenant: host } : {}), error: publicError(error) }; }
  }

  async mcpConnection(input) {
    let host;
    try {
      if (!['readiness', 'import-plan'].includes(input.action)) fail('INPUT_INVALID', 'Only readiness and import-plan are supported by this read-only helper.');
      if (input.action === 'import-plan' && (!Array.isArray(input.toolNames) || !input.toolNames.length))
        fail('INPUT_INVALID', 'Explicit toolNames are required for import-plan.');
      host = await this.pickTenant(input.tenant);
      const auth = input.auth ?? 'auto';
      const observation = await observeMcpImport(input, (operationId, request) =>
        this.portalRead({ tenant: host, auth, operationId, input: request }));
      const result = observation.readiness;
      if (input.action === 'import-plan' && result.ok && result.readyForToolImport) {
        const plan = planMcpImport(input, observation);
        return { ok: true, tenant: host, action: 'import-plan', plan: plan.preview,
          note: 'Read-only plan; review before authorizing odc_mcp_import. No tools imported or invoked.' };
      }
      return { ...result, tenant: host };
    } catch (error) { return { ok: false, ...(host ? { tenant: host } : {}), error: publicError(error) }; }
  }

  async externalDbConnection(input) {
    const { tenant, auth = 'auto', action } = input;
    let host;
    try {
      host = await this.pickTenant(tenant);
      if(input.objectContracts!==undefined&&!['plan-entities','import-entities'].includes(action))fail('INPUT_INVALID','objectContracts requires plan-entities or import-entities.');
      if(input.headerPatch!==undefined&&!['plan-header','edit-header'].includes(action))fail('INPUT_INVALID','headerPatch requires plan-header or edit-header.');
      if(action==='plan-header')return await boundedRead({scope:'odc-db-header-plan',host,auth,connectionId:input.connectionId,providerId:input.providerId,patch:input.headerPatch,expectedUpdatedOn:input.expectedUpdatedOn},()=>this.dbHeaderPlan(host,auth,input));
      if(action==='edit-header')return await this.dbHeaderEdit(host,auth,input);
      if(action==='plan-entities')return await boundedRead({scope:'odc-db-entity-plan',host,auth,connectionId:input.connectionId,objects:input.objects,objectContracts:input.objectContracts},()=>this.dbEntityPlan(host,auth,input));
      if (action === 'providers') return this.portalRead({ tenant: host, auth, operationId: 'connections.providers' });
      if (action === 'list') return this.portalRead({ tenant: host, auth, operationId: 'connections.list' });
      if (action === 'delete') return await this.dbDelete(host, auth, input);
      if (action === 'entities') return await this.dbEntities(host, auth, input);
      if (action === 'test' || action === 'create') return await this.dbTestOrCreate(host, auth, input);
      if (action === 'import-entities' || action === 'remove-entities') return await this.dbImport(host, auth, input);
      fail('INPUT_INVALID', 'action must be providers, list, entities, plan-entities, plan-header, edit-header, test, create, import-entities, remove-entities or delete.');
    } catch (error) { return { ok: false, ...(host ? { tenant: host } : {}), error: publicError(error) }; }
  }

  async dbHeaderPlan(host, auth, {connectionId, providerId, headerPatch, expectedUpdatedOn}) {
    const identity={connectionId,providerId};
    const input=connectionDetailInput(identity);
    const resolved=await this.resolvePortal(host,auth);
    if(resolved.ok===false)return {...resolved,tenant:host};
    // Inspect the native detail only inside the broker boundary; its key/value
    // dictionaries may carry credentials and must never be returned or logged.
    const response=await resolved.broker.callScreenservice({operationId:'connections.detail',write:false,input});
    const plan=connectionHeaderPlan(response?.data,identity,headerPatch,expectedUpdatedOn);
    const header=plan.input.inputParameters.ConnectionDetails.ConnectionDetails_Header;
    const availability=await this.portalRead({tenant:host,auth,operationId:'connections.relationalNameAvailability',
      input:{inputParameters:{ConnectionName:header.ConnectionName,ConnectionId:connectionId}}});
    if(!availability.ok)return availability;
    this.journal({tool:'portal',command:'connection-header-plan',outcome:'ok',note:'['+host+'] read-only; stage configuration withheld'});
    return {ok:true,tenant:host,action:'plan-header',plan,nameAvailability:availability.nameAvailability,
      ready:availability.nameAvailability?.available===true,sent:false,
      note:'Read-only preparation. No write is dispatched; contextual ownership approval and a current baseline are required for editing.'};
  }

  async dbHeaderEdit(host,auth,input) {
    const detailInput=connectionDetailInput({connectionId:input.connectionId,providerId:input.providerId});
    const resolved=await this.resolvePortal(host,auth);
    if(resolved.ok===false)return {...resolved,tenant:host,sent:false};
    return editConnectionHeader({...input,tenant:host,auth},{receipts:this.receipts,write:(request,options)=>this.portalWrite(request,options),
      read:async(kind,name)=>{
        if(kind==='availability'){
          const result=await this.portalRead({tenant:host,auth,operationId:'connections.relationalNameAvailability',
            input:{inputParameters:{ConnectionName:name,ConnectionId:input.connectionId}}});
          if(!result.ok)fail('CONNECTION_NAME_UNVERIFIED','Name availability could not be verified. Nothing was sent.');
          return result.nameAvailability?.available;
        }
        const result=await resolved.broker.callScreenservice({operationId:'connections.detail',write:false,input:detailInput});
        return result?.data;
      }});
  }

  async a2aConnectionDelete({tenant,auth='auto',connectionId,originOperationUuid,authorize,authorizationContext,operationUuid,confirmTenant}){
    let host;
    try{
      host=await this.pickTenant(tenant);precheck(authorize,operationUuid);
      if(!isUuid(originOperationUuid)||!isUuid(connectionId))fail('INPUT_INVALID','A2A cleanup needs its connection and originating test UUIDs.');
      const origin=this.receipts.lookup(originOperationUuid),connectionName=origin?.reconciliation?.a2aConnection?.name;
      const target={connectionId,connectionName,originOperationUuid};
      const existing=this.receipts.lookup(operationUuid,{kind:'odc-portal',tenant:host,operationId:'connections.delete',target});
      let written;
      if(existing){
        if(existing.authorization?.wordsSha256!==sha256(authorize))fail('AUTHORIZATION_CONTEXT_INVALID','Cleanup reconciliation requires the original authorization.');
        written=answerExisting(existing,'connections.delete',host);
        if(!['accepted','uncertain'].includes(existing.state))return written;
      }else{
        const detail=await this.portalRead({tenant:host,auth,operationId:'connections.detail',input:{connectionId,providerId:'a2a'}});
        if(!detail.ok)return detail;
        const metadata=detail.data?.Connection?.externalMetadata?.selectedActionCount===1
          ?await readA2aCleanupMetadata(detail.data.Connection,(operationId,input)=>this.portalRead({tenant:host,auth,operationId,input})):null;
        let failedTest;
        const stage=origin?.reconciliation?.a2aConnection?.details?.ConnectionDetail_StageConfig?.List?.[0]?.TenantStage;
        if(detail.data?.Connection?.stageConfigurations?.[0]?.a2a?.agentCardSha256===null&&stage&&Number.isFinite(Date.parse(origin?.createdAt))){
          failedTest=await this.portalRead({tenant:host,auth,operationId:'connections.testStatus',input:{clientVariables:{ConnectionListSearchValue:''},screenVariables:{
            InitDateTime:new Date(origin.createdAt).toISOString().replace('T',' ').slice(0,19),ConnectionId:connectionId,_connectionIdInDataFetchStatus:1,
            StageDetails:{List:[{Key:stage.Key,Name:stage.Name,Purpose:stage.Purpose}]},_stageDetailsInDataFetchStatus:1}}});
        }
        const dependencies=await readAssetConsumers(connectionId,(operationId,input)=>this.read({tenant:host,auth:'api-client',operationId,...input}));
        const provisional=!dependencies.ok&&failedTest?await readA2aProvisionalState(detail.data.Connection,
          (operationId,input)=>this.portalRead({tenant:host,auth,operationId,input}),
          assetKey=>this.read({tenant:host,auth:'api-client',operationId:'asset-repository-api-v1:get:/assets/{assetKey}',path:{assetKey}})):null;
        const approval=a2aDeleteApproval({file:authorizationContext,words:authorize,host,origin,originOperationUuid,connectionId,detail:detail.data,dependencies,metadata,failedTest,provisional});
        written=await this.portalWrite({tenant:host,auth,operationId:'connections.delete',authorize,authorizationContext,operationUuid,confirmTenant,target,
          input:{inputParameters:{ConnectionId:connectionId,ProviderId:'a2a',ConsoleProviderId:''}}},{preparedConnectionApproval:approval});
        if(!['accepted','uncertain'].includes(written.receipt?.state))return written;
      }
      const result=await this.dbDeleteReadBack(host,auth,{connectionId,providerId:'a2a',connectionName,operationUuid,originOperationUuid},written);
      if(result.receipt?.state==='confirmed'&&result.error){result.writeError=result.error;delete result.error;}
      if(result.continuation)result.continuation={tool:'odc_a2a_connection_delete',arguments:{tenant:host,auth,connectionId,originOperationUuid,operationUuid,authorize},
        why:'Read-only reconciliation of the same deletion UUID; quote the original authorization. Never resend deletion.'};
      return result;
    }catch(error){
      let saved;try{saved=isUuid(operationUuid)?this.receipts.lookup(operationUuid):null;}catch{}
      return {ok:false,...(host?{tenant:host}:{}),error:publicError(error),...(saved?{receipt:receiptOf(saved)}:{})};
    }
  }

  // Only the explicitly approved, unused temporary SQL connection is eligible.
  // Bind its current detail to the originating receipt before the single delete;
  // subsequent calls with that UUID only reconcile observable absence.
  async dbDelete(host, auth, { connectionId, providerId, authorize, authorizationContext, originOperationUuid, operationUuid, confirmTenant }) {
    routeOf('connections.delete', true);
    if (!isUuid(originOperationUuid)) fail('INPUT_INVALID', 'Deleting a temporary connection requires originOperationUuid from its successful test/create receipt.');
    const origin = this.receipts.lookup(originOperationUuid);
    const existing = this.receipts.lookup(operationUuid, { kind: 'odc-portal', tenant: host, operationId: 'connections.delete',
      target: { connectionId, connectionName: origin?.identity?.target?.connectionName } });
    if (existing) {
      const answer = answerExisting(existing, 'connections.delete', host);
      if (!['accepted', 'uncertain'].includes(existing.state)) return answer;
      if (providerId !== 'mssql') fail('INPUT_INVALID', 'The approved temporary connection uses the native mssql provider.');
      return this.dbDeleteReadBack(host, auth, { connectionId, providerId,
        connectionName: existing.identity.target.connectionName, operationUuid, originOperationUuid }, answer);
    }
    const detailInput = { connectionId, providerId };
    connectionDetailInput(detailInput);
    const detail = await this.portalRead({ tenant: host, auth, operationId: 'connections.detail', input: detailInput });
    if (!detail.ok) return detail;
    const approval = dbDeleteApproval(authorizationContext, authorize, { host, detail: detail.data, origin });
    const connection = detail.data.Connection;
    const written = await this.portalWrite({ tenant: host, auth, operationId: 'connections.delete', authorize, authorizationContext, operationUuid, confirmTenant,
      target: { connectionId, connectionName: connection.name }, input: { inputParameters: { ConnectionId: connectionId, ProviderId: connection.providerId, ConsoleProviderId: '' } } },
      { preparedConnectionApproval: approval });
    if (!written.ok) return { ...written, connectionId };
    return this.dbDeleteReadBack(host, auth, { connectionId, providerId, connectionName: connection.name, operationUuid, originOperationUuid }, written);
  }

  // Deletion is eventually visible. Continuing an accepted/uncertain receipt
  // performs only these reads; it never invokes the delete action again.
  async dbDeleteReadBack(host, auth, { connectionId, providerId, connectionName, operationUuid, originOperationUuid }, written) {
    const detailInput = { connectionId, providerId };
    connectionDetailInput(detailInput);
    const after = await this.portalRead({ tenant: host, auth, operationId: 'connections.detail', input: detailInput });
    const listing = await this.portalRead({ tenant: host, auth, operationId: 'connections.list' });
    const readBack=connectionDeleteObservation(after,listing,{connectionId,connectionName,providerId}),absent=readBack.absent;
    if (absent && ['accepted', 'uncertain'].includes(written.receipt?.state)) this.receipts.reconcile(this.receipts.lookup(operationUuid),
      { state: 'confirmed', observation: { operationId: 'connections.detail+connections.list', connectionId, absent: true } });
    return { ...written, ...(absent ? { ok: true } : {}), receipt: receiptOf(this.receipts.lookup(operationUuid)), connectionId,
      readBack,
      ...(!absent ? { continuation: { tool: 'odc_external_db_connection',
        arguments: { action: 'delete', tenant: host, auth, connectionId, providerId, operationUuid, originOperationUuid },
        why: 'Continue this same operationUuid for read-only reconciliation; the delete is never sent again.' } } : {}),
      concurrency: { compareAndSwap: false, note: 'The native delete action has no revision/ETag parameter; preflight applies to the observed temporary connection.' } };
  }

  async dbEntities(host, auth, { connectionId }) {
    if (!connectionId) fail('INPUT_INVALID', 'connectionId is required.');
    const screenVariables = elementVariables(connectionId);
    const connection = await this.portalRead({ tenant: host, auth, operationId: 'connections.connection', input: { screenVariables } });
    if (!connection.ok) return connection;
    const entities = await this.portalRead({ tenant: host, auth, operationId: 'connections.entities', input: { screenVariables } });
    const selected = await this.portalRead({ tenant: host, auth, operationId: 'connections.selectedEntities', input: { screenVariables } });
    return { ok: entities.ok, tenant: host, auth: connection.auth, connection: connection.data, available: listOf(entities.data?.EntityList).map(e => pick(e, ['EntityId', 'Id', 'OriginalName', 'Name', 'IsView', 'ObjectType'])),
      selected: listOf(selected.data?.SelectedEntityList_Original).map(e => pick(e, ['OriginalName', 'Name'])), ...(entities.ok ? {} : { error: entities.error }) };
  }

  async dbTestOrCreate(host, auth, input) {
    const { name, providerId, server, port, database, description = '', additionalParameters = '', privateGateway = false, privateGatewayPort, stageKey,
      credential = name, authorize, operationUuid, confirmTenant, authorizationContext, waitSeconds = 60 } = input;
    for (const [field, value] of Object.entries({ name, providerId, server, port, database })) if (value === undefined || value === '') fail('INPUT_INVALID', field + ' is required.');
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(String(credential))) fail('INPUT_INVALID', 'credential names the vault entry SSAM/ODC3/<tenant>/DB/<credential> ([A-Za-z0-9_.-], up to 64).');
    if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) fail('INPUT_INVALID', 'port must be 1..65535.');
    // The database account is typed by the user in a private prompt, once, and this process only asks whether the entry
    // exists. Only the bridge reads it, inside the ODC Studio signed in to the tenant (the Portal window path): with no
    // Studio session (or auth:"portal-credential") the write is refused before any prompt, reservation or send.
    if (auth === 'portal-credential' || !this.session(await this.studioState(), host)) return { ...refusal('STUDIO_REQUIRED', secretStudioRequired(host), { host }), sent: false };
    const entry = dbSecretTarget(host, credential);
    // Hosted the entry lives in the customer's vault: their bridge checks it (secret_ref_missing), never this server.
    if (!this.hosted && !(await this.portalCredentialAvailable(host, credential))) return { ...(await this.openPrompt('portal', host, String(credential))), credentialEntry: entry };
    const stages = await this.portalRead({ tenant: host, auth, operationId: 'monitoring.stages' });
    if (!stages.ok) return stages;
    const chosen = (stages.rows ?? []).filter(s => !stageKey || s.Key === stageKey);
    if (!chosen.length) fail('INPUT_INVALID', 'No visible stage' + (stageKey ? ' with key ' + stageKey : '') + '.');
    const configs = chosen.map(stage => ({ ConnectionDetails_Common: { ConnectionUsername: '', ConnectionPassword: '', AdvancedConnectionString: additionalParameters,
      ConnectionServer: server, ConnectionServerPort: Number(port), ConnectionDatabase: database, IsPrivateGateway: Boolean(privateGateway), PrivateGatewayPort: privateGateway ? Number(privateGatewayPort) : 0 },
      TenantStage: { Key: stage.Key, Name: stage.Name, Purpose: stage.Purpose, Order: '0', Hosting: '' } }));
    const header = { ConnectionName: name, ConnectionDescription: description, PortfolioKey: '' };
    const variant = /-azure$/.test(providerId) ? 'azure' : /-aurora$/.test(providerId) ? 'aurora' : 'vanilla';
    const refs =(list, base) => list.flatMap((_, i) => [{ pointer: base + '/' + i + '/ConnectionDetails_Common/ConnectionUsername', target: entry, field: 'username' },
      { pointer: base + '/' + i + '/ConnectionDetails_Common/ConnectionPassword', target: entry, field: 'password' }]);
    // create = test + save, two receipts; the test's UUID derives from the create's, so a repeated create never re-tests.
    const testUuid = input.action === 'test' ? operationUuid : derivedUuid(operationUuid, 'test');
    if (input.action === 'create') {
      const existingSave = this.receipts.lookup(operationUuid, {kind:'odc-portal',tenant:host,
        operationId:'connections.relationalSave',target:{connectionName:name,step:'save'}});
      if (existingSave) {
        const origin = this.receipts.lookup(testUuid, {kind:'odc-portal',tenant:host,
          operationId:'connections.relationalTest',target:{connectionName:name,step:'test'}});
        const id = origin?.response?.Out_ConnectionId;
        if (!id) fail('PORTAL_CONTRACT_CHANGED', 'Existing save has no matching test receipt. No write repeated.');
        return this.dbCreateReadBack(host, auth, name, id, testUuid,
          answerExisting(existingSave,'connections.relationalSave',host),
          {notRepeated:true,source:'existing-save-receipt'});
      }
    }
    if (authorizationContext && !this.receipts.lookup(testUuid)) {
      const listing = await this.portalRead({ tenant: host, auth, operationId: 'connections.list' });
      if (!listing.ok || listing.truncated !== false || !Array.isArray(listing.rows))
        fail('PORTAL_CONTRACT_CHANGED', 'The current connection list is unavailable or incomplete. No test/create was sent.');
      if (listing.rows.some(row => String(row.Name ?? row.ConnectionName ?? '').toLowerCase() === name.toLowerCase()))
        fail('INPUT_INVALID', 'A connection with this temporary name already exists; reconcile ownership before any write.');
    }
    const tested = await this.portalWrite({ tenant: host, auth, operationId: 'connections.relationalTest', authorize, authorizationContext, operationUuid: testUuid, confirmTenant, target: { connectionName: name, step: 'test' },
      input: { inputParameters: { ConnectionId: '', ProviderId: providerId, ForceErrorOnStageKeys: '', IsEditConnection: false, ValidStageConfigs: { List: configs },
        ConnectionDetails_Header: header, EditedStageConfigs: { List: configs }, IsConfigChanged: true, Variant: variant } } },
      { secretRefs: [...refs(configs, '/inputParameters/ValidStageConfigs/List'), ...refs(configs, '/inputParameters/EditedStageConfigs/List')] });
    if (!tested.ok) return tested;
    const connectionId = tested.data?.Out_ConnectionId ?? tested.receipt?.response?.Out_ConnectionId;
    if (!connectionId) return { ...tested, ok: false, error: { code: 'PORTAL_CONTRACT_CHANGED', message: 'The connection test returned no connection id.' } };
    const status = await this.dbTestStatus(host, auth, connectionId, chosen, waitSeconds);
    if (input.action === 'test' || !status.ok) return { ...tested, ok: tested.ok && status.ok, ...(status.ok ? {} : { error: status.error }),
      connectionId, originOperationUuid: tested.receipt?.operationUuid, testStatus: status };
    const saved = await this.portalWrite({ tenant: host, auth, operationId: 'connections.relationalSave', authorize, authorizationContext, operationUuid, confirmTenant, target: { connectionName: name, step: 'save' },
      input: { inputParameters: { ConnectionDetails: { ConnectionDetail_StageConfig: { List: configs }, ConnectionDetails_Header: header, NullValueHandling: NULL_HANDLING },
        ConnectionId: connectionId, ConnectionOriginalUpdateTimestamp: '1900-01-01T00:00:00', ProviderId: providerId, Variant: variant, ForceErrorOnMetadataStatus: false } } },
      { secretRefs: refs(configs, '/inputParameters/ConnectionDetails/ConnectionDetail_StageConfig/List') });
    if (!saved.ok) return { ...saved, connectionId, originOperationUuid: tested.receipt?.operationUuid, testStatus: status };
    return this.dbCreateReadBack(host, auth, name, connectionId, tested.receipt?.operationUuid, saved, status);
  }

  async dbCreateReadBack(host, auth, name, connectionId, originOperationUuid, saved, testStatus) {
    const list = await this.portalRead({ tenant: host, auth, operationId: 'connections.list' });
    const created = list.ok && list.truncated === false ? (list.rows ?? []).find(row => (row.ConnectionId ?? row.Id) === connectionId && (row.Name ?? row.ConnectionName) === name) ?? null : null;
    if (created && ['accepted','uncertain'].includes(saved.receipt?.state)) this.receipts.reconcile(this.receipts.lookup(saved.receipt.operationUuid), { state: 'confirmed', observation: { operationId: 'connections.list', found: true, connectionId } });
    return { ...saved, receipt: receiptOf(this.receipts.lookup(saved.receipt.operationUuid)), connectionId, originOperationUuid, testStatus, readBack: { found: Boolean(created), connection: created } };
  }

  async dbTestStatus(host, auth, connectionId, stages, waitSeconds) {
    const deadline = this.now() + Math.min(Math.max(Number(waitSeconds) || 0, 0), MAX_WAIT_SECONDS) * 1000;
    const initDateTime = new Date(this.now()).toISOString().replace('T', ' ').slice(0, 19);
    while (true) {
      const read = await this.portalRead({ tenant: host, auth, operationId: 'connections.testStatus', input: { clientVariables: { ConnectionListSearchValue: '' },
        screenVariables: { InitDateTime: initDateTime, ConnectionId: connectionId, _connectionIdInDataFetchStatus: 1,
          StageDetails: { List: stages.map(s => ({ Key: s.Key, Name: s.Name, Purpose: s.Purpose })) }, _stageDetailsInDataFetchStatus: 1 } } });
      if (!read.ok) return read;
      const rows = listOf(read.data?.Status?.Results).map(r => pick(r, ['StageKey', 'Status', 'Errorcode', 'diagnosticCategory']));
      const stageKeys = new Set(stages.map(stage => stage.Key));
      if (rows.some(row => !stageKeys.has(row.StageKey)) || new Set(rows.map(row => row.StageKey)).size !== rows.length)
        return { ok: false, error: { code: 'PORTAL_CONTRACT_CHANGED', message: 'Connection test results do not match the requested stages.' } };
      const failed = rows.filter(r => String(r.Status).toLowerCase() === 'error');
      if (failed.length) return { ok: false, results: rows, error: { code: 'CONNECTION_TEST_FAILED', message: 'Connection test failed for a requested stage; native free-text errors are withheld.' } };
      if (rows.length === stageKeys.size && rows.length && rows.every(r => String(r.Status).toLowerCase() === 'success')) return { ok: true, results: rows };
      if (this.now() >= deadline) return { ok: false, results: rows, error: { code: 'CONNECTION_TEST_PENDING', message: 'The test did not finish in time; read connections.testStatus again, never re-run the test automatically.' } };
      await this.sleep(Math.min(2000, Math.max(deadline - this.now(), 0)));
    }
  }

  async dbEntityPlan(host,auth,{connectionId,objects,objectContracts={}}){
    if(!connectionId||!Array.isArray(objects)||!objects.length||new Set(objects).size!==objects.length||objects.some(x=>typeof x!=='string'||!x.trim()))fail('INPUT_INVALID','An exact connectionId and unique nonempty objects are required.');
    if(!objectContracts||typeof objectContracts!=='object'||Array.isArray(objectContracts)||Object.keys(objectContracts).some(k=>!objects.includes(k)))fail('INPUT_INVALID','objectContracts must reference only requested objects.');
    const screenVariables=elementVariables(connectionId);
    const connection=await this.portalRead({tenant:host,auth,operationId:'connections.connection',input:{screenVariables}});if(!connection.ok)return connection;
    const entities=await this.portalRead({tenant:host,auth,operationId:'connections.entities',input:{screenVariables}});if(!entities.ok)return entities;
    const available=new Map(listOf(entities.data?.EntityList).map(e=>[e.OriginalName||e.Name,e]));
    const updates=[],adjustments=[];
    for(const object of objects){
      if(!available.has(object))fail('INPUT_INVALID','Requested object is not exposed by the connection.');
      const attributes=await this.portalRead({tenant:host,auth,operationId:'connections.entityAttributes',input:{inputParameters:{ConnectionId:connectionId,EntityName:object},screenVariables}});if(!attributes.ok)return attributes;
      const built=entityUpdate(available.get(object),listOf(attributes.data?.AttributesList),{contract:objectContracts[object],nullWriteBehavior:connection.data?.NullWriteBehavior||'ConvertNull'});
      updates.push(built.update);adjustments.push(...built.adjustments);
    }
    const timestamp=connection.data?.ConnectionUpdateTimestamp;if(!timestamp||connection.data?.NotFound===true)fail('PORTAL_CONTRACT_CHANGED','Current connection metadata is required.');
    const plan={connectionId,connectionName:connection.data.Name,connectionUpdateTimestamp:timestamp,entities:updates,actions:[]};
    return {ok:true,tenant:host,auth:connection.auth,readOnly:true,sent:false,plan,planSha256:sha256(JSON.stringify(plan)),objectContractsApplied:Object.keys(objectContracts),primaryKeyAdjustments:adjustments,
      customContractWritesEnabled:true,note:'Metadata plan only. Save requires the exact planSha256 as expectedPlanSha256, authorization and a new operationUuid.'};
  }

  // Selects (imports) relational objects of a connection: every attribute selected, the primary key as the server
  // reports it. Read back from the selected entities afterwards.
  async dbImport(host, auth, { connectionId, objects, authorize, operationUuid, confirmTenant, action = 'import-entities', authorizationContext, originOperationUuid, objectContracts, expectedPlanSha256 }) {
    if (!connectionId || !Array.isArray(objects) || !objects.length) fail('INPUT_INVALID', 'connectionId and objects (table or view names) are required.');
    if (new Set(objects).size !== objects.length || objects.some(o => typeof o !== 'string' || !o.trim())) fail('INPUT_INVALID', 'objects must contain unique, nonempty names.');
    const remove = action === 'remove-entities';
    const custom = objectContracts !== undefined;
    if(custom && (!authorizationContext || !/^[a-f0-9]{64}$/.test(expectedPlanSha256??'')))fail('INPUT_INVALID','Custom entity import requires contextual approval and the reviewed expectedPlanSha256.');
    if(!custom && expectedPlanSha256!==undefined)fail('INPUT_INVALID','expectedPlanSha256 requires objectContracts.');
    if (remove && !authorizationContext) fail('AUTHORIZATION_CONTEXT_INVALID', 'Removal requires contextual approval of the owned temporary connection.');
    const screenVariables = elementVariables(connectionId);
    const target = { connectionId, step: remove ? 'remove' : 'import', objects: [...objects].sort(), ...(custom?{planSha256:expectedPlanSha256,contractsSha256:sha256(JSON.stringify(objectContracts))}:{}) };
    const existing = this.receipts.lookup(operationUuid, { kind: 'odc-portal', tenant: host, operationId: 'connections.importEntities', target });
    if (existing) return this.dbEntityReadBack(host, auth, { connectionId, objects, remove, operationUuid }, answerExisting(existing, 'connections.importEntities', host));
    let approval;
    if (authorizationContext) {
      if (!isUuid(originOperationUuid)) fail('INPUT_INVALID', 'Entity changes require the original connection test/create receipt.');
      const detail = await this.portalRead({ tenant: host, auth, operationId: 'connections.detail', input: { connectionId, providerId: 'mssql' } });
      if (!detail.ok) return detail;
      approval = dbEntityApproval(authorizationContext, authorize, { host, detail: detail.data, origin: this.receipts.lookup(originOperationUuid) });
    }
    if(custom){
      const planned=await this.dbEntityPlan(host,auth,{connectionId,objects,objectContracts});if(!planned.ok)return planned;
      if(planned.planSha256!==expectedPlanSha256)fail('ENTITY_PLAN_CHANGED','Current metadata or contract differs from the reviewed plan. Nothing was sent.');
      const plan=planned.plan;
      const saved=await this.portalWrite({tenant:host,auth,operationId:'connections.importEntities',authorize,operationUuid,confirmTenant,target,authorizationContext,
        input:{inputParameters:{ConnectionId:connectionId,DatabaseObjects:{Entities:{List:plan.entities},Actions:{List:[]}},ConnectionOriginalUpdateTimestamp:plan.connectionUpdateTimestamp},screenVariables}},
        {preparedConnectionApproval:approval,preparedEntityImport:{connectionId,planSha256:expectedPlanSha256,entities:plan.entities}});
      if(!saved.ok)return saved;
      return this.dbEntityReadBack(host,auth,{connectionId,objects,remove:false,operationUuid},saved);
    }
    const connection = await this.portalRead({ tenant: host, auth, operationId: 'connections.connection', input: { screenVariables } });
    if (!connection.ok) return connection;
    const entities = await this.portalRead({ tenant: host, auth, operationId: 'connections.entities', input: { screenVariables } });
    if (!entities.ok) return entities;
    const available = new Map(listOf(entities.data?.EntityList).map(e => [e.OriginalName || e.Name, e]));
    if (remove) {
      const selected = await this.portalRead({ tenant: host, auth, operationId: 'connections.selectedEntities', input: { screenVariables } });
      if (!selected.ok) return selected;
      const selectedRows = listOf(selected.data?.SelectedEntityList_Original);
      for (const row of selectedRows) available.set(row.OriginalName || row.Name, row);
      if (objects.some(name => !selectedRows.some(row => (row.OriginalName || row.Name) === name))) fail('INPUT_INVALID', 'Every removal target must currently be selected.');
    }
    const missing = objects.filter(o => !available.has(o));
    if (missing.length) fail('INPUT_INVALID', 'The connection does not expose: ' + missing.join(', '));
    const updates = [];
    for (const object of objects) {
      const attributes = await this.portalRead({ tenant: host, auth, operationId: 'connections.entityAttributes', input: { inputParameters: { ConnectionId: connectionId, EntityName: object }, screenVariables } });
      if (!attributes.ok) return attributes;
      const entity = available.get(object);
      updates.push({ EntityId: entity.EntityId ?? entity.Id ?? '', OriginalName: object, Name: entity.Name || object, Description: entity.Description ?? '', IsSelected: !remove,
        NullWriteBehavior: entity.NullWriteBehavior || connection.data?.NullWriteBehavior || 'ConvertNull', HasCustomNullWriteBehavior: Boolean(entity.HasCustomNullWriteBehavior),
        Attributes: { List: listOf(attributes.data?.AttributesList).map(a => ({ Id: a.AttributeId ?? a.Id ?? '', OriginalName: a.OriginalName || a.Name, Name: a.Name || a.OriginalName,
          Description: a.Description ?? '', IsSelected: a.ChangeStatus !== 'Deleted' && (!remove || Boolean(a.IsMandatory || a.IsPrimaryKey)), ChangeStatus: a.ChangeStatus || 'Unchanged', DefaultValue: a.IsPrimaryKey || a.IsDefaultPrimaryKey ? '' : a.DefaultValue ?? '', HasCustomDefaultValue: !a.IsPrimaryKey && !a.IsDefaultPrimaryKey && Boolean(a.HasCustomDefaultValue),
          DataType: a.DataType ?? '', IsPrimaryKey: Boolean(a.IsPrimaryKey) })) } });
    }
    const timestamp = connection.data?.ConnectionUpdateTimestamp;
    if (!timestamp || timestamp === '1900-01-01T00:00:00') fail('PORTAL_CONTRACT_CHANGED', 'A current connection timestamp is required before changing entity metadata.');
    const saved = await this.portalWrite({ tenant: host, auth, operationId: 'connections.importEntities', authorize, operationUuid, confirmTenant, target, authorizationContext,
      input: { inputParameters: { ConnectionId: connectionId, DatabaseObjects: { Entities: { List: updates }, Actions: { List: [] } },
        ConnectionOriginalUpdateTimestamp: timestamp }, screenVariables } }, { preparedConnectionApproval: approval });
    if (!saved.ok) return saved;
    return this.dbEntityReadBack(host, auth, { connectionId, objects, remove, operationUuid }, saved);
  }

  async dbEntityReadBack(host, auth, { connectionId, objects, remove, operationUuid }, saved) {
    const screenVariables = elementVariables(connectionId);
    const selected = await this.portalRead({ tenant: host, auth, operationId: 'connections.selectedEntities', input: { screenVariables } });
    const names = listOf(selected.data?.SelectedEntityList_Original).map(e => e.OriginalName || e.Name);
    const valid = selected.ok === true && (Array.isArray(selected.data?.SelectedEntityList_Original) || Array.isArray(selected.data?.SelectedEntityList_Original?.List));
    let all = valid && objects.every(o => names.includes(o) === !remove);
    const expectation=this.receipts.lookup(operationUuid)?.reconciliation?.entityImport;
    const metadataChecks=[];
    if(expectation){
      if(expectation.connectionId!==connectionId||remove)fail('RECEIPT_TARGET_MISMATCH','Stored entity expectation does not match the reconciliation target.');
      for(const expected of expectation.entities){
        const row=listOf(selected.data?.SelectedEntityList_Original).find(e=>(e.OriginalName||e.Name)===expected.OriginalName);
        const attributes=await this.portalRead({tenant:host,auth,operationId:'connections.entityAttributes',input:{inputParameters:{ConnectionId:connectionId,EntityName:expected.OriginalName},screenVariables}});
        const shape=Array.isArray(attributes.data?.AttributesList)||Array.isArray(attributes.data?.AttributesList?.List);
        const observed=listOf(attributes.data?.AttributesList);
        const expectedAttributes=expected.Attributes.List;
        const attributesMatch=attributes.ok===true&&shape&&observed.length===expectedAttributes.length&&new Set(observed.map(a=>a.OriginalName||a.Name)).size===observed.length&&expectedAttributes.every(a=>{
          const b=observed.find(x=>(x.OriginalName||x.Name)===a.OriginalName);
          return b&&['Name','DataType','IsSelected','IsPrimaryKey','DefaultValue','HasCustomDefaultValue'].every(k=>b[k]===a[k]);
        });
        const check={object:expected.OriginalName,nameMatches:row?.Name===expected.Name,attributesMatch};metadataChecks.push(check);
        all=all&&check.nameMatches&&attributesMatch;
      }
    }
    if (all && ['accepted', 'uncertain'].includes(saved.receipt?.state)) this.receipts.reconcile(this.receipts.lookup(operationUuid), { state: 'confirmed', observation: { operationId: 'connections.selectedEntities', objects, removed: remove, ...(expectation?{planSha256:expectation.planSha256,metadataChecks}:{}) } });
    const receipt = receiptOf(this.receipts.lookup(operationUuid));
    return { ...saved, ...(all && receipt?.state === 'confirmed' ? { ok: true } : {}), receipt, readBack: { selected: names, verified: all, ...(expectation?{metadataChecks,metadataVerified:all}:{}), ...(remove ? { allRemoved: all } : { allImported: all }), ...(!selected.ok ? { error: selected.error } : {}) } };
  }
}

const CONFIGURATIONS = {
  'mobile-extensibility': {param:'applicationKey',get:MOBILE_EXTENSIBILITY_PATCH.replace(':patch:',':get:'),patch:MOBILE_EXTENSIBILITY_PATCH},
  application: { param: 'applicationKey', get: 'asset-configurations-api-v1:get:/environments/{environmentKey}/applications/{applicationKey}/revisions/deployed/configurations',
    revision: 'asset-configurations-api-v1:get:/environments/{environmentKey}/applications/{applicationKey}/revisions/{baselineRevision}/configurations',
    patch: 'asset-configurations-api-v1:patch:/environments/{environmentKey}/applications/{applicationKey}/configurations' },
  agent: { param: 'agentKey', get: 'asset-configurations-api-v1:get:/environments/{environmentKey}/agents/{agentKey}/revisions/deployed/configurations',
    revision: 'asset-configurations-api-v1:get:/environments/{environmentKey}/agents/{agentKey}/revisions/{baselineRevision}/configurations',
    patch: 'asset-configurations-api-v1:patch:/environments/{environmentKey}/agents/{agentKey}/configurations' },
  environment: { get: 'asset-configurations-api-v1:get:/environments/{environmentKey}/default-system-configurations',
    patch: 'asset-configurations-api-v1:patch:/environments/{environmentKey}/default-system-configurations' },
};
const NULL_HANDLING = { NullWriteBehavior: 'ConvertNull', Boolean: 'False', Date: '1900-01-01', Time: '00:00:00', DateTime: '1900-01-01 00:00:00', Integer: '0', LongInteger: '0', Decimal: '0.0', Text: '' };
const elementVariables = connectionId => ({ ConnectionId: connectionId, _connectionIdInDataFetchStatus: 1, Source: '', _sourceInDataFetchStatus: 1,
  ForceRefreshFail: false, _forceRefreshFailInDataFetchStatus: 1, ForceSupportBoth: false, _forceSupportBothInDataFetchStatus: 1 });
const listOf = value => Array.isArray(value) ? value : Array.isArray(value?.List) ? value.List : [];

// Timer, integration and library-setting values of a configuration patch, each with what the read-back holds under the
// same keys. A null value removes the override (live: the read-back shows the default origin again).
function nestedConfigurations(body, data, prefix='') {
  const found = [];
  for (const config of Array.isArray(body?.systemConfigurations) ? body.systemConfigurations : [])
    found.push({pointer:prefix+'/systemConfigurations/'+body.systemConfigurations.indexOf(config)+'/value',group:'systemConfigurations',parent:null,key:config?.key,value:config?.value ?? null,
      observed:(data?.systemConfigurations??[]).find(s=>s.key===config?.key)});
  for (const [group, items] of [['timers', 'configs'], ['integrations', 'configs'], ['libraries', 'settings']]) {
    for (const item of Array.isArray(body?.[group]) ? body[group] : []) {
      const seen = (Array.isArray(data?.[group]) ? data[group] : []).find(x => x?.key === item?.key);
      for (const config of Array.isArray(item?.[items]) ? item[items] : []) {
        found.push({ pointer:prefix+'/'+group+'/'+body[group].indexOf(item)+'/'+items+'/'+item[items].indexOf(config)+'/value',group, parent: item.key, key: config?.key, value: config?.value ?? null,
          observed: (Array.isArray(seen?.[items]) ? seen[items] : []).find(x => x?.key === config?.key) });
      }
    }
  }
  for (const library of Array.isArray(body?.libraries) ? body.libraries : []) {
    const observed=(data?.libraries??[]).find(l=>l.key===library?.key);
    for (const item of nestedConfigurations({systemConfigurations:library?.systemConfigurations,integrations:library?.integrations},observed,prefix+'/libraries/'+body.libraries.indexOf(library)))
      found.push({...item,group:'libraries.'+item.group,parent:library.key});
  }
  return found;
}

function derivedUuid(uuid, purpose) {
  if (!isUuid(uuid)) return uuid;
  const h = sha256(uuid.toLowerCase() + ':' + purpose);
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-8' + h.slice(17, 20) + '-' + h.slice(20, 32);
}
// Step 2 of the contract: a Studio is involved but cannot serve this tenant. Never a prompt here.
function studioRefusal(studio, host, extra, hosted = false) {
  return refusal(studio.connected ? 'STUDIO_NOT_SIGNED_IN' : 'STUDIO_NOT_CONNECTED',
    studio.connected ? 'The ODC Studio has no authenticated session on ' + host + '. Headless access through that session is unavailable; no interactive recovery or identity switch was performed.'
      : studio.running ? (studio.hint ?? 'The ODC Studio is open but its bridge is not connected.')
      : hosted ? 'No ODC Studio of the user is open: the user opens it and signs in to ' + host + ' (in hosted mode the Studio session is the only path).'
      : 'No authenticated Studio session is available for ' + host + '. A compatible authorized headless credential is required; this tool does not open the Studio or a login window.',
    { host, ...extra });
}
// Hosted: a path other than the customer's Studio session is never taken.
function hostedOnlyStudio(host, auth) {
  return refusal('HOSTED_STUDIO_SESSION_ONLY', 'auth:"' + auth + '" uses a credential of the SSAM server, which is never used in hosted mode: the call runs only through the session '
    + 'of the user\'s own ODC Studio (auth "auto" or "studio").', { host });
}
function refusal(code, message, extra = {}) { return { ok: false, code, error: { code, message }, ...extra }; }
function precheck(authorize, operationUuid) {
  if (typeof authorize !== 'string' || authorize.trim().length < 8) fail('AUTHORIZATION_REQUIRED', 'Writes need the user\'s own authorization words (authorize), quoted verbatim; only their sha256 is kept.');
  if (!isUuid(operationUuid)) fail('INPUT_INVALID', 'operationUuid must be a new UUID for this write; reuse it only to read the same receipt.');
}
// Tenant classes (tenants.json): personal = free for tests; corporate, client and unknown hosts need the user's
// explicit instruction for each operation; readOnly tenants refuse every write. Destructive writes need words that
// name the target.
export function guardTenant(info, authorize, confirmTenant, approval = null) {
  if (info.readOnly) fail('TENANT_READ_ONLY', 'Tenant ' + info.host + ' is read-only in tenants.json; no write is sent.');
  if (info.class !== 'personal') {
    const label = info.host.split('.')[0].toLowerCase();
    if (confirmTenant !== info.host || !(approval?.host === info.host || authorize.toLowerCase().includes(label))) {
      fail('CORPORATE_TENANT_GUARD', 'Tenant ' + info.host + ' (' + info.class + ') needs the user\'s explicit instruction for this operation: confirmTenant:"' + info.host + '" and words that name ' + label + '.');
    }
  }
}
// The words name a target as whole words, without case or accents; spaces of the name match any run of spaces
// ("OldApp2" does not name "OldApp"). The same rule as the facade's namesWhole (studio-create-app.mjs, D3).
export function namesWhole(words, name) {
  if (typeof words !== 'string' || typeof name !== 'string' || !name.trim()) return false;
  const fold = text => text.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  const pattern = fold(name.trim()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp('(?<![\\p{L}\\p{N}_])' + pattern + '(?![\\p{L}\\p{N}_])', 'iu').test(fold(words));
}
export function guardTarget(authorize, names = []) {
  const words = authorize.toLowerCase();
  const candidates = names.filter(n => typeof n === 'string' && n.trim());
  if (!candidates.some(n => words.includes(n.toLowerCase()))) fail('DESTRUCTIVE_TARGET_NOT_NAMED', 'A destructive write needs the user\'s words to name its target: ' + (candidates.join(' | ') || 'its key'), { candidates });
}
// An internal route added to PORTAL_WRITES as destructive (e.g. the connection delete the live proof captures) names
// its target ({connectionName} or {connectionId}) and the words must contain it, as for the public deletes.
export function guardPortalTarget(effect, authorize, target) {
  if (effect !== 'destructive') return;
  guardTarget(authorize, Object.values(target ?? {}).filter(v => typeof v === 'string' || typeof v === 'number').map(String));
}
// A write that names secretRefs runs only where the bridge reads the vault inside the ODC Studio (CONTRATO.md, wave 2
// item 1). Refused before the reservation, so the same operationUuid stays free.
const secretStudioRequired = host => 'A secret value (external database account, secret setting) goes only through the ODC Studio signed in to ' + host
  + ' with native headless secretRefs support: the bridge reads an existing private entry inside the Studio. Nothing was reserved or sent. '
  + 'Bridge v44 does not provide internal headless Portal authentication. No window or interactive recovery is available through this tool.';
// The bridge's own refusals of secretRefs (PortalCore.cs): nothing was reserved by it or sent.
function secretRefsHint(failure, host) {
  if (failure.gate === 'secret_refs_unsupported') return { hint: 'The attached bridge lacks the required native headless secretRefs capability; nothing was sent. A compatible bridge is required. No Studio restart or interactive fallback is performed.' };
  if (failure.gate === 'secret_ref_missing') return { hint: 'The private entry named by secretRefs is missing or incomplete for ' + host + '; nothing was sent. Provision the entry separately before resuming. This tool never opens a prompt.' };
  if (failure.gate === 'secret_ref_vault') return { hint: 'The Windows vault could not be read inside the ODC Studio; nothing was sent.' };
  return {};
}
// 2xx accepted; 4xx refused by the server (nothing applied); 5xx, transport loss and the bridge's UNCERTAIN may have applied.
function outcomeOf(output) {
  if (output.ok) return 'accepted';
  if (typeof output.status === 'number') return output.status >= 400 && output.status < 500 ? 'rejected' : 'uncertain';
  return !output.thrown && NOT_SENT.has(output.error?.code) ? 'not-sent' : 'uncertain';
}
// The bridge v32 answer (CONTRATO.md): UNCERTAIN wins over any status; a busy gate or a refusal was never sent;
// a 4xx write comes as REMOTE_ERROR with its status; big bodies come as a redacted file under journal\portal\downloads.
function studioAnswer(answer, operationId, host) {
  if (answer?.outcome === 'gate_refused') return { ok: false, operationId, error: { code: 'STUDIO_BUSY', gate: answer.gate ?? null, message: 'The Studio was busy; nothing was sent. Repeat later (a write with a new operationUuid).' } };
  if (answer?.ok === false && answer.code === 'UNCERTAIN') return { ok: false, operationId, ...(typeof answer.status === 'number' ? { status: answer.status } : {}),
    error: { code: 'UNCERTAIN', ...(answer.reason ? { reason: answer.reason } : {}), message: 'The request may have been applied; reconcile by a read, never resend.' } };
  if (answer?.host && String(answer.host).toLowerCase() !== host) return { ok: false, operationId, error: { code: 'HOST_MISMATCH', message: 'The Studio answered for another host.' } };
  if (typeof answer?.status !== 'number') {
    const code = typeof answer?.code === 'string' ? answer.code : 'STUDIO_BRIDGE_FAILED';
    return { ok: false, operationId, error: { code, ...(answer?.gate ? { gate: answer.gate } : {}), message: 'The Studio bridge refused or failed the request.' } };
  }
  const contentType = answer.contentType ?? '';
  const summary = (byteLength, digest) => ({ contentOmitted: true, mediaType: contentType, byteLength, sha256: digest, reason: 'Non-JSON response is not exposed to the model.' });
  let data = null;
  if (answer.body !== undefined) data = answer.body;
  else if (typeof answer.bodyBase64 === 'string') { const bytes = Buffer.from(answer.bodyBase64, 'base64'); data = summary(bytes.length, crypto.createHash('sha256').update(bytes).digest('hex')); }
  else if (typeof answer.text === 'string') data = summary(Buffer.byteLength(answer.text), crypto.createHash('sha256').update(answer.text).digest('hex'));
  else if (typeof answer.bodyFile === 'string') data = { file: answer.bodyFile, byteLength: answer.bytes ?? null, sha256: answer.sha256 ?? null, mediaType: contentType, reason: 'Large body written (redacted) by the bridge.' };
  else if (answer.bodyOmitted) data = { contentOmitted: true, mediaType: contentType, byteLength: answer.bytes ?? null, sha256: answer.sha256 ?? null, reason: 'Body above 16 MB was not read.' };
  const ok = answer.status >= 200 && answer.status < 300;
  return trustedProjection({ ok, operationId, status: answer.status, data,
    ...(!ok ? { error: { code: answer.status === 401 ? 'STUDIO_SESSION_REJECTED' : answer.status === 403 ? 'API_FORBIDDEN' : 'API_ERROR',
      message: answer.status === 401 ? 'The gateway did not accept the Studio session for this API family; repeat with auth:"api-client" if a vault API Client exists.'
        : answer.status === 403 ? 'The signed-in user is not authorized for this operation.' : 'The API returned an unsuccessful response.' } } : {}) });
}
const authOf = resolved => ({ path: resolved.path, host: resolved.host, ...(resolved.user ? { user: resolved.user } : {}) });
const noteOf = (host, resolved, output) => '[' + host + '] auth=' + resolved.path + ' status=' + (output.status ?? output.error?.code ?? '?');
const receiptOf = receipt => ({ operationUuid: receipt.operationUuid, state: receipt.state, file: receipt.receipt, createdAt: receipt.createdAt, updatedAt: receipt.updatedAt ?? null,
  ...(receipt.response ? { response: receipt.response } : {}), ...(receipt.reconciliations ? { reconciliations: receipt.reconciliations.length } : {}) });
function answerExisting(existing, operationId, host) {
  return { ok: existing.ok === true, operationId, tenant: host, existingReceipt: true, replayed: false, receipt: receiptOf(existing),
    ...(existing.state==='confirmed'&&operationId===A2A_DISCOVER
      ?{continuation:a2aDiscoveryContinuation(existing.operationUuid,existing.reconciliation?.a2aDiscovery)}:{}),
    ...(existing.state === 'uncertain' ? { reconcile: reconcileHint(operationId, host, existing) } : {}),
    message: existing.state === 'not-sent' || existing.state === 'rejected' ? 'This operationUuid already ended (' + existing.state + '); nothing was sent again. A new attempt needs a new operationUuid.'
      : 'This operationUuid was already used; nothing was sent again.' };
}
function reconcileHint(operationId, host, receipt) {
  const job = Object.entries(OPERATION_STATUS).find(([, spec]) => spec.start === operationId);
  return 'Never resend. Read the target (' + (job ? 'odc_read on the list of ' + job[0] + ' operations, then odc_operation_status' : 'odc_read of the affected resource') + ' on ' + host
    + '), then odc_receipt {operationUuid:"' + receipt.operationUuid + '", reconcile:{state, read, authorize}} with the user\'s words.';
}
function safeSession(value) {
  const clean = redactValues(value);
  for (const key of ['credentialConfigured', 'bootstrapRequired', 'authenticated', 'ok']) if (typeof value?.[key] === 'boolean') clean[key] = value[key];
  if (value?.session && typeof value.session === 'object') clean.session = safeSession(value.session);
  return clean;
}
