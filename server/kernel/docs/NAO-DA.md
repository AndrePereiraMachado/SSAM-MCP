# Conhecimento negativo: o que NAO da, e porque

100 factos medidos, nao lembrados. Cada um traz a mensagem exacta que o provou e o ficheiro onde foi
visto, para se poder repetir a medicao em vez de acreditar nesta pagina.

Existe porque metade do tempo perdido a automatizar OutSystems e gasto a tentar outra vez uma coisa que ja se
sabe que a plataforma recusa. Um LLM frio que leia isto primeiro nao repete a tentativa.

## Quanto disto esta verificado (2026-09-17)

Estes 100 itens foram COLHIDOS de relatorios e jobs por agentes. Os 52 que so se apoiavam em apontamentos foram
depois ATACADOS um a um por uma passagem adversarial -- agentes com ordem de os DERRUBAR, nao de os confirmar,
contra o Studio decompilado, o kernel e o contrato da API publica -- e uma segunda passagem voltou a atacar
os que a primeira dera por bons. Cada um desses itens leva agora o seu veredicto em citacao, por baixo do texto
original. O texto original FICA: apagar perderia o mais util desta pagina, que e ver COMO um facto plausivel se
revelou errado.

| veredicto | itens |
| --- | ---: |
| `IMPRECISO` -- o nucleo vale, o mecanismo ou o alcance estao errados | 27 |
| `CONFIRMADO` -- aguentou o ataque | 15 |
| `OBSOLETO` -- era verdade, ja foi consertado | 4 |
| `REFUTADO` -- e falso | 4 |
| `NAO MEDIDO` -- so se sabe correndo, e ninguem correu | 1 |

**Quinze em cinquenta e um sobreviveram intactos: 29 %.** E oito viraram na segunda passagem, ou seja a primeira
leva de agentes tambem se enganou. Escrevi no topo desta pagina, quando a criei, "100 factos medidos, nao
lembrados". Era generoso demais, e fica aqui como aviso: uma pagina de conhecimento negativo escrita por colheita
herda a confianca de quem a colheu, que e pouca.

O erro mais caro foi o oposto do que esta pagina existe para evitar. O item do BPT dizia que o ODC nao tem a
funcionalidade; tem, chama-se **Workflow**, e um tipo de asset proprio e escreve-se no Workflow Editor do Portal
-- o ODC Studio ate traz a mensagem pronta, `Files created with Workflow Editor can only be opened in ODC Portal`.
Concluiu-se a AUSENCIA no produto sem ir ver o produto, e a conclusao foi depois copiada para a `description` de um
job. A regra que fica: nem a presenca de um tipo na API prova a funcionalidade, nem a falta de job prova a
ausencia dela; ve-se no produto, que e leitura barata e esta em disco.

Por isso: **a prova de cada item e a sua `Prova:` e o seu `Visto em:`, nao esta pagina.** Contados:

| ancoragem do `Visto em:` | itens | o que vale |
| --- | --- | --- |
| um job de `tests/jobs*` | 36 | sustenta-se sozinho: o job corre nas suites e fica vermelho se o facto mudar |
| codigo em `src/` ou `scripts/` | 12 | leia-se o ficheiro citado; o codigo e a verdade, o texto e o resumo |
| so relatorios ou notas | 52 | vale o que vale um apontamento: repita a medicao antes de decidir em cima dele |

Foi um item do terceiro grupo que se revelou falso. Esses 52 sao a fila de trabalho desta pagina: passar cada um
para um dos dois primeiros grupos -- de preferencia para o primeiro, escrevendo o job que o prova.

Os tipos:

| tipo | significa |
| --- | --- |
| `recusa-da-plataforma` | a API aceita a escrita e o Verify recusa depois; o caminho existe e nao leva a lado nenhum |
| `inalcancavel` | nao ha caminho a partir do modelo low-code, independentemente da ordem das ops |
| `diferenca-entre-faixas` | O11 e ODC comportam-se de maneira diferente no mesmo pedido |
| `armadilha` | da certo, mas nao o que se esperava; o erro so aparece mais tarde |
| `limite-do-kernel` | limitacao nossa, do Anvil ou do SSAM, e nao da plataforma |


## Limites do tradutor de C# para logica OutSystems (Anvil.CSharp)

### TimeSpan.FromDays/FromHours/... com argumento NAO constante

`limite-do-kernel`

`TimeSpan.FromDays(x)` com `x` variavel e recusado com `AVCS310: Duration factory double semantics require a
constant or a supported exact integral range`. Com um literal compila, porque o valor e calculado na compilacao.

A recusa e deliberada e prefere-se ao mal menor. Estas fabricas recebem um `double` e o .NET tem regras proprias
de arredondamento para ticks; reproduzi-las em expressoes OutSystems para um valor so conhecido em runtime daria
resultados quase certos, que e a pior especie de resultado -- um erro de milissegundos que so aparece em producao
e que ninguem liga a esta traducao. Melhor recusar alto.

A volta: usar os intervalos inteiros suportados, ou exprimir a duracao com as funcoes de data do proprio
OutSystems (`AddDays`, `AddHours`, `DiffDays`...), que e o que um modulo escrito a mao faria.

Decidido em 2026-09-18 documentar em vez de implementar: nenhuma app real bateu neste limite; o unico caso e a
fixture `TemporalInstants` do proprio teste, e enquanto assim for a aritmetica de virgula flutuante nao se
reproduz. Se aparecer em trabalho a serio, reabre-se.

Prova:

```
Anvil.CSharp.SourceCompilationException : TemporalInstants.cs(13,62): AVCS310: Duration factory double semantics
require a constant or a supported exact integral range
TemporalInstants.cs(14,71): AVCS310: (a mesma, na linha seguinte)
```

Visto em: `src/Anvil.CSharp/MethodCompiler.cs:20` (`Unsupported` monta o AVCS310) e o teste
`tests/Anvil.Tests/CSharpTemporalTests.cs:25`, unico vermelho da suite O11 em 2026-09-18 (1138/1139).

## Recusas e limites da plataforma ODC (Verify e Model API): o que o ODC recusa mesmo estando a API publica disponivel

### IRestClient.Username / IRestClient.Password (REST consumido)

`recusa-da-plataforma`

As duas propriedades existem na API do ODC e aceitam escrita, mas o Verify recusa-as como ERRO: no ODC as credenciais nao vivem no modelo. Fica no modelo apenas o MODO de autenticacao (AuthenticationType + ClientAuthentication); o segredo fica fora dele. Nao tente gravar credencial num IRestClient.

Prova:

```
CustomObjectError: Invalid Password | Password is not supported, please remove it using Model API. @ InsuranceApp (ESpace) / WfCovOrdersApi (RestClient) / Password (CustomProperty) -- idem para Username. O enum AuthenticationType do ODC so tem None, BasicAuthentication e OAuth2; o get do cliente devolve Username e Password a NULL.
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc\rest-consume-post.json:2 (description, medida no proprio job) e :11 (_why do AuthenticationType); C:\Users\andre\Anvil\tests\jobs-odc\rest-consume-lifecycle.json:8

### ISessionVariable / IESpace.CreateSessionVariable

`recusa-da-plataforma`

Session Variable nao existe no produto ODC (nao ha Traditional Web). A API publica ainda oferece o tipo e o metodo de criacao exatamente como no SS11, mas a fabrica recusa na hora. Quem precisa de estado no ODC usa client variable.

Prova:

```
op #0 (create WfCovSessionState): InvalidOperationException: Session Variable objects can't be children of App objects
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc-negative\session-variable-not-in-odc.json:7 (expectError, corre em OdcJobTests.JobFailsWithTheTeachingMessageInTheOdcLane); saida colada em C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:213 e :427

### rename sobre IEvent (Extended Event) e ISystemEvent

`recusa-da-plataforma`

Renomear um evento de plataforma e recusado PELA PLATAFORMA, antes de o kernel chegar ao seu proprio 'Name is read-only': a coleccao Events nao tem handler de colisao de nomes. A unica forma de mudar o nome de um Extended Event e escrever a propriedade 'Event' (lista fechada de 11 nomes do produto); o DisplayName e o ReadableIdentifier acompanham sozinhos.

Prova:

```
op #N (rename <nome>): InvalidOperationException: Cannot find handler for object On Click of type Event. -- e, para o system event: op #N (rename WfEvtOnStart): InvalidOperationException: Cannot find handler for object OnApplicationReady of type On Application Ready. Ambas atiradas de ServiceStudio.Model.NameClashHandler.GetNamesToNameClashAgainstChildObj. Contraprova no mesmo job: o IExternalSite vizinho renomeia-se sem uma queixa.
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc\platform-events-lifecycle.json:2 (description, pontos 2 e 3) e :51, :90

### ISystemRole

`inalcancavel`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> A primeira passagem tinha dito `confirmado`; caiu na reconferencia.
> 
> **Correccao:** Manter a conclusao (nenhum job cria os tres) e trocar o motivo de IService/IExposedAction. Nao e 'abstratos (IsConcrete = false) sem classe concreta': ha classe concreta (CustomService implementa IService; CustomActionFlow implementa IExposedAction) e a flag IsConcrete nao e lida por ninguem em runtime. O que impede e o registo da ModelFactory: so fica construtor para a interface de modelo com UMA unica implementacao e que nao seja interface-base de outra ja registada (ModelFactory.cs:259-275); IService e base de IRestService/ISOAPService, por isso sai do registo e Create atira 'Couldn't find any concrete class implementing'. IExposedAction nem chega a fabrica -- nenhum pai publica Create para ele, e a recusa e do proprio kernel (Verbs.cs:311). ISystemRole fica como esta: e IsConcrete = true (ISystemRole.cs:6) e o motivo e mesmo a ausencia de Create em IESpace.
> 
> **Como se soube:** A METADE LITERAL AGUENTA: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.V1\OutSystems.Model.Logic.Integrations\IService.cs:7 traz mesmo `[ModelInterface(DisplayName = "Service", Icon = "WebService.ico", IsConcrete = false)]` e IExposedAction.cs:6 `[ModelInterface(DisplayName = "Action", Icon = "Action.ico", IsConcrete = false)]`; em odc\OutSystems.Model.V1\OutSystems.Model\IESpace.cs (694 linhas) nao ha CreateSystemRole nem CreateExposedAction -- :187 `IEnumerable<IRoleSignature> SystemRoles { get; }`, :583 `T CreateIntegration<T>(string name = null, IKey key = null) where T : IIntegration`, :671 `IAppRole CreateRole(string name = null, IKey key = null)`. A citacao confere: docs\tasks\cobertura-t-relatorio.md:500-501 (confirmei as tres mensagens no ficheiro). MAS O MECANISMO DADO E FALSO, EM DOIS PONTOS. (a) `IsConcrete` NAO TEM UM UNICO LEITOR em todo o dump ODC: existe so a definicao odc\OutSystems.Model.V1\OutSystems.Model\ModelExtensions.cs:355-357 `public static bool IsConcrete(this Type type) { return type.GetCustomAttribute<ModelInterfaceAttribute>()?.IsConcrete ?? false; }` e ZERO chamadas `.IsConcrete()` em qualquer .cs de C:\Users\andre\ODC3\decompiled\odc. A flag e metadado de geracao de codigo, nao causa da recusa. (b) 'sem classe concreta' e literalmente falso: odc\OutSystems.Model\ServiceStudio.Model\CustomService.cs:49 `public class CustomService : AbstractObject, ICustomService, ... OutSystems.Model.Logic.Integrations.IService, IIntegration, OutSystems.Model.IObject, ...` e odc\OutSystems.Model\ServiceStudio.Model\Flows.cs:73 `public class CustomActionFlow : AbstractCustomActionFlow, ... IActionSignature, IExposedAction, IObjectWithNodes`. A CAUSA REAL esta em odc\OutSystems.Model\OutSystems.Model.API\ModelFactory.cs:259-275: `if (!item.Value.IsSingle()) { constructorsByType.Remove(key); } key.GetInterfaces().Apply(delegate(Type baseInterface) { constructorsByType.Remove(baseInterface); });` -- toda interface-BASE de um tipo registado e removida do dicionario `constructors` (:23 `Dictionary<Type, ConstructorInfo> constructors`), e IService e base de IRestService (tests\jobs-odc\rest-expose.json:2: `ServiceStudio.Plugin.RESTService.RestService, criado por IESpace.CreateIntegration<T>`); logo Create(typeof(IService)) cai em ModelFactory.cs:153 `throw new ArgumentException("Couldn't find any concrete class implementing " + type.FullName);` (via ESpace.cs:22199-22201 `T IESpace.CreateIntegration<T>(...) { return ModelFactory.Create<T>(this, ...); }`). Nota sobre a evidencia do agente anterior: o template do kernel e src\Anvil.Core\Kernel\Verbs.cs:311 `throw new InvalidOperationException($"{Describe(parent)} cannot create {typeName} (no Create method in the API)")`, NAO :883, que e `unknown Model API type: {typeName} (not in OutSystems.Model.V1 nor in the Studio plugins)`.
> 
> **Job que o ancoraria:** Nao existe hoje (tests/jobs-odc-negative tem so 7 jobs: delete-block-event-in-use, delete-data-in-use, delete-logic-in-use, delete-screen-in-use, move-foreign-sibling, rename-name-clash, session-variable-not-in-odc). O molde e session-variable-not-in-odc.json, que confirmei ter UM `expectError` array por job -- logo sao TRES jobs irmaos, nao um. tests/jobs-odc-negative/system-role-not-creatable.json (create ISystemRole sobre @espace, expectError ['create <nome>','cannot create ISystemRole (no Create method in the API)']), .../exposed-action-not-creatable.json (idem com IExposedAction) e .../service-not-creatable.json (create IService, expectError ['Couldn't find any concrete class implementing OutSystems.Model.Logic.Integrations.IService']). Todos com `base` na fixture odc e `expectValid: true`, a correr em OdcJobTests.JobFailsWithTheTeachingMessageInTheOdcLane.


Existe na API do ODC mas nao se cria a partir do modulo: nao ha metodo Create. O papel que um autor cria e IRole -> concreto IAppRole, por IESpace.CreateRole.

Prova:

```
IESpace 'InsuranceApp' cannot create ISystemRole (no Create method in the API)
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:500 (tabela 'Tipos que NAO existem no ODC'); caminho que funciona provado em C:\Users\andre\Anvil\tests\jobs-odc\security-settings.json

### IService e IExposedAction (OutSystems.Model.Logic.Integrations)

`inalcancavel`

Os dois nomes existem na API mas sao abstratos (IsConcrete = false) e nao tem classe concreta nem metodo Create. O REST exposto de verdade no ODC e IRestService, do plugin ServiceStudio.Plugin.RESTService, criado por IESpace.CreateIntegration<T>.

Prova:

```
ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.Logic.Integrations.IService -- e IESpace 'InsuranceApp' cannot create IExposedAction (no Create method in the API)
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:501; caminho que funciona em C:\Users\andre\Anvil\tests\jobs-odc\rest-expose.json

### ILocalStorageEntity

`inalcancavel`

Nao existe tipo proprio de 'local storage' no ODC: o tipo e IClientEntity, o mesmo nome do SS11. Procurar pelo nome do conceito da erro de tipo desconhecido.

Prova:

```
KeyNotFoundException: unknown Model API type: ILocalStorageEntity (not in OutSystems.Model.V1 nor in the Studio plugins)
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:499; IClientEntity criado com sucesso em C:\Users\andre\Anvil\tests\jobs-odc\client-storage.json

### IAggregateAttribute (nome do SS11) num job ODC

`diferenca-entre-faixas`

> **CONFIRMADO** (passagem adversarial, 2026-09-17)
> 
> **Como se soube:** C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.V1\OutSystems.Model.Logic.Aggregates\IAggregatedAttribute.cs:10-11 -- `[ModelInterface(DisplayName = "Aggregate Attribute", Icon = "StructureAttribute.ico", IsConcrete = true)]` / `public interface IAggregatedAttribute : IObject, ...`. Nessa mesma pasta NAO existe IAggregateAttribute.cs (Test-Path = False). Do lado O11: C:\Users\andre\Anvil\catalog\model-api-11.55.69.json:8734 -- `"Name": "OutSystems.Model.Logic.Aggregates.IAggregateAttribute"`. As propriedades batem (AggregationType, Attribute, DataType, Name) e a classe concreta e ServiceStudio.Model.AggregateAttribute nas duas.
> 
> **Job que o ancoraria:** JA existe e o `Visto em:` nao o cita: C:\Users\andre\Anvil\tests\jobs-odc\aggregate-full.json:65 (`{"op":"create","parent":"$agg","type":"IAggregatedAttribute","name":"Orders"...}` com o _why da diferenca) e tests\jobs-odc\structure-list-type.json:21. O item esta hoje no grupo 3 da tabela (so relatorios) quando ja pertence ao grupo 1 -- basta trocar o `Visto em:` do lab\cobertura-t-relatorio.md:366-379 para estes dois jobs.


No ODC a interface chama-se IAggregatedAttribute (com o mesmo DisplayName 'Aggregate Attribute', as mesmas propriedades e a mesma classe concreta ServiceStudio.Model.AggregateAttribute). Copiar o job do O11 letra a letra falha no nome da interface, nao no conceito.

Prova:

```
op #12 (create OpenCount): KeyNotFoundException: unknown Model API type: IAggregateAttribute (not in OutSystems.Model.V1 nor in the Studio plugins)
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:366-379

### Prefixo de expressao Site.<Nome> (Site Property do SS11)

`diferenca-entre-faixas`

> **CONFIRMADO** (passagem adversarial, 2026-09-17)
> 
> **Como se soube:** C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Model\ModelFrameworkConstants.cs:148-155 -- `public static string GetSiteOrSettings(ESpace eSpace) { if (!ServiceStudio.ModelFeatures.ModelFeatures.SitePropertiesRefactoredToSettings.CanBeUsedInServerAndServiceStudio(eSpace)) { return "Site"; } return "Settings"; }`. O prefixo de cliente em C:\Users\andre\ODC3\decompiled\authorship\ESpace.cs:1719 -- `Add("Client", ScopeLookupKind.NotFunction, AggregatorScopeEntry.ClientVariables(), ...)`. A mesma funcao e usada pelo parser de expressoes: ParsedExpression.cs:1171 e :1185.
> 
> **Job que o ancoraria:** JA existe e o `Visto em:` deste cabecalho nao o cita (o cabecalho gemeo da linha 463 cita): C:\Users\andre\Anvil\tests\jobs-odc\security-settings.json:40-41 (`"Rows > Settings.WfCovMaxRows"`, `"Token <> Settings.WfCovAuditToken"`) e :60 e :71 (`Client.WfCovLastFilter` lido numa expressao e gravado num Assign). Para prender tambem a metade negativa faltava um job em tests/jobs-odc-negative -- esboco: `site-prefix-not-in-odc.json`, um IAssignment com Value `Site.WfCovMaxRows` e expectedMessages [{id: ExpressionUnknownObject, element: "<Action> / <AssignNode> / Assignment", why: "no ODC o prefixo e Settings."}].


No ODC o prefixo e Settings.<Nome> e o de cliente e Client.<Nome>. Escrever Site.<Nome> ou o nome cru e erro de Verify. Provado nas duas direcoes por sonda.

Prova:

```
Error ExpressionUnknownObject: Invalid Expression | Can't identify 'Site' element in expression. @ InsuranceApp (ESpace) / WfProbe_ReadSite (ServerAction) / ReadWithSitePrefix (AssignNode) / Assignment -- e sem prefixo nenhum: Can't identify 'WfCovMaxRows' element in expression. Com Settings.WfCovMaxRows: 0 mensagens novas. Fonte: ScopeTreeFolders.GetSiteOrSettings em ServiceStudio.Model/ModelFrameworkConstants.cs (assembly OutSystems.Model do ODC Studio).
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:301-338

### Public / Shareable em action, block, structure

`diferenca-entre-faixas`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** Trocar `usar um tipo nao partilhavel no contrato de uma action shareable e ERRO, nao aviso como no O11` por: e ERRO nas duas faixas -- o que muda e a palavra (Public/public no O11, Shareable/shareable no ODC), nao a severidade. Manter o resto: IServerAction e IStructure do ODC tem as duas propriedades, o SS11 so tem Public, e `set Public true` continua a ser o que compila nas duas.
> 
> **Como se soube:** O par de propriedades confirma-se: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.V1\OutSystems.Model.Logic\IServerAction.cs -- `[Property(DisplayName = "Public")] bool Public { get; set; }` E `[Property(DisplayName = "Shareable")] bool Shareable { get; set; }`; o catalogo O11 model-api-11.55.69.json (entrada OutSystems.Model.Logic.IServerAction) lista Properties = CacheInMinutes, Folder, Function, Icon, Public -- sem Shareable. Mas `e ERRO, nao aviso como no O11` (NAO-DA.md:156) e falso nas TRES formas citadas no cabecalho; O11 resx vs ODC resx, mesma id e mesma severidade: `InvalidPublic_ActionParameterNotPublic|Error|Invalid Public Action` (o11:157) vs `|Error|Invalid Shareable Action` (odc:186); `InvalidPublicNRBlock|Error|Invalid Public Block` (o11:163) vs `|Error|Invalid Shareable Block` (odc:192); `InvalidPublic_AttributeNotPublic|Error|Invalid Public Structure` (o11:230) vs `|Error|Invalid Shareable Structure` (odc:273).
> 
> **Job que o ancoraria:** C:\Users\andre\Anvil\tests\jobs-odc\service-action.json:167-173 ja ancora o PAR Public/Shareable (quatro gets mostram os quatro estados). O que nenhum job ancora e a severidade -- ver o job par proposto no item seguinte.


No ODC 'Public' chama-se Shareable no produto e usar um tipo nao partilhavel no contrato de uma action shareable e ERRO, nao aviso como no O11. O job continua a escrever 'set Public true' (que e o que compila nas duas faixas), mas a mensagem que se le usa outra palavra.

Prova:

```
Catalogo do Verify do ODC: { "Id": "InvalidPublic_ActionParameterNotPublic", "Severity": "Error", "Title": "Invalid Shareable Action", "Detail": "The Action '{0}' is shareable but its parameter '{1}' is defined as a record of type {2} that is not shareable." } e { "Id": "InvalidPublicNRBlock", "Severity": "Error", ... }. Na API, IServerAction do ODC tem AS DUAS propriedades (Public e Shareable); no SS11 so tem Public.
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:340-364; resumo em lab\ws1-diferencas.md:50

### Count de aggregate e action sem consumidor (Verify do ODC)

`diferenca-entre-faixas`

> **REFUTADO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** O que e verdade: no ODC o Count de um aggregate e Long Integer e o Sum sobre Integer sobe a Long Integer -- e o job tem de declarar o tipo certo. O que e falso e o parentese `(no O11 e Integer)` e a classificacao `diferenca-entre-faixas`: em 11.55.87 o O11 devolve Long Integer pelo mesmo metodo. Idem para UnusedUserAction: uma server action NAO publica sem consumidor leva o aviso nas duas faixas (e marca-la Public evita-o nas duas). Reclassificar como `armadilha` do ODC ou, melhor, como facto de plataforma valido nas duas faixas. O cabecalho gemeo da linha 617 (`UnusedUserAction em server action sem consumidor`, que diz `no SS11 nao`) cai pela mesma prova e tem de ser corrigido junto.
> 
> **Como se soube:** As DUAS metades sao codigo identico nas duas faixas, logo nao sao `diferenca-entre-faixas`. (1) Count: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Model\AggregationTypeExtensions.cs:17 -- `case AggregationType.Count: return argType.OwnerESpace.GetLongIntegerType();` e o ficheiro homologo do O11, C:\Users\andre\ODC3\decompiled\o11\ServiceStudio.Framework\ServiceStudio.Model\AggregationTypeExtensions.cs:17, tem a MESMA linha; os dois ficheiros sao iguais de ponta a ponta, e ha um unico chamador em cada faixa (AggregateAttribute.cs:653 no O11, :910 no ODC). (2) UnusedUserAction: C:\Users\andre\ODC3\decompiled\o11\...\Flows.cs:8768-8776 e C:\Users\andre\ODC3\decompiled\odc\...\Flows.cs:26004-26012 sao o mesmo bloco -- `if (Public) { VerifyAllTypesAreFromPublicRecords(... InvalidPublic_ActionParameterNotPublic); } else if (!base.Referers.Any()) { addMessage(new VerifyMessage(this, VerifyMessageId.UnusedUserAction, Name)); }` -- e o resx do O11:239 tem `UnusedUserAction|Warning|...`. Alem disso a metade `no O11 e Integer` nunca foi medida: o job O11 espelho, C:\Users\andre\Anvil\tests\jobs\aggregate-sum-calc.json, NAO tem nenhuma coluna Count -- o seu output `Groups` Integer (linha 16) recebe `GetOrderTotals.List.Length` (linha 45), e List.Length e Integer nas duas faixas, como o proprio job ODC admite em aggregate-full.json:39.
> 
> **Job que o ancoraria:** A metade ODC ja esta ancorada: tests/jobs-odc/aggregate-full.json:37 (`"value": "Long Integer"` com o _why) e structure-list-type.json:56. O que faltava, e que teria apanhado o erro, e o gemeo O11: `tests/jobs/aggregate-count-type.json` -- mesmo aggregate com um IAggregateAttribute AggregationType=Count e um IOutputParameter que o recebe; declarar Integer e ver o ExpressionUnexpectedExpresssionType aparecer TAMBEM no O11 e a prova de que nao ha diferenca. Para o UnusedUserAction, o par e tests/jobs-odc/logic-action.json:9 (ja existe) mais um gemeo O11 com uma server action privada sem consumidor e expectedMessages [{id: UnusedUserAction, ...}].


No ODC o Count de um aggregate e Long Integer (no O11 e Integer), e uma server action privada sem consumidor recebe UnusedUserAction. Sao diferencas de plataforma, nao de kernel: o job tem de declarar o tipo certo e a mensagem esperada.

Prova:

```
ExpressionUnexpectedExpresssionType ... 'Integer' data type expected instead of 'Long Integer'; UnusedUserAction ... is never used
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\ws1-diferencas.md:28

### IEndNode dentro de tela (eSpace CrossDevice)

`recusa-da-plataforma`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** A fabrica do ODC nao recusa nos de fim 'num eSpace CrossDevice' -- recusa um no de fim num PAI onde nenhuma variante terminal e permitida, e escreve o tipo do eSpace na mensagem so como contexto. O caso medido foi resolucao de nome no namespace errado (Processes/BusinessProcesses), ja tratada pelo kernel (FindCreateCore.Rank + GetBaseException). Reescrever como 'armadilha' de resolucao de nome, nao como recusa-da-plataforma, e dizer explicitamente que IEndNode dentro de client/screen action funciona na faixa ODC.
> 
> **Como se soube:** A mensagem e literal mas e um FORMATO, nao uma regra sobre CrossDevice: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\OutSystems.Model.API\ModelFactory.cs:222-232 -- `if (type == typeof(IEndNode)) { if (AbstractTerminalNodeKind<UpdateScreen.Kind>.Instance.IsAllowedIn(parent)) ...; if (AbstractTerminalNodeKind<End.Kind>.Instance.IsAllowedIn(parent)) ...; throw new InvalidOperationException($"Nodes of type {type.Name} are not allowed in {((IModelObject)parent).GetInterface().Name} or eSpaces of type {parent.OwnerESpace.ESpaceType}"); }`. Ou seja: o teste e `IsAllowedIn(parent)` -- o tipo de eSpace entra por interpolacao no texto, nao na decisao. A fonte citada atribui o caso a outra causa: C:\Users\andre\SSAM-Hybrid-ODC\lab\ws1-diferencas.md:22 -- 'O mesmo nome de interface existe em mais de um namespace do ODC: ... `IStartNode`/`IEndNode`/`ICommentNode` tambem em `Processes` e `BusinessProcesses`' e '`FindCreateCore.Rank` despromove esses namespaces; `Create` passa ao candidato seguinte quando a fabrica recusa com essas mensagens'. E hoje o ODC cria IEndNode as dezenas no mesmo eSpace CrossDevice: tests/jobs-odc/block-events.json:38 e :68, block-events-nested.json:22,:47,:80, block-events-types.json:77,:150, block-events-mandatory.json:26, block-events-two-instances.json:38,:77.
> 
> **Job que o ancoraria:** O lado positivo ja esta provado por tests/jobs-odc/block-events.json (cria IEndNode em handlers dentro do eSpace CrossDevice da fixture). Falta o negativo que fixaria o que a plataforma realmente recusa: tests/jobs-odc-negative/end-node-directly-in-screen.json -- `{"op":"create","parent":"IMobileScreen:<tela>","type":"IEndNode"}` com expectError 'are not allowed in'.


A fabrica do ODC recusa nos de fim em telas de um eSpace CrossDevice. O erro aparece quando o nome IEndNode e resolvido no namespace errado (Processes/BusinessProcesses) ou quando se tenta mesmo o no numa tela.

Prova:

```
op #23 (create ): Nodes of type IEndNode are not allowed in IMobileScreen or eSpaces of type CrossDevice (a excecao vem aninhada em dois TargetInvocationException: usar GetBaseException())
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\ws1-diferencas.md:22

### CronSchedule de ITimer

`recusa-da-plataforma`

> **CONFIRMADO** (passagem adversarial, 2026-09-17)
> 
> **Como se soube:** C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Model\Schedule.cs:846-849 -- `string[] array = cronExpression.Split(new char[1] { ' ' }); if (array.Length != 5) { throw new InvalidOperationException("Invalid cron expression provided: " + cronExpression); }`, e :640 -- `return ToCronExpression<Minute>() + " " + ToCronExpression<Hour>() + " " + ToCronExpression<DayOfMonth>() + " " + ToCronExpression<Month>() + " " + ToCronExpression<DayOfWeek>();` (a ordem citada no item confere). Ja tem ancora viva: C:\Users\andre\Anvil\tests\jobs-odc\timer-action.json -- `{"op":"set","target":"$timer","prop":"CronSchedule","value":"15 3 * * *","_why":"cron de CINCO campos (minuto hora diaDoMes mes diaDaSemana); com seis campos o ODC recusa: 'Invalid cron expression provided'"}` mais um `get` e um `dump depth 3` que provam Schedule e o filho ScheduleConfiguration. Citacao confere: docs\tasks\cobertura-t-relatorio.md:381-397. Nota que o item nao da e nao contradiz: FromCronExpression tambem aceita a string vazia (limpa os itens, :837-840) e o literal `"WhenPublished"` (:841-845).
> 
> **Job que o ancoraria:** Ja ancorado em tests/jobs-odc/timer-action.json (lado positivo + os dois filhos). Falta so o negativo que prova a recusa em vez de a citar: tests/jobs-odc-negative/timer-cron-six-fields.json, set CronSchedule '0 15 3 * * ?' com expectError 'Invalid cron expression provided: 0 15 3 * * ?'.


O cron do ODC e de CINCO campos (minuto hora diaDoMes mes diaDaSemana), nao seis: a forma Quartz e recusada. Escrever CronSchedule preenche tambem Schedule e o filho ScheduleConfiguration.

Prova:

```
op #4 (set CronSchedule): InvalidOperationException: Invalid cron expression provided: 0 15 3 * * ?  at ServiceStudio.Model.Schedule.FromCronExpression(String cronExpression). Confirmado na fonte ServiceStudio.Model/Schedule.cs (ToCronExpression<Minute|Hour|DayOfMonth|Month|DayOfWeek>).
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:381-397

### IActionSignature:ListAppend num IExecuteServerActionNode

`armadilha`

No ODC ListAppend existe como IClientActionSignature E como IServerActionSignature. A forma do job O11 (IActionSignature:ListAppend) acerta na do cliente e o no de servidor recusa-a. Tem de se escrever IServerActionSignature:ListAppend.

Prova:

