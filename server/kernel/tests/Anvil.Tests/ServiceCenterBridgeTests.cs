using System.Net;
using System.Reflection;
using System.Text.Json.Nodes;
using Anvil.Bridge;
using Anvil.Core;
using OutSystems.Communication.Identity.Login;
using OutSystems.Communication.Rest;
using OutSystems.Communication.ServiceCenter;
using ServiceStudio.ServerCommunications.ServiceCenter;
using Xunit;

namespace Anvil.Tests;

/// <summary>sc_api / sc_web of the bridge (ScProtocol.cs, ScOperations.cs) against fakes of the Studio interfaces:
/// allowlist, write guard, a single send, UNCERTAIN after the send, host match, redaction and the sc_web path allowlist.
/// Nothing here reaches a Studio or a server.</summary>
public sealed class ServiceCenterBridgeTests
{
    private const string Host = "lab.example";
    private const string Secret = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.c2lnbmF0dXJlLW9mLXRlc3Q";
    private static readonly string Words = new('a', 64);

    public ServiceCenterBridgeTests() => StudioAssemblies.Bind();

    [Fact]
    public void PlatformSettingsIsAFixedAuthenticatedGetWithoutRetry()
    {
        var (rest, fake) = Fake<IRestService>();
        fake.Handler = (_, _) => new HttpResponseMessage(HttpStatusCode.OK)
            { Content = new StringContent("{\"Setting\":\"Value\",\"Token\":\"" + Secret + "\"}") };
        var studio = new ScBound { Host = Host, User = "test-user", Secret = () => Secret, RestService = rest };
        var result = ScApi.Execute(ScApi.Prepare(Request("sc-rest", "platform-settings", new JsonObject()), Host), studio);
        Assert.Equal(new[] { "Get" }, fake.Calls);
        var parameters = Assert.IsType<HttpRequestParameters>(fake.Arguments.Single()[0]);
        Assert.Equal("https://" + Host + "/ServiceCenter/rest/PlatformServices/PlatformSettings", parameters.Uri.AbsoluteUri);
        Assert.False(parameters.RetryOnCommunicationError);
        Assert.False(parameters.HandleCommunicationError);
        Assert.StartsWith("Basic ", parameters.RequestHeaders["Authorization"]);
        Assert.DoesNotContain(Secret, result.ToJsonString());
        Assert.Equal("Value", result["result"]!["body"]!["Setting"]!.GetValue<string>());
    }

    // ---- allowlist ---------------------------------------------------------------------------

    [Theory]
    [InlineData("SetupAdminUser")]
    [InlineData("TestAction")]
    [InlineData("TestQuery")]
    [InlineData("UploadProductLicense")]
    [InlineData("DeleteProductLicense")]
    [InlineData("SynchronizeApps")]
    [InlineData("PushProducerToConsumer")]
    [InlineData("ImportTable")]
    [InlineData("RegisterOperation")]
    [InlineData("Metrics_Synchronized")]
    [InlineData("Metrics_AnythingElse")]
    public void DangerousSoapOperationsAreClosedEvenWithTheWriteFields(string operation)
    {
        var request = Write(Request("soap", operation, new JsonObject()));
        var refusal = Assert.Throws<ScFailure>(() => ScApi.Prepare(request, Host));
        Assert.Equal(ScCodes.NotAllowed, refusal.Code);
        Assert.False(refusal.Sent);
        Assert.Contains("closed", refusal.Message);
        Assert.False(ScApi.SoapOperations.ContainsKey(operation));
    }

