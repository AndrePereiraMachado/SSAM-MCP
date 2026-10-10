# List_Counter

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 26 widgets internos

Shows a counter of a TableRecords widget (e.g. 51 to 100 of 2345 records).

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| StartIndex | Integer | sim |  | The Starting Index. Usually it is a TableRecords.StartIndex |
| TotalRowCount | Long Integer | sim |  | The Total Number of Rows |
| LineCount | Integer | sim |  | The number of rows shown on each page. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Classes: `.Counter_Message`

```css
div.Counter_Message {
    color: #888888;
}

/* ExcludeAllFromPickersOutsideBlock */
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"List_Counter1","source":"IWebBlock:List_Counter","as":"$b"}
{"op":"set","target":"$b/StartIndex","prop":"Value","value":"<Integer>"}
{"op":"set","target":"$b/TotalRowCount","prop":"Value","value":"<Long Integer>"}
{"op":"set","target":"$b/LineCount","prop":"Value","value":"<Integer>"}
```
