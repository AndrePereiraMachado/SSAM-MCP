using System.Net;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Bridge;
using Xunit;

namespace Anvil.Tests;

/// <summary>secretRefs of sc_web fetch (ScSecrets.cs) against a fake vault: the vault value fills only the form copy of the
/// page script, never comes from or goes back to the facade (answer, form state, failure), and every refusal happens
/// before anything is sent. Nothing here reads the real Windows vault or reaches a Studio.</summary>
public sealed class ServiceCenterSecretRefsTests
{
    private const string Host = "lab.example";
    private const string Target = "SSAM/O11/lab.example/DatabaseConnection/SampleWarehouse";
    private const string PasswordField = "wt9$wtContentMain$wtDBParams$ctl02$wt133";
    private const string UserField = "wt9$wtContentMain$wtDBParams$ctl00$wt173";
    private const string Placeholder = "<SECRET-INJECTED-IN-STUDIO-PROCESS>";
    private const string Password = "Fict<on&al\"Pw'9-long";
    private const string User = "svc_fictional_reader";
    private static readonly string Words = new('a', 64);

    // ---- injection -----------------------------------------------------------------------------

    [Fact]
    public void TheVaultValueFillsOnlyTheFormCopyOfTheScript()
    {
        var request = ScWebRequest.Parse(Postback(Ref(PasswordField, "password"), Ref(UserField, "username")), Host);
        Assert.Equal(2, request.SecretRefs.Count);
        var vault = Vault();
        var injected = ScSecretRefs.Resolve(request.SecretRefs, vault);
        Assert.Equal(new[] { Target }, vault.Reads);
        var form = injected.Apply(request.Form)!;
        Assert.Equal(Password, form[PasswordField]!.GetValue<string>());
        Assert.Equal(User, form[UserField]!.GetValue<string>());
        Assert.Equal(Placeholder, request.Form![PasswordField]!.GetValue<string>());
        var script = ScWebScripts.Fetch("id-1", "https://" + Host, request.Url, request.Method, form, request.Accept);
        Assert.Contains(JsonEncodedText.Encode(Password).ToString(), script);
        Assert.DoesNotContain("SECRET-INJECTED", script);
        // What describes the request or the values never shows them.
        Assert.DoesNotContain(Password, request.ToString());
        Assert.DoesNotContain(Password, injected.ToString());
        Assert.DoesNotContain(User, injected.ToString());
        Assert.DoesNotContain(Password, new ScVaultEntry(User, Password).ToString());
    }

    [Fact]
    public void TheShapeSharedWithTheOdcBridgeNamesTheSameField()
    {
        var shared = new JsonObject { ["pointer"] = PasswordField, ["target"] = Target, ["field"] = "password" };
        Assert.Equal(new ScSecretRef(PasswordField, Target, "password"), Assert.Single(ScWebRequest.Parse(Postback(shared), Host).SecretRefs));
        var both = new JsonObject { ["field"] = PasswordField, ["pointer"] = UserField, ["target"] = Target, ["part"] = "password" };
        Refused(ScCodes.BadRequest, Postback(both), "secret_refs_invalid");
    }

    [Fact]
    public void TheFacadePointerIsAnRfc6901PointerIntoTheFlatForm()
    {
        // kernel/scripts/service_center/http.py json_pointer: "/" + the field name, '~' as '~0' and '/' as '~1'.
        var facade = new JsonObject { ["pointer"] = "/" + PasswordField, ["target"] = Target, ["field"] = "password" };
        Assert.Equal(new ScSecretRef(PasswordField, Target, "password"), Assert.Single(ScWebRequest.Parse(Postback(facade), Host).SecretRefs));
        var escaped = Postback(new JsonObject { ["pointer"] = "/wt9$a~1b~0c", ["target"] = Target, ["field"] = "password" });
        escaped["form"]!["wt9$a/b~c"] = "";
        Assert.Equal("wt9$a/b~c", Assert.Single(ScWebRequest.Parse(escaped, Host).SecretRefs).Field);
        // The form is flat: a pointer with a second step names nothing in it.
        Refused(ScCodes.BadRequest, Postback(new JsonObject { ["pointer"] = "/form/" + PasswordField, ["target"] = Target, ["field"] = "password" }), "secret_refs_invalid");
        var same = new JsonObject { ["field"] = PasswordField, ["pointer"] = "/" + PasswordField, ["target"] = Target, ["part"] = "password" };
        Assert.Single(ScWebRequest.Parse(Postback(same), Host).SecretRefs);
    }

