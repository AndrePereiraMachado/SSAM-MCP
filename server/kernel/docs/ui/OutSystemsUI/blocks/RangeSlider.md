# RangeSlider

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 11 widgets internos

Select a single value within a range, using a sliding handle.

For advanced options, read the official documentation:
https://refreshless.com/nouislider/

Note: To ensure the correct behavior of the component, we recommend not using different versions of it in the same page.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| MinValue | Decimal | sim |  | The slider's minimum value. |
| MaxValue | Decimal | sim |  | The slider's maximum value. |
| StartingValue | Decimal | sim |  | Value selected by default. Must be between min and max values. |
| Orientation | Orientation Identifier | nao | Entities.Orientation.Horizontal | Set the direction of the RangeSlider. By default, horizontal. |
| Size | Text | nao | "100%" | Set the RangeSlider size. If horizontal, the size is the width. Otherwise (vertical), the size is the height.  Accepts any kind of unit (px, %, vw). By default, "100%".  Example: "30%" |
| OptionalConfigs | RangeSliderOptionalConfigs | nao |  | Set additional parameters to customize the RangeSlider behavior and functionality. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Orientation**: Horizontal, Vertical

## Placeholders

Nenhum.

## Eventos

- **OnValueChange**(RangeSliderId: Text, Value: Decimal) [obrigatorio]: Event triggered after selecting a new value on the slider. By default, the event is triggered while the user is dragging the RangeSlider handler. 
You can use the SetRangeSliderChangeOnDragEnd to trigger the event only after the user releases it.
- **Initialized**(RangeSliderId: Text): Event triggered after the RangerSlider instance is ready.

With this event you get the element Id that can be used to call methods from the RangeSliderAPI:
OutSystems.OSUI.Patterns.RangeSliderAPI

## Composicao interna

- Scripts exigidos: wNumb, NoUISlider, OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnParametersChanged, OnInitialize, OnDestroy, OnReady, IntializeHandler, OnValueChangeHandler, RegisterCallbacks
- Chama actions do modulo: RangeSliderChangeTextProperty, RangeSliderChangeDecimalProperty, RangeSliderChangeBooleanProperty, LogEvent, GenerateUniqueId, RangeSliderCreate, RangeSliderDestroy, RangeSliderInitialize, RangeSliderRegisterCallback (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.RangeSliderAPI.ChangeProperty`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.RangeSliderAPI.Create`, `OutSystems.OSUI.Patterns.RangeSliderAPI.Dispose`, `OutSystems.OSUI.Patterns.RangeSliderAPI.Initialize`, `OutSystems.OSUI.Patterns.RangeSliderAPI.RegisterCallback`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.OnValueChange = $actions.OnValueChangeHandler;

$parameters.RangeSliderInitializedObj = $actions.IntializeHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"RangeSlider1","source":"IMobileBlock:RangeSlider","as":"$b"}
{"op":"set","target":"$b/MinValue","prop":"Value","value":"<Decimal>"}
{"op":"set","target":"$b/MaxValue","prop":"Value","value":"<Decimal>"}
{"op":"set","target":"$b/StartingValue","prop":"Value","value":"<Decimal>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnValueChange` resolve o IEventHandler pelo nome do evento e `$b/OnValueChange/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"RangeSlider1_OnValueChange","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"RangeSliderId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"Value","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Decimal"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnValueChange","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnValueChange/RangeSliderId","prop":"Value","value":"RangeSliderId"}
{"op":"set","target":"$b/OnValueChange/Value","prop":"Value","value":"Value"}
```
