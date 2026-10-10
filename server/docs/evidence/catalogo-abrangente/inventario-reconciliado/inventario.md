# Inventário de cobertura — fase 1 (gerado; correção de identidade e estatutos)

Gerado em 2026-09-23T20:43:25.957Z por `node platforms/odc/facade/coverage-inventory.mjs --census-from <inventory.json>` em 1981 ms. Fontes, regras e exclusões em `inventory.json.sources`; matriz completa em `matrix.json` / `matrix.csv` (9720 linhas = tipo qualificado × operação × plataforma). Estatutos por célula: tested-executed, tested-static, route-only, suggested-only, context-excluded, refused-proven, undetermined. Nenhum percentual global.

## ODC — ODC metadata 1.7.25.10778 (reflection index) against the installed Studio 1.7.25.10778: the inventory is not complete for the installed version

Inventariados: 564 tipos qualificados (140 nomes curtos partilhados por mais de um tipo qualificado no índice nativo; 51 entre os inventariados). Denominadores separados por classe: concrete-authorable 278, base-interface 41, referenced-signature 186, undetermined 59; por etiqueta de família de aplicação: shared 386, reactive 97, web 81 (etiqueta, não exclusão).

Regra de inventário: kept: every interface (no de-duplication by short name) whose resolved base closure reaches IObject (role object) or IObjectSignature only (role signature); a base written as a short name is resolved by RESOLUTION_RULE, otherwise recorded in ambiguousBases and not followed (its members are not merged); role stated through an ambiguous base only when all candidates agree, else undetermined (kept, flagged); excluded: *Descriptor / IObjectDescriptor / IClassDescriptor closures, classes, static classes, enums, interfaces without the object roots (Extensions/ExternalLibraries hierarchies reach IModelObject only). Identity = platform:metadataVersion:assembly:namespace.name

Regra de classe: referenced-signature = role signature (base closure reaches IObjectSignature but not IObject); concrete-authorable = role object with a factory that returns exactly this type (ODC: Create* method resolved without ambiguity; O11: catalog Creatables) or, when no other inventoried interface has it as a base, a widget/flow-node interface created through the generic CreateWidget<T>/CreateNode<T>; base-interface = role object without such a factory that appears in the resolved base closure of another inventoried interface (its properties and operations are kept; it is not counted as an extra concrete element); undetermined = role object with neither a factory nor an implementer (possibly created by the platform, not verified). A concrete type that is also a base of others keeps alsoBaseOf

Regra de atribuição de evidência por nome curto: evidence keyed by a short name (jobs, ledger, descriptor, reader census) is attributed to a qualified type only when: exact = the short name has one qualified type in the platform inventory; kernel-rank (create only) = the kernel ranking of Verbs.cs FindCreateCore leaves one top candidate (NRWidgets > OutSystems.Model.* > Extensions/ExternalLibraries/Processes/BusinessProcesses); module-context = after removing the OutSystems.Model.Extensions and OutSystems.Model.ExternalLibraries candidates (extension-module types, "never what an eSpace creates", Verbs.cs:904-905) one candidate remains; otherwise ambiguous = recorded under the short name, attributed to no qualified type and not counted as proof

| Dimensão | Contagem (por atribuição) | Denominador | O que foi medido |
|---|---|---:|---|
| Nomeados num contrato público (api --op) | 44 | 564 | short name appears in the JSON returned by api --op (spec/logic/screen/html/html-visual); a mention in expander source code is recorded separately as route.codeMentions and is not a public contract |
| Mencionados no código dos expansores | 173 | 564 | menção em código ≠ contrato público |
| Nomeados pelo descritor da faixa (43 capacidades, partilhadas: data.static, data.structure, data.entity) | ledger-qualificado 95, exato 89, contexto-módulo 0, rank-kernel 10, ambíguo 34; atribuídos a este tipo 89; potencial de reutilização (nome curto no descritor da outra faixa) 50 | 564 | exposure counted only when the descriptor of lane odc names the short name AND the attribution rule assigns it to this qualified type; on this lane the descriptor holds the shared capabilities projected for it (data.static, data.structure, data.entity) |
| Prova executada (ledger, qualquer op; resultados 72, atuais 72, com ledger qualificado 72) | ledger-qualificado 106, exato 0, contexto-módulo 0, rank-kernel 9, ambíguo 18 | 564 | ODC ledger of the suite jobs; counted per attribution level (ledger-qualified = the result names the interface) |
| Prova estática (job positivo, qualquer op) | ledger-qualificado 86, exato 65, contexto-módulo 0, rank-kernel 8, ambíguo 21; só job negativo 3 | 564 | positive suites only; the type name as written in the job; negative suites counted separately |
| Observados na fixture (censo do leitor) | ledger-qualificado 0, exato 191, contexto-módulo 0, rank-kernel 0, ambíguo 93; interfaces base observadas via implementadores 31 | 564 | --kind K counts objects implementing any interface named IK (inclusive); a kind absent from the fixture is not unreadable — censo reutilizado de docs/evidence/descoberta-cobertura-fase1/inventory.json (2026-09-23T12:49:47.197Z, fixture kernel/tests/fixtures/odc/wrightflood-personal-r8.oml) |

