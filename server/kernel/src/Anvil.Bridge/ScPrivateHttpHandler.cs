using System.Text.Json.Nodes;
using Ssam.PrivateTransport;

namespace Anvil.Bridge;

internal static class ScPrivateHttpHandler
{
    internal static async Task<string> Handle(JsonObject? parameters, bool cookieExchange = false)
    {
        try {
            if (parameters == null) throw new ScFailure(ScCodes.BadRequest, "Private HTTP parameters are required.");
            var scope = ScPrivateHttp.Parse(parameters);
            Task<string?> Principal() => ScApiHandler.StudioPrincipal(scope.Host);
            await ScPrivateHttp.CheckPrincipal(scope.Principal, Principal);
            using var timeout = new CancellationTokenSource(scope.Request.Timeout);
            using var exchange = cookieExchange ? await ScPrivateCookieExchange.Receive(scope.Pipe, scope.Hash,
                scope.Host, scope.Principal, scope.Request.Url, timeout.Token) : null;
            var context = exchange?.Context ?? await PrivateHttpContext.Receive(scope.Pipe, scope.Hash, scope.Host, scope.Principal, timeout.Token);
            using var handler = new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false };
            var result = await ScPrivateHttp.Execute(scope.Host, scope.Principal, scope.Request, context,
                new ScWindowsVault(), Principal, handler, timeout.Token, exchange == null ? null : exchange.Publish);
            return ScReply.Ok("private-http", scope.Host, scope.Principal, 0, result);
        } catch (ScFailure failure) { return ScReply.Fail(failure); }
        catch { return ScReply.Fail(new ScFailure(ScCodes.BadRequest, "Private HTTP context is unavailable; nothing was sent.")); }
    }
}
