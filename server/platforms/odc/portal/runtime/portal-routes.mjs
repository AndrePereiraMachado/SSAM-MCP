// Internal Portal screenservices (observed wire contracts, not public APIs): one table for every session that can
// reach them headlessly (a capable native session or the private-credential broker, odc3-context.mjs).
// Each entry is [module, wire view, action path, metadata discovery view?]. Anything not listed is refused.
import { fail, redact } from './errors.mjs';

export const PORTAL_READS = Object.freeze({
  // Shared aside data action called by the Apps shell. This returns menu
  // options, not the header/light-access-token actions beside it.
  'portal.navigation': ['apps','apps.apps','UnifiedExperienceCommonLib/UnifiedExpTools/UnifiedExperienceAside/DataActionGetUEAside'],
  'apiClients.list': ['usersaccess','APIClients.apiclients','usersaccess/APIClients/apiclients/DataActionApiClients_GetAll'],
  'apiClients.statuses': ['usersaccess','APIClients.apiclients','usersaccess/APIClients/apiclients/DataActionApiClientsStatus_GetAll'],
  'apiClients.detail': ['usersaccess','APIClients.apiclient','usersaccess/APIClients/apiclient/DataActionGetApiClientByKey'],
  'connections.alternateInventory':['connections','Connections.connections_RDDFT1370','connections/Connections/connections_RDDFT1370/DataActionGetConnections'],
  'mobileExtensibility.stages': ['apps','ApplicationMobile.extensibillitysetting','apps/ApplicationMobile/extensibillitysetting/DataActionGetApplicationStages'],
  'mobileExtensibility.revision': ['apps','ApplicationMobile.extensibillitysetting','apps/ApplicationMobile/extensibillitysetting/DataActionGetLatestDeployedAppVersion'],
  'mobileExtensibility.setting': ['apps','ApplicationMobile.extensibillitysetting','apps/ApplicationMobile/extensibillitysetting/DataActionGetExtensibilitySettingInfo'],
  // AI model console prerequisites, captured from its public controllers on
  // 2026-10-10. Raw data actions only; wake-up and model creation are writes.
  'aiModels.list': ['aimodels', 'MainFlow.aimodels', 'aimodels/MainFlow/aimodels/DataActionGetAIModels'],
  'aiModels.stages': ['aimodels', 'MainFlow.aimodels', 'aimodels/MainFlow/aimodels/DataActionGetStages'],
  'aiModels.providers': ['aimodels', 'MainFlow.aimodels', 'aimodels/MainFlow/AIModelProvider_List/DataActionGetProviders'],
  'aiModels.trials': ['aimodels', 'MainFlow.aimodels', 'aimodels/MainFlow/TrialAIModel_List/DataActionGetTrials'],
  'aiModels.detail': ['aimodels', 'MainFlow.aimodel', 'aimodels/MainFlow/aimodel/DataActionGetAIModel'],
  // Knowledge-base creation prerequisites, observed in the current native
  // createknowledgebase controller. Both data actions have no input parameters.
  'knowledgeBases.createStages': ['knowledgebases', 'KnowledgeBases.createknowledgebase', 'knowledgebases/KnowledgeBases/createknowledgebase/DataActionGetStages'],
  'knowledgeBases.uploadLimits': ['knowledgebases', 'DataSources.datasource', 'knowledgebases/DataSources/datasource/DataActionGetUploadLimits'],
  'knowledgeBases.fileEnums': ['knowledgebases', 'DataSources.datasource', 'knowledgebases/DataSources/datasource/DataActionGetEnums'],
  'knowledgeBases.fileDetail': ['knowledgebases', 'DataSourceFile.datasourcefile', 'knowledgebases/DataSourceFile/datasourcefile/DataActionGetDataSourceFile'],
  'knowledgeBases.detail': ['knowledgebases', 'KnowledgeBases.knowledgebase', 'knowledgebases/KnowledgeBases/knowledgebase/DataActionGetKnowledgeBase'],
  'knowledgeBases.dataSources': ['knowledgebases', 'KnowledgeBases.knowledgebase', 'knowledgebases/KnowledgeBases/knowledgebase/DataActionGetDataSources'],
  'knowledgeBases.dataSource': ['knowledgebases', 'DataSources.datasource', 'knowledgebases/DataSources/datasource/DataActionGetDataSource'],
  'knowledgeBases.files': ['knowledgebases', 'DataSources.datasource', 'knowledgebases/DataSources/datasource/DataActionGetFiles'],
  'knowledgeBases.sourceStages': ['knowledgebases', 'DataSources.datasource', 'knowledgebases/DataSources/datasource/DataActionGetKnowledgeBaseAndStages'],
  'knowledgeBases.chunkingMethods': ['knowledgebases', 'KnowledgeBases.createknowledgebase', 'knowledgebases/KnowledgeBases/createknowledgebase/DataActionGetChunkingMethods'],
  'knowledgeBases.list': ['knowledgebases', 'KnowledgeBases.knowledgebases', 'knowledgebases/KnowledgeBases/knowledgebases/DataActionGetKnowledgeBases'],
  'knowledgeBases.consumers': ['knowledgebases', 'KnowledgeBases.knowledgebases', 'knowledgebases/Common_WebBlocks/KnowledgeBase_DeletePopup/DataActionGetConsumersList'],
  // Native mobile package screens, discovered live 2026-10-09. Data actions
  // enumerate supported build types; they do not save settings or start builds.
  'mobile.androidBuildTypes': ['apps', 'ApplicationMobile.createandroidpackage', 'apps/ApplicationMobile/createandroidpackage/DataActionGetAndroidBuildType_NAOS'],
  'mobile.iosBuildTypes': ['apps', 'ApplicationMobile.createiospackage', 'apps/ApplicationMobile/createiospackage/DataActionGetiOSBuildType_NAOS'],
  // Native library release screen prerequisites (public scripts captured 2026-10-09).
  // Revision selection uses screenVariables.id and _idInDataFetchStatus=1.
  'libraries.releaseSettings': ['apps', 'library.libraryrelease', 'apps/library/libraryrelease/DataActionGetSettings'],
  'libraries.releaseRevision': ['apps', 'library.libraryrelease', 'apps/library/libraryrelease/DataActionGetRevision'],
  // Current Timers.timer read prerequisites. Screen variables are appid, stageid,
  // id and their _<name>InDataFetchStatus=1 fields, from the live screen model.
  'timers.info': ['apps', 'Timers.timer', 'apps/Timers/timer/DataActionGetTimerInfo'],
  'timers.currentRun': ['apps', 'Timers.timer', 'apps/Timers/timer/DataActionGetCurrentTimerRunInformation'],
  'timers.pendingConfiguration': ['apps', 'Timers.timer', 'apps/Timers/timer/DataActionGetPendingConfiguration'],
  'timers.latestDeployment': ['apps', 'Timers.timer', 'apps/Timers/timer/DataActionGetLatestDeployedAppVersion'],
  'timers.stages': ['apps', 'Timers.timer', 'apps/Timers/timer/DataActionGetApplicationStages'],
  'timers.deploymentStatus': ['apps', 'Timers.timer', 'apps/Timers/timer/DataActionCheckLatestDeployment'],
  // Read-only prerequisites of the native trace block; not standalone typed operations.
  'monitoring.traceStage': ['monitoring', 'traces.trace', 'monitoring/traces/trace/DataActionGetStage'],
  'monitoring.traceSettings': ['monitoring', 'traces.trace', 'monitoring/traces/trace/DataActionGetSettings'],
  // Typed reads with input preparation and response projection in portal-read.mjs.
  'monitoring.stages': ['monitoring', 'logs.logs', 'monitoring/logs/logs/DataActionGetFilter_Stages'],
  'monitoring.applications': ['monitoring', 'logs.logs', 'monitoring/logs/logs/ActionStage_GetApplications_Wrapper'],
  'monitoring.logs': ['monitoring', 'logs.logs', 'monitoring/logs/logs/DataActionLogSearch'],
  'monitoring.errors': ['monitoring', 'logs.logs', 'monitoring/logs/logs/DataActionLogSearch'],
  'monitoring.detail': ['monitoring', 'logs.log', 'monitoring/logs/log/DataActionGetLogById'],
  'monitoring.trace': ['monitoring', 'traces.trace', 'monitoring/traces/TreeView_multipleRoots/DataActionGetSpans', 'traces.trace'],
  'monitoring.traceLogs': ['monitoring', 'traces.trace', 'monitoring/traces/TreeView_multipleRoots/DataActionGetLogsByTraceId', 'traces.trace'],
  'monitoring.traceSummary': ['monitoring', 'traces.trace', 'monitoring/traces/trace/DataActionGetTraceById'],
  'monitoring.traces': ['monitoring', 'traces.traces', 'monitoring/traces/traces/ActionTraceSearch_Wrapper'],
  // Search-service prerequisites observed in the current Connections controller.
  'connections.azureSearchNameAvailability': ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_AzureAISearch/ActionConnection_CheckNameAvailability_Wrapper'],
  'connections.customSearchNameAvailability': ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_CustomAISearch/ActionConnection_CheckNameAvailability_Wrapper'],
  'connections.azureSearchQueryTypes': ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_AzureAISearch/DataActionGetQueryTypes'],
  'connections.azureSearchQueryTypeLabels': ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_View_AzureAISearch/DataActionGetQueryTypeLabels'],
  'connections.providers': ['connections', 'Connections.connections', 'connections/Connections/connections/DataActionGetProviders'],
  'connections.list': ['connections', 'Connections.connections', 'connections/Connections/connections/DataActionGetConnections'],
  // Raw reads: {inputParameters, screenVariables, clientVariables} in, the redacted data envelope out.
  'connections.settings': ['connections', 'Connections.connection', 'connections/Connections/connection/DataActionGetSettings'],
  'connections.a2aAuthenticationOptions': ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_A2A/DataActionGetAuthenticationTypesAndKeyLocations'],
  'connections.a2aNameAvailability': ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_A2A/ActionConnection_CheckNameAvailability_Wrapper'],
  'connections.testStatus': ['connections', 'Connections.connection', 'connections/ConnectionsCommon/Connection_GetTestStatus/DataActionGetStatus'],
  'connections.relationalNameAvailability': ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnection_CheckNameAvailability_Wrapper'],
  'connections.mcpNameAvailability': ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_MCPServer/ActionConnection_CheckNameAvailability_Wrapper'],
  'connections.mcpAuthenticationTypes': ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_MCPServer/DataActionGetAuthenticationTypes'],
  'connections.mcpTransportTypes': ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_MCPServer/DataActionGetTransportTypes'],
  'connections.mcpAuthenticationSchemes': ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_MCPServer/DataActionGetAuthenticationSchemes'],
  'connections.mcpKeyLocations': ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_MCPServer/DataActionGetKeyLocations'],
  'connections.connection': ['connections', 'Connections.elements', 'connections/Connections/elements/DataActionGetConnection'],
  'connections.detail': ['connections', 'Connections.connection', 'connections/Connections/connection/DataActionGetConnection'],
  'connections.revisionAndStages': ['connections', 'Connections.connection_v2', 'connections/Connections/connection_v2/DataActionGetLatestRevisionAndStages'],
  'connections.assetForStage': ['connections', 'Connections.connection_v2', 'connections/Connections/connection_v2/DataActionGetAssetDataForStage'],
  'connections.entities': ['connections', 'Connections.elements', 'connections/Connections/elements/DataActionGetEntities'],
  'connections.selectedEntities': ['connections', 'Connections.elements', 'connections/Connections/elements/DataActionGetSelectedEntities'],
  'connections.entityAttributes': ['connections', 'Connections.elements', 'connections/Connections/elements/ActionConnection_GetEntityAttributes_Wrapper'],
  'connections.actions': ['connections', 'Connections.elements', 'connections/Connections/elements/DataActionGetActions'],
  'connections.selectedActions': ['connections', 'Connections.elements', 'connections/Connections/elements/DataActionGetSelectedActions'],
  'agents.evaluationsAvailable': ['agents', 'Evaluations.evaluations', 'agents/Evaluations/evaluations/ActionCheckEvaluationsConsoleAvailability'],
  'agents.evaluationFeatures': ['agents', 'Evaluations.evaluations', 'agents/Evaluations/evaluations/DataActionGetFeatureToggles'],
  'agents.consoleAvailable': ['agents', 'AgentsV2.agent', 'agents/AgentsV2/agent/ActionCheckAgentsConsoleAvailability'],
  'agents.listLegacy': ['agents', 'AgentsV2.agents', 'agents/AgenticApps/AgentsV1/DataActionGetAgents'],
  'agents.listV2': ['agents', 'AgentsV2.agents', 'agents/AgentsV2/AgentsV2_AgentList/DataActionGetAgents'],
  'agents.legacyFeatures': ['agents', 'AgenticApps.agenticapp', 'agents/AgenticApps/agenticapp/DataActionGetSettingsAndFeatureToggles'],
  'agents.revisionStages': ['agents', 'AgenticApps.agenticapp', 'agents/AgenticApps/agenticapp/DataActionGetLatestAgentRevisionAndAgentStages'],
  'agents.datasets': ['agents', 'Evaluations.evaluations', 'agents/Evaluations/EvalsHome_DatasetList/DataActionGetDatasets'],
  'agents.dataset': ['agents', 'Evaluations_Datasets.dataset', 'agents/Evaluations_Datasets/dataset/DataActionGetDataset'],
  'agents.datasetEvaluations': ['agents', 'Evaluations_Datasets.dataset', 'agents/Evaluations_Datasets/Dataset_DetailsMoreOptions/DataActionGetEvaluationsByDatasetId'],
  'agents.datasetSchema': ['agents', 'Evaluations_Datasets.dataset', 'agents/Evaluations_Datasets/Dataset_TestCase_Create/DataActionGetJsonSchema'],
  'agents.evaluations': ['agents', 'Evaluations.evaluations', 'agents/Evaluations/EvalsHome_EvaluationList/DataActionGetEvaluations'],
  'agents.evaluationRuns': ['agents', 'Evaluations.evaluations', 'agents/Evaluations/EvalsHome_RunsList/DataActionGetEvaluationRuns'],
  'agents.evaluationHistory': ['agents', 'Evaluations_Details.evaluation', 'agents/Evaluations_Details/EvaluationDetails_RunList/DataActionGetEvaluationRuns'],
  'agents.agenticApps': ['agents', 'Evaluations_Datasets.dataset', 'agents/Evaluations_Datasets/Dataset_Form/DataActionGetAgenticApps'],
  'agents.serviceActions': ['agents', 'Evaluations_Datasets.dataset', 'agents/Evaluations_Components/Dropdown_ServiceActions/DataActionGetServiceActionsByApp'],
  'agents.datasetTemplate': ['agents', 'Evaluations_Datasets.dataset', 'agents/Evaluations_Datasets/Dataset_Form/ActionDataset_GetTemplate_Wrapper'],
  'agents.judges': ['agents', 'Evaluations_Details.evaluation', 'agents/Evaluations_Details/Evaluation_CreateForm/DataActionGetJudges'],
  'agents.evaluationDatasets': ['agents', 'Evaluations_Details.evaluation', 'agents/Evaluations_Details/Evaluation_CreateForm/DataActionGetDatasets'],
  'agents.evaluation': ['agents', 'Evaluations_Details.evaluation', 'agents/Evaluations_Details/evaluation/DataActionGetEvaluation'],
  'agents.evaluationDevStage': ['agents', 'Evaluations_Details.evaluation', 'agents/Evaluations_Details/evaluation/DataActionGetDevStage'],
  'agents.evaluationOngoingRun': ['agents', 'Evaluations_Details.evaluation', 'agents/Evaluations_Details/evaluation/DataActionGetOngoingEvaluationRun'],
  'agents.evaluationRunStatus': ['agents', 'Evaluations_Details.evaluation', 'agents/Evaluations_Details/evaluation/ActionEvaluationRun_GetStatus_Wrapper'],
  'agents.evaluationRun': ['agents', 'Evaluations_Details.evaluation', 'agents/Evaluations_EvaluationRuns/EvaluationRun_DetailedResults/DataActionGetEvaluationRun'],
  'agents.stages': ['agents', 'MainFlow_Agents.agent', 'agents/MainFlow_Agents/agent/DataActionGetApplicationStages'],
  'agents.latestRevision': ['agents', 'MainFlow_Agents.agent', 'agents/MainFlow_Agents/agent/DataActionGetLatestAgentRevision'],
  'agents.elements': ['agents', 'AgenticApps.agenticapp', 'agents/AgenticApps_AgentElements/Agent_Elements/DataActionGetAgents'],
  'agents.guardrails': ['agents', 'AgenticApps.agenticapp', 'agents/AgenticApps_AgentElements/Agent_Guardrails/DataActionGetAgentGuardrail'],
  'agents.guardrailsV2': ['agents', 'AgentsV2.agent', 'agents/AgentsV2/AgentV2_Guardrails/DataActionGetAgentGuardrail'],
  'agents.guardrailsV5': ['agents', 'AgenticApps.agenticapp', 'agents/AgenticApps_AgentElements/Agent_Guardrails_v5/DataActionGetAgentGuardrail'],
  'guardrails.stages': ['agentguardrails', 'MainFlow.agentguardrails', 'agentguardrails/MainFlow/agentguardrails/DataActionGetStages'],
  'guardrails.baseline': ['agentguardrails', 'MainFlow.agentguardrails', 'agentguardrails/MainFlow/agentguardrails/DataActionGetGuardrail'],
  'guardrails.features': ['agentguardrails', 'MainFlow.agentguardrails', 'agentguardrails/MainFlow/agentguardrails/DataActionGetFeatureToggles'],
});
// effect: external-test contacts the external system without saving an asset; mutation changes the tenant.
export const PORTAL_WRITES = Object.freeze({
  'apiClients.create': {route:['usersaccess','APIClients.apiclient','usersaccess/APIClients/apiclient/ActionAPIClients_Create'],effect:'mutation'},
  'apiClients.delete': {route:['usersaccess','APIClients.apiclient','usersaccess/APIClients/DeleteAPIClient/ActionAPIClients_Delete'],effect:'destructive'},
  'connections.customSearchTest': {route:['connections','Connections.connection','connections/ProviderBlocks/Connection_Edit_CustomAISearch/ActionConnections_CustomAISearch_Test_Wrapper'],effect:'external-test'},
  'connections.customSearchSave': {route:['connections','Connections.connection','connections/ProviderBlocks/Connection_Edit_CustomAISearch/ActionConnection_Convert_CustomAISearch'],effect:'mutation'},
  'mobileExtensibility.uploadFile': {route:['apps','ApplicationMobile.extensibillitysetting','apps/ApplicationMobile/extensibillitysetting/ActionFileUpload_Wrapper'],effect:'mutation'},
  'mobileExtensibility.convertFile': {route:['apps','ApplicationMobile.extensibillitysetting','apps/ApplicationMobile/extensibillitysetting/ActionBinaryToBase64'],effect:'mutation'},
  'mobileExtensibility.saveFile': {route:['apps','ApplicationMobile.extensibillitysetting','apps/ApplicationMobile/extensibillitysetting/ActionExtensbilitySettingSave_Wrapper'],effect:'mutation'},
  'guardrails.baselineSave': { route: ['agentguardrails', 'MainFlow.agentguardrails', 'agentguardrails/MainFlow/agentguardrails/ActionUI_Guardrails_CreateOrUpdate_v5'], effect: 'mutation' },
  'aiModels.trialCreate': { route: ['aimodels', 'MainFlow.aimodels', 'aimodels/MainFlow/AddAIModel_Popup/ActionUI_AIModelTrial_Create'], effect: 'mutation' },
  'aiModels.trialDelete': { route: ['aimodels', 'MainFlow.aimodel', 'aimodels/CommonWidgets/AIModel_MoreOptions/ActionUI_AIModel_Delete'], effect: 'destructive' },
  'knowledgeBases.uploadFile': { route: ['knowledgebases', 'DataSources.datasource', 'knowledgebases/DataSources/datasource/ActionDataSourceFile_Upload_Wrapper'], effect: 'mutation' },
  'connections.a2aDiscover': {route:['connections','Connections.connection','connections/ProviderBlocks/Connection_Edit_A2A/ActionAgentDiscovery_GetAgentCard_Wrapper'],effect:'external-test'},
  'connections.a2aTest': {route:['connections','Connections.connection','connections/ProviderBlocks/Connection_Edit_A2A/ActionConnections_A2A_Test_Wrapper'],effect:'external-test'},
  'connections.a2aSave': {route:['connections','Connections.connection','connections/ProviderBlocks/Connection_Edit_A2A/ActionConnection_Convert_A2A'],effect:'mutation'},
  'knowledgeBases.create': {route:['knowledgebases','KnowledgeBases.createknowledgebase','knowledgebases/KnowledgeBases/createknowledgebase/ActionKnowledgeBase_Create_Wrapper'],effect:'mutation'},
  'knowledgeBases.delete': {route:['knowledgebases','KnowledgeBases.knowledgebases','knowledgebases/Common_WebBlocks/KnowledgeBase_DeletePopup/ActionKnowledgeBase_Delete_Wrapper'],effect:'destructive'},
  'libraries.release': { route: ['apps', 'library.libraryrelease', 'apps/library/libraryrelease/ActionReleaseLibrary_ValidateAndSave'], effect: 'mutation' },
  'connections.delete': { route: ['connections', 'Connections.connection', 'connections/Connections/connection/ActionConnection_Delete_Wrapper'], effect: 'destructive' },
  // Public facade preflight validates the exact deployed timer and named authorization.
  // Acceptance is not execution/completion proof; the receipt carries a read continuation.
  'timers.run': { route: ['apps', 'Timers.timer', 'apps/Timers/timer/ActionWakeTimer_Wrapper'], effect: 'mutation' },
  'timers.pause': { route: ['apps', 'Timers.timer', 'apps/Timers/timer/ActionTimers_SaveAndApply'], effect: 'mutation' },
  'timers.resume': { route: ['apps', 'Timers.timer', 'apps/Timers/timer/ActionTimers_SaveAndApply'], effect: 'mutation' },
  'connections.relationalTest': { route: ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnections_RelationalDB_Test_Wrapper'], effect: 'external-test' },
  'connections.relationalSave': { route: ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnection_Convert_RelationalDB'], effect: 'mutation' },
  'connections.importEntities': { route: ['connections', 'Connections.elements', 'connections/Connections/elements/ActionConnectionDBObjects_Save_V1_1_Wrapper'], effect: 'mutation' },
  'connections.importActions': { route: ['connections', 'Connections.elements', 'connections/Connections/elements/ActionConnectionDBObjects_Save_V1_1_Wrapper'], effect: 'mutation' },
  'connections.mcpTest': { route: ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_MCPServer/ActionConnections_MCPServer_Test_Wrapper'], effect: 'external-test' },
  'connections.mcpSave': { route: ['connections', 'Connections.connection', 'connections/ProviderBlocks/Connection_Edit_MCPServer/ActionConnection_Convert_MCPServer'], effect: 'mutation' },
  'agents.datasetCreate': { route: ['agents', 'Evaluations_Datasets.dataset', 'agents/Evaluations_Datasets/Dataset_Form/ActionDataset_Create'], effect: 'mutation' },
  'agents.datasetDelete': { route: ['agents', 'Evaluations_Datasets.dataset', 'agents/Evaluations_Datasets/Dataset_DetailsMoreOptions/ActionDataset_Delete_Wrapper'], effect: 'destructive' },
  'agents.evaluationCreate': { route: ['agents', 'Evaluations_Details.evaluation', 'agents/Evaluations_Details/Evaluation_CreateForm/ActionEvaluation_Create_Wrapper'], effect: 'mutation' },
  'agents.evaluationRunCreate': { route: ['agents', 'Evaluations_Details.evaluation', 'agents/Evaluations_Details/evaluation/ActionEvaluationRun_Create_Wrapper'], effect: 'mutation' },
  'agents.evaluationDelete': { route: ['agents', 'Evaluations_Details.evaluation', 'agents/Evaluations_Details/EvaluationDetails_MoreOptions/ActionEvaluation_Delete_Wrapper'], effect: 'destructive' },
  'agents.guardrailsSave': { route: ['agents', 'AgenticApps.agenticapp', 'agents/AgenticApps_AgentElements/Agent_Guardrails_v5/ActionUI_SaveGuardrails_v5'], effect: 'mutation' },
  // Publishes a generated External Library job (ReadyForReview) into a library revision: input {JobKey}. The route the
  // Portal's "Publish" button of the External Library wizard calls (GitSSAM proved it); its moduleVersion and apiVersion
  // come from PortalMetadata at each call, never pinned. Used by odc_external_library deploy.
  'externalLibraries.publishJob': { route: ['logic', 'CreateExternalLibraryWizard.createnewrevision', 'logic/CreateExternalLibraryWizard/createnewrevision/ActionExternalLibraryPublishJob'], effect: 'mutation' },
});
// Known Portal features without a validated executable contract: refused, never guessed from a similar name. Each
// refusal carries the capture step of the live proof as its continuation (odc_portal_routes with PORTAL_CAPTURE: GETs of
// the module's own public assets, no action executed). Enable PORTAL_WRITES only after validating inputs/effects;
// prove the exact action with the user's words on a named harmless target in the selected tenant, confirmed by a read.
// W17 (the timer run/pause/resume and connection delete routes, captured in another session) lands here, one id at a
// time and only with the captured [module, view, action]:
//   1. PORTAL_WRITES[id] = { route: [module, view, action], effect }: timers.* 'mutation'; connections.delete
//      'destructive' (portalWrite then needs a target whose name the user's words contain);
//   2. remove id from PORTAL_GAPS and PORTAL_CAPTURE (routeOf stops refusing it);
//   3. catalog/portal-capabilities.json: id from access.unmapped to access.writes (portal.timers, or
//      portal.external-db-management and portal.agent-connections) and odc_portal_write in their access.tools;
//   4. connections.delete only: OdcAccess.dbDelete (access.mjs) reads the connection, then portalWrite with target
//      {connectionId, connectionName}; odc_portal_write has no target argument, so it refuses a destructive route;
//   5. tests: the W17 tests of access.test.mjs and portal-capabilities.test.mjs switch branch by themselves.
const captureTimer = verb => 'Live proof: odc_portal_login on the explicitly selected tenant using a headless session, then odc_portal_routes {module:"apps", view:"Timers.timer", match:"' + verb + '"} reads public metadata by GET only. '
  + 'Validate the inputs, current timer state and concurrency contract before enabling a write; execution needs the user\'s words for a named harmless timer and independent read-back.';
export const PORTAL_GAPS = Object.freeze({});
// odc_portal_routes arguments of each gap's capture step (the tenant is added by the answer that refuses).
export const PORTAL_CAPTURE = Object.freeze({});
export const captureStep = id => ({ tool: 'odc_portal_routes', arguments: { ...PORTAL_CAPTURE[id] },
  why: 'No validated executable route for ' + id + ': lists the screenservice actions of the ' + PORTAL_CAPTURE[id].module + ' module (GETs only, nothing called) for the live proof.' });
// Portal modules whose assets odc_portal_routes never reads (sign-in and identity surfaces, the API gateway).
export const ROUTES_REFUSED_MODULES = Object.freeze(new Set(['authentication', 'identity', 'api']));
export function routesModule(module) {
  const name = typeof module === 'string' ? module.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || ROUTES_REFUSED_MODULES.has(name.toLowerCase())) fail('INPUT_INVALID', 'module must be a Portal module name outside authentication, identity and api.');
  return name;
}
// Returns decrypted connection secrets: never callable, by any session.
export const NEVER_EXPOSED = Object.freeze(new Set(['connections/ProviderBlocks/Connection_Edit_MCPServer/DataActionGetDecryptedSecrets']));

const RAW_INPUT = ['inputParameters', 'screenVariables', 'clientVariables'];
const SECRET_KEY = /^(?:.*password|.*passwd|.*secret|accesstoken|refreshtoken|idtoken|token|privatekey)$/i;
// Generic route input: only the three screenservice objects, bounded, and never a secret value (secrets travel only
// as secretRefs resolved inside the session that sends the request).
export function rawInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !RAW_INPUT.includes(k))) {
    fail('INPUT_INVALID', 'Internal route input accepts only inputParameters, screenVariables and clientVariables.');
  }
  for (const key of RAW_INPUT) if (input[key] !== undefined && (!input[key] || typeof input[key] !== 'object' || Array.isArray(input[key]))) fail('INPUT_INVALID', key + ' must be an object.');
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 262144) fail('REQUEST_TOO_LARGE', 'Internal route input exceeds 256 KiB.');
  const visit = (value, key) => {
    if (typeof value === 'string' && value && SECRET_KEY.test(key ?? '')) fail('SECRET_IN_ARGUMENTS', 'Credentials never travel as tool arguments; the typed helper takes a credential target and the session resolves it privately.', { field: key });
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k);
  };
  visit(input);
  return { inputParameters: input.inputParameters ?? {}, screenVariables: input.screenVariables ?? {}, clientVariables: input.clientVariables ?? {} };
}

