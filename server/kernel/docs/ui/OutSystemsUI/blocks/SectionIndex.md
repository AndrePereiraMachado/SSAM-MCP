# SectionIndex

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 5 widgets internos

Use the Section Index to organize a screen's content, enabling quick navigation within a page.

Just drag the pattern, and it will create a link to every section you have on the page. If you use a list of sections, add disable-virtualization=true through the Attributes section on the list widget containing the section patterns.

Use the parameter isFixed to define if it will stick on scroll and the TopPosition to change the distance to top. 

Set IsSmooth to true to enable animated scroll.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| SmoothScrolling | Boolean | nao | True | If True, navigation to the destination is animated. If False, the navigation is instant. The default value is True. |
| IsFixed | Boolean | nao | False | If True, the Section Index Pattern is always in the same position on the screen. This is the default.  If False, the Section Index Pattern scrolls with the page content. The default value is False.  As the SectionIndex uses the CSS position: sticky property, to achieve the fixed behaviour, there might be situations, depending on screen structure, where the pattern is not getting properly fixed. In these cases, adding the following CSS on the your Application Theme might help solving the issue:  *:has( > [data-block] > .osui-section-index.osui-section-index--is-sticky) {   display: initial; } |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Content**: Drag SectionIndexItem blocks to this placeholder. | nasce com: WebBlockInstance:SectionIndexItem, WebBlockInstance:SectionIndexItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **Initialized**(SectionIndexId: Text): Event triggered after the SectionIndex instance is ready.

## Composicao interna

- Usa os blocos: SectionIndexItem
- Scripts exigidos: ScrollPolyfill, OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnDestroy, RegisterCallbacks, InitializedHandler, OnParametersChanged, OnReady, OnInitialize
- Chama actions do modulo: SectionIndexDestroy, SectionIndexRegisterCallback, SectionIndexChangeBooleanProperty, SectionIndexChangeTextProperty, LogEvent, SectionIndexInitialize, GenerateUniqueId, SectionIndexCreate (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.SectionIndexAPI.Dispose`, `OutSystems.OSUI.Patterns.SectionIndexAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.SectionIndexAPI.ChangeProperty`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.SectionIndexAPI.Initialize`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.SectionIndexAPI.Create`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.Initialized = $actions.InitializedHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"SectionIndex1","source":"IMobileBlock:SectionIndex","empty":true,"as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"SectionIndex1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"SectionIndexId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/SectionIndexId","prop":"Value","value":"SectionIndexId"}
```
