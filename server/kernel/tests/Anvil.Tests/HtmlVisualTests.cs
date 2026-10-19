using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
namespace Anvil.Tests;

/// <summary>The visual HTML compiler, one test per row of the closed syntax and one per refusal: same fragment, same ops;
/// widgets, order, classes and attributes preserved; every name checked against the module before a single op is emitted.
/// No Studio and no module: the ops are the proof, as they are for the HtmlExpander. The fixture proofs are the jobs
/// html-visual-alert / html-visual-list / html-visual-block.</summary>
public sealed class HtmlVisualTests
{
    // ---- the table ---------------------------------------------------------------------------------------------------

    [Fact] public void ADivIsAContainerWithItsClassOnStyleAndItsIdAsTheName()
    {
        var ops = Ops("<div id=\"Panel\" class=\"card shadow\"></div>");
        Assert.Contains(ops, o => Is(o, "IContainer", "Panel"));
        Assert.Contains(ops, o => Sets(o, "Style", "\"card shadow\""));
        Assert.DoesNotContain(ops, o => Sets(o, "Property", "id"));
    }

    [Theory]
    [InlineData("section")] [InlineData("header")] [InlineData("ul")] [InlineData("li")]
    [InlineData("h1")] [InlineData("p")] [InlineData("span")] [InlineData("strong")]
    [InlineData("em")] [InlineData("small")] [InlineData("code")]
    public void EveryOtherSupportedTagIsAnHtmlElementCarryingItsOwnTag(string tag)
    {
        var ops = Ops($"<{tag} class=\"x\"></{tag}>");
        Assert.Contains(ops, o => Is(o, "IAdvancedHtml"));
        Assert.Contains(ops, o => Sets(o, "Tag", tag));
        // an HTML Element has no native Style: the class travels as an extended property
        Assert.Contains(ops, o => Sets(o, "Property", "class"));
        Assert.Contains(ops, o => Sets(o, "Value", "\"x\""));
    }

    [Theory] [InlineData("br")] [InlineData("hr")]
    public void TheClosingTagOfAVoidElementIsIgnoredWithANote(string tag)
    {
        // atritos 3, C13: the closing tag closes nothing (lab 23 was refused for </hr>); the element compiles once, said in notes.
        var fragment = HtmlVisual.Expand($"<div><{tag}></{tag}></div>", "$screen", Scope());
        Assert.Single(fragment.Ops, o => o["op"]?.ToString() == "create" && o["parent"]?.ToString() != "$screen" && o["type"]?.ToString() is "IContainer" or "IAdvancedHtml");
        Assert.Contains($"</{tag}> closes a void element", fragment.Report["notes"]![0]!.ToString());
    }

    [Fact] public void ABreakIsAnEmptyContainerAndARuleIsAnHtmlElement()
    {
        // The Verify answers "'br' is not a valid HTML tag" for an HTML Element with Tag br (Cardapio 2026-10-06 13:44).
        var br = Ops("<p>a<br>b</p>");
        Assert.DoesNotContain(br, o => Sets(o, "Tag", "br"));
        Assert.Contains(br, o => Is(o, "IContainer", "Br1"));
        // It accepts Tag hr: the Cardapio BackOffice merged four <hr> with 0 new errors (2026-10-06 16:45). Only what the
        // platform refuses is refused.
        var hr = Ops("<div><hr></div>");
        Assert.Contains(hr, o => Is(o, "IAdvancedHtml"));
        Assert.Contains(hr, o => Sets(o, "Tag", "hr"));
    }

    [Fact] public void LiteralTextIsATextWidgetThatDoesNotRepeatTheClassAroundIt()
    {
        var ops = Ops("<div class=\"note\">Nothing was changed.</div>");
        Assert.Contains(ops, o => Is(o, "ITextWidget"));
        Assert.Contains(ops, o => Sets(o, "Text", "Nothing was changed."));
        // the class stays on the element only: on the text too, a pill drew inside another pill (Escala Viva ev-warn)
        Assert.DoesNotContain(ops, o => o["prop"]?.ToString() == "StyleClasses");
    }

