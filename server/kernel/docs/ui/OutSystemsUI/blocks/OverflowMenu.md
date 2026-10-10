# OverflowMenu

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 23 widgets internos

Clickable element that displays hidden actions, settings, or secondary options. Use this pattern to show additional options when there is a space constraint (e.g. in toolbars or other places where a group of actions is required).

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| BalloonShape | Shape Identifier | nao | Entities.Shape.SoftRounded | Set the balloon shape. The predefined options are: - SoftRounded - Rounded - Sharp  Examples: Entities.Shape.Rounded - the inherit style will be rounded.  By default, 4px (Entities.Shape.SoftRounded).  Default: Shape.SoftRounded |
| BalloonPosition | FloatingPosition Identifier | nao |  | Set the balloon’s position. The predefined options are: - Auto  - Top - Top start - Top end - Right - Right start - Right end - Bottom - Bottom start - Bottom end - Left - Left start - Left end  Examples: - Blank (Entities.BalloonPosition.Auto) - The placement of the balloon is automatically calculated based on the space available. This is the default. - Entities.BalloonPosition.Right - The balloon is displayed to the right of the element. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. Examples:  Blank - No custom styles are added (default value).  "myclass" - Adds the myclass style to the UI styles being applied.  "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Shape**: SoftRounded, Sharp, Rounded
- **Entities.FloatingPosition**: Top, LeftStart, Right, Bottom, Auto, RightStart, BottomStart, TopEnd, Center, LeftEnd, BottomEnd, RightEnd, TopStart, Left

## Placeholders

- **Menu**: Drag links here to add elements to the menu (em `OverflowMenu/content/ManageBaloonPreview`) | nasce com: AdvancedHtml (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **TriggerContent**: Drag the clickable element here. (em `OverflowMenu/content/Trigger/content`) | nasce com: Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **OnMenuToggle**(OverflowMenuId: Text, IsOpen: Boolean): Event triggered when the Overflow Menu is toggled.
- **Initialized**(OverflowMenuId: Text): Event triggered after the Overflow Menu instance is ready.

## Composicao interna

- Usa os blocos: Separator
- Scripts exigidos: OutSystemsUI, FloatingUIDom
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnDestroy, OnInitialize, OnReady, RegisterCallback, OnParametersChanged, InitializeHandler, OnMenuToggleHandler
- Chama actions do modulo: OverflowMenuDestroy, OverflowMenuCreate, LogEvent, GenerateUniqueId, OverflowMenuInitialize, OverflowMenuRegisterCallback, OverflowMenuChangeTextProperty (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.OverflowMenuAPI.Dispose`, `OutSystems.OSUI.Patterns.OverflowMenuAPI.Create`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.OverflowMenuAPI.Initialize`, `OutSystems.OSUI.Patterns.OverflowMenuAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.OverflowMenuAPI.ChangeProperty`

`RegisterCallback` / no `GetCallbackHandler`:

```js
$parameters.InitializeObj = $actions.InitializeHandler;
$parameters.OnToggleObj = $actions.OnMenuToggleHandler
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"OverflowMenu1","source":"IMobileBlock:OverflowMenu","empty":true,"as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnMenuToggle` resolve o IEventHandler pelo nome do evento e `$b/OnMenuToggle/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"OverflowMenu1_OnMenuToggle","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"OverflowMenuId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"IsOpen","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Boolean"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnMenuToggle","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnMenuToggle/OverflowMenuId","prop":"Value","value":"OverflowMenuId"}
{"op":"set","target":"$b/OnMenuToggle/IsOpen","prop":"Value","value":"IsOpen"}
```
