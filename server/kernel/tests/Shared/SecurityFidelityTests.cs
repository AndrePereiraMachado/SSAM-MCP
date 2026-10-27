using System.Reflection;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// T12 part 1 (access and security fidelity), linked into both test projects. Every security warning id of the platform
/// is known and classified (SecurityWarnings.Classify): blocking per A03, the anonymous-access family, or reviewed as no
/// security warning. A blocking one answers with the fix and the acceptance (a declaration whose why holds the user's own
/// words), never a dead end. The sweeps are generated: from every Verify id manifest of the repository (catalog/ and
/// catalog/odc/) and, when a Studio is bound, from the native metadata of that Studio (its security category and the title
/// family of every security id).
/// </summary>
public sealed class SecurityFidelityTests
{
    // The words that name a security concern in a Verify id (the manifests carry ids only).
    private static readonly Regex Vocabulary = new("Inject|Redirect|Secur|Anonym|Login|Escap|ClientSide|Everyone|Role|Permission|Cookie|Password|Encrypt|Csrf|Xss|Saniti",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private const string Ss11Anonymous = "You're exposing a Server Action for public access and without authentication. Consider removing the Anonymous Role from this Screen.";

    private static string KernelRoot()
    {
        // From the test assembly (once a Studio is bound, AppContext.BaseDirectory is the Studio's folder).
        var start = Path.GetDirectoryName(typeof(SecurityFidelityTests).Assembly.Location)!;
        for (var dir = start; dir != null; dir = Path.GetDirectoryName(dir))
            if (Directory.Exists(Path.Combine(dir, "catalog", "odc")) && Directory.Exists(Path.Combine(dir, "src", "Anvil.Core"))) return dir;
        throw new InvalidOperationException("kernel root not found above " + start);
    }

    /// <summary>Every id of every Verify manifest of both lanes, by lane.</summary>
    private static Dictionary<string, HashSet<string>> ManifestIds()
    {
        var root = KernelRoot();
        var lanes = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var (lane, dir) in new[] { ("o11", Path.Combine(root, "catalog")), ("odc", Path.Combine(root, "catalog", "odc")) })
        {
            var ids = lanes[lane] = new HashSet<string>(StringComparer.Ordinal);
            foreach (var file in Directory.GetFiles(dir, "verify-messages-*.json"))
                ids.UnionWith(JsonNode.Parse(File.ReadAllText(file))!.AsArray().Select(x => x!["id"]!.GetValue<string>()));
        }
        return lanes;
    }

    private static MessageInfo Warning(string id, string detail = "detail")
        => new(id, "Warning", id + "|k", "M (ESpace) / MainFlow (WebFlow) / Detail (WebScreen) / Go (ScreenAction)", detail);

    [Fact]
    public void EverySecurityNamedIdOfTheVerifyManifestsIsClassifiedAndNoClassifiedIdIsAGhost()
    {
        var lanes = ManifestIds();
        Assert.True(lanes["o11"].Count > 400 && lanes["odc"].Count > 400, "the manifests were not read");
        var all = lanes.Values.SelectMany(x => x).ToHashSet(StringComparer.Ordinal);
        var unclassified = all.Where(id => Vocabulary.IsMatch(id) && SecurityWarnings.Classify(id) == null).Order(StringComparer.Ordinal).ToList();
        Assert.True(unclassified.Count == 0, "security-named Verify ids without a class: " + string.Join(", ", unclassified));
        var ghosts = SecurityWarnings.Classified.Where(id => !all.Contains(id)).ToList();
        Assert.True(ghosts.Count == 0, "classified ids no manifest has: " + string.Join(", ", ghosts));
        // The classes are disjoint and each one answers its own class.
        Assert.Empty(SecurityWarnings.Ids.Intersect(SecurityWarnings.AnonymousIds));
        Assert.Empty(SecurityWarnings.Ids.Intersect(SecurityWarnings.NotSecurityIds));
        Assert.Empty(SecurityWarnings.AnonymousIds.Intersect(SecurityWarnings.NotSecurityIds));
        Assert.Empty(SecurityWarnings.GenericIds.Intersect(SecurityWarnings.Ids.Concat(SecurityWarnings.AnonymousIds).Concat(SecurityWarnings.NotSecurityIds)));
        Assert.All(SecurityWarnings.GenericIds, id => Assert.Equal(SecurityWarnings.Generic, SecurityWarnings.Classify(id)));
        Assert.All(SecurityWarnings.Ids, id => Assert.Equal(SecurityWarnings.Blocking, SecurityWarnings.Classify(id)));
        Assert.All(SecurityWarnings.AnonymousIds, id => Assert.Equal(SecurityWarnings.Anonymous, SecurityWarnings.Classify(id)));
        // The ids of the Traditional-migration audit: OpenRedirect and OpenRedirectNR are in the list.
        Assert.Contains("OpenRedirect", SecurityWarnings.Ids);
        Assert.Contains("OpenRedirectNR", SecurityWarnings.Ids);
    }

