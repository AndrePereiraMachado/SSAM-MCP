# Search

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 10 widgets internos

Input with search icon to search within the application.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Input**: Drag the search input to this placeholder (em `TogglePreview/content`) | nasce com: Label, Input:Input_Search. Esse Input e parte do padrao: NAO use empty; ligue-o com `set $b/Input/#IInput prop Variable value <variavel>` (os nomes reais sao renumerados, ex. Input1; enderece por tipo)

## Eventos

- **Initialized**(SearchId: Text): Event triggered when the Search instance is ready.

## Composicao interna

- Scripts exigidos: OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: RegisterCallback, OnParametersChanged, OnReady, OnDestroy, OnInitialize, InitializedHandler
- Chama actions do modulo: SearchRegisterCallback, SearchChangeTextProperty, LogEvent, SearchInitialize, SearchDestroy, GenerateUniqueId, SearchCreate (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.SearchAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.SearchAPI.ChangeProperty`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.SearchAPI.Initialize`, `OutSystems.OSUI.Patterns.SearchAPI.Dispose`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.SearchAPI.Create`

`RegisterCallback` / no `GetCallbackHandlers`:

```js
$parameters.Initialized = $actions.InitializedHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Search1","source":"IMobileBlock:Search","as":"$b"}
{"op":"set","target":"$b/Input/#IInput","prop":"Variable","value":"<variavel local>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"Search1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"SearchId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/SearchId","prop":"Value","value":"SearchId"}
```
