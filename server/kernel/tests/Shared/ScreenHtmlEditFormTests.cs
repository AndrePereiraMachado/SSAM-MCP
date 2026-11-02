using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

// Linked into both test projects. Ported from the proto (ad8d86a9, 63f3d451, 63c6fa8f), adapted to the line: where the line has
// its own rule for a case (destination by kind, prose literal, the actions list) the test pins that rule. F10 (the owner's 9 screens of SSAMCoverageSoapWire_UI on 2026-10-25: 6 refusals before the
// first delivery, 4 before the second): what the edit form refused for its shape, one reading each, is normalized and listed;
// what stays wrong is said before anything is written, with the fix that resolves it. Each case: the round that refused it.
public sealed partial class ScreenHtmlEditTests
{
    // Two screens: Detail with a mandatory input, and Orders with a variable named like the screen Detail (the output
    // Pedidos beside the screen Pedidos of the rounds), two screen actions (Open with an input), a toolbar with an input that
    // has a placeholder and a link that opens Open(Id = 1).
    private static Node FormModule()
    {
        keys = 0;
        var module = N("ESpace", "Shop");
        var text = new Node("T-Text", "BasicType", "Text"); var id = new Node("T-Id", "BasicType", "Long Integer");
        var flow = module.Add(N("MobileFlow", "MainFlow"));
        var detail = flow.Add(N("MobileScreen", "Detail"));
        var orderId = detail.Add(N("InputParameter", "OrderId")).Set("DataType", id).Set("IsMandatory", true);
        detail.Set("InputParameters", new List<Node> { orderId });
        detail.Add(W("Container", "Body")).Set("Style", new Code("\"body\""));
        var screen = flow.Add(N("MobileScreen", "Orders"));
        var search = screen.Add(N("LocalVariable", "Search")).Set("DataType", text);
        var shadow = screen.Add(N("LocalVariable", "Detail")).Set("DataType", text);
        screen.Set("LocalVariables", new List<Node> { search, shadow });
        var refresh = screen.Add(N("ScreenAction", "Refresh"));
        var open = screen.Add(N("ScreenAction", "Open"));
        var openId = open.Add(N("InputParameter", "Id")).Set("DataType", id);
        var toolbar = screen.Add(W("Container", "Toolbar")).Set("Style", new Code("\"toolbar\""));
        var input = toolbar.Add(W("Input")).Set("Variable", new Code("Search")).Set("Prompt", new Code("\"Find\""));
        Event(input, "OnChange").Set("Destination", refresh);
        var link = toolbar.Add(W("Link")).Set("Style", new Code("\"go\""));
        Event(link, "OnClick").Set("Destination", open).Add(N("Argument")).Set("Parameter", openId).Set("Value", new Code("1"));
        link.Add(W("TextWidget")).Set("Text", "Go");
        // The reading writes a reference to the screen Detail as the variable's name would not resolve to it.
        shadow.UsedBy.Add(link);
        return module;
    }

    // The k of the element of the reading whose line holds `fragment`, and its whole text.
    private static (string K, string Text) ElementOf(ScreenHtmlDocument document, string fragment)
    {
        var line = document.Html.Split('\n').First(l => l.Contains(fragment, StringComparison.Ordinal) && l.Contains(" k=\"", StringComparison.Ordinal));
        var k = line[(line.IndexOf(" k=\"", StringComparison.Ordinal) + 4)..].Split('"')[0];
        return (k, HtmlElementEdits.ElementText(document.Html, k)!);
    }

    private static string Said(ScreenHtmlEditResult result) => string.Join(" | ", result.Problems.Select(p => p["code"] + ": " + p["message"]));
    private static bool Listed(ScreenHtmlEditResult result, string code) => result.Normalized.Any(n => n["code"]?.ToString() == code);

    [Fact]
    public void AnEditStringWithTheDeclarationsAndTheContentIsAsManyEditsAndTheNewVariableIsCreated()
    {
        // Rounds 1 (6f28e84d) of 25/10: "<var .../><var name=StartIndex .../>\n<div k=w56 ...>" refused HTML_EDIT_INVALID x7.
        var module = FormModule();
        var (_, document) = Read(module, "Orders");
        var (k, toolbar) = ElementOf(document, "class=\"toolbar\"");
        var edit = "<var name=\"Page\" type=\"Text\"/>\n" + toolbar.Replace("class=\"toolbar\"", "class=\"toolbar wide\"", StringComparison.Ordinal);
        var (result, after, _) = Apply(module, [edit], "Orders");
        Assert.False(result.Refused, Said(result));
        Assert.True(Listed(result, "HTML_EDIT_SPLIT"));
        Assert.Contains("name=\"Page\" type=\"Text\"", after);
        Assert.Contains("class=\"toolbar wide\"", after);   // the k of the reading after it moved one place down
        Assert.Contains(module.Children[0].Children[1].Children, c => c.Kind == "LocalVariable" && c.Name == "Page");
    }

