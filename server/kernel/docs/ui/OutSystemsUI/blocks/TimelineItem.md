# TimelineItem

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 11 widgets internos

Item to create a timeline of event information, with placeholders for icon, title text and actions.

Drag the Block to the screen, add your content and set if the item is active or not active.

Used to create sequence  of chronologically related events.

For Accessibility compliance, please set the 'role=list' attribute on the parent element.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| IsActive | Boolean | nao | False | Set item as active in the timeline. |
| Color | Color Identifier | nao | Entities.Color.Primary | Color of the icon. |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

Valores possiveis (static entities):

- **Entities.Color**: Pink, Blue, Neutral0, Neutral4, Violet, Neutral2, Neutral5, Green, Indigo, Neutral3, Grape, Lime, Neutral8, Neutral9, Secondary, Primary, Neutral7, Neutral6, Yellow, Cyan, Orange, Neutral10, Neutral1, Red, Teal, Transparent

## Placeholders

- **Left**: Add text to this placeholder (em `content`)
- **Right**: Add text to this placeholder (em `content`) | nasce com: Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Icon**: Add icon to this placeholder (em `content/TimelineIcon/content`) | nasce com: Icon (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **Title**: Add title to this placeholder (em `content/TimelineContent/content`)
- **Content**: Add content to this placeholder (em `content/TimelineContent/content`)

## Eventos

Nenhum.

## Composicao interna

- Ciclo de vida: OnReady -> OnReady
- Actions do bloco: OnReady

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"TimelineItem1","source":"IMobileBlock:TimelineItem","empty":true,"as":"$b"}
{"op":"create","parent":"$b/Left","type":"IExpression","as":"$eLeft"}
{"op":"create","parent":"$b/Title","type":"IExpression","as":"$eTitle"}
```
