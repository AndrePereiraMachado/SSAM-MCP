window.__o11Proof={errors:[],console:[],cspViolations:[]};
window.addEventListener('error',event=>window.__o11Proof.errors.push({message:event.message||'Resource load failed',filename:event.filename||event.target?.src||event.target?.href||null,stack:event.error?.stack||null}),true);
window.addEventListener('unhandledrejection',event=>window.__o11Proof.errors.push({message:String(event.reason?.message??event.reason),stack:event.reason?.stack??null}));
window.addEventListener('securitypolicyviolation',event=>window.__o11Proof.cspViolations.push({directive:event.effectiveDirective,blockedURI:event.blockedURI,sourceFile:event.sourceFile}));
const originalConsoleError=console.error;
console.error=function(...args){window.__o11Proof.console.push({level:'error',message:args.map(x=>String(x?.message??x)).join(' ')});return originalConsoleError.apply(console,args);};
