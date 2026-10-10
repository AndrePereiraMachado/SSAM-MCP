# Tabs

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 22 widgets internos

Set of Tabs with placeholders for Title and Content.

Fill in the headers and respective content areas of the tabs to be displayed. Empty tabs will not be rendered.

Used to display large sets of information which can be split into different areas, whilst always remaining a click away.

📝 To ensure predictable behavior and avoid runtime issues, the Tabs component is designed to include at least one TabsHeaderItem and one TabsContentItem.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| TabsOrientation | Orientation Identifier | nao | Entities.Orientation.Horizontal | Set the direction of the tabs. By default, the tabs are displayed horizontally. |
| StartingTab | Integer | nao | 0 | Set the index of the currently active tab. The index begins at 0.  Examples: - Blank - The 1st tab is the active tab. This is the default. - 1 - The 2nd tab is the active tab. |
| Height | Text | nao | "auto" | Height of the tabs container. By default, "auto".  Examples: - Auto - The tab height adjusts to the content. This is the default. - 400px - The height of the tab is 400px. |
| TabsVerticalPosition | Direction Identifier | nao | Entities.Direction.Left | Sets the position of the tabs headers. By default, tabs appear on left. |
| OptionalConfigs | TabsOptionalConfigs | nao |  | Set additional parameters to customize the Tabs behavior and functionality. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. Examples:  Blank - No custom styles are added (default value).  "myclass" - Adds the myclass style to the UI styles being applied.  "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Orientation**: Horizontal, Vertical
- **Entities.Direction**: Right, Left

## Placeholders

- **Header**: Drag TabsHeaderItem blocks to this placeholder. (em `content/content`) | nasce com: WebBlockInstance:TabsHeaderItem, WebBlockInstance:TabsHeaderItem, WebBlockInstance:TabsHeaderItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Content**: Drag TabsContentItem blocks to this placeholder. (em `content/content/TogglePreview`) | nasce com: WebBlockInstance:TabsContentItem, WebBlockInstance:TabsContentItem, WebBlockInstance:TabsContentItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **Initialized**(TabsId: Text): Event triggered after the Tabs instance is ready.
- **OnTabChange**(TabsId: Text, ActiveTab: Integer): Event triggered when switching Tabs.

## Composicao interna

- Usa os blocos: TabsHeaderItem, TabsContentItem
- Scripts exigidos: OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnParametersChanged, OnReady, RegisterCallback, OnTabChangeHandler, InitializedHandler, OnDestroy, OnInitialize
- Chama actions do modulo: TabsChangeTextProperty, TabsChangeBooleanProperty, TabsChangeIntegerProperty, LogEvent, TabsInitialize, TabsRegisterCallback, TabsDestroy, GenerateUniqueId, TabsCreate (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.TabsAPI.ChangeProperty`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.TabsAPI.Initialize`, `OutSystems.OSUI.Patterns.TabsAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.TabsAPI.Dispose`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.TabsAPI.Create`

`RegisterCallback` / no `GetCallbackHandler`:

```js
$parameters.IntializedHandler = $actions.InitializedHandler;
$parameters.OnChange = $actions.OnTabChangeHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Tabs1","source":"IMobileBlock:Tabs","empty":true,"as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"Tabs1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"TabsId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/TabsId","prop":"Value","value":"TabsId"}
```
