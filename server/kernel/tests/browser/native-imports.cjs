const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{chromium}=require('playwright');
const url=process.argv[2],out=process.argv[3];
if(!url||!out)throw Error('Usage: node native-imports.cjs <ImportGallery URL> <proof directory>');
fs.mkdirSync(out,{recursive:true});
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});const result={checks:[],errors:[]};try{
 const page=await browser.newPage({viewport:{width:1360,height:900}});page.setDefaultTimeout(15000);page.on('pageerror',e=>result.errors.push(e.message));
 await page.goto(url,{waitUntil:'networkidle'});const cards=page.locator('article');assert.equal(await cards.count(),2);
 await cards.first().getByRole('button',{name:'Incrementar',exact:true}).click();
 await cards.first().getByRole('button',{name:'Incrementar',exact:true}).click();
 await cards.nth(1).getByRole('button',{name:'Incrementar',exact:true}).click();
 assert.deepEqual(await cards.locator('.count').allTextContents(),['2','1']);result.checks.push('two aliases of one imported panel contain independent instances of one imported counter');
 assert.equal(await cards.locator('footer').filter({hasText:'Conteúdo projetado pelo painel importado.'}).count(),2);result.checks.push('slot content survives nested file imports');
 assert.equal(await cards.first().evaluate(e=>getComputedStyle(e).borderRadius),'16px');result.checks.push('stylesheet from imported file applied');
 await page.screenshot({path:path.join(out,'imports-desktop.png')});await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(out,'imports-mobile.png')});result.checks.push('390px without horizontal overflow');
 assert.deepEqual(result.errors,[]);result.ok=true;
}catch(error){result.ok=false;result.failure=error.stack;process.exitCode=1;}finally{fs.writeFileSync(path.join(out,'imports-browser.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await browser.close();}})();
