# List_SortColumn

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 9 widgets internos

Use this widget with a column of a TableRecords widget to sort by that column (ascending and descending).
Create a screen action and set it on the 'On Notify' property. 
In the action flow repopulate the TableRecords widget using the following:
1. The 'Refresh Query' tool to refresh the query that is bond to the TableRecords or List Records widget;
2. The 'Ajax Refresh' tool refresh the TableRecords or ListRecords widget on screen.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Column | Text | sim |  | The name of the column using the following syntax: "{<TableName>}.[<ColumnName>]". |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Actions do bloco: sort
- Chama actions do modulo: GetPageName, List_SortColumn_SetOrderBy, Deprecated_Notify (contratos em [actions.md](../actions.md))

## JavaScript

JavaScript do bloco:

```js
function RichWidgets_List_SortColumn(Column, linkId, sortColumn_OrderBy, pageName, inputTableRecordsId, sortLabelId){
 outsystems.internal.$(function($) {
  var columnHeader = $('#' + linkId).parents('th:eq(0)');
  var label = document.getElementById(sortLabelId);
    
  columnHeader.click(function(e){
   $('#' + linkId).triggerHandler("click");
  });
  
  var tableRecordsId = $('#' + linkId).parents('table.TableRecords:eq(0)').attr('id');
  $('#' + inputTableRecordsId).val(tableRecordsId);
  var isSortedColumn = sortColumn_OrderBy.indexOf(pageName + ":" + tableRecordsId + "=" + Column)>-1;
  if (isSortedColumn){
   columnHeader.addClass('SortColumns_Sorted');
  } else {
   columnHeader.addClass('SortColumns_Sortable');
  }
  
  var accessibilityImprovements = function() {
      var columnString = Column.replace(/[\[\]']+/g, '').replace(/[{()}]/g, '').replace(/[.]+/g, '');
      
      columnHeader.attr("tabindex", "0");
      label.textContent = "Sort column by " + columnString;
      
      columnHeader.keypress(function(e){
        if(e.keyCode == 13 || e.keyCode == 32) {
            $('#' + linkId).triggerHandler("click");
        } 
      });
  }
  
  accessibilityImprovements();
  
 });
}
```

## CSS

Classes: `.SortColumns_Sortable`, `.SortColumns_Sorted`, `.sort-label`

```css
.SortColumns_Sortable {
    font-weight: normal;
    cursor:pointer;
    color:white;
}

.SortColumns_Sortable:hover {
    text-decoration:underline;
}    

.SortColumns_Sorted {
    font-weight: bold;
    cursor:pointer;
    color:white;
}

.SortColumns_Sorted:hover {
    text-decoration:underline;

}

/* CSS hack for hidden labels necessary for Accessibility compliance*/
.sort-label {
    height: 0 !important;
    overflow: hidden;
    position: absolute;
    width: 0 !important;
}

/* ExcludeAllFromPickersOutsideBlock */
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"List_SortColumn1","source":"IWebBlock:List_SortColumn","as":"$b"}
{"op":"set","target":"$b/Column","prop":"Value","value":"<Text>"}
```
