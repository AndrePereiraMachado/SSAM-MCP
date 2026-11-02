using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

// Linked into both test projects. The review of fase4-28/r4-w3-edit (REVISAO-W3-EDIT.md, CORRIGIR): what the F8/F10 port changed
// in modules that already exist, and the three normalizations that were not of one reading. Each case is the reviewer's probe.
public sealed partial class ScreenHtmlEditTests
{
    // The line's block of version 4 (the rule of the table parts before F8), as a theme of the owner carries it.
    private static string LineV4Block() => ScreenVisual.NativeLayoutCss
        .Replace("version " + ScreenVisual.NativeLayoutVersion + ",", "version 4,", StringComparison.Ordinal)
        .Replace(ScreenVisual.TableRowsCss, ":is(thead,tbody,tfoot)[data-ssam-rows]{display:table-row-group;width:auto}\n", StringComparison.Ordinal);

    // ScreenVisual.WithNativeLayout with what an older block held (by reflection: the test compiles where it is red).
    private static string Replace(string author, out string action, out string? from, out List<string> kept)
    {
        var css = Replace(author, out action, out from, out kept, out _);
        return css;
    }

    private static string Replace(string author, out string action, out string? from, out List<string> kept, out List<string> asComment)
    {
        var method = typeof(ScreenVisual).GetMethods().SingleOrDefault(m => m.Name == "WithNativeLayout" && m.GetParameters().Length == 5);
        Assert.True(method != null, "WithNativeLayout says neither the version it replaced nor what it kept as a comment");
        var args = new object?[] { author, null, null, null, null };
        var css = (string)method!.Invoke(null, args)!;
        action = (string)args[1]!; from = (string?)args[2]; kept = (List<string>)args[3]!; asComment = (List<string>)args[4]!;
        return css;
    }

    [Fact]
    public void AnOlderNativeBlockIsReplacedAndWhatItsAuthorWroteInsideItIsKeptOutsideIt()
    {
        // Correction 1 (RevProbe1): an author's rule inside the v4 block was dropped without a word.
        var v4 = LineV4Block();
        Assert.NotEqual(ScreenVisual.NativeLayoutCss, v4);
        var custom = v4.Replace(ScreenVisual.NativeLayoutEnd, ".mine[data-ssam-rows]{background:red}\n" + ScreenVisual.NativeLayoutEnd, StringComparison.Ordinal);
        var after = Replace(".a{color:blue}\n\n" + custom + "\n.b{color:green}\n", out var action, out var from, out var kept);
        Assert.Equal("replaced", action);
        Assert.Equal("4", from);
        Assert.Equal([".mine[data-ssam-rows]{background:red}"], kept);
        Assert.Contains(ScreenVisual.NativeLayoutCss + "\n.mine[data-ssam-rows]{background:red}", after);   // right after the block, outside it
        Assert.Contains(".a{color:blue}", after);
        Assert.Contains(".b{color:green}", after);
        // Exactly a block the engine wrote: replaced, nothing kept; and the new text is the fixed point.
        var plain = Replace(".a{}\n" + v4, out action, out from, out kept);
        Assert.Equal("replaced", action);
        Assert.Equal("4", from);
        Assert.Empty(kept);
        Assert.Equal(plain, ScreenVisual.WithNativeLayout(plain, out action));
        Assert.Equal("present", action);
        // The proto's "4" is this version's table rules with another comment: nothing of it is the author's.
        var proto = ScreenVisual.NativeLayoutCss.Replace("version " + ScreenVisual.NativeLayoutVersion + ",", "version 4,", StringComparison.Ordinal);
        Replace(proto, out action, out from, out kept);
        Assert.Equal(("replaced", "4"), (action, from));
        Assert.Empty(kept);
    }