    // ---- refusals before the send --------------------------------------------------------------

    [Fact]
    public void SecretRefsGoOnlyWithAWritePostbackAndNameAFieldOfItsForm()
    {
        var read = Postback(Ref(PasswordField, "password"));
        read.Remove("write"); read.Remove("operationId"); read.Remove("authorizeSha256");
        Refused(ScCodes.NotAllowed, read, "secret_refs_write_only");
        var xlsx = Postback(Ref(PasswordField, "password")); xlsx["accept"] = "xlsx";
        Refused(ScCodes.BadRequest, xlsx);
        Refused(ScCodes.BadRequest, Postback(Ref("wt9$wtContentMain$wtNoSuchField", "password")));
        Refused(ScCodes.BadRequest, Postback(Ref(PasswordField, "token")));
        Refused(ScCodes.BadRequest, Postback(Ref(PasswordField, "password"), Ref(PasswordField, "username")));
        Refused(ScCodes.BadRequest, Postback(Enumerable.Range(0, ScSecretRefs.Limit + 1).Select(_ => Ref(PasswordField, "password")).ToArray()));
        var list = Postback(Ref(PasswordField, "password")); list["form"]![PasswordField] = new JsonArray("a", "b");
        Refused(ScCodes.BadRequest, list);
        var text = Postback(); text["secretRefs"] = Target;
        Refused(ScCodes.BadRequest, text);
        // A secretRef that carries anything but names is refused without repeating it.
        var carriesValue = Postback(new JsonObject { ["field"] = PasswordField, ["target"] = Target, ["part"] = "password", ["value"] = "typed-by-the-agent" });
        Assert.DoesNotContain("typed-by-the-agent", ScReply.Fail(Refused(ScCodes.BadRequest, carriesValue)));
        // Without secretRefs nothing changes: no refs, no vault read, the same form.
        var plain = ScWebRequest.Parse(Postback(), Host);
        Assert.Empty(plain.SecretRefs);
        var vault = Vault();
        Assert.Same(plain.Form, ScSecretRefs.Resolve(plain.SecretRefs, vault).Apply(plain.Form));
        Assert.Empty(vault.Reads);
    }

    [Theory]
    [InlineData("SSAM/O11/other.example/DatabaseConnection/SampleWarehouse", ScCodes.HostMismatch)]
    [InlineData("SSAM/O11/lab.example.evil.example/DB/Sales", ScCodes.HostMismatch)]
    [InlineData("SSAM/ODC3/lab.example/DB/Sales", ScCodes.HostMismatch)]
    [InlineData("lab.example/DB/Sales", ScCodes.HostMismatch)]
    [InlineData("SSAM/O11/lab.example", ScCodes.HostMismatch)]
    [InlineData("SSAM/O11/lab.example/ServiceCenter", ScCodes.NotAllowed)]
    [InlineData("SSAM/O11/LAB.example/servicestudio", ScCodes.NotAllowed)]
    [InlineData("SSAM/O11/lab.example/LifeTime", ScCodes.NotAllowed)]
    [InlineData("SSAM/O11/lab.example/", ScCodes.BadRequest)]
    [InlineData("SSAM/O11/lab.example/DB/../ServiceCenter", ScCodes.BadRequest)]
    [InlineData("SSAM/O11/lab.example/DB//Sales", ScCodes.BadRequest)]
    public void TargetsStayInThisEnvironmentAndNeverNameItsLogins(string target, string code)
    {
        var refusal = Refused(code, Postback(Ref(PasswordField, "password", target)));
        if (code == ScCodes.HostMismatch) Assert.Equal("secret_target_host", refusal.Details!["gate"]!.ToString());
    }

