using System.Text.Json.Nodes;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>CX16 W1: the engine of the element edits of a reading (HtmlElementEdits), pure, on the reading of docs/SSAM-HTML.md
/// ("A forma"): each form of the grammar with its result written by hand, the If with its else, a slot, the root, @ObjectKey,
/// R1 (every edit on the base; a find and an address on the same text clash), R2 (canonical text at its depth, the rest byte
/// for byte), R3 (the element keeps its k), R5 (no effect = the base), R4 (every problem in one call, with at, element or
/// candidates) and the strict read of the result. The owner's AdminStations reading is read from SSAM_CX16_DATA only.</summary>
public class HtmlElementEditsTests
{
    private static readonly string[] BaseLines =
    [
        "<screen name=\"Login\" actions=\"LoginOnClick, OnTogglePasswordVisibility\" roles=\"AppRole:FloodQuotes\" title='\"Log in\"' os-AnonymousAccess=\"True\">",
        "<var k=\"w1\" name=\"UserEmail\" type=\"Text\" description=\"Holds the user email of the login form.\"/>",
        "<Block k=\"w5\" name=\"Layout_Blank\">",
        " <slot name=\"Content\">",
        "  <form k=\"w7\" id=\"LoginForm\" class=\"login-form\">",
        "   <input k=\"w17\" id=\"Input_Username\" bind=\"UserEmail\" maxlength=\"250\" required=\"True\" class=\"form-control\"/>",
        "   <a k=\"w22\" onclick=\"OnTogglePasswordVisibility\">",
        "    <div k=\"w23\" id=\"PasswordVisibile\" if=\"MakePasswordVisible\">",
        "     <i k=\"w24\" icon=\"eye-slash\" class=\"icon\"/>",
        "    </div>",
        "    <div else>",
        "     <i k=\"w25\" icon=\"eye\" class=\"icon\"/>",
        "    </div>",
        "   </a>",
        "   <Block k=\"w31\" name=\"ButtonLoading\" :ExtendedClass='\"full-width\"' :IsLoading=\"IsExecuting\">",
        "    <slot name=\"Button\">",
        "     <button k=\"w32\" class=\"btn btn-primary\" os-IsDefault=\"True\" onclick=\"LoginOnClick\" os-onclick.BuiltInValidations=\"ValidateAndContinue\">Log in</button>",
        "    </slot>",
        "   </Block>",
        "  </form>",
        " </slot>",
        "</Block>",
        "</screen>",
    ];
    private static readonly string Base = string.Join("\n", BaseLines) + "\n";

    private static (string Document, List<JsonObject> Problems, List<string> Touched) Apply(params string[] edits) => Apply(null, edits);
    private static (string Document, List<JsonObject> Problems, List<string> Touched) Apply(IReadOnlyDictionary<string, string>? keys, params string[] edits)
        => HtmlElementEdits.Apply(Base, new JsonArray(edits.Select(e => JsonNode.Parse(e)).ToArray()), keys);

    // The base with lines replaced: (index of the first line, how many lines go, the lines in their place).
    private static string With(params (int At, int Remove, string[] Lines)[] changes)
    {
        var lines = BaseLines.ToList();
        foreach (var (at, remove, insert) in changes.OrderByDescending(c => c.At)) { lines.RemoveRange(at, remove); lines.InsertRange(at, insert); }
        return string.Join("\n", lines) + "\n";
    }

    private static void Accepted((string Document, List<JsonObject> Problems, List<string> Touched) r, string expected)
    {
        Assert.True(r.Problems.Count == 0, string.Join(" | ", r.Problems.Select(p => p.ToJsonString())));
        Assert.Equal(expected, r.Document);
        ScreenHtml.Parse(r.Document);
    }

    private static List<string> Codes((string Document, List<JsonObject> Problems, List<string> Touched) r) => r.Problems.Select(p => p["code"]!.ToString()).ToList();

    [Fact]
    public void TheReadingOfTheDocIsCanonical() => Assert.Equal(Base, ScreenHtmlText.Write(ScreenHtml.Parse(Base)));

