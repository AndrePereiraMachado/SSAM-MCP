# DEPRECATED_DatePicker

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 12 widgets internos

Date and time picker with a flat UI to be displayed inline on the screen. It can receive lists of dates with events and selection within a range of days.

For better usability and compatibility with library behaviors, you should use with an input and variable of type "text".

Previously called Calendar.

For advanced options, read the official documentation:
https://github.com/dbushell/Pikaday

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| InputWidgetId | Text | nao |  | Input Element Name that will trigger the element to be visible. |
| ButtonWidgetId | Text | nao |  | Element Name (example: button) that will trigger the element to be visible.  It overrides what triggers the opening of the date picker. |
| EventList | Date Time List | nao |  | Receives a List of DateTime records that are used to highlight days as event days. |
| MinDate | Date Time | nao |  | Days before this date will be disabled. |
| MaxDate | Date Time | nao |  | Days after this date will be disabled. |
| InitialDate | Date Time | nao |  | The initial selected day for the Date Picker. If not set, it will be the current day by default. |
| ShowWeekNumbers | Boolean | nao |  | Displays the week number on the left side of the Date Picker. |
| FirstWeekDay | Integer | nao | 1 | Defines which week day should be displayed first.  0: Sunday 1: Monday 2: Tuesday 3: Wednesday 4: Thursday 5: Friday 6: Saturday |
| ShowTime | Boolean | nao | False | Displays a time picker below the Date Picker. |
| Show24HourFormat | Boolean | nao | True | Changes the time picker to a 24 hour format. |
| DisabledDaysList | Date Time List | nao |  | Receives a List of DateTime records that are will be disabled on the Date Picker.  If this parameter is not set, all days are between the MinDate and MaxDate are enabled. |
| DisabledWeekDays | Text | nao | "" | String containing disabled weekdays.  If the string is empty, all weekdays are active.  Example with Sunday and Friday disabled: "0,5"  0: Sunday 1: Monday 2: Tuesday 3: Wednesday 4: Thursday 5: Friday 6: Saturday |
| SelectInterval | Boolean | nao |  | Allows the selection between two dates.  In this case, the Block Event "On Select" will have values for both parameters. |
| StartEmpty | Boolean | nao | False | Determines if the input for the date picker starts as empty |
| DateFormat | Text | nao | "" | Defaults to "YYYY-MM-DD" format, accepted by Form Validations.  For better compatibility we advise using an input and variable of type "text". If that's the case, here's some of the examples that you can use:         "DD/MM/YYYY" -> 23/03/2018         "MM/DD/YYYY" -> 03/23/2018         "DD MMM YYYY" -> 23 Mar 2018  If using an input/ variable of type Date or DateTime, the only options available are (due to Form Validations):         Server Format         "YYYY-MM-DDTHH:mm:ss.sssZ"         "YYYY-MM-DD HH:mm:ss"         "YYYY/MM/DD HH:mm:ss"         "YYYY.MM.DD HH:mm:ss"         "YYYY.MM.DD"         "YYYY/MM/DD"         "YYYY-MM-DD" |
| ShowTodayButton | Boolean | nao | False | Set to True, to show Today button. |
| AdvancedFormat | Text | nao |  | Allow for more options beyond what it's provided through the inputs.  "{     i18n: {         previousMonth : 'Anterior',         nextMonth     : 'Próximo',         months        : ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'],         weekdays      : ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'],         weekdaysShort : ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'],         todayButton   : 'Hoje'     },      i18nAccessibility: {         isDisabled        : 'Desactivado. ',         isToday           : 'Hoje. ',         daySelected       : 'Dia seleccionado. ',         hasEvent          : 'Tem evento.',         daysInRange       : 'Dias no intervalo de datas. ',         startRange        : 'Início do intervalo de datas. ',         endRange          : 'Fim do intervalo de datas. ',         navigation        : 'navegação',         month             : 'mês',         year              : 'ano',         previousMonth     : 'Mês anterior',         nextMonth         : 'Próximo mês',         keyboardShortcuts : 'Lista de atalhos',         calendarDates     : 'Dias do calendário',         shortcutsDialog   : ['Lista de atalhos disponíveis:','LEFT/RIGHT navega entre os dias.','UP/DOWN navega entre semanas.','DELETE anula a data.','ESCAPE fecha o calendário.','PAGE UP navega para o mês anterior.','PAGE DOWN navega para o próximo mês.','SPACE/ENTER selecciona a data.'],         dialogButton      : 'Entendi!',         dateSelected      : 'Data seleccionada: ',         calendar          : 'Calendário',         goToToday         : 'Ir para o dia actual',         openCalendar      : 'Aberto. Pressione Enter para fechar o calendário',         closeCalendar     : 'Fechado. Pressione Enter para abrir o calendário',         enterCalendar     : 'Pressione Tab para entrar no calendário'     } }"  For more information visit: https://github.com/Pikaday/Pikaday#configuration |

