# Rating

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Numbers** | publico | 14 widgets internos

Use this pattern to let your users score your products and services.

Drag the pattern to the screen and set the Rating Value parameter.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| RatingValue | Decimal | sim |  | Rating number to be displayed. |
| RatingScale | Integer | nao | 5 | Rating scale that determines the number of items to be displayed. By default, the scale is "5". If set to 1, it will behave as a 'view only' element, with IsEdit automatically set to false.  The parameter maximum value is 100. If the value introduced is bigger, only 100 items will be displayed. |
| IsEdit | Boolean | nao | False | Set to True to allow users to interact with the pattern. Default value is False. |
| Size | Size Identifier | nao |  | Sets the size of the Rating pattern. There are 3 sizes available; Small, Medium, and Base. Default size is Base. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Size**: Small, Medium

## Placeholders

- **FilledState** (em `Rating/content/Fieldset/content/IconStates/content`) | nasce com: Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **HalfState** (em `Rating/content/Fieldset/content/IconStates/content`) | nasce com: Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **EmptyState** (em `Rating/content/Fieldset/content/IconStates/content`) | nasce com: Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **Initialized**(RatingId: Text): Event triggered after the Rating instance is ready.
- **OnSelect**(RatingId: Text, Value: Decimal): Event that returns the current rating value.

## Composicao interna

- Scripts exigidos: OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: InitializedHandler, OnSelectHandler, OnDestroy, OnParametersChanged, OnReady, RegisterCallback, OnInitialize
- Chama actions do modulo: RatingDestroy, RatingChangeRatingValue, RatingChangeRatingScale, RatingChangeExtendedClass, RatingChangeIsEdit, RatingChangeSize, RatingInitialize, LogEvent, RatingRegisterCallback, GenerateUniqueId, RatingCreate (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.RatingAPI.Dispose`, `OutSystems.OSUI.Patterns.RatingAPI.ChangeProperty`, `OutSystems.OSUI.Patterns.RatingAPI.Initialize`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.RatingAPI.RegisterCallback`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.RatingAPI.Create`

`RegisterCallback` / no `GetCallbackHandler`:

```js
$parameters.OnInitializedHandler = $actions.InitializedHandler;
$parameters.OnSelectHandler = $actions.OnSelectHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Rating1","source":"IMobileBlock:Rating","empty":true,"as":"$b"}
{"op":"set","target":"$b/RatingValue","prop":"Value","value":"<Decimal>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"Rating1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"RatingId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/RatingId","prop":"Value","value":"RatingId"}
```