    [Fact]
    public void TargetsMatchTheHostIgnoringCase()
    {
        Assert.Equal("SSAM/O11/LAB.Example/DB/Sales", ScSecretRefs.Target("SSAM/O11/LAB.Example/DB/Sales", Host));
        Assert.Equal("ssam/o11/lab.example/DatabaseConnection/Sales", ScSecretRefs.Target("ssam/o11/lab.example/DatabaseConnection/Sales", Host));
    }

    [Fact]
    public void AMissingEntryIsSecretNotFoundNamingTheTargetAndNeverAValue()
    {
        var request = ScWebRequest.Parse(Postback(Ref(PasswordField, "password")), Host);
        var missing = Assert.Throws<ScFailure>(() => ScSecretRefs.Resolve(request.SecretRefs, new FakeVault(new())));
        Assert.Equal(ScCodes.SecretNotFound, missing.Code);
        Assert.False(missing.Sent);
        Assert.Contains(Target, missing.Message);
        var reply = JsonNode.Parse(ScReply.Fail(missing))!;
        Assert.Equal("SECRET_NOT_FOUND", reply["code"]!.ToString());
        Assert.False(reply["executed"]!.GetValue<bool>());
        Assert.Equal(Target, reply["data"]!["target"]!.ToString());
        Assert.Equal("password", reply["data"]!["part"]!.ToString());
        // An entry without the named part is missing too, and the part it has never shows.
        var noUser = new FakeVault(new(StringComparer.OrdinalIgnoreCase) { [Target] = new ScVaultEntry(null, Password) });
        var userRequest = ScWebRequest.Parse(Postback(Ref(UserField, "username")), Host);
        var partMissing = Assert.Throws<ScFailure>(() => ScSecretRefs.Resolve(userRequest.SecretRefs, noUser));
        Assert.Equal(ScCodes.SecretNotFound, partMissing.Code);
        Assert.DoesNotContain(Password, ScReply.Fail(partMissing));
    }

    [Fact]
    public void AVaultThatCannotBeReadStopsThePostbackWithoutItsMessage()
    {
        var broken = Vault();
        broken.Override = _ => throw new InvalidOperationException("native failure near " + Password);
        var request = ScWebRequest.Parse(Postback(Ref(PasswordField, "password")), Host);
        var failure = Assert.Throws<ScFailure>(() => ScSecretRefs.Resolve(request.SecretRefs, broken));
        Assert.Equal(ScCodes.StudioUnavailable, failure.Code);
        Assert.False(failure.Sent);
        Assert.DoesNotContain(Password, ScReply.Fail(failure));
    }

    // ---- the answer ----------------------------------------------------------------------------

