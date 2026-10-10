// Select only a fully emitted, qualified native entry and its reviewed URL.
(function(){
 const requested=new URLSearchParams(location.search).get('entry');
 const options=window.__nativeEntryOptions,config=window.__nativeScreenConfig;
 const selected=options.find(x=>x.target.screenKey===(requested??config.entryScreenKey));
 if(!selected)throw Error('Entry is outside the qualified native release');
 config.entry=selected.entry;config.entryScreenKey=selected.target.screenKey;config.entryLocation=selected.location;
 window.__officialHostTarget=selected.target;
})();