    [Fact]
    public void SetChangesOnlyTheOpenTag()
    {
        // "id": null removes the name: written id="" in place (a text that only leaves the id out keeps the name, review of
        // fix/html-edit-names round 2, A2).
        var r = Apply("""{"set":"w7","attributes":{"class":"login-form card","data-test":"login","id":null}}""");
        Accepted(r, With((4, 1, ["  <form k=\"w7\" id=\"\" class=\"login-form card\" data-test=\"login\">"])));
        Assert.Equal(["w7"], r.Touched);
        // A value with a double quote is written as the reading writes it (single quotes).
        Accepted(Apply("""{"set":"/","attributes":{"title":"\"Sign in\""}}"""),
            With((0, 1, ["<screen name=\"Login\" actions=\"LoginOnClick, OnTogglePasswordVisibility\" roles=\"AppRole:FloodQuotes\" title='\"Sign in\"' os-AnonymousAccess=\"True\">"])));
        // A self-closed element keeps its />.
        Accepted(Apply("""{"set":"w24","attributes":{"class":null,"icon":"eye"}}"""), With((8, 1, ["     <i k=\"w24\" icon=\"eye\"/>"])));
    }

    [Fact]
    public void AnEditThatChangesNothingIsTheBase()
    {
        Accepted(Apply("""{"set":"w7","attributes":{"class":"login-form","missing":null}}"""), Base);
        Accepted(Apply("""{"set":"w31","attributes":{":ExtendedClass":"\"full-width\""}}"""), Base);
        // The element as read, with the indentation it had, replaced by itself.
        var w22 = string.Join("\n", BaseLines[6..14]);
        Accepted(Apply(new JsonObject { ["replace"] = "w22", ["with"] = w22 }.ToJsonString()), Base);
        // ... and written on one line: the same element, written back in the canonical form.
        Accepted(Apply(new JsonObject { ["replace"] = "w22", ["with"] = string.Concat(BaseLines[6..14].Select(l => l.Trim())) }.ToJsonString()), Base);
    }

    [Fact]
    public void ReplaceKeepsTheKeyAndWritesTheCanonicalForm()
    {
        var r = Apply("""{"replace":"w17","with":"<input id=\"Input_Username\" bind=\"UserEmail\" maxlength=\"120\" class=\"form-control\"/>"}""");
        Accepted(r, With((5, 1, ["   <input k=\"w17\" id=\"Input_Username\" bind=\"UserEmail\" maxlength=\"120\" class=\"form-control\"/>"])));
        // A child of the replaced element keeps its k under it; the If (and its else) are gone.
        Accepted(Apply("""{"replace":"w22","with":"<a onclick=\"OnTogglePasswordVisibility\"><i k=\"w24\" icon=\"eye-slash\" class=\"icon\"/></a>"}"""),
            With((6, 8, ["   <a k=\"w22\" onclick=\"OnTogglePasswordVisibility\">", "    <i k=\"w24\" icon=\"eye-slash\" class=\"icon\"/>", "   </a>"])));
    }

    [Fact]
    public void AnIfIsReplacedAndDeletedWithItsElse()
    {
        Accepted(Apply("""{"replace":"w23","with":"<div if=\"ShowPassword\"><i k=\"w24\" icon=\"eye\"/></div><div else><span>hidden</span></div>"}"""),
            With((7, 6, ["    <div k=\"w23\" if=\"ShowPassword\">", "     <i k=\"w24\" icon=\"eye\"/>", "    </div>", "    <div else>", "     <span>hidden</span>", "    </div>"])));
        Accepted(Apply("""{"delete":"w23"}"""), With((7, 6, [])));
        Accepted(Apply("""{"delete":"w23.false"}"""), With((10, 3, [])));
        Accepted(Apply("""{"delete":"w17"}"""), With((5, 1, [])));
    }

    [Fact]
    public void AfterAndBeforeInsertSiblingsAtTheirDepth()
    {
        Accepted(Apply("""{"after":"w17","insert":"<label class=\"hint\">Email</label><p>We never share it</p>"}"""),
            With((6, 0, ["   <label class=\"hint\">Email</label>", "   <p>We never share it</p>"])));
        // After an If: after its else. Before: on the line of the element. The order of the edits at one place is kept.
        Accepted(Apply("""{"after":"w23","insert":"<hr/>"}""", """{"before":"w17","insert":"<h2>Log in</h2>"}""", """{"before":"w17","insert":"<p>Welcome</p>"}"""),
            With((13, 0, ["    <hr/>"]), (5, 0, ["   <h2>Log in</h2>", "   <p>Welcome</p>"])));
        // A new element of a root child sits in column 0.
        Accepted(Apply("""{"after":"w1","insert":"<var name=\"Remember\" type=\"Boolean\"/>"}"""), With((2, 0, ["<var name=\"Remember\" type=\"Boolean\"/>"])));
    }

