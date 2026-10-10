const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{chromium,expect}=require('playwright/test');
const [url,out]=process.argv.slice(2);
if(!url||!out)throw Error('Usage: node native-values.cjs <ValueGallery URL> <proof directory>');
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});const result={checks:[],errors:[]};
 try {
  const page=await browser.newPage({viewport:{width:1360,height:900}});page.setDefaultTimeout(15000);
  page.on('pageerror',e=>result.errors.push(e.message));await page.goto(url,{waitUntil:'domcontentloaded'});
  const cards=page.locator('article');await expect(cards).toHaveCount(2);
  await expect(cards.locator('h2')).toHaveText(['Pronto','Pronto']);
  await expect(cards.locator('.amount')).toHaveText(['Valor: 1.5','Valor: 1.5']);
  const initial='9223372036854775807: A / 1 / inicial\n9007199254740993: B / 2 / outro';
  await expect(cards.locator('.rows')).toHaveText([initial,initial]);
  result.checks.push('native initialization precedes authored onInitialize','large text identifiers preserved exactly','nested primitive arrays round trip');
  await cards.first().getByRole('button',{name:'Alterar',exact:true}).click();
  await cards.first().getByRole('button',{name:'Alterar',exact:true}).click();
  await cards.nth(1).getByRole('button',{name:'Alterar',exact:true}).click();
  await expect(cards.locator('.amount')).toHaveText(['Valor: 2.5','Valor: 2']);
  await expect(cards.locator('.edits')).toHaveText(['Edições: 2','Edições: 1']);
  await expect(cards.locator('.rows')).toHaveText([
   '9223372036854775807: A / 3 / inicial,editado,editado\n9007199254740993: B / 4 / outro,editado,editado',
   '9223372036854775807: A / 2 / inicial,editado\n9007199254740993: B / 3 / outro,editado']);
  result.checks.push('map/spread/nested field edits persist across native actions','block instances retain independent state');
  await page.screenshot({path:path.join(out,'values-desktop.png')});
  await cards.first().getByRole('button',{name:'Limpar',exact:true}).click();
  await expect(cards.first().locator('.rows')).toHaveText('');
  await expect(cards.nth(1).locator('.rows')).toContainText('9223372036854775807: A / 2');
  await cards.first().getByRole('button',{name:'Alterar',exact:true}).click();
  await expect(cards.first().locator('.rows')).toHaveText('');
  await expect(cards.first().locator('.amount')).toHaveText('Valor: 3');
  result.checks.push('empty runtime arrays survive later handlers without affecting the other instance');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:path.join(out,'values-mobile.png'),fullPage:true});result.checks.push('390px without horizontal overflow');
  assert.deepEqual(result.errors,[]);result.ok=true;
 }catch(error){result.ok=false;result.failure=error.stack;process.exitCode=1;}
 finally{fs.writeFileSync(path.join(out,'values-browser.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await browser.close();}
})();