```
op #30 (set Action): InvalidOperationException: Cannot set OutSystems.Model.Logic.Nodes.IExecuteServerActionNode.Action to 'ListAppend' (OutSystems.Model.IObject): the value is not valid in this context
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:399-418; correcao aplicada em C:\Users\andre\Anvil\tests\jobs-odc\data-action.json:64

### IsSecret numa Setting (ISiteProperty)

`armadilha`

IsSecret NAO protege nada dentro do modelo: nem o Verify nem a Model API impedem gravar um DefaultValue em claro numa Setting secreta, e ligar IsSecret numa Setting que ja tem valor nao o apaga nem o bloqueia. Quem guarda o segredo e o Portal do ODC, nao o Studio. A bandeira e ortogonal ao valor.

Prova:

```
Medido: set DefaultValue "CHANGE-ME-IN-THE-PORTAL" numa Setting com IsSecret True passa via 'SetDefaultValue' e o get devolve o valor em claro, IsSecret continua True, 0 mensagens novas de Verify; depois set IsSecret true numa Setting com DefaultValue 250 -> get devolve IsSecret True e DefaultValue 250 INTACTO.
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc\setting-lifecycle.json:25 (_why 8a), :26 (8b), :28 (9a), :29 (9b)

### Gravar Setting dentro de uma action (WriteableSiteProperties removido)

`armadilha`

> **NAO MEDIDO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** Nada a corrigir no texto, mas esta na seccao errada: vive sob "## Recusas e limites da plataforma ODC ... o que o ODC recusa" (NAO-DA.md:38) e o proprio item diz que o ODC NAO recusou. Ou muda de seccao, ou a seccao ganha um aviso de que este item e o unico nao provado.
> 
> **Como se soube:** O item ja se declara nao provado e isso e exacto; tudo o que se pode conferir sem tenant confere. As DUAS mensagens existem no Studio ODC instalado: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Verify\VerifyMessageId.cs:1036 `ModelFeature_RemovedFeature_ModelFeature_WriteableSiteProperties` e :1116 `ModelFeature_WriteableSiteProperties_Removed`; a ligacao a marca esta em ServiceStudio.Verify\ModelFeaturesVerifyMessagesManager.cs:53 `FeatureMapper.Add(VerifyMessageId.Parse("ModelFeature_WriteableSiteProperties_Removed"), "ModelFeature_WriteableSiteProperties")`. O gate e mesmo dependente do ambiente: ServiceStudio.Model\Variables.cs:37895-37901 `SitePropertyScopeEntry.IsReadOnly => ... return !ModelFeatures.WriteableSiteProperties.CanBeUsedInServerAndServiceStudio(Owner.OwnerESpace);` e ServiceStudio.ModelFeatures\ModelFeatures.cs:772-789, onde a decisao passa por `serverModelFeaturesInfo` (nulo sem ambiente) e pelo switch de status (:1060 so o estado `Removed` gera a mensagem). O texto e a severidade citados sao copia fiel do relatorio: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:458-461 e :480 "**Nao esta provado** que gravar uma Setting e erro no ODC". Para saber se dispara e preciso o Studio ligado ao tenant -- que esta fora de questao aqui.
> 
> **Job que o ancoraria:** Nenhum job headless pode prova-lo (e essa a conclusao). O que o job pode fixar e o oposto, e ja fixa: um `tests/jobs-odc/setting-write-in-action.json` com `expectValid: true` e um `_why` a dizer que headless nao dispara -- ou seja, um canario: se um dia a mensagem passar a disparar sem ambiente, o job fica vermelho e a pagina actualiza-se sozinha. Prova definitiva so com o Studio ligado ao tenant.


AFIRMACAO NAO PROVADA, marcada como tal na fonte: o catalogo do Verify do ODC tem DUAS mensagens de Error a dizer que nao se pode mudar o valor de uma setting dentro de uma action, e o mecanismo esta ligado a marca de modelo -- MAS a sonda headless que grava Settings.<Nome> num IAssignNode passou LIMPA. As marcas so disparam com o ambiente ligado; headless (cache local Features.xml) nao disparam. Nao afirmar que gravar Setting e erro no ODC sem o Studio ligado ao tenant.

Prova:

```
Catalogo: { "Id": "ModelFeature_RemovedFeature_ModelFeature_WriteableSiteProperties", "Severity": "Error", "Detail": "You cannot change the value of a setting within an action. To change settings values, you must edit their default values." }. Contraprova medida: == probe-setting-write.json: ok=True {'ops': 17, 'objects': 59293, 'isValid': True, 'messages': 55, 'applyMs': 17} ... unexpected: 0, accepted=True
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:448-482 (a propria fonte escreve 'Nao esta provado')

### BPT / IESpace.CreateBusinessProcess

`inalcancavel`

> **REFUTADO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** O ODC TEM a funcionalidade: chama-se Workflow, e um tipo de asset proprio (SegmentationKind.BusinessProcess), escreve-se no Workflow Editor do ODC Portal e o ODC Studio recusa-se a abrir o ficheiro ('Files created with Workflow Editor can only be opened in ODC Portal'). E o mesmo padrao de vocabulario ja registado na pagina (ISiteProperty = Settings): na API chama-se BusinessProcess, no produto chama-se Workflow. O que nao se sabe -- porque ninguem executou -- e se `IESpace.CreateBusinessProcess` num modulo de Studio produz algo valido; a marca de modelo e `Stable` com `checkEnvironmentCompatibility: true`, e pelo proprio relatorio (cobertura-t-relatorio.md:477-482) marcas assim NAO disparam headless, logo o mais provavel e que a criacao passe em silencio e produza lixo. Corrigir tambem a frase 'Processo e trabalho da faixa O11' e a mesma afirmacao copiada para a description de tests/jobs-odc-negative/session-variable-not-in-odc.json:2 ('o mesmo padrao do CreateBusinessProcess (API sim, produto nao)').
> 
> **Como se soube:** C:\Users\andre\ODC3\decompiled\odc\ServiceStudio.Presenter\ServiceStudio.Presenter.Generated.PresenterMessageIdResources.Generated.resx:271 -- literal: `WorkflowInvalidApp|Error|Couldn't open file|Files created with Workflow Editor can only be opened in ODC Portal.`; disparado em C:\Users\andre\ODC3\decompiled\odc\ServiceStudio.Presenter\ServiceStudio.Presenter\AggregatorPresenter.cs:2589-2591 -- `if (... .ESpaceType == OutSystems.MetaModel.Enumerations.SegmentationKind.BusinessProcess) { ... ShowMessage(..., PresenterMessageId.WorkflowInvalidApp); return null; }`. O tipo de asset existe no enum publico: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.V1\OutSystems.Model.Enumerations\SegmentationKind.cs:17 `BusinessProcess`. E a API publica do ODC cria-o: C:\Users\andre\SSAM-Hybrid-ODC\portal\catalog\specs\asset-repository-api-v1.json:1903 -- `Recognized values are [WebApplication, MobileApplication, MobileLibrary, LowCodeLibrary, Agent, Workflow]` (e :156 lista `Workflow` entre os tipos filtraveis). No modelo nada esta removido: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.ModelFeatures\ModelFeatures.cs:1384 -- `BusinessProcesses = new ModelFeature("ModelFeature_BusinessProcesses", "Business Processes", ..., ModelFeatureStatus.Stable, ..., checkEnvironmentCompatibility: true, ...)`, e ESpace.cs:44937-44940 implementa `CreateBusinessProcess` devolvendo `new BusinessProcesses.BusinessProcess(...)` (nao lanca). As citacoes do item conferem (lab\ws1-diferencas.md:55-59, PLANO-COBERTURA.md:161), mas o que elas registam e a confirmacao do dono, nao uma medicao.
> 
> **Job que o ancoraria:** Nao existe hoje. Esboco: tests/jobs-odc-negative/business-process-create.json, base tests/fixtures/odc/insurance-reactive-r8.oml, op unica {"op":"create","parent":"@espace","type":"IBusinessProcess"} + um `get`, corrido por OdcJobTests na faixa ODC. Enquanto ninguem o correr, o veredicto honesto sobre o metodo e 'nao medido'; o que ja esta provado e que o PRODUTO tem workflows.


A API do ODC tem CreateBusinessProcess e o namespace OutSystems.Model.BusinessProcesses(.Nodes) com os mesmos tipos de atividade, mas o PRODUTO nao tem a funcionalidade. Processo e trabalho da faixa O11. NOTA DE HONESTIDADE: nao ha mensagem de recusa colada -- a prova e a superficie de API mais a confirmacao do dono; ninguem executou.

Prova:

```
Superficie confirmada por sonda sobre a DLL: CreateBusinessProcess: True; IBusinessProcess: True; OutSystems.Model.BusinessProcesses.Nodes: True (OutSystems.Model.V1/OutSystems.Model/IESpace.cs). Ausencia no produto: 'confirmado pelo dono em 2026-09-17'. Regra derivada: superficie de API nao e prova de funcionalidade.
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\ws1-diferencas.md:55-59; C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:502; C:\Users\andre\SSAM-Hybrid-ODC\docs\PLANO-COBERTURA.md:161

### Assets ODC sem modelo low-code (Cordova, WidgetLibrary, ExternalLibrary, ExtensionLibrary, ExternalConnection, AIModelConnection)

`inalcancavel`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** Trocar a lista pela medicao. (a) 'Cordova' nao e um tipo de asset -- os dois plugins Cordova que falharam sao assetType MobileLibrary, e outro MobileLibrary (Device Diagnostic) abriu em 7s, logo o tipo nao explica nada. (b) WidgetLibrary e Agent falharam mesmo, mas nao por 'nao terem modelo low-code': para o Agent a plataforma tem regra propria e literal -- resx:704 'AgentDefinitionInvalidApp|Error|Couldn't open file|Files created with Agent Editor can only be opened in ODC Portal.' (c) Um LowCodeLibrary (OutSystems UI) tambem falhou, o que derruba de vez 'sem modelo low-code' como causa. (d) ExternalLibrary, ExtensionLibrary, ExternalConnection e AIModelConnection nunca foram tentados na corrida medida -- para esses a afirmacao e suposicao a priori do script, nao medicao. O que esta medido e util: ha assets que nao abrem, o open fica 3m43s pendurado antes de desistir, e o caminho e a API publica.
> 
> **Como se soube:** A medicao existe e esta em disco -- C:\Users\andre\SSAM-Hybrid-ODC\lab\pull-corpus.log -- e desmente a lista. Falharam a abrir: '15:31:28 ABRE Firebase Cloud Messaging Plugin [MobileLibrary r6] ... 15:35:11 FALHA', '15:35:26 ABRE InAppBrowser Plugin [MobileLibrary r16] ... 15:39:09 FALHA', '15:39:09 ABRE MobileUI [WidgetLibrary r8] ... 15:42:52 FALHA', '15:43:00 ABRE OutSystems UI [LowCodeLibrary r19] ... 15:46:43 FALHA', '15:47:30 ABRE template_Agent [Agent r11] ... 15:51:14 FALHA'. Abriram bem, no mesmo tipo: '15:31:20 ABRE Device Diagnostic [MobileLibrary r1] ... 15:31:27 OK DeviceDiagnostic (119 KB)'. Nenhum ExternalLibrary, ExtensionLibrary, ExternalConnection ou AIModelConnection foi sequer tentado: C:\Users\andre\SSAM-Hybrid-ODC\lab\pull-corpus.ps1:42 filtra `... -and $comModelo -contains $_.assetType`, e :30 `$comModelo = @('WebApplication','MobileApplication','LowCodeLibrary','MobileLibrary','WidgetLibrary','Agent')` -- ou seja o proprio script conta WidgetLibrary e Agent como tipos COM modelo, ao contrario do cabecalho do item. 'Cordova' nao e tipo de asset nenhum: nao esta na lista da API (asset-repository-api-v1.json:156) e so aparece numa descricao de asset (snapshots\assets-clienttenant.outsystems.dev.json:1687 'This Plugin is compatible with both Cordova and Capacitor'). Confirmam-se: os 206 assets (o snapshot tem `count: 206` e 206 entradas) e os 3m43s (o log da 3m43s exactos em quatro falhas seguidas). Confirma-se o caminho alternativo: asset-repository-api-v1.json:135 `"operationId": "AssetRepository_ListAssets"` e :1285 'Returns the source code for a specific asset revision\n\nAPI Client needs the **Asset management > Open** permissions.'
> 
> **Job que o ancoraria:** Nao e provavel por job do Anvil -- e medicao de bridge contra tenant (e o clienttenant e so-leitura e caro). Ancora honesta: substituir o 'Visto em: tenants.json:30' por 'lab\pull-corpus.log' (a medicao) mais 'lab\pull-corpus.ps1:27-30' (a suposicao), e marcar os quatro tipos nunca tentados como nao-verificavel-sem-correr.


Estes assets NAO abrem no Studio pela bridge: a tentativa nao falha depressa, fica ~3m43s por asset antes de desistir. Para censo/leitura o caminho e a API publica (AssetRepository_ListAssets + AssetRepository_GetAssetRevisionSourceCode), que exige um API client com a permissao 'Asset management > Open'.

Prova:

```
Medido no tenant clienttenant (206 assets): download pela bridge ~10s por modulo e 3m43s por asset SEM modelo low-code.
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\tenants.json:30 (nota do tenant clienttenant.outsystems.dev, registada em 2026-09-17)

### IImage do modulo (recurso de imagem)

`limite-do-kernel`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> A primeira passagem tinha dito `confirmado`; caiu na reconferencia.
> 
> **Correccao:** Trocar "o unico construtor exige byte[] binary" por "as DUAS sobrecargas de CreateImage exigem byte[] binary" (a segunda acrescenta ImageFormat/width/height, todos convertiveis -- so o binary nao e). A conclusao do item nao muda: continua inexprimivel nas duas faixas. Vale tambem notar que este item esta TRIPLICADO na pagina (NAO-DA.md:278, :729 e :993), com o mesmo defeito de frase nos tres.
> 
> **Como se soube:** O nucleo do item aguenta, mas a frase "o UNICO construtor exige byte[] binary" e falsa a letra e a propria fonte do item ja o desmentia. Nas DUAS faixas ha DUAS sobrecargas: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.V1\OutSystems.Model\IESpace.cs:483 `IImage CreateImage(byte[] binary, string originalPath, string name = null, IKey key = null);` E :485 `IImage CreateImage(byte[] binary, string originalPath, ImageFormat format, int width, int height, string name = null, IKey key = null);` -- identicas em decompiled\o11\...\IESpace.cs:241 e :243. A fonte citada escreve-o com a ressalva que a pagina deixou cair: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:518-519 "o unico construtor e `IImage CreateImage(byte[] binary, ...)` (e a sobrecarga com `ImageFormat/width/height`)". Tudo o resto confere: Verbs.cs:956-994 -- os ramos sao string, bool, int, long, decimal, `t.IsEnum`, ITypeSignature, `t.IsInterface` (Resolve) e ExpressionDefinition, o fim e `System.Convert.ChangeType(s, t)` (:992) e o nao-JsonValue cai em `throw ... cannot convert {value.GetType().Name} to {t.Name}` (:994); grep por `byte[]`/`base64` em src/Anvil.Core nao devolve NADA em Verbs.cs, logo nao ha ramo byte[] hoje. Sem arg, Verbs.cs:328 `values[k] = p.ParameterType.IsValueType ? Activator.CreateInstance(p.ParameterType) : null` poe null (byte[] nao e value type) e a plataforma atira o "Image binary cannot be null" citado. Fonte em cobertura-t-relatorio.md:512-533 confere linha a linha, incluindo :527-528 ("o `IImage` que aparece em tests/jobs/gallery-native-reactive.json e outro tipo: o widget ServiceStudio.Plugin.NRWidgets.IImage"); o aviso bate com ScreenVocabulary.json:1848-1849 (`"mobile:IImage": { "type": "ServiceStudio.Plugin.NRWidgets.IImage"`, no ficheiro CANONICO src\Anvil.Core\Kernel\, nao so na copia de .local) e com tests\jobs\gallery-native-reactive.json:88.


Nao e exprimivel pela linguagem de jobs em NENHUMA das duas faixas: o unico construtor exige byte[] binary e o Convert do kernel nao converte JsonValue para byte[]. Nao e diferenca de plataforma -- o catalogo do SS11 tem a mesma assinatura. Nao confundir com o widget ServiceStudio.Plugin.NRWidgets.IImage dentro de uma tela, que funciona.

Prova:

```
op #0 (create WfProbeImage): InvalidOperationException: Image binary cannot be null: Object not set. Assinatura: IImage CreateImage(byte[] binary, string originalPath, string name = null, IKey key = null). Convert so sabe string, bool, int, long, decimal, enum, ITypeSignature, interface do modelo e ExpressionDefinition.
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:512-533

### IUserException.Description no ODC

`diferenca-entre-faixas`

No ODC a excecao de usuario nao tem Description: so CreatedBy, LastModifiedBy, LastModifiedDate e Name sao escritaveis. Um job do O11 que escreve Description na excecao nao se copia letra a letra.

Prova:

```
Registado no _why do op que cria a excecao: 'no ODC a IUserException nao tem Description -- so CreatedBy, LastModifiedBy, LastModifiedDate e Name sao escritaveis'
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc\service-action.json:106

### Client entity com Id AutoNumber

`recusa-da-plataforma`

O Verify recusa IsAutoNumber Yes numa client entity: o Id e Long Integer SEM AutoNumber, porque o identificador e do dispositivo. Vale nas duas faixas e esta provado na faixa ODC.

Prova:

```
Job ODC grava IsAutoNumber = No com o _why 'o Verify recusa AutoNumber Yes em client entity; o Id e do dispositivo'; corrida limpa: client-storage :: ok=True isValid=True messages=55 accepted=True
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc\client-storage.json:10; C:\Users\andre\Anvil\AGENTS.md:204; corrida em lab\cobertura-t-relatorio.md:118-121

### DeployAction = DeployToTargetDirectory num IResource

`armadilha`

> **CONFIRMADO** (passagem adversarial, 2026-09-17)
> 
> **Como se soube:** Verificado nos quatro ficheiros decompilados, um a um. OutSystems.Model.Enumerations.DeployAction = { Ignore, CopyToApplicationDir } nas DUAS faixas (C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.V1\OutSystems.Model.Enumerations\DeployAction.cs e o gemeo em ...\o11\...). OutSystems.Model.Extensions.DeployAction = { Ignore, CopyToBinariesDirectory, CopyToApplicationDirectory, CopyToImagesDirectory } nas DUAS. O 'so o DisplayName engana' e literal no ficheiro do ODC: `[EnumValue(DisplayName = "Deploy to Target Directory")] CopyToApplicationDir` (e `[EnumValue(DisplayName = "Do Nothing")] Ignore`). A mensagem da Prova tambem e real e localizavel: o formato `op #{origin}: {target}.{property} value '{value}' invalid; allowed: {...}; see anvil api --name {...}` esta em C:\Users\andre\Anvil\src\Anvil.Core\Kernel\DataPreflight.cs:49 -- casa palavra a palavra com o texto colado.
> 
> **Job que o ancoraria:** Nenhum job cobre (o item e uma nao-diferenca; o valor dele e evitar a repeticao). Ancora barata: tests/jobs-odc/resource-script-lifecycle.json ja mexe no IResource -- acrescentar-lhe um `set DeployAction CopyToApplicationDir` com `_why` a dizer que 'Deploy to Target Directory' e so o DisplayName deste valor. Para o erro, um tests/jobs-odc-negative/deploy-action-display-name.json com expectError ["DeployAction", "allowed: Ignore, CopyToApplicationDir"] fixa a mensagem do DataPreflight.


FALSA diferenca de plataforma, ja investigada e fechada para ninguem repetir: as duas faixas tem dois enums DeployAction distintos e IGUAIS entre si. So o DisplayName engana -- CopyToApplicationDir mostra-se como 'Deploy to Target Directory'.

Prova:

```
InvalidOperationException: op #2: $r.DeployAction value 'DeployToTargetDirectory' invalid; allowed: Ignore, CopyToApplicationDir; see anvil api --name DeployAction. OutSystems.Model.Enumerations.DeployAction = Ignore, CopyToApplicationDir nas duas; OutSystems.Model.Extensions.DeployAction = Ignore, CopyToBinariesDirectory, CopyToApplicationDirectory, CopyToImagesDirectory nas duas.
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:433-446

### move entre pais diferentes (before/after com irmao de outro pai)

`armadilha`

O move so REORDENA dentro do mesmo pai. Sem a recusa do kernel, a plataforma cai numa assercao interna sem informacao nenhuma, nas DUAS faixas. Para mudar de pai: criar no destino e apagar o antigo.

Prova:

```
Sem a recusa a plataforma cai na mesma assercao interna ('Condition is false') nas duas faixas. A recusa ensinada nomeia os dois caminhos: 'move before: IContainer:WfBoxB is not a sibling of IContainer:WfBoxA ... move only REORDERS inside the same parent ... create the object at the new parent and delete the old one'.
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc-negative\move-foreign-sibling.json:2 (description) e :5-12 (expectError)

### IESpace.DefaultScreen do ODC ao apagar a primeira tela criada headless

`armadilha`

No ODC o ESpace guarda DefaultScreen e a primeira tela criada headless fica com esse papel. O delete dessa tela e recusado por um consumidor que aparece com CAMINHO VAZIO (o ESpace nao tem caminho), invisivel para quem le so a mensagem. Tem de se apontar DefaultScreen para outra tela antes.

Prova:

```
delete: refused, IMobileScreen 'WfCovTaskDetail' is used by 3 consumer(s) -- dois OnClick com caminho e o terceiro com caminho vazio (o ESpace). Correcao provada: set @espace DefaultScreen = IMobileScreen:WfCovTasks antes do delete.
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc-negative\delete-screen-in-use.json:2 (description e expectError); caminho limpo em C:\Users\andre\Anvil\tests\jobs-odc\delete-screen.json:7 e :45

### ITransactionsManager do ODC (formas assincrona, oculta e descartavel)

`limite-do-kernel`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** So o TIPO esta errado. A pagina define `limite-do-kernel` como 'limitacao nossa, do Anvil ou do SSAM, e nao da plataforma' (NAO-DA.md:35) -- estes tres NotImplementedException sao da plataforma, nao nossos. Deve ser `recusa-da-plataforma` (ou `diferenca-entre-faixas`, como no item gemeo 'Transacao (ITransactionsManager)'). Acrescentar tambem a precisao que o proprio literal da: as formas nao 'nao existem', sao 'Only implemented by the Model Versioning strategy', estrategia que nao vem instalada. E este item e o 'Transacao (ITransactionsManager)' sao o mesmo facto duas vezes.
> 
> **Como se soube:** O conteudo confere, literal a literal, em C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\OutSystems.Model.API.V1.Undo\ESpaceTransactionsManager.cs: :283-285 forma assincrona de ExecuteTransaction, :288-290 e :293-295 ExecuteHiddenTransaction (sincrona e assincrona), :298-300 e :303-305 ExecuteDiscardableTransaction -- todas `throw new NotImplementedException("Only implemented by the Model Versioning strategy");`; :97 `IsEnabled = !ESpaceInstances.IsUnregisteredESpace(eSpace);` e :103-106 `if (ESpaceInstances.IsUnregisteredESpace(eSpace)) { return func(arg1: false, null); }` (corre sem transacao nenhuma); :224/:242/:260 delegam Undo/Redo ao `UndoManager` do Studio. Contagem citada confere: odc\OutSystems.Model.V1 tem 1254 ficheiros. Nao encontrei outra implementacao de ITransactionsManager no dump do ODC -- `ESpaceTransactionsManager` e a unica (`internal class ESpaceTransactionsManager : ITransactionsManager, IDisposable`), logo a 'Model Versioning strategy' nao vem na instalacao.
> 
> **Job que o ancoraria:** Nao e provavel por job -- o kernel nunca chama as formas oculta/descartavel/assincrona. Esboco de teste em vez de job: Anvil.Tests.Odc, um facto tipo 'TransactionsManagerHiddenFormThrows' que apanhe `espace.TransactionsManager.ExecuteHiddenTransaction(...)` e assevere NotImplementedException com a mensagem 'Only implemented by the Model Versioning strategy'; ficaria vermelho no dia em que a instalacao passar a trazer a outra estrategia.


Tres avisos reais lidos na API decompilada: as formas assincrona, oculta e descartavel lancam NotImplementedException nessa estrategia; num eSpace NAO REGISTRADO a transacao roda sem transacao nenhuma; e o rollback e o UndoManager do Studio. PROVA POR LEITURA DE CODIGO DECOMPILADO, nao por execucao.

Prova:

```
Levantamento de 2026-09-17 sobre C:\Users\andre\ODC3\decompiled\odc (API publica com 1254 arquivos): ITransactionsManager.ExecuteTransaction com Undo/Redo/CanUndo e transactionGroupId; formas assincrona/oculta/descartavel -> NotImplementedException; eSpace nao registrado -> roda sem transacao. No O11 ITransactionsManager nao existe na API.
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\api-nativa-o11-odc.md:166-171

### Disparar o Mentor do ODC Studio de fora da interface grafica

`inalcancavel`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> A primeira passagem tinha dito `confirmado`; caiu na reconferencia.
> 
> **Correccao:** A conclusao pratica fica de pe (nao ha caminho suportado para acionar o Mentor de fora da GUI), mas ha tres consertos. Trocar o `Visto em:` de lab\mentor-odc.md (apontamento) para codigo: C:\Users\andre\ODC3\decompiled\odc\ServiceStudio.Presenter\ServiceStudio.Presenter.Commands\CommandLineSwitch.cs (24 switches, nenhum de Mentor) mais ChatWithAgent\ChatWithAgentPaneProvider.cs:12 (o Mentor e IPaneProvider). Trocar 'nao ha ... cano nomeado' por 'o cano nomeado que existe (ProcessReuse) so transporta switches de linha de comando, e nenhum e de Mentor'. E marcar o resto do Prova como nao reconferido: 49 ferramentas, WebSocket JSON-RPC e MentorUse vivem em assemblies (OutSystems.AI.*, WebViewImplementation, ServerCommunications.API) que NAO estao em C:\Users\andre\ODC3\decompiled -- nao se verificam sem reabrir os binarios instalados. Corrigir tambem a citacao para mentor-odc.md:15-21.
> 
> **Como se soube:** A prova nova do agente anterior E real e confirmei-a ao byte: C:\Users\andre\ODC3\decompiled\odc\ServiceStudio.Presenter\ServiceStudio.Presenter.Commands\CommandLineSwitch.cs tem 29 linhas e 24 membros -- `Debug, OpenFromUrl, OpenModuleFromUrl, DownloadAndOpen, Auth, Support, Create, Hotfix, Mergeback, TryLibrary, Recover, SilentRecover, RecoverCrash, Diff, StructuralDiff, DumpDiff, DumpStructuralDiff, Merge, AutomaticMerge, StructuralMerge, Info, Log, RemoveChangeTracking, DebugUpgradeVerify` -- nenhum de Mentor/agente/chat, e ServiceStudio.Presenter.Commands\CommandLineProcessor.cs so declara handlers para estes (Auth:58, DumpDiff:386, Diff:686, Merge:741, Create:897, OpenModuleFromUrl:1065, Hotfix:1703, Info:1809, Recover:1906, Support:2115, TryLibrary:2182, etc). Reforcei-a: o Mentor e um painel de docking -- ServiceStudio.Presenter.ChatWithAgent\ChatWithAgentPaneProvider.cs:12 `public class ChatWithAgentPaneProvider(IAggregatorPresenter aggregator) : IPaneProvider`, com `CreateDockedPane`/`CreateUndockedPane` e `public const string ChatWithAgentId = "chat-with-agent";` (:17). MAS A AFIRMACAO E MAIS LARGA DO QUE A PROVA, em dois pontos. (1) 'nao ha ... cano nomeado': o ODC Studio TEM servidor de named pipe, no mesmo assembly -- ServiceStudio.Presenter\ServiceStudio.Presenter.ProcessReuse\CommandLineProcessor.cs:3 `using System.IO.Pipes;`, prs-sfoyjeuc.cs:28 `using NamedPipeServerStream namedPipeServerStream = new NamedPipeServerStream(prs_0023tsgwkdbo, ..., PipeTransmissionMode.Byte, PipeOptions.Asynchronous);` e :149 idem, RuntimeImplementation.cs:3294 idem. So se salva porque esse cano transporta payload de CommandLineSwitch (reuso de processo), e nenhum switch e de Mentor -- mas escrito assim le-se como 'o Studio nao tem cano nomeado', o que e falso. (2) O resto do Prova nao e reconferivel em lado nenhum dentro do escopo de leitura: C:\Users\andre\ODC3\decompiled\odc so tem SEIS pastas (OutSystems.Model, OutSystems.Model.Definition, OutSystems.Model.V1, ServiceStudio.BuiltInBehaviors, ServiceStudio.Presenter, ServiceStudio.ServerCommunications.Phoenix) -- OutSystems.AI.AgentAdapter.dll, OutSystems.AI.ClientTools.dll, ServiceStudio.WebViewImplementation.dll e ServiceStudio.ServerCommunications.API.dll NAO estao decompilados. Logo '49 ferramentas', 'WebSocket JSON-RPC 2.0 (converse/getAgentModes/stateChanged/chatUpdate)' e 'MentorUse por asset e portfolio' continuam a valer o que vale o levantamento sobre os binarios instalados, que ninguem reabriu (o dump so mostra o `using OutSystems.AI.AgentAdapter;` em ChatWithAgent\MockAgent.cs:6). Citacoes conferem: C:\Users\andre\SSAM-Hybrid-ODC\lab\mentor-odc.md:82-86 tem o texto e o literal 'nao ha evidencia' em :86; a tabela de pecas esta em :15-21 (nao :15-24; :23-24 ja sao os chunks de streaming).
> 
> **Job que o ancoraria:** Nao e provavel por job: nao ha tenant nem GUI numa corrida de suite, e nenhum verbo do kernel toca no Presenter. A ancora duravel e o ficheiro de codigo (CommandLineSwitch.cs + ChatWithAgentPaneProvider.cs), que ja e melhor prova do que o apontamento. Vermelho automatico so por sonda de inventario sobre o dump/instalacao, que falhe se aparecer um switch novo no enum ou um ponto de entrada de Mentor fora de IPaneProvider -- nao e um job de tests/jobs*.


Nao ha linha de comando, cano nomeado nem API documentada para acionar o Mentor: todos os pontos de entrada sao menu, barra ou atalho. Existem duas superficies reais (AppSettingsOverride.xml e o proprio cliente JSON-RPC com 49 ferramentas por descoberta), mas os nomes exatos da seccao desse arquivo estao entre strings criptografadas -- a propria fonte escreve 'nao ha evidencia' em vez de supor.

Prova:

