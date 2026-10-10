# ButtonLoading

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Utilities** | publico | 4 widgets internos

Button with loading state when is clicked.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsLoading | Boolean | sim |  | If True, the button shows the loading spinner. If False, the button doesn't show the loading spinner. |
| ShowLabelOnLoading | Boolean | nao | False | If True, the loading spinner displays beside the label. If False, only the loading spinner is displayed. This is the default. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Button**: Drag a Button or a Link to this placeholder. | nasce com: Button (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **Initialized**(ButtonLoadingId: Text): Event triggered after the ButtomLoading instance is ready.

## Composicao interna

- Scripts exigidos: OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnDestroy, RegisterCallbacks, OnParametersChanged, OnReady, OnInitialize, InitializedHandler
- Chama actions do modulo: ButtonLoadingDestroy, ButtonLoadingRegisterCallback, ButtonLoadingChangeBooleanProperty, ButtonLoadingChangeTextProperty, LogEvent, ButtonLoadingInitialize, GenerateUniqueId, ButtonLoadingCreate (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.ButtonLoadingAPI.Dispose`, `OutSystems.OSUI.Patterns.ButtonLoadingAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.ButtonLoadingAPI.ChangeProperty`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.ButtonLoadingAPI.Initialize`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.ButtonLoadingAPI.Create`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.Initialized = $actions.InitializedHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"ButtonLoading1","source":"IMobileBlock:ButtonLoading","empty":true,"as":"$b"}
{"op":"set","target":"$b/IsLoading","prop":"Value","value":"<Boolean>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"ButtonLoading1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"ButtonLoadingId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/ButtonLoadingId","prop":"Value","value":"ButtonLoadingId"}
```
