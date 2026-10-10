# DisplayOnDevice

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Responsive** | publico | 8 widgets internos

Use to select if an element should be loaded in a specific device. Especially helpful to avoid too much data being loaded in mobile devices.

Set up the content of the pattern and then change the devices where it will be displayed.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Behavior | DeviceResponsive Identifier | sim |  | Select the way the server will load the data. |

Valores possiveis (static entities):

- **Entities.DeviceResponsive**: TabletOnly, PhoneOnly, TabletAndPhone, DesktopAndTablet, DesktopOnly, AllDevices

## Placeholders

- **Content**: Drag your content to this placeholder.

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: WidgetLateLoad
- Actions do bloco: RefreshBlock
- Chama actions do modulo: GetCookie (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"DisplayOnDevice1","source":"IWebBlock:DisplayOnDevice","as":"$b"}
{"op":"set","target":"$b/Behavior","prop":"Value","value":"<DeviceResponsive Identifier>"}
{"op":"create","parent":"$b/Content","type":"IExpressionWidget","as":"$eContent"}
```
