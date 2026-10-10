# InlineSVG

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Utilities** | publico | 6 widgets internos

Use this pattern to be able to use an SVG inline, so that you can change the fill and stroke properties, or animate the SVG paths.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| SVGCode | Text | nao |  | SVG markup code, that is going to be appended on the HTML. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

Nenhum.

## Eventos

- **Initialized**(InlineSVGId: Text): Event triggered after the InlineSVG instance is ready.

## Composicao interna

- Scripts exigidos: OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnInitialize, OnParametersChanged, RegisterCallbacks, OnDestroy, InitializedHandler, OnReady
- Chama actions do modulo: LogEvent, GenerateUniqueId, InlineSVGCreate, InlineSVGChangeTextProperty, InlineSVGRegisterCallback, InlineSVGDestroy, InlineSVGInitialize (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.InlineSvgAPI.Create`, `OutSystems.OSUI.Patterns.InlineSvgAPI.ChangeProperty`, `OutSystems.OSUI.Patterns.InlineSvgAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.InlineSvgAPI.Dispose`, `OutSystems.OSUI.Patterns.InlineSvgAPI.Initialize`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.OnInitialize = $actions.InitializedHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"InlineSVG1","source":"IMobileBlock:InlineSVG","as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"InlineSVG1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"InlineSVGId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/InlineSVGId","prop":"Value","value":"InlineSVGId"}
```