| Operação | Tipos | Metadados sugerem (próprio / só herdado / genérico) | Ambíguo | Sem base | Excluído por contexto | Testado (executado) | Testado (estático) | Só rota | Recusa provada | Indeterminado | Evidência não atribuída |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| read | 564 | 564 / 0 / 0 | 0 | 0 | 0 | 191 | 19 | 259 | 0 | 95 | 16 |
| address | 564 | 564 / 0 / 0 | 0 | 0 | 0 | 191 | 19 | 259 | 0 | 95 | 16 |
| usages | 564 | 78 / 0 / 0 | 7 | 479 | 0 | 0 | 26 | 68 | 0 | 470 | 6 |
| create | 564 | 153 / 0 / 125 | 1 | 99 | 186 | 97 | 3 | 165 | 1 | 112 | 18 |
| set | 564 | 283 / 59 / 0 | 0 | 36 | 186 | 92 | 3 | 236 | 2 | 45 | 14 |
| rename | 564 | 124 / 98 / 0 | 0 | 156 | 186 | 28 | 1 | 190 | 4 | 155 | 2 |
| replace | 564 | 78 / 0 / 0 | 7 | 479 | 0 | 7 | 2 | 74 | 0 | 481 | 1 |
| move | 564 | 0 / 378 / 0 | 0 | 0 | 186 | 14 | 3 | 355 | 1 | 5 | 5 |
| duplicate | 564 | 0 / 378 / 0 | 0 | 0 | 186 | 8 | 0 | 369 | 0 | 1 | 1 |
| delete | 564 | 0 / 378 / 0 | 0 | 0 | 186 | 24 | 2 | 347 | 1 | 4 | 4 |

Mesma tabela restrita aos tipos concrete-authorable (estatuto por célula):

| Operação | Testado (executado) | Testado (estático) | Só rota | Recusa provada | Indeterminado |
|---|---:|---:|---:|---:|---:|
| read | 78 | 16 | 138 | 0 | 46 |
| address | 78 | 16 | 138 | 0 | 46 |
| usages | 0 | 21 | 25 | 0 | 232 |
| create | 95 | 0 | 165 | 1 | 17 |
| set | 86 | 1 | 173 | 1 | 17 |
| rename | 27 | 1 | 168 | 3 | 79 |
| replace | 7 | 2 | 29 | 0 | 240 |
| move | 13 | 3 | 257 | 1 | 4 |
| duplicate | 8 | 0 | 269 | 0 | 1 |
| delete | 24 | 2 | 248 | 1 | 3 |