// secretRefs (CONTRATO.md): a secret travels only as the name of its Windows vault entry, never as its value, and only
// the bridge reads it, inside the ODC Studio, right before the send (the value never enters this process). Entries of
// this tenant: an external database account in an internal Portal route (SSAM/ODC3/<host>/DB/<name>, user name and
// password, at a JSON pointer of the screenservice input) and a secret setting value in the configurations PATCH of
// portal-call (SSAM/ODC3/<host>/Setting/<name>, the password, at /settings/<i>/value). Each pointer holds an empty
// placeholder. MAX_SECRET_REFS is the bridge's limit (PortalCore.cs MaxSecretRefs).
export const SECRET_FIELDS = Object.freeze(['password', 'username']);
export const MAX_SECRET_REFS = 32;
export const SECRET_KINDS = Object.freeze({
  SettingFile: { vaultKind:'Setting', fields:['password'], pointer:/^\/inputParameters\/(?:FileContent|BinaryData)$/, where:'the exact native binary FileContent or BinaryData placeholder' },
  DB: { fields: SECRET_FIELDS, pointer: /^\/(?:inputParameters|screenVariables|clientVariables)\/[^/]/, where: 'inputParameters, screenVariables or clientVariables' },
  Setting: { fields: ['password'], pointer: /^\/(?:settings\/(?:0|[1-9][0-9]{0,8})|integrations\/(?:0|[1-9][0-9]{0,8})\/configs\/(?:0|[1-9][0-9]{0,8})|libraries\/(?:0|[1-9][0-9]{0,8})\/(?:settings\/(?:0|[1-9][0-9]{0,8})|integrations\/(?:0|[1-9][0-9]{0,8})\/configs\/(?:0|[1-9][0-9]{0,8})))\/value$/, where: 'a setting or integration configuration value, optionally inside a library' },
});
export const dbSecretTarget = (host, name) => 'SSAM/ODC3/' + host + '/DB/' + name;
export const settingSecretTarget = (host, name) => 'SSAM/ODC3/' + host + '/Setting/' + name;
export function checkSecretRefs(host, refs, input, { kind = 'DB' } = {}) {
  if (refs === undefined || refs === null) return [];
  const rule = SECRET_KINDS[kind];
  const vaultKind=rule.vaultKind??kind;
  if (!Array.isArray(refs) || refs.length > MAX_SECRET_REFS) fail('INPUT_INVALID', 'secretRefs is a list of at most ' + MAX_SECRET_REFS + ' {pointer, target, field}.');
  const entry = new RegExp('^SSAM/ODC3/' + String(host).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/' + vaultKind + '/([A-Za-z0-9_.-]{1,64})$');
  return refs.map(ref => {
    if (!ref || typeof ref !== 'object' || Object.keys(ref).some(k => !['pointer', 'target', 'field'].includes(k))) fail('INPUT_INVALID', 'secretRefs entries are {pointer, target, field}.');
    const name = entry.exec(ref.target)?.[1];
    if (!name || !rule.fields.includes(ref.field)) fail('INPUT_INVALID', 'secretRefs name only this tenant\'s ' + kind + ' entries (SSAM/ODC3/<host>/' + kind + '/<name>, field ' + rule.fields.join(' or ') + ').');
    if (typeof ref.pointer !== 'string' || !rule.pointer.test(ref.pointer)) fail('INPUT_INVALID', 'secretRefs pointers must start in ' + rule.where + '.');
    if (input !== undefined && pointerValue(input, ref.pointer) !== '') fail('INPUT_INVALID', 'Each secretRefs pointer must name an existing field holding an empty placeholder: ' + ref.pointer);
    return { pointer: ref.pointer, target: ref.target, field: ref.field, name };
  });
}
// The screenservice body on the wire nests the screen variables under screenData.variables (screenservice() below);
// pointers into the request file of the bridge name the wire body.
export const wirePointer = pointer => pointer.replace(/^\/screenVariables\//, '/screenData/variables/');
// RFC 6901 read; undefined when the path does not exist.
export function pointerValue(target, pointer) {
  let node = target;
  for (const part of pointer.slice(1).split('/').map(p => p.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

export function routeOf(operationId, write) {
  if (Object.hasOwn(PORTAL_GAPS, operationId)) fail('PORTAL_ROUTE_UNMAPPED', PORTAL_GAPS[operationId], { continuation: captureStep(operationId) });
  const entry = write ? PORTAL_WRITES[operationId]?.route : PORTAL_READS[operationId];
  if (!entry) fail('PORTAL_OPERATION_NOT_FOUND', write ? 'Only listed internal Portal writes are implemented.' : 'Only listed internal Portal reads are implemented.');
  if (NEVER_EXPOSED.has(entry[2])) fail('PORTAL_ACCESS_DENIED', 'This internal action is never exposed.');
  return { module: entry[0], view: entry[1], action: entry[2], discoveryView: entry[3] ?? entry[1] };
}

// One screenservice POST with the version metadata the Portal page itself would send. `request` is the session's own
// transport (cookie broker or the Studio Portal window); `extra` carries what only that transport adds.
function exceptionDiagnostic(remote) {
  let nested;
  try { nested = JSON.parse(remote?.message); } catch {}
  const code = value => typeof value === 'string' && /^OS-[A-Z0-9]{2,12}-\d{3,8}$/.test(value);
  const nativeType = remote?.type ?? remote?.name;
  return {
    ...(code(remote?.errorCode) ? { remoteCode: remote.errorCode } : {}),
    ...(code(nested?.ErrorCode) ? { remoteCauseCode: nested.ErrorCode } : {}),
    ...(['SecurityException', 'InvalidArgumentException', 'CommunicationException', 'DatabaseException', 'UserException'].includes(nativeType) ? { remoteType: nativeType } : {}),
  };
}

export async function screenservice({ origin, metadata, request }, { module, view, action, discoveryView = view, inputParameters = {}, screenVariables = {}, clientVariables = {}, signal, extra = {} }) {
  if (NEVER_EXPOSED.has(action)) fail('PORTAL_ACCESS_DENIED', 'This internal action is never exposed.');
  const meta = await metadata.resolve(module, discoveryView, action, signal);
  const response = await request(`${origin}/${module}/screenservices/${meta.action}`, { method: 'POST', signal, ...extra,
    body: { versionInfo: { moduleVersion: meta.moduleVersion, apiVersion: meta.apiVersion }, viewName: view,
      inputParameters, screenData: { variables: screenVariables }, clientVariables } });
  // Everything below happened after the POST: `sent` lets a write tell "refused" from "maybe applied".
  if (response.status === 401 || response.status === 403) fail(response.status === 403 ? 'PORTAL_ACCESS_DENIED' : 'PORTAL_AUTH_REQUIRED', 'Portal session or role does not authorize this call.', { sent: true, status: response.status });
  if (response.status !== 200) {
    let remote;
    try { remote = JSON.parse(response.text)?.exception; } catch { /* Do not expose non-JSON bodies. */ }
    // Observed on the current connections inventory after losing the tool's
    // own cookies: HTTP 250 wraps a precise No Session code. Other 250 errors,
    // role failures, unrelated routes and writes are not authentication hints.
    let nativeSession;
    try { nativeSession = JSON.parse(remote?.message); } catch {}
    if (extra.write !== true && response.status === 250 && module === 'connections'
        && view === 'Connections.connections' && action === 'connections/Connections/connections/DataActionGetConnections'
        && remote?.name === 'UserException' && remote?.specificType === 'Connections_CS.INTC_ConsoleException'
        && remote?.errorCode === 'OS-BERT-00000' && nativeSession?.Type === 'OS-UAUC-60002'
        && nativeSession.ErrorCode === 'OS-UAUC-60002' && nativeSession.Detail === 'No Session' && nativeSession.IsParsed === true)
      fail('PORTAL_AUTH_REQUIRED', 'The native connections inventory requires an authenticated session.', { sent: true, status: 250, reason: 'native-no-session' });
    // This native lookup reports a deleted connection as a UserException (250),
    // not a 404. Require its exact type, route and requested UUID in the
    // missing-connection clause; never infer absence from OS-BERT alone.
    const connectionId = screenVariables.ConnectionId;
    if (extra.write !== true && response.status === 250 && module === 'connections'
        && view === 'Connections.connection' && action === 'connections/Connections/connection/DataActionGetConnection'
        && remote?.name === 'UserException' && remote?.specificType === 'Connections_CS.INTC_ConsoleException'
        && remote?.errorCode === 'OS-BERT-00000' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(connectionId ?? '')) {
      const clauses = String(remote.message ?? '').match(/\bConnection\b[^\r\n]{0,250}?\bdoes not exist\b/gi) ?? [];
      const exact = clauses.some(clause => {
        const ids = clause.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi) ?? [];
        return ids.length === 1 && ids[0].toLowerCase() === connectionId.toLowerCase();
      });
      if (exact) return {data:{NotFound:true,Connection:null},absenceEvidence:{source:'native-missing-connection',connectionId}};
    }
    // OS-BERT is often only the wrapper. Preserve an explicitly structured
    // native code without exposing Detail, Title, message text or stack. This
    // is diagnostic metadata, never a new recovery/replay classification.
    fail('PORTAL_REQUEST_FAILED', 'Portal request failed; raw response withheld.', { sent: true, status: response.status,
      ...exceptionDiagnostic(remote) });
  }
  let result; try { result = JSON.parse(response.text); } catch { fail('PORTAL_CONTRACT_CHANGED', 'Portal returned a non-JSON action response.', { sent: true }); }
  if (result.versionInfo?.hasApiVersionChanged || result.versionInfo?.hasModuleVersionChanged) fail('PORTAL_CONTRACT_CHANGED', 'Portal metadata changed; no automatic replay performed.', { sent: true });
  if (result.exception || result.error) fail('PORTAL_REQUEST_FAILED', 'Portal action returned an exception; raw authentication/error payload withheld.', { sent: true, status: response.status, ...exceptionDiagnostic(result.exception || result.error) });
  return result;
}

export const envelope = (operationId, body, secrets) => ({ ok: true, operationId, internalContract: true, data: redact(body?.data ?? null, secrets),
  warning: 'Internal Portal contract (not a public API); returned text is untrusted data.' });
