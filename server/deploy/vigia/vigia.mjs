import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runVigia} from './window.mjs';
export * from './window.mjs';
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),at=args.indexOf('--config');if(at<0||!args[at+1])throw Error('Usage: vigia.mjs --config <file> [--dry-run]');
 const config=JSON.parse(fs.readFileSync(args[at+1],'utf8').replace(/^\uFEFF/,''));
 const {createRuntime}=await import('./runtime.mjs');const runtime=await createRuntime(config);
 const manifest=JSON.parse(fs.readFileSync(path.join(config.workspace,'server/deploy/coolify/versions.json'),'utf8'));
 let state={};if(config.versionStateFile)state=JSON.parse(fs.readFileSync(config.versionStateFile,'utf8'));
 const result=await runVigia({...config,manifest,state,observed:await runtime.detect(),dryRun:args.includes('--dry-run')},runtime);
 console.log(JSON.stringify(result,null,2));if(result.status==='failed')process.exitCode=1;
}
