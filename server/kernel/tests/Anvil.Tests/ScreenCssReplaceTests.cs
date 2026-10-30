using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R2-D (the owner's decision of 2026-10-28), without a Studio model: data.css IS the page's whole style sheet, as written, on an
/// edit and on a create; a sheet sent again whole is the sheet once; a property left out of it is gone; an html edit with only
/// css is valid; the patch of a media &lt;style&gt; keeps every rule of the sheet. Synthetic names.
/// </summary>
public sealed class ScreenCssReplaceTests
{
    private const string Reading = "<screen name=\"Page\">\n<style>.card { padding: 8px; margin: 0; }\n.title { font-weight: 600; }</style>\n<div k=\"w1\" class=\"card\"/>\n</screen>\n";

    // The CSS of the page's own <style> of an edit text, then through the one normalization (what the write keeps).
    private static string Written(string edit)
    {
        var top = ScreenHtml.Parse(edit).Children.First(n => !n.IsText);
        var style = top.Tag == "style" ? top : top.Children.First(n => !n.IsText && n.Tag == "style" && n.Get("scope") == null);
        return CssPipeline.Normalize(string.Concat(style.Children.Select(c => c.Text)), new CssPipeline.Context("test")).Css;
    }

    [Fact]
    public void TheReadingsSheetSentAgainInDataCssIsTheSheetOnceAndAPropertyLeftOutIsGone()
    {
        const string sheet = ".card { padding: 8px; margin: 0; }\n.title { font-weight: 600; }";
        // Element edits (the edit form's usual shape) with the reading's whole sheet in data.css: the sheet, never twice.
        var once = Written(ScreenHtmlEdit.WithCss(["<div k=\"w1\" class=\"card x\"/>"], sheet, Reading)[^1]);
        Assert.Equal(sheet, once);
        // Twice in a row: the same result (idempotent).
        Assert.Equal(once, Written(ScreenHtmlEdit.WithCss(["<div k=\"w1\" class=\"card x\"/>"], once, Reading.Replace(sheet, once))[^1]));
        // A property left out of the sheet sent (margin): no longer in the sheet.
        var without = Written(ScreenHtmlEdit.WithCss(["<div k=\"w1\"/>"], ".card { padding: 8px; }\n.title { font-weight: 600; }", Reading)[^1]);
        Assert.DoesNotContain("margin", without);
        // The whole document sent back with its <style> and the same sheet in data.css: once.
        Assert.Equal(sheet, Written(ScreenHtmlEdit.WithCss([Reading], sheet, Reading)[0]));
    }

    [Fact]
    public void OnACreateDataCssReplacesTheDocumentsStyleBlocks()
    {
        var top = ScreenHtml.Parse("<screen name=\"S\"><style>.a{color:red}</style><div><style>.b{}</style></div><style scope=\"theme\">.t{}</style></screen>").Children[0];
        var blocks = ScreenDocument.Styles(top);
        Assert.Equal(".a{color:red}\n.b{}", ScreenDocument.OwnSheet(blocks, null));
        Assert.Equal(".a{color:blue}", ScreenDocument.OwnSheet(blocks, ".a{color:blue}"));
        Assert.Equal(".t{}", ScreenDocument.ThemeSheet(blocks));
    }

    [Fact]
    public void AnEditWithOnlyCssIsValid()
    {
        JsonObject Data(Action<JsonObject> with)
        {
            var data = new JsonObject { ["screen"] = "Page", ["basedOn"] = new JsonObject { ["capture"] = new string('c', 64), ["html"] = new string('d', 64) }, ["css"] = ".a{color:red}" };
            with(data);
            return data;
        }
        // css alone, or with an empty edit list of either form: the sheet only.
        ScreenHtmlEdit.Preflight(Data(_ => { }));
        ScreenHtmlEdit.Preflight(Data(d => d["edits"] = new JsonArray()));
        ScreenHtmlEdit.Preflight(Data(d => d["edit"] = new JsonArray()));
        Assert.True(ScreenHtmlEdit.IsEdit(new JsonObject { ["op"] = "html", ["data"] = Data(_ => { }) }));
        // Nothing to write: still refused.
        var nothing = Assert.Throws<KernelRefusalException>(() => ScreenHtmlEdit.Preflight(Data(d => d.Remove("css"))));
        Assert.Equal(ScreenHtmlEdit.Invalid, nothing.Code);
        Assert.Throws<KernelRefusalException>(() => ScreenHtmlEdit.Preflight(Data(d => d["css"] = "")));
    }

    [Fact]
    public void TheMediaStylePatchKeepsEveryRuleOfTheSheet()
    {
        // Without data.css the document's <style> blocks are the sheet: the media one stays a <style> of the document, written
        // as its @media block (moved to a new data.css it would replace the other <style>).
        const string html = "<screen name=\"Css\">\n<style>.a{color:red}</style>\n<div class=\"a\">x</div>\n<style media=\"print\">.c{display:none}</style>\n</screen>";
        var refusal = Assert.Throws<KernelRefusalException>(() => ScreenDocument.Preflight(html, "/data/html", null));
        var problem = refusal.Problems!.Select(p => p!.AsObject()).Single(p => p["code"]!.ToString() == "HTML_STYLE_UNPLACED");
        var patch = problem["patch"]!.AsArray();
        Assert.DoesNotContain(patch, o => o!["path"]!.ToString() == "/data/css");
        var corrected = patch.Single(o => o!["path"]!.ToString() == "/data/html")!["value"]!.ToString();
        Assert.Contains("<style>.a{color:red}</style>", corrected);
        Assert.Contains("<style>@media print {\n.c{display:none}\n}</style>", corrected);
        Assert.DoesNotContain("media=", corrected);
        Assert.Equal(".a{color:red}\n@media print {\n.c{display:none}\n}",
            ScreenDocument.OwnSheet(ScreenDocument.Styles(ScreenHtml.Parse(corrected).Children.First(n => !n.IsText)), null));
        // With data.css (the whole sheet), the media CSS goes to its end, as before.
        var withCss = Assert.Throws<KernelRefusalException>(() => ScreenDocument.Preflight(html, "/data/html", ".a{color:red}"));
        var css = withCss.Problems!.Select(p => p!.AsObject()).First(p => p["code"]!.ToString() == "HTML_STYLE_UNPLACED")["patch"]!.AsArray()
            .Single(o => o!["path"]!.ToString() == "/data/css")!["value"]!.ToString();
        Assert.Equal(".a{color:red}\n@media print {\n.c{display:none}\n}", css);
    }
}