    [Fact] public void InterpolationIsAnExpressionCopiedAsWrittenAndNeverJavaScript()
    {
        var ops = Ops("<div>Pin {{ PinNumber }} of {{ Quantity }}</div>");
        Assert.Contains(ops, o => Sets(o, "Value", "PinNumber"));
        Assert.Contains(ops, o => Sets(o, "Value", "Quantity"));
        // the space that touches an interpolation is kept, so the page reads "Pin 12 of 40", not "Pin12of40"
        Assert.Contains(ops, o => Sets(o, "Text", "Pin "));
        Assert.Contains(ops, o => Sets(o, "Text", " of "));
        Assert.Equal(2, ops.Count(o => Is(o, "IExpression")));
    }

    [Fact] public void IndentationAtTheEdgesOfATextRunIsDroppedAndASpaceBetweenTwoInterpolationsIsKept()
    {
        var ops = Ops("<div>\n    For {{ Key }}\n    {{ Label }}·{{ Name }}\n</div>");
        static List<string> Texts(IEnumerable<JsonObject> all) =>
            all.Where(o => o["op"]?.ToString() == "set" && o["prop"]?.ToString() == "Text").Select(o => o["value"]!.ToString()).ToList();
        Assert.Equal(["For ", " ", "·"], Texts(ops));
        Assert.Equal(3, ops.Count(o => Is(o, "IExpression")));
        Assert.Equal(["Done."], Texts(Ops("<div>\n  Done.\n</div>")));
    }

    [Fact] public void TheSpaceNextToAnInlineElementIsKept()
    {
        // the Escala Viva hints read "Arrasteturnos" when the space after </strong> was dropped as edge indentation
        var ops = Ops("<span><strong>Arraste</strong> turnos entre células</span>");
        Assert.Contains(ops, o => Sets(o, "Text", " turnos entre células"));
        Assert.Contains(Ops("<p>Passe o mouse no <strong>!</strong> para ver</p>"), o => Sets(o, "Text", "Passe o mouse no "));
        Assert.Contains(Ops("<p><strong>A</strong> <em>B</em></p>"), o => Sets(o, "Text", " "));
        Assert.Equal(["Done."], Ops("<div>\n  Done.\n</div>").Where(o => o["prop"]?.ToString() == "Text").Select(o => o["value"]!.ToString()));
    }

    [Fact] public void AnIconCarriesItsNameAndTheWeightOnlyWhereTheWidgetHasOne()
    {
        var withoutWeight = Ops("<i icon=\"warning-circle\" weight=\"regular\"></i>");
        Assert.Contains(withoutWeight, o => Is(o, "IIcon"));
        Assert.Contains(withoutWeight, o => Sets(o, "Icon", "warning-circle"));
        Assert.DoesNotContain(withoutWeight, o => o["prop"]?.ToString() == "Weight"); // O11: IIcon has no Weight
        var odc = HtmlVisual.Expand("<i icon=\"warning-circle\" weight=\"regular\"></i>", "$screen",
            Scope() with { Supports = (type, property) => type != "IIcon" || property is "Icon" or "Weight" or "Style" }).Ops;
        Assert.Contains(odc, o => Sets(o, "Weight", "regular"));
        // the ODC icon is born Twotimes; an <i> keeps the font size around it
        var sized = HtmlVisual.Expand("<i icon=\"clock\" weight=\"bold\"></i>", "$screen",
            Scope() with { Supports = (type, property) => type != "IIcon" || property is "Icon" or "Weight" or "IconSize" }).Ops;
        Assert.Contains(sized, o => Sets(o, "IconSize", "FontSize"));
    }

