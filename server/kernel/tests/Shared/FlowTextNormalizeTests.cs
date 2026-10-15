using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

// Linked into both test projects: the syntax of a ssam-flow/1 text a model sends (VisitaCerta_CS, 2026-10-12). Every line
// the grammar refuses comes in one refusal (FlowSyntaxException.Errors, the first the strict parse's message), and a text
// with one reading is normalized (FlowTextNormalizer) and each edit listed: a branch that falls through, a label after one
// space, an assignment one level shallower than its block, the read ids of a new action, a mapping that reads its list's
// Current, a sort written DESC. A text with two readings, or with another error, is never rewritten.
public sealed class FlowTextNormalizeTests
{
    private static string Lines(params string[] lines) => string.Join("\n", lines) + "\n";

    private static FlowSyntaxException Refused(string text)
    {
        var error = Assert.ThrowsAny<FormatException>(() => ModuleFlow.Read(text));
        return Assert.IsType<FlowSyntaxException>(error);
    }

    private static FlowItem Node(FlowItem action, Func<FlowItem, bool> test) => action.Items.Single(i => i.Role == "node" && test(i));

    // ---- every error, one refusal ------------------------------------------------------------------------------------------

    [Fact]
    public void EveryLineTheGrammarRefusesIsNamedFirstErrorFirst()
    {
        var text = Lines(
            "server action Many",
            "  in A: Integer",
            "  out B: Integer",
            "  assign B = (A + 1",
            "  X = Call(P=1",
            "  if A > 0:",
            "    raise Oops(\"no\"",
            "  end");
        var refused = Refused(text);
        Assert.Equal(3, refused.Errors.Count);
        Assert.StartsWith("line 4: ", refused.Errors[0]);
        Assert.StartsWith("line 5: ", refused.Errors[1]);
        Assert.StartsWith("line 7: ", refused.Errors[2]);
        Assert.Equal(refused.Errors[0], refused.Message);
        // The normalizer leaves a text with errors as it was written: nothing is guessed.
        var normalized = FlowTextNormalizer.Normalize(text);
        Assert.Equal(text, normalized.Text);
        Assert.Empty(normalized.Edits);
    }

    [Fact]
    public void ATextThatParsesIsReadAsBeforeAndOneErrorIsOneError()
    {
        var good = Lines("server action Fine", "  out B: Integer", "  assign B = 1", "  end");
        Assert.Equal("Fine", ModuleFlow.Read(good).Name);
        var one = Refused(Lines("server action One", "  out B: Integer", "  assign B = (1", "  end"));
        Assert.Single(one.Errors);
    }

    // ---- FLOW_BRANCH_FALLS_THROUGH ---------------------------------------------------------------------------------------

    // The second text of the session (GetWeatherForPlace, line 34): the true branch of the outer If ends after an inner If,
    // with no terminator; the next line is one level up.
    private static readonly string Nested = Lines(
        "server action Fall",
        "  in A: Boolean",
        "  in B: Boolean",
        "  out N: Integer",
        "  if A:",
        "    assign N = 1",
        "    if B:",
        "      assign N = 2",
        "      end",
        "  assign N = 3",
        "  end");