    [Fact]
    public void IntoASlotABranchTheRootAndASelfClosedOrOneLineElement()
    {
        Accepted(Apply("""{"into":"w7","insert":"<p>first</p>","at":"first"}"""), With((5, 0, ["   <p>first</p>"])));
        Accepted(Apply("""{"into":"w5/Content","insert":"<div class=\"footer\"/>"}"""), With((20, 0, ["  <div class=\"footer\"/>"])));
        Accepted(Apply("""{"into":"w23.false","insert":"<span>x</span>"}"""), With((12, 0, ["     <span>x</span>"])));
        Accepted(Apply("""{"into":"w23.true","insert":"<span>y</span>","at":"first"}"""), With((8, 0, ["     <span>y</span>"])));
        Accepted(Apply("""{"into":"/","insert":"<var name=\"Extra\" type=\"Text\"/>","at":"first"}"""), With((1, 0, ["<var name=\"Extra\" type=\"Text\"/>"])));
        Accepted(Apply("""{"into":"w24","insert":"<span>a</span>"}"""),
            With((8, 1, ["     <i k=\"w24\" icon=\"eye-slash\" class=\"icon\">", "      <span>a</span>", "     </i>"])));
        Accepted(Apply("""{"into":"w32","insert":"<i icon=\"check\"/>","at":"first"}"""),
            With((16, 1, ["     <button k=\"w32\" class=\"btn btn-primary\" os-IsDefault=\"True\" onclick=\"LoginOnClick\" os-onclick.BuiltInValidations=\"ValidateAndContinue\">",
                "      <i icon=\"check\"/>", "      Log in", "     </button>"])));
        // set and into of one element do not clash: the open tag and the children.
        Accepted(Apply("""{"set":"w7","attributes":{"class":"login-form card"}}""", """{"into":"w7","insert":"<p>last</p>"}"""),
            With((19, 0, ["   <p>last</p>"]), (4, 1, ["  <form k=\"w7\" id=\"LoginForm\" class=\"login-form card\">"])));
    }

    [Fact]
    public void AnElseAndASlotTheReadingDoesNotWriteAreCreated()
    {
        var noElse = string.Join("\n", BaseLines[..10].Concat(BaseLines[13..])) + "\n";
        var r = HtmlElementEdits.Apply(noElse, new JsonArray(JsonNode.Parse("""{"into":"w23.false","insert":"<span>off</span>"}""")), null);
        Assert.Empty(r.Problems);
        Assert.Contains("    </div>\n    <div else>\n     <span>off</span>\n    </div>\n   </a>", r.Document);
        var emptyBlock = Base.Replace("   <Block k=\"w31\"", "   <Block k=\"w40\" name=\"Card\"/>\n   <Block k=\"w31\"");
        var s = HtmlElementEdits.Apply(emptyBlock, new JsonArray(JsonNode.Parse("""{"into":"w40/Content","insert":"<p>body</p>"}""")), null);
        Assert.Empty(s.Problems);
        Assert.Contains("   <Block k=\"w40\" name=\"Card\">\n    <slot name=\"Content\">\n     <p>body</p>\n    </slot>\n   </Block>\n", s.Document);
    }

    [Fact]
    public void MoveKeepsTheKeyAndTheText()
    {
        Accepted(Apply("""{"move":"w17","after":"w22"}"""), With((14, 0, [BaseLines[5]]), (5, 1, [])));
        Accepted(Apply("""{"move":"w24","into":"w7"}"""), With((19, 0, ["   <i k=\"w24\" icon=\"eye-slash\" class=\"icon\"/>"]), (8, 1, [])));
        var inside = Apply("""{"move":"w22","into":"w23"}""");
        Assert.Equal([ScreenHtmlEdit.Invalid], Codes(inside));
        Assert.Equal(Base, inside.Document);
    }