    [Fact] public void AnInputBindsAnExistingVariableAndTurnsThePlaceholderIntoThePrompt()
    {
        var ops = Ops("<input id=\"Pin\" bind=\"PinNumber\" placeholder=\"e.g. 1234\" type=\"text\">");
        Assert.Contains(ops, o => Is(o, "IInput", "Pin"));
        Assert.Contains(ops, o => Sets(o, "Variable", "PinNumber"));
        Assert.Contains(ops, o => Sets(o, "Prompt", "\"e.g. 1234\""));
        Assert.Contains(ops, o => Sets(o, "InputType", "Text"));
        Assert.Contains(Ops("<input bind=\"Quantity\" type=\"number\">"), o => Sets(o, "InputType", "Number"));
        Assert.Contains(Ops("<input bind=\"SelectedDate\" type=\"date\">"), o => Sets(o, "InputType", "Date"));
        Assert.Contains(Ops("<input bind=\"Email\" type=\"email\">"), o => Sets(o, "InputType", "Email"));
        Assert.Contains(Ops("<input bind=\"StartsAt\" type=\"time\">"), o => Sets(o, "InputType", "Time"));
        Assert.Contains(Ops("<input bind=\"PinNumber\" type=\"password\">"), o => Sets(o, "InputType", "Password"));
    }

    [Fact] public void AnInputWithoutTypeTakesTheInputTypeOfItsVariable()
    {
        // ODC refused a Time variable behind an input of type Text; the Studio itself derives the type when a variable is dropped
        Assert.Contains(Ops("<input bind=\"StartsAt\">"), o => Sets(o, "InputType", "Time"));
        Assert.Contains(Ops("<input bind=\"Quantity\">"), o => Sets(o, "InputType", "Number"));
        Assert.Contains(Ops("<input bind=\"SelectedDate\">"), o => Sets(o, "InputType", "Date"));
        Assert.Contains(Ops("<input bind=\"PinNumber\">"), o => Sets(o, "InputType", "Text"));
        // atritos 2 (A11): the bound data type wins over an authored type the Verify would refuse (Pa2F3HtmlTests)
        Assert.Contains(Ops("<input bind=\"Quantity\" type=\"text\">"), o => Sets(o, "InputType", "Number"));
    }

    [Fact] public void AnEnumIsResolvedByItsNamespaceNotOnlyByItsName()
    {
        // the reactive input's InputType is the NRWidgets enum, not OutSystems.Model.Enumerations.InputType (Text, Number, Email, Search)
        Assert.Contains("Time", ApiCatalog.EnumValues("ServiceStudio.Plugin.NRWidgets.Enumerations.InputType")!);
        Assert.DoesNotContain("Time", ApiCatalog.EnumValues("OutSystems.Model.Enumerations.InputType")!);
        Assert.Null(ApiCatalog.EnumValues("Some.Other.Namespace.InputType"));
        var preflight = DataPreflight.Analyze(JsonNode.Parse("[{\"op\":\"set\",\"target\":\"IInput:StartsAtInput\",\"prop\":\"InputType\",\"value\":\"Time\"}]")!.AsArray());
        Assert.DoesNotContain("InputType", preflight.ToJsonString());
    }

    [Fact] public void ATextAreaAndACheckboxBindAnExistingVariable()
    {
        Assert.Contains(Ops("<textarea bind=\"Note\"></textarea>"), o => Is(o, "ITextArea"));
        Assert.Contains(Ops("<textarea bind=\"Note\"></textarea>"), o => Sets(o, "Variable", "Note"));
        var checkbox = Ops("<input type=\"checkbox\" bind=\"Agreed\">");
        Assert.Contains(checkbox, o => Is(o, "ICheckbox"));
        Assert.Contains(checkbox, o => Sets(o, "Variable", "Agreed"));
    }

    [Fact] public void ASelectIsADropdownOverTheListItNames()
    {
        var ops = Ops("<select bind=\"ChoiceId\" options=\"GetUsers.List\" value=\"User.Id\" label=\"User.Name\"></select>");
        Assert.Contains(ops, o => Is(o, "IDropdown"));
        Assert.Contains(ops, o => Sets(o, "Variable", "ChoiceId"));
        Assert.Contains(ops, o => Sets(o, "List", "GetUsers.List"));
        Assert.Contains(ops, o => Sets(o, "Values", "User.Id"));
        Assert.Contains(ops, o => Sets(o, "Labels", "User.Name"));
    }

