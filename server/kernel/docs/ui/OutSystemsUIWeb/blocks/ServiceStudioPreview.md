# ServiceStudioPreview

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Private** | privado | 0 widgets internos

CSS for the Service Studio Preview.

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## JavaScript

Sem JavaScript proprio.
## CSS

Classes: `.header`, `.Application_Menu`, `.Menu_TopMenus`, `.Menu_DropDownButton`, `.Menu_TopMenu`, `.Menu_DropDownPanel`, `.Menu_TopMenuActive`, `.open`, `.navigation`, `.tablet`, `.header-top`, `.phone`, `.header-right`, `.header-center`, `.balloon`, `.columns`, `.content-middle`, `.is--hidden`, `.accordion`, `.modal`, `.breadcrumbs`, `.center-align`, `.sidebar-container`, `.accordion-item-title`, `.alert-message`, `.modal-title`, `.animated-label-text`, `.animated-label-input`, `.dropdown-header`, `.input-with-icon`, `.input-with-icon-input`, `.toggle-button-label`, `.breadcrumbs-item`, `.title`, `.sidebar-header`, `.wizard-item-label`, `.columns-item`, `.balloon-title`, `.tooltip-widget`, `.timeline-item-date`, `.modal-footer`, `.panel-title`, `.panel-footer`, `.timeline-item-container`, `.accordion-item-content`, `.balloon-content`, `.blank-slate-content`, `.card`, `.card-background-content`, `.card-background-image`, `.modal-content`, `.panel-content`, `.upload-widget`, `.counter`, `.flip-content`, `.flip-content-front`, `.flip-content-back`, `.dropdown-container`, `.dropdown-content-list`, `.search-balloon-answers`, `.sidebar-content`, `.tabs-content`, `.tabs-content-item`, `.wizard`, `.fieldset-content`, `.modal-wrapper`, `.dropdown`, `.separator`, `.vertical`, `.bottom-left`, `.bottom-right`, `.top-left`, `.top-right`, `.left`, `.right`, `.balloon-container`, `.card-background-color`, `.card-background`, `.chat`, `.chat-message-content`, `.section-header`, `.section-actions`, `.section-content`, `.progress-container`, `.flex-direction-row`, `.progress-title`, `.flex-direction-row-reverse`, `.search`, `.search-actions`, `.search-balloon`, `.user-avatar`, `.badge-icon`, `.badge`, `.icon`, `.ph`, `.tabs-header`, `.tabs`, `.flex-direction-column`, `.timeline`, `.timeline-item-right`, `.wizard-vertical`, `.wizard-item`, `.wizard-item-icon-wraper`, `.wizard-item-icon`, `.load-on-visible-content`, `.WebBlock`, `.layout-login`, `.layout-login-background`, `.WebScreen`, `.layout-login-form-content`, `.layout-login-simple`, `.OUTSYSTEMS_INTERNAL_BLOCK_INSTANCE`, `.layout-login-form`, `.character-count-text`

Variaveis: `--color-neutral-3`, `--shadow-m`, `--space-xs`, `--space-s`, `--hidden`, `--space-none`, `--space-l`, `--space-base`

