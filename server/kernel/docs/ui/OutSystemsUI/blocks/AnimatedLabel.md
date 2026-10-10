# AnimatedLabel

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 6 widgets internos

Input fields with labels that animate when users focus the input.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Label**: Insert label text. You should use a label widget and assign the Input Widget properly. (em `AnimatedLabel/content`) | nasce com: Label (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Input**: Drag input control. (em `AnimatedLabel/content`) | nasce com: Input:InputSample. Esse Input e parte do padrao: NAO use empty; ligue-o com `set $b/Input/#IInput prop Variable value <variavel>` (os nomes reais sao renumerados, ex. Input1; enderece por tipo)

## Eventos

- **Initialized**(AnimatedLabelId: Text): Event triggered after the AnimatedLabel instance is ready.

## Composicao interna

- Scripts exigidos: OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnRender -> OnRender; OnDestroy -> OnDestroy
- Actions do bloco: OnReady, InitializedHandler, OnInitialize, OnParametersChanged, OnDestroy, RegisterCallbacks, OnRender
- Chama actions do modulo: LogEvent, AnimatedLabelInitialize, GenerateUniqueId, AnimatedLabelCreate, AnimatedLabelChangeTextProperty, AnimatedLabelDestroy, AnimatedLabelRegisterCallback, AnimatedLabelUpdateOnRender (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.AnimatedLabelAPI.Initialize`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.AnimatedLabelAPI.Create`, `OutSystems.OSUI.Patterns.AnimatedLabelAPI.ChangeProperty`, `OutSystems.OSUI.Patterns.AnimatedLabelAPI.Dispose`, `OutSystems.OSUI.Patterns.AnimatedLabelAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.AnimatedLabelAPI.UpdateOnRender`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.Initialized = $actions.InitializedHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"AnimatedLabel1","source":"IMobileBlock:AnimatedLabel","empty":true,"as":"$b"}
{"op":"set","target":"$b/Input/#IInput","prop":"Variable","value":"<variavel local>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"AnimatedLabel1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"AnimatedLabelId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/AnimatedLabelId","prop":"Value","value":"AnimatedLabelId"}
```
