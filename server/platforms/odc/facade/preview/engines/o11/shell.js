// The outer page selects qualified native entries; no app routing or guards are replaced.
(function(){
 let frame=null,shown=null,activeKey=null,localReport=null,state={};const status=document.getElementById('status'),details=document.getElementById('details'),nav=document.getElementById('entries');
 function paint(){
  // SSE's last report can belong to another browser. Only this iframe confirms this UI.
  const p=state.promoted,r=localReport,e=state.error||state.pipeline?.error,observed=r&&r.buildId===p?.buildId&&r.entryScreenKey===activeKey?r:null;
  const messages={rendered:'Tela carregada', 'rendered-with-warnings':'Tela carregada · há avisos de recursos/execução nos detalhes', 'render-error':'A tela não concluiu a abertura · erro nos detalhes', 'render-pending':'A tela ainda está aguardando o runtime · detalhes disponíveis'};
  status.textContent=e?'Falha ao preparar atualização · última tela preservada':observed?messages[observed.kind]:p?'Abrindo a tela…':'Preparando a tela…';details.textContent=JSON.stringify({...state,localFrameReport:localReport},null,2);
 }
 function label(selected,entries){
  activeKey=selected.screenKey;frame.title=selected.module+' · '+selected.screen;document.getElementById('entry-title').textContent=frame.title;document.title=frame.title+' · Preview local';
  nav.replaceChildren(...entries.map(e=>{const link=document.createElement('a');link.href='/?entry='+encodeURIComponent(e.screen.split('.').at(-1));link.textContent=e.screen.split('.').at(-1);if(e.screenKey===activeKey)link.setAttribute('aria-current','page');return link;}));
 }
 function update(next){
  state=next;const p=state.promoted;if(p){
   const requested=new URLSearchParams(location.search).get('entry');
   const entries=p.entries??[p.target],selected=requested?entries.find(e=>e.screenKey===requested||e.screen===requested||e.screen.split('.').at(-1)===requested):p.target;
   if(!selected){status.textContent='Esta entrada não faz parte das telas preparadas';return;}
   const identity=p.buildId+'|'+selected.screenKey;
   if(identity!==shown){shown=identity;localReport=null;frame=document.createElement('iframe');label(selected,entries);frame.src=p.entry+'?entry='+encodeURIComponent(selected.screenKey);document.getElementById('preview').replaceChildren(frame);
   }
  }paint();
 }
 window.addEventListener('message',async event=>{
  const m=event.data,p=state.promoted,entries=p?.entries??[],selected=entries.find(e=>e.screenKey===m?.entryScreenKey);
  if(event.origin!==location.origin||event.source!==frame?.contentWindow||m?.protocol!=='ssam-official-frame/2'||m.buildId!==p?.buildId||!selected||!['rendered','rendered-with-warnings','render-error','render-pending'].includes(m.kind))return;
  localReport=m;label(selected,entries);paint();
  try{await fetch('/render-report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m)});}catch{if(localReport===m)status.textContent='Falha ao registrar estado do navegador';}
 });
 const events=new EventSource('/events');events.addEventListener('state',event=>update(JSON.parse(event.data)));events.onerror=()=>{status.textContent='Conexão com o preview interrompida; a página atual permanece visível.';};
})();
