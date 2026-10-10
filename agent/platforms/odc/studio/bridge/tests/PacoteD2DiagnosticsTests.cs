using Xunit;
using Node = MergeDiagnostics.ModelNode;

// Pacote D2 (C16.3, C16.4, C08): the bridge's answers name what they saw. The author refusal shows the observed developer,
// tenant and user next to the expected ones; an uncertain merge lists one line per divergence and no .NET stack trace; a
// validation message carries its owner and the nearest ancestor ssam_map and studio_inspect address by @key.
public sealed class PacoteD2DiagnosticsTests {
    [Fact]
    public void TheAuthorRefusalShowsTheObservedIdentityNextToTheExpectedOne() {
        var text = MergeDiagnostics.AuthorMismatch("dev@example.com", "tenant-a.example.dev", "other@example.com", "tenant-b.example.dev", "other@example.com", true,
            new[] { "tenant-a.example.dev (signed out)", "tenant-b.example.dev" });
        Assert.StartsWith("Authenticated author mismatch: expected dev@example.com on tenant-a.example.dev", text);
        Assert.Contains("observed developerId other@example.com", text);
        Assert.Contains("tenant tenant-b.example.dev", text);
        Assert.Contains("user other@example.com", text);
        Assert.Contains("logged in true", text);
        Assert.Contains("Studio sessions: tenant-a.example.dev (signed out), tenant-b.example.dev", text);
        Assert.Contains("sign in to tenant-a.example.dev", text);
        // The journal still classifies it as the authorship gate (shared/Journal.cs looks for "author").
        Assert.Contains("author", text);
    }

    [Fact]
    public void AnEmptyObservedDeveloperSaysTheSessionDoesNotAnswerTheAuthor() {
        var text = MergeDiagnostics.AuthorMismatch("dev@example.com", "tenant-a.example.dev", null, "tenant-a.example.dev", null, false);
        Assert.Contains("observed developerId (none)", text);
        Assert.Contains("user (none)", text);
        Assert.Contains("logged in false", text);
        Assert.Contains("does not answer the snapshot author", text);
        var same = MergeDiagnostics.AuthorMismatch("dev@example.com", "tenant-a.example.dev", "x@example.com", "tenant-a.example.dev", "x@example.com", true);
        Assert.Contains("deliver again from a new snapshot", same);
    }

    [Fact]
    public void AnAnswerNeverCarriesAStackTrace() {
        Exception thrown;
        try { throw new InvalidOperationException("Native object differs from the candidate: x"); } catch (Exception e) { thrown = e; }
        Assert.Contains("   at ", thrown.ToString());
        Assert.Equal("Native object differs from the candidate: x", MergeDiagnostics.Answer(thrown));
        var withStack = "System.InvalidOperationException: boom\r\n   at A.B() in C:\\x.cs:line 1\r\n--- End of stack trace from previous location ---\r\n   at C.D()";
        Assert.Equal("System.InvalidOperationException: boom", MergeDiagnostics.WithoutStack(withStack));
    }

    [Fact]
    public void AnUncertainMergeListsOneLinePerDivergenceWithoutAStackTrace() {
        var divergences = new[] {
            new NativeMergeVerification.Divergence("MainFlow/Board/LoadWeek/Refresh GetPeople", "Refresh Data", "Max. Records", "50", "200"),
            new NativeMergeVerification.Divergence("MainFlow/Board/LoadWeek/Copy", "Assign", null, "present", "absent"),
        };
        var error = new MergeDiagnostics.MergeUncertainException("Native object differs from the candidate: |    +-- (Object Refresh Data) Refresh GetPeople [ChangedInLocal]\r\n   at NativeMergeVerification.Require()", divergences);
        Assert.Equal("Native object differs from the candidate: |    +-- (Object Refresh Data) Refresh GetPeople [ChangedInLocal]", error.Message);
        var lines = error.Detailed.Split('\n');
        Assert.Equal("MainFlow/Board/LoadWeek/Refresh GetPeople (Refresh Data): Max. Records local '50' / candidate '200'", lines[1]);
        Assert.Equal("MainFlow/Board/LoadWeek/Copy (Assign): element present in the module, absent in the candidate", lines[2]);
        Assert.DoesNotContain("   at ", error.Detailed);
        // G-3 (package 3): the closing line says the merge is integrated whenever it says never repeat.
        Assert.Contains("already integrated", lines[^1]); Assert.Contains("never repeat", lines[^1]);
        // The divergences come from the dump itself, so an old evidence folder gives the same lines.
        Assert.Equal(divergences[0], NativeMergeVerification.Divergences("(Object App) A [DifferenceInLocalMergeUnit]\r\n+-- (Folder) UI Flows\r\n|    |\r\n|    +-- (Object UI Flow) MainFlow [DifferenceInLocalMergeUnit]\r\n|    |    |\r\n|    |    +-- (Object Screen) Board [DifferenceInLocalMergeUnit]\r\n|    |    |    |\r\n|    |    |    +-- (Object Client Action) LoadWeek [DifferenceInLocalChildren]\r\n|    |    |    |    |\r\n|    |    |    |    +-- (Object Refresh Data) Refresh GetPeople [ChangedInLocal]\r\n|    |    |    |    |    |         >> Max. Records[50] / Max. Records[200] [ChangedInLocal]\r\n")[0]);
    }

    [Fact]
    public void TheNearestAddressableAncestorIsTheOwnerOrItsFirstKeyedNamedParent() {
        // An expression owned by an assignment inside a server action: the expression has a composite key, the assign is addressable.
        var chain = new[] {
            new Node("k-assign/Value", "ParsedExpression", "Total + 1"),
            new Node("k-assign", "Assign", "Sum"),
            new Node("k-action", "ServerAction", "Compute"),
            new Node("k-module", "ESpace", "Sample"),
        };
        var at = MergeDiagnostics.Locate(chain);
        Assert.Equal("k-assign/Value", at.OwnerKey);
        Assert.Equal("ServerAction:Compute/Assign:Sum/ParsedExpression:Total + 1", at.OwnerPath);
        Assert.Equal("k-assign", at.AddressableKey);
        Assert.Equal("ServerAction:Compute/Assign:Sum", at.AddressablePath);
        // An addressable owner is its own address.
        var own = MergeDiagnostics.Locate(chain.Skip(1).ToArray());
        Assert.Equal("k-assign", own.AddressableKey);
        Assert.Equal(own.OwnerPath, own.AddressablePath);
        // Unnamed or unkeyed ancestors are skipped; the module itself is never the answer.
        var none = MergeDiagnostics.Locate(new[] { new Node(null, "CustomProperty", "GridColumns"), new Node("k-w", "Container", null), new Node("k-module", "ESpace", "Sample") });
        Assert.Null(none.AddressableKey);
        Assert.Null(none.AddressablePath);
        Assert.False(MergeDiagnostics.IsAddressable(new Node("a b", "Assign", "x")));
    }
}
