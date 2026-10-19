using System.Collections;
using System.Diagnostics;
using System.Reflection;
using System.Security;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

public sealed class PatchCertaintyLiteralRevisionTests(ITestOutputHelper output)
{
    [Fact]
    public void LiteralJobNamesIncludesPendingNodeAliasesAndReferenceSelectors()
    {
        var ops = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = new JsonArray(new JsonObject {
            ["name"] = "LaterAction", ["steps"] = new JsonArray(new JsonObject { ["call"] = "ReadValue", ["as"] = "Probe" }) }) } },
            new JsonObject { ["op"] = "reference", ["producer"] = "Producer", ["elements"] = new JsonArray("IServerEntity:Customer") });
        var method = typeof(ModelSession).GetMethod("LiteralJobNames", BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(method);
        var names = Assert.IsAssignableFrom<IReadOnlySet<string>>(method!.Invoke(null, [ops]));
        Assert.Contains("Probe", names); Assert.Contains("Customer", names);
    }
    [Fact]
    public void CorpusAndProductionShareCompleteNativeLiteralScope()
    {
        var method = typeof(ModelSession).GetMethod("LiteralScopeNames", BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(method);
        var lane = typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc") != null ? "odc" : "o11";
        var kernel = Path.Combine(TextRoundTripCorpus.Root()!, "kernel");
        var fixture = Path.Combine(kernel, "tests", "fixtures", lane == "odc" ? "odc/blank-mobile.oml" : "reactive-ui.oml");
        new ModelHost(Path.Combine(kernel, ".local", "literal-scope-contract", lane)).WithSession(fixture, session => {
            var scope = session.LiteralScopeNames(["FutureJobName"]);
            var root = typeof(ModelSession).GetField("_espace", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(session)!;
            var names = Walk(root).Select(n => ModelHost.Prop(n, "Name")?.ToString()).Where(n => !string.IsNullOrEmpty(n)).Cast<string>().ToList();
            Assert.All(names, n => Assert.Contains(n, scope));
            Assert.Contains("FutureJobName", scope);
            Assert.All(FunctionCatalog.Names, n => Assert.Contains(n, scope));
            return true;
        });
    }
    [Theory]
    [InlineData("GetCliente(ClienteId) obrigatorio")]
    [InlineData("Pedido.Total itens no carrinho")]
    [InlineData("NomeCliente \"obrigatorio\"")]
    [InlineData("Hnit \"obrigatorio\"")]
    [InlineData("GetClinte valor")]
    [InlineData("MissingValue texto")]
    [InlineData("ident(x) palavra")]
    [InlineData("a.b palavra")]
    [InlineData("ident \"texto\"")]
    [InlineData("NomeCompleto campo")]
    [InlineData("valor + texto")]
    [InlineData("valor - texto")]
    [InlineData("valor * texto")]
    [InlineData("valor / texto")]
    [InlineData("valor = texto")]
    [InlineData("valor < texto")]
    [InlineData("valor > texto")]
    [InlineData("valor & texto")]
    [InlineData("0A0 palavra")]
    public void CodeShapeNeverBecomesMoreCertainWhenItsNamesAreUnknown(string text)
        => Assert.False(ScreenHtml.CertainLiteral(text, []));

    [Theory]
    [InlineData("GetCliente(ClienteId) obrigatorio")]
    [InlineData("Pedido.Total itens no carrinho")]
    [InlineData("NomeCliente \"obrigatorio\"")]
    [InlineData("Hnit \"obrigatorio\"")]
    [InlineData("User obrigatorio")]
    public void ResidualNativeLiteralCandidatesRequireTheAuthorsChoice(string text)
    {
        var result = Run(text, "<var name='Hint' type='Text'/>");
        Assert.False(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        Assert.Null(result["patchesApplied"]);
        var problems = (result["problems"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        Assert.NotEmpty(problems);
        Assert.DoesNotContain(problems, PatchCertainty.IsCertain);
    }

    [Theory]
    [InlineData("Buscar por nome")]
    [InlineData("Total itens")]
    [InlineData("Nome completo")]
    [InlineData("Telefone com DDD")]
    public void NeutralProseControlsContinueToBeCertain(string text)
        => Assert.True(ScreenHtml.CertainLiteral(text, ["Hint", "Customer", "DisplayName"]));

    [Theory]
    [InlineData("Hnit palavra", "Hint")]
    [InlineData("Naem palavra", "Name")]
    [InlineData("UsrE palavra", "User")]
    public void TransposingTwoLettersOfAKnownNameNeverMakesItsLiteralPatchMoreCertain(string text, string original)
        => Assert.False(ScreenHtml.CertainLiteral(text, [original]));
    [Theory]
    [InlineData("Hint label", "Hint")]
    [InlineData("InputValue label", "InputValue")]
    [InlineData("GetRows label", "GetRows")]
    [InlineData("EntryWidget label", "EntryWidget")]
    [InlineData("FormatValue label", "FormatValue")]
    [InlineData("hint label", "Hint")]
    [InlineData("1 2", "")]
    [InlineData("Buscar por nome\"", "")]
    [InlineData("Buscar por nome;", "")]
    [InlineData("Buscar por nome?", "")]
    [InlineData("Buscar por nome!", "")]
    [InlineData("Buscar por nome$", "")]
    [InlineData("Buscar por nome@", "")]
    [InlineData("Buscar por nome`", "")]
    [InlineData("Buscar por nome~", "")]
    [InlineData("Buscar por nome\\", "")]
    public void ScopeNamesAndForeignLanguageMarkersAreNotCertainLiterals(string text, string name)
        => Assert.False(ScreenHtml.CertainLiteral(text, [name]));

    [Fact]
    public void ForeignSyntaxWithoutANewUnusedElementKeepsAnOfferedChoice()
    {
        var result = Run("Buscar por nome;", "");
        Assert.False(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        Assert.Contains((result["problems"] as JsonArray ?? []).OfType<JsonObject>(), p => p["patch"] is JsonArray
            && p["patchRule"]?.ToString() == "TEXT_LITERAL_CHOICE" && p["patchCertain"]?.GetValue<bool>() == false);
        Assert.Null(result["patchesApplied"]);
    }

    [Fact]
    public void MutationsOfNativeCorpusExpressionsNeverBecomeCertainLiterals()
    {
        var lane = typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc") != null ? "odc" : "o11";
        var kernel = Path.Combine(TextRoundTripCorpus.Root()!, "kernel");
        var work = Path.Combine(kernel, ".local", "literal-revision-corpus", lane);
        var binder = typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc") ?? typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssemblies")!;
        var method = binder.GetMethods().First(m => m.Name == "Bind");
        method.Invoke(null, method.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
        var manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(kernel, "tests", "fixtures", "text-roundtrip", "corpus.json")))!.AsArray();
        var modules = manifest.OfType<JsonObject>().Where(m => m["lane"]?.ToString() == lane && File.Exists(m["oml"]!.ToString())).ToList();
        Assert.NotEmpty(modules);
        var counts = new Dictionary<string, int>(); var inTheory = new Dictionary<string, int>(); var certain = new Dictionary<string, int>(); var expressionCount = 0;
        var byDeclaredRule = new Dictionary<string, int>(); var examples = new Dictionary<string, List<string>>();
        var clock = Stopwatch.StartNew();
        var propertiesByType = new Dictionary<Type, PropertyInfo[]>();
        foreach (var module in modules) {
            var captured = new ModelHost(Path.Combine(work, "read")).WithSession(module["oml"]!.ToString(), session => {
                var root = typeof(ModelSession).GetField("_espace", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(session)!;
                var nodes = Walk(root).ToList();
                var scope = session.LiteralScopeNames();
                var typedNames = new Dictionary<string, List<string>>();
                foreach (var node in WalkWithReferences(root)) {
                    string? name;
                    try { name = ModelHost.Prop(node, "Name")?.ToString(); } catch (TargetInvocationException) { continue; }
                    if (string.IsNullOrEmpty(name)) continue;
                    var interfaces = node.GetType().GetInterfaces().Select(t => t.Name).ToHashSet(StringComparer.Ordinal);
                    var reader = new KernelModelReader();
                    var nativeKind = reader.GetType().GetMethod("KindOf", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!.Invoke(reader, [node])?.ToString();
                    var entity = interfaces.Any(k => k is "IEntity" or "IEntitySignature" or "IServerEntity" or "IClientEntity" or "IServerEntitySignature" or "IClientEntitySignature" or "IStaticEntity" or "IStaticEntitySignature");
                    // ServerEntity implements IStaticEntity in native models too. Its interface list is not the entity kind.
                    var statik = nativeKind is "StaticEntity" or "StaticEntitySignature";
                    if (entity && !statik) try { statik = ModelHost.Prop(node, "IsStaticEntity") is true; } catch (TargetInvocationException) { }
                    var category = entity ? (statik ? "static-entity-name" : "entity-name")
                        : interfaces.Any(k => k.Contains("Attribute", StringComparison.Ordinal)) ? "attribute-name"
                        : interfaces.Any(k => k.Contains("Structure", StringComparison.Ordinal)) ? "structure-name" : null;
                    if (category != null) { if (!typedNames.TryGetValue(category, out var names)) typedNames[category] = names = []; names.Add(name); }
                }
                var expressions = new HashSet<string>(StringComparer.Ordinal);
                foreach (var node in nodes) {
                    if (!propertiesByType.TryGetValue(node.GetType(), out var properties)) propertiesByType[node.GetType()] = properties = node.GetType()
                        .GetProperties(BindingFlags.Instance | BindingFlags.Public).Where(p => p.GetIndexParameters().Length == 0
                            && p.PropertyType.GetInterfaces().Append(p.PropertyType).Any(i => i.Name == "IExpression")).ToArray();
                    foreach (var property in properties) {
                        var expression = property.GetValue(node);
                        var text = expression == null ? null : ModelHost.Prop(expression, "Text")?.ToString();
                        if (!string.IsNullOrWhiteSpace(text)) expressions.Add(text);
                    }
                }
                return (scope, expressions, typedNames, pages: session.LiteralDeclaredNamesByPage());
            });
            var sampled = new Dictionary<string, int>();
            void Check(string kind, string mutation, IReadOnlySet<string>? declared = null) {
                if (sampled.GetValueOrDefault(kind) >= 50) return;
                var eligible = InTheoryLiteral(mutation);
                var isCertain = Certain(mutation, captured.scope, declared);
                counts[kind] = counts.GetValueOrDefault(kind) + 1;
                if (eligible) inTheory[kind] = inTheory.GetValueOrDefault(kind) + 1;
                if (isCertain) {
                    certain[kind] = certain.GetValueOrDefault(kind) + 1;
                    if (!examples.TryGetValue(kind, out var list)) examples[kind] = list = [];
                    if (list.Count < 5) list.Add(module["label"] + ": " + mutation);
                }
                else if (declared != null && Certain(mutation, captured.scope, null)) byDeclaredRule[kind] = byDeclaredRule.GetValueOrDefault(kind) + 1;
                sampled[kind] = sampled.GetValueOrDefault(kind) + 1;
            }
            foreach (var expression in captured.expressions.Order(StringComparer.Ordinal)) {
                expressionCount++;
                foreach (var (kind, mutation) in Mutations(expression)) Check(kind, mutation);
            }
            foreach (var name in captured.scope.Where(n => System.Text.RegularExpressions.Regex.IsMatch(n, @"^[A-Za-z_][A-Za-z0-9_]+$")).Order(StringComparer.Ordinal)) {
                var chars = name.ToCharArray();
                for (var i = 0; i + 1 < chars.Length; i++) {
                    if (!char.IsLetter(chars[i]) || !char.IsLetter(chars[i + 1]) || chars[i] == chars[i + 1]) continue;
                    (chars[i], chars[i + 1]) = (chars[i + 1], chars[i]);
                    Check("transposed-known-name", new string(chars) + " palavra");
                    (chars[i], chars[i + 1]) = (chars[i + 1], chars[i]);
                    break;
                }
                if (sampled.GetValueOrDefault("transposed-known-name") >= 50) break;
            }
            for (var i = 0; i < 50; i++) {
                var unknown = "UnknownCorpusName" + i;
                while (captured.scope.Contains(unknown)) unknown += "X";
                Check("unknown-name", unknown + " palavra");
                Check("unknown-call", unknown + "(x) palavra");
                Check("unknown-member", unknown + ".x palavra");
                Check("identifier-with-literal", unknown + " \"texto\"");
            }
            foreach (var (category, names) in captured.typedNames)
                foreach (var name in names.Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.Ordinal).Take(50)) Check(category, name + " palavra");
            // Option B (owner, 2026-10-17): one letter replaced, removed or added in a name the page declares. The name is
            // written in lower case, so no other veto (CamelCase, a digit, '_', a bracket) can decide the sample.
            var pageNames = new HashSet<string>(captured.pages.SelectMany(p => p.Names), StringComparer.OrdinalIgnoreCase);
            foreach (var (_, declared) in captured.pages.OrderBy(p => p.Page, StringComparer.Ordinal)) {
                foreach (var name in declared.Where(SimpleName).Order(StringComparer.Ordinal).Take(5))
                    foreach (var (kind, slip) in Slips(name.ToLowerInvariant())) Check(kind, slip + " palavra", declared);
                if (DeclaredSlipKinds.All(k => sampled.GetValueOrDefault(k) >= 50)) break;
            }
            // Accepted limits, measured and reported: a word that is no name at all, and one letter replaced in a name of the
            // module or its references that the page does not declare (System's User and Email written Usr, Emal).
            for (var i = 0; i < 200 && sampled.GetValueOrDefault("unknown-lowercase-name") < 50; i++) {
                var word = Syllables[i % Syllables.Length] + Syllables[(i / Syllables.Length + 3) % Syllables.Length] + Syllables[(i * 5 + 7) % Syllables.Length];
                if (!captured.scope.Contains(word)) Check("unknown-lowercase-name", word + " palavra", new HashSet<string>());
            }
            foreach (var name in captured.scope.Where(n => SimpleName(n) && !pageNames.Contains(n)).Order(StringComparer.Ordinal)) {
                foreach (var (_, slip) in Slips(name.ToLowerInvariant()).Where(s => s.Kind == "declared-name-replaced-letter"))
                    Check("module-name-replaced-letter", slip + " palavra", new HashSet<string>());
                if (sampled.GetValueOrDefault("module-name-replaced-letter") >= 50) break;
            }
            output.WriteLine(module["label"] + ": " + captured.expressions.Count + " distinct native expressions; " + captured.pages.Count + " pages; " + string.Join(", ", sampled.Select(k => k.Key + "=" + k.Value)));
        }
        Assert.True(expressionCount > 0);
        foreach (var required in new[] { "removed-operator", "removed-comma", "appended-semicolon", "foreign-not-equal", "null-coalescing", "removed-opening-quote", "transposed-known-name", "unknown-name", "unknown-call", "unknown-member", "identifier-with-literal", "entity-name", "attribute-name", "structure-name", "static-entity-name" }.Concat(DeclaredSlipKinds).Concat(AcceptedLimitKinds))
            Assert.True(counts.GetValueOrDefault(required) > 0, "no native mutation for " + required);
        foreach (var (category, total) in counts.OrderBy(k => k.Key, StringComparer.Ordinal))
            output.WriteLine($"MUTATION_CATEGORY {category}: total={total}, inTheory={inTheory.GetValueOrDefault(category)}, certain={certain.GetValueOrDefault(category)}, decidedByDeclaredNameRule={byDeclaredRule.GetValueOrDefault(category)}"
                + (AcceptedLimitKinds.Contains(category) ? ", owner-accepted limit" : "")
                + (examples.TryGetValue(category, out var shown) ? "; certain examples: " + string.Join(" | ", shown) : ""));
        var wrong = counts.Keys.Where(k => !AcceptedLimitKinds.Contains(k) && certain.GetValueOrDefault(k) > 0).Order(StringComparer.Ordinal).ToList();
        output.WriteLine($"{modules.Count} captures; {expressionCount} distinct native expressions; {counts.Values.Sum()} mutations; "
            + $"{counts.Where(k => !AcceptedLimitKinds.Contains(k.Key)).Sum(k => k.Value)} outside the accepted limits with {wrong.Sum(k => certain[k])} certain; {clock.Elapsed.TotalSeconds:0.0}s");
        Assert.True(wrong.Count == 0, "certain literals outside the owner's accepted limits: " + string.Join("; ", wrong.Select(k => k + "=" + certain[k] + " (" + string.Join(" | ", examples[k]) + ")")));
        Assert.True(clock.Elapsed < TimeSpan.FromMinutes(5));
    }

    private static readonly string[] DeclaredSlipKinds = ["declared-name-replaced-letter", "declared-name-removed-letter", "declared-name-added-letter"];
    private static readonly HashSet<string> AcceptedLimitKinds = new(StringComparer.Ordinal) { "unknown-lowercase-name", "module-name-replaced-letter" };
    private static readonly string[] Syllables = ["ba", "ce", "di", "fo", "gu", "la", "me", "ni", "po", "ru", "sa", "te", "vi", "zo"];

    private static bool SimpleName(string name) => name.Length >= 3 && name.All(char.IsLetter);

    /// <summary>One letter replaced, removed or added in the middle of a name, each still three letters or more.</summary>
    private static IEnumerable<(string Kind, string Text)> Slips(string name)
    {
        var i = name.Length / 2;
        var letter = name[i];
        var other = letter is >= 'a' and < 'z' ? (char)(letter + 1) : letter == 'z' ? 'y' : 'x';
        yield return ("declared-name-replaced-letter", name[..i] + other + name[(i + 1)..]);
        if (name.Length >= 4) yield return ("declared-name-removed-letter", name.Remove(i, 1));
        yield return ("declared-name-added-letter", name.Insert(i, letter.ToString()));
    }

    private static bool Certain(string text, IReadOnlySet<string> scope, IReadOnlySet<string>? declared) => ScreenHtml.CertainLiteral(text, scope, declared);

    private static bool InTheoryLiteral(string text)
    {
        if (text.IndexOfAny([';', '?', '!']) >= 0) return false;
        var quotes = text.Count(c => c == '"');
        return quotes % 2 == 0;
    }

    private static IEnumerable<object> WalkWithReferences(object root)
    {
        var seen = new HashSet<object>(ReferenceEqualityComparer.Instance);
        var pending = new Stack<object>(); pending.Push(root);
        while (pending.TryPop(out var node)) {
            if (!seen.Add(node)) continue;
            yield return node;
            foreach (var child in (ModelHost.Prop(node, "Children") as IEnumerable)?.Cast<object>() ?? []) pending.Push(child);
        }
    }

    private static IEnumerable<object> Walk(object node)
    {
        yield return node;
        if (node.GetType().GetInterfaces().Any(i => i.Name == "IReference")) yield break;
        foreach (var child in (ModelHost.Prop(node, "Children") as IEnumerable)?.Cast<object>() ?? [])
            foreach (var descendant in Walk(child)) yield return descendant;
    }

    private static IEnumerable<(string Kind, string Text)> Mutations(string expression)
    {
        var tokens = ExpressionText.Tokens(expression);
        var op = tokens.FirstOrDefault(t => t.Kind == TokenKind.Operator);
        if (op != null) yield return ("removed-operator", expression.Remove(op.Start, op.Text.Length));
        var comma = tokens.FirstOrDefault(t => t.Kind == TokenKind.Comma);
        if (comma != null) yield return ("removed-comma", expression.Remove(comma.Start, comma.Text.Length));
        yield return ("appended-semicolon", expression + ";");
        var neq = tokens.FirstOrDefault(t => t.Kind == TokenKind.Operator && t.Text == "<>");
        if (neq != null) yield return ("foreign-not-equal", expression.Remove(neq.Start, 2).Insert(neq.Start, "!="));
        yield return ("null-coalescing", op == null ? expression + " ?? \"\"" : expression.Remove(op.Start, op.Text.Length).Insert(op.Start, "??"));
        var quote = tokens.FirstOrDefault(t => t.Kind == TokenKind.Text);
        if (quote != null) yield return ("removed-opening-quote", expression.Remove(quote.Start, 1));
    }
    [Theory]
    [InlineData("If(Hint != \"\", Hint, \"Digite o nome\")")]
    [InlineData("Trim(Hint);")]
    [InlineData("Hint \"obrigatorio\"")]
    [InlineData("If(Hint = \"\", \"Digite o nome\" Hint)")]
    [InlineData("Hint ?? \"Digite o nome\"")]
    [InlineData("Hint !")]
    [InlineData("Hint $")]
    [InlineData("Hint @")]
    [InlineData("Hint `")]
    [InlineData("Hint ~")]
    [InlineData("Hint \\")]
    public void MalformedExpressionsRemainChoicesInsteadOfQuotedText(string expression)
    {
        var result = Run(expression, "<var name='Hint' type='Text'/>");
        Assert.False(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        var problems = (result["problems"] as JsonArray ?? result["data"]?["problems"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        Assert.NotEmpty(problems);
        Assert.DoesNotContain(problems, PatchCertainty.IsCertain);
        Assert.Null(result["patchesApplied"]);
    }

    [Fact]
    public void QuotingThatMakesAReferencedVariableUnusedWithdrawsTheCompoundPatch()
    {
        var result = Run("Trim(Hint);", "<var name='Hint' type='Text'/>");
        Assert.False(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        var problems = (result["problems"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        Assert.NotEmpty(problems);
        var literals = problems.Where(p => p["code"]?.ToString() == "HTML_INVALID").ToList();
        Assert.NotEmpty(literals);
        Assert.All(literals, p => Assert.Null(p["patch"]));
        Assert.Null(result["patchesApplied"]);
    }

    [Fact]
    public void OrdinaryProseWithoutScopeNamesStillAcceptsWithADisclosedLiteralPatch()
    {
        var result = Run("Buscar por nome", "<var name='Hint' type='Text'/>");
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
        Assert.Contains(result["patchesApplied"]!.AsArray().OfType<JsonObject>(), p => p["patchRule"]?.ToString() == "TEXT_LITERAL_QUOTED");
    }

    private static JsonObject Run(string expression, string declarations)
    {
        var lane = typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc") != null ? "odc" : "o11";
        var kernel = Path.Combine(TextRoundTripCorpus.Root()!, "kernel");
        var fixture = Path.Combine(kernel, "tests", "fixtures", lane == "odc" ? "odc/blank-mobile.oml" : "reactive-ui.oml");
        var work = Path.Combine(kernel, ".local", "literal-revision", lane, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var html = "<screen name='LiteralRevision' flow='LiteralRevisionFlow'>" + declarations
            + "<var name='Value' type='Text'/><input bind='Value' placeholder=\"" + SecurityElement.Escape(expression) + "\"/></screen>";
        var job = new JsonObject { ["expectValid"] = true, ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IMobileFlow", ["name"] = "LiteralRevisionFlow" },
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } }) };
        if (lane == "odc") job["expectedMessages"] = new JsonArray(new JsonObject {
            ["id"] = "AnonymousAccess_NoPermissions", ["all"] = true, ["why"] = "a test screen without a role" });
        var jobPath = Path.Combine(work, "job.json"); File.WriteAllText(jobPath, job.ToJsonString());
        var output = Path.Combine(work, "candidate.oml");
        try { return JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(work, "runtime")), fixture, jobPath, output))!.AsObject(); }
        catch (Exception error) {
            var coded = Errors.FindCoded(error);
            Assert.NotNull(coded);
            Assert.False(File.Exists(output));
            return new JsonObject { ["accepted"] = false, ["problems"] = coded!.Problems?.DeepClone() };
        }
    }
}
