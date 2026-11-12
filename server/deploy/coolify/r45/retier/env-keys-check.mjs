// node env-keys-check.mjs --check <env-check.sh> --added <env-added.json> --mode after|base   (run by retier-kit.mjs)
// Revision 2 of the retier: extends an env-check.sh made by ../gen-checks.mjs (unchanged, shared with the r45 kit) for the
// environment keys the retier ADDS to every backend (env-added.json of gen-retier-php.mjs). Rewrites the file in place.
// Why (COOLIFY.md 13, Coolify 4.4.6): on the first deploy of a compose that lists ${KEY:-default}, Coolify stores the
// default as a resource variable, and from then on the ROW is what the container gets; a row that already existed with
// another value wins over the compose default. So the compose text proves nothing about the running value:
//   --mode after (env-check.sh, after the retier's Redeploy): every backend container must carry KEY=default exactly
//     (the compose default; "missing" and "another value" are told apart, the value is never printed);
//   both modes: the rows Coolify creates for these keys on the Redeploy are expected, so the gen-checks "created on or
//     after SINCE" query leaves out exactly these names (any other new row still FAILs), and a second read-only query
//     lists which of them have a row (names only, information);
//   --mode base (env-check-base.sh, after a rollback to the r45 compose): only the two queries; the rows stay in Coolify
//     (harmless: the r45 compose does not list the keys).
// --tier <tier-keys.json> (revision 3, only for a kit with tier keys): every backend's SSAM_CODE_CHECKS and
// SSAM_CODE_CHECKS_PER_CUSTOMER in the container are the literal of the compose of the mode (the new one after the
// Redeploy, the base one after a rollback), or absent when that compose does not list them (a leftover value FAILs).
// With no added key and no --tier the file is left byte for byte as gen-checks wrote it.
import fs from 'node:fs';
const argv=process.argv.slice(2),opt=k=>{const i=argv.indexOf(k);return i>=0?argv[i+1]:undefined;};
const file=opt('--check'),addedFile=opt('--added'),mode=opt('--mode'),tierFile=opt('--tier');
if(!file||!addedFile||!['after','base'].includes(mode))throw new Error('--check <env-check.sh> --added <env-added.json> --mode after|base [--tier <tier-keys.json>]');
const added=JSON.parse(fs.readFileSync(addedFile,'utf8'));
const keys=Object.keys(added.keys).sort();
if(!keys.length&&!tierFile){console.log(JSON.stringify({mode,keys:0}));process.exit(0);}
const NAME=/^[A-Za-z_][A-Za-z0-9_]*$/,PLAIN=/^[A-Za-z0-9._,:\/-]*$/,SVC=/^ssam-server-v[1-9]$/;
for(const k of keys){if(!NAME.test(k)||!PLAIN.test(added.keys[k].default)||added.keys[k].value!==`\${${k}:-${added.keys[k].default}}`)throw new Error('env-added.json: bad key '+k);}
if(keys.length&&(!added.backends.length||!added.backends.every(b=>SVC.test(b))))throw new Error('env-added.json: bad backends');
const U='ksqommjgowjjilpgpbmf7cdo';
let sh=fs.readFileSync(file,'utf8');
const once=(needle,repl,what)=>{const n=sh.split(needle).length-1;if(n!==1)throw new Error(`${file}: ${what} found ${n} times, not once (gen-checks.mjs changed?)`);sh=sh.replace(needle,()=>repl);};
const inList=keys.map(k=>`'${k}'`).join(',');
const sinceLine=/^  and \(v\.key ~ '\^SSAM_\(HOT\|OTHER\|ROUTER\)_' or v\.created_at >= '\d{4}-\d{2}-\d{2}'\)\n/m;
const m=sh.match(sinceLine);if(!m)throw new Error(file+': the resource variable query of gen-checks.mjs is not there');
if(keys.length)once(m[0],m[0]+`  and v.key not in (${inList})\n`,'the resource variable query');
let block=!keys.length?'':`# --- retier revision 2: the ${keys.length} environment keys added to every backend (${keys.join(' ')})\n`;
if(mode==='after'&&keys.length){
 for(const b of added.backends){
  block+=`c=${b}-${U}
if ! docker inspect "$c" >/dev/null 2>&1; then echo "FAIL ${b}: no container (added keys)"; fail=$((fail+1)); else
envs="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c")"
`;
  for(const k of keys)block+=`if grep -qx '${k}=${added.keys[k].default}' <<<"$envs"; then echo "ok   ${b} ${k} arrived with the compose default"; elif grep -q '^${k}=' <<<"$envs"; then echo "FAIL ${b} ${k} arrived with another value (a Coolify resource variable overrides the default)"; fail=$((fail+1)); else echo "FAIL ${b} ${k} did not arrive"; fail=$((fail+1)); fi
`;
  block+=`fi
`;
 }
}
if(keys.length)block+=`rows="$(docker exec -i coolify-db psql -U coolify -d coolify -tA <<'SQL'
select v.key from environment_variables v join services s on s.id = v.resourceable_id
where v.resourceable_type like '%Service' and s.uuid = '${U}' and v.key in (${inList})
order by v.key;
SQL
)" || rows="(the SELECT failed)"
echo "info resource variables of the added keys (names only): $(echo $rows)"
`;
// tier keys (retier revision 3): tier-keys.json of gen-retier-php.mjs, the state each compose gives every backend.
if(tierFile){
 const T=JSON.parse(fs.readFileSync(tierFile,'utf8'))[mode],TK=/^(SSAM_CODE_CHECKS|SSAM_CODE_CHECKS_PER_CUSTOMER)$/,VAL=/^([1-9]|1[0-6])$/;
 if(!T||!Object.keys(T).length||!Object.keys(T).every(b=>SVC.test(b)))throw new Error('tier-keys.json: bad backends');
 let t=`# --- retier revision 3: the tier keys of every backend (${mode==='after'?'the new compose':'the base compose'}): the literal of its tier, or absent\n`;
 for(const [b,ks] of Object.entries(T)){
  t+=`c=${b}-${U}
if ! docker inspect "$c" >/dev/null 2>&1; then echo "FAIL ${b}: no container (tier keys)"; fail=$((fail+1)); else
envs="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c")"
`;
  for(const [k,v] of Object.entries(ks)){
   if(!TK.test(k)||(v!==null&&!VAL.test(v)))throw new Error('tier-keys.json: bad key '+k);
   t+=v===null
    ?`if grep -q '^${k}=' <<<"$envs"; then echo "FAIL ${b} ${k} is set but the compose does not list it (a Coolify resource variable?)"; fail=$((fail+1)); else echo "ok   ${b} ${k} absent, as the compose"; fi\n`
    :`if grep -qx '${k}=${v}' <<<"$envs"; then echo "ok   ${b} ${k}=${v} (tier)"; else echo "FAIL ${b} ${k} is not ${v}"; fail=$((fail+1)); fi\n`;
  }
  t+=`fi\n`;
 }
 block+=t;
}
once('[ "$fail" = 0 ] && echo "ENVCHECK OK" || echo "ENVCHECK FAIL $fail"\n',block+'[ "$fail" = 0 ] && echo "ENVCHECK OK" || echo "ENVCHECK FAIL $fail"\n','the last line');
fs.writeFileSync(file,sh);
console.log(JSON.stringify({mode,keys:keys.length,...(tierFile?{tier:true}:{}),backends:mode==='after'?added.backends.length:0}));
