using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>T1 "a text value never carries binding syntax or raw markup", the fragment form (the html op with a parent) and the one
/// compile of a text with bindings (BindingText). No Studio: the ops are the proof. The job forms (document, edits) and the
/// post-apply invariant LITERAL_BINDING_REMNANT are in TextBindingJobTests.</summary>
public sealed class TextBindingTests
{
    // ---- positive: every text position of the fragment ----------------------------------------------------------------

    [Fact]
    public void ALabelWithAConstantBindingIsItsLiteralText()
    {
        var ops = Ops("<div><label for=\"Pin\">{{ \"Search\" }}</label><input id=\"Pin\" bind=\"PinNumber\"></div>");
        Assert.Contains(ops, o => o["target"]?.ToString()?.EndsWith("/#ITextWidget", StringComparison.Ordinal) == true && Sets(o, "Text", "Search"));
        NoRemnant(ops);
    }

    [Fact]
    public void ALabelWithANamedBindingIsALabelWithAnExpression()
    {
        var ops = Ops("<div><label for=\"Pin\">Note: {{ Note }}</label><input id=\"Pin\" bind=\"PinNumber\"></div>");
        var label = ops.First(o => Is(o, "ILabel"))["as"]!.ToString();
        Assert.Contains(ops, o => o["op"]?.ToString() == "delete" && o["target"]?.ToString() == label + "/#ITextWidget");
        Assert.Contains(ops, o => Is(o, "ITextWidget") && o["parent"]?.ToString() == label);
        Assert.Contains(ops, o => Sets(o, "Text", "Note: "));
        Assert.Contains(ops, o => Is(o, "IExpression") && o["parent"]?.ToString() == label);
        Assert.Contains(ops, o => Sets(o, "Value", "Note"));
        // The label still targets its input.
        var input = ops.First(o => Is(o, "IInput"))["as"]!.ToString();
        Assert.Contains(ops, o => Sets(o, "TargetWidget", input));
        NoRemnant(ops);
    }

    [Theory]
    [InlineData("{{ \"Search by name\" }}", "\"Search by name\"")]
    [InlineData("{{ &quot;Search by name&quot; }}", "\"Search by name\"")]
    [InlineData("Find {{ Note }}", "\"Find \" + Note")]
    [InlineData("{{ Note }}", "Note")]
    [InlineData("e.g. 1234", "\"e.g. 1234\"")]
    public void APlaceholderIsThePromptExpression(string placeholder, string prompt)
    {
        var quote = placeholder.Contains('"') ? '\'' : '"';
        var ops = Ops($"<input id=\"Pin\" bind=\"PinNumber\" placeholder={quote}{placeholder}{quote}>");
        Assert.Contains(ops, o => Sets(o, "Prompt", prompt));
        NoRemnant(ops);
    }

    [Fact]
    public void ATitleAndTheAriaLabelItGivesAnIconOnlyButtonAreExpressions()
    {
        var ops = Ops("<div><span title=\"{{ Note }}\">x</span><button onclick=\"RetrySearch\" title=\"{{ &quot;Retry&quot; }}\"><i icon=\"refresh\"></i></button></div>");
        Assert.Contains(ops, o => Sets(o, "Property", "title"));
        Assert.Contains(ops, o => Sets(o, "Value", "Note"));
        Assert.Contains(ops, o => Sets(o, "Property", "aria-label"));
        Assert.Contains(ops, o => Sets(o, "Value", "\"Retry\""));
        NoRemnant(ops);
    }

    [Fact]
    public void ACounterSpanIsAnExpressionAndABindingClosesOutsideItsStrings()
    {
        var ops = Ops("<div><span>{{ If(Quantity = 0, \"none\", \"some\") }}</span><span>{{ \"a }} b\" + Note }}</span></div>");
        Assert.Contains(ops, o => Sets(o, "Value", "If(Quantity = 0, \"none\", \"some\")"));
        Assert.Contains(ops, o => Sets(o, "Value", "\"a }} b\" + Note"));
        NoRemnant(ops);
    }

    [Fact]
    public void AButtonCaptionWithAConstantBindingIsItsLiteralCaption()
    {
        var ops = Ops("<button onclick=\"RetrySearch\">{{ \"Save\" }}</button>");
        Assert.Contains(ops, o => o["target"]?.ToString()?.EndsWith("/#ITextWidget", StringComparison.Ordinal) == true && Sets(o, "Text", "Save"));
        NoRemnant(ops);
    }

    // ---- the cases a parallel migration review found in the same family (neutral words) -----------------------------------