    /// <summary>The platform's own security category (VerifyMessage.SecurityWarningMessage, the key of its OneCPCategories)
    /// and the title family of every blocking id, read from the bound Studio: every Warning in them blocks. Without a bound
    /// Studio (no installation in this environment) there is nothing native to read.</summary>
    [Fact]
    public void TheNativeSecurityCategoryAndTheTitleFamilyOfEverySecurityIdBlock()
    {
        IReadOnlyList<VerifyDefinition> live;
        try { live = StudioAdapter.Runtime.VerifyDefinitions; }
        // SSAM_REQUIRE_NATIVE_SWEEP=1 (the release battery): a Studio that does not bind fails instead of skipping.
        catch (Exception) when (Environment.GetEnvironmentVariable("SSAM_REQUIRE_NATIVE_SWEEP") != "1") { return; }
        Assert.True(live.Count > 400, "the bound Studio answered " + live.Count + " Verify definitions");
        var category = AppDomain.CurrentDomain.GetAssemblies().Select(a => { try { return a.GetType("ServiceStudio.Verify.VerifyMessage", false); } catch { return null; } })
            .OfType<Type>().Select(t => t.GetField("SecurityWarningMessage", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)?.GetValue(null) as string)
            .FirstOrDefault(v => !string.IsNullOrEmpty(v));
        Assert.False(string.IsNullOrEmpty(category), "the bound Studio has no native security category");
        var titles = live.Where(d => SecurityWarnings.Blocks(d.Id)).Select(d => d.Title).Append(category!).ToHashSet(StringComparer.Ordinal);
        var family = live.Where(d => d.Severity == "Warning" && titles.Contains(d.Title)).Select(d => d.Id).ToList();
        Assert.Contains(family, id => SecurityWarnings.AnonymousIds.Contains(id) || id == "EntityActionClientSide");
        var missing = family.Where(id => !SecurityWarnings.Blocks(id)).Order(StringComparer.Ordinal).ToList();
        Assert.True(missing.Count == 0, "native security warnings that do not block: " + string.Join(", ", missing));
        // Every blocking id of this lane's manifest is a Warning of the bound Studio (an error blocks as an error anyway).
        var byId = live.ToDictionary(d => d.Id, StringComparer.Ordinal);
        foreach (var id in SecurityWarnings.Ids.Where(byId.ContainsKey)) Assert.Equal("Warning", byId[id].Severity);
    }

    [Theory]
    [InlineData("OpenRedirectNR")]
    [InlineData("OpenRedirect")]
    [InlineData("SQL_InputParameterPropagation")]
    [InlineData("EntityActionClientSide")]
    [InlineData("LdapFilterInjection")]
    [InlineData("SQLInjection")]
    public void ANewSecurityWarningBlocksUntilTheJobDeclaresItWithTheUsersWords(string id)
    {
        var message = Warning(id);
        var refused = MessageExpectations.Evaluate([message], []);
        Assert.False(refused.Accepted);
        Assert.Equal("security:" + id, Assert.Single(refused.Verdicts).Reason);
        var declared = MessageExpectations.Evaluate([message], [new ExpectedMessage(id, "Detail (WebScreen) / Go (ScreenAction)", "the user said: keep it, the target is our own domain")]);
        Assert.True(declared.Accepted);
        Assert.Equal("matched", Assert.Single(declared.Verdicts).Verdict);
    }

