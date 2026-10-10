// LAB experiment, not a claim of supported source-level key semantics.
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{chromium}=require('playwright');
const [url,out]=process.argv.slice(2);if(!url||!out)throw Error('URL and output directory required');fs.mkdirSync(out,{recursive:true});
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});const result={errors:[],modes:[],sourceFrontendImplemented:false};
try{
 for(const preserve of [null,true]){
  const p=await browser.newPage();p.setDefaultTimeout(15000);p.on('pageerror',e=>result.errors.push(e.message));await p.goto(url,{waitUntil:'networkidle'});
  const mode={override:preserve,preserveListItemReactKey:await p.evaluate(value=>{const env=require('OutSystems/ClientRuntime/Settings').getEnvParams();if(value!==null)env.PreserveListItemReactKey=value;return env.PreserveListItemReactKey},preserve)};
  // The flag changes the wrapper-key format. Mount/reset under that format before accumulating
  // state, otherwise the first transition falsely measures the format change as a sort failure.
  if(preserve!==null){await p.getByRole('button',{name:'Reset',exact:true}).click();await p.waitForTimeout(250);}
  const rows=p.locator('.identity-counter');assert.equal(await rows.count(),2);
  await rows.nth(0).getByRole('button',{name:'Increment',exact:true}).click();await rows.nth(0).getByRole('button',{name:'Increment',exact:true}).click();await rows.nth(1).getByRole('button',{name:'Increment',exact:true}).click();
  async function snapshot(){return{labels:await rows.locator('.caption').allTextContents(),counts:await rows.locator('.count').allTextContents(),before:await p.locator('.before-ids').textContent(),after:await p.locator('.after-ids').textContent()};}
  mode.initial=await snapshot();await p.getByRole('button',{name:'TrackedDescending',exact:true}).click();await p.waitForTimeout(250);mode.descending=await snapshot();
  await p.getByRole('button',{name:'TrackedAscending',exact:true}).click();await p.waitForTimeout(250);mode.ascending=await snapshot();
  mode.stateFollowsBusinessKey=JSON.stringify(mode.descending.labels)==='["B","A"]'&&JSON.stringify(mode.descending.counts)==='["1","2"]'&&JSON.stringify(mode.ascending.counts)==='["2","1"]';
  mode.itemIdsPreserved=JSON.stringify(JSON.parse(mode.descending.before).sort())===JSON.stringify(JSON.parse(mode.descending.after).sort());
  await p.getByRole('button',{name:'NativeSort',exact:true}).click();await p.waitForTimeout(250);mode.normalNativeSort=await snapshot();
  result.modes.push(mode);await p.screenshot({path:path.join(out,'list-'+String(preserve)+'.png')});await p.close();
 }
 assert.deepEqual(result.errors,[]);result.experimentCompleted=true;
}catch(error){result.experimentCompleted=false;result.failure=error.stack;process.exitCode=1;}finally{fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await browser.close();}})();
