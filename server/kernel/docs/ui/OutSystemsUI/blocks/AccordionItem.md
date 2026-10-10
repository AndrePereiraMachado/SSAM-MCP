# AccordionItem

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 10 widgets internos

An area that can be expanded or collapsed. You can change the default state of the Block using the IsExpanded input.

Can also be used within the Accordion Pattern, placed inside the Content placeholder. Drag into the Accordion Block as many items as you need.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| StartsExpanded | Boolean | nao | False | Initial state of the Block. If set to True, when the page is rendered, the Accordion Item is open. If set to False, the Accordion Item is closed. The default value is False. |
| Icon | AccordionIconType Identifier | nao | Entities.AccordionIconType.Caret | Set the icons shown in of the AccordionItem.  You can pick between the following: - Carets - Arrow up icon when the item is expanded and arrow down icon when the item is collapsed. This is the default. - Plus/Minus - Minus icon (-) when the item is expanded and plus icon (+) when the item is collapsed. - Custom - Advanced option to customize the Accordion icons. To use custom icons, set the Icon property to Custom and drag and drop the Icon widget to the Accordion Item placeholder. |
| IconPosition | AccordionIconPosition Identifier | nao | Entities.AccordionIconPosition.Right | Set the position of the accordion icon. By default, the icon appears on the right. |
| IsDisabled | Boolean | nao | False | Doesn't allow the Accordion Item to be clickable. Default value is False. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.AccordionIconType**: Custom, Caret, PlusMinus
- **Entities.AccordionIconPosition**: Right, Left

## Placeholders

- **Title**: Section Title (em `AccordionItem/content/TitleWrapper/content`)
- **CustomIcon**: Drop an icon here (em `AccordionItem/content/TitleWrapper/content`)
- **Content**: Add content to this placeholder (em `AccordionItem/content/ContentWrapper/content`)

## Eventos

- **OnToggle**(AccordionItemId: Text, IsExpanded: Boolean): Event triggered when the section is expanded or collaped.
- **Initialized**(AccordionItemId: Text): Event triggered after the AccordionItem instance is ready.

## Composicao interna

- Scripts exigidos: OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnReady, TriggerToggleClick, InitializedHandler, OnParametersChanged, RegisterCallbacks, OnInitialize, OnDestroy
- Chama actions do modulo: AccordionItemInitialize, LogEvent, AccordionItemChangeTextProperty, AccordionItemChangeBooleanProperty, AccordionItemRegisterCallback, AccordionItemCreate, GenerateUniqueId, AccordionItemDestroy (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.AccordionItemAPI.Initialize`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.AccordionItemAPI.ChangeProperty`, `OutSystems.OSUI.Patterns.AccordionItemAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.AccordionItemAPI.Create`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.AccordionItemAPI.Dispose`

`RegisterCallbacks` / no `GetActionReference`:

```js
$parameters.IntializedHandler = $actions.InitializedHandler;
$parameters.OnToggleHandler = $actions.TriggerToggleClick;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"AccordionItem1","source":"IMobileBlock:AccordionItem","as":"$b"}
{"op":"create","parent":"$b/Title","type":"IExpression","as":"$eTitle"}
{"op":"create","parent":"$b/CustomIcon","type":"IExpression","as":"$eCustomIcon"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnToggle` resolve o IEventHandler pelo nome do evento e `$b/OnToggle/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"AccordionItem1_OnToggle","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"AccordionItemId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"IsExpanded","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Boolean"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnToggle","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnToggle/AccordionItemId","prop":"Value","value":"AccordionItemId"}
{"op":"set","target":"$b/OnToggle/IsExpanded","prop":"Value","value":"IsExpanded"}
```
