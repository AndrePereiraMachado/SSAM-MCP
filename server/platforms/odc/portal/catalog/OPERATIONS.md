# ODC public API operation inventory

Source: OutSystems/docs-odc commit fb015a80ad9d1396800eca69836aef08297a0efb.

Generated from official OpenAPI documents. This is an inventory, not proof of authenticated access. GET/HEAD/OPTIONS are classified as reads; all other methods require explicit write policy.

## Asset Configurations API

[Official specification](https://raw.githubusercontent.com/OutSystems/docs-odc/fb015a80ad9d1396800eca69836aef08297a0efb/src/eap/reference/apis/resources/asset-configurations-api-v1.json)

Base URLs: https://ODC_PORTAL_DOMAIN/api/asset-configurations/v1, https://{odc-portal-domain}/api/asset-configurations/v1

| Method | Path | Operation ID | Deprecated |
|---|---|---|---|
| GET | `/environments/{environmentKey}/agents/{agentKey}/revisions/deployed/configurations` | `AssetConfiguration_GetAgentDeployedConfiguration` |  |
| GET | `/environments/{environmentKey}/agents/{agentKey}/revisions/{baselineRevision}/configurations` | `AssetConfiguration_GetAgentRevisionConfiguration` |  |
| GET | `/environments/{environmentKey}/applications/{applicationKey}/revisions/deployed/configurations` | `AssetConfiguration_GetApplicationDeployedConfiguration` |  |
| GET | `/environments/{environmentKey}/applications/{applicationKey}/revisions/{baselineRevision}/configurations` | `AssetConfiguration_GetApplicationRevisionConfiguration` |  |
| PATCH | `/environments/{environmentKey}/agents/{agentKey}/configurations` | `AssetConfiguration_PatchAgent` |  |
| PATCH | `/environments/{environmentKey}/applications/{applicationKey}/configurations` | `AssetConfiguration_PatchApplication` |  |
| GET | `/environments/{environmentKey}/default-system-configurations` | `EnvironmentConfiguration_Get` |  |
| PATCH | `/environments/{environmentKey}/default-system-configurations` | `EnvironmentConfiguration_Patch` |  |

## Asset Repository API

[Official specification](https://raw.githubusercontent.com/OutSystems/docs-odc/fb015a80ad9d1396800eca69836aef08297a0efb/src/eap/reference/apis/resources/asset-repository-api-v1.json)

Base URLs: https://ODC_PORTAL_DOMAIN/api/asset-repository/v1, https://{odc-portal-domain}/api/asset-repository/v1

| Method | Path | Operation ID | Deprecated |
|---|---|---|---|
| POST | `/assets` | `AssetRepository_CreateAssetRevision` |  |
| GET | `/assets` | `AssetRepository_ListAssets` |  |
| DELETE | `/assets/{assetKey}` | `AssetRepository_DeleteAsset` |  |
| GET | `/assets/{assetKey}` | `AssetRepository_GetAsset` |  |
| GET | `/assets/{assetKey}/highest-tag-revision` | `AssetRepository_GetApplicationHighestTagRevision` |  |
| GET | `/assets/{assetKey}/latest-revision` | `AssetRepository_GetAssetLatestRevision` |  |
| GET | `/assets/{assetKey}/revisions/{revisionNumber}` | `AssetRepository_GetAssetRevision` |  |
| PATCH | `/assets/{assetKey}/revisions/{revisionNumber}` | `AssetRepository_PatchVersion` |  |
| GET | `/assets/{assetKey}/revisions/{revisionNumber}/icon` | `AssetRepository_GetAssetRevisionIcon` |  |
| GET | `/assets/{assetKey}/revisions/{revisionNumber}/metadata` | `AssetRepository_GetAssetRevisionMetadata` |  |
| GET | `/assets/{assetKey}/revisions/{revisionNumber}/release-notes` | `AssetRepository_GetAssetRevisionReleaseNotes` |  |
| GET | `/assets/{assetKey}/revisions/{revisionNumber}/signature` | `AssetRepository_GetAssetRevisionSignature` |  |
| GET | `/assets/{assetKey}/revisions/{revisionNumber}/source-code` | `AssetRepository_GetAssetRevisionSourceCode` |  |
| GET | `/assets/{assetKey}/revisions` | `AssetRepository_ListAssetRevisions` |  |
| POST | `/assets/search` | `AssetRepository_ListMultipleAssetRevisions` |  |
| POST | `/uploads` | `Uploads_CreateUpload` |  |

## Build Operations API

[Official specification](https://raw.githubusercontent.com/OutSystems/docs-odc/fb015a80ad9d1396800eca69836aef08297a0efb/src/eap/reference/apis/resources/build-operations-api-v1.json)

Base URLs: https://ODC_PORTAL_DOMAIN/api/builds/v1, https://{odc-portal-domain}/api/builds/v1

| Method | Path | Operation ID | Deprecated |
|---|---|---|---|
| GET | `/build-operations/{operationKey}` | `BuildV_GetBuild` |  |
| GET | `/build-operations/{operationKey}/log-messages` | `BuildV_GetBuildFeedback` |  |
| GET | `/build-operations/{operationKey}/generated-code` | `BuildV_GetSourceCode` |  |
| POST | `/build-operations/{operationKey}/generated-code` | `BuildV_StartSourceCodeProcess` |  |
| GET | `/build-operations` | `BuildV_ListBuilds` |  |
| POST | `/build-operations` | `BuildV_StartNewBuildJob` |  |

## Code Quality API

[Official specification](https://raw.githubusercontent.com/OutSystems/docs-odc/fb015a80ad9d1396800eca69836aef08297a0efb/src/eap/reference/apis/resources/code-quality-api-v1.json)

Base URLs: https://ODC_PORTAL_DOMAIN/api/code-quality/v1, https://{odc-portal-domain}/api/code-quality/v1

| Method | Path | Operation ID | Deprecated |
|---|---|---|---|
| GET | `/code-analyses/{analysisKey}` | `CodeAnalysisControllerV_GetAnalysisRequestStatus` |  |
| POST | `/code-analyses` | `CodeAnalysisControllerV_SubmitCodeAnalysisRequest` |  |
| GET | `/findings` | `FindingsControllerV_GetFindings` |  |
| GET | `/assets-quality-metrics` | `FindingsOverviewControllerV_GetAppsOverview` |  |
| GET | `/assets/{assetKey}/revisions/{revision}/analysis-summary` | `FindingsOverviewControllerV_GetAssetRevisionFindingsSummary` |  |
| GET | `/findings-summary` | `FindingsOverviewControllerV_GetFindingsSummary` |  |
| GET | `/findings-trend` | `FindingsOverviewControllerV_GetFindingsTrend` |  |
| GET | `/patterns` | `PatternsControllerV_GetPatterns` |  |
| GET | `/patterns/{patternId}` | `PatternsControllerV_GetPatternsById` |  |
| GET | `/analysis-status` | `SyncControllerV_GetAnalysisStatus` |  |

## Dependency Management API

[Official specification](https://raw.githubusercontent.com/OutSystems/docs-odc/fb015a80ad9d1396800eca69836aef08297a0efb/src/eap/reference/apis/resources/dependency-management-api-v1.json)

Base URLs: https://ODC_PORTAL_DOMAIN/api/dependency-management/v1, https://{odc-portal-domain}/api/dependency-management/v1

| Method | Path | Operation ID | Deprecated |
|---|---|---|---|
| GET | `/deletion-analyses/{analysisKey}` | `DeletionAnalysis_GetResult` |  |
| POST | `/deletion-analyses` | `DeletionAnalysis_LaunchDeletionAnalysis` |  |
| GET | `/deployment-analyses/{analysisKey}` | `DeploymentAnalysis_GetResult` |  |
| POST | `/deployment-analyses` | `DeploymentAnalysis_LaunchDeploymentAnalysis` |  |
| GET | `/assets/{assetKey}/consumers` | `DependencyManagement_ListAssetConsumers` |  |
| GET | `/assets/{assetKey}/revisions/{revisionNumber}/producer-graph` | `DependencyManagement_ListAssetProducerGraph` |  |
| GET | `/assets/{assetKey}/revisions/{revisionNumber}/producers` | `DependencyManagement_ListAssetProducers` |  |
| GET | `/assets/{assetKey}/revisions/{revisionNumber}/consumers` | `DependencyManagement_ListAssetRevisionConsumers` |  |
| GET | `/assets/{assetKey}/revisions/{revisionNumber}/public-elements` | `DependencyManagement_ListAssetRevisionPublicElements` |  |
| GET | `/assets/{assetKey}/revisions/{revisionNumber}/referenced-elements` | `DependencyManagement_ListReferencedElements` |  |
| POST | `/public-elements/search` | `DependencyManagement_SearchPublicElements` |  |

## Deployments API

[Official specification](https://raw.githubusercontent.com/OutSystems/docs-odc/fb015a80ad9d1396800eca69836aef08297a0efb/src/eap/reference/apis/resources/deployments-api-v1.json)

Base URLs: https://ODC_PORTAL_DOMAIN/api/deployments/v1, https://{odc-portal-domain}/api/deployments/v1

| Method | Path | Operation ID | Deprecated |
|---|---|---|---|
| GET | `/deployment-operations` | `DeploymentOperations_Filter` |  |
| POST | `/deployment-operations` | `DeploymentOperations_Post` |  |
| GET | `/deployment-operations/{operationKey}` | `DeploymentOperations_Get` |  |
| GET | `/deployment-operations/{operationKey}/messages` | `DeploymentOperations_GetMessages` |  |
| GET | `/publish-operations` | `PublishOperations_Filter` |  |
| POST | `/publish-operations` | `PublishOperations_Post` |  |
| GET | `/publish-operations/{operationKey}` | `PublishOperations_Get` |  |
| GET | `/publish-operations/{operationKey}/messages` | `PublishOperations_GetMessages` |  |

## Environment Configurations API

[Official specification](https://raw.githubusercontent.com/OutSystems/docs-odc/fb015a80ad9d1396800eca69836aef08297a0efb/src/eap/reference/apis/resources/environment-configurations-api-v1.json)

Base URLs: https://ODC_PORTAL_DOMAIN/api/environment-configurations/v1, https://{odc-portal-domain}/api/environment-configurations/v1

| Method | Path | Operation ID | Deprecated |
|---|---|---|---|
| DELETE | `/environments/{environmentKey}/domains/{domainKey}` | `Domains_Delete` |  |
| GET | `/environments/{environmentKey}/domains/{domainKey}` | `Domains_Get` |  |
| PATCH | `/environments/{environmentKey}/domains/{domainKey}` | `Domains_Patch` |  |
| GET | `/environments/{environmentKey}/domains` | `Domains_Get` |  |
| POST | `/environments/{environmentKey}/domains` | `Domains_Post` |  |
| POST | `/environments/{environmentKey}/builtin-domains/availability` | `EnvironmentConfigurations_CheckBuiltinDomainAvailability` |  |
| DELETE | `/environments/{environmentKey}/builtin-domains/{builtinDomainPrefix}` | `EnvironmentConfigurations_Delete` |  |
| PATCH | `/environments/{environmentKey}/builtin-domains/{builtinDomainPrefix}` | `EnvironmentConfigurations_PatchPrimary` |  |
| GET | `/environments/{environmentKey}/default-domain` | `EnvironmentConfigurations_Get` |  |
| PATCH | `/environments/{environmentKey}/default-domain` | `EnvironmentConfigurations_Patch` |  |
| GET | `/environments/{environmentKey}/builtin-domains` | `EnvironmentConfigurations_GetBuiltinDomains` |  |
| POST | `/environments/{environmentKey}/builtin-domains` | `EnvironmentConfigurations_Post` |  |
| DELETE | `/environments/{environmentKey}/ip-filter-groups/{ipFilterGroupKey}` | `IpFilterGroups_Delete` |  |
| GET | `/environments/{environmentKey}/ip-filter-groups/{ipFilterGroupKey}` | `IpFilterGroups_Get` |  |
| PATCH | `/environments/{environmentKey}/ip-filter-groups/{ipFilterGroupKey}` | `IpFilterGroups_Patch` |  |
| GET | `/environments/{environmentKey}/ip-filter-groups` | `IpFilterGroups_List` |  |
| POST | `/environments/{environmentKey}/ip-filter-groups` | `IpFilterGroups_Post` |  |
| POST | `/environments/{environmentKey}/private-gateway/activation` | `PrivateGateway_Activation` |  |
| POST | `/environments/{environmentKey}/private-gateway/deactivation` | `PrivateGateway_Deactivation` |  |
| GET | `/environments/{environmentKey}/private-gateway` | `PrivateGateway_Get` |  |
| POST | `/environments/{environmentKey}/private-gateway/key-rotation` | `PrivateGateway_KeyRotation` |  |

## External Library Generation Service API

[Official specification](https://raw.githubusercontent.com/OutSystems/docs-odc/fb015a80ad9d1396800eca69836aef08297a0efb/src/eap/reference/apis/resources/external-library-generation-api-v1.json)

Base URLs: https://ODC_PORTAL_DOMAIN/api/external-libraries/v1, https://{odc-portal-domain}/api/external-libraries/v1

| Method | Path | Operation ID | Deprecated |
|---|---|---|---|
| POST | `/generation-operations` | `GenerationOperations_CreateGenerationOperation` |  |
| GET | `/generation-operations` | `GenerationOperations_GetGenerationOperations` |  |
| DELETE | `/generation-operations/{operationKey}` | `GenerationOperations_DeleteGenerationOperationByOperationKey` |  |
| GET | `/generation-operations/{operationKey}` | `GenerationOperations_GetGenerationOperationByOperationKey` |  |
| GET | `/generation-operations/{operationKey}/contents` | `GenerationOperations_GetGenerationOperationContents` |  |
| GET | `/generation-operations/{operationKey}/log-messages` | `GenerationOperations_GetGenerationOperationLogMessages` |  |
| POST | `/assets/{assetKey}/revisions/{revision}/source-code-download` | `SourceCodeDownload_CreateDownloadOperation` |  |
| GET | `/assets/{assetKey}/revisions/{revision}/source-code-download/{operationKey}` | `SourceCodeDownload_GetDownloadUri` |  |
| GET | `/uploads` | `Upload_UploadOperation` |  |

## Native Mobile Build API

[Official specification](https://raw.githubusercontent.com/OutSystems/docs-odc/fb015a80ad9d1396800eca69836aef08297a0efb/src/eap/reference/apis/resources/native-application-orchestration-service-api-v1.json)

Base URLs: https://ODC_PORTAL_DOMAIN/api/native-mobile-builds/v1, https://{odc-portal-domain}/api/native-mobile-builds/v1

| Method | Path | Operation ID | Deprecated |
|---|---|---|---|
| GET | `/build-operations/{operationKey}` | `GET_BuildOperations_Get` |  |
| GET | `/build-operations/{operationKey}/log-messages` | `GET_BuildOperations_GetMessages` |  |
| GET | `/build-operations` | `GET_BuildOperations_List` |  |
| POST | `/build-operations` | `POST_BuildOperations_Post` |  |
| POST | `/build-operations/version-suggestions` | `POST_BuildOperations_PostVersionSuggestions` |  |
| POST | `/build-operations/native-build-validation` | `POST_BuildOperations_ValidateNativeBuild` |  |
| GET | `/environments/{environmentKey}/applications/{applicationKey}/configurations/android` | `GET_NativeBuildConfigurations_GetAndroidMobileConfiguration` |  |
| PATCH | `/environments/{environmentKey}/applications/{applicationKey}/configurations/android` | `PATCH_NativeBuildConfigurations_UpdateMobileAndroidConfiguration` |  |
| GET | `/environments/{environmentKey}/applications/{applicationKey}/configurations/ios` | `GET_NativeBuildConfigurations_GetIosMobileConfiguration` |  |
| PATCH | `/environments/{environmentKey}/applications/{applicationKey}/configurations/ios` | `PATCH_NativeBuildConfigurations_UpdateMobileIosConfiguration` |  |
| GET | `/native-builder-versions` | `GET_NativeBuilderVersions_List` |  |
| GET | `/environments/{environmentKey}/applications/{applicationKey}/configurations/extensibility-settings` | `GET_NativeBuildExtensibilitySettings_Get` |  |
| PATCH | `/environments/{environmentKey}/applications/{applicationKey}/configurations/extensibility-settings` | `PATCH_NativeBuildExtensibilitySettings_Patch` |  |

## Organization API

[Official specification](https://raw.githubusercontent.com/OutSystems/docs-odc/fb015a80ad9d1396800eca69836aef08297a0efb/src/eap/reference/apis/resources/organization-api-v1.json)

Base URLs: https://ODC_PORTAL_DOMAIN/api/organization/v1, https://{odc-portal-domain}/api/organization/v1

| Method | Path | Operation ID | Deprecated |
|---|---|---|---|
| POST | `/builtin-domains/availability` | `Organization_CheckBuiltinDomainAvailability` |  |
| DELETE | `/builtin-domains/{builtinDomainPrefix}` | `Organization_Delete` |  |
| PATCH | `/builtin-domains/{builtinDomainPrefix}` | `Organization_Patch` |  |
| GET | `/builtin-domains` | `Organization_GetBuiltinDomains` |  |
| POST | `/builtin-domains` | `Organization_Post` |  |
| GET | `/organization` | `Organization_GetOrganization` |  |
| PATCH | `/organization` | `Organization_PatchOrganization` |  |
| GET | `/ip-filter-group` | `Organization_GetPlatformIpFilterGroup` |  |

## Portfolio API

[Official specification](https://raw.githubusercontent.com/OutSystems/docs-odc/fb015a80ad9d1396800eca69836aef08297a0efb/src/eap/reference/apis/resources/portfolio-api-v1.json)

Base URLs: https://ODC_PORTAL_DOMAIN/api/portfolios/v1, https://{odc-portal-domain}/api/portfolios/v1

| Method | Path | Operation ID | Deprecated |
|---|---|---|---|
| GET | `/deployed-assets` | `DeployedAssets_ListAssets` | yes |
| GET | `/environments` | `Environments_ListEnvironments` | yes |

## Portfolio API

[Official specification](https://raw.githubusercontent.com/OutSystems/docs-odc/fb015a80ad9d1396800eca69836aef08297a0efb/src/eap/reference/apis/resources/portfolio-api-v2.json)

Base URLs: https://ODC_PORTAL_DOMAIN/api/portfolios/v2, https://{odc-portal-domain}/api/portfolios/v2

| Method | Path | Operation ID | Deprecated |
|---|---|---|---|
| GET | `/deployed-assets` | `DeployedAssets_ListAssets` |  |
| GET | `/environments` | `Environments_ListEnvironments` |  |
| PATCH | `/environments` | `Environments_UpdateEnvironments` |  |
| PATCH | `/environments/{environmentKey}` | `Environments_PatchEnvironment` |  |
| GET | `/libraries` | `Libraries_ListLibraries` |  |
| GET | `/portfolios` | `Portfolios_ListPortfolios` |  |
| PATCH | `/portfolios/{portfolioKey}` | `Portfolios_PatchPortfolio` |  |

## Subscription API

[Official specification](https://raw.githubusercontent.com/OutSystems/docs-odc/fb015a80ad9d1396800eca69836aef08297a0efb/src/eap/reference/apis/resources/subscription-api-v1.json)

Base URLs: https://ODC_PORTAL_DOMAIN/api/subscription/v1, https://{odc-portal-domain}/api/subscription/v1

| Method | Path | Operation ID | Deprecated |
|---|---|---|---|
| GET | `/environments/{environmentKey}/entitlements/usage/by-asset` | `Subscription_GetAssetUsage` |  |
| GET | `/environments/{environmentKey}/entitlements` | `Subscription_GetEnvironmentEntitlements` |  |
| GET | `/environments/{environmentKey}/entitlements/usage` | `Subscription_GetEnvironmentUsage` |  |
| GET | `/organization/configurations` | `Subscription_GetOrganizationConfigurations` |  |
| PATCH | `/organization/configurations` | `Subscription_PatchOrganizationConfigurations` |  |
| GET | `/organization/entitlements` | `Subscription_GetOrganizationEntitlements` |  |
| GET | `/organization/entitlements/usage` | `Subscription_GetOrganizationUsage` |  |

## User and Access Management API

[Official specification](https://raw.githubusercontent.com/OutSystems/docs-odc/fb015a80ad9d1396800eca69836aef08297a0efb/src/eap/reference/apis/resources/user-access-management-api-v1.json)

Base URLs: https://ODC_PORTAL_DOMAIN/api/identity/v1, https://{odc-portal-domain}/api/identity/v1

| Method | Path | Operation ID | Deprecated |
|---|---|---|---|
| GET | `/application-roles` | `ApplicationRole_QueryApplicationRoles` |  |
| GET | `/application-roles/{key}/users` | `ApplicationRole_QueryUsersByApplicationRole` |  |
| POST | `/users/bulk` | `BulkUserProfile_CreateBulkUserProfilesOperation` |  |
| GET | `/users/bulk/{key}` | `BulkUserProfile_GetBulkUserProfileOperationStatus` |  |
| PATCH | `/groups/{key}/users` | `Group_AddOrRemoveUsersFromGroup` |  |
| GET | `/groups/{key}/users` | `Group_QueryUsersFromGroup` |  |
| POST | `/groups` | `Group_CreateGroup` |  |
| GET | `/groups` | `Group_QueryGroups` |  |
| DELETE | `/groups/{key}` | `Group_DeleteGroup` |  |
| GET | `/groups/{key}` | `Group_ReadGroup` |  |
| PATCH | `/groups/{key}` | `Group_UpdateGroup` |  |
| PATCH | `/groups/{key}/application-roles` | `Group_ModifyGroupApplicationRoles` |  |
| GET | `/groups/{key}/application-roles` | `Group_QueryApplicationRolesGroups` |  |
| DELETE | `/groups/{key}/claim-mappings/{mappingKey}` | `GroupIdpClaimMapping_DeleteGroupIdpClaimMapping` |  |
| GET | `/identity-providers` | `IdentityProvider_QueryIdentityProviders` |  |
| GET | `/identity-providers/{key}` | `IdentityProvider_ReadIdentityProvider` |  |
| POST | `/organization-roles` | `OrganizationRole_CreateOrganizationRole` |  |
| GET | `/organization-roles` | `OrganizationRole_QueryOrganizationRoles` |  |
| DELETE | `/organization-roles/{key}` | `OrganizationRole_DeleteOrganizationRole` |  |
| GET | `/organization-roles/{key}` | `OrganizationRole_ReadOrganizationRole` |  |
| PATCH | `/organization-roles/{key}` | `OrganizationRole_UpdateOrganizationRole` |  |
| GET | `/organization-roles/{key}/users` | `OrganizationRole_QueryUsersByRole` |  |
| GET | `/permissions` | `Permission_QueryPermissions` |  |
| GET | `/permissions/{key}` | `Permission_ReadPermission` |  |
| POST | `/users/{key}/application-roles/{roleKey}` | `UserApplicationRoles_GrantApplicationRoleToUser` |  |
| DELETE | `/users/{key}/application-roles/{roleKey}` | `UserApplicationRoles_RevokeApplicationRoleForUser` |  |
| GET | `/users/{key}/application-roles` | `UserApplicationRoles_QueryUserApplicationRoles` |  |
| GET | `/users/{key}/organization-roles` | `UserOrganizationRoles_GetUserOrganizationRoles` |  |
| POST | `/users/{key}/organization-roles/{roleKey}` | `UserOrganizationRoles_GrantOrganizationRoleToUser` |  |
| DELETE | `/users/{key}/organization-roles/{roleKey}` | `UserOrganizationRoles_RevokeOrganizationRoleForUser` |  |
| GET | `/users/count` | `UserProfile_CountUsers` |  |
| POST | `/users` | `UserProfile_CreateUser` |  |
| GET | `/users` | `UserProfile_QueryUsers` |  |
| DELETE | `/users/{key}` | `UserProfile_DeleteUser` |  |
| GET | `/users/{key}` | `UserProfile_GetUser` |  |
| PATCH | `/users/{key}` | `UserProfile_PatchUser` |  |
| GET | `/users/{key}/groups` | `UserProfile_QueryGroupsByUser` |  |
