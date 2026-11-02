using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R4 (B1, group K3, ported from the proto line): what only the apply or the Verify used to refuse, said before the build
/// from the real message of the friction reports, with the patch when the correction is certain. No Studio process; the
/// tests that compile a document load the installed Studio's assemblies headless and skip without them.
/// </summary>
public sealed class PreflightPatchTests
{
    // ---- C-40 -------------------------------------------------------------------------------------------------------------

    /// <summary>C-40 (F-FitBody-04a): `&lt;` inside a binding of the text ({{ If(Count &lt; 3, ...) }}) was "stray '&lt;'" at the
    /// parse of the document; it is the expression's. A '&lt;' outside a binding is still refused, a {{ nothing closes is no
    /// binding, and a '&lt;' that opens a tag (a letter, '/' or '!' after it) still ends the text, binding or not.</summary>
    [Fact]
    public void ALessThanInsideABindingIsTheExpressionsNeverATag()
    {
        var html = "<screen name=\"CsProgress\">\n<var name=\"Count\" type=\"Integer\"/>\n<div class=\"cs-count\">{{ If(Count < 3, \"few\", \"many\") }}</div>\n</screen>";
        var top = ScreenHtml.Parse(html).Children.First(c => !c.IsText);
        var div = top.Children.First(c => !c.IsText && c.Tag == "div");
        Assert.Equal("{{ If(Count < 3, \"few\", \"many\") }}", Assert.Single(div.Children).Text);
        ScreenDocument.Preflight(html, "/data/html");
        Assert.Throws<FormatException>(() => ScreenHtml.Parse("<screen name=\"A\"><div>a < b</div></screen>"));
        // A {{ nothing closes is no binding: the '<' after it is the tag it is.
        Assert.Equal("b", ScreenHtml.Parse("<screen name=\"A\"><div>{{ a <b>x</b></div></screen>").Children.First(c => !c.IsText).Children[0].Children.First(c => !c.IsText).Tag);
        // A tag inside an unpaired {{ before a later }} is still a tag: the binding does not swallow the page.
        var swallowed = ScreenHtml.Parse("<screen name=\"A\"><div>{{ a <b>x</b></div><p>}}</p></screen>").Children.First(c => !c.IsText);
        Assert.Equal(["div", "p"], swallowed.Children.Where(c => !c.IsText).Select(c => c.Tag));
        // The other parser of the language (HtmlSource: the page and fragment forms) reads it the same way.
        var source = HtmlSource.Parse("<div class=\"x\">{{ If(A < B, 1, 2) }}</div>");
        Assert.Equal("{{ If(A < B, 1, 2) }}", Assert.Single(source.Elements.First().Children).Text);
        Assert.Throws<InvalidOperationException>(() => HtmlSource.Parse("<div>a < b</div>"));
    }

    // ---- C-38 -------------------------------------------------------------------------------------------------------------

