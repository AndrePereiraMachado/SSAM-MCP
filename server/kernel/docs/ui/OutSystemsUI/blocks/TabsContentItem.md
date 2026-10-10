# TabsContentItem

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 2 widgets internos

Item for placeholder Content in the Tabs Block. Drag as many items as you need.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Content**: Drag your content to this placeholder. (em `content`)

## Eventos

- **Initialized**(TabsContentItemId: Text): Event triggered after the TabsContentItem instance is ready.

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: RegisterCallbacks, OnParametersChanged, InitializedHandler, OnReady, OnInitialize, OnDestroy
- Chama actions do modulo: TabsContentItemRegisterCallback, TabsContentItemChangeTextProperty, TabsContentItemInitialize, LogEvent, GenerateUniqueId, TabsContentItemCreate, TabsContentItemDestroy (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.TabsContentItemAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.TabsContentItemAPI.ChangeProperty`, `OutSystems.OSUI.Patterns.TabsContentItemAPI.Initialize`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.TabsContentItemAPI.Create`, `OutSystems.OSUI.Patterns.TabsContentItemAPI.Dispose`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.Initialized = $actions.InitializedHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"TabsContentItem1","source":"IMobileBlock:TabsContentItem","as":"$b"}
{"op":"create","parent":"$b/Content","type":"IExpression","as":"$eContent"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"TabsContentItem1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"TabsContentItemId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/TabsContentItemId","prop":"Value","value":"TabsContentItemId"}
```
