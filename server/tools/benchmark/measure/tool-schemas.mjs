// Reads only transcript attachments and tool outputs, never the server's source files.
const ssam = n => /^mcp__ssam[a-z_-]*__/.test(n || '');
const short = n => (n || '').replace(/^mcp__ssam[a-z_-]*__/, '');
const contentText = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(x => x.text || contentText(x.content) || '').join('\n') : '';

export function measureToolSchemas(sources, {from,to} = {}) {
  const end = to != null ? (typeof to==='number'?to:Date.parse(to)) : Infinity, start = from != null ? (typeof from==='number'?from:Date.parse(from)) : -Infinity;
  const loaded = new Map(), used = new Set(), cuts = {n:0,originalTokens:0,byTool:{}};
  let shownChars = 0, truncated = false, codexSchemas = false;
  for (const source of sources) {
    const calls = new Map();
    for (const row of source.rows) {
      const t = Date.parse(row.timestamp); if (t > end) continue;
      const a = row.attachment;
      if (a?.type === 'deferred_tools_record') for (const e of Array.isArray(a.entries) ? a.entries : Object.values(a.entries || {})) if (ssam(e.name)) loaded.set(e.name,JSON.stringify(e).length);
      if (a?.type === 'mcp_instructions_delta') (a.addedNames || []).forEach((n,i) => {if (/ssam/.test(n)) {const block=a.addedBlocks?.[i] || ''; shownChars += block.length; truncated ||= /\[truncated\]/i.test(block);}});
      for (const x of Array.isArray(row.message?.content) ? row.message.content : []) if (x.type === 'tool_use' && ssam(x.name)) used.add(x.name);
      const p=row.payload || {};
      if (/^(custom_tool_call|function_call)$/.test(p.type)) {
        const code=p.input || p.arguments || '';
        const names=[...code.matchAll(/tools\.(mcp__ssam[a-z_-]*__[a-z0-9_]+)/g)].map(m=>m[1]);
        if (ssam(p.name)) names.push(p.name);
        for (const n of names) used.add(n);
        calls.set(p.call_id,{names,code});
      }
      if (/call_output$/.test(p.type)) {
        const c=calls.get(p.call_id) || {names:[],code:''};
        for (const part of Array.isArray(p.output) ? p.output : [{text:p.output}]) {
          const text=part.text || '', tool=c.names.length ? short(c.names[0]) : /ALL_TOOLS/.test(c.code) ? '(ALL_TOOLS)' : 'other';
          if (/ALL_TOOLS|exec tool declaration/.test(c.code+text)) codexSchemas=true;
          const match=text.match(/original token count:\s*(\d+)/i);
          if (match && t>=start) {cuts.n++; cuts.originalTokens+=+match[1]; cuts.byTool[tool]=(cuts.byTool[tool]||0)+1;}
          // ALL_TOOLS is commonly printed as a JSON array of metadata.
          if (/ALL_TOOLS/.test(c.code)) try {for (const e of JSON.parse(text)) if(ssam(e.name)) loaded.set(e.name,JSON.stringify(e).length);} catch {}
        }
      }
    }
  }
  const loadedChars=[...loaded.values()].reduce((a,b)=>a+b,0);
  const usedNames=[...loaded.keys()].filter(n=>used.has(n));
  return {schemas:{loaded:loaded.size,loadedChars,used:usedNames.length,usedChars:usedNames.reduce((n,k)=>n+loaded.get(k),0),method:'recorded',...(codexSchemas?{separation:'Server instructions and schemas share a group when transcript metadata does not identify separate blocks.'}: {})},serverInstructions:{shownChars,truncated,method:'recorded'},truncatedAnswers:cuts};
}
