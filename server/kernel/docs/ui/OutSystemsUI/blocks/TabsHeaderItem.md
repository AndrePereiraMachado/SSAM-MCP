# TabsHeaderItem

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 2 widgets internos

Item for placeholder Header in the Tabs Block. Drag as many items as you need.

The headers can have rich information like counters, badges or icons.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Title**: Use this placeholder to set your title. (em `content`)

## Eventos

- **Initialized**(TabsHeaderItemId: Text): Event triggered after the TabsHeaderItem instance is ready.

## Composicao interna

- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnRender -> OnRender; OnDestroy -> OnDestroy
- Actions do bloco: RegisterCallbacks, OnInitialize, OnReady, OnRender, OnDestroy, InitializedHandler, OnParametersChanged
- Chama actions do modulo: TabsHeaderItemRegisterCallback, TabsHeaderItemCreate, LogEvent, GenerateUniqueId, TabsHeaderItemInitialize, TabsHeaderItemUpdateOnRender, TabsHeaderItemDestroy, TabsHeaderItemChangeTextProperty (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.TabsHeaderItemAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.TabsHeaderItemAPI.Create`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.TabsHeaderItemAPI.Initialize`, `OutSystems.OSUI.Patterns.TabsHeaderItemAPI.UpdateOnRender`, `OutSystems.OSUI.Patterns.TabsHeaderItemAPI.Dispose`, `OutSystems.OSUI.Patterns.TabsHeaderItemAPI.ChangeProperty`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.Initialized = $actions.InitializedHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"TabsHeaderItem1","source":"IMobileBlock:TabsHeaderItem","as":"$b"}
{"op":"create","parent":"$b/Title","type":"IExpression","as":"$eTitle"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"TabsHeaderItem1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"TabsHeaderItemId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/TabsHeaderItemId","prop":"Value","value":"TabsHeaderItemId"}
```