## Placeholders

Nenhum.

## Eventos

- **OnSelect**(StartDate: Date Time, EndDate: Date Time) [obrigatorio]: Event to trigger after selecting a date on the date picker.
If SelectInterval is enabled, both parameters return values, if not, only the StartDate has a value.

## Composicao interna

- Scripts exigidos: DEPRECATED_Moment, DEPRECATED_Calendar
- Ciclo de vida: OnInitialize -> OnInitialize; OnParametersChanged -> OnParametersChanged; OnReady -> OnReady; OnDestroy -> OnDestroy
- Actions do bloco: OnInitialize, SetValue, Init, OnParametersChanged, OnDestroy, SelectDate, CheckValueOnFormValidation, Observer, CheckFieldValue, OnReady
- Chama actions do modulo: DEPRECATED_DatepickerExposeTranslations (contratos em [actions.md](../actions.md))

## JavaScript

`SetValue` / no `JsSetValue`:

```js
if($parameters.IsInterval) {
    $parameters.CalendarObj.setStartRange($parameters.CurrentStartDate); 
    $parameters.CalendarObj.setEndRange($parameters.CurrentEndDate);            
    $parameters.CalendarObj.draw();
}

if($parameters.IsInputBounded && !$parameters.disableInputOverride) {
    var field = document.getElementById($parameters.InputWidgetId);
    var defaultFormat = $parameters.ShowTime ? "YYYY-MM-DD HH:mm" : "YYYY-MM-DD";
    var isValid = isFormatValid($parameters.Format);
    var fieldType = $parameters.FieldType;
    
    // Check if Dateformat is used or if input is of type text, otherwise use server format
    var dateFormat = $parameters.Format.length === 0 || fieldType !== "text" ? (isValid ? $parameters.Format : defaultFormat) : $parameters.Format;
    
    // If StartEmpty, init date is empty, otherwise use a formatted one
    var formattedStartDate = moment(new Date($parameters.CurrentStartDate)).format(dateFormat);
    var formattedEndDate = moment(new Date($parameters.CurrentEndDate)).format(dateFormat);
    
    if(field) {
        field.value = $parameters.IsInterval ? formattedStartDate + ($parameters.IsEndDateNull ? "" : " - " + formattedEndDate) : formattedStartDate;
    }
}

function isFormatValid(format) {
    var isFormatValid;
    switch(format) {
        case "YYYY-MM-DDTHH:mm:ss.sssZ":
        case "YYYY-MM-DD HH:mm:ss":
        case "YYYY/MM/DD HH:mm:ss":
        case "YYYY.MM.DD HH:mm:ss":
        case "YYYY.MM.DD":
        case "YYYY/MM/DD":
        case "YYYY-MM-DD":
            isFormatValid = true;
        break;
        default:
            isFormatValid = false;
    }
    
    return isFormatValid;
} 
```

`Init` / no `JsInit`:

```js
var field = document.getElementById($parameters.InputWidgetid);
var str = String($parameters.AdvancedFormat);
var isValid = isFormatValid($parameters.Format);
var fieldType = $parameters.FieldType;
var initialDate = $parameters.InitialDate;
var defaultFormat = $parameters.ShowTime ? "YYYY-MM-DD HH:mm" : "YYYY-MM-DD";
var layout = document.querySelector('.layout');
var isRTL = document.querySelector('.is-rtl'); 
var hasAccessibility;

// Check if layout has accessibilty class
if(layout) {
    hasAccessibility = layout.classList.contains('has-accessible-features');
}

// Check if Dateformat is used or if input is of type text, otherwise use server format
var dateFormat = $parameters.Format.length === 0 || fieldType !== "text" ? (isValid ? $parameters.Format : defaultFormat) : $parameters.Format;

if(field && fieldType !== "text") {
    field.type = "text";
}

// Convert the parameters to an array of strings
$parameters.TranslateMonths = $parameters.TranslateMonths.split(',');
$parameters.TranslateWeekdays = $parameters.TranslateWeekdays.split(',');
$parameters.TranslateWeekdaysShort = $parameters.TranslateWeekdaysShort.split(',');
$parameters.TranslateShortcutsDialog = $parameters.TranslateShortcutsDialog.split(',');

// Set Library options
var options = {
    
    field: document.getElementById($parameters.InputWidgetid),
    
    trigger: document.getElementById($parameters.ButtonWidgetId),
    
    container: document.getElementById($parameters.CalendarId),
    
    bound: $parameters.IsBound,
    
    format: dateFormat,
    
    events: $parameters.Events,
    
    minDate: $parameters.MinDate,
   
    maxDate: $parameters.MaxDate,
    
    defaultDate: initialDate,
    
    setDefaultDate: true,
    
    showDaysInNextAndPreviousMonths: true,
    
    showWeekNumber: $parameters.ShowWeekNumbers,
    
    firstDay: $parameters.FirstDay,
    
    showTime: $parameters.ShowTime,
    
    use24hour: $parameters.Show24HourFormat,
    
    showTodayButton: $parameters.showTodayButton,
    
    isInterval: $parameters.selectInterval,
    
    // Apply RTL by default on Datepicker, if class is-rtl are applied
    hasRTL: isRTL ? true : false,
    
    calendarPosition: isRTL ? 'bottom right' : 'bottom left',
    
    // i18n translations
    translationsPreviousMonth: $parameters.TranslatePreviousMonth,
    
    translationsNextMonth: $parameters.TranslateNextMonth,
    
    translationsMonths: $parameters.TranslateMonths,
    
    translationsWeekdays: $parameters.TranslateWeekdays,
    
    translationsWeekdaysShort: $parameters.TranslateWeekdaysShort,
    
    translationsMidnight: $parameters.TranslateMidnight,
    
    translationsNoon: $parameters.TranslateNoon,
    
    translationsTodayButton: $parameters.TranslateTodayButton,
    
    // i18n Accessibility translations
    translationsCalendar: $parameters.TranslateCalendar,
    
    translationsCalendarDates: $parameters.TranslateCalendarDates,
    
    translationsCloseCalendar: $parameters.TranslateCloseCalendar,
    
    translationsDateSelected: $parameters.TranslateDateSelected,
    
    translationsDaySelected: $parameters.TranslateDaySelected,
    
    translationsDaysInRange: $parameters.TranslateDaysInRange,
    
    translationsDialogButton: $parameters.TranslateDialogButton,
    
    translationsEndRange: $parameters.TranslateEndRange,
    
    translationsEnterCalendar: $parameters.TranslateEnterCalendar,
    
    translationsGoToToday: $parameters.TranslateGoToToday,
    
    translationseHasEvent: $parameters.TranslateHasEvent,
    
    translationsIsDisabled: $parameters.TranslateIsDisabled,
    
    translationsIsToday: $parameters.TranslateIsToday,
    
    translationsKeyboardShortcuts: $parameters.TranslateKeyboardShortcuts,
    
    translationsMonth: $parameters.TranslateMonth,
    
    translationsNavigation: $parameters.TranslateNavigation,
    
    translationsMonthNext: $parameters.TranslateMonthNext,
    
    translationsMonthPrevious: $parameters.TranslateMonthPrevious,
    
    translationsOpenCalendar: $parameters.TranslateOpenCalendar,
    
    translationsStartRange: $parameters.TranslateStartRange,
    
    translationsYear: $parameters.TranslateYear,
    
    translationsShortcutsDialog: $parameters.TranslateShortcutsDialog,
    
    
    disableDayFn: function(d) {
        var disabledDay = $parameters.DisabledDates.indexOf(d.toDateString()) !== -1 ? true : false;
        var disabledWeekDay = $parameters.DisabledWeekDays.indexOf(d.getDay()) !== -1 ? true : false;
        
        if(disabledDay || disabledWeekDay) {
            return true;
        }
    },
    
    onSelect: function(d) {
        $actions.SelectDate(d);
    }
};

// Set AdvancedFomrmat          
if(str.length > 0) {
    var json = JSON.stringify(eval('(' + str + ')'));   
    options = mergeJSON(options, JSON.parse(json));
    
    // Check if container is defined
    if(options.hasOwnProperty('container')){
        options.container = eval(options.container);
    }
}

if(options.disableInputOverride === true) {
    $parameters.disableInputOverride = true;
}

$parameters.CalendarObj = new Pikaday(options);

if($parameters.IsBound && hasAccessibility) {
    $parameters.CalendarObj.el.classList.add('has-accessible-features');
}

if(field) {
    
    field.clearDate = function(){
        $parameters.CalendarObj.clear(); 
    };

    field.addEventListener('input', $actions.CheckFieldValue);
    
    field.value = $parameters.StartEmpty ? "" : moment(new Date(initialDate)).format(dateFormat); 
    
    setTimeout(function () {
            field.value = field.value.indexOf('T') === 10 ? field.value.replace("T", ' ') : field.value;
    }, 0);

    // Check for not-valid class after form validation to make sure the current value and dateFormat is maintained
    var observer = new MutationObserver(function (event) {
        $actions.CheckValueOnFormValidation(dateFormat);
    });

    observer.observe(field, {
        attributes: true, 

/* ... truncado: 1229 chars a mais no JSON do catalogo */
```