    [Fact]
    public void AnOrdinaryWarningStaysNonBlockingAndTheAnonymousFamilyKeepsItsFootprintRule()
    {
        var ordinary = MessageExpectations.Evaluate([Warning("UnusedElement")], []);
        Assert.True(ordinary.Accepted);
        Assert.Equal(MessageExpectations.NonBlockingReason, Assert.Single(ordinary.Verdicts).Reason);
        // C37: outside the job's screens the anonymous family is tolerated; on a screen of the job it blocks.
        var anonymous = new MessageInfo("CustomObjectWarning", "Warning", "a|k", "M (ESpace) / MainFlow (WebFlow) / Public (WebScreen) / Go (ScreenAction)", Ss11Anonymous)
            { ScreenKey = "screen1" };
        Assert.True(MessageExpectations.Evaluate([anonymous], [], [], JobFootprint.Empty).Accepted);
        var onJobScreen = new JobFootprint(new HashSet<string>(), new HashSet<string>(), new HashSet<string> { "screen1" });
        var refused = MessageExpectations.Evaluate([anonymous], [], [], onJobScreen);
        Assert.Equal("anonymous-in-job-screen", Assert.Single(refused.Verdicts).Reason);
    }

    /// <summary>The O11 bucket CustomObjectWarning, by its title (the text starts "Title | ..."; the bridge joins them with
    /// a bare "|"), stands for the security id its title and words name; other bucket texts stay ordinary.</summary>
    [Theory]
    [InlineData("SQL Injection | When adding an expand inline parameter after a Group By or Order By, sanitize it.", "SQL_InputParameterPropagation")]
    [InlineData("SQL Injection|EncodeSql should only be used for string literals.", "SQLInjectionInvalidEncodeSQL")]
    [InlineData("SQL Injection | Avoid enabling the Expand Inline property.", "SQLInjection")]
    [InlineData("Open Redirect | Redirecting to a URL coming from a screen input parameter is unsafe.", "OpenRedirectNR")]
    [InlineData("Open Redirect | Enclose the input parameters with a ReplaceURLDomain() function.", "OpenRedirect")]
    [InlineData("Security Warning | You're exposing a database operation in the client side.", "EntityActionClientSide")]
    [InlineData("HTML Injection | Ensure the expression is protected.", "HTMLInjection")]
    [InlineData("Expression Should Be Escaped | Set it.", "ExpressionShouldBeEscaped")]
    [InlineData("Unused Element | a note", null)]
    [InlineData("SQL Injection without a title bar", null)]
    public void TheGenericBucketIsClassifiedByItsTitle(string detail, string? expected)
    {
        Assert.Equal(expected, SecurityWarnings.SecurityIdOf("CustomObjectWarning", detail));
        Assert.Equal(expected != null, SecurityWarnings.IsSecurity("CustomObjectWarning", detail));
        var message = new MessageInfo("CustomObjectWarning", "Warning", "g|k", "M (ESpace) / Search (ServerAction) / Sql (SQLNode) / Argument", detail);
        var verdict = Assert.Single(MessageExpectations.Evaluate([message], []).Verdicts);
        Assert.Equal(expected == null ? MessageExpectations.NonBlockingReason : "security:" + expected, verdict.Reason);
        // The anonymous sentences keep their own family.
        Assert.Null(SecurityWarnings.SecurityIdOf("CustomObjectWarning", "Security Warning | " + Ss11Anonymous));
    }

    [Fact]
    public void TheFixTextsGiveThePlatformsAdviceForEachIdAndLane()
    {
        string Fix(string id) => SecurityWarnings.Fix(id, null)!;
        Assert.Contains("allowlist", Fix("SQL_InputParameterPropagation"));
        Assert.DoesNotContain("turn Expand Inline off", Fix("SQL_InputParameterPropagation"));
        Assert.DoesNotContain("use EncodeSql", Fix("SQLInjectionInvalidEncodeSQL"));
        Assert.Contains("Escape Content to Yes", Fix("ExpressionShouldBeEscaped"));
        Assert.Contains("ReplaceURLDomain() (HTTPRequestHandler, O11 Traditional Web)", Fix("OpenRedirect"));
        Assert.DoesNotContain("ReplaceURLDomain", Fix("OpenRedirectNR"));
        Assert.Contains("EncodeHtml()", Fix("HTMLInjection"));
        Assert.Contains("EncodeJavaScript()", Fix("JavascriptInjection"));
        // The refusal never suggests an ellipsis as why.
        var unexpected = MessageExpectations.Evaluate([Warning("OpenRedirectNR")], []);
        Assert.All(unexpected.Diagnostics(), d => { Assert.DoesNotContain("\"why\":\"...\"", d); Assert.Contains("the user's own words", d); });
    }

