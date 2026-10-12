import fs from 'node:fs';import path from 'node:path';
import {isUuid} from './write-journal.mjs';import {fail} from './errors.mjs';
export const API_CLIENT_VAULT_STATUS='apiClients.fixtureCredentialStatus';
const bad=()=>fail('API_CLIENT_VAULT_SCOPE_UNVERIFIED','Fixture credential status requires its registered own creation, native reservation and matching authenticated Studio principal.');
export async function apiClientVaultStatus({host,input,lookup,writesDir,session,probe}){
 if(!input||Object.keys(input).join(',')!=='creationOperationUuid'||!isUuid(input.creationOperationUuid)
  ||input.creationOperationUuid!==input.creationOperationUuid.toLowerCase())bad();
 const id=input.creationOperationUuid,origin=lookup(id),name=origin?.identity?.target?.apiClientFixtureName;
 if(origin?.schema!=='ssam-odc-write/1'||origin.operationUuid!==id||origin.identity?.tenant!==host||origin.identity.operationId!=='apiClients.create'
  ||!['uncertain','accepted','confirmed'].includes(origin.state)||origin.reconciliation?.apiClientFixture?.name!==name
  ||!/^SSAMApiClientProof\d{8}[A-Za-z0-9]{0,16}$/.test(name??'')||!isUuid(origin.authorization?.source?.threadId)||!isUuid(origin.authorization?.source?.messageId)
  ||!/^[a-f0-9]{64}$/.test(origin.authorization.wordsSha256??'')||!session?.loggedIn||session.host!==host||!session.user)bad();
 let native;try{const file=path.join(writesDir,id+'.json');if(fs.statSync(file).size>32768)bad();native=JSON.parse(fs.readFileSync(file,'utf8'));}catch{bad();}
 if(native.operationUuid!==id||native.operationId!=='apiClients.create'||native.host!==host
  ||native.path!=='/usersaccess/screenservices/usersaccess/APIClients/apiclient/ActionAPIClients_Create'||native.source!=='private-session-pipe'
  ||String(native.user??'').toLowerCase()!==session.user.toLowerCase()||native.authorizeSha256!==origin.authorization.wordsSha256)bad();
 const observed=await probe(host,id),target='SSAM/ODC3/'+host+'/APIClientFixture/'+id;
 if(typeof observed?.available!=='boolean'||observed.operationUuid!==id||observed.target!==target)bad();
 return {ok:true,tenant:host,operationId:API_CLIENT_VAULT_STATUS,creationOperationUuid:id,name,
  credentialPresent:observed.available,credentialAbsenceVerified:!observed.available,privateValueExposed:false,
  captureVerified:false,remoteDeletionVerified:false,scope:'exact-local-fixture-vault-destination'};
}
