using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>The tests that point the measurements of the Studio's defaults at a folder of their own (an empty cache): they run
/// alone, after the others, so no other test reads from that folder meanwhile.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class StudioDefaultsCollection { public const string Name = "Anvil.Tests.StudioDefaults"; }

/// <summary>
/// The O11 side of the Studio's defaults of the screen reading (ScreenDefaults, StudioBornValues, StudioDefaults): the same
/// mechanism as ODC, measured on the installed Service Studio. What a fresh element is born with is what the reading omits;
/// the event of a widget inside a Popup takes what it is born with there; a screen written from scratch reads back with
/// what it says plus what the answer of its op declares (DeclaredLook). Each module is measured in its own context (a
/// Traditional Web module, a Mobile app and a Reactive app are three): the first module read never decides for another. No
/// value of the Studio is written here. Needs the Service Studio; without it the tests return.
/// </summary>
[Collection(StudioDefaultsCollection.Name)]
public class StudioDefaultsTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(StudioDefaultsTests).Assembly.Location)!)!;
    private static readonly string Fixture = Path.Combine(Root, "tests", "fixtures", "reactive-ui.oml");
    private static readonly string Traditional = Path.Combine(Root, "tests", "fixtures", "traditional-ui.oml");
    private static readonly string Mobile = Path.Combine(Root, "tests", "fixtures", "mobile-ui.oml");

    [Fact]
    public void TheDefaultsAreWhatTheInstalledServiceStudioGivesAFreshElement()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: skipped."); return; }
        var host = new ModelHost(Work());
        var measured = host.MeasureBorn(File.ReadAllBytes(Fixture));
        foreach (var line in measured.Log.Where(l => l.StartsWith("not created", StringComparison.Ordinal))) output.WriteLine(line);
        var studio = ScreenDefaults.FromBorn("test", measured.Born, measured.Roles);
        // Every setting a fresh element is born with is its default, whatever its value in this Studio (no value is listed here);
        // a named boolean attribute of the language means what the language says instead (an input without mandatory is optional).
        var settings = 0;
        foreach (var (key, facts) in measured.Born) {
            var popup = key.EndsWith(ScreenDefaults.PopupSuffix, StringComparison.Ordinal);
            var kind = popup ? key[..^ScreenDefaults.PopupSuffix.Length] : key;
            foreach (var (property, fact) in facts)
                if (ScreenDefaults.IsSetting(kind, measured.Roles[key], property, fact)) {
                    Assert.Equal(ScreenDefaults.LanguageDefault(kind, property) ?? fact[2..], studio.DefaultOf(kind, property, fact[0], popup));
                    settings++;
                }
        }
        Assert.Equal("False", studio.DefaultOf("InputParameter", "IsMandatory", 'b'));
        Assert.Equal("False", studio.DefaultOf("BlockEvent", "IsMandatory", 'b'));
        output.WriteLine(settings + " settings over " + measured.Born.Count + " kinds");
        Assert.Equal(measured.Born["Container"]["Visible"][2..], studio.DefaultOf("Container", "Visible", 'e'));
        Assert.Equal(measured.Born["Container"]["Width"][2..], studio.DefaultOf("Container", "Width", 't'));
        // The native event of a widget (a UILifeCycleEvent on O11), on a page and inside a Popup: each where it was born.
        Assert.Equal(measured.Born["UILifeCycleEvent"]["Transition"][2..], studio.DefaultOf("UILifeCycleEvent", "Transition", 'v'));
        Assert.Equal(measured.Born["UILifeCycleEvent" + ScreenDefaults.PopupSuffix]["Transition"][2..], studio.DefaultOf("UILifeCycleEvent", "Transition", 'v', inPopup: true));
        // A class, a name and an icon a fresh element shows are the developer's.
        Assert.Equal("", studio.DefaultOf("Button", "Style", 'e'));
        Assert.Equal("", studio.DefaultOf("Icon", "Icon", 't'));
    }

    [Fact]
    public void AScreenWrittenFromScratchReadsBackWithWhatItSaysPlusWhatItsAnswerDeclares()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: skipped."); return; }
        var work = Work();
        var host = new ModelHost(work);
        WriteProbeScreen(host, work, "probe");
    }

    [Fact]
    public void EachModuleIsMeasuredInItsOwnContextWhateverWasMeasuredFirst()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: skipped."); return; }
        var work = Work();
        var host = new ModelHost(work);
        var reactive = File.ReadAllBytes(Fixture);
        try {
            // The Reactive app read alone, with an empty cache: the reference.
            StudioDefaults.ResetForTests(Path.Combine(work, "cache-alone"));
            var alone = host.HtmlRead(reactive, null, withKeys: false);
            // A Traditional Web module first (its pages take no Reactive widget), then a Mobile app, then the Reactive app.
            var cache = Path.Combine(work, "cache");
            StudioDefaults.ResetForTests(cache);
            var answered = new[] { ("Traditional", File.ReadAllBytes(Traditional)), ("Mobile", File.ReadAllBytes(Mobile)), ("Reactive", reactive) }
                .Select(m => (Name: m.Item1, Bytes: m.Item2, Defaults: host.StudioDefaultsOf(m.Item2))).ToList();
            foreach (var (name, bytes, defaults) in answered) {
                output.WriteLine(name + ": context " + defaults.Context + ", " + defaults.Kinds.Count() + " kinds" + (defaults.Note.Length > 0 ? ", note " + defaults.Note : ""));
                Assert.True(defaults.Measured, name + ": " + defaults.Note);
                var own = host.MeasureBorn(bytes);
                Assert.Equal(Kinds(ScreenDefaults.FromBorn(defaults.Identity, own.Born, own.Roles)), Kinds(defaults));
            }
            Assert.Equal(3, answered.Select(a => a.Defaults.Context).Distinct().Count());
            // The Reactive app reads the same text after the others were measured as read alone.
            var after = host.HtmlRead(reactive, null, withKeys: false);
            var before = alone["documents"]!.AsArray().ToDictionary(d => d!["rootKey"]!.ToString(), d => d!["htmlSha256"]!.ToString());
            var now = after["documents"]!.AsArray().ToDictionary(d => d!["rootKey"]!.ToString(), d => d!["htmlSha256"]!.ToString());
            Assert.Equal(before.Count, now.Count);
            foreach (var (key, sha) in before) Assert.Equal(sha, now[key]);
            output.WriteLine(before.Count + " documents read the same");
            // And a screen written in it is born at its defaults (a Traditional Web measurement never reaches it).
            WriteProbeScreen(host, work, "after-traditional");
        }
        finally { StudioDefaults.ResetForTests(); }
    }

    // Review of 3ab12209, finding 6: recipe 6 tried the 19 Traditional-only widget kinds in every Reactive and Mobile page (and
    // ODC: StudioDefaultsOdcTests), about 3,000 refused creates per context. Each context tries the widget kinds of its runtime
    // only: no Traditional-only kind in a Reactive or Mobile page; in a Traditional Web page its Traditional kinds, never a
    // Reactive kind the writer writes as its Traditional counterpart (ScreenHtmlTables.TraditionalKind).
    [Fact]
    public void EachContextTriesOnlyTheWidgetKindsOfItsRuntime()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: skipped."); return; }
        var host = new ModelHost(Work());
        foreach (var (name, file, traditional) in new[] { ("Reactive", Fixture, false), ("Mobile", Mobile, false), ("Traditional", Traditional, true) }) {
            var bytes = File.ReadAllBytes(file);
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var measured = host.MeasureBorn(bytes);
            var tried = TriedKinds(measured.Log);
            output.WriteLine(name + ": measured in " + sw.ElapsedMilliseconds + " ms, " + measured.Born.Count + " kinds born, " + measured.Log.Count + " log lines, "
                + measured.Log.Count(l => l.StartsWith("create ", StringComparison.Ordinal)) + " refused creates");
            output.WriteLine(name + " born: " + string.Join(", ", measured.Born.Keys));
            Assert.True(measured.Born.Values.Count > 0 && measured.Roles.Values.Any(r => r is "screen" or "block"), name + ": nothing measured");
            if (!traditional) {
                var wrong = tried.Where(ScreenHtmlTables.TraditionalOnly.Contains).Distinct().Order(StringComparer.Ordinal).ToList();
                Assert.True(wrong.Count == 0, name + ": Traditional-only kinds tried: " + string.Join(", ", wrong));
                Assert.DoesNotContain(measured.Born.Keys, k => ScreenHtmlTables.TraditionalOnly.Contains(k.Split('@')[0]));
                Assert.Contains("Container", measured.Born.Keys);
                Assert.Contains("MobileBlockInstanceWidget", measured.Born.Keys);
            } else {
                var replaced = tried.Where(k => ScreenHtmlTables.TraditionalKind(k) != k).Distinct().Order(StringComparer.Ordinal).ToList();
                Assert.True(replaced.Count == 0, name + ": Reactive kinds written as their Traditional counterpart tried: " + string.Join(", ", replaced));
                foreach (var kind in new[] { "ContainerWidget", "ButtonWidget", "LinkWidget", "InputWidget", "ExpressionWidget", "CheckBoxWidget", "ComboBoxWidget", "TableRecordsWidget", "WebBlockInstanceWidget" })
                    Assert.True(measured.Born.ContainsKey(kind), name + ": " + kind + " not measured");
                Assert.DoesNotContain("MobileBlockInstanceWidget", tried);
            }
        }
    }

    // The kinds a measurement tried and the Studio refused ("create X under Y: ...", "not created: X", "not created in a popup: X").
    private static List<string> TriedKinds(IEnumerable<string> log) =>
        log.Select(l => Regex.Match(l, @"^(?:create (?<k>\w+) under |not created(?: in a popup)?: (?<k>\w+)$)")).Where(m => m.Success).Select(m => m.Groups["k"].Value).ToList();

    // Cache names (review of 3ab12209): the kept file names the schema and the recipe of the kernel that measured it, so two
    // kernel releases that share one root keep two files and never overwrite each other's.
    [Fact]
    public void TheKeptMeasurementNamesItsSchemaAndRecipeAndLeavesAnotherReleasesFile()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: skipped."); return; }
        var work = Work();
        var host = new ModelHost(work);
        var cache = Path.Combine(work, "cache");
        try {
            StudioDefaults.ResetForTests(cache);
            var id = StudioDefaults.Identity();
            var bytes = File.ReadAllBytes(Fixture);
            var context = host.StudioDefaultsOf(bytes).Context;
            var dir = Path.Combine(cache, "ss11");
            var schema = StudioDefaults.Schema[(StudioDefaults.Schema.LastIndexOf('/') + 1)..];
            var expected = "studio-defaults.s" + schema + "-r" + StudioBornValues.Recipe + "." + id + "." + context + ".json";
            var kept = Directory.GetFiles(dir, "studio-defaults.*.json").Select(Path.GetFileName).ToList();
            Assert.Equal(new[] { expected }, kept);
            // A file another release kept for the same Studio identity and context (another recipe) is never read or overwritten.
            var other = Path.Combine(dir, "studio-defaults.s" + schema + "-r" + (StudioBornValues.Recipe + 1) + "." + id + "." + context + ".json");
            File.WriteAllText(other, "{\"other\":\"release\"}");
            File.Delete(Path.Combine(dir, expected));
            StudioDefaults.ResetForTests(cache);
            Assert.True(host.StudioDefaultsOf(bytes).Measured);
            Assert.Equal("{\"other\":\"release\"}", File.ReadAllText(other));
            Assert.True(File.Exists(Path.Combine(dir, expected)));
            Assert.Equal(2, Directory.GetFiles(dir, "studio-defaults.*.json").Length);
        }
        finally { StudioDefaults.ResetForTests(); }
    }

    [Fact]
    public void AFlowWithAThemeOfItsOwnReadsWithItsDefaultsTheSameOnEveryLoad()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: skipped."); return; }
        var work = Work();
        var host = new ModelHost(work);
        var reactive = File.ReadAllBytes(Fixture);
        try {
            // One job, with an empty cache: a theme without a base and without a grid, a UI flow with it (the prototype importer's
            // shape) and a screen written in html there. The flow's defaults are measured inside the job's command: its theme is not
            // in the base, a fresh theme of the copy is given its settings.
            StudioDefaults.ResetForTests(Path.Combine(work, "cache-build"));
            const string html = "<screen name=\"GridlessProbe\" flow=\"ProbeFlow\" roles=\"Registered\">\n<div class=\"probe\">\n <span class=\"tag\">Ok</span>\n <i icon=\"lock\"/>\n</div>\n</screen>\n";
            var ops = new JsonArray(
                JsonNode.Parse("""{"op":"create","parent":"@espace","type":"IMobileTheme","name":"ProbeTheme","as":"$t"}"""),
                JsonNode.Parse("""{"op":"set","target":"$t","prop":"BaseTheme","empty":true}"""),
                JsonNode.Parse("""{"op":"set","target":"$t","prop":"GridType","value":"No"}"""),
                JsonNode.Parse("""{"op":"create","parent":"@espace","type":"IMobileFlow","name":"ProbeFlow","as":"$f"}"""),
                JsonNode.Parse("""{"op":"set","target":"$f","prop":"Theme","value":"$t"}"""),
                new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } });
            var job = Path.Combine(work, "gridless.json");
            File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
            var outFile = Path.Combine(work, "gridless.oml");
            var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, Fixture, job, outFile))!;
            Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString()[..Math.Min(3000, result.ToJsonString().Length)]);
            var module = File.ReadAllBytes(outFile);
            StudioDefaults.ResetForTests(Path.Combine(work, "cache-alone"));
            var alone = Shas(host.HtmlRead(reactive, null, withKeys: true));
            var flowOf = host.FlowsOfPages(module);
            var flows = flowOf.Values.Distinct().Order(StringComparer.Ordinal).ToList();
            Dictionary<string, string>? first = null;
            // Each load with an empty cache, the flows measured first in another order each time: the same text.
            for (var load = 0; load < 3; load++) {
                StudioDefaults.ResetForTests(Path.Combine(work, "cache-" + load));
                output.WriteLine("flows as loaded: " + string.Join(" ", host.FlowsAsLoaded(module)));
                var asked = flows.Skip(load % flows.Count).Concat(flows.Take(load % flows.Count)).ToList();
                if (load % 2 == 1) asked.Reverse();
                foreach (var flow in asked) Assert.True(host.StudioDefaultsOf(module, flow).Measured, flow);
                var read = Shas(host.HtmlRead(module, null, withKeys: true));
                if (first == null) first = read;
                else foreach (var (key, sha) in first) Assert.True(sha == read[key], "load " + load + ": " + key + " reads another text");
            }
            // The pages of the other flows read as in the app alone; the flow without a grid has a context of its own.
            foreach (var (key, sha) in first!.Where(d => flowOf[d.Key] != "ProbeFlow")) Assert.True(sha == alone[key], key + " reads another text than in the app alone");
            var probe = host.StudioDefaultsOf(module, "ProbeFlow");
            Assert.NotEqual(host.StudioDefaultsOf(module).Context, probe.Context);
            var document = host.HtmlRead(module, "GridlessProbe", withKeys: false)["documents"]!.AsArray().Single()!;
            var text = Regex.Replace(document["html"]!.GetValue<string>(), " k=\"[^\"]*\"", "");
            output.WriteLine(text);
            Assert.Null(document["defaults"]);
            const string gridlessBody = "<div class=\"probe\">\n <span class=\"tag\">Ok</span>\n <i icon=\"lock\"/>\n</div>\n";
            Assert.Contains(gridlessBody, DeclaredLook.WithoutDeclared(text, result, "GridlessProbe", gridlessBody));
            Assert.DoesNotContain("os-GridType", text);
            Assert.DoesNotContain("os-MarginLeft", text);
            // A job that changes the grid of that theme (in its base now) and writes a page in its flow: the copy's theme is given the
            // job's settings, and the page is born at the defaults of the new context.
            StudioDefaults.ResetForTests(Path.Combine(work, "cache-regrid"));
            const string again = "<screen name=\"RegridProbe\" flow=\"ProbeFlow\" roles=\"Registered\">\n<div class=\"probe\">\n <span class=\"tag\">Again</span>\n</div>\n</screen>\n";
            var regrid = Path.Combine(work, "regrid.json");
            File.WriteAllText(regrid, new JsonObject { ["ops"] = new JsonArray(
                JsonNode.Parse("""{"op":"set","target":"MobileTheme:ProbeTheme","prop":"GridType","value":"Fluid"}"""),
                new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = again } }) }.ToJsonString());
            var regridOut = Path.Combine(work, "regrid.oml");
            var regridResult = JsonSerializer.SerializeToNode(JobRunner.Run(host, outFile, regrid, regridOut))!;
            Assert.True(regridResult["accepted"]!.GetValue<bool>(), regridResult.ToJsonString()[..Math.Min(3000, regridResult.ToJsonString().Length)]);
            var regridded = File.ReadAllBytes(regridOut);
            Assert.NotEqual(probe.Context, host.StudioDefaultsOf(regridded, "ProbeFlow").Context);
            var page = host.HtmlRead(regridded, "RegridProbe", withKeys: false)["documents"]!.AsArray().Single()!;
            var pageText = Regex.Replace(page["html"]!.GetValue<string>(), " k=\"[^\"]*\"", "");
            output.WriteLine(pageText);
            Assert.Null(page["defaults"]);
            const string regridBody = "<div class=\"probe\">\n <span class=\"tag\">Again</span>\n</div>\n";
            Assert.Contains(regridBody, DeclaredLook.WithoutDeclared(pageText, regridResult, "RegridProbe", regridBody));
            Assert.DoesNotContain("os-GridType", pageText);
        }
        finally { StudioDefaults.ResetForTests(); }
    }

    [Fact]
    public void AnInputOrABlockEventWithoutMandatoryIsNotMandatoryWhateverTheStudioGivesAFreshOne()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: skipped."); return; }
        var work = Work();
        var host = new ModelHost(work);
        // What this Studio gives a fresh input and block event (Service Studio 11.55.87: mandatory): the text does not follow it.
        var born = host.MeasureBorn(File.ReadAllBytes(Fixture)).Born;
        output.WriteLine("born: InputParameter " + born["InputParameter"].GetValueOrDefault("IsMandatory") + ", BlockEvent " + born["BlockEvent"].GetValueOrDefault("IsMandatory"));
        // A screen with an optional input (a default), an optional one without a default and a mandatory one, and a block with an
        // optional and a mandatory input and event, each written in the order the reading writes it; a caller that passes only the
        // mandatory input (valid only when the others are optional).
        const string screen = "<input name=\"Filter\" default='\"all\"' type=\"Text\"/>\n<input name=\"Page\" type=\"Integer\"/>\n<input name=\"Term\" mandatory=\"True\" type=\"Text\"/>\n";
        const string block = "<input name=\"Label\" default='\"b\"' type=\"Text\"/>\n<input name=\"Caption\" mandatory=\"True\" type=\"Text\"/>\n<event name=\"OnClose\" mandatory=\"True\"/>\n<event name=\"OnPick\"/>\n";
        JsonObject Html(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };
        var job = Path.Combine(work, "mandatory.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(
            Html("<screen name=\"MandatoryProbe\" roles=\"Registered\">\n" + screen + "</screen>\n"),
            Html("<block name=\"MandatoryProbeBlock\">\n" + block + "</block>\n"),
            Html("<screen name=\"MandatoryCaller\" roles=\"Registered\">\n<a onclick='MandatoryProbe(Term = \"x\")'>go</a>\n</screen>\n")) }.ToJsonString());
        var outFile = Path.Combine(work, "mandatory.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, Fixture, job, outFile))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString()[..Math.Min(3000, result.ToJsonString().Length)]);
        // The model: mandatory exactly where the text says so.
        foreach (var (path, mandatory) in new[] {
            ("MandatoryProbe/InputParameter:Filter", "False"), ("MandatoryProbe/InputParameter:Page", "False"), ("MandatoryProbe/InputParameter:Term", "True"),
            ("MandatoryProbeBlock/InputParameter:Label", "False"), ("MandatoryProbeBlock/InputParameter:Caption", "True"),
            ("MandatoryProbeBlock/BlockEvent:OnPick", "False"), ("MandatoryProbeBlock/BlockEvent:OnClose", "True") }) {
            var kind = path[(path.IndexOf('/') + 1)..path.IndexOf(':')]; var name = path[(path.IndexOf(':') + 1)..];
            var facts = host.ReadModel(outFile, "/", new(Kind: kind, Name: name, Properties: "IsMandatory", Max: 200))["entries"]!.AsArray()
                .Select(e => e!["path"]!.ToString() + " " + e["properties"]?["IsMandatory"]).ToList();
            Assert.True(facts.Any(f => f.EndsWith(":" + path + " " + mandatory, StringComparison.Ordinal)), path + " is not IsMandatory " + mandatory + ": " + string.Join("; ", facts));
        }
        // The reading gives the same text back, the same on a second read, and is a fixed point.
        var bytes = File.ReadAllBytes(outFile);
        var check = host.HtmlCheck(bytes);
        foreach (var (root, body) in new[] { ("MandatoryProbe", screen), ("MandatoryProbeBlock", block) }) {
            var document = host.HtmlRead(bytes, root, withKeys: false)["documents"]!.AsArray().Single()!;
            var text = Regex.Replace(document["html"]!.GetValue<string>(), " k=\"[^\"]*\"", "");
            output.WriteLine(text);
            Assert.Null(document["defaults"]);
            Assert.Contains(body, text);
            Assert.Equal(document["htmlSha256"]!.ToString(), host.HtmlRead(bytes, root, withKeys: false)["documents"]!.AsArray().Single()!["htmlSha256"]!.ToString());
            var row = check["documents"]!.AsArray().Single(d => d!["root"]!.ToString() == root)!;
            Assert.Equal(0, row["ops"]!.GetValue<int>());
            Assert.Equal(0, row["problemCount"]!.GetValue<int>());
        }
    }

    [Fact]
    public void AJoinWithoutATypeIsALeftJoinAndAnIconWithoutASizeKeepsTheFontSize()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: skipped."); return; }
        var work = Work();
        var host = new ModelHost(work);
        // What this Studio gives a fresh Join and Icon (Service Studio 11.55.87: Inner and Twotimes): the text does not follow it.
        var born = host.MeasureBorn(File.ReadAllBytes(Fixture)).Born;
        output.WriteLine("born: Join " + born.GetValueOrDefault("Join")?.GetValueOrDefault("JoinType") + ", Icon " + born["Icon"].GetValueOrDefault("IconSize"));
        // Two entities, one referencing the other (the static one); a screen with an aggregate that joins them (the short form)
        // and an icon.
        const string spec = """
            {"op": "spec", "data": {
              "static": [{"name": "ProbeStatus", "records": [{"name": "Open", "label": "Open"}, {"name": "Closed", "label": "Closed"}], "public": true}],
              "entities": [{"name": "ProbeOrder", "attributes": [{"name": "Number", "type": "Text", "length": 20}, {"name": "ProbeStatusId", "type": "ProbeStatus Identifier"}], "public": true}]}}
            """;
        const string body = "<div class=\"probe\">\n <i icon=\"times\"/>\n</div>\n";
        var job = Path.Combine(work, "join.json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(JsonNode.Parse(spec),
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = "<screen name=\"JoinProbe\" roles=\"Registered\">\n<aggregate name=\"GetOrders\" from=\"ProbeOrder\" join=\"ProbeStatus on ProbeOrder.ProbeStatusId = ProbeStatus.Id\" max=\"50\"/>\n" + body + "</screen>\n" } }) }.ToJsonString());
        var outFile = Path.Combine(work, "join.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, Fixture, job, outFile))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString()[..Math.Min(3000, result.ToJsonString().Length)]);
        // Every Join and Icon of the page in the model: Left and FontSize; the reading names neither and gives the body back.
        var screen = host.ReadModel(outFile, "/", new(Kind: "MobileScreen", Name: "JoinProbe", Max: 5))["entries"]!.AsArray().Single()!["reference"]!.ToString();
        foreach (var (kind, property, value) in new[] { ("Join", "JoinType", "Left"), ("Icon", "IconSize", "FontSize") }) {
            var facts = host.ReadModel(outFile, screen, new(Kind: kind, Properties: property, Max: 200))["entries"]!.AsArray()
                .Select(e => e!["path"]!.ToString() + " " + e!["properties"]?[property]).ToList();
            output.WriteLine(string.Join("\n", facts));
            Assert.NotEmpty(facts);
            Assert.All(facts, f => Assert.EndsWith(" " + value, f));
        }
        var bytes = File.ReadAllBytes(outFile);
        var document = host.HtmlRead(bytes, "JoinProbe", withKeys: false)["documents"]!.AsArray().Single()!;
        var text = Regex.Replace(document["html"]!.GetValue<string>(), " k=\"[^\"]*\"", "");
        output.WriteLine(text);
        Assert.Null(document["defaults"]);
        Assert.Contains(body, DeclaredLook.WithoutDeclared(text, result, "JoinProbe", body));
        Assert.DoesNotContain("os-JoinType", text);
        Assert.DoesNotContain(" size=", text);
        var row = host.HtmlCheck(bytes)["documents"]!.AsArray().Single(d => d!["root"]!.ToString() == "JoinProbe")!;
        Assert.Equal(0, row["ops"]!.GetValue<int>());
        Assert.Equal(0, row["problemCount"]!.GetValue<int>());
    }

    [Fact]
    public void TheDeclaredLookSumsTheNotesOfOneClassAndKeepsTheClassesTheAuthorWrote()
    {
        // Review of the CX17 merge, B2: the helper compared each note with every class of its value in the text, so two notes of
        // one class (an Input and a TextArea are both form-control) or the author's own class btn beside a new button failed. The
        // notes are summed per class, the author's classes discounted, and only the declared ones are taken out (never the author's).
        static JsonObject Note(string code, string element, int count, string written) => new()
        {
            ["code"] = code, ["element"] = element, ["count"] = count,
            ["note"] = $"a new {element} without class (synthetic): the reading writes it as class=\"{written}\"",
        };
        static JsonObject Answer(params JsonObject[] notes) => new()
        {
            ["results"] = new JsonArray(new JsonObject { ["result"] = new JsonObject { ["root"] = "LookProbe", ["normalized"] = new JsonArray(notes.Select(n => (JsonNode)n.DeepClone()).ToArray()) } }),
        };
        var answer = Answer(Note(ScreenVisual.StudioClassKept, "Input", 2, "form-control"), Note(ScreenVisual.StudioClassKept, "TextArea", 1, "form-control"),
            Note(ScreenVisual.StudioClassTrimmed, "Button", 1, "btn"), new JsonObject { ["code"] = ScreenVisual.PageMarked, ["element"] = "Container", ["count"] = 1 });
        const string body = "<div class=\"look\">\n <input bind=\"Q\"/>\n <input bind=\"Q\" class=\"form-control\" type=\"search\"/>\n <textarea bind=\"Q\"/>\n"
            + " <input bind=\"Q\"/>\n <button onclick=\"Go\">Go</button>\n <button class=\"btn\" onclick=\"Go\">Mine</button>\n</div>\n";
        const string text = "<screen name=\"LookProbe\">\n<div class=\"look\" data-ssam-page=\"1\">\n <input bind=\"Q\" class=\"form-control\"/>\n"
            + " <input bind=\"Q\" class=\"form-control\" type=\"search\"/>\n <textarea bind=\"Q\" class=\"form-control\"/>\n <input bind=\"Q\" class=\"form-control\"/>\n"
            + " <button class=\"btn\" onclick=\"Go\">Go</button>\n <button class=\"btn\" onclick=\"Go\">Mine</button>\n</div>\n</screen>\n";
        var without = DeclaredLook.WithoutDeclared(text, answer, "LookProbe", body);
        Assert.Contains(body, without);
        Assert.DoesNotContain("data-ssam-", without);
        // Never hidden: a class the answer does not declare, one it declares and the text lacks, or a declared class on an element
        // whose author wrote another fails.
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => DeclaredLook.WithoutDeclared(text.Replace("<textarea bind=\"Q\"", "<textarea bind=\"Q\" class=\"form-control\""), answer, "LookProbe", body));
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => DeclaredLook.WithoutDeclared(text.Replace(" class=\"btn\" onclick=\"Go\">Go", " onclick=\"Go\">Go"), answer, "LookProbe", body));
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => DeclaredLook.WithoutDeclared(text.Replace(" data-ssam-page=\"1\"", ""), answer, "LookProbe", body));
        var moved = text.Replace(" <button class=\"btn\" onclick=\"Go\">Go</button>\n <button class=\"btn\" onclick=\"Go\">Mine</button>", " <button class=\"btn\" onclick=\"Go\">Go</button>\n <button onclick=\"Go\">Mine</button>\n <i class=\"btn\"/>");
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => Assert.Contains(body, DeclaredLook.WithoutDeclared(moved, answer, "LookProbe", body)));
    }

    private static Dictionary<string, string> Shas(JsonNode read) =>
        read["documents"]!.AsArray().ToDictionary(d => d!["rootKey"]!.ToString(), d => d!["htmlSha256"]!.ToString() + (d["defaults"] is { } note ? " " + note : ""));

    [Fact]
    public void AnAssemblyRewrittenWithItsOldSizeAndTimesIsHashedAgain()
    {
        // The hash of a Studio assembly is reused only while its stamp holds: size, write and creation time and the NTFS change
        // time, which a write moves even when the write time is put back (verify\e6 of the first review: same size, same date,
        // other content, and the old identity was reused).
        var file = Path.Combine(Work(), "OutSystems.Probe.dll");
        File.WriteAllBytes(file, [1, 2, 3, 4]);
        var created = File.GetCreationTimeUtc(file); var written = File.GetLastWriteTimeUtc(file);
        var before = StudioDefaults.Stamp(file);
        Assert.NotNull(before);
        Assert.Equal(before, StudioDefaults.Stamp(file));
        Thread.Sleep(50);
        File.WriteAllBytes(file, [4, 3, 2, 1]);
        File.SetCreationTimeUtc(file, created); File.SetLastWriteTimeUtc(file, written);
        Assert.Equal(4L, new FileInfo(file).Length);
        Assert.NotEqual(before, StudioDefaults.Stamp(file));
    }

    private void WriteProbeScreen(ModelHost host, string work, string label)
    {
        const string html = "<screen name=\"DefaultsProbe\" roles=\"Registered\">\n<var name=\"Show\" type=\"Boolean\" default=\"False\"/>\n<div class=\"probe\">\n <span class=\"tag\">Ok</span>\n <popup show=\"Show\">\n  <div class=\"inside\">Inside</div>\n </popup>\n</div>\n</screen>\n";
        var job = Path.Combine(work, label + ".json");
        File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } }) }.ToJsonString());
        var outFile = Path.Combine(work, label + ".oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, Fixture, job, outFile))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString()[..Math.Min(3000, result.ToJsonString().Length)]);
        var read = host.HtmlRead(File.ReadAllBytes(outFile), "DefaultsProbe", withKeys: false);
        var document = read["documents"]!.AsArray().Single()!;
        var text = Regex.Replace(document["html"]!.GetValue<string>(), " k=\"[^\"]*\"", "");
        output.WriteLine(text);
        Assert.Null(document["defaults"]);
        const string probeBody = "<div class=\"probe\">\n <span class=\"tag\">Ok</span>\n <popup show=\"Show\">\n  <div class=\"inside\">Inside</div>\n </popup>\n</div>\n";
        Assert.Contains(probeBody, DeclaredLook.WithoutDeclared(text, result, "DefaultsProbe", probeBody));
        var check = host.HtmlCheck(File.ReadAllBytes(outFile));
        var row = check["documents"]!.AsArray().Single(d => d!["root"]!.ToString() == "DefaultsProbe")!;
        Assert.Equal(0, row["ops"]!.GetValue<int>());
        Assert.Equal(0, row["problemCount"]!.GetValue<int>());
    }

    private static string Kinds(ScreenDefaults defaults) => defaults.ToJson()["kinds"]!.ToJsonString();

    private static string Work()
    {
        var dir = Path.Combine(Root, ".local", "studio-defaults", Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