    // CX16 r2 M2: a k is the identity of its element. A find whose with drops, changes or adds a k of the text it replaces is
    // refused (HTML_EDIT_INVALID, the fix: keep the k, or set/replace/move); with the same k the element is kept. CX16 r3 M5: the
    // k of two elements permuted with their content in place is no permutation of elements (each k would name the other's
    // text, and the plan would move their children into each other with new ObjectKeys): refused, the k named.
    [Fact]
    public void AFindKeepsTheKOfTheTextItReplaces()
    {
        var dropped = Apply("""{"find":"<a k=\"w22\" onclick=\"OnTogglePasswordVisibility\"","with":"<a onclick=\"OnTogglePasswordVisibility\" class=\"toggle\""}""");
        var problem = Assert.Single(dropped.Problems);
        Assert.Equal(ScreenHtmlEdit.Invalid, problem["code"]!.ToString());
        Assert.Equal("/edits/0", problem["pointer"]!.ToString());
        Assert.Contains("keep k=\"w22\"", problem["fix"]!.ToString());
        Assert.Equal(Base, dropped.Document);
        Assert.Equal([ScreenHtmlEdit.Invalid], Codes(Apply("""{"find":"<a k=\"w22\"","with":"<a k=\"w99\""}""")));
        // A find that starts at the k itself drops it as well; an attribute that only ends in k (data-k) is no k.
        Assert.Equal([ScreenHtmlEdit.Invalid], Codes(Apply("""{"find":"k=\"w24\" ","with":""}""")));
        Accepted(Apply("""{"find":" id=\"LoginForm\"","with":" id=\"LoginForm\" data-k=\"x\""}"""),
            With((4, 1, [BaseLines[4].Replace(" id=\"LoginForm\"", " id=\"LoginForm\" data-k=\"x\"")])));
        Assert.Equal([ScreenHtmlEdit.Invalid], Codes(Apply("""{"find":">Log in</button>","with":">Log in</button><p k=\"w40\">x</p>"}""")));
        Accepted(Apply("""{"find":"<a k=\"w22\" onclick=\"OnTogglePasswordVisibility\"","with":"<a k=\"w22\" onclick=\"OnTogglePasswordVisibility\" class=\"toggle\""}"""),
            With((6, 1, ["   <a k=\"w22\" onclick=\"OnTogglePasswordVisibility\" class=\"toggle\">"])));
        // w24 <-> w25 between the branches of the If, the content in place: w24 would carry the text of w25 in the else, and
        // w25 the text of w24 in the true branch. Refused before any plan: one problem, the edit named, the k that changes place
        // and text named, the fix (move + set), the base unchanged and nothing touched.
        var find = string.Join("\n", BaseLines[8..12]);
        var with = find.Replace("k=\"w24\"", "k=\"#\"").Replace("k=\"w25\"", "k=\"w24\"").Replace("k=\"#\"", "k=\"w25\"");
        var swapped = HtmlElementEdits.Apply(Base, new JsonArray(JsonNode.Parse(new JsonObject { ["find"] = find, ["with"] = with }.ToJsonString())), null, out var editOf);
        var refusal = Assert.Single(swapped.Problems);
        Assert.Equal((ScreenHtmlEdit.Invalid, "/edits/0"), (refusal["code"]!.ToString(), refusal["pointer"]!.ToString()));
        var named = Assert.Single(refusal["keys"]!.AsArray())!.ToString();
        Assert.Contains(named, new[] { "w24", "w25" });
        Assert.Contains("k=\"" + named + "\"", refusal["element"]!.ToString());
        Assert.Contains("move", refusal["fix"]!.ToString());
        Assert.Contains("set", refusal["fix"]!.ToString());
        Assert.Equal(Base, swapped.Document);
        Assert.Empty(editOf);
    }