    [Fact]
    public void TheVersionOfABlockOfVersionOneIsReadAndNoLeftoverJoinsTheRuleAfterIt()
    {
        // Round 2 (R2-1): the v1 block writes its version on the marker line ("/* ssam:native-layout */ v1"); its "v1" was kept
        // after the new block and the author's .b{} outside it read as "v1 .b".
        const string v1 = "/* ssam:native-layout */ v1\n.ThemeGrid_MarginGutter.ThemeGrid_MarginGutter{margin-left:0}\n.layout .main,.layout .content,.layout .main-content{min-width:0}\n"
            + "table>:is(thead,tbody,tfoot)[data-list]{display:table-row-group;width:auto}\n[data-list][data-virtualization-disabled]>script{display:none!important}\n/* /ssam:native-layout */";
        var after = Replace(".a{color:blue}\n" + v1 + "\n.b{color:green}\n", out var action, out var from, out var kept, out var asComment);
        Assert.Equal(("replaced", "1"), (action, from));
        Assert.Empty(kept);
        Assert.Empty(asComment);
        Assert.Contains(".b", ScreenVisual.RulesOf([after]).Select(r => r.Selector));
        Assert.DoesNotContain(ScreenVisual.RulesOf([after]), r => r.Selector.Contains("v1", StringComparison.Ordinal));
        // A stray word of the author inside the block: kept inside a comment, never the selector of the next rule.
        var stray = ScreenVisual.NativeLayoutCss.Replace("version " + ScreenVisual.NativeLayoutVersion + ",", "version 4,", StringComparison.Ordinal)
            .Replace(ScreenVisual.NativeLayoutEnd, "oops\n.mine{color:red}\n" + ScreenVisual.NativeLayoutEnd, StringComparison.Ordinal);
        var kept2 = Replace(stray + "\n.b{}", out _, out from, out kept, out asComment);
        Assert.Equal("4", from);
        Assert.Equal([".mine{color:red}"], kept);
        Assert.Equal(["oops"], asComment);
        var selectors = ScreenVisual.RulesOf([kept2]).Select(r => r.Selector).ToList();
        Assert.Contains(".mine", selectors);
        Assert.Contains(".b", selectors);
        Assert.DoesNotContain(selectors, x => x.Contains("oops", StringComparison.Ordinal));
        Assert.Contains("/* ssam: kept from the native layout block of version 4 (no complete rule): oops */", kept2);
    }

    [Fact]
    public void TextAfterACommentOnItsLineIsClassifiedLikeALineOfItsOwn()
    {
        // Round 3 (R3-1, the reviewer's probe R12): "/* a note */ stray" was kept as CSS with the comment, and ".ok" read as "stray .ok".
        var v4 = ScreenVisual.NativeLayoutCss.Replace("version " + ScreenVisual.NativeLayoutVersion + ",", "version 4,", StringComparison.Ordinal);
        var body = v4.Replace(ScreenVisual.NativeLayoutEnd, "/* a note */ stray\n}\n.ok{color:red}\n" + ScreenVisual.NativeLayoutEnd, StringComparison.Ordinal);
        var after = Replace(body + "\n.b{color:green}\n", out _, out var from, out var kept, out var asComment);
        Assert.Equal("4", from);
        Assert.Equal(["/* a note */", ".ok{color:red}"], kept);
        Assert.Equal(["stray", "}"], asComment);
        var selectors = ScreenVisual.RulesOf([after]).Select(r => r.Selector).ToList();
        Assert.Contains(".ok", selectors);
        Assert.Contains(".b", selectors);
        Assert.DoesNotContain(selectors, x => x.Contains("stray", StringComparison.Ordinal));
    }

    [Fact]
    public void AnExistingListThatIsNoTablePartKeepsItsModeWhenAnEditTouchesWhatHoldsIt()
    {
        // Correction 2 (RevProbe5): an edit of the container around a <ul list k> of the reading switched it to Mode Custom and
        // said "in a table the edit touches".
        keys = 0;
        var module = N("ESpace", "Shop");
        var screen = module.Add(N("MobileFlow", "MainFlow")).Add(N("MobileScreen", "Clients"));
        var box = screen.Add(W("Container", "Box")).Set("Style", new Code("\"box\""));
        var ul = box.Add(W("List", "Items")).Set("Tag", "ul").Set("Style", new Code("\"list\"")).Set("Source", new Code("GetClients.List"));
        ul.Add(W("AdvancedHtml")).Set("Tag", "li").Add(W("Expression")).Set("Value", new Code("GetClients.List.Current.Name"));
        var (_, document) = Read(module, "Clients");
        var k = document.Html.Split('\n').First(l => l.Contains("class=\"box\"", StringComparison.Ordinal)).Split(" k=\"")[1].Split('"')[0];
        var text = HtmlElementEdits.ElementText(document.Html, k)!;
        var (result, after) = ApplyWith(module, [text.Replace("class=\"box\"", "class=\"box wide\"", StringComparison.Ordinal)], ThemeOfThisModule);
        Assert.False(result.Refused, Codes(result));
        Assert.DoesNotContain("os-Mode", after.Split('\n').Single(l => l.TrimStart().StartsWith("<ul", StringComparison.Ordinal)));
        Assert.False(ul.Props.ContainsKey("Mode"));
        Assert.DoesNotContain(result.Normalized, n => n["code"]?.ToString() is "TABLE_LIST_REPAIRED" or "LIST_MODE_CUSTOM");
    }

