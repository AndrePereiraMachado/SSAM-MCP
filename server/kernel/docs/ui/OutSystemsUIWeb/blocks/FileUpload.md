# FileUpload

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Controls** | publico | 17 widgets internos

Masks a File upload widget.

Drag your file upload widget and write your label for the file upload. After the widget is configured, create a button to save the file.

## Inputs

| Nome | Tipo | Obrigatorio | Default | Descricao |
|---|---|---|---|---|
| ExtendedClass | Text | nao |  | Add custom style classes to this Block. |

## Placeholders

- **EmptyMessage**: Drag the text to be shown when no file is selected. When a file is selected, this message will be replaced by the file name. (em `FileUploadWrapper`) | nasce com: Text, Text (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)
- **UploadWidget**: Drag the Upload widget to this placeholder. (em `FileUploadWrapper`) | nasce com: InputFilename:Upload. Esse Input e parte do padrao: NAO use empty; ligue-o com `set $b/UploadWidget/#IInput prop Variable value <variavel>` (os nomes reais sao renumerados, ex. Input1; enderece por tipo)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: Icon, JavaScriptNode

## JavaScript

JavaScript do bloco:

```js
/* Masks a file type input */
var newFileUpload = function() {
    // Object variables
    var fileUploadWrapper;
    var fileUploadMessageObj;
    var fileUploadMessageOriginal = "No file selected.";
    var fileInput;
    var fileUploadIcon;
    var inputLabel;
    
    // Checks if the value is valid
    var isValid = function(value) {
        if(/^\s*$/.test(value)) {
            return false;
        }
        return true;
    };

    // Sanitizes a string to help mitigating XSS attacks
    var sanitize = function sanitize(value) {
        if (typeof value === 'string') {
            if (value !== undefined && value !== null && value !== '') {
                return value.replace(/</g, '‹').replace(/>/g, '›');
            }
        }
        return value;
    }
    
    // Handler when the input chages
    var onFileInputChange = function() {
        var newFile;
        var fileUploadDelete = fileUploadWrapper.querySelector('.file-upload-delete');

        // Sanitize the input name in order to avoid XSS attacks
        var fileNameAux = sanitize(fileInput.value);
       
        if(isValid(fileNameAux)) {

            // Adds active class
            if(fileUploadWrapper && !fileUploadWrapper.classList.contains('active')) {
                fileUploadWrapper.classList.add('active');
            }
            
            // Creates a new div with the name of the file
            newFile = document.createElement('div');
            newFile.innerHTML = fileNameAux.replace("C:\\fakepath\\", "");
            
            // Creates a new icon to delete function
            fileUploadDelete.setAttribute('tabindex', '0');
            fileUploadDelete.addEventListener('click', onDeleteIconClick);
            fileUploadDelete.addEventListener('keypress', onDeleteIconOnKeypress);
            
            // Appends the file name to the message placeholder
            fileUploadMessageObj.innerHTML = "";
            fileUploadMessageObj.appendChild(newFile);
            fileUploadDelete.setAttribute('aria-label', 'Delete file ' + fileInput.files[0].name);
            fileUploadIcon.setAttribute('aria-label', 'Uploaded ' + fileInput.files[0].name + ' file');
            
        } else {
            fileUploadDelete.setAttribute('tabindex', '-1');
            
            // Removes active class
            if(fileUploadWrapper && fileUploadWrapper.classList.contains('active')) {
                fileUploadWrapper.classList.remove('active');
            }
            
            // Replaces the name of the archive to the empty message
            fileUploadMessageObj.innerHTML = fileUploadMessageOriginal;
            fileUploadIcon.setAttribute('aria-label', 'Upload File');
        }
        
        // Focus on the uploadIcon after selecting or deleting a file
        fileUploadIcon.focus();
    };
    
    // Handler for delete icon events
    var handleDeleteIconEvent = function(evt){
        // Resets input's value
        fileInput.value = "";
        
        // Removes on delete button event listeners
        if(evt.target && evt.target.classList.contains('file-upload-delete')) {
            evt.target.removeEventListener('click', onDeleteIconClick);
            evt.target.removeEventListener('keypress', onDeleteIconOnKeypress);
        }
        
        // Resets the UI
        onFileInputChange();
    }
    
    // Handler for delete icon keypress
    var onDeleteIconOnKeypress = function(evt) {
        if(evt.keyCode == "13" || evt.keyCode == "32") {
            handleDeleteIconEvent(evt);
        }
    };
    
    // Handler for delete icon click
    var onDeleteIconClick = function(evt) {
        handleDeleteIconEvent(evt);
    };
    
    var handleUploadIconEvent = function(){
        inputLabel.click();
    }
    
    var onUploadIcOnClick = function(){
        handleUploadIconEvent();
    }
    
    var onUploadIcOnKeypress = function(evt){
        if(evt.keyCode == "13" || evt.keyCode == "32") {
            handleUploadIconEvent();
        } 
    }

    // Start the upload
    var start = function(widgetId) {
        if(widgetId) {
            // Gets file input
            fileUploadWrapper = document.querySelector('#' + widgetId + ' .file-upload');
            if(fileUploadWrapper) {
                fileUploadMessageObj = fileUploadWrapper.querySelector('.file-upload-message');
                fileInput = fileUploadWrapper.querySelector('input[type=file]');
                fileUploadIcon = fileUploadWrapper.querySelector('.file-upload-icon');
                
                // Saves the original message if it exists
                if(fileUploadMessageObj.innerHTML.length > 0) {
                    fileUploadMessageOriginal = fileUploadMessageObj.innerHTML;
                }

                // Adds event listeners if file input exists
                if(fileInput) {
                    var fileInputId = fileInput.id;
                    inputLabel = document.createElement('label');
                    inputLabel.setAttribute('for', fileInputId);
                    fileUploadWrapper.appendChild(inputLabel);
                    
                    // Add Accessibility attributes
                    fileUploadIcon.setAttribute('aria-controls', fileInputId);
                    fileInput.setAttribute('tabindex', '-1');
                    fileInput.setAttribute('aria-hidden', true);
                    fileInput.setAttribute('aria-labelledby', fileUploadIcon.id);
                    
                    // Add events
                    fileUploadIcon.addEventListener('keypress', onUploadIcOnKeypress);
                    fileUploadIcon.addEventListener('click', onUploadIcOnClick);
                    
                    fileInput.addEventListener('change', onFileInputChange);
                }
            }
        }
    };
    
    return {
        init: function(widgetId) {
            start(widgetId);
            osAjaxBackend.BindAfterAjaxRequest(function() {
       
/* ... truncado: 59 chars a mais no JSON do catalogo */
```

## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"FileUpload1","source":"IWebBlock:FileUpload","empty":true,"as":"$b"}
{"op":"set","target":"$b/UploadWidget/#IInput","prop":"Variable","value":"<variavel local>"}
```