    [Fact]
    public void ANewInputWithoutKIsAnInputOfTheScreenAfterItsInputsAndBeforeItsVariables()
    {
        // The variable written first: the input still goes with the inputs (an aggregate or a variable before a new input is
        // read back as that input).
        var module = FormModule();
        var (result, after, _) = Apply(module, ["<var name=\"Seen\" type=\"Text\"/>", "<input name=\"Code\" type=\"Text\"/>"], "Detail");
        Assert.False(result.Refused, Said(result));
        var lines = after.Split('\n').Select(l => l.Trim()).ToList();
        int At(string tag, string name) => lines.FindIndex(l => l.StartsWith("<" + tag, StringComparison.Ordinal) && l.Contains("name=\"" + name + "\"", StringComparison.Ordinal));
        Assert.True(At("input", "OrderId") < At("input", "Code") && At("input", "Code") < At("var", "Seen"), after);
        // A new element that is no declaration still needs its parent: the shape of the edit form is unchanged for it.
        var (refused, _, writer) = Apply(FormModule(), ["<div class=\"loose\"/>"], "Orders");
        Assert.Equal(ScreenHtmlEdit.NoKey, Codes(refused));
        Assert.Empty(writer.Log);
    }

    [Fact]
    public void AnEmptyEditStringBesideOthersIsNothing()
    {
        var module = FormModule();
        var (_, document) = Read(module, "Orders");
        var (_, toolbar) = ElementOf(document, "class=\"toolbar\"");
        var (result, _, _) = Apply(module, ["", toolbar.Replace("toolbar", "bar", StringComparison.Ordinal)], "Orders");
        Assert.False(result.Refused, Said(result));
    }

    [Fact]
    public void NamedArgumentsWrittenWithoutSpacesAreTheCallTheReadingWrites()
    {
        // Round 2 (8bc99ec2): onclick="SelecionarAba(NomeAba=&quot;resumo&quot;)" refused "event onclick is not Destination(...)" x8.
        var module = FormModule();
        var (_, document) = Read(module, "Orders");
        var (k, toolbar) = ElementOf(document, "class=\"toolbar\"");
        Assert.Contains("onclick=\"Open(Id = 1)\"", toolbar);
        var (result, after, _) = Apply(module, [toolbar.Replace("Open(Id = 1)", "Open(Id=2)", StringComparison.Ordinal)], "Orders");
        Assert.False(result.Refused, Said(result));
        Assert.True(Listed(result, "HTML_EVENT_ARGUMENTS"));
        Assert.Contains("onclick=\"Open(Id = 2)\"", after);
    }

    [Fact]
    public void AnEventNamingWhatNoEventRunsBesideTheOnlyScreenOfThatNameOpensTheScreen()
    {
        // Rounds 1-2: onclick="Pedidos" beside the output Pedidos of a data action, refused with this very patch, 2-6 times a job.
        var module = FormModule();
        var (_, document) = Read(module, "Orders");
        var (k, toolbar) = ElementOf(document, "class=\"toolbar\"");
        var edit = toolbar.Replace("</div>", "<a onclick=\"Detail(OrderId = Search)\">Detail</a>\n</div>", StringComparison.Ordinal);
        var (result, after, _) = Apply(module, [edit], "Orders");
        Assert.False(result.Refused, Said(result));
        // The line's rule (R2-A, NameResolution: a destination by its kind before its scope) is the proto's
        // HTML_DESTINATION_RESOLVED: the screen, written in its canonical form and listed (REFERENCE_CANONICAL).
        Assert.True(Listed(result, "REFERENCE_CANONICAL"), string.Join(", ", result.Normalized.Select(n => n["code"])));
        Assert.Contains("onclick=\"MobileScreen:Detail(OrderId = Search)\"", after);
    }

    [Fact]
    public void TheArgumentsOfAnEventAreJudgedAgainstTheInputsOfItsDestinationBeforeAnythingIsWritten()
    {
        // Rounds 2-5: "the platform refused set Destination on Button (new): the destination of ev:OnClick on the new element
        // has no input PedidoId", after the build, "nothing was kept".
        var module = FormModule();
        var (_, document) = Read(module, "Orders");
        var (_, toolbar) = ElementOf(document, "class=\"toolbar\"");
        var unknown = toolbar.Replace("</div>", "<a onclick=\"Open(Code = 2)\">Code</a>\n</div>", StringComparison.Ordinal);
        var (result, _, writer) = Apply(module, [unknown], "Orders");
        var problem = Assert.Single(result.Problems);
        Assert.Equal(ScreenHtmlEdit.NameUnknown, problem["code"]!.ToString());
        Assert.Contains("has no input Code (its inputs: Id)", problem["message"]!.ToString());
        Assert.Contains("<input name=\"Code\"", problem["fix"]!.ToString());
        Assert.Empty(writer.Log);
        var mandatory = toolbar.Replace("</div>", "<a onclick=\"MobileScreen:Detail\">Detail</a>\n</div>", StringComparison.Ordinal);
        // A mandatory input left out is the Verify's (a later op of the job may make it optional): not refused here.
        var (second, _, _) = Apply(FormModule(), [mandatory], "Orders");
        Assert.False(second.Refused, Said(second));
        // An argument the destination certainly means (one letter off) is named in the fix.
        var close = toolbar.Replace("</div>", "<a onclick=\"Open(Ids = 2)\">Ids</a>\n</div>", StringComparison.Ordinal);
        var (third, _, _) = Apply(FormModule(), [close], "Orders");
        Assert.StartsWith("write Id = ...", Assert.Single(third.Problems)["fix"]!.ToString());
    }

