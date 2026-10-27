using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests.Odc;

/// <summary>The tests that point the measurements of the Studio's defaults at a folder of their own (an empty cache): they run
/// alone, after the others, so no other test reads from that folder meanwhile.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class StudioDefaultsOdcCollection { public const string Name = "Anvil.Tests.Odc.StudioDefaults"; }

/// <summary>
/// The defaults of the screen reading come from the installed ODC Studio, never from a list (ScreenDefaults, StudioBornValues,
/// StudioDefaults). The ODC Studio 1.7.28.10873 (13/10/2026) gave every widget Gap, GridColumns and GridRows; the reading of
/// the Studio before it had a fixed table without them and wrote os-Gap="8px" os-GridColumns="3" os-GridRows="1" on every
/// container and button. What a fresh element is born with also depends on the module (the kind of module and the grid of its
/// theme): each module is measured in its own context, whatever module was measured first, a module without a page (a library,
/// a blank app) is measured too, and one where the Studio makes no page answers why and the writers refuse with it. No value
/// of the Studio is written here: every expected value is read from fresh elements of the installed Studio. Needs the ODC
/// Studio; without it the tests return.
/// </summary>
[Collection(StudioDefaultsOdcCollection.Name)]
public class StudioDefaultsOdcTests(ITestOutputHelper output)
{
    private static readonly string Root = FindRoot();
    private static readonly string Fixture = Path.Combine(Root, "tests", "fixtures", "odc", "insurance-reactive-r8.oml");