```
Levantamento sobre C:\Program Files\OutSystems\ODC Studio\ODC Studio: transporte WebSocket JSON-RPC 2.0 (converse/getAgentModes/stateChanged/chatUpdate) em OutSystems.AI.AgentAdapter.dll; 49 ferramentas em OutSystems.AI.ClientTools.dll; permissao MentorUse por asset e portfolio (controle de acesso do tenant, nao licenca). Literal da seccao do AppSettingsOverride.xml: 'nao ha evidencia'.
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\mentor-odc.md:80-86 (e a tabela de pecas em :15-24)

### studio_open com nome de asset que tem espaco

`armadilha`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** Trocar o rider por: "Consertar exige recompilar a bridge e ANEXAR uma versao nova (bump de Version + AssemblyName, `odc attach`, ~2 s) - o Studio NAO precisa de fechar. O que nao se recupera e o estado em memoria da versao antiga (busy, 'merged in this session'), que nao atravessa versoes; por isso e que nao se faz no meio de uma entrega."
> 
> **Como se soube:** NUCLEO CONFIRMADO. C:\Users\andre\SSAM-Hybrid-ODC\studio\bridge\StartupHook.cs:878-880 (literal, hoje): `var parts = argument.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);` ... `var module = parts[0]; var localPath = parts.Length == 2 ? Path.GetFullPath(parts[1]) : null;`. Recusa literal em C:\Users\andre\SSAM-Hybrid-ODC\journal\operations.jsonl:707: `"command":"open" ... "outcome":"gate_refused" ... "note":"Local model not found: C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\OutSystems\\ClientUITheme"`. Contorno provado em operations.jsonl:708: `"command":"open","module":"Sinal ClientUITheme","module_key":"qclhM3yjX06Cr_HZbsHyZw","outcome":"ok"`. RIDER FALSO: "a bridge so recarrega quando o Studio fecha". C:\Users\andre\SSAM-Hybrid-ODC\studio\bridge\README.md:26-28: "A loaded DLL is never replaced: to ship a change, bump `Version` in StartupHook.cs and Program.cs and the `AssemblyName` in Bridge.csproj, then attach the new DLL. Each version keeps its own in-memory state". C:\Users\andre\SSAM-Hybrid-ODC\facade\lib.mjs:79-85 `attach(pid)` pega `newestBridgeDll()` e chama `client(target, ['attach', dll.path])` contra o pid VIVO; C:\Users\andre\SSAM-Hybrid-ODC\studio\bridge\client\Program.cs:22 `await new DiagnosticsClient(pid).ApplyStartupHookAsync(dll, ...)`. Prova material: studio\bridge\bin\Release\net8.0 tem ODC3.Bridge.v1..v28.dll todas de 2026-09-16 entre 02:11 e 16:53 - 26 versoes num dia, ou seja anexar-a-quente e o fluxo normal. Custo real: C:\Users\andre\SSAM-Hybrid-ODC\lab\int-integracao.md:12 "`.\odc attach` | `attached=true`, bridge v28, **2 s**". NOTA: este item e duplicata literal dos itens "Nome com espaco: studio_open corta no primeiro espaco" e "studio_open da bridge ODC" - o mesmo facto conta 3 vezes nos "100 factos".
> 
> **Job que o ancoraria:** Nao e provavel por job do Anvil (tests/jobs* corre o kernel de modelo, nao o parser de argumentos da bridge). O ancoradouro certo e um teste em C:\Users\andre\SSAM-Hybrid-ODC\facade\tests\ (ao lado de mcp.test.mjs): esboco `open-argument-split.test.mjs` - extrair o split de StartupHook.Open para um metodo puro `SplitOpenArgument(string)` e assertar SplitOpenArgument("Sinal ClientUITheme") == ("Sinal", "ClientUITheme") e SplitOpenArgument("qclhM3yjX06Cr_HZbsHyZw") == (key, null). Fica vermelho no dia em que a bridge passar a aceitar nomes com espaco.


A bridge corta o argumento no primeiro espaco: 'Sinal ClientUITheme' vira modulo 'Sinal' + caminho local 'ClientUITheme' e recusa. Contorno provado: abrir pela CHAVE do asset (sem espacos). Consertar exige recompilar a bridge, e a bridge so recarrega quando o Studio fecha -- nao fazer no meio de uma entrega. Nota relacionada: nome de asset != nome de modulo (o asset 'Sinal ClientUITheme' contem o modulo 'SinalClientUITheme').

Prova:

```
Local model not found: C:\ProgramData\... -- causa em studio\bridge\StartupHook.cs:878 (argument.Split(' ', 2)). Contorno medido: studio_open module: "qclhM3yjX06Cr_HZbsHyZw" abre "Sinal ClientUITheme".
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\docs\ENTREGA-AGORA.md:32-46


## Integracoes REST e SOAP (lane restsoap, 2026-10-06): o que as ops `rest`, `rest-expose` e `soap` nao fazem

### SOAP no ODC

`lacuna-declarada`

A op `soap` responde `SOAP_LANE_UNSUPPORTED` na faixa ODC, antes de qualquer op (regra `PreflightRules.IntegrationOps` e o
proprio handler). Um binario do ODC declara o consumo SOAP removido, enquanto o ODC Studio 1.7.25 ainda traz o plugin SOAP;
nenhuma rota foi provada. No catalogo: `integration.soap-odc` (indisponivel). Alternativa: uma fachada REST do servico (op `rest`)
ou uma biblioteca externa que o chame.

Visto em: src/Anvil.Core/Kernel/Verbs.Integration.cs (SoapOp); src/Anvil.Core/Kernel/IntegrationPreflight.cs; docs/GITSSAM-O-QUE-SE-APROVEITA.md:799-807

### Callbacks de REST (OnBefore/OnAfterRequest, OnRequest/OnResponse)

`lacuna-declarada`

Nenhuma das ops escreve callbacks. Os quatro criadores de callback do cliente consumido deixam o create generico ambiguo (a
primeira fabrica atribuivel venceria). Continua `integration.rest-callbacks` (indisponivel) nas duas faixas.

Visto em: platforms/odc/facade/catalog/fragments/C/integrations-without-route.json (integration.rest-callbacks)

### Fluxo de autenticacao de REST exposto (Basic/Custom)

`regra-do-ssam`

A op `rest-expose` recusa `authentication` diferente de `None` com `REST_EXPOSE_AUTH_FLOW_UNSUPPORTED`: Basic e Custom pedem o
fluxo OnAuthentication do servico, que nao tem criador em nenhum catalogo e nenhum job. Alternativa: conferir o chamador dentro do
metodo (entrada em header comparada com uma setting) ou escrever o fluxo no Studio.

Visto em: src/Anvil.Core/Kernel/RestExposeExpander.cs (Validate)

### Credencial de REST consumido no O11

`regra-do-ssam`

O Verify do O11 aceita `Username`/`Password` num IRestClient (o do ODC recusa, secao acima). O SSAM nunca escreve segredo literal
num modulo: a op `rest` recusa `auth` diferente de `None` ou chaves de credencial com `REST_CREDENTIALS_NOT_IN_MODEL` e
`ssamRule: true`. A correcao e uma entrada obrigatoria `Authorization` em header, com o valor vindo de uma setting na chamada.
Os verbos crus continuam podendo gravar o modo (`AuthenticationType`), como em `tests/jobs/rest-consume-post.json`.

Visto em: src/Anvil.Core/Kernel/RestExpander.cs (Validate); tests/Anvil.Tests/RestSpecTests.cs (CredentialsNeverGoInTheModel)

### Import OpenAPI do ODC pede o icone do host da API

`medido`

`CreateRestClientFromSwagger` pede `favicon.ico` ao host do `servers[0].url` (tres URLs) para decorar o cliente. O servico HTTP
que o kernel entrega ao plugin responde 404 localmente a esses pedidos (aviso na resposta) e recusa qualquer outro
(`OPENAPI_NETWORK_REFUSED`): nada sai da maquina.

Prova:

```
tests/Anvil.Tests.Odc/RestOpenApiImportTests.cs (OnlyTheChosenOperationsAreCreated): warnings "the importer asked for the API icon https://example.invalid/favicon.ico; answered 404 locally (no network)", idem https://www.invalid/favicon.ico e https://example.invalid/img/favicon.ico
```

Visto em: src/Anvil.Core.Odc/Adapters.ODC/OdcRestOpenApi.cs (RefusingRestService)

### Import OpenAPI e SOAP do O11 fora da entrega

`depende-do-studio`

O importador OpenAPI do O11 desreferencia o workspace (NullReferenceException headless, medido em 2026-09-04) e o importador de
WSDL so existe dentro do plugin do Studio. As duas importacoes rodam na bridge (`integration_import`), numa copia destacada do
modulo, dentro do `o11_deliver`. `ssam_job`/`o11_job` sem Studio respondem `INTEGRATION_IMPORT_NEEDS_STUDIO`. Ainda sem prova ao
vivo: `tests/jobs-live/soap-import-calculator.json`, `tests/jobs-live/o11-rest-openapi-import.json`.

Visto em: docs/mapa/2026-09-04-rest-investigacao.md:170; src/Anvil.Bridge/IntegrationImportHandler.cs

## Diferencas medidas entre O11 (SS11) e ODC: o que se comporta diferente nas duas faixas, com o numero ou a mensagem que o provou

### ISessionVariable / IESpace.CreateSessionVariable

`recusa-da-plataforma`

Session variable nao existe no produto ODC: a API publica oferece o tipo e a fabrica, mas a fabrica recusa na hora (no SS11 session variable e Traditional Web, e o ODC nao tem Traditional Web).

Prova:

```
"error": "op #0 (create WfCovSessionState): InvalidOperationException: Session Variable objects can't be children of App objects" -- repare no vocabulario: App, nao ESpace. Superficie da API: OutSystems.Model.V1/OutSystems.Model.Data/ISessionVariable.cs e IESpace.CreateSessionVariable(bool isReadOnly, string name, IKey key).
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc-negative\session-variable-not-in-odc.json (expectError); C:\Users\andre\Anvil\docs\tasks\cobertura-t-relatorio.md:427 e :498

### ISystemRole, IService, IExposedAction

`inalcancavel`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> A primeira passagem tinha dito `confirmado`; caiu na reconferencia.
> 
> **Correccao:** Manter a conclusao (nenhum job cria os tres) e trocar o motivo de IService/IExposedAction. Nao e 'abstratos (IsConcrete = false) sem classe concreta': ha classe concreta (CustomService implementa IService; CustomActionFlow implementa IExposedAction) e a flag IsConcrete nao e lida por ninguem em runtime. O que impede e o registo da ModelFactory: so fica construtor para a interface de modelo com UMA unica implementacao e que nao seja interface-base de outra ja registada (ModelFactory.cs:259-275); IService e base de IRestService/ISOAPService, por isso sai do registo e Create atira 'Couldn't find any concrete class implementing'. IExposedAction nem chega a fabrica -- nenhum pai publica Create para ele, e a recusa e do proprio kernel (Verbs.cs:311). ISystemRole fica como esta: e IsConcrete = true (ISystemRole.cs:6) e o motivo e mesmo a ausencia de Create em IESpace.
> 
> **Como se soube:** A METADE LITERAL AGUENTA: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.V1\OutSystems.Model.Logic.Integrations\IService.cs:7 traz mesmo `[ModelInterface(DisplayName = "Service", Icon = "WebService.ico", IsConcrete = false)]` e IExposedAction.cs:6 `[ModelInterface(DisplayName = "Action", Icon = "Action.ico", IsConcrete = false)]`; em odc\OutSystems.Model.V1\OutSystems.Model\IESpace.cs (694 linhas) nao ha CreateSystemRole nem CreateExposedAction -- :187 `IEnumerable<IRoleSignature> SystemRoles { get; }`, :583 `T CreateIntegration<T>(string name = null, IKey key = null) where T : IIntegration`, :671 `IAppRole CreateRole(string name = null, IKey key = null)`. A citacao confere: docs\tasks\cobertura-t-relatorio.md:500-501 (confirmei as tres mensagens no ficheiro). MAS O MECANISMO DADO E FALSO, EM DOIS PONTOS. (a) `IsConcrete` NAO TEM UM UNICO LEITOR em todo o dump ODC: existe so a definicao odc\OutSystems.Model.V1\OutSystems.Model\ModelExtensions.cs:355-357 `public static bool IsConcrete(this Type type) { return type.GetCustomAttribute<ModelInterfaceAttribute>()?.IsConcrete ?? false; }` e ZERO chamadas `.IsConcrete()` em qualquer .cs de C:\Users\andre\ODC3\decompiled\odc. A flag e metadado de geracao de codigo, nao causa da recusa. (b) 'sem classe concreta' e literalmente falso: odc\OutSystems.Model\ServiceStudio.Model\CustomService.cs:49 `public class CustomService : AbstractObject, ICustomService, ... OutSystems.Model.Logic.Integrations.IService, IIntegration, OutSystems.Model.IObject, ...` e odc\OutSystems.Model\ServiceStudio.Model\Flows.cs:73 `public class CustomActionFlow : AbstractCustomActionFlow, ... IActionSignature, IExposedAction, IObjectWithNodes`. A CAUSA REAL esta em odc\OutSystems.Model\OutSystems.Model.API\ModelFactory.cs:259-275: `if (!item.Value.IsSingle()) { constructorsByType.Remove(key); } key.GetInterfaces().Apply(delegate(Type baseInterface) { constructorsByType.Remove(baseInterface); });` -- toda interface-BASE de um tipo registado e removida do dicionario `constructors` (:23 `Dictionary<Type, ConstructorInfo> constructors`), e IService e base de IRestService (tests\jobs-odc\rest-expose.json:2: `ServiceStudio.Plugin.RESTService.RestService, criado por IESpace.CreateIntegration<T>`); logo Create(typeof(IService)) cai em ModelFactory.cs:153 `throw new ArgumentException("Couldn't find any concrete class implementing " + type.FullName);` (via ESpace.cs:22199-22201 `T IESpace.CreateIntegration<T>(...) { return ModelFactory.Create<T>(this, ...); }`). Nota sobre a evidencia do agente anterior: o template do kernel e src\Anvil.Core\Kernel\Verbs.cs:311 `throw new InvalidOperationException($"{Describe(parent)} cannot create {typeName} (no Create method in the API)")`, NAO :883, que e `unknown Model API type: {typeName} (not in OutSystems.Model.V1 nor in the Studio plugins)`.
> 
> **Job que o ancoraria:** Nao existe hoje (tests/jobs-odc-negative tem so 7 jobs: delete-block-event-in-use, delete-data-in-use, delete-logic-in-use, delete-screen-in-use, move-foreign-sibling, rename-name-clash, session-variable-not-in-odc). O molde e session-variable-not-in-odc.json, que confirmei ter UM `expectError` array por job -- logo sao TRES jobs irmaos, nao um. tests/jobs-odc-negative/system-role-not-creatable.json (create ISystemRole sobre @espace, expectError ['create <nome>','cannot create ISystemRole (no Create method in the API)']), .../exposed-action-not-creatable.json (idem com IExposedAction) e .../service-not-creatable.json (create IService, expectError ['Couldn't find any concrete class implementing OutSystems.Model.Logic.Integrations.IService']). Todos com `base` na fixture odc e `expectValid: true`, a correr em OdcJobTests.JobFailsWithTheTeachingMessageInTheOdcLane.


Tres tipos que aparecem na API do ODC e que nenhum job consegue criar: ISystemRole nao tem metodo Create no modulo, e IService/IExposedAction sao abstratos sem classe concreta (o REST exposto de verdade e IRestService, e o role de autor e IRole -> IAppRole).

Prova:

```
"IESpace 'InsuranceApp' cannot create ISystemRole (no Create method in the API)"; "ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.Logic.Integrations.IService"; "IESpace 'InsuranceApp' cannot create IExposedAction (no Create method in the API)"
```

Visto em: C:\Users\andre\Anvil\docs\tasks\cobertura-t-relatorio.md:500-501

### IAggregateAttribute vs IAggregatedAttribute

`diferenca-entre-faixas`

O tipo do atributo agregado mudou de nome entre as faixas: copiar letra a letra um job do SS11 falha na hora do create. Propriedades, DisplayName ('Aggregate Attribute') e classe concreta (ServiceStudio.Model.AggregateAttribute) sao identicos -- so a interface que o job escreve mudou.

Prova:

```
"error": "op #12 (create OpenCount): KeyNotFoundException: unknown Model API type: IAggregateAttribute (not in OutSystems.Model.V1 nor in the Studio plugins)". Catalogo SS11: OutSystems.Model.Logic.Aggregates.IAggregateAttribute; API ODC: OutSystems.Model.Logic.Aggregates.IAggregatedAttribute.
```

Visto em: C:\Users\andre\Anvil\docs\tasks\cobertura-t-relatorio.md:371-379; jobs C:\Users\andre\Anvil\tests\jobs-odc\aggregate-full.json:65 e structure-list-type.json:21

### Count de aggregate (tipo de dados)

`diferenca-entre-faixas`

No ODC o Count de um aggregate e Long Integer; no SS11 e Integer. Declarar Integer no ODC derruba o Verify.

Prova:

```
ExpressionUnexpectedExpresssionType ... 'Integer' data type expected instead of 'Long Integer'. Contorno provado: o job declara Long Integer e fecha com 0 mensagens novas.
```

Visto em: C:\Users\andre\Anvil\docs\tasks\2026-09-17-ws1-diferencas.md:28; C:\Users\andre\Anvil\tests\jobs-odc\aggregate-full.json:37 e structure-list-type.json:56

### Prefixo de expressao de Site Property / Setting

`diferenca-entre-faixas`

A mesma configuracao le-se 'Settings.<Nome>' no ODC e 'Site.<Nome>' no SS11 (e a variavel de cliente e 'Client.<Nome>'). Copiar a expressao do O11 quebra o modulo; escrever sem prefixo tambem.

Prova:

```
Sonda probe-site-prefix.json: ok=False {'ops': 17, 'objects': 59293, 'isValid': False, 'messages': 57} -- "Error ExpressionUnknownObject: Invalid Expression | Can't identify 'Site' element in expression."; sem prefixo: "Can't identify 'WfCovMaxRows' element in expression."; com Settings.WfCovMaxRows: 0 mensagens novas. Fonte: ServiceStudio.Model/ModelFrameworkConstants.cs, ScopeTreeFolders.GetSiteOrSettings(ESpace).
```

Visto em: C:\Users\andre\Anvil\docs\tasks\cobertura-t-relatorio.md:301-338; job tests\jobs-odc\security-settings.json

### Site Property = Setting (vocabulario do produto)

`armadilha`

> **CONFIRMADO** (passagem adversarial, 2026-09-17)
> 
> **Como se soube:** Nome da API: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.V1\OutSystems.Model.Data\ISiteProperty.cs:11-12 -- `[ModelInterface(DisplayName = "Site Property", Icon = "SiteProperty.ico", IsConcrete = true)]` / `public interface ISiteProperty : IObject, ...`. Nome do produto: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Model\ModelFrameworkConstants.cs:175 -- `public const string Setting = "Setting";` e :177 -- `public static string Application = "App";` (classe DisplayNames), e :1803-1810 `GetSiteOrSetting(ESpace)` devolve "Site Property" ou "Setting" conforme a marca. Marca real em ...\ServiceStudio.ModelFeatures\ModelFeatures.cs:126 -- `public const string SitePropertiesRefactoredToSettings = "ModelFeature_SitePropertiesRefactoredToSettings";`. O gabarito da mensagem confere: resx do ODC:534 -- `UnusedElement|Warning|Unused Element|{0} '{1}' is never used in {2} '{3}'.`
> 
> **Job que o ancoraria:** C:\Users\andre\Anvil\tests\jobs-odc\security-settings.json:2,:10,:15 e setting-lifecycle.json:2 -- criam ISiteProperty (o nome da API) e descrevem-se por Setting (o nome do produto). O par API/produto ja esta provado por esses jobs; o que nenhum job prova e o TEXTO do Verify ("Setting ... in App"), porque o job limpo nao deixa a Setting por usar. Esboco do que faltaria: `setting-unused-vocabulary.json` em tests/jobs-odc, uma Setting sem consumidor e expectedMessages [{id: UnusedElement, element: "<App> / <Setting>", why: "o texto diz Setting/App, o caminho diz SiteProperty/ESpace"}].


A API publica das duas faixas mantem o nome antigo (ISiteProperty, CreateSiteProperty, DisplayName 'Site Property'), mas o produto ODC chama Setting e App -- quem procurar na interface pelo nome que compila nao acha nada.

Prova:

```
Verify do ODC Studio instalado: "Warning UnusedElement: Unused Element | Setting 'WfCovAuditToken' is never used in App 'InsuranceApp'. Consider deleting it. @ InsuranceApp (ESpace) / WfCovAuditToken (SiteProperty)" -- o texto diz Setting/App, o caminho (que vem do modelo) diz SiteProperty/ESpace. Marca: ModelFeatures.SitePropertiesRefactoredToSettings.
```

Visto em: C:\Users\andre\Anvil\docs\tasks\cobertura-t-relatorio.md:275-299; C:\Users\andre\Anvil\docs\tasks\2026-09-17-ws1-diferencas.md:76

### Propriedade Shareable (so no ODC) e o seu par com Public

`diferenca-entre-faixas`

O ODC tem a propriedade Shareable, que o SS11 nao tem, e ela anda AGARRADA a Public nos dois sentidos: por Public a False o Shareable cai sozinho, e por Shareable a False o Public cai sozinho. Em IResource e IScript sao literalmente o mesmo bit.

Prova:

```
Quatro gets sobre a mesma IServiceAction mostram os quatro estados do par (service-action.json ops 167-173): set Public false -> Shareable cai; set Public true + set Shareable false -> Public volta a False; um unico set Shareable true repoe os dois. Em IResource: 'IResource.Public devolve e escreve IResource.Shareable', um so op liga os dois.
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc\service-action.json:167-173 e :2; resource-script-lifecycle.json:25-26

### InvalidPublic_ActionParameterNotPublic (severidade)

`diferenca-entre-faixas`

> **CONFIRMADO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** Pode deixar de ser `AFIRMACAO CONTESTADA` e passar a facto fechado: a severidade e Error nas DUAS faixas, so o vocabulario muda. E este item que deve ser o dono do assunto; os cabecalhos das linhas 152 e 1399 repetem a versao errada e devem apontar para ca.
> 
> **Como se soube:** A contradicao citada existe onde diz: C:\Users\andre\Anvil\docs\tasks\cobertura-a-relatorio.md:380-382 -- `sem isso o Verify da erro InvalidPublic_ActionParameterNotPublic ("The Action 'Contact_Import' is public but its parameter 'Contact' is defined as a record of type 'Contact' Entity that is not public")`, na faixa O11. E ha prova mais forte do que a contestacao: os dois catalogos instalados dizem literalmente `|Error|` -- o11 resx:157 `InvalidPublic_ActionParameterNotPublic|Error|Invalid Public Action|...` e odc resx:186 `InvalidPublic_ActionParameterNotPublic|Error|Invalid Shareable Action|...`. O decompilado o11 e 11.55.87.65162 (AssemblyInfo.cs:35), a versao corrente.
> 
> **Job que o ancoraria:** Nao existe; e o job que faltava e que fechava os tres cabecalhos de uma vez. Esboco: PAR de jobs gemeos em expectError/expectedMessages, um por faixa -- tests/jobs/public-action-nonpublic-record.json (IServerAction Public=true com IOutputParameter de tipo record de entidade nao publica) e tests/jobs-odc/shareable-action-nonshareable-record.json (o mesmo), ambos com expectedMessages [{id: InvalidPublic_ActionParameterNotPublic, element: "<Action> / Public", why: "..."}] e expectValid=false. Verde nos dois = severidade igual; se um dia uma faixa mudar, o job vermelho avisa. Nota de mecanica: MessageExpectations.Read (MessageExpectations.cs:97) so conhece ids de catalog/verify-messages-*.json, que hoje sao os do O11 -- a id esta la (verify-messages-11.55.69.json:816 e 11.55.87.json:765), logo os dois jobs passam a validacao de schema.


AFIRMACAO CONTESTADA, registada como tal: duas fontes dizem que no ODC a regra 'action partilhavel so expoe tipos partilhaveis' e erro 'ao contrario do O11', mas uma terceira mostra a MESMA mensagem como erro na faixa O11. O que esta provado e a mudanca de VOCABULARIO (id diz Public, texto diz shareable), nao a de severidade.

Prova:

```
ODC: "Error InvalidPublic_ActionParameterNotPublic: Invalid Shareable Action | The Action 'WfCov_Tasks_SearchSql' is shareable but its parameter 'Tasks' is defined as a record of type 'WfCovTask' Entity that is not shareable." (validation new:1, unexpected:1, accepted=False). O11, mesma id, tambem Error: "The Action 'Contact_Import' is public but its parameter 'Contact' is defined as a record of type 'Contact' Entity that is not public".
```

Visto em: ODC: cobertura-c-relatorio.md:187-200 e ws1-diferencas.md:77. Contradicao O11: C:\Users\andre\Anvil\docs\tasks\cobertura-a-relatorio.md:380-384

### Rename de action/no/saida e a expressao <No>.<Saida>

`diferenca-entre-faixas`

Renomeada a action, o ODC religa sozinho a expressao que le a saida do no; o O11 deixa o nome antigo e o modulo cai no Verify. Nas DUAS faixas o rename devolve expressionsRewritten: 0, porque quem conta como consumidor e o NO, nao a expressao -- quem confiar nesse numero entrega quebrado.

Prova:

```
Mesmo job, uma faixa cada. O11: "probe-rename-breaks-expression.json: ok=True {'ops': 39, 'objects': 11219, 'isValid': False, 'messages': 1}" + "Error ExpressionUnknownObject: Invalid Expression | Can't identify 'Slug_Make' element in expression." ODC: "probe-rename-breaks-expression-odc.json: ok=True {'ops': 39, 'objects': 59367, 'isValid': True, 'messages': 55}" + get IAssignment ... "Value": "WfP_Slug_Build.Slug".
```

Visto em: C:\Users\andre\Anvil\docs\tasks\cobertura-r-relatorio.md:308-332; tests\jobs-odc\rename-logic-propagation.json:98 e :106

### Propriedades de expressao gravaveis (set de Value, DefaultValue, SetVariable)

`diferenca-entre-faixas`

> **CONFIRMADO** (passagem adversarial, 2026-09-17)
> 
> **Como se soube:** C:\Users\andre\Anvil\src\Anvil.Core\Kernel\Verbs.cs:988-991, literal: "// ODC: writable expression properties (static record values, defaults) hold a parsed ExpressionDefinition, // where SS11 exposes a read-only IExpression whose Text is written." + `if (t.FullName == "OutSystems.Model.Expressions.ExpressionDefinition") return t.GetMethod("Parse", BindingFlags.Public | BindingFlags.Static, [typeof(string)])!.Invoke(null, [s]);` -- e a chamada e mesmo por reflexao, como o item diz. A segunda metade (o contrato de dados lembra o TEXTO) esta em Verbs.cs:950-954: `Remembered(...)` devolve `value?.ToString()` quando o convertido e `OutSystems.Model.Expressions.ExpressionDefinition`, com o comentario "because the proof reads the text back"; repetido em DataAssertions.cs:20-21.
> 
> **Job que o ancoraria:** Ja ancorado de facto: C:\Users\andre\Anvil\tests\jobs-odc\static-entity.json (a description diz "o valor de cada coluna escreve-se em $registo/<Atributo> prop Value e no ODC quem o guarda e um IRecordAttributeValue"). Se a linha de Verbs.cs:990-991 cair, o job rebenta com o InvalidCastException citado. Vale trocar o `Visto em:` de ws1-diferencas.md:25 (nota) para esse job + Verbs.cs:988-991 (codigo).


No ODC essas propriedades recebem uma AST (OutSystems.Model.Expressions.ExpressionDefinition), nao texto; no SS11 recebem string. O kernel passou a chamar ExpressionDefinition.Parse por reflexao, e o contrato de dados tem de lembrar o texto porque a prova le texto de volta.

Prova:

```
"spec op #18 (set Value on $WfProofStatus.Active/Label): InvalidCastException: Invalid cast from 'System.String' to 'OutSystems.Model.Expressions.ExpressionDefinition'"; e depois "Data property mismatch ... expected ExpressionDefinition+Text, actual \"Active\"".
```

Visto em: C:\Users\andre\Anvil\docs\tasks\2026-09-17-ws1-diferencas.md:25

### IContainer.CreateWidget / CreateSibling

`armadilha`

> **OBSOLETO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** E historia, nao limite presente. Texto certo: "No ODC o IObject tem CreateSibling<T>/CreateSibling(Type) que o O11 nao tem, e a descoberta reflexiva escolhia-o num IContainer (widget irmao, ordem inversa, fora do Content). CORRIGIDO em 3f6fba6 (2026-09-16): FindCreate ignora todo `CreateSibling*`, o create com pai IContainer volta a cair dentro do Content na ordem do job, e o pai explicito `$container/#IContent` deixou de ser preciso."
> 
> **Como se soube:** O kernel de HOJE ja ignora CreateSibling: C:\Users\andre\Anvil\src\Anvil.Core\Kernel\Verbs.cs:892-893 -- "// CreateSibling (ODC IObject) creates BESIDE the object, not inside it: never a way to create a child." e `AllMethods(parent).Where(m => m.Name.StartsWith("Create") && !m.Name.StartsWith("CreateSibling"))`. O conserto e anterior a esta pagina: `git log -S CreateSibling -- src/Anvil.Core/Kernel/Verbs.cs` devolve 3f6fba6 2026-09-16 "int: FindCreate ignora CreateSibling (ODC): create em IContainer volta a criar dentro do Content, na ordem do job" (NAO-DA.md e de 2026-09-17 e ainda esta untracked em git status). O contorno que a Prova descreve ja nao e usado: tests\jobs-odc\screen-basic.json:14-20 cria com `"parent": "$box"` cru, sem `$container/#IContent`. A propria fonte citada diz o mesmo: docs\tasks\2026-09-17-ws1-diferencas.md:67 coluna 'O que o kernel faz' -- "FindCreateCore ignora CreateSibling*; IContainer.CreateWidget do ODC delega ao Content e a ordem fica a do job".
> 
> **Job que o ancoraria:** Nao existe job que o prove -- e por isso que a regressao passaria despercebida outra vez. Job novo tests/jobs-odc/container-children-order.json: criar IContainer `$box`, depois tres filhos ($one, IContainer Inner, $two) com `"parent": "$box"`, e fechar com um contrato de dados/dump exigindo o caminho IContainer:Box/IContent/[one, Inner, two] NESSA ordem. Fica vermelho se o kernel voltar a escolher CreateSibling.


No ODC o IObject tem CreateSibling<T>/CreateSibling(Type) que o O11 nao tem, e a descoberta reflexiva de fabricas escolhia-o num IContainer: o widget nascia como IRMAO do container, em ordem inversa, fora do Content. O modulo ficava valido e o teste nao notava -- quem pegou foi o gate de equivalencia do merge nativo.

Prova:

```
Merge recusado duas vezes: "ok=false, outcome=uncertain, gate=equivalence", "Native object differs from the candidate: (Object Block) WF_PinNotFoundBanner [ChangedInLocal]", com native-equivalence.txt so com EffectiveMarginLeft (Auto_0/Auto_Gutter, 'Not Visible') em DropPinButton, Title e WarningIcon. Com pai explicito $container/#IContent: strictlyEqual = true a primeira.
```

Visto em: C:\Users\andre\Anvil\docs\tasks\2026-09-17-ws2-prova-viva.md:100-116; lab\ws2-prova-viva\01-block-alert e 02-block-alert; ws1-diferencas.md:67

### Legenda de botao/link/label (ITextWidget)

`diferenca-entre-faixas`

> **CONFIRMADO** (passagem adversarial, 2026-09-17)
> 
> **Como se soube:** C:\Users\andre\Anvil\src\Anvil.Core\Kernel\Verbs.cs:824-826 (comentario literal): "// ODC keeps a widget's default caption inside its Content (button, link, label); SS11 puts it beside it." seguido de `if (hits.Count < index) hits = hits.Concat(owner.Children.OfType<IObjectSignature>().Where(c => Implements(c, "IContent")).SelectMany(...))`. A mensagem da Prova nasce literalmente de Verbs.cs:828: `throw new KeyNotFoundException($"{Describe(owner)} has no child #{index} of type {spec} (has {hits.Count})")` -> "IButton 'GreetButton' has no child #1 of type ITextWidget (has 0)". Uso vivo nas duas faixas: tests\jobs-odc\screen-basic.json:21 e tests\jobs\block-events-reactive.json:25, ambos `"target": "$btn/#ITextWidget"`.
> 
> **Job que o ancoraria:** Existe mas so prova por expectValid: C:\Users\andre\Anvil\tests\jobs-odc\screen-basic.json:20-21. Para ancorar a DIFERENCA falta um job novo (ex. tests/jobs-odc/button-caption-in-content.json) que, depois do `set $btn/#ITextWidget Text`, faca `{"op":"usages","target":"$btn"}` ou um dump com contrato de dados exigindo o caminho IButton/IContent/ITextWidget -- e o par O11 exigindo IButton/ITextWidget direto. Hoje, se a plataforma voltasse a por a legenda ao lado, screen-basic.json continuaria verde.


No ODC a legenda nasce DENTRO de Content (IContent -> ITextWidget); no SS11 nasce ao lado. O seletor #ITipo teve de passar a procurar tambem dentro dos filhos IContent.

Prova:

```
"op #15 (set Text): KeyNotFoundException: IButton 'GreetButton' has no child #1 of type ITextWidget (has 0)"
```

Visto em: C:\Users\andre\Anvil\docs\tasks\2026-09-17-ws1-diferencas.md:26

### Filhos de uma IList

`diferenca-entre-faixas`

No ODC o filho de uma List nao pendura direto: vive num IContent intermedio, e e esse o caminho que sai em usages e nas mensagens de recusa. Quem escrever expectError partilhado entre as faixas nao pode casar o caminho.

