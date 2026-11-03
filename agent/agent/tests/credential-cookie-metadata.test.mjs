import test from 'node:test';
import assert from 'node:assert/strict';
import {isSensitiveCookie} from '../lib/credential-session.mjs';
test('only bounded public Portal routing cookies are excluded from secret substring matching',()=>{
 for(const [name,value] of [['TenantGeo','US'],['TenantRing','1'],['TenantPortfolio','3']]) assert.equal(isSensitiveCookie(name,value),false);
 for(const [name,value] of [['TenantAccess','1'],['TenantRing','secret-token'],['TenantGeo','US\n'],['tenantgeo','US'],['TenantPortfolio','1234567'],['session','US'],[undefined,'1']]) assert.equal(isSensitiveCookie(name,value),true);
});
test('visit marker family excludes only exact public flags, not sessions or malformed names',()=>{
 const name='osvisit'+'a'.repeat(32);
 for(const value of ['0','1']) assert.equal(isSensitiveCookie(name,value),false);
 for(const [key,value] of [[name,'private-token'],[name,'1\n'],[name+'x','1'],['x'+name,'1'],['osVisit','1'],['osVisitor','1'],['ASP.NET_SessionId','1']]) assert.equal(isSensitiveCookie(key,value),true);
});
