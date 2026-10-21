// Hosted router entrypoint; shares the production image and the license database.
import {createRouter} from './hosted/router.mjs';
import {openTokenStore} from './server-tokens.mjs';
const dir=process.env.SSAM_SERVER_DIR??'/data/server';
try{
 const store=await openTokenStore({dir});
 const router=await createRouter({dir,store,host:'0.0.0.0',port:Number(process.env.SSAM_ROUTER_PORT??7300),window:Number(process.env.SSAM_VERSION_WINDOW??3),
  backends:JSON.parse(process.env.SSAM_ROUTER_BACKENDS??'[]'),publicHosts:(process.env.SSAM_PUBLIC_HOST??'').split(',').filter(Boolean),consoleHost:process.env.SSAM_CONSOLE_HOST,consoleUrl:process.env.SSAM_CONSOLE_URL});
 const stop=async()=>{await router.close();await store.close?.();process.exit(0);};process.once('SIGTERM',stop);process.once('SIGINT',stop);
 process.stdout.write(JSON.stringify({event:'router-started',port:router.server.address().port})+'\n');
}catch{process.stderr.write('Router configuration or license database unavailable.\n');process.exitCode=1;}
