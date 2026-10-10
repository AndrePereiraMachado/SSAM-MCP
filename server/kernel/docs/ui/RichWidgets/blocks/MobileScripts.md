# MobileScripts

RichWidgets  | Traditional | UI flow **RichWidgets** | publico | 6 widgets internos

Set of scripts to add functionality to mobile devices:
- Orientation change CSS landscape/portrait
- Slide animations. Needs a style named .Main.
- If the web app added to Home Page, this prevents jumping to safari when following a link
- Hides the browser address bar in iPhone
- Disables phone numbers auto detection
- Adds meta tags (viewport, etc..)

## Inputs

Nenhum.

## Placeholders

Nenhum.

## Eventos

Nenhum.

## Composicao interna

- Chama actions do modulo: AddMetaTag (contratos em [actions.md](../actions.md))

## JavaScript

JavaScript do bloco:

```js
var Mobile_slideAnimations = true;
var Mobile_slideOutAnimation = '1200ms';
var Mobile_slideInAnimation = '200ms';
var Mobile_slideDiv = '.MainContent';
var Mobile_hasShownDiv = false;
//Fetches the cookie policy set on screen
function getCookiePolicy(){
    var cookiePolicy = "";
    var htmlPolicy = document.body.getAttribute("data-os-cookie-policy");
    if(htmlPolicy){
        if (htmlPolicy.search(/SameSite/i) > -1){
            var pattern = new RegExp(/SameSite=([^&;]+)/i);
            var result = pattern.exec(htmlPolicy);
            cookiePolicy = cookiePolicy + result[0] + ";"; 
        }
        if (htmlPolicy.search(/Secure/i) > -1){
            cookiePolicy = cookiePolicy + "Secure"; 
        }
    }
    return cookiePolicy;
}
outsystems.internal.$(function($) {

    // Disable animations for Android stock browser
    // as it has issues with HTML select elements (dropdowns)
    var userAgent = navigator.userAgent.toLowerCase(),
        // !( !android || !webkit || chrome )
        badBrowserForAnimations = !(userAgent.indexOf( 'android' ) < 0 ||
            userAgent.indexOf( 'AppleWebKit' ) < 0 ||
            userAgent.indexOf( 'chrome' ) >= 0);

    Mobile_slideAnimations = Mobile_slideAnimations && !badBrowserForAnimations; 

    // ios 5 cache on javascript:history.back() doesn't re-run onready javascript
    window.addEventListener("pageshow", pageShown, false);
    // We need to cache Mobile_hasShownDiv value as false to force the pageShown on javascript:history.back()
    window.addEventListener("pagehide", function(){ Mobile_hasShownDiv = false; }, false);
    pageShown(null);
    
    // Add Touch States to Your Buttons
    // One of the easiest ways to improve perceived performance on your site is by enabling the active state on mobile.
    // Unfortunately, neither iOS nor Android respect this property when a link or button is tapped on mobile. 
    // To enable those active states, you need to add a simple event to the page with JavaScript:
    document.addEventListener("touchstart", function(){}, true)
    
    function pageShown(evt) {
        if(Mobile_hasShownDiv) 
            return;
        Mobile_hasShownDiv = true;
        //Show the page
        if (Mobile_slideAnimations) {
            var fromBack = (document.cookie.indexOf('navigatedBack=true')>=0);
            slideIn($(Mobile_slideDiv), fromBack);
        } else {
            $(Mobile_slideDiv).show();
        }
        //Hide back button when it does not make sense
        if (document.referrer.indexOf(document.location.host)==-1 || history.length == 1) 
            $('a[href="javascript:history.back()"]').hide();
        
        //Scroll automatically on focus in search fields
        $("input[type=search]").focus(function(){
            scrollTo(0, $(this).offset().top);
            }
        );
    }

    //Intercept clicks to do the animations
    $('a').live('click', function(event){

        /*jshint scripturl:true*/
        var ahref = $(this).attr('href') ? $(this).attr('href').toLowerCase() : null,
            toBack = (ahref === 'javascript:history.back()');

        //continue as normally if it is a javascript link, an anchor or mailto: and tel: links
        if (ahref.indexOf('#')!=-1 ||
            event.isDefaultPrevented() ||
            !ahref ||
            this.target ||
            /^(http|https|mailto|tel):/.test(ahref) ||
            (ahref.indexOf('javascript:')===0 && !toBack )) {
          return;
        }

        document.cookie = 'navigatedBack=' + toBack + "; " + getCookiePolicy();
        
        //All clicks need to do this so that applications added to iphone home screen will not jump to safari
        event.preventDefault();
        window.location = this.href;
        
        // hide the current page while new page is loading
        if (Mobile_slideAnimations)
           slideOut($(Mobile_slideDiv), toBack);

    });

    function slideIn(toPage, backwards) {
        //using translate3d because it is hardware accelarated
        var translate3d = 'translate3d(' + (backwards ? '-' : '') + window.innerWidth + 'px,0,0)';
        var $toPage = $(toPage);
        $toPage
            .css('webkitTransitionDuration', '0ms')
            .css('webkitTransform', translate3d)
            .css('webkitTransitionDuration', Mobile_slideInAnimation)
            .css('transitionDuration', '0ms')
            .css('transform', translate3d)
            .css('transitionDuration', Mobile_slideInAnimation)
            .show();
        setTimeout(function() {
          $toPage.css('webkitTransform', 'none');
          $toPage.css('transform', 'none');
        }, 0);
    }

    function slideOut(fromPage, backwards) {
        $(fromPage).css('webkitTransitionDuration', Mobile_slideOutAnimation);
        setTimeout(function() {
            $(fromPage).css('webkitTransform', 'translate3d(' + (!backwards ? '-' : '') + window.innerWidth +    'px,0,0)');
        }, 0);
    }    
    
    //Set orientation classes in body (these can be used in the CSS selectors)
    var portraitVal = 'portrait';
    var landscapeVal = 'landscape';
    function orientChangeHandler(){
        var orientation = (window.orientation===0)? portraitVal: landscapeVal;
        $(document.body).removeClass(portraitVal).removeClass(landscapeVal)
            .attr('orient', orientation)
            .addClass(orientation);
        //Hide browser address bar
        if (badBrowserForAnimations) {
            setTimeout(scrollTo, 100, 0, 1);
        } else if (!pageYOffset && !location.hash) {
            setTimeout(scrollTo, 100, 0, 0);
        }
    }
    
    if (typeof window.onorientationchange == 'object'){
        $(window).bind( 'orientationchange', orientChangeHandler);
        setTimeout(orientChangeHandler, 0);
    }
 

});


```

## CSS

Classes: `.MainContent`

```css
.MainContent {
    display: none; /* JavaScript will make it show with animation */
    -servicestudio-display: block;
}

/* ExcludeAllFromPickersOutsideBlock */
```

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"MobileScripts1","source":"IWebBlock:MobileScripts","as":"$b"}
```
