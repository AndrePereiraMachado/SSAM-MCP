# DropdownServerSideItem

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Advanced** | publico | 3 widgets internos

DropdownOptionItem block, this block should be use as a DropdownServerAction option item.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ItemId | Text | sim |  | Identifier of the DropdownServerSide item. |
| IsSelected | Boolean | nao | False | Set to True to display this dropdown option as selected. By default, False. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **DropdownItemContent** (em `DropdownSSItem/content`) | nasce com: Expression (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **OnSelected**(DropdownServerSideItemId: Text, ItemOptionId: Text, DropdownServerSideId: Text) [obrigatorio]: Event triggered each time the item is clicked.
- **Initialized**(DropdownServerSideItemId: Text): Event triggered after the DropdownServerSideItem instance is ready.

## Composicao interna

- Scripts exigidos: OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: InitializedHandler, OnDestroy, RegisterCallbacks, OnReady, OnParametersChanged, OnSelectedHandler, OnInitialize
- Chama actions do modulo: DropdownServerSideItemDestroy, DropdownServerSideItemRegisterCallback, LogEvent, DropdownServerSideItemInitialize, DropdownServerSideItemChangeTextProperty, DropdownServerSideItemChangeBooleanProperty, DropdownServerSideItemCreate, GenerateUniqueId (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.DropdownServerSideItemAPI.Dispose`, `OutSystems.OSUI.Patterns.DropdownServerSideItemAPI.RegisterCallback`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.DropdownServerSideItemAPI.Initialize`, `OutSystems.OSUI.Patterns.DropdownServerSideItemAPI.ChangeProperty`, `OutSystems.OSUI.Patterns.DropdownServerSideItemAPI.Create`, `OutSystems.OSUI.Utils.GenerateUniqueId`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.IntializedHandler = $actions.InitializedHandler;
$parameters.OnSelected = $actions.OnSelectedHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DropdownServerSideItem1","source":"IMobileBlock:DropdownServerSideItem","empty":true,"as":"$b"}
{"op":"set","target":"$b/ItemId","prop":"Value","value":"<Text>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnSelected` resolve o IEventHandler pelo nome do evento e `$b/OnSelected/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DropdownServerSideItem1_OnSelected","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"DropdownServerSideItemId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"ItemOptionId","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"DropdownServerSideId","as":"$p3"}
{"op":"set","target":"$p3","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnSelected","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnSelected/DropdownServerSideItemId","prop":"Value","value":"DropdownServerSideItemId"}
{"op":"set","target":"$b/OnSelected/ItemOptionId","prop":"Value","value":"ItemOptionId"}
{"op":"set","target":"$b/OnSelected/DropdownServerSideId","prop":"Value","value":"DropdownServerSideId"}
```
