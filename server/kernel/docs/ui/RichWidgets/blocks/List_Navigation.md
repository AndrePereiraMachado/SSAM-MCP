# List_Navigation

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 47 widgets internos

Use this widget with a TableRecords or ListRecords widget for pagination:
- Shows Next (page) and Previous (page) links 
- Shows page numbers
Create a screen action and set it on the 'On Notify' property. 
In the action flow repopulate the TableRecords or ListRecords widget using the following:
1. The 'Refresh Query' tool to refresh the query that is bond to the TableRecords or List Records widget;
2. The 'Ajax Refresh' tool refresh the TableRecords or ListRecords widget on screen.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ListWidgetId | Text | sim |  | The 'Id' runtime property of the TableRecords or ListRecords widget. |
| LineCount | Integer | sim |  | The 'LineCount' runtime property of the TableRecords or ListRecords widget. |
| TotalRowCount | Long Integer | sim |  | The 'Length' runtime property of the TableRecords or ListRecords widget. |
| MaxPageNumbers | Integer | nao | 5 | The maximum number of displayed page numbers (the default is 5). When set to 0 (zero) no page numbers are displayed, only the Next and Previous links. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Actions do bloco: Page, Previous, Next
- Chama actions do modulo: Private_List_Navigation_SaveStartIndex, Deprecated_Notify (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Classes: `.ListNavigation_PageNumber`, `.ListNavigation_CurrentPageNumber`, `.ListNavigation_Ellipsis`, `.ListNavigation_DisabledNext`, `.ListNavigation_Next`, `.ListNavigation_Previous`, `.ListNavigation_DisabledPrevious`

```css
a.ListNavigation_PageNumber,
span.ListNavigation_CurrentPageNumber,
span.ListNavigation_Ellipsis {
    padding: 3px 6px;
}

span.ListNavigation_DisabledNext,
a.ListNavigation_Next {
    padding: 3px 0px 3px 6px;
}

a.ListNavigation_Previous,
span.ListNavigation_DisabledPrevious {
    padding: 3px 6px 3px 0px;
}

span.ListNavigation_CurrentPageNumber {
    font-weight: bold;
}

span.ListNavigation_DisabledPrevious,
span.ListNavigation_DisabledNext {
    color: gray;
}

/* ExcludeAllFromPickersOutsideBlock */
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"List_Navigation1","source":"IWebBlock:List_Navigation","as":"$b"}
{"op":"set","target":"$b/ListWidgetId","prop":"Value","value":"<Text>"}
{"op":"set","target":"$b/LineCount","prop":"Value","value":"<Integer>"}
{"op":"set","target":"$b/TotalRowCount","prop":"Value","value":"<Long Integer>"}
```
