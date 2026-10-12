using System.Net;
using System.IO.Pipes;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Bridge;
using Ssam.PrivateTransport;
using Xunit;

namespace Anvil.Tests;

public sealed class ServiceCenterPrivateHttpTests
{
    private const string Host = "lab.example";
    private const string Principal = "fixture@example.test";
    private const string Initial = "initial-synthetic-session-credential";
    private const string Rotated = "rotated-synthetic-session-credential";
    private sealed class Vault : IScVault { public ScVaultEntry? Read(string target) => throw new Exception("No vault read expected"); }
    private sealed class Handler(string body, bool updated, string contentType = "text/html") : HttpMessageHandler
    {
        internal int Sends;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Sends++;
            Assert.Equal("https://lab.example/ServiceCenter/Extension_Edit.aspx?ExtensionId=1", request.RequestUri!.ToString());
            Assert.Equal("session=" + Initial, request.Headers.GetValues("Cookie").Single());
            var answer = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, contentType) };
            if (updated) answer.Headers.TryAddWithoutValidation("Set-Cookie", "session=" + Rotated + "; Path=/ServiceCenter/; Secure; HttpOnly");
            return Task.FromResult(answer);
        }
    }
    private static ScWebRequest Request(string accept = "html") => ScWebRequest.Parse(new JsonObject {
        ["host"] = Host, ["method"] = "GET", ["path"] = "/ServiceCenter/Extension_Edit.aspx?ExtensionId=1", ["accept"] = accept }, Host);
    private static Task<JsonObject> Execute(Handler handler, string accept = "html", Func<Task<string?>>? principal = null) =>
        ScPrivateHttp.Execute(Host, Principal, Request(accept), new PrivateHttpContext("session=" + Initial, ""), new Vault(),
            principal ?? (() => Task.FromResult<string?>(Principal)), handler, CancellationToken.None);

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ResponseObservesRotationWithoutReturningCookie(bool updated)
    {
        var handler = new Handler("<html>" + Initial + (updated ? Rotated : "") + "</html>", updated);
        var answer = await Execute(handler);
        Assert.Equal(1, handler.Sends);
        Assert.Equal(updated, answer["sessionCookieUpdatesObserved"]!.GetValue<bool>());
        Assert.False(answer["sessionCookieUpdatesApplied"]!.GetValue<bool>());
        Assert.DoesNotContain(Initial, answer.ToJsonString());
        Assert.DoesNotContain(Rotated, answer.ToJsonString());
        Assert.DoesNotContain("Set-Cookie", answer.ToJsonString());
    }
    [Fact]
    public async Task AChangedIdentityPreventsEverySend()
    {
        var handler = new Handler("<html>OK</html>", false);
        var error = await Assert.ThrowsAsync<ScFailure>(() => Execute(handler, principal: () => Task.FromResult<string?>("other@example.test")));
        Assert.Equal(ScCodes.StudioNotSignedIn, error.Code);
        Assert.False(error.Sent); Assert.Equal(0, handler.Sends);
    }
    [Fact]
    public async Task BinaryEchoOfNewSessionIsDroppedWithoutRetry()
    {
        var handler = new Handler(Rotated, true, "application/octet-stream");
        var error = await Assert.ThrowsAsync<ScFailure>(() => Execute(handler, "binary"));
        Assert.Equal(ScCodes.RemoteError, error.Code); Assert.Equal(1, handler.Sends);
        Assert.DoesNotContain(Rotated, error.Message);
    }

    [Fact]
    public async Task HtmlAnswerToAFileRequestComesBackAsMaskedHtmlLikeTheStudioScript()
    {
        // AjaxStepsGetInfo and solution downloads are read as binary; an expired
        // operation answers an authenticated error page that echoes the session.
        var handler = new Handler("<html><h1>Unexpected error</h1>" + Initial + Rotated + "</html>", true);
        var answer = await Execute(handler, "binary");
        Assert.Equal(1, handler.Sends);
        Assert.Null(answer["bodyBase64"]);
        Assert.Contains("Unexpected error", answer["html"]!.ToString());
        Assert.DoesNotContain(Initial, answer.ToJsonString());
        Assert.DoesNotContain(Rotated, answer.ToJsonString());
    }

    [Fact]
    public async Task CookieUpdateAcknowledgementIsRequiredBeforeSuccess()
    {
        var handler = new Handler("<html>OK</html>", true);
        var updates = 0;
        var answer = await ScPrivateHttp.Execute(Host, Principal, Request(), new PrivateHttpContext("session="+Initial,""),new Vault(),
            () => Task.FromResult<string?>(Principal), handler, CancellationToken.None, (cookies,ct) => {
                updates++; Assert.Contains(Rotated,cookies.Single()); return Task.CompletedTask;
            });
        Assert.Equal(1,updates);Assert.Equal(1,handler.Sends);
        Assert.True(answer["sessionCookieUpdatesApplied"]!.GetValue<bool>());
        Assert.DoesNotContain(Rotated,answer.ToJsonString());
        var failed = new Handler("<html>OK</html>", true);
        var error = await Assert.ThrowsAsync<ScFailure>(() => ScPrivateHttp.Execute(Host,Principal,Request(),new PrivateHttpContext("session="+Initial,""),new Vault(),
            () => Task.FromResult<string?>(Principal),failed,CancellationToken.None,(_,_)=>throw new Exception(Rotated)));
        Assert.Equal(ScCodes.RemoteError,error.Code);Assert.True(error.Sent);Assert.Equal(1,failed.Sends);
        Assert.DoesNotContain(Rotated,error.Message);
    }

    [Fact]
    public async Task CurrentUserDuplexPipeTransfersOneBoundUpdateAndRequiresAck()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var id=Guid.NewGuid().ToString("D");var hash=new string('a',64);var url=Request().Url;
        var receive=ScPrivateCookieExchange.Receive(id,hash,Host,Principal,url,timeout.Token);
        using var client=new NamedPipeClientStream(".",ScPrivateCookieExchange.Name(id),PipeDirection.InOut,PipeOptions.Asynchronous);
        await client.ConnectAsync(timeout.Token);
        var now=DateTimeOffset.UtcNow;
        var context=System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new {
            schema="ssam-private-http-context/1",requestSha256=hash,host=Host,principal=Principal,
            issuedAt=now.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"),expiresAt=now.AddSeconds(30).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"),cookie="session="+Initial,csrf=""});
        var prefix=BitConverter.GetBytes(context.Length);await client.WriteAsync(prefix,timeout.Token);await client.WriteAsync(context,timeout.Token);
        using var exchange=await receive;
        Assert.DoesNotContain(Initial,exchange.ToString());
        var publish=exchange.Publish(["session="+Rotated+"; Path=/ServiceCenter/"],timeout.Token);
        await client.ReadExactlyAsync(prefix,timeout.Token);var bytes=new byte[BitConverter.ToInt32(prefix)];await client.ReadExactlyAsync(bytes,timeout.Token);
        var answer=JsonNode.Parse(bytes)!;
        Assert.Equal(hash,answer["requestSha256"]!.ToString());Assert.Equal(url,answer["url"]!.ToString());Assert.Equal(Host,answer["host"]!.ToString());
        Assert.Contains(Rotated,answer["cookies"]![0]!.ToString());Assert.False(publish.IsCompleted);
        await client.WriteAsync(new byte[]{1},timeout.Token);await publish;
    }
}
