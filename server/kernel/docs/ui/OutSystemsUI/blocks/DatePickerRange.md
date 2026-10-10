# DatePickerRange

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 9 widgets internos

Allows the user to select a range of dates using a calendar.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| DateFormat | Text | nao |  | Set the input date format. If empty, the date format will be the same as the server format. When using formats with time, make sure to set the TimeFormat property.  Here are some of the examples that you can use: • "DD/MM/YYYY"    -> 23/03/2018 • "MM/DD/YYYY"    -> 03/23/2018 • "DD MMM YYYY"   -> 23 Mar 2018 • "DD-MMM-YYYY"   -> 23-Mar-2018 • "DD.MMM.YYYY"   -> 23.Mar.2018 • "MMM DDD, YYYY" -> Mar Mon, 2021 • "MMM DDD, YY"   -> Mar Mon, 21 |
| ShowTodayButton | Boolean | nao | False | Set to "True" to show a button below the DatePicker that allows users to pick the current day date. |
| OptionalConfigs | DatePickerRangeOptionalConfigs | nao |  | Set additional parameters to customize the DatePickerRange behavior and functionality. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your app using CSS. Examples: - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI. You can also use the classes available on the OutSystems UI. For more information, go to the OutSystems UI Cheatsheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Datepicker**: Add an Input Date or DateTime type | nasce com: Input:Datepicker_Input. Esse Input e parte do padrao: NAO use empty; ligue-o com `set $b/Datepicker/#IInput prop Variable value <variavel>` (os nomes reais sao renumerados, ex. Input1; enderece por tipo)
- **Placeholder_SSPreview** (em `ServiceStudioPreview`)

## Eventos

- **OnSelected**(DatePickerId: Text, SelectedStartDate: Date, SelectedEndDate: Date) [obrigatorio]: Event triggered when a range of dates is selected.
- **Initialized**(DatePickerId: Text): Event triggered after the DatePickerRange instance is ready.

## Composicao interna

- Scripts exigidos: FlatpickrLocale, OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnRender -> OnRender; OnDestroy -> OnDestroy
- Actions do bloco: OnParametersChanged, OnDestroy, OnRender, RegisterCallbacks, OnInitialize, InitializedHandler, OnReady, OnChangeDateHandler
- Chama actions do modulo: DatePickerChangeDateTimeProperty, DatePickerChangeIntegerProperty, DatePickerChangeBooleanProperty, DatePickerChangeTextProperty, DatePickerDestroy, DatePickerOnRender, DatePickerRegisterCallback, GenerateUniqueId, SetLocalLanguage, SetServerDateFormat, LogEvent, DatePickerCreate, DatePickerInitialize (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.DatePickerAPI.ChangeProperty`, `OutSystems.OSUI.Patterns.DatePickerAPI.Dispose`, `OutSystems.OSUI.Patterns.DatePickerAPI.OnRender`, `OutSystems.OSUI.Patterns.DatePickerAPI.RegisterCallback`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Language.Set`, `OutSystems.OSUI.Dates.SetServerDateFormat`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.DatePickerAPI.Create`, `OutSystems.OSUI.Patterns.DatePickerAPI.Initialize`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.OnChange = $actions.OnChangeDateHandler;
$parameters.OnInitialize = $actions.InitializedHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DatePickerRange1","source":"IMobileBlock:DatePickerRange","as":"$b"}
{"op":"set","target":"$b/Datepicker/#IInput","prop":"Variable","value":"<variavel local>"}
{"op":"create","parent":"$b/Placeholder_SSPreview","type":"IExpression","as":"$ePlaceholder_SSPreview"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnSelected` resolve o IEventHandler pelo nome do evento e `$b/OnSelected/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DatePickerRange1_OnSelected","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"DatePickerId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"SelectedStartDate","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Date"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"SelectedEndDate","as":"$p3"}
{"op":"set","target":"$p3","prop":"DataType","value":"Date"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnSelected","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnSelected/DatePickerId","prop":"Value","value":"DatePickerId"}
{"op":"set","target":"$b/OnSelected/SelectedStartDate","prop":"Value","value":"SelectedStartDate"}
{"op":"set","target":"$b/OnSelected/SelectedEndDate","prop":"Value","value":"SelectedEndDate"}
```