    [Theory] [InlineData("button", "IButton")] [InlineData("a", "ILink")]
    public void AButtonAndALinkReplaceTheirOwnCaptionAndCallAnExistingAction(string tag, string widget)
    {
        var ops = Ops($"<{tag} id=\"Retry\" onclick=\"RetrySearch\" class=\"btn\">Try again</{tag}>");
        Assert.Contains(ops, o => Is(o, widget, "Retry"));
        var alias = ops.First(o => Is(o, widget, "Retry"))["as"]!.ToString();
        Assert.Contains(ops, o => o["target"]?.ToString() == alias + "/#ITextWidget" && Sets(o, "Text", "Try again"));
        Assert.Single(ops, o => o["prop"]?.ToString() == "Text");
        Assert.Contains(ops, o => o["target"]?.ToString() == alias + "/OnClick" && Sets(o, "Destination", "@retry"));
    }

    [Fact] public void AButtonCarriesItsIconsBeforeOrAfterTheCaption()
    {
        var ops = Ops("<button id=\"Save\" onclick=\"RetrySearch\"><i icon=\"floppy-disk\" weight=\"bold\"></i>Salvar<i icon=\"caret-right\" weight=\"bold\"></i></button>");
        var button = ops.First(o => Is(o, "IButton", "Save"))["as"]!.ToString();
        var icons = ops.Where(o => Is(o, "IIcon") && o["parent"]?.ToString() == button).Select(o => o["as"]!.ToString()).ToList();
        Assert.Equal(2, icons.Count);
        Assert.Contains(ops, o => Sets(o, "Text", "Salvar"));
        Assert.Contains(ops, o => o["op"]?.ToString() == "move" && o["target"]?.ToString() == icons[0] && o["first"]?.GetValue<bool>() == true);
        Assert.DoesNotContain(ops, o => o["op"]?.ToString() == "move" && o["target"]?.ToString() == icons[1]);
        // atritos 3, C13: other child elements are the control's content, in the order written (the platform accepts them)
        var content = Ops("<button onclick=\"RetrySearch\"><span>x</span>Go</button>");
        var control = content.Single(o => Is(o, "IButton"))["as"]!.ToString();
        Assert.Contains(content, o => o["op"]?.ToString() == "delete" && o["target"]?.ToString() == control + "/#ITextWidget");
        Assert.Equal(["IAdvancedHtml", "ITextWidget"], content.Where(o => o["op"]?.ToString() == "create" && o["parent"]?.ToString() == control).Select(o => o["type"]!.ToString()));
    }

    [Theory] [InlineData("button", "IButton")] [InlineData("a", "ILink")]
    public void DynamicCaptionsAreNativeExpressionsInsideTheControl(string tag, string widget)
    {
        var ops = Ops($"<{tag} id=\"Restaurant\" class=\"card\" onclick=\"Chosen\">{{{{ Restaurantes.Current.Nome }}}}</{tag}>");
        var control = ops.Single(o => Is(o, widget))["as"]!.ToString();
        var expression = ops.Single(o => Is(o, "IExpression"));
        Assert.Equal(control, expression["parent"]!.ToString());
        Assert.Contains(ops, o => o["target"]?.ToString() == expression["as"]!.ToString() && Sets(o, "Value", "Restaurantes.Current.Nome"));
        Assert.Contains(ops, o => o["op"]?.ToString() == "delete" && o["target"]?.ToString() == control + "/#ITextWidget");
        Assert.DoesNotContain(ops, o => o["prop"]?.ToString() == "Text");
        Assert.Contains(ops, o => o["target"]?.ToString() == control + "/OnClick" && Sets(o, "Destination", "@chosen"));
        Assert.Contains(ops, o => o["target"]?.ToString() == control && Sets(o, "Style", "\"card\""));
    }

