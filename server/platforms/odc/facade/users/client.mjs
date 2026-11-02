// Users is a distinct WebForms security surface, not a Service Center URL alias.
// Page state and event targets come from the current response. Never evaluate remote JS.
import { Transport, hostName } from '../service-center/http.mjs';
import { Document, Page, controls, controlValue, caption, formFields, postbackTarget, lower } from '../service-center/html.mjs';
import { urljoin, urlsplit } from '../service-center/urls.mjs';
import { ajaxPage } from '../service-center/client.mjs';

export class UsersError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fromBase64 = text => Buffer.from(text ?? '', 'base64').toString('utf8');
const fail = (code, message) => { throw new UsersError(code, message); };
const pages = new Set(['Login','User_List','Inactive_Users','User_Show','User_Edit','Group_List','Group_Show','Group_Edit','Application_List','Application_Show','Role_Show','MyInfo']);
export const identifier = value => {
  const v = String(value ?? '');
  if (!/^[1-9][0-9]{0,18}$/.test(v)) fail('USERS_BAD_ID', 'Use an exact positive identifier as text.');
  return v;
};
export function usersUrl(host, value, base = `https://${hostName(host)}/Users/`) {
  if (typeof value !== 'string' || /\\|[\u0000-\u0020]|%2e|%2f|%5c/i.test(value) || value.split(/[/?#]/).some(p => p === '..' || p === '.'))
    fail('USERS_ROUTE_REFUSED', 'Invalid Users route.');
  const url = urljoin(base, value), u = urlsplit(url);
  const m = /^\/Users\/([A-Za-z_]+)\.aspx$/.exec(u.path);
  if (u.scheme !== 'https' || u.netloc.toLowerCase() !== hostName(host) || u.username || u.fragment || (u.path !== '/Users/' && (!m || !pages.has(m[1]))))
    fail('USERS_ROUTE_REFUSED', 'Only mapped Users pages on the exact HTTPS host are allowed.');
  const q = new URLSearchParams(u.query);
  for (const [k,v] of q) if (!['UserId','GroupId','RoleId','ApplicationId'].includes(k) || identifier(v) !== v || q.getAll(k).length !== 1)
    fail('USERS_ROUTE_REFUSED', 'Unmapped or ambiguous Users parameter.');
  return url;
}
export class UsersTransport extends Transport {
  constructor(host, { secretSend, send, ...options } = {}) {
    // What the agent answered keeps its own code: the transport underneath only knows a connection that failed.
    const noting = fn => fn && (async request => { try { return await fn(request); } catch (error) { this.failure = error; throw error; } });
    super(host, { ...options, ...(send ? { send: noting(send) } : {}) });
    this.base = `https://${this.host}/Users/`; this.secretSend = noting(secretSend);
  }
  url(value, base) { return usersUrl(this.host, value, base ?? this.base); }
  // HTTP 404 of a Users page: the page, or the user, group or role its ID names, is not on this host; never a Service Center
  // protocol refusal (SC_PROTOCOL_INVALID). Any other status keeps the transport's refusal.
  statusRefusal(status, context) {
    if (status !== 404) return super.statusRefusal(status, context);
    const page = String(context?.path ?? '').split('/').at(-1) || 'the page';
    return new UsersError('USERS_PAGE_NOT_FOUND', `Users answered HTTP 404 for ${page}: the page, or the user, group or role its ID names, does not exist on ${this.host}. Repeating the same request answers the same.`);
  }
  async fetch(url, fields = null, accept = 'html', secrets = null, firstHop = null) {
    if (secrets?.length) {
      if (!this.secretSend) fail('USERS_SECRET_TRANSPORT_REQUIRED', 'A private vault transport is required.');
      const target = this.url(url);
      firstHop = () => this.secretSend({url:target,fields:fields.filter(([k])=>!secrets.some(r=>r.field===k)),secretRefs:secrets,cookie:this.jar.header(target)});
    }
    this.failure = null;
    try { return await super.fetch(url, fields, accept, null, firstHop); }
    catch (error) { if (this.failure?.code) throw this.failure; throw error; }
  }
}
const unique = (xs, what) => xs.length === 1 ? xs[0] : fail('USERS_LAYOUT_CHANGED', `Expected one ${what}; found ${xs.length}.`);
// What a page says is data: one line, without control or direction characters, so it cannot pass for something else.
const text = n => (n?.text ?? '').replace(/[\p{Cc}\p{Cf}]+/gu,' ').replace(/\s+/g,' ').trim();
const title = page => text(page.doc.all('h1')[0]) || text(page.doc.all('div').filter(n=>n.attr('id','').endsWith('wtTitle')&&/(?:^|\s)title(?:\s|$)/i.test(n.attr('class',''))).at(-1));
export const field = (page, suffix) => unique(controls(page.doc.first('form')).filter(n => n.attr('id','').endsWith(suffix)), suffix);
export const clickable = (page, label, scope = page.doc.root) => unique(scope.all('a','button','input').filter(n => text(n) === label || caption(n) === label), label);
export function checked(page, { login = false } = {}) {
  if (/\b(?:Permission denied|Access denied|You don.t have permission)\b/i.test(page.doc.root.text)) fail('USERS_PERMISSION_DENIED','This Users session lacks the required permissions.');
  const form = page.doc.first('form');
  if (!form) fail('USERS_LAYOUT_CHANGED','Users returned no WebForms form.');
  if (!login && /(?:^|\/)Login\.aspx(?:\?|$)/i.test(form.attr('action',''))) fail('USERS_LOGIN_REQUIRED','Sign in to Users in the private credential popup.');
  const errors = page.doc.all('span','div').filter(n => /(?:ValidationMessage|Feedback_Message_Error|ErrorMessage)/i.test(n.attr('class','')) && text(n));
  // What the page said names people: it goes in validation, the answer of this call, and never in the error text.
  if (errors.length) { const refused = new UsersError('USERS_VALIDATION_FAILED', 'Users refused the form; its own messages are in validation.'); refused.validation = [...new Set(errors.map(text))].map(m => m.slice(0,300)).slice(0,10); throw refused; }
  return page;
}
function listTable(page, suffix) { return unique(page.doc.all('table').filter(n=>n.attr('id','').endsWith(suffix)),suffix); }
export function userRows(page) {
  return listTable(page,'wtUserTable').all('tr').flatMap(tr=>{
    const cells=tr.children.filter(n=>n?.tag==='td'), a=tr.all('a').find(n=>/User_Show\.aspx\?UserId=/.test(n.attr('href','')));
    if(!a)return [];
    return [{id:identifier(new URLSearchParams(urlsplit(a.attr('href')).query).get('UserId')),name:text(a),username:text(cells[2]),email:text(cells[3])}];
  });
}
export function userDetail(page) {
  const id=identifier(new URLSearchParams(urlsplit(page.url).query).get('UserId'));
  const records=page.doc.all('table').filter(n=>n.attr('id','').endsWith('wtUserShow'));
  const details={};
  for(const tr of unique(records,'user details').all('tr')) { const td=tr.children.filter(n=>n?.tag==='td'); if(td.length===2)details[text(td[0])]=text(td[1]); }
  const status=page.doc.all('a').filter(n=>/wtEnableDisableLink$/.test(n.attr('id','')));
  if(status.length!==1 || !['Set as Inactive','Set as Active'].includes(text(status[0])))fail('USERS_LAYOUT_CHANGED','Unknown user status.');
  const roles=page.doc.all('table').filter(n=>n.attr('id','').includes('wtUserRoles')&&n.attr('id','').endsWith('wtRoleTable')).flatMap(t=>t.all('tr').flatMap(tr=>{
    const role=tr.all('a').find(a=>/Role_Show\.aspx\?RoleId=/.test(a.attr('href','')));if(!role)return [];
    const group=tr.all('a').find(a=>/Group_Show\.aspx\?GroupId=/.test(a.attr('href','')));
    return [{id:identifier(new URLSearchParams(urlsplit(role.attr('href')).query).get('RoleId')),name:text(role),inheritedFrom:group?{id:identifier(new URLSearchParams(urlsplit(group.attr('href')).query).get('GroupId')),name:text(group)}:null}];
  }));
  const groups=page.doc.all('table').filter(n=>n.attr('id','').endsWith('wtGroupTable')).flatMap(t=>t.all('tr').flatMap(tr=>{
    const a=tr.all('a').find(n=>/Group_Show\.aspx\?GroupId=/.test(n.attr('href','')));return a?[{id:identifier(new URLSearchParams(urlsplit(a.attr('href')).query).get('GroupId')),name:text(a)}]:[];
  }));
  return {id,name:title(page).replace(/\(Inactive\)/g,'').trim(),username:details.Username,email:details.Email,phone:details.Phone,isActive:text(status[0])==='Set as Inactive',roles,groups};
}
export class UsersClient {
  constructor(transport) { this.http=transport; }
  async get(route) { return checked(await this.http.request(this.http.url(route))); }
  async click(page, control, updates={}, secrets=[]) {
    const script=control.attr('onclick',''), event=postbackTarget(control);let post;
    if(/OsAjax/.test(script))post=this.http.ajaxPost(page,control,updates);
    else if(event?.kind==='postback'){
      const form=control.ancestor('form');
      const fields=formFields(form).filter(([k])=>!['__EVENTTARGET','__EVENTARGUMENT'].includes(k)&&!Object.hasOwn(updates,k));
      fields.push(...Object.entries(updates),['__EVENTTARGET',event.target],['__EVENTARGUMENT',event.argument]);post=[this.http.url(form.attr('action'),page.url),fields];
    }else post=this.http.formPost(page,control,updates);
    const [url,reply]=await this.http.reply(post[0],post[1],true,secrets);
    return this.interpret(page,url,reply,post[1]);
  }
  // What a page answered to a POST: a page, a redirect it writes (only to a mapped route), or an OsAjax reply over the page it came from.
  async interpret(page,url,reply,fields) {
    if(/^\s*(?:<!doctype|<html)/i.test(reply))return checked(new Page(url,new Document(reply)));
    const destinations=[...reply.matchAll(/"__RedirectToURL"\s*:\s*("(?:[^"\\]|\\.)*")/g)].map(m=>JSON.parse(m[1]));
    if(destinations.length>1)fail('USERS_LAYOUT_CHANGED','Ambiguous Users redirect.');
    if(destinations.length===1)return this.get(this.http.url(destinations[0],url));
    const redirects=[...reply.matchAll(/(?:window\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/g)];
    if(redirects.length===1)return this.get(this.http.url(redirects[0][1],url));
    return checked(ajaxPage(page,reply,fields));
  }
  async listUsers({search='',inactive=false}={}) {
    let p=await this.get(inactive?'Inactive_Users.aspx':'User_List.aspx');
    const f=field(p,'wtSearchInput');p=await this.click(p,clickable(p,'Search'),{[f.attr('name')]:search});
    const rows=userRows(p);return {users:rows,hasMore:/Go To Next Page/.test(p.doc.root.readable),complete:rows.length<50};
  }
  async user(id) { return userDetail(await this.get(`User_Show.aspx?UserId=${identifier(id)}`)); }
  async setActive(id,active) {
    let p=await this.get(`User_Show.aspx?UserId=${identifier(id)}`), before=userDetail(p);
    if(before.isActive===active)return {changed:false,user:before};
    await this.click(p,clickable(p,active?'Set as Active':'Set as Inactive'));
    const after=await this.user(id);if(after.isActive!==active)fail('USERS_NOT_CONFIRMED','The requested status was not confirmed.');
    return {changed:true,user:after};
  }
  async saveUser({id,name,username,email,phone},secrets=[]) {
    const p=await this.get(id?`User_Edit.aspx?UserId=${identifier(id)}`:'User_Edit.aspx');const updates={};
    for(const [k,suffix] of [['name','wtUser_Name'],['username','wtUser_Username'],['email','wtUser_Email'],['phone','wtUser_Phone']]){
      const value={name,username,email,phone}[k];if(value!==undefined)updates[field(p,suffix).attr('name')]=value;
    }
    const refs=secrets.length?['wtPasswordInput','wtConfirmPasswordInput'].map(s=>({...secrets[0],field:field(p,s).attr('name')})):[];
    const result=await this.click(p,clickable(p,'Save'),updates,refs);
    if(id)return this.user(id);
    if(/User_Show\.aspx\?UserId=/.test(result.url))return userDetail(result);
    const found=await this.listUsers({search:username});const exact=found.users.filter(u=>u.username.toLowerCase()===username.toLowerCase());
    if(exact.length!==1)fail('USERS_NOT_CONFIRMED','The created user was not uniquely confirmed.');
    return this.user(exact[0].id);
  }
  async setPassword(id,secret) {
    let p=await this.get(`User_Show.aspx?UserId=${identifier(id)}`);
    p=await this.click(p,clickable(p,'Set Password'));
    const refs=['wtNewPasswordInput','wtConfirmPasswordInput'].map(s=>({...secret,field:field(p,s).attr('name')}));
    const save=unique(p.doc.all('input').filter(n=>n.attr('type')==='submit'&&caption(n)==='Save'),'password Save');
    const result=await this.click(p,save,{},refs);
    // We never claim a password match by reading a hash or trying it automatically.
    return {accepted:true,passwordVerified:false,feedback:text(result.doc.root).slice(0,0)};
  }
  async membership(id,kind,targetId,add) {
    let p=await this.get(`User_Show.aspx?UserId=${identifier(id)}`);const before=userDetail(p), key=kind==='role'?'roles':'groups';targetId=identifier(targetId);
    const existing=before[key].find(x=>x.id===targetId);
    if(Boolean(existing)===add)return {changed:false,user:before};
    if(!add && kind==='role' && existing.inheritedFrom)fail('USERS_INHERITED_ROLE','Remove the group membership explicitly; this role is inherited.');
    if(add){
      const target=await this.get(`${kind==='role'?'Role':'Group'}_Show.aspx?${kind==='role'?'Role':'Group'}Id=${targetId}`);
      const heading=title(target);if(!heading)fail('USERS_LAYOUT_CHANGED','Target has no heading.');
      const input=field(p,kind==='role'?'wtNewRole':'wtNewGroupInput');
      const parent=input.parent;const scope=parent;const auto=unique(scope.all('input').filter(n=>n.attr('id','').endsWith('wttxtAutoCompleteValue')),'autocomplete value');
      const addButton=clickable(p,'Add',scope);
      await this.click(p,addButton,{[input.attr('name')]:heading,[auto.attr('name')]:targetId});
    }else{
      const suffix=kind==='role'?`Role_Show.aspx?RoleId=${targetId}`:`Group_Show.aspx?GroupId=${targetId}`;
      const table=listTable(p,kind==='role'?'wtRoleTable':'wtGroupTable');
      const row=unique(table.all('tr').filter(tr=>tr.all('a').some(a=>a.attr('href','').endsWith(suffix))),'membership row');
      const remove=unique(row.all('a').filter(a=>/OsAjax/.test(a.attr('onclick',''))),'remove membership');await this.click(p,remove);
    }
    const after=await this.user(id);if(after[key].some(x=>x.id===targetId)!==add)fail('USERS_NOT_CONFIRMED','Membership change was not confirmed.');return {changed:true,user:after};
  }
  async deleteUser(id) {
    const before=await this.user(id),p=await this.get(`User_Edit.aspx?UserId=${identifier(id)}`);
    await this.click(p,clickable(p,'Delete this User'));
    const found=await this.listUsers({search:before.username});const inactive=await this.listUsers({search:before.username,inactive:true});
    if([...found.users,...inactive.users].some(u=>u.id===id)||!found.complete||!inactive.complete)fail('USERS_NOT_CONFIRMED','Deletion could not be confirmed.');
    return {deleted:true,id,username:before.username};
  }
}

// Hosted: the POSTs are the agent's. This client reads pages with GET, and for a write it names the operation and its ids: the agent reads the
// real page, shows the person what it will send and sends that (kind o11.users, agent/lib/users-page.mjs). What a person never approved is
// not something this server can send. Deleting is not here: the agent has no such operation.
export class AgentUsersClient extends UsersClient {
  constructor(transport, agent) { super(transport); this.agent=agent; }
  async answered(value,route) {
    const body=fromBase64(value.body),location=fromBase64(value.location),url=this.http.url(route);
    if(value.status>=300&&value.status<400&&location)return this.get(this.http.url(location,url));
    if(/^\s*(?:<!doctype|<html)/i.test(body))return checked(new Page(url,new Document(body)));
    return this.interpret(await this.get(route),url,body,null);
  }
  async listUsers({search='',inactive=false}={}) {
    const route=inactive?'Inactive_Users.aspx':'User_List.aspx';
    const p=await this.answered(await this.agent.search({inactive,text:search}),route);
    const rows=userRows(p);return {users:rows,hasMore:/Go To Next Page/.test(p.doc.root.readable),complete:rows.length<50};
  }
  async setActive(id,active) {
    const before=await this.user(id);
    if(before.isActive===active)return {changed:false,user:before};
    const route=`User_Show.aspx?UserId=${identifier(id)}`;
    await this.answered(await this.agent.write({action:active?'activate':'deactivate',userId:identifier(id)}),route);
    const after=await this.user(id);if(after.isActive!==active)fail('USERS_NOT_CONFIRMED','The requested status was not confirmed.');
    return {changed:true,user:after};
  }
  async saveUser({id,name,username,email,phone},secrets=[]) {
    const changes=Object.fromEntries(Object.entries({name,username,email,phone}).filter(([,v])=>v!==undefined));
    const route=id?`User_Edit.aspx?UserId=${identifier(id)}`:'User_Edit.aspx';
    const value=await this.agent.write(id?{action:'update',userId:identifier(id),changes}:{action:'create',changes,entry:secrets[0].entry});
    const result=await this.answered(value,route);
    if(id)return this.user(id);
    if(/User_Show\.aspx\?UserId=/.test(result.url))return userDetail(result);
    const found=await this.listUsers({search:username});const exact=found.users.filter(u=>u.username.toLowerCase()===username.toLowerCase());
    if(exact.length!==1)fail('USERS_NOT_CONFIRMED','The created user was not uniquely confirmed.');
    return this.user(exact[0].id);
  }
  async setPassword(id,secret) {
    const route=`User_Show.aspx?UserId=${identifier(id)}`;
    const value=await this.agent.write({action:'set-password',userId:identifier(id),entry:secret.entry});
    await this.answered(value,route);
    // We never claim a password match by reading a hash or trying it automatically.
    return {accepted:true,passwordVerified:false};
  }
  async membership(id,kind,targetId,add) {
    if(!add)fail('USERS_OFF_HERE','This operation is not available through the agent.');
    const before=await this.user(id),key=kind==='role'?'roles':'groups';targetId=identifier(targetId);
    if(before[key].some(x=>x.id===targetId))return {changed:false,user:before};
    const route=`User_Show.aspx?UserId=${identifier(id)}`;
    await this.answered(await this.agent.write({action:kind==='role'?'grant-role':'add-group',userId:identifier(id),targetId}),route);
    const after=await this.user(id);if(!after[key].some(x=>x.id===targetId))fail('USERS_NOT_CONFIRMED','Membership change was not confirmed.');
    return {changed:true,user:after};
  }
  async deleteUser() { fail('USERS_OFF_HERE','This operation is not available through the agent.'); }
}
