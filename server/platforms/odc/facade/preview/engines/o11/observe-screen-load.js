// Temporary transparent observation, to be evaluated in the already authorized local frame.
// Does not initiate navigation or execution; the caller may request a normal Root refresh.
(function(){
 const ScreenLoader=require('OutSystems/ReactView/ScreenLoader').default;
 if(ScreenLoader.prototype.load.__localObserved)return;
 const original=ScreenLoader.prototype.load;
 function record(error){window.__screenLoaderFailure={message:String(error?.message??error),stack:error?.stack??null};}
 function observed(...args){
  window.__screenLoaderAttempt={location:args[0],action:args[1]};
  try{const result=original.apply(this,args);if(result&&typeof result.catch==='function')return result.catch(error=>{record(error);throw error;});window.__screenLoaderReturnedNull=result===null;return result;}catch(error){record(error);throw error;}
 }
 observed.__localObserved=true;ScreenLoader.prototype.load=observed;
})();