| Família | Tipos | concrete / base / signature / undetermined | Com prova executada (op de escrita) | Com prova estática | Nomeados pelo descritor (atribuídos) | Na fixture (atribuídos) | Evidência só por nome curto ambíguo |
|---|---:|---|---:|---:|---:|---:|---:|
| abstract | 8 | 0 / 2 / 4 / 2 | 0 | 0 | 0 | 6 | 0 |
| ai | 15 | 2 / 1 / 7 / 5 | 0 | 0 | 0 | 0 | 0 |
| data.entity | 20 | 9 / 3 / 2 / 6 | 8 | 4 | 7 | 17 | 0 |
| data.structure | 7 | 2 / 0 / 4 / 1 | 2 | 1 | 2 | 3 | 0 |
| data.type | 11 | 1 / 4 / 2 / 4 | 0 | 1 | 0 | 6 | 0 |
| integration.event | 9 | 6 / 2 / 0 / 1 | 6 | 2 | 3 | 3 | 3 |
| integration.plugin | 7 | 0 / 5 / 2 / 0 | 0 | 0 | 0 | 0 | 0 |
| integration.rest | 23 | 13 / 0 / 9 / 1 | 9 | 10 | 10 | 0 | 0 |
| integration.soap | 25 | 18 / 1 / 2 / 4 | 0 | 0 | 0 | 0 | 0 |
| integration.timer | 10 | 8 / 1 / 0 / 1 | 1 | 1 | 1 | 0 | 0 |
| logic.action | 26 | 17 / 2 / 6 / 1 | 8 | 5 | 7 | 9 | 2 |
| logic.exception | 5 | 1 / 1 / 1 / 2 | 1 | 1 | 1 | 5 | 0 |
| logic.node | 90 | 74 / 12 / 0 / 4 | 25 | 2 | 21 | 32 | 10 |
| logic.parameter | 10 | 4 / 0 / 5 / 1 | 4 | 1 | 3 | 6 | 0 |
| logic.query | 16 | 13 / 1 / 0 / 2 | 8 | 1 | 6 | 8 | 3 |
| module | 9 | 4 / 0 / 0 / 5 | 2 | 0 | 2 | 5 | 0 |
| other | 2 | 0 / 1 / 1 / 0 | 0 | 0 | 0 | 0 | 0 |
| process | 11 | 3 / 0 / 8 / 0 | 0 | 0 | 0 | 1 | 0 |
| reference.signature | 56 | 0 / 0 / 56 / 0 | 0 | 0 | 1 | 28 | 0 |
| security.config | 7 | 4 / 1 / 2 / 0 | 3 | 3 | 3 | 6 | 0 |
| ui.block | 18 | 9 / 0 / 9 / 0 | 3 | 1 | 2 | 5 | 2 |
| ui.metadata | 8 | 0 / 1 / 0 / 7 | 1 | 1 | 1 | 0 | 0 |
| ui.screen | 34 | 23 / 2 / 4 / 5 | 8 | 6 | 7 | 15 | 1 |
| ui.widget | 137 | 67 / 1 / 62 / 7 | 16 | 0 | 12 | 36 | 4 |

## O11 — O11 catalog 11.55.87

Inventariados: 408 tipos qualificados (46 nomes curtos partilhados por mais de um tipo qualificado no índice nativo; 31 entre os inventariados). Denominadores separados por classe: concrete-authorable 209, base-interface 32, referenced-signature 130, undetermined 37; por etiqueta de família de aplicação: shared 247, reactive 89, web 72 (etiqueta, não exclusão).

Regra de inventário: kept: every interface (no de-duplication) whose catalog Bases include OutSystems.Model.IObject (object) or IObjectSignature only (signature); excluded: *Descriptor and interfaces without those roots; names are qualified in the catalog (bases, creatables, property types), so no resolution ambiguity arises except for property types written as short names; the catalog has no method list (Delete/Duplicate assumed from IObject). Identity = platform:metadataVersion:namespace.name (assembly not recorded by the catalog)

Regra de classe: referenced-signature = role signature (base closure reaches IObjectSignature but not IObject); concrete-authorable = role object with a factory that returns exactly this type (ODC: Create* method resolved without ambiguity; O11: catalog Creatables) or, when no other inventoried interface has it as a base, a widget/flow-node interface created through the generic CreateWidget<T>/CreateNode<T>; base-interface = role object without such a factory that appears in the resolved base closure of another inventoried interface (its properties and operations are kept; it is not counted as an extra concrete element); undetermined = role object with neither a factory nor an implementer (possibly created by the platform, not verified). A concrete type that is also a base of others keeps alsoBaseOf

Regra de atribuição de evidência por nome curto: evidence keyed by a short name (jobs, ledger, descriptor, reader census) is attributed to a qualified type only when: exact = the short name has one qualified type in the platform inventory; kernel-rank (create only) = the kernel ranking of Verbs.cs FindCreateCore leaves one top candidate (NRWidgets > OutSystems.Model.* > Extensions/ExternalLibraries/Processes/BusinessProcesses); module-context = after removing the OutSystems.Model.Extensions and OutSystems.Model.ExternalLibraries candidates (extension-module types, "never what an eSpace creates", Verbs.cs:904-905) one candidate remains; otherwise ambiguous = recorded under the short name, attributed to no qualified type and not counted as proof