    /// <summary>C-38 (F-FigmaReactive-06): `&lt;div name="SectionFaq"&gt;` was an extended property in silence, and every
    /// SectionFaq.Id came back HTML_NAME_UNKNOWN (42 of them). The Name of a widget is id=; the platform accepts name= on a
    /// container (it passed), so it is never refused (the Integradora, review B1 S2): name= of a new element with no id= is
    /// written as id= before the checks, and said (HTML_WIDGET_NAME_IS_ID in normalizations), so it costs no round. name= of
    /// the elements that take one stays; an element with both keeps both, as written.</summary>
    [Fact]
    public void TheNameOfAWidgetIsWrittenAsItsIdAndSaid()
    {
        var html = "<screen name=\"CsHome\" roles=\"Registered\">\n<div name=\"SectionFaq\" class=\"cs-faq\">FAQ</div>\n<var name=\"Shown\" type=\"Boolean\"/>\n<div id=\"Both\" name=\"Kept\">x</div>\n<div class=\"cs-go\">{{ SectionFaq.Id }}</div>\n</screen>";
        // The job alone: the document is written with id= and the note says where; the check of the document passes.
        var ops = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } });
        var notes = Anvil.Core.Preflight.JobNormalizer.Pure(ops, "/ops", "o11").Where(n => n["rule"]?.ToString() == "HTML_WIDGET_NAME_IS_ID").ToList();
        var note = Assert.Single(notes);
        Assert.Equal("/ops/0/data/html", note["path"]!.ToString());
        Assert.Contains("line 2", note["message"]!.ToString());
        Assert.Contains("id=\"SectionFaq\"", note["message"]!.ToString());
        var written = ops[0]!["data"]!["html"]!.ToString();
        Assert.Contains("<div id=\"SectionFaq\" class=\"cs-faq\">", written);
        Assert.Contains("<var name=\"Shown\"", written);
        Assert.Contains("<div id=\"Both\" name=\"Kept\">", written);
        ScreenDocument.Preflight(html, "/data/html");
        // With the module: accepted, the widget's Name is the id (it reads back as id=), and the answer lists the note.
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (page, answer) = CompiledWithAnswer("reactive-ui.oml", "MobileScreen:CsHome", new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } });
        Assert.Contains("id=\"SectionFaq\"", page);
        Assert.Contains((answer["normalizations"] as JsonArray ?? []).OfType<JsonObject>(), n => n["rule"]?.ToString() == "HTML_WIDGET_NAME_IS_ID" && n["message"]!.ToString().Contains("SectionFaq"));
    }

    /// <summary>C-38 (review B1 round 2, fix 4): name= becomes id= only when that id is the name the Studio keeps: an
    /// identifier no other id=, name= of the document or other rewrite has (case-insensitive). A name with a hyphen or a space,
    /// a name two widgets share, or the name of a variable stays the extended property it is at base: accepted, no note.</summary>
    [Theory]
    [InlineData("<div name=\"hero-1\" class=\"cs-hero\">Hi</div>", "hero-1")]
    [InlineData("<div name=\"main hero\" class=\"cs-hero\">Hi</div>", "main hero")]
    [InlineData("<div name=\"Card\" class=\"cs-a\">A</div>\n<div name=\"Card\" class=\"cs-b\">B</div>", "Card")]
    [InlineData("<var name=\"Title\" type=\"Text\"/>\n<div name=\"Title\" class=\"cs-a\">A</div>", "Title")]
    public void ANameThatIsNoFreeIdentifierStaysTheExtendedPropertyItIs(string body, string name)
    {
        var html = $"<screen name=\"CsPlain\" roles=\"Registered\">\n{body}\n</screen>";
        var ops = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } });
        Assert.DoesNotContain(Anvil.Core.Preflight.JobNormalizer.Pure(ops, "/ops", "o11"), n => n["rule"]?.ToString() == "HTML_WIDGET_NAME_IS_ID");
        Assert.Equal(html, ops[0]!["data"]!["html"]!.ToString());
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var (page, answer) = CompiledWithAnswer("reactive-ui.oml", "MobileScreen:CsPlain", new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } });
        Assert.Contains($"ext:name=\"{name}\"", page);
        Assert.DoesNotContain((answer["normalizations"] as JsonArray ?? []).OfType<JsonObject>(), n => n["rule"]?.ToString() == "HTML_WIDGET_NAME_IS_ID");
    }

    /// <summary>C-38: a free identifier still becomes the id its expression names, and is said (the probe of the review).</summary>
    [Fact]
    public void AFreeIdentifierNameStillBecomesTheIdItsExpressionNames()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var hero = "<screen name=\"CsPlain\" roles=\"Registered\">\n<div name=\"Hero\" class=\"cs-hero\">Hi</div>\n<div class=\"cs-x\">{{ Hero.Id }}</div>\n</screen>";
        var (heroPage, heroAnswer) = CompiledWithAnswer("reactive-ui.oml", "MobileScreen:CsPlain", new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = hero } });
        Assert.Contains("id=\"Hero\"", heroPage);
        Assert.Contains((heroAnswer["normalizations"] as JsonArray ?? []).OfType<JsonObject>(), n => n["rule"]?.ToString() == "HTML_WIDGET_NAME_IS_ID" && n["message"]!.ToString().Contains("Hero"));
    }

    // ---- C-45 -------------------------------------------------------------------------------------------------------------

    /// <summary>C-45 (F-FitBody-13): `client variable X: T = NullIdentifier()` passed the grammar and the Verify refused it
    /// (InvalidPropertyValue_DefaultValue, no patch). The null of the type is the value with no default: left out, and said;
    /// any other default stays as written.</summary>
    [Fact]
    public void TheNullOfItsTypeAsTheDefaultOfAClientVariableIsLeftOutAndSaid()
    {
        var edit = DdlParser.Parse("client variable FBCurrentMemberId: FBMember Identifier = NullIdentifier()\nclient variable FBTheme: Text = \"dark\"\nsite property CsStart: Date = NullDate()\n", "o11");
        var result = DdlConventions.Apply(edit, null);
        Assert.Empty(result.Problems);
        var byName = edit.Elements.ToDictionary(e => e.Name);
        Assert.False(byName["FBCurrentMemberId"].Props.ContainsKey("DefaultValue"));
        Assert.False(byName["CsStart"].Props.ContainsKey("DefaultValue"));
        Assert.Equal("\"dark\"", byName["FBTheme"].Props["DefaultValue"]);
        Assert.Equal(2, result.Notes.Count(n => n.Code == "DDL_DEFAULT_NULL_DROPPED"));
        Assert.Contains(result.Notes, n => n.Message.Contains("client variable FBCurrentMemberId is NullIdentifier()"));
    }

    // ---- C-34 -------------------------------------------------------------------------------------------------------------

    /// <summary>C-34 (F-FigmaMobile-05, -07; five rounds): `&lt;div onclick="Screen"&gt;` was the platform's raw
    /// "IMobileScreen cannot be used as the value for the IEvent.Handler property" (the event of a container runs a screen
    /// action). The compile says it at the element, with the document that writes it as &lt;a&gt; (a Link opens a screen).</summary>
    [Fact]
    public void AContainerWhoseEventOpensAScreenIsALinkByThePatch()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var problems = Problems("mobile-ui.oml",
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = "<screen name=\"CsWallet\" flow=\"MainFlow\">\n<div class=\"cs-send\" onclick=\"CsContacts\">Send</div>\n</screen>" } },
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = "<screen name=\"CsContacts\" flow=\"MainFlow\">\n<div class=\"cs-list\">Contacts</div>\n</screen>" } });
        var problem = Assert.Single(problems, p => p["code"]?.ToString() == "HTML_EVENT_OPENS_SCREEN");
        Assert.Contains("line 2", problem["message"]!.ToString());
        Assert.Contains("<a class=\"cs-send\" onclick=\"CsContacts\">Send</a>", problem["patch"]![0]!["value"]!.ToString());
        Assert.DoesNotContain(problems, p => (p["message"]?.ToString() ?? "").Contains("IEvent.Handler"));
    }

    /// <summary>C-34 (review B1 round 3, correction 1): an element that is itself the widget (an Image, an Icon, an input:
    /// nothing inside it to keep) whose onclick opens a screen was written as &lt;a&gt; by the patch, which lost the widget
    /// (`&lt;img src onclick/&gt;` became an empty Link with src as an extended property, and the job passed); a void &lt;img&gt;
    /// got a fix that promised a patch it did not carry. The element goes inside the Link that opens the screen: the event
    /// moves to the &lt;a&gt;, every other attribute stays on the element, self-closed or not; the fix says what the patch
    /// does without promising one.</summary>
    [Theory]
    [InlineData("<img class=\"cs-logo\" src=\"https://example.com/a.png\" onclick=\"CsContacts\"/>", "<a onclick=\"CsContacts\"><img class=\"cs-logo\" src=\"https://example.com/a.png\"/></a>", "<img ")]
    [InlineData("<img class=\"cs-logo\" src=\"https://example.com/a.png\" onclick=\"CsContacts\">", "<a onclick=\"CsContacts\"><img class=\"cs-logo\" src=\"https://example.com/a.png\"></a>", "<img ")]
    [InlineData("<i icon=\"home\" class=\"cs-home\" onclick=\"CsContacts\"></i>", "<a onclick=\"CsContacts\"><i icon=\"home\" class=\"cs-home\"></i></a>", "<i ")]
    public void AWidgetWhoseEventOpensAScreenGoesInsideTheLinkByThePatch(string element, string wrapped, string widget)
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var contacts = new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = "<screen name=\"CsContacts\" flow=\"MainFlow\">\n<div class=\"cs-list\">Contacts</div>\n</screen>" } };
        var problems = Problems("mobile-ui.oml",
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = "<screen name=\"CsWallet\" flow=\"MainFlow\">\n" + element + "\n</screen>" } }, contacts.DeepClone());
        var problem = Assert.Single(problems, p => p["code"]?.ToString() == "HTML_EVENT_OPENS_SCREEN");
        Assert.Contains("line 2", problem["message"]!.ToString());
        Assert.Contains("inside an <a>", problem["fix"]!.ToString());
        Assert.DoesNotContain("the patch", problem["fix"]!.ToString());
        var patched = Assert.IsType<JsonArray>(problem["patch"])[0]!["value"]!.ToString();
        Assert.Contains(wrapped, patched);
        Assert.DoesNotContain("<a class=", patched);
        // The patched document compiles, and the widget reads back inside the Link that opens the screen.
        var html = Compiled("mobile-ui.oml", "MobileScreen:CsWallet", new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = patched } }, contacts.DeepClone());
        Assert.Matches(@"<a [^>]*onclick=""CsContacts""[^>]*>\s*" + System.Text.RegularExpressions.Regex.Escape(widget), html);
    }

    /// <summary>C-34 (review B1 round 2, S9): an &lt;i&gt; without icon= is an Icon whose Icon is not set: the Verify said it
    /// (RequiredPropertyValue_Property) only on the round after the compile's refusal. The compile says it at the element, in
    /// the same refusal as the event that opens a screen.</summary>
    [Fact]
    public void AnIconWithoutIconIsSaidInTheSameRefusalAsItsEvent()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var contacts = new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = "<screen name=\"CsContacts\" flow=\"MainFlow\">\n<div class=\"cs-list\">Contacts</div>\n</screen>" } };
        var problems = Problems("mobile-ui.oml", new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] =
            "<screen name=\"CsWallet\" flow=\"MainFlow\">\n<i class=\"icon fa fa-home\" onclick=\"CsContacts\"></i>\n</screen>" } }, contacts.DeepClone());
        Assert.Single(problems, p => p["code"]?.ToString() == "HTML_EVENT_OPENS_SCREEN");
        var icon = Assert.Single(problems, p => (p["message"]?.ToString() ?? "").Contains("needs icon="));
        Assert.Equal("HTML_INVALID", icon["code"]!.ToString());
        Assert.Contains("line 2", icon["message"]!.ToString());
        Assert.Contains("icon=\"home\"", icon["fix"]!.ToString());
        var alone = Problems("mobile-ui.oml", new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] =
            "<screen name=\"CsWallet\" flow=\"MainFlow\">\n<i class=\"cs-mark\"></i>\n</screen>" } });
        Assert.Contains(alone, p => (p["message"]?.ToString() ?? "").Contains("needs icon="));
        Assert.DoesNotContain(alone, p => p["code"]?.ToString() == "RequiredPropertyValue_Property");
        // The property written as itself sets the Icon: accepted, as at base.
        Compiled("mobile-ui.oml", "MobileScreen:CsWallet", new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] =
            "<screen name=\"CsWallet\" flow=\"MainFlow\">\n<i os-Icon=\"home\"></i>\n</screen>" } });
    }

    /// <summary>C-34 (review B1 round 2, S8): an element whose onclick opens a screen and that is already inside an
    /// &lt;a onclick&gt; is not wrapped again (a Link inside a Link): the patch removes the element's onclick, the Link
    /// around it takes the click.</summary>
    [Fact]
    public void AWidgetAlreadyInsideALinkLosesItsOnclickInsteadOfASecondLink()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var contacts = new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = "<screen name=\"CsContacts\" flow=\"MainFlow\">\n<div class=\"cs-list\">Contacts</div>\n</screen>" } };
        var problems = Problems("mobile-ui.oml", new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] =
            "<screen name=\"CsWallet\" flow=\"MainFlow\">\n<a onclick=\"CsContacts\"><img class=\"cs-logo\" src=\"https://example.com/a.png\" onclick=\"CsContacts\"/></a>\n</screen>" } }, contacts.DeepClone());
        var problem = Assert.Single(problems, p => p["code"]?.ToString() == "HTML_EVENT_OPENS_SCREEN");
        Assert.Contains("already inside", problem["fix"]!.ToString());
        var patched = Assert.IsType<JsonArray>(problem["patch"])[0]!["value"]!.ToString();
        Assert.Contains("<a onclick=\"CsContacts\"><img class=\"cs-logo\" src=\"https://example.com/a.png\"/></a>", patched);
        Assert.DoesNotContain("<a onclick=\"CsContacts\"><a", patched);
        var html = Compiled("mobile-ui.oml", "MobileScreen:CsWallet", new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = patched } }, contacts.DeepClone());
        Assert.Matches(@"<a [^>]*onclick=""CsContacts""[^>]*>\s*<img ", html);
    }

    // ---- C-41 -------------------------------------------------------------------------------------------------------------

    /// <summary>C-41 (F-FitBody-04b): `&lt;input type="email" bind="Email"/&gt;` over a Text variable passed the compile and
    /// the Verify refused it (Input Type Mismatch). The compile says it at the input, with the document that leaves type out
    /// (the bound data type decides) as the patch; an input type the bound type takes stays.</summary>
    [Fact]
    public void AnInputTypeTheBoundVariableDoesNotTakeIsRefusedAtItsLineWithThePatch()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var problems = Problems("mobile-ui.oml", new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] =
            "<screen name=\"CsSignup\" flow=\"MainFlow\">\n<var name=\"Email\" type=\"Text\"/>\n<var name=\"Phone\" type=\"Phone Number\"/>\n<input type=\"email\" bind=\"Email\"/>\n<input type=\"tel\" bind=\"Phone\"/>\n</screen>" } });
        var problem = Assert.Single(problems, p => p["code"]?.ToString() == "HTML_INPUT_TYPE_MISMATCH");
        Assert.Contains("line 4", problem["message"]!.ToString());
        var corrected = problem["patch"]![0]!["value"]!.ToString();
        Assert.Contains("<input bind=\"Email\"/>", corrected);
        Assert.Contains("<input type=\"tel\" bind=\"Phone\"/>", corrected);
        Assert.DoesNotContain(problems, p => (p["message"]?.ToString() ?? "").Contains("Input Type Mismatch") && p["code"]?.ToString() != "HTML_INPUT_TYPE_MISMATCH");
    }

    // ---- C-44 -------------------------------------------------------------------------------------------------------------

    /// <summary>C-44 (F-Jesse-02): `{{ Site.X }}` in a Reactive screen passed the preflight and the Verify refused it
    /// (ExpressionUnknownObject, with the hint "qualify it (Site.)"): a site property is the server's. The compile says it at
    /// the element; a text literal that only spells Site.X is no expression of it.</summary>
    [Fact]
    public void ASitePropertyInAnExpressionOfAReactivePageIsRefusedAtItsElement()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var problems = Problems("reactive-ui.oml",
            new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = "ISiteProperty", ["name"] = "CsCtaText", ["as"] = "$cta" },
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = "<screen name=\"CsLanding\" roles=\"Registered\">\n<div class=\"cs-cta\">\n {{ Site.CsCtaText }}\n</div>\n<div class=\"cs-label\">{{ \"Site.Nothing\" }}</div>\n</screen>" } });
        var problem = Assert.Single(problems, p => p["code"]?.ToString() == "HTML_SITE_PROPERTY_IN_CLIENT");
        Assert.Contains("line 2", problem["message"]!.ToString());
        Assert.Contains("Site.CsCtaText", problem["message"]!.ToString());
        Assert.Contains("data action", problem["fix"]!.ToString());
    }

    // ---- C-47 -------------------------------------------------------------------------------------------------------------

    /// <summary>C-47 (F-FT-13): `///` above `preparation Fitmaker.Preparation`, as the grammar writes it above every action,
    /// was PROPERTY_SET_DROPPED and then FLOW_NOT_EXACT ("report it"): a Preparation has no description in the model. The
    /// lines are left out, and said; the description of any other action stays.</summary>
    [Fact]
    public void TheDescriptionOfAPreparationIsLeftOutAndSaid()
    {
        var text = "/// Loads the plans of the page.\n/// Runs before the page renders.\npreparation Fitmaker.Preparation\n  assign Message = \"x\"\n  end\n";
        var normalized = FlowTextNormalizer.Normalize(text);
        Assert.DoesNotContain("///", normalized.Text);
        Assert.Contains("preparation Fitmaker.Preparation", normalized.Text);
        Assert.Equal(2, normalized.Edits.Count(e => e.Rule == "FLOW_PREPARATION_DESCRIPTION"));
        ModuleFlow.Read(normalized.Text);
        var action = "/// Saves the plan.\naction Fitmaker.Save\n  end\n";
        Assert.Contains("/// Saves the plan.", FlowTextNormalizer.Normalize(action).Text);
    }

    // ---- C-43 -------------------------------------------------------------------------------------------------------------

    /// <summary>C-43 (F-Jesse-01): a screen action named ToggleSideMenu, as an action of OutSystemsUI the module references,
    /// came back "screen action 'ToggleSideMenu' is not declared" and three raw "A OutSystems.Model.IObject cannot be used as
    /// the value for the ... Destination property": the Studio had renamed the screen action and the links bound to the
    /// other one. One problem at the root says the name is taken and by what; the links say nothing more.</summary>
    [Fact]
    public void AScreenActionWhoseNameAReferencedActionTakesIsSaidOnceWithTheOtherElement()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var problems = Problems("reactive-ui.oml",
            new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = "<screen name=\"CsMenu\" roles=\"Registered\" actions=\"ToggleSideMenu\">\n<a class=\"cs-menu\" onclick=\"ToggleSideMenu\">Menu</a>\n<a class=\"cs-menu2\" onclick=\"ToggleSideMenu\">Menu</a>\n</screen>" } },
            new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray("action CsMenu.ToggleSideMenu\n  end\n") } });
        var taken = Assert.Single(problems, p => p["code"]?.ToString() == "HTML_ACTION_NAME_TAKEN");
        Assert.Contains("OutSystemsUI", taken["message"]!.ToString());
        Assert.DoesNotContain(problems, p => (p["message"]?.ToString() ?? "").Contains("cannot be used as the value"));
        Assert.DoesNotContain(problems, p => (p["message"]?.ToString() ?? "").Contains("is not declared"));
    }

    // ---- C-31 -------------------------------------------------------------------------------------------------------------

    /// <summary>C-31 (F-FitBody-06, -39, F-AiChatbot-06b): `src="{{ GetFotos.List[0].Foto.FotoUrl }}"` was "the type of the
    /// expression is not known here" (HTML_IMAGE_BINDING) beside another problem of the same element, though the indexed row
    /// is the current row's type. Typed as List.Current: a Text is the Url (External), a Binary Data the content.</summary>
    [Fact]
    public void AnIndexedRowOfAListHasTheTypeOfItsCurrentRow()
    {
        var records = new Dictionary<string, IReadOnlyDictionary<string, string>>(StringComparer.OrdinalIgnoreCase)
        {
            ["Foto"] = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["FotoUrl"] = "Text", ["Arquivo"] = "Binary Data" },
        };
        IReadOnlyDictionary<string, string>? Records(string name) => records.TryGetValue(name, out var r) ? r : null;
        foreach (var (src, kind) in new[] { ("{{ GetFotos.List[0].Foto.FotoUrl }}", "External"), ("{{ GetFotos.List[Index + 1].Foto.Arquivo }}", "Binary") })
        {
            var top = ScreenHtml.Parse("<screen name=\"S\"><var name=\"Index\" type=\"Integer\"/><aggregate name=\"GetFotos\" from=\"Foto\"/><img src=\"" + System.Net.WebUtility.HtmlEncode(src) + "\"/></screen>").Children.First(c => !c.IsText);
            var outcome = ScreenHtmlNative.Apply(top, _ => true, _ => null, _ => false, null, null, Records, null);
            Assert.Empty(outcome.Problems);
            Assert.Equal(kind, top.Children.Last().Get("os-Type"));
        }
    }

    // ---- C-36 -------------------------------------------------------------------------------------------------------------

    /// <summary>C-36 (F-FitBody-25): DATABASE_UPGRADE_REFUSED named FBWorkoutLog.ExerciseId "already in the module, not set by
    /// this job" though the job's data text created it: the op that writes it is the data text, with its delete rule.</summary>
    [Fact]
    public void AnAttributeADataTextWritesIsTheJobsInTheDatabaseUpgradeRefusal()
    {
        var ops = new JsonArray(new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] =
            "create entity FBWorkoutLog label Title (\n  Id Long Integer identifier auto required,\n  Title Text(100) required,\n  ExerciseId FBExercise Identifier references FBExercise on delete Delete\n);\n" } });
        Assert.Equal(new DatabaseUpgradeRules.Origin(0, "spec"), DatabaseUpgradeRules.Declared(ops, "FBWorkoutLog", "ExerciseId"));
        Assert.Equal(new DatabaseUpgradeRules.Origin(0, "spec"), DatabaseUpgradeRules.Declared(ops, "FBWorkoutLog", null));
        Assert.Null(DatabaseUpgradeRules.Declared(ops, "FBContent", "ExerciseId"));
        Assert.Null(DatabaseUpgradeRules.Declared(ops, "FBWorkoutLog", "Steps"));
    }

    // ---- C-24 -------------------------------------------------------------------------------------------------------------

    /// <summary>C-24 (F-FigmaReactive-10a): `(a - b + n) mod n` in a page reached the Verify as "Invalid Expression | Expecting
    /// an expression instead of end of line", with no word of Mod(n, m). Refused before the Studio, every expression of the
    /// html at once, with the html written with Mod as the patch (the writer of the logic rule, C19), on both lanes.</summary>
    [Fact]
    public void AModOperatorInAPageIsRefusedWithTheModFunctionAsThePatch()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var html = "<screen name=\"Carousel\">\n<var name=\"A\" type=\"Integer\"/>\n<var name=\"N\" type=\"Integer\" default=\"3\"/>\n"
            + "<div class=\"dot\" if=\"A mod 2 = 0\">{{ (A - 1 + N) mod N }}</div>\n<div class=\"modal\">{{ \"a mod b\" }}</div>\n</screen>";
        foreach (var lane in new[] { "o11", "odc" })
        {
            var ops = new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } });
            var problems = Anvil.Core.Preflight.HtmlDocumentRules.Check(ops, "/ops", lane).Where(p => p["code"]!.ToString() == "EXPR_UNKNOWN_IDENTIFIER").ToList();
            Assert.Equal(2, problems.Count);
            Assert.All(problems, p => Assert.Contains("can't identify 'mod'", p["message"]!.ToString()));
            Assert.Contains("line 4", problems[0]["message"]!.ToString());
            var patched = problems[0]["patch"]![0]!["value"]!.ToString();
            Assert.Equal("/ops/0/data/html", problems[0]["patch"]![0]!["path"]!.ToString());
            Assert.Equal(patched, problems[1]["patch"]![0]!["value"]!.ToString());
            Assert.Contains("if=\"Mod(A, 2) = 0\"", patched);
            Assert.True(System.Text.RegularExpressions.Regex.IsMatch(patched, @"\{\{ Mod\(\(?A - 1 \+ N\)?, N\) \}\}"), patched);
            Assert.Contains("{{ \"a mod b\" }}", patched);
            Assert.Empty(Anvil.Core.Preflight.HtmlDocumentRules.Check(new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = patched } }), "/ops", lane)
                .Where(p => p["code"]!.ToString() == "EXPR_UNKNOWN_IDENTIFIER"));
        }
    }

    // ---- helpers ----------------------------------------------------------------------------------------------------------

    /// <summary>The problems a job of these ops answers on a fixture base (its refusal, or the problems of its result).</summary>
    private static List<JsonObject> Problems(string baseOml, params JsonNode[] ops)
    {
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "preflight-patch-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, new JsonObject { ["base"] = baseOml, ["ops"] = new JsonArray(ops) }.ToJsonString());
        try
        {
            var result = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, Path.Combine(dir, "out.oml")))!;
            return (result["problems"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        }
        catch (Exception error) { return (Errors.Envelope("apply", error, 1)["problems"] as JsonArray ?? []).OfType<JsonObject>().ToList(); }
        finally { try { Directory.Delete(dir, true); } catch { } }
    }

    /// <summary>The page a job of these ops writes on a fixture base, read back without keys (the job must be accepted).</summary>
    private static string Compiled(string baseOml, string target, params JsonNode[] ops) => CompiledWithAnswer(baseOml, target, ops).Page;

    /// <summary>The same with the answer of the job.</summary>
    private static (string Page, JsonNode Answer) CompiledWithAnswer(string baseOml, string target, params JsonNode[] ops)
    {
        var dir = Path.Combine(PacoteBPolicyTests.FindRoot(), ".local", "preflight-patch-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "job.json");
        File.WriteAllText(job, new JsonObject { ["base"] = baseOml, ["ops"] = new JsonArray(ops) }.ToJsonString());
        try
        {
            var host = new ModelHost(Path.Combine(dir, "work"));
            var output = Path.Combine(dir, "out.oml");
            var result = System.Text.Json.JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, output))!;
            Assert.True(result["accepted"]!.GetValue<bool>(), result.ToJsonString());
            return (host.HtmlRead(File.ReadAllBytes(output), target, withKeys: false)["documents"]![0]!["html"]!.ToString(), result);
        }
        finally { try { Directory.Delete(dir, true); } catch { } }
    }
}