    [Theory] [InlineData("button")] [InlineData("a")]
    public void DynamicCaptionsKeepMixedTextIconsAndListScopeInAuthoredOrder(string tag)
    {
        var ops = Ops($"<div list=\"GetUsers.List\" as=\"Row\"><{tag} onclick=\"Chosen\"><i icon=\"star\" weight=\"regular\"></i>Ver {{{{ Row.User.Name }}}}<i icon=\"star\" weight=\"regular\"></i> {{{{ Quantity }}}} moedas<i icon=\"star\" weight=\"regular\"></i></{tag}></div>");
        var control = ops.Single(o => Is(o, tag == "a" ? "ILink" : "IButton"))["as"]!.ToString();
        var children = ops.Where(o => o["op"]?.ToString() == "create" && o["parent"]?.ToString() == control).ToList();
        Assert.Equal(new[] { "IIcon", "ITextWidget", "IExpression", "IIcon", "ITextWidget", "IExpression", "ITextWidget", "IIcon" }, children.Select(o => o["type"]!.ToString()));
        Assert.Contains(ops, o => Sets(o, "Value", "GetUsers.List.Current.User.Name"));
        Assert.Contains(ops, o => Sets(o, "Value", "Quantity"));
        Assert.Equal(new[] { "Ver ", " ", " moedas" }, ops.Where(o => o["prop"]?.ToString() == "Text").Select(o => o["value"]!.ToString()));
        Assert.DoesNotContain(ops, o => o["value"]?.ToString().Contains("{{") == true);
    }

    [Theory] [InlineData("button")] [InlineData("a")]
    public void EmptyCaptionExpressionsAreRejected(string tag)
        => Assert.Contains("needs an OutSystems expression", Assert.Throws<InvalidOperationException>(() => Ops($"<{tag} onclick=\"Chosen\">{{{{ }}}}</{tag}>")).Message);

    [Fact] public void ALabelTargetsTheInputOfTheSameFragment()
    {
        var ops = Ops("<div><label for=\"Pin\">Pin</label><input id=\"Pin\" bind=\"PinNumber\"></div>");
        var input = ops.First(o => Is(o, "IInput", "Pin"))["as"]!.ToString();
        Assert.Contains(ops, o => Sets(o, "TargetWidget", input));
    }

    [Fact] public void AnImageNamesAnImageOfTheModule()
    {
        var ops = Ops("<img src=\"Logo\">");
        Assert.Contains(ops, o => Is(o, "IImage"));
        Assert.Contains(ops, o => Sets(o, "Image", "IImage:Logo"));
    }

    [Fact] public void AListRepeatsOverItsSourceAndTheRowAliasIsTheCurrentRecord()
    {
        var ops = Ops("<div list=\"GetUsers.List\" as=\"Row\"><div class=\"row\">{{ Row.User.Name }}</div></div>");
        Assert.Contains(ops, o => Is(o, "IList"));
        Assert.Contains(ops, o => Sets(o, "Source", "GetUsers.List"));
        Assert.Contains(ops, o => Sets(o, "Value", "GetUsers.List.Current.User.Name"));
        var list = ops.First(o => Is(o, "IList"))["as"]!.ToString();
        Assert.Contains(ops, o => Is(o, "IContainer") && o["parent"]?.ToString() == list);
    }

    [Fact] public void AnIfPutsItsChildrenInTheTrueBranchAndTheElseSiblingInTheFalseOne()
    {
        var ops = Ops("<div if=\"Agreed\"><span>Yes</span></div><div else><span>No</span></div>");
        var branch = ops.First(o => Is(o, "IIfWidget"))["as"]!.ToString();
        Assert.Contains(ops, o => Sets(o, "Condition", "Agreed"));
        Assert.Contains(ops, o => o["parent"]?.ToString() == branch + "/TrueBranch");
        Assert.Contains(ops, o => o["parent"]?.ToString() == branch + "/FalseBranch");
        Assert.Single(ops, o => Is(o, "IIfWidget"));
    }

