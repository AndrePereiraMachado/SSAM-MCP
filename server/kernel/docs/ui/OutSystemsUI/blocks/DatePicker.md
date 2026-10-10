# DatePicker

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 9 widgets internos

Allows the user to select a single date using a calendar.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| DateFormat | Text | nao |  | Set the input date format. If empty, the date format will the same as the server format.  Here's some of the examples that you can use: • "DD/MM/YYYY"    -> 23/03/2018 • "MM/DD/YYYY"    -> 03/23/2018 • "DD MMM YYYY"   -> 23 Mar 2018 • "DD-MMM-YYYY"   -> 23-Mar-2018 • "DD.MMM.YYYY"   -> 23.Mar.2018 • "MMM DDD, YYYY" -> Mar Mond, 2021 • "MMM DDD, YY"   -> Mar Mond, 21 • ...  The time format will be determined by the TimeFormat property. |
| ShowTodayButton | Boolean | nao | False | Set to True to show a button below the DatePicker that allows users to pick the current day date. |
| TimeFormat | DatePickerTimeFormat Identifier | nao | Entities.DatePickerTimeFormat.Disabled | Select the format of the time (12 hours or 24 hours). By default, no time is shown (Disabled). |
| OptionalConfigs | DatePickerOptionalConfigs | nao |  | Set additional parameters to customize DatePicker behavior and functionality. |
| ExtendedClass | Text | nao |  | Add custom style classes to the pattern. You define your custom style classes in your application using CSS. Examples: - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/StyleGuidePreview/Styles |

Valores possiveis (static entities):

- **Entities.DatePickerTimeFormat**: Disabled, Time12hFormat, Time24hFormat

## Placeholders

- **Datepicker**: Add an Input Date or DateTime type | nasce com: Input:Datepicker_Input. Esse Input e parte do padrao: NAO use empty; ligue-o com `set $b/Datepicker/#IInput prop Variable value <variavel>` (os nomes reais sao renumerados, ex. Input1; enderece por tipo)
- **Placeholder_SSPreview** (em `ServiceStudioPreview`)

## Eventos

- **Initialized**(DatePickerId: Text): Event triggered after the DatePicker instance is ready.
- **OnSelected**(DatePickerId: Text, SelectedDateTime: Date Time) [obrigatorio]: Event triggered each time a date is selected.

## Composicao interna

- Scripts exigidos: FlatpickrLocale, OutSystemsUI
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnRender -> OnRender; OnDestroy -> OnDestroy
- Actions do bloco: OnDestroy, InitializedHandler, OnRender, RegisterCallbacks, OnInitialize, OnChangeDateHandler, OnReady, OnParametersChanged
- Chama actions do modulo: DatePickerDestroy, DatePickerOnRender, DatePickerRegisterCallback, SetServerDateFormat, LogEvent, DatePickerCreate, SetLocalLanguage, GenerateUniqueId, DatePickerInitialize, DatePickerChangeDateTimeProperty, DatePickerChangeBooleanProperty, DatePickerChangeIntegerProperty, DatePickerChangeTextProperty (contratos em [actions.md](../actions.md))

## JavaScript

APIs OSUI alcancadas (direto ou pelas actions chamadas): `OutSystems.OSUI.Patterns.DatePickerAPI.Dispose`, `OutSystems.OSUI.Patterns.DatePickerAPI.OnRender`, `OutSystems.OSUI.Patterns.DatePickerAPI.RegisterCallback`, `OutSystems.OSUI.Dates.SetServerDateFormat`, `OutSystems.OSUI.Utils.LogMessage`, `OutSystems.OSUI.Patterns.DatePickerAPI.Create`, `OutSystems.OSUI.Language.Set`, `OutSystems.OSUI.Utils.GenerateUniqueId`, `OutSystems.OSUI.Patterns.DatePickerAPI.Initialize`, `OutSystems.OSUI.Patterns.DatePickerAPI.ChangeProperty`

`RegisterCallbacks` / no `GetCallbackHandlers`:

```js
$parameters.OnChange = $actions.OnChangeDateHandler;
$parameters.OnInitialize = $actions.InitializedHandler;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DatePicker1","source":"IMobileBlock:DatePicker","as":"$b"}
{"op":"set","target":"$b/Datepicker/#IInput","prop":"Variable","value":"<variavel local>"}
{"op":"create","parent":"$b/Placeholder_SSPreview","type":"IExpression","as":"$ePlaceholder_SSPreview"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DatePicker1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"DatePickerId","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Text"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/DatePickerId","prop":"Value","value":"DatePickerId"}
```
