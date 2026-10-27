using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>Behavior lost by a Traditional-to-Reactive portal migration must be preserved by the fragment compiler.</summary>
public sealed class MigrationFragmentRegressionTests
{
    private static HtmlVisualScope Scope() => new(
        ["Title", "CanSave", "Choice", "Rows", "Pages"],
        new Dictionary<string, string> { ["Refresh"] = "@refresh", ["Go"] = "@go" },
        new Dictionary<string, string>(), new Dictionary<string, string>(),
        reference => reference == "@go" ? new ScreenContract(reference,
            [new UiParam("PageNumber", "Integer", true, null, null)], [], [], [], [],
            new Dictionary<string, IReadOnlyList<UiParam>>(), new Dictionary<string, IReadOnlyList<string>>()) : null);

    private static List<JsonObject> Ops(string html) => HtmlVisual.Expand(html, "$screen", Scope()).Ops;
    private static bool Set(JsonObject op, string property, string value) =>
        op["op"]?.ToString() == "set" && op["prop"]?.ToString() == property && op["value"]?.ToString() == value;

    [Fact] public void LabelInterpolationsAreExpressionsRatherThanLiteralBraces()
    {
        var ops = Ops("<label>{{ Title }}</label>");
        Assert.Contains(ops, o => Set(o, "Value", "Title"));
        Assert.DoesNotContain(ops, o => Set(o, "Text", "{{ Title }}"));
    }

    [Fact] public void ExplicitTextCanContainBracesWithoutBeingInterpretedAsBindings()
        => Assert.Contains(Ops("<text>{{ Example }}</text>"), o => Set(o, "Text", "{{ Example }}"));

    [Theory]
    [InlineData("<radio-group bind=\"Choice\" onchange=\"Refresh\"><radio-button value=\"1\">One</radio-button></radio-group>", "IRadioGroup")]
    [InlineData("<upload content=\"Title\" filename=\"Title\"/>", "IUpload")]
    [InlineData("<placeholder name=\"Content\"/>", "IPlaceholderWidget")]
    [InlineData("<expr value=\"Title\"/>", "IExpression")]
    [InlineData("<list-item>Item</list-item>", "IListItem")]
    public void DocumentComponentsRemainNativeInFragments(string html, string type)
        => Assert.Contains(Ops(html), o => o["type"]?.ToString() == type);

    [Theory]
    [InlineData("{{ Title }}", "Title")]
    [InlineData("{{ &quot;Search&quot; }}", "\"Search\"")]
    public void PlaceholderUsesTheSameBindingGrammarAsText(string value, string expression)
        => Assert.Contains(Ops($"<input bind=\"Title\" placeholder=\"{value}\"/>"), o => Set(o, "Prompt", expression));

    [Fact] public void TextareaPlaceholderIsNotDiscarded()
        => Assert.Contains(Ops("<textarea bind=\"Title\" placeholder=\"{{ Title }}\"/>"), o => Set(o, "Prompt", "Title"));

    [Theory]
    [InlineData("<textarea bind=\"Title\" rows=\"7\"/>", "TextLines", "7")]
    [InlineData("<input bind=\"Title\" os-MaxLength=\"{{ 24 }}\"/>", "MaxLength", "24")]
    [InlineData("<popup show=\"CanSave\" os-ExpandedInWebEditor=\"True\"/>", "ExpandedInWebEditor", "True")]
    [InlineData("<upload bind=\"Title\" filename=\"Title\" accept=\"Image\"/>", "Accept", "Image")]
    public void NativePropertyRegistryKeepsLiteralAndExpressionTypes(string html, string property, string expected)
        => Assert.Contains(Ops(html), op => Set(op, property, expected));

    [Theory]
    [InlineData("enabled", "CanSave", "Enabled", "CanSave")]
    [InlineData("os-Enabled", "CanSave", "Enabled", "CanSave")]
    [InlineData("disabled", "", "Enabled", "False")]
    [InlineData("required", "", "Mandatory", "True")]
    [InlineData("required", "{{ CanSave }}", "Mandatory", "CanSave")]
    public void ControlPropertiesAreNativeRatherThanInertHtmlAttributes(string attribute, string value, string property, string expression)
    {
        var ops = Ops($"<input bind=\"Title\" {attribute}=\"{value}\"/>");
        Assert.Contains(ops, o => Set(o, property, expression));
        Assert.DoesNotContain(ops, o => Set(o, "Property", attribute));
    }

