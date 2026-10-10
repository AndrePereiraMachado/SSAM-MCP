# Breadcrumbs

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Navigation** | publico | 15 widgets internos

Present the current user location in applications with a deep page hierarchy.

When you want to make an in-app navigation.

Drag it into the breadcrumb placeholder. Drag as many BreadCrumbsItems to Content as you need.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **Content**: Drag BeadcrumbsItem blocks to this placeholder. | nasce com: WebBlockInstance:BreadcrumbsItem, WebBlockInstance:BreadcrumbsItem, WebBlockInstance:BreadcrumbsItem (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: BreadcrumbsItem, Icon

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Breadcrumbs1","source":"IWebBlock:Breadcrumbs","empty":true,"as":"$b"}
```
