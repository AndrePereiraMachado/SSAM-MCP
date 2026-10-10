const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{chromium}=require('playwright');
const [url,out]=process.argv.slice(2);
if(!url||!out)throw Error('Usage: node native-module-consumer.cjs <SharedComponents URL> <proof directory>');
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});const result={checks:[],errors:[]};
 try {
  const page=await browser.newPage({viewport:{width:1360,height:900}});page.setDefaultTimeout(15000);
  page.on('pageerror',e=>result.errors.push(e.message));await page.goto(url,{waitUntil:'domcontentloaded'});
  const cards=page.locator('article');await cards.first().getByRole('button',{name:'Incrementar',exact:true}).waitFor();
  assert.equal(await cards.count(),2);
  await cards.first().getByRole('button',{name:'Incrementar',exact:true}).click();
  await cards.first().getByRole('button',{name:'Incrementar',exact:true}).click();
  await cards.nth(1).getByRole('button',{name:'Incrementar',exact:true}).click();
  assert.deepEqual(await cards.locator('.count').allTextContents(),['2','1']);
  await page.locator('.result').filter({hasText:'Eventos recebidos: 3'}).waitFor();
  await cards.nth(1).getByRole('button',{name:'Emitir sequência',exact:true}).click();
  await page.locator('.result').filter({hasText:'Último: 2 · Eventos recebidos: 6'}).waitFor();
  assert.equal(await cards.first().evaluate(e=>getComputedStyle(e).borderRadius),'16px');
  assert.equal(await cards.first().getByText('Conteúdo da primeira instância',{exact:true}).count(),1);
  assert.equal(await cards.nth(1).getByText('Conteúdo da segunda instância',{exact:true}).count(),1);
  result.checks.push('published block reused across modules','independent instance states 2/1','native events reach authored consumer handlers including three queued emissions','producer CSS and consumer slots preserved');
  await page.screenshot({path:path.join(out,'consumer-desktop.png')});await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:path.join(out,'consumer-mobile.png'),fullPage:true});result.checks.push('390px without horizontal overflow');
  assert.deepEqual(result.errors,[]);result.ok=true;
 }catch(error){result.ok=false;result.failure=error.stack;process.exitCode=1;}
 finally{fs.writeFileSync(path.join(out,'consumer-browser.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await browser.close();}
})();
