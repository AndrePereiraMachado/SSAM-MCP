using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Atritos 3, lane kl, C08: the anonymous intent is declared once per screen, never per node. Lab 25 made three screens
/// anonymous with `set AnonymousAccess true` and was refused with nine Unexpected ServerActionInScreenAccessibleByEveryone;
/// lab 31 recreated data actions on screens the base already opened and got two more. The family on a screen of the intent
/// is tolerated with reason anonymous-declared-by-job (I4); the other screens of the footprint keep C37.
/// </summary>
public sealed class Pa3KlAnonymousTests
{
    private static MessageInfo Anonymous(string key, string screen, string action)
        => new("ServerActionInScreenAccessibleByEveryone", "Warning", key, $"Loja (ESpace) / {screen} (MobileScreen) / {action} (ServerAction)",
            "Security Warning | You're exposing a Server Action for public access and without authentication. Consider restricting Screen accessibility to Authenticated Users.")
        { ScreenKey = screen + "-key" };

    private static JobFootprint Footprint(params string[] screens)
        => new(new HashSet<string>(), new HashSet<string>(), screens.Select(s => s + "-key").ToHashSet());

    [Fact]
    public void ASetAnonymousAccessDeclaresTheFamilyOfItsScreen()
    {
        var messages = new[] { Anonymous("m1", "Produtos", "GetProducts"), Anonymous("m2", "Produtos", "GetCategories"), Anonymous("m3", "Carrinho", "GetCart") };
        var declared = Footprint("Produtos", "Carrinho") with { AnonymousIntent = new HashSet<string> { "Produtos-key", "Carrinho-key" } };
        var result = MessageExpectations.Evaluate(messages, [], null, declared);
        Assert.True(result.Accepted);
        Assert.All(result.Verdicts, v => Assert.Equal(("tolerated", "anonymous-declared-by-job"), (v.Verdict, v.Reason)));
        // Without the declaration the screens of the job stay under C37.
        var undeclared = MessageExpectations.Evaluate(messages, [], null, Footprint("Produtos", "Carrinho"));
        Assert.False(undeclared.Accepted);
        Assert.All(undeclared.Verdicts, v => Assert.Equal(("unexpected", "anonymous-in-job-screen"), (v.Verdict, v.Reason)));
    }

    [Fact]
    public void AScreenTheBaseAlreadyOpenedKeepsItsFamilyAndANewOneDoesNot()
    {
        var screens = new HashSet<string> { "Base-key", "New-key" };
        var intent = AnonymousIntent.Compute([], screens, created: new HashSet<string> { "New-key" }, isAnonymous: _ => true);
        Assert.Equal(["Base-key"], intent);
        // Declared by the job: also a screen the job created.
        Assert.Contains("New-key", AnonymousIntent.Compute(["New-key"], screens, new HashSet<string> { "New-key" }, _ => false));
        Assert.True(AnonymousIntent.Opens(true) && AnonymousIntent.Opens("True") && !AnonymousIntent.Opens(false));
    }

    [Fact]
    public void VerifyMessageAnswersTheSsamCodesAndTheAnonymousTextTheVerifyCatalogDoesNotName()
    {
        // C-11 (the proto line's b19ae05e; F-AiChatbot-02: verify-message answered []; F-FigmaMobile-08: it only repeated the
        // bucket "{0}"/"{1}"): the code of a refusal and the text of the anonymous warning come back with what they mean and
        // what to do.
        var bucket = new VerifyDefinition("CustomObjectWarning", "Warning", "{0}", "{1}");
        var hints = new Dictionary<string, VerifyHint>();
        string Json(object o) => System.Text.Json.JsonSerializer.Serialize(o);
        var code = Json(CommandSurface.VerifyMessages([bucket], hints, "HTML_NAME_AMBIGUOUS", exact: true));
        Assert.Contains("\"id\":\"HTML_NAME_AMBIGUOUS\"", code);
        Assert.Contains("Kind:Name or Owner.Name", code);
        var text = Json(CommandSurface.VerifyMessages([bucket], hints, "exposing a Server Action", exact: false));
        Assert.Contains("\"id\":\"CustomObjectWarning\"", text);
        Assert.Contains("/expectedMessages/-", text);
        Assert.Contains("roles=\\u0022Anonymous\\u0022", text);
        // The Verify id still answers its own definition first, then the SSAM's reading of it.
        var both = System.Text.Json.Nodes.JsonNode.Parse(Json(CommandSurface.VerifyMessages([bucket], hints, "CustomObjectWarning", exact: true)))!.AsArray();
        Assert.Equal(["{1}", "ssam"], [both[0]!["detail"]!.ToString(), both[1]!["hintOrigin"]!.ToString()]);
        Assert.Equal("[]", Json(CommandSurface.VerifyMessages([bucket], hints, "NO_SUCH_CODE", exact: true)));
        // The normalization of C-05 is answered too (the ODC CLI's verify-catalog gives the same list as data.ssamCodes).
        Assert.Contains(CommandSurface.SsamCodes("CSS_IMPORT_MOVED", exact: true), s => s.Severity == "normalized");
    }

    [Fact]
    public void TheReceiptListsTheExposedActionsByScreen()
    {
        var messages = new[] { Anonymous("m1", "Produtos", "GetProducts"), Anonymous("m2", "Produtos", "GetCategories") };
        var declared = Footprint("Produtos") with { AnonymousIntent = new HashSet<string> { "Produtos-key" } };
        var policy = MessageExpectations.Evaluate(messages, [], null, declared);
        var fields = typeof(ModelSession).GetMethod("ReceiptFields")!;
        Assert.NotNull(fields);
        // ReceiptFields reads only the verdicts: a session is not needed for the shape (checked in the ODC lane end to end).
        var exposure = policy.Verdicts.Where(v => v.Reason == MessageExpectations.AnonymousDeclaredReason).Select(v => v.Path.Split(" / ")[^1]).Order(StringComparer.Ordinal).ToArray();
        Assert.Equal(["GetCategories (ServerAction)", "GetProducts (ServerAction)"], exposure);
    }
}
