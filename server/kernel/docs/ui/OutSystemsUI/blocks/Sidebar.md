# Sidebar

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 8 widgets internos

Display additional information on a floating panel on the side of the screen.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| StartsOpen | Boolean | nao | False | Set to True to display the Sidebar. The default value is False. |
| Direction | Direction Identifier | nao | Entities.Direction.Right | Set the position where the Sidebar appears on the screen.  The predefined options are: -Left -Right  Examples:     Entities.Direction.Right - The sidebar is displayed on the right side of the screen.     Entities.Direction.Left - The sidebar is displayed on the left side of the screen. |
| HasOverlay | Boolean | nao | False | Set to True, to show an overlay when the Sidebar is open. When you click on the overlay, the Sidebar is closed. |
| Width | Text | nao | "500px" | Set the Sidebar width. Accepts any kind of unit (px, %, vw). Default value is 500px.  Example: "30%" |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Direction**: Right, Left

## Placeholders

- **Header**: Add your header content in this placeholder (em `TogglePreview/Sidebar/content`)
- **Content**: Add your Sidebar content in this placeholder (em `TogglePreview/Sidebar/content`)

## Eventos

- **OnToggle**(SidebarId: Text, IsOpen: Boolean): Event triggered when the Sidebar is toggled.
- **Initialized**(SidebarId: Text): Event triggered when the Sidebar instance is ready.

## Composicao interna

- Scripts exigidos: OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnToggleHandler, InitializedHandler, OnInitialize, RegisterCallback, OnDestroy, OnReady, OnParametersChanged
- Chama actions do modulo: LogEvent, SidebarCreate, GenerateUniqueId, SidebarRegisterCallback, SidebarDestroy, SidebarInitialize, SidebarChangeTextProperty, SidebarChangeBooleanProperty (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.SidebarAPI.Create`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.SidebarAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.SidebarAPI.Dispose`, `OutSystems.OSUI.Patterns.SidebarAPI.Initialize`, `OutSystems.OSUI.Patterns.SidebarAPI.ChangeProperty`

`RegisterCallback` / no `GetCallbackHandlers`:

```js
$parameters.Initialized = $actions.InitializedHandler;
$parameters.OnToggle = $actions.OnToggleHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Sidebar1","source":"IMobileBlock:Sidebar","as":"$b"}
{"op":"create","parent":"$b/Header","type":"IExpression","as":"$eHeader"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnToggle` resolve o IEventHandler pelo nome do evento e `$b/OnToggle/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"Sidebar1_OnToggle","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"SidebarId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"IsOpen","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Boolean"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnToggle","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnToggle/SidebarId","prop":"Value","value":"SidebarId"}
{"op":"set","target":"$b/OnToggle/IsOpen","prop":"Value","value":"IsOpen"}
```
