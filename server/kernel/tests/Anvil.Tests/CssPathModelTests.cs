using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using OutSystems.Model;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// T18 on the O11 model (Traditional and Reactive fixtures): the keyed css op on every element that has a stylesheet, derived
/// from the fixture (a theme, a screen and a block of each flavor), writes through the one path: the normalization of every
/// write (the @import at the top), F1's stylesheet touch and report (apply.styleSheets, the served proof's read-back), and the
/// basedOn of the result is the sha256 of what the get then reads. A stale basedOn and edits that cannot apply are refused, all
/// at once, naming the element and the next call; a set StyleSheet takes the same normalization and the same basedOn check.
/// </summary>
public sealed class CssPathModelTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(CssPathModelTests).Assembly.Location)!)!;
    private const string Import = "@import url(\"https://fonts.googleapis.com/css2?family=Inter\");";

    public static TheoryData<string> Fixtures => new() { "traditional-ui.oml", "reactive-ui.oml" };

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void TheCssOpEditsOneRuleOfEveryStylesheetElementThroughTheOnePath(string fixtureName)
    {
        if (!StudioAvailable()) return;
        var (host, work, fixture) = Setup("css-op-" + Path.GetFileNameWithoutExtension(fixtureName), fixtureName);
        var elements = Elements(host, fixture);
        Assert.Contains(elements, e => e.Kind == "theme");
        Assert.Contains(elements, e => e.Kind == "block");
        foreach (var (target, kind, author) in elements)
        {
            var name = target.Replace(':', '-');
            var probe = $".t18-{kind}-probe{{color:#123456}}";
            var result = RunJob(host, fixture, new JsonArray(
                new JsonObject { ["op"] = "css", ["target"] = target, ["basedOn"] = ThemeCss.Sha256(author),
                    ["edits"] = new JsonArray(new JsonObject { ["append"] = probe + "\n" + Import }) },
                new JsonObject { ["op"] = "get", ["target"] = target }), Path.Combine(work, name + ".oml"));
            Assert.True(result["accepted"]!.GetValue<bool>(), target + ": " + Clip(result));
            var css = Results(result).OfType<JsonObject>().First(r => r["css"] != null);
            var properties = Results(result).OfType<JsonObject>().Last(r => r["properties"] != null)["properties"]!.AsObject();
            var written = (properties["UserStyleSheet"] ?? properties["StyleSheet"])!.ToString();
            Assert.Contains(probe, written);
            // The one normalization: the @import the edit appended is at the top of the stylesheet.
            Assert.StartsWith(Import, (properties["StyleSheet"]!.ToString()).TrimStart());
            Assert.True(ThemeCss.Matches(css["basedOn"]!.ToString(), written), target);
            Assert.Equal(ThemeCss.Sha256(author), css["was"]!.ToString());
            // F1: the element is in the stylesheet report the served proof compares against (the read-back stylesheet).
            var entry = Assert.Single(result["styleSheets"]!.AsArray(), e => e!["name"]!.ToString() == target[(target.IndexOf(':') + 1)..])!;
            Assert.Equal(kind, entry["kind"]!.ToString());
            Assert.Contains(probe, entry["styleSheet"]!.ToString());
            // F1: a touch, or the reason there is none (a theme has no widget).
            Assert.True(entry["touch"] != null || entry["reason"]?.ToString() is { Length: > 0 }, target + ": " + entry.ToJsonString());
            if (kind == "block") Assert.NotNull(entry["touch"]);
        }
    }

    [Fact]
    public void AStaleBasedOnAndEditsThatCannotApplyAreRefusedAtOnce()
    {
        if (!StudioAvailable()) return;
        var (host, work, fixture) = Setup("css-op-refusals", "traditional-ui.oml");
        var (target, _, author) = Elements(host, fixture).First(e => e.Kind == "block");
        var (code, problems) = Refusal(() => RunJob(host, fixture, new JsonArray(new JsonObject { ["op"] = "css", ["target"] = target, ["basedOn"] = ThemeCss.Sha256(author + "x"),
            ["edits"] = new JsonArray(new JsonObject { ["append"] = ".a{b:c}" }) }), Path.Combine(work, "stale.oml")));
        Assert.Equal(ModelSession.ThemeChanged, code);
        var stale = Assert.Single(problems)!;
        Assert.Equal(ThemeCss.Sha256(author), stale["actual"]!.ToString());   // the current hash, for the next call
        Assert.Equal("/ops/0/basedOn", stale["patch"]![0]!["path"]!.ToString());
        Assert.Contains(target[(target.IndexOf(':') + 1)..], stale["message"]!.ToString());
        (code, problems) = Refusal(() => RunJob(host, fixture, new JsonArray(new JsonObject { ["op"] = "css", ["target"] = target,
            ["edits"] = new JsonArray(new JsonObject { ["append"] = ".a{b:c}" }) }), Path.Combine(work, "missing.oml")));
        Assert.Equal(CssEdits.BasedOnMissing, code);
        Assert.Equal("add", problems[0]!["patch"]![0]!["op"]!.ToString());
        // Every problem of the edits in one refusal: a rule and a text that are not there, and a generated id the edit brings.
        (code, problems) = Refusal(() => RunJob(host, fixture, new JsonArray(new JsonObject { ["op"] = "css", ["target"] = target, ["basedOn"] = ThemeCss.Sha256(author),
            ["edits"] = new JsonArray(new JsonObject { ["replaceRule"] = ".t18-no-such-rule", ["body"] = "color:red" }, new JsonObject { ["find"] = "t18-no-such-text", ["with"] = "" },
                new JsonObject { ["append"] = ".bar{background:url(\"/M/img/z.png\")}" }, new JsonObject { ["find"] = "url(\"/M/", ["with"] = "url(\"https://acme-dev.outsystemscloud.com/M/" }) }), Path.Combine(work, "wrong.oml")));
        Assert.Equal(CssEdits.Refused, code);
        Assert.Equal([CssEdits.NotFound, CssEdits.FindNotFound, CssPipeline.EnvUrl], problems.Select(p => p!["code"]!.ToString()));
        Assert.All(problems, p => Assert.False(string.IsNullOrWhiteSpace(p!["fix"]?.ToString())));
        // An environment url in CSS the op certainly adds is refused before any build, with the other problems of the job.
        var error = Assert.ThrowsAny<Exception>(() => RunJob(host, fixture, new JsonArray(new JsonObject { ["op"] = "css", ["target"] = target, ["basedOn"] = ThemeCss.Sha256(author),
            ["edits"] = new JsonArray(new JsonObject { ["append"] = ".bar{background:url(\"https://acme-dev.outsystemscloud.com/M/img/a.png\")}" }) }), Path.Combine(work, "generated.oml")));
        Assert.Equal("PREFLIGHT_REFUSED", Errors.FindCoded(error)?.Code);
        Assert.Contains(CssPipeline.EnvUrl, error.ToString());
    }

    [Fact]
    public void ASetStyleSheetTakesTheSameNormalizationAndTheSameBasedOnCheck()
    {
        if (!StudioAvailable()) return;
        var (host, work, fixture) = Setup("css-set-path", "traditional-ui.oml");
        var (target, _, author) = Elements(host, fixture).First(e => e.Kind == "theme");
        var set = RunJob(host, fixture, new JsonArray(
            new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = "StyleSheet", ["value"] = ".t18-set{color:#123456}\n" + Import },
            new JsonObject { ["op"] = "get", ["target"] = target }), Path.Combine(work, "set.oml"));
        Assert.True(set["accepted"]!.GetValue<bool>(), Clip(set));
        var properties = Results(set).OfType<JsonObject>().Last(r => r["properties"] != null)["properties"]!.AsObject();
        Assert.StartsWith(Import, properties["StyleSheet"]!.ToString().TrimStart());   // before T18: only a theme with Theme Editor CSS
        var landing = Results(set).OfType<JsonObject>().First(r => r["set"] != null)["styleSheet"]!;
        Assert.True(ThemeCss.Matches(landing["basedOn"]!.ToString(), (properties["UserStyleSheet"] ?? properties["StyleSheet"])!.ToString()));
        Assert.NotNull(landing["cssImportsHoisted"]);
        var (code, problems) = Refusal(() => RunJob(host, fixture, new JsonArray(new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = "StyleSheet", ["value"] = ".x{y:z}", ["basedOn"] = ThemeCss.Sha256(author + "x") }),
            Path.Combine(work, "set-stale.oml")));
        Assert.Equal(ModelSession.ThemeChanged, code);
        Assert.Equal(ThemeCss.Sha256(author), problems[0]!["actual"]!.ToString());
        var right = RunJob(host, fixture, new JsonArray(new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = "StyleSheet", ["value"] = ".x{y:z}", ["basedOn"] = ThemeCss.Sha256(author) }),
            Path.Combine(work, "set-right.oml"));
        Assert.True(right["accepted"]!.GetValue<bool>(), Clip(right));
    }

    // Every element of the fixture with a stylesheet of its own, one of each kind (theme, screen, block), with its author CSS:
    // derived from the native model, never named by hand.
    internal static List<(string Target, string Kind, string Author)> Elements(ModelHost host, string fixture)
    {
        var found = new List<(string, string, string)>();
        var module = typeof(ModelHost).GetMethod("Load", [typeof(string)])!.Invoke(host, [fixture])!;
        try
        {
            static string? Interface(object o) => o.GetType().GetInterfaces().Select(i => i.Name).FirstOrDefault(n => n is "IWebTheme" or "IMobileTheme" or "IWebBlock" or "IMobileBlock" or "IWebScreen" or "IMobileScreen");
            foreach (var o in ((IObjectSignature)module).GetAllDescendantsOfType<IObjectSignature>())
            {
                // Reactive first: an O11 mobile screen implements the web screen interface too.
                var names = o.GetType().GetInterfaces().Select(i => i.Name).ToHashSet();
                var type = names.Contains("IMobileTheme") ? "IMobileTheme" : names.Contains("IMobileBlock") ? "IMobileBlock" : names.Contains("IMobileScreen") ? "IMobileScreen" : Interface(o);
                if (type == null || ThemeCss.AuthorOf(o) is not { } author) continue;
                var kind = type.EndsWith("Theme") ? "theme" : type.EndsWith("Block") ? "block" : "screen";
                if (found.Any(f => f.Item2 == kind) || TypeResolver.Name(o) is not { Length: > 0 } name) continue;
                found.Add((type + ":" + name, kind, author));
            }
        }
        finally { typeof(ModelHost).GetMethod("Release")!.Invoke(null, [module]); }
        return found;
    }

    private static (ModelHost Host, string Work, string Fixture) Setup(string name, string fixture)
    {
        StudioAssemblies.Bind(null);
        var work = Path.Combine(Root, ".local/lane-ss5/proofs/t18-css-path", name);
        Directory.CreateDirectory(work);
        return (new ModelHost(work), work, Path.Combine(Root, "tests/fixtures", fixture));
    }

    private static JsonObject RunJob(ModelHost host, string basis, JsonArray ops, string output)
    {
        var job = output + ".job.json";
        File.WriteAllText(job, new JsonObject { ["ops"] = ops }.ToJsonString());
        return JsonSerializer.SerializeToNode(JobRunner.Run(host, basis, job, output))!.AsObject();
    }

    // The refusal of a job (the apply throws it): its code and its problems.
    private static (string? Code, JsonArray Problems) Refusal(Func<JsonObject> run)
    {
        var error = Assert.ThrowsAny<Exception>(() => run());
        var coded = Errors.FindCoded(error);
        return (coded?.Code, (coded as KernelRefusalException)?.Problems ?? new JsonArray());
    }

    private static IEnumerable<JsonNode?> Results(JsonObject result) => (result["results"] as JsonArray ?? new JsonArray()).Select(r => r is JsonObject o && o["result"] is { } inner ? inner : r);
    private static string Clip(JsonObject result) { var s = result.ToJsonString(); return s[..Math.Min(4000, s.Length)]; }
    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