    [Fact]
    public void ATextAreaPlaceholderIsItsPromptNeverDropped()
    {
        var ops = Ops("<textarea id=\"T\" bind=\"Note\" placeholder=\"{{ &quot;Why do you need more time?&quot; }}\"></textarea>");
        Assert.Contains(ops, o => Sets(o, "Prompt", "\"Why do you need more time?\""));
        Assert.Contains(Ops("<textarea id=\"T\" bind=\"Note\" placeholder=\"Optional\"></textarea>"), o => Sets(o, "Prompt", "\"Optional\""));
    }

    [Fact]
    public void AdjacentBindingsInAnAttributeAreJoinedNeverAdded()
        // "{{ 1 }}{{ 2 }} items" shows "12 items": the empty text first makes every + a join (1 + 2 would show 3).
        => Assert.Contains(Ops("<input id=\"Pin\" bind=\"PinNumber\" placeholder=\"{{ 1 }}{{ 2 }} items\">"), o => Sets(o, "Prompt", "\"\" + 1 + 2 + \" items\""));

    [Fact]
    public void AButtonGroupItemCaptionKeepsTheBracesInsideItsStrings()
    {
        var ops = Ops("<ButtonGroup bind=\"ChoiceId\"><ButtonGroupItem value=\"1\">{{ If(Quantity = 0, \"}}\", Note) }}</ButtonGroupItem></ButtonGroup>");
        Assert.Contains(ops, o => Sets(o, "Value", "If(Quantity = 0, \"}}\", Note)"));
        NoRemnant(ops);
    }

    [Theory]
    [InlineData("<fieldset><legend>{{ Note }}</legend></fieldset>", "Note")]
    [InlineData("<button onclick=\"RetrySearch\">{{ Note }}</button>", "Note")]
    [InlineData("<a onclick=\"RetrySearch\">Open {{ Note }}</a>", "Note")]
    public void ACaptionOrALegendWithABindingIsAnExpression(string html, string value)
    {
        var ops = Ops("<div>" + html + "</div>");
        Assert.Contains(ops, o => Is(o, "IExpression"));
        Assert.Contains(ops, o => Sets(o, "Value", value));
        NoRemnant(ops);
    }

    [Fact]
    public void ALegendWithAConstantBindingIsItsText()
    {
        var ops = Ops("<fieldset><legend>{{ \"Contact\" }}</legend></fieldset>");
        Assert.Contains(ops, o => Sets(o, "Text", "Contact"));
        NoRemnant(ops);
    }

    // ---- negative: what never compiles ---------------------------------------------------------------------------------

    [Theory]
    [InlineData("<label for=\"Pin\">{{ Note</label><input id=\"Pin\" bind=\"PinNumber\">")]
    [InlineData("<span>a }} b</span>")]
    [InlineData("<input id=\"Pin\" bind=\"PinNumber\" placeholder=\"{{ }}\">")]
    [InlineData("<div>{{ Note</div>")]
    [InlineData("<label>{{ }}</label>")]
    [InlineData("<input id=\"Pin\" bind=\"PinNumber\" placeholder=\"{{ Note\">")]
    [InlineData("<ButtonGroup bind=\"ChoiceId\"><ButtonGroupItem value=\"1\">{{ Note</ButtonGroupItem></ButtonGroup>")]
    public void AMalformedBindingIsRefusedNamed(string html)
    {
        var error = Assert.ThrowsAny<Exception>(() => Ops("<div>" + html + "</div>"));
        var coded = Errors.FindCoded(error);
        Assert.NotNull(coded);
        Assert.Contains(coded!.Problems!.OfType<JsonObject>(), p => p["code"]?.ToString() == "HTML_BINDING_INVALID" && p["fix"] != null);
    }

    // ---- the one compile ------------------------------------------------------------------------------------------------

    [Theory]
    [InlineData("{{ \"Search\" }}", true)]
    [InlineData("{{ &quot;Search&quot; }}", true)]
    [InlineData("&#123;&#123; x &#125;&#125;", true)]
    [InlineData("a {{ b", false)]
    [InlineData("{{", false)]
    [InlineData("Search", false)]
    [InlineData("{ a } }", false)]
    public void ALiteralHoldsTheBracePairOfABindingAfterEntityDecoding(string literal, bool pair)
        => Assert.Equal(pair, BindingText.HoldsPair(literal));

    [Theory]
    [InlineData("\"{{ \"\"Applied\"\" }}\"", "\"Applied\"")]
    [InlineData("If(A, \"{{ X }}\", \"\")", "X")]
    public void AStringLiteralOfAnExpressionThatHoldsABindingIsARemnantWithItsFix(string expression, string fix)
    {
        var found = BindingText.Remnants(expression).ToList();
        Assert.Single(found);
        Assert.Equal(fix, BindingText.FixOf(found[0]));
    }

