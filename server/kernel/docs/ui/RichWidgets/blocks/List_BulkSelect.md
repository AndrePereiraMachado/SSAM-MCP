# List_BulkSelect

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 5 widgets internos

Checkbox to drag into a column header of the Table Records widget to allow bulk selection (select all / select none) of the rows. This widget also disables the action buttons associated with the list when no row is selected.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| TableRecordsWidgetId | Text | sim |  | The Id of the TableRecords widget. |
| AssociatedLinkIds | Text | sim |  | Ids of the associated link widgets to be enabled when there are selected items. To specify more than one link use a comma-separated list. |
| Enabled | Boolean | nao | True | If False, the user cannot interact with the widget. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

JavaScript do bloco:

```js
var RichWidgets_List_BulkSelect_toggle = null;

function RichWidgets_List_BulkSelect_bootstrap(chkboxId, TableRecordsWidget, ButtonWidgetsList) {
  outsystems.internal.$(function($) {
  
  //enable disable buttons
   var RichWidgets_List_BulkSelect_toggleEnabledButtons = function() {
    $.each(ButtonWidgetsList.split(','),  function(i, val) {
      if (val != "") {
        var obj = $('#' + val);
        if ($('#' + TableRecordsWidget +' tbody tr').find(":checkbox:checked").length==0){
          obj.attr('disabled', 'disabled');
          if (obj.attr('href') != undefined  && obj.attr('href') != '') {
            obj.data('hrefSave',obj.attr('href'));
            obj.removeAttr('href');
          }
          if (obj.attr('onclick') != undefined) {
            if (obj.data('clickFn') == undefined)
              obj.data('clickFn', new Function(obj.attr('onclick')));
          }
          obj.unbind('click.BulkSelect');
          obj.removeAttr('onclick');
        }
        else {
          obj.removeAttr('disabled')
          if (obj.data('hrefSave') != undefined) {
            obj.attr('href',obj.data('hrefSave'));
          }
          if (obj.data('clickFn') != undefined) {
            obj.unbind('click.BulkSelect');
            obj.bind('click.BulkSelect', obj.data('clickFn'));
          }
        }
        obj = null;
      }
    });
    $('#' + TableRecordsWidget + ' tbody').find('tr:has(:checkbox:not(:checked))').removeClass('TableRecords_SelectedLine');
    $('#' + TableRecordsWidget + ' tbody').find('tr:has(:checked)').addClass('TableRecords_SelectedLine');
    
  };
  
  RichWidgets_List_BulkSelect_toggle = RichWidgets_List_BulkSelect_toggleEnabledButtons;

    RichWidgets_List_BulkSelect_toggleEnabledButtons();
    
    //click on bulk select
    $('#' + chkboxId).click(function(){
        var bulkChecked = $('#' + chkboxId).attr('checked');
        $('#' + TableRecordsWidget).children("tbody").find('input:checkbox').each(function() {
            var boxChecked = $(this).attr('checked');
            if (bulkChecked) {
                if(!boxChecked) {
                    if(typeof $(this)[0].onclick == "function")
                        $(this)[0].click();
                    else
                        $(this).attr('checked',true);
                }
            }
            else {
                if(boxChecked) {
                    if(typeof $(this)[0].onclick == "function")
                        $(this)[0].click();
                    else
                        $(this).attr('checked',false);
                }
            }
        });
        RichWidgets_List_BulkSelect_toggleEnabledButtons();
    });
    
    //click on individual checkboxes
    $('#' + TableRecordsWidget +' tbody tr').find(':checkbox').click(function(){
     RichWidgets_List_BulkSelect_toggleEnabledButtons();
    });
  });
 }
```

## CSS

Classes: `.BulkSelect_Wrapper`, `.TableRecords_Actions`, `.TableRecords_Footer`, `.BulkSelect_SelectedLine`

```css
div.BulkSelect_Wrapper {
    padding-top: 4px;
    padding-bottom: 4px;
    font-size: 11px;
}

div.TableRecords_Actions div.BulkSelect_Wrapper, 
div.TableRecords_Footer div.BulkSelect_Wrapper {
    float: left;
    padding: 0px;
}

td.BulkSelect_SelectedLine,
th.BulkSelect_SelectedLine {
    background-color: #cccccc;
    border-bottom: 1px solid #efefef;
    border-left: 1px solid #cccccc;
}

/* ExcludeAllFromPickersOutsideBlock */
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"List_BulkSelect1","source":"IWebBlock:List_BulkSelect","as":"$b"}
{"op":"set","target":"$b/TableRecordsWidgetId","prop":"Value","value":"<Text>"}
{"op":"set","target":"$b/AssociatedLinkIds","prop":"Value","value":"<Text>"}
```