    [Fact]
    public void ProseInAnExpressionOfTextIsItsStringLiteral()
    {
        // Round 3 (1748e51c): empty="Selecione um cliente" on a new Dropdown refused HTML_EDIT_INVALID with its literal as the fix.
        var module = FormModule();
        var (_, document) = Read(module, "Orders");
        var (_, toolbar) = ElementOf(document, "class=\"toolbar\"");
        Assert.Contains("placeholder='\"Find\"'", toolbar);
        // The line's rule (R2-C, ScreenDocument.ProseLiteral) is the proto's HTML_LITERAL_QUOTED: decided with the names of the
        // module and of the job (what ModelHost.HtmlEdit gives the plan), listed as TEXT_LITERAL_QUOTED.
        var (reading, read) = Read(module, "Orders");
        var plan = reading.Edit(read, [toolbar.Replace("placeholder='\"Find\"'", "placeholder=\"Digite o nome\"", StringComparison.Ordinal)], "/edit", null,
            () => (new HashSet<string>(StringComparer.Ordinal), new HashSet<string>(StringComparer.Ordinal)));
        if (!plan.Refused) plan.Apply(new Writer());
        var result = plan.Result;
        Assert.False(result.Refused, Said(result));
        Assert.True(Listed(result, "TEXT_LITERAL_QUOTED"));
        Assert.Contains("placeholder='\"Digite o nome\"'", ScreenHtml.Module(module, new Reader()).Read("Orders").Html);
    }

    [Fact]
    public void TheActionsListOfTheRootIsWhatTheLogicMadeAndANameThePageHasNotIsDeclaredInTheJob()
    {
        // Round 11 (bd9278e9): data-actions="CarregarIndicadores" beside CarregarPainel, refused HTML_ACTIONS_LISTED.
        var module = FormModule();
        var (_, document) = Read(module, "Orders");
        Assert.Contains("actions=\"Open, Refresh\"", document.Html);
        var (result, after, _) = Apply(module, [document.Html.Replace("actions=\"Open, Refresh\"", "actions=\"Refresh\"", StringComparison.Ordinal)], "Orders");
        Assert.False(result.Refused, Said(result));
        // The line's rule (2026-10-18) is the proto's HTML_ACTIONS_KEPT: the list as the module has it, said in normalized.
        Assert.Contains(result.Normalized, n => n["property"]?.ToString() == "actions" && n["kept"] is JsonArray kept && kept.Any(x => x!.ToString() == "Open"));
        Assert.Contains("actions=\"Open, Refresh\"", after);
        var (refused, _, _) = Apply(FormModule(), [document.Html.Replace("actions=\"Open, Refresh\"", "actions=\"Open, Refresh, Archive\"", StringComparison.Ordinal)], "Orders");
        var problem = Assert.Single(refused.Problems);
        Assert.Equal(ScreenHtmlEdit.ActionsListed, problem["code"]!.ToString());
        Assert.Contains("action Orders.Archive", problem["fix"]!.ToString());
    }

    [Fact]
    public void ABreakIsAnEmptyContainerAndTheRowOfADropdownIsReadPerElement()
    {
        // Round 6 live (396214dd): "'br' is not a valid HTML tag"; rounds 1-4: "Can't identify 'CarregarClientes'" on Labels/Values.
        var module = FormModule();
        var (_, document) = Read(module, "Orders");
        var (_, toolbar) = ElementOf(document, "class=\"toolbar\"");
        var edit = toolbar.Replace("</div>", "<p>Linha 1<br/>Linha 2</p>\n<select bind=\"Search\" options=\"GetItems.List\" value=\"GetItems.List.Current.Id\" label=\"GetItems.List.Current.Name\"/>\n</div>", StringComparison.Ordinal);
        var (result, after, _) = Apply(module, [edit], "Orders");
        Assert.False(result.Refused, Said(result));
        Assert.True(Listed(result, "HTML_BR_CONTAINER"));
        Assert.DoesNotContain("<br", after);
        // The row of a Dropdown: the one rule of the line (DropdownItemScopeRules, DROPDOWN_ITEM_SCOPE), O11 only as it is proved.
        if (KernelLane.Current == "odc") { Assert.DoesNotContain(result.Normalized, n => n["code"]?.ToString() == "DROPDOWN_ITEM_SCOPE"); return; }
        Assert.Equal(2, result.Normalized.Count(n => n["code"]?.ToString() == "DROPDOWN_ITEM_SCOPE"));
        Assert.Contains("value=\"Id\"", after);
        Assert.Contains("label=\"Name\"", after);
    }