    // Re-check of 2026-10-12 (probes N25, N26, P6, P13, P14): a true branch that ends on an If with no false step, followed by
    // the outer If's false branch, reads two ways like any other: B false goes on to the outer If's false branch (`-> @j1`),
    // or a terminator was forgotten at the end of the outer branch, which ends B's false path (`end`). Whatever the inner true
    // branch does (a step then `end`, `end` alone, a jump), the engine never chooses: both readings come, each verified.
    [Fact]
    public void ABranchThatEndsOnAnIfWithoutAFalseStepHasTwoReadingsAndIsNeverRewritten()
    {
        var refused = Refused(Nested);
        Assert.Equal("line 10: expected a line at depth 2, found depth 1: assign N = 3", Assert.Single(refused.Errors));
        // The inner true branch ends alone, or jumps to a step after the outer If.
        var alone = Lines("server action Fall", "  in A: Boolean", "  in B: Boolean", "  out N: Integer", "  if A:", "    assign N = 1", "    if B:", "      end",
            "  assign N = 3", "  end");
        var jumps = Lines("server action Fall", "  in A: Boolean", "  in B: Boolean", "  out N: Integer", "  if A:", "    assign N = 1", "    if B:", "      -> @x1",
            "  assign N = 3", "  assign N = 4 @x1", "  end");
        foreach (var text in new[] { Nested, alone, jumps }) {
            var normalized = FlowTextNormalizer.Normalize(text);
            Assert.Equal(text, normalized.Text);
            Assert.Empty(normalized.Edits);
            Assert.Null(FlowTextNormalizer.Corrected(text));
            var two = Assert.Single(FlowTextNormalizer.Ambiguities(text));
            Assert.Contains("    -> @j1\n  assign N = 3 @j1\n", two.Through);
            Assert.Contains("    end\n  assign N = 3\n", two.Ends);
            // Through: B false (and A false) go on to the step after the block; ends: B false ends inside A's branch.
            var through = ModuleFlow.Read(two.Through);
            var ends = ModuleFlow.Read(two.Ends);
            Assert.Equal("j1", Node(through, n => n.Kind == "IfNode" && n.Prop("Condition") == "B").Edges["FalseTarget"]);
            Assert.Equal("EndNode", ends.Items.Single(n => n.Key == Node(ends, m => m.Kind == "IfNode" && m.Prop("Condition") == "B").Edges["FalseTarget"]).Kind);
        }
    }

    [Fact]
    public void ALoopBodyWithoutNextGoesBackToItsLoopAndAFlowWithoutEndEnds()
    {
        var text = Lines(
            "server action Loop",
            "  in L: Integer List",
            "  out N: Integer",
            "  foreach L:",
            "    if L.Current > 0:",
            "      assign N = N + L.Current",
            "      next",
            "    assign N = N + 1",
            "  assign N = N * 2");
        var normalized = FlowTextNormalizer.Normalize(text);
        Assert.Equal(Lines(
            "server action Loop",
            "  in L: Integer List",
            "  out N: Integer",
            "  foreach L:",
            "    if L.Current > 0:",
            "      assign N = N + L.Current",
            "      next",
            "    assign N = N + 1",
            "    next",
            "  assign N = N * 2",
            "  end"), normalized.Text);
        Assert.Equal(2, normalized.Edits.Count(e => e.Insert));
        // A branch whose last step is an If with no false step, at the end of a loop body or of the flow: one reading too.
        var guard = Lines(
            "server action Guard",
            "  in L: Integer List",
            "  out N: Integer",
            "  foreach L:",
            "    if L.Current > 0:",
            "      assign N = N + L.Current",
            "  if N > 9:",
            "    assign N = 9");
        Assert.Equal(Lines(
            "server action Guard",
            "  in L: Integer List",
            "  out N: Integer",
            "  foreach L:",
            "    if L.Current > 0:",
            "      assign N = N + L.Current",
            "      next",
            "    next",
            "  if N > 9:",
            "    assign N = 9",
            "    -> @j1",
            "  end @j1"), FlowTextNormalizer.Normalize(guard).Text);
    }

