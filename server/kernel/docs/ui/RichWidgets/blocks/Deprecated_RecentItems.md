# Deprecated_RecentItems

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 23 widgets internos

DEPRECATED: Consider creating a similar webblock in a different eSpace. Shows a list of recently visited pages. Use RichWidgets\RecentItem_Add() to add a page to this list.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Title | Text | nao | "Recent Items" |  |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Classes: `.RecentItem`, `.RecentItemType`, `.RecentItemHeading`, `.RecentItemsBlock`

```css
.RecentItem {
}

.RecentItemType {
    color: #888888;
    font-size: 11px;
    font-weight: normal;    
}

.RecentItemHeading {
    color: #444444;
    font-size: 14px;
    font-weight: bold;
    margin-bottom:5px;
}

.RecentItemsBlock {
    line-height: 1.5;
}

.RecentItemsBlock a,
.RecentItemsBlock a:link,
.RecentItemsBlock a:visited {
    color: #444444;
}

/* ExcludeAllFromPickersOutsideBlock */

```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Deprecated_RecentItems1","source":"IWebBlock:Deprecated_RecentItems","as":"$b"}
```
