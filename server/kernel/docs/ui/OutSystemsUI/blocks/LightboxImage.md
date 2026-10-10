# LightboxImage

OutSystemsUI 2.28.1 | Reactive/Mobile | UI flow **Interaction** | publico | 8 widgets internos

Block with only one placeholder for image. It’s possible use local images or External URL, using the ImageURL parameter on the block. To be able to open items, the Utilities\Lightbox Block needs to be placed somewhere on the screen.

To disable the URL feature, use the class 'disable-url' on the ExtendedClass parameter.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| Title | Text | nao |  | Title of the image to be displayed |
| Group | Text | nao |  | Images of the same group will be displayed in a gallery |
| ImageURL | Text | nao |  | URL for an image that can be a replacement for the Image Placeholder image. To get the URl of a binary image, use the BinaryToURLImage actions from the Utilities folder. |
| ImageZoom | Decimal | nao | 2 | The zoom value is used to define the size of the image that will open in full screen based on the thumbnail size.   Note: try to use images with the same ratio to avoid rendering problems:       - thumbnail with 100x100 and zoom 2 will open with 200x200       - thumbnail with 500x500 and zoom 0.5 will open with 250x250 |
| ExtendedClass | Text | nao |  | Add custom style classes to the Pattern. You define your custom style classes in your application using CSS.Examples:  - Blank - No custom styles are added (default value). - "myclass" - Adds the myclass style to the UI styles being applied. - "myclass1 myclass2" - Adds the myclass1 and myclass2 styles to the UI styles being applied.  You can also use the classes available on the OutSystems UI. For more information, see the OutSystems UI Cheat Sheet: https://outsystemsui.outsystems.com/OutsystemsUiWebsite/CheatSheet |
| OptionalConfigs | LightboxImageOptionalConfigs | nao |  | Extra configurations. |

## Placeholders

- **Thumbnail**: Drag an image element (em `LightboxItem/content/content/content`) | nasce com: Image (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

- **Initialized**(LightboxObj: Object): Event triggered after the Lightbox instance is ready.
 
Info:
- This event will returns the Lightbox JavaScript Object Instance.
- Through this object, you can programmatically access the created instance and invoke its public methods and properties. For example, within a JS Node you may use:
    $parameters.LightboxObj.updateCloseBtnAriaLabel("New label text");
    $parameters.LightboxObj.updatePrevBtnAriaLabel("New label text");
    $parameters.LightboxObj.updateNextBtnAriaLabel("New label text");
 
These methods allow you to dynamically update the ARIA labels of the Lightbox control buttons.
 
NOTES: 
- Special for this Pattern, and due the way it's implemented, this event will be fired from the first Lightbox instance to be created.
- Any changes made through these methods will apply to all Lightbox instances currently rendered on the screen.

## Composicao interna

- Usa os blocos: LightBox
- Scripts exigidos: Lightbox
- Ciclo de vida: OnReady -> OnReady
- Actions do bloco: OnReady, InitializedHandler, OnImgClick

## JavaScript

`OnReady` / no `Init`:

```js
$parameters.LightboxObj = new Lightbox($parameters.WidgetId, JSON.parse($parameters.OptConfigs), $actions.InitializedHandler);
```

`OnImgClick` / no `OpenPhoto`:

```js
$parameters.Lightbox.openPhoto(event);
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IMobileBlockInstanceWidget","name":"LightboxImage1","source":"IMobileBlock:LightboxImage","empty":true,"as":"$b"}
```

## Como ligar um evento (handler)

O handler e uma screen action com um input por parametro do evento; `$b/Initialized` resolve o IEventHandler pelo nome do evento e `$b/Initialized/<Param>` o argumento. Provado em `tests/jobs/osui-patterns.json` (Tabs.OnTabChange).

```json
{"op":"create","parent":"$scr","type":"IScreenAction","name":"LightboxImage1_Initialized","as":"$h"}
{"op":"create","parent":"$h","type":"IInputParameter","name":"LightboxObj","as":"$p1"}
{"op":"set","target":"$p1","prop":"DataType","value":"Object"}
{"op":"create","parent":"$h","type":"IStartNode","as":"$hs"}
{"op":"create","parent":"$h","type":"IEndNode","as":"$he"}
{"op":"link","from":"$hs","to":"$he"}   // ponha a logica entre Start e End
{"op":"layout","target":"$h"}
{"op":"set","target":"$b/Initialized","prop":"Handler","value":"$h"}
{"op":"set","target":"$b/Initialized/LightboxObj","prop":"Value","value":"LightboxObj"}
```
