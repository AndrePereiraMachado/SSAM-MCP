// Structural evidence at the native transport boundary, before SDK conversion.
// Never copies scalar values. This distinguishes absent wire fields from defaults
// created by the original runtime without reconstructing either value.
export function nativeOutputShape(value, privateValues = []) {
  let nodes = 0;
  const seen = new WeakSet();
  function visit(item, depth) {
    if (++nodes > 200 || depth > 8) return { omitted: true, reason: 'shape-budget' };
    if (item === null) return { type: 'null' };
    if (typeof item !== 'object') return { type: typeof item };
    if (seen.has(item)) return { omitted: true, reason: 'repeated-object' };
    seen.add(item);
    if (Array.isArray(item)) return { type: 'array', length: item.length,
      items: item.slice(0,20).map(v=>visit(v,depth+1)), omittedItems: Math.max(0,item.length-20) };
    const entries=Object.entries(item), fields={};let omittedFields=0;
    for(const [name,child] of entries){
      if(Object.keys(fields).length>=50 || !/^[A-Za-z_][A-Za-z0-9_]{0,119}$/.test(name) ||
          privateValues.some(v=>typeof v==='string' && v.length && name.includes(v))){omittedFields++;continue;}
      Object.defineProperty(fields,name,{value:visit(child,depth+1),enumerable:true});
    }
    return {type:'object',fields,omittedFields};
  }
  return visit(value,0);
}
