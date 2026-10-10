# FlipContent

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 10 widgets internos

Flip between two placeholders.
It can be used out of the box, or it can be controled by your own variable. Works well with cards or images of the same size.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| StartsFlipped | Boolean | nao | False | Sets the initial state of the pattern. If True, the CardFront content is displayed first before flipping. If False, the CardBack content is displayed first before flipping. This is the default.  Use one of the following actions to change the value afterwards: - FlipContentBack - FlipContentFront - FlipContentToggle |
| FlipOnClick | Boolean | nao | True | If True, the flip event is triggered when the Flip Content card (front or back) is clicked. This is the default. If False, you can define the action that triggers the flip event. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **CardFront**: Add content to the Flip Content front side (em `FlipWrapper/content/FlipContainer/content`)
- **CardBack**: Add content to the Flip Content back side. (em `FlipWrapper/content/FlipContainer/content/ServiceStudioPreview`)

## Eventos

- **OnFlip**(FlipContentId: Text, IsFlipped: Boolean): Event triggered after the content is flipped.
- **Initialized**(FlipContentId: Text): Event triggered after the FlipContent instance is ready.

## Composicao interna

- Scripts exigidos: OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: ToggleFlip, OnParametersChanged, InitializedHandler, OnDestroy, RegisterCallbacks, OnInitialize, OnReady
- Chama actions do modulo: FlipContentChangeTextProperty, FlipContentChangeBooleanProperty, FlipContentDestroy, FlipContentRegisterCallack, FlipContentCreate, LogEvent, GenerateUniqueId, FlipContentInitialize (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.FlipContentAPI.ChangeProperty`, `OutSystems.OSUI.Patterns.FlipContentAPI.Dispose`, `OutSystems.OSUI.Patterns.FlipContentAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.FlipContentAPI.Create`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.FlipContentAPI.Initialize`

`RegisterCallbacks` / no `GetActionReference`:

```js
$parameters.IntializedHandler = $actions.InitializedHandler;
$parameters.ToggleFlipHandler = $actions.ToggleFlip;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"FlipContent1","source":"IMobileBlock:FlipContent","as":"$b"}
{"op":"create","parent":"$b/CardFront","type":"IExpression","as":"$eCardFront"}
{"op":"create","parent":"$b/CardBack","type":"IExpression","as":"$eCardBack"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnFlip` resolve o IEventHandler pelo nome do evento e `$b/OnFlip/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"FlipContent1_OnFlip","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"FlipContentId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"IsFlipped","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Boolean"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnFlip","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnFlip/FlipContentId","prop":"Value","value":"FlipContentId"}
{"op":"set","target":"$b/OnFlip/IsFlipped","prop":"Value","value":"IsFlipped"}
```
