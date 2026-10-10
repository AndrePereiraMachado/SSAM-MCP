# RangeSliderInterval

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 12 widgets internos

Select an interval within a range of values, using two sliding handles.

For advanced options, read the official documentation:
https://refreshless.com/nouislider/

Note: To ensure the correct behavior of the component, we recommend not using different versions of it in the same page.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| MinValue | Decimal | sim |  | Slider's minimum value. |
| MaxValue | Decimal | sim |  | Slider's maximum value. |
| StartingValueFrom | Decimal | sim |  | Default value for the interval's start. Must be between min and max values. |
| StartingValueTo | Decimal | sim |  | Default value for the interval's end. Must be between min and max values. |
| Orientation | Orientation Identifier | nao | Entities.Orientation.Horizontal | Set the direction of the RangeSlider. By default, horizontal. |
| Size | Text | nao | "100%" | Set the size of the Range Slider Interval. If the slider's orientation is horizontal, the size you set will be the width of the Range Slider Interval. Otherwise (vertical), the size you set will be the height. Accepts any kind of unit (px, %, vw). Default value is 100%. |
| OptionalConfigs | RangeSliderOptionalConfigs | nao |  | Set additional parameters to customize the RangeSliderInterval behavior and functionality. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Orientation**: Horizontal, Vertical

## Placeholders

Nenhum.

## Eventos

- **Initialized**(RangeSliderIntervalId: Text): Event triggered after the RangerSliderInterval instance is ready.

With this event you get the element Id that can be used to call methods from the RangeSliderAPI:
OutSystems.OSUI.Patterns.RangeSliderAPI
- **OnValueChange**(RangeSliderIntervalId: Text, IntervalStart: Decimal, IntervalEnd: Decimal) [obrigatorio]: Event triggered after selecting a new value on the slider. By default, the event is triggered while the user is dragging the RangeSliderInterval handler. You can use the SetRangeSliderIntervalChangeOnDragEnd to trigger the event only after the user releases it.

## Composicao interna

- Scripts exigidos: wNumb, NoUISlider, OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: RegisterCallbacks, OnParametersChanged, OnValueChangeHandler, OnInitialize, OnReady, IntializeHandler, OnDestroy
- Chama actions do modulo: RangeSliderRegisterCallback, RangeSliderChangeTextProperty, RangeSliderChangeDecimalProperty, RangeSliderChangeBooleanProperty, GenerateUniqueId, RangeSliderCreate, LogEvent, RangeSliderInitialize, RangeSliderDestroy (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.RangeSliderAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.RangeSliderAPI.ChangeProperty`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.RangeSliderAPI.Create`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.RangeSliderAPI.Initialize`, `OutSystems.OSUI.Patterns.RangeSliderAPI.Dispose`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.OnValueChange = $actions.OnValueChangeHandler;

$parameters.RangeSliderInitializedObj = $actions.IntializeHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"RangeSliderInterval1","source":"IMobileBlock:RangeSliderInterval","as":"$b"}
{"op":"set","target":"$b/MinValue","prop":"Value","value":"<Decimal>"}
{"op":"set","target":"$b/MaxValue","prop":"Value","value":"<Decimal>"}
{"op":"set","target":"$b/StartingValueFrom","prop":"Value","value":"<Decimal>"}
{"op":"set","target":"$b/StartingValueTo","prop":"Value","value":"<Decimal>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"RangeSliderInterval1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"RangeSliderIntervalId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/RangeSliderIntervalId","prop":"Value","value":"RangeSliderIntervalId"}
```