    // Review of 2026-10-12 (probe 13): an If whose true branch ends on a step before the lines that follow the If (its false
    // branch) reads two ways: the branch goes on to the false branch, or a terminator was forgotten (an if/else). The engine
    // never chooses: the text is not rewritten and both readings come, each verified to remove the error (the line after the
    // branch, `-> @j1`, or `end`; `next` in a loop body).
    [Fact]
    public void AnIfElseWithoutATerminatorHasTwoReadingsAndIsNeverRewritten()
    {
        var text = Lines(
            "server action IfElse",
            "  in Found: Boolean",
            "  out Result: Text",
            "  if Found:",
            "    assign Result = \"yes\"",
            "  assign Result = \"no\"",
            "  end");
        Assert.Equal("line 6: expected a line at depth 2, found depth 1: assign Result = \"no\"", Assert.Single(Refused(text).Errors));
        var normalized = FlowTextNormalizer.Normalize(text);
        Assert.Equal(text, normalized.Text);
        Assert.Empty(normalized.Edits);
        Assert.Null(FlowTextNormalizer.Corrected(text));
        var two = Assert.Single(FlowTextNormalizer.Ambiguities(text));
        Assert.Equal(6, two.Line);
        Assert.Contains("    assign Result = \"yes\"\n    -> @j1\n  assign Result = \"no\" @j1\n", two.Through);
        Assert.Contains("    assign Result = \"yes\"\n    end\n  assign Result = \"no\"\n", two.Ends);
        // Each reading is a text the grammar reads, and they say different things.
        var through = ModuleFlow.Read(two.Through);
        var ends = ModuleFlow.Read(two.Ends);
        Assert.Equal("j1", Node(through, n => n.Kind == "AssignNode" && n.Items.Any(a => a.Prop("Value") == "\"yes\"")).Edges["Target"]);
        Assert.Equal("EndNode", ends.Items.Single(n => n.Key == Node(ends, m => m.Kind == "AssignNode" && m.Items.Any(a => a.Prop("Value") == "\"yes\"")).Edges["Target"]).Kind);
        Assert.Contains("-> @j1", two.ThroughEdit);
        Assert.Contains("`    end` before line 6", two.EndsEdit);
        // Inside a loop body the other reading is `next`; a true branch whose false branch is `next` (or `end`) has one reading.
        var loop = Lines(
            "server action LoopElse",
            "  in L: Integer List",
            "  out N: Integer",
            "  foreach L:",
            "    if L.Current > 0:",
            "      assign N = N + L.Current",
            "    assign N = N + 1",
            "    next",
            "  end");
        Assert.Equal(loop, FlowTextNormalizer.Normalize(loop).Text);
        Assert.Contains("      next\n    assign N = N + 1\n", Assert.Single(FlowTextNormalizer.Ambiguities(loop)).Ends);
        var same = Lines(
            "server action Same",
            "  in A: Boolean",
            "  out N: Integer",
            "  if A:",
            "    assign N = 1",
            "  end");
        Assert.Equal(Lines("server action Same", "  in A: Boolean", "  out N: Integer", "  if A:", "    assign N = 1", "    -> @j1", "  end @j1"),
            FlowTextNormalizer.Normalize(same).Text);
    }

    [Fact]
    public void AnEmptyBranchIsNoFallThroughAndStaysAnError()
    {
        var text = Lines("server action Empty", "  in A: Boolean", "  out N: Integer", "  if A:", "  assign N = 3", "  end");
        Assert.NotEmpty(Refused(text).Errors);
        var normalized = FlowTextNormalizer.Normalize(text);
        Assert.Equal(text, normalized.Text);
        Assert.Empty(normalized.Edits);
    }

    [Fact]
    public void AFallThroughNextToAnotherErrorIsNotNormalizedAndBothAreNamed()
    {
        var text = Nested.Replace("  assign N = 3\n", "  assign N = (3\n");
        var refused = Refused(text);
        Assert.True(refused.Errors.Count >= 2, string.Join("\n", refused.Errors));
        Assert.Equal(text, FlowTextNormalizer.Normalize(text).Text);
    }

    // ---- FLOW_LABEL_SPACING, FLOW_ASSIGNMENT_INDENT -----------------------------------------------------------------------

    [Fact]
    public void ALabelAfterOneSpaceIsTheLabelAndADateLiteralIsNot()
    {
        var text = Lines(
            "server action Labels",
            "  in A: Boolean",
            "  out D: Date",
            "  assign # Prepare",
            "    D = #2020-01-02#",
            "  if A: # Check",
            "    end",
            "  assign D = #2021-03-04#",
            "  end");
        var normalized = FlowTextNormalizer.Normalize(text);
        Assert.Equal(text.Replace("assign # Prepare", "assign  # Prepare").Replace("if A: # Check", "if A:  # Check"), normalized.Text);
        Assert.Equal(2, normalized.Edits.Count(e => e.Rule == FlowTextEdit.LabelSpacing));
        var action = ModuleFlow.Read(normalized.Text);
        Assert.Contains(action.Items, n => n.Kind == "AssignNode" && n.Prop("Label") == "Prepare");
        Assert.Contains(action.Items, n => n.Kind == "AssignNode" && n.Items.Any(a => a.Prop("Value") == "#2021-03-04#"));
    }