    // CX16 r3 M5, the family: identity by k in every edit that writes k of the reading (find/with, replace/with). A reorder that
    // moves whole elements, each with its own text, is a pure relocation (accepted); an element whose k changes place among the
    // others AND whose text changes is refused (HTML_EDIT_INVALID, move + set); move and set of one element go in one list.
    [Fact]
    public void AReorderMovesEachElementWithItsOwnText()
    {
        // w17 after w22 (the a and its If), each with its own text: accepted, the lines reordered as they are.
        var find = string.Join("\n", BaseLines[5..14]);
        Accepted(Apply(new JsonObject { ["find"] = find, ["with"] = string.Join("\n", BaseLines[6..14].Append(BaseLines[5])) }.ToJsonString()),
            With((5, 9, [.. BaseLines[6..14], BaseLines[5]])));
        // The same reorder with w17 changed: w17 changes place and text at once (w22 and its children stay in their order).
        var changed = Apply(new JsonObject { ["find"] = find, ["with"] = string.Join("\n", BaseLines[6..14].Append(BaseLines[5].Replace("maxlength=\"250\"", "maxlength=\"120\""))) }.ToJsonString());
        var problem = Assert.Single(changed.Problems);
        Assert.Equal(ScreenHtmlEdit.Invalid, problem["code"]!.ToString());
        Assert.Equal(["w17"], problem["keys"]!.AsArray().Select(k => k!.ToString()));
        // The same family in a replace: the children of the If swapped with their content in place.
        var replaced = Apply("""{"replace":"w23","with":"<div if=\"MakePasswordVisible\"><i k=\"w25\" icon=\"eye-slash\" class=\"icon\"/></div><div else><i k=\"w24\" icon=\"eye\" class=\"icon\"/></div>"}""");
        Assert.Equal([ScreenHtmlEdit.Invalid], Codes(replaced));
        Assert.Equal(Base, replaced.Document);
        // ... and the whole document by replace /: w17 and w22 reordered with their own text is accepted.
        var reordered = With((5, 9, [.. BaseLines[6..14], BaseLines[5]]));
        Accepted(Apply(new JsonObject { ["replace"] = "/", ["with"] = reordered }.ToJsonString()), reordered);
        // The fix the refusal gives: move it and set it, in one list.
        Accepted(Apply("""{"move":"w24","into":"w7"}""", """{"set":"w24","attributes":{"icon":"eye","class":null}}"""),
            With((19, 0, ["   <i k=\"w24\" icon=\"eye\"/>"]), (8, 1, [])));
        Accepted(Apply("""{"set":"w17","attributes":{"maxlength":"120"}}""", """{"move":"w17","after":"w22"}"""),
            With((14, 0, [BaseLines[5].Replace("maxlength=\"250\"", "maxlength=\"120\"")]), (5, 1, [])));
        // A set beside the move of its element still clashes with a replace of it (one change per element).
        Assert.Equal([ScreenHtmlEdit.Overlap, ScreenHtmlEdit.Overlap, ScreenHtmlEdit.Overlap, ScreenHtmlEdit.Overlap],
            Codes(Apply("""{"move":"w24","into":"w7"}""", """{"set":"w24","attributes":{"icon":"eye"}}""", """{"replace":"w24","with":"<i icon=\"x\"/>"}""")).Order());
    }

    [Fact]
    public void FindReplacesTheOnlyOccurrence()
    {
        Accepted(Apply("""{"find":">Log in</button>","with":">Sign in</button>"}"""), With((16, 1, [BaseLines[16].Replace(">Log in<", ">Sign in<")])));
        Accepted(Apply("""{"find":" required=\"True\"","with":""}"""), With((5, 1, [BaseLines[5].Replace(" required=\"True\"", "")])));
        var twice = Apply("""{"find":"class=\"icon\"","with":"class=\"ico\""}""");
        var problem = Assert.Single(twice.Problems);
        Assert.Equal(HtmlElementEdits.TextNotUnique, problem["code"]!.ToString());
        Assert.Equal("/edits/0", problem["pointer"]!.ToString());
        Assert.Equal([9, 12], problem["lines"]!.AsArray().Select(l => l!["line"]!.GetValue<int>()));
        var none = Apply("""{"find":"class=\"nothing\"","with":""}""");
        Assert.Equal([HtmlElementEdits.TextNotUnique], Codes(none));
        Assert.Empty(none.Problems[0]["lines"]!.AsArray());
    }

