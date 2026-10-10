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
