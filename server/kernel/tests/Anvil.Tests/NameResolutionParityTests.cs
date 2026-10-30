using System.Text.Json.Nodes;
using Anvil.Core.Preflight;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// R2-A (2026-10-29): the parity of the preflight and the apply over one table of synthetic cases. Each row is resolved by both
/// sides of a job with their own source over the same module (NameResolutionFixture): the preflight from the module index
/// (ScopeRules.ResolveCall over IndexBaseFacts; the page's event from the static check's candidates), the apply from the model
/// (NameResolution.ModelCall over the callables Verbs.Flow gathers; the page's event from ScreenHtmlModule.Destination, the
/// rule of the html edit). Both must give the same outcome and the same forms: the element resolved (and whether its form is
/// the canonical one the text must write), or the candidates of the refusal. The entry points of a job are
/// NameResolutionEntryTests.
/// </summary>
public sealed class NameResolutionParityTests
{
    public static TheoryData<string, string?, NameOutcome, string> Calls => new()
    {
        // written, owner, outcome, the form resolved (Resolved) or the candidates of the refusal (sorted, comma-separated)
        { "Charge", null, NameOutcome.Resolved, "Billing_CS.Charge" },          // a producer's action without its producer, the only one
        { "Invoice", null, NameOutcome.Resolved, "Billing_CS.Invoice" },        // the module's Invoice is a screen: no call
        { "Pay", null, NameOutcome.Resolved, "Pay" },                           // the same action in the module and in a producer
        { "Billing_CS.Pay", null, NameOutcome.Resolved, "Billing_CS.Pay" },
        { "Save", "Home", NameOutcome.Resolved, "Save" },                       // a screen action of the caller's own screen
        { "Refund", null, NameOutcome.Ambiguous, "Billing_CS.Refund,Ledger_CS.Refund" },   // two producers
        { "Ledger_CS.Charge", null, NameOutcome.Unknown, "" },                  // a structure: of another kind
        { "charge", null, NameOutcome.Resolved, "Billing_CS.Charge" },          // another case: the element's name
        { "pay", null, NameOutcome.Resolved, "Pay" },
        { "billing_cs.charge", null, NameOutcome.Resolved, "Billing_CS.Charge" },
    };

    private static ScopeRules.Callables Index(JsonArray? ops = null)
    {
        ops ??= new JsonArray();
        return ScopeRules.Known(NameResolutionEntryTests.Facts(ops), ScopeJob.Of(ops), ops, "o11");
    }

    private static NameAnswer Model(string written, string? owner, JsonArray? ops = null)
    {
        var reader = new NameResolutionFixture.Reader();
        var module = NameResolutionFixture.Module();
        return NameResolution.ModelCall(reader, NameResolution.ModelCallables(reader, module).ToList(), written, owner, ScopeJob.DeclaredActions(ops ?? new JsonArray()));
    }

    // The review's blocker, in the table: an action the job declares and the model does not hold yet (a screen action of Home
    // named like the producers' Refund) is what a call of that name from Home reaches, on both sides.
    [Fact]
    public void AnActionTheJobDeclaresIsACandidateOnBothSidesBeforeItExists()
    {
        var ops = NameResolutionEntryTests.Ops("/// x.\naction Home.Refund\n  end\n", "/// y.\naction Home.Probe\n  Refund()\n  end\n");
        var preflight = ScopeRules.ResolveCall("Refund", "Home", Index(ops));
        var apply = Model("Refund", "Home", ops);
        Assert.Equal(NameOutcome.Resolved, preflight.Outcome);
        Assert.Equal(NameOutcome.Resolved, apply.Outcome);
        Assert.Equal(("Refund", 0, false), (preflight.Chosen!.Canonical, preflight.Chosen.Tier, preflight.Canonicalized));
        Assert.Equal(("Refund", 0, false), (apply.Chosen!.Canonical, apply.Chosen.Tier, apply.Canonicalized));
        // From another owner it is not a candidate: the producers' two answer, on both sides.
        Assert.Equal(NameOutcome.Ambiguous, ScopeRules.ResolveCall("Refund", "Dashboard", Index(ops)).Outcome);
        Assert.Equal(NameOutcome.Ambiguous, Model("Refund", "Dashboard", ops).Outcome);
    }

    private static string Forms(NameAnswer answer) => answer.Outcome == NameOutcome.Resolved ? answer.Chosen!.Canonical
        : answer.Outcome == NameOutcome.Ambiguous ? string.Join(",", answer.Candidates.Select(c => c.Canonical).Order(StringComparer.Ordinal)) : "";