    [Fact]
    public void EveryEditAddressesTheBaseAndATextTwiceChangedIsAnOverlap()
    {
        // R1: a find inside the open tag a set changes, a set inside a replaced element, an insert inside a deleted one.
        var r = Apply("""{"find":"class=\"login-form\"","with":"class=\"x\""}""", """{"set":"w7","attributes":{"id":"F"}}""");
        Assert.Equal([ScreenHtmlEdit.Overlap, ScreenHtmlEdit.Overlap], Codes(r));
        Assert.Equal(["/edits/0", "/edits/1"], r.Problems.Select(p => p["pointer"]!.ToString()));
        Assert.Equal([ScreenHtmlEdit.Overlap, ScreenHtmlEdit.Overlap], Codes(Apply("""{"replace":"w22","with":"<a/>"}""", """{"set":"w24","attributes":{"icon":"x"}}""")));
        Assert.Equal([ScreenHtmlEdit.Overlap, ScreenHtmlEdit.Overlap], Codes(Apply("""{"delete":"w23"}""", """{"after":"w24","insert":"<p/>"}""")));
        Assert.Equal([ScreenHtmlEdit.Overlap, ScreenHtmlEdit.Overlap], Codes(Apply("""{"set":"w7","attributes":{"id":"A"}}""", """{"set":"w7","attributes":{"class":"B"}}""")));
        Assert.Equal([ScreenHtmlEdit.Overlap, ScreenHtmlEdit.Overlap], Codes(Apply("""{"delete":"w17"}""", """{"after":"w17","insert":"<p/>"}""")));
        // A find elsewhere on the same line as a set, outside its open tag, is fine: two edits of the base.
        Accepted(Apply("""{"find":">Log in</button>","with":">Go</button>"}""", """{"set":"w32","attributes":{"class":"btn"}}"""),
            With((16, 1, ["     <button k=\"w32\" class=\"btn\" os-IsDefault=\"True\" onclick=\"LoginOnClick\" os-onclick.BuiltInValidations=\"ValidateAndContinue\">Go</button>"])));
    }

    [Fact]
    public void EveryProblemComesInOneAnswer()
    {
        var r = Apply(new Dictionary<string, string> { ["w7"] = "OBJ7" },
            """{"set":"w99","attributes":{"class":"a"}}""",
            """{"delete":"w5/Footer"}""",
            """{"into":"w17.true","insert":"<p/>"}""",
            """{"find":"class=\"icon\"","with":""}""",
            """{"replace":"w17","with":"<input k=\"w22\"/>"}""",
            """{"after":"w1","insert":"<p k=\"w25\">x</p>"}""",
            """{"delete":"w1","after":"w5"}""",
            """{"set":"w7","attributes":{"k":"w8"}}""",
            """{"set":"@NOPE","attributes":{"class":"a"}}""",
            """{"set":"@OBJ7","attributes":{"class":"ok"}}""");
        Assert.Equal(Base, r.Document);
        var byEdit = r.Problems.GroupBy(p => p["pointer"]!.ToString()).ToDictionary(g => g.Key, g => g.Select(p => p["code"]!.ToString()).ToList());
        Assert.Equal([HtmlElementEdits.TargetUnknown], byEdit["/edits/0"]);
        Assert.Equal(["w32", "w31", "w25"], r.Problems[0]["candidates"]!.AsArray().Select(c => c!.ToString()));
        Assert.Equal([HtmlElementEdits.TargetUnknown], byEdit["/edits/1"]);
        Assert.Equal(["w5/Content"], r.Problems.First(p => p["pointer"]!.ToString() == "/edits/1")["candidates"]!.AsArray().Select(c => c!.ToString()));
        Assert.Equal([HtmlElementEdits.TargetUnknown], byEdit["/edits/2"]);
        Assert.NotNull(r.Problems.First(p => p["pointer"]!.ToString() == "/edits/2")["element"]);
        Assert.Equal([HtmlElementEdits.TextNotUnique], byEdit["/edits/3"]);
        Assert.Equal([ScreenHtmlEdit.KeyTwice], byEdit["/edits/4"]);
        Assert.Equal([ScreenHtmlEdit.KeyTwice], byEdit["/edits/5"]);
        Assert.Equal([ScreenHtmlEdit.Invalid], byEdit["/edits/6"]);
        Assert.Equal([ScreenHtmlEdit.Invalid], byEdit["/edits/7"]);
        Assert.Equal([HtmlElementEdits.TargetUnknown], byEdit["/edits/8"]);
        Assert.False(byEdit.ContainsKey("/edits/9"));
        // In the order of the edits, each with a fix.
        Assert.Equal(r.Problems.Select(p => p["pointer"]!.ToString()).ToList(), r.Problems.Select(p => p["pointer"]!.ToString()).OrderBy(p => int.Parse(p["/edits/".Length..])).ToList());
        Assert.All(r.Problems, p => Assert.False(string.IsNullOrWhiteSpace(p["fix"]?.ToString())));
    }