    [Fact]
    public void ALiftedRowOfTheReadingKeepsTheAuthorsClassAndLeavesTheStudiosClassOfTheList()
    {
        // Correction 3 (RevProbe4): the lift carried the Studio's class="list" to each row. Another class of the author stays on
        // the row and is said.
        var module = RowListModule();
        var list = AllNodes(module).Single(n => n.Kind == "List");
        list.Set("Style", new Code("\"row-x list\""));
        var (_, document) = Read(module, "Clients");
        var th = document.Html.Split('\n').First(l => l.TrimStart().StartsWith("<th ", StringComparison.Ordinal)).Trim();
        var (result, after) = ApplyWith(module, [th.Replace(">Name<", ">Client<", StringComparison.Ordinal)], ThemeOfThisModule);
        Assert.False(result.Refused, Codes(result));
        var lines = after.Split('\n').Select(l => l.Trim()).ToList();
        var bodyAt = lines.FindIndex(l => l.StartsWith("<tbody", StringComparison.Ordinal));
        Assert.Contains("class=\"row-x\"", lines[bodyAt + 1]);
        Assert.DoesNotContain("list", lines[bodyAt + 1].Replace("row-x", "", StringComparison.Ordinal));
        var note = Assert.Single(result.Normalized, n => n["code"]?.ToString() == "TABLE_ROW_LIST_LIFTED");
        Assert.Contains("row-x", note["classMovedToRow"]![0]!.ToString());
        Assert.Contains("list", note["classDropped"]![0]!.ToString());
    }

    [Fact]
    public void ADeclarationWithoutKNamedLikeOneTheScreenHasIsItsEditOrOneRefusalBeforeAnythingIsWritten()
    {
        // Correction 4 (RevProbe2, J2b): the Studio renamed the second one (Username2) after the build. The only <var> of that
        // name is edited, said with its k; a name another kind of declaration has is refused in the plan with its k.
        var module = FormModule();
        var (result, _, _) = Apply(module, ["<var name=\"Search\" type=\"Text\"/>"], "Orders");
        Assert.False(result.Refused, Said(result));
        Assert.Single(module.Children[0].Children[1].Children, c => c.Kind == "LocalVariable" && c.Name == "Search");
        var keyed = Assert.Single(result.Normalized, n => n["code"]?.ToString() == "HTML_DECLARATION_KEYED");
        Assert.False(string.IsNullOrEmpty(keyed["k"]?.ToString()));
        // Round 2 (R2-2): only the element exactly as read is that one; the mandatory input written without mandatory is refused.
        var (input, _, inputWriter) = Apply(FormModule(), ["<input name=\"OrderId\" type=\"Long Integer\"/>"], "Detail");
        Assert.Equal(ScreenHtmlEdit.NameTaken, Assert.Single(input.Problems)["code"]!.ToString());
        Assert.Empty(inputWriter.Log);
        var fresh = FormModule();
        var (taken, _, writer) = Apply(fresh, ["<input name=\"Search\" type=\"Text\"/>"], "Orders");
        var problem = Assert.Single(taken.Problems);
        Assert.Equal(ScreenHtmlEdit.NameTaken, problem["code"]!.ToString());
        Assert.Contains("k=\"", problem["fix"]!.ToString());
        Assert.Empty(writer.Log);
    }

