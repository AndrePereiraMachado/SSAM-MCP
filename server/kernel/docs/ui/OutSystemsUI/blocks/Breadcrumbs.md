# Breadcrumbs

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Navigation** | publico | 16 widgets internos

Present the current user location in applications with a deep page hierarchy.

Usefull when you want to make an in-app navigation.

Drag it into the breadcrumb placeholder. Drag as many BreadCrumbsItems to Content as you need.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

- **Content**: Drag BeadcrumbsItem blocks to this placeholder. (em `content`) | nasce com: WebBlockInstance:BreadcrumbsItem, WebBlockInstance:BreadcrumbsItem, WebBlockInstance:BreadcrumbsItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: BreadcrumbsItem

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Breadcrumbs1","source":"IMobileBlock:Breadcrumbs","empty":true,"as":"$b"}
```