    [Fact]
    public void TheDefaultsAreWhatTheInstalledStudioGivesAFreshElement()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var host = new ModelHost(Work());
        var measured = host.MeasureBorn(File.ReadAllBytes(Fixture));
        foreach (var line in measured.Log.Where(l => l.StartsWith("not created", StringComparison.Ordinal))) output.WriteLine(line);
        var studio = ScreenDefaults.FromBorn("test", measured.Born, measured.Roles);
        // Every setting a fresh element is born with is its default, whatever the value in this Studio (the properties of the
        // update of 13/10 among them): the values come from fresh elements of the model, none is written here. A named boolean attribute
        // of the language means what the language says instead (an input without mandatory is optional).
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
        foreach (var (kind, property) in new[] { ("Container", "Gap"), ("Button", "GridColumns"), ("Button", "GridRows"), ("Container", "Visible") })
            if (measured.Born[kind].TryGetValue(property, out var fact)) Assert.Equal(fact[2..], studio.DefaultOf(kind, property, fact[0]));
        // A native event on a page and inside a Popup: each where it was born.
        Assert.Equal(measured.Born["BuiltinEvent"]["Transition"][2..], studio.DefaultOf("BuiltinEvent", "Transition", 'v'));
        Assert.Equal(measured.Born["BuiltinEvent" + ScreenDefaults.PopupSuffix]["Transition"][2..], studio.DefaultOf("BuiltinEvent", "Transition", 'v', inPopup: true));
        // What a fresh element shows the developer to replace is never a default: its class, its name, its icon.
        Assert.Equal("", studio.DefaultOf("Button", "Style", 'e'));
        Assert.Equal("", studio.DefaultOf("Button", "Name", 't'));
        Assert.Equal("", studio.DefaultOf("Icon", "Icon", 't'));
    }

    // Review of 3ab12209, finding 6: recipe 6 tried the 19 Traditional-only widget kinds of O11 in every ODC page too (about
    // 3,000 refused creates per context). ODC has no Traditional Web runtime: no measurement tries one, the Reactive kinds stay.
    [Fact]
    public void AnOdcMeasurementTriesNoTraditionalOnlyKind()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var host = new ModelHost(Work());
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var measured = host.MeasureBorn(File.ReadAllBytes(Fixture));
        output.WriteLine("measured in " + sw.ElapsedMilliseconds + " ms, " + measured.Born.Count + " kinds born, " + measured.Log.Count + " log lines, "
            + measured.Log.Count(l => l.StartsWith("create ", StringComparison.Ordinal)) + " refused creates");
        var tried = measured.Log.Select(l => Regex.Match(l, @"^(?:create (?<k>\w+) under |not created(?: in a popup)?: (?<k>\w+)$)")).Where(m => m.Success).Select(m => m.Groups["k"].Value).ToList();
        var wrong = tried.Where(ScreenHtmlTables.TraditionalOnly.Contains).Distinct().Order(StringComparer.Ordinal).ToList();
        Assert.True(wrong.Count == 0, "Traditional-only kinds tried: " + string.Join(", ", wrong));
        Assert.DoesNotContain(measured.Born.Keys, k => ScreenHtmlTables.TraditionalOnly.Contains(k.Split('@')[0]));
        foreach (var kind in new[] { "Container", "Button", "Link", "Input", "MobileBlockInstanceWidget", "TableRecords" }) Assert.True(measured.Born.ContainsKey(kind), kind + " not measured");
    }

    [Fact]
    public void EachModuleIsMeasuredInItsOwnContextWhateverWasMeasuredFirst()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var work = Work();
        var host = new ModelHost(work);
        // A Mobile app, a library and a CrossDevice app without a theme, blank (as the installed Studio creates them), then the
        // Reactive app with its theme: measured in that order with an empty cache.
        var modules = new List<(string Name, byte[] Bytes)>();
        foreach (var kind in new[] { "Mobile", "ReactiveLibrary", "CrossDevice" }) {
            var path = Path.Combine(work, "blank-" + kind + ".oml");
            OdcBlankModule.Create(host, kind, "DefaultsBlank" + kind, path);
            modules.Add((kind, File.ReadAllBytes(path)));
        }
        modules.Add(("Reactive", File.ReadAllBytes(Fixture)));
        var cache = Path.Combine(work, "cache");
        try {
            StudioDefaults.ResetForTests(cache);
            var answered = modules.Select(m => (m.Name, m.Bytes, Defaults: host.StudioDefaultsOf(m.Bytes))).ToList();
            foreach (var (name, bytes, defaults) in answered) {
                output.WriteLine(name + ": context " + defaults.Context + ", " + defaults.Kinds.Count() + " kinds" + (defaults.Note.Length > 0 ? ", note " + defaults.Note : ""));
                Assert.True(defaults.Measured, name + ": " + defaults.Note);
                // Each module's defaults are what a fresh element is born with in that module, not in the one measured first.
                var own = host.MeasureBorn(bytes);
                Assert.Equal(Kinds(ScreenDefaults.FromBorn(defaults.Identity, own.Born, own.Roles)), Kinds(defaults));
            }
            // Four kinds of module, four contexts, one kept file each.
            Assert.Equal(4, answered.Select(a => a.Defaults.Context).Distinct().Count());
            Assert.Equal(4, Directory.GetFiles(Path.Combine(cache, "odc"), "studio-defaults.*.*.json").Length);
            // A new process (nothing in memory) reads them back as they were measured.
            StudioDefaults.ResetForTests(cache);
            foreach (var (name, bytes, defaults) in answered) Assert.Equal(Kinds(defaults), Kinds(host.StudioDefaultsOf(bytes)));
        }
        finally { StudioDefaults.ResetForTests(); }
    }

    [Fact]
    public void AScreenWrittenFromScratchReadsBackWithoutTheStudiosDefaults()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var work = Work();
        var host = new ModelHost(work);
        const string html = "<screen name=\"DefaultsProbe\" roles=\"DefaultsProbeRole\">\n<var name=\"Show\" type=\"Boolean\" default=\"False\"/>\n<div class=\"probe\">\n <span class=\"tag\">Ok</span>\n <popup show=\"Show\">\n  <div class=\"inside\">Inside</div>\n </popup>\n</div>\n</screen>\n";
        // A role for the screen (a screen without one is a security warning, which refuses the job).
        var outFile = Apply(host, work, Fixture, "insurance", Op("IRole", "DefaultsProbeRole"), Html(html));
        AssertReadsBackAsWritten(host, outFile, "DefaultsProbe", "<div class=\"probe\">\n <span class=\"tag\">Ok</span>\n <popup show=\"Show\">\n  <div class=\"inside\">Inside</div>\n </popup>\n</div>\n");
    }

    [Fact]
    public void APageIsWrittenWithAnEmptyCacheInABlankAppAndInALibrary()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var work = Work();
        var host = new ModelHost(work);
        try {
            // A blank CrossDevice app (no flow, no theme), first module read after a Studio update: a flow and a screen with a popup.
            var app = Path.Combine(work, "blank-CrossDevice.oml");
            OdcBlankModule.Create(host, "CrossDevice", "DefaultsBlankApp", app);
            StudioDefaults.ResetForTests(Path.Combine(work, "cache-app"));
            const string screen = "<screen name=\"DefaultsProbe\" roles=\"DefaultsProbeRole\">\n<var name=\"Show\" type=\"Boolean\" default=\"False\"/>\n<div class=\"probe\">\n <span class=\"tag\">Ok</span>\n <popup show=\"Show\">\n  <div class=\"inside\">Inside</div>\n </popup>\n</div>\n</screen>\n";
            var appOut = Apply(host, work, app, "app", Op("IRole", "DefaultsProbeRole"), Op("IMobileFlow", "MainFlow"), Html(screen));
            AssertReadsBackAsWritten(host, appOut, "DefaultsProbe", "<div class=\"probe\">\n <span class=\"tag\">Ok</span>\n <popup show=\"Show\">\n  <div class=\"inside\">Inside</div>\n </popup>\n</div>\n");
            // A blank library, with an empty cache, and then with the cache of an app: a flow and a block, then a second block.
            var library = Path.Combine(work, "blank-ReactiveLibrary.oml");
            OdcBlankModule.Create(host, "ReactiveLibrary", "DefaultsBlankLibrary", library);
            const string first = "<block name=\"DefaultsProbeBlock\">\n<div class=\"probe\">\n <span class=\"tag\">Ok</span>\n <div class=\"inner\">Inner</div>\n</div>\n</block>\n";
            const string second = "<block name=\"SecondBlock\">\n<div class=\"probe\">\n <span class=\"tag\">Two</span>\n</div>\n</block>\n";
            foreach (var appFirst in new[] { false, true }) {
                StudioDefaults.ResetForTests(Path.Combine(work, "cache-library-" + appFirst));
                if (appFirst) Assert.True(host.StudioDefaultsOf(File.ReadAllBytes(Fixture)).Measured);
                var one = Apply(host, work, library, "library-" + appFirst, Op("IMobileFlow", "MainFlow"), Html(first));
                AssertReadsBackAsWritten(host, one, "DefaultsProbeBlock", "<div class=\"probe\">\n <span class=\"tag\">Ok</span>\n <div class=\"inner\">Inner</div>\n</div>\n");
                StudioDefaults.ResetForTests(Path.Combine(work, "cache-library2-" + appFirst));
                var two = Apply(host, work, one, "library2-" + appFirst, Html(second));
                AssertReadsBackAsWritten(host, two, "SecondBlock", "<div class=\"probe\">\n <span class=\"tag\">Two</span>\n</div>\n");
            }
        }
        finally { StudioDefaults.ResetForTests(); }
    }

    [Fact]
    public void AModuleWhereTheStudioMakesNoPageSaysWhyAndTheWriterRefusesWithIt()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var work = Work();
        var host = new ModelHost(work);
        var agent = Path.Combine(work, "blank-AIAgent.oml");
        OdcBlankModule.Create(host, "AIAgent", "DefaultsBlankAgent", agent);
        var cache = Path.Combine(work, "cache");
        try {
            StudioDefaults.ResetForTests(cache);
            var defaults = host.StudioDefaultsOf(File.ReadAllBytes(agent));
            output.WriteLine(defaults.Note);
            Assert.False(defaults.Measured);
            Assert.NotEqual("", defaults.Note);
            // The verdict is kept for the context: a new process answers it from the file.
            StudioDefaults.ResetForTests(cache);
            Assert.Equal(defaults.Note, host.StudioDefaultsOf(File.ReadAllBytes(agent)).Note);
            // A document refused with the reason, never with the platform's word on an empty Visible.
            var job = Path.Combine(work, "agent-job.json");
            File.WriteAllText(job, new JsonObject { ["ops"] = new JsonArray(Html("<block name=\"NoPage\">\n<div class=\"probe\">x</div>\n</block>\n")) }.ToJsonString());
            var error = Assert.ThrowsAny<Exception>(() => JobRunner.Run(host, agent, job, Path.Combine(work, "agent-out.oml")));
            var refusal = Assert.IsType<KernelRefusalException>(error.GetBaseException());
            output.WriteLine(refusal.Code + ": " + refusal.Message);
            Assert.Contains(ScreenDocument.DefaultsMissing, refusal.Problems?.ToJsonString() ?? refusal.Code);
            Assert.Contains(defaults.Note, refusal.Message);
            Assert.DoesNotContain("must be set", refusal.Message);
        }
        finally { StudioDefaults.ResetForTests(); }
    }

    // A screen with an optional input (a default), an optional one without a default and a mandatory one, and a block with an
    // optional and a mandatory input and event, each written in the order the reading writes it; a caller that passes only the
    // mandatory input.
    internal const string MandatoryScreen = "<input name=\"Filter\" default='\"all\"' type=\"Text\"/>\n<input name=\"Page\" type=\"Integer\"/>\n<input name=\"Term\" mandatory=\"True\" type=\"Text\"/>\n";
    internal const string MandatoryBlock = "<input name=\"Label\" default='\"b\"' type=\"Text\"/>\n<input name=\"Caption\" mandatory=\"True\" type=\"Text\"/>\n<event name=\"OnClose\" mandatory=\"True\"/>\n<event name=\"OnPick\"/>\n";
    internal const string MandatoryCaller = "<a onclick='MandatoryProbe(Term = \"x\")'>go</a>\n";
    internal static readonly (string Path, string Mandatory)[] MandatoryFacts = [
        ("MandatoryProbe/InputParameter:Filter", "False"), ("MandatoryProbe/InputParameter:Page", "False"), ("MandatoryProbe/InputParameter:Term", "True"),
        ("MandatoryProbeBlock/InputParameter:Label", "False"), ("MandatoryProbeBlock/InputParameter:Caption", "True"),
        ("MandatoryProbeBlock/BlockEvent:OnPick", "False"), ("MandatoryProbeBlock/BlockEvent:OnClose", "True")];

    [Fact]
    public void AnInputOrABlockEventWithoutMandatoryIsNotMandatoryWhateverTheStudioGivesAFreshOne()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var work = Work();
        var host = new ModelHost(work);
        // What this Studio gives a fresh input and block event (ODC Studio 1.7.28.10873: mandatory): the text does not follow it.
        var born = host.MeasureBorn(File.ReadAllBytes(Fixture)).Born;
        output.WriteLine("born: InputParameter " + born["InputParameter"].GetValueOrDefault("IsMandatory") + ", BlockEvent " + born["BlockEvent"].GetValueOrDefault("IsMandatory"));
        var outFile = Apply(host, work, Fixture, "mandatory", Op("IRole", "MandatoryProbeRole"),
            Html("<screen name=\"MandatoryProbe\" roles=\"MandatoryProbeRole\">\n" + MandatoryScreen + "</screen>\n"),
            Html("<block name=\"MandatoryProbeBlock\">\n" + MandatoryBlock + "</block>\n"),
            Html("<screen name=\"MandatoryCaller\" roles=\"MandatoryProbeRole\">\n" + MandatoryCaller + "</screen>\n"));
        // The model: mandatory exactly where the text says so (the caller that passes only Term is valid: Apply accepted it).
        foreach (var (path, mandatory) in MandatoryFacts) {
            var kind = path[(path.IndexOf('/') + 1)..path.IndexOf(':')]; var name = path[(path.IndexOf(':') + 1)..];
            var facts = host.ReadModel(outFile, "/", new(Kind: kind, Name: name, Properties: "IsMandatory", Max: 200))["entries"]!.AsArray()
                .Select(e => e!["path"]!.ToString() + " " + e["properties"]?["IsMandatory"]).ToList();
            Assert.True(facts.Any(f => f.EndsWith(":" + path + " " + mandatory, StringComparison.Ordinal)), path + " is not IsMandatory " + mandatory + ": " + string.Join("; ", facts));
        }
        // The reading gives the same text back, the same on a second read, and is a fixed point.
        AssertReadsBackAsWritten(host, outFile, "MandatoryProbe", MandatoryScreen);
        AssertReadsBackAsWritten(host, outFile, "MandatoryProbeBlock", MandatoryBlock);
        var again = host.HtmlRead(File.ReadAllBytes(outFile), "MandatoryProbe", withKeys: false)["documents"]!.AsArray().Single()!["htmlSha256"]!.ToString();
        Assert.Equal(host.HtmlRead(File.ReadAllBytes(outFile), "MandatoryProbe", withKeys: false)["documents"]!.AsArray().Single()!["htmlSha256"]!.ToString(), again);
    }

    // Two entities, one referencing the other (the static one), for an aggregate with a join.
    internal const string JoinSpec = """
        {"op": "spec", "data": {
          "static": [{"name": "ProbeStatus", "records": [{"name": "Open", "label": "Open"}, {"name": "Closed", "label": "Closed"}], "public": true}],
          "entities": [{"name": "ProbeOrder", "attributes": [{"name": "Number", "type": "Text", "length": 20}, {"name": "ProbeStatusId", "type": "ProbeStatus Identifier"}], "public": true}]}}
        """;
    internal const string JoinScreen = "<aggregate name=\"GetOrders\" from=\"ProbeOrder\" join=\"ProbeStatus on ProbeOrder.ProbeStatusId = ProbeStatus.Id\" max=\"50\"/>\n<div class=\"probe\">\n <i icon=\"times\"/>\n</div>\n";

    [Fact]
    public void AJoinWithoutATypeIsALeftJoinAndAnIconWithoutASizeKeepsTheFontSize()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var work = Work();
        var host = new ModelHost(work);
        // What this Studio gives a fresh Join and Icon (ODC Studio 1.7.28.10873: Inner and Twotimes): the text does not follow it.
        var born = host.MeasureBorn(File.ReadAllBytes(Fixture)).Born;
        output.WriteLine("born: Join " + born.GetValueOrDefault("Join")?.GetValueOrDefault("JoinType") + ", Icon " + born["Icon"].GetValueOrDefault("IconSize"));
        var outFile = Apply(host, work, Fixture, "join", JsonNode.Parse(JoinSpec)!.AsObject(), Op("IRole", "JoinProbeRole"),
            Html("<screen name=\"JoinProbe\" roles=\"JoinProbeRole\">\n" + JoinScreen + "</screen>\n"));
        AssertLeftJoinAndFontSize(host, outFile, "JoinProbe", output.WriteLine);
        AssertReadsBackAsWritten(host, outFile, "JoinProbe", "<div class=\"probe\">\n <i icon=\"times\"/>\n</div>\n");
    }

    // Every Join and Icon of the page in the model: Left and FontSize; the reading names neither.
    internal static void AssertLeftJoinAndFontSize(ModelHost host, string oml, string root, Action<string> log)
    {
        var screen = host.ReadModel(oml, "/", new(Kind: "MobileScreen", Name: root, Max: 5))["entries"]!.AsArray().Single()!["reference"]!.ToString();
        foreach (var (kind, property, value) in new[] { ("Join", "JoinType", "Left"), ("Icon", "IconSize", "FontSize") }) {
            var facts = host.ReadModel(oml, screen, new(Kind: kind, Properties: property, Max: 200))["entries"]!.AsArray()
                .Select(e => e!["path"]!.ToString() + " " + e!["properties"]?[property]).ToList();
            log(string.Join("\n", facts));
            Assert.NotEmpty(facts);
            Assert.All(facts, f => Assert.EndsWith(" " + value, f));
        }
        var text = host.HtmlRead(File.ReadAllBytes(oml), root, withKeys: false)["documents"]!.AsArray().Single()!["html"]!.ToString();
        Assert.DoesNotContain("os-JoinType", text);
        Assert.DoesNotContain(" size=", text);
    }

    // The module of the variant of defect B (2nd review, rF): insurance whose Layouts flow takes a theme of its own without a grid
    // (BaseTheme null, the grid Inherited from nothing), and a new flow ProbeFlow with another one (BaseTheme null, GridType No: the
    // prototype importer's shape) holding a screen the Studio creates (raw) and a screen written in html. Invalid on purpose: the
    // layout blocks of Layouts keep margins in grid columns.
    private static JsonObject[] TwoThemesOps(string role) => [
        Op("IRole", role),
        new() { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IMobileTheme", ["name"] = "GridlessTheme", ["as"] = "$g" },
        new() { ["op"] = "set", ["target"] = "$g", ["prop"] = "BaseTheme", ["value"] = null },
        new() { ["op"] = "set", ["target"] = "IMobileFlow:Layouts", ["prop"] = "Theme", ["value"] = "$g" },
        new() { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IMobileTheme", ["name"] = "ProbeTheme", ["as"] = "$t" },
        new() { ["op"] = "set", ["target"] = "$t", ["prop"] = "BaseTheme", ["value"] = null },
        new() { ["op"] = "set", ["target"] = "$t", ["prop"] = "GridType", ["value"] = "No" },
        new() { ["op"] = "create", ["parent"] = "@espace", ["type"] = "IMobileFlow", ["name"] = "ProbeFlow", ["as"] = "$f" },
        new() { ["op"] = "set", ["target"] = "$f", ["prop"] = "Theme", ["value"] = "$t" },
        new() { ["op"] = "create", ["parent"] = "$f", ["type"] = "IMobileScreen", ["name"] = "RawProbe", ["as"] = "$s" },
        new() { ["op"] = "create", ["parent"] = "$s", ["type"] = "IContainer", ["name"] = "RawContainer", ["as"] = "$c" },
        new() { ["op"] = "create", ["parent"] = "$c", ["type"] = "IButton", ["name"] = "RawButton" },
        new() { ["op"] = "create", ["parent"] = "$c", ["type"] = "IIcon", ["name"] = "RawIcon" },
        Html("<screen name=\"HtmlProbe\" flow=\"ProbeFlow\" roles=\"" + role + "\">\n<div class=\"probe\">\n <span class=\"tag\">Ok</span>\n <button>Go</button>\n</div>\n</screen>\n"),
    ];

    [Fact]
    public void TheSameModuleReadsTheSameTextOnEveryLoadWhicheverFlowIsMeasuredFirst()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var work = Work();
        var host = new ModelHost(work);
        var insurance = File.ReadAllBytes(Fixture);
        try {
            StudioDefaults.ResetForTests(Path.Combine(work, "cache-build"));
            var modulePath = Apply(host, work, Fixture, "two-themes", expectValid: false, TwoThemesOps("DefaultsProbeRole"));
            var module = File.ReadAllBytes(modulePath);
            // The insurance app alone, with an empty cache: the reference of every page outside the two flows with a theme of their own.
            StudioDefaults.ResetForTests(Path.Combine(work, "cache-insurance"));
            var alone = Shas(host.HtmlRead(insurance, null, withKeys: true));
            var flowOf = host.FlowsOfPages(module);
            var flows = flowOf.Values.Append("ProbeFlow").Distinct().Order(StringComparer.Ordinal).ToList();
            Dictionary<string, string>? first = null;
            var orders = new HashSet<string>(StringComparer.Ordinal);
            // Each load of the same bytes with an empty cache (a new process), the flows measured first in another order each time
            // (the Model API also gives the flows in another order on each load): the same text, document by document.
            for (var load = 0; load < 4; load++) {
                var cache = Path.Combine(work, "cache-" + load);
                StudioDefaults.ResetForTests(cache);
                orders.Add(string.Join(" ", host.FlowsAsLoaded(module)));
                var asked = flows.Skip(load % flows.Count).Concat(flows.Take(load % flows.Count)).ToList();
                if (load % 2 == 1) asked.Reverse();
                foreach (var flow in asked) Assert.True(host.StudioDefaultsOf(module, flow).Measured, flow);
                var read = Shas(host.HtmlRead(module, null, withKeys: true));
                output.WriteLine("load " + load + ": measured first " + string.Join(", ", asked) + "; " + read.Count + " documents");
                if (first == null) first = read;
                else {
                    Assert.Equal(first.Count, read.Count);
                    foreach (var (key, sha) in first) Assert.True(sha == read[key], "load " + load + ": " + key + " reads another text");
                }
                // The insurance app read after it in the same cache reads as alone (the first measured never decides for another
                // context).
                if (load == 0) {
                    var after = Shas(host.HtmlRead(insurance, null, withKeys: true));
                    foreach (var (key, sha) in alone) Assert.True(sha == after[key], "insurance after the two themes: " + key + " reads another text");
                }
            }
            foreach (var order in orders) output.WriteLine("flows as loaded: " + order);
            // Every page outside the two flows with a theme of their own reads as in the insurance app alone.
            var outside = first!.Where(d => alone.ContainsKey(d.Key) && flowOf[d.Key] is not ("Layouts" or "ProbeFlow")).ToList();
            Assert.NotEmpty(outside);
            foreach (var (key, sha) in outside) Assert.True(sha == alone[key], key + " (" + flowOf[key] + ") reads another text than in the insurance app alone");
            // The contexts: the theme of a flow decides, and a flow without a grid is born otherwise than one with it.
            var main = host.StudioDefaultsOf(module, "MainFlow");
            var gridless = host.StudioDefaultsOf(module, "Layouts");
            var probe = host.StudioDefaultsOf(module, "ProbeFlow");
            output.WriteLine("contexts: MainFlow " + main.Context + ", Layouts " + gridless.Context + ", ProbeFlow " + probe.Context + ", new flow " + host.StudioDefaultsOf(module).Context);
            Assert.Equal(main.Context, host.StudioDefaultsOf(module).Context);
            Assert.NotEqual(main.Context, gridless.Context);
            Assert.NotEqual(main.Context, probe.Context);
            Assert.NotEqual(main.DefaultOf("MobileScreen", "GridType", 'v'), probe.DefaultOf("MobileScreen", "GridType", 'v'));
            // The pages of the flow without a grid read without what the Studio gives them there: the screen the Studio created
            // and the one written in html (which reads back as written).
            var raw = Html(host, module, "RawProbe");
            var written = Html(host, module, "HtmlProbe");
            foreach (var text in new[] { raw, written }) {
                Assert.DoesNotContain("os-GridType", text);
                Assert.DoesNotContain("os-MarginLeft", text);
                Assert.DoesNotContain("os-Gap", text);
            }
            const string probeBody = "<div class=\"probe\">\n <span class=\"tag\">Ok</span>\n <button>Go</button>\n</div>\n";
            Assert.Contains(probeBody, DeclaredLook.WithoutDeclared(written, answers[modulePath], "HtmlProbe", probeBody));
        }
        finally { StudioDefaults.ResetForTests(); }
    }

    [Fact]
    public void EveryFlowIsBornAsTheFreshFlowItsContextIsMeasuredIn()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var work = Work();
        var host = new ModelHost(work);
        try {
            StudioDefaults.ResetForTests(Path.Combine(work, "cache-build"));
            var module = File.ReadAllBytes(Apply(host, work, Fixture, "two-themes", expectValid: false, TwoThemesOps("DefaultsProbeRole")));
            // What a fresh element is born with in each flow of the module itself (its pages there) is what it is born with in a
            // fresh flow of that flow's context: the context (the module and the theme of the flow) is all a flow gives.
            foreach (var flow in host.FlowsOfPages(module).Values.Distinct().Order(StringComparer.Ordinal)) {
                var own = host.MeasureBornInFlow(module, flow);
                var context = host.MeasureBorn(module, flow);
                var ownKinds = Kinds(ScreenDefaults.FromBorn("test", own.Born, own.Roles));
                output.WriteLine(flow + ": " + own.Born.Count + " kinds in itself, " + context.Born.Count + " in a fresh flow of its context");
                Assert.True(ownKinds == Kinds(ScreenDefaults.FromBorn("test", context.Born, context.Roles)), flow + ": " + Difference(own, context));
            }
        }
        finally { StudioDefaults.ResetForTests(); }
    }

    // The first kind and property two measurements differ in.
    private static string Difference(StudioBornValues.Measured a, StudioBornValues.Measured b)
    {
        foreach (var kind in a.Born.Keys.Union(b.Born.Keys).Order(StringComparer.Ordinal)) {
            var x = a.Born.GetValueOrDefault(kind); var y = b.Born.GetValueOrDefault(kind);
            if (x == null || y == null) return kind + " only in " + (x == null ? "the fresh flow" : "the flow itself");
            foreach (var p in x.Keys.Union(y.Keys).Order(StringComparer.Ordinal))
                if (x.GetValueOrDefault(p) != y.GetValueOrDefault(p)) return kind + "." + p + ": " + x.GetValueOrDefault(p) + " in the flow itself, " + y.GetValueOrDefault(p) + " in the fresh flow";
        }
        return "the same";
    }

    private static Dictionary<string, string> Shas(JsonNode read) =>
        read["documents"]!.AsArray().ToDictionary(d => d!["rootKey"]!.ToString(), d => d!["htmlSha256"]!.ToString() + (d["defaults"] is { } note ? " " + note : ""));

    private string Html(ModelHost host, byte[] oml, string root)
    {
        var document = host.HtmlRead(oml, root, withKeys: false)["documents"]!.AsArray().Single()!;
        Assert.Null(document["defaults"]);
        var text = Regex.Replace(document["html"]!.GetValue<string>(), " k=\"[^\"]*\"", "");
        output.WriteLine(text);
        return text;
    }

    [Fact]
    public void TheMeasurementIsKeptPerStudioIdentity()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no ODC Studio: skipped."); return; }
        var identity = StudioDefaults.Identity();
        Assert.Matches("^[0-9a-f]{32}$", identity);
        Assert.Equal(identity, StudioDefaults.Identity());
        // This process loaded the Studio that is on disk: it keeps what it measures.
        Assert.Equal("", StudioDefaults.StaleReason);
        output.WriteLine("ODC Studio " + StudioAssembliesOdc.IdeVersion + ": defaults " + identity);
    }

    private static JsonObject Op(string type, string name) => new() { ["op"] = "create", ["parent"] = "@espace", ["type"] = type, ["name"] = name };
    private static JsonObject Html(string html) => new() { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } };

    // The answer of the job that wrote each module (what the reading of a screen it wrote may add is what this answer declares).
    private readonly Dictionary<string, JsonNode> answers = new(StringComparer.OrdinalIgnoreCase);

    private string Apply(ModelHost host, string work, string basePath, string label, params JsonObject[] ops) => Apply(host, work, basePath, label, true, ops);

    // expectValid false: a module the Studio's check finds errors in on purpose (written all the same).
    private string Apply(ModelHost host, string work, string basePath, string label, bool expectValid, params JsonObject[] ops)
    {
        var job = Path.Combine(work, label + ".json");
        var json = new JsonObject { ["ops"] = new JsonArray(ops.Select(o => (JsonNode)o.DeepClone()).ToArray()) };
        if (!expectValid) json["expectValid"] = false;
        File.WriteAllText(job, json.ToJsonString());
        var outFile = Path.Combine(work, label + ".oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, job, outFile))!;
        answers[outFile] = result;
        if (expectValid) Assert.True(result["accepted"]!.GetValue<bool>(), label + ": " + result.ToJsonString()[..Math.Min(3000, result.ToJsonString().Length)]);
        else Assert.True(File.Exists(outFile), label + ": " + result.ToJsonString()[..Math.Min(3000, result.ToJsonString().Length)]);
        return outFile;
    }

    // The document read back is what was written (the root's own attributes aside), with no default of the Studio printed, and it
    // is a fixed point.
    private void AssertReadsBackAsWritten(ModelHost host, string oml, string root, string body)
    {
        var read = host.HtmlRead(File.ReadAllBytes(oml), root, withKeys: false);
        var document = read["documents"]!.AsArray().Single()!;
        var text = Regex.Replace(document["html"]!.GetValue<string>(), " k=\"[^\"]*\"", "");
        output.WriteLine(text);
        Assert.Null(document["defaults"]);
        Assert.Contains(body, DeclaredLook.WithoutDeclared(text, answers[oml], root, body));
        Assert.DoesNotContain("os-Gap", text);
        Assert.DoesNotContain("os-GridColumns", text);
        Assert.DoesNotContain("os-GridRows", text);
        Assert.DoesNotContain("os-GridType", text);
        Assert.DoesNotContain("os-Visible", text);
        var check = host.HtmlCheck(File.ReadAllBytes(oml));
        var row = check["documents"]!.AsArray().Single(d => d!["root"]!.ToString() == root)!;
        Assert.Equal(0, row["ops"]!.GetValue<int>());
        Assert.Equal(0, row["problemCount"]!.GetValue<int>());
    }

    private static string Kinds(ScreenDefaults defaults) => defaults.ToJson()["kinds"]!.ToJsonString();

    private static string Work()
    {
        var dir = Path.Combine(Root, ".local", "lane-odc", "studio-defaults", Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static bool StudioAvailable()
    {
        try { StudioAssembliesOdc.Bind(null); return Directory.Exists(StudioAssembliesOdc.Directory); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(StudioDefaultsOdcTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir ?? Directory.GetCurrentDirectory();
    }
}