```css
/* Menu Preview */

.header .Application_Menu,
.header .Menu_TopMenus,
.header .Menu_DropDownButton,
.header .Menu_TopMenu,
.header .Menu_TopMenu > div,
.header .Menu_TopMenu > div > a {
   -servicestudio-height: 100%;
} 



.header .Menu_DropDownPanel {
   -servicestudio-border: 1px solid var(--color-neutral-3);
   -servicestudio-box-shadow: var(--shadow-m);
   -servicestudio-border-radius: var(--space-xs);
   -servicestudio-min-width: 140px;
   -servicestudio-height: auto;
   -servicestudio-margin: -1rem 0 0 0;
   -servicestudio-z-index: 250;
}

.header .Menu_TopMenu > div > a:hover,
.header .Menu_TopMenu.Menu_TopMenuActive > div > a,
.header .Menu_DropDownButton.open .Menu_TopMenu > div > a {
   -servicestudio-border-left: 0;
}

.header .Menu_DropDownButton {
   -servicestudio-width: auto;
}

.Menu_TopMenus:empty,
.navigation .Menu_TopMenus:empty {
    -servicestudio-position: relative;    
    -servicestudio-width: 100%;
    -servicestudio-height: 100%;    
} 

.Menu_TopMenus:empty:after {    
    -servicestudio-color: #ccc;
    -servicestudio-font-size: 10px;
    -servicestudio-content: "Drag screens to this area create menu items";
    -servicestudio-text-align: center;
    -servicestudio-position: absolute;
    -servicestudio-top: 50%;
    -servicestudio-left: 50%;
    -servicestudio-transform: translateX(-50%) translateY(-50%);
}

/* SS Responsive behaviour */

.Application_Menu {
    -servicestudio-display: flex;
}

.tablet .header-top,
.phone .header-top {
    -servicestudio-display: flex;
    -servicestudio-align-items: center;
}

.phone .header-right {
    -servicestudio-display: none !important;
}

.phone .header-center {
    -servicestudio-padding: var(--space-s);
}

.phone .balloon,
.phone .columns,
.Menu_TopMenus:empty:after {
    -servicestudio-width: 100%;
}


/*CONTENT LAYOUT*/

.content-middle {   
    -servicestudio-min-height: 400px;
}

.header-center {
    -servicestudio-display: block !important;
}


/* CONTENT ServiceStudioPreview */

.is--hidden {
    -servicestudio-visibility: visible !important;
}

.accordion,
.modal,
.balloon,
.breadcrumbs,
.center-align:empty,
.sidebar-container {
    -servicestudio-position: relative !important;
}

.accordion-item-title:empty,
.alert-message:empty,
.modal-title:empty:empty
.animated-label-text:empty,
.animated-label-input:empty,
.dropdown-header > div:empty,
.input-with-icon .input-with-icon-input:empty,
.toggle-button-label:empty,
.breadcrumbs-item .title:empty,
.sidebar-header:empty,
.wizard-item-label:empty,
.columns-item:empty,
.balloon-title:empty,
.tooltip-widget:empty,
.timeline-item-date:empty {
    -servicestudio-height: 30px !important;
}

.modal-footer:empty,
.panel-title:empty,
.panel-footer:empty,
.breadcrumbs:empty,
.center-align:empty,
.timeline-item-container:empty{
    -servicestudio-height: 60px;
}

.accordion-item-content:empty,
.balloon-content:empty,
.blank-slate-content:empty,
.card:empty,
.card-background-content:empty,
.card-background-image:empty,
.modal-content:empty,
.panel-content:empty,
.upload-widget:empty,
.counter .center-align:empty,
.flip-content .flip-content-front:empty,
.flip-content .flip-content-back:empty  {
    -servicestudio-height: 90px;
}

.accordion:empty,
.dropdown-container .dropdown-content-list:empty,
.search-balloon-answers .balloon-content > div,
.sidebar-content:empty,
.tabs-content:empty,
.tabs-content-item:empty,
.columns:empty,
.wizard:empty,
.fieldset-content:empty {
    -servicestudio-height: 150px;
}

.alert-message:empty,
.modal-wrapper,
.animated-label-input,
.dropdown,
.dropdown .dropdown-header > div,
.columns-item,
.columns-item:empty,
.sidebar-container,
.separator.vertical {
    -servicestudio-width: 100%;
}

.card-background-content:empty,
.blank-slate-content:empty {
    -servicestudio-min-width: 100%;
}

.bottom-left .blank-slate-content,
.bottom-right .blank-slate-content,
.top-left .blank-slate-content,
.top-right .blank-slate-content,
.left .blank-slate-content,
.right .blank-slate-content,
.bottom-left .card-background-content,
.bottom-right .card-background-content,
.top-left .card-background-content,
.top-right .card-background-content,
.left .card-background-content,
.right .card-background-content {
    -servicestudio-max-width: 65%;
}

.toggle-button-label:empty {
    -servicestudio-width: 100px;
}

.wizard-item-label:empty {
    -servicestudio-width: 90px;
}

.balloon {
    -servicestudio-position: static;
}

.balloon-container {
    -servicestudio-display: initial;
}

.card:empty {
    -servicestudio-min-height: 120px;
}

.card-background-color {
    -servicestudio-pointer-events: none;
}

.card-background {
    -servicestudio-flex-direction: column;
}


.card-background-image:empty {
    -servicestudio-position: static;
    -servicestudio-opacity: 0.5;
    -servicestudio-z-index: 1;
}

.chat .chat-message-content {
    -servicestudio-width: 100%;
}

.balloon {
    -servicestudio-position: relative;
    -servicestudio-width: 340px;
}

.section-header .title {
    -servicestudio-height: 30px;
}

.section-actions:empty {
    -servicestudio-height: 30px;
    -servicestudio-min-width: 20%;
}

.section-content:empty {
    -servicestudio-height: 150px;
}

.tooltip-widget {
    -servicestudio-margin-right: 8px;
}

.tooltip-widget:empty {
    -servicestudio-width: 30px;
}

.progress-container.flex-direction-row .progress-title {
    -servicestudio-display: none !important;
}



/* CONTROLS ServiceStudioPreview */
.input-with-icon .input-with-icon-input:empty {
    -servicestudio-margin-left: 50px;
}

.input-with-icon.flex-direction-row-reverse .input-with-icon-input {
    -servicestudio-margin-left: 0;
}

.input-with-icon.flex-direction-row-reverse .input-with-icon-input:empty {
    -servicestudio-margin-right: 50px;
}



.search .search-actions {
    -servicestudio-top: 0;
}

.search-balloon .balloon {
   -servicestudio-max-width: 100% !important; 
}

/* DATA ServiceStudioPreview */

.user-avatar  {
    -servicestudio-border-radius: 50%;
}

.badge-icon .badge span {
    -servicestudio-display: none;
}

.badge-icon .badge:before {
    -servicestudio-content:'9';
}

/* NAVIGATION ServiceStudioPreview */

.breadcrumbs-item .icon:empty {
    -servicestudio-height: 20px;
}

.breadcrumbs-item .icon.ph {
    -servicestudio-display: inline-block !important;
}


.tabs-header:empty{
    -servicestudio-min-height: 60px;
    -servicestudio-min-width: 150px;
}

.tabs.flex-direction-column {
    -servicestudio-display: flex;
    -servicestudio-flex-wrap: nowrap;
    -servicestudio-flex-direction: row;
    
}

.tabs.flex-direction-column .tabs-header {
    -servicestudio-flex-direction: column;
}

.timeline:empty {
    -servicestudio-width: 100% !important;
    -servicestudio-height: 150px;
}

.timeline-item-right,
.timeline-item-date:empty,
.timeline-item-container:empty {
    -servicestudio-width: 100% !important;
}


.wizard:empty {
    -servicestudio-width: 100% !important;
    -servicestudio-height: 150px;
}

.wizard-vertical .wizard-item {
    -servicestudio-padding-bottom: 32px;
}

.wizard-item:first-child .wizard-item-icon-wraper:before {
   -servicestudio-content: '';
}

.wizard .wizard-item {
   -servicestudio-padding-right: 24px;
}

.wizard-item-icon:empty {
    -servicestudio-width: 32px !important;
    -servicestudio-height: 32px !important;
}



/* Responsive */
/* Load On Visible */
.load-on-visible-content:empty {
    -servicestudio-height: 30px !important;
}

/* UTILITIES Structure */
.columns .columns-item {
    -servicestudio-margin: var(--space-none) calc(var(--space-l) / 2);
    -servicestudio-margin-bottom: var(--space-l) !important;
    -servicestudio-padding: 0 !important;
    }

.columns .columns-item:empty {
    -servicestudio-height: 400px !important;    
}

.columns .columns-item > div > .card {
   -servicestudio-height: 100%;
}

/* UTILITIES ServiceStudioPreview */

.flip-content .flip-content-front,
.flip-content .flip-content-back {
    -servicestudio-position: relative !important;
    -servicestudio-margin-top: 10px !important;
    -servicestudio-transform: rotateY(0deg) !important;
}

.separator.vertical {
    -servicestudio-margin: 0;
}

/* LAYOUTS Layout Login */
html[data-ss-kind='Nodes.WebBlock'],
.layout-login .columns,
.layout-login .layout-login-background {
    -servicestudio-height: 100%;
}

html[data-ss-kind='Nodes.WebScreen'] .layout-login,
html[data-ss-kind='Nodes.WebScreen'] .layout-login .layout-login-form-content,
.layout-login-simple .OUTSYSTEMS_INTERNAL_BLOCK_INSTANCE {
    -servicestudio-min-height: 100vh;
}

html[data-ss-kind='Nodes.WebScreen'] .layout-login .layout-login-form-content .OUTSYSTEMS_INTERNAL_BLOCK_INSTANCE {
    -servicestudio-min-height: auto;
}

.layout-login .OUTSYSTEMS_INTERNAL_BLOCK_INSTANCE {
    -servicestudio-width: 100%;
}

.layout-login-simple .OUTSYSTEMS_INTERNAL_BLOCK_INSTANCE {
    -servicestudio-width: auto;
    -servicestudio-height: 100%;
}

.layout-login .columns .columns-item > .OUTSYSTEMS_INTERNAL_BLOCK_INSTANCE {
    -servicestudio-display: flex;
    -servicestudio-justify-content: center;
    -servicestudio-flex-direction: column;
    -servicestudio-height: 100%;
    -servicestudio-align-items: center;
}

.layout-login .OUTSYSTEMS_INTERNAL_BLOCK_INSTANCE > .columns {
    -servicestudio-margin-left: 0 !important;
    -servicestudio-margin-right: 0 !important;
}

.layout-login .OUTSYSTEMS_INTERNAL_BLOCK_INSTANCE > .columns .columns-item {
    -servicestudio-padding: 0 !important;
    -servicestudio-margin: 0 !important;
}

.layout-login .OUTSYSTEMS_INTERNAL_BLOCK_INSTANCE > .columns .columns-item > img {
    -servicestudio-width: 100%;
    -servicestudio-height: 100%;
    -servicestudio-object-fit: cover;
    -servicestudio-object-position: center;    
}

.layout-login-form-content {
    -servicestudio-position: absolute;
    -servicestudio-left: 50%;
    -servicestudio-transform: translateX(-50%);
    -servicestudio-min-height: 100vh !important;
    -servicestudio-min-width: 100% !important;
    -servicestudio-margin: 0 !important;
}

.layout-login-form {
    -servicestudio-margin: var(--space-base) var(--space-none) !important;
}
.phone .layout-login-simple .layout-login-form-content {
    -servicestudio-align-items: center !important;
}

/* Character Count */
.character-count-text  {
    -servicestudio-min-width: 50px;   
}

/* ExcludeAllFromPickersOutsideBlock */

```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"ServiceStudioPreview1","source":"IWebBlock:ServiceStudioPreview","as":"$b"}
```
