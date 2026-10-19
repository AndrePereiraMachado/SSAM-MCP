using System.Collections;
using System.Diagnostics;
using System.Reflection;
using System.Security;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>Samples corrections, while checking expression recognition in every available capture of the lane.</summary>
public sealed class PatchCertaintyCorpusTests(ITestOutputHelper output)
{
    private static string Lane => typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc") != null ? "odc" : "o11";
    private static string Kernel => Path.Combine(TextRoundTripCorpus.Root()!, "kernel");
    private static string Work => Path.Combine(Kernel, ".local", "patch-certainty-corpus", Lane);
    private static object? Property(object? target, string name) => target == null ? null : ModelHost.Prop(target, name);
    private static string? Expression(object? value) => value == null ? null : value.GetType().GetInterfaces().Any(i => i.Name == "IExpression") ? Property(value, "Text")?.ToString() : value as string;
    private static IEnumerable<object> Children(object node) => (Property(node, "Children") as IEnumerable)?.Cast<object>() ?? [];
    private static IEnumerable<object> Walk(object node)
    {
        yield return node;
        foreach (var child in Children(node)) {
            if (child.GetType().GetInterfaces().Any(t => t.Name == "IReference")) continue;
            foreach (var descendant in Walk(child)) yield return descendant;
        }
    }
    private static object RootOf(ModelSession session) => typeof(ModelSession).GetField("_espace", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(session)!;
    private static void Bind()
    {
        var binder = typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc") ?? typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssemblies")!;
        var method = binder.GetMethods().First(m => m.Name == "Bind");
        method.Invoke(null, method.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
    }

    // The ODC app kind forbids public server actions; use a real native library for those naming/exposure tests.
    // The shared test compiles against both lanes, so the ODC-only factory is discovered after binding the model.
    private static string ActionFixture(string directory, string role)
    {
        if (Lane != "odc") return Path.Combine(Kernel, "tests", "fixtures", role == "Producer" ? "blank-service.oml" : "reactive-ui.oml");
        var path = Path.Combine(directory, role.ToLowerInvariant() + "-library.oml");
        var factory = typeof(ModelHost).Assembly.GetType("Anvil.Core.OdcBlankModule")!;
        var receipt = (JsonObject)factory.GetMethod("Create")!.Invoke(null,
            new object?[] { new ModelHost(Path.Combine(directory, "library-" + role)), "ReactiveLibrary", "Certainty" + role + Guid.NewGuid().ToString("N")[..8], path, null })!;
        Assert.True(receipt["isValid"]!.GetValue<bool>(), receipt.ToJsonString());
        Assert.Equal("ReactiveLibrary", receipt["moduleKind"]!.ToString());
        return path;
    }

    [Theory]
    [InlineData("{ Flag: False }")]
    [InlineData("Items mapTo { Label: Item.Label }")]
    [InlineData("Items mapTo")]
    [InlineData("Items mapTo { Label:")]
    [InlineData("{ incomplete")]
    [InlineData("BuildValue(State: Record.State, Code: Record.Code)")]
    [InlineData("BuildValue(State:")]
    [InlineData("BuildValue(State: Record.State")]
    public void StructuredValuesAndIncompleteMappingsAreNeverReinterpretedAsProse(string expression)
        => Assert.False(ScreenHtml.NotAnExpression(expression));

    [Theory]
    [InlineData("Buscar por nome")]
    [InlineData("Nota: revisar")]
    [InlineData("Buscar \"{nome}\" agora")]
    public void OrdinaryProseStillReceivesTheLiteralRule(string prose)
        => Assert.True(ScreenHtml.NotAnExpression(prose));

    private static string? SingleLiteralValue(string text)
    {
        var source = text.Trim();
        if (source.Length < 2 || source[0] != '"') return null;
        var value = new StringBuilder();
        for (var i = 1; i < source.Length; i++) {
            if (source[i] != '"') { value.Append(source[i]); continue; }
            if (i + 1 < source.Length && source[i + 1] == '"') { value.Append('"'); i++; continue; }
            return i == source.Length - 1 ? value.ToString() : null;
        }
        return null;
    }

    [Theory]
    [InlineData("\"A\" + \"B\"")]
    [InlineData("\"A\" and \"B\"")]
    [InlineData("\"A\" +")]
    [InlineData("If(True, \"A\", \"B\")")]
    public void ExpressionsBeginningAndEndingWithQuotesAreNotNecessarilyLiterals(string expression)
        => Assert.Null(SingleLiteralValue(expression));

    [Theory]
    [InlineData("\"Say \"\"Hi\"\"\"", "Say \"Hi\"")]
    [InlineData("\"First\nSecond\"", "First\nSecond")]
    [InlineData(" \"Buscar por nome\" ", "Buscar por nome")]
    public void ASingleLiteralDecodesDoubledQuotesAndLineBreaks(string expression, string expected)
        => Assert.Equal(expected, SingleLiteralValue(expression));

    [Fact]
    public void CapturedExpressionsNeverBecomeProseAndSampledCorrectionsRestoreTheirSources()
    {
        Bind();
        var clock = Stopwatch.StartNew();
        var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(Kernel, "tests", "fixtures", "text-roundtrip", "corpus.json")))!.AsArray();
        var modules = manifest.OfType<JsonObject>().Where(m => m["lane"]!.ToString() == Lane).ToList();
        var available = modules.Where(m => File.Exists(m["oml"]!.ToString())).ToList();
        foreach (var missing in modules.Except(available)) output.WriteLine("WARNING: unavailable capture: " + missing["label"]);
        if (available.Count == 0) { output.WriteLine("WARNING: no captures; corpus certainty checks did not run."); return; }
        Directory.CreateDirectory(Work);
        var expressionCount = 0;
        var proseLiterals = new HashSet<string>(StringComparer.Ordinal);
        var choiceLiterals = new HashSet<string>(StringComparer.Ordinal);
        var foreignMarkerLiterals = new HashSet<string>(StringComparer.Ordinal);
        var defaults = 0;
        var noDefault = 0;
        var collisionCases = 0;
        var expressionProperties = new Dictionary<Type, PropertyInfo[]>();
        foreach (var module in available) {
            var file = module["oml"]!.ToString();
            var bytes = File.ReadAllBytes(file);
            Assert.Equal(module["sha"]!.ToString(), Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
            var host = new ModelHost(Path.Combine(Work, "read"));
            var counts = host.WithSession(file, session => {
                var nodes = Walk(RootOf(session)).ToList();
                var literalScope = session.LiteralScopeNames(["Value", "CertaintyProse", "CertaintyFlow"]);
                var localExpressions = 0;
                var getterFailures = 0;
                foreach (var node in nodes)
                {
                    if (!expressionProperties.TryGetValue(node.GetType(), out var properties))
                        expressionProperties[node.GetType()] = properties = node.GetType().GetProperties(BindingFlags.Instance | BindingFlags.Public).Where(p => p.GetIndexParameters().Length == 0
                            && p.PropertyType.GetInterfaces().Append(p.PropertyType).Any(i => i.Name == "IExpression")).ToArray();
                    foreach (var property in properties) {
                        string? text;
                        try { text = Expression(property.GetValue(node)); }
                        catch (TargetInvocationException) { getterFailures++; continue; }
                        if (string.IsNullOrWhiteSpace(text)) continue;
                        // Published captures supply native expressions, independently of the tool's syntax heuristics.
                        Assert.False(ScreenHtml.NotAnExpression(text), module["label"] + " " + property.Name + ": " + text);
                        localExpressions++;
                        if (SingleLiteralValue(text) is { } raw) {
                            if (!ScreenHtml.HoldsBraces(raw) && !raw.TrimStart().StartsWith('"') && ScreenHtml.NotAnExpression(raw)) {
                                // ProsePatch compiles each literal in a job that declares these names (Input1: the name the
                                // Studio gives its input): the same declared names here.
                                if (ScreenHtml.CertainLiteral(raw, literalScope, ["Value", "CertaintyProse", "CertaintyFlow", "Input1"])) proseLiterals.Add(raw);
                                else choiceLiterals.Add(raw);
                                if (raw.IndexOfAny([';', '?', '!', '$', '@', '`', '~', '\\']) >= 0) foreignMarkerLiterals.Add(raw);
                            }
                        }
                    }
                }
                // Exercise real calls whose argument equals the input's declared default, at most eight per capture.
                var restored = 0; var absent = 0;
                var declaredArguments = 0; var matchingDefaults = 0;
                var byKey = nodes.Where(n => Property(n, "ObjectKey") != null).ToDictionary(n => Property(n, "ObjectKey")!.ToString()!, n => n);
                host.BuildFlow(bytes, module["sha"]!.ToString(), Lane, action => {
                    if (restored >= 8) return;
                    foreach (var call in action.Items.Where(i => i.Kind == "Execute" && !i.Opaque)) {
                        if (!byKey.TryGetValue(call.Key, out var nativeCall) || Property(nativeCall, "Action") is not { } callee) continue;
                        var inputs = Children(callee).Where(i => i.GetType().GetInterfaces().Any(t => t.Name is "IInputParameter" or "IInputParameterSignature"))
                            .ToDictionary(i => Property(i, "Name")?.ToString() ?? "", i => Expression(Property(i, "DefaultValue")));
                        foreach (var argument in call.Items.Where(a => a.Role == "argument")) {
                            if (!inputs.TryGetValue(argument.Name, out var declared)) continue;
                            if (string.IsNullOrWhiteSpace(declared)) { absent++; continue; }
                            declaredArguments++;
                            if (argument.Prop("Value") == declared) matchingDefaults++;
                            if (argument.Prop("Value") != declared) continue;
                            var original = FlowPrinter.Print(action).Text;
                            var clone = action.Clone();
                            var clonedCall = clone.Items.Single(n => n.Key == call.Key);
                            clonedCall.Items.RemoveAll(a => a.Role == "argument" && a.Name == argument.Name);
                            var missing = FlowPrinter.Print(clone).Text;
                            var name = Property(callee, "Name")!.ToString()!;
                            var corrected = VerifySourceEdits.AddFlowArgument(missing, call.Name, name, argument.Name, declared);
                            Assert.Equal(original, corrected);
                            restored++;
                            if (restored >= 8) break;
                        }
                        if (restored >= 8) break;
                    }
                });
                var collisions = 0;
                foreach (var name in session.ActionNames().Where(a => a.Scope == "server" && a.Kind.Contains("Action", StringComparison.Ordinal)).Select(a => a.Name).Distinct(StringComparer.OrdinalIgnoreCase).Take(2)) {
                    var ops = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray(new JsonObject {
                        ["name"] = name, ["public"] = true, ["steps"] = new JsonArray() }) } });
                    var problems = ActionNameRules.Check(ops, "/ops", session.ActionNameFacts());
                    Assert.NotEmpty(problems);
                    Assert.All(problems, p => { Assert.IsType<JsonArray>(p["patch"]); Assert.Equal("ACTION_RENAMED_FREE_NAME", p["patchRule"]!.ToString()); Assert.False(PatchCertainty.IsCertain(p)); });
                    collisions += problems.Count;
                }
                return (localExpressions, getterFailures, restored, absent, collisions, declaredArguments, matchingDefaults);
            });
            expressionCount += counts.localExpressions; defaults += counts.restored; noDefault += counts.absent;
            collisionCases += counts.collisions;
            output.WriteLine($"{module["label"]}: {counts.localExpressions} native expressions, {counts.getterFailures} unreadable expression properties, {counts.restored} exact declared-default restorations ({counts.matchingDefaults} arguments equal to a declared default, {counts.declaredArguments} arguments with a declared default), {counts.absent} inputs without declared defaults, {counts.collisions} public-action collision choices");
        }
        Assert.True(expressionCount > 0, "no valid expressions inspected");
        Assert.True(defaults > 0, "no real declared-default call restored");
        Assert.True(collisionCases > 0, "no public-action collision checked against captured module facts");
        var literals = proseLiterals.Order(StringComparer.Ordinal).Take(8).ToArray();
        Assert.NotEmpty(literals);
        foreach (var literal in literals) ProsePatch(literal);
        output.WriteLine($"{available.Count} captures; TEXT_LITERAL_QUOTED: {expressionCount} expressions, {proseLiterals.Count} eligible distinct prose literals, {literals.Length} real prose patches; TEXT_LITERAL_CHOICE: {choiceLiterals.Count} ineligible distinct prose literals ({foreignMarkerLiterals.Count} with foreign-language markers); REQUIRED_ARGUMENT_DEFAULT: {defaults} exact restorations; REQUIRED_ARGUMENT_TYPE_DEFAULT: {noDefault} real absent defaults; ACTION_RENAMED_FREE_NAME: {collisionCases} public-action choices; {clock.Elapsed.TotalSeconds:0.0}s");
        Assert.True(clock.Elapsed < TimeSpan.FromMinutes(5), "sampled certainty corpus must finish in less than five minutes");
    }

    private void ProsePatch(string prose)
    {
        var fixture = Path.Combine(Kernel, "tests", "fixtures", Lane == "odc" ? "odc/blank-mobile.oml" : "reactive-ui.oml");
        var host = new ModelHost(Path.Combine(Work, "literal"));
        var value = SecurityElement.Escape(prose)!;
        var html = "<screen name='CertaintyProse' flow='CertaintyFlow'><var name='Value' type='Text'/><input bind='Value' placeholder=\"" + value + "\"/></screen>";
        // The runner opens the native command; a blank ODC module does not yet have a UI flow.
        var job = new JsonObject { ["autoPatch"] = false, ["expectValid"] = true, ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IMobileFlow", ["name"] = "CertaintyFlow" },
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } }) };
        var sample = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(prose)))[..16];
        var path = Path.Combine(Work, "literal-" + sample + ".json");
        File.WriteAllText(path, job.ToJsonString());
        JsonArray? all = null; string detail = "";
        try {
            var result = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(host, fixture, path, Path.Combine(Work, "literal-" + sample + ".oml")))!.AsObject();
            all = result["problems"] as JsonArray; detail = result["accepted"]?.ToString() ?? "no acceptance field";
        } catch (Exception error) { all = Errors.FindCoded(error)?.Problems; detail = Errors.Text(error); }
        var problems = (all ?? []).OfType<JsonObject>().Where(p => p["patchRule"]?.ToString() == "TEXT_LITERAL_QUOTED").ToList();
        var diagnostics = string.Join("; ", (all ?? []).OfType<JsonObject>().Select(p => p["code"] + ":" + p["patchRule"] + ":" + p["message"]));
        Assert.True(problems.Count > 0, "no real literal patch for prose " + prose[..Math.Min(prose.Length, 160)] + ": "
            + detail[..Math.Min(detail.Length, 1200)] + "; problems: " + diagnostics[..Math.Min(diagnostics.Length, 1200)]);
        Assert.All(problems, p => Assert.True(PatchCertainty.IsCertain(p), p.ToJsonString()));
        var corrected = problems[0]["patch"]![0]!["value"]!.ToString();
        var placeholder = ScreenHtml.Parse(corrected).Children.SelectMany(Flatten).Select(n => n.Get("placeholder")).First(p => p != null);
        Assert.Equal(ScreenHtml.Literal(prose), placeholder);
    }
    private static IEnumerable<ScreenHtml.Node> Flatten(ScreenHtml.Node node)
    {
        yield return node;
        foreach (var child in node.Children) foreach (var descendant in Flatten(child)) yield return descendant;
    }

    [Theory]
    [InlineData(true, "REQUIRED_ARGUMENT_DEFAULT")]
    [InlineData(false, "REQUIRED_ARGUMENT_TYPE_DEFAULT")]
    public void NativeRequiredInputDiagnosticsDistinguishDeclaredAndTypeDefaults(bool declared, string rule)
    {
        Bind(); Directory.CreateDirectory(Work);
        var input = new JsonObject { ["name"] = "Reset", ["type"] = "Boolean", ["mandatory"] = true };
        if (declared) input["default"] = "False";
        var job = new JsonObject { ["autoPatch"] = false, ["expectValid"] = true, ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray(new JsonObject { ["name"] = "ReadValue", ["inputs"] = new JsonArray(input),
                ["outputs"] = new JsonArray(new JsonObject { ["name"] = "Result", ["type"] = "Boolean" }),
                ["steps"] = new JsonArray(new JsonObject { ["assign"] = new JsonObject { ["Result"] = "Reset" } }) }) } },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = "client action CheckValue\n  Probe = ReadValue()\n  end\n" } }) };
        var path = Path.Combine(Work, "defaults-" + declared + ".json"); File.WriteAllText(path, job.ToJsonString());
        var fixture = Path.Combine(Kernel, "tests", "fixtures", Lane == "odc" ? "odc/blank-mobile.oml" : "reactive-ui.oml");
        JsonArray? problems;
        try { var result = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(Work, "defaults")), fixture, path, Path.Combine(Work, "defaults.oml")))!.AsObject(); problems = result["problems"] as JsonArray; }
        catch (Exception error) { problems = Errors.FindCoded(error)?.Problems; }
        var required = Assert.Single((problems ?? []).OfType<JsonObject>().Where(p => p["code"]?.ToString() == "ArgumentRequiredExpression"));
        Assert.Equal(rule, required["patchRule"]!.ToString()); Assert.Equal(declared, PatchCertainty.IsCertain(required));
    }

    [Theory]
    [InlineData("DecodeUrl")]
    [InlineData("DecodeHtml")]
    [InlineData("DecodeSql")]
    [InlineData("Years")]
    [InlineData("Hours")]
    [InlineData("Months")]
    [InlineData("Minutes")]
    [InlineData("DiffDate")]
    [InlineData("GetUserIds")]
    [InlineData("EncodeUri")]
    [InlineData("AddMonth")]
    public void EditDistanceBuiltinSuggestionsAlwaysRequireTheAuthorsChoice(string wrong)
    {
        Bind();
        Assert.Null(FunctionCatalog.Certain(wrong));
    }

    [Fact]
    public void EveryWhitelistedRenamePreservesItsDeclaredNativeSignature()
    {
        Bind();
        var scopeFixture = Path.Combine(Kernel, "tests", "fixtures", Lane == "odc" ? "odc/blank-mobile.oml" : "blank-service.oml");
        var actionNames = new ModelHost(Path.Combine(Work, "whitelist-scope")).WithSession(scopeFixture, session => session.BuiltinActionNames());
        Assert.NotNull(actionNames);
        Assert.DoesNotContain("NullDate", actionNames!);
        var expected = new Dictionary<string, (string Return, string[] Parameters)> {
            ["NullDateTime"] = ("Date", []), ["Len"] = ("Integer", ["Text"]),
            ["Upper"] = ("Text", ["Text"]), ["Lower"] = ("Text", ["Text"]),
            ["ToUpperCase"] = ("Text", ["Text"]), ["ToLowerCase"] = ("Text", ["Text"]),
            ["Now"] = ("Date Time", []), ["CurrentDateTime"] = ("Date Time", []),
            ["CurrentDate"] = ("Date", []), ["CurrentTime"] = ("Time", []), ["Today"] = ("Date", []),
            ["IIf"] = ("Generic", ["Boolean", "Generic", "Generic"]), ["NullId"] = ("Identifier", []),
        };
        Assert.Equal(expected.Keys.Order(), FunctionCatalog.Renames.Keys.Order());
        foreach (var (written, target) in FunctionCatalog.Renames) {
            var native = Assert.Single(FunctionCatalog.All.Where(f => f.Name.Equals(target, StringComparison.OrdinalIgnoreCase)));
            Assert.Equal(expected[written].Return, native.ReturnType);
            Assert.Equal(expected[written].Parameters, native.Parameters.Select(p => p.Type));
            Assert.All(native.Parameters, p => Assert.False(p.Optional));
            Assert.Equal(target, FunctionCatalog.Certain(written));
        }
    }

    [Theory]
    [InlineData("Lower", false)]
    [InlineData("Lower", true)]
    [InlineData("DecodeUrl", false)]
    [InlineData("DecodeUrl", true)]
    public void AnExistingNonFunctionActionMustNotBecomeABuiltinCall(string name, bool inBase)
    {
        Bind(); Directory.CreateDirectory(Work);
        var directory = Path.Combine(Work, "shadow-" + name + "-" + inBase + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var fixture = ActionFixture(directory, "Own");
        var own = new JsonObject { ["name"] = name, ["public"] = true,
            ["inputs"] = new JsonArray(new JsonObject { ["name"] = "Value", ["type"] = "Text" }),
            ["outputs"] = new JsonArray(new JsonObject { ["name"] = "Result", ["type"] = "Text" }),
            ["steps"] = new JsonArray(new JsonObject { ["assign"] = new JsonObject { ["Result"] = "Replace(ToLower(Trim(Value)), \" \", \"-\")" } }) };
        var actions = new JsonArray();
        if (inBase) {
            var baseJob = Path.Combine(directory, "base.json");
            File.WriteAllText(baseJob, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray(own) } }) }.ToJsonString());
            var baseOut = Path.Combine(directory, "base.oml");
            var built = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(directory), fixture, baseJob, baseOut))!;
            Assert.True(built["accepted"]!.GetValue<bool>(), built.ToJsonString()); fixture = baseOut;
        } else actions.Add(own);
        actions.Add(new JsonObject { ["name"] = "ReadSlug", ["public"] = true,
            ["inputs"] = new JsonArray(new JsonObject { ["name"] = "Title", ["type"] = "Text" }),
            ["outputs"] = new JsonArray(new JsonObject { ["name"] = "Slug", ["type"] = "Text" }),
            ["steps"] = new JsonArray(new JsonObject { ["assign"] = new JsonObject { ["Slug"] = name + "(Title)" } }) });
        var job = Path.Combine(directory, "caller.json"); var candidate = Path.Combine(directory, "candidate.oml");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = actions } }) }.ToJsonString());
        JsonObject response; var wasRefused = false;
        try { response = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(directory), fixture, job, candidate))!.AsObject(); }
        catch (Exception error) { wasRefused = true; response = new JsonObject { ["accepted"] = false, ["problems"] = Errors.FindCoded(error)?.Problems.DeepClone() }; }
        Assert.False(response["accepted"]?.GetValue<bool>() ?? true, response.ToJsonString());
        var problems = (response["problems"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        Assert.Contains(problems, p => p["code"]?.ToString() is "ExpressionUnknownFunction" or "FUNCTION_UNKNOWN");
        Assert.All(problems, p => Assert.False(PatchCertainty.IsCertain(p), p.ToJsonString()));
        Assert.Null(response["patchesApplied"]);
        if (wasRefused) { Assert.Contains(problems, p => p["code"]?.ToString() == "FUNCTION_UNKNOWN"); Assert.False(File.Exists(candidate)); }
        else { Assert.True(File.Exists(candidate)); Assert.NotNull(response["validation"]); Assert.NotNull(response["policyMessages"]); }
    }

    [Fact]
    public void CorpusCertaintyChecksDoNotDependOnAnExternalNameOracle()
    {
        var source = File.ReadAllText(Path.Combine(Kernel, "tests", "Shared", "PatchCertaintyCorpusTests.cs"));
        var obsolete = string.Concat("C:", "\\t\\codex\\", "cx1\\", "ORACULO-NOMES.md");
        Assert.DoesNotContain(obsolete, source);
    }

    [Theory]
    [InlineData("Lower")]
    [InlineData("DecodeUrl")]
    public void AnImportedNonFunctionActionMustNotBecomeABuiltinCall(string name)
    {
        Bind();
        var directory = Path.Combine(Work, "import-" + name + "-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
        var fixture = ActionFixture(directory, "Consumer");
        var producer = Path.Combine(directory, "producer.json"); var producerOut = Path.Combine(directory, "producer.oml");
        var producerFixture = ActionFixture(directory, "Producer");
        File.WriteAllText(producer, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject {
            ["actions"] = new JsonArray(new JsonObject { ["name"] = name, ["public"] = true,
                ["inputs"] = new JsonArray(new JsonObject { ["name"] = "Value", ["type"] = "Text" }),
                ["outputs"] = new JsonArray(new JsonObject { ["name"] = "Result", ["type"] = "Text" }),
                ["steps"] = new JsonArray(new JsonObject { ["assign"] = new JsonObject { ["Result"] = "Replace(Value, \" \", \"-\")" } }) }) } }) }.ToJsonString());
        var built = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(directory), producerFixture, producer, producerOut))!;
        Assert.True(built["accepted"]!.GetValue<bool>(), built.ToJsonString());
        var consumer = Path.Combine(directory, "consumer.json"); var candidate = Path.Combine(directory, "consumer.oml");
        File.WriteAllText(consumer, new JsonObject { ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "reference", ["producer"] = "Imported", ["elements"] = new JsonArray("IServerAction:" + name) },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray(new JsonObject {
                ["name"] = "ReadImportedValue", ["public"] = true,
                ["inputs"] = new JsonArray(new JsonObject { ["name"] = "Value", ["type"] = "Text" }),
                ["outputs"] = new JsonArray(new JsonObject { ["name"] = "Result", ["type"] = "Text" }),
                ["steps"] = new JsonArray(new JsonObject { ["assign"] = new JsonObject { ["Result"] = name + "(Value)" } }) }) } }) }.ToJsonString());
        JsonObject response; var wasRefused = false;
        try { response = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(directory), fixture, consumer, candidate,
            bindings: new Dictionary<string, string> { ["Imported"] = producerOut }))!.AsObject(); }
        catch (Exception error) { wasRefused = true; response = new JsonObject { ["accepted"] = false, ["problems"] = Errors.FindCoded(error)?.Problems.DeepClone() }; }
        Assert.False(response["accepted"]?.GetValue<bool>() ?? true, response.ToJsonString());
        var problems = (response["problems"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        Assert.Contains(problems, p => p["code"]?.ToString() is "ExpressionUnknownFunction" or "FUNCTION_UNKNOWN");
        Assert.All(problems, p => Assert.False(PatchCertainty.IsCertain(p), p.ToJsonString()));
        Assert.Null(response["patchesApplied"]);
        if (wasRefused) { Assert.Contains(problems, p => p["code"]?.ToString() == "FUNCTION_UNKNOWN"); Assert.False(File.Exists(candidate)); }
        else { Assert.True(File.Exists(candidate)); Assert.NotNull(response["validation"]); Assert.NotNull(response["policyMessages"]); }
    }

    [Fact]
    public void NativeBuiltinCatalogContainsUniqueWhitelistedTargets()
    {
        Bind();
        IReadOnlyList<BuiltinFunctionInfo> catalog;
        try { catalog = FunctionCatalog.All; }
        catch (Exception error) { output.WriteLine("WARNING: builtin catalog unavailable: " + error.GetBaseException().Message); return; }
        Assert.Equal(catalog.Count, catalog.Select(f => f.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count());
        var checkedNames = 0;
        foreach (var name in FunctionCatalog.Renames.Keys)
            if (FunctionCatalog.Certain(name) is { } mapped) { Assert.Single(catalog.Where(f => f.Name.Equals(mapped, StringComparison.OrdinalIgnoreCase))); checkedNames++; }
        Assert.True(checkedNames > 0);
        output.WriteLine($"BUILTIN_FUNCTION_RENAMED: {catalog.Count} unique builtin names, {checkedNames} unique mappings");
    }
}
