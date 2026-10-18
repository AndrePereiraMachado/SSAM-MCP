using System.Text;
using System.Text.RegularExpressions;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// fix-ext-refs (2026-10-16, PMAI_Report_CS + PMAI_Report_Ext): every model mutation the bridge runs inside the Service
/// Studio happens inside a Studio command the bridge opened itself (QuietCommand.Execute), on the thread that opened it,
/// or inside one of the Studio's own command entry points. Two incident classes are refused by source, family-wide:
/// (1) the merge editor's apply helper CompareAndMergeCommands.Merge (built for the UI thread of the merge dialog: it runs
/// tree.Merge inside a nested very slow operation and ends the command's cleanup in the middle of the command); the live
/// signature merge failed there with "No command is open. The model cannot be changed outside the scope of a command!";
/// (2) a raw mutation (MatchTree.Merge, the signature selection, Manage Dependencies checks and commit, a ReferenceHash
/// assignment) that is not lexically inside a command opened in the same file. A raw Command.Execute is refused as well
/// (fam-deps R1: an exception that leaves a Studio command opens the modal "Unexpected Error").
/// Review A2 (round 2), what the rule guarantees and no more: it is lexical, over every .cs of the bridge (subfolders too)
/// and ManageDependencies.cs. It sees the forms it names: Command.Execute however qualified (global::, namespaces); the
/// mutations MatchTree.Merge(), MergeInCurrentCommand(Staged), ApplySelection, SetIsChecked, CommitRefreshReferences, a
/// ReferenceHash assignment, a Delete() call, a property write on a variable named like a module or a reference
/// (module.Name = ...), and a method group of one of them passed as an argument; a scope is only QuietCommand.Execute or
/// StudioAdapter.Runtime.Mutate; inside a scope a thread hop (Task.Run, Task.Factory, ThreadPool, new Thread,
/// Dispatcher.*Invoke*, BeginInvoke, ExecuteInContext, DoSlowOperation) is refused, because the command is open on the
/// thread that opened it only. A mutation reached through a helper method called from a scope, or through reflection,
/// is outside what a lexical rule sees.
/// Pure: reads the sources, no Studio.
/// </summary>
public sealed class BridgeCommandScopeTests
{
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(BridgeCommandScopeTests).Assembly.Location)!)!;

    /// <summary>The code that runs inside the Studio: the bridge, and the Manage Dependencies it runs (Adapters.SS11).</summary>
    private static IEnumerable<string> StudioSideSources()
    {
        var bridge = Path.Combine(Root, "src", "Anvil.Bridge");
        foreach (var file in Directory.EnumerateFiles(bridge, "*.cs", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(bridge, file).Replace('\\', '/');
            if (relative.StartsWith("bin/", StringComparison.Ordinal) || relative.StartsWith("obj/", StringComparison.Ordinal)) continue;
            yield return file;
        }
        var manage = Path.Combine(Root, "src", "Anvil.Core", "Adapters.SS11", "ManageDependencies.cs");
        if (File.Exists(manage)) yield return manage;
    }

    /// <summary>servidor/fase4-26 a7, rule D of the merge: the server line keeps kernel/src/Anvil.Bridge with the bytes of the
    /// agent pack's bridge (the thin bridge links six of its files and refuses Anvil.Core), so fix-ext-refs (the signature merge
    /// inside QuietCommand, tree.Merge on the command's thread) is not in it: these three violations of its MergeHandler.cs are
    /// the known gap, the same in the thin bridge of the pack (C:\t\vps-a7\LINHA.md). Each must still be there (the line drops
    /// it when it takes the fix with a new agent pack); any other violation fails as in the product.</summary>
    private static readonly string[] KeptByTheServerLine = [
        "MergeHandler.cs: line 231: a raw Command.Execute",
        "MergeHandler.cs: line 233: ReferenceSignatureMerge.MergeInCurrentCommand outside a command",
        "MergeHandler.cs: line 236: CompareAndMergeCommands.Merge",
    ];

    [Fact]
    public void EveryModelMutationOfTheBridgeRunsInsideAStudioCommandItOpened()
    {
        var violations = new List<string>();
        foreach (var file in StudioSideSources())
            violations.AddRange(CommandScope.Violations(File.ReadAllText(file)).Select(v => Path.GetFileName(file) + ": " + v));
        foreach (var kept in KeptByTheServerLine) Assert.Contains(violations, v => v.StartsWith(kept, StringComparison.Ordinal));
        violations.RemoveAll(v => KeptByTheServerLine.Any(kept => v.StartsWith(kept, StringComparison.Ordinal)));
        Assert.True(violations.Count == 0, "Model mutations outside a Studio command the bridge opened:\n" + string.Join("\n", violations));
    }

    [Fact]
    public void TheScannerSeesAMutationOutsideACommandAndAcceptsOneInside()
    {
        Assert.Single(CommandScope.Violations("void A(MatchTree tree) { tree.Merge(); }"));
        Assert.Empty(CommandScope.Violations("void A(MatchTree tree) { var f = QuietCommand.Execute(ctx, \"d\", stage => { tree.Merge(); }); }"));
        Assert.Single(CommandScope.Violations("void A() { CompareAndMergeCommands.Merge(aggregator, tree); }"));
        Assert.Single(CommandScope.Violations("void A() { QuietCommand.Execute(ctx, \"d\", s => { CompareAndMergeCommands.Merge(aggregator, tree); }); }"));
        // A raw Command.Execute is refused, and it is no scope for the mutation it holds: both are named.
        Assert.Equal(2, CommandScope.Violations("void A() { Command.Execute(ctx, \"d\", () => { tree.Merge(); }); }").Count);
        Assert.Equal(2, CommandScope.Violations("void A() { rm.SetIsChecked(match, true); rm.CommitRefreshReferences(\"x\"); }").Count);
        Assert.Single(CommandScope.Violations("void A() { reference.ReferenceHash = Guid.Empty; }"));
        Assert.Empty(CommandScope.Violations("void A() { if (reference.ReferenceHash == other) return; }"));
        // Comments and strings never count: the bridge documents the native helpers it does not call.
        Assert.Empty(CommandScope.Violations("// CompareAndMergeCommands.Merge(aggregator, tree) is never called\nvar s = \"tree.Merge()\";"));
    }

    [Fact]
    public void TheScannerSeesTheFormsTheReviewPlanted()
    {
        // Review A2: a qualified raw Command.Execute (P1, P2), each also leaving its mutation outside any scope.
        Assert.Equal(2, CommandScope.Violations("void A() { ServiceStudio.Commands.Command.Execute(ctx, \"d\", () => { tree.Merge(); }); }").Count);
        Assert.Equal(2, CommandScope.Violations("void A() { global::ServiceStudio.Commands.Command.Execute(ctx, \"d\", () => { tree.Merge(); }); }").Count);
        // P3, P4: a reference deleted and a module property written outside a command.
        Assert.Single(CommandScope.Violations("void A() { reference.Delete(); }"));
        Assert.Single(CommandScope.Violations("void A() { module.Name = \"x\"; }"));
        Assert.Empty(CommandScope.Violations("void A() { QuietCommand.Execute(ctx, \"d\", s => { module.Name = \"x\"; reference.Delete(); }); }"));
        // P5: a thread hop inside the command: the command is open on its own thread only.
        Assert.Single(CommandScope.Violations("void A() { QuietCommand.Execute(ctx, \"d\", s => { Task.Run(() => tree.Merge()); }); }"));
        Assert.Single(CommandScope.Violations("void A() { QuietCommand.Execute(ctx, \"d\", s => { aggregator.ExecuteInContext(() => tree.Merge()); }); }"));
        Assert.Single(CommandScope.Violations("void A() { QuietCommand.Execute(ctx, \"d\", s => { Dispatcher.UIThread.InvokeAsync(() => tree.Merge()); }); }"));
        // P8: a method group of a mutation hides its call site.
        Assert.Single(CommandScope.Violations("void A() { Run(tree.Merge); }"));
        Assert.Single(CommandScope.Violations("void A() { Run(manager.CommitRefreshReferences); }"));
        // P12: only the bridge's own command opens a scope; any other Mutate does not.
        Assert.Single(CommandScope.Violations("void A() { list.Mutate(x => tree.Merge()); }"));
        Assert.Empty(CommandScope.Violations("void A() { StudioAdapter.Runtime.Mutate(copy, \"d\", _ => tree.Merge()); }"));
        // The thread hops the bridge uses outside a command stay allowed (its handlers queue work on the tab that way).
        Assert.Empty(CommandScope.Violations("void A() { var q = aggregator.ExecuteInContext(() => { QuietCommand.Execute(ctx, \"d\", s => { tree.Merge(); }); }); _ = Task.Run(() => Wait()); }"));
        // An enum member named Merge is no method group.
        Assert.Empty(CommandScope.Violations("void A() { var r = MergeOperationResult.Merge; if (r is MergeOperationResult.Merge or MergeOperationResult.MergeAndPublish) { } }"));
    }

    /// <summary>The lexical rule, on source text without comments and string contents.</summary>
    internal static class CommandScope
    {
        private static readonly (Regex Pattern, string Why)[] Forbidden =
        [
            (new Regex(@"\bCompareAndMergeCommands\s*\.\s*Merge\s*\("), "CompareAndMergeCommands.Merge (the merge editor's apply helper; merge the tree inside the bridge's own command)"),
            (new Regex(@"\bDoVerySlowOperation\s*\("), "DoVerySlowOperation inside the Studio side (model writes from a slow operation)"),
            (new Regex(@"\bDoSlowOperation\s*\("), "DoSlowOperation inside the Studio side"),
            // Review A2: however qualified (ServiceStudio.Commands.Command, global::...); QuietCommand is its own word.
            (new Regex(@"\bCommand\s*\.\s*Execute\s*\("), "a raw Command.Execute (fam-deps R1: QuietCommand.Execute)"),
            // Review A2 (P8): a method group of a mutation passed as an argument hides where it runs.
            (new Regex(@"\.\s*(?:Merge|CommitRefreshReferences|SetIsChecked|ApplySelection|MergeInCurrentCommand(?:Staged)?)\s*(?=[,)])"), "a method group of a model mutation (call it inside QuietCommand.Execute)"),
        ];
        private static readonly (Regex Pattern, string What)[] Mutations =
        [
            (new Regex(@"\.\s*Merge\s*\(\s*\)"), "MatchTree.Merge()"),
            (new Regex(@"\bMergeInCurrentCommand(Staged)?\s*\("), "ReferenceSignatureMerge.MergeInCurrentCommand"),
            (new Regex(@"\bApplySelection\s*\("), "ReferenceSignatureMerge.ApplySelection"),
            (new Regex(@"\.\s*SetIsChecked\s*\("), "ReferencesManager.SetIsChecked"),
            (new Regex(@"\.\s*CommitRefreshReferences\s*\("), "ReferencesManager.CommitRefreshReferences"),
            (new Regex(@"\.\s*ReferenceHash\s*=(?!=)"), "a ReferenceHash assignment"),
            // Review A2 (P3, P4): a model object deleted, a property of a module or a reference written.
            (new Regex(@"\.\s*Delete\s*\(\s*\)"), "a Delete() of a model object"),
            (new Regex(@"\b\w*(?:[Mm]odule|[Ee][Ss]pace|[Rr]eference)\s*\.\s*(?!ReferenceHash\b)\w+\s*=(?![=>])"), "a property write on a module or a reference"),
        ];
        // Review A2 (P12): only the bridge's own command opens a scope (QuietCommand.Execute, StudioAdapter.Runtime.Mutate).
        private static readonly Regex Openers = new(@"\bQuietCommand\s*\.\s*Execute\s*\(|\bRuntime\s*\.\s*Mutate\s*\(");
        // Review A2 (P5): inside a scope the command is open on the thread that opened it only.
        private static readonly Regex Hops = new(@"\bTask\s*\.\s*(?:Run|Factory)\b|\bThreadPool\s*\.|\bnew\s+Thread\s*\(|\bDispatcher\b[\w.\s]*\.\s*\w*Invoke\w*\s*\(|\.\s*BeginInvoke\s*\(|\bExecuteInContext\s*\(|\bDoSlowOperation\s*\(");

        public static List<string> Violations(string source)
        {
            var code = Strip(source);
            var violations = new List<string>();
            foreach (var (pattern, why) in Forbidden)
                foreach (Match m in pattern.Matches(code)) violations.Add("line " + Line(code, m.Index) + ": " + why);
            var scopes = new List<(int Open, int Close)>();
            foreach (Match opener in Openers.Matches(code))
            {
                var open = opener.Index + opener.Length - 1;
                scopes.Add((open, Close(code, open)));
            }
            foreach (var (pattern, what) in Mutations)
                foreach (Match m in pattern.Matches(code))
                    if (!scopes.Any(s => s.Open < m.Index && m.Index < s.Close))
                        violations.Add("line " + Line(code, m.Index) + ": " + what + " outside a command the bridge opened (QuietCommand.Execute)");
            foreach (Match m in Hops.Matches(code))
                if (scopes.Any(s => s.Open < m.Index && m.Index < s.Close))
                    violations.Add("line " + Line(code, m.Index) + ": a thread hop (" + m.Value.Trim() + ") inside a command the bridge opened: the command is open on its own thread only");
            return violations;
        }

        private static int Close(string code, int open)
        {
            var depth = 0;
            for (var i = open; i < code.Length; i++)
            {
                if (code[i] == '(') depth++;
                else if (code[i] == ')' && --depth == 0) return i;
            }
            return code.Length;
        }

        private static int Line(string code, int index) => code.Take(index).Count(c => c == '\n') + 1;

        /// <summary>Comments removed and string/char contents blanked (same length, so lines keep their numbers).</summary>
        public static string Strip(string source)
        {
            var output = new StringBuilder(source.Length);
            var i = 0;
            while (i < source.Length)
            {
                var c = source[i];
                if (c == '/' && i + 1 < source.Length && source[i + 1] == '/')
                {
                    while (i < source.Length && source[i] != '\n') { output.Append(' '); i++; }
                    continue;
                }
                if (c == '/' && i + 1 < source.Length && source[i + 1] == '*')
                {
                    while (i < source.Length && !(source[i] == '*' && i + 1 < source.Length && source[i + 1] == '/')) { output.Append(source[i] == '\n' ? '\n' : ' '); i++; }
                    if (i < source.Length) { output.Append("  "); i += 2; }
                    continue;
                }
                if (c == '"' || c == '\'')
                {
                    var verbatim = i > 0 && (source[i - 1] == '@' || (i > 1 && source[i - 1] == '$' && source[i - 2] == '@') || (source[i - 1] == '$' && i > 1 && source[i - 2] == '@'));
                    var quote = c;
                    output.Append(c); i++;
                    while (i < source.Length && source[i] != quote)
                    {
                        if (!verbatim && source[i] == '\\' && i + 1 < source.Length) { output.Append("  "); i += 2; continue; }
                        if (verbatim && source[i] == '"' && i + 1 < source.Length && source[i + 1] == '"') { output.Append("  "); i += 2; continue; }
                        output.Append(source[i] == '\n' ? '\n' : ' '); i++;
                    }
                    if (i < source.Length) { output.Append(quote); i++; }
                    continue;
                }
                output.Append(c); i++;
            }
            return output.ToString();
        }
    }
}