    [Theory]
    [InlineData("\"{\" + \"{ x }\" + \"}\"")]
    [InlineData("\"Total: \" + N")]
    [InlineData("\"a }} b\"")]
    public void AnExpressionWhoseLiteralsHoldNoPairIsNoRemnant(string expression) => Assert.Empty(BindingText.Remnants(expression));

    [Theory]
    [InlineData("\"<span class=\"\"icon fa fa-lock\"\" aria-hidden=\"\"true\"\"></span>\"", true)]
    [InlineData("\"&lt;b&gt;x&lt;/b&gt;\"", true)]
    [InlineData("\"a < b\"", false)]
    [InlineData("\"<b>\" + Name", false)]
    [InlineData("Name", false)]
    public void AConstantExpressionWithMarkupIsShownAsText(string expression, bool markup) => Assert.Equal(markup, BindingText.Markup(expression) != null);

    // ---- generated sweep: every text-bearing slot of every tag of the closed syntax, every binding shape ------------------

    public static IEnumerable<object[]> Slots()
    {
        var shapes = new[] { "{{ \"Lit\" }}", "{{ Note }}", "Lit {{ Note }} lit", "{{ &quot;Lit&quot; }}", "{{ \"a\" }}{{ Note }}" };
        // Every tag of the closed syntax that takes text (HtmlVisual.Schema) and every element tag of the platform's HTML Element.
        var textTags = new[] { "div", "label", "button", "a", "span", "p", "h1", "li", "td", "strong", "small" };
        foreach (var shape in shapes) {
            foreach (var tag in textTags) yield return [$"<{tag}{(tag is "button" or "a" ? " onclick=\"RetrySearch\"" : "")}>{shape}</{tag}>"];
            foreach (var attribute in new[] { "title", "aria-label", "data-x", "role" })
                foreach (var tag in new[] { "div", "span", "label", "button", "a", "img" })
                    yield return [$"<{tag}{(tag is "button" or "a" ? " onclick=\"RetrySearch\"" : "")}{(tag == "img" ? " src=\"Logo\"" : "")} {attribute}=\"{shape.Replace("\"", "&quot;")}\">{(tag == "img" ? "" : "x")}</{(tag == "img" ? "img" : tag)}>"];
            yield return [$"<input id=\"Pin\" bind=\"PinNumber\" placeholder=\"{shape.Replace("\"", "&quot;")}\">"];
            yield return [$"<textarea id=\"T\" bind=\"Note\" placeholder=\"{shape.Replace("\"", "&quot;")}\"></textarea>"];
            yield return [$"<button onclick=\"RetrySearch\" title=\"{shape.Replace("\"", "&quot;")}\"><i icon=\"refresh\"></i></button>"];
            yield return [$"<ButtonGroup bind=\"ChoiceId\"><ButtonGroupItem value=\"1\">{shape}</ButtonGroupItem></ButtonGroup>"];
        }
    }

    [Theory]
    [MemberData(nameof(Slots))]
    public void NoSlotOfTheFragmentKeepsTheBracesOfABinding(string html) => NoRemnant(Ops("<div>" + html + "</div>"));

    // ---- helpers ----------------------------------------------------------------------------------------------------------

    /// <summary>No literal-typed value an op writes holds the brace pair of a binding, and no string literal of an expression an op
    /// writes holds one (the invariant LITERAL_BINDING_REMNANT on the ops of the fragment).</summary>
    private static void NoRemnant(IEnumerable<JsonObject> ops)
    {
        foreach (var op in ops.Where(o => o["op"]?.ToString() == "set" && o["value"] is JsonValue)) {
            var value = op["value"]!.ToString();
            var prop = op["prop"]!.ToString();
            if (prop is "Text") Assert.False(BindingText.HoldsPair(value), "literal " + prop + " keeps a binding: " + op.ToJsonString());
            else Assert.Empty(BindingText.Remnants(value));
        }
    }

    private static HtmlVisualScope Scope() => new(
        ["PinNumber", "Note", "Quantity", "ChoiceId"],
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["RetrySearch"] = "@retry" },
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase),
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Logo"] = "IImage:Logo" },
        _ => null,
        InputTypes: new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Quantity"] = "Number" });

    private static List<JsonObject> Ops(string html) => HtmlVisual.Expand(html, "$screen", Scope()).Ops;
    private static bool Is(JsonObject o, string type) => o["op"]?.ToString() == "create" && o["type"]?.ToString() == type;
    private static bool Sets(JsonObject o, string prop, string value) => o["op"]?.ToString() == "set" && o["prop"]?.ToString() == prop && o["value"]?.ToString() == value;
}
