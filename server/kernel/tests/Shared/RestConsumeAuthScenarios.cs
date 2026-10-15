using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Linked into both test projects: rest-consume for authenticated and customized APIs (RestConsume.Auth.cs), offline on the
/// lane's blank fixture. Nothing here reaches an API (no runtime is reachable offline): the proof is the Verify, the read-back
/// of the generated callbacks as ssam-flow text, the settings and REST parameters read back from the module, the fixed point
/// (the same ops again change nothing), the removal of what an auth that changed no longer needs, and one refusal with every
/// problem of the data. Every auth mode: bearer (with client headers, the base URL setting, a correlation header, mapped
/// statuses, header inputs, optional inputs, a timeout and the model's own steps in both callbacks), basic, API key in a
/// header, API key in the query, OAuth 2.0 client credentials. Basic on O11 encodes user:password at runtime with the system
/// extension BinaryData: the job references TextToBinaryData and BinaryToBase64 (the facade appends that op; a delivery
/// captures the producer), bound here to tests/fixtures/rest-consume/producers/BinaryData.avsig, an attested capture of the
/// extension (signature 3cd1d5d5, the elements of two captures of the same signature in one file).
/// </summary>
public static class RestConsumeAuthScenarios
{
    private static string Lane(string fixture) => fixture.Contains("odc", StringComparison.OrdinalIgnoreCase) ? "odc" : "o11";

    /// <summary>The ops of AuthOps as the delivery runs them on the lane: on O11 the facade appends the BinaryData reference
    /// that basic needs (the kernel hoists a frozen reference before the edit).</summary>
    public static JsonArray AuthOps(string lane)
    {
        var ops = AuthOps();
        if (lane == "o11") ops.Add(RestConsume.BinaryDataReference());
        return ops;
    }

    /// <summary>The producer bindings of a lane's auth jobs (O11: the BinaryData capture).</summary>
    public static IReadOnlyDictionary<string, string>? Bindings(string lane)
        => lane == "o11" ? new Dictionary<string, string> { [RestConsume.BinaryDataProducer] = RestConsumeScenarios.Fixture("rest-consume/producers/BinaryData.avsig") } : null;

    private static List<JsonObject> Gets(JsonNode result) => result["results"]!.AsArray().OfType<JsonObject>().Where(r => r["op"]?.ToString() == "get").Select(r => r["result"]!.AsObject()).ToList();

    /// <summary>One op per auth mode, as a model writes them (with the samples the facade cannot read without credentials).</summary>
    public static JsonArray AuthOps() => JsonNode.Parse("""
        [
         {"op":"rest-consume","data":{"name":"Acme","auth":{"type":"bearer"},"headers":{"Accept":"application/json","X-Client":"ssam"},
           "settings":{"baseUrl":true},"timeout":20,"correlationHeader":"X-Correlation-Id",
           "errors":{"status":{"404":"AcmeNotFound","429":"AcmeRateLimited"}},
           "callbacks":{"before":{"steps":[{"assign":{"Header.Name":"\"X-Request-Time\"","Header.Value":"DateTimeToText(CurrDateTime())"},"label":"Build the request time header"},
                                           {"call":"ListAppend","as":"AddRequestTime","args":{"List":"CustomizedRequest.Headers","Element":"Header"}}]},
                        "after":{"steps":[{"assign":{"CustomizedResponse.ResponseText":"Trim(Response.ResponseText)"},"label":"Trim the body"}]}},
           "methods":[
            {"name":"GetOrder","url":"https://api.acme.example/v1/orders/{id=1}?expand={expand=items}","headers":{"X-Tenant":"{tenant=t1}","X-Version":"2"},
             "optional":["tenant","expand"],"sample":{"id":1,"status":"open","total":10.5,"paid":false}},
            {"name":"CreateOrder","verb":"POST","url":"https://api.acme.example/v1/orders","request":{"customer":"c1","total":10.5},"sample":{"id":2,"status":"open"}}]}},
         {"op":"rest-consume","data":{"name":"Basicky","auth":{"type":"basic"},"methods":[{"name":"Ping","url":"https://basic.example/api/ping","sample":{"ok":true}}]}},
         {"op":"rest-consume","data":{"name":"KeyH","auth":{"type":"apiKey","name":"X-Key"},"methods":[{"name":"Items","url":"https://keyh.example/api/items","sample":[{"id":1,"name":"a"}]}]}},
         {"op":"rest-consume","data":{"name":"KeyQ","auth":{"type":"apiKey","in":"query","name":"appid"},"methods":[{"name":"Weather","url":"https://keyq.example/data/weather?q={q=London}","sample":{"temp":12.5,"city":"London"}}]}},
         {"op":"rest-consume","data":{"name":"Oauth","auth":{"type":"oauth2","tokenUrl":"https://auth.oauth.example/oauth2/token","scope":"read write","cacheMinutes":30},
           "methods":[{"name":"Accounts","url":"https://api.oauth.example/v2/accounts","sample":[{"id":"a1","balance":3.5}]}]}}
        ]
        """)!.AsArray();