| Dimensão | Contagem (por atribuição) | Denominador | O que foi medido |
|---|---|---:|---|
| Nomeados num contrato público (api --op) | 43 | 408 | short name appears in the JSON returned by api --op (spec/logic/screen/html/html-visual); a mention in expander source code is recorded separately as route.codeMentions and is not a public contract |
| Mencionados no código dos expansores | 162 | 408 | menção em código ≠ contrato público |
| Nomeados pelo descritor da faixa (3 capacidades, partilhadas: data.static, data.structure, data.entity) | ledger-qualificado 39, exato 36, contexto-módulo 0, rank-kernel 3, ambíguo 10; atribuídos a este tipo 36; potencial de reutilização (nome curto no descritor da outra faixa) 115 | 408 | exposure counted only when the descriptor of lane o11 names the short name AND the attribution rule assigns it to this qualified type; on this lane the descriptor holds the shared capabilities projected for it (data.static, data.structure, data.entity) |
| Prova executada (ledger, qualquer op; resultados 22, atuais 22, com ledger qualificado 22) | ledger-qualificado 45, exato 0, contexto-módulo 0, rank-kernel 4, ambíguo 5 | 408 | O11 ledger of the jobs stamped by JobTests (tests/provenance-o11.json); counted per attribution level |
| Prova estática (job positivo, qualquer op) | ledger-qualificado 42, exato 84, contexto-módulo 0, rank-kernel 10, ambíguo 21; só job negativo 4 | 408 | positive suites only; the type name as written in the job; negative suites counted separately |
| Observados na fixture | n/a | 408 | O11 reader not run (O11 CLI not built in this checkout) |

| Operação | Tipos | Metadados sugerem (próprio / só herdado / genérico) | Ambíguo | Sem base | Excluído por contexto | Testado (executado) | Testado (estático) | Só rota | Recusa provada | Indeterminado | Evidência não atribuída |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| read | 408 | 408 / 0 / 0 | 0 | 0 | 0 | 0 | 42 | 358 | 0 | 8 | 8 |
| address | 408 | 408 / 0 / 0 | 0 | 0 | 0 | 0 | 38 | 362 | 0 | 8 | 8 |
| usages | 408 | 54 / 0 / 0 | 0 | 354 | 0 | 0 | 11 | 50 | 0 | 347 | 2 |
| create | 408 | 108 / 0 / 101 | 0 | 69 | 130 | 40 | 59 | 96 | 1 | 82 | 15 |
| set | 408 | 222 / 35 / 0 | 0 | 21 | 130 | 34 | 48 | 162 | 1 | 33 | 15 |
| rename | 408 | 95 / 94 / 0 | 0 | 89 | 130 | 14 | 2 | 171 | 3 | 88 | 1 |
| replace | 408 | 54 / 0 / 0 | 0 | 354 | 0 | 3 | 3 | 52 | 0 | 350 | 0 |
| move | 408 | 0 / 278 / 0 | 0 | 0 | 130 | 6 | 2 | 269 | 1 | 0 | 0 |
| duplicate | 408 | 0 / 278 / 0 | 0 | 0 | 130 | 7 | 0 | 270 | 0 | 1 | 1 |
| delete | 408 | 0 / 278 / 0 | 0 | 0 | 130 | 11 | 8 | 254 | 0 | 5 | 5 |

Mesma tabela restrita aos tipos concrete-authorable (estatuto por célula):

| Operação | Testado (executado) | Testado (estático) | Só rota | Recusa provada | Indeterminado |
|---|---:|---:|---:|---:|---:|
| read | 0 | 40 | 162 | 0 | 7 |
| address | 0 | 36 | 166 | 0 | 7 |
| usages | 0 | 11 | 14 | 0 | 184 |
| create | 39 | 59 | 96 | 1 | 14 |
| set | 31 | 48 | 114 | 1 | 15 |
| rename | 14 | 2 | 148 | 3 | 42 |
| replace | 3 | 3 | 16 | 0 | 187 |
| move | 6 | 2 | 200 | 1 | 0 |
| duplicate | 7 | 0 | 201 | 0 | 1 |
| delete | 11 | 8 | 186 | 0 | 4 |

