// Native Communication checks this endpoint when its business timeout elapses.
// Only a token emitted by an in-flight original app request can authorize it.
export function isO11NativeSuspensionCheck(method, url, target, activeTokens) {
  return method === 'GET' && url.origin === new URL(target.runtimeUrl).origin &&
    url.pathname === '/' + target.module + '/moduleservices/checkrequestsuspended' &&
    !url.username && !url.password && !url.hash &&
    /^\?requestToken=\d{1,16}$/.test(url.search) && activeTokens.has(url.searchParams.get('requestToken'));
}
