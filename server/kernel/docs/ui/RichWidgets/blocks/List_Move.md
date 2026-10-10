# List_Move

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 23 widgets internos

Use this widget with TableRecords widgets to have arrows in rows to move them up and down.
Create a screen action and set it on the 'On Notify' property. 
In the action flow move a row up or down using the following:
- The 'NotifyWidgetGetMessage()' built-in function and compare it with 'RichWidgets.List_Move_Up()' or 'RichWidgets.List_Move_Down()' actions.
- The 'CurrentRowNumber' runtime property of the TableRecords to know which row was moved.
- The 'CurrentRowNumber', the 'StartIndex', and the 'LineCount' runtime properties of the TableRecords to check whether the row was moved outside the currently set of displayed rows.

You can also use this widget in a ListRecords widget.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| StartIndex | Integer | nao | -1 | Set with the 'StartIndex' runtime property for computing the enabled/disabled state of the Up arrow of each row. |
| TableRecordsCurrentRowNumber | Integer | nao | -1 | Set with the 'CurrentRowNumber' runtime property for computing the enabled/disabled state of the Up and Down arrows of each row. |
| TableRecordsLineCount | Integer | nao | -1 | Set with the 'LineCount' runtime property for computing the enabled/disabled state of the Down arrow of each row. |
| TotalCounter | Integer | nao | -1 | Set with the 'Length' runtime property for computing the enabled/disabled state of the Down arrow of each row. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Actions do bloco: Move
- Chama actions do modulo: Deprecated_Notify (contratos em [actions.md](../actions.md))

## JavaScript

JavaScript do bloco:

```js
function RichWidgets_List_Move_SetActive(arrowId, arrowActiveId, active) {
 
 if (active == true) {
  outsystems.internal.$("#" + arrowId).hide();
  outsystems.internal.$("#" + arrowActiveId).show();
 }
 else {
  outsystems.internal.$("#" + arrowId).show();
  outsystems.internal.$("#" + arrowActiveId).hide();
 }
}
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"List_Move1","source":"IWebBlock:List_Move","as":"$b"}
```
