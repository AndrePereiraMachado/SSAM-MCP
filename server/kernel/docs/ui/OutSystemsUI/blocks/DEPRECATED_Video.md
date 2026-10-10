# DEPRECATED_Video

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 7 widgets internos

A simple way to embed video content directly into your web pages without the need for a third-party plug-in.

Drag the pattern to the screen and set the SourceFile with the URL of the video. The URL must be of a direct video file, not a website like Vimeo or YouTube, those servers provide their own embed code already

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| VideoURL | Text | sim |  | URL to the video file, preferably mp4 or webm format |
| PosterURL | Text | nao |  | URL to the poster image that displays before the video starts. |
| Width | Text | nao | "100%" | Width (in pixel or percentage) is added for the video, otherwise the original video Width is detected. |
| Height | Text | nao | "100%" | Height (in pixel or percentage) is added for the video, otherwise the original video Height is detected. |
| Muted | Boolean | nao | False | If True, specifies that the audio of the video will be disabled. |
| Loop | Boolean | nao | False | If True, specifies that the video will restart playing as soon as it ends. |
| Controls | Boolean | nao | False | If False, disabled video controls. In case of mobile, the controls will always be enable. |
| Autoplay | Boolean | nao | False | If True, the video will start immediately |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Actions do bloco: OnClick
- Chama actions do modulo: DEPRECATED_VideoPause, DEPRECATED_VideoPlay (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"DEPRECATED_Video1","source":"IMobileBlock:DEPRECATED_Video","as":"$b"}
{"op":"set","target":"$b/VideoURL","prop":"Value","value":"<Text>"}
```