    [Fact]
    public void ADeclarationTypeQualifiedWithItsProducerIsTheTypeOfThatName()
    {
        // Round 2 (8bc99ec2): "'SSAMCoverageSoapWire.Cliente Identifier' names nothing for DataType", fix "closest: <modules>".
        // The qualifier is the module that owns the entity (review W3-EDIT, 5: the rule of TypeResolver.Qualified).
        var module = FormModule();
        module.Add(N("DataFolder", "Data")).Add(N("Entity", "Customer"));   // under a folder: Shop.Customer names no parent of it
        var (result, after, _) = Apply(module, ["<var name=\"Note\" type=\"Shop.Customer\"/>"], "Orders");
        Assert.False(result.Refused, Said(result));
        Assert.True(Listed(result, "HTML_TYPE_UNQUALIFIED"));
        Assert.Contains("name=\"Note\" type=\"Customer\"", after);
    }

    [Fact]
    public void ADestinationThatNamesNothingSaysToDeclareTheScreenActionNeverTheClosestScreens()
    {
        // Rounds 2-5: "'AplicarPeriodo' names nothing as the destination of hev:onclick from Dashboard | fix: closest: Pedidos, Cliente".
        var module = FormModule();
        var (_, document) = Read(module, "Orders");
        var (_, toolbar) = ElementOf(document, "class=\"toolbar\"");
        var (result, _, writer) = Apply(module, [toolbar.Replace("</div>", "<button onclick=\"ApplyPeriod\">Apply</button>\n</div>", StringComparison.Ordinal)], "Orders");
        var problem = Assert.Single(result.Problems);
        Assert.Equal(ScreenHtmlEdit.NameUnknown, problem["code"]!.ToString());
        Assert.Contains("`action Orders.ApplyPeriod`", problem["fix"]!.ToString());
        Assert.DoesNotContain("closest", problem["fix"]!.ToString());
        Assert.Empty(writer.Log);
    }

    [Fact]
    public void TheEventOfAnHtmlElementRunsAScreenActionNeverAScreen()
    {
        // Round 8 (7304ec8c): "IMobileScreen cannot be used as the value for the IEvent.Handler property in a IAdvancedHtml",
        // after the build.
        var module = FormModule();
        var (_, document) = Read(module, "Orders");
        var (_, toolbar) = ElementOf(document, "class=\"toolbar\"");
        var (result, _, writer) = Apply(module, [toolbar.Replace("</div>", "<section onclick=\"MobileScreen:Detail(OrderId = 1)\">x</section>\n</div>", StringComparison.Ordinal)], "Orders");
        var problem = Assert.Single(result.Problems);
        Assert.Contains("the event of an HTML element runs a screen action of Orders, never a screen", problem["message"]!.ToString());
        Assert.Contains("<a> or <button>", problem["fix"]!.ToString());
        Assert.Empty(writer.Log);
        // The same element on a screen action is written.
        var (fine, _, _) = Apply(FormModule(), [toolbar.Replace("</div>", "<section onclick=\"Refresh\">x</section>\n</div>", StringComparison.Ordinal)], "Orders");
        Assert.False(fine.Refused, Said(fine));
    }

    [Fact]
    public void ThePreflightOfTheEditFormTakesSeveralElementsAndNewDeclarationsInOneString()
    {
        var data = new JsonObject { ["screen"] = "Orders", ["basedOn"] = new JsonObject { ["capture"] = "c", ["html"] = "h" },
            ["edit"] = new JsonArray("<var name=\"Page\" type=\"Text\"/><input name=\"Code\" type=\"Text\"/>\n<div k=\"w9\" class=\"a\"/>", "") };
        ScreenHtmlEdit.Preflight(data);   // no refusal
        var loose = new JsonObject { ["screen"] = "Orders", ["basedOn"] = new JsonObject { ["capture"] = "c", ["html"] = "h" },
            ["edit"] = new JsonArray("texto solto <div k=\"w9\"/>") };
        var refusal = Assert.Throws<KernelRefusalException>(() => ScreenHtmlEdit.Preflight(loose));
        Assert.Equal(ScreenHtmlEdit.Invalid, refusal.Code);
    }
}
