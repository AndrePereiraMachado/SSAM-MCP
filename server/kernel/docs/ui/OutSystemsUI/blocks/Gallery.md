# Gallery

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Adaptive** | publico | 3 widgets internos

Display content in gallery style with different columns per device type/orientation

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| RowItemsDesktop | Integer | nao | 4 | Set the number of items that are shown simultaneously per row in desktop. The number must be greater than 0. By default, 4. |
| RowItemsTablet | Integer | nao | 3 | Set the number of items that are shown simultaneously per row in tablet. The number must be greater than 0. By default, 3. |
| RowItemsPhone | Integer | nao | 1 | Set the number of items that are shown simultaneously per row in phone. The number must be greater than 0. By default, 1. |
| ItemsGap | Space Identifier | nao | Entities.Space.Base | Defines the space between the Gallery items. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Space**: XXLarge, ExtraLarge, Large, None, Medium, ExtraSmall, Base, Small

## Placeholders

- **Content**: Add content to this placeholder. | nasce com: List (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **Initialized**(GalleryId: Text): Event triggered after the Gallery instance is ready.

## Composicao interna

- Scripts exigidos: OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnDestroy, OnParametersChanged, RegisterCallbacks, OnInitialize, OnReady, InitializedHandler
- Chama actions do modulo: GalleryDestroy, GalleryChangeTextProperty, GalleryRegisterCallback, LogEvent, GenerateUniqueId, GalleryCreate, GalleryInitialize (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.GalleryAPI.Dispose`, `OutSystems.OSUI.Patterns.GalleryAPI.ChangeProperty`, `OutSystems.OSUI.Patterns.GalleryAPI.RegisterCallback`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.GalleryAPI.Create`, `OutSystems.OSUI.Patterns.GalleryAPI.Initialize`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.Initialized = $actions.InitializedHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Gallery1","source":"IMobileBlock:Gallery","empty":true,"as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"Gallery1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"GalleryId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/GalleryId","prop":"Value","value":"GalleryId"}
```
