# Accordion

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Content** | publico | 13 widgets internos

Arrange the content by having vertically stacked tabs that expand when clicked. This is an effective way to display additional information.

Add the Accordion Web Block on your Screen and as many AccordionItems as you need inside the Accordion.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| MultipleItems | Boolean | nao | False | Set to True to allow multiple Accordion items to be expanded simultaneously. By default, False. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Content**: Drag AccordionItem blocks to this placeholder. | nasce com: WebBlockInstance:AccordionItem, WebBlockInstance:AccordionItem, WebBlockInstance:AccordionItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **Initialized**(AccordionId: Text): Event triggered after the Accordion instance is ready.

## Composicao interna

- Usa os blocos: AccordionItem
- Scripts exigidos: OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnReady, OnDestroy, OnInitialize, InitializedHandler, OnParametersChanged, RegisterCallbacks
- Chama actions do modulo: LogEvent, AccordionInitialize, AccordionDestroy, AccordionCreate, GenerateUniqueId, AccordionChangeTextProperty, AccordionChangeBooleanProperty, AccordionRegisterCallback (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.AccordionAPI.Initialize`, `OutSystems.OSUI.Patterns.AccordionAPI.Dispose`, `OutSystems.OSUI.Patterns.AccordionAPI.Create`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.AccordionAPI.ChangeProperty`, `OutSystems.OSUI.Patterns.AccordionAPI.RegisterCallback`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.Initialized = $actions.InitializedHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Accordion1","source":"IMobileBlock:Accordion","empty":true,"as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"Accordion1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"AccordionId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/AccordionId","prop":"Value","value":"AccordionId"}
```
