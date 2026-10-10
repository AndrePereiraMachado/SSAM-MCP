# Video

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Controls** | publico | 5 widgets internos

Embed a native video player.

Drag the Block to the screen and define the source video file to be embedded. All other parameters such as controls or size are optional.

You can also use VideoPlay and/ or VideoPause server actions to control the video.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| SourceFile | Text | sim |  | Used when video is a resource file. |
| Width | Text | nao | "100%" | Width (in pixel or percentage) is added for the video, otherwise the original video Width is detected. |
| Height | Text | nao | "100%" | Height (in pixel or percentage) is added for the video, otherwise the original video Height is detected. |
| Autoplay | Boolean | nao | False | If True, specifies that the video will start playing as soon as it is ready. |
| Loop | Boolean | nao | False | If True, specifies that the video will restart playing as soon as it ends. |
| Muted | Boolean | nao | False | If True, specifies that the audio of the video will be disabled. |
| Controls | Boolean | nao | True | If False, disabled video controls. In case of mobile, the controls will always be enable. |
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"Video1","source":"IWebBlock:Video","as":"$b"}
{"op":"set","target":"$b/SourceFile","prop":"Value","value":"<Text>"}
```
