import net from 'node:net';

export function request(pipe, command, {connectTimeoutMs=3000, replyTimeoutMs=5000, maxBytes=4*1024*1024,connect=address=>net.createConnection(address)}={}) {
  if(command.includes('\n')||command.includes('\r'))throw new Error('Single-line command required');
  return new Promise((resolve,reject)=>{
    let socket,data='',finished=false,phase='connect',writeAttempted=false,timer;
    const metadata=()=>({command,phase,writeAttempted});
    const finish=(error,result)=>{
      if(finished)return;finished=true;clearTimeout(timer);socket?.destroy();
      if(error){Object.assign(error,metadata(),{retryable:!writeAttempted});reject(error);}
      else resolve({...result,transport:metadata()});
    };
    try{socket=connect(pipe);}catch(e){finish(e);return;}
    timer=setTimeout(()=>finish(Object.assign(new Error('Pipe connection timed out before send'),{code:'PIPE_CONNECT'})),connectTimeoutMs);
    socket.once('connect',()=>{
      // A connection completing after timeout must never dispatch the command.
      if(finished)return;
      clearTimeout(timer);phase='write';writeAttempted=true;
      try{socket.write(command+'\n');}catch(e){finish(e);return;}
      if(finished)return;phase='reply';
      if(replyTimeoutMs>0)timer=setTimeout(()=>finish(Object.assign(new Error('Pipe reply timed out; no command replay'),{code:'PIPE_REPLY'})),replyTimeoutMs);
    });
    socket.on('data',bytes=>{
      if(finished)return;data+=bytes.toString('utf8');
      if(Buffer.byteLength(data)>maxBytes)return finish(Object.assign(new Error('Pipe response exceeds size limit'),{code:'PIPE_SIZE'}));
      const end=data.indexOf('\n');if(end>=0){phase='decode';try{const result=JSON.parse(data.slice(0,end));if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('Expected object response');phase='response';finish(null,result);}catch(e){e.code??='PIPE_DECODE';finish(e);}}
    });
    socket.once('error',e=>finish(e));
    socket.once('end',()=>finish(Object.assign(new Error('Pipe closed without a complete response'),{code:'PIPE_CLOSED'})));
    socket.once('close',()=>finish(Object.assign(new Error('Pipe closed without a complete response'),{code:'PIPE_CLOSED'})));
  });
}

export function serialRequests(pipe, options, requestImpl=request) {
  let tail=Promise.resolve();
  return command=>{const next=tail.then(()=>requestImpl(pipe,command,options));tail=next.catch(()=>{});return next;};
}

export function signalClient(pid,{requestImpl=request,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  const pipe=`\\\\.\\pipe\\SSAM-QuotesPreviewSignal-v1-${pid}`,transient=new Set(['ENOENT','EBUSY','ECONNRESET']);let tail=Promise.resolve();
  return command=>{
    if(command!=='signal')throw new Error('Read-only signal command only');
    const next=tail.then(async()=>{
      for(let attempt=0;attempt<3;attempt++){
        try{return await requestImpl(pipe,command);}
        catch(error){if(attempt===2||!transient.has(error.code))throw error;await delay(attempt===0?50:100);}
      }
    });
    tail=next.catch(()=>{});return next;
  };
}
export function bridgeClient(pid,{requestImpl=request}={}){
  // A native call may already be executing after a transport timeout. Wait for its reply;
  // the bridge owns its native timeout and reports uncertainty for reconciliation.
  const invoke=serialRequests(`\\\\.\\pipe\\ODC3-Bridge-v36-${pid}`,{connectTimeoutMs:1000,replyTimeoutMs:0},requestImpl);
  return command=>{if(!['status','snapshot Quotes'].includes(command))throw new Error('Read-only Quotes commands only');return invoke(command);};
}
