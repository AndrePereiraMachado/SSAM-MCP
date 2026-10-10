// Prepared releases without an explicit context never execute a screen.
if(window.__nativeScreenConfig?.canStart===true){
 window.startNativeO11Screen(window.__nativeScreenConfig).catch(error=>{window.__candidateEntryFailure={message:error.message,stack:error.stack};});
}