    [Fact]
    public void AnAssignmentOneLevelShallowerThanItsBlockIsOfTheBlockButACallIsACall()
    {
        var text = Lines(
            "server action Slip",
            "  out R: Rec",
            "  assign",
            "    R.A = 1",
            "  R.B = Trim(\" x \")",
            "  Saved = CreateRec(Source=R)",
            "  end");
        var normalized = FlowTextNormalizer.Normalize(text);
        Assert.Equal(text.Replace("  R.B = Trim", "    R.B = Trim"), normalized.Text);
        var edit = Assert.Single(normalized.Edits);
        Assert.Equal(FlowTextEdit.AssignmentIndent, edit.Rule);
        var action = ModuleFlow.Read(normalized.Text);
        Assert.Equal(2, Node(action, n => n.Kind == "AssignNode").Items.Count(i => i.Role == "assignment"));
        Assert.Contains(action.Items, n => n.Kind == "Execute" && n.Name == "Saved");
        Assert.Equal(Lines("server action G", "  out T: Text", "  assign", "    T = \"a\"", "    T = Concat(T, \"b\")", "  end"),
            FlowTextNormalizer.Normalize(Lines("server action G", "  out T: Text", "  assign", "    T = \"a\"", "  T = Concat(T, \"b\")", "  end")).Text);
        // Re-check of 2026-10-12 (pure probe P3): a built-in function whose first argument is a comparison is no call with a
        // named argument; the line is a slipped assignment (one reading) and is indented into the block.
        Assert.Equal(Lines("server action P3", "  in A: Integer", "  out T: Text", "  assign", "    T = \"a\"", "    T = If(A=1, \"x\", \"y\")", "  end"),
            FlowTextNormalizer.Normalize(Lines("server action P3", "  in A: Integer", "  out T: Text", "  assign", "    T = \"a\"", "  T = If(A=1, \"x\", \"y\")", "  end")).Text);
    }

    // Review of 2026-10-12 (probes 14, 15 and C): a node line the grammar refuses (a space before a call's parenthesis, a typo
    // after FROM) also reads as an assignment; it is never taken as one, alone or next to another error (the verified patch of
    // the other edits never carries it): its FLOW_SYNTAX stays.
    [Fact]
    public void AMalformedNodeLineAfterAnAssignBlockIsNoSlippedAssignment()
    {
        // Re-check of 2026-10-12 (pure probes P1, P2, P2b): spaces around a named argument's `=`, and the keywords of a node line
        // in another case, are node lines too.
        foreach (var line in new[] { "  Created = CreateRec (Source=R)", "  Saved = (System).ListAppend(List=L, Element=R)  X", "  Q = aggregate FROM Rec WHER (Rec.A <> \"\") MAX 5",
                     "  J = JSONSerialize (R)", "  S = sql X", "  Created = CreateRec (Source = R)", "  Created = CreateRec(Source =R)  X",
                     "  J = jsonSerialize (R)" }) {
            var text = Lines("server action Malformed", "  out N: Integer", "  local R: Rec", "  local L: Rec List", "  assign", "    R.A = \"a\"", line, "  end");
            Assert.NotEmpty(Refused(text).Errors);
            var normalized = FlowTextNormalizer.Normalize(text);
            Assert.Equal(text, normalized.Text);
            Assert.DoesNotContain(normalized.Edits, e => e.Rule == FlowTextEdit.AssignmentIndent);
            Assert.Null(FlowTextNormalizer.Corrected(text));
        }
        // CX3 accepts aggregate keyword casing through the shape normalization, without changing its node into an assignment.
        foreach (var line in new[] { "  Q = aggregate from Rec WHERE (Rec.A <> \"\") MAX 5", "  Q = Aggregate FROM Rec WHERE (Rec.A <> \"\") MAX 5" }) {
            var text = Lines("server action Shape", "  out N: Integer", "  local R: Rec", "  assign", "    R.A = \"a\"", line, "  end");
            var normalized = FlowTextNormalizer.Normalize(text);
            var canonical = "  Q = aggregate FROM Rec WHERE (Rec.A <> \"\") MAX 5";
            Assert.Equal(text.Replace(line, canonical), normalized.Text);
            Assert.Equal(FlowTextEdit.AggregateSqlShape, Assert.Single(normalized.Edits).Rule);
            Assert.DoesNotContain(normalized.Edits, e => e.Rule == FlowTextEdit.AssignmentIndent);
            Assert.Contains(ModuleFlow.Read(normalized.Text).Items, n => n.Kind == "AggregateNode" && n.Name == "Q");
        }
        // Probe C: with another error, the certain edits are the patch, and the malformed call is not among them.
        var mixed = Lines("server action C", "  out N: Integer", "  local P: Rec", "  assign", "    P.Name = \"a\"", "  Created = CreateRec (Source=P)", "  assign N = (1", "  end");
        Assert.Equal(2, Refused(mixed).Errors.Count);
        Assert.Null(FlowTextNormalizer.Corrected(mixed));
    }