    [Fact]
    public void TheAnswerLosesEveryEchoOfTheValuesAndItsFormState()
    {
        var injected = Injected(Ref(PasswordField, "password"), Ref(UserField, "username"));
        const string state = "U1NBTS1TWU5USEVUSUMtT1NWU1RBVEUvZGItdGVzdC1vaw==";
        var html = $"<input type=\"hidden\" name=\"__OSVSTATE\" id=\"__OSVSTATE\" value=\"{state}\" />" +
            "<input type=\"hidden\" name=\"__VIEWSTATEGENERATOR\" id=\"__VIEWSTATEGENERATOR\" value=\"A1B2C3D4\" />" +
            $"<input name=\"{UserField}\" type=\"text\" value=\"{User}\" />" +
            $"<input name=\"{PasswordField}\" type=\"password\" value=\"{WebUtility.HtmlEncode(Password)}\" />" +
            $"<span>Login failed for {WebUtility.HtmlEncode(Password)}</span>" +
            $"<script>var x={JsonSerializer.Serialize(Password)};var u='{User}';</script>" +
            $"<a href=\"Log.aspx?p={Uri.EscapeDataString(Password)}\">log</a>" +
            "<span>Connection test was successful.</span>" +
            $"<script>outsystems.internal.$('input[name=__OSVSTATE]').val('{state}');</script>";
        var body = ScWebResult.Fetch(Host, "POST", true, Page(html), injected);
        var text = body["html"]!.ToString();
        foreach (var form in new[] { Password, WebUtility.HtmlEncode(Password), JsonEncodedText.Encode(Password).ToString(), Uri.EscapeDataString(Password), User })
            Assert.DoesNotContain(form, text);
        Assert.DoesNotContain(state, text);
        Assert.Contains("value=\"A1B2C3D4\"", text);
        Assert.Contains("Connection test was successful.", text);
        Assert.Contains(ScRedaction.Mask, text);
        Assert.True(body["stateOmitted"]!.GetValue<bool>());
        Assert.True(body["echoMasked"]!.GetValue<bool>());
        Assert.Equal(2, body["injectedFields"]!.GetValue<int>());
        var reply = ScReply.Ok("studio-web", Host, null, 1, body);
        Assert.DoesNotContain(JsonEncodedText.Encode(Password).ToString(), reply);
        Assert.DoesNotContain(User, reply);
    }

    [Fact]
    public void AShortUserNameIsMaskedOnlyAsAWholeToken()
    {
        var vault = new FakeVault(new(StringComparer.OrdinalIgnoreCase) { [Target] = new ScVaultEntry("sa", Password) });
        var injected = ScSecretRefs.Resolve(ScWebRequest.Parse(Postback(Ref(UserField, "username")), Host).SecretRefs, vault);
        var body = ScWebResult.Fetch(Host, "POST", true, Page($"<input name=\"{UserField}\" type=\"text\" value=\"sa\" /><span>message saved as usual</span>"), injected);
        var text = body["html"]!.ToString();
        Assert.Contains("message saved as usual", text);
        Assert.Contains($"value=\"{ScRedaction.Mask}\"", text);
    }

    [Fact]
    public void AnEchoTheBridgeCannotMaskDropsTheWholeHtml()
    {
        var hex = string.Concat(Password.Select(c => $"&#x{(int)c:x};"));
        var body = ScWebResult.Fetch(Host, "POST", true, Page($"<span>{hex}</span>"), Injected(Ref(PasswordField, "password")));
        Assert.Null(body["html"]);
        Assert.NotNull(body["htmlOmitted"]);
    }

    [Fact]
    public void AnOsAjaxAnswerLosesItsStateToo()
    {
        const string state = "U1NBTS1TWU5USEVUSUMtT1NWU1RBVEUvZXh0ZW5zaW9uLWVkaXQtMjAyLXN0YWdlZA==";
        var body = ScWebResult.Fetch(Host, "POST", true, Page($"OsAjaxReply_v1([\"__OSVSTATE\",\"{state}\"],[]);"), Injected(Ref(PasswordField, "password")));
        Assert.Equal("OsAjaxReply_v1([\"__OSVSTATE\",\"\"],[]);", body["html"]!.ToString());
        Assert.True(body["stateOmitted"]!.GetValue<bool>());
        Assert.False(body["echoMasked"]!.GetValue<bool>());
    }

    [Fact]
    public void FailuresAfterTheSendNeverCarryAValue()
    {
        var injected = Injected(Ref(PasswordField, "password"));
        var uncertain = injected.Mask(ScReply.Uncertain("sc_web POST", new InvalidOperationException("script failed near '" + Password + "'"), null));
        Assert.Equal(ScCodes.Uncertain, uncertain.Code);
        Assert.True(uncertain.Sent);
        Assert.Equal("uncertain", uncertain.Details!["outcome"]!.ToString());
        Assert.DoesNotContain(Password, uncertain.Message);
        Assert.DoesNotContain(JsonEncodedText.Encode(Password).ToString(), ScReply.Fail(uncertain));
        // Bytes cannot be masked: a binary answer to a postback with vault values is dropped.
        var bytes = ScWebResult.Fetch(Host, "POST", true, Page(null, "UEsDBA=="), injected);
        Assert.Null(bytes["bodyBase64"]);
        Assert.NotNull(bytes["bodyOmitted"]);
    }

