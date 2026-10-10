# Manage Dependencies headless para qualquer produtor (frente K1) — prova de 2026-09-26

Pedido do dono (2026-09-26): "você deveria conseguir pegar dependência de qualquer coisa no ambiente": extensões .NET
(xif, ex. HMISPdfText → HMISJHA_CS), eSpaces (referência nova e existente) e (System) (ex. HMISJHA_CS → (System)).
Desenho verificado: `docs/tasks/2026-09-26-o11-capacidades-headless.md`, seção 2.1 (opção A + A') e seção 4, no release
`SSAM-Hybrid-o11-sso`. Branch `claude/o11-manage-dependencies` (worktree `SSAM-Hybrid-o11-sso-deps`).

**Situação.** Código, testes, prova offline e prova viva de leitura L1–L4 (integrador, 2026-09-26 20:39–20:40Z) prontos.
A revisão adversarial K1 teve dois achados maiores, corrigidos na frente B5 (seção 7): captura de vários produtores
retomável no deliver, e jobs de prova sem action pública nem `Login`, aprovados no gate de padrões O11. A revisão de B5
não teve achado maior; os menores estão na seção 7.4, e o deliver agora recusa os jobs de prova. Nenhum deliver
foi feito; a escrita num módulo ZZ de teste continua dependendo das palavras de autorização (L5).

## 1. O que foi construído

| Peça | Onde | O que faz |
|---|---|---|
| Verbo `anvil signature` (só leitura) | `src/Anvil.Cli/Program.cs` `SignatureCmd`; `src/Anvil.Core/Adapters.SS11/ProducerSignatureCapture.cs` | Lease `readOnly:true` no Studio logado (recusa `--credentials` e lease não read-only); observa a versão publicada antes e depois; lê `signature(key, kind)`; resolve Tipo:Nome → OriginalKey e o fechamento de tipos na própria assinatura; grava `.avsig` atestado; `--pin-xif` opcional. |
| Parser da assinatura do servidor | `src/Anvil.Core/Adapters.SS11/NativeDependencyReader.cs` `ResolveServerSignature` | Decodifica o `SignatureBinary` (FastInfoset, `Oml.GetSignatureReader`), valida cada `ElementSignature` pelo hash nativo (o mesmo `Index` do leitor de OML), acha o elemento visível por tag + OriginalName e calcula o fechamento de structures/entities do mesmo produtor (parâmetros, atributos, listas). Chaves de outro produtor são listadas (`foreignDependencies`), nunca inventadas. |
| Envelope atestado (FormatVersion 2) | `src/Anvil.Core/Kernel/NativeReferenceSnapshot.cs` | Extensão **ou eSpace** (inclui sistema); `Attestation` obrigatória (Source, VersionId, Guard, AdvertisedSignatureHash, CapturedAtUtc); elementos `action`, `entity`, `structure`, `service-action`, `client-action` com `Requires` (fechamento). A versão 1 (extensão, sem atestação) continua igual. |
| Import de eSpace e (System) (A') | `src/Anvil.Core/Adapters.SS11/ReferenceRefresher.cs` `ImportSnapshot`; `src/Anvil.Core/Kernel/Verbs.cs` | O op `reference` ligado a um `.avsig` v2 cria/atualiza a referência eSpace ou de extensão com stubs dos elementos pedidos **e do fechamento**, e roda o mesmo `RefreshReferences` nativo; confere `ReferenceHash == SignatureHash`. `elements: []` numa referência que já existe = refresh contra a assinatura do servidor (A'). |
| `deliver --capture-producer` | `src/Anvil.Core/Delivery/Delivery.cs`, `ProducerSignatures.cs`; `StudioProducerAuthority` | Captura só leitura para `<tarefa>/producers/<Nome>.avsig`, **uma por produtor**: cada captura concluída entra em `capturedProducers` e nas `sources` (sha256) e a tarefa é salva na hora. A retomada reusa as capturas gravadas (nunca recaptura) e captura só as que faltam; todas as gravadas são re-atestadas no servidor antes do apply **e** antes do merge. |
| Lease só leitura no cliente | `src/Anvil.Core/Adapters.SS11/ConnectedEnvironment.cs` | `WriteOperations` recusadas no próprio cliente quando o lease é read-only (além do `RequireWrite` do lado do Studio). |
| Evidência offline (nunca entregável) | `src/Anvil.Core/Adapters.SS11/SignatureFixtures.cs`; verbo `anvil signature-fixture` | Monta `.avsig` v2 sem servidor: `--from-oml` (assinatura que o OML do produtor carrega) ou `--from-consumers` (elementos da referência existente regenerados pelo serializador do Studio e conferidos contra o hash que o consumidor guardou do servidor). `deliver` recusa as duas fontes. |
| Runner e MCP | `scripts/run_job.py --capture-producer`; `platforms/odc/facade/ssam.mjs` (`o11_job`, `ssam_job`) | `producers: {Nome: caminhoAbs}` → `--producer`; `captureProducers: ["Nome" \| "Nome=Produtor"]` → captura só leitura antes do job. |

### 1.1 Contrato de `anvil signature`

```
anvil signature --producer <Nome> [--key <chave>] [--kind Extension|eSpace]
                [--elements "IServerActionSignature:X,IStructureSignature:Y" | --job <job.json> [--binding <Nome>]]
                [--pin-xif] --out <abs>\<Nome>.avsig [--host <ambiente>] [--bridge-port 4516]
```

Passos (todos só leitura; o stub dos testes recusa qualquer operação de escrita):
1. Lease `environment_session` com `readOnly:true`. `--credentials` → `NotReadOnly`.
2. `referenceable`: identidade (nome/chave/kind). Chave de outro produtor ou kind diferente → `IdentityMismatch`.
3. Observação antes: extensão → `extensions` (VersionId, IsActive); eSpace → `modules`; sistema → hash anunciado no
   `referenceable` (o (System) não tem versão publicada visível). Inativo → `NotActive`.
4. `signature(key, kind)`; vazio → `SignatureUnavailable` (com o erro REST quando existe).
5. Observação depois: VersionId diferente → `VersionIdChanged`; hash anunciado diferente → `SignatureHashChanged`.
6. Resolução Tipo:Nome → OriginalKey e fechamento no payload; ausente → `ElementNotFound`.
7. `--pin-xif` (só extensão): `extension-download` da versão capturada e nova observação da versão **antes de gravar
   qualquer arquivo**; republicação durante o download → `VersionIdChanged` sem `.avsig` nem `.xif` (B5).
8. `NativeReferenceCapture.Capture` + `Write` (FormatVersion 2); o `.xif` (SHA-256) vai para a mesma pasta do `.avsig`.

Saída (JSON do envelope do CLI, campo `data`):
`producer, key, kind, system, environment, guard, versionIdBefore, versionIdAfter, isActive, signatureHash,
advertisedSignatureHash, advertisedMatchesSignature, signatureBytes, elementSignatures, elements[{type,name,originalKey}],
closure[...], foreignDependencies, unresolvedDependencies, avsigPath, avsigSha256, xifPath, xifSha256, readOnly`.

Sistema: a coluna `Is_System` do catálogo chega `False` em todas as 383 linhas do inventário vivo de 2026-09-26
(inclusive (System), `kernel\.local\hmisjha\integrador\inv\referenceable.json` do release). O verbo reconhece o (System)
pela chave da plataforma (`Constants.ServiceCenterESpaceKey` = `uXCIR2Atc0+es3zYuZSnNw`).

## 2. Atestação de identidade (NativeDependencyReader.cs:12-15, 48-50)

O leitor de dependências nativas continua recusando envelopes só-assinatura como prova de identidade: o payload não
diz de quem é. Nada disso foi afrouxado. A identidade passa a ser **observada no servidor** duas vezes:

1. **Na captura**: ambiente do lease, chave e kind no `referenceable`, VersionId (ou hash anunciado) estável antes e
   depois da leitura. Tudo gravado no `.avsig` (`Environment`, `ModuleKey`, `SignatureHash`, `Attestation`).
2. **No deliver**, antes do apply e de novo imediatamente antes do `merge_from_oml`: lease só leitura no mesmo
   ambiente, mesma chave/kind no catálogo, mesmo VersionId (ou mesmo hash anunciado para sistema). Qualquer diferença
   interrompe antes de qualquer escrita (`VersionIdChanged`/`SignatureHashChanged`/`WrongEnvironment`).

Recusas no deliver (testadas): envelope de outro ambiente; envelope de evidência offline (`producer-oml`,
`consumer-reconstruction`); envelope atestado sem autoridade de re-atestação; produtor republicado depois da captura.

## 3. Evidência offline

### 3.1 Testes (alvo, sem a suíte completa)

`dotnet test tests\Anvil.Tests -c Release --filter "FullyQualifiedName~NativeReferenceSignatureCaptureTests|FullyQualifiedName~NativeReferenceImportTests|FullyQualifiedName~NativeReferenceSnapshotTests|FullyQualifiedName~ConnectedEnvironmentTests"`
→ **57/57 aprovados** depois de B5 e do merge do release (eram 55; +2 casos de B5). Regressão das áreas tocadas
(`Delivery*`, `RuntimeDependencyDelivery`, `FrozenCSharpDelivery`, `NativeDependency*`, merges de referência,
`CSharpReference*`, `DataContractTests`, `AppSession*`) → **239/239** depois da revisão de B5 (238 + a recusa de jobs
de prova; seção 7.4). Fachada:
`node --test --test-name-pattern "producer bindings|each verb" platforms/odc/facade/tests/lanes.test.mjs` → 2/2 (K1).

| Caso | Teste |
|---|---|
| Extensão: captura pela bridge (stub) com lease read-only, VersionId antes/depois, `ExtractPdfText`-like resolvido do payload (`i5FAvgzI2UOEJ7U4bvKbRw`), `--pin-xif` com SHA-256 | `CaptureResolvesTheServerSignatureAndPinsTheXifThroughAReadOnlyLease` |
| Erros tipados sem escrever arquivo: NotReadOnly (nenhuma operação), ProducerNotFound, NotActive, VersionIdChanged, SignatureUnavailable, ElementNotFound, IdentityMismatch | `CaptureRefusalsAreTypedAndWriteNothing` |
| `--pin-xif` recusado (republicação durante o download do `.xif`): nem `.avsig` nem `.xif` (B5) | `RefusedXifPinWritesNeitherTheEnvelopeNorTheXif` |
| (System): reconhecido pela chave com `Is_System=false`, guarda por hash anunciado, Login `DrBxgnTw8ECd0ZLsqFHPbQ` + fechamento `User`; re-atestação ok e recusa após "upgrade" | `SystemCaptureResolvesLoginAndGuardsOnTheAdvertisedHash` |
| Deliver `--capture-producer`: captura única, sha256 nas sources, binding no apply, re-atestação; retomada sem recaptura | `DeliveryCapturesOnceRecordsTheHashAndReattestsBeforeApplying` |
| Deliver com dois produtores, a 2ª captura falha: a 1ª fica gravada; a retomada captura só a que faltava, reusa o arquivo e o sha256 da 1ª (uma entrada por captura nas sources), re-atesta as duas e chega ao apply; uma 3ª execução não captura nada (B5) | `DeliveryResumesAPartialCaptureAndCapturesOnlyTheMissingProducers` |
| Deliver recusa produtor republicado antes de qualquer snapshot | `DeliveryRefusesAProducerRepublishedAfterItsCaptureBeforeAnySnapshot` |
| Deliver recusa outro ambiente, fixture offline e envelope atestado sem autoridade | `DeliveryRefusesUnattestableProducerSignatures` |
| Envelope capturado (v2) importa e é chamável como o v1 | `CapturedExtensionSignatureImportsAndIsCallable` |
| eSpace sem OML do produtor: `Product_GetById` + fechamento `ProductSummary`/`Product`; depois refresh A' com `elements: []` | `ESpaceProducerElementsImportWithTheirTypeClosureWithoutTheProducerOml` |
| (System) Login na referência (System) existente do `blank-service` | `SystemLoginImportsIntoTheExistingSystemReference` |
| Lease read-only recusa cada operação de escrita no cliente | `ReadOnlyLeaseRefusesEveryWriteOperationBeforeSubmission` |
| Envelope v2 malformado (sem atestação, sem versão, guarda incoerente, fonte desconhecida, fechamento estranho) | `MalformedEnvelopeCannotBecomeAnAcceptedProducer` |

### 3.2 HMISJHA_CS publicado (v5578): (System) User + AgentOps_Core_CS sem OML dos produtores

Bases (sha256; desde o merge do release elas também estão versionadas em `kernel\tests\fixtures\hmisjha\`):
`HMISJHA_CS-v5578.oml` `497c8bda…7f66`, `HMISJHA-v5580.oml` `932990bd…7110`, `AgentOps_Core_CS-v5585.oml`
`2173965d…ffcd5` (as cópias usadas na prova são idênticas byte a byte às versionadas pelo release).

```powershell
cd C:\Users\andre\SSAM-Hybrid-o11-sso-deps\kernel; $env:ANVIL_WORKER='0'; $env:ANVIL_ODC_NO_WORKER='1'; $p='.local\k1-b5\offline'
dotnet .local\cli\anvil.dll signature-fixture --from-consumers "tests\fixtures\hmisjha\HMISJHA-v5580.oml,tests\fixtures\hmisjha\HMISJHA_CS-v5578.oml" --key "uXCIR2Atc0+es3zYuZSnNw" --system --elements "IEntitySignature:User" --out "$p\System.avsig" --work "$p\work"
dotnet .local\cli\anvil.dll signature-fixture --from-oml tests\fixtures\hmisjha\AgentOps_Core_CS-v5585.oml --elements "IServerActionSignature:GetAgentRunTrace" --out "$p\AgentOps_Core_CS.avsig" --work "$p\work"
dotnet .local\cli\anvil.dll apply --job tests\jobs-live\hmisjha-k1-dependencies\k1-offline-system-core.json --out "$p\HMISJHA_CS-k1-offline.oml" --producer "System=$p\System.avsig" --producer "AgentOps_Core_CS=$p\AgentOps_Core_CS.avsig" --work "$p\work" 1> "$p\3-apply.json" 2> "$p\3-apply.log"
dotnet .local\cli\anvil.dll merge-probe --base tests\fixtures\hmisjha\HMISJHA_CS-v5578.oml --foreign "$p\HMISJHA_CS-k1-offline.oml" --work "$p\work" 1> "$p\4-merge-probe.json" 2> "$p\4-merge-probe.log"
```

`--out` é relativo, e o `3-apply.json` grava esse `outPath` relativo: o gate da seção 7.2 tem de rodar desta mesma pasta
(`kernel` do worktree).

| Etapa | Resultado (job corrigido em B5) |
|---|---|
| (System) reconstruído dos consumidores | 38 elementos, todos reproduzindo o `FullSignatureHash` que cada consumidor guardou do servidor (0 divergências), 672.422 bytes, hash local `e4267b03-600d-68a8-3ae1-95f56e9783f5` (determinístico). `User` = `LYIWpF+Ey0aicHD144NUTA`. |
| AgentOps_Core_CS do OML v5585 | 183.088 bytes, hash local `86ade7ad-dd05-2281-bc83-530ed81cc2fa`; `GetAgentRunTrace` = `dDPIhIX9GUCBvzZKzBsFKQ`; fechamento de 15 tipos (RunTraceDTO, RunHeaderDTO, TraceItemDTO via lista, CheckpointDTO, RunLimitDTO e 10 static entities). |
| apply `k1-offline-system-core.json` | 11 ops, 59.793 objetos, **isValid=True, accepted=True, 0 mensagens**; 18 s. (System): `referenceExisted=true`, `User` já estava na referência (`added=0`), hash `0000…` → `e4267b03…`. Core: `e5f1afb6…` → `86ade7ad…`, `GetAgentRunTrace` acrescentado (os 15 tipos do fechamento já existiam). A action **privada** `ProbeK1RunTraceAndUser` (sem inputs) lê `ReadTrace.Trace.Items.Length` e o próprio `User` da sessão sem erro de tipo; o timer sem agendamento `ProbeK1RunTraceAndUserTimer` é o seu único consumidor. `preflight.publicActions=0`. |
| merge-probe (base v5578, foreign = saída) | 59.793/59.793 objetos, válido, **0 erros, 0 avisos, sem conflitos**. |
| gate de padrões O11 (autor, `--stage all`) | **exit 0**; único achado novo = `AR1 info` (o binding `System` não está em `config.modules`); os 117 demais são preexistentes do módulo, cobertos pelas exceções do release. |

Os dois `.avsig` desta prova têm `Environment = offline.invalid` e fonte de evidência: o deliver os recusa. O hash de
uma assinatura de eSpace calculado localmente nunca é o do servidor (`gaps\verify\sighash.log`); por isso a entrega
exige a captura viva.

Achado do caminho: os filhos de uma `Reference` não enumeram em ordem estável entre cargas; a reconstrução ordena por
OriginalKey para que o payload e o hash local sejam reproduzíveis.

## 4. O que a prova viva mostrou (e o que ainda falta)

1. **Feito.** `signature` sob SSO pelo Anvil.Core instalado no SS4, lease só leitura e sem arquivo de credencial ("read-only
   lease on bridge 4516 ... no credential file"), para extensão (HMISPdfText) e (System).
2. **Feito.** O hash do catálogo (`referenceable`) e o hash devolvido por `signature` coincidem nos dois casos
   (`advertisedMatchesSignature=true`).
3. **Feito.** O payload real do (System) tem 221 `ElementSignature` (1.296.693 bytes; a reconstrução offline tinha 38) e
   refresca a referência (System) inteira do HMISJHA_CS, `ReferenceHash` `0000…` → `eee5a39e…`, sem mensagem nova
   (job corrigido: 0 mensagens).
4. **Parcial.** Structure de extensão pelo fechamento: a captura de `ExtractPdfText` devolveu `closure: []`. O output
   `Pages` é do tipo anônimo `PdfPageTextRecordList` (seção `AnonymousTypesNames` do payload), e o `TypeClosure` pula
   tipos anônimos em vez de descer até a structure nomeada `PdfPageText`. Mesmo assim o `RefreshReferences` nativo trouxe
   a structure (`added=3`, `find PdfPageText` não vazio, a action de prova tipa `Pages` como `PdfPageText List` sem erro).
   Pendência: descer nos tipos anônimos do payload de extensão para que o envelope registre o fechamento real.
5. **Falta.** No merge da bridge, referência eSpace **existente** com hash novo passa pela seleção explícita do
   `ReferenceSignatureMerge` (já implementada na bridge instalada, sem prova viva para eSpace). Só com deliver
   autorizado, num módulo ZZ de teste primeiro (desenho 2.1, passo 6; L5).

## 5. Limites e o que não foi feito

- `propose`/`continue` (`dependencies: [...]`) continua fora: o `DeliveryRequest` desse fluxo segue sem produtores.
  `o11_job`/`ssam_job` e `deliver` já aceitam `producers` e captura. Decisão mantida em B5 (fora do escopo da revisão).
- Remoção de dependência (opção C) fora do escopo.
- Dependências de outro produtor (`foreignDependencies`) são só relatadas; a referência daquele produtor tem de existir
  ou ser capturada junto.
- `--pin-xif` só para extensão com versão publicada; o `.xif` fica na pasta da tarefa, identificado por SHA-256, nunca
  publicado.
- `signature-fixture` é só evidência offline e não substitui a captura.
- Fechamento de tipos anônimos de extensão: ver 4.4.

## 6. Prova viva (integrador, 2026-09-26, só leitura) e comandos

Pré-requisitos: SS4 aberto e logado em `personal-2qqw9srv.outsystemscloud.com` (bridge 4516, Anvil.Core instalado de
16/09; **não** rodar `open_studio.ps1` nem trocar DLL). CLI do worktree construído cru:

```powershell
cd C:\Users\andre\SSAM-Hybrid-o11-sso-deps\kernel
$env:ANVIL_WORKER='0'; $env:ANVIL_ODC_NO_WORKER='1'
dotnet build src\Anvil.Cli -c Release -o .local\cli
$live = 'C:\Users\andre\SSAM-Hybrid-o11-sso-deps\kernel\.local\k1-live'; New-Item -ItemType Directory -Force $live | Out-Null
```

Evidência em `kernel\.local\k1-live\` (L1–L4 do integrador, jobs de antes de B5) e `kernel\.local\k1-b5\live\` (L3'/L4',
jobs corrigidos, sobre as mesmas capturas vivas; nenhuma chamada nova ao Studio ou ao ambiente).

| Passo | Resultado |
|---|---|
| **L1** captura HMISPdfText (`--pin-xif`) | `ok=true`, extensão `11B3VoXJqE2Vul+gqAKRBw`, **VersionId 149** antes e depois, `guard=extension-version`, **SignatureHash `861bafeb-b394-d5e8-48bd-ab2f9561106c`** (= inventário), `advertisedMatchesSignature=true`, 4.733 bytes, 5 elementos; `ExtractPdfText` = `vITPpt51jlmh7JVc9c6KGw` (xifgen :186); `closure: []` (ver 4.4); `.avsig` sha256 `b7d2f868…54dffe`; **`.xif` v149 2.567.316 bytes, sha256 `af1f2e29bd8525b977159b16ff041d0aad994c8a5719499f101e0fca19cc7cc3`**; 8,8 s. |
| **L2** captura (System) | `ok=true`, `system=true`, `guard=signature-hash`, **hash `eee5a39e-be64-035a-9b30-34e14570177b`** anunciado = assinado, 221 elementos, 1.296.693 bytes; `Login` = `DrBxgnTw8ECd0ZLsqFHPbQ`, fechamento `User` = `LYIWpF+Ey0aicHD144NUTA`; `.avsig` sha256 `3b3a171a…71ff92`; 3,9 s. |
| **L3** apply no HMISJHA_CS v5578 (job antigo, com Login) | 6 ops, 59.796 objetos, **isValid, accepted, 1 mensagem** (o `LoginSecurity` declarado). HMISPdfText: referência nova, `added=3`, **`ReferenceHash = SignatureHash` (`861bafeb…`)**. (System): referência existente, `Login` acrescentado, **`ReferenceHash` `0000…` → `eee5a39e…`**. `find` ExtractPdfText, PdfPageText, Login não vazios. |
| **L4** merge-probe (job antigo) | 59.796/59.796, válido, **0 erros, 1 aviso** (o `LoginSecurity` declarado), **sem conflitos**. |
| **L3'** apply com o job corrigido (B5), mesmas capturas | 11 ops, 59.811 objetos, **isValid, accepted, 0 mensagens**. HMISPdfText como em L3 (`added=3`, `861bafeb…` = SignatureHash). (System): `User` selecionado da captura viva (está no envelope como fechamento de Login), já presente (`added=0`), `ReferenceHash` `0000…` → `eee5a39e…`. `find` ExtractPdfText, PdfPageText, User não vazios; `preflight.publicActions=0`. |
| **L4'** merge-probe do L3' | 59.811/59.811, válido, **0 erros, 0 avisos, sem conflitos**. |
| gate O11 do L3' | **exit 0** (autor, job + truechange + oml); ver 7.2. |

Comandos executados (L1–L4) e os do job corrigido:

```powershell
# L1 (leitura)
dotnet .local\cli\anvil.dll signature --producer HMISPdfText --key "11B3VoXJqE2Vul+gqAKRBw" --kind Extension --elements "IServerActionSignature:ExtractPdfText" --pin-xif --out "$live\HMISPdfText.avsig" --host personal-2qqw9srv.outsystemscloud.com --bridge-port 4516 1> "$live\L1-signature-pdftext.json" 2> "$live\L1-signature-pdftext.log"
# L2 (leitura). Para o job corrigido basta --elements "IEntitySignature:User"; a captura com Login também serve (User é fechamento de Login)
dotnet .local\cli\anvil.dll signature --producer "(System)" --key "uXCIR2Atc0+es3zYuZSnNw" --kind eSpace --elements "IServerActionSignature:Login" --out "$live\System.avsig" --host personal-2qqw9srv.outsystemscloud.com --bridge-port 4516 1> "$live\L2-signature-system.json" 2> "$live\L2-signature-system.log"
# L3'/L4' (offline, job corrigido)
$b5 = '.local\k1-b5\live'
dotnet .local\cli\anvil.dll apply --job tests\jobs-live\hmisjha-k1-dependencies\k1-live-pdftext-system.json --out "$b5\HMISJHA_CS-k1-live.oml" --producer "HMISPdfText=$live\HMISPdfText.avsig" --producer "System=$live\System.avsig" --work "$b5\work" 1> "$b5\L3-apply.json" 2> "$b5\L3-apply.log"
dotnet .local\cli\anvil.dll merge-probe --base tests\fixtures\hmisjha\HMISJHA_CS-v5578.oml --foreign "$b5\HMISJHA_CS-k1-live.oml" --work "$b5\work" 1> "$b5\L4-merge-probe.json" 2> "$b5\L4-merge-probe.log"
```

**L5 — só com palavras de autorização e num módulo ZZ de teste (não faz parte desta prova).** O deliver capturaria
sozinho (uma vez por produtor; a retomada captura só as que faltam) e re-atestaria antes do apply e do merge:
`dotnet .local\cli\anvil.dll deliver --module ZZ<Teste>_CS --job <job sobre o ZZ> --capture-producer HMISPdfText --capture-producer "System=(System)" --checks <Nomes>`.
Pelo MCP: `o11_job` com `captureProducers: ["HMISPdfText", "System=(System)"]` (leitura) ou `producers: {Nome: caminho}`.
Os jobs `hmisjha-k1-dependencies` são provas sobre cópia e **não** são entregáveis: o deliver os recusa antes de
registrar a tarefa (seção 7.4). Os jobs corrigidos só refrescam o hash da referência (System) (`User` já estava nela,
`added=0`); o único acréscimo de elemento novo do (System) provado é o `Login` do job antigo (L3). No L5, escolher um
elemento do (System) que o módulo ZZ ainda não referencia (por exemplo uma entidade de sistema só lida), para provar
ao vivo também esse caminho.

## 7. Revisão adversarial K1 — correções da frente B5

### 7.1 Maior 1: captura de vários produtores não retomável

Antes: `CaptureProducers` só gravava `capturedProducers` depois de capturar **todos**; as entradas das `sources` iam sendo
acrescentadas na memória e o `task.Save` do `finally` as persistia. Com dois `--capture-producer`, se o 1º dava certo e o
2º falhava, a retomada recapturava o 1º no mesmo arquivo (novo `CapturedAtUtc`, novo sha256) e acrescentava uma 2ª
entrada nas `sources`: o apply parava em "Job or dependency changed during apply" e toda retomada seguinte em "Task source
changed" (sonda do revisor `PartialCaptureFailureThenResume`, 3 leituras de `signature`).

Agora (`Delivery.CaptureProducers`): cada produtor capturado entra em `capturedProducers` e nas `sources` e a tarefa é
salva logo em seguida (`capture-producer:<Nome>`); a retomada pula os gravados (conferindo que o produtor é o mesmo),
captura só os que faltam e exige exatamente uma entrada por captura nas `sources`, com o sha256 gravado. Arquivo de uma
captura que não chegou a ser gravada (tentativa interrompida) é descartado antes de capturar de novo: nada o consumiu,
porque todas as capturas precedem o apply. Tarefa de antes de B5: só se recupera a que falhou uma única vez (sem
`capturedProducers`, uma entrada por arquivo). A que um build anterior a B5 já retomou (entrada duplicada nas `sources`,
arquivo recapturado com sha256 novo) continua parando em "Task source changed", porque a conferência das `sources`
(`Delivery.cs`, antes do `open_module`) roda antes de `CaptureProducers`; essa tarefa tem de ser fechada
(`deliver --close <id> --reason ...`) e criada de novo. Nenhum deliver vivo com `--capture-producer` rodou até hoje (L5
não foi feito), então nenhuma tarefa real está nesse estado. A re-atestação continua sobre
todas as `.avsig` atestadas das `sources`, antes do apply e antes do merge. Teste:
`DeliveryResumesAPartialCaptureAndCapturesOnlyTheMissingProducers` (extensão ZZHighCodePrimitives + (System), por stubs do
`environment_session`; a 1ª execução
falha em `SignatureUnavailable` no (System) sem snapshot nem apply; a retomada faz 1 leitura nova, só do (System)).

### 7.2 Maior 2: jobs de prova com action pública chamando (System) Login

Antes: os dois jobs criavam uma server action **pública** que chamava `(System) Login` com um `UserId` arbitrário
(impersonação se um dia fosse entregue) e falhavam o gate (N4: `LoginSecurity` declarado; N1: nomes sem verbo, inputs e
outputs sem descrição, assign sem `as`; L7: literal 4000).

Agora:
- Nenhum `Login` em lugar nenhum. O (System) é provado pela entidade `User`: um aggregate lê só o registro do próprio
  usuário da sessão (`User.Id = GetUserId()`, Max Records 1). Nada recebe `UserId`. A prova do (System) não grava; a do
  `GetAgentRunTrace` grava um DataAccessEvent quando o leitor de oversight tem sessão (ver o fim desta seção).
- As actions de prova são **privadas** e **sem inputs** (`ProbeK1PdfTextAndUser`, `ProbeK1RunTraceAndUser`), com a marca
  "K1 PROBE ONLY, NEVER DELIVER" na descrição; `preflight.publicActions=0`.
- Plataforma: uma server action não pública sem consumidor recebe `UnusedUserAction` (ServiceStudio.Model `Flows.cs`
  8768-8776: `if (Public) ... else if (!Referers.Any()) UnusedUserAction`; observado no apply offline intermediário de B5, com a
  action privada ainda sem consumidor: 1 aviso `UnusedUserAction`) e a N4 do gate conta
  todo aviso, declarado ou não. Por isso o único consumidor de cada probe é um **timer sem agendamento**
  (`...Timer`, `TimeoutInMinutes=1`, também marcado "NEVER DELIVER"): não roda sozinho, não é chamável de outro módulo;
  rodado à mão no Service Center, executaria sem sessão (o aggregate não acha usuário, `ExtractPdfText` recebe
  `NullBinary()`, `GetAgentRunTrace` recebe o run 0). A probe do job ao vivo só lê. A do job offline **não** é leitura
  pura por construção: `GetAgentRunTrace` grava um `DataAccessEvent` (`RecordTraceRead` → `RecordOversightDataAccess`)
  para quem tem papel de leitura de supervisão. Ela não grava nada só porque o timer roda sem sessão e
  `RequireOversightReaderRole` (AgentAdmin ou AgentAuditor, com sessão) levanta exceção antes desse registro (fluxo
  `GetAgentRunTrace_Impl` do `AgentOps_Core_CS-v5585.oml` lido pelo revisor: `CheckOversightRole` → `BuildRunTrace` →
  `RecordTraceRead`); a descrição da action diz isso. O timer seria uma porta de execução manual nova se o job fosse
  entregue; o deliver o recusa (7.4).
- Gate de padrões O11 (`C:\Users\andre\SSAM-Hybrid-o11-sso\kernel\tests\jobs-live\hmisjha\padroes\o11_padroes.py`, modo
  autor, `--cli` = CLI deste worktree, `--out`/`--work` em `kernel\.local\k1-b5\gate`):

```powershell
# Rodar desta pasta: os --result gravam outPath relativo e o gate o resolve contra a pasta atual (senão exit 2,
# "data.outPath ... diferente de --oml").
cd C:\Users\andre\SSAM-Hybrid-o11-sso-deps\kernel
$py='C:\Users\andre\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$g='C:\Users\andre\SSAM-Hybrid-o11-sso\kernel\tests\jobs-live\hmisjha\padroes\o11_padroes.py'; $k='C:\Users\andre\SSAM-Hybrid-o11-sso-deps\kernel'
& $py $g --mode autor --stage all --job "$k\tests\jobs-live\hmisjha-k1-dependencies\k1-offline-system-core.json" --result "$k\.local\k1-b5\offline\3-apply.json" --oml "$k\.local\k1-b5\offline\HMISJHA_CS-k1-offline.oml" --base-oml "$k\tests\fixtures\hmisjha\HMISJHA_CS-v5578.oml" --module HMISJHA_CS --cli "$k\.local\cli\anvil.dll" --work "$k\.local\k1-b5\gate\work-offline-all" --out "$k\.local\k1-b5\gate\k1-offline-system-core.all.padroes.json"
& $py $g --mode autor --stage all --job "$k\tests\jobs-live\hmisjha-k1-dependencies\k1-live-pdftext-system.json" --result "$k\.local\k1-b5\live\L3-apply.json" --oml "$k\.local\k1-b5\live\HMISJHA_CS-k1-live.oml" --base-oml "$k\tests\fixtures\hmisjha\HMISJHA_CS-v5578.oml" --module HMISJHA_CS --cli "$k\.local\cli\anvil.dll" --work "$k\.local\k1-b5\gate\work-live-all" --out "$k\.local\k1-b5\gate\k1-live-pdftext-system.all.padroes.json"
```

| Job | Estágio job | Estágios job + truechange + oml |
|---|---|---|
| `k1-offline-system-core.json` | exit 0 (só `AR1 info`) | **exit 0**; achados novos: 1 `AR1 info`; demais preexistentes, cobertos pelas exceções do release |
| `k1-live-pdftext-system.json` | exit 0 (só `AR1 info` ×2) | **exit 0**; achados novos: 2 `AR1 info`; demais preexistentes, cobertos pelas exceções do release |

`AR1 info`: os bindings `System`/`HMISPdfText` não estão em `config.modules` do gate (o (System) está como `(System)`);
é informativo e não bloqueia.

### 7.3 Menores e verificação

- `--pin-xif` recusado deixava o `.avsig` gravado (sonda do revisor `PinXifRefusalAfterTheEnvelopeIsWritten`): o `.xif` é
  lido e a versão re-observada antes de gravar qualquer arquivo; teste `RefusedXifPinWritesNeitherTheEnvelopeNorTheXif`.
- `propose`/`continue` com `dependencies` continua fora (seção 5).
- Testes (CLI e testes reconstruídos crus depois do merge do release `claude/hmisjha-poc`, `ANVIL_WORKER=0`,
  `ANVIL_ODC_NO_WORKER=1`): alvo `NativeReferenceSignatureCaptureTests|NativeReferenceImportTests|NativeReferenceSnapshotTests|ConnectedEnvironmentTests`
  **57/57**; regressão `NativeReference|ConnectedEnvironmentTests|Delivery|NativeDependency|CSharpReference|DataContractTests|AppSession`
  **238/238** (5 min 10 s), igual ao resultado antes do merge. O merge não tocou fonte do kernel, scripts nem fachada.
- Os applies, merge-probes e o gate das seções 3.2, 6 (L3'/L4') e 7.2 rodaram com o CLI de B5 antes do merge; o merge não
  mudou fonte do kernel. Refeitos depois na seção 7.4.

### 7.4 Revisão de B5: menores

A revisão de B5 (bde0219..bdf25df) não teve achado bloqueante. Menores tratados:

- **O deliver recusa os jobs de prova** (antes a marca "NEVER DELIVER" era só texto). `NonDeliverableJobs.Require`
  (`src/Anvil.Core/Delivery/NonDeliverableJobs.cs`) roda no início de `Delivery.Run`, antes de registrar a tarefa e
  antes de qualquer chamada à bridge. Recusa um job:
  1. em `tests\jobs-live\hmisjha-k1-dependencies` (ou abaixo dela), em qualquer checkout; ou
  2. com `NEVER DELIVER` (maiúsculas, como marca) numa descrição: um valor `description` em qualquer ponto do job
     (o do job, o de uma action, input ou output) ou o `value` de um `set` da propriedade `Description`.
  Uma cópia da prova fora da pasta continua recusada pela marca da action de prova. A retomada relê o job gravado, então
  uma tarefa registrada antes da regra também é recusada; `deliver --close` continua possível. Os dois jobs também
  ganharam a marca na descrição do job. Teste `DeliveryTests.ProofOnlyJobsAreRefusedBeforeAnyTaskOrBridgeCall`: os dois
  jobs versionados, uma cópia sem a descrição do job, marca no topo, marca num `set Description` e um job sem marca numa
  pasta `tests\jobs-live\hmisjha-k1-dependencies` de outro checkout são recusados, sem chamada à bridge e sem pasta
  `deliver`. Passam a regra: prosa "never deliver" em minúsculas, pasta de mesmo nome fora de `tests\jobs-live`, um
  job comum de `tests\jobs` e um arquivo inexistente (fica para a validação do job).
- Texto da probe offline: diz que ela não grava nada só porque o timer roda sem sessão (7.2).
- 7.1: a recuperação de tarefas de antes de B5 ficou restrita ao caso que funciona; as já presas são fechadas e
  recriadas.
- 7.2: o bloco do gate começa com `cd` para a pasta `kernel` do worktree.
- `docs/PROVAS.md`: a primeira linha K1 (d795a24, job com Login) está marcada como superada.
- L5: escolher um elemento do (System) que o módulo ZZ ainda não referencia (seção 6).

Achado do caminho: `DeliveryTests` rodado sozinho falhava em 6 casos de `FullWorkflowUsesOneMergeAndStopsAtTheFailingStage`
(estágio `producer-signatures`, `FileNotFoundException` de `OutSystems.Model.V1`). O `AttestProducers` do K1 chamava
`ProducerSignatures.RequiresAttestation` para toda fonte, inclusive o `job.json`; a chamada compila o leitor de
envelopes, que carrega os assemblies do Studio. Nas execuções anteriores outra classe de teste já os tinha carregado, e o
CLI os carrega antes do `deliver`, por isso não aparecia. Agora só fontes `.avsig` chegam a essa chamada, e uma entrega
sem assinatura de produtor não precisa dos assemblies nesse estágio.

Verificação (depois do merge do release `claude/hmisjha-poc` em `c07212d`, sem conflito; o merge trouxe só jobs,
fixtures e `docs/specs/hmisjha`, nenhuma fonte do kernel):

- Testes, `ANVIL_WORKER=0`, `ANVIL_ODC_NO_WORKER=1`: alvo K1 **57/57**; filtro `FullyQualifiedName~DeliveryTests` sozinho
  (`DeliveryTests` e as demais classes `*DeliveryTests`) **61/61**; `Delivery|AppSession` sozinhos **88/88**; regressão
  `NativeReference|ConnectedEnvironmentTests|Delivery|NativeDependency|CSharpReference|DataContractTests|AppSession`
  **239/239** (4 min 58 s).
- CLI cru: `dotnet build src\Anvil.Cli -c Release` com 0 erros. A pasta `.local\cli` estava travada por outra frente
  (a revisão pdftext rodava `merge-probe` com esse CLI; `MSB3027`, arquivo em uso por vários `.NET Host`). Para não
  derrubar essa frente, o build pós-merge foi para `.local\cli-postmerge`, e os comandos abaixo usam esse CLI. Com a
  pasta livre, `.local\cli` foi reconstruído no fim, do mesmo commit (0 erros). Com ele,
  `deliver --module HMISJHA_CS --job tests\jobs-live\hmisjha-k1-dependencies\k1-offline-system-core.json --port 9`
  sai com exit 1 e a recusa `deliver refuses proof-only jobs`, sem pasta `deliver`. A `--port 9` é só uma proteção:
  a recusa vem antes de qualquer chamada.
- Jobs refeitos offline (evidência em `kernel\.local\k1-b5r\`; a de `k1-b5` fica como estava):
  offline `k1-offline-system-core.json` 11 ops, 59.793 objetos, isValid, accepted, 0 mensagens, `publicActions=0`;
  merge-probe 59.793/59.793, 0 erros, 0 avisos, sem conflitos. L3' `k1-live-pdftext-system.json` sobre as capturas vivas
  de `k1-live`: 11 ops, 59.811 objetos, isValid, accepted, 0 mensagens; HMISPdfText `added=3`, `ReferenceHash =
  SignatureHash` `861bafeb…`; (System) `added=0`, `0000…` → `eee5a39e…`; L4' 59.811/59.811, 0 erros, 0 avisos, sem
  conflitos.
- Gate de padrões O11 (autor, `--stage all`, `--cli .local\cli-postmerge\anvil.dll`, rodado da pasta `kernel`):
  **exit 0 nos dois**, com o mesmo resumo de B5: `k1-offline-system-core` `AR1 info`=1, `k1-live-pdftext-system`
  `AR1 info`=2; nos dois, D3 (6), D5 (61) e L6 (50) só como exceções do release, 107 runtimeTests (5 min 47 s e 5 min
  35 s). Relatórios em `kernel\.local\k1-b5r\gate\`.
- Prova viva: nada novo. L1–L4 continuam as do integrador (seção 6, jobs de antes de B5); L3'/L4' são os jobs
  corrigidos sobre as mesmas capturas vivas, offline. Nenhuma chamada à bridge, ao Studio ou ao ambiente nesta revisão.