    // ---- FLOW_NEW_ACTION_IDS ---------------------------------------------------------------------------------------------

    [Fact]
    public void TheReadIdsOfANewActionLabelItsNewElementsAndAnEditKeepsThem()
    {
        var text = Lines(
            "server action Fresh",
            "  in A: Boolean",
            "  out N: Integer",
            "  if A:",
            "    assign N = 1",
            "    -> @n900",
            "  assign N = 2 @n900",
            "  end");
        var normalized = FlowTextNormalizer.Normalize(text);
        Assert.Equal(text.Replace("@n900", "@xn900"), normalized.Text);
        Assert.All(normalized.Edits, e => Assert.Equal(FlowTextEdit.NewActionIds, e.Rule));
        // An edit of a read (a header with @key) keeps its ids: they are the read's.
        var edit = text.Replace("server action Fresh", "server action Fresh @MrB+ndLCeEidaZwSA+2WWg");
        Assert.Equal(edit, FlowTextNormalizer.Normalize(edit).Text);
    }

    // ---- FLOW_MAPPING_RELATIVE, FLOW_SORT_DIRECTION ----------------------------------------------------------------------

    [Fact]
    public void AMappingOverAListReadsTheItemNotTheListsCurrent()
    {
        var text = Lines(
            "server action Map",
            "  out Rows: Row List",
            "  Q = aggregate FROM Ent WHERE (Ent.Qty > 0) SORT Ent.Qty DESC, Ent.Name ASC, Ent.Id MAX 10",
            "  assign Rows = Q.List mapTo { Id: Q.List.Current.Ent.Id, Name: Trim(Q.List.Current.Ent.Name) }",
            "  end");
        var normalized = FlowTextNormalizer.Normalize(text);
        // Review of 2026-10-12 (probe 5): a value that reads the list's Current inside an expression reads the item too; every
        // `Q.List.Current.` of the values goes, never the cursor left in place.
        Assert.Equal(Lines(
            "server action Map",
            "  out Rows: Row List",
            "  Q = aggregate FROM Ent WHERE (Ent.Qty > 0) SORT Ent.Qty desc, Ent.Name, Ent.Id MAX 10",
            "  assign Rows = Q.List mapTo { Id: Ent.Id, Name: Trim(Ent.Name) }",
            "  end"), normalized.Text);
        Assert.Contains(normalized.Edits, e => e.Rule == FlowTextEdit.MappingRelative);
        var sorts = Node(ModuleFlow.Read(normalized.Text), n => n.Kind == "AggregateNode").Items.Where(i => i.Role == "sort").ToList();
        Assert.Equal(new[] { "Ent.Qty", "Ent.Name", "Ent.Id" }, sorts.Select(s => s.Prop("Attribute") ?? "").ToArray());
        Assert.Equal("Descending", sorts[0].Prop("SortDirection"));

        var plain = text.Replace("Name: Trim(Q.List.Current.Ent.Name)", "Name: Q.List.Current.Ent.Name");
        var relative = FlowTextNormalizer.Normalize(plain);
        Assert.Contains("assign Rows = Q.List mapTo { Id: Ent.Id, Name: Ent.Name }", relative.Text);
        Assert.Contains(relative.Edits, e => e.Rule == FlowTextEdit.MappingRelative);
        Assert.Empty(FlowTextNormalizer.Cursors(relative.Text));
    }

