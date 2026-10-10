# Tooltip

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 9 widgets internos

Dynamic tooltip displaying simple content.

Drag the Block to the screen, add your content in the Content placeholder and then add the tooltip text in the Tooltip placeholder.

Use the Tooltip block to display additional information related to a screen element.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Position | Position Identifier | nao | Entities.Position.Right | Set the Tooltip's position. Default is Right.   The predefined options are the following: - Bottom - BottomLeft - BottomRight - Center - Left - Right - Top - TopLeft - TopRight  Examples: - Entities.Position.Right - The Tooltip is displayed to the right of the element. - Entities.Position.Bottom - The Tooltip is displayed underneath the element. |
| StartsOpen | Boolean | nao | False | Set to True to show the Tooltip when the page is first loaded (without the need for the initial trigger). If False, the tooltip is not visible. This is the default. |
| Trigger | Trigger Identifier | nao | Entities.Trigger.OnHover | Set how the tooltip is triggered. By default, on mobile devices, the tooltip appears on click, while on other devices, it appears on hover. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Position**: Right, TopRight, BottomLeft, Left, TopLeft, Center, BottomRight, Top, Bottom
- **Entities.Trigger**: OnClick, OnHover

## Placeholders

- **Content**: Drag content here (em `TooltipWrapper/content`)
- **Tooltip**: Drag tooltip content here (em `TooltipWrapper/content/TooltipBallonWrapper/content`)

## Eventos

- **OnToggle**(TooltipId: Text, IsOpened: Boolean): Event triggered each time a Tooltip opens or closes.
- **Initialized**(TooltipId: Text): Event triggered after the Tooltip instance is ready.

## Composicao interna

- Scripts exigidos: OutSystemsUI, FloatingUIDom
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnReady, OnToggleHandler, OnInitialize, InitializedHandler, OnParametersChanged, RegisterCallbacks, OnDestroy
- Chama actions do modulo: LogEvent, TooltipInitialize, GenerateUniqueId, TooltipCreate, TooltipChangeTextProperty, TooltipChangeBooleanProperty, TooltipRegisterCallback, TooltipDestroy (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.TooltipAPI.Initialize`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.TooltipAPI.Create`, `OutSystems.OSUI.Patterns.TooltipAPI.ChangeProperty`, `OutSystems.OSUI.Patterns.TooltipAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.TooltipAPI.Dispose`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.Initialized = $actions.InitializedHandler;
$parameters.OnToggle = $actions.OnToggleHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Tooltip1","source":"IMobileBlock:Tooltip","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
{"op":"create","parent":"$b/Tooltip","type":"IExpression","as":"$eTooltip"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnToggle` resolve o IEventHandler pelo nome do evento e `$b/OnToggle/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"Tooltip1_OnToggle","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"TooltipId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"IsOpened","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Boolean"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnToggle","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnToggle/TooltipId","prop":"Value","value":"TooltipId"}
{"op":"set","target":"$b/OnToggle/IsOpened","prop":"Value","value":"IsOpened"}
```
