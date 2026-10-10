# MonthPicker

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 14 widgets internos

Allows the user to select a single month and year using a calendar.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| DateFormat | Text | nao | "MM/YYYY" | Set the input date format. If empty, the date format will be the same as the server format. When using formats with time, make sure to set the TimeFormat property. Here are some of the examples that you can use:  - "MM/YYYY" -> 03/2022 - "MMM YYYY" -> Mar 2022 - "MMM-YYYY" -> Mar-2022 - "MMM.YYYY" -> Mar.2022 - "MMM, YY" -> Mar, 22 |
| InitialMonth | MonthYear | nao |  | The initial selected month and year for the MonthPicker. If not set, no initial date is selected. |
| MinMonth | MonthYear | nao |  | Set the minimum month that can be selected. Any month before this is disabled and cannot be selected. |
| MaxMonth | MonthYear | nao |  | Set the maximum month that can be selected. Any month after this is disabled and cannot be selected. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.  Examples: - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **MonthPicker**: Add an Input Date type | nasce com: Input:Monthpicker_Input. Esse Input e parte do padrao: NAO use empty; ligue-o com `set $b/MonthPicker/#IInput prop Variable value <variavel>` (os nomes reais sao renumerados, ex. Input1; enderece por tipo)
- **Placeholder_SSPreview** (em `ServiceStudioPreview`)

## Eventos

- **OnSelected**(MonthpickerId: Text, SelectedMonth: MonthOrderYear) [obrigatorio]: Event triggered when the user selects a month.
- **Initialized**(MonthpickerId: Text): Event triggered after the MonthPicker instance is ready.

## Composicao interna

- Scripts exigidos: FlatpickrMonthPlugin, FlatpickrLocale, OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnRender -> OnRender; OnDestroy -> OnDestroy
- Actions do bloco: OnSelectedMonthHandler, InitializedHandler, RegisterCallbacks, OnInitialize, OnDestroy, OnRender, OnReady, OnParametersChanged
- Chama actions do modulo: MonthPickerRegisterCallback, GenerateUniqueId, SetServerDateFormat, MonthPickerCreate, SetLocalLanguage, LogEvent, MonthPickerDestroy, MonthPickerOnRender, MonthPickerInitialize, MonthPickerChangeMonthYearProperty, MonthPickerChangeTextProperty (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.MonthPickerAPI.RegisterCallback`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Dates.SetServerDateFormat`, `OutSystems.OSUI.Patterns.MonthPickerAPI.Create`, `OutSystems.OSUI.Language.Set`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.MonthPickerAPI.Dispose`, `OutSystems.OSUI.Patterns.MonthPickerAPI.OnRender`, `OutSystems.OSUI.Patterns.MonthPickerAPI.Initialize`, `OutSystems.OSUI.Patterns.MonthPickerAPI.ChangeProperty`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.OnSelected = $actions.OnSelectedMonthHandler;
$parameters.OnInitialized = $actions.InitializedHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"MonthPicker1","source":"IMobileBlock:MonthPicker","as":"$b"}
{"op":"set","target":"$b/MonthPicker/#IInput","prop":"Variable","value":"<variavel local>"}
{"op":"create","parent":"$b/Placeholder_SSPreview","type":"IExpression","as":"$ePlaceholder_SSPreview"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnSelected` resolve o IEventHandler pelo nome do evento e `$b/OnSelected/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"MonthPicker1_OnSelected","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"MonthpickerId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"SelectedMonth","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"MonthOrderYear"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnSelected","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnSelected/MonthpickerId","prop":"Value","value":"MonthpickerId"}
{"op":"set","target":"$b/OnSelected/SelectedMonth","prop":"Value","value":"SelectedMonth"}
```