    // Review of 2026-10-12 (probe 6 and the cursor that stays): the same mapping on two lines is written relative on both (the
    // lines of its nodes, not a text found once); a cursor inside a "text" is a text; a value that reads the item whole
    // (`Q.List.Current`) has no relative form and is named (FLOW_MAPPING_CURSOR); an edit of a read is the apply's.
    [Fact]
    public void EveryLineOfAMappingThatReadsItsListsCurrentIsWrittenRelativeOrNamed()
    {
        var mapping = "Q.List mapTo { Name: Q.List.Current.Ent.Name, Code: \"Q.List.Current.X\" + q.list.current.Ent.City }";
        var text = Lines(
            "server action Twice",
            "  out Rows: Row List",
            "  out Rows2: Row List",
            "  Q = aggregate FROM Ent MAX 10",
            "  assign Rows = " + mapping,
            "  assign",
            "    Rows2 = " + mapping,
            "  end");
        var normalized = FlowTextNormalizer.Normalize(text);
        var relative = "Q.List mapTo { Name: Ent.Name, Code: \"Q.List.Current.X\" + Ent.City }";
        Assert.Equal(text.Replace(mapping, relative), normalized.Text);
        Assert.Equal(2, normalized.Edits.Count(e => e.Rule == FlowTextEdit.MappingRelative));
        Assert.Empty(FlowTextNormalizer.Cursors(normalized.Text));

        var whole = Lines(
            "server action Whole",
            "  out Wraps: Wrap List",
            "  Q = aggregate FROM Ent MAX 10",
            "  assign Wraps = Q.List mapTo { Place: Q.List.Current, Note: Q.List.Current.Ent.Name }",
            "  end");
        Assert.Equal(whole, FlowTextNormalizer.Normalize(whole).Text);
        var (line, value, source) = Assert.Single(FlowTextNormalizer.Cursors(whole));
        Assert.Equal(4, line);
        Assert.Equal("Q.List", source);
        Assert.StartsWith("Q.List mapTo { Place: Q.List.Current,", value);

        var edit = text.Replace("server action Twice", "server action Twice @MrB+ndLCeEidaZwSA+2WWg");
        Assert.Equal(edit, FlowTextNormalizer.Normalize(edit).Text);
        Assert.Empty(FlowTextNormalizer.Cursors(edit));
    }

    // Review of 2026-10-12 (pure probes A, B and E): two bad assignments of one block are two errors; a line with an odd
    // indentation is one error, not one more for the line under it; a line the recovery meets twice is one error; the cases of
    // a Switch at the end of the flow end there.
    [Fact]
    public void EveryErrorOnceAndNoErrorTheRecoveryMade()
    {
        var two = Refused(Lines("server action A", "  out N: Integer", "  assign", "    N = (1", "    N = (2", "  end"));
        Assert.Equal(new[] { 4, 5 }, two.Errors.Select(e => FlowTextNormalizer.LineOf(e) ?? 0).ToArray());
        var odd = Refused(Lines("server action B", "  in A: Boolean", "  out N: Integer", "   if A:", "    assign N = 1", "    end", "  assign N = 2", "  end"));
        Assert.Equal("line 4: indentation must be a multiple of two spaces", Assert.Single(odd.Errors));
        var after = Refused(Lines("server action E", "  in K: Integer", "  out R: Text", "  switch:", "    case K = 1:", "      assign R = \"one\"",
            "    otherwise:", "      assign R = \"other\"", "  assign R = R + \"!\"", "  end"));
        Assert.Equal(after.Errors.Count, after.Errors.Select(e => FlowTextNormalizer.LineOf(e)).Distinct().Count());
        var cases = Lines("server action S", "  in K: Integer", "  out R: Text", "  switch:", "    case K = 1:", "      assign R = \"one\"",
            "    otherwise:", "      assign R = \"other\"");
        var ended = FlowTextNormalizer.Normalize(cases);
        Assert.Equal(Lines("server action S", "  in K: Integer", "  out R: Text", "  switch:", "    case K = 1:", "      assign R = \"one\"", "      -> @j1",
            "    otherwise:", "      assign R = \"other\"", "      end @j1"), ended.Text);
        Assert.All(ended.Edits, e => Assert.Equal(FlowTextEdit.FallsThrough, e.Rule));
    }

    [Fact]
    public void TheEditsApplyInOrderAndKeepTheLastLineBreak()
    {
        var edits = new List<FlowTextEdit> {
            new("R", 2, true, null, "  inserted", ""),
            new("R", 2, false, "b", "B", ""),
            new("R", 2, false, null, " @j1", ""),
            new("R", 4, true, null, "  end", "") };
        Assert.Equal("a\n  inserted\nB @j1\nc\n  end\n", FlowTextEdit.Apply("a\nb\nc\n", edits));
    }
}