    [Fact]
    public void OperationsOutsideTheListsAreRefusedAndTheListsMatchTheStudioInterfaces()
    {
        Assert.Equal(ScCodes.NotAllowed, Assert.Throws<ScFailure>(() => ScApi.Prepare(Request("soap", "Upload", new JsonObject()), Host)).Code);
        Assert.Equal(ScCodes.NotAllowed, Assert.Throws<ScFailure>(() => ScApi.Prepare(Request("server-api", "InsertRecords", new JsonObject()), Host)).Code);
        Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScApi.Prepare(Request("ldap", "ListEspaces", new JsonObject()), Host)).Code);
        var soap = typeof(IServiceCenter).GetMethods().Select(m => m.Name).ToHashSet();
        Assert.All(ScApi.SoapOperations.Keys, name => Assert.Contains(name, soap));
        Assert.All(ScApi.Closed, name => Assert.Contains(name, soap));
        var serverApi = typeof(IServerAPI).GetMethods().Select(m => m.Name).ToHashSet();
        Assert.All(ScApi.ServerApiOperations.Keys, name => Assert.Contains(name, serverApi));
        // Edit Data stays on environment_session (data-read/data-write), with its (System)/Users refusal.
        Assert.DoesNotContain(ScApi.ServerApiOperations.Keys, k => k.Contains("Records", StringComparison.Ordinal));
        var catalog = ScApi.Catalog();
        Assert.Contains("Metrics_*", catalog["closed"]!.AsArray().Select(x => x!.ToString()));
        Assert.Contains("apply-settings", catalog["sc-rest"]!.AsArray().Select(x => x!.ToString()));
    }

    // ---- write guard ---------------------------------------------------------------------------

    [Fact]
    public void WritesNeedTheFacadeAuthorizationFields()
    {
        var args = new JsonObject { ["moduleKey"] = Key(), ["moduleKind"] = "eSpace" };
        Assert.Equal(ScCodes.NotAllowed, Assert.Throws<ScFailure>(() => ScApi.Prepare(Request("soap", "DeleteModule", args), Host)).Code);
        var noId = Request("soap", "DeleteModule", args); noId["write"] = true; noId["authorizeSha256"] = Words;
        Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScApi.Prepare(noId, Host)).Code);
        var badHash = Write(Request("soap", "DeleteModule", args)); badHash["authorizeSha256"] = "the words themselves";
        Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScApi.Prepare(badHash, Host)).Code);
        var named = Write(Request("soap", "DeleteModule", args)); named["target"] = args["moduleKey"]!.ToString();
        var prepared = ScApi.Prepare(named, Host);
        Assert.True(prepared.Write);
        Assert.True(prepared.Destructive);
        Assert.NotNull(prepared.OperationId);
    }

    [Fact]
    public void ADestructiveWriteWithoutTargetIsNotAllowed()
    {
        var module = Write(Request("soap", "DeleteModule", new JsonObject { ["moduleKey"] = Key(), ["moduleKind"] = "Extension" }));
        var refusal = Assert.Throws<ScFailure>(() => ScApi.Prepare(module, Host));
        Assert.Equal(ScCodes.NotAllowed, refusal.Code);
        Assert.False(refusal.Sent);
        Assert.Contains("target", refusal.Message);
        var application = Write(Request("soap", "DeleteApplication", new JsonObject { ["appKey"] = Key(), ["simulate"] = false }));
        Assert.Equal(ScCodes.NotAllowed, Assert.Throws<ScFailure>(() => ScApi.Prepare(application, Host)).Code);
        // A non-destructive write is not affected, and the simulation of DeleteApplication stays a read.
        Assert.True(ScApi.Prepare(Write(Request("soap", "ChangeCommitMessage", new JsonObject { ["eSpaceVersionId"] = 3, ["newCommitMessage"] = "fictional" })), Host).Write);
        Assert.False(ScApi.Prepare(Request("soap", "DeleteApplication", new JsonObject { ["appKey"] = Key() }), Host).Write);
    }

    [Fact]
    public void DeleteApplicationSimulatesUnlessToldOtherwiseAndThenNeedsWordsNamingItsTarget()
    {
        var key = Key();
        var simulation = ScApi.Prepare(Request("soap", "DeleteApplication", new JsonObject { ["appKey"] = key }), Host);
        Assert.False(simulation.Write);
        var delete = new JsonObject { ["appKey"] = key, ["simulate"] = false };
        Assert.Equal(ScCodes.NotAllowed, Assert.Throws<ScFailure>(() => ScApi.Prepare(Request("soap", "DeleteApplication", delete), Host)).Code);
        var wrongTarget = Write(Request("soap", "DeleteApplication", delete.DeepClone().AsObject())); wrongTarget["target"] = Key();
        Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScApi.Prepare(wrongTarget, Host)).Code);
        var named = Write(Request("soap", "DeleteApplication", delete.DeepClone().AsObject())); named["target"] = key;
        var prepared = ScApi.Prepare(named, Host);
        Assert.True(prepared.Write && prepared.Destructive);
    }

    [Fact]
    public void CorporateEnvironmentWritesNeedAnExplicitInstructionEachTime()
    {
        // No host name is compiled in: the corporate hosts are corporateHosts of %USERPROFILE%\.ssam-hybrid\config.json,
        // here a temporary profile (this assembly runs its tests one at a time).
        const string corporate = "dev.corp.example";
        var profile = Path.Combine(Path.GetTempPath(), "anvil-sc-profile-" + Guid.NewGuid().ToString("N"));
        var config = Path.Combine(profile, ".ssam-hybrid", "config.json");
        var previous = Environment.GetEnvironmentVariable("USERPROFILE");
        try
        {
            Environment.SetEnvironmentVariable("USERPROFILE", profile);
            Assert.Equal(config, ScGuard.ConfigFile);
            var args = new JsonObject { ["eSpaceVersionId"] = 3, ["newCommitMessage"] = "fictional" };
            // Without config.json the full bridge counts no host as corporate (the facade's host policy still guards).
            Assert.False(BridgeKit.CorporateWhenUnconfigured);
            Assert.True(ScApi.Prepare(Write(Request("soap", "ChangeCommitMessage", args.DeepClone().AsObject())), corporate).Write);

            Directory.CreateDirectory(Path.GetDirectoryName(config)!);
            File.WriteAllText(config, "{\"corporateHosts\": [\" Corp.Example. \", \"other.example\"]}");
            Assert.Equal(new[] { "Corp.Example", "other.example" }, ScGuard.CorporateHosts(config));
            var refusal = Assert.Throws<ScFailure>(() => ScApi.Prepare(Write(Request("soap", "ChangeCommitMessage", args.DeepClone().AsObject())), corporate));
            Assert.Equal(ScCodes.NotAllowed, refusal.Code);
            Assert.Contains("corporateInstruction:true", refusal.Message);
            var instructed = Write(Request("soap", "ChangeCommitMessage", args.DeepClone().AsObject())); instructed["corporateInstruction"] = true;
            Assert.True(ScApi.Prepare(instructed, corporate).Write);
            Assert.False(ScApi.Prepare(Request("soap", "ListEspaces", new JsonObject()), corporate).Write);
            // A name covers itself and its subdomains, never a longer name that only ends the same way.
            Assert.True(ScGuard.Corporate("corp.example", config));
            Assert.False(ScGuard.Corporate("notcorp.example", config));
            Assert.False(ScGuard.Corporate(Host, config));

            // A field that is not a list of names, or a file that is not JSON, refuses the write.
            File.WriteAllText(config, "{\"corporateHosts\": \"corp.example\"}");
            Assert.Equal(ScCodes.NotAllowed, Assert.Throws<ScFailure>(() => ScApi.Prepare(Write(Request("soap", "ChangeCommitMessage", args.DeepClone().AsObject())), Host)).Code);
            File.WriteAllText(config, "{ not json");
            Assert.Equal(ScCodes.NotAllowed, Assert.Throws<ScFailure>(() => ScGuard.Corporate(Host, config)).Code);
            // A config.json without the field: not configured.
            File.WriteAllText(config, "{\"ports\": {\"first\": 4600, \"last\": 4619}}");
            Assert.Null(ScGuard.CorporateHosts(config));
        }
        finally
        {
            Environment.SetEnvironmentVariable("USERPROFILE", previous);
            try { Directory.Delete(profile, true); } catch (IOException) { }
        }
    }

    [Fact]
    public void ArgumentsAndFilesAreCheckedBeforeAnythingIsSent()
    {
        Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScApi.Prepare(Request("soap", "GetESpaceId", new JsonObject()), Host)).Code);
        Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScApi.Prepare(Request("soap", "GetESpaceId", new JsonObject { ["eSpaceKey"] = "not a key!" }), Host)).Code);
        var relative = Write(Request("soap", "UploadAndPublishExtension", new JsonObject { ["file"] = "relative.xif" }));
        Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScApi.Prepare(relative, Host)).Code);
        var moduleKey = Key();
        var kind = Write(Request("soap", "DeleteModule", new JsonObject { ["moduleKey"] = moduleKey, ["moduleKind"] = "Library" })); kind["target"] = moduleKey;
        Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScApi.Prepare(kind, Host)).Code);
    }

    // ---- one send, UNCERTAIN after it ----------------------------------------------------------

    [Fact]
    public void AFailedWriteIsUncertainSentOnceAndItsOperationIdIsNeverResent()
    {
        var (api, fake) = Fake<IServiceCenter>();
        fake.Handler = (_, _) => throw new System.TimeoutException("socket closed after " + Secret);
        var secrets = 0;
        var studio = new ScBound { Host = Host, User = "test-user", Secret = () => { secrets++; return Secret; }, Soap = api };
        var moduleKey = Key();
        var request = Write(Request("soap", "DeleteModule", new JsonObject { ["moduleKey"] = moduleKey, ["moduleKind"] = "Extension" })); request["target"] = moduleKey;
        var failure = Assert.Throws<ScFailure>(() => ScApi.Execute(ScApi.Prepare(request, Host), studio));
        Assert.Equal(ScCodes.Uncertain, failure.Code);
        Assert.True(failure.Sent);
        Assert.Equal(new[] { "DeleteModule" }, fake.Calls);
        Assert.DoesNotContain(Secret, failure.Message);
        Assert.DoesNotContain(Secret, ScReply.Fail(failure, Secret));
        // The same operationId again: refused before the client, never a second send.
        var again = Assert.Throws<ScFailure>(() => ScApi.Execute(ScApi.Prepare(request, Host), studio));
        Assert.Equal(ScCodes.NotAllowed, again.Code);
        Assert.Single(fake.Calls);
        Assert.Equal(2, secrets);
    }

    [Fact]
    public void AFailedReadIsARemoteErrorAndTheClientIsCalledWithAFreshSecret()
    {
        var (api, fake) = Fake<IServiceCenter>();
        var seen = new List<string?>();
        fake.Handler = (method, args) => { seen.Add(args[1] as string); throw new InvalidOperationException("fault"); };
        var n = 0;
        var studio = new ScBound { Host = Host, User = "test-user", Secret = () => "secret-" + ++n, Soap = api };
        var call = ScApi.Prepare(Request("soap", "ListEspaces", new JsonObject()), Host);
        Assert.Equal(ScCodes.RemoteError, Assert.Throws<ScFailure>(() => ScApi.Execute(call, studio)).Code);
        Assert.Equal(ScCodes.RemoteError, Assert.Throws<ScFailure>(() => ScApi.Execute(call, studio)).Code);
        Assert.Equal(new[] { "secret-1", "secret-2" }, seen);
    }

    [Fact]
    public void AChangedStudioLoginStopsTheCallBeforeTheOperationIdIsUsed()
    {
        var (api, fake) = Fake<IServiceCenter>();
        var request = Write(Request("soap", "ChangeCommitMessage", new JsonObject { ["eSpaceVersionId"] = 9, ["newCommitMessage"] = "fictional" }));
        var changed = new ScBound { Host = Host, User = "test-user", Secret = () => Secret, Soap = api, Validate = () => throw new InvalidOperationException("login changed") };
        var refusal = Assert.Throws<ScFailure>(() => ScApi.Execute(ScApi.Prepare(request, Host), changed));
        Assert.Equal(ScCodes.StudioNotSignedIn, refusal.Code);
        Assert.False(refusal.Sent);
        Assert.Empty(fake.Calls);
        var studio = new ScBound { Host = Host, User = "test-user", Secret = () => Secret, Soap = api };
        var done = ScApi.Execute(ScApi.Prepare(request, Host), studio);
        Assert.True(done["write"]!.GetValue<bool>());
        Assert.Equal(new[] { "ChangeCommitMessage" }, fake.Calls);
    }

    [Fact]
    public void ServerApiWritesAreRefusedWhenTheStudioClientCouldResend()
    {
        var (api, fake) = Fake<IServerAPI>();
        fake.Handler = (_, _) => true;
        var request = Write(Request("server-api", "SetIsPWA", new JsonObject { ["applicationKey"] = Key(), ["value"] = true }));
        var resending = new ScBound { Host = Host, User = "test-user", Secret = () => Secret, ServerApi = api, ServerApiSingleSend = false, Login = Fake<ILoginInfoBase>().Api };
        Assert.Equal(ScCodes.NotAllowed, Assert.Throws<ScFailure>(() => ScApi.Execute(ScApi.Prepare(request, Host), resending)).Code);
        Assert.Empty(fake.Calls);
        var once = new ScBound { Host = Host, User = "test-user", Secret = () => Secret, ServerApi = api, ServerApiSingleSend = true, Login = Fake<ILoginInfoBase>().Api };
        var result = ScApi.Execute(ScApi.Prepare(Write(Request("server-api", "SetIsPWA", new JsonObject { ["applicationKey"] = Key(), ["value"] = true })), Host), once);
        Assert.True(result["result"]!["changed"]!.GetValue<bool>());
        Assert.Equal(new[] { "SetIsPWA" }, fake.Calls);
    }

    [Theory]
    [InlineData(500, ScCodes.Uncertain)]
    [InlineData(504, ScCodes.Uncertain)]
    [InlineData(403, ScCodes.RemoteError)]
    public void ApplySettingsIsOnePutWithoutTheStudioRetryAndClassifiesTheAnswer(int status, string code)
    {
        var (rest, fake) = Fake<IRestService>();
        fake.Handler = (_, _) => new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent("{\"Errors\":\"" + Secret + "\"}") };
        var studio = new ScBound { Host = Host, User = "test-user", Secret = () => Secret, RestService = rest };
        var request = Write(Request("sc-rest", "apply-settings", new JsonObject { ["applicationKey"] = Key() }));
        var failure = Assert.Throws<ScFailure>(() => ScApi.Execute(ScApi.Prepare(request, Host), studio));
        Assert.Equal(code, failure.Code);
        Assert.Equal(new[] { "Put" }, fake.Calls);
        var parameters = Assert.IsType<HttpRequestParameters>(fake.Arguments.Single()[0]);
        Assert.False(parameters.RetryOnCommunicationError);
        Assert.False(parameters.HandleCommunicationError);
        Assert.Equal(Host, parameters.Uri.Host);
        Assert.Equal(Uri.UriSchemeHttps, parameters.Uri.Scheme);
        Assert.StartsWith("/ServiceCenter/rest/PlatformServices/applysettings/application/", parameters.Uri.AbsolutePath);
        Assert.StartsWith("Basic ", parameters.RequestHeaders["Authorization"]);
        Assert.DoesNotContain(Secret, ScReply.Fail(failure, Secret));
    }

    [Fact]
    public void ApplySettingsSuccessReturnsTheServerOperationId()
    {
        var (rest, fake) = Fake<IRestService>();
        fake.Handler = (_, _) => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"OperationId\":7}") };
        var studio = new ScBound { Host = Host, User = "test-user", Secret = () => Secret, RestService = rest };
        var result = ScApi.Execute(ScApi.Prepare(Write(Request("sc-rest", "apply-settings", new JsonObject { ["applicationKey"] = Key() })), Host), studio);
        Assert.Equal(7, result["result"]!["body"]!["OperationId"]!.GetValue<int>());
    }

    // ---- redaction and binaries ----------------------------------------------------------------

    [Fact]
    public void SecretsAreRedactedFromResultsAndFailures()
    {
        var (api, fake) = Fake<IServiceCenter>();
        fake.Handler = (_, _) => new Dictionary<string, string>
        {
            ["HubServerVersion"] = "11.41.0", ["DBPassword"] = "fictional-password", ["Token"] = "fictional-token",
            ["Connection"] = "Server=db;User Id=sa;Password=fictional-password;", ["Echo"] = "issued " + Secret,
            ["ForceSecureAlgorithmsInAuthentication"] = "fictional-opaque-auth-material",
        };
        var studio = new ScBound { Host = Host, User = "test-user", Secret = () => Secret, Soap = api };
        var result = ScApi.Execute(ScApi.Prepare(Request("soap", "GetProperties", new JsonObject()), Host), studio)["result"]!.AsObject();
        Assert.Equal("11.41.0", result["HubServerVersion"]!.ToString());
        Assert.Equal(ScRedaction.Mask, result["DBPassword"]!.ToString());
        Assert.Equal(ScRedaction.Mask, result["Token"]!.ToString());
        Assert.Equal(ScRedaction.Mask, result["ForceSecureAlgorithmsInAuthentication"]!.ToString());
        Assert.DoesNotContain("fictional-opaque-auth-material", result.ToJsonString());
        Assert.DoesNotContain("fictional-password", result.ToJsonString());
        Assert.DoesNotContain(Secret, result.ToJsonString());
        var pairs = ScRedaction.Node(new JsonArray(new JsonObject { ["Key"] = "ApiKey", ["Value"] = "fictional" }), null)!;
        Assert.Equal(ScRedaction.Mask, pairs[0]!["Value"]!.ToString());
        var authPair = ScRedaction.Node(new JsonArray(new JsonObject {
            ["Key"] = "ForceSecureAlgorithmsInAuthentication", ["Value"] = "fictional-opaque-auth-material"
        }), null)!;
        Assert.Equal(ScRedaction.Mask, authPair[0]!["Value"]!.ToString());
        Assert.Equal("Authorization: Bearer " + ScRedaction.Mask, ScRedaction.Text("Authorization: Bearer abc.def-123", null));
    }

    [Fact]
    public void BinariesGoToANewAbsoluteFileOrComeBackAsBase64()
    {
        var (api, fake) = Fake<IServiceCenter>();
        fake.Handler = (method, args) => method.Name == "DownloadExtension" ? new byte[] { 1, 2, 3 } : null;
        var studio = new ScBound { Host = Host, User = "test-user", Secret = () => Secret, Soap = api };
        var args = new JsonObject { ["extensionKey"] = Key(), ["versionId"] = 4 };
        var inline = ScApi.Execute(ScApi.Prepare(Request("soap", "DownloadExtension", args), Host), studio)["result"]!;
        Assert.Equal(3, inline["bytes"]!.GetValue<int>());
        Assert.Equal("AQID", inline["base64"]!.ToString());
        var dir = Path.Combine(Path.GetTempPath(), "anvil-sc-" + Guid.NewGuid().ToString("N"));
        try
        {
            var file = Path.Combine(dir, "extension.xif");
            var toFile = args.DeepClone().AsObject(); toFile["outFile"] = file;
            var written = ScApi.Execute(ScApi.Prepare(Request("soap", "DownloadExtension", toFile), Host), studio)["result"]!;
            Assert.Equal(file, written["file"]!.ToString());
            Assert.Equal(new byte[] { 1, 2, 3 }, File.ReadAllBytes(file));
            Assert.Null(written["base64"]);
            // Never overwritten: refused before the call.
            Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScApi.Prepare(Request("soap", "DownloadExtension", toFile), Host)).Code);
            Assert.Equal(2, fake.Calls.Count);
        }
        finally { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
    }

    // ---- hosts and sc_web ----------------------------------------------------------------------

    [Theory]
    [InlineData("https://lab.example")]
    [InlineData("lab.example:443")]
    [InlineData("lab.example/ServiceCenter")]
    [InlineData("user@lab.example")]
    [InlineData("")]
    public void HostIsTheBareEnvironmentName(string host)
        => Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScGuard.Host(host)).Code);

    [Fact]
    public void HostMatchIsExactIgnoringCase()
    {
        Assert.Equal("personal-x.outsystemscloud.com", ScGuard.Host("Personal-X.OutSystemsCloud.com."));
        Assert.True(ScGuard.SameHost("PERSONAL-X.outsystemscloud.com", "personal-x.outsystemscloud.com"));
        Assert.False(ScGuard.SameHost("personal-x.outsystemscloud.com.evil.example", "personal-x.outsystemscloud.com"));
    }

    [Theory]
    [InlineData("eSpace_Edit.aspx?EspaceId=12", "https://lab.example/ServiceCenter/eSpace_Edit.aspx?EspaceId=12")]
    [InlineData("/ServiceCenter/Error_Logs.aspx", "https://lab.example/ServiceCenter/Error_Logs.aspx")]
    [InlineData(null, "https://lab.example/ServiceCenter/")]
    [InlineData("https://LAB.example/ServiceCenter/Timers.aspx", "https://lab.example/ServiceCenter/Timers.aspx")]
    public void WebPathsResolveUnderTheServiceCenter(string? path, string expected)
        => Assert.Equal(expected, ScWebPaths.Resolve(Host, path));

    [Theory]
    [InlineData("/ServiceCenter/../Users/")]
    [InlineData("/ServiceCenter/%2e%2e/Users/")]
    [InlineData("/ServiceCenter%2fx")]
    [InlineData("/Users/Users.aspx")]
    [InlineData("//evil.example/ServiceCenter/")]
    [InlineData("https://evil.example/ServiceCenter/")]
    [InlineData("https://lab.example:8443/ServiceCenter/")]
    [InlineData("http://lab.example/ServiceCenter/")]
    [InlineData("/ServiceCenter/a.aspx#frag")]
    [InlineData("\\ServiceCenter\\a.aspx")]
    public void WebPathsOutsideTheAllowlistAreRefused(string path)
        => Assert.Equal(ScCodes.NotAllowed, Assert.Throws<ScFailure>(() => ScWebPaths.Resolve(Host, path)).Code);

    [Fact]
    public void TheWebWindowLeavesTheServiceCenterOnlyWhileTheUserSignsIn()
    {
        Assert.True(ScWebPaths.MayNavigate(Host, "https://lab.example/ServiceCenter/Home.aspx", false));
        Assert.True(ScWebPaths.MayNavigate(Host, "https://login.identity.example/authorize?x=1", true));
        Assert.False(ScWebPaths.MayNavigate(Host, "https://login.identity.example/authorize?x=1", false));
        Assert.False(ScWebPaths.MayNavigate(Host, "http://lab.example/ServiceCenter/", true));
        Assert.False(ScWebPaths.MayNavigate(Host, "file:///C:/Windows/win.ini", true));
        // An identity provider URL is described by its origin only (it can carry codes and state).
        Assert.Equal("https://login.identity.example", ScWebPaths.Describe(Host, "https://login.identity.example/cb?code=secret-code"));
    }

    [Fact]
    public void FetchAnswersOutsideTheAllowlistAreDroppedAndSignInIsReported()
    {
        var offHost = Page(new JsonObject { ["status"] = 200, ["finalUrl"] = "https://other.example/ServiceCenter/x.aspx", ["contentType"] = "text/html", ["html"] = "private" });
        var mismatch = Assert.Throws<ScFailure>(() => ScWebResult.Fetch(Host, "GET", false, offHost));
        Assert.Equal(ScCodes.HostMismatch, mismatch.Code);
        Assert.DoesNotContain("private", ScReply.Fail(mismatch));
        var login = Page(new JsonObject { ["status"] = 200, ["finalUrl"] = "https://lab.example/ServiceCenter/Login.aspx?OriginalURL=x", ["html"] = "<form/>" });
        Assert.Equal(ScCodes.WebSignInRequired, Assert.Throws<ScFailure>(() => ScWebResult.Fetch(Host, "GET", false, login)).Code);
        var origin = Assert.Throws<ScFailure>(() => ScWebResult.Fetch(Host, "POST", true, Page(new JsonObject { ["error"] = "origin" })));
        Assert.Equal(ScCodes.WebSignInRequired, origin.Code);
        Assert.False(origin.Sent);
        Assert.Equal(ScCodes.WebSignInRequired, Assert.Throws<ScFailure>(() => ScWebResult.Fetch(Host, "GET", false, Page(new JsonObject { ["error"] = "network" }))).Code);
    }

    [Fact]
    public void AWebPostbackWithoutAnAnswerIsUncertain()
    {
        Assert.Equal(ScCodes.Uncertain, Assert.Throws<ScFailure>(() => ScWebResult.Fetch(Host, "POST", true, null)).Code);
        Assert.Equal(ScCodes.Uncertain, Assert.Throws<ScFailure>(() => ScWebResult.Fetch(Host, "POST", true, Page(new JsonObject { ["error"] = "network" }))).Code);
        Assert.Equal(ScCodes.RemoteError, Assert.Throws<ScFailure>(() => ScWebResult.Fetch(Host, "POST", false, null)).Code);
        var redirect = ScWebResult.Fetch(Host, "POST", true, Page(new JsonObject { ["status"] = 0, ["type"] = "opaqueredirect", ["finalUrl"] = "" }));
        Assert.True(redirect["redirected"]!.GetValue<bool>());
    }

    [Fact]
    public void FetchKeepsFormStateButNotPasswordValues()
    {
        var html = "<input type=\"hidden\" name=\"__VIEWSTATE\" value=\"abc\"><input name=\"p\" type=\"password\" value=\"fictional-password\">";
        var body = ScWebResult.Fetch(Host, "GET", false, Page(new JsonObject { ["status"] = 200, ["finalUrl"] = "https://lab.example/ServiceCenter/DBConnection_Edit.aspx", ["contentType"] = "text/html", ["html"] = html }));
        var text = body["html"]!.ToString();
        Assert.Contains("value=\"abc\"", text);
        Assert.DoesNotContain("fictional-password", text);
        var xlsx = ScWebResult.Fetch(Host, "POST", false, Page(new JsonObject { ["status"] = 200, ["finalUrl"] = "https://lab.example/ServiceCenter/Error_Logs.aspx", ["contentType"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ["bodyBase64"] = "UEsDBA==" }));
        Assert.Equal("UEsDBA==", xlsx["bodyBase64"]!.ToString());
    }

    [Fact]
    public void TheFetchScriptIsFixedSameOriginAndNeverReadsCookies()
    {
        var url = ScWebPaths.Resolve(Host, "Error_Logs.aspx?q=');alert(1)//");
        var form = new JsonObject { ["__VIEWSTATE"] = "abc", ["x\"y"] = new JsonArray("1", "2") };
        var script = ScWebScripts.Fetch("id-1", "https://" + Host, url, "POST", form, "html");
        Assert.DoesNotContain("cookie", script, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("credentials:'same-origin'", script);
        Assert.Contains("mode:'same-origin'", script);
        Assert.Contains("location.origin!==a.origin", script);
        Assert.DoesNotContain("');alert(1)", script);
        Assert.DoesNotContain("cookie", ScWebScripts.Status, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("\"id-1\"", ScWebScripts.Take("id-1"));
    }

    private static JsonObject WebStatus(bool signedIn) => new() { ["open"] = true, ["signedIn"] = signedIn };
    private static string LoginPage(string origin, bool form = true, bool error = false) =>
        new JsonObject { ["origin"] = origin, ["form"] = form, ["error"] = error }.ToJsonString();

    [Fact]
    public void TheStoredLoginIsFilledOnlyIntoTheEnvironmentOrTheOutSystemsSignIn()
    {
        Assert.Equal("SSAM/O11/lab.example/ServiceCenter", ScWebLogin.Target(Host));
        Assert.True(ScWebLogin.MayFill(Host, "https://id.outsystems.com"));
        Assert.True(ScWebLogin.MayFill(Host, "https://lab.example"));
        Assert.False(ScWebLogin.MayFill(Host, "https://login.microsoftonline.com"));
        Assert.False(ScWebLogin.MayFill(Host, "http://lab.example"));
        Assert.False(ScWebLogin.MayFill(Host, "https://id.outsystems.com.evil.example"));
        Assert.False(ScWebLogin.MayFill(Host, null));
        Assert.Equal(ScWebLogin.Step.Fill, ScWebLogin.Next(Host, WebStatus(false), LoginPage("https://id.outsystems.com"), null));
        // Another identity provider is never filled: the sign-in needs the user.
        Assert.Equal(ScWebLogin.Step.Interactive, ScWebLogin.Next(Host, WebStatus(false), LoginPage("https://login.microsoftonline.com"), null));
        // Redirects in between: no form yet.
        Assert.Equal(ScWebLogin.Step.Wait, ScWebLogin.Next(Host, WebStatus(false), LoginPage("https://id.outsystems.com", form: false), null));
        Assert.Equal(ScWebLogin.Step.Wait, ScWebLogin.Next(Host, WebStatus(false), null, null));
        Assert.Equal(ScWebLogin.Step.SignedIn, ScWebLogin.Next(Host, WebStatus(true), null, TimeSpan.FromSeconds(3)));
    }

    [Fact]
    public void TheStoredLoginIsSubmittedOnceAndARejectionIsNeverRetried()
    {
        var page = LoginPage("https://id.outsystems.com");
        // After the submit the form never gets a second fill: it waits, then reports the rejection.
        Assert.Equal(ScWebLogin.Step.Wait, ScWebLogin.Next(Host, WebStatus(false), page, TimeSpan.FromSeconds(2)));
        Assert.Equal(ScWebLogin.Step.Rejected, ScWebLogin.Next(Host, WebStatus(false), page, ScWebLogin.RejectAfter));
        Assert.Equal(ScWebLogin.Step.Rejected, ScWebLogin.Next(Host, WebStatus(false), LoginPage("https://id.outsystems.com", error: true), TimeSpan.FromSeconds(2)));
        // A page without the password form after the submit (MFA, consent) keeps waiting until the handler's limit.
        Assert.Equal(ScWebLogin.Step.Wait, ScWebLogin.Next(Host, WebStatus(false), LoginPage("https://id.outsystems.com", form: false), TimeSpan.FromSeconds(30)));
    }

    [Fact]
    public void TheLoginScriptsNeverReadValuesOrCookies()
    {
        var script = ScWebLogin.Fill("ana@example.com", "fic'tional\"</script>");
        Assert.Contains("\"ana@example.com\"", script);
        Assert.DoesNotContain("fic'tional\"</script>", script);
        Assert.Contains("a=null", script);
        Assert.DoesNotContain("cookie", script, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("cookie", ScWebLogin.State, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(".value", ScWebLogin.State);
        Assert.Contains(ScCodes.WebLoginRejected, new[] { "WEB_LOGIN_REJECTED" });
        Assert.Contains(ScCodes.WebSignInInteractive, new[] { "WEB_SIGN_IN_INTERACTIVE" });
    }

    [Fact]
    public void WebRequestsCheckMethodFormAndWriteFieldsUpFront()
    {
        JsonObject Web(JsonObject extra) { var r = new JsonObject { ["host"] = Host, ["action"] = "fetch" }; foreach (var (k, v) in extra) r[k] = v?.DeepClone(); return r; }
        Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScWebRequest.Parse(Web(new JsonObject { ["method"] = "DELETE" }), Host)).Code);
        Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScWebRequest.Parse(Web(new JsonObject { ["form"] = new JsonObject { ["a"] = "1" } }), Host)).Code);
        Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScWebRequest.Parse(Web(new JsonObject { ["method"] = "POST", ["form"] = new JsonObject { ["a"] = new JsonObject() } }), Host)).Code);
        Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScWebRequest.Parse(Web(new JsonObject { ["method"] = "POST", ["write"] = true }), Host)).Code);
        var postback = ScWebRequest.Parse(Web(new JsonObject { ["method"] = "POST", ["path"] = "Timers.aspx", ["write"] = true,
            ["operationId"] = Guid.NewGuid().ToString(), ["authorizeSha256"] = Words, ["form"] = new JsonObject { ["__EVENTTARGET"] = "RunNow" } }), Host);
        Assert.True(postback.Write);
        Assert.Equal("https://lab.example/ServiceCenter/Timers.aspx", postback.Url);
        Assert.False(ScWebRequest.Parse(Web(new JsonObject()), Host).Write);
        // A solution .osp download (the facade asks binary) reads its non-HTML answer as bytes, like xlsx.
        Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScWebRequest.Parse(Web(new JsonObject { ["accept"] = "pdf" }), Host)).Code);
        var download = ScWebRequest.Parse(Web(new JsonObject { ["method"] = "POST", ["accept"] = "binary", ["form"] = new JsonObject { ["__EVENTTARGET"] = "Download" } }), Host);
        Assert.Equal(("binary", false), (download.Accept, download.Write));
        Assert.Contains("a.accept!=='html'", ScWebScripts.Fetch("id-2", "https://" + Host, download.Url, "POST", download.Form, download.Accept));
    }

    // ---- integration-studio (IntegrationStudio.asmx, reads only) --------------------------------

    private const string StubsResponse = """
        <?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
        <GenerateSourceCodeStubsResponse xmlns="http://www.outsystems.com"><sourceCodeZip>UEsDBA==</sourceCodeZip>
        <messages><HEMessage><Id>IS-1</Id><Message>Stub generated with a warning</Message><Detail>synthetic</Detail><HelpRef>0</HelpRef><Type>Warning</Type><Submitable>false</Submitable></HEMessage></messages>
        </GenerateSourceCodeStubsResponse></soap:Body></soap:Envelope>
        """;

    private static (ScBound Studio, List<ScSoapRequest> Sent) IntegrationStudio(Func<ScSoapRequest, ScHttp> answer)
    {
        var sent = new List<ScSoapRequest>();
        return (new ScBound { Host = Host, User = "test-user", Secret = () => Secret, IntegrationStudioHttp = r => { sent.Add(r); return answer(r); } }, sent);
    }

    [Fact]
    public void TheIntegrationStudioSurfaceIsReadOnlyAndListedInTheCatalog()
    {
        var catalog = ScApi.Catalog();
        Assert.Equal(["GenerateSourceCodeStubs", "GetSourceCodeDependencies", "Handshake", "TranslateLogicalDatabaseToDbConnection", "UploadNeeded"], catalog["integration-studio"]!.AsArray().Select(x => x!.ToString()));
        Assert.All(ScApi.IntegrationStudioOperations.Values, op => Assert.False(op.Write || op.Destroys != null || op.WriteWhen != null));
        // The write fields change nothing: no operationId is claimed and the write guard does not run.
        var handshake = ScApi.Prepare(Write(Request("integration-studio", "Handshake", new JsonObject { ["version"] = "11.14.25.134" })), Host);
        Assert.False(handshake.Write);
        Assert.Null(handshake.OperationId);
        Assert.False(handshake.Destructive);
        Assert.False(ScApi.Prepare(Request("integration-studio", "Handshake", new JsonObject { ["version"] = "11.14.25.134" }), "dev.wrightflood.example").Write);
        var unknown = Assert.Throws<ScFailure>(() => ScApi.Prepare(Request("integration-studio", "Upload", new JsonObject()), Host));
        Assert.Equal(ScCodes.NotAllowed, unknown.Code);
        Assert.Equal(ScCodes.NotAllowed, Assert.Throws<ScFailure>(() => ScApi.Prepare(Request("integration-studio", "Publish", new JsonObject()), Host)).Code);
        Assert.Contains("integration-studio", Assert.Throws<ScFailure>(() => ScApi.Prepare(Request("ldap", "Handshake", new JsonObject()), Host)).Message);
    }

    private static string ProviderResponse(string fields) =>
        "<soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\"><soap:Body><TranslateLogicalDatabaseToDbConnectionResponse xmlns=\"http://www.outsystems.com\">"
        + fields + "</TranslateLogicalDatabaseToDbConnectionResponse></soap:Body></soap:Envelope>";

    [Fact]
    public void DatabaseProviderReadUsesBoundLoginAndExactWsdlFieldsOnce()
    {
        var (studio, sent) = IntegrationStudio(_ => new ScHttp(200, "text/xml", ProviderResponse(
            "<dbConnection><Name>ProofDatabase</Name><ProviderName>SqlServer</ProviderName></dbConnection>")));
        var key = Key();
        var prepared = ScApi.Prepare(Request("integration-studio", "TranslateLogicalDatabaseToDbConnection",
            new JsonObject { ["extensionKey"] = key, ["logicalDatabase"] = "Cargo<&" }), Host);
        Assert.False(prepared.Write);
        var result = ScApi.Execute(prepared, studio)["result"]!;
        Assert.True(result["providerObserved"]!.GetValue<bool>());
        Assert.False(result["mappingAbsentProven"]!.GetValue<bool>());
        Assert.Equal("ProofDatabase", result["dbConnection"]!["name"]!.ToString());
        Assert.Equal("SqlServer", result["dbConnection"]!["providerName"]!.ToString());
        var request = Assert.Single(sent);
        Assert.Equal(ScIntegrationStudioSoap.ActionPrefix + "TranslateLogicalDatabaseToDbConnection", request.SoapAction);
        var wrapper = System.Xml.Linq.XDocument.Parse(request.Body).Descendants().Single(e => e.Name.LocalName == "TranslateLogicalDatabaseToDbConnection");
        Assert.Equal(new[] { "username", "password", "extensionKey", "logicalDatabase" }, wrapper.Elements().Select(e => e.Name.LocalName));
        Assert.Equal("Cargo<&", wrapper.Elements().Last().Value);
        Assert.DoesNotContain(Secret, result.ToJsonString());
    }

    [Theory]
    [InlineData("")]
    [InlineData("<dbConnection />")]
    [InlineData("<dbConnection><Name>A</Name></dbConnection>")]
    [InlineData("<dbConnection><Name>A</Name><Name>B</Name><ProviderName>SqlServer</ProviderName></dbConnection>")]
    [InlineData("<dbConnection><Name><Password>private</Password></Name><ProviderName>SqlServer</ProviderName></dbConnection>")]
    [InlineData("<dbConnection><Name>A</Name><ProviderName>SqlServer</ProviderName><Password>private</Password></dbConnection>")]
    [InlineData("<dbConnection xmlns='urn:wrong'><Name>A</Name><ProviderName>SqlServer</ProviderName></dbConnection>")]
    [InlineData("<dbConnection xmlns:xsi='http://www.w3.org/2001/XMLSchema-instance' xsi:nil='true'><Name>A</Name></dbConnection>")]
    [InlineData("<dbConnection /><dbConnection />")]
    public void InvalidProviderAnswersNeverProveMappingAbsence(string fields)
    {
        var (studio, sent) = IntegrationStudio(_ => new ScHttp(200, "text/xml", ProviderResponse(fields)));
        var failure = Assert.Throws<ScFailure>(() => ScApi.Execute(ScApi.Prepare(Request("integration-studio",
            "TranslateLogicalDatabaseToDbConnection", new JsonObject { ["extensionKey"] = Key(), ["logicalDatabase"] = "Cargo" }), Host), studio));
        Assert.Equal(ScCodes.RemoteError, failure.Code);
        Assert.True(failure.Sent);
        Assert.DoesNotContain("private", failure.Message);
        Assert.Single(sent);
    }

    [Fact]
    public void NilProviderIsUnobservedAndNotProofOfUnmapping()
    {
        var answer = ScIntegrationStudioSoap.Parse("TranslateLogicalDatabaseToDbConnection", 200, ProviderResponse(
            "<dbConnection xmlns:xsi='http://www.w3.org/2001/XMLSchema-instance' xsi:nil='true' />"));
        var result = ScIntegrationStudioSoap.DatabaseProvider(answer);
        Assert.False(result["providerObserved"]!.GetValue<bool>());
        Assert.False(result["mappingAbsentProven"]!.GetValue<bool>());
        Assert.Null(result["dbConnection"]);
    }

    [Fact]
    public void IntegrationStudioFilesAreAbsoluteExistingAndOutFilesAreNew()
    {
        Assert.Equal(256L * 1024 * 1024, ScArgs.FileLimit);
        var dir = Path.Combine(Path.GetTempPath(), "anvil-is-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScApi.Prepare(Request("integration-studio", "GenerateSourceCodeStubs", new JsonObject { ["file"] = "model.xif" }), Host)).Code);
            Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScApi.Prepare(Request("integration-studio", "GenerateSourceCodeStubs", new JsonObject { ["file"] = Path.Combine(dir, "absent.xif") }), Host)).Code);
            var empty = Path.Combine(dir, "empty.xif"); File.WriteAllBytes(empty, []);
            Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScApi.Prepare(Request("integration-studio", "GenerateSourceCodeStubs", new JsonObject { ["file"] = empty }), Host)).Code);
            var model = Path.Combine(dir, "model.xif"); File.WriteAllBytes(model, [1, 2, 3]);
            var existing = Path.Combine(dir, "stubs.zip"); File.WriteAllBytes(existing, [9]);
            Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScApi.Prepare(Request("integration-studio", "GenerateSourceCodeStubs", new JsonObject { ["file"] = model, ["outFile"] = existing }), Host)).Code);
            Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScApi.Prepare(Request("integration-studio", "GetSourceCodeDependencies", new JsonObject { ["outFile"] = "deps.zip" }), Host)).Code);
            Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScApi.Prepare(Request("integration-studio", "UploadNeeded", new JsonObject { ["extensionKey"] = "not a key!", ["extensionHash"] = "h" }), Host)).Code);
            Assert.Equal(ScCodes.BadRequest, Assert.Throws<ScFailure>(() => ScApi.Prepare(Request("integration-studio", "Handshake", new JsonObject()), Host)).Code);
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public void TheEnvelopeCarriesTheUserAndTheFreshSecretToTheIntegrationStudioService()
    {
        var request = ScIntegrationStudioSoap.Request(Host, "UploadNeeded", "test-user", Secret, ("ExtensionGUID", "6f1c2a3b-0000-4000-8000-000000000001"), ("ExtensionHash", "abc"));
        Assert.Equal("https://lab.example/ServiceCenter/IntegrationStudio.asmx", request.Uri.ToString());
        Assert.Equal("http://ServiceCenter/IntegrationStudio/UploadNeeded", request.SoapAction);
        var envelope = System.Xml.Linq.XDocument.Parse(request.Body);
        System.Xml.Linq.XNamespace ns = "http://www.outsystems.com";
        var body = envelope.Root!.Elements().Single().Elements().Single();
        Assert.Equal(ns + "UploadNeeded", body.Name);
        Assert.Equal(["username", "password", "ExtensionGUID", "ExtensionHash"], body.Elements().Select(e => e.Name.LocalName));
        Assert.Equal("test-user", body.Element(ns + "username")!.Value);
        Assert.Equal(Secret, body.Element(ns + "password")!.Value);
        Assert.DoesNotContain(Secret, request.ToString());
    }

    [Fact]
    public void AReadReturnsTheZipToTheOutFileWithTheServerMessagesSentOnce()
    {
        var dir = Path.Combine(Path.GetTempPath(), "anvil-is-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var model = Path.Combine(dir, "model.xif"); File.WriteAllBytes(model, [7, 7, 7]);
            var stubs = Path.Combine(dir, "out", "stubs.zip");
            var n = 0;
            var (studio, sent) = IntegrationStudio(_ => new ScHttp(200, "text/xml", StubsResponse));
            studio = new ScBound { Host = studio.Host, User = studio.User, Secret = () => Secret + "-" + ++n, IntegrationStudioHttp = studio.IntegrationStudioHttp };
            var result = ScApi.Execute(ScApi.Prepare(Request("integration-studio", "GenerateSourceCodeStubs", new JsonObject { ["file"] = model, ["outFile"] = stubs }), Host), studio)["result"]!;
            Assert.Equal(stubs, result["file"]!.ToString());
            Assert.Equal(new byte[] { 0x50, 0x4B, 0x03, 0x04 }, File.ReadAllBytes(stubs));
            Assert.Equal("Warning", result["meta"]!["messages"]![0]!["type"]!.ToString());
            Assert.Equal("Stub generated with a warning", result["meta"]!["messages"]![0]!["message"]!.ToString());
            Assert.Equal(0, result["meta"]!["errors"]!.GetValue<int>());
            var only = Assert.Single(sent);
            Assert.Contains(Convert.ToBase64String([7, 7, 7]), only.Body);
            Assert.Contains(Secret + "-1", only.Body);

            var (upload, _) = IntegrationStudio(_ => new ScHttp(200, "text/xml", """
                <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><UploadNeededResponse xmlns="http://www.outsystems.com">
                <Needs>false</Needs><ExtensionId>41</ExtensionId><equalVersionId>7</equalVersionId><runningVersionId>7</runningVersionId><messages /></UploadNeededResponse></soap:Body></soap:Envelope>
                """));
            var needed = ScApi.Execute(ScApi.Prepare(Request("integration-studio", "UploadNeeded", new JsonObject { ["extensionKey"] = Key(), ["extensionHash"] = "h1" }), Host), upload)["result"]!;
            Assert.False(needed["needs"]!.GetValue<bool>());
            Assert.Equal((41, 7, 7), (needed["extensionId"]!.GetValue<int>(), needed["equalVersionId"]!.GetValue<int>(), needed["runningVersionId"]!.GetValue<int>()));

            var (handshake, _) = IntegrationStudio(_ => new ScHttp(200, "text/xml", """
                <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><HandshakeResponse xmlns="http://www.outsystems.com">
                <ok>false</ok><error>Integration Studio 11.14 is older than this platform</error><platform>11.38.0</platform><database>SqlServer</database></HandshakeResponse></soap:Body></soap:Envelope>
                """));
            var shake = ScApi.Execute(ScApi.Prepare(Request("integration-studio", "Handshake", new JsonObject { ["version"] = "11.14.25.134" }), Host), handshake)["result"]!;
            Assert.False(shake["ok"]!.GetValue<bool>());
            Assert.Equal("Integration Studio 11.14 is older than this platform", shake["error"]!.ToString());
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public void AFaultIsARemoteErrorAndTheSecretNeverComesBack()
    {
        var (studio, sent) = IntegrationStudio(_ => new ScHttp(500, "text/xml", """
            <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Server</faultcode>
            <faultstring>Invalid login for test-user with password eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.c2lnbmF0dXJlLW9mLXRlc3Q</faultstring></soap:Fault></soap:Body></soap:Envelope>
            """));
        var failure = Assert.Throws<ScFailure>(() => ScApi.Execute(ScApi.Prepare(Request("integration-studio", "GetSourceCodeDependencies", new JsonObject()), Host), studio));
        Assert.Equal(ScCodes.RemoteError, failure.Code);
        Assert.True(failure.Sent);
        Assert.Contains("HTTP 500", failure.Message);
        Assert.Contains("Invalid login", failure.Message);
        Assert.DoesNotContain(Secret, failure.Message);
        Assert.DoesNotContain(Secret, ScReply.Fail(failure));
        Assert.Single(sent);
        // A Studio without the HTTP client of this surface: unavailable before anything is sent.
        var none = new ScBound { Host = Host, User = "test-user", Secret = () => Secret };
        Assert.Equal(ScCodes.StudioUnavailable, Assert.Throws<ScFailure>(() => ScApi.Execute(ScApi.Prepare(Request("integration-studio", "GetSourceCodeDependencies", new JsonObject()), Host), none)).Code);
    }

    // ---- helpers -------------------------------------------------------------------------------

    private static JsonObject Request(string surface, string operation, JsonObject args) =>
        new() { ["host"] = Host, ["surface"] = surface, ["operation"] = operation, ["args"] = args.DeepClone() };

    private static JsonObject Write(JsonObject request)
    {
        request["write"] = true;
        request["operationId"] = Guid.NewGuid().ToString();
        request["authorizeSha256"] = Words;
        return request;
    }

    private static string Key() => Guid.NewGuid().ToString();

    private static string Page(JsonObject page) => page.ToJsonString();

    private static (T Api, Recorder Fake) Fake<T>() where T : class
    {
        var api = DispatchProxy.Create<T, Recorder>();
        return (api, (Recorder)(object)api);
    }

    /// <summary>A Studio interface that records each call; Handler answers it (out arguments keep their defaults).</summary>
    public class Recorder : DispatchProxy
    {
        public readonly List<string> Calls = [];
        public readonly List<object?[]> Arguments = [];
        public Func<MethodInfo, object?[], object?>? Handler;

        protected override object? Invoke(MethodInfo? method, object?[]? args)
        {
            Calls.Add(method!.Name);
            Arguments.Add(args ?? []);
            var result = Handler?.Invoke(method, args ?? []);
            if (result == null && method.ReturnType.IsValueType && method.ReturnType != typeof(void)) return Activator.CreateInstance(method.ReturnType);
            return result;
        }
    }
}