    [Theory]
    [InlineData("empty", "All categories", "\"All categories\"")]
    [InlineData("os-EmptyValue", "&quot;All categories&quot;", "\"All categories\"")]
    [InlineData("os-EmptyValue", "{{ Title }}", "Title")]
    public void EmptyChoiceDoesNotSilentlySelectTheFirstRecord(string attribute, string value, string expression)
    {
        var ops = Ops($"<select bind=\"Choice\" options=\"Rows\" value=\"Id\" label=\"Name\" {attribute}=\"{value}\"/>");
        Assert.Contains(ops, o => Set(o, "EmptyValue", expression));
        Assert.DoesNotContain(ops, o => Set(o, "Property", attribute));
    }

    [Theory]
    [InlineData("span")]
    [InlineData("tbody")]
    [InlineData("ul")]
    public void ListOnAnHtmlElementCannotBecomeAnOrdinaryStaticElement(string tag)
    {
        var ops = Ops($"<{tag} list=\"Pages\" as=\"Page\"><span>{{{{ Page }}}}</span></{tag}>");
        Assert.Contains(ops, o => o["type"]?.ToString() == "IList");
        Assert.Contains(ops, o => Set(o, "Source", "Pages"));
        Assert.Contains(ops, o => Set(o, "Tag", tag));
        Assert.Contains(ops, o => Set(o, "Value", "Pages.Current"));
    }

    [Fact] public void NativeChangeHandlerIsNotRejectedAsInlineJavascript()
        => Assert.Contains(Ops("<input bind=\"Title\" onchange=\"Refresh\"/>"),
            o => o["target"]?.ToString().EndsWith("/OnChange") == true && Set(o, "Destination", "@refresh"));

    [Fact] public void NamedCallArgumentsAreValuesNotEqualityExpressions()
        => Assert.Contains(Ops("<a onclick=\"Go(PageNumber = 2)\">2</a>"),
            o => o["target"]?.ToString().EndsWith("/PageNumber") == true && Set(o, "Value", "2"));

    [Fact] public void ButtonGroupChangeIsWiredAndCaptionRespectsQuotesInsideBindings()
    {
        var ops = Ops("""<ButtonGroup bind="Choice" onchange="Refresh"><ButtonGroupItem value="1">{{ If(CanSave, "}}", Title) }}</ButtonGroupItem></ButtonGroup>""");
        Assert.Contains(ops, o => o["target"]?.ToString().EndsWith("/OnChange") == true && Set(o, "Destination", "@refresh"));
        Assert.Contains(ops, o => Set(o, "Value", "If(CanSave, \"}}\", Title)"));
    }

    [Fact] public void AdjacentBindingsInAnAttributeConcatenateRatherThanAdd()
        => Assert.Contains(Ops("<input bind=\"Title\" placeholder=\"{{ 1 }}{{ 2 }} items\"/>"),
            // T1 (BindingText, the one compile): the empty text first makes every + a join; an atom needs no parentheses.
            o => Set(o, "Prompt", "\"\" + 1 + 2 + \" items\""));

    [Fact] public void PopupIsNativeWithVisibilityAndEventTransition()
    {
        var ops = Ops("<popup show=\"CanSave\" class=\"editor\"><button onclick=\"Refresh\">Salvar</button></popup>");
        Assert.Contains(ops, o => o["type"]?.ToString() == "IPopup");
        Assert.Contains(ops, o => Set(o, "ShowPopup", "CanSave"));
        Assert.Contains(ops, o => Set(o, "Transition", "Fade"));
        Assert.DoesNotContain(ops, o => Set(o, "Property", "show"));
    }

    [Theory]
    [InlineData("<div>{{ Title</div>")]
    [InlineData("<label>{{ }}</label>")]
    [InlineData("<input bind=\"Title\" placeholder=\"{{ Title\"/>")]
    [InlineData("<a onclick=\"Refresh\" os-UnknownNative=\"True\">X</a>")]
    [InlineData("<input bind=\"Title\" list=\"Rows\" as=\"Row\"/>")]
    [InlineData("<ButtonGroup bind=\"Choice\"><ButtonGroupItem value=\"1\">{{ Title</ButtonGroupItem></ButtonGroup>")]
    [InlineData("<popup><p>Missing visibility</p></popup>")]
    [InlineData("<span onclick=\"Refresh\">Lost event</span>")]
    [InlineData("<div placeholder=\"Lost prompt\"></div>")]
    [InlineData("<div show=\"CanSave\"></div>")]
    [InlineData("<input bind=\"Title\" os-MaxLength=\"{{ Choice }}\"/>")]
    [InlineData("<upload bind=\"Title\" enabled=\"CanSave\"/>")]
    public void UnsupportedOrMalformedSemanticsFailClosed(string html)
        => Assert.ThrowsAny<InvalidOperationException>(() => Ops(html));
}
