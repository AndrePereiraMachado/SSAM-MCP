using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

/// <summary>L3d (24/10/2026): the HTML_EDIT_NOT_APPLIED of 11-24/10 that were still open, on the O11 fixtures. Each one either
/// applies now or is refused before anything is written, with its fix and, when the correction is certain, the patch (a
/// corrected edit list that applies). Relatos e2891d6b and e21fa130 (a new &lt;var type&gt;), 9540e92c (an empty os-GridColumns;
/// the ODC mirror has it), 6bd23d43 (a widget the platform would not rename), and the rest of the receipts: the weight of an
/// O11 &lt;i&gt;, the class of an If, enabled of an &lt;upload&gt;, a &lt;var&gt; inside an element. Needs the Service Studio.</summary>
public class ScreenHtmlEditRefusalTests(ITestOutputHelper output)
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenHtmlEditRefusalTests).Assembly.Location)!)!;
    private static readonly string Work = Path.Combine(Root, ".local", "screen-html-edit-refusals");
    private static string Fixture(string name) => Path.Combine(Root, "tests", "fixtures", name);

    // Relatos e2891d6b and e21fa130: a new variable was read as a widget, so its derived Type was a fact the text did not write
    // and the plan "reset" it: "the platform refused set Type on LocalVariable 'IsUploading' (new): ILocalVariable has no
    // writable property or setter 'Type'". Every type is created as written, and a type change of a variable of the reading too.
    [Fact]
    public void ANewVariableIsCreatedWithTheTypeItsTextSays()
    {
        var (host, bytes, data) = Edit("reactive-ui.oml", "InvalidPermissions",
            Insert("before", "w1", "<var name=\"IsUploading\" type=\"Boolean\" default=\"False\"/><var name=\"Count\" type=\"Integer\" default=\"5\"/>"
                + "<var name=\"When\" type=\"Date Time\"/><var name=\"Names\" type=\"Text List\"/><var name=\"Who\" type=\"User Identifier\"/>"));
        var answer = Apply(host, bytes, data, "vars");
        Assert.True(answer["accepted"]!.GetValue<bool>(), answer.ToJsonString());
        var after = ReadBack(host, "vars", "InvalidPermissions");
        foreach (var line in new[] { "name=\"IsUploading\" type=\"Boolean\" default=\"False\"", "name=\"Count\" type=\"Integer\" default=\"5\"", "name=\"When\" type=\"Date Time\"",
                     "name=\"Names\" type=\"Text List\"", "name=\"Who\" type=\"User Identifier\"" })
            Assert.Contains(line, after);
        Assert.DoesNotContain(answer["result"]!["ops"]!.AsArray(), op => op!["property"]?.ToString() == "Type");

        var (host2, bytes2, data2) = Edit("reactive-ui.oml", "Login", new JsonObject { ["set"] = "w4", ["attributes"] = new JsonObject { ["type"] = "Integer" } });
        var changed = Apply(host2, bytes2, data2, "var-type");
        Assert.True(changed["accepted"]!.GetValue<bool>(), changed.ToJsonString());
        Assert.Contains("<var k=\"w4\" name=\"Remember\" type=\"Integer\"/>", ReadBack(host2, "var-type", "Login"));
    }

    // A variable written inside an element: the platform refused its create after the build ("IPlaceholderContentWidget cannot
    // create ILocalVariable"). Refused by the plan, with where it goes.
    [Fact]
    public void AVariableInsideAnElementIsRefusedBeforeAnythingIsWritten()
    {
        var (host, bytes, data) = Edit("reactive-ui.oml", "InvalidPermissions", Insert("after", "w4", "<var name=\"F\" type=\"Boolean\"/>"));
        var answer = Apply(host, bytes, data, "var-in-slot");
        var problem = Assert.Single(Problems(answer));
        Assert.Equal(ScreenHtmlEdit.Invalid, problem["code"]!.ToString());
        Assert.Contains("a variable belongs to the screen itself", problem["message"]!.ToString());
        Assert.Contains("\"into\":\"/\"", problem["fix"]!.ToString());
    }

    // An empty value (relato 9540e92c on the ODC lane; here an option and an expression of O11): never a refusal after the build.
    // The patch leaves the attribute out, and the corrected edit applies.
    [Theory]
    [InlineData("w6", "os-Align", "a value")]
    [InlineData("w11", "enabled", "an expression")]
    public void AnEmptyValueIsRefusedBeforeTheBuildWithAPatchThatApplies(string k, string attribute, string takes)
    {
        var (host, bytes, data) = Edit("reactive-ui.oml", "InvalidPermissions", new JsonObject { ["set"] = k, ["attributes"] = new JsonObject { [attribute] = "" } });
        var answer = Apply(host, bytes, data, "empty-" + k);
        var problem = Assert.Single(Problems(answer));
        Assert.Equal(k, problem["k"]!.ToString());
        // integ/proto-into-product: a value the property model of F2 refuses (an option of Align) is F2's one problem
        // (HTML_PROPERTY_VALUE, the candidate's rule), and it carries this rule's certain patch; an empty expression is this rule's.
        if (problem["code"]!.ToString() == "HTML_PROPERTY_VALUE") Assert.Equal(attribute, problem["attribute"]!.ToString());
        else {
            Assert.Equal("HTML_VALUE_EMPTY", problem["code"]!.ToString());
            Assert.Contains(attribute + "=\"\"", problem["message"]!.ToString());
            Assert.Contains("takes " + takes, problem["message"]!.ToString());
        }
        AssertPatchApplies(host, bytes, data, problem, "empty-" + k + "-patched");
    }

    // integ/proto-into-product: an empty expression of a property whose default is empty (placeholder="") is the default
    // written explicitly, accepted (F2, the candidate's round trip; its generated sweep ScreenHtmlRoundTrip*Tests proves it on
    // every such property of the fixtures); an empty Enabled, whose default is True, is refused (the theory above).

    // "has no writable property or setter" (Weight of an O11 Icon, Style of an If, Enabled of an Upload, 9 receipts of 15-22/10):
    // what the document form normalizes is normalized here too, the rest is refused before the build.
    [Fact]
    public void WhatTheLaneHasNoPropertyForIsNormalizedOrRefusedBeforeTheBuild()
    {
        // A new If with a class: the class goes on a container of what it shows (IF_CLASS_MOVED, as in the document form).
        var (host, bytes, data) = Edit("reactive-ui.oml", "InvalidPermissions", Insert("after", "w4", "<div if=\"True\" class=\"card\"><text>x</text></div>"));
        var moved = Apply(host, bytes, data, "if-class");
        Assert.True(moved["accepted"]!.GetValue<bool>(), moved.ToJsonString());
        Assert.Contains(Normalized(moved), n => n!["code"]?.ToString() == "IF_CLASS_MOVED");
        var after = ReadBack(host, "if-class", "InvalidPermissions");
        Assert.Matches("<div k=\"w\\d+\" if=\"True\">\\s*<div k=\"w\\d+\" class=\"card\">", after);

        // The weight of an <i>, new or of the reading: the O11 Icon has none (ICON_WEIGHT_DROPPED, as in the document form).
        (host, bytes, data) = Edit("reactive-ui.oml", "InvalidPermissions", new JsonObject { ["set"] = "w3", ["attributes"] = new JsonObject { ["weight"] = "Bold" } },
            Insert("after", "w4", "<i icon=\"star\" weight=\"Bold\"/>"));
        var weight = Apply(host, bytes, data, "icon-weight");
        Assert.True(weight["accepted"]!.GetValue<bool>(), weight.ToJsonString());
        Assert.Equal(2, Normalized(weight).Count(n => n!["code"]?.ToString() == "ICON_WEIGHT_DROPPED"));

        // A class on an If of the reading: refused with the fix (its children would move to a new container).
        (host, bytes, data) = Edit("reactive-ui.oml", "InvalidPermissions", new JsonObject { ["set"] = "w10", ["attributes"] = new JsonObject { ["class"] = "card" } });
        var ifClass = Assert.Single(Problems(Apply(host, bytes, data, "if-class-read")));
        Assert.Equal("HTML_PROPERTY_UNKNOWN", ifClass["code"]!.ToString());
        Assert.Contains("an If shows no element of its own", ifClass["message"]!.ToString());
        Assert.Contains("<div class=\"card\">", ifClass["fix"]!.ToString());

        // A property the kind does not have: the fix lists what it writes, the patch removes it and applies.
        (host, bytes, data) = Edit("reactive-ui.oml", "InvalidPermissions", new JsonObject { ["set"] = "w6", ["attributes"] = new JsonObject { ["os-Widht"] = "3" } });
        var unknown = Apply(host, bytes, data, "unknown");
        var problem = Assert.Single(Problems(unknown));
        // integ/proto-into-product: F2's property model judges a property the kind does not have first (HTML_PROPERTY_NOT_KEPT,
        // the candidate's rule); its one problem carries this rule's certain patch.
        Assert.Equal("HTML_PROPERTY_NOT_KEPT", problem["code"]!.ToString());
        Assert.Contains("Container has no property Widht", problem["message"]!.ToString());
        Assert.StartsWith("remove os-Widht", problem["fix"]!.ToString());
        AssertPatchApplies(host, bytes, data, problem, "unknown-patched");

        // A new <upload enabled> or <upload disabled>: no Upload has Enabled, in either lane (the language's table no longer
        // maps enabled for it): refused before the build, never kept as an HTML attribute, and the patch applies.
        foreach (var control in new[] { "enabled=\"False\"", "disabled=\"\"" }) {
            (host, bytes, data) = Edit("reactive-ui.oml", "InvalidPermissions", Insert("before", "w1", "<var name=\"F\" type=\"Binary Data\"/>"),
                Insert("after", "w6", "<upload content=\"F\" " + control + " aria-label=\"up\"/>"));
            var upload = Assert.Single(Problems(Apply(host, bytes, data, "upload")));
            Assert.Equal("HTML_PROPERTY_UNKNOWN", upload["code"]!.ToString());
            Assert.Contains("on a new Upload: Upload has no Enabled", upload["message"]!.ToString());
            AssertPatchApplies(host, bytes, data, upload, "upload-patched");
        }
        // A Button has Enabled: enabled stays its property.
        (host, bytes, data) = Edit("reactive-ui.oml", "InvalidPermissions", new JsonObject { ["set"] = "w11", ["attributes"] = new JsonObject { ["enabled"] = "False" } });
        Assert.True(Apply(host, bytes, data, "button-enabled")["accepted"]!.GetValue<bool>());
    }

    // "no block named 'BottomSheet' for a new <Block>" (receipts of 12/10 and 22/10, after the build): the plan resolves the name
    // first; a typo or a qualification the module does not use comes with the block it certainly means as the patch.
    [Theory]
    [InlineData("BottomSheet", null)]
    [InlineData("BlankSlat", "BlankSlate")]
    [InlineData("OutSystemsUI.BlankSlate", "BlankSlate")]
    public void ANewBlockThatNamesNoBlockIsRefusedBeforeTheBuild(string name, string? meant)
    {
        var (host, bytes, data) = Edit("reactive-ui.oml", "InvalidPermissions", Insert("after", "w4", "<Block name=\"" + name + "\"/>"));
        var problem = Assert.Single(Problems(Apply(host, bytes, data, "block-" + name)));
        Assert.Equal(ScreenHtmlEdit.NameUnknown, problem["code"]!.ToString());
        Assert.Contains("<Block name=\"" + name + "\">", problem["message"]!.ToString());
        if (meant == null) {
            Assert.Contains("reference it in the same job", problem["fix"]!.ToString());
            Assert.Null(problem["patch"]);
            return;
        }
        Assert.StartsWith("write <Block name=\"" + meant + "\">", problem["fix"]!.ToString());
        AssertPatchApplies(host, bytes, data, problem, "block-" + name + "-patched");
    }

    // "set Destination: A OutSystems.Model.IObject cannot be used as the value for the ...Destination property" (15/10): the
    // name of the event resolved to the server action Login of a reference, nearer than the screen Login. Refused before the
    // build, on an element of the reading and on a new one, with the screen written as the reading writes it (the patch).
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void AnEventThatNamesWhatNoEventRunsIsRefusedBeforeTheBuild(bool read)
    {
        var edit = read ? new JsonObject { ["set"] = "w11", ["attributes"] = new JsonObject { ["onclick"] = "Login" } } : Insert("after", "w4", "<a onclick=\"Login\">x</a>");
        var (host, bytes, data) = Edit("reactive-ui.oml", "InvalidPermissions", edit);
        var problem = Assert.Single(Problems(Apply(host, bytes, data, "destination-" + read)));
        Assert.Equal(ScreenHtmlEdit.NameUnknown, problem["code"]!.ToString());
        Assert.Contains("'Login' is the ServerActionSignature Login, which an event cannot run", problem["message"]!.ToString());
        Assert.StartsWith("write onclick=\"MobileScreen:Login\"", problem["fix"]!.ToString());
        AssertPatchApplies(host, bytes, data, problem, "destination-" + read + "-patched");
    }

    // "k="w19" holds a widget the edit does not write" (7 receipts of 12-19/10, still live on 24/10): an element moved into another
    // parent whose children also change (a new one inside it). The platform's move gives the subtree new objects, and the order
    // of the moved element read its kept children as the old ones. Applies now, and reads back as written.
    [Fact]
    public void AMovedElementWithANewChildKeepsItsChildren()
    {
        var (host, bytes, data) = Edit("reactive-ui.oml", "InvalidPermissions");
        data.Remove("edits");
        data["edit"] = new JsonArray("<div k=\"w4\"><text k=\"w5\" class=\"heading6\">You don't have permissions to view this screen.</text>"
            + "<button k=\"w7\" class=\"btn\" onclick=\"@Mif02PxcH0K7KiABEHTwMg.#PreviousScreen\" os-onclick.Transition=\"UseHistory\"><span class=\"x\"><i icon=\"star\"/>y</span>"
            + "<i k=\"w8\" icon=\"angle-left\" class=\"icon\"/><text k=\"w9\" class=\"margin-left-s\">Go Back</text></button></div>");
        var answer = Apply(host, bytes, data, "moved-with-child");
        Assert.True(answer["accepted"]!.GetValue<bool>(), answer.ToJsonString());
        Assert.Contains(answer["result"]!["ops"]!.AsArray(), op => op!["op"]?.ToString() == "move" && op["k"]?.ToString() == "w7");
        var after = ReadBack(host, "moved-with-child", "InvalidPermissions");
        Assert.Matches("<div k=\"w4\">\\s*<text k=\"w5\" class=\"heading6\">[^<]*</text>\\s*<button k=\"w6\" class=\"btn\"[^>]*>\\s*<span k=\"w7\" class=\"x\">\\s*<i k=\"w8\" icon=\"star\"", after);
    }

    // Receipt 6da32953 (22/10): os-DesignMode on an If is no part of the text (the reading never writes it), so the module never
    // read back as the edit. Refused before the build, with the patch that removes it.
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void APropertyTheReadingNeverWritesIsRefusedBeforeTheBuild(bool read)
    {
        var edit = read ? new JsonObject { ["set"] = "w10", ["attributes"] = new JsonObject { ["os-DesignMode"] = "ShowTrueOrPreview" } }
            : Insert("after", "w4", "<div if=\"True\" os-DesignMode=\"ShowTrueOrPreview\"><text>x</text></div>");
        var (host, bytes, data) = Edit("reactive-ui.oml", "InvalidPermissions", edit);
        var problem = Assert.Single(Problems(Apply(host, bytes, data, "design-mode-" + read)));
        // integ/proto-into-product: on an element of the reading F2's property model refuses the editor state first
        // (HTML_PROPERTY_NOT_KEPT, the candidate's rule), with this rule's certain patch; on a new one this rule says it.
        if (read) { Assert.Equal("HTML_PROPERTY_NOT_KEPT", problem["code"]!.ToString()); Assert.Contains("os-DesignMode", problem["message"]!.ToString()); }
        else { Assert.Equal("HTML_PROPERTY_UNKNOWN", problem["code"]!.ToString()); Assert.Contains("DesignMode is not part of ssam-html/1", problem["message"]!.ToString()); }
        AssertPatchApplies(host, bytes, data, problem, "design-mode-" + read + "-patched");
    }

    // The SSAM_DumpProbe of 20/10 ("the block of k=\"+2\" has no input Title", after the build): an argument that is no input of
    // the block is refused before, with the inputs, and the slot when the name is a placeholder of the block.
    [Fact]
    public void AnArgumentThatIsNoInputOfTheBlockIsRefusedBeforeTheBuild()
    {
        var (host, bytes, data) = Edit("reactive-ui.oml", "InvalidPermissions", Insert("after", "w6", "<Block name=\"BlankSlate\" :Content=\"1\"/>"));
        var slot = Assert.Single(Problems(Apply(host, bytes, data, "argument-slot")));
        Assert.Equal(ScreenHtmlEdit.NameUnknown, slot["code"]!.ToString());
        Assert.Contains("its block has no input Content (inputs: ExtendedClass, FullHeight; placeholders: Icon, Content, Actions)", slot["message"]!.ToString());
        Assert.StartsWith("Content is a placeholder of the block: write what goes there as <slot name=\"Content\">", slot["fix"]!.ToString());

        (host, bytes, data) = Edit("reactive-ui.oml", "InvalidPermissions", new JsonObject { ["set"] = "w2", ["attributes"] = new JsonObject { [":FullHeigth"] = "True" } });
        var typo = Assert.Single(Problems(Apply(host, bytes, data, "argument-typo")));
        Assert.Equal("w2", typo["k"]!.ToString());
        Assert.Equal("write :FullHeight", typo["fix"]!.ToString());
    }

    // Receipts 2d984f9a and 9671c951 (22/10, relato e2891d6b): the literal text of a new <upload filename> is turned into an
    // expression by the platform when FileName is set ("k=\"+4\" does not hold a TextWidget the edit puts there"). The same text
    // as the expression of its literal applies (UPLOAD_TEXT_EXPRESSION), beside the icon and nested in an If.
    [Fact]
    public void TheTextOfANewUploadWithAFileNameIsItsExpression()
    {
        var (host, bytes, data) = Edit("reactive-ui.oml", "InvalidPermissions", Insert("before", "w1", "<var name=\"F\" type=\"Binary Data\"/><var name=\"N\" type=\"Text\"/>"),
            Insert("after", "w6", "<div class=\"a\"><div if=\"True\"><div class=\"b\"><upload bind=\"F\" filename=\"N\" accept=\".png,.pdf\"><i icon=\"paperclip\" weight=\"regular\"/> Attach</upload></div></div></div>"));
        var answer = Apply(host, bytes, data, "upload-text");
        Assert.True(answer["accepted"]!.GetValue<bool>(), answer.ToJsonString());
        Assert.Contains(Normalized(answer), n => n!["code"]?.ToString() == "UPLOAD_TEXT_EXPRESSION");
        Assert.Contains("{{ \" Attach\" }}", ReadBack(host, "upload-text", "InvalidPermissions"));
    }

    // Receipts 1efb50cf, 3c3ec56b and b75f1c3e (19/10): "a:ValuesType is 'Entities.ValuesType.Datetime', the edit says
    // 'Entities.ValuesType.DateTime'". A name has no case in OutSystems: the platform writes it as the module names it, and the
    // conference takes it as the same expression (NAME_CASE), on an argument of the reading and of a new block.
    [Fact]
    public void ANameWrittenInAnotherCaseIsTheSameExpression()
    {
        var (host, bytes, data) = Edit("traditional-ui.oml", "InvalidPermissions", new JsonObject { ["set"] = "w7", ["attributes"] = new JsonObject { [":Name"] = "Entities.IconName.Check_Circle" } },
            Insert("after", "w9", "<Block name=\"WebBlockSignature:Icon\" :Name=\"Entities.IconName.Info_Circle\"/>"));
        var answer = Apply(host, bytes, data, "name-case");
        Assert.True(answer["accepted"]!.GetValue<bool>(), answer.ToJsonString());
        Assert.Equal(2, Normalized(answer).Count(n => n!["code"]?.ToString() == "NAME_CASE"));
        var after = ReadBack(host, "name-case", "InvalidPermissions");
        Assert.Contains(":Name=\"Entities.IconName.check_circle\"", after);
        Assert.Contains(":Name=\"Entities.IconName.info_circle\"", after);
    }

    // An attribute on a Traditional os-ActionConnector is an extended property, which it cannot hold: refused before the build.
    [Fact]
    public void AnAttributeOnAnElementWithoutExtendedPropertiesIsRefusedBeforeTheBuild()
    {
        var (host, bytes, data) = Edit("traditional-ui.oml", "NoPermission", new JsonObject { ["set"] = "w1", ["attributes"] = new JsonObject { ["id"] = "X" } });
        var problem = Assert.Single(Problems(Apply(host, bytes, data, "connector")));
        Assert.Equal("HTML_PROPERTY_UNKNOWN", problem["code"]!.ToString());
        Assert.Contains("id=\"X\" on ActionConnector k=\"w1\"", problem["message"]!.ToString());
        AssertPatchApplies(host, bytes, data, problem, "connector-patched");
    }

    // Relato 6bd23d43 ("Widget does not support name changing"): a new block instance is named at its creation and a slot is
    // never named (20/10, ScreenHtmlEditTests); a widget of the reading is renamed by the platform, block instances included,
    // in Reactive and in Traditional.
    [Theory]
    [InlineData("reactive-ui.oml", "InvalidPermissions", "w2")]   // a Block (BlankSlate)
    [InlineData("reactive-ui.oml", "InvalidPermissions", "w3")]   // an <i>
    [InlineData("reactive-ui.oml", "InvalidPermissions", "w5")]   // a <text> with class
    [InlineData("traditional-ui.oml", "InvalidPermissions", "w5")] // a Web Block (Card)
    [InlineData("traditional-ui.oml", "InvalidPermissions", "w7")] // a Web Block with an argument (Icon)
    public void AWidgetOfTheReadingIsRenamed(string fixture, string screen, string k)
    {
        var (host, bytes, data) = Edit(fixture, screen, new JsonObject { ["set"] = k, ["attributes"] = new JsonObject { ["id"] = "Renamed" + k } });
        var answer = Apply(host, bytes, data, "rename-" + Path.GetFileNameWithoutExtension(fixture) + "-" + k);
        Assert.True(answer["accepted"]!.GetValue<bool>(), answer.ToJsonString());
        Assert.Matches("k=\"" + k + "\"[^>]* id=\"Renamed" + k + "\"", ReadBack(host, "rename-" + Path.GetFileNameWithoutExtension(fixture) + "-" + k, screen));
    }

    // ---- helpers ----------------------------------------------------------------------------------------------------------
    private static JsonObject Insert(string where, string k, string html) => new() { [where] = k, ["insert"] = html };

    private (ModelHost Host, byte[] Bytes, JsonObject Data) Edit(string fixture, string screen, params JsonObject[] edits)
    {
        var dir = Path.Combine(Work, Path.GetFileNameWithoutExtension(fixture));
        Directory.CreateDirectory(dir);
        var host = new ModelHost(dir);
        var bytes = File.ReadAllBytes(Fixture(fixture));
        var read = host.HtmlRead(bytes, screen);
        var data = new JsonObject { ["screen"] = screen,
            ["basedOn"] = new JsonObject { ["capture"] = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant(), ["html"] = read["documents"]![0]!["htmlSha256"]!.DeepClone() },
            ["edits"] = new JsonArray(edits.Select(e => (JsonNode)e).ToArray()) };
        return (host, bytes, data);
    }

    private JsonObject Apply(ModelHost host, byte[] bytes, JsonObject data, string name)
    {
        var answer = host.HtmlEdit(bytes, data, Path.Combine(host.WorkDirectory, name + ".oml"));
        output.WriteLine(name + ": " + answer.ToJsonString()[..Math.Min(1500, answer.ToJsonString().Length)]);
        // Never the platform's refusal after the build: each case here is decided by the plan.
        Assert.NotEqual(ScreenHtmlEdit.NotApplied, answer["code"]?.ToString());
        return answer;
    }

    private static string ReadBack(ModelHost host, string name, string screen) =>
        host.HtmlRead(File.ReadAllBytes(Path.Combine(host.WorkDirectory, name + ".oml")), screen)["documents"]![0]!["html"]!.ToString();

    private static List<JsonObject> Problems(JsonObject answer) => (answer["problems"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().ToList();
    private static JsonArray Normalized(JsonObject answer) => answer["result"]?["normalized"] as JsonArray ?? new JsonArray();

    // The patch of a problem (JSON Patch over op.data: the element edits replaced by the corrected edit list) applies.
    private void AssertPatchApplies(ModelHost host, byte[] bytes, JsonObject data, JsonObject problem, string name)
    {
        var patch = Assert.IsType<JsonArray>(problem["patch"]);
        var patched = data.DeepClone().AsObject();
        foreach (var step in patch.OfType<JsonObject>()) {
            var key = step["path"]!.ToString().TrimStart('/');
            if (step["op"]!.ToString() == "remove") patched.Remove(key); else patched[key] = step["value"]!.DeepClone();
        }
        var answer = Apply(host, bytes, patched, name);
        Assert.True(answer["accepted"]!.GetValue<bool>(), answer.ToJsonString());
    }
}
