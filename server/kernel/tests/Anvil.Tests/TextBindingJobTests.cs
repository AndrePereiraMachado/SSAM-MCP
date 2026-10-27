using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>T1 on the O11 lane, through the job (JobRunner): every html write path (the fragment op, the edit form, a set) compiles
/// a binding as the expression it is, and the invariant after the apply (LITERAL_BINDING_REMNANT, HTML_IN_EXPRESSION) refuses a
/// literal that would show the braces of a binding or an Expression that would show markup, named, with one next call, whatever op
/// wrote it. The reading prints a literal brace as its character reference, so a literal never prints as a binding, and read ->
/// write -> read is the identity. Needs the Service Studio; the neutral Reactive fixture.</summary>
public class TextBindingJobTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TextBindingJobTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "text-binding");

    // ---- positive: the fragment op ------------------------------------------------------------------------------------

    [Fact]
    public void AFragmentWritesItsLabelPlaceholderTitleAndCounterAsTheirBindingsSay()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: skipped."); return; }
        var (host, basePath, read, keys) = Login();
        var form = Container(read, keys);
        var bind = Variable(read);
        var fragment = $"<div class=\"t1-box\"><label for=\"T1Input\">{{{{ \"Search\" }}}}</label>"
            + $"<input id=\"T1Input\" bind=\"{bind}\" placeholder=\"{{{{ &quot;Search by name&quot; }}}}\"/>"
            + $"<label>Name: {{{{ {bind} }}}}</label><span title=\"{{{{ {bind} }}}}\">x</span>"
            + $"<span>{{{{ If({bind} = \"\", \"none\", \"some\") }}}}</span></div>";
        var result = Run(host, basePath, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["parent"] = "@" + form, ["html"] = fragment }) }, "fragment");
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString()[..Math.Min(3000, result.ToJsonString().Length)]);
        var html = Html(host, Path.Combine(Work, "fragment.oml"));
        output.WriteLine(html);
        Assert.Contains(">Search</label>", html);
        // An expression attribute holds its expression as text: the Prompt is the string literal.
        Assert.Contains("placeholder='\"Search by name\"'", html);
        Assert.Contains("title=\"{{ " + bind + " }}\"", html);
        Assert.Contains("{{ If(" + bind + " = \"\", \"none\", \"some\") }}", html);
        Assert.Contains("{{ " + bind + " }}", html);
        Assert.DoesNotContain("<text>{{", html);
        Assert.DoesNotContain("\"{{ \"\"", html);
    }

    // ---- negative: a remnant is refused, named, whatever op writes it --------------------------------------------------------

    [Fact]
    public void AnEditThatWritesALiteralRunWithABindingIsRefusedBeforeAnythingIsWritten()
    {
        if (!StudioAvailable()) return;
        var (host, basePath, read, _) = Login();
        var html = read["documents"]![0]!["html"]!.ToString();
        var tree = ScreenHtml.Parse(html);
        var label = ScreenHtmlText.Elements(tree).First(e => e.Node.Tag == "label" && e.Node.Get("k") != null).Node;
        label.Children.Clear();
        label.Children.Add(new ScreenHtml.Node { Tag = "text", Children = [new ScreenHtml.Node { Text = "{{ \"Search\" }}" }] });
        var result = Run(host, basePath, EditJob(basePath, read, [ScreenHtmlText.Write(label)]), "edit-run");
        var problem = Problems(result).Single(p => p!["code"]!.ToString() == BindingText.Remnant)!;
        Assert.Equal(label.Get("k"), problem["k"]!.ToString());
        Assert.Equal("Text", problem["property"]!.ToString());
        Assert.Contains("write the run as Search", problem["next"]!.ToString());
    }

    [Fact]
    public void AnEditPlaceholderWhoseTextLiteralHoldsABindingIsRefusedWithTheExpressionItStandsFor()
    {
        if (!StudioAvailable()) return;
        var (host, basePath, read, _) = Login();
        var tree = ScreenHtml.Parse(read["documents"]![0]!["html"]!.ToString());
        var input = ScreenHtmlText.Elements(tree).First(e => e.Node.Tag == "input" && e.Node.Get("bind") != null).Node;
        Attribute(input, "placeholder", "{{ \"{{ \"\"Applied to the decision\"\" }}\" }}");
        var result = Run(host, basePath, EditJob(basePath, read, [ScreenHtmlText.Write(input)]), "edit-placeholder");
        var problem = Problems(result).Single(p => p!["code"]!.ToString() == BindingText.Remnant)!;
        Assert.Equal(input.Get("k"), problem["k"]!.ToString());
        Assert.Equal("Prompt", problem["property"]!.ToString());
        Assert.Equal("placeholder", problem["attribute"]!.ToString());
        Assert.StartsWith("write placeholder='\"Applied to the decision\"'", problem["next"]!.ToString());
        // The string literal of the placeholder written as an expression (the other shape of the audit) is refused too, named.
        Attribute(input, "placeholder", "\"{{ \"\"X\"\" }}\"");
        var other = Run(host, basePath, EditJob(basePath, read, [ScreenHtmlText.Write(input)]), "edit-placeholder-2");
        Assert.NotEqual(true, other["accepted"]?.GetValue<bool>());
        Assert.Contains(Problems(other), p => p!["k"]?.ToString() == input.Get("k") || p!["message"]!.ToString().Contains("placeholder", StringComparison.Ordinal));
    }

    [Fact]
    public void ASetThatLeavesALiteralWithABindingIsRefusedAfterTheApplyWithTheElementAndTheFix()
    {
        if (!StudioAvailable()) return;
        var (host, basePath, read, keys) = Login();
        var form = Container(read, keys);
        var bind = Variable(read);
        var input = keys[ScreenHtmlText.Elements(ScreenHtml.Parse(read["documents"]![0]!["html"]!.ToString())).First(e => e.Node.Tag == "input" && e.Node.Get("bind") != null).Node.Get("k")!];
        var job = new JsonObject { ["ops"] = new JsonArray(
            new JsonObject { ["op"] = "create", ["parent"] = "@" + form, ["type"] = "ITextWidget", ["as"] = "$t" },
            new JsonObject { ["op"] = "set", ["target"] = "$t", ["prop"] = "Text", ["value"] = "{{ \"Status\" }}" },
            new JsonObject { ["op"] = "set", ["target"] = "@" + input, ["prop"] = "Prompt", ["value"] = "\"{{ " + bind + " }}\"" },
            new JsonObject { ["op"] = "create", ["parent"] = "@" + form, ["type"] = "IExpression", ["as"] = "$e" },
            new JsonObject { ["op"] = "set", ["target"] = "$e", ["prop"] = "Value", ["value"] = "\"<span class=\"\"icon fa fa-lock\"\" aria-hidden=\"\"true\"\"></span>\"" }) };
        var result = Run(host, basePath, job, "set-remnant");
        Assert.NotEqual(true, result["accepted"]?.GetValue<bool>());
        var problems = Problems(result);
        // Every problem of the job in one refusal: the Text, the Prompt and the Expression.
        var text = problems.Single(p => p!["code"]!.ToString() == BindingText.Remnant && p["property"]?.ToString() == "Text")!;
        Assert.Equal(1, text["op"]!.GetValue<int>());
        Assert.Equal("TextWidget", text["kind"]!.ToString());
        Assert.Contains("write the text as Status", text["next"]!.ToString());
        var prompt = problems.Single(p => p!["code"]!.ToString() == BindingText.Remnant && p["property"]?.ToString() == "Prompt")!;
        Assert.Equal(input, prompt["key"]!.ToString());
        Assert.StartsWith("write placeholder='" + bind + "'", prompt["next"]!.ToString());
        var markup = problems.Single(p => p!["code"]!.ToString() == BindingText.HtmlInExpression)!;
        Assert.Equal(4, markup["op"]!.GetValue<int>());
        Assert.Contains("<span class=\"icon fa fa-lock\"", markup["markup"]!.ToString());
    }

    // ---- generated sweep: every expression property of every kind of the fixtures (F2's property model) -----------------------

    [Theory]
    [InlineData("reactive-ui.oml")]
    [InlineData("mobile-ui.oml")]
    public void EveryExpressionPropertyOfEveryKindRefusesARemnantBeforeAnythingIsWritten(string fixture)
    {
        if (!StudioAvailable()) return;
        Directory.CreateDirectory(Work);
        var host = new ModelHost(Work);
        var bytes = File.ReadAllBytes(Path.Combine(Root, "tests", "fixtures", fixture));
        var espace = host.Load(bytes);
        var cases = new List<(string Root, string K, string Kind, string Property)>();
        var refusals = new Dictionary<string, JsonArray>(StringComparer.Ordinal);
        try
        {
            var m = ScreenHtml.Module((OutSystems.Model.IObjectSignature)espace, new KernelModelReader());
            var slots = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (name, kind, key) in m.Roots)
            {
                if (kind is "WebScreen" or "WebBlock") continue;
                var doc = m.Read("@" + key);
                if (doc.Problems.Count > 0) continue;
                var tree = ScreenHtml.Parse(doc.Html);
                var written = new List<(string K, string Kind, string Property)>();
                foreach (var (node, _) in ScreenHtmlText.Elements(tree).ToList())
                {
                    if (node.Get("k") is not { } k || !doc.Canon.Elements.TryGetValue(k, out var element) || !ScreenHtml.WidgetTags.ContainsKey(element.Kind)) continue;
                    if (m.NodeOf(doc, k) is not { } native) continue;
                    foreach (var property in m.PropertiesOf(native).Values.OrderBy(p => p.Name, StringComparer.Ordinal))
                    {
                        if (property.Type != 'e' || !property.Writable || property.NotOfThePage != null || property.Name is "Visible" or "Name" or "Tag" or "StyleSheet") continue;
                        var attribute = ScreenHtmlTables.AttributeOf(element.Kind, property.Name, ScreenHtmlModuleMode.Widget, element.Facts.ContainsKey("p:StyleClasses"));
                        if (attribute is "class" or "id" or "if" or "list" || attribute.StartsWith(':') || attribute.StartsWith('@') || attribute.StartsWith("on", StringComparison.Ordinal)) continue;
                        if (!slots.Add(element.Kind + "." + property.Name)) continue;
                        Attribute(node, attribute, "{{ \"{{ T1 }}\" }}");
                        written.Add((k, element.Kind, property.Name));
                    }
                }
                if (written.Count == 0) continue;
                var data = new JsonObject { ["screen"] = "@" + key, ["basedOn"] = new JsonObject { ["capture"] = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), ["html"] = doc.HtmlSha256 },
                    ["html"] = ScreenHtmlText.Write(tree) };
                var answer = host.HtmlEdit(bytes, data);
                Assert.False(answer["accepted"]!.GetValue<bool>(), name + ": " + answer.ToJsonString()[..Math.Min(2000, answer.ToJsonString().Length)]);
                refusals[name] = answer["problems"] as JsonArray ?? new JsonArray();
                cases.AddRange(written.Select(w => (name, w.K, w.Kind, w.Property)));
            }
        }
        finally { ModelHost.Release(espace); }
        output.WriteLine($"{fixture}: {cases.Count} kind x property slots, {refusals.Count} roots");
        Assert.NotEmpty(cases);
        foreach (var (root, k, kind, property) in cases)
            Assert.True(refusals[root].Any(p => p!["code"]?.ToString() == BindingText.Remnant && p["k"]?.ToString() == k && p["property"]?.ToString() == property
                && p["next"]?.ToString().Contains("T1", StringComparison.Ordinal) == true), $"{root} k={k} {kind}.{property}: no {BindingText.Remnant} in {refusals[root].ToJsonString()[..Math.Min(1500, refusals[root].ToJsonString().Length)]}");
    }

    // ---- the reading: a literal brace never prints as a binding; read -> write -> read is the identity ------------------------

    [Fact]
    public void ALiteralWithBracesReadsEscapedAndAnEditOfItsElementKeepsIt()
    {
        if (!StudioAvailable()) return;
        var (host, basePath, read, keys) = Login();
        var form = Container(read, keys);
        // A module that already holds such a literal (a delivery before T1): written below the job, as the Studio would keep it.
        var legacy = Path.Combine(Work, "legacy.oml");
        WriteDirect(host, basePath, legacy, [
            new JsonObject { ["op"] = "create", ["parent"] = "@" + form, ["type"] = "ITextWidget", ["as"] = "$t" },
            new JsonObject { ["op"] = "set", ["target"] = "$t", ["prop"] = "Text", ["value"] = "{{ \"Status\" }} and {{" }]);
        var legacyRead = host.HtmlRead(File.ReadAllBytes(legacy), "Login", withKeys: false);
        var html = legacyRead["documents"]![0]!["html"]!.ToString();
        output.WriteLine(html);
        Assert.Contains("&#123;&#123; \"Status\" &#125;&#125; and &#123;&#123;", html);
        Assert.DoesNotContain("{{ \"Status\" }} and", html);
        // The element holding it, written again with another change: accepted, the literal kept, and the text read again is the same.
        var tree = ScreenHtml.Parse(html);
        var holder = ScreenHtmlText.Elements(tree).First(e => e.Node.Tag == "form" && e.Node.Get("k") != null).Node;
        Assert.Contains("&#123;", ScreenHtmlText.Write(holder));
        Attribute(holder, "class", "t1-kept");
        var same = Run(host, legacy, EditJob(legacy, legacyRead, [ScreenHtmlText.Write(holder)]), "legacy-edit");
        Assert.True(same["accepted"]?.GetValue<bool>() == true, same.ToJsonString()[..Math.Min(3000, same.ToJsonString().Length)]);
        var after = Html(host, Path.Combine(Work, "legacy-edit.oml"));
        Assert.Contains("&#123;&#123; \"Status\" &#125;&#125; and &#123;&#123;", after);
        Assert.Equal(ScreenHtmlText.WithoutKeys(ScreenHtmlText.Write(tree)), ScreenHtmlText.WithoutKeys(after));
    }

    [Fact]
    public void ARealLiteralBraceWrittenEscapedRoundTrips()
    {
        if (!StudioAvailable()) return;
        var (host, basePath, read, _) = Login();
        var tree = ScreenHtml.Parse(read["documents"]![0]!["html"]!.ToString());
        var label = ScreenHtmlText.Elements(tree).First(e => e.Node.Tag == "label" && e.Node.Get("k") != null).Node;
        // A lone {{ in <text> (no binding), and a pair the page must show, split in an expression.
        label.Children.Clear();
        label.Children.Add(new ScreenHtml.Node { Tag = "text", Children = [new ScreenHtml.Node { Text = "Use {{" }] });
        label.Children.Add(new ScreenHtml.Node { Text = "{{ \"{\" + \"{ name }\" + \"}\" }}" });
        var result = Run(host, basePath, EditJob(basePath, read, [ScreenHtmlText.Write(label)]), "escaped");
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString()[..Math.Min(3000, result.ToJsonString().Length)]);
        var after = Html(host, Path.Combine(Work, "escaped.oml"));
        Assert.Contains("<text>Use &#123;&#123;</text>", after);
        Assert.Contains("{{ \"{\" + \"{ name }\" + \"}\" }}", after);
        // Read and written again: the same text (the fixed point).
        var again = ScreenHtml.Parse(after);
        var back = ScreenHtmlText.Elements(again).First(e => e.Node.Get("k") == label.Get("k")).Node;
        var bytes = File.ReadAllBytes(Path.Combine(Work, "escaped.oml"));
        var reread = host.HtmlRead(bytes, "Login", withKeys: false);
        var fixedPoint = Run(host, Path.Combine(Work, "escaped.oml"), EditJob(Path.Combine(Work, "escaped.oml"), reread, [ScreenHtmlText.Write(back)]), "escaped-again");
        Assert.True(fixedPoint["accepted"]?.GetValue<bool>() == true, fixedPoint.ToJsonString()[..Math.Min(3000, fixedPoint.ToJsonString().Length)]);
        Assert.Equal(after, Html(host, Path.Combine(Work, "escaped-again.oml")));
    }

    // ---- the real deliveries of the audit (captures of a customer module: read from an env var, never committed) -------------

    [Fact]
    public void TheFragmentsOfTheAuditedDeliveriesWriteNoRemnant()
    {
        var dir = Environment.GetEnvironmentVariable("SSAM_T1_CASE_DIR");
        if (dir is not { Length: > 0 } || !Directory.Exists(dir)) { output.WriteLine("SSAM_T1_CASE_DIR unset: skipped."); return; }
        var fragments = 0; var withBindings = 0;
        foreach (var file in Directory.GetFiles(dir, "*.json").Order(StringComparer.Ordinal))
        {
            if (JsonNode.Parse(File.ReadAllText(file)) is not JsonObject { } job || job["ops"] is not JsonArray ops) continue;
            foreach (var op in ops.OfType<JsonObject>().Where(o => o["op"]?.ToString() == "html" && o["parent"] is JsonValue && o["html"] is JsonValue))
            {
                var html = op["html"]!.ToString();
                fragments++;
                if (html.Contains("{{", StringComparison.Ordinal)) withBindings++;
                List<JsonObject> written;
                try { written = HtmlVisual.Expand(html, op["parent"]!.ToString(), TextBindingCases.ScopeOf(html)).Ops; }
                catch (Exception error) { output.WriteLine(Path.GetFileName(file) + ": a fragment does not compile here (" + Errors.Text(error)[..Math.Min(200, Errors.Text(error).Length)] + ")"); continue; }
                foreach (var set in written.Where(o => o["op"]?.ToString() == "set" && o["value"] is JsonValue))
                {
                    var value = set["value"]!.ToString();
                    if (set["prop"]!.ToString() == "Text") Assert.False(BindingText.HoldsPair(value), Path.GetFileName(file) + ": " + set.ToJsonString());
                    else Assert.Empty(BindingText.Remnants(value));
                }
            }
        }
        output.WriteLine($"{fragments} fragments, {withBindings} with bindings: no remnant");
        Assert.True(withBindings > 0);
    }

    // ---- helpers --------------------------------------------------------------------------------------------------------------

    private (ModelHost Host, string BasePath, JsonObject Read, Dictionary<string, string> Keys) Login()
    {
        Directory.CreateDirectory(Work);
        var host = new ModelHost(Work);
        var basePath = Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml");
        var bytes = File.ReadAllBytes(basePath);
        var read = host.HtmlRead(bytes, "Login", withKeys: true);
        var keys = read["documents"]![0]!["keys"]!.AsObject().ToDictionary(p => p.Key, p => p.Value!.ToString(), StringComparer.Ordinal);
        return (host, basePath, read, keys);
    }

    // The ObjectKey of the reading's form (the container the fragment fills), and the variable an input of the screen binds.
    private static string Container(JsonObject read, Dictionary<string, string> keys)
        => keys[ScreenHtmlText.Elements(ScreenHtml.Parse(read["documents"]![0]!["html"]!.ToString())).First(e => e.Node.Tag is "form" && e.Node.Get("k") != null).Node.Get("k")!];
    private static string Variable(JsonObject read)
        => ScreenHtmlText.Elements(ScreenHtml.Parse(read["documents"]![0]!["html"]!.ToString())).First(e => e.Node.Tag == "input" && e.Node.Get("bind") != null && e.Node.Get("type") is null or "text").Node.Get("bind")!;

    private static JsonObject EditJob(string basePath, JsonObject read, IEnumerable<string> edits) => new() { ["ops"] = new JsonArray(new JsonObject {
        ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "Login",
            ["basedOn"] = new JsonObject { ["capture"] = Sha(basePath), ["html"] = read["documents"]![0]!["htmlSha256"]!.DeepClone() },
            ["edit"] = new JsonArray(edits.Select(e => (JsonNode)e).ToArray()) } }) };

    private JsonObject Run(ModelHost host, string basePath, JsonObject job, string name)
    {
        var jobPath = Path.Combine(Work, name + ".json"); File.WriteAllText(jobPath, job.ToJsonString());
        try { return JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, Path.Combine(Work, name + ".oml")))!.AsObject(); }
        catch (Exception error) {
            var coded = Errors.FindCoded(error);
            output.WriteLine(name + " refused: " + Errors.Text(error)[..Math.Min(3000, Errors.Text(error).Length)]);
            return new JsonObject { ["accepted"] = false, ["code"] = coded?.Code, ["problems"] = coded?.Problems?.DeepClone() };
        }
    }

    // Writes ops below the job (no invariant): a module as a delivery before T1 left it.
    private static void WriteDirect(ModelHost host, string basePath, string outPath, IEnumerable<JsonObject> ops)
    {
        var module = host.Load(File.ReadAllBytes(basePath));
        try {
            var session = new ModelSession(module);
            StudioAdapter.Runtime.Mutate(module, "Anvil: test", _ => { foreach (var op in ops) session.ApplyOne(op); });
            File.WriteAllBytes(outPath, host.Save(module));
        }
        finally { ModelHost.Release(module); }
    }

    private static string Html(ModelHost host, string oml) => host.HtmlRead(File.ReadAllBytes(oml), "Login", withKeys: false)["documents"]![0]!["html"]!.ToString();
    private static string Sha(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
    private static JsonArray Problems(JsonObject result) => result["problems"] as JsonArray ?? new JsonArray();
    private static void Attribute(ScreenHtml.Node node, string name, string value)
    {
        var i = node.Attributes.FindIndex(a => a.Key == name);
        if (i >= 0) node.Attributes[i] = new(name, value); else node.Attributes.Add(new(name, value));
    }
    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}

