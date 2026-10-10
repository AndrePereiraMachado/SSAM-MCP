# DatePicker

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Controls** | publico | 12 widgets internos

Used to select a date or simply check the calendar and allows to be displayed on smartphones instead of reverting to the native picker.

Drag an input and the date picker to the Web Screen and set up the parameters. The only mandatory one is the InputWidgetId which must reference an input widget that will show the date picked on the page.

For advanced options, read the official documentation:
https://github.com/dbushell/Pikaday

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| InputWidgetId | Text | sim |  | Input Element Name that will trigger the element to be visible. |
| ButtonWidgetId | Text | nao | "" | Element Name (example: button) that will trigger the element to be visible.  It overrides what triggers the opening of the date picker. |
| DisabledDates | Date List | nao |  | List of dates for the disabled days. |
| MinDate | Date | nao |  | Date Picker enables dates from this date onwards and disables dates before this date. |
| MaxDate | Date | nao |  | Date Picker enables dates that come before this date and disables dates after this date. |
| InitialDate | Date Time | nao | CurrDate() | If set, the calendar will initially display the set date, otherwise it will display the  current Date. |
| DateFormat | Text | nao | "" | Defaults to the date format defined in the server configuration. The default is the server date format.     some of the examples that you can use:         "DD/MM/YYYY" -> 23/03/2018         "MM/DD/YYYY" -> 03/23/2018         "DD MMM YYYY" -> 23 Mar 2018 |
| StartEmpty | Boolean | nao | False | Determines if the input for the date picker starts as empty |
| SelectInterval | Boolean | nao | False | Allows the selection between two dates.  In this case, the Event "On Select" will have values for both parameters. |
| AdvancedFormat | DatePickerAdvancedFormat | nao |  | Allows for more options that the ones given in the input parameters.   Inputs:     DatePickerAdvancedFormat          EventsList (Date Time List)         AdvancedFormatJSON (Text) |

## Placeholders

Nenhum.

## Eventos

- **OnSelect**(StartDate: Date, EndDate: Date): Event will be triggered when a date is selected returning it.
- **onClose**(StartDate: Date, EndDate: Date): Event that will be triggered once you close the date picker which returns the last selected date.
- **onOpen**(): Event that will be triggered once you open the date picker.

## Composicao interna

- Usa os blocos: JavaScriptNode, Moment_2_29_4, EventThroughExtensibility
- Actions do bloco: CloseEventEventFromJS, PickDateEventFromJS
- Chama actions do modulo: GetServerDateFormat (contratos em [actions.md](../actions.md))

## JavaScript

JavaScript do bloco:

```js
var DatePicker = function() {
    var field;
    var trigger;
    var format;
    var initDate;
    var options;
    var inputEmpty;
    var isInterval;
    var startDate;
    var endDate;

    var start = function(widgetIdParam, containerId, buttonWidgetId,
        dateFormat, serverFormat, disabledDates,
        minDate, maxDate, initialDate, startEmpty, selectInterval, advancedFormat, pickEventId,
        openEventId, closeEventId) {

        field = document.getElementById(widgetIdParam);
        trigger = document.getElementById(widgetIdParam);
        format = dateFormat;
        initDate = getInitDate(field.value, initialDate, serverFormat);
        minDate = getInitDate(minDate, minDate, serverFormat);
        maxDate = getInitDate(maxDate, minDate, serverFormat);
        innerPickEventId = pickEventId;
        inputEmpty = (startEmpty === "True" ? true : false);
        isInterval = (selectInterval === "True" ? true : false);

        var advancedFormat = JSON.parse(advancedFormat);
        var events = [];
        var disabledD = [];

        if (field.placeholder.length === 0) {
            if (format.length === 0) {
                field.placeholder = serverFormat;
            } else {
                field.placeholder = format;
            }
        }

        if (buttonWidgetId) {
            trigger = document.getElementById(buttonWidgetId);
        }

        if (advancedFormat.EventsList) {
            events = getArrayOfDates(advancedFormat.EventsList);
        }

        if (JSON.parse(disabledDates)) {
            disabledD = getArrayOfDates(JSON.parse(disabledDates));
        }

        if (format.length === 0) {
            format = serverFormat;
        }

        options = {
            field: field,
            trigger: trigger,
            format: format,
            defaultDate: new Date(initDate),
            setDefaultDate: true,
            minDate: new Date(minDate),
            maxDate: new Date(maxDate),
            showDaysInNextAndPreviousMonths: true,
            events: events,
            disableDayFn: function(d) {
                disabledDay = disabledD.indexOf(d.toDateString()) !== -1 ? true : false;
                disabledWeekDay = disabledD.indexOf(d.getDay()) !== -1 ? true : false;

                if (disabledDay || disabledWeekDay) {
                    return true;
                }
            },
            onSelect: function() {
                setSelectInterval(this, this._o.eventId);
                setTimeout(function(){
                    field.blur();
                }, 0);
            },
            onOpen: function() {
                // prevent previous events occurs on input widgets when tabbing
                setTimeout(function(){
                    TriggerEvents(openEventId);
                }, 0);
            },
            onClose: function() {
                setSelectInterval(this, closeEventId);
            },
            i18n: {
                previousMonth: 'Previous Month',
                nextMonth: 'Next Month',
                previousYear: 'Previous Year',
                nextYear: 'Next Year',
                previousDecade: 'Previous Decade',
                nextDecade: 'Next Decade',
                months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
                monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
                weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
                weekdaysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
                todayButton: 'Today'
            },
            eventId: innerPickEventId,
            isInterval: isInterval,
            disableFocusOnDraw: false
        };

        if (advancedFormat.AdvancedFormatJSON) {
            if (advancedFormat.AdvancedFormatJSON.length > 0) {
                var advancedObj = JSON5.parse(advancedFormat.AdvancedFormatJSON);
                
                // Accomodates the 'container' option to eval a DOM node
                if(advancedObj.hasOwnProperty('container')){
                    advancedObj.container = eval(advancedObj.container);
                }

                options = mergeJSON(options, advancedObj);
            }
        }

        // create only if the input is not read only or if the trigger is not the input
        if (!field.readOnly || buttonWidgetId.length !== 0) {
            create();
            
        // If input is readOnly, like in the of being inside an EditableTable, start an observer
        // to watch for changes on the readOnly attribute. If it chnages to false, create the picker.
        } else if(field.readOnly) {
            // Callback that runs when the oberver detects a mutation
            function callback(mutationList) {
              mutationList.forEach(function(mutation) {
                  // If what changes is the attribute readOnly and its value is false, create the picker
                  if(mutation.attributeName === "readonly" && !field.readOnly) {
                      create();
                      observer.disconnect(); // disconnect the observer after creating the picker
                  }
              });
            }
            
            // start the observer
            var observer = new MutationObserver(callback);
            
            observer.observe(field, {
              attributes: true,
              attributeOldValue: true
            });
        }
    }

    function create() {
        var picker = new Pikaday(options);

        setInput(picker);

        // code used for when user writes in the input directly, don't set the calendar with each stroke
        setInputListener(picker);

    }

    function getInitDate(inputValue, initDateParameter, serverFormat) {
        var date = moment(new Date()).format("YYYY/MM/DD");
        var initDate = initDatePa
/* ... truncado: 66596 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"DatePicker1","source":"IWebBlock:DatePicker","as":"$b"}
{"op":"set","target":"$b/InputWidgetId","prop":"Value","value":"<Text>"}
```