`Init` / no `ParseDisabledDates`:

```js
var events = JSON.parse($parameters.EventList);

$parameters.DisabledDates = [];

for(var i=0; i< events.length; i++) {
    var day = new Date(events[i]).toDateString();
    $parameters.DisabledDates.push(day);
}

$parameters.DisabledDates = $parameters.DisabledDates.toString();
```

`Init` / no `JsParseEvents`:

```js
var events = JSON.parse($parameters.EventList);

$parameters.Events = [];

for(var i=0; i< events.length; i++) {
    var day = new Date(events[i]).toDateString();
    $parameters.Events.push(day);
}

$parameters.Events = $parameters.Events.toString();
```

`OnParametersChanged` / no `JsCheckObjectStatus`:

```js
$parameters.ObjectIsDefined = $parameters.Object !== null;
```

`OnDestroy` / no `JsCallDestroyFunction`:

```js
if($parameters.CalendarObj !== null)
{
    $parameters.CalendarObj.destroy();
}

if($parameters.ObserverLangObj !== null)
{
    $parameters.ObserverLangObj.disconnect();
}

if($parameters.ObserverFormClassObj !== null)
{
    $parameters.ObserverFormClassObj.disconnect();
}
```

`CheckValueOnFormValidation` / no `JsSetValueAfterFormValidation`:

```js
var obj = $parameters.Obj;
var field = $parameters.Obj._o.field;
var dateFormat = $parameters.DateFormat;
var selectedDate = $parameters.SelectedDate;

if(field) {
    field.value = $parameters.IsNull ? "" : moment(new Date(selectedDate)).format(dateFormat); 
} 
```

`Observer` / no `JsObserver`:

```js
//target element that we will observe
var target = document.documentElement;

//Define observer configurations
var config = {
    attributeFilter: [ "lang" ],
    attributeOldValue: true,
    characterData: false,
    characterDataOldValue: false,
    childList: false,
    subtree: false
};

//Call update action to apply new values on datepicker only when lang changed
function updateDatepicker(mutations) {
    if(mutations[0].oldValue !== document.documentElement.lang){
        switch(mutations[0].type) {
            case "attributes":
                switch(mutations[0].attributeName) {
                    case "lang":
                        $actions.OnParametersChanged();
                    break;
                
                }
            break;
        }  
    }
}

//instantiating observer
var observer = new MutationObserver(updateDatepicker);

//observing target
observer.observe(target, config);

//store and return observer as an object
$parameters.ObserverLangObj = observer;

```

`CheckFieldValue` / no `JsGetFieldValue`:

```js
var field = document.getElementById($parameters.InputWidgetId);

if(field) {
    $parameters.FieldValue = field.value; 
}
```

`OnReady` / no `JsGetInputType`:

```js
var field = document.getElementById($parameters.InputWidgetId);
var fieldType;

if(field && field.type !== undefined) {
    $parameters.FieldType = field.type;
}

```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_DatePicker1","source":"IMobileBlock:DEPRECATED_DatePicker","as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnSelect` resolve o IEventHandler pelo nome do evento e `$b/OnSelect/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"DEPRECATED_DatePicker1_OnSelect","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"StartDate","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Date Time"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"EndDate","as":"$p2"}
{"op":"set","target":"$p2","prop":"DataType","value":"Date Time"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnSelect","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnSelect/StartDate","prop":"Value","value":"StartDate"}
{"op":"set","target":"$b/OnSelect/EndDate","prop":"Value","value":"EndDate"}
```