    [Theory]
    [MemberData(nameof(Calls))]
    public void ACallResolvesTheSameInThePreflightAndInTheApply(string written, string? owner, NameOutcome outcome, string forms)
    {
        var preflight = ScopeRules.ResolveCall(written, owner, Index());
        var apply = Model(written, owner);
        Assert.Equal(outcome, preflight.Outcome);
        Assert.Equal(outcome, apply.Outcome);
        Assert.Equal(forms, Forms(preflight));
        Assert.Equal(forms, Forms(apply));
        Assert.Equal(preflight.Canonicalized, apply.Canonicalized);
        Assert.Equal(written != forms && outcome == NameOutcome.Resolved, apply.Canonicalized);
    }

    [Fact]
    public void ANameNothingHasIsRefusedByBothWithTheSameNearestForms()
    {
        var preflight = ScopeRules.ResolveCall("Chargee", null, Index());
        var apply = Model("Chargee", null);
        Assert.Equal(NameOutcome.Unknown, preflight.Outcome);
        Assert.Equal(NameOutcome.Unknown, apply.Outcome);
        Assert.Equal("Billing_CS.Charge", preflight.Candidates[0].Canonical);
        Assert.Equal(preflight.Candidates.Select(c => c.Canonical), apply.Candidates.Select(c => c.Canonical));
        // The scope rule's refusal says the same (with each one's patch: NameResolutionEntryTests).
        Assert.Contains("Billing_CS.Charge", ScopeRules.Resolve("Chargee", null, Index())!.Candidates);
    }

    [Fact]
    public void AnElementOfAnotherKindOfThatNameIsSaidInBoth()
    {
        var preflight = ScopeRules.ResolveCall("Ledger_CS.Charge", null, Index());
        var apply = Model("Ledger_CS.Charge", null);
        // The model's callables hold no structure, so the apply has nothing of that name; the preflight sees the structure as
        // unfit. Both refuse.
        Assert.Equal(NameOutcome.Unknown, apply.Outcome);
        Assert.Equal("StructureSignature Ledger_CS.Charge", NameResolution.Describe(Assert.Single(preflight.Unfit)));
    }

    // ---- the destination of an event --------------------------------------------------------------------------------------

    public static TheoryData<string, NameOutcome, string> Events => new()
    {
        { "Dashboard", NameOutcome.Resolved, "MobileScreen:Dashboard" },        // a screen beside a nearer output parameter of its name
        { "Save", NameOutcome.Resolved, "Save" },                               // a screen action of the page
        { "Statement", NameOutcome.Ambiguous, "MobileScreenSignature:Billing_CS.Statement,MobileScreenSignature:Ledger_CS.Statement" },
        { "Report", NameOutcome.Unknown, "" },                                  // a server action: no event destination
    };

    [Theory]
    [MemberData(nameof(Events))]
    public void AnEventDestinationResolvesTheSameInThePreflightAndInTheApply(string written, NameOutcome outcome, string forms)
    {
        var reading = ScreenHtml.Module(NameResolutionFixture.Module(), new NameResolutionFixture.Reader());
        var apply = reading.Destination(written, reading.ScopeOf("Home"));
        Assert.Equal(outcome, apply.Outcome);
        Assert.Equal(forms, apply.Outcome == NameOutcome.Resolved ? apply.Chosen!.Canonical
            : apply.Outcome == NameOutcome.Ambiguous ? string.Join(",", apply.Candidates.Select(c => c.Kind + ":" + c.Qualifier + "." + c.Name).Order(StringComparer.Ordinal)) : "");
        // The static check of a document of the module that writes the same event: the same outcome.
        var html = "<screen name=\"Overview\"><a onclick=\"" + written + "\">x</a></screen>";
        var found = StaticChecks.Run(new JsonArray(new JsonObject { ["op"] = "html", ["data"] = new JsonObject { ["html"] = html } }), "/ops", "o11",
            new StaticBasis { Lane = "o11", Module = ModuleIndex.Build(NameResolutionFixture.Module(), new NameResolutionFixture.Reader(), "App_UI", "o11", "kernel", new string('d', 64), 1000), Fresh = true });
        var named = found.Problems.Concat(found.Warnings).Where(p => p["code"]?.ToString() is "HTML_NAME_UNKNOWN" or "HTML_NAME_AMBIGUOUS").ToList();
        // Save is a screen action of Home, not of the new screen Overview: the static check refuses it there (the apply's scope is Home).
        if (written == "Save") return;
        switch (outcome)
        {
            case NameOutcome.Resolved: Assert.Empty(named); break;
            case NameOutcome.Ambiguous:
                Assert.Equal(forms, string.Join(",", Assert.Single(named)["candidates"]!.AsArray().Select(c => c!.ToString()).Order(StringComparer.Ordinal)));
                break;
            default: Assert.Equal("HTML_NAME_UNKNOWN", Assert.Single(named)["code"]!.ToString()); break;
        }
    }

}
