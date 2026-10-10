# ResponsiveTableRecords

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 4 widgets internos

Makes tables stack cells on top of each other in mobile.

To use it just add this web block to the screeen and make sure they are inside a container with the style "Responsive"

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

JavaScript do bloco:

```js
outsystems.internal.$(function () {
    var responsiveTables = function() {
        outsystems.internal.$('.Responsive .TableRecords').each(function() {
            var table = outsystems.internal.$(this);
            table.find('thead th').each( function ( index ) {
                var label = outsystems.internal.$(this).clone().children().remove().end().text();
                if (label == "")
                    label = outsystems.internal.$(this).text().replace(/lnkSort[\s\S]*/,"");
                table.find('tbody tr').each( function () {
                    var cell = outsystems.internal.$(this).children().eq(index);
                    if( cell.find('div.TableRecords_Label').length == 0 ) {
                        if (index == 0 && cell.find(':checkbox').length > 0) {
                            label = cell.next().find('a').text();
                            cell.append(outsystems.internal.$('<div class=\'TableRecords_Label\'></div>').text(label) );
                        } else {                        
                            cell.prepend(outsystems.internal.$('<div class=\'TableRecords_Label\'></div>').text(label) );
                        }
                    }
                });
            });
         });
    };
    responsiveTables();
    outsystems.internal.$('body').on('click', '.Responsive .TableRecords td:first-child',function(event) {
        if (!outsystems.internal.$(event.target).is("a,input,button")) {
            outsystems.internal.$(this).parent('tr').toggleClass('TableRecords_ExpandedRow');
        }
    });
    osAjaxBackend.BindAfterAjaxRequest(function(){responsiveTables();});
});
```

## CSS

Classes: `.TableRecords_Label`, `.Responsive`, `.TableRecords`, `.TableRecords_OddLine`, `.TableRecords_EvenLine`, `.TableRecords_ExpandedRow`, `.HiddenInSmartphone`, `.Expanded`

```css
div.TableRecords_Label {
    display: none;   
}


@media screen and (max-width: 764px) {
    .Responsive .TableRecords_Label {
        display: block;
        color: #999; 
    }
    
    .Responsive .TableRecords td:first-child .TableRecords_Label {
        display:inline-block; /* for master details with checkboxes*/
    }

    .Responsive .TableRecords td:first-child .TableRecords_Label:first-child {
        display:none;
    }
    
    .Responsive .TableRecords {
        padding: 0px;
    }
    
    .Responsive .TableRecords td.TableRecords_OddLine, 
    .Responsive .TableRecords td.TableRecords_EvenLine {
        width: 100%;
        float: left;
        display: block;
        padding: 5px;
        box-sizing: border-box;
        border-bottom: none;
        display:none;
        -servicestudio-display:none!important;
    }
    
    .Responsive .TableRecords td.TableRecords_OddLine:first-child, 
    .Responsive .TableRecords td.TableRecords_EvenLine:first-child {
        border-top: 1px dotted #CCC;
        display:block;
        padding-top: 10px;
        padding-bottom: 10px;
        cursor:pointer;
        -servicestudio-display:block!important;
    }
    
    .Responsive .TableRecords tr:first-child td.TableRecords_OddLine:first-child, 
    .Responsive .TableRecords tr:first-child td.TableRecords_EvenLine:first-child {
        border:  none;
    }
    
    .Responsive .TableRecords thead {
        display: none;
        -servicestudio-display: none!important;
    }
    
    .Responsive .TableRecords td * {
        text-align: left;
    }

    .Responsive .TableRecords tr.TableRecords_ExpandedRow td.TableRecords_OddLine,
    .Responsive .TableRecords tr.TableRecords_ExpandedRow td.TableRecords_EvenLine {
        display: block;
        -servicestudio-display: block!important;
    }

    .Responsive .TableRecords tr.TableRecords_ExpandedRow td.TableRecords_OddLine.HiddenInSmartphone,
    .Responsive .TableRecords tr.TableRecords_ExpandedRow td.TableRecords_EvenLine.HiddenInSmartphone {
        display: none;
    }

    .Responsive .TableRecords td:first-child:before {
        content: "\f0dd";
        float: right;
        font-family: FontAwesome;
        color: #AAA;
        margin-right:5px;
    }
    
    .Responsive .TableRecords td:last-child:before {
        content: ""; /* hide the icon there is only one column (first and last child are the same) */
    }

    .Responsive .TableRecords td[colspan]:first-child:before {
        content: "";
    }

    .Responsive .TableRecords tr.TableRecords_ExpandedRow td:first-child:before {
        content: "\f0de";
    }
    
    .Responsive .TableRecords tr.TableRecords_ExpandedRow td:last-child:before {
        content: ""; /* hide the icon there is only one column (first and last child are the same) */
    }
    
    .Responsive .TableRecords.Expanded td.TableRecords_OddLine, 
    .Responsive .TableRecords.Expanded td.TableRecords_EvenLine {
        display:table-cell;
        -servicestudio-display:table-cell!important;
     }
    
    .Responsive .TableRecords.Expanded td:first-child:before {
        display:none;
        -servicestudio-display:none!important;
    }
    .Responsive .TableRecords.Expanded td:first-child .TableRecords_Label:first-child {
        display:table-cell;
    }
}    

/* ExcludeAllFromPickersOutsideBlock */
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"ResponsiveTableRecords1","source":"IWebBlock:ResponsiveTableRecords","as":"$b"}
```
