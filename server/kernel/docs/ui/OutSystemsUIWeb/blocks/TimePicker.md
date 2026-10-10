# TimePicker

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Controls** | publico | 19 widgets internos

Select a single time.

Use the Time Picker to enable users to select a single time from a dropdown.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| StartTime | Time | nao |  | The time that the dropdown options will scroll to in order to have it as the first item.  Make sure that the time is according to the interval that you set to begin with.  Default is NewTime(0,0,0) -> 12:00am  Example: If you set the interval as 30, but the Start Time as 10:05:00. Then while it will be the time that it'll appear on the input, the drop down won't scroll down to the hour since it doesn't match the interval. |
| Interval | Integer | nao | 30 | Interval of time (in minutes) between options.   Example: If 30, then the options will appear as: 08:00:00, 08:30:00, 09:00:00... |
| Is24hFormat | Boolean | nao | True | If true, then time format will be 24 hour. If false, then 12 hour. |
| AdvancedFormat | TimePickerAdvancedFormat | nao |  | Allows for more options that the ones given in the input parameters.   Inputs:     TimePickerAdvancedFormat          DisabledTimes (Time List)         MinTime (Time)         MaxTime (Time)         StartEmpty (Boolean) |

## Placeholders

- **Input**: Drag your input with a variable of the type time to this placeholder. (em `TimeDropdown/Prompt`) | nasce com: Input. Esse Input e parte do padrao: NAO use empty; ligue-o com `set $b/Input/#IInput prop Variable value <variavel>` (os nomes reais sao renumerados, ex. Input1; enderece por tipo)

## Eventos

- **OnSelect**(TimeSelected: Time): Event will be triggered when a time is selected returning it.

## Composicao interna

- Usa os blocos: Dropdown, JavaScriptNode, EventThroughExtensibility
- Actions do bloco: OnChange
- Chama actions do modulo: ListAppend, ListClear, ListIndexOf, SetHourFor12hFormat, Feedback_Message, ToggleElement (contratos em [actions.md](../actions.md))

## JavaScript

JavaScript do bloco:

```js
   
// var IsFirst Identifies if it's the first time that the TimePicker runs because the timePicked is 'default'
// When it picks something from the options, the start will run again because of the ajax refresh so
// There needs to be a verification between the first run and the following ones.

var TimePicker = function() {
    var widget;
    var input;
    var tp;
    var isFirst = true;
    
    var start = function(widgetId, startTime, timePicked, is24h, startEmpty, eventId) {
        input = document.querySelector("#" + widgetId + " .time-input input");
        widget = widgetId;

        tp = (isFirst ? startTime : timePicked); 
        var hour = tp.split(":")[0];
        var period = "am";
        
        var is12h = (is24h !== "True");
        var isStartEmpty = (startEmpty === "True");
                
        if(isStartEmpty && isFirst) {
            input.value = "";
            input.placeholder = (is12h ? "hh:mm" : "HH:mm"); 
        } else {            
            if(parseFloat(hour) >= 12) {
                period = "pm";
            }
            
            if(is12h) {
                switch(hour) {
                    case "00":    
                        hour = "12";
                        break;
                    case "13":    
                        hour = "01";
                        break;
                    case "14":
                        hour = "02";
                        break;
                    case "15":    
                        hour = "03";
                        break;
                    case "16":
                        hour = "04";
                        break;
                    case "17":    
                        hour = "05";
                        break;
                    case "18":
                        hour = "06";
                        break;
                    case "19":    
                        hour = "07";
                        break;
                    case "20":
                        hour = "08";
                        break;
                    case "21":    
                        hour = "09";
                        break;
                    case "22":
                        hour = "10";
                        break;
                    case "23":    
                        hour = "11";
                        break;
                    case "24":
                        hour = "12";
                        break;
                }
            }
        
            // last bit sets am/pm or nothing in case if it's a 12h format
            input.value = hour + ":" + tp.split(":")[1] + (is12h ? period : "");   
        }
        
        setFocus(tp);
        setListeners(eventId);
    }
    
    var setListeners = function(eventId) {
        var header = document.querySelector("#" + widget + " .dropdown-header");
        var wrapper = document.querySelector("#" + widget + " .time-picker-dropdown");
        var option = document.querySelector("#" + widget + " .time-option");
        var iOS = document.querySelector('.ios');
        var timeout = null;
        var currentTarget;
        
        // Sets up the scroll to the date set as 'start date' in the drop down
        header.addEventListener("mousedown", function() {
            scrollTo(tp);
        });
        
        // Sets the value of the input with what was clicked/keypressed from within the drop down options
        var onSelect = function(elem) {
            setFocus(tp);    
            tp = elem.dataset.time;
            input.value = elem.innerHTML;
            isFirst = false;
            
            elem.classList.add("time-option-selected");
        }
        
        // Sets click listener
        if(iOS){
            wrapper.addEventListener("touchstart", function(e) {
                currentTarget = e.target;
                if(currentTarget.classList.contains('time-option')) {
                    onSelect(currentTarget);
                }
            });
        } else {
            wrapper.addEventListener("mousedown", function(e) {
                currentTarget = e.target;
                if(currentTarget.classList.contains('time-option')) {
                    onSelect(currentTarget);
                }
            });
        }
        
        // Sets keypress listener
        wrapper.addEventListener("keydown", function(e) {
            currentTarget = e.target;
            if(currentTarget.classList.contains('time-option') && e.keyCode == "13") {
                onSelect(currentTarget);
            }
        });
        
        
        // Grabs the value when the  value changes in the input
        input.addEventListener("input", function(e) {
            clearTimeout(timeout);

            // Make a new timeout set to go off in 800ms
            // This was created as to allow the user to write out the dates on the input and change the picker change accordingly
            timeout = setTimeout(function () {
                TriggerEvents(eventId, e.target.value);
                isFirst = false;
            }, 500);
            
        });   
    }
    
    var setFocus = function(timePicked) {
        
        var timeValue = timePicked.replace(/(:)/g, ""); 
        var element = document.querySelector("#" + widget + " [data-time='" + timeValue + "']");
        
        if(element) {
            if(element.classList.contains("time-option-selected")) {
                element.classList.remove("time-option-selected");
            } else {
                element.classList.add("time-option-selected");
            }
        }
    }
    
    var scrollTo = function(timePicked) {
        
        var interval = setInterval(function() {
            
            var isDropDownHidden = document.querySelector("#" + widget + " .dropdown.is--hidden");
            
            // Only runs the rest of the code if the drop down options are really visible
            if(!isDropDownHidden) {
                clearInterval(i
/* ... truncado: 945 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"TimePicker1","source":"IWebBlock:TimePicker","as":"$b"}
{"op":"set","target":"$b/Input/#IInput","prop":"Variable","value":"<variavel local>"}
```