    [Fact]
    public void ADeclarationWithoutKThatChangesWhatTheScreenHasIsRefusedWithThePatchThatAddsItsK()
    {
        // Round 2 (R2-2): the edit made of a declaration without k changed what the job did not say: its type (refused after the
        // build on the bound Input), its default ("abc" erased), the case of its name (Username renamed username). Each is now one
        // refusal in the plan, nothing written, with the patch that writes the k (and the name as read).
        string Patched(JsonObject problem) => problem["patch"]![0]!["value"]!.ToString();
        var typed = FormModule();
        var k = Read(typed, "Orders").Document.Html.Split('\n').First(l => l.Contains("name=\"Search\"", StringComparison.Ordinal)).Split(" k=\"")[1].Split('"')[0];
        var (type, _, typeWriter) = Apply(typed, ["<var name=\"Search\" type=\"Integer\"/>"], "Orders");
        var refused = Assert.Single(type.Problems);
        Assert.Equal(ScreenHtmlEdit.NameTaken, refused["code"]!.ToString());
        Assert.Equal("<var k=\"" + k + "\" name=\"Search\" type=\"Integer\"/>", Patched(refused));
        Assert.Empty(typeWriter.Log);
        var cased = FormModule();
        var (name, _, nameWriter) = Apply(cased, ["<var name=\"search\" type=\"Text\"/>"], "Orders");
        var renamed = Assert.Single(name.Problems);
        Assert.Equal(ScreenHtmlEdit.NameTaken, renamed["code"]!.ToString());
        Assert.Equal("<var k=\"" + k + "\" name=\"Search\" type=\"Text\"/>", Patched(renamed));
        Assert.Empty(nameWriter.Log);
        Assert.Contains(cased.Children[0].Children[1].Children, c => c.Kind == "LocalVariable" && c.Name == "Search");
        // A default the job leaves out is refused too, and the default stays.
        var defaulted = FormModule();
        var search = defaulted.Children[0].Children[1].Children.Single(c => c.Kind == "LocalVariable" && c.Name == "Search");
        search.Set("DefaultValue", new Code("\"abc\""));
        Assert.Contains("abc", Read(defaulted, "Orders").Document.Html);
        var (dropped, after, droppedWriter) = Apply(defaulted, ["<var name=\"Search\" type=\"Text\"/>"], "Orders");
        Assert.Equal(ScreenHtmlEdit.NameTaken, Assert.Single(dropped.Problems)["code"]!.ToString());
        Assert.Empty(droppedWriter.Log);
        Assert.Contains("abc", after);
    }

    [Fact]
    public void ATypeQualifiedWithWhatOwnsNoSuchTypeIsNeverNormalized()
    {
        // Correction 5 (RevProbe3): Nowhere.Text became Text with a note that Nowhere owns it.
        var (result, _, writer) = Apply(FormModule(), ["<var name=\"Note\" type=\"Nowhere.Text\"/>"], "Orders");
        Assert.DoesNotContain(result.Normalized, n => n["code"]?.ToString() == "HTML_TYPE_UNQUALIFIED");
        Assert.True(result.Refused, "a type the page cannot resolve is refused");
        Assert.Empty(writer.Log);
        var other = FormModule();
        other.Add(N("DataFolder", "Data")).Add(N("Entity", "Customer"));
        var (foreign, _, _) = Apply(other, ["<var name=\"Note\" type=\"Other.Customer\"/>"], "Orders");
        Assert.DoesNotContain(foreign.Normalized, n => n["code"]?.ToString() == "HTML_TYPE_UNQUALIFIED");
        Assert.True(foreign.Refused);
    }

    [Fact]
    public void TheRowOfADropdownIsTheCentralRuleAComputedLabelIncludedAndOnlyWhereItIsProved()
    {
        // Correction 6 (RevProbe6): only a value starting with L.Current. was read per element, also on ODC.
        var module = FormModule();
        var (_, document) = Read(module, "Orders");
        var (_, toolbar) = ElementOf(document, "class=\"toolbar\"");
        var edit = toolbar.Replace("</div>", "<select bind=\"Search\" options=\"GetItems.List\" value=\"GetItems.List.Current.Id\" label=\"GetItems.List.Current.Name + &quot; (&quot; + GetItems.List.Current.Code + &quot;)&quot;\"/>\n</div>", StringComparison.Ordinal);
        var (result, after, _) = Apply(module, [edit], "Orders");
        Assert.DoesNotContain(result.Normalized, n => n["code"]?.ToString() == "HTML_DROPDOWN_ROW");
        if (KernelLane.Current == "odc") {
            Assert.DoesNotContain(result.Normalized, n => n["code"]?.ToString() == "DROPDOWN_ITEM_SCOPE");
            return;
        }
        Assert.False(result.Refused, Said(result));
        Assert.Equal(2, result.Normalized.Count(n => n["code"]?.ToString() == "DROPDOWN_ITEM_SCOPE"));
        var select = after.Split('\n').Single(l => l.Contains("<select", StringComparison.Ordinal));
        Assert.Contains("value=\"Id\"", select);
        Assert.DoesNotContain("GetItems.List.Current", select);
        Assert.Contains("Name + ", select);
    }
}
