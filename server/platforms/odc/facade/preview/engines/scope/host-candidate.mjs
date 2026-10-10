import fs from 'node:fs';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function assertExecutionAuthority(config){
 if(config?.canStart!==true||config.authorization?.status!=='authorized-local-render-scenario'||!config.authorization.scopeReceipt?.file)throw Object.assign(Error('Explicit local-render scope required'),{code:'LOCAL_SCENARIO_SCOPE_ABSENT'});
 const receipt=config.authorization.scopeReceipt,bytes=fs.readFileSync(receipt.file);if(hash(bytes)!==receipt.sha256)throw Error('Changed scope receipt');const scope=JSON.parse(bytes);
 if(scope.status!=='authorized-local-render-scenario'||scope.scenario.fictitiousUserId!==2147483001||scope.scenario.userProvider!=='Users'||JSON.stringify(scope.scenario.roles)!=='["Quotes"]'||scope.scenario.realBackend!==false||scope.scenario.realAccessValidated!==false)throw Error('Scope does not match this declared scenario');
 if(config.bindHost!=='127.0.0.2'||config.authorization.realAccessValidated!==false)throw Error('Dedicated local host required');
 if(config.preconditions?.some(x=>x.blocking===true&&x.status!=='complete'))throw Error('Independent precondition remains open');
}

