# Layout_MarkerPopup

OutSystemsMaps 2.3.1 | Reactive/Mobile | UI flow **Marker** | publico | 12 widgets internos

Popup layout that can be used together with the MarkerPopup inside the Map Block. Its content can be fully customized. By default, the MarkerPopup comes with this popup layout.

## Inputs

Nenhum.

## Placeholders

- **Image** (em `Popup/content`) | nasce com: Container:Popup_Image (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Header** (em `Popup/content`) | nasce com: AdvancedHtml:Popup_Header (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Description** (em `Popup/content`) | nasce com: Text:Popup_Description (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Link** (em `Popup/content`) | nasce com: AdvancedHtml (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Layout_MarkerPopup1","source":"IMobileBlock:Layout_MarkerPopup","empty":true,"as":"$b"}
```