    [Fact]
    public void TheManifestAnnouncesSecretRefsAndOnlyTheVaultFileReadsTheVault()
    {
        var bridge = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(Source())!, "..", "..", "src", "Anvil.Bridge"));
        Assert.Contains("\"sc_web:secretRefs\"", File.ReadAllText(Path.Combine(bridge, "Dispatch.cs")));
        Assert.Equal(new[] { "ScVault.cs" }, Directory.GetFiles(bridge, "*.cs").Where(f => File.ReadAllText(f).Contains("CredReadW")).Select(Path.GetFileName));
    }

    // ---- helpers -------------------------------------------------------------------------------

    private static JsonObject Ref(string field, string part, string target = Target) => new() { ["field"] = field, ["target"] = target, ["part"] = part };

    /// <summary>The Test Connection postback of a new database connection (fixture dbconnection-test.request.json).</summary>
    private static JsonObject Postback(params JsonObject[] refs)
    {
        var request = new JsonObject
        {
            ["host"] = Host, ["action"] = "fetch", ["method"] = "POST", ["path"] = "DatabaseConnection_Edit.aspx", ["accept"] = "html",
            ["write"] = true, ["operationId"] = Guid.NewGuid().ToString(), ["authorizeSha256"] = Words,
            ["form"] = new JsonObject
            {
                ["__OSVSTATE"] = "U1NBTS1TWU5USEVUSUMtT1NWU1RBVEUvZGItbmV3", ["wt9$wtContentMain$wtConnection_Name"] = "SampleWarehouse",
                [UserField] = Placeholder, [PasswordField] = Placeholder, ["wt9$wtContentMain$wtTestConnectionButton"] = "Test Connection",
            },
        };
        if (refs.Length > 0) request["secretRefs"] = new JsonArray(refs.Select(r => (JsonNode)r.DeepClone()).ToArray());
        return request;
    }

    private static ScFailure Refused(string code, JsonObject request, string? gate = null)
    {
        var refusal = Assert.Throws<ScFailure>(() => ScWebRequest.Parse(request, Host));
        Assert.Equal(code, refusal.Code);
        Assert.False(refusal.Sent);
        if (gate != null) Assert.Equal(gate, refusal.Details!["gate"]!.ToString());
        return refusal;
    }

    private static FakeVault Vault() => new(new(StringComparer.OrdinalIgnoreCase) { [Target] = new ScVaultEntry(User, Password) });

    private static ScInjected Injected(params JsonObject[] refs) => ScSecretRefs.Resolve(ScWebRequest.Parse(Postback(refs), Host).SecretRefs, Vault());

    private static string Page(string? html, string? base64 = null)
    {
        var page = new JsonObject { ["status"] = 200, ["finalUrl"] = "https://lab.example/ServiceCenter/DatabaseConnection_Edit.aspx",
            ["contentType"] = "text/html; charset=utf-8", ["redirected"] = false };
        if (base64 != null) page["bodyBase64"] = base64;
        else page["html"] = html;
        return page.ToJsonString();
    }

    private static string Source([CallerFilePath] string path = "") => path;

    /// <summary>The vault by target name, ignoring case like the Windows vault; records each read.</summary>
    private sealed class FakeVault(Dictionary<string, ScVaultEntry> entries) : IScVault
    {
        public readonly List<string> Reads = [];
        public Func<string, ScVaultEntry?>? Override;

        public ScVaultEntry? Read(string target)
        {
            Reads.Add(target);
            return Override != null ? Override(target) : entries.GetValueOrDefault(target);
        }
    }
}