    private static List<JsonObject> Reports(JsonNode result) => result["integration"]!.AsArray().OfType<JsonObject>().ToList();
    private static JsonObject Report(JsonNode result, string client) => Reports(result).Single(r => r["client"]!["name"]!.ToString() == client);
    private static List<string> Strings(JsonNode? node) => node?.AsArray().Select(n => n!.ToString()).ToList() ?? [];

    private static void Valid(JsonNode result)
    {
        Assert.True(result["accepted"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        Assert.True(result["isValid"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        Assert.DoesNotContain(result["validation"]!["new"]!.AsArray().OfType<JsonObject>(), m => m["type"]?.ToString() == "Error");
    }

    private static JsonObject Props(JsonNode result, int read) => Gets(result)[read]["properties"]!.AsObject();

    /// <summary>Every auth mode applies in one job, the Verify accepts it, the module reads back as planned (callbacks as
    /// text, settings empty and secret, header inputs, the token cache), and the same ops again change nothing.</summary>
    public static void EveryAuthModeAppliesVerifiesAndReadsBack(string dir, string fixture)
    {
        var lane = Lane(fixture);
        var site = lane == "odc" ? "Settings." : "Site.";
        // A later op of the same job reads what the generator writes by its planned names (the job text never spells them).
        var ops = AuthOps(lane);
        ops.Add(new JsonObject { ["op"] = "get", ["target"] = "IServiceAction:GetAcmeOrder" });
        ops.Add(new JsonObject { ["op"] = "get", ["target"] = "ISiteProperty:AcmeToken" });
        var first = RestConsumeScenarios.Run(dir, "rca-all", ops, fixture, bindings: Bindings(lane));
        Assert.Equal(["GetAcmeOrder", "AcmeToken"], Gets(first).Select(g => g["name"]!.ToString()));
        var oml = Path.Combine(dir, "rca-all.oml");
        Valid(first);
        Assert.Equal(5, Reports(first).Count);
        Assert.All(Reports(first), r => Assert.True(r["changed"]!.GetValue<bool>()));

        // The receipt: what the user fills (names and places, never a value), the callbacks, the token, the statuses.
        var acme = Report(first, "Acme");
        var configure = acme["configure"]!.AsArray().OfType<JsonObject>().ToDictionary(c => c["name"]!.ToString());
        Assert.Equal(["AcmeBaseUrl", "AcmeToken"], configure.Keys.Order());
        Assert.True(configure["AcmeToken"]["secret"]!.GetValue<bool>());
        Assert.False(configure["AcmeBaseUrl"]["secret"]!.GetValue<bool>());
        Assert.Equal("https://api.acme.example/v1", configure["AcmeBaseUrl"]["default"]!.ToString());
        Assert.Contains(lane == "odc" ? "ODC Portal" : "Service Center", configure["AcmeToken"]["where"]!.ToString());
        Assert.Equal("bearer", acme["generated"]!["auth"]!.ToString());
        Assert.Equal(["Acme.OnBeforeRequest", "Acme.OnAfterResponse"], Strings(acme["generated"]!["callbacks"]));
        Assert.Equal("AcmeNotFound", acme["generated"]!["status"]!["404"]!.ToString());
        var getOrder = acme["generated"]!["methods"]!.AsArray().OfType<JsonObject>().Single(m => m["method"]!.ToString() == "GetOrder");
        Assert.Equal("GetAcmeOrder(Id: Integer, Expand: Text? = \"items\", Tenant: Text? = \"t1\", CorrelationId: Text?) -> Result: Order", getOrder["action"]!["signature"]!.ToString());
        Assert.Equal("2", getOrder["headers"]!["X-Version"]!.ToString());
        // Basic: O11 keeps the user and the password, each secret, and encodes them at runtime; ODC keeps their Base64.
        var basic = Report(first, "Basicky")["configure"]!.AsArray().OfType<JsonObject>().ToList();
        Assert.Equal(lane == "o11" ? ["BasickyUsername", "BasickyPassword"] : ["BasickyBasicCredentials"], basic.Select(c => c["name"]!.ToString()));
        Assert.All(basic, c => Assert.True(c["secret"]!.GetValue<bool>()));
        Assert.Equal(["KeyHApiKey"], Report(first, "KeyH")["configure"]!.AsArray().Select(c => c!["name"]!.ToString()));
        var oauth = Report(first, "Oauth");
        Assert.Equal(["OauthClientId", "OauthClientSecret"], oauth["configure"]!.AsArray().Select(c => c!["name"]!.ToString()));
        Assert.Equal("GetOauthAccessToken", oauth["generated"]!["token"]!["action"]!.ToString());
        Assert.Contains("IRestClient:OauthAuth", Strings(oauth["imported"]));

        // Fixed point: the same ops on the result change nothing (same objects, nothing imported or updated); the same job reads
        // the module: no credential in the client (AuthenticationType None, no user/password), the settings empty and secret,
        // the base URL setting with the design URL, the header inputs (name in the request, not sent when optional), the
        // method's timeout, the token cached.
        var again = AuthOps(lane);
        const int at = 0; // the reads, in the order of the get ops
        foreach (var target in new[] { "IRestClient:Acme", "ISiteProperty:AcmeToken", "ISiteProperty:AcmeBaseUrl", "IServerAction:GetOauthAccessToken",
            "IRestClient:Acme/GetOrder/tenant", "IRestClient:Acme/GetOrder/XVersion", "IRestClient:Acme/GetOrder" })
            again.Add(new JsonObject { ["op"] = "get", ["target"] = target });
        var second = RestConsumeScenarios.Run(dir, "rca-all-again", again, fixture, oml, Bindings(lane));
        Valid(second);
        Assert.All(Reports(second), r => Assert.False(r["changed"]!.GetValue<bool>(), r.ToJsonString()));
        Assert.All(Reports(second), r => Assert.Empty(r["imported"]!.AsArray()));
        Assert.All(Reports(second), r => Assert.Empty(r["updated"]!.AsArray()));
        Assert.Equal(first["objects"]!.GetValue<int>(), second["objects"]!.GetValue<int>());
        var client = Props(second, at);
        Assert.Equal("None", client["AuthenticationType"]!.ToString());
        Assert.Null(client["Username"]); Assert.Null(client["Password"]); Assert.Null(client["ClientSecret"]);
        Assert.NotNull(client["OnBeforeRequestCallback"]); Assert.NotNull(client["OnAfterResponseCallback"]);
        var token = Props(second, at + 1);
        Assert.Equal("True", token["IsSecret"]!.ToString());
        Assert.True(string.IsNullOrEmpty(token["DefaultValue"]?.ToString()));
        Assert.Contains("https://api.acme.example/v1", Props(second, at + 2)["DefaultValue"]!.ToString());
        Assert.Equal("30", Props(second, at + 3)["CacheInMinutes"]!.ToString());
        var tenant = Props(second, at + 4);
        Assert.Equal("X-Tenant", tenant["OriginalName"]!.ToString());
        Assert.Equal("HeaderPlacement", tenant["InputPlacement"]!.ToString());
        Assert.Equal("DontSend", tenant["DefaultValueBehavior"]!.ToString());
        Assert.Equal("False", tenant["IsMandatory"]!.ToString());
        Assert.Equal("X-Version", Props(second, at + 5)["OriginalName"]!.ToString());
        Assert.Equal("20", Props(second, at + 6)["TimeoutinSeconds"]!.ToString());

        // The callbacks read back as ssam-flow text: the recipe of each auth mode, then the model's own steps.
        var host = new ModelHost(Path.Combine(dir, "work-readback"));
        var acmeText = host.RestCallbackTexts(oml, "Acme");
        var before = acmeText["OnBeforeRequest"];
        var after = acmeText["OnAfterResponse"];
        File.WriteAllText(Path.Combine(dir, "rca-all.callbacks.txt"), before + "\n" + after);
        foreach (var expected in new[] { $"\"Bearer \" + {site}AcmeToken", $"If({site}AcmeBaseUrl = \"\", Request.BaseURL, {site}AcmeBaseUrl)", "\"Accept\"", "\"application/json\"",
            "\"X-Client\"", "AddAuthorizationHeader", "AddAcceptHeader", "AddXClientHeader", "AddRequestTime", "\"X-Request-Time\"" })
            Assert.Contains(expected, before);
        Assert.True(before.IndexOf("AddAuthorizationHeader", StringComparison.Ordinal) < before.IndexOf("AddRequestTime", StringComparison.Ordinal), before);
        foreach (var expected in new[] { "Response.StatusCode = 404", "raise AcmeNotFound", "Response.StatusCode = 429", "raise AcmeRateLimited", "Response.StatusCode >= 400", "raise AcmeError",
            "Substr(Response.ResponseText, 0, 300)", "Trim(Response.ResponseText)" })
            Assert.Contains(expected, after);
        var basicBefore = host.RestCallbackTexts(oml, "Basicky")["OnBeforeRequest"];
        if (lane == "o11")
            foreach (var expected in new[] { "TextToBinaryData", "BinaryToBase64", $"{site}BasickyUsername + \":\" + {site}BasickyPassword", "\"utf-8\"", "\"Basic \" + Base64Credentials.Base64" })
                Assert.Contains(expected, basicBefore);
        else Assert.Contains($"\"Basic \" + {site}BasickyBasicCredentials", basicBefore);
        var keyH = host.RestCallbackTexts(oml, "KeyH")["OnBeforeRequest"];
        Assert.Contains("\"X-Key\"", keyH); Assert.Contains($"{site}KeyHApiKey", keyH);
        var keyQ = host.RestCallbackTexts(oml, "KeyQ")["OnBeforeRequest"];
        Assert.Contains("CustomizedRequest.URLQueryParameters", keyQ); Assert.Contains("\"appid\"", keyQ); Assert.Contains($"{site}KeyQApiKey", keyQ);
        var oauthBefore = host.RestCallbackTexts(oml, "Oauth")["OnBeforeRequest"];
        Assert.Contains("GetOauthAccessToken", oauthBefore); Assert.Contains("\"Bearer \" + GetAccessToken.AccessToken", oauthBefore);
        Assert.Empty(host.RestCallbackTexts(oml, "OauthAuth"));   // the token client has no callback: its request carries no token
    }

    /// <summary>An auth that changes or goes takes with it what this op wrote for it and no longer plans (callbacks, token
    /// client and action, settings, header inputs); the Verify stays clean and the rerun changes nothing.</summary>
    public static void AnAuthThatChangesRemovesWhatItNoLongerNeeds(string dir, string fixture)
    {
        var first = RestConsumeScenarios.Run(dir, "rca-before", AuthOps(Lane(fixture)), fixture, bindings: Bindings(Lane(fixture)));
        Valid(first);
        var ops = JsonNode.Parse("""
            [
             {"op":"rest-consume","data":{"name":"Acme","methods":[
                {"name":"GetOrder","url":"https://api.acme.example/v1/orders/{id=1}?expand={expand=items}","sample":{"id":1,"status":"open","total":10.5,"paid":false}},
                {"name":"CreateOrder","verb":"POST","url":"https://api.acme.example/v1/orders","request":{"customer":"c1","total":10.5},"sample":{"id":2,"status":"open"}}]}},
             {"op":"rest-consume","data":{"name":"Oauth","auth":{"type":"bearer"},"methods":[{"name":"Accounts","url":"https://api.oauth.example/v2/accounts","sample":[{"id":"a1","balance":3.5}]}]}}
            ]
            """)!.AsArray();
        var second = RestConsumeScenarios.Run(dir, "rca-after", ops, fixture, Path.Combine(dir, "rca-before.oml"));
        Valid(second);
        var acme = Strings(Report(second, "Acme")["removed"]);
        foreach (var gone in new[] { "IRestCallbackActionFlow:OnBeforeRequest", "IRestCallbackActionFlow:OnAfterResponse", "ISiteProperty:AcmeBaseUrl", "ISiteProperty:AcmeToken",
            "IRestActionInput:GetOrder.tenant", "IRestActionInput:GetOrder.XVersion", "IRestActionInput:GetOrder.CorrelationId" })
            Assert.Contains(gone, acme);
        Assert.Null(Report(second, "Acme")["configure"]);
        var oauth = Report(second, "Oauth");
        foreach (var gone in new[] { "IServerAction:GetOauthAccessToken", "IRestClient:OauthAuth", "ISiteProperty:OauthClientId", "ISiteProperty:OauthClientSecret" })
            Assert.Contains(gone, Strings(oauth["removed"]));
        Assert.Contains("ISiteProperty:OauthToken", Strings(oauth["imported"]));
        Assert.Contains("IRestCallbackActionFlow:OnBeforeRequest", Strings(oauth["updated"]));
        Assert.Empty(new ModelHost(Path.Combine(dir, "work-readback")).RestCallbackTexts(Path.Combine(dir, "rca-after.oml"), "Acme"));
        var third = RestConsumeScenarios.Run(dir, "rca-after-again", ops, fixture, Path.Combine(dir, "rca-after.oml"));
        Valid(third);
        Assert.All(Reports(third), r => Assert.False(r["changed"]!.GetValue<bool>(), r.ToJsonString()));
    }

    /// <summary>Every problem of the auth and customization data in one refusal, before anything is written.</summary>
    public static void EveryAuthProblemIsOneRefusal(string dir, string fixture)
    {
        var ops = new JsonArray(JsonNode.Parse("""
            {"op":"rest-consume","data":{"name":"Bad","auth":{"type":"oauth2","clientSecret":"s3cr3t","tokenUrl":"http://auth.example/token"},
              "headers":{"Authorization":"Bearer abc","X-Ok":"{p}"},"settings":{"baseUrl":"yes"},"timeout":-1,"correlationHeader":"Bad Header",
              "callbacks":{"before":{"steps":[]},"during":{}},"errors":{"status":{"200":"Fine","404":"Not Found"}},
              "methods":[{"name":"GetX","url":"https://a.example/x/{id}","headers":{"X-T":"{id}"},"optional":["id","zz"]}]}}
            """));
        var error = Assert.ThrowsAny<Exception>(() => RestConsumeScenarios.Run(dir, "rca-refused", ops, fixture));
        var problems = (Errors.FindCoded(error)?.Problems ?? new JsonArray()).OfType<JsonObject>().ToList();
        var codes = problems.Select(p => p["code"]!.ToString()).ToList();
        Assert.True(codes.Count > 0, Errors.Text(error));
        foreach (var code in new[] { "REST_CREDENTIALS_NOT_IN_MODEL", "REST_CONSUME_KEY_INVALID", "REST_CONSUME_UNKNOWN_KEYS", "REST_CONSUME_DUPLICATE_NAME", "REST_CONSUME_SAMPLE_MISSING" })
            Assert.Contains(code, codes);
        // The credential of auth and the one of the header, each with its place; the sample the sampler cannot read.
        Assert.Equal(2, problems.Count(p => p["code"]!.ToString() == "REST_CREDENTIALS_NOT_IN_MODEL"));
        Assert.Contains(problems, p => p["code"]!.ToString() == "REST_CONSUME_SAMPLE_MISSING" && p["message"]!.ToString().Contains("authenticated"));
        foreach (var path in new[] { "/data/auth/tokenUrl", "/data/headers/X-Ok", "/data/settings/baseUrl", "/data/timeout", "/data/correlationHeader", "/data/callbacks/during",
            "/data/callbacks/before/steps", "/data/errors/status/200", "/data/errors/status/404", "/data/methods/0/optional/0", "/data/methods/0/optional/1" })
            Assert.Contains(problems, p => (p["path"] ?? p["pointer"])?.ToString()?.EndsWith(path, StringComparison.Ordinal) == true);
        Assert.False(File.Exists(Path.Combine(dir, "rca-refused.oml")));
    }

    /// <summary>Basic on O11 needs the BinaryData reference: without it one refusal before anything is written, with the op that
    /// adds it; with it (appended, as the facade does) the same op applies. ODC keeps the Base64 setting and needs none.</summary>
    public static void BasicAuthNeedsBinaryDataOnO11(string dir, string fixture)
    {
        var lane = Lane(fixture);
        var ops = new JsonArray(JsonNode.Parse("""{"op":"rest-consume","data":{"name":"Basicky","auth":{"type":"basic"},"methods":[{"name":"Ping","url":"https://basic.example/api/ping","sample":{"ok":true}}]}}"""));
        if (lane == "o11")
        {
            var error = Assert.ThrowsAny<Exception>(() => RestConsumeScenarios.Run(dir, "rca-basic-bare", ops, fixture));
            var problems = (Errors.FindCoded(error)?.Problems ?? new JsonArray()).OfType<JsonObject>().ToList();
            var missing = Assert.Single(problems, p => p["code"]!.ToString() == "REST_CONSUME_REFERENCE_MISSING");
            Assert.Contains("BinaryData", missing.ToJsonString());
            Assert.False(File.Exists(Path.Combine(dir, "rca-basic-bare.oml")));
            ops.Add(RestConsume.BinaryDataReference());
        }
        var result = RestConsumeScenarios.Run(dir, "rca-basic", ops, fixture, bindings: Bindings(lane));
        Valid(result);
        Assert.Equal(lane == "o11" ? ["BasickyUsername", "BasickyPassword"] : ["BasickyBasicCredentials"],
            Report(result, "Basicky")["configure"]!.AsArray().Select(c => c!["name"]!.ToString()));
        var again = RestConsumeScenarios.Run(dir, "rca-basic-again", ops, fixture, Path.Combine(dir, "rca-basic.oml"), Bindings(lane));
        Valid(again);
        Assert.False(Report(again, "Basicky")["changed"]!.GetValue<bool>());
    }

    /// <summary>A callback of the client that this op did not write is never replaced: one refusal with the way out.</summary>
    public static void ACallbackTheOpDidNotWriteIsRefused(string dir, string fixture)
    {
        var plain = JsonNode.Parse("""{"op":"rest-consume","data":{"name":"Fx","methods":[{"name":"Latest","url":"https://api.frankfurter.app/latest?from=BRL","sample":{"amount":1,"base":"BRL"}}]}}""")!;
        var ops = new JsonArray(plain.DeepClone(),
            JsonNode.Parse("""{"op":"create","parent":"IRestClient:Fx","type":"IRestCallbackActionFlow","name":"OnBeforeRequest"}"""),
            JsonNode.Parse("""{"op":"rest-consume","data":{"name":"Fx","auth":{"type":"bearer"},"methods":[{"name":"Latest","url":"https://api.frankfurter.app/latest?from=BRL","sample":{"amount":1,"base":"BRL"}}]}}"""));
        var error = Assert.ThrowsAny<Exception>(() => RestConsumeScenarios.Run(dir, "rca-foreign", ops, fixture));
        var problems = (Errors.FindCoded(error)?.Problems ?? new JsonArray()).OfType<JsonObject>().ToList();
        Assert.Contains(problems, p => p["code"]!.ToString() == "REST_CONSUME_CALLBACK_NOT_OWN");
    }
}
