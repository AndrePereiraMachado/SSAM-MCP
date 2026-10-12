// Serialized into the private browser. Native ESM performs evaluation; this
// only tracks its promises/namespaces and validates the declared static graph.
export function createOdcBrowserModuleLoader(imports, importModule) {
 const fail=code=>{throw new Error('debug_odc_browser_module_'+code);};
 const filePattern=/^_os(?:chunk-[A-Za-z0-9]+|bundle-[A-Za-z0-9_.]+__[A-Za-z0-9_+]+)\.js$/;
 if(!imports||typeof imports!=='object'||typeof importModule!=='function')fail('contract_invalid');
 const graph=new Map(Object.entries(imports).map(([file,edges])=>[file,Array.isArray(edges)?[...edges]:null]));
 const namespaces=new Map(),promises=new Map();let disposed=false;
 function closure(root){
  const seen=new Set(),queue=[root];
  for(let i=0;i<queue.length;i++){
   const file=queue[i];if(seen.has(file))continue;
   if(!filePattern.test(file)||!graph.has(file)||!Array.isArray(graph.get(file)))fail('graph_unbound');
   seen.add(file);
   for(const specifier of graph.get(file)){
    if(typeof specifier!=='string'||!specifier.startsWith('./')||!filePattern.test(specifier.slice(2)))fail('graph_unbound');
    queue.push(specifier.slice(2));
   }
  }
  return [...seen];
 }
 function once(file){
  if(!promises.has(file))promises.set(file,Promise.resolve().then(()=>{
   if(disposed)fail('disposed');return importModule(file);
  }).then(namespace=>{
   if(disposed)fail('disposed');
   if(!namespace||typeof namespace!=='object')fail('namespace_invalid');
   namespaces.set(file,namespace);return namespace;
  }));
  // Rejected promises stay cached. A failed import never becomes undefined
  // and no request is resubmitted to recover an uncertain initialization.
  return promises.get(file);
 }
 return {
  async load(file){
   if(disposed)fail('disposed');
   const files=closure(file); // Validate the entire graph before native import.
   const namespace=await once(file);
   // Native ESM has already evaluated these dependencies, including cycles.
   // Obtain their namespaces through the same native module cache.
   for(const dependency of files.slice(1))await once(dependency);
   return namespace;
  },
  loadedModule:file=>namespaces.get(file),
  values:()=>[...namespaces.values()],
  dispose(){disposed=true;namespaces.clear();},
 };
}
