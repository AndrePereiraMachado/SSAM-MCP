# SectionIndexItem

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 2 widgets internos

Use the Section Index to organize a screen's content, enabling quick navigation within a page.

Just drag the pattern, and it will create a link to every section you have on the page. If you use a list of sections, add disable-virtualization=true through the Attributes section on the list widget containing the section patterns.

Use the parameter isFixed to define if it will stick on scroll and the TopPosition to change the distance to top. 

Set IsSmooth to true to enable animated scroll.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ScrollToWidgetId | Text | sim |  | Element to where the page will navigate. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Content**: Add content to this placeholder (em `content`)

## Eventos

- **Initialized**(SectionIndexItemId: Text): Event triggered after the SectionIndexItem instance is ready.

## Composicao interna

- Scripts exigidos: OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnReady, InitializedHandler, OnInitialize, RegisterCallbacks, OnParametersChanged, OnDestroy
- Chama actions do modulo: LogEvent, SectionIndexItemInitialize, GenerateUniqueId, SectionIndexItemCreate, SectionIndexItemRegisterCallback, SectionIndexItemChangeTextProperty, SectionIndexItemDestroy (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.SectionIndexItemAPI.Initialize`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.SectionIndexItemAPI.Create`, `OutSystems.OSUI.Patterns.SectionIndexItemAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.SectionIndexItemAPI.ChangeProperty`, `OutSystems.OSUI.Patterns.SectionIndexItemAPI.Dispose`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.Initialized = $actions.InitializedHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"SectionIndexItem1","source":"IMobileBlock:SectionIndexItem","as":"$b"}
{"op":"set","target":"$b/ScrollToWidgetId","prop":"Value","value":"<Text>"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"SectionIndexItem1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"SectionIndexItemId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/SectionIndexItemId","prop":"Value","value":"SectionIndexItemId"}
```