    [Fact] public void ABlockInstanceCarriesItsInputsItsHandlerAndItsSlots()
    {
        var ops = Ops("<Block name=\"WF_Alert\" :Title=\"&quot;Pin&quot;\" @Picked=\"Chosen\"><slot name=\"Body\"><span>Body</span></slot></Block>");
        var block = Assert.Single(ops, o => Is(o, "IMobileBlockInstanceWidget"));
        Assert.Equal("IMobileBlock:WF_Alert", block["source"]?.ToString());
        var alias = block["as"]!.ToString();
        Assert.Contains(ops, o => o["target"]?.ToString() == alias + "/Title" && Sets(o, "Value", "\"Pin\""));
        Assert.Contains(ops, o => o["target"]?.ToString() == alias + "/Picked" && Sets(o, "Handler", "@chosen"));
        // the event parameter reaches the handler through the input of the same name
        Assert.Contains(ops, o => o["target"]?.ToString() == alias + "/Picked/Id" && Sets(o, "Value", "Id"));
        Assert.Contains(ops, o => o["parent"]?.ToString() == alias + "/Body");
    }

    [Fact] public void AnyOtherAttributeBecomesAnExtendedPropertyWithItsLiteralValue()
    {
        var ops = Ops("<div role=\"alert\" aria-live=\"polite\"></div>");
        Assert.Contains(ops, o => Sets(o, "Property", "role"));
        Assert.Contains(ops, o => Sets(o, "Value", "\"alert\""));
        Assert.Contains(ops, o => Sets(o, "Property", "aria-live"));
        Assert.Contains(ops, o => Sets(o, "Value", "\"polite\""));
    }

    [Fact] public void WidgetNamesComeFromTheIdOrAreGeneratedByPosition()
    {
        var ops = Ops("<div></div><div id=\"Named\"></div><span></span><span></span>");
        Assert.Contains(ops, o => Is(o, "IContainer", "Div1"));
        Assert.Contains(ops, o => Is(o, "IContainer", "Named"));
        Assert.Contains(ops, o => Is(o, "IAdvancedHtml", "Span1"));
        Assert.Contains(ops, o => Is(o, "IAdvancedHtml", "Span2"));
    }

    [Fact] public void TheStylesheetIsRewrittenUnderTheClassOfTheFragmentRoot()
    {
        var fragment = HtmlVisual.Expand("<style>:root{padding:4px} .title{font-weight:600}</style><div class=\"wf-alert\"><span class=\"title\">Hi</span></div>", "$screen", Scope());
        Assert.Equal("wf-alert", fragment.ScopeClass);
        Assert.Contains(".wf-alert { padding: 4px;", fragment.ScopedCss);
        Assert.Contains(".wf-alert .title", fragment.ScopedCss);
        Assert.Equal(2, fragment.Report["css"]!["rules"]!.GetValue<int>());
    }

    [Fact] public void TheSameFragmentAlwaysCompilesToTheSameOps()
    {
        var html = File.ReadAllText(Path.Combine(Root, "tests", "html", "visual", "alert.html"));
        var scope = Scope();
        Assert.Equal(Dump(HtmlVisual.Expand(html, "$screen", scope).Ops), Dump(HtmlVisual.Expand(html, "$screen", scope).Ops));
    }

    [Fact] public void TheAlertFragmentIsThePanelIconTitleThreeTextsTwoInputsAndAButton()
    {
        var ops = Ops(File.ReadAllText(Path.Combine(Root, "tests", "html", "visual", "alert.html")));
        Assert.Contains(ops, o => Is(o, "IContainer", "PinAlert"));
        Assert.Single(ops, o => Is(o, "IIcon"));
        Assert.Contains(ops, o => Sets(o, "Text", "Pin not found"));
        Assert.Equal(3, ops.Count(o => o["prop"]?.ToString() == "Tag" && o["value"]?.ToString() == "p"));
        Assert.Equal(2, ops.Count(o => Is(o, "IInput")));
        Assert.Single(ops, o => Is(o, "IButton", "RetryButton"));
        var fragment = HtmlVisual.Expand(File.ReadAllText(Path.Combine(Root, "tests", "html", "visual", "alert.html")), "$screen", Scope());
        Assert.Equal("wf-alert", fragment.ScopeClass);
        Assert.Contains(".wf-alert .wf-alert-title", fragment.ScopedCss);
    }

