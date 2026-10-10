# ODC Portal API — integration acceptance review

## Scope and ownership

The public API implementation and the Portal capability-gap investigation are separate workstreams. This package must be usable without prior conversation context by an MCP-compatible host. A model without tool support cannot execute it on its own.

No application edits, Studio model changes, tenant permission changes, API-client creation, deployment, or live mutation is authorized by this review. Cataloguing a mutation does not authorize executing it.

## Evidence collected by the coordinating agent

- The pinned official source inventory contains 14 OpenAPI files and 163 operations. Both Portfolio versions are included; v1 is deprecated.
- The inventory is not a claim that all Portal functionality has a public REST endpoint.
- Public build and external-library-generation APIs include log-message retrieval. Application runtime logs and traces have not been found in the public inventory. These are different capabilities; absence of a runtime query in this catalog is not proof that no other supported integration exists.
- On 2026-09-15, a read-only, unauthenticated GET to the WrightFlood tenant's official identity discovery URL succeeded. The metadata advertises `client_credentials` and `client_secret_post`; its issuer and token endpoint are on the same HTTPS tenant origin.
- Discovery used no credentials and did not request a token. No live authenticated public API operation has been established by this evidence.
- Earlier Studio-authenticated access to an internal Portal screen-service endpoint failed token validation. That does not establish a lack of user permission and must not be treated as authentication for the documented public API.

## Acceptance gates

| Area | Required evidence |
|---|---|
| Completeness | Every catalog operation can be discovered and described; unsupported request encodings are explicit, never silently ignored. |
| Contract fidelity | Paths, parameters, schema references, required values, arrays, request media types, and response forms respect the pinned source contracts. |
| Authentication | Official discovery and client-credentials exchange; in-memory token reuse and expiry handling; concurrent requests do not create token storms. |
| Secret isolation | Client secret and bearer token never appear in tool arguments, tool output, error bodies, test receipts, or committed configuration. |
| Target safety | Operator configures tenant origin. Model-supplied paths, headers, redirects, or token endpoints cannot redirect credentials to another origin. |
| Authorization | Read-only default. Mutations require operator-controlled enablement; a model cannot enable writes through tool input. Tenant permissions remain authoritative. |
| Retry safety | No blind replay of uncertain mutations. Authentication retries, rate limits, timeouts, and partial results are explicit. |
| Portability | Clean MCP initialization/list-tools/tool-call smoke test, documented install command and credential configuration, no dependency on conversation state or Codex-only tools. |
| Operational scope | Catalog search/describe works before authentication. Missing configuration is actionable without asking users to paste secrets into chat. |
| Honest coverage | Distinguish mapped, implemented, mock-tested, and live-verified. Logs/traces remain separate until proven. |

## Official references

- [Public ODC REST APIs](https://success.outsystems.com/documentation/outsystems_developer_cloud/odc_rest_apis/)
- [Configure an API client](https://success.outsystems.com/documentation/outsystems_developer_cloud/odc_rest_apis/api_authentication_and_authorization/configure_api_access_using_an_api_client/)
- [Get an access token](https://success.outsystems.com/documentation/outsystems_developer_cloud/odc_rest_apis/api_authentication_and_authorization/get_access_token/)
- [Pinned operation inventory](catalog/OPERATIONS.md)

## Current verification status

Catalog and unauthenticated identity discovery verified. Implementation and research reviews are pending. No live authenticated access, no tenant writes, and no host installation are claimed.