/// <summary>The names a fragment of a real delivery mentions, as the module it was written for has them (the delivery compiled
/// there): every bind, every onclick and handler, every block and image, so the fragment compiles here without the module.</summary>
internal static class TextBindingCases
{
    internal static HtmlVisualScope ScopeOf(string html)
    {
        var tree = HtmlSource.Parse(html);
        var variables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var actions = HtmlVisualScope.Map(); var blocks = HtmlVisualScope.Map(); var images = HtmlVisualScope.Map(); var screens = HtmlVisualScope.Map();
        var contracts = new Dictionary<string, ScreenContract>(StringComparer.OrdinalIgnoreCase);
        foreach (var node in tree.Descendants().Where(n => !n.IsText))
        {
            foreach (var (name, value) in node.Attributes)
            {
                if (name is "bind" or "filename" or "content") variables.Add(value.Split('.')[0]);
                if (name is "onclick" or "href" || name.StartsWith('@')) { var call = System.Text.RegularExpressions.Regex.Match(value, @"^\s*([A-Za-z_][A-Za-z0-9_]*)"); if (call.Success) actions[call.Groups[1].Value] = "@" + call.Groups[1].Value; }
                if (node.Tag == "img" && name == "src") images[value] = "IImage:" + value;
            }
            // A block as the fragment uses it: its inputs (:Input), its events (@Event) and its placeholders (<slot name>).
            if (node.Tag == "block" && node.Attribute("name") is { Length: > 0 } block)
            {
                var reference = "IMobileBlock:" + block;
                blocks[block] = reference;
                var known = contracts.GetValueOrDefault(reference);
                var inputs = (known?.Inputs ?? []).Concat(node.Attributes.Where(a => a.Key.StartsWith(':')).Select(a => new UiParam(a.Key[1..], "Text", false, null, null)))
                    .DistinctBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToArray();
                var events = (known?.Events ?? []).Concat(node.Attributes.Where(a => a.Key.StartsWith('@') && !a.Key.Contains('.')).Select(a => new UiEvent(a.Key[1..], false, null, [])))
                    .DistinctBy(e => e.Name, StringComparer.OrdinalIgnoreCase).ToArray();
                var slots = (known?.Placeholders ?? []).Concat(node.Elements.Where(e => e.Tag == "slot").Select(e => new UiPlaceholder(e.Attribute("name") ?? "", null, "", [])))
                    .DistinctBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToArray();
                contracts[reference] = new ScreenContract(reference, inputs, [], [], events, slots, new Dictionary<string, IReadOnlyList<UiParam>>(), new Dictionary<string, IReadOnlyList<string>>());
            }
        }
        // An action or a screen a link calls: optional inputs by position, and every :Input the fragment passes by name.
        var named = tree.Descendants().Where(n => !n.IsText && n.Tag is not "block").SelectMany(n => n.Attributes).Where(a => a.Key.StartsWith(':')).Select(a => a.Key[1..]);
        var generic = Enumerable.Range(1, 12).Select(i => "In" + i).Concat(named).Distinct(StringComparer.OrdinalIgnoreCase).Select(n => new UiParam(n, "Text", false, null, null)).ToArray();
        ScreenContract Generic(string reference) => new(reference, generic, [], [], [], [], new Dictionary<string, IReadOnlyList<UiParam>>(), new Dictionary<string, IReadOnlyList<string>>());
        return new HtmlVisualScope(variables, actions, blocks, images, reference => contracts.GetValueOrDefault(reference) ?? Generic(reference)) { Screens = screens };
    }
}
