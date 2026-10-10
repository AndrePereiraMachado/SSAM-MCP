const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{chromium}=require('playwright');
const [url,out]=process.argv.slice(2);
if(!url||!out)throw Error('Usage: node native-module-imports.cjs <NativeImports URL> <proof directory>');
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
 const result={checks:[],errors:[],dataPagingProven:false};
 try {
  const page=await browser.newPage({viewport:{width:1360,height:900}});page.setDefaultTimeout(15000);
  page.on('pageerror',e=>result.errors.push(e.message));
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'Componentes de outro módulo'}).waitFor();
  assert.equal(await page.locator('.card').count(),2);
  await page.locator('.page').filter({hasText:'Página 1 de 4'}).waitFor();
  await page.getByRole('button',{name:'go to next page'}).click();
  await page.locator('.page').filter({hasText:'Página 2 de 4'}).waitFor();
  await page.getByRole('button',{name:'go to next page'}).click();
  await page.locator('.page').filter({hasText:'Página 3 de 4'}).waitFor();
  await page.getByRole('button',{name:'go to next page'}).click();
  await page.locator('.page').filter({hasText:'Página 4 de 4'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'go to next page'}).isDisabled(),true);
  await page.getByRole('button',{name:'go to previous page'}).click();
  await page.locator('.page').filter({hasText:'Página 3 de 4'}).waitFor();
  result.checks.push('two native Card instances render projected HTML','native Pagination invokes authored JavaScript and receives updated StartIndex','forward/back navigation and final-page disabled state');
  await page.screenshot({path:path.join(out,'native-imports-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:path.join(out,'native-imports-mobile.png'),fullPage:true});
  result.checks.push('390px without horizontal overflow');assert.deepEqual(result.errors,[]);result.ok=true;
 } catch(error){result.ok=false;result.failure=error.stack;process.exitCode=1;}
 finally{fs.writeFileSync(path.join(out,'native-imports-browser.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await browser.close();}
})();