    [Fact]
    public void TheShapeIsJudgedWithoutTheBase()
    {
        static List<string> Shape(string json) => HtmlElementEdits.Shape(JsonNode.Parse(json)).Select(p => p["pointer"] + " " + p["code"]).ToList();
        Assert.Equal(["/edits " + ScreenHtmlEdit.Invalid], Shape("[]"));
        Assert.Equal(["/edits " + ScreenHtmlEdit.Invalid], Shape("{\"set\":\"w1\"}"));
        var many = Shape("""[{"set":"w1"},{"replace":"w2"},{"find":"x"},{"move":"w3"},{"after":"w4","insert":"<p/>","at":"first"},{"delete":"w5","with":""},{"into":"w6","insert":"<p/>","at":"middle"},{"set":"w7","attributes":{"class":1}},{"replace":"w8","with":"<p/>","color":"red"},"w9",{"delete":"w10"}]""");
        Assert.Equal(Enumerable.Range(0, 10).Select(j => "/edits/" + j + " " + ScreenHtmlEdit.Invalid), many.Distinct());
        Assert.Empty(HtmlElementEdits.Shape(JsonNode.Parse("""[{"find":"a","with":""},{"set":"/","attributes":{"x":null}},{"move":"w1","into":"w2/Content","at":"first"},{"into":"w2.true","insert":"<p/>"}]""")));
    }

    [Fact]
    public void TheResultReadsWithTheStrictParser()
    {
        var broken = Apply("""{"replace":"w17","with":"<div class=\"a\">"}""", """{"find":"<h1>","with":""}""");
        Assert.Contains(ScreenHtmlEdit.Invalid, Codes(broken));
        var unclosed = Apply("""{"find":"</button>","with":""}""");
        var problem = Assert.Single(unclosed.Problems);
        Assert.Equal((ScreenHtmlEdit.Invalid, "/edits/0"), (problem["code"]!.ToString(), problem["pointer"]!.ToString()));
        Assert.Equal(Base, unclosed.Document);
    }

    // The owner's AdminStations reading (C:\t\codex\cx16\dados, never versioned): a set of the admin bar and a link into it
    // change those lines only, and the result reads.
    [Fact]
    public void TheAdminStationsReadingTakesASetAndAnInto()
    {
        var data = Environment.GetEnvironmentVariable("SSAM_CX16_DATA");
        var folder = data == null ? null : Path.Combine(data, "demolatam", "readings");
        var file = folder != null && Directory.Exists(folder) ? Directory.GetFiles(folder, "*.html-a00c964b*.json").FirstOrDefault() : null;
        if (file == null) return;   // the data of the measurement is not here
        var reading = JsonNode.Parse(File.ReadAllText(file))!.AsObject();
        var html = reading["html"]!.ToString();
        var keys = reading["keys"]!.AsObject().ToDictionary(p => p.Key, p => p.Value!.ToString());
        var r = HtmlElementEdits.Apply(html, new JsonArray(
            JsonNode.Parse("""{"set":"w17","attributes":{"class":"toolbar admin-bar"}}"""),
            JsonNode.Parse("""{"into":"w17","insert":"<a class=\"btn-ghost\" onclick=\"GoAdminStations\">Painel</a>"}""")), keys);
        Assert.Empty(r.Problems);
        ScreenHtml.Parse(r.Document);
        var before = html.Split('\n'); var after = r.Document.Split('\n');
        Assert.Equal(before.Length + 1, after.Length);
        Assert.Equal(2, after.Except(before).Count());
        Assert.Contains("    <div k=\"w17\" class=\"toolbar admin-bar\">", after);
        Assert.Contains("     <a class=\"btn-ghost\" onclick=\"GoAdminStations\">Painel</a>", after);
        var objectKey = keys["w17"];
        Assert.Equal(r.Document, HtmlElementEdits.Apply(html, new JsonArray(
            JsonNode.Parse("{\"set\":\"@" + objectKey + "\",\"attributes\":{\"class\":\"toolbar admin-bar\"}}"),
            JsonNode.Parse("""{"into":"w17","insert":"<a class=\"btn-ghost\" onclick=\"GoAdminStations\">Painel</a>"}""")), keys).Document);
    }
}
