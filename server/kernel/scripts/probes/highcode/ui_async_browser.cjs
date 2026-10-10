// Runtime research, synthetic lab only. No change to product source syntax.
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {chromium}=require('playwright');
const url=process.argv[2],out=process.argv[3];
if(!url||!out)throw Error('Usage: node ui_async_browser.cjs <lab URL> <output directory>');
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
 const result={checks:[],errors:[],serverCalls:0};
 try {
  const page=await browser.newPage();page.setDefaultTimeout(12000);
  page.on('pageerror',e=>result.errors.push(e.message));
  page.on('request',r=>{if(r.url().includes('InteropServerEcho'))result.serverCalls++});
  await page.goto(url,{waitUntil:'networkidle'});
  const cards=page.locator('.interop-card');assert.equal(await cards.count(),2);
  result.wire=await cards.first().locator('.wire-json').textContent();
  result.nativeRows=await cards.first().locator('.wire-rows').innerText();
  result.parsedWire=JSON.parse(result.wire);
  assert.equal(result.parsedWire[0].Id,'9223372036854775807');
  assert.equal(result.parsedWire[1].Id,'9007199254740993');
  result.decimal={source:'123456789012345.6789',nativeClientValue:result.parsedWire[0].Amount,
                  exact:result.parsedWire[0].Amount==='123456789012345.6789'};
  result.nativeSerializer=await page.evaluate(()=>{
    const json=require('OutSystems/ClientRuntime/JSONUtils'),model=require('ZZHtmlDashboardReview_UI.model');
    const list=json.deserializeFromJSON('[{"Id":9223372036854775807,"Caption":"probe"}]',model.InteropWireRowList,false);
    try{return {rejected:false,value:json.serializeToJSON(list,true,false)}}
    catch(error){return {rejected:true,name:error.name,message:error.message}}
  });
  assert.equal(result.nativeSerializer.rejected,true);
  assert.ok(result.nativeRows.includes('9223372036854775807:primeiro'));
  assert.ok(result.nativeRows.includes('9007199254740993:segundo'));
  result.checks.push('typed native list renders two distinct 64-bit IDs after JSON round trip');
  await cards.first().getByRole('button',{name:'Slow',exact:true}).click();
  await cards.first().locator('.busy').filter({hasText:'loading'}).waitFor();
  assert.equal(await cards.first().locator('.result').textContent(),'0');
  result.checks.push('native Busy visible before delayed request completes');
  await cards.first().getByRole('button',{name:'Fast',exact:true}).click();
  await cards.first().locator('.result').filter({hasText:/^21$/}).waitFor();
  assert.equal(await cards.nth(1).locator('.result').textContent(),'0');
  await page.waitForTimeout(2100);
  assert.equal(await cards.first().locator('.result').textContent(),'21');
  result.checks.push('newer response preserved after slower older response; instances isolated');
  await cards.first().getByRole('button',{name:'Fail',exact:true}).click();
  await cards.first().locator('.failure').filter({hasText:'synthetic failure'}).waitFor();
  assert.equal(await cards.first().locator('.busy').textContent(),'idle');
  await cards.first().getByRole('button',{name:'Fast',exact:true}).click();
  await cards.first().locator('.result').filter({hasText:/^21$/}).waitFor();
  assert.equal(await cards.first().locator('.failure').textContent(),'');
  result.checks.push('rejection settles loading; retry commits result');
  await cards.first().getByRole('button',{name:'Slow',exact:true}).click();
  await page.getByRole('button',{name:'Toggle first',exact:true}).click();
  assert.equal(await cards.count(),1);
  await page.getByRole('button',{name:'Toggle first',exact:true}).click();
  await page.waitForTimeout(2100);
  assert.deepEqual(await cards.locator('.result').allTextContents(),['0','0']);
  result.checks.push('disposed instance cannot overwrite remounted instance');
  await page.screenshot({path:path.join(out,'async-lifetime.png')});
  await page.goto(new URL('InteropListResearch',url).href,{waitUntil:'networkidle'});
  const rows=page.locator('.research-row');
  assert.deepEqual(await rows.locator('.row-caption').allTextContents(),['A','B']);
  await rows.first().getByRole('button',{name:'Fast',exact:true}).click();
  await rows.first().locator('.result').filter({hasText:/^21$/}).waitFor();
  await page.getByRole('button',{name:'Sort rows',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.row-caption')?.textContent==='B');
  result.nativeSort={captions:await rows.locator('.row-caption').allTextContents(),values:await rows.locator('.result').allTextContents()};
  result.nativeSort.stateFollowsBusinessKey=JSON.stringify(result.nativeSort.values)===JSON.stringify(['0','21']);
  await page.getByRole('button',{name:'Reverse rows',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.row-caption')?.textContent==='B');
  result.reorder={captions:await rows.locator('.row-caption').allTextContents(),values:await rows.locator('.result').allTextContents()};
  result.reorder.stateFollowsBusinessKey=JSON.stringify(result.reorder.values)===JSON.stringify(['0','21']);
  result.checks.push('native list replacement/reorder observed; key semantics reported separately');
  assert.ok(result.serverCalls>0,'real native server request observed');
  assert.deepEqual(result.errors,[]);result.ok=true;
 } catch(error){result.ok=false;result.failure=error.stack;process.exitCode=1;}
 finally{fs.writeFileSync(path.join(out,'async-browser.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await browser.close();}
})();
