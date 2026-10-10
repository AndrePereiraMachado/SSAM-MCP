# Licenses

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Licenses** | publico | 6 widgets internos

Contains the OutSystems platform licenses.

## Inputs

Nenhum.

## Placeholders

- **CustomLicenses**: Add your custom licenses here. (em `content/content`)

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Classes: `.license-font`

```css
.license-font {
    font-family: monospace;
    font-size: small;
}
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"Licenses1","source":"IMobileBlock:Licenses","as":"$b"}
{"op":"create","parent":"$b/CustomLicenses","type":"IExpression","as":"$eCustomLicenses"}
```