Prova:

```
Caminho devolvido pelo usages no ODC: IList:RegionList/IContent:content/IExpression -- o job escreve na List e o kernel poe o IContent no meio.
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc\data-action.json:178

### ListAppend (assinatura ambigua)

`armadilha`

No ODC ListAppend existe como IClientActionSignature E como IServerActionSignature. A forma do job do SS11 ('IActionSignature:ListAppend') acerta na do cliente e o no de servidor recusa-a.

Prova:

```
find sobre a fixture: [('IClientActionSignature','ListAppend'), ('IServerActionSignature','ListAppend'), ('IExecuteClientActionNode','ListAppend'), ...]. Recusa: "op #30 (set Action): InvalidOperationException: Cannot set OutSystems.Model.Logic.Nodes.IExecuteServerActionNode.Action to 'ListAppend' (OutSystems.Model.IObject): the value is not valid in this context". Correcao: "IServerActionSignature:ListAppend".
```

Visto em: C:\Users\andre\Anvil\docs\tasks\cobertura-t-relatorio.md:399-418; jobs tests\jobs-odc\data-action.json:64 e structure-list-type.json:42

### Timer: agendamento (CronSchedule)

`diferenca-entre-faixas`

O SS11 tem so Schedule:String; o ODC tem CronSchedule mais o filho ScheduleConfiguration (ISchedule com ScheduleItems tipados). E o cron do ODC e de CINCO campos, nao seis: a forma Quartz e recusada.

Prova:

```
"error": "op #4 (set CronSchedule): InvalidOperationException: Invalid cron expression provided: 0 15 3 * * ?" at ServiceStudio.Model.Schedule.FromCronExpression(String cronExpression). Escrever CronSchedule preenche os dois lados: get mostra "CronSchedule": "15 3 * * *" E "Schedule": "03:15". Fonte: ServiceStudio.Model/Schedule.cs concatena Minute Hour DayOfMonth Month DayOfWeek.
```

Visto em: C:\Users\andre\Anvil\docs\tasks\cobertura-t-relatorio.md:381-397; tests\jobs-odc\timer-action.json:2 e timer-lifecycle.json:27

### UnusedUserAction em server action sem consumidor

`diferenca-entre-faixas`

No ODC uma server action sem consumidor recebe o aviso UnusedUserAction; no SS11 nao. Marcar a action Public evita o aviso sem precisar declara-lo.

Prova:

```
Verify do ODC: "UnusedUserAction ... is never used". Declaracao no job: why = "a action e criada para provar get/assign/if headless no ODC e nao tem consumidor; o ODC avisa sobre actions sem uso (o SS11 nao)". Uma IServiceAction a zero consumidores NAO leva o aviso, porque o consumidor dela e remoto por definicao (usages=0, 0 mensagens novas).
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc\logic-action.json:9; ws1-diferencas.md:28; service-action.json:162

### ServerActionInScreenAccessibleByEveryone (tolerancia do kernel)

`limite-do-kernel`

> **OBSOLETO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** O campo `tolerated` NAO sai sempre 0 na faixa ODC e o job ja NAO tem de declarar o aviso com why. Hoje o kernel tolera as duas formas: no ODC pelo id proprio ServerActionInScreenAccessibleByEveryone, no O11 pelo balde CustomObjectWarning + a frase `Consider removing the Anonymous Role from this Screen.`; nas duas exige-se a frase comum `You're exposing a Server Action for public access and without authentication.`, e o balde generico nunca e tolerado so pelo id. O item deve ir para a seccao de `ja corrigido`, como o IsDerived (linha 1385) e o EntityIndex (linha 1161).
> 
> **Como se soube:** O predicado de hoje tolera o id do ODC: C:\Users\andre\Anvil\src\Anvil.Core\Kernel\MessageExpectations.cs:79-83 -- `private static bool IsAnonymousAccessWarning(MessageInfo message) => message.Type == "Warning" && message.Detail.Contains(AnonymousAccessSentence, ...) && (message.Id == "ServerActionInScreenAccessibleByEveryone" || (message.Id == "CustomObjectWarning" && message.Detail.Contains("Consider removing the Anonymous Role from this Screen.", ...)))`. A linha 72, que o item cita como sendo o predicado exigente, e hoje um comentario que diz o contrario (`SS11: id CustomObjectWarning ...`). Data do conserto: commit 3e39e58, 2026-09-17, `int: a tolerancia do aviso de acesso anonimo vale nas duas plataformas (achado da frente C)` -- ou seja, o facto era verdade quando foi medido (cobertura-c-relatorio.md:204-237) e foi consertado no MESMO dia em que a pagina foi escrita.
> 
> **Job que o ancoraria:** Ja existe e nao e um job, e um teste: C:\Users\andre\Anvil\tests\Anvil.Tests\MessageToleranceTests.cs:23-30 `TheAnonymousAccessWarningIsToleratedOnBothPlatforms` (Assert.Equal(2, result.Tolerated.Count)) e :32-40 `TheGenericBucketIsNotToleratedByItsIdAlone`. E o segundo grupo da tabela (codigo em src/ com teste), nao o terceiro -- o `Visto em:` deve passar a apontar para MessageExpectations.cs:79-83 + MessageToleranceTests.cs.


A tolerancia do kernel para o aviso de seguranca 'server action publica chamada por tela' NUNCA dispara na faixa ODC: o predicado exige id CustomObjectWarning e uma frase que so o O11 usa. Na faixa ODC o campo tolerated sai sempre 0 e o job tem de declarar o aviso com why.

Prova:

```
Predicado: src/Anvil.Core/Kernel/MessageExpectations.cs:72 exige message.Id == "CustomObjectWarning" E Detail contendo "Consider removing the Anonymous Role from this Screen.". Catalogo do ODC Studio instalado (anvil-odc verify-catalog): {"Id": "ServerActionInScreenAccessibleByEveryone", "Severity": "Warning", "Detail": "You're exposing a Server Action for public access and without authentication. Consider restricting Screen accessibility to Authenticated Users."} e {"Id": "CustomObjectWarning", "Title": "{0}", "Detail": "{1}"} -- no ODC o CustomObjectWarning e so o gabarito generico.
```

Visto em: C:\Users\andre\Anvil\docs\tasks\cobertura-c-relatorio.md:204-237

### Registo de exemplo de entidade (SampleRecord vs IRecord)

`diferenca-entre-faixas`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** Trocar "Ponto de classificacao: Verbs.cs:977 (IsDerived)" por "Verbs.cs:1042-1050 (IsDerived), corrigido em 7642caa". O resto do item mantem-se, incluindo a nota de que ja esta corrigido.
> 
> **Como se soube:** O facto de fundo esta certo e no codigo: C:\Users\andre\Anvil\src\Anvil.Core\Kernel\Verbs.cs:1045-1050, literal: "// O valor do registo de exemplo da entidade: no SS11 chama-se SampleRecord, no ODC e um IRecord com // IRecordAttributeValue por atributo (...) sem esta linha nenhum atributo de entidade pode ser apagado no ODC sem force." + `return t.Contains("AttributeReference") || t.Contains("SampleRecord") || t.Contains("RecordAttributeValue") || path.Contains("/SampleRecord") || path.Contains("IAddSourceOperation:")`. MAS o ponteiro da Prova esta morto: a Prova diz "Ponto de classificacao: Verbs.cs:977 (IsDerived)" e a linha 977 de hoje e `if (typeof(OutSystems.Model.Types.ITypeSignature).IsAssignableFrom(t) ...)` dentro do Convert; IsDerived vive em Verbs.cs:1042-1050. O conserto e de 7642caa 2026-09-17 "int: no ODC o valor do registo de exemplo conta como uso derivado (achado da frente A)".
> 
> **Job que o ancoraria:** Ja existe e e do primeiro grupo: C:\Users\andre\Anvil\tests\jobs-odc\delete-attribute-no-consumers.json -- a description diz "apagar um atributo sem consumidor de autoria tem de passar SEM force". Basta o `Visto em:` apontar para esse job e para Verbs.cs:1042-1050 em vez de cobertura-a-relatorio.md:319-336 (nota), promovendo o item do terceiro grupo para o primeiro.


O mesmo objeto tem nomes diferentes: no O11 e IServerEntity:X/SampleRecord/SampleRecordAttributeValue, no ODC e IRecord/IRecordAttributeValue. Enquanto o kernel so conhecia o nome do O11, NENHUM atributo de entidade podia ser apagado na faixa ODC sem force.

Prova:

```
"op #46 (delete ): InvalidOperationException: delete: refused, IEntityAttribute 'Body' is used by 1 consumer(s): IServerEntity:WfProofNotice/IRecord/IRecordAttributeValue (list them with usages, fix or remove those usages, or pass \"force\": true to break them)" -- com os tres consumidores reais ja removidos. Ponto de classificacao: Verbs.cs:977 (IsDerived). Ja corrigido: tests\jobs-odc\delete-attribute-no-consumers.json e a regressao que prova que hoje passa SEM force.
```

Visto em: C:\Users\andre\Anvil\docs\tasks\cobertura-a-relatorio.md:319-336; lab\cobertura-a\BLOCKER.md

### Tipo devolvido para expressoes (usages e mensagens)

`armadilha`

Onde a faixa O11 devolve IExpression, o ODC devolve ITextBasedExpression (mesmo papel, mesmo text). Um expectError escrito para as duas faixas nao pode casar o nome do tipo. O mesmo vale para o registo de static entity: IRecord no O11, IStaticEntityRecord no ODC.

Prova:

```
cobertura-a-relatorio.md:338-342 ('Onde a faixa O11 devolve IExpression ... o ODC devolve ITextBasedExpression'); tests\jobs-odc\static-entity.json:28 e :60 ('o type do create e IRecord nas duas faixas, mas o objeto que volta no dump e IRecord na O11 e IStaticEntityRecord no ODC'; 'cada valor guardado num ITextBasedExpression (na O11 o mesmo lugar aparece como IExpression)').
```

Visto em: C:\Users\andre\Anvil\docs\tasks\cobertura-a-relatorio.md:338-342; tests\jobs-odc\static-entity.json:28,60

### IStaticEntityRecord e o verbo rename

`recusa-da-plataforma`

No ODC o registo de static entity nao publica Name, por isso o verbo rename recusa; renomear exige escrever a propriedade Identifier, que chama SetName -- e o SetName sufixa colisoes em SILENCIO, ao contrario do rename, que as recusa.

Prova:

```
Recusa do verbo: "IStaticEntityRecord UnderReview has no Name". O setter de Identifier chama SetName, o mesmo que a grelha do Studio chama, e cai em AbstractObject.NameClash (sufixo silencioso). Comparar com a recusa do rename, identica nas duas faixas: "op #2 (rename Title): InvalidOperationException: rename: 'Title' clashes with an existing name in that scope (the Studio would use 'Title2'); pick another name".
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc\static-entity-lifecycle.json:26; cobertura-r-relatorio.md:262-270; tests\jobs-odc-negative\rename-name-clash.json

### IUserException.Description

`diferenca-entre-faixas`

No ODC uma excecao de utilizador nao tem Description gravavel: as unicas propriedades de escrita sao CreatedBy, LastModifiedBy, LastModifiedDate e Name. O nome e tudo o que ela leva.

Prova:

```
_why do job: 'no ODC um IUserException nao tem Description gravavel (as gravaveis sao CreatedBy, LastModifiedBy, LastModifiedDate e Name), por isso o nome e tudo o que ele leva' -- registado nos dois jobs que criam excecoes na faixa.
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc\exception-lifecycle.json:56 e service-action.json:106

### ESpace.DefaultScreen e o delete de tela

`armadilha`

No ODC o ESpace guarda DefaultScreen, e a primeira tela criada headless fica com esse papel sozinha. O delete dessa tela e recusado por um consumidor cujo CAMINHO E VAZIO (o ESpace nao tem caminho), o que so o usages explica.

Prova:

```
expectError provado: "delete: refused", "IMobileScreen 'WfCovTaskDetail' is used by 3 consumer(s)", ... "list them with usages, fix or remove those usages, or pass \"force\": true to break them" -- dos tres consumidores, dois sao OnClick e o terceiro sai com caminho vazio. Contorno provado: set @espace DefaultScreen para outra tela antes do delete.
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc-negative\delete-screen-in-use.json; tests\jobs-odc\delete-screen.json:45

### FK e tipo Record gerados pela plataforma ODC

`armadilha`

No ODC cada FK nasce com o seu proprio indice (AutoIndex_<Attr>) que nenhum job escreveu, e cada entidade traz um tipo Record anonimo que aponta de volta para ela -- e esse Record sobrevive ao delete da entidade como lixo silencioso que o Verify nao assinala.

Prova:

```
usages do atributo FK: real=2, e so um e do autor -- IX_WfCovTask_ProjectDone (declarado no job) e AutoIndex_ProjectId (que nenhum job escreveu). usages da entidade antes: real=1, e IAnonymousStructure:WfCovProject Record/IAttribute:WfCovProject. Depois do delete: real=0 e nenhuma mensagem do Verify o lembra.
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc\delete-entity-whole.json:9, :13 e :26

### IImage de modulo (create com byte[])

`limite-do-kernel`

Imagem de modulo nao e exprimivel pela linguagem de jobs em NENHUMA das duas faixas: o unico construtor pede byte[] e o Convert do kernel nao sabe converter JsonValue para byte[]. Explicitamente NAO e diferenca de plataforma -- a assinatura e identica nos dois catalogos.

Prova:

```
"error": "op #0 (create WfProbeImage): InvalidOperationException: Image binary cannot be null: Object not set". Assinatura nas duas faixas: CreateImage(byte[] binary, string originalPath, string name = null, IKey key = null). Convert (Verbs.cs) so sabe string, bool, int, long, decimal, enum, ITypeSignature, interface do modelo e ExpressionDefinition.
```

Visto em: C:\Users\andre\Anvil\docs\tasks\cobertura-t-relatorio.md:512-528

### IResource.ResourceContent (bytes do recurso)

`limite-do-kernel`

Os bytes de um recurso nao entram por job em NENHUMA das duas faixas: na Model API V1 o membro e so de leitura e o descriptor nasce isReadOnly. Entram pelo Studio (Import Resource).

Prova:

