using System.Globalization;
using System.Reflection;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using OutSystems.Model;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// Linked into both test projects. The gate of 2026-10-30: a block written with os-Public="True" came out Public False, with no word
// (ODC: the compile's reset of the unwritten properties wrote Shareable False, and Shareable is Public). The family: a property the
// document declares reaches the model, or the answer says it did not. Needs the lane's Studio.
public sealed class DeclaredPropertyKeptTests(ITestOutputHelper output)
{
    private static readonly Assembly Kernel = typeof(ModelHost).Assembly;
    private static bool Odc => Kernel.GetType("Anvil.Core.StudioAssembliesOdc") != null;
    private const string BlockType = "IMobileBlock", FlowType = "IMobileFlow", ScreenType = "IMobileScreen";

    private bool Bound()
    {
        try
        {
            var binder = Kernel.GetType("Anvil.Core.StudioAssembliesOdc") ?? Kernel.GetType("Anvil.Core.StudioAssemblies")!;
            var bind = binder.GetMethods().First(m => m.Name == "Bind");
            bind.Invoke(null, bind.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
            return true;
        }
        catch (Exception) { output.WriteLine("WARNING: no Studio of this lane: skipped."); return false; }
    }

    private static string Root()
    {
        var dir = Path.GetDirectoryName(typeof(DeclaredPropertyKeptTests).Assembly.Location)!;
        while (!File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Directory.GetParent(dir)!.FullName;
        return dir;
    }

    // A reactive module of the lane with one UI flow.
    private static (ModelHost Host, string Base, string Work) Module(string name)
    {
        var work = Path.Combine(Root(), ".local", Odc ? "lane-odc" : "", "declared-property-tests", name + "-" + Guid.NewGuid().ToString("N")[..6]);
        Directory.CreateDirectory(work);
        var fixture = Path.Combine(Root(), "tests", "fixtures", Odc ? Path.Combine("odc", "blank-crossdevice.oml") : "reactive-ui.oml");
        return (new ModelHost(work), fixture, work);
    }

    private static JsonObject Run(ModelHost host, string baseOml, string work, string job, out string output)
    {
        var path = Path.Combine(work, "job-" + Guid.NewGuid().ToString("N")[..6] + ".json");
        File.WriteAllText(path, job);
        output = Path.Combine(work, "out-" + Guid.NewGuid().ToString("N")[..6] + ".oml");
        return System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(host, baseOml, path, output))!.AsObject();
    }

    private static string FlowOp => new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = FlowType, ["name"] = "KeptFlow" }.ToJsonString();
    private static string HtmlOp(string html) => new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } }.ToJsonString();

    private static object? Prop(object element, string property)
    {
        foreach (var type in element.GetType().GetInterfaces().Prepend(element.GetType()))
            if (type.GetProperty(property, BindingFlags.Public | BindingFlags.Instance) is { } pi && pi.GetIndexParameters().Length == 0) return pi.GetValue(element);
        return null;
    }

    private static object Block(ModelHost host, string oml, string name)
    {
        var module = host.Load(File.ReadAllBytes(oml));
        return ((IObjectSignature)module).GetAllDescendantsOfType<IObjectSignature>()
            .First(o => o.GetType().GetInterfaces().Any(i => i.Name == BlockType) && Prop(o, "Name") as string == name);
    }

    [Fact]
    public void ABlockWrittenWithOsPublicComesOutPublic()
    {
        if (!Bound()) return;
        var (host, baseOml, work) = Module("public");
        var document = "<block name=\"KeptPublic\" flow=\"KeptFlow\" os-Public=\"True\" description=\"Kept\">\n<div>hi</div>\n</block>";
        var result = Run(host, baseOml, work, "{\"ops\":[" + FlowOp + "," + HtmlOp(document) + "]}", out var oml);
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        Assert.Equal(true, Prop(Block(host, oml, "KeptPublic"), "Public"));
    }

    [Fact]
    public void WrittenFalseStaysFalse()
    {
        if (!Bound()) return;
        var (host, baseOml, work) = Module("private");
        var result = Run(host, baseOml, work, "{\"ops\":[" + FlowOp + "," + HtmlOp("<block name=\"KeptPrivate\" flow=\"KeptFlow\" os-Public=\"False\"><div>hi</div></block>") + "]}", out var oml);
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        Assert.Equal(false, Prop(Block(host, oml, "KeptPrivate"), "Public"));
    }

    // The rule itself: a property that does not reach the model is a refusal that names it. In ODC Shareable and Public are one, so a
    // document that declares them apart cannot have both: on the base this was accepted, with one of the two lost.
    [Fact]
    public void ADeclaredPropertyTheModelDoesNotKeepIsRefusedByName()
    {
        if (!Bound() || !Odc) return;
        var (host, baseOml, work) = Module("refused");
        var document = "<block name=\"KeptNot\" flow=\"KeptFlow\" os-Public=\"True\" os-Shareable=\"False\"><div>hi</div></block>";
        var refusal = Assert.ThrowsAny<Exception>(() => Run(host, baseOml, work, "{\"ops\":[" + FlowOp + "," + HtmlOp(document) + "]}", out _));
        var coded = refusal as KernelRefusalException ?? refusal.InnerException as KernelRefusalException;
        Assert.NotNull(coded);
        var said = coded!.Problems?.ToJsonString() ?? coded.Message;
        output.WriteLine(said);
        Assert.Contains(ScreenHtmlEdit.PropertyNotKept, said, StringComparison.Ordinal);
        Assert.Contains("did not reach MobileBlock KeptNot", said, StringComparison.Ordinal);
    }

    // The proof of the document form compiles every element with its k of the reading. It goes through the refusal of a new document
    // all the same, or a false refusal never shows in it (the review of 2026-10-30: type="tel" was refused, and the proof said 46/46).
    [Fact]
    public void TheRecreationProofGoesThroughTheRefusalOfADeclaredProperty()
    {
        if (!Bound()) return;
        var (host, baseOml, work) = Module("proof");
        var document = "<block name=\"KeptProof\" flow=\"KeptFlow\"><var name=\"Phone\" type=\"PhoneNumber\"/><var name=\"When\" type=\"DateTime\"/>"
            + "<input id=\"PhoneInput\" bind=\"Phone\" os-InputType=\"Phone\"/><input id=\"WhenInput\" bind=\"When\" os-InputType=\"DateTime\"/></block>";
        var created = Run(host, baseOml, work, "{\"ops\":[" + FlowOp + "," + HtmlOp(document) + "]}", out var oml);
        Assert.True(created["accepted"]?.GetValue<bool>() == true, created.ToJsonString());
        var proof = ScreenRecreationProof.Run(host, File.ReadAllBytes(oml), "KeptProof", blocks: true);
        output.WriteLine(proof.ToJsonString());
        var row = proof["rows"]!.AsArray().Single()!.AsObject();
        Assert.Equal("same", row["outcome"]?.ToString());
        Assert.True(row["declaredPropertiesKept"]?.GetValue<int>() > 0, row.ToJsonString());
    }

    // The family of the false refusal: every word of the language for a value of the model. Each type of input of the grammar, on a
    // new document, on both lanes, reaches the model as the member the table says.
    [Theory]
    [InlineData("text", "Text", "Text")]
    [InlineData("password", "Text", "Password")]
    [InlineData("number", "Integer", "Number")]
    [InlineData("email", "Email", "Email")]
    [InlineData("tel", "PhoneNumber", "Phone")]
    [InlineData("search", "Text", "Search")]
    [InlineData("date", "Date", "Date")]
    [InlineData("time", "Time", "Time")]
    [InlineData("datetime-local", "DateTime", "DateTime")]
    public void EveryTypeOfInputOfTheGrammarReachesTheModelOfANewDocument(string type, string dataType, string member)
    {
        if (!Bound()) return;
        var (host, baseOml, work) = Module("input-" + type);
        var document = $"<block name=\"KeptInput\" flow=\"KeptFlow\"><var name=\"V\" type=\"{dataType}\"/><input bind=\"V\" type=\"{type}\"/></block>";
        var result = Run(host, baseOml, work, "{\"ops\":[" + FlowOp + "," + HtmlOp(document) + "]}", out var oml);
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        var input = ((IObjectSignature)Block(host, oml, "KeptInput")).GetAllDescendantsOfType<IObjectSignature>().First(o => o.GetType().GetInterfaces().Any(i => i.Name == "IInput"));
        Assert.Equal(member, Prop(input, "InputType")?.ToString(), ignoreCase: true);
    }

    // What is compared is what the compile wrote, never the text of the attribute: a constant binding is its value (LITERAL_CONSTANT), and
    // the family needs no row for it. property: the one to read back on the widget; value: what it holds.
    [Theory]
    [InlineData("<input bind=\"V\" maxlength=\"{{ 20 }}\"/>", "IInput", "MaxLength", "20")]
    [InlineData("<input bind=\"V\" os-MaxLength=\"{{ 20 }}\"/>", "IInput", "MaxLength", "20")]
    [InlineData("<textarea bind=\"V\" rows=\"{{ 4 }}\"></textarea>", "ITextArea", "TextLines", "4")]
    [InlineData("<input bind=\"V\" os-InputType='{{ \"Search\" }}'/>", "IInput", "InputType", "Search")]
    [InlineData("<div os-Width='{{ \"100 px\" }}'>x</div>", "IContainer", "Width", "100 px")]
    [InlineData("<input bind=\"V\" os-MaxLength=\" 20\"/>", "IInput", "MaxLength", "20")]
    public void AValueTheCompileNormalizesIsComparedAsItWrote(string widget, string type, string property, string value)
    {
        if (!Bound()) return;
        var (host, baseOml, work) = Module("written");
        var document = "<block name=\"KeptWritten\" flow=\"KeptFlow\"><var name=\"V\" type=\"Text\"/>" + widget + "</block>";
        var result = Run(host, baseOml, work, "{\"ops\":[" + FlowOp + "," + HtmlOp(document) + "]}", out var oml);
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        var made = ((IObjectSignature)Block(host, oml, "KeptWritten")).GetAllDescendantsOfType<IObjectSignature>().First(o => o.GetType().GetInterfaces().Any(i => i.Name == type));
        Assert.Equal(value, Convert.ToString(Prop(made, property), CultureInfo.InvariantCulture));
    }

    // A value the write itself refused has one problem, its own: no second one that says the platform decides.
    [Fact]
    public void AValueTheWriteRefusedIsNotSaidTwice()
    {
        if (!Bound()) return;
        var (host, baseOml, work) = Module("twice");
        var document = "<block name=\"KeptTwice\" flow=\"KeptFlow\"><var name=\"V\" type=\"PhoneNumber\"/><input bind=\"V\" type=\"TEL\"/></block>";
        var refusal = Assert.ThrowsAny<Exception>(() => Run(host, baseOml, work, "{\"ops\":[" + FlowOp + "," + HtmlOp(document) + "]}", out _));
        var said = (refusal as KernelRefusalException ?? refusal.InnerException as KernelRefusalException)?.Problems?.ToJsonString() ?? "";
        Assert.Contains("HTML_INVALID", said, StringComparison.Ordinal);
        Assert.DoesNotContain(ScreenHtmlEdit.PropertyNotKept, said, StringComparison.Ordinal);
    }

    // Measured: a new widget ends the compile with no MarginTop, alone or with a width, in ODC and O11, and with no inline style: the value is
    // lost. So it is refused by name, with the way that works (style= does reach the module). MarginBottom and MarginRight are
    // no properties of a widget. MarginLeft does reach it, with any width and in either order.
    [Theory]
    [InlineData("os-MarginTop=\"7\"", "replace os-MarginTop=\"7\" with style=\"margin-top:7px\"")]
    [InlineData("os-MarginTop=\"100 px\"", "replace os-MarginTop=\"100 px\" with style=\"margin-top:100px\"")]
    [InlineData("os-MarginTop=\"3 col\"", "remove os-MarginTop=\"3 col\": a style has no such length; write the top margin you mean as margin-top in style=")]
    [InlineData("os-Width=\"(fill parent)\" os-MarginTop=\"7\"", "replace os-MarginTop=\"7\" with style=\"margin-top:7px\"")]
    [InlineData("os-MarginTop=\"7\" style=\"color:red\"", "remove os-MarginTop=\"7\" and add margin-top:7px to the style this element has: style=\"color:red;margin-top:7px\"")]
    [InlineData("os-MarginTop=\"7\" style=\"{{ V }}\"", "remove os-MarginTop=\"7\" and add margin-top:7px to the text of the style this element has, style=\"{{ V }}\"")]
    public void ATopMarginThatNeverReachesTheModelIsRefusedByNameWithTheWayThatWorks(string attributes, string fix)
    {
        if (!Bound()) return;
        var (host, baseOml, work) = Module("margin-top");
        var document = "<block name=\"KeptMargin\" flow=\"KeptFlow\"><var name=\"V\" type=\"Text\"/><div " + attributes + ">x</div></block>";
        var refusal = Assert.ThrowsAny<Exception>(() => Run(host, baseOml, work, "{\"ops\":[" + FlowOp + "," + HtmlOp(document) + "]}", out _));
        var problems = (refusal as KernelRefusalException ?? refusal.InnerException as KernelRefusalException)?.Problems;
        var problem = problems!.Select(p => p!.AsObject()).Single(p => p["code"]?.ToString() == ScreenHtmlEdit.PropertyNotKept);
        Assert.Equal(fix, problem["fix"]?.ToString());
    }

    // The text taken at its word: the style it says compiles, with no second attribute, and the margin is in the module.
    [Fact]
    public void TheStyleTheRefusalSaysReachesTheModule()
    {
        if (!Bound()) return;
        var (host, baseOml, work) = Module("margin-style");
        var document = "<block name=\"KeptMargin\" flow=\"KeptFlow\"><div id=\"Boxed\" style=\"color:red;margin-top:7px\">x</div></block>";
        var result = Run(host, baseOml, work, "{\"ops\":[" + FlowOp + "," + HtmlOp(document) + "]}", out var oml);
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        Assert.Contains("style=\"color:red;margin-top:7px\"", host.HtmlRead(File.ReadAllBytes(oml), "KeptMargin")["documents"]![0]!["html"]!.ToString(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("os-MarginBottom=\"7\"")]
    [InlineData("os-MarginRight=\"7\"")]
    public void AMarginAWidgetDoesNotHaveIsRefusedByName(string attributes)
    {
        if (!Bound()) return;
        var (host, baseOml, work) = Module("margin-none");
        var document = "<block name=\"KeptMargin\" flow=\"KeptFlow\"><div " + attributes + ">x</div></block>";
        var refusal = Assert.ThrowsAny<Exception>(() => Run(host, baseOml, work, "{\"ops\":[" + FlowOp + "," + HtmlOp(document) + "]}", out _));
        Assert.Contains(attributes[..attributes.IndexOf('=')], refusal.ToString(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("os-MarginLeft=\"7\"", "7")]
    [InlineData("os-MarginLeft=\"8 px\"", "8 px")]
    [InlineData("os-Width=\"100 px\" os-MarginLeft=\"7\"", "7")]
    [InlineData("os-MarginLeft=\"7\" os-Width=\"100 px\"", "7")]
    [InlineData("os-Width=\"(fill parent)\" os-MarginLeft=\"7\"", "7")]
    public void ALeftMarginReachesTheModelWithAnyWidthInEitherOrder(string attributes, string value)
    {
        if (!Bound()) return;
        var (host, baseOml, work) = Module("margin-left");
        var document = "<block name=\"KeptMargin\" flow=\"KeptFlow\"><div id=\"Boxed\" " + attributes + ">x</div></block>";
        var result = Run(host, baseOml, work, "{\"ops\":[" + FlowOp + "," + HtmlOp(document) + "]}", out var oml);
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        var boxed = ((IObjectSignature)Block(host, oml, "KeptMargin")).GetAllDescendantsOfType<IObjectSignature>().First(o => Prop(o, "Name") as string == "Boxed");
        Assert.Equal(value, Prop(boxed, "MarginLeft"));
    }

    // The one table says which words the language has and which values the platform may rewrite (said, never refused), so nothing here
    // lists a case: every row of the language is covered above, and a word no row knows is the model's own.
    [Fact]
    public void TheTableOfDeclaredValuesIsTheOneTheCompileWrites()
    {
        Assert.Equal("Phone", ScreenHtmlTables.ModelValue("Input", "InputType", "tel"));
        Assert.Equal("DateTime", ScreenHtmlTables.ModelValue("Input", "InputType", "datetime-local"));
        Assert.Equal("Phone", ScreenHtmlTables.ModelValue("Input", "InputType", "Phone"));
        Assert.Equal("tel", ScreenHtmlTables.ModelValue("TextWidget", "InputType", "tel"));
        Assert.True(ScreenHtmlTables.PlatformRewrites("Container", "Name"));
        foreach (var margin in new[] { "MarginTop", "MarginLeft", "MarginBottom", "MarginRight" }) Assert.False(ScreenHtmlTables.PlatformRewrites("Container", margin));
        Assert.False(ScreenHtmlTables.PlatformRewrites("MobileBlock", "Public"));
    }

    // What the platform rewrites is said in the receipt and the document is not refused: a name it normalizes.
    [Fact]
    public void AValueThePlatformRewritesIsSaidAndNotRefused()
    {
        if (!Bound()) return;
        var (host, baseOml, work) = Module("rewrites");
        var document = "<block name=\"KeptRewrite\" flow=\"KeptFlow\"><div os-Name=\"Two Words\">x</div></block>";
        var result = Run(host, baseOml, work, "{\"ops\":[" + FlowOp + "," + HtmlOp(document) + "]}", out _);
        output.WriteLine(result.ToJsonString());
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        var said = result["results"]!.ToJsonString();
        Assert.Contains(ScreenHtmlEdit.PropertyNotKept, said, StringComparison.Ordinal);
    }

    // The same proof, fixed: an element with its k of the reading that declares what does not reach the model is refused there. Without
    // ProveDeclared it would pass as a note, and the proof would never show a false refusal again.
    [Fact]
    public void TheRecreationProofRefusesAnElementOfTheReadingThatDoesNotKeepItsProperty()
    {
        if (!Bound()) return;
        var (host, baseOml, work) = Module("proof-refusal");
        var created = Run(host, baseOml, work, "{\"ops\":[" + FlowOp + "," + HtmlOp("<block name=\"KeptProof\" flow=\"KeptFlow\"><div id=\"Boxed\">x</div></block>") + "]}", out var oml);
        Assert.True(created["accepted"]?.GetValue<bool>() == true, created.ToJsonString());
        var espace = host.Load(File.ReadAllBytes(oml));
        var reading = ScreenHtml.Module((IObjectSignature)espace, new KernelModelReader()).Read("MobileBlock:KeptProof");
        Assert.Contains("id=\"Boxed\"", reading.Html, StringComparison.Ordinal);
        var tampered = (ScreenHtmlDocument)typeof(object).GetMethod("MemberwiseClone", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(reading, null)!;
        typeof(ScreenHtmlDocument).GetProperty(nameof(ScreenHtmlDocument.Html))!.SetValue(tampered, reading.Html.Replace("id=\"Boxed\"", "id=\"Boxed\" os-MarginTop=\"7\""));
        var report = new ModelSession(espace).RecreateFromReading(tampered);
        output.WriteLine(report.ToJsonString());
        Assert.False(report["recreated"]?.GetValue<bool>() == true, report.ToJsonString());
        Assert.Equal(ScreenHtmlEdit.PropertyNotKept, report["code"]?.ToString());
    }

    // A test over a corpus that is not on the machine says so: skipped, with the reason, never green having read nothing.
    [Fact]
    public void ACorpusTestWithoutItsCapturesIsSkippedWithTheReason()
    {
        var dir = Path.Combine(Path.GetTempPath(), "corpus-fact", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var here = Path.Combine(dir, "here.oml"); File.WriteAllText(here, "x");
        var gone = Path.Combine(dir, "gone.oml");
        string Manifest(params (string Lane, string Oml)[] rows) { var file = Path.Combine(dir, Guid.NewGuid().ToString("N") + ".json");
            File.WriteAllText(file, new JsonObject { ["modules"] = new JsonArray(rows.Select(r => (JsonNode)new JsonObject { ["lane"] = r.Lane, ["oml"] = r.Oml }).ToArray()) }.ToJsonString()); return file; }
        Assert.Contains("0 of 1 captures", CorpusFactAttribute.ReasonOf(Manifest(("odc", gone)), "odc", all: false));
        Assert.Contains("no module", CorpusFactAttribute.ReasonOf(Manifest(("o11", here)), "odc", all: false));
        Assert.Null(CorpusFactAttribute.ReasonOf(Manifest(("odc", here), ("odc", gone)), "odc", all: false));
        Assert.Contains("1 of 2 captures", CorpusFactAttribute.ReasonOf(Manifest(("odc", here), ("odc", gone)), "odc", all: true));
        Assert.Contains("needs all of them", CorpusFactAttribute.ReasonOf(Manifest(("odc", here), ("odc", gone)), "odc", all: true));
        string Labeled() { var file = Path.Combine(dir, Guid.NewGuid().ToString("N") + ".json");
            File.WriteAllText(file, new JsonArray(new JsonObject { ["lane"] = "odc", ["label"] = "Here", ["oml"] = here }, new JsonObject { ["lane"] = "odc", ["label"] = "Gone", ["oml"] = gone }).ToJsonString()); return file; }
        Assert.Null(CorpusFactAttribute.ReasonOf(Labeled(), "odc", all: false, "Here"));
        Assert.Null(CorpusFactAttribute.ReasonOf(Manifest(("odc", here)), "odc", all: true));
        Assert.Contains("and not Gone", CorpusFactAttribute.ReasonOf(Labeled(), "odc", all: false, "Gone"));
    }

    // A test that reads what is present never waits for the whole corpus, and one that reads one module asks for that module. Read from the
    // attributes of the tests themselves (1 of 28 captures skipped these, saying "nothing to read").
    [Fact]
    public void ACorpusTestAsksOnlyForTheCapturesItReads()
    {
        var marked = typeof(DeclaredPropertyKeptTests).Assembly.GetTypes().SelectMany(t => t.GetMethods())
            .Select(m => (m.Name, Attribute: m.GetCustomAttribute<CorpusFactAttribute>())).Where(m => m.Attribute != null).ToList();
        Assert.NotEmpty(marked);
        foreach (var (name, attribute) in marked.Where(m => m.Name is "EveryPrintedCallInTheO11CorpusReturnsToItsExactOriginalText" or "PredictionsAndPatchNamesAgreeWithTheNativeNamingScope"))
            Assert.True(attribute!.Corpus == CorpusFactAttribute.TextPresent, name);
        var patched = marked.Single(m => m.Name == "AnOwnerWhoseScreenActionsRunAScriptIsCreatedThroughThePatch").Attribute!;
        Assert.Equal(Odc ? "FloodQuotes" : "DCIPS_Staff_Common", patched.Module);
    }

    // The other path of a text: the edit of a reading by k. os-Public on the block itself, and the answer either keeps it or names it.
    [Fact]
    public void AnEditOfTheReadingThatWritesOsPublicKeepsIt()
    {
        if (!Bound()) return;
        var (host, baseOml, work) = Module("edit");
        var created = Run(host, baseOml, work, "{\"ops\":[" + FlowOp + "," + HtmlOp("<block name=\"KeptEdit\" flow=\"KeptFlow\"><div>hi</div></block>") + "]}", out var oml);
        Assert.True(created["accepted"]?.GetValue<bool>() == true, created.ToJsonString());
        var bytes = File.ReadAllBytes(oml);
        var data = new JsonObject {
            ["screen"] = "KeptEdit",
            ["basedOn"] = new JsonObject { ["capture"] = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant(),
                ["html"] = host.HtmlRead(bytes, "KeptEdit")["documents"]![0]!["htmlSha256"]!.DeepClone() },
            ["edits"] = new JsonArray(new JsonObject { ["find"] = "name=\"KeptEdit\"", ["with"] = "name=\"KeptEdit\" os-Public=\"True\"" }) };
        var edited = Path.Combine(work, "edited.oml");
        var answer = host.HtmlEdit(bytes, data, edited);
        output.WriteLine(answer.ToJsonString());
        if (answer["accepted"]?.GetValue<bool>() == true) Assert.Equal(true, Prop(Block(host, edited, "KeptEdit"), "Public"));
        else Assert.Contains("Public", answer.ToJsonString(), StringComparison.Ordinal);
    }

    // A value declared on a block by an edit is applied, never ignored. A public block's reading prints both properties, which are one in
    // ODC, so a value left as it was is a stale copy: what the edit changed is what it means, and the answer says the other went with it.
    // An attribute taken out is no declaration: the one still written is what the text says, and with neither written the block is private.
    // A private block's reading prints neither: writing both apart is a contradiction, refused as in a new document. kept: the block after; null: refused by name.
    [Theory]
    [InlineData(true, "os-Public=\"True\"", "os-Public=\"False\"", false)]
    [InlineData(true, "os-Public=\"True\"", "", true)]
    [InlineData(true, "os-Shareable=\"True\"", "os-Shareable=\"False\"", false)]
    [InlineData(true, "os-Shareable=\"True\"", "", true)]
    [InlineData(true, "os-Public=\"True\" os-Shareable=\"True\"", "", false)]
    [InlineData(true, "os-Public=\"True\" os-Shareable=\"True\"", "os-Public=\"False\" os-Shareable=\"False\"", false)]
    [InlineData(true, "os-Shareable=\"True\"", "os-Shareable=\"True\" description=\"x\"", true)]
    [InlineData(true, "os-Public=\"True\" os-Shareable=\"True\"", "os-Public=\"True\" os-Shareable=\"False\"", false)]
    [InlineData(true, "os-Public=\"True\" os-Shareable=\"True\"", "os-Public=\"False\" os-Shareable=\"True\"", false)]
    [InlineData(false, "name=\"KeptPair\"", "name=\"KeptPair\" os-Public=\"True\"", true)]
    [InlineData(false, "name=\"KeptPair\"", "name=\"KeptPair\" os-Shareable=\"True\"", true)]
    [InlineData(false, "name=\"KeptPair\"", "name=\"KeptPair\" os-Public=\"True\" os-Shareable=\"True\"", true)]
    [InlineData(false, "name=\"KeptPair\"", "name=\"KeptPair\" os-Public=\"False\" os-Shareable=\"True\"", null)]
    [InlineData(false, "name=\"KeptPair\"", "name=\"KeptPair\" os-Shareable=\"False\" os-Public=\"True\"", null)]
    [InlineData(false, "name=\"KeptPair\"", "name=\"KeptPair\" os-Public=\"False\"", false)]
    public void AnEditOfThePairIsAppliedOrRefusedNeverIgnored(bool isPublic, string find, string with, bool? kept)
    {
        if (!Bound() || !Odc) return;
        var (host, baseOml, work) = Module("pair");
        var created = Run(host, baseOml, work, "{\"ops\":[" + FlowOp + "," + HtmlOp("<block name=\"KeptPair\" flow=\"KeptFlow\"" + (isPublic ? " os-Public=\"True\"" : "") + "><div>hi</div></block>") + "]}", out var oml);
        Assert.True(created["accepted"]?.GetValue<bool>() == true, created.ToJsonString());
        var bytes = File.ReadAllBytes(oml);
        var data = new JsonObject {
            ["screen"] = "KeptPair",
            ["basedOn"] = new JsonObject { ["capture"] = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant(),
                ["html"] = host.HtmlRead(bytes, "KeptPair")["documents"]![0]!["htmlSha256"]!.DeepClone() },
            ["edits"] = new JsonArray(new JsonObject { ["find"] = find, ["with"] = with }) };
        var edited = Path.Combine(work, "edited.oml");
        var answer = host.HtmlEdit(bytes, data, edited);
        output.WriteLine(answer.ToJsonString());
        if (kept == null)
        {
            Assert.NotEqual(true, answer["accepted"]?.GetValue<bool>());
            Assert.Contains(ScreenHtmlEdit.PropertyNotKept, answer.ToJsonString(), StringComparison.Ordinal);
            return;
        }
        Assert.True(answer["accepted"]?.GetValue<bool>() == true, answer.ToJsonString());
        if (kept != isPublic) Assert.Contains("is the same property of the platform", answer.ToJsonString(), StringComparison.Ordinal);
        var block = Block(host, edited, "KeptPair");
        Assert.Equal(kept, Prop(block, "Public"));
        Assert.Equal(kept, Prop(block, "Shareable"));
    }

    // The same words on a new document, where the two are one property too: each order of the attributes, and alone.
    [Theory]
    [InlineData("os-Public=\"False\"", false)]
    [InlineData("os-Shareable=\"True\"", true)]
    [InlineData("os-Shareable=\"False\"", false)]
    [InlineData("os-Public=\"True\" os-Shareable=\"True\"", true)]
    [InlineData("os-Public=\"False\" os-Shareable=\"False\"", false)]
    [InlineData("os-Public=\"False\" os-Shareable=\"True\"", null)]
    [InlineData("os-Shareable=\"True\" os-Public=\"False\"", null)]
    [InlineData("os-Shareable=\"False\" os-Public=\"True\"", null)]
    public void ADocumentOfThePairIsAppliedOrRefusedByName(string attributes, bool? kept)
    {
        if (!Bound() || !Odc) return;
        var (host, baseOml, work) = Module("pair-doc");
        var job = "{\"ops\":[" + FlowOp + "," + HtmlOp("<block name=\"KeptDoc\" flow=\"KeptFlow\" " + attributes + "><div>hi</div></block>") + "]}";
        if (kept == null)
        {
            var refusal = Assert.ThrowsAny<Exception>(() => Run(host, baseOml, work, job, out _));
            var coded = refusal as KernelRefusalException ?? refusal.InnerException as KernelRefusalException;
            Assert.Contains(ScreenHtmlEdit.PropertyNotKept, coded?.Problems?.ToJsonString() ?? "", StringComparison.Ordinal);
            return;
        }
        var result = Run(host, baseOml, work, job, out var oml);
        Assert.True(result["accepted"]?.GetValue<bool>() == true, result.ToJsonString());
        var block = Block(host, oml, "KeptDoc");
        Assert.Equal(kept, Prop(block, "Public"));
        Assert.Equal(kept, Prop(block, "Shareable"));
    }

    // The census: every writable boolean, number and member of an enumeration of the roots of the language and of a data element,
    // written away from what a new one has. Each one either reaches the model or the compile refuses it, naming it. No third case.
    [Theory]
    [InlineData("block")]
    [InlineData("screen")]
    public void EveryPropertyOfARootReachesTheModelOrIsRefused(string tag)
    {
        if (!Bound()) return;
        var (host, baseOml, work) = Module("census-" + tag);
        var fresh = Run(host, baseOml, work, "{\"ops\":[" + FlowOp + "," + HtmlOp($"<{tag} name=\"Census\" flow=\"KeptFlow\"{Open(tag, null)}><div>hi</div></{tag}>") + "]}", out var freshOml);
        Assert.True(fresh["accepted"]?.GetValue<bool>() == true, fresh.ToJsonString());
        var element = Root(host, freshOml, tag);
        var tried = new List<string>(); var silent = new List<string>(); var refused = new List<string>();
        foreach (var pi in Writable(element))
        {
            var away = Away(pi, Prop(element, pi.Name));
            if (away == null) continue;
            tried.Add(pi.Name);
            var html = $"<{tag} name=\"Census\" flow=\"KeptFlow\"{Open(tag, pi.Name)} os-{pi.Name}=\"{away}\"><div>hi</div></{tag}>";
            JsonObject answer; string oml;
            try { answer = Run(host, baseOml, work, "{\"ops\":[" + FlowOp + "," + HtmlOp(html) + "]}", out oml); }
            catch (Exception refusal) when (refusal.Message.Contains(pi.Name, StringComparison.Ordinal)) { refused.Add(pi.Name); continue; }
            if (answer["accepted"]?.GetValue<bool>() != true)
            {
                var said = answer.ToJsonString();
                if (said.Contains("os-" + pi.Name, StringComparison.Ordinal) || said.Contains(pi.Name, StringComparison.Ordinal)) refused.Add(pi.Name);
                else silent.Add(pi.Name + " (refused without naming it)");
                continue;
            }
            var now = Prop(Root(host, oml, tag), pi.Name);
            if (!string.Equals(Convert.ToString(now, CultureInfo.InvariantCulture), away, StringComparison.OrdinalIgnoreCase)) silent.Add(pi.Name + "=" + away + " came out " + now);
        }
        output.WriteLine(tag + ": tried " + string.Join(", ", tried));
        output.WriteLine(tag + ": refused by name " + string.Join(", ", refused));
        Assert.NotEmpty(tried);
        Assert.True(silent.Count == 0, tag + ": lost in silence: " + string.Join("; ", silent));
    }

    // A new screen needs a role or anonymous access to be valid: the census writes it open, except when it is the property under test.
    private static string Open(string tag, string? tested) => Odc && tag == "screen" && tested != "AnonymousAccess" ? " os-AnonymousAccess=\"True\"" : "";

    private static object Root(ModelHost host, string oml, string tag)
    {
        var wanted = tag == "block" ? BlockType : ScreenType;
        var module = host.Load(File.ReadAllBytes(oml));
        return ((IObjectSignature)module).GetAllDescendantsOfType<IObjectSignature>()
            .First(o => o.GetType().GetInterfaces().Any(i => i.Name == wanted) && Prop(o, "Name") as string == "Census");
    }

    private static IEnumerable<PropertyInfo> Writable(object element)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var type in element.GetType().GetInterfaces())
        {
            if (type.Namespace?.StartsWith("OutSystems.Model", StringComparison.Ordinal) != true) continue;
            foreach (var pi in type.GetProperties())
            {
                if (!pi.CanWrite || pi.GetIndexParameters().Length != 0 || !seen.Add(pi.Name)) continue;
                if (ScreenHtml.NotFacts.Contains(pi.Name) || pi.Name is "Name" or "Visible") continue;
                var t = Nullable.GetUnderlyingType(pi.PropertyType) ?? pi.PropertyType;
                if (t == typeof(bool) || t.IsEnum) yield return pi;
            }
        }
    }

    // The text of a value away from the fresh one: the other boolean, another member. Null when there is none.
    private static string? Away(PropertyInfo pi, object? fresh)
    {
        var t = Nullable.GetUnderlyingType(pi.PropertyType) ?? pi.PropertyType;
        if (t == typeof(bool)) return fresh is true ? "False" : "True";
        return t.IsEnum ? Enum.GetNames(t).FirstOrDefault(n => !string.Equals(n, fresh?.ToString(), StringComparison.Ordinal)) : null;
    }
}