| Família | Tipos | concrete / base / signature / undetermined | Com prova executada (op de escrita) | Com prova estática | Nomeados pelo descritor (atribuídos) | Na fixture (atribuídos) | Evidência só por nome curto ambíguo |
|---|---:|---|---:|---:|---:|---:|---:|
| abstract | 3 | 0 / 1 / 1 / 1 | 0 | 0 | 0 | n/a | 0 |
| data.entity | 8 | 5 / 1 / 1 / 1 | 5 | 5 | 4 | n/a | 0 |
| data.structure | 4 | 2 / 0 / 2 / 0 | 2 | 2 | 2 | n/a | 0 |
| data.type | 8 | 0 / 4 / 0 / 4 | 0 | 1 | 2 | n/a | 0 |
| integration.event | 8 | 5 / 1 / 0 / 2 | 1 | 1 | 0 | n/a | 0 |
| integration.plugin | 14 | 5 / 5 / 2 / 2 | 0 | 0 | 0 | n/a | 0 |
| integration.rest | 23 | 13 / 0 / 9 / 1 | 4 | 7 | 4 | n/a | 0 |
| integration.soap | 19 | 16 / 0 / 1 / 2 | 0 | 0 | 0 | n/a | 0 |
| integration.timer | 1 | 1 / 0 / 0 / 0 | 0 | 1 | 0 | n/a | 0 |
| logic.action | 15 | 10 / 2 / 3 / 0 | 5 | 5 | 4 | n/a | 2 |
| logic.exception | 5 | 1 / 1 / 1 / 2 | 1 | 0 | 1 | n/a | 0 |
| logic.node | 57 | 43 / 10 / 0 / 4 | 9 | 12 | 7 | n/a | 6 |
| logic.parameter | 9 | 3 / 1 / 4 / 1 | 4 | 2 | 3 | n/a | 0 |
| logic.query | 16 | 13 / 1 / 0 / 2 | 3 | 6 | 2 | n/a | 3 |
| module | 5 | 3 / 0 / 0 / 2 | 0 | 2 | 0 | n/a | 0 |
| process | 8 | 2 / 0 / 6 / 0 | 0 | 1 | 0 | n/a | 0 |
| reference.signature | 40 | 0 / 0 / 40 / 0 | 0 | 0 | 0 | n/a | 0 |
| security.config | 5 | 4 / 0 / 1 / 0 | 0 | 3 | 0 | n/a | 0 |
| ui.block | 14 | 9 / 0 / 5 / 0 | 1 | 3 | 0 | n/a | 0 |
| ui.metadata | 6 | 0 / 1 / 0 / 5 | 0 | 0 | 0 | n/a | 0 |
| ui.screen | 25 | 19 / 1 / 0 / 5 | 3 | 7 | 3 | n/a | 2 |
| ui.widget | 115 | 55 / 3 / 54 / 3 | 7 | 29 | 4 | n/a | 8 |

## Correspondência ODC ↔ O11 (três níveis; nenhum verificado)

| Nível | Contagem | Significado |
|---|---:|---|
| sameShortName | 365 nomes curtos (486 pares, 318 um-para-um) | the same short name exists on both platforms (possibly in several namespaces each); a naming coincidence, not a contract |
| sameQualifiedName | 389 | same namespace.name on both platforms: a correspondence CANDIDATE; the contract (properties, factories, behaviour) is not verified by this level |
| sameQualifiedNameAndSameWritableProperties | 152 | metadata-level agreement of the writable property names (ODC own+inherited vs O11 catalog list, whose inheritance scope is not recorded); still not a proof of behaviour |
| verifiedContractEquivalence | 0 | requires a positive proof of the same operation with the same contract on both platforms; O11 has no executed ledger in this checkout, so nothing is verified |

## Fronteira operacional (fora do modelo)

model = reads or changes the module model headless (inspect, job, discover, feature build); delivery = snapshot/candidate/merge/publish of a module; data = development database records; portal = ODC Portal APIs; operations = Studio session, diagnostics, URLs, tenants

| Ferramenta | Classe | Arquivo |
|---|---|---|
| ssam_discover | model | mcp.mjs |
| ssam_app_url | operations | mcp.mjs |
| studio_doctor | operations | mcp.mjs |
| studio_attach | operations | mcp.mjs |
| studio_status | operations | mcp.mjs |
| studio_wait | operations | mcp.mjs |
| studio_assets | operations | mcp.mjs |
| studio_consumers | operations | mcp.mjs |
| studio_data | data | mcp.mjs |
| studio_data_insert | data | mcp.mjs |
| studio_data_update | data | mcp.mjs |
| studio_data_delete | data | mcp.mjs |
| studio_open | operations | mcp.mjs |
| studio_close | operations | mcp.mjs |
| studio_snapshot | delivery | mcp.mjs |
| studio_latest | delivery | mcp.mjs |
| studio_refresh_references | operations | mcp.mjs |
| studio_dismiss_dialog | operations | mcp.mjs |
| studio_build | model | mcp.mjs |
| studio_inspect | model | mcp.mjs |
| studio_check_base | delivery | mcp.mjs |
| studio_preview | delivery | mcp.mjs |
| studio_merge | delivery | mcp.mjs |
| studio_authorize | delivery | mcp.mjs |
| studio_publish | delivery | mcp.mjs |
| studio_create | operations | mcp.mjs |
| studio_command | operations | mcp.mjs |
| studio_manifest | delivery | mcp.mjs |
| studio_deliver | delivery | mcp.mjs |
| hybrid_tenants | operations | mcp.mjs |
| o11_data | data | ssam.mjs |
| o11_job | model | ssam.mjs |
| ssam_job | model | ssam.mjs |
| ssam_doctor | operations | ssam.mjs |
| ssam_debug | operations | debug.mjs |
