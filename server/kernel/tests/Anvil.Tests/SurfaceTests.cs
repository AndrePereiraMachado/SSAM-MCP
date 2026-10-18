using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class SurfaceTests
{
    private static readonly string Root = JobRunner.RepoRoot(Directory.GetCurrentDirectory())!;
    private static JsonNode Node(object value) => JsonSerializer.SerializeToNode(value)!;

    [Fact]
    public void VerifyIdsAndHintsMatchTheInstalledPublicCatalog()
    {
        if (!File.Exists(Path.Combine(StudioAssemblies.DefaultDirectory, "ServiceStudio.Framework.dll"))) return;
        StudioAssemblies.Bind(null); // the catalog reads the installed DLL; when this test runs alone nothing bound it yet
        // O manifesto e do Studio INSTALADO, nao de uma versao fixa: cada atualizacao do Studio acrescenta ids
        // (11.55.87 trouxe InvalidFlow_UnreachableNode) e um numero no codigo transforma isso em falha permanente.
        var file = Path.Combine(Root, "catalog", $"verify-messages-{FunctionCatalog.StudioVersion}.json");
        Assert.True(File.Exists(file), $"catalog/verify-messages-{FunctionCatalog.StudioVersion}.json ausente: gere com `anvil verify-message --out catalog/verify-messages-<ver>.json`");
        var ids = JsonNode.Parse(File.ReadAllText(file))!.AsArray();
        Assert.All(ids, id => Assert.Single(id!.AsObject())); // metadata only, never vendor prose
        Assert.Equal(ids.Select(i => i!["id"]!.ToString()).Order(), VerifyCatalog.All.Select(m => m.Id).Order());
        var hints = VerifyHints.Read(Root);
        Assert.Equal(169, hints.Count);
        Assert.All(hints, h => Assert.Contains(VerifyCatalog.All, m => m.Id == h.Key));
        Assert.All(hints, h => Assert.False(h.Value.Origin.StartsWith("frase")));
        var message = Node(CommandSurface.VerifyMessages(VerifyCatalog.All, hints, "RequiredConnector_Out", true)).AsArray().Single()!;
        Assert.Equal("Error", message["severity"]!.ToString());
        Assert.False(string.IsNullOrWhiteSpace(message["detail"]!.ToString()));
        Assert.Contains("Ligar", message["hint"]!.ToString());
    }

    [Fact]
    public void InlineAdviceIsCuratedAndNeverRepeatsAnId()
    {
        var hints = VerifyHints.Read(Root);
        var items = new[] { new MessageInfo("RequiredConnector_Out", "Error", "a", "Action / Start", "detail"),
            new MessageInfo("RequiredConnector_Out", "Error", "b", "Other / Start", "detail"),
            new MessageInfo("NotCurated", "Error", "c", "Other / End", "detail") };
        Assert.Single(VerifyHints.Inline(items, hints));
        Assert.Empty(VerifyHints.Inline(items, new Dictionary<string, VerifyHint>()));
    }

    [Fact]
    public void MapsCoverEveryCurrentCreatableAndDistinguishRuntimeRestrictions()
    {
        var result = Node(CommandSurface.WhereCan(Root, Path.Combine(Root, "catalog/model-api-11.55.69.json"), "IServiceAction"));
        var runtimes = result["runtimes"]!.AsArray();
        Assert.StartsWith("created", runtimes.Single(r => r!["runtime"]!.ToString() == "Service")!["status"]!.ToString());
        Assert.All(runtimes.Where(r => r!["runtime"]!.ToString() != "Service"), r => Assert.Equal("not-allowed", r!["status"]!.ToString()));
        Assert.Contains("no proof", result["library"]!.ToString());
        Assert.Contains("it does not mean not-allowed", result["noParent"]!.ToString());
    }

    [Fact]
    public void CatalogHashIgnoresCheckoutLineEndingsButDetectsContentChanges()
    {
        byte[] Bytes(string s) => System.Text.Encoding.UTF8.GetBytes(s);
        Assert.Equal(CommandSurface.CatalogHash(Bytes("{\n}\n")), CommandSurface.CatalogHash(Bytes("{\r\n}\r\n")));
        Assert.NotEqual(CommandSurface.CatalogHash(Bytes("{\n}\n")), CommandSurface.CatalogHash(Bytes("{\n \n}\n")));
    }

    [Fact]
    public void StaleMapsAreRejectedEvenWhenTheFilenameIsUnchanged()
    {
        var work = Path.Combine(Root, ".local/lane-ss5/test-work/surface-stale", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(work, "docs/mapa"));
        var source = Path.Combine(Root, "docs/mapa/criar-blank-service.json");
        var map = JsonNode.Parse(File.ReadAllText(source))!;
        map["catalogSha256"] = "old";
        File.WriteAllText(Path.Combine(work, "docs/mapa/criar-blank-service.json"), map.ToJsonString());
        var error = Assert.Throws<InvalidOperationException>(() => CommandSurface.WhereCan(work, Path.Combine(Root, "catalog/model-api-11.55.69.json"), "IServiceAction"));
        Assert.Contains("stale map", error.Message);
    }

    [Fact]
    public void RecipesPointAtTestedJobsAndBoundCompositeOps()
    {
        var rows = Node(CommandSurface.Recipes(Root, "tickets-all", true, 3)).AsArray();
        var recipe = rows.Single(r => r!["name"]!.ToString() == "tickets-all")!;
        // 3131 until GetBreaches (tickets-07-read) joined its two sources as the Studio does (one filter became five join ops).
        Assert.Equal(3135, recipe["opCount"]!.GetValue<int>());
        Assert.Equal(recipe["rows"]!.AsArray().Count, recipe["rows"]!.AsArray().Select(r => r!.ToString()).Distinct().Count());
        Assert.True(recipe["truncated"]!.GetValue<bool>());
        Assert.Equal(3, recipe["ops"]!.AsArray().Count);
        Assert.True(rows.Sum(r => r!["ops"]!.AsArray().Count) <= 3);
        Assert.All(rows, r => Assert.True(File.Exists(Path.Combine(Root, r!["path"]!.ToString()))));
        Assert.Throws<ArgumentException>(() => CommandSurface.Recipes(Root, "tickets", true));
        Assert.Throws<ArgumentException>(() => CommandSurface.Recipes(Root, "tickets", true, 0));
        Assert.All(Node(CommandSurface.Recipes(Root, "")).AsArray(), r => Assert.False(string.IsNullOrWhiteSpace(r!["description"]!.ToString())));
    }

    [Fact]
    public void SchemaQueriesShareClosedCompilerKeys()
    {
        Assert.Contains("replace", CommandSurface.Schema("logic")["action"]!.AsArray().Select(k => k!.ToString()));
        Assert.Contains("params", CommandSurface.Schema("logic")["steps"]!["get"]!.AsArray().Select(k => k!.ToString()));
        Assert.Contains("clientEntities", CommandSurface.Schema("spec")["shapes"]!["data"]!.AsArray().Select(k => k!.ToString()));
        Assert.Contains("form", CommandSurface.Schema("screen")["kinds"]!.AsArray().Select(k => k!.ToString()));
        Assert.Contains("list", CommandSurface.Schema("html")["kinds"]!.AsArray().Select(k => k!.ToString()));
        Assert.Contains("table", CommandSurface.Schema("html")["tags"]!.AsArray().Select(k => k!.ToString()));
        // A forma VISUAL da op html tem sintaxe propria e sai pelo mesmo `api --op` (decisao D2 do WS4, feita pelo INT).
        Assert.Contains("parent", CommandSurface.Schema("html-visual")["shape"]!.AsObject().Select(p => p.Key));
        Assert.Equal(HtmlVisual.Schema().ToJsonString(), CommandSurface.Schema("html-visual").ToJsonString());
        Assert.Throws<ArgumentException>(() => CommandSurface.Schema("explain"));
        var error = Assert.Throws<InvalidOperationException>(() => SpecExpander.Expand(JsonNode.Parse("{\"entites\":[]}")!.AsObject()));
        Assert.Contains("allowed:", error.Message);
        // C21 (atritos 3): a structure attribute takes length and label as an entity attribute does; other keys stay closed.
        SpecExpander.Expand(JsonNode.Parse("{\"structures\":[{\"name\":\"S\",\"attributes\":[{\"name\":\"X\",\"length\":10,\"label\":\"Xis\"}]}]}")!.AsObject());
        Assert.Throws<InvalidOperationException>(() => SpecExpander.Expand(JsonNode.Parse("{\"structures\":[{\"name\":\"S\",\"attributes\":[{\"name\":\"X\",\"size\":10}]}]}")!.AsObject()));
    }

    /// <summary>
    /// The verb table is a projection of the dispatcher, not a second source: every verb it names is a private
    /// handler of ModelSession (the switch in ApplyOne calls Create/Set/Link/...), and the dispatched set is closed.
    /// A verb added to one side without the other fails here.
    /// </summary>
    [Fact]
    public void VerbSchemaNamesExactlyTheDispatchedVerbs()
    {
        // Reflecting over ModelSession loads the Studio assemblies its members reference: bind them first, and skip
        // where the installation is absent (the schema itself needs no Studio, only this pin does).
        if (!File.Exists(Path.Combine(StudioAssemblies.DefaultDirectory, "ServiceStudio.Framework.dll"))) return;
        StudioAssemblies.Bind(null);
        var schema = CommandSurface.Schema("verbs");
        var named = schema["verbs"]!.AsObject().Select(p => p.Key).Order().ToArray();
        var handlers = typeof(ModelSession).GetMethods(System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)
            .Where(m => m.ReturnType == typeof(JsonNode) && m.GetParameters() is [{ ParameterType: var t }] && t == typeof(JsonObject))
            .Select(m => m.Name.ToLowerInvariant()).ToHashSet();
        handlers.UnionWith(["get", "dump"]); // dispatched with a resolved target instead of the op object
        foreach (var verb in named) Assert.Contains(verb.Replace("-", ""), handlers); // rest-expose -> RestExpose
        foreach (var expected in new[] { "agent", "create", "set", "link", "move", "reference", "usages", "rename", "duplicate", "delete", "get", "find", "replace", "layout", "spec", "logic", "screen", "html", "dump", "rest", "rest-consume", "rest-expose", "soap", "prototype", "entity-actions" })
            Assert.Contains(expected, named);
        Assert.Equal(25, named.Length);
        Assert.Contains("parent", schema["verbs"]!["create"]!["required"]!.AsArray().Select(k => k!.ToString()));
        Assert.Contains("$pai/#Tipo[n]", schema["references"]!.AsObject().Select(p => p.Key));
        Assert.Contains("verbs", CommandSurface.OperationNames);
        Assert.Contains("verbs", Assert.Throws<ArgumentException>(() => CommandSurface.Schema("nope")).Message);
    }

    /// <summary>The table is the executed contract: the dispatcher refuses what it does not name, with the table in the message.</summary>
    [Fact]
    public void VerbContractIsEnforcedBeforeDispatch()
    {
        var unknownKey = Assert.Throws<InvalidOperationException>(() => VerbSurface.Check(JsonNode.Parse("{\"op\":\"create\",\"parent\":\"@espace\",\"type\":\"IServerAction\",\"nmae\":\"X\"}")!.AsObject()));
        Assert.Contains("unknown key(s) 'nmae'", unknownKey.Message);
        Assert.Contains("optional: name, args, as, source, empty", unknownKey.Message);
        var missing = Assert.Throws<InvalidOperationException>(() => VerbSurface.Check(JsonNode.Parse("{\"op\":\"set\",\"target\":\"$x\"}")!.AsObject()));
        Assert.Contains("missing 'prop'", missing.Message);
        var alternative = Assert.Throws<InvalidOperationException>(() => VerbSurface.Check(JsonNode.Parse("{\"op\":\"html\",\"file\":\"x.html\"}")!.AsObject()));
        Assert.Contains("one of parent, data", alternative.Message);
        Assert.Contains("ops:", Assert.Throws<InvalidOperationException>(() => VerbSurface.Check(JsonNode.Parse("{\"op\":\"explode\"}")!.AsObject())).Message);
        VerbSurface.Check(JsonNode.Parse("{\"op\":\"create\",\"parent\":\"@espace\",\"type\":\"IServerAction\",\"name\":\"X\",\"as\":\"$x\",\"_why\":\"annotations pass\"}")!.AsObject());
        VerbSurface.Check(JsonNode.Parse("{\"op\":\"html\",\"parent\":\"$scr\",\"file\":\"f.html\"}")!.AsObject());
        VerbSurface.Check(JsonNode.Parse("{\"op\":\"move\",\"target\":\"$a\",\"before\":\"$b\"}")!.AsObject());
        VerbSurface.Check(JsonNode.Parse("{\"op\":\"move\",\"target\":\"$a\",\"into\":\"$box\",\"first\":true}")!.AsObject());
        Assert.Contains("unknown key(s) 'parent'", Assert.Throws<InvalidOperationException>(() => VerbSurface.Check(JsonNode.Parse("{\"op\":\"move\",\"target\":\"$a\",\"parent\":\"$box\"}")!.AsObject())).Message);
    }

    /// <summary>Every op of every job in the suites passes the contract: the table covers what the jobs really use.</summary>
    [Fact]
    public void EveryJobOpOfEverySuitePassesTheVerbContract()
    {
        var folders = new[] { "jobs", "jobs-negative", "jobs-odc", "jobs-odc-negative", "jobs-cold", "jobs-live" };
        var checkedOps = 0;
        foreach (var folder in folders)
        {
            var dir = Path.Combine(Root, "tests", folder);
            if (!Directory.Exists(dir)) continue;
            foreach (var file in Directory.GetFiles(dir, "*.json", SearchOption.AllDirectories))
            {
                JsonObject job;
                try { job = JsonNode.Parse(File.ReadAllText(file))!.AsObject(); } catch { continue; }
                foreach (var op in job["ops"]?.AsArray().OfType<JsonObject>() ?? [])
                {
                    if (op["op"] == null) continue;
                    try { VerbSurface.Check(op); checkedOps++; }
                    catch (InvalidOperationException e) { Assert.Fail($"{folder}/{Path.GetFileName(file)}: {e.Message}"); }
                }
            }
        }
        Assert.True(checkedOps > 10000, "ops checked: " + checkedOps);
    }

    /// <summary>
    /// The table (what the validator accepts) and the handlers (what the code reads) are the same key sets: this test
    /// scans the handler sources for the keys they read from the op object and compares them with VerbSurface, verb by
    /// verb. A key read by a handler but absent from the table would be unreachable (Check refuses it before dispatch);
    /// a key declared but never read would be accepted and silently ignored. Either drift fails here, by name.
    /// Known and intended exception: Create reads `replace` only to refuse it with a hint; the table does not declare it.
    /// </summary>
    [Fact]
    public void HandlerKeyReadsMatchTheVerbTable()
    {
        var kernel = Path.Combine(Root, "src", "Anvil.Core", "Kernel");
        var sources = string.Join("\n", new[] { "Verbs.cs", "HtmlDelta.cs", "HtmlVisual.cs", "Reparent.cs", "AgentExpander.cs", "Verbs.Prototype.cs", "Verbs.EntityActions.cs" }.Select(f => File.ReadAllText(Path.Combine(kernel, f))));
        // Any method that takes the op object (handlers return JsonNode; the html helpers return string/void).
        var handlerStart = new System.Text.RegularExpressions.Regex(@"\b(?:JsonNode\??|string|void|bool)\s+([A-Z][A-Za-z]*)\(JsonObject op(?:,[^)]*)?\)", System.Text.RegularExpressions.RegexOptions.Compiled);
        var readers = new[] { @"op\[""([A-Za-z_]+)""\]", @"Req\(op,\s*""([A-Za-z_]+)""\)", @"op\.ContainsKey\(""([A-Za-z_]+)""\)", @"op\.TryGetPropertyValue\(""([A-Za-z_]+)""" }
            .Select(p => new System.Text.RegularExpressions.Regex(p)).ToArray();
        var starts = handlerStart.Matches(sources).Select(m => (Name: m.Groups[1].Value, At: m.Index)).ToList();
        HashSet<string> ReadsOf(string handler)
        {
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (name, at) in starts.Where(s => s.Name == handler))
            {
                var next = starts.Where(s => s.At > at).Select(s => s.At).DefaultIfEmpty(sources.Length).Min();
                var body = sources.Substring(at, next - at);
                foreach (var r in readers) foreach (System.Text.RegularExpressions.Match k in r.Matches(body)) if (k.Groups[1].Value != "op") keys.Add(k.Groups[1].Value);
            }
            return keys;
        }
        // get and dump are dispatched inline in ApplyOne with a resolved target: their reads are on the switch lines.
        var applyOne = sources.Substring(sources.IndexOf("public JsonNode? ApplyOne(JsonObject op)", StringComparison.Ordinal));
        applyOne = applyOne.Substring(0, applyOne.IndexOf("Anotar(kind, op, result)", StringComparison.Ordinal));
        var inline = new Dictionary<string, HashSet<string>>
        {
            ["get"] = ["target"],
            ["dump"] = ["target", "depth"],
        };
        Assert.Contains("\"get\" => Get(Resolve(Req(op, \"target\")))", applyOne);
        Assert.Contains("\"dump\" => Dump(Resolve(Req(op, \"target\")), op[\"depth\"]", applyOne);
        var allowedUndeclared = new Dictionary<string, string[]> { ["create"] = ["replace"] }; // refused-with-hint keys, never accepted
        var problems = new List<string>();
        foreach (var verb in VerbSurface.Verbs)
        {
            var declared = verb.Required.SelectMany(g => g.Split('|')).Concat(verb.Optional).ToHashSet(StringComparer.Ordinal);
            var handler = string.Concat(verb.Verb.Split('-').Select(part => char.ToUpperInvariant(part[0]) + part[1..])); // rest-expose -> RestExpose
            var read = inline.TryGetValue(verb.Verb, out var fixedReads) ? fixedReads : ReadsOf(handler);
            // The html handler splits into the page form (HtmlDelta.Html: data) and the visual form (ApplyHtmlVisual: parent;
            // HtmlVisual.Source/PreflightOp: file, html).
            if (verb.Verb == "html") foreach (var helper in new[] { "ApplyHtmlVisual", "Source", "PreflightOp" }) read.UnionWith(ReadsOf(helper));
            // The move handler splits into the reorder (Reorder: first/last/before/after) and the parent change
            // (Reparent.cs MoveInto: into, x/y refused; HasDirection: the position in the new parent).
            if (verb.Verb == "move") foreach (var helper in new[] { "Reorder", "MoveInto", "HasDirection" }) read.UnionWith(ReadsOf(helper));
            // The create handler is Create(op) => CreateCore(op, nativeNameProbe) (the native name probe of the job preflight).
            if (verb.Verb == "create") read.UnionWith(ReadsOf("CreateCore"));
            Assert.True(read.Count > 0, $"{verb.Verb}: no handler reads found (source scan broke: handler renamed?)");
            var undeclared = read.Except(declared).Except(allowedUndeclared.GetValueOrDefault(verb.Verb, [])).ToList();
            var unread = declared.Except(read).ToList();
            if (undeclared.Count > 0) problems.Add($"{verb.Verb}: handler reads undeclared key(s) {string.Join(", ", undeclared)} (unreachable: add to VerbSurface or remove the read)");
            if (unread.Count > 0) problems.Add($"{verb.Verb}: table declares key(s) {string.Join(", ", unread)} no handler reads (accepted and ignored: remove from VerbSurface or implement)");
        }
        Assert.True(problems.Count == 0, string.Join("\n", problems));
    }

    [Fact]
    public void StaticRecordsAcceptOnlyDeclaredCustomAttributeNames()
    {
        var data = JsonNode.Parse("{\"static\":[{\"name\":\"Status\",\"attributes\":[{\"name\":\"Code\"}],\"records\":[{\"name\":\"Open\",\"Code\":\"\\\"O\\\"\"}]}]}")!.AsObject();
        Assert.NotEmpty(SpecExpander.Expand(data));
        data["static"]![0]!["records"]![0]!["Cdoe"] = "typo";
        Assert.Contains("Cdoe", Assert.Throws<InvalidOperationException>(() => SpecExpander.Expand(data)).Message);
    }
}