    // ---- refusals ----------------------------------------------------------------------------------------------------

    [Fact] public void AnOnclickThatNamesNoActionIsRefusedWithTheNamesThatExist()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => Ops("<div>\n  <button onclick=\"Missing\">Go</button>\n</div>"));
        Assert.Contains("line 2 col 3 <button>", ex.Message);
        Assert.Contains("\"Missing\" does not name an action or a screen of the module", ex.Message);
        Assert.Contains("Chosen, RetrySearch", ex.Message);
    }

    [Fact] public void AnIconWithoutAWeightIsRefusedWithLineAndColumnWhereTheIconHasOne()
    {
        // ODC: the icon has a Weight, and without one the Studio shows "Non Existing Icon".
        var ex = Assert.Throws<InvalidOperationException>(() => HtmlVisual.Expand("<div>\n<i icon=\"warning-circle\"></i>\n</div>", "$screen",
            Scope() with { Supports = (type, property) => type != "IIcon" || property is "Icon" or "Weight" or "Style" }));
        Assert.Contains("line 2 col 1 <i>", ex.Message);
        Assert.Contains("needs weight=", ex.Message);
        // O11: the icon has no Weight, its reading writes none, and the fragment takes the <i> as the reading writes it (round 2 of
        // the html edit names, 2026-10-18).
        Assert.Contains(Ops("<div>\n<i icon=\"warning-circle\"></i>\n</div>"), o => Is(o, "IIcon"));
    }

    [Fact] public void AScriptIsRefusedBecauseLogicIsNative()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => Ops("<div>\n  <script>alert(1)</script>\n</div>"));
        Assert.Contains("line 2 col 3 <script>", ex.Message);
        Assert.Contains("logic is native", ex.Message);
    }

    [Fact] public void ABindThatNamesNoVariableIsRefusedWithTheVariablesThatExist()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => Ops("<input bind=\"Nope\">"));
        Assert.Contains("bind=\"Nope\" does not name a variable", ex.Message);
        Assert.Contains("PinNumber", ex.Message);
    }

    [Fact] public void ABlockAnInputAndAnEventThatDoNotExistAreRefused()
    {
        Assert.Contains("does not name a block", Assert.Throws<InvalidOperationException>(() => Ops("<Block name=\"Nope\"></Block>")).Message);
        // the parser folds the case of an attribute name: the signature is matched, and reported, case-insensitively
        Assert.Contains("has no input 'nope'", Assert.Throws<InvalidOperationException>(() => Ops("<Block name=\"WF_Alert\" :Nope=\"1\"></Block>")).Message);
        Assert.Contains("has no event 'nope'", Assert.Throws<InvalidOperationException>(() => Ops("<Block name=\"WF_Alert\" @Nope=\"Chosen\"></Block>")).Message);
        Assert.Contains("has no placeholder 'Nope'", Assert.Throws<InvalidOperationException>(() => Ops("<Block name=\"WF_Alert\"><slot name=\"Nope\"></slot></Block>")).Message);
    }

    [Theory]
    // H9 (the one table): a static table compiles to HTML Elements of its tags (ElementWidgetMapTests); a tag outside every list is refused.
    [InlineData("<marquee>a</marquee>", "is not compiled")]
    [InlineData("<div list=\"GetUsers.List\"><span>x</span></div>", "needs as=")]
    [InlineData("<div else><span>x</span></div>", "must immediately follow")]
    [InlineData("<div id=\"A\"></div><div id=\"A\"></div>", "already used by another widget")]
    [InlineData("<label for=\"Ghost\">Pin</label>", "does not name a widget of this fragment")]
    [InlineData("<input bind=\"PinNumber\" type=\"color\">", "input type \"color\" is not compiled")]
    [InlineData("<div if=\"Agreed\" class=\"x\"></div>", "carries no attributes")]
    [InlineData("<style>#x{color:red}</style><div class=\"a\"></div>", "reserves the id attribute")]
    [InlineData("<style>.a{color:red}</style><div></div>", "one root element carrying the class")]
    public void WhatTheSyntaxDoesNotCoverIsRefusedWithADiagnostic(string html, string expected)
        => Assert.Contains(expected, Assert.Throws<InvalidOperationException>(() => Ops(html)).Message);

    // ---- the published vocabulary ------------------------------------------------------------------------------------

    [Fact] public void TheVocabularyFileIsExactlyTheCompiledSyntax()
    {
        var path = Path.Combine(Root, "src", "Anvil.Core", "Kernel", "HtmlVisualVocabulary.json");
        Assert.Equal(Canonical(HtmlVisual.Schema()), Canonical(JsonNode.Parse(File.ReadAllText(path))!));
    }

    [Fact] public void PreflightProvesTheSyntaxWithoutAModule()
    {
        var result = HtmlVisual.Preflight("<div class=\"a\"><button onclick=\"AnythingAtAll\">Go</button></div>", "$screen");
        Assert.Equal(2, result["elements"]!.GetValue<int>());
        Assert.Contains("is not compiled", Assert.Throws<InvalidOperationException>(() => HtmlVisual.Preflight("<script>x</script>", "$screen")).Message);
    }

    // ---- fixtures ----------------------------------------------------------------------------------------------------

    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(HtmlVisualTests).Assembly.Location)!)!;
    private static UiParam Param(string name, string type) => new(name, type, false, null, null);

    private static HtmlVisualScope Scope() => new(
        ["PinNumber", "AlertNote", "SelectedDate", "Quantity", "Email", "Agreed", "Note", "ChoiceId", "StartsAt"],
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["RetrySearch"] = "@retry", ["Chosen"] = "@chosen" },
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["WF_Alert"] = "IMobileBlock:WF_Alert" },
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Logo"] = "IImage:Logo" },
        Contract,
        InputTypes: new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["SelectedDate"] = "Date", ["Quantity"] = "Number", ["Email"] = "Email", ["StartsAt"] = "Time" });

    private static ScreenContract? Contract(string reference) => reference switch
    {
        "IMobileBlock:WF_Alert" => new(reference, [Param("Title", "Text")], [], [],
            [new UiEvent("Picked", false, null, [Param("Id", "Text")]), new UiEvent("Dismissed", false, null, [])],
            [new UiPlaceholder("Body", null, "Body", [])], new Dictionary<string, IReadOnlyList<UiParam>>(), new Dictionary<string, IReadOnlyList<string>>()),
        "@chosen" => new(reference, [Param("Id", "Text")], [], [], [], [], new Dictionary<string, IReadOnlyList<UiParam>>(), new Dictionary<string, IReadOnlyList<string>>()),
        _ => null,
    };

    private static List<JsonObject> Ops(string html) => HtmlVisual.Expand(html, "$screen", Scope()).Ops;
    private static string Dump(IEnumerable<JsonObject> ops) => string.Join("\n", ops.Select(o => o.ToJsonString()));
    private static bool Is(JsonObject o, string type, string? name = null) => o["type"]?.ToString() == type && (name == null || o["name"]?.ToString() == name);
    private static bool Sets(JsonObject o, string prop, string value) => o["op"]?.ToString() == "set" && o["prop"]?.ToString() == prop && o["value"]?.ToString() == value;
    private static string Canonical(JsonNode? node) => node switch
    {
        JsonObject o => "{" + string.Join(",", o.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => System.Text.Json.JsonSerializer.Serialize(p.Key) + ":" + Canonical(p.Value))) + "}",
        JsonArray a => "[" + string.Join(",", a.Select(Canonical)) + "]",
        _ => node?.ToJsonString() ?? "null",
    };
}