    [Fact]
    public void EveryBlockingSecurityIdAnswersTheFixAndTheAcceptanceNeverTheGenericHint()
    {
        foreach (var id in SecurityWarnings.Ids.Concat(SecurityWarnings.AnonymousIds))
        {
            var fix = SecurityWarnings.Fix(id, null);
            Assert.False(string.IsNullOrEmpty(fix), id + " has no fix");
            Assert.Contains("the user's own words", fix);
            Assert.DoesNotMatch("[ãçéêóõí]", fix!);
        }
        Assert.NotNull(SecurityWarnings.Fix("CustomObjectWarning", Ss11Anonymous));
        // The generic bucket without the anonymous sentences, and an ordinary warning, keep their own advice.
        Assert.Null(SecurityWarnings.Fix("CustomObjectWarning", "Some other custom warning."));
        Assert.Null(SecurityWarnings.Fix("UnusedElement", null));
        // The acceptance is a patch of the job's expectedMessages whose why is the marker of the user's words; it is never
        // certain, so neither the kernel nor the facade applies it by itself.
        var acceptance = SecurityAcceptance.Patch("OpenRedirectNR", "M (ESpace) / MainFlow (WebFlow) / Detail (WebScreen) / Go (ScreenAction)");
        var edit = Assert.IsType<JsonObject>(Assert.Single(acceptance));
        Assert.Equal("add", edit["op"]!.ToString());
        Assert.Equal("/expectedMessages/-", edit["path"]!.ToString());
        Assert.Equal("OpenRedirectNR", edit["value"]!["id"]!.ToString());
        Assert.Equal("Detail (WebScreen) / Go (ScreenAction)", edit["value"]!["element"]!.ToString());
        Assert.Equal(SecurityAcceptance.WordsMarker, edit["value"]!["why"]!.ToString());
        var problem = new JsonObject { ["patch"] = acceptance.DeepClone(), ["patchRule"] = SecurityAcceptance.PatchRule };
        Assert.False(Anvil.Core.Preflight.PatchCertainty.IsCertain(problem));
        Anvil.Core.Preflight.PatchCertainty.Publish(problem);
        Assert.Contains("user", problem["patchChoice"]!.ToString());
        Assert.DoesNotContain("A03", problem["patchChoice"]!.ToString());
        // Agents find the temporary contract and the conditional restore in the kernel's surface.
        var surface = VerbSurface.Schema();
        Assert.Contains("temporary", surface["job"]!.AsArray().Select(k => k!.ToString()));
        Assert.Contains("restore", surface["temporary"]!.ToString());
        Assert.Contains("ifCurrent", VerbSurface.Verbs.Single(v => v.Verb == "set").Optional);
    }

    [Theory]
    [InlineData("OpenRedirectNR", "<the user's own words>")]
    [InlineData("OpenRedirectNR", "<reason>")]
    [InlineData("OpenRedirectNR", "   ")]
    [InlineData("OpenRedirectNR", "...")]
    [InlineData("SQLInjection", "…")]
    // The generic bucket may carry a security warning (by its title): it takes the user's words too.
    [InlineData("CustomObjectWarning", "<the user's own words>")]
    [InlineData("CustomObjectWarning", "...")]
    public void ASecurityDeclarationWithoutTheUsersWordsIsRefused(string id, string why)
    {
        var job = new JsonObject { ["ops"] = new JsonArray(), ["expectedMessages"] = new JsonArray(new JsonObject { ["id"] = id, ["element"] = "Detail (WebScreen) / Go (ScreenAction)", ["why"] = why }) };
        var reading = MessageExpectations.Inspect(job, null);
        var problem = Assert.Single(reading.Problems);
        Assert.Contains(id, problem.Message);
        Assert.Contains("is not the user's own words", problem.Message);
        Assert.Contains("the user's own words", problem.Fix);
        // A declaration of an ordinary warning keeps its old contract (any reason).
        var ordinary = new JsonObject { ["ops"] = new JsonArray(), ["expectedMessages"] = new JsonArray(new JsonObject { ["id"] = "UnusedElement", ["element"] = "X (ScreenAction)", ["why"] = "<reason>" }) };
        Assert.Empty(MessageExpectations.Inspect(ordinary, null).Problems);
    }
}
