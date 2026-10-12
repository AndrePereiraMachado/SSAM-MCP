// Runs in the owned browser. Preserve the native factory in the DI container:
// removing it makes runPostInitialization register a fresh factory/transports.
// Use only native transport removal and tracer controls, never replacement
// callbacks or fabricated spans. Application settings remain unchanged.
export async function isolateOdcBrowserInstrumentation(factory){
 const fail=()=>{throw new Error('debug_odc_browser_instrumentation_native_api_unavailable');};
 if(!factory||typeof factory.getLogger!=='function'||typeof factory.getTracer!=='function'||typeof factory.setTracerStatus!=='function')fail();
 const logger=await factory.getLogger(),tracer=factory.getTracer();
 if(typeof logger?.removeTransport!=='function'||typeof tracer?.removeTransport!=='function')fail();
 factory.setTracerStatus(false);
 const logTransports=['otel-logger-transport','native-logger-transport','console-transport'];
 const traceTransports=['otel-tracer-transport','sw-tracer-transport'];
 for(const name of logTransports)logger.removeTransport(name);
 for(const name of traceTransports)tracer.removeTransport(name);
 return {nativeFactoryRetained:true,nativeTracerDisabled:true,removedLogTransports:logTransports,removedTraceTransports:traceTransports,
  applicationSettingsChanged:false,debuggerReplaced:false};
}
