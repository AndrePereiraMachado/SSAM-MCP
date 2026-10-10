# TimePicker

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 7 widgets internos

Allows the user to select a time using a picker.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| TimeFormat | Text | nao |  | Set the input time format. If empty, the time format will be defined based on the Is24Hours parameter.  Here is a list of formatting tokens that you can use:  H → Hours (24 hours) h → Hours (12 hours) G → Hours (12 hours), 2 digits with leading zeros i → Minutes s → Seconds S → Seconds, 2 digits with leading zeros K → AM/PM  You may escape formatting tokens using \\.  Examples: “H:i” → 15:30 “G:i K” → 03:30 PM ”h\\hi\\m K” → 3h30m PM ”H \\ho\\ur\\s i \\m\\i\\n\\ute\\s” → 15 hours 30 minutes |
| Is24Hours | Boolean | nao | True | Set to “True” to display the time in a 24 hour format without AM/PM selection. By default, the time is displayed using a 24 hour format. |
| InitialTime | Time | nao |  | The initial selected time for the TimePicker. If not set, no initial time will be displayed on the input and the TimePicker will start at 12:00. |
| OptionalConfigs | TimePickerOptionalConfigs | nao |  | Set additional parameters to customize TimePicker behavior and functionality. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. Examples: - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/StyleGuidePreview/Styles |

## Placeholders

- **Timepicker**: Add an Input Time type | nasce com: Input:Timepicker_Input. Esse Input e parte do padrao: NAO use empty; ligue-o com `set $b/Timepicker/#IInput prop Variable value <variavel>` (os nomes reais sao renumerados, ex. Input1; enderece por tipo)
- **Placeholder_SSPreview** (em `ServiceStudioPreview`)

## Eventos

- **OnSelected**(TimePickerId: Text, SelectedTime: Time) [obrigatorio]: Event triggered when the user selects a time.
- **Initialized**(TimePickerId: Text): Event triggered after the TimePicker instance is ready

## Composicao interna

- Scripts exigidos: FlatpickrLocale, OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnRender -> OnRender; OnDestroy -> OnDestroy
- Actions do bloco: OnInitialize, OnRender, OnReady, OnDestroy, OnChangeTimeHandler, RegisterCallbacks, OnParametersChanged, InitializedHandler
- Chama actions do modulo: SetServerDateFormat, TimePickerCreate, LogEvent, SetLocalLanguage, GenerateUniqueId, TimePickerOnRender, TimePickerInitialize, TimePickerDestroy, TimePickerRegisterCallback, TimePickerChangeTimeProperty, TimePickerChangeTextProperty, TimePickerChangeBooleanProperty (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Dates.SetServerDateFormat`, `OutSystems.OSUI.Patterns.TimePickerAPI.Create`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Language.Set`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.TimePickerAPI.OnRender`, `OutSystems.OSUI.Patterns.TimePickerAPI.Initialize`, `OutSystems.OSUI.Patterns.TimePickerAPI.Dispose`, `OutSystems.OSUI.Patterns.TimePickerAPI.RegisterCallback`, `OutSystems.OSUI.Patterns.TimePickerAPI.ChangeProperty`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.OnChange = $actions.OnChangeTimeHandler;
$parameters.OnInitialized = $actions.InitializedHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"TimePicker1","source":"IMobileBlock:TimePicker","as":"$b"}
{"op":"set","target":"$b/Timepicker/#IInput","prop":"Variable","value":"<variavel local>"}
{"op":"create","parent":"$b/Placeholder_SSPreview","type":"IExpression","as":"$ePlaceholder_SSPreview"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnSelected` resolve o IEventHandler pelo nome do evento e `$b/OnSelected/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"TimePicker1_OnSelected","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"TimePickerId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"SelectedTime","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Time"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnSelected","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnSelected/TimePickerId","prop":"Value","value":"TimePickerId"}
{"op":"set","target":"$b/OnSelected/SelectedTime","prop":"Value","value":"SelectedTime"}
```
