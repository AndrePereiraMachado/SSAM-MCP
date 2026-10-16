using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>CX16 W2 on the O11 lane: the html op with data.edits (element edits of a reading) inside a job, the path of today
/// with the document they make: the Login of reactive-ui.oml changed by edits is the edit form's result (the same ops, the same
/// text read back); an older reading kept in the store is merged three ways; a reading not kept with the screen changed is
/// HTML_BASE_CHANGED with the current text of each element addressed (current.elements, when the key table is kept); check-job
/// says an unknown address in ms without the model; and the battery of synthetic edits (ScreenHtmlEditBattery, the parameters
/// of today) gives in the edits form the document and the ops of the edit form. Needs the Service Studio, except check-job.
/// CX16 r2 (M4): each test that keeps a reading owns its store (OwnStore), never the store of the process.</summary>
public class HtmlElementEditJobTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(HtmlElementEditJobTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "html-element-edits");
    private static string Fixture(string name) => Path.Combine(Root, "tests", "fixtures", name);

    [Fact]
    public void TheEditsOfTheLoginWriteWhatTheEditFormWrites()
    {
        if (!StudioAvailable()) return;
        var host = Host("login");
        var basePath = Fixture("reactive-ui.oml");
        var (reading, html, sha) = Read(host, basePath, "Login");
        // The edit form: the elements whole (the logo with a class, the form with a new paragraph, the link with another action).
        var tree = ScreenHtml.Parse(html);
        Attribute(Element(tree, "w8"), "class", "login-logo compact");
        var form = Element(tree, "w7");
        form.Children.Insert(form.Children.IndexOf(Element(tree, "w13")), ScreenHtml.Parse("<p class=\"login-hint\">{{ \"Use your company account\" }}</p>").Children[0]);
        Attribute(Element(tree, "w28"), "onclick", "OnInitialize");
        var whole = Run(host, basePath, Job(sha, reading, "Login", edit: [ScreenHtmlText.Write(form)]), "edit-form");
        // The same change by element: three small edits, nothing resent.
        var edits = new JsonArray(
            JsonNode.Parse("""{"set":"w8","attributes":{"class":"login-logo compact"}}"""),
            JsonNode.Parse("""{"before":"w13","insert":"<p class=\"login-hint\">{{ \"Use your company account\" }}</p>"}"""),
            JsonNode.Parse("""{"set":"w28","attributes":{"onclick":"OnInitialize"}}"""));
        var small = Run(host, basePath, Job(sha, reading, "Login", edits: edits), "edits-form");
        Assert.True(whole["accepted"]!.GetValue<bool>(), whole.ToJsonString());
        Assert.True(small["accepted"]!.GetValue<bool>(), small.ToJsonString());
        var a = Answer(whole); var b = Answer(small);
        Assert.Equal(a["ops"]!.ToJsonString(), b["ops"]!.ToJsonString());
        Assert.Equal(a["next"]!["html"]!.ToString(), b["next"]!["html"]!.ToString());
        var note = b["normalizations"]![0]!;
        Assert.Equal("html-element-edits", note["rule"]!.ToString());
        Assert.Equal(3, note["edits"]!.GetValue<int>());
        Assert.Equal(["w8", "w13", "w28"], note["touched"]!.AsArray().Select(k => k!.ToString()));
        var (_, afterWhole, _) = Read(host, Path.Combine(Work, "login", "edit-form.oml"), "Login");
        var (_, afterSmall, _) = Read(host, Path.Combine(Work, "login", "edits-form.oml"), "Login");
        Assert.Equal(afterWhole, afterSmall);
        output.WriteLine($"edit form {Job(sha, reading, "Login", edit: [ScreenHtmlText.Write(form)]).ToJsonString().Length} B, edits {Job(sha, reading, "Login", edits: edits).ToJsonString().Length} B");

        // A problem of the plan on an element an edit touched names that edit.
        var script = Run(host, basePath, Job(sha, reading, "Login", edits: new JsonArray(
            JsonNode.Parse("""{"set":"w8","attributes":{"class":"x"}}"""),
            JsonNode.Parse("""{"set":"w28","attributes":{"onclick":"javascript:alert(1)"}}"""))), "edits-script");
        Assert.False(script["accepted"]?.GetValue<bool>() ?? false);
        var problem = Problems(script).Select(p => p!.AsObject()).First(p => p["code"]!.ToString() == ScreenHtmlEdit.Script);
        Assert.Equal("/ops/0/data/edits/1", problem["pointer"]!.ToString());
        Assert.Equal(1, problem["edit"]!.GetValue<int>());
    }

    [Fact]
    public void AnOlderReadingKeptInTheStoreIsMergedThreeWays()
    {
        if (!StudioAvailable()) return;
        var host = Host("rebase");
        using var own = new OwnStore();
        var store = own.Store;
        var basePath = Fixture("reactive-ui.oml");
        var (read, html, sha) = Read(host, basePath, "Login", keys: true);
        Keep(store, sha, read, html, withText: true);
        // The screen changes in the Studio: a banner at its top (every k after it renumbers) and the text of the link.
        var tree = ScreenHtml.Parse(html);
        var screenSlot = Element(tree, "w5").Children.First(c => c.Tag == "slot");
        screenSlot.Children.Insert(screenSlot.Children.IndexOf(Element(tree, "w6")), ScreenHtml.Parse("<div class=\"banner\">{{ \"Maintenance tonight\" }}</div>").Children[0]);
        var link = Element(tree, "w28");
        link.Children.Clear(); link.Children.Add(new ScreenHtml.Node { Text = "Recover password" });
        var changed = Run(host, basePath, Job(sha, read, "Login", edit: [ScreenHtmlText.Write(Element(tree, "w5"))]), "changed");
        Assert.True(changed["accepted"]!.GetValue<bool>(), changed.ToJsonString());
        // The edits of the first reading: a class on the link. The class is the edit's, the text the Studio's, the banner stays.
        var rebased = Run(host, Path.Combine(Work, "rebase", "changed.oml"), Job(sha, read, "Login", edits: new JsonArray(JsonNode.Parse("""{"set":"w28","attributes":{"class":"forgot"}}"""))), "rebased");
        Assert.True(rebased["accepted"]!.GetValue<bool>(), rebased.ToJsonString());
        Assert.Equal("three-way", Answer(rebased)["rebased"]![0]!["merge"]!.ToString());
        var (_, after, _) = Read(host, Path.Combine(Work, "rebase", "rebased.oml"), "Login");
        Assert.Contains("Maintenance tonight", after);
        Assert.Contains("class=\"forgot\" onclick=\"ForgotPassword\"", after);
        Assert.Contains(">Recover password</a>", after);
    }

    // servidor/fase4-26 (M2): on a hosted server (ANVIL_KEPT_READINGS=own) the store is every customer's: the reading kept for
    // another capture than the one the job runs on is not its base. The same rebase as above is refused with the current text.
    [Fact]
    public void HostedAnOlderReadingOfAnotherCaptureIsNotTheBaseOfTheEdits()
    {
        if (!StudioAvailable()) return;
        var host = Host("rebase-hosted");
        using var own = new OwnStore();
        var basePath = Fixture("reactive-ui.oml");
        var (read, html, sha) = Read(host, basePath, "Login", keys: true);
        Keep(own.Store, sha, read, html, withText: true);
        var tree = ScreenHtml.Parse(html);
        var link = Element(tree, "w28");
        link.Children.Clear(); link.Children.Add(new ScreenHtml.Node { Text = "Recover password" });
        var changed = Run(host, basePath, Job(sha, read, "Login", edit: [ScreenHtmlText.Write(link)]), "changed");
        Assert.True(changed["accepted"]!.GetValue<bool>(), changed.ToJsonString());
        using var hosted = ModuleIndexStore.OwnReadings();
        var refused = Run(host, Path.Combine(Work, "rebase-hosted", "changed.oml"), Job(sha, read, "Login", edits: new JsonArray(JsonNode.Parse("""{"set":"w28","attributes":{"class":"forgot"}}"""))), "rebased");
        Assert.False(refused["accepted"]?.GetValue<bool>() ?? false, refused.ToJsonString());
        var problem = Problems(refused).Select(p => p!.AsObject()).Single();
        Assert.Equal(ScreenHtmlEdit.BaseChanged, problem["code"]!.ToString());
        Assert.Contains(">Recover password</a>", problem["current"]!["text"]!.ToString());
    }

    [Fact]
    public void WithoutItsReadingAChangedScreenIsRefusedWithTheCurrentElements()
    {
        if (!StudioAvailable()) return;
        var host = Host("base-changed");
        using var own = new OwnStore();
        var store = own.Store;
        var basePath = Fixture("reactive-ui.oml");
        var (read, html, sha) = Read(host, basePath, "Login", keys: true);
        // An older reading of the screen (another htmlSha256): nothing kept of it (the store is this test's own, empty).
        var older = new string('a', 64);
        var stale = (JsonObject)read.DeepClone(); stale["documents"]![0]!["htmlSha256"] = older;
        var edits = new JsonArray(JsonNode.Parse("""{"set":"w28","attributes":{"class":"forgot"}}"""), JsonNode.Parse("""{"find":"x","with":"y"}"""));
        var bare = Run(host, basePath, Job(sha, stale, "Login", edits: edits), "bare");
        var problem = Problems(bare).Select(p => p!.AsObject()).Single();
        Assert.Equal(ScreenHtmlEdit.BaseChanged, problem["code"]!.ToString());
        Assert.Equal(html, problem["current"]!["text"]!.ToString());
        Assert.Null(problem["current"]!["elements"]);
        // An older store kept its key table only: the current text of each element the edits address, found by ObjectKey.
        Keep(store, sha, stale, null, withText: false, keys: read["documents"]![0]!["keys"]!.AsObject());
        var keyed = Run(host, basePath, Job(sha, stale, "Login", edits: edits), "keyed");
        var elements = Problems(keyed).Single()!["current"]!["elements"]!.AsArray();
        var element = Assert.Single(elements)!;
        Assert.Equal("w28", element["address"]!.ToString());
        Assert.Equal("w28", element["k"]!.ToString());
        Assert.StartsWith("<a k=\"w28\"", element["text"]!.ToString().TrimStart());
    }

    [Fact]
    public void CheckJobSaysAnUnknownAddressInMillisecondsWithoutTheModel()
    {
        using var own = new OwnStore();
        var store = own.Store;
        var capture = new string('c', 64); var htmlSha = new string('d', 64);
        const string reading = "<screen name=\"Login\">\n<div k=\"w1\" class=\"card\">\n <a k=\"w2\" onclick=\"Save\">Save</a>\n</div>\n</screen>\n";
        Directory.CreateDirectory(Path.GetDirectoryName(store.HtmlKeysPathOf(capture, htmlSha))!);
        File.WriteAllText(store.HtmlKeysPathOf(capture, htmlSha), new JsonObject {
            ["schema"] = ScreenHtml.Schema, ["extractor"] = ScreenHtml.Extractor, ["lane"] = store.Lane, ["sourceSha256"] = capture, ["root"] = "Login",
            ["rootKey"] = "root", ["rootKind"] = "MobileScreen", ["htmlSha256"] = htmlSha,
            ["keys"] = new JsonObject { [""] = "root", ["w1"] = "k1", ["w2"] = "k2" }, ["html"] = reading }.ToJsonString());
        var dir = Path.Combine(Work, "check"); Directory.CreateDirectory(dir);
        JsonObject Check(JsonArray edits, string? onCapture = null)
        {
            var job = new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "Login",
                ["basedOn"] = new JsonObject { ["capture"] = onCapture ?? capture, ["html"] = htmlSha }, ["edits"] = edits } }) };
            var file = Path.Combine(dir, Guid.NewGuid().ToString("N") + ".json"); File.WriteAllText(file, job.ToJsonString());
            return JobPreflight.Check(file);
        }
        var clock = Stopwatch.StartNew();
        var result = Check(new JsonArray(JsonNode.Parse("""{"set":"w9","attributes":{"class":"x"}}"""), JsonNode.Parse("""{"find":"nothing","with":""}"""),
            JsonNode.Parse("""{"into":"w1","insert":"<button onclick=\"javascript:go()\">Go</button>"}""")));
        var ms = clock.ElapsedMilliseconds;
        Assert.False(result["valid"]!.GetValue<bool>());
        Assert.False(result["verifyRan"]!.GetValue<bool>());
        var problems = result["problems"]!.AsArray().Select(p => (p!["pointer"]!.ToString(), p["code"]!.ToString())).ToList();
        Assert.Contains(("/ops/0/data/edits/0", HtmlElementEdits.TargetUnknown), problems);
        Assert.Contains(("/ops/0/data/edits/1", HtmlElementEdits.TextNotUnique), problems);
        Assert.True(ms < 2000, ms + " ms");
        // The addresses are good: the document they make is judged as a whole document (a new element's script).
        var script = Check(new JsonArray(JsonNode.Parse("""{"into":"w1","insert":"<button onclick=\"javascript:go()\">Go</button>"}""")));
        Assert.Contains(script["problems"]!.AsArray(), p => p!["code"]!.ToString() == ScreenHtmlEdit.Script && p["pointer"]!.ToString() == "/ops/0/data/edits");
        // Without the reading kept, only the shape: an edit with two addresses; a good shape passes the preflight.
        var shape = Check(new JsonArray(JsonNode.Parse("""{"set":"w1","replace":"w2"}""")), new string('e', 64));
        Assert.Equal([("/ops/0/data/edits/0", ScreenHtmlEdit.Invalid)], shape["problems"]!.AsArray().Select(p => (p!["pointer"]!.ToString(), p["code"]!.ToString())));
        Assert.True(Check(new JsonArray(JsonNode.Parse("""{"set":"w1","attributes":{"class":"x"}}""")), new string('e', 64))["valid"]!.GetValue<bool>());
        // edits beside edit: refused with the shape.
        var file = Path.Combine(dir, "both.json");
        File.WriteAllText(file, new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["screen"] = "Login",
            ["basedOn"] = new JsonObject { ["capture"] = capture, ["html"] = htmlSha }, ["edit"] = new JsonArray("<div k=\"w1\"/>"), ["edits"] = new JsonArray(JsonNode.Parse("""{"delete":"w2"}""")) } }) }.ToJsonString());
        Assert.Contains(JobPreflight.Check(file)["problems"]!.AsArray(), p => p!["pointer"]!.ToString() == "/ops/0/data/edits" && p["code"]!.ToString() == ScreenHtmlEdit.Invalid);
    }

    // CX16 r2 M4: the tests of the store own theirs (OwnStore: a temporary root, ModuleIndexStore.Use in their flow of
    // execution, deleted at the end). Run here one after the other, they leave the store of the process (the one
    // SSAM_MODULE_INDEX_ROOT names) as it was: no file of theirs is created or written there.
    [Fact]
    public void TheTestsOfTheStoreNeverWriteTheStoreOfTheProcess()
    {
        var shared = ModuleIndexStore.Default();
        if (shared == null) { output.WriteLine("WARNING: no store for the process (SSAM_MODULE_INDEX_ROOT or a workspace): nothing to compare."); return; }
        var started = DateTime.UtcNow.AddSeconds(-2);
        var before = Files(shared.Root);
        CheckJobSaysAnUnknownAddressInMillisecondsWithoutTheModel();
        WithoutItsReadingAChangedScreenIsRefusedWithTheCurrentElements();
        AnOlderReadingKeptInTheStoreIsMergedThreeWays();
        TheStaticCheckAcceptsWhatTheApplyAcceptsOnTheLogin();
        AFindKeepsTheIdentityOfTheElementsItChanges();
        var after = Files(shared.Root);
        Assert.Equal(before.Keys.Order(StringComparer.OrdinalIgnoreCase), after.Keys.Order(StringComparer.OrdinalIgnoreCase));
        Assert.Empty(after.Where(f => f.Value >= started).Select(f => f.Key));
        Assert.Equal(shared.Root, ModuleIndexStore.Default()!.Root);
    }

    // CX16 r2 A1 + A2 end to end on the Login of reactive-ui.oml, with the module index the model read stores (its imported
    // blocks are reference rows, MobileBlockSignature), no digest and no UI catalog: a benign element edit and the whole
    // document with screen and basedOn are valid in check-job (no HTML_NAME_UNKNOWN, no HTML_ROOT_EXISTS), as the apply
    // accepts them; the same document without screen and basedOn is a new screen whose name the module has.
    [Fact]
    public void TheStaticCheckAcceptsWhatTheApplyAcceptsOnTheLogin()
    {
        if (!StudioAvailable()) return;
        using var own = new OwnStore();
        var host = Host("static-login");
        var basePath = Fixture("reactive-ui.oml");
        var (read, html, sha) = Read(host, basePath, "Login", keys: true);
        Keep(own.Store, sha, read, html, withText: true);
        host.ReadModel(basePath, "/", new ReadingOptions(Max: 1), own.Store);
        var index = own.Store.PathOf(sha);
        Assert.True(File.Exists(index), index);
        Assert.False(File.Exists(Path.Combine(Path.GetDirectoryName(index)!, sha + ".kernel.digest.json")));
        JsonObject Check(JsonObject job, string name)
        {
            var file = Path.Combine(host.WorkDirectory, name + ".json"); File.WriteAllText(file, job.ToJsonString());
            return JsonSerializer.SerializeToNode(Anvil.Core.Preflight.CheckJobCommand.Run(["--job", file, "--module-index", index, "--basis-fresh", "true"]))!.AsObject();
        }
        var benign = Check(Job(sha, read, "Login", edits: new JsonArray(JsonNode.Parse("""{"set":"w9","attributes":{"class":"logo-box"}}"""))), "benign");
        Assert.True(benign["valid"]!.GetValue<bool>(), benign.ToJsonString());
        Assert.DoesNotContain(benign["problems"]!.AsArray(), p => p!["code"]!.ToString() == ScreenHtmlEdit.NameUnknown);
        const string logoBox = "<div k=\"w9\" style=\"text-align: center;\">";
        Assert.Contains(logoBox, html);
        var document = html.Replace(logoBox, "<div k=\"w9\" style=\"text-align: center;\" class=\"logo-box\">");
        var whole = Job(sha, read, "Login"); whole["ops"]![0]!["data"]!["html"] = document;
        var wholeCheck = Check(whole, "whole");
        Assert.True(wholeCheck["valid"]!.GetValue<bool>(), wholeCheck.ToJsonString());
        Assert.DoesNotContain(wholeCheck["problems"]!.AsArray(), p => p!["code"]!.ToString() == ScreenDocument.RootExists);
        var applied = Run(host, basePath, whole, "whole-apply");
        Assert.True(applied["accepted"]!.GetValue<bool>(), applied.ToJsonString());
        var created = new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = document } }) };
        Assert.Contains(Check(created, "new")["problems"]!.AsArray(), p => p!["code"]!.ToString() == ScreenDocument.RootExists);
    }

    // CX16 r2 M2 on the Login: a find that keeps k="w28" is one set of its Style; one whose with drops it is refused
    // (HTML_EDIT_INVALID, the edit named); two elements swapped inside one find, each with its k, keep both (they are placed
    // again: no create and no delete).
    [Fact]
    public void AFindKeepsTheIdentityOfTheElementsItChanges()
    {
        if (!StudioAvailable()) return;
        using var own = new OwnStore();
        var host = Host("find-k");
        var basePath = Fixture("reactive-ui.oml");
        var (read, html, sha) = Read(host, basePath, "Login", keys: true);
        Keep(own.Store, sha, read, html, withText: true);
        JsonObject Edit(string find, string with, string name) =>
            Run(host, basePath, Job(sha, read, "Login", edits: new JsonArray(new JsonObject { ["find"] = find, ["with"] = with })), name);
        var kept = Edit("<a k=\"w28\" onclick=\"ForgotPassword\"", "<a k=\"w28\" onclick=\"ForgotPassword\" class=\"forgot\"", "kept");
        Assert.True(kept["accepted"]!.GetValue<bool>(), kept.ToJsonString());
        var op = Assert.Single(Answer(kept)["ops"]!.AsArray())!;
        Assert.Equal("set", op["op"]!.ToString());
        Assert.Equal("w28", op["k"]!.ToString());
        var dropped = Edit("<a k=\"w28\" onclick=\"ForgotPassword\"", "<a onclick=\"ForgotPassword\" class=\"forgot\"", "dropped");
        Assert.False(dropped["accepted"]?.GetValue<bool>() ?? false);
        Assert.Contains(Problems(dropped), p => p!["code"]!.ToString() == ScreenHtmlEdit.Invalid && p["pointer"]!.ToString() == "/ops/0/data/edits/0");
        var lines = html.Split('\n');
        var input = lines.Single(l => l.Contains("k=\"w25\"")); var label = lines.Single(l => l.Contains("k=\"w26\""));
        Assert.Equal(Array.IndexOf(lines, input) + 1, Array.IndexOf(lines, label));
        var swapped = Edit(input.TrimStart() + "\n" + label, label.TrimStart() + "\n" + input, "swapped");
        Assert.True(swapped["accepted"]!.GetValue<bool>(), swapped.ToJsonString());
        // CX16 r3 M5: each with its own text, the pair is placed again and nothing else: no create, delete, set or move, and
        // no ObjectKey changes.
        var kinds = Answer(swapped)["ops"]!.AsArray().Select(o => o!["op"]!.ToString()).ToList();
        Assert.Equal(["place"], kinds);
        Assert.Null(Answer(swapped)["keyChanged"]);
        // CX16 r3 M5 (the review's case): the containers w14 and w18 with their k swapped and their content in place. Accepted
        // before (set x2, move w15, move w19, place: 2 x 15 objects with new ObjectKeys for a screen that reads the same);
        // now refused before the plan, with the edit and the k named.
        var w14 = HtmlElementEdits.ElementText(html, "w14")!; var w18 = HtmlElementEdits.ElementText(html, "w18")!;
        Assert.Equal(html.IndexOf(w14, StringComparison.Ordinal) + w14.Length, html.IndexOf(w18, StringComparison.Ordinal));
        var pair = (w14 + w18).Trim();
        var keysSwapped = pair.Replace("k=\"w14\"", "k=\"#\"").Replace("k=\"w18\"", "k=\"w14\"").Replace("k=\"#\"", "k=\"w18\"");
        var inPlace = Edit(pair, keysSwapped, "keys-swapped-in-place");
        Assert.False(inPlace["accepted"]?.GetValue<bool>() ?? false, inPlace.ToJsonString());
        var refusal = Assert.Single(Problems(inPlace), p => p!["pointer"]!.ToString() == "/ops/0/data/edits/0")!;
        Assert.Equal(ScreenHtmlEdit.Invalid, refusal["code"]!.ToString());
        Assert.Equal(["w14", "w18"], refusal["keys"]!.AsArray().Select(k => k!.ToString()).Order());
    }

    // §9.1: every synthetic edit of the battery (ScreenHtmlEditBattery, today's parameters) written as edits — each element
    // whole as {replace: k}, the <style> by {find, with} (or into / when the reading has none), the document as {replace: "/"} —
    // gives the document and the ops of the edit form.
    [Fact]
    public void EveryBatteryEditInTheEditsFormIsTheEditForm()
    {
        if (!StudioAvailable()) { output.WriteLine("WARNING: no Service Studio: the equivalence battery is skipped."); return; }
        var host = Host("equivalence");
        var totals = new Dictionary<string, (int Edits, int Same)>(StringComparer.Ordinal);
        foreach (var (fixture, seed) in new[] { ("reactive-ui.oml", 1), ("mobile-ui.oml", 2) })
            foreach (var row in HtmlElementEditsBattery.Equivalence(host, File.ReadAllBytes(Fixture(fixture)), seed, perKind: 2)) {
                var t = totals.GetValueOrDefault(row.Kind); totals[row.Kind] = (t.Edits + 1, t.Same + (row.Same ? 1 : 0));
                if (!row.Same) output.WriteLine($"DIFFERS {fixture} {row.Root} {row.Kind}: {row.Detail}");
            }
        foreach (var (kind, t) in totals.OrderBy(x => x.Key)) output.WriteLine($"{kind}: {t.Same}/{t.Edits}");
        output.WriteLine($"total: {totals.Values.Sum(t => t.Same)}/{totals.Values.Sum(t => t.Edits)}");
        Assert.True(totals.Count > 0);
        Assert.All(totals, t => Assert.Equal(t.Value.Edits, t.Value.Same));
    }

    // ---- helpers (as ScreenHtmlEditJobTests) ---------------------------------------------------------------------------------
    // CX16 r2 (M4): the store of one test: a temporary root, Default() in its flow of execution only, deleted when disposed.
    private sealed class OwnStore : IDisposable
    {
        public readonly ModuleIndexStore Store;
        private readonly IDisposable scope;
        public OwnStore()
        {
            Store = new ModuleIndexStore(Path.Combine(Path.GetTempPath(), "cx16-store-" + Guid.NewGuid().ToString("N")), "o11", "kernel");
            scope = ModuleIndexStore.Use(Store);
        }
        public void Dispose()
        {
            scope.Dispose();
            try { if (Directory.Exists(Store.Root)) Directory.Delete(Store.Root, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    private static Dictionary<string, DateTime> Files(string root) => Directory.Exists(root)
        ? Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories).ToDictionary(f => f, File.GetLastWriteTimeUtc, StringComparer.OrdinalIgnoreCase) : [];

    private ModelHost Host(string name) { var dir = Path.Combine(Work, name); Directory.CreateDirectory(dir); return new ModelHost(dir); }

    private static (JsonObject Read, string Html, string Sha) Read(ModelHost host, string oml, string screen, bool keys = false)
    {
        var bytes = File.ReadAllBytes(oml);
        var read = host.HtmlRead(bytes, screen, withKeys: keys);
        return (read, read["documents"]![0]!["html"]!.ToString(), Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
    }

    private static void Keep(ModuleIndexStore store, string sha, JsonObject read, string? html, bool withText, JsonObject? keys = null)
    {
        var document = read["documents"]![0]!;
        var file = store.HtmlKeysPathOf(sha, document["htmlSha256"]!.ToString());
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var json = new JsonObject {
            ["schema"] = ScreenHtml.Schema, ["extractor"] = ScreenHtml.Extractor, ["lane"] = store.Lane, ["sourceSha256"] = sha, ["root"] = "Login",
            ["rootKey"] = document["rootKey"]!.DeepClone(), ["rootKind"] = document["rootKind"]!.DeepClone(), ["htmlSha256"] = document["htmlSha256"]!.DeepClone(),
            ["keys"] = (keys ?? document["keys"]!.AsObject()).DeepClone() };
        if (withText) json["html"] = html;
        File.WriteAllText(file, json.ToJsonString());
    }

    private static JsonObject Job(string sha, JsonObject read, string screen, IEnumerable<string>? edit = null, JsonArray? edits = null)
    {
        var data = new JsonObject { ["screen"] = screen, ["basedOn"] = new JsonObject { ["capture"] = sha, ["html"] = read["documents"]![0]!["htmlSha256"]!.DeepClone() } };
        if (edit != null) data["edit"] = new JsonArray(edit.Select(e => (JsonNode)e).ToArray());
        if (edits != null) data["edits"] = edits.DeepClone();
        return new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = data }) };
    }

    private JsonObject Run(ModelHost host, string basePath, JsonObject job, string name)
    {
        var dir = host.WorkDirectory;
        var jobPath = Path.Combine(dir, name + ".json"); File.WriteAllText(jobPath, job.ToJsonString());
        try { return JsonSerializer.SerializeToNode(JobRunner.Run(host, basePath, jobPath, Path.Combine(dir, name + ".oml")))!.AsObject(); }
        catch (Exception error) {
            var coded = Errors.FindCoded(error);
            output.WriteLine(name + " refused: " + Errors.Text(error)[..Math.Min(2000, Errors.Text(error).Length)]);
            return new JsonObject { ["accepted"] = false, ["code"] = coded?.Code, ["problems"] = coded?.Problems?.DeepClone() };
        }
    }

    private static JsonObject Answer(JsonObject result) => result["results"]!.AsArray().Select(r => r!["result"]).OfType<JsonObject>().Last(r => r["mode"]?.ToString() == "edit");
    private static JsonArray Problems(JsonObject result) => result["problems"] as JsonArray ?? new JsonArray();
    private static ScreenHtml.Node Element(ScreenHtml.Node tree, string k) => ScreenHtmlText.Elements(tree).First(x => x.Node.Get("k") == k).Node;
    private static void Attribute(ScreenHtml.Node node, string name, string value)
    {
        var i = node.Attributes.FindIndex(a => a.Key == name);
        if (i >= 0) node.Attributes[i] = new(name, value); else node.Attributes.Add(new(name, value));
    }
    private static bool StudioAvailable() { try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; } }
}