```
Recusa do verbo: "IResource X has no writable property or setter ResourceContent. Writable: CreatedBy, DeployAction, Description, Folder, LastModifiedBy, LastModifiedDate, Name, Public, Shareable, TargetDirectory". Fonte nas DUAS faixas: byte[] ResourceContent { get; }, e Resource.ResourceContentProperty e um UnderlyingModelProperty com setter null (BinaryPropertyDescriptor nasce isReadOnly).
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc\resource-script-lifecycle.json:26

### CSS do tema (set de StyleSheet)

`armadilha`

CORRIGE UMA CONCLUSAO ANTIGA: a separacao do CSS do tema NAO e diferenca entre O11 e ODC -- depende de o tema ter CSS do Theme Editor (a fixture do ODC tem, a do O11 nao). O que vale nas duas faixas e que o StyleSheet e DERIVADO: ler da gerada+autor, escrever grava so a metade do autor, e a leitura seguinte nao mostra o que se escreveu.

Prova:

```
Medido na fixture do tenant pessoal (sonda do INT, 2026-09-17): antes StyleSheet 45320 chars = GeneratedStyleSheet 884 + CRLF + UserStyleSheet 44434; set StyleSheet "<53 chars>" -> {"set":"StyleSheet","via":"property"} (sucesso, sem nota); depois UserStyleSheet 53 chars (os 44 434 caracteres de CSS do autor foram substituidos) e StyleSheet 45320 chars INALTERADA.
```

Visto em: C:\Users\andre\Anvil\docs\tasks\2026-09-17-ws1-diferencas.md:34 e :36-61; tests\jobs-odc\theme-css-halves.json

### Nomes de interface ambiguos entre namespaces do ODC

`armadilha`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** Trocar `IStaticEntity/IEntity/IStructure tambem em Extensions e ExternalLibraries` por: IEntity/IStaticEntity/IStructure tambem em OutSystems.Model.Extensions, e IStructure tambem em OutSystems.Model.ExternalLibraries. O resto do item fica como esta.
> 
> **Como se soube:** A substancia confirma-se. Namespaces reais em C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.V1: OutSystems.Model.Extensions tem IEntity.cs, IStaticEntity.cs e IStructure.cs a par de OutSystems.Model.Data (que tem os mesmos tres); OutSystems.Model.Processes.Nodes e OutSystems.Model.BusinessProcesses.Nodes tem ICommentNode.cs, IEndNode.cs e IStartNode.cs, os mesmos tres de OutSystems.Model.Logic.Nodes. O contorno esta onde diz: C:\Users\andre\Anvil\src\Anvil.Core\Kernel\Verbs.cs:888-891 -- `int Rank(Type t) => t.FullName == typeName ? 0 : ... : t.Namespace is "OutSystems.Model.Extensions" or "OutSystems.Model.ExternalLibraries" ? 3 : t.Namespace?.StartsWith("OutSystems.Model.Processes") == true || t.Namespace?.StartsWith("OutSystems.Model.BusinessProcesses") == true ? 3 : ...`, com o comentario :885-887 a nomear os mesmos tipos, e o GetBaseException em Verbs.cs:331 e :334. MAS: OutSystems.Model.ExternalLibraries tem so IStructure.cs -- nao tem IEntity nem IStaticEntity (a pasta inteira sao 21 ficheiros: IAction, IExternalLibrary, IExternalLibraryObject, IInputParameter, IListType, IOutputParameter, IParameter, IResource, IShareableExternalLibraryObject, IStructure, IStructureAttribute e os respectivos Descriptor).
> 
> **Job que o ancoraria:** Ja ha jobs que atravessam cada um dos nomes ambiguos e que ficariam vermelhos se o Rank regredisse: tests/jobs-odc/static-entity.json:7 (create IStaticEntity -- tem de cair em OutSystems.Model.Data e nao em Extensions), tests/jobs-odc/structure-list-type.json (create IStructure -- Data, nao Extensions nem ExternalLibraries) e tests/jobs-odc/aggregate-full.json:90 / block-events-nested.json:22 (create IEndNode -- Logic.Nodes, nao Processes/BusinessProcesses). Falta so o `Visto em:` cita-los em vez do relatorio; um job negativo nao acrescenta nada aqui porque o kernel resolve a ambiguidade sozinho.


No ODC o mesmo nome de interface vive em mais de um namespace (IStaticEntity/IEntity/IStructure tambem em Extensions e ExternalLibraries; IStartNode/IEndNode/ICommentNode tambem em Processes e BusinessProcesses), e a fabrica recusa com mensagens que nao dizem 'namespace errado'. A excecao vem aninhada em dois TargetInvocationException.

Prova:

```
"spec op #0 (create WfProofStatus on @espace): ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.Extensions.IStaticEntity"; "op #23 (create ): Nodes of type IEndNode are not allowed in IMobileScreen or eSpaces of type CrossDevice". Contorno no kernel: FindCreateCore.Rank despromove esses namespaces e Create passa ao candidato seguinte (usando GetBaseException()).
```

Visto em: C:\Users\andre\Anvil\docs\tasks\2026-09-17-ws1-diferencas.md:22

### Superficie de API != funcionalidade do produto (BPT)

`inalcancavel`

> **REFUTADO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** Trocar 'Processo (BPT) nao existe no produto ODC' por: 'Processo/BPT no ODC existe com outro nome e noutro sitio -- e o asset Workflow, feito no Workflow Editor do Portal; o ODC Studio recusa abrir esses ficheiros. Nao ha caminho conhecido para o criar a partir de um modulo de Studio, e isso continua por medir.' Este item e o #1 e o #3 dizem a mesma coisa tres vezes: valem um item so.
> 
> **Como se soube:** Mesma prova literal do item anterior: resx:271 `Files created with Workflow Editor can only be opened in ODC Portal.` + AggregatorPresenter.cs:2589 (`SegmentationKind.BusinessProcess`) + asset-repository-api-v1.json:1903 (`Workflow` entre os tipos criaveis pela API publica do ODC). A fonte citada no item existe e diz o que o item diz -- C:\Users\andre\Anvil\docs\tasks\2026-09-17-ws1-diferencas.md:82-86: 'A API do ODC tem `CreateBusinessProcess` e o namespace `OutSystems.Model.BusinessProcesses.Nodes`, mas o **produto nao tem a funcionalidade** (confirmado pelo dono em 2026-09-17)' -- mas essa fonte e uma confirmacao de memoria, nao uma medicao, e o produto instalado contradiz-a.
> 
> **Job que o ancoraria:** O mesmo esboco do item 1 (tests/jobs-odc-negative/business-process-create.json). O facto 'o produto tem workflows' nao e provavel por job do Anvil -- prova-se pelo literal do Studio e pelo contrato da API publica, ambos ja em disco.


Processo (BPT) nao existe no produto ODC, embora a API tenha IESpace.CreateBusinessProcess e o namespace OutSystems.Model.BusinessProcesses.Nodes. SEM MENSAGEM DE PLATAFORMA: a prova e a confirmacao do dono mais a superficie da API -- nenhum job foi escrito, logo nenhuma recusa foi colada.

Prova:

```
Superficie: OutSystems.Model.V1/OutSystems.Model/IESpace.cs (CreateBusinessProcess). Confirmacao do dono em 2026-09-17, registada em ws1-diferencas.md:82-86 e repetida em PLANO-COBERTURA.md:161 ('a API tem CreateBusinessProcess, o produto nao tem a funcionalidade'). E o mesmo padrao do ISessionVariable, esse sim com recusa viva colada.
```

Visto em: C:\Users\andre\Anvil\docs\tasks\2026-09-17-ws1-diferencas.md:82-86; cobertura-t-relatorio.md:502; SSAM-Hybrid-ODC\docs\PLANO-COBERTURA.md:161

### ModelFeature_WriteableSiteProperties (gravar uma Setting numa action)

`armadilha`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** Apagar este item e deixar so o de NAO-DA.md:236. Se ficar, a causa passa a: "a marca nasce Stable no registo do Studio (ServiceStudio.ModelFeatures\ModelFeatures.cs:1514) com checkEnvironmentCompatibility: true; headless o `serverModelFeaturesInfo` vem nulo (ModelFeatures.cs:772-789) e o gate SitePropertyScopeEntry.IsReadOnly (Variables.cs:37895-37904) deixa passar -- so o estado `Removed` vindo do ambiente gera a mensagem (ModelFeatures.cs:1060). `Undefined` e a copia da API V1 (V1\ModelFeatures.cs:1440), que nao e quem decide."
> 
> **Como se soube:** Primeiro: e o MESMO facto do item de NAO-DA.md:236 -- mesma sonda, mesmo relatorio, mesmo intervalo de linhas (:448-482); dois dos "100 factos" sao um so. Segundo: esta arquivado sob "## Diferencas medidas entre O11 (SS11) e ODC ... com o numero ou a mensagem que o provou" (NAO-DA.md:405) quando nao mede diferenca nenhuma e diz-se nao provado. Terceiro, e o que tem conserto tecnico: a "causa provavel" aponta a copia errada da marca. A marca que governa o gate e a do Studio, e nasce Stable: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.ModelFeatures\ModelFeatures.cs:1514 `WriteableSiteProperties = new ModelFeature("ModelFeature_WriteableSiteProperties", "Site Property Is Writeable", predatesContinuousDelivery: true, ModelFeatureStatus.Stable, isExcludedFromCompiler: false, checkEnvironmentCompatibility: true, ...)` -- e e essa (`ServiceStudio.ModelFeatures.ModelFeatures`) que Variables.cs:37901 consulta. `Undefined` e a copia da API V1: odc\OutSystems.Model.V1\OutSystems.Model.ModelFeatures\ModelFeatures.cs:1440.
> 
> **Job que o ancoraria:** O mesmo do item 236 -- nao ha job que o prove sem ambiente. Se se guardar um canario, guarde-se UM (tests/jobs-odc/setting-write-in-action.json), nao dois.


AFIRMACAO NAO PROVADA, registada como tal: a plataforma ODC TEM a mensagem de erro que proibe gravar uma Setting dentro de uma action, e tem o mecanismo que a liga a marca, mas ela NAO disparou headless. Nao esta provado que gravar uma Setting e erro no ODC.

Prova:

```
Catalogo do ODC Studio instalado: {"Id": "ModelFeature_WriteableSiteProperties_Removed", "Severity": "Error", "Detail": "Cannot change the value of a {0} within an action..."}. MAS a sonda que grava Settings.WfProbeLimit num IAssignNode passou limpa: "probe-setting-write.json: ok=True {'ops': 17, 'objects': 59293, 'isValid': True, 'messages': 55, 'applyMs': 17}" com validation new:0, unexpected:0, accepted=True. Causa provavel: as marcas nascem ModelFeatureStatus.Undefined com checkEnvironmentCompatibility:true e a corrida e headless, sem ambiente. Confirmar exige o Studio ligado ao tenant.
```

Visto em: C:\Users\andre\Anvil\docs\tasks\cobertura-t-relatorio.md:448-482

### Eventos de bloco (comportamento)

`diferenca-entre-faixas`

RESULTADO NEGATIVO UTIL: nao ha NENHUMA diferenca de comportamento entre O11 e ODC em eventos de bloco. Contrato, tipos compostos (lista e registo), obrigatoriedade, propagacao bloco-dentro-de-bloco e recusa do delete respondem igual. Nao vale gastar rodada a procurar diferenca aqui.

Prova:

```
Paridade completa medida: 5 jobs positivos + 1 negativo em cada faixa. IsMandatory sem handler e ERRO do Verify (EventHandlerRequiredAction) nas duas, cobrado por INSTANCIA -- duas instancias sem handler dao dois erros com caminhos diferentes (declarado em block-events-mandatory.json:6-7). Recusa do delete provada nas duas, com o handler vindo da autoria visual no ODC.
```

Visto em: C:\Users\andre\Anvil\docs\tasks\cobertura-e-relatorio.md:283-288; tests\jobs-odc\block-events-mandatory.json:6-7; tests\jobs-odc-negative\delete-block-event-in-use.json

### move e duplicate (reordenar e copiar)

`diferenca-entre-faixas`

RESULTADO NEGATIVO UTIL: nenhuma diferenca. A superficie extra de mover que o IObject do ODC tem (MoveToEnd, MoveBefore, MoveAfter, MoveAfterSibling, MoveBeforeSibling, MoveToNewAbsoluteIndex, MoveToNewRelativeIndex) NAO e usada e nao deve ser -- o kernel usa os da ISequence, que existem nas duas. Nao 'adapte' o verbo a API extra do ODC.

Prova:

```
Medido lado a lado (tests/jobs/refactor-move.json e tests/jobs-odc/refactor-move.json): a order devolvida por cada op e IDENTICA nas quatro direcoes, sobre atributos, widgets, parametros de entrada e variaveis de tela, mais o x/y de um no. duplicate idem (Body -> Body2, copia no fim do mesmo pai, sem consumidores). Recusa identica nas duas: 'move only REORDERS inside the same parent' -- sem ela a plataforma cai na mesma assercao interna 'Condition is false' nas DUAS faixas.
```

Visto em: C:\Users\andre\Anvil\docs\tasks\2026-09-17-ws1-diferencas.md:88-97; tests\jobs-odc-negative\move-foreign-sibling.json

### Diff e merge de tres vias (IModelServices)

`diferenca-entre-faixas`

O ODC publica comparacao de tres vias headless com arvore, detalhe por propriedade e MergeAction gravavel; o O11 so tem bool Merge(meu, outro, base) -- sem arvore, sem detalhe, sem controlo. E por isso que o kernel carrega o seu proprio MergeProbe, excluido do build ODC.

Prova:

```
Medido por OdcDiff.Compare sobre a fixture InsuranceApp (teste TheOdcApiDiffsTwoModelsHeadlessAndSeesTheChangeOfAJob): 59 419 comparacoes, 138 objetos so no candidato, 0 conflitos, com valor local e estrangeiro de cada propriedade que difere. Superficie ODC: IModelServices.Diff(local, foreign, base) -> IMatchTree com MatchType, DifferenceType, MergeAction gravavel por objeto E por propriedade, Dump() e Merge().
```

Visto em: C:\Users\andre\Anvil\docs\tasks\2026-09-17-api-nativa-o11-odc.md:16-33; src/Anvil.Core.Odc/Adapters.ODC/OdcDiff.cs

### Transacao (ITransactionsManager)

`diferenca-entre-faixas`

> **CONFIRMADO** (passagem adversarial, 2026-09-17)
> 
> **Como se soube:** Metade ODC: ESpaceTransactionsManager.cs:283-305 (assincrona/oculta/descartavel -> `throw new NotImplementedException("Only implemented by the Model Versioning strategy")`), :103 e :137 (eSpace nao registado -> `return func(arg1: false, null)`), :100-135 a sobrecarga com `Guid transactionGroupId`, :74-76 `CanUndo`/`CanRedo`, :84-86 eventos `TransactionCompleted`/`UndoCompleted`/`RedoCompleted`, :224/:260 `UndoManager.Undo/Redo` (o rollback e o UndoManager do Studio). Metade O11: zero ocorrencias de `ITransactionsManager` em C:\Users\andre\ODC3\decompiled\o11, e a unidade e mesmo o Command do framework com o literal citado -- o11\ServiceStudio.Framework\ServiceStudio.Commands\UnrecoverableException.cs:7-10 `public class UnrecoverableException : Exception { public UnrecoverableException(Exception innerException, IEnumerable<ESpace> eSpaces) : base("Unrecoverable Exception", innerException)` e Command.cs:1018 `throw new UnrecoverableException(originalException, enumerable);`. As QUATRO contagens do item batem certo ao ficheiro: odc\OutSystems.Model = 2073 .cs, odc\OutSystems.Model.V1 = 1254 ficheiros, o11\ServiceStudio.Framework = 1749 .cs, o11\OutSystems.Model.V1 = 435 .cs. Citacao confere (docs\tasks\2026-09-17-api-nativa-o11-odc.md:161-171).
> 
> **Job que o ancoraria:** Nao e provavel por job (nenhum verbo toca nestas formas). O mesmo teste sugerido no item gemeo serve para os dois; e as contagens de ficheiros, se se quiser guardar, pedem uma sonda de inventario, nao um job.


No O11 NAO existe ITransactionsManager na API: a unidade e o Command do framework. No ODC existe, com Undo/Redo e TransactionCompleted, mas com tres avisos reais -- as formas assincrona, oculta e descartavel lancam NotImplementedException, e num eSpace nao registado a transacao RODA SEM TRANSACAO. Evidencia de leitura de API decompilada, nao de mensagem colada.

Prova:

```
Levantamento de 2026-09-17 sobre C:\Users\andre\ODC3\decompiled (ODC: modelo com 2 073 arquivos, API publica com 1 254; O11: framework com 1 749, API publica com 435). ODC: ITransactionsManager.ExecuteTransaction com Undo, Redo, CanUndo, transactionGroupId e eventos TransactionCompleted; rollback e o UndoManager do Studio. O11: Command do framework, com UnrecoverableException quando o proprio rollback falha.
```

Visto em: C:\Users\andre\Anvil\docs\tasks\2026-09-17-api-nativa-o11-odc.md:161-171 e :1-11

### Consumidores (Referrers) e endereco textual

`diferenca-entre-faixas`

> **CONFIRMADO** (passagem adversarial, 2026-09-17)
> 
> **Como se soube:** Conferido no Studio decompilado, item a item. ODC publico: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.V1\OutSystems.Model\IModelObject.cs:28 `IEnumerable<IModelObject> Referrers { get; }`; C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.V1\OutSystems.Model.Factory\FactoryExtensions.cs:255 `public static string GetTargetPath(this IModelObject obj)` (:274-280 empilha `collectionDescriptor.Name` + identificador e junta com '\\') e :289 `public static IModelObject ResolveTargetPath(this IModelObject root, string path)` -- a assinatura (root, path) do item esta certa. O11: varri os 435 ficheiros .cs de C:\Users\andre\ODC3\decompiled\o11\OutSystems.Model.V1 com `Referrers|Referers|TargetPath` e deu ZERO; o IObjectSignature.cs dessa pasta tem ObjectKey, GlobalKey, Parent, Children, WasDeleted, IsValid, Digest, GetESpace, GetAllDescendantsOfType, Delete, GetInterface, GetValidationMessages -- e mais nada. O cast que o item descreve esta mesmo la: C:\Users\andre\Anvil\src\Anvil.Core\Kernel\Verbs.cs:1030 `var ao = target as ServiceStudio.Model.AbstractObject ?? throw ...` e :1032 `foreach (var r in ao.Referers)`. A tabela citada bate a letra: C:\Users\andre\Anvil\docs\tasks\2026-09-17-api-nativa-o11-odc.md:40 e :42.
> 
> **Job que o ancoraria:** Nao e provavel por job (e superficie de API, nao comportamento de modelo). O que o prenderia e um teste de superficie ao lado de SurfaceTests/FunctionCatalogTests: assertar que `typeof(OutSystems.Model.IModelObject).GetProperty("Referrers") != null` e que existe `FactoryExtensions.ResolveTargetPath` na faixa ODC, e que na faixa O11 `IObjectSignature` nao tem `Referrers` -- fica vermelho se a OutSystems mudar a superficie numa actualizacao do Studio.


O ODC publica IModelObject.Referrers e GetTargetPath()/ResolveTargetPath(root, path); o O11 nao publica nem um nem outro -- o kernel le consumidores por cast para AbstractObject.Referers do framework, e nao ha endereco textual estavel nenhum. Evidencia de leitura de API decompilada.

Prova:

```
Tabela de comparacao ODC x O11: 'Quem usa este objeto' -> ODC: IModelObject.Referrers PUBLICO; O11: nao existe na API, so AbstractObject.Referers do framework. 'Endereco textual estavel' -> ODC: GetTargetPath()/ResolveTargetPath -> Entities\Order\Attributes\Id, com Tipo[n] para anonimos; O11: nao existe.
```

Visto em: C:\Users\andre\Anvil\docs\tasks\2026-09-17-api-nativa-o11-odc.md:36-46

### Compilar o mesmo kernel contra as duas faixas

`diferenca-entre-faixas`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** O corpo do item contradiz a sua propria Prova ao eleger "os tres maiores". Por contagem, os tres maiores sao: IObjectSignature.Parent/Children a devolverem IModelObject (CS1503, 36 pontos), EntityIndexes/NativePerformanceCapture/BridgeCallException neutros mas alojados em ficheiros SS11 (CS0103, 29) e IExpression noutro namespace (CS0246, 25). A ausencia de OutSystems.Model.IParameter e CS0234 e vale UM ponto, nao um dos tres maiores. Tudo o resto do item (105 erros em 19 arquivos, todos mecanicos, nenhum #if, resolvidos por adaptador ou ramo neutro) confirma-se.
> 
> **Como se soube:** C:\Users\andre\Anvil\docs\tasks\2026-09-17-ws1-diferencas.md:7 tem o titulo literal "## Compilacao (105 erros em 19 arquivos -> 0)" e :4-5 a frase "Nenhuma foi contornada com `#if`: cada build resolve pelo seu adaptador ou por um ramo neutro no kernel". As contagens estao na mesma tabela: :11 "(36 pontos)" para CS1503/IModelObject, :12 "(25)" para CS0246/IExpression, :14 "(29)" para CS0103/EntityIndexes, :13 CS0234 IParameter sem contagem. E o "nenhum #if" continua verdade HOJE: uma varredura de todos os .cs de C:\Users\andre\Anvil\src por '^\s*#if' devolve ZERO ocorrencias. O mecanismo tambem se confirma no projeto: C:\Users\andre\Anvil\src\Anvil.Core.Odc\Anvil.Core.Odc.csproj:3-4 (comentario) "the same kernel sources as Anvil.Core (linked, never copied) compiled against the ODC Studio assemblies, plus the ODC platform adapter (Adapters.ODC)" e :24-28 `<Compile Include="../Anvil.Core/Kernel/**/*.cs" Exclude="...MergeProbe.cs;...ReferenceSignatureMerge.cs" />` + `<Compile Include="Adapters.ODC/**/*.cs" />`.
> 
> **Job que o ancoraria:** Nao e provavel por job (nenhuma op de modelo ve o compilador). Job/teste novo que o provasse, e barato: tests/Anvil.Tests/KernelPortabilityTests.cs -- (a) NoConditionalCompilationInTheKernel: varrer src/**/*.cs e afirmar 0 linhas comecadas por #if/#elif, que e o facto que o item afirma e que hoje nao tem rede nenhuma; (b) OdcProjectLinksTheKernelSourcesInsteadOfCopying: ler Anvil.Core.Odc.csproj e afirmar que os Compile Include do kernel apontam para ../Anvil.Core/ e que nao existe copia de Kernel/*.cs dentro de src/Anvil.Core.Odc. As duas passam a vermelho no dia em que alguem resolver uma diferenca de faixa com #if, que e precisamente o que o item quer impedir.


O kernel do O11 nao compila contra o ODC sem edicao: 105 erros em 19 arquivos, todos mecanicos e todos resolvidos por adaptador ou ramo neutro (nenhum #if). Os tres maiores: IObjectSignature.Parent/Children devolvem IModelObject no ODC, IExpression mudou de namespace, e nao ha OutSystems.Model.IParameter no ODC.

Prova:

```
Primeiro build real: 105 erros em 19 arquivos -> 0. Por causa: CS1503 'nao e possivel converter de OutSystems.Model.IModelObject para OutSystems.Model.IObjectSignature' (36 pontos); CS0246 'O nome do tipo IExpression nao pode ser encontrado' (25); CS0103 'O nome EntityIndexes nao existe' (29); CS0234 'IParameter nao existe no namespace OutSystems.Model'; CS1061 'nao contem uma definicao para IsVisibleInServerQueries'.
```

Visto em: C:\Users\andre\Anvil\docs\tasks\2026-09-17-ws1-diferencas.md:7-16; SSAM-Hybrid-ODC\docs\PROGRESSO-UNIFICACAO.md:130-136

### Custo por chamada de cada faixa

`diferenca-entre-faixas`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** Os tempos conferem, mas a ultima frase atribui mal a causa. "Os ~2,7 s que sobram sao a carga do OML de 6,5 MB" nao se sustenta: no worker quente de hoje a carga e ~1,1-1,8 s (cerca de metade) e o resto e o apply, que varia com o numero de ops e nao com o tamanho do OML. Texto certo: "...pedidos seguintes ~3 s, dos quais ~1,1-1,8 s sao a carga do OML (6,5 MB / ~59 800 objetos, refeita a cada apply por desenho) e o resto e o apply, proporcional aos ops." O resto do item mantem-se, incluindo a conclusao de que a faixa ODC e estruturalmente mais lenta por chamada.
> 
> **Como se soube:** Os numeros citados estao todos literalmente em C:\Users\andre\SSAM-Hybrid-ODC\docs\PROGRESSO-UNIFICACAO.md:274-293: ":274-276 `ssam job --lane o11` -> 2 s (22 ops, isValid, 0 mensagens) e `ssam job --lane odc` -> 14 s ... processo frio sobre um modulo de 59 667 objetos"; ":289-291 frio 13-14 s toda vez; primeiro pedido num worker novo ~15 s; pedidos seguintes ~3 s (5 s quando o job encadeia outro job como base). Faixa O11 intacta: 1,4 s. Os ~2,7 s que sobram sao a carga de um OML de 6,5 MB". A causa estrutural confirma-se no codigo: C:\Users\andre\Anvil\src\Anvil.Core\Kernel\JobRunner.cs:30 `var espace = host.Load(File.ReadAllBytes(basePath));` -- cada corrida le a base em bytes do zero. O tamanho tambem bate: tests\fixtures\odc\insurance-reactive-r8.oml = 6,19 MiB (~6,5 MB decimais). O QUE DERRUBA A ATRIBUICAO sao as linhas de tempo do worker ODC quente de hoje, C:\Users\andre\Anvil\.local\lane-odc\worker-odc-4547-60048.log, que separam as duas metades: "apply: 25 ops, 59821 objects, 55 messages, isValid=True, load 1769 ms, apply 954 ms" (:1180), "...load 1539 ms, apply 712 ms" (:1301), "...53 ops ... load 1138 ms, apply 690 ms" (:1412), "...load 1099 ms, apply 887 ms" (:1495), "...load 1254 ms, apply 2742 ms" (:1578). Load entre 1,1 e 1,8 s; apply entre 0,69 e 2,7 s.
> 
> **Job que o ancoraria:** O job da medicao JA EXISTE nas duas faixas e e o proprio que o item cita: C:\Users\andre\Anvil\tests\jobs\html-visual-alert.json e C:\Users\andre\Anvil\tests\jobs-odc\html-visual-alert.json -- o mesmo trabalho nas duas pistas, que e o que torna a comparacao honesta. O que nenhum job prova e o TEMPO (uma assercao de milissegundos seria instavel). Job/teste novo que ancorasse a parte que interessa, que e a estrutural: tests/Anvil.Tests.Odc/WarmWorkerStillReloadsTheBaseTests.cs -- correr html-visual-alert duas vezes seguidas no mesmo worker quente e afirmar que a segunda corrida tambem reporta `load` > 0 ms, ou seja, que o worker nao guarda modelo entre pedidos. Isso fixa a causa (recarga por apply) sem fixar um numero que a maquina muda.


A faixa ODC e estruturalmente mais lenta por chamada, e nao ha como a igualar sem mudar o desenho: cada apply carrega a base do zero, e o OML do ODC e de 6,5 MB. Nao prometa tempo de faixa O11 num trabalho da faixa ODC.

Prova:

```
Mesmo job (html-visual-alert sobre o InsuranceApp, 59 667 objetos), um comando so pela fachada: ssam job --lane o11 = 2 s (22 ops, isValid, 0 mensagens, via worker) contra ssam job --lane odc = 14 s (processo frio). Depois do worker residente da faixa ODC: frio 13-14 s toda vez; primeiro pedido num worker novo ~15 s; pedidos seguintes ~3 s (5 s quando o job encadeia outro job como base); faixa O11 intacta em 1,4 s. Os ~2,7 s que sobram sao a carga do OML de 6,5 MB, por desenho.
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\docs\PROGRESSO-UNIFICACAO.md:274-293

### base: "job:<nome>" na faixa ODC

`limite-do-kernel`

**JA NAO E VERDADE -- consertado.** Verificado em 2026-09-17 contra o codigo e contra o repositorio: hoje funciona.
`JobRunner.ResolveJobFile` junta TRES candidatos, nao dois -- a pasta do proprio job, a pasta irma sem o sufixo
`-negative` (por isso `jobs-odc-negative` alcanca `jobs-odc`), e `tests/jobs`. Ha **27 jobs ODC a encadear por
`job:`** neste momento, incluindo `delete-screen-in-use.json`, que e negativo e vai buscar `job:screen-list` ao
positivo; a suite ODC fecha 84/84 verde com eles.

Fica aqui em vez de ser apagado porque a observacao original era verdadeira quando foi feita, e o que ela ensina
continua a valer: a mensagem de erro do kernel ENUMERA os caminhos procurados, e e por ai que se decide se o
problema e do job ou da resolucao. Repare-se que a prova de baixo lista dois caminhos -- e essa contagem, nao a
memoria de ninguem, que data a observacao.

Prova (historica, de uma worktree `Anvil-cov-b`, com o codigo anterior):

```
"error": "FileNotFoundException: jobs: parte nao encontrada: job:block-events (procurado em C:\\Users\\andre\\Anvil-cov-b\\tests\\jobs-odc-negative\\block-events.json, C:\\Users\\andre\\Anvil-cov-b\\tests\\jobs\\block-events.json)" -- a nota esta escrita no proprio job negativo.
```

Visto em: C:\Users\andre\Anvil\docs\tasks\cobertura-e-relatorio.md:291-300; tests\jobs-odc-negative\delete-block-event-in-use.json (campo description)

### studio_open da bridge ODC

`armadilha`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** Fundir os tres itens num so (poupa 2 dos "100") e corrigir o rider: a versao carregada nunca e substituida, mas uma versao NOVA anexa-se ao Studio aberto em ~2 s; perde-se o estado em memoria da anterior, nao a sessao.
> 
> **Como se soube:** TERCEIRA COPIA DO MESMO FACTO (os outros dois: "studio_open com nome de asset que tem espaco" e "Nome com espaco: studio_open corta no primeiro espaco"). O nucleo e verdade e esta confirmado no mesmo sitio: StartupHook.cs:878-880 e operations.jsonl:707 (recusa) / :708 (contorno pela chave, outcome ok). O bloco Prova acrescenta a armadilha irma (asset 'Sinal ClientUITheme' contem o modulo 'SinalClientUITheme'), que tambem confere: operations.jsonl:711 `"command":"snapshot","module":"SinalClientUITheme","module_key":"qclhM3yjX06Cr_HZbsHyZw","outcome":"ok"`. RIDER FALSO identico: "corrigir exige recompilar a bridge, que so recarrega quando o Studio fecha" - contrariado por studio\bridge\README.md:26-28, facade\lib.mjs:79-85, studio\bridge\client\Program.cs:22 (ApplyStartupHookAsync contra um pid vivo) e pelas v1..v28 de 2026-09-16. A frase de onde saiu o erro esta em studio\bridge\client\Program.cs:23: "a bridge stays loaded until the Studio closes" - isso diz que a versao JA CARREGADA nunca sai, nao que nao se possa anexar uma nova.
> 
> **Job que o ancoraria:** Sem job possivel em tests/jobs*. Esboco de teste na faixa ODC: facade\tests\open-argument-split.test.mjs, mais uma assercao de que `attach` contra um pid vivo devolve `attached=true` com uma versao superior a que estava (prova directa contra o rider).


Abrir um asset cujo NOME tem espaco falha: a bridge corta o argumento no primeiro espaco. Contorno provado: abrir pela CHAVE do asset, que nao tem espaco. E corrigir exige recompilar a bridge, que so recarrega quando o Studio fecha -- nao no meio de uma entrega.

Prova:

```
'Sinal ClientUITheme' vira modulo 'Sinal' + caminho local 'ClientUITheme' e recusa com "Local model not found: C:\ProgramData\...". Ponto exato: studio\bridge\StartupHook.cs:878 (argument.Split(' ', 2)). Contorno: studio_open module: "qclhM3yjX06Cr_HZbsHyZw" abre "Sinal ClientUITheme". Armadilha irma: nome de ASSET != nome de MODULO (o asset 'Sinal ClientUITheme' contem o modulo 'SinalClientUITheme').
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\docs\ENTREGA-AGORA.md:30-46

### Download de assets ODC por bridge (tenant clienttenant)

`inalcancavel`

> **REFUTADO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** "Sete assets do clienttenant nao confirmaram abertura dentro do limite de 180 s do `open` da bridge (Template Web App, CriptoAES, Firebase Cloud Messaging Plugin, InAppBrowser Plugin, MobileUI, OutSystems UI, template_Agent) e custaram 3m43s de relogio cada; os outros 16 abriram em ~10s. A operacao nao foi cancelada, portanto nao esta provado que NAO abrem - so que passam dos 180 s. O tipo de asset nao explica o resultado: OutSystems UI e LowCodeLibrary e falhou, Device Diagnostic e MobileLibrary e abriu em 1.8 s. ExtensionLibrary, ExternalConnection e AIModelConnection nunca foram tentados. Para varrer o tenant, o caminho barato continua a ser a API publica (AssetRepository_ListAssets + AssetRepository_GetAssetRevisionSourceCode), que exige um API client com 'Asset management > Open'."
> 
> **Como se soube:** A CAUSA E O TIPO ESTAO ERRADOS, e os proprios dados da sessao provam-no. (1) Nao ha recusa da plataforma: as 7 falhas sao um TIMEOUT DO NOSSO LADO. journal\operations.jsonl, comando `open-late`, 2026-09-17, sete linhas com `"outcome":"gate_refused"` e note literal "Document opening is unconfirmed after 180 s; do not retry blindly." - e antes delas sete `open` com `"outcome":"uncertain","gate":"studio_busy"` e "Command 'open' is still running after 00:03:00; it was not cancelled" (StartupHook.cs:110). "Nao foi cancelado" quer dizer que pode muito bem ter aberto depois; ninguem verificou. Logo o tipo `inalcancavel` esta errado - no maximo e `limite-do-kernel`. (2) A LISTA DE TIPOS e contrariada pelo cruzamento do diario com snapshots\modules.json (seccao clienttenant): FALHOU `OutSystems UI` = `"assetType": "LowCodeLibrary"` - e um asset COM modelo low-code, o oposto do que o item afirma; FALHOU `Template Web App` = `"assetType": "WebApplication"` (e com um modal "Open template" registado na note, causa completamente diferente); FALHOU `template_Agent` = `"assetType": "Agent"`, tipo que nem sequer esta na lista. E ABRIU `Device Diagnostic` = `"assetType": "MobileLibrary"` em 1.8 s, o mesmo tipo dos dois plugins Cordova que falharam (Firebase Cloud Messaging Plugin, InAppBrowser Plugin) - logo o tipo NAO e o discriminante. (3) TRES DOS SEIS TIPOS NOMEADOS NUNCA FORAM TENTADOS: dos 206 assets do tenant, o diario mostra 23 `open`; nenhum `ExtensionLibrary` (sao 11: BinaryData, DateTime, HTTP, Math, Sanitization, Security, Text, TextDictionary, URL, Xml, Zip), nenhum `ExternalConnection` (1: O11_ClientPOA) e nenhum `AIModelConnection` (1: TrialGPT5) foi aberto. A afirmacao sobre eles nao foi medida, foi assumida.
> 
> **Job que o ancoraria:** Sem job de tests/jobs* (nao ha faixa de teste que abra assets de tenant). O que fecharia a duvida sem palpite - e sem tocar no clienttenant - e subir o limite de `open` e reensaiar no tenant PESSOAL com um asset grande, registando se abre aos 4-5 min; e, para a lista de tipos, um `open` unico contra um `ExtensionLibrary` do tenant pessoal. Esboco: `open-timeout-vs-assettype.test.mjs` em facade\tests\, parametrizado por assetType, a correr so contra personal-nv0s5uly.


Ha tipos de asset ODC que simplesmente NAO abrem no Studio, e o download pela bridge e caro o suficiente para inviabilizar varredura de tenant. O caminho rapido e a API publica, que exige um API client com permissao 'Asset management > Open'.

Prova:

```
Medido e registado no tenants.json em 2026-09-17 (206 assets): '~10s por modulo e 3m43s por asset SEM modelo low-code (plugins Cordova, WidgetLibrary, ExternalLibrary, ExtensionLibrary, ExternalConnection, AIModelConnection nao abrem)'. Alternativa: AssetRepository_ListAssets + AssetRepository_GetAssetRevisionSourceCode.
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\tenants.json:30 (tenant clienttenant.outsystems.dev, readOnly: true)

### Abrir um modulo num tenant movimentado

`armadilha`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> A primeira passagem tinha dito `confirmado`; caiu na reconferencia.
> 
> **Correccao:** Fundir os dois itens num so, ficando com este (:962), que ja traz o discard. E substituir o `Prova:` (:971) pela medicao: "aberto Client Portal as 17:40:04.684 (operations.jsonl:720); snapshot as 17:40:17.939 com `modified: false` e dependencia `BeneficiarioIS` na revisao 410 (snapshots\ClientPortal-D59BAA28...oml.json); 42,7 s depois, sem nenhum comando entre as duas linhas do diario, o close recusa: `Copy of ClientPortal is modified; refusing to close it without --discard.` (:723). Saida segura provada: close com --discard, recibo journal\discard-20260917174121.json (StartupHook.cs:637-643). Aconteceu em 5 dos 16 modulos clienttenant dessa sessao. A causa (subida da referencia para r411) e inferencia, nao registo." Apagar o duplicado de :1259. Isso poupa 1 dos "100" e a contagem da tabela de ancoragem (NAO-DA.md:18-22) tem de descer 1 na linha "so relatorios ou notas".
> 
> **Como se soube:** E o MESMO facto do item anterior, com o mesmo `Visto em:` (NAO-DA.md:974 e :1271, ambos `docs\ENTREGA-AGORA.md:48-51`), e herda os mesmos dois defeitos -- mais um que e so deste.
> 
> DUPLICACAO confirmada literalmente: NAO-DA.md:962 "### Abrir um modulo num tenant movimentado" e :1259 "### Abrir um modulo nao e operacao de leitura" cobrem a mesma frase de ENTREGA-AGORA.md:48-51 (`**3. Abrir um módulo NÃO é uma operação de leitura num tenant movimentado.** Abri \`ClientPortal\` com \`BeneficiarioIS r410\`; minutos depois ...`). Este (:962) e o mais completo: o seu `Prova:` (:971) e o unico que traz a saida segura (`studio_close com discard: true`), corroborada por StartupHook.cs:637-643 e por journal\discard-20260917174121.json.
> 
> HERDA: (a) "minutos depois" errado -- 55,9 s entre operations.jsonl:720 (17:40:04.684) e :723 (17:41:00.614); (b) a causa "atualizou a referencia para r411 sozinho" nao esta medida em lado nenhum (o r410 esta, no recibo do snapshot; o 411 so existe como revisao de ASSET no catalogo, listado as 18:12:22, depois do facto).
> 
> DERRUBA O "REPARO DE NOMES" DO AGENTE ANTERIOR, que estava AO CONTRARIO e teria metido um erro na pagina. Ele afirmou que "BeneficiarioIS"/"ClientPortal" sao errados e que os certos sao "Beneficiario IS"/"Client Portal". Nao: a prosa fala de MODULOS e usa a conveccao certa. Literal do recibo snapshots\ClientPortal-D59BAA28...oml.json: `{"Name": "BeneficiarioIS", "Revision": "410"}` -- sem espaco, dentro das Dependencies do modulo. E operations.jsonl:722/:723 registam `"module":"ClientPortal"`. Os nomes com espaco sao os de asset no catalogo (modules.json:1595, :3003) e so aparecem no `open` (operations.jsonl:720 `"module":"Client Portal"`, porque StartupHook.cs:898 faz `module = d.AssetInfo!.Name`). A prosa nao "mistura convencoes sem avisar": e precisamente sobre modulos.
> 
> **Job que o ancoraria:** Sem job possivel, pela mesma razao do irmao: facto de tenant vivo, e repetir exigia abrir modulos no clienttenant. A ancora e o mesmo trio de ficheiros ja em disco (recibo do snapshot + recibo de discard + operations.jsonl:720-725), que dispensa correr o que quer que seja.


Abrir um modulo no ODC Studio NAO e uma operacao de leitura: o Studio pode atualizar referencias sozinho e marcar o modulo como modificado sem ninguem lhe tocar. Para sair sem gravar e preciso fechar com discard.

Prova:

```
Observado em 2026-09-17: aberto ClientPortal com BeneficiarioIS r410; minutos depois o Studio tinha atualizado a referencia para r411 sozinho e marcado o modulo como modified: true. Saida segura: studio_close com discard: true (tira copia de seguranca e fecha sem gravar nada no servidor).
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\docs\ENTREGA-AGORA.md:48-51


## Armadilhas e limites do kernel Anvil e das ferramentas SSAM-Hybrid-ODC: enderecamento do contrato de dados, ordem de ops, aliases locais ao job, escolha de sobrecarga, nomes com espaco, catalogo de tenants, workers e pastas de trabalho (varrido em 2026-09-17)

### create ISessionVariable (faixa ODC)

`recusa-da-plataforma`

Session Variable nao existe no produto ODC: a API publica ainda oferece ISessionVariable e IESpace.CreateSessionVariable, mas a fabrica recusa na hora. Estado de sessao no ODC faz-se com client variable.

Prova:

```
expectError: ["create WfCovSessionState", "Session Variable objects can't be children of App objects"] — recusa fixada como regressao e corrida por OdcJobTests.JobFailsWithTheTeachingMessageInTheOdcLane
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc-negative\session-variable-not-in-odc.json; tabela em C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:498

### create IImage (recurso de modulo) — as DUAS faixas

`inalcancavel`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** Tipo certo: `limite-do-kernel`, nao `inalcancavel` (o Studio cria imagens; quem nao chega la e a linguagem de jobs). E "o unico construtor exige byte[]" -> "as duas sobrecargas de CreateImage exigem byte[] binary". Alem disso o facto esta TRIPLICADO em NAO-DA.md:278, :729 e :993 com tipos inconsistentes -- fundir numa entrada so, senao a contagem de '100 factos' esta inflada e o leitor ve o mesmo item a contradizer-se.
> 
> **Como se soube:** O facto e o mesmo do item anterior e esta certo, mas o TIPO esta trocado. A entrada em C:\Users\andre\Anvil\docs\NAO-DA.md:995 e marcada `inalcancavel`, que a tabela da propria pagina (NAO-DA.md:32) define como "nao ha caminho a partir do modelo low-code, independentemente da ordem das ops" -- e o corpo do item diz o contrario: "o Convert do kernel nao sabe converter JsonValue para byte[]", que e exactamente `limite-do-kernel` (NAO-DA.md:35, "limitacao nossa, do Anvil ou do SSAM, e nao da plataforma"). As outras duas copias do mesmo facto, NAO-DA.md:280 e :731, estao marcadas `limite-do-kernel`. A plataforma tem caminho: IESpace.cs:483 e :485 no ODC e :241/:243 no O11 -- SAO DUAS sobrecargas de CreateImage, nao "o unico construtor".
> 
> **Job que o ancoraria:** O mesmo do item anterior (tests/jobs-odc-negative/image-binary-not-expressible.json). Nao faz sentido escrever tres jobs para tres copias do mesmo facto -- e mais um argumento para as fundir.


Imagem de modulo nao e exprimivel pela linguagem de jobs em nenhuma das duas faixas: o unico construtor exige byte[] binary e o Convert do kernel nao sabe converter JsonValue para byte[]. Nao e diferenca de plataforma — o catalogo do SS11 tem a mesma assinatura.

Prova:

```
"error": "op #0 (create WfProbeImage): InvalidOperationException: Image binary cannot be null: Object not set"; assinatura `IImage CreateImage(byte[] binary, string originalPath, string name = null, IKey key = null)`; Convert so aceita string, bool, int, long, decimal, enum, ITypeSignature, interface do modelo e ExpressionDefinition
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:512-531

### Tipos que existem na API do ODC mas nao se criam a partir do modulo

`inalcancavel`

ILocalStorageEntity nao existe (o tipo certo e IClientEntity); ISystemRole e IExposedAction nao tem metodo Create; IService e abstrato sem classe concreta. O REST exposto de verdade e IRestService; o role de autor e IRole -> IAppRole.

Prova:

```
"KeyNotFoundException: unknown Model API type: ILocalStorageEntity (not in OutSystems.Model.V1 nor in the Studio plugins)"; "IESpace 'InsuranceApp' cannot create ISystemRole (no Create method in the API)"; "ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.Logic.Integrations.IService"
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:499-501; template da mensagem em C:\Users\andre\Anvil\src\Anvil.Core\Kernel\Verbs.cs:883

### Superficie de API nao e prova de funcionalidade (BPT / CreateBusinessProcess)

`inalcancavel`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** Guardar a regra ('antes de escrever job para um tipo que so se viu na API, confirmar que o produto o oferece') e deitar fora o exemplo. Ironia util para a pagina: este item e ele proprio o erro simetrico -- concluiu-se a AUSENCIA no produto sem ir ver o produto. A regra completa e: nem a presenca na API prova a funcionalidade, nem a ausencia de job prova a ausencia no produto; ve-se no produto (Studio decompilado + contrato da API publica), que e leitura barata e esta em disco. Exemplo com recusa viva para pos no lugar: ISessionVariable ('Session Variable objects can't be children of App objects').
> 
> **Como se soube:** A regra geral e boa, mas o exemplo que a ancora esta errado -- ver resx:271 e asset-repository-api-v1.json:1903 acima. O proprio corpo do item admite a fragilidade: NAO-DA.md:1030 -- 'ATENCAO: nao ha recusa viva colada para este caso (ao contrario da session variable) - item registado como afirmacao sem mensagem de plataforma'. As duas fontes citadas existem e conferem (2026-09-17-ws1-diferencas.md:82-86 e cobertura-t-relatorio.md:502 -- 'Confirmado o que a segunda onda do plano ja diz: a API tem `IESpace.CreateBusinessProcess`, o produto nao tem a funcionalidade | ... | Nao escrevi job').
> 
> **Job que o ancoraria:** Nenhum: e uma regra de metodo, nao um facto do modelo. O que se pode ancorar e o exemplo que a substituir -- ja esta: tests/jobs-odc-negative/session-variable-not-in-odc.json.


A API do ODC tem IESpace.CreateBusinessProcess e o namespace OutSystems.Model.BusinessProcesses.Nodes, mas o produto nao tem a funcionalidade. Regra geral: antes de escrever job para um tipo que so se viu na API, confirmar que o produto o oferece.

Prova:

```
Confirmado pelo dono em 2026-09-17; a unica prova documental e o ficheiro decompilado `OutSystems.Model.V1/OutSystems.Model/IESpace.cs`. ATENCAO: nao ha recusa viva colada para este caso (ao contrario da session variable) — item registado como afirmacao sem mensagem de plataforma.
```

Visto em: C:\Users\andre\Anvil\docs\tasks\2026-09-17-ws1-diferencas.md:82-86 e C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:502

### delete com consumidores

`recusa-da-plataforma`

O delete recusa quando o alvo tem consumidores reais e a mensagem NOMEIA cada um pelo caminho; usos derivados nao contam. Quatro recusas estao fixadas como jobs negativos na faixa ODC.

Prova:

```
"delete: refused, IEntityAttribute 'Body' is used by 2 consumer(s): IAggregateNode:ReadNotices/DataTable/ICombineSourcesOperation:WfProofNotices/IFilter; IServerAction:WfProof_Digest/IAssignNode/IAssignment (list them with usages, fix or remove those usages, or pass "force": true to break them)" — texto gerado em Verbs.cs:596-597
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc-negative\delete-data-in-use.json, delete-logic-in-use.json, delete-screen-in-use.json, delete-block-event-in-use.json; C:\Users\andre\Anvil\src\Anvil.Core\Kernel\Verbs.cs:589-601

### rename com colisao de nome

`recusa-da-plataforma`

O rename recusa quando o nome novo ja existe no mesmo escopo, porque o Studio sufixaria em silencio e o modulo ficaria com um nome diferente do pedido.

Prova:

```
expectError: ["rename: 'Title' clashes with an existing name in that scope", "pick another name"]; forma completa no guia: "rename: 'X' clashes with an existing name in that scope (the Studio would use 'X2'); pick another name"
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc-negative\rename-name-clash.json; C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-r-relatorio.md:280-281

### move nao reparenta

`recusa-da-plataforma`

move so REORDENA dentro do mesmo pai. before/after de um irmao de outro pai e recusado pelo kernel; sem essa recusa a plataforma cai numa assercao interna inutil, igual nas duas faixas. Tambem recusa filho que o pai nao guarda em sequencia (ex.: screen actions de uma tela).

Prova:

```
expectError: ["move before:", "is not a sibling of", "IContainer:WfBoxB", "IContainer:WfBoxA", "move only REORDERS inside the same parent", "create the object at the new parent and delete the old one"]; sem a recusa a plataforma da `Condition is false`
```

Visto em: C:\Users\andre\Anvil\tests\jobs-odc-negative\move-foreign-sibling.json; C:\Users\andre\Anvil\AGENTS.md:354-364

### Ordem de ops: forward reference

`armadilha`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** "O kernel detecta e lista os forward-refs do op que falhou e ate 8 outros (`Also out of order:`)" -- nao todos. E o `Visto em:` deve passar para tests/jobs-negative/destination-before-screen.json (grupo 'job', nao 'so notas'); AGENTS.md:625-628 fica como leitura de apoio e tem a mesma exageracao ("lista todos os outros forward-refs do job").
> 
> **Como se soube:** O nucleo esta certo e vive no codigo: C:\Users\andre\Anvil\src\Anvil.Core\Kernel\Errors.cs:107 `parts.Add($"{f.Reference} does not exist yet at this point of the job: it is created at op #{f.CreatedAt} ({f.CreatedAs}). Create it before op #{failedIndex}...")` e :109 `parts.Add("Also out of order: " + string.Join("; ", others...))`. MAS o item diz "lista TODOS os forward-refs do job" e Errors.cs:103 diz `var others = all.Where(f => !mine.Contains(f)).Take(8).ToList();` -- os do op que falhou saem todos (mine, sem Take), os outros saem no maximo 8. Alem disso o `Visto em:` so cita AGENTS.md:625-628, quando o facto ja esta pinado por job: C:\Users\andre\Anvil\tests\jobs-negative\destination-before-screen.json:5 `"expectError": ["op #4 (set Destination)", "IMobileScreen:Catalog does not exist yet at this point of the job: it is created at op #6", "Also out of order: IMobileScreen:GameDetail (created at op #7, used at op #5)"]`, varrido por C:\Users\andre\Anvil\tests\Anvil.Tests\NegativeJobTests.cs:19 `var dir = Path.Combine(Root, "tests", "jobs-negative");`.
> 
> **Job que o ancoraria:** Ja ancorado: tests/jobs-negative/destination-before-screen.json (NegativeJobTests). Para prender tambem o tecto dos 8, um segundo job negativo com 10+ forward-refs e `expectError` a citar exactamente 8 entradas depois de "Also out of order:".


O job e uma SEQUENCIA: o alvo de um set/link tem de existir ANTES do op. O kernel detecta e lista todos os forward-refs do job, mas quem escreve os sets antes dos creates perde a corrida inteira.

Prova:

```
"op #4 (set Destination): ... IMobileScreen:Catalog does not exist yet at this point of the job: it is created at op #6 ..." seguido de "Also out of order: ..." (exemplo negativo tests/jobs-negative/destination-before-screen.json)
```

Visto em: C:\Users\andre\Anvil\AGENTS.md:625-628

### Ordem de ops: referencias de extensao congeladas e job composto

`armadilha`

Uma ordem rigida mais: um job composto usa 'jobs' OU 'ops', nunca os dois (o base das partes e ignorado; vale o do composto). As referencias .avsig deixaram de ser ordem rigida (pacote 2026-10-05, C09): uma referencia congelada escrita depois das edicoes e importada antes da transacao e informada em hoistedReferences, nunca recusada.

Prova:

```
`throw new InvalidOperationException("job composto: use 'jobs' OU 'ops', nao os dois")` em JobRunner.cs:268; o hoist das referencias congeladas em JobRunner.cs:28-32 (teste NativeReferenceImportTests.AFrozenReferenceAfterTheEditsIsHoistedAndLeavesTheBaseUntouched)
```

Visto em: kernel/src/Anvil.Core/Kernel/JobRunner.cs:28-32 e :268

### Aliases $x sao locais ao job (nao atravessam `base: job:`)

`armadilha`

Com `base: job:x`, o job x e construido num OML separado, gravado, e o job atual carrega esse ficheiro numa ModelSession NOVA — o dicionario de handles nasce vazio, logo nenhum $alias do job base existe. Num job COMPOSTO ('jobs': [...]) os ops sao concatenados numa unica transacao e os aliases valem. Por isso os jobs negativos enderecam por Tipo:Nome.

Prova:

```
`unresolved reference '<ref>' (use $alias, @key or Type:Name)` em Verbs.cs:797; handles por sessao em Verbs.cs:115 (`_handles[alias] = obj`); JobRunner.cs:222 constroi o job base noutro OML e JobRunner.cs:30-32 faz `host.Load(...)` + `new ModelSession(espace)`. Uso real: `"base": "job:screen-list"` + `{"op":"delete","target":"IMobileScreen:WfCovTaskDetail"}` (Tipo:Nome, nao alias)
```

Visto em: C:\Users\andre\Anvil\src\Anvil.Core\Kernel\JobRunner.cs:214-227 e :19-32; C:\Users\andre\Anvil\tests\jobs-odc-negative\delete-screen-in-use.json

### Resolucao de `job:<nome>` por faixa

`armadilha`

`job:<nome>` procura na pasta do proprio job, depois na pasta POSITIVA da mesma faixa (um job de tests/jobs-odc-negative alcanca tests/jobs-odc) e so entao em tests/jobs — a pasta positiva vem antes para que uma faixa nunca herde por engano o job da outra.

Prova:

```
JobRunner.cs:168-183 (comentario + `if (folder.EndsWith("-negative"...)` acrescenta a pasta positiva antes de `tests/jobs`); conserto registado como commit c56af06. CUIDADO com fonte desatualizada: a `description` de tests/jobs-odc-negative/delete-block-event-in-use.json ainda diz "o `job:` so procura na pasta do proprio job e em tests/jobs - nao em tests/jobs-odc" — isso ja nao e verdade.
```

Visto em: C:\Users\andre\Anvil\src\Anvil.Core\Kernel\JobRunner.cs:168-183; C:\Users\andre\SSAM-Hybrid-ODC\docs\PROGRESSO-UNIFICACAO.md:317

### Enderecamento do contrato de dados: propriedades assimetricas na leitura

`armadilha`

Ha propriedades que NAO devolvem o que se escreveu estando a escrita correcta, e por isso estao fora da vigilancia do contrato: StyleSheet, UserStyleSheet, GeneratedStyleSheet e Label. Value/Text de expressao escreve-se texto e le-se um ExpressionDefinition — a comparacao certa e a do texto.

Prova:

```
`private static readonly HashSet<string> AssimetricasNaLeitura = new(StringComparer.Ordinal) { "StyleSheet", "UserStyleSheet", "GeneratedStyleSheet", "Label" };` com a medicao no comentario: "escrever 53 caracteres devolve 45 320"
```

Visto em: C:\Users\andre\Anvil\src\Anvil.Core\Kernel\DataAssertions.cs:13-24

### Enderecamento do contrato de dados: so identidade estavel

`limite-do-kernel`

O contrato so vigia tipos de dados e elementos nomeados de topo que sobrevivem a corrida com a mesma chave. A plataforma RECRIA a maquinaria interna quando o contrato muda (argumentos de ITriggerNode, IContent dentro de um botao, IEventHandler de instancia de bloco, widgets): lembrar esses por chave garante falso positivo.

Prova:

```
Comentario medido: "medido ao alargar o contrato sem esta lista, o job block-events-types encheu-se de 'KeyNotFoundException: no object with key ...' sobre escritas correctas"; lista IdentidadeEstavel com 20 tipos (ITheme, IMobileTheme, IServerAction, IMobileScreen, IRestService, ...)
```

Visto em: C:\Users\andre\Anvil\src\Anvil.Core\Kernel\DataAssertions.cs:26-45

### Enderecamento do contrato de dados: atributos de EntityIndex por CHAVE (bug ja corrigido)

`armadilha`

CORRIGIDO — nao voltar a reportar. O contrato guardava os atributos de um EntityIndex pelo NOME e recusava a entrega ao renomear um atributo indexado, com isValid=True e o indice certo no modelo. Hoje guarda AttributeKeys (por chave) e renomear um atributo indexado no mesmo job que cria o indice e entrega valida.

Prova:

```
Sintoma medido entao: "data mismatch: {'element': 'Headless_CS (ESpace) / Notice (ServerEntity) / IX_Notice_Body (EntityIndex)', 'property': 'Attributes', 'expected': ['Body'], 'actual': ['Message']}" com "== probe-index-rename.json: ok=True {... 'isValid': True ...} accepted= False". Conserto: `RememberData(target, "AttributeKeys", ...)` com o comentario "Por CHAVE, nao por nome" (commit 8ab8529)
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-r\BLOCKER.md:12-64; conserto em C:\Users\andre\Anvil\src\Anvil.Core\Kernel\DataAssertions.cs:137-144

### CSS de tema: tres metades, leitura != escrita

`armadilha`

> **CONFIRMADO** (passagem adversarial, 2026-09-17)
> 
> **Como se soube:** Verificado nas DUAS faixas no Studio decompilado, nao so inferido. ODC: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Model\WebStyleSheet.cs:1185 `SetCssSource(text + "\r\n" + (UserCssSource?.GetText() ?? string.Empty));` (CalculateFinalCssSource, :1180) e :1213-1224 `public void SetCorrectCssSource(string value) { if (IsGeneratedEffectiveValueInUse()) { ... SetUserCssSource(userCssSource); }`. O11: C:\Users\andre\ODC3\decompiled\o11\ServiceStudio.Framework\ServiceStudio.Model\WebStyleSheet.cs:2209 e :2237-2248 -- codigo identico, incluindo o mesmo gate :2261 `IsGeneratedEffectiveValueInUse()` => `IsThemeEditorActive()`. Os numeros do item fecham: 884 + 2 (CRLF) + 44434 = 45320. Kernel: C:\Users\andre\Anvil\src\Anvil.Core\Kernel\ThemeCss.cs:52 `sheet.SetCssSource(generated + "\r\n" + (sheet.UserEffectiveValue ?? ""));` e :17-19 "o `get` seguinte devolvia o texto antigo ... escrita destrutiva invisivel na leitura" (o conserto ja la esta). Unica ressalva, que nao derruba o item: ha SIM uma diferenca de faixa do lado da LEITURA -- ThemeCss.cs:80-81 "as metades que o Model API do O11 nao tem (o do ODC ja as publica como somente-leitura)".
> 
> **Job que o ancoraria:** Ja ancorado na faixa ODC: tests/jobs-odc/theme-css-halves.json + tests/jobs-odc/theme-css-reload.json, com asserts em tests/Anvil.Tests.Odc/ThemeCssTests.cs:38 `Assert.Equal(generated + "\r\n" + author, effective)`. Falta o par O11: nao existe nenhum tests/jobs/*theme*; um `tests/jobs/theme-css-halves.json` sobre uma fixture O11 cujo tema TENHA CSS do Theme Editor (a actual nao tem -- ThemeCssTests.cs:15-17 diz isso) fecharia a afirmacao "vale nas duas faixas" por medicao e nao so por leitura do assembly.


O CSS de um tema tem tres metades (GeneratedCssSource, UserCssSource e CssSource=derivada). O Model API le a derivada e escreve a do autor. Um `set StyleSheet` num tema com CSS do Theme Editor SUBSTITUI o CSS do autor; antes do conserto o get seguinte ainda mostrava o texto antigo. Vale nas DUAS faixas — nao e diferenca de plataforma.

Prova:

```
Medido no InsuranceApp: "antes StyleSheet 45320 chars = GeneratedStyleSheet 884 + CRLF + UserStyleSheet 44434 / set StyleSheet \"<53 chars>\" -> {\"set\":\"StyleSheet\",\"via\":\"property\"} (sucesso, sem nota) / depois UserStyleSheet 53 chars <- os 44 434 caracteres de CSS do autor foram substituidos / StyleSheet 45320 chars <- INALTERADA"
```

Visto em: C:\Users\andre\Anvil\docs\tasks\2026-09-17-ws1-diferencas.md:36-61; C:\Users\andre\Anvil\AGENTS.md:366-375; C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-r\BLOCKER.md:68-101

### rename de action/no/saida: expressao `<No>.<Saida>`

`diferenca-entre-faixas`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
>
> **Correccao:** "Na faixa O11 a expressao `<No>.<Saida>` NAO e reescrita e o modulo cai com
> ExpressionUnknownObject; na faixa ODC religa sozinha. Nas DUAS faixas esse rename devolve
> `expressionsRewritten: 0` com `consumers: 1` -- o consumidor contado e o NO, e a expressao que le o no nao
> entra na conta; nao confie no numero em faixa nenhuma."
>
> **Como se soube:** o item poe o contador a mentir SO no O11, e e falso -- devolve 0 nas duas. A propria fonte
> citada di-lo: `docs/tasks/cobertura-r-relatorio.md:326` -- "Nas duas faixas o **no** e renomeado pela plataforma
> e o `rename` devolve `expressionsRewritten: 0`. A diferenca esta no que acontece com a expressao: o ODC religa,
> o O11 deixa o nome antigo". E o contador varia por CASO, nao por faixa:
> `tests/jobs-odc/rename-logic-propagation.json:100` -- "o output da client action: no ODC vem com consumers 2 e
> expressionsRewritten 2".
>
> **DUPLICADO:** este item e o de cima, "Rename de action/no/saida e a expressao `<No>.<Saida>`", sao o mesmo
> facto colhido duas vezes de relatorios diferentes. Ficam os dois so ate alguem os fundir; o de cima tem melhor
> `Visto em:`.

Na faixa O11 uma expressao `<No>.<Saida>` NAO e reescrita quando a action, o no ou a saida sao renomeados, e o contador do proprio rename mente: devolve expressionsRewritten 0 com consumers 1, porque o consumidor contado e o NO e a expressao que le o no nao entra na conta. Na faixa ODC a mesma expressao religa sozinha.

Prova:

```
"Error ExpressionUnknownObject: Invalid Expression | Can't identify 'Slug_Make' element in expression. @ Headless_UI (ESpace) / MainFlow (MobileFlow) / SlugProbe (MobileScreen) / Go (ScreenAction) / Keep (AssignNode) / Assignment" junto de "rename {\"renamed\": \"IServerAction 'Slug_Build'\", \"from\": \"Slug_Make\", \"to\": \"Slug_Build\", \"consumers\": 1, \"expressionsRewritten\": 0}"
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-r-relatorio.md:140-154 e :290-292

### rename de metodo/input de REST exposto muda a URL publica

`armadilha`

> **CONFIRMADO** (passagem adversarial, 2026-09-17)
> 
> **Como se soube:** Medido, e nas duas faixas (o item cita so a medicao O11). C:\Users\andre\Anvil\tests\jobs\rename-logic-propagation.json:132 `{"op": "set", "target": "$m", "prop": "URLPath", "value": "/GetSlug/{Text}"}` seguido de :149 rename do metodo e :151 rename do input, com o `_why` :149 "o URLPath NAO e texto parado -- o segmento com o nome do metodo e reescrito e a URL publica do endpoint muda sozinha". Leitura de volta em C:\Users\andre\Anvil\docs\tasks\cobertura-r-relatorio.md:159-160 `"URLPath": "/SlugOf/{Text}"` / `"/SlugOf/{Term}"`, e a mesma coisa na faixa ODC em :334-343 "### B. O `URLPath` de REST exposto acompanha -- igual nas duas faixas" (sonda .local/probe/probe-rest-odc.json). Tentei derrubar por "o URLPath era so o default derivado do nome": nao cola -- o default documentado e `/<Nome>` (C:\Users\andre\Anvil\docs\mapa\2026-09-04-rest-investigacao.md:177 "`URLPath` (\"URL Path\", default `/<Nome>`...") e o valor medido era `/GetSlug/{Text}`, escrito a mao e diferente do default.
> 
> **Job que o ancoraria:** Meia ancoragem que ninguem notou: tests/jobs/rename-logic-propagation.json:151-152 renomeia o input Text->Term e NUNCA corrige o URLPath; como `{param}` tem de existir como input (docs/mapa/2026-09-04-rest-investigacao.md:236 "`{x}` sem input -> 'Invalid URL Path'"), se o placeholder deixasse de acompanhar o job ficava vermelho por `expectValid: true`. O segmento com o NOME do metodo nao esta ancorado (a URL continuaria valida). Falta: (a) o job de REST exposto da faixa ODC, que o relatorio :347 diz que a frente T ainda nao escreveu -- os cinco ops entram em tests/jobs-odc/rename-logic-propagation.json; (b) um teste xunit estilo ThemeCssTests a ler o `get` do metodo e a exigir `"URLPath": "/SlugOf/{Term}"`, ja que o formato de job so sabe `expectValid`/`expectedMessages`/`expectError`.


Ao contrario do esperado, o URLPath de um metodo REST exposto ACOMPANHA o rename, inclusive o segmento com o nome do metodo: a URL publica do endpoint muda sozinha e quem chama de fora quebra sem aviso.

Prova:

```
"get IRestServiceAction SlugOf ... \"URLPath\": \"/SlugOf/{Text}\"  <- depois de renomear o metodo GetSlug -> SlugOf" e "\"URLPath\": \"/SlugOf/{Term}\"  <- depois de renomear o input Text -> Term"
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-r-relatorio.md:156-161 e :284-286

### Escolha de sobrecarga no create: CreateSibling e ranking de namespaces

`armadilha`

O mesmo nome de interface existe em varios namespaces do ODC, e o IObject do ODC tem CreateSibling* (o SS11 nao). Sem guarda, o FindCreate escolhia CreateSibling num IContainer e o widget nascia como IRMAO do container, em ordem inversa, fora do Content — e so o gate de equivalencia do merge apanhou. O kernel hoje ignora CreateSibling*, despromove Extensions/ExternalLibraries/Processes/BusinessProcesses e lista a sobrecarga com parametro Type antes da generica.

Prova:

```
`AllMethods(parent).Where(m => m.Name.StartsWith("Create") && !m.Name.StartsWith("CreateSibling"))` com o comentario "CreateSibling (ODC IObject) creates BESIDE the object, not inside it: never a way to create a child" (Verbs.cs:892-893) e a funcao Rank em Verbs.cs:888-891. Sintoma original: gate de equivalencia deu `WF_PinNotFoundBanner ChangedInLocal por EffectiveMarginLeft em tres widgets`; erros irmaos: "ArgumentException: Couldn't find any concrete class implementing OutSystems.Model.Extensions.IStaticEntity" e "Nodes of type IEndNode are not allowed in IMobileScreen or eSpaces of type CrossDevice"
```

Visto em: C:\Users\andre\Anvil\src\Anvil.Core\Kernel\Verbs.cs:875-899; C:\Users\andre\Anvil\docs\tasks\2026-09-17-ws1-diferencas.md:22-24 e :63-67

### Nome com espaco: studio_open corta no primeiro espaco

`armadilha`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** Igual ao item irmao: a bridge anexa uma versao nova ao Studio EM EXECUCAO (`odc attach`, 2 s medidos em lab\int-integracao.md:12). O que nao se recupera e o estado em memoria da versao antiga, nao a sessao do Studio.
> 
> **Como se soube:** CITACAO EXACTA, ANCORA EXACTA. O bloco Prova cita `var parts = argument.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries); ... var module = parts[0]; var localPath = parts.Length == 2 ? Path.GetFullPath(parts[1]) : null;` e o Visto em: aponta C:\Users\andre\SSAM-Hybrid-ODC\studio\bridge\StartupHook.cs:877-880 - confere caracter a caracter com o ficheiro de hoje. O caminho absoluto na recusa (journal\operations.jsonl:707, "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\OutSystems\\ClientUITheme") e o `Path.GetFullPath` relativo ao cwd do Studio, o que fecha a cadeia causal. Mecanismo confirmado tambem do lado do cliente: studio\bridge\README.md:65-66 "Argument words are joined with spaces" - o studio_open do MCP entrega mesmo a string inteira ao `open`. MESMO RIDER FALSO dos outros dois itens irmaos: "a bridge so recarrega quando o Studio fecha", contrariado por studio\bridge\README.md:26-27 ("bump Version ... then attach the new DLL"), por facade\lib.mjs:79-85 e pelas 26 DLLs v1..v28 construidas em 2026-09-16 no mesmo dia de trabalho.
> 
> **Job que o ancoraria:** Mesmo ancoradouro do item irmao: teste unitario sobre um `SplitOpenArgument` extraido, em facade\tests\ ou num projecto de teste da bridge. Nao ha job de tests/jobs* que possa prova-lo.


studio_open/`open` da bridge parte o argumento no primeiro espaco e trata a segunda metade como caminho local: 'Sinal ClientUITheme' vira modulo 'Sinal' + caminho 'ClientUITheme'. Contorno provado: abrir pela CHAVE do asset, que nao tem espaco. Consertar exige recompilar a bridge, e a bridge so recarrega quando o Studio fecha — nao fazer no meio de uma entrega.

Prova:

```
`var parts = argument.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries); ... var module = parts[0]; var localPath = parts.Length == 2 ? Path.GetFullPath(parts[1]) : null;` (StartupHook.cs:878-880); recusa observada: "Local model not found: C:\ProgramData\..."; contorno: `studio_open module: "qclhM3yjX06Cr_HZbsHyZw" -> abre "Sinal ClientUITheme"`
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\studio\bridge\StartupHook.cs:877-880; C:\Users\andre\SSAM-Hybrid-ODC\docs\ENTREGA-AGORA.md:32-42

### Nome de asset != nome de modulo

`armadilha`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> A primeira passagem tinha dito `confirmado`; caiu na reconferencia.
> 
> **Correccao:** Trocar a frase final por: "Usar o nome de asset num studio_snapshot (e no studio_deliver, que o encadeia) cai no gate `scope` com \"Expected exactly one open <X>; found 0.\" (StartupHook.cs:742-743). No studio_close cai noutro sitio: \"No open copy of <X>.\" (StartupHook.cs:629), que a Journal.Gate nao classifica -- sai gate `none`. Os tres aceitam o NOME DE MODULO ou a CHAVE; so o nome de ASSET e que nao serve (excepto no `open`, onde e o nome de asset ou a chave que servem)." Trocar o `Visto em:` de ENTREGA-AGORA.md:44-46 e :93 para journal\operations.jsonl:709 e :711 (17:35:52 vs 17:36:08, mesma key), e NAO citar :706 nem o catalogo como prova de nomes.
> 
> **Como se soube:** O NUCLEO da armadilha resiste, mas a frase final do item (NAO-DA.md:1249 "Usar o nome errado cai no gate `scope`") e FALSA para studio_close, e a evidencia do agente anterior tem dois furos.
> 
> (1) DERRUBA A FRASE DO GATE: `close` NAO passa por `Active()`. C:\Users\andre\SSAM-Hybrid-ODC\studio\bridge\StartupHook.cs:628-629 literal: `var copies = await Ui(() => RuntimeImplementation.Instance.Aggregators.Where(a => a.ActiveESpace != null && (a.ActiveESpace.Name == module || a.ActiveESpace.Key.ToString() == module)).ToArray()); Require(copies.Length > 0, "No open copy of " + module + ".");`. A string "No open copy of Sinal ClientUITheme." nao casa NENHUM needle de C:\Users\andre\SSAM-Hybrid-ODC\studio\shared\Journal.cs:37-46, logo Journal.cs:47 `return "none";`. Nome de asset no studio_close da gate **none**, nao **scope**. O caminho e directo: facade\mcp.mjs:38 `wrap(({ module, ... }) => studio(['close', module, ...]))` -- nenhuma resolucao asset->modulo em lado nenhum da facade.
> 
> (2) DERRUBA METADE DA PROVA CITADA: a linha das 17:34:58 (operations.jsonl:706) NAO prova nada sobre nomes. As quatro linhas anteriores da mesma sessao studio-7256 (operations.jsonl:702-705) sao `status`,`status`,`status`,`assets` -- nao houve NENHUM `open` antes dela. "found 0" ali significa so "nada aberto". A prova real e uma so: :709 (17:35:52, snapshot "Sinal ClientUITheme" -> gate scope) DEPOIS do open ok em :708 (17:35:45, key qclhM3yjX06Cr_HZbsHyZw), contra :711 (17:36:08, snapshot "SinalClientUITheme", MESMA key -> outcome ok).
> 
> (3) DERRUBA "Catalogo confirma os dois nomes": FALSO. `Select-String -Pattern 'SinalClientUITheme'` sobre C:\Users\andre\SSAM-Hybrid-ODC\snapshots\modules.json devolve ZERO linhas; so ha :2747 `"name": "Sinal ClientUITheme"`. O catalogo so tem o nome de ASSET. O nome de MODULO existe no diario (:711) e no recibo snapshots\SinalClientUITheme-...oml.json, nunca no catalogo.
> 
> (4) CONFIRMO a imprecisao que o agente anterior ja apontou: StartupHook.cs:742 `a.ActiveESpace.Name == module || a.ActiveESpace.Key.ToString() == module` -- a chave tambem serve.
> 
> (5) studio_deliver: nao existe comando `deliver` na bridge (dispatch em StartupHook.cs:137-158, e o proprio usage impresso em operations.jsonl:700 nao o lista). E facade: lib.mjs:123 `const snapshot = await timed('snapshot', () => studio(['snapshot', module], pid));` -- logo deliver herda o gate scope do snapshot. Essa parte do item sustenta-se.
> 
> (6) NAO e obsoleto: a assimetria continua no codigo de hoje. `open` fala ASSET (StartupHook.cs:892 `return await OpenFromServer(module, top, c)`, que em :984 devolve `module = name` = nome do asset), `snapshot`/`close` falam MODULO.
> 
> **Job que o ancoraria:** Nenhum job de tests/jobs* o prova (e bridge, nao kernel). Mas metade do item e ancoravel OFFLINE, sem Studio e sem tenant, porque Journal.Gate e funcao pura: teste novo sobre studio\shared\Journal.cs que asserte Gate("Expected exactly one open X; found 0.") == "scope" E Gate("No open copy of X.") == "none" -- exactamente o que derruba a frase de hoje. A outra metade (asset vs modulo com o Studio anexado) so num teste de facade ao lado de C:\Users\andre\SSAM-Hybrid-ODC\facade\tests\mcp.test.mjs, e nunca contra clienttenant.


studio_assets lista ASSETS; studio_snapshot, studio_close e studio_deliver querem MODULOS. O asset 'Sinal ClientUITheme' contem o modulo 'SinalClientUITheme'. Usar o nome errado cai no gate `scope`.

Prova:

```
"O asset chama-se `Sinal ClientUITheme`; o modulo dentro dele e `SinalClientUITheme`"; vocabulario do gate: "`scope` = modulo errado ou nome errado (quase sempre a armadilha 2)". Depois de abrir, rodar studio_status e usar o nome de `modules[].name`.
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\docs\ENTREGA-AGORA.md:44-46 e :93

### Abrir um modulo nao e operacao de leitura

`armadilha`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> A primeira passagem tinha dito `confirmado`; caiu na reconferencia.
> 
> **Correccao:** Prova: substituir por medicao. "snapshots\ClientPortal-D59BAA28...oml.json regista `capturedAt 2026-09-17T17:40:17.939` com `modified: false` e `{\"Name\": \"BeneficiarioIS\", \"Revision\": \"410\"}`; 42,7 s depois, sem nenhum comando entre as duas linhas do diario, o close recusa com `Copy of ClientPortal is modified; refusing to close it without --discard.` (operations.jsonl:723). Repetiu-se em 5 dos 16 modulos clienttenant abertos nessa sessao (recibos journal\discard-*.json de 17:41:21, 17:41:51, 18:25:58, 18:46:59, 18:47:10), enquanto 11 fecharam limpos. O QUE o Studio mexeu nao esta medido: a subida da referencia para r411 e inferencia, nao registo." Tirar "minutos depois" (foram 56 s do open, 43 s do snapshot) e marcar a causa como nao provada, no mesmo tom da NOTA DE HONESTIDADE que a pagina ja usa no item do BPT.
> 
> **Como se soube:** O FACTO resiste e fica MUITO mais forte do que o agente anterior mostrou; o que nao resiste e o `Prova:` (NAO-DA.md:1268), que afirma um numero errado e uma causa nao medida.
> 
> PROVA NOVA, melhor do que a citada -- o recibo do proprio snapshot. C:\Users\andre\SSAM-Hybrid-ODC\snapshots\ClientPortal-D59BAA28B20B553F36AA183217224C2D1C44C1065B1B1C8D8BA5A6CEF1A8E239.oml.json literal: `"capturedAt": "2026-09-17T17:40:17.9392884+00:00", "modified": false`. A recusa do close e as 17:41:00.61 (operations.jsonl:723). Entre as duas linhas do diario (:722 -> :723) nao correu comando nenhum. Logo o modulo passou de `modified: false` a `modified: true` em 42,7 s com ZERO comandos -- mesmo modulo, mesma propriedade (StartupHook.cs:786 e :634 leem ambos `s.WasModifiedSinceLastSave`). Isto e controlo interno, muito melhor do que comparar com outros modulos.
> 
> O NUMERO ESTA ERRADO: "minutos depois" nao confere. open 17:40:04.6841258 (:720) -> recusa 17:41:00.6145715 (:723) = 55,9 s. Menos de um minuto.
> 
> A CAUSA NAO ESTA MEDIDA: "o Studio atualizar referencias sozinho" / "r410 -> r411" nao tem registo. O r410 EXISTE em disco -- o mesmo recibo traz `{"Name": "BeneficiarioIS", "Revision": "410"}` entre 56 dependencias (o agente anterior disse que so havia prosa; errou) -- mas NADA regista o r411 DENTRO do modulo. O 411 que existe e a revisao do ASSET no catalogo (modules.json:1595-1600 `"name": "Beneficiario IS" ... "revision": 411`), listado as 18:12:22, 32 min DEPOIS do evento. Os dois .oml (base e discarded) comecam por `b'OML\xaa\x86\x01\x001'` e nao sao zip, logo nao ha como ler a referencia sem correr.
> 
> DERRUBA O CONTROLO DO AGENTE ANTERIOR: PortalDoCliente NAO e controlo, e um SEGUNDO caso. Ele leu operations.jsonl:728 (close PortalDoCliente outcome ok) como "nao estava modificado". C:\Users\andre\SSAM-Hybrid-ODC\journal\discard-20260917174151.json existe: `"at": "2026-09-17T17:41:51.2591055+00:00", "module": "PortalDoCliente"`. Esse ficheiro so e escrito dentro de `if (state.modified && discard)` (StartupHook.cs:637-639). Fechou ok porque fechou COM discard, estando modificado. E o recibo PortalDoCliente-...oml.json diz `"capturedAt": "...17:41:31.9177443+00:00", "modified": false` -- mesmo padrao, 18 s.
> 
> REPRODUZIDO 5x na mesma sessao studio-7256 sobre clienttenant, por recibos de discard: ClientPortal (17:41:21), PortalDoCliente (17:41:51), CooperadoFinanceiro (18:25:58), POCHugoMobile (18:46:59), POCLucioMobile (18:47:10). Controlo verdadeiro: dos 16 recibos .oml.json com `"host": "clienttenant.outsystems.dev"`, 11 ficaram limpos e sem discard (SinalClientUITheme, ClientComponentesUI, ModeloAssistencial, CooperadoSolicitacoes, DeviceDiagnostic, GestaodaInternacao, ModeloAssistencialLibrary, QualityGate, SRTWorkflow, ClientUITheme, CloneOfCodeQualityAPILibray). 5 em 16, nao 1 em 5.
> 
> **Job que o ancoraria:** Nenhum job de tests/jobs* pode prova-lo: e estado de tenant vivo, nao do kernel, e reproduzi-lo exigiria abrir modulos no clienttenant, que esta fora de questao. A ancora ja existe em disco e nao precisa de correr nada: snapshots\ClientPortal-D59BAA28...oml.json (`modified: false`, BeneficiarioIS r410) + journal\discard-20260917174121.json + operations.jsonl:722-723. Um teste offline util sobre esses ficheiros: asserir que todo `discard-*.json` tem um recibo de snapshot irmao com `modified: false`, que e a forma do facto.


Num tenant movimentado, abrir um modulo basta para o Studio atualizar referencias sozinho e marcar o modulo como modificado, sem ninguem tocar nele. Para sair sem gravar, fechar com discard.

Prova:

```
"Abri `ClientPortal` com `BeneficiarioIS r410`; minutos depois o Studio tinha atualizado a referencia para `r411` sozinho e marcado o modulo como `modified: true`, sem ninguem tocar nele"
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\docs\ENTREGA-AGORA.md:48-51

### Catalogo de tenants: raiz do catalogo x sessao do Studio

`armadilha`

> **OBSOLETO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** "O `open` NAO exige que a raiz do catalogo seja o tenant da sessao - isso era verdade antes da bridge v28 e esta consertado. Hoje `ResolveKey(modulo, host)` (StartupHook.cs:822-846) procura primeiro na seccao do tenant da sessao, depois em todas as seccoes de snapshots\\modules.json (raiz + otherTenants), depois nos outros snapshots\\*.json, e por fim trata o argumento como chave. O que se mantem: modules.json e um so ficheiro com seccoes por tenant, editar a mao ja perdeu a seccao pessoal, e a verdade e a listagem nativa `assets <host>`, que reescreve a seccao em ~1 s."
> 
> **Como se soube:** E O MESMO ERRO DO `base: "job:<nome>"`: a frase foi copiada da coluna CAUSA de uma tabela cujo titulo e "| Causa | Correcao | Prova |". C:\Users\andre\SSAM-Hybrid-ODC\lab\REPORT.md:202 e o cabecalho `| Causa | Correcao | Prova |`; :204 e a linha `| `open` exige que o catalogo raiz seja o tenant da sessao | Bridge v28: `Top()` usa a unica sessao autenticada; `ResolveKey(modulo, host)` procura primeiro na seccao do tenant da sessao | `attach` v28 e `snapshot` do InsuranceApp corporativo com o raiz apontando para outro tenant |`. Ou seja, a coluna do meio diz que ja foi consertado, na v28. CODIGO DE HOJE: StartupHook.cs:833-837 monta `var sections = new List<JsonElement> { root }; if (root.TryGetProperty("otherTenants", out var others)) sections.AddRange(others.EnumerateArray());` e depois `foreach (var section in sections.Where(s => tenant != null && string.Equals(TenantOf(s), tenant, ...)).Concat(sections))` - tenta primeiro a seccao do tenant da sessao e a seguir TODAS, e ainda cai para snapshots\*.json (:839-845) e finalmente para `ObjectKey.Parse(moduleOrKey)` (:846). Nao exige nada da raiz. StartupHook.cs:35 `public const string Version = "v28"` e docs\ENTREGA-AGORA.md:22 "bridge | anexada, v28". PROVA EMPIRICA: com a raiz do catalogo a dizer `insuranceapp.outsystems.dev` (snapshots\modules.json) e o clienttenant em `otherTenants`, o diario regista 16 `open` bem sucedidos contra assets do clienttenant entre 17:35 e 18:51 de 2026-09-17. O RESTO do item mantem-se verdade (lab\REPORT.md:268-269: "Catalogo editado a mao ... Trocar seccoes a mao perdeu a seccao pessoal; `assets <host>` reconstroi em 1 s"). Erro adicional de leitura: "o catalogo snapshots\modules.json e POR TENANT" - e UM ficheiro com uma seccao raiz mais um array `otherTenants` (confirmado em StartupHook.cs:833-834 e studio\builder\Program.cs:151).
> 
> **Job que o ancoraria:** Sem job de tests/jobs*. Ancoradouro certo, e barato: teste unitario sobre `ResolveKey` com um modules.json de fixture cuja raiz e o tenant A e cujo `otherTenants` tem o tenant B - assertar que `ResolveKey("<modulo de B>", "<host de B>")` devolve a chave de B. Esse teste teria apanhado este item hoje.


O `open` exige que o catalogo raiz seja o tenant da sessao; o catalogo snapshots\modules.json e POR TENANT. Editar o catalogo a mao perdeu a seccao do tenant pessoal. A ferramenta so conhece o que o catalogo diz — a listagem nativa (`assets <host>`) e que e verdade.

Prova:

```
"29. Catalogo editado a mao. O tenant raiz do catalogo nao e a sessao do Studio; a sessao e o snapshot dizem o tenant. Trocar seccoes a mao perdeu a seccao pessoal; `assets <host>` reconstroi em 1 s." Estado em disco no dia: "raiz diz `insuranceapp` (57 modulos); o clienttenant esta em `otherTenants` com 206 assets"
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\REPORT.md:268-269, :204-205 e :235-236; C:\Users\andre\SSAM-Hybrid-ODC\docs\ENTREGA-AGORA.md:25

### Catalogo de tenants: politica por tenant e custo de leitura do clienttenant

`armadilha`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** Separar as duas metades. Politica: "clienttenant e SOMENTE LEITURA por CONVENCAO declarada em tenants.json:25/29; nenhum gate da bridge le `readOnly`, so o operador e que o cumpre." Custo: manter "~10s por asset que abre" e "3m43s por asset que nao abre" (ambos reconfirmados no diario), mas trocar a causa de "asset SEM modelo low-code" por "asset que estoura o limite de 180 s do `open` da bridge".
> 
> **Como se soube:** O QUE CONFERE: C:\Users\andre\SSAM-Hybrid-ODC\tenants.json:25 literal - "Tenant de cliente (operadora de saude): SOMENTE LEITURA. Nenhuma escrita, merge, publish ou delete sem autorizacao escrita e por escrito do dono, caso a caso."; :29 `"readOnly": true`; :30 a nota com os numeros. E confere que docs\ENTREGA-AGORA.md:102 diz "o `clienttenant` **nao esta no `tenants.json`**", logo a politica foi mesmo acrescentada depois, no mesmo dia. OS NUMEROS CONFEREM, e ate melhor do que a nota de honestidade sugere: recontei-os no journal\operations.jsonl, relogio de parede entre inicios de `open` consecutivos em 2026-09-17 - assets que abrem: 7.8 / 8.2 / 8.5 / 8.7 / 8.8 / 9.1 / 10.5 / 11.7 / 15.9 / 16.2 s (o "~10s por modulo"); assets que nao abrem: 222.7 / 222.7 / 222.8 / 223.1 / 223.2 s, isto e 3m43s exactos (InAppBrowser Plugin comeca 18:35:27.575, MobileUI comeca 18:39:10.266). O QUE NAO CONFERE, duas coisas: (1) a causa - "Varios tipos de asset nao abrem de todo pela bridge" herda o erro do item "Download de assets ODC por bridge": o discriminante nao e o tipo de asset (ver esse veredicto); (2) "SOMENTE LEITURA" nao e imposto por nada. `readOnly` so aparece em tenants.json:29 em todo o repositorio; facade\lib.mjs:177 `export function tenants() { return readJson(paths.tenants); }` devolve o JSON e facade\mcp.mjs:60-63 (`hybrid_tenants`) so o reporta; studio\builder\Program.cs:67 usa tenants.json apenas para preencher identidade. Nenhum gate da bridge le `readOnly` - um `merge` ou `publish` contra o clienttenant nao seria recusado pela ferramenta.
> 
> **Job que o ancoraria:** Metade nao e provavel por job (e politica humana). A outra metade e: esboco `readonly-tenant-gate.test.mjs` em facade\tests\ - assertar que um comando mutante (`merge`/`publish`/`create`) contra um tenant com `readOnly: true` e recusado antes de tocar no servidor. Hoje esse teste ficaria VERMELHO, porque o gate nao existe - o que e exactamente a informacao que falta nesta pagina.


clienttenant.outsystems.dev e SOMENTE LEITURA (nenhuma escrita, merge, publish ou delete sem autorizacao escrita, caso a caso). Varios tipos de asset nao abrem de todo pela bridge, e o download e lento — o caminho rapido e a API publica, que exige um API client com a permissao 'Asset management > Open'.

Prova:

```
tenants.json: "206 assets. O download pela bridge custa ~10s por modulo e 3m43s por asset SEM modelo low-code (plugins Cordova, WidgetLibrary, ExternalLibrary, ExtensionLibrary, ExternalConnection, AIModelConnection nao abrem). O caminho rapido e a API publica: AssetRepository_ListAssets + AssetRepository_GetAssetRevisionSourceCode". Nota de honestidade: os numeros sao a medicao registada pela propria sessao no tenants.json; nao ha log separado citado.
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\tenants.json:24-31 (o ENTREGA-AGORA.md:102 diz que o tenant nao tinha politica declarada — ja tem, foi acrescentada no mesmo dia)

### Workers: a porta e da FAIXA, a pasta .local e do WORKTREE

`armadilha`

Cada worktree deriva `.local` do seu proprio ROOT, mas a porta do worker nao: e por faixa, com default fixo no script. Duas frentes na mesma faixa fazem uma rodar os jobs no worker da OUTRA, com o codigo e os ficheiros da outra, sem avisar. Contorno provado: processo frio (ANVIL_WORKER='0' e ANVIL_ODC_NO_WORKER='1'), ao custo de ~8 s por job na O11 e ~13 s na ODC contra ~0,4 s com worker quente.

Prova:

```
`ROOT = pathlib.Path(__file__).resolve().parents[1]` e `LOCAL = ROOT / ".local" / "lane-odc"` mas `PORT = int(os.environ.get("ANVIL_ODC_PORT", "4547"))` (odc_worker.py:23,28-29); `PORT = int(os.environ.get("ANVIL_WORKER_PORT", str(LANE.worker)))` (anvil_cli.py:23). Acidente medido: "Get-NetTCPConnection -LocalPort 4547 -> 4547 Listen 32720" e "ProcessId : 32720 CommandLine : dotnet C:\Users\andre\Anvil\.local\lane-odc\cli\anvil-odc.dll serve --port 4547" — worker do repositorio principal, nao do worktree da frente
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-a\BLOCKER.md:9-46; C:\Users\andre\Anvil\scripts\odc_worker.py:23,28-29; C:\Users\andre\Anvil\scripts\anvil_cli.py:23; C:\Users\andre\SSAM-Hybrid-ODC\docs\PLANO-COBERTURA.md:43-53

### Worker de pe segura a DLL e faz o build falhar

`armadilha`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> A primeira passagem tinha dito `confirmado`; caiu na reconferencia.
> 
> **Correccao:** O facto e verdadeiro e vale nas DUAS faixas, mas o remedio esta mais largo que a prova. Texto certo: "`dotnet build` solto com um worker .NET de pe falha: o processo segura o Anvil.Core*.dll (MSB3027). Usar build.py/build_odc.py -- MAS eles so param o worker da porta CORRENTE: um worker orfao noutra porta ou de outro worktree continua a segurar a DLL e faz o PROPRIO build_odc.py falhar (medido em 4567 e 4557). Nesse caso, parar o orfao pelo caminho limpo (odc_worker.stop(<porta>) / worker_process.recover_unresponsive), nunca com kill."
> 
> **Como se soube:** O nucleo do facto CONFIRMA-SE, e com uma prova a mais que o agente anterior nao viu: C:\Users\andre\SSAM-Hybrid-ODC\docs\PROGRESSO-UNIFICACAO.md:122-124 (literal) "o worker residente da faixa (`anvil.dll serve --port 4537`) segura o `Anvil.Core.dll` do worktree e faz o `dotnet build` falhar com `MSB3027`; parar com `worker_process.recover_unresponsive(lane.local, lane.worker)` antes de reconstruir" -- e a medicao na faixa O11, que faltava (a citada no item e so ODC). O que DERRUBA o "confirmado": C:\Users\andre\Anvil\docs\tasks\cobertura-e-relatorio.md:310-315 (literal) "havia um worker ODC orfao da primeira onda (porta 4557) ... segurando `Anvil.Core.Odc.dll` e fazendo `build_odc.py` falhar com `MSB3027` ... Fica o aviso para quem reusar worktrees entre ondas: `build.py` / `build_odc.py` so param o worker da porta **corrente**" (copia identica em SSAM-Hybrid-ODC\lab\cobertura-e-relatorio.md:310-315). E a propria Prova do item e um caso desses: cobertura-t-relatorio.md:546-547 diz "fazia o `build_odc.py` falhar", nao `dotnet build` solto -- ou seja, o comando que o item manda usar como remedio e exatamente o que falhou. Os scripts fazem mesmo stop->build->start (build.py:28,29,36; build_odc.py:27,28,37), mas com `a.port` (default anvil_cli.PORT / odc_worker.PORT=4547, odc_worker.py:28), logo nao alcancam um orfao noutra porta. Correccao a fazer tambem na EVIDENCIA do agente anterior: ele escreveu que 4567 e "a porta de outra frente, ambas listadas em cobertura-t-relatorio.md:548" -- falso; :545 diz que o worker de 4567 era "deste mesmo worktree" e :548 lista as portas que NAO foram tocadas (4517/4547/4617/4647/4627/4657), sem 4567. AGENTS.md:134-135 confere literalmente ("`dotnet build` solto falha com o worker de pe").
> 
> **Job que o ancoraria:** Nao e provavel por job de modelo (jobs sao ops sobre um OML e nao veem processos nem MSBuild). Teste estatico novo em tests/Anvil.Tests/BuildHygieneTests.cs: (1) ler scripts/build.py e scripts/build_odc.py e afirmar que o stop do worker aparece antes do `dotnet build` e o start/ensure depois; (2) afirmar que o argumento de stop e uma UNICA porta (`a.port`), para que o teste falhe no dia em que alguem apagar da documentacao a ressalva de que so a porta corrente e parada. Fica vermelho se alguem devolver o `dotnet build` solto ao caminho documentado.


`dotnet build` solto com o worker da faixa de pe falha: o processo .NET segura o Anvil.Core*.dll. Sempre usar build.py/build_odc.py (que param o worker, constroem e voltam a subi-lo) ou parar o worker pelo caminho limpo, nunca com kill.

Prova:

```
"MSB3027 ... O arquivo e bloqueado por: \".NET Host (55536)\"" — worker ODC orfao da porta 4567 segurando `.local/lane-odc/cli/Anvil.Core.Odc.dll`; AGENTS.md:135: "`dotnet build` solto falha com o worker de pe"
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-t-relatorio.md:545-549; C:\Users\andre\Anvil\AGENTS.md:134-137

### Smart App Control bloqueia todo binario novo desta maquina

`armadilha`

> **OBSOLETO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** O Smart App Control CONTINUA em imposicao (o registo bate ao caracter), mas ja NAO bloqueia binario novo desta maquina: parou de bloquear as 08:31 de 2026-09-17 e desde entao build.py/build_odc.py constroem E o worker sobe. Alem disso a afirmacao sempre foi mais larga do que a prova -- todos os bloqueios registados sao de DLLs do worktree C:\Users\andre\Anvil-cov-b, nenhum do repositorio principal. Texto certo: "Entre as ~08:28 e as 08:31 de 2026-09-17 o Smart App Control bloqueou as DLLs recem-construidas no worktree Anvil-cov-b (build.py compilava com 0 erros e o worker morria no arranque, 0x800711C7). O SAC continua ligado em imposicao, mas desde as 08:31 nao ha um unico bloqueio novo e os builds das 11:38 e das 20:42 do mesmo dia correram. Nao tratar como bloqueio sem reler o log de Code Integrity primeiro."
> 
> **Como se soube:** A PARTE QUE SE CONFIRMA -- li o registo AGORA nesta sessao, HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy: "VerifiedAndReputablePolicyState : 1 / SAC_PreviousState : 2 / SAC_EnforcementReason : 1", identico ao que o item cita, e C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-b\BLOCKER.md:1-54 tem literalmente o exit 3762504530, o 0x800711C7 e o teste do veredicto por conteudo. A PARTE QUE CAIU -- (a) binarios construidos DEPOIS da imposicao correm: C:\Users\andre\Anvil\.local\lane-odc\cli\Anvil.Core.Odc.dll LastWriteTime 9/17/2026 8:42:20 PM e anvil-odc.dll 8:42:21 PM, e o log C:\Users\andre\Anvil\.local\lane-odc\worker-odc-4547-60048.log abre com "anvil-odc worker: ODC Studio 1.7.24.10718 ..." / "anvil-odc worker: ouvindo em 127.0.0.1:4547 pid 60048" e tem 328.505 bytes de ops ate as 9:32:28 PM -- worker nascido DAQUELE build; idem worker-odc-4567-44064.log (pid 44064) ate as 10:15:51 PM. (b) na faixa O11, .local\cli\anvil.dll e 9/17/2026 11:38:26 AM (tambem pos-imposicao) e .local\worker-4517-startup.log so tem `{"ok": true, "command": "serve", ...}`, com .local\worker-4517.json a apontar `{"pid": 40796, ...}`. (c) decisivo: Get-WinEvent -LogName 'Microsoft-Windows-CodeIntegrity/Operational' -MaxEvents 40 devolve os 40 eventos MAIS RECENTES e todos sao de 8:29:06 a 8:31:03 AM de hoje -- zero bloqueios depois das 08:31 -- e cada 3077 nomeia "\Users\andre\Anvil-cov-b\.local\lane-ss5\cli\anvil.dll" ou "...\cli-try\anvil.dll", nunca C:\Users\andre\Anvil.
> 
> **Job que o ancoraria:** Nao e provavel por job nem por teste do repositorio: e estado da maquina (registo do Windows + log de Code Integrity), nao do codigo. O lugar certo e um doctor de ambiente (scripts/, ao lado do ssam_doctor): ler VerifiedAndReputablePolicyState e perguntar ao log se ha algum evento 3077/3118 mais recente que o binario da faixa; enquanto nao houver, o item nao deve ser lido como bloqueio. Um job nunca poderia prova-lo.


Desde 2026-09-17 de manha o Smart App Control passou de avaliacao para imposicao: build.py/build_odc.py compilam com 0 erros e o worker morre no arranque. Binarios anteriores continuam a correr (veredicto ja em cache, por CONTEUDO: copiar um permitido continua permitido). Mexer na politica nao e alcada de um agente; desligar o SAC exige reinstalar o Windows depois. Confirmado ainda ligado nesta sessao.

Prova:

```
"RuntimeError: worker startup failed (exit 3762504530)" e "System.IO.FileLoadException: Could not load file or assembly ... Uma politica de Controle de Aplicativo bloqueou este arquivo. (0x800711C7)"; CodeIntegrity 3077 (Policy ID:{0283ac0f-fff1-49ae-ada1-8a933130cad6}) e 3118. Registo lido agora por esta sessao: VerifiedAndReputablePolicyState : 1 / SAC_PreviousState : 2 / SAC_EnforcementReason : 1
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-b\BLOCKER.md (ficheiro inteiro); releitura de HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy nesta sessao

### Pastas de trabalho: tests/jobs* e varrido pelos GuideTests

`armadilha`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> A primeira passagem tinha dito `confirmado`; caiu na reconferencia.
> 
> **Correccao:** Duas bordas estao mais largas do que o codigo. (1) Nao e "qualquer pasta debaixo de tests/": `Directory.GetDirectories(Path.Combine(Root,"tests"),"jobs*")` so apanha filhas DIRETAS de tests/ (nao ha SearchOption.AllDirectories na chamada de pastas; so na de ficheiros). Uma tests/archive/jobs-old NAO e varrida. (2) A recusa de sufixo de versao vale em tests/ EXCETO tests/jobs-cold. Texto certo: "Qualquer pasta filha DIRETA de tests/ cujo nome comece por 'jobs' entra nos GuideTests ... o runner recusa nome de job com sufixo de versao dentro de tests/, exceto em tests/jobs-cold".
> 
> **Como se soube:** O nucleo confere literalmente: GuideTests.cs:55 e :82, identicas, "foreach (var dir in Directory.GetDirectories(Path.Combine(Root, \"tests\"), \"jobs*\"))", cada uma seguida de "foreach (var path in Directory.GetFiles(dir, \"*.json\", SearchOption.AllDirectories))" -- repare que o AllDirectories esta no GetFiles, NAO no GetDirectories: e dai que vem a borda (1). Borda (2), literal em C:\Users\andre\Anvil\src\Anvil.Core\Kernel\JobRunner.cs:120: "if (full.Contains(Path.DirectorySeparatorChar + \"jobs-cold\" + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return;", com o proprio doc comment :111-112 a dize-lo ("Vale para jobs dentro de `<repo>/tests/`, exceto `tests/jobs-cold` ate serem consolidados") -- e GuideTests.NoJobIsAVersionedCopy:39 varre so "jobs", "jobs-negative", "jobs-live", nem sequer jobs-odc. Nem o item nem o AGENTS.md:122 dizem isto. O resto confere no disco e no codigo: tests/ tem jobs, jobs-cold, jobs-live, jobs-negative, jobs-odc, jobs-odc-negative (nenhuma outra casa jobs*), e o arquivo e tests\archive\incidents\ com 96 .json e tests\archive\README.md; a politica de base/producer esta em JobSources.cs:28-59 -- "points to an OML outside tests/fixtures (a file another run rewrites). Use job:<name>, a fixture, or bind a snapshot on the command" (:58-59), com job: em :35-36 e binding em :28-33; CheckJobName esta mesmo no caminho do runner (Anvil.Cli/Program.cs:563, Anvil.Cli.Odc/Program.cs:98, JobRunner.cs:143 e :232, Delivery.cs:56), logo "o runner recusa" e literal. PROGRESSO-UNIFICACAO.md:251-252 confere a frase citada na Prova.
> 
> **Job que o ancoraria:** Ja ancorado no essencial por GuideTests.NoJobPointsAtMutableOml e GuideTests.EveryJobHasAValidMessageContract (tests/Anvil.Tests/GuideTests.cs:51-85). O que fica sem rede sao as duas bordas. Teste novo GuideTests.TheVersionSuffixRuleExemptsOnlyJobsCold: afirmar que JobRunner.CheckJobName(tests/jobs-cold/x-v2.json) NAO atira e que CheckJobName(tests/jobs/x-v2.json) atira com "version suffix" -- fixa a isencao que hoje so existe no codigo. E GuideTests.ArchiveIsNotSweptByTheJobTests: afirmar que Directory.GetDirectories(tests,"jobs*") nao contem tests/archive e que tests/archive/README.md existe.


Qualquer pasta debaixo de tests/ cujo nome comece por 'jobs' entra nos GuideTests. Por isso a pasta de arquivo NAO pode chamar-se jobs*: foi criada como tests\archive\incidents\. Alem disso o runner recusa nome de job com sufixo de versao dentro de tests/, e base/producer so aceitam fixture em tests/fixtures, job:<nome> ou snapshot ligado no comando (caminho .local e recusado).

Prova:

```
`foreach (var dir in Directory.GetDirectories(Path.Combine(Root, "tests"), "jobs*"))` em GuideTests.cs:55 e :82; "A pasta nao pode chamar-se `jobs*`: GuideTests.NoJobPointsAtMutableOml e EveryJobHasAValidMessageContract varrem `tests\jobs*`"; recusa de nome: "job 'x-v2' has a version suffix ..."
```

Visto em: C:\Users\andre\Anvil\tests\Anvil.Tests\GuideTests.cs:55,82; C:\Users\andre\SSAM-Hybrid-ODC\docs\PROGRESSO-UNIFICACAO.md:250-254; C:\Users\andre\Anvil\AGENTS.md:121-125

### Pastas de trabalho: produtores sem cache entre corridas

`limite-do-kernel`

Cada corrida cria uma pasta de produtores nova (GUID) debaixo do WorkDirectory e nunca reutiliza saidas de outra corrida. Dentro da mesma corrida um job base e construido uma vez. Consequencia: `base: job:x` recompila x a cada corrida — nao contar com cache, e nunca apontar uma base para um ficheiro de trabalho em .local (foi essa a causa de 24 falhas da suite).

Prova:

```
`private readonly string work = Path.Combine(host.WorkDirectory, "producers", Guid.NewGuid().ToString("N"));` com o comentario "Cache e deteccao de ciclos por execucao; nunca reutiliza saidas de outra corrida" (JobRunner.cs:200-204); falha tipica: "base 'C:\Users\andre\Anvil\.local\work\deliver\<chave>\foreign.oml' points to an OML outside tests/fixtures (a file another run rewrites)" (24 testes)
```

Visto em: C:\Users\andre\Anvil\src\Anvil.Core\Kernel\JobRunner.cs:200-227; C:\Users\andre\SSAM-Hybrid-ODC\lab\ws4-html-visual\BLOCKER.md:32-36

### Suite completa O11: o que 'verde' significa hoje

`armadilha`

> **CONFIRMADO** (passagem adversarial, 2026-09-17)
> 
> **Como se soube:** Todos os quatro numeros citados existem literalmente onde o item diz. (1) Base: C:\Users\andre\SSAM-Hybrid-ODC\lab\ws4-html-visual\BLOCKER.md:25 e C:\Users\andre\Anvil\docs\tasks\ws4-relatorio.md:15: "Com falha! - Com falha:   151, Aprovado:  1005, Ignorado:     0, Total:  1156, Duracao: 25 m 27 s - Anvil.Tests.dll (net8.0)". (2) A regra de aceitacao esta escrita: mesmo BLOCKER.md:11-13 "A regra 1.8 ... redefine \"verde\" como o mesmo conjunto de falhas do `anvil`, nenhuma nova". (3) Pos-arquivamento: C:\Users\andre\SSAM-Hybrid-ODC\docs\PROGRESSO-UNIFICACAO.md:255-257 "suite completa -> 1111 testes, 58 falhas (eram 1207 e 151): sobraram 52 ScreenCoverageTests ... e 6 de catalogo/C# temporal". (4) Pos-consertos de 11:40: PROGRESSO-UNIFICACAO.md:333-335 "suite O11 completa antes destes consertos 1134 testes, 6 falhas ... e depois deles 4 falhas, todas no tradutor de C#". (5) Os grupos das 151 batem a soma 90+52+3+6=151 em C:\Users\andre\SSAM-Hybrid-ODC\lab\int-vermelhos.md:8-13. (6) O .gitignore e mesmo deliberado: linhas 11-13 de C:\Users\andre\Anvil\.gitignore sao "!tests/**/fixtures/*.oml" / "# Local OutSystems UI producer libraries" / "/tests/fixtures/outsystems-ui.oml" / "/tests/fixtures/outsystems-ui-web.oml" -- re-ignoradas logo DEPOIS da excecao; `git check-ignore -v` devolve ".gitignore:12" e ".gitignore:13" para as duas e `git ls-files tests/fixtures/` nao as lista. (7) "o teste falha em vez de dizer que a fixture nao veio" continua verdade no codigo de hoje: tests\Anvil.Tests\ScreenCoverageTests.cs nao tem uma unica ocorrencia de Skip nem de File.Exists -- a linha :30 monta o caminho da fixture e :37/:44 entregam-no ao JobRunner, que atira. NAO RE-CORRI A SUITE (instrucao de leitura apenas), por isso o numero de hoje e o de :334 (4 falhas), nao uma medicao minha -- e e exatamente isso que o item manda fazer. Nota util a acrescentar, que nao contradiz nada: as duas fixtures JA ESTAO nesta maquina (CreationTime 9/17/2026 9:28:22 AM, 4,9 MB e 3,54 MB), e e isso que explica ao caracter o 58 -> 6; quem vier procurar os 52 vermelhos aqui nao os encontra.
> 
> **Job que o ancoraria:** Nao e provavel por job: o facto E a suite. O que falta e a rede que o proprio inventario propoe em int-vermelhos.md:34-37 e nunca foi feita: ScreenCoverageTests.EveryMatrixRowHas... passar a Skip com motivo quando a fixture do produtor nao existe (o padrao que JobTests ja usa quando nao ha Service Studio), em vez de falhar. Com isso, 'verde' volta a significar verde numa maquina limpa e o item perde metade da razao de existir. Enquanto nao houver, o unico ancoradouro honesto e o par de numeros datados que o item ja traz.


A suite O11 nunca esteve verde nesta maquina e a regra de aceitacao e 'as mesmas falhas, nenhuma nova'. O numero mudou tres vezes num dia — nao comparar contra um numero decorado, medir a base antes de tocar em ficheiro. As fixtures outsystems-ui.oml e outsystems-ui-web.oml estao ignoradas de PROPOSITO no .gitignore e o teste falha em vez de dizer que a fixture nao veio.

Prova:

```
"Com falha! - Com falha: 151, Aprovado: 1005, Ignorado: 0, Total: 1156, Duracao: 25 m 27 s" (WS4, base); depois do arquivamento dos 96 jobs incidents-*/inspect-*: "suite completa -> 1111 testes, 58 falhas (eram 1207 e 151)"; apos os consertos de 11:40: "suite O11 completa antes destes consertos 1134 testes, 6 falhas ... e depois deles 4 falhas, todas no tradutor de C#". Grupos das 151: 90 JobTests corpus incidents-*, 52 ScreenCoverageTests por fixture ausente, 3 GuideTests, 6 catalogo/C# temporal
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\ws4-html-visual\BLOCKER.md:9-49; C:\Users\andre\SSAM-Hybrid-ODC\lab\int-vermelhos.md:1-13 e :29-32; C:\Users\andre\SSAM-Hybrid-ODC\docs\PROGRESSO-UNIFICACAO.md:241, :255-257 e :333-335

### IsDerived e o registo de exemplo do ODC (bug ja corrigido)

`diferenca-entre-faixas`

CORRIGIDO — nao voltar a reportar. O registo de exemplo de uma entidade chama-se SampleRecord no O11 e IRecord/IRecordAttributeValue no ODC; sem a linha equivalente, na faixa ODC nenhum atributo de entidade podia ser apagado sem force, mesmo sem um unico consumidor de autoria.

Prova:

```
Sintoma entao: "op #46 (delete ): InvalidOperationException: delete: refused, IEntityAttribute 'Body' is used by 1 consumer(s): IServerEntity:WfProofNotice/IRecord/IRecordAttributeValue (list them with usages, fix or remove those usages, or pass \"force\": true to break them)". Conserto presente: `return t.Contains("AttributeReference") || t.Contains("SampleRecord") || t.Contains("RecordAttributeValue") || ...` (Verbs.cs:1049)
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\cobertura-a\BLOCKER.md:50-89; conserto em C:\Users\andre\Anvil\src\Anvil.Core\Kernel\Verbs.cs:1042-1050

### Vocabulario: o nome da API nao e o nome do produto (ODC)

`diferenca-entre-faixas`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** Cortar `, e no ODC nao e aviso, e ERRO`. O que muda entre faixas e SO o vocabulario: mesma id, mesma severidade (Error), texto `public`/`Invalid Public Action` no O11 e `shareable`/`Invalid Shareable Action` no ODC. Precisao menor no mesmo paragrafo: o nome do produto para UMA Site Property e `Setting` (singular); `Settings` e a pasta da scope tree e o prefixo da expressao. E `ModelFeature_WriteableSiteProperties_Removed` nao e uma marca de modelo ao lado das outras -- e um VerifyMessageId (VerifyMessageId.cs:1116), mapeado para a marca em ModelFeaturesVerifyMessagesManager.cs:53.
> 
> **Como se soube:** A metade do vocabulario confirma-se (ver o item Site Property = Setting). A cauda da afirmacao -- NAO-DA.md:1403, `a propriedade Public chama-se 'shareable' nas mensagens, e no ODC nao e aviso, e ERRO` -- e falsa: C:\Users\andre\ODC3\decompiled\o11\ServiceStudio.Framework\ServiceStudio.Framework.Verify.Generated.VerifyMessageIdResources.Generated.resx:157 -- `InvalidPublic_ActionParameterNotPublic|Error|Invalid Public Action|The Action '{0}' is public but its parameter ...` contra C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\OutSystems.Model.Verify.Generated.VerifyMessageIdResources.Generated.resx:186 -- `InvalidPublic_ActionParameterNotPublic|Error|Invalid Shareable Action|The Action '{0}' is shareable but its parameter ...`. Os dois dizem `|Error|`. A propria pagina ja regista isto como contestado em NAO-DA.md:509.
> 
> **Job que o ancoraria:** Nao ha job e a correccao mata a necessidade de um do lado da severidade. O que resta provavel por job e so o nome da API: tests/jobs-odc/security-settings.json (cria ISiteProperty). Para fechar a severidade de vez, o par de jobs descrito no item InvalidPublic_ActionParameterNotPublic.


A API publica do ODC manteve nomes que o produto ja nao usa: ISiteProperty na API e 'Settings' na interface; a propriedade Public chama-se 'shareable' nas mensagens, e no ODC nao e aviso, e ERRO. No job usa-se o nome da API (e o que compila); na documentacao, o nome do produto, senao uma sessao fria procura na interface por um nome que nao existe.

Prova:

```
Marca de modelo `ModelFeature_SitePropertiesRefactoredToSettings` na OutSystems.Model.dll do ODC Studio, ao lado de `ModelFeature_SitePropertiesSupportsSecretsO11` e `ModelFeature_WriteableSiteProperties_Removed`; mensagem do Verify: "InvalidPublic_ActionParameterNotPublic: ... is shareable but its parameter ... is not shareable"
```

Visto em: C:\Users\andre\Anvil\docs\tasks\2026-09-17-ws1-diferencas.md:69-80

### Aggregate com nome padrao do Studio e renomeado sozinho

`armadilha`

> **CONFIRMADO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** Trocar a `Prova:` (citacao do AGENTS.md) pelo codigo. E afinar dois pontos: (a) o gatilho nao e so o nome padrao -- a condicao e `HasDefaultName() || Name == "Get" + <PluralBonito>`, logo bate tambem num aggregate baptizado a mao com exatamente esse nome; (b) o filtro tem de ser `<atributo> <op> <expressao>` (IsFilterByAttribute, Nodes.cs:6096-6118) e, se o atributo filtrado for o IDENTIFICADOR da entidade, o nome novo usa o SINGULAR: Get<Entidade>By<Id>, nao o plural.
> 
> **Como se soube:** A `Prova:` que estava la era circular (a pagina a citar AGENTS.md:280-281, que diz o mesmo sem nenhuma medicao). A prova real esta no Studio: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Model\Nodes.cs:6121-6139 -- `internal void OnFilterConditionChanged(Filter filter) { if (base.OwnerESpace.IsUpgrading || !IsFilterByAttribute(filter, out var attr)) { return; } AbstractEntity abstractEntity = (AbstractEntity)attr.ParentRecord; if (HasDefaultName() || Name == "Get" + abstractEntity.GetPrettyNamePlural()) { if (attr == abstractEntity.GetIdentifier()) { SetName("Get" + abstractEntity.GetPrettyName() + "By" + abstractEntity.GetIdentifier().Name.ToPascalCase()); } else { SetName("Get" + abstractEntity.GetPrettyNamePlural() + "By" + attr.Name.ToPascalCase()); } } }`. Bate letra a letra com o exemplo: GetTeamMembers + filtro por TeamId (que nao e o identificador) -> "Get"+"TeamMembers"+"By"+"TeamId". O mesmo bloco esta em Nodes.cs:23529-23533.
> 
> **Job que o ancoraria:** Nao existe -- hoje os jobs so CONTORNAM (tests/jobs-odc/aggregate-full.json:45 escolhe `WfGetOrdersByCustomer` com um _why que explica o contorno), e contornar nao prova. Esboco do job que provaria, em tests/jobs-odc: `aggregate-default-name-renames.json` -- create IAggregateNode com name `GetWfCovOrders` (exatamente "Get"+plural da entidade), create IAliasedSource, create IFilter com args.condition `WfCovOrder.CustomerId = <input>`, e depois `{"op":"get","target":"$agg"}`; o contrato de dados prende `Name` em `GetWfCovOrdersByCustomerId`. Um segundo job com filtro pelo Id provaria a variante singular.


Nao dar ao aggregate o nome padrao do Studio (Get<Entidade>s): ao receber um filtro ele e renomeado sozinho (GetTeamMembers -> GetTeamMembersByTeamId) e as expressoes que o citam quebram. Usar outro nome (GetMembersOfTeam).

Prova:

```
AGENTS.md:280-281: "Nao de ao aggregate o nome padrao do Studio (`Get<Entidade>s`, ex. GetTeamMembers): ao receber filtro ele e renomeado sozinho (GetTeamMembersByTeamId) e as expressoes que o citam quebram"
```

Visto em: C:\Users\andre\Anvil\AGENTS.md:280-281

### Funcoes de expressao: so as 121 do catalogo do Studio

`recusa-da-plataforma`

> **IMPRECISO** (passagem adversarial, 2026-09-17)
> 
> **Correccao:** "So as funcoes do catalogo do Studio CARREGADO: 121 no SS11 11.55.87 (docs/functions.md), 128 no ODC Studio -- as mesmas 121 mais NullFile, Size, MIMEType, IsTemp, IsOwnedByCurrentApp (File), GetAppName (Organization) e CheckEndUserRole (Roles). docs/functions.md e o catalogo do O11 e nao serve de lista fechada para um job ODC." A mesma correccao e devida em AGENTS.md:266 ("SO as 121 de docs/functions.md").
> 
> **Como se soube:** 121 e o numero da faixa O11, nao do ODC. Contagem sobre o Studio decompilado (leitura permitida): `Select-String 'new BuiltinFunctionDescriptor'` da 121 em C:\Users\andre\ODC3\decompiled\o11\ServiceStudio.Framework\ServiceStudio.Scope\BuiltinFunctions.cs e 128 em C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Scope\BuiltinFunctions.cs. O diff sao 7 nomes que so o ODC tem: NullFile, Size, MIMEType, IsTemp, IsOwnedByCurrentApp, GetAppName, CheckEndUserRole -- todos `functions.Add(new BuiltinFunctionDescriptor(...))` incondicionais (ex. L982 NullFile, L1098 MIMEType, L1246 GetAppName, L1298 CheckEndUserRole) e nenhum aparece em C:\Users\andre\Anvil\docs\functions.md (cujo cabecalho diz 'Service Studio 11.55.87' e tem exactamente 121 linhas de tabela). O catalogo e lido em runtime do Studio carregado -- FunctionCatalog.cs:37 `All => _all ??= Extract()` e :83 `foreach (var d in ServiceStudio.Scope.BuiltinFunctions.Functions)` -- logo na faixa ODC o proprio runner ja aceita as 128, e o `Hint UnknownFunction` (ExpressionCheck.cs:61 `FunctionCatalog.Names.Contains(name)`) nunca as acusaria.
> 
> **Job que o ancoraria:** Nao existe: o unico exemplo negativo e da faixa O11 (tests/jobs-negative/unknown-function.json; nao ha equivalente em tests/jobs-odc-negative). Dois jobs novos: (a) tests/jobs-odc/odc-only-functions.json com uma expressao a usar MIMEType(...) e NullFile() sobre um atributo File, que tem de fechar isValid=True e ZERO linhas de Hint UnknownFunction -- prova que o catalogo ODC nao e o do O11; (b) tests/jobs-odc-negative/unknown-function.json com Right( para fixar o Hint tambem na faixa ODC. Em C#, um teste FunctionCatalogTests que afirme Count por faixa (121 vs 128) em vez de um numero unico.


Nomes de outras linguagens nao existem (Right, Left, Mid, Len, ToText, ToString, Now, Today, IIf, DateDiff...). O runner devolve um Hint deterministico ANTES do Verify, com as parecidas.

Prova:

```
"Hint UnknownFunction: 'X(' nao existe ...; parecidas: A, B" (checagem deterministica contra o catalogo de funcoes lido do proprio Studio); exemplo negativo tests/jobs-negative/unknown-function.json
```

Visto em: C:\Users\andre\Anvil\AGENTS.md:266-269 e :140-141

### Widget nasce com texto padrao e icone precisa de Weight

`armadilha`

> **CONFIRMADO** (passagem adversarial, 2026-09-17)
> 
> **Como se soube:** As duas metades estao no codigo, nao so na nota. C:\Users\andre\SSAM-Hybrid-ODC\studio\shared\AuthoringUi.cs:15-19, literal: "// ---- Captions. A button, link or label created by CreateWidget already carries a default Text widget // (\"Button\", \"Save\", \"label\"); the caption replaces that text instead of adding a second one beside it. // Lesson from 16/09: an Expression added next to the default text rendered as \"Button Drop pin here\"." + `var caption = content.Children.OfType<ITextWidget>().FirstOrDefault() ?? Widget<ITextWidget>(content, "Text");`. E AuthoringUi.cs:108-111: "// Icon names are Phosphor 2.0 names (...); the weight is part of the lookup, so it is // never left empty: without it the Studio reports \"Non Existing Icon\" (live warning seen on 16/09)." + `public static W.IIcon Icon(IObject parent, string name, string icon, string css = "", string weight = "regular")`. O REPORT.md citado confere: :197 "botão com \"Button Drop pin here\"", :266-267 e :274-276.
> 
> **Job que o ancoraria:** Nenhum job cobre isto (e caminho do builder do SSAM, nao da linguagem de jobs). Dois anchors possiveis: (a) na feature do lab, manter a checagem "exactly one caption" que REPORT.md:207 ja cita, promovida a teste; (b) um job tests/jobs-odc/icon-weight.json que crie um IIcon SEM Weight e declare em expectedMessages que o headless NAO ve o aviso -- fixando por escrito que este defeito so aparece ao vivo e por isso o gate de merge e a unica rede. Convem a pagina notar que ambos ja estao defendidos no codigo (Caption substitui; Icon grava 'regular' por defeito), senao le-se como armadilha ainda aberta.


Botao, link e label criados por CreateWidget ja nascem com um TextWidget ('Button', 'Save', 'label'): pôr uma Expression ao lado duplica a legenda, e sem renderizacao o defeito so aparece na tela do usuario. E o nome de um icone Phosphor 2.0 so resolve junto com o Weight — sem ele o Studio emite 'Non Existing Icon' AO VIVO, um aviso que o builder headless nao ve e que faz o gate recusar o merge.

Prova:

```
REPORT.md:266-267: "Botao, link e label criados por `CreateWidget` ja tem um `TextWidget` (\"Button\", \"Save\", \"label\"); `Caption` o substitui. Sem renderizacao, o defeito so aparece na tela do usuario"; REPORT.md:274-276: "sem ele o Studio emite \"Non Existing Icon\" ao vivo, e o gate de validacao recusa o merge por um aviso que o builder headless nao ve". Resultado errado observado: botao com "Button Drop pin here"
```

Visto em: C:\Users\andre\SSAM-Hybrid-ODC\lab\REPORT.md:196-208 e :266-277



Uma Data Action do ODC NAO pode ter parametros de entrada. Tem saidas e mais nada. Por isso so serve para dados
que o servidor obtem sozinho -- configuracao, dados de referencia, ou o que depende do utilizador autenticado.
Uma tela cujo estado vive em client variables nao pode alimentar uma Data Action: as client variables sao do
cliente, o corpo da Data Action corre no servidor, e nao ha por onde passar nada.

Prova:

```
1) Sonda pelo modelo (jobs/probe-dataaction-input.json, criar IDataAction com inputs):
   InvalidOperationException: IDataAction 'ProbeDataActionWithInput' cannot create IInputParameter
   (no Create method in the API)

2) A interface, em C:\Users\andre\ODC3\decompiled\v1\OutSystems.Model.V1.decompiled.cs:12287
   public interface IDataAction : IFlow, ...
   {
       [Property] DataSourceFetch Fetch
       [Children] ISequence<ILocalVariable>   LocalVariables
       [Children] IEnumerable<IActionNode>    Nodes
       [Child]    IUILifeCycleEvent           OnAfterFetch
       [Children] ISequence<IOutputParameter> OutputParameters
       ILocalVariable  CreateLocalVariable(...)
       IActionNode     CreateNode(...)
       IOutputParameter CreateOutputParameter(...)
       // nao existe InputParameters. nao existe CreateInputParameter.
   }

3) Confirmacao empirica no Quotes (insuranceapp): as tres Data Actions do modulo
   -- PropertyCoverage/GetScreenData (18 saidas), Location/GetGoogleKey, Location/GetPropertyDetails --
   tem TODAS zero entradas. Nao e estilo: e a unica forma possivel.
```

Cuidado com a prova fraca: a primeira coisa que observei foi "a GetScreenData nao tem nenhuma referencia a
Client.*", e usei isso para declarar o limite. Isso nao provava nada -- ela nao tem entradas NENHUMAS, logo
nunca leria o que quer que fosse. Declarar um limite a partir da ausencia de um exemplo e o erro; a sonda de um
minuto e a interface decompilada sao a prova.

Visto em: sessao ODC3/Quotes de 2026-09-18, ao tentar mover a moldagem de dados da tela Options para Data
Actions. Registado tambem em SSAM-Hybrid-ODC\docs\FRICCAO-QUOTES-REFACTOR.md problema 17.

## Piloto de contratos partilhados (fase 2, 2026-09-23): static entities, registos, structures e atributos, medido nas DUAS faixas

### Apagar uma static entity: sem force e recusada (provado); com force e um comportamento observado com integridade NAO comprovada, nao a via normal (as duas faixas)

`armadilha`

Mesmo sem nenhum consumidor de autor, uma static entity (como qualquer entidade) traz o IAnonymousStructure `<Nome> Record`
gerado pela plataforma, cujo IAttribute a cita; o kernel nao o classifica como derivado, por isso o `delete` sem force e
recusado a nomea-lo (recusa provada). Com force o delete e aceite (brokenConsumers 1, a entidade some do `find`), mas o atributo
anonimo sobrevive com DataType null e o Verify nao o assinala: a ausencia de mensagens NAO e prova de integridade. Fica registado
como comportamento observado (fechamento da fase 2, 2026-09-23), separado da aplicabilidade: apagar a entidade e `undetermined`
nas duas faixas, e force nao e recomendado como via normal. Falta verificar: o que resta da estrutura anonima e do seu atributo,
o efeito na publicacao (nenhuma entrega foi corrida). Apagar um REGISTO sem consumidores continua provado sem force.

Prova:

```
ODC: "delete: refused, IStaticEntity 'WfClaimStage' is used by 2 consumer(s): IAnonymousStructure:WfClaimStage Record/IAttribute:WfClaimStage; IServerEntity:WfClaimFile/IEntityAttribute:StageId/ITextBasedExpression (...)". O11: "delete: refused, IStaticEntity 'ContactStatus2' is used by 1 consumer(s): IAnonymousStructure:ContactStatus2 Record/IAttribute:ContactStatus2". Depois do force (O11): get IAttribute:ContactStatus2 -> WasDeleted False, DataType null; validation.unexpected [].
```

Visto em: tests/jobs-odc-negative/delete-static-entity-in-use.json; tests/jobs-odc/static-record-refactor.json (ops 5d-6); tests/jobs/static-record-refactor.json (ops 18-20)

### Registos de static entity nao se movem: a ordem de leitura e o valor de Order (as duas faixas)

`recusa-da-plataforma`

`IStaticEntity.Records` nao e uma ISequence; o verbo `move` recusa e lista as sequencias do pai (Attributes, Metadata). No O11 o
`dump` enumera os registos numa ordem que muda entre corridas. A alternativa provada e `set <registo>/Order prop Value`.

Prova:

```
ODC: "move: IStaticEntity 'WfClaimStage' does not keep IStaticEntityRecord 'Closed' in an ordered sequence, so there is no order to change (the Studio lists that kind by itself). Sequences of this parent: Attributes, Metadata". O11: a mesma mensagem com IRecord 'Active'.
```

Visto em: tests/jobs-odc-negative/move-static-record.json; tests/jobs-negative/move-static-record.json

### O rename de um registo de static entity e recusado (IStaticEntityRecord no ODC, IRecord no O11); `set Identifier` em colisao sufixava em silencio e o kernel recusa desde 2026-09-23

`recusa-da-plataforma`

O nome de um registo de static entity e a propriedade Identifier (o `rename` recusa com "has no Name" nas duas faixas: IStaticEntityRecord
no ODC, IRecord no O11). O setter nativo chama SetName, que passa por AbstractObject.NameClash e sufixa (Received2) sem avisar. O kernel
passou a conferir o NameClash antes de escrever, como o `rename` ja fazia.

Prova:

```
ODC: "set Identifier: 'Received' clashes with an existing name in that scope (the Studio would use 'Received2'); pick another identifier". O11: "set Identifier: 'Active' clashes with an existing name in that scope (the Studio would use 'Active2'); pick another identifier". Rename: ODC "IStaticEntityRecord 'UnderReview' has no Name"; O11 "IRecord 'Active' has no Name".
```

Visto em: src/Anvil.Core/Kernel/Verbs.cs (Set, guarda de Identifier); tests/jobs-odc-negative/set-identifier-clash.json; tests/jobs-negative/set-identifier-clash.json; tests/jobs-odc-negative/rename-static-record.json; tests/jobs-negative/rename-static-record.json

### `replace` de uma structure reaponta ate o registo anonimo, e o delete da origem deixa um registo anonimo orfao (as duas faixas)

`armadilha`

Reapontar `IStructure:A -> B` reescreve os consumidores tipados (parametros, atributos aninhados) E o IAttribute do `A Record` anonimo,
por isso A fica com 0 consumidores e apaga-se sem force. O `A Record` sobrevive ao delete de A, renomeado `B Record`, a apontar para B:
B fica com dois registos anonimos (usages conta dois IAttribute). O Verify nao o assinala. Classificacao (fechamento da fase 2):
o REAPONTAMENTO esta provado (0 consumidores em A, todos em B) e o delete de A esta provado (objeto removido, 0 consumidores partidos);
a LIMPEZA completa nao esta provada (registo anonimo orfao, efeito na publicacao nao avaliado) e fica como comportamento observado.

Prova:

```
ODC: replace consumers 7 rewired 7 stillPointingAtFrom 0 consumersOfTo 11; usages WfCovLocation count 0; delete brokenConsumers 0; usages WfCovSite byType {IAttribute:2, ...}. O11: replace consumers 4 rewired 4 consumersOfTo 5; delete ProductCard brokenConsumers 0; find 'ProductCardCopy' -> IStructure + 2 IAttribute.
```

Visto em: tests/jobs-odc/structure-refactor.json (ops 3b-4d); tests/jobs/structure-refactor.json (ops 14-27)

### Contrato de dados: valor de registo escrito antes de mudar o Identifier desse registo no mesmo job

`limite-do-kernel`

Uma assercao do contrato de dados ancora o primeiro segmento por chave e re-resolve o resto pelo NOME no fim do job. Um `set` em
`IStaticEntity:E/Registo/Label` seguido de `set Identifier` desse registo faz o job reprovar no contrato com o modelo correcto.
Contorno provado: enderecar o valor como `IRecord:<Registo>/<Atributo>` (ancora na chave do registo).

Prova:

```
O11: "Data property mismatch: ... expected \"Not active\", actual: unavailable: KeyNotFoundException: IStaticEntity 'ContactStatus' has no child 'Inactive'" (primeira corrida, accepted=false); com IRecord:Inactive/Label o contrato aceita (9 assercoes).
```

Visto em: tests/jobs/static-entity-lifecycle.json (ops 16-17, 25-28); src/Anvil.Core/Kernel/DataAssertions.cs (DataAssertionReference)

### Diferencas medidas entre faixas na familia (2026-09-23)

`diferenca-entre-faixas`

(1) O registo e IStaticEntityRecord no ODC e IRecord no O11 (o job pede IRecord nas duas); o valor do registo e uma ExpressionDefinition
gravavel no ODC (liga por chave) e um IExpression so de leitura no O11 (o kernel escreve o Text). (2) `get` de um IStructureAttribute no
O11 nao expoe IndexInParent (no ODC expoe: 4 -> 0 depois do move); a ordem le-se no `order` do resultado do move e no dump nas duas.
(3) A ordem dos consumidores na mensagem de recusa do delete muda entre corridas: os jobs negativos nomeiam cada caminho como fragmento
proprio, ou so a contagem. O que NAO e diferenca, apesar de parecer: o `duplicate` de uma structure herda Public e Description nas duas
faixas (ODC WfCovLocation2 Public/Shareable True; O11 ProductCard2 Public True).

Prova:

```
O11 structure-refactor: duplicate -> Public True, Description copiada; get Sku sem IndexInParent; move -> order ["Sku","Title","Price"]. ODC structure-refactor: get WfCountry IndexInParent 4 -> 0; get WfCovLocation2 Public True Shareable True.
```

Visto em: tests/jobs/structure-refactor.json; tests/jobs-odc/structure-refactor.json; tests/jobs-negative/delete-structure-in-use.json

## Lote de dados (fase 3, 2026-09-23): entidades, atributos, identificadores e indices, medido nas DUAS faixas

### Toda FK nasce com um AutoIndex_<Atributo>; reapontar a FK arrasta o AutoIndex antigo e o Verify recusa os dois indices iguais (as duas faixas)

`armadilha`

A plataforma cria um indice `AutoIndex_<Atributo>` para cada atributo `<Entidade> Identifier`. Esse indice conta como consumidor do
atributo (o `delete` da FK e recusado ate o AutoIndex sair; sem force, primeiro `delete EntityIndex:AutoIndex_<Atributo>`). Um
`replace` de FK antiga -> FK nova reaponta TAMBEM o AutoIndex antigo, que passa a cobrir o mesmo atributo que o AutoIndex da nova:
o Verify da `InvalidEntityIndex_DupIndexes` ate o AutoIndex antigo ser apagado. Um indice explicito com a mesma composicao de um
AutoIndex nao duplica: a plataforma promove o AutoIndex (mesma chave, nome novo).

Prova:

```
ODC entity-refactor: replace PriorityId -> PriorityId2 rewired 2 (o filtro E o AutoIndex); find AutoIndex_PriorityId ainda existe sobre PriorityId2; delete EntityIndex:AutoIndex_PriorityId brokenConsumers 0; so entao delete IServerEntity:WfCovTask/PriorityId. O11 entity-refactor: o mesmo com StatusId -> StatusId2 e AutoIndex_StatusId. Recusa: "delete: refused, IEntityAttribute 'PriorityId' is used by ... EntityIndex:AutoIndex_PriorityId" (tests/jobs-*-negative/delete-fk-attribute-autoindex.json).
```

Visto em: tests/jobs-odc/entity-refactor.json (2); tests/jobs/entity-refactor.json (2); tests/jobs-odc-negative/delete-fk-attribute-autoindex.json; tests/jobs-negative/delete-fk-attribute-autoindex.json; sonda index-promotes-autoindex (ODC)

### Nome de indice com mais de 28 caracteres e truncado em silencio pelo Studio (as duas faixas); o kernel recusa desde 2026-09-23

`recusa-do-kernel`

`IX_WfCovTask_ThisNameIsTooLongForOdc` (36) vira `IX_WfCovTask_ThisNameIsTooLo` no modelo sem aviso, tanto no create como no rename; o
contrato de dados apanhava-o como divergencia de Name. `EntityIndexes.CheckName` recusa nomes acima de 28 e colisoes (sem distincao
de maiusculas) dentro da entidade, nas duas faixas, antes de escrever.

Prova:

```
"EntityIndex name 'IX_WfCovTask_ThisNameIsTooLongForOdc' has 36 characters; the Studio truncates index names to 28 (it would become 'IX_WfCovTask_ThisNameIsTooLo'); pick a shorter name". O11: o mesmo com 'IX_Contact_Email_Name_Status30' (30). Sonda index-name-28 aceite, index-name-30 truncada.
```

Visto em: src/Anvil.Core/Kernel/EntityIndexes.cs (MaxNameLength, CheckName); tests/jobs-odc-negative/index-name-too-long.json; tests/jobs-negative/index-name-too-long.json; tests/jobs-*-negative/index-name-clash.json

### Um indice nao se move, nao se duplica e nao se reaponta; os atributos do indice reordenam-se no ODC e NAO no O11

`recusa-da-plataforma`

`move EntityIndex:X` e recusado nas duas faixas (os indices nao sao uma sequencia de autor). `duplicate` de um indice e recusado pelo
kernel porque a plataforma recusa dois indices com a mesma composicao ("Condition is false" no Studio). `replace` nao se aplica (um
indice nao tem consumidores). A ordem dos atributos DENTRO do indice e uma sequencia no ODC (`move EntityIndex:X/<Attr> first`
aceite, `Attributes` lido de volta na ordem nova) e nao o e no O11 (recusa; a alternativa e apagar e recriar o indice com os atributos
na ordem pedida). Mudar a composicao de um indice existente e sempre apagar e recriar (nao ha verbo de atributo de indice).

Prova:

```
ODC entity-refactor: move EntityIndex:IX_WfCovTask_Subj_Due/DueOn first -> Attributes ["DueOn","Subject"]. O11: "move: EntityIndex 'IX_Contact_NameEmail' does not keep EntityIndexAttribute '' in an ordered sequence, so there is no order to change". Duplicate: "duplicate: EntityIndex 'IX_WfCovTask_ProjectDone' cannot be duplicated (the platform refuses two indexes with the same attributes); create another EntityIndex with a different composition".
```

Visto em: tests/jobs-odc/entity-refactor.json (4); tests/jobs-negative/move-index-attribute.json; tests/jobs-*-negative/move-index.json; tests/jobs-*-negative/duplicate-index.json; tests/jobs-*-negative/index-duplicate-composition.json

### Renomear um indice: o ODC tem Name nativo, o O11 diz "has no Name"; o kernel renomeia pela classe nativa (SetName) nas duas faixas

`diferenca-entre-faixas`

No O11 o `EntityIndex` nao expoe `Name` pelo Model API V1 (o kernel sintetiza o tipo sobre a classe nativa `ServiceStudio.Model.EntityIndex`),
por isso o `rename` generico recusava. Desde 2026-09-23 `EntityIndexes.Rename` escreve pelo `SetName` da classe nativa nas duas faixas,
com a mesma recusa de comprimento e colisao do create. Nada cita um indice pelo nome: `consumers 0`.

Prova:

```
ODC/O11 entity-refactor: rename EntityIndex:IX_..._MailName -> IX_..._Mail_Name; get -> nome novo, Unique, Attributes iguais. Ledger: ServiceStudio.Model.EntityIndex {create, rename, set, delete} no O11; OutSystems.Model.Data.IEntityIndex no ODC.
```

Visto em: src/Anvil.Core/Kernel/EntityIndexes.cs (Rename); src/Anvil.Core/Kernel/Verbs.cs (Rename); tests/jobs-odc/entity-refactor.json (4); tests/jobs/entity-refactor.json (4)

### `replace` entre entidades e recusado pelo kernel: os consumidores ligam-se aos filhos (tipo identificador, atributos, registo anonimo, tipo lista), que o replace nao mapeia

`recusa-do-kernel`

Medido antes da recusa: no ODC `replace IServerEntity:A -> B` deixava o eSpace em `InvalidGlobalStateException 6 - eSpace has missing
Anonymous Structures`; no O11 "native replacement was incomplete". Desde 2026-09-23 o kernel recusa de frente e aponta o caminho:
renomear a entidade, ou reapontar os atributos um a um (o `replace` de atributo -> atributo esta provado nas duas faixas, com o filtro
consumidor reescrito e a origem a sair sem force).

Prova:

```
"replace: IServerEntity 'WfCovOrganization' is an entity and cannot be repointed: its consumers bind to its children (identifier type, attributes, anonymous record, list type), which replace does not map. Rename it, or move the consumers to the other entity by hand (attributes can be replaced one by one)". O11: o mesmo com IServerEntity 'Contact'.
```

Visto em: src/Anvil.Core/Kernel/Verbs.cs (Replace); tests/jobs-odc-negative/replace-entity.json; tests/jobs-negative/replace-entity.json; tests/jobs-*/entity-refactor.json (1)

### Mudar o tipo de uma FK que tem DefaultValue faz o Verify do Studio lancar "Condition is false"; o kernel exige limpar o default primeiro (as duas faixas)

`recusa-do-kernel`

`set DataType` num atributo `<E> Identifier` com `DefaultValue` (por exemplo `Entities.WfCovPriority.Normal`) executa, mas o Verify do
Studio lanca uma excecao interna ("Condition is false") em vez de uma mensagem. O kernel recusa antes: limpar (`set DefaultValue ""`),
depois mudar o tipo (e tirar antes as expressoes que comparem a FK com o registo). A mudanca de tipo em si EXECUTA headless e o Verify
fica limpo; isso nao prova a migracao dos dados de um banco publicado.

Prova:

```
"set DataType on IEntityAttribute 'PriorityId': the attribute has a DefaultValue (Entities.WfCovPriority.Normal) typed by an identifier; clear it first (set DefaultValue \"\"), then change the type (the Studio's own validation fails otherwise), or replace the attribute by a new one". Sonda type-change-fk-cleared: accepted, contrato de dados sem diferencas (DefaultValue vazio le-se null: o contrato trata "" e null como iguais desde 2026-09-23).
```

Visto em: src/Anvil.Core/Kernel/Verbs.cs (Set, guarda de DataType); tests/jobs-odc-negative/fk-type-change-with-default.json; tests/jobs-negative/fk-type-change-with-default.json; tests/jobs-*/entity-refactor.json (3)

### Apagar uma entidade de servidor sem consumidores de autor e recusado sem force (registo anonimo `<E> Record` e, no O11, `<E> List`); com force e comportamento observado, integridade nao comprovada

`armadilha`

Como na static entity (fase 2): o `IAnonymousStructure <E> Record` cita a entidade pelo `IAttribute` e, no O11, o `IListType <E> List`
tambem, mesmo sem nenhum consumidor de autor. Sem force a recusa esta provada nas duas faixas; com force o delete e aceite e sobram
orfaos (o `IAttribute` do registo anonimo; o `IListType` sobrevive quando algo o usa) que o Verify nao assinala. A descoberta diz
`undetermined` + `observed` para o papel entidade e nunca recomenda force. O que NAO se afirma: integridade do modulo, efeito na
publicacao, migracao do banco.

Prova:

```
O11 entity-refactor (5): usages $DcScratch real 2 (IAttribute do `DcScratch Record`, `DcScratch List`); delete force brokenConsumers 2; find 'DcScratch' -> IAttribute orfao; find 'DcScratch Record' -> IAnonymousStructure sobrevive. Recusa: "delete: refused, IServerEntity 'WfCovOrganization' is used by ... IAnonymousStructure:WfCovOrganization Record/IAttribute:WfCovOrganization ..." (tests/jobs-*-negative/delete-entity-in-use.json).
```

> **OBSOLETO** (cobertura testada, fase 2, 2026-10-03)
>
> O registo anonimo `<E> Record`, o tipo `<E> List` e a excecao `Not <Role>` so contam enquanto alguem fora do alvo os usa; sem
> consumidor de autor a entidade (e a static, a structure, o role) apaga-se sem force nas duas faixas e o Verify nao muda
> (tests/jobs*/delete-generated-companions.json). O registo anonimo orfao fica no modelo em memoria e nao vai para o OML gravado.
> Em troca o delete passou a olhar os consumidores dos FILHOS: a FK que cita `<E> Identifier`, o Execute de uma action de
> entidade (tests/jobs-negative/delete-entity-fk-in-use.json, tests/jobs-*-negative/delete-entity-in-use.json).

Visto em: tests/jobs/entity-refactor.json (5); tests/jobs-odc/entity-refactor.json (5); tests/jobs-odc-negative/delete-entity-in-use.json; tests/jobs-negative/delete-entity-in-use.json

### `usages` de uma entidade sub-reporta as FKs: elas ligam-se ao filho `<E> Identifier` (IIdentifierType), nao a entidade

`armadilha`

O tipo identificador e um filho gerado pela plataforma (`IServerEntity:<E>/#IIdentifierType`, so leitura). As FKs de outras
entidades apontam para ELE, por isso `usages IServerEntity:<E>` conta o registo anonimo e as expressoes, mas nao as FKs; para saber
quem aponta para a entidade por chave estrangeira, leia `usages` do tipo identificador ou os atributos das outras entidades.

Prova:

```
ODC delete-entity-whole: usages da entidade real 1 (registo anonimo) enquanto duas FKs a citam; get IServerEntity:WfCovTask/#IIdentifierType devolve o IIdentifierType (entity-lifecycle, as duas faixas).
```

Visto em: tests/jobs-odc/delete-entity-whole.json; tests/jobs-odc/entity-lifecycle.json; tests/jobs/entity-lifecycle.json

### Contrato de dados: uma assercao segue o objeto pela identidade (chave) e absorve o que a plataforma reescreve de forma legitima; um valor errado continua a reprovar

`limite-do-kernel`

Desde 2026-09-23 as assercoes ancoram cada segmento por chave (`@<registo>/@<atributo>` para valores de registo) e, em volta de
`rename`, `set Identifier`, `replace` e `move`, o contrato tira uma fotografia antes e depois: um valor que batia antes do verbo e mudou
durante ele e uma reescrita da plataforma (`platformRewrites`, `rewrittenByPlatform`), e a expectativa acompanha; um valor escrito
fora do job (ou errado) continua a reprovar com o texto esperado e o real. Um `set DefaultValue ""` le-se `null`: iguais para o contrato.
O que o contrato NAO faz: validar semantica (uma expressao reescrita para um nome que nao existe so cai no Verify).

Prova:

```
tests/jobs-*/data-contract-identity.json: 7 reescritas absorvidas (Identifier Closed->Done reescreve `Entities.DcStage.Closed` no DefaultValue e no filtro; rename da entidade e dos atributos), contrato aceite. DataContractIdentityScenarios: valor escrito fora do job ("Outra coisa") reprovado depois de dois renames, sem platformRewrites; os valores do registo seguem o registo depois de `set Identifier`.
```

Visto em: src/Anvil.Core/Kernel/DataAssertions.cs (ResolveAssertion, SnapshotAssertions, AbsorbPlatformRewrites); tests/Shared/DataContractIdentityScenarios.cs; tests/jobs/data-contract-identity.json; tests/jobs-odc/data-contract-identity.json
