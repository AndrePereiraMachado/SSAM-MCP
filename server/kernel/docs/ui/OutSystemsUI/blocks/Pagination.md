# Pagination

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 35 widgets internos

Drag the Pagination block to your screen. 
Set the StartIndex and MaxRecords parameters to the related variables from your Screen. 
Set the TotalCount parameter to the Count from the Aggregate you are using.

Use the OnNavigate event to create an action that assigns the StartIndex to the NewStartIndex. Drag a RefreshData to refresh your Aggregate.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| StartIndex | Integer | sim |  | Set the initial index to start pagination. |
| MaxRecords | Integer | sim |  | Number of records per page. |
| TotalCount | Long Integer | sim |  | Total records of list. |
| ShowGoToPage | Boolean | nao | False | Set to true, to show pagination with an input that allows to jump to a specific page. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Previous**: Add content to be displayed inside Previous button (em `PaginationWrapper/content/content/btnPreviousPage/content`) | nasce com: Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Next**: Add content to be displayed inside Next button (em `PaginationWrapper/content/content/btnNextPage/content`) | nasce com: Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **OnNavigate**(NewStartIndex: Integer) [obrigatorio]: Event triggered on navigate.

## Composicao interna

- Ciclo de vida: OnParametersChanged -> InitPagination; OnReady -> InitPagination; OnDestroy -> OnDestroy
- Actions do bloco: GoTo, InitPagination, OnDestroy, InputOnChange
- Chama actions do modulo: ListAppend, ListClear, LoadOutSystemsUIScript, ListSort (contratos em [actions.md](../actions.md))

## JavaScript

`GoTo` / no `JsSetFocusOnButton`:

```js
// Find the right button to focus on
let currentButton;

if($parameters.IsFirstButton)
{
    currentButton = document.getElementById($parameters.FirstButtonElemId);
}
else if($parameters.IsLastButton)
{
    const lastButton = document.getElementById($parameters.LastButtonElemId);
    if (lastButton) {
        currentButton = lastButton;
    } else {
        //if last button was not found it means the pagination has less than 4
        //knowing this we need to find the last button on the last item from pagination list
        const pageButtonsList = document.querySelectorAll('#' + $parameters.PaginationListId + " .pagination-button");
        if(pageButtonsList.length > 0){
            currentButton = pageButtonsList[pageButtonsList.length-1];
        }
    }
}
else if($parameters.EdgeFocusableElemId && !$parameters.IsFirstButton && !$parameters.IsLastButton)
{
    currentButton = document.getElementById($parameters.EdgeFocusableElemId);
} 
else
{
    //will get the current element from the list of page buttons
    currentButton = document.querySelector('#' + $parameters.PaginationListId + 
    ' > .pagination-button[aria-current=true]');
}

// Check if such a button exists and focus on it
if (currentButton) {
    currentButton.focus();
}
```

`InitPagination` / no `JsGetTotalPages`:

```js
const getTotalPages = $parameters.TotalCount / $parameters.MaxRecords;

if (getTotalPages == Math.floor(getTotalPages)) {
    $parameters.TotalPages = (getTotalPages - 1);
} else {
    $parameters.TotalPages = (getTotalPages);
}
```

`InitPagination` / no `JsCalculateGoToValue`:

```js
let value = $parameters.Value;

if(value >= 1 && value <= $parameters.TotalPages) 
{
    // Go to Selected Page
    value = ($parameters.StartIndex + $parameters.MaxRecords) / $parameters.MaxRecords;
} 
else if(value > $parameters.TotalPages && $parameters.StartIndex > 0) {
    // Go to Last Page
    value = $parameters.TotalPages + 1;
} 
else {
    // Go to First page
    value = 1;
}

$parameters.GotoValue = value;
```

`OnDestroy` / no `RemoveListener`:

```js
let inputElem = document.getElementById($parameters.InputElemId);

if(inputElem) {
    inputElem.removeEventListener('keydown', $parameters.KeypressCallback);
}
```

`InputOnChange` / no `SetListener`:

```js
let value = $parameters.Value;
const totalPages = $parameters.TotalPages;
const enterPressed = 13; // enter-key
let inputElem = document.getElementById($parameters.InputElementId);

var checkValue = function() {
    if(value > 0 && value <= totalPages) {
    // Go to Selected Page
    value = (value - 1) * $parameters.MaxRecords;
    } else if(value > totalPages) {
        // Go to Last Page
        value = totalPages * $parameters.MaxRecords;
    } else {
        // Go to First page
        value = 0;
    }
};

var inputOnKeypress = function(e){
    if (e.keyCode === enterPressed) {
        checkValue();
        $actions.GoTo(value);
    }
    inputElem.removeEventListener('keydown', inputOnKeypress); 
};

if($parameters.IsBlur === false) {
    inputElem.addEventListener('keydown', inputOnKeypress);
    $parameters.KeypressCallbackObj = inputOnKeypress;
} else {
    if (value !== $parameters.SelectedPageButton) {
        checkValue();
        $actions.GoTo(value);
    }
}

$parameters.GotoValue = value;
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Pagination1","source":"IMobileBlock:Pagination","empty":true,"as":"$b"}
{"op":"set","target":"$b/StartIndex","prop":"Value","value":"<Integer>"}
{"op":"set","target":"$b/MaxRecords","prop":"Value","value":"<Integer>"}
{"op":"set","target":"$b/TotalCount","prop":"Value","value":"<Long Integer>"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/OnNavigate` resolve o IEventHandler pelo nome do evento e `$b/OnNavigate/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"Pagination1_OnNavigate","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"NewStartIndex","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Integer"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/OnNavigate","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/OnNavigate/NewStartIndex","prop":"Value","value":"NewStartIndex"}
```
