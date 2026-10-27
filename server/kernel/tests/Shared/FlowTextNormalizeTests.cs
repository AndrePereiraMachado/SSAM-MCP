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
        // in another case, are node lines too, never assignments of the block.
        foreach (var line in new[] { "  Saved = (System).ListAppend(List=L, Element=R)  X", "  Q = aggregate FROM Rec WHER (Rec.A <> \"\") MAX 5",
                     "  S = sql X", "  Created = CreateRec(Source =R)  X" }) {
            var text = Lines("server action Malformed", "  out N: Integer", "  local R: Rec", "  local L: Rec List", "  assign", "    R.A = \"a\"", line, "  end");
            Assert.NotEmpty(Refused(text).Errors);
            var normalized = FlowTextNormalizer.Normalize(text);
            Assert.Equal(text, normalized.Text);
            Assert.DoesNotContain(normalized.Edits, e => e.Rule == FlowTextEdit.AssignmentIndent);
            Assert.Null(FlowTextNormalizer.Corrected(text));
        }
        // R1 (24/10/2026): a space before the parenthesis or around a named argument's `=` has one reading, the node line in the
        // grammar's spelling (FLOW_ARGUMENT_SPACING); it stays a node, never an assignment of the block above.
        foreach (var (line, node) in new[] { ("  Created = CreateRec (Source=R)", "  Created = CreateRec(Source=R)"), ("  Created = CreateRec (Source = R)", "  Created = CreateRec(Source=R)"),
                     ("  J = JSONSerialize (R)", "  J = JSONSerialize(R)"), ("  J = jsonSerialize (R)", "  J = jsonSerialize(R)") }) {
            var text = Lines("server action Malformed", "  out N: Integer", "  local R: Rec", "  local L: Rec List", "  assign", "    R.A = \"a\"", line, "  end");
            Assert.NotEmpty(Refused(text).Errors);
            var normalized = FlowTextNormalizer.Normalize(text);
            Assert.Equal(text.Replace(line, node), normalized.Text);
            Assert.Equal(FlowTolerance.ArgumentSpacing, Assert.Single(normalized.Edits).Rule);
            Assert.DoesNotContain(ModuleFlow.Read(normalized.Text).Items.Single(n => n.Role == "node" && n.Kind == "AssignNode").Items, a => a.Prop("Variable") is "Created" or "J");
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
        // Probe C: with another error, the certain edits are the patch: the call in the grammar's spelling, still a node.
        var mixed = Lines("server action C", "  out N: Integer", "  local P: Rec", "  assign", "    P.Name = \"a\"", "  Created = CreateRec (Source=P)", "  assign N = (1", "  end");
        Assert.Equal(2, Refused(mixed).Errors.Count);
        var partial = FlowTextNormalizer.Corrected(mixed);
        Assert.NotNull(partial);
        Assert.Equal(mixed.Replace("CreateRec (Source=P)", "CreateRec(Source=P)"), partial!.Text);
        Assert.Equal([6], partial.Lines.Order());
        Assert.DoesNotContain(partial.Edits, e => e.Rule == FlowTextEdit.AssignmentIndent);
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

    // ---- R1 (24/10/2026): the shapes a model writes for a line with one reading (FlowTolerance) ----------------------------

    // The normalized text is the canonical one, line for line; each rewrite is listed with its rule; the canonical text reads,
    // prints and reads again as the same model (the fixed point of ModuleFlow.Check), and normalizing it again changes nothing.
    private static FlowTextNormalizer.Normalized Tolerated(string text, string expected, params string[] rules)
    {
        Assert.NotEmpty(Refused(text).Errors);
        var normalized = FlowTextNormalizer.Normalize(text);
        Assert.Equal(expected, normalized.Text);
        foreach (var rule in rules) Assert.Contains(normalized.Edits, e => e.Rule == rule);
        Assert.All(normalized.Edits.Where(e => rules.Contains(e.Rule) && e.Rule != FlowTextEdit.FallsThrough), e => Assert.StartsWith("line " + e.Line + ": ", e.Message));
        var action = ModuleFlow.Read(normalized.Text);
        var printed = ModuleFlow.Print(action);
        Assert.Null(ModuleFlow.Check(action, printed));
        Assert.Equal(action.Canon(), ModuleFlow.Read(printed.Text, printed.Keys).Canon());
        Assert.Empty(FlowTextNormalizer.Normalize(normalized.Text).Edits);
        return normalized;
    }

    private const string Head = "server action T\n  in A: Integer\n  in Price: Integer\n  out B: Integer\n  out Msg: Text\n  local L: Integer List\n";
    private static string Body(params string[] lines) => Head + string.Join("\n", lines) + "\n";

    public static IEnumerable<object[]> Separators() => new[] {
        // assign X=v and the spaces around the first `=` (never one inside the value, a text or the id).
        new object[] { "  assign B=Price*2", "  assign B = Price*2", FlowTolerance.AssignSpacing },
        ["  assign Msg=If(Price=1, \"a=b\", \"x\")  # pick @k1", "  assign Msg = If(Price=1, \"a=b\", \"x\")  # pick @k1", FlowTolerance.AssignSpacing],
        ["  assign B =A", "  assign B = A", FlowTolerance.AssignSpacing],
        ["  assign\n    B=Price\n    Msg =\"=\"", "  assign\n    B = Price\n    Msg = \"=\"", FlowTolerance.AssignSpacing],
        // A mapping without spaces after its commas (with another shape of the text: alone, the grammar already reads it).
        ["  assign Msg=L mapTo {Code: A,Total: Trim(\"a,b\")}", "  assign Msg = L mapTo { Code: A, Total: Trim(\"a,b\") }", FlowTolerance.MappingSpacing],
        ["  Twice(N=Price,M=L mapTo {Code: A,Total: B})", "  Twice(N=Price, M=L mapTo { Code: A, Total: B })", FlowTolerance.MappingSpacing],
        ["  (System).ListAppendAll(List = L,SourceList=L mapTo {Code: A,Total: B})", "  (System).ListAppendAll(List=L, SourceList=L mapTo { Code: A, Total: B })", FlowTolerance.MappingSpacing],
        // Result=Action(...) and the arguments of a call: a comma and one space, no space around a named argument's `=`.
        ["  Saved=Twice(N=Price)", "  Saved = Twice(N=Price)", FlowTolerance.ResultSpacing],
        ["  Saved = Twice(N=Price,M=2)", "  Saved = Twice(N=Price, M=2)", FlowTolerance.ArgumentSpacing],
        ["  Twice(N = Price, M = Price = 1)", "  Twice(N=Price, M=Price = 1)", FlowTolerance.ArgumentSpacing],
        ["  Twice(Price,N=\"a,b\")", "  Twice(Price, N=\"a,b\")", FlowTolerance.ArgumentSpacing],
        ["  (System).ListAppend(List = L,Element = A)", "  (System).ListAppend(List=L, Element=A)", FlowTolerance.ArgumentSpacing],
        ["  Saved=Twice (N = 1)  # twice", "  Saved = Twice(N=1)  # twice", FlowTolerance.ArgumentSpacing],
        // A label after one space; a #date# literal is no label.
        ["  assign B = Price # double it", "  assign B = Price  # double it", FlowTextEdit.LabelSpacing],
        ["  assign B = If(#2020-01-01# = CurrDate(), 1, 2) # a date", "  assign B = If(#2020-01-01# = CurrDate(), 1, 2)  # a date", FlowTextEdit.LabelSpacing],
    };

    [Theory]
    [MemberData(nameof(Separators))]
    public void ASeparatorWrittenAnotherWayIsTheGrammarsAndOnlyThat(string line, string canonical, string rule)
    {
        Tolerated(Body(line, "  end"), Body(canonical, "  end"), rule);
    }

    [Fact]
    public void ATerminatorWithoutItsParenthesesHasThem()
    {
        Tolerated(Body("  navigate Agenda"), Body("  navigate Agenda()"), FlowTolerance.NavigateArguments);
        Tolerated(Body("  navigate Detail (Id = A)  # open"), Body("  navigate Detail(Id=A)  # open"), FlowTolerance.ArgumentSpacing);
        Tolerated(Body("  raise Oops"), Body("  raise Oops()"), FlowTolerance.NavigateArguments);
        // An end right after a navigate (or raise) of its branch is no step.
        Tolerated(Body("  navigate Agenda()", "  end"), Body("  navigate Agenda()", ""), FlowTolerance.UnreachedEnd);
        // A navigate to a screen of another flow is not one of these shapes: refused as written.
        var other = Body("  navigate Morada/Search(Id=A)");
        Assert.Equal(other, FlowTextNormalizer.Normalize(other).Text);
    }

    [Fact]
    public void AnIndentationOfOneOrFourSpacesALevelIsTwo()
    {
        var two = Lines("server action U", "  in A: Integer", "  out B: Integer", "  if A > 0:", "    assign B = 1", "    end", "  assign B = 2", "  end");
        Tolerated(two.Replace("  ", " "), two, FlowTolerance.IndentUnit);
        Tolerated(two.Replace("  ", "    "), two, FlowTolerance.IndentUnit);
        // Two spaces a level, every line one space short (the corpus of the plan: 431 refusals of one shape).
        Tolerated(Lines("server action U", " in A: Integer", " out B: Integer", " if A > 0:", "   assign B = 1", "   end", " assign B = 2", " end"), two, FlowTolerance.IndentUnit);
        Tolerated(Lines("server action U", "   in A: Integer", "   out B: Integer", "   if A > 0:", "     assign B = 1", "     end", "   assign B = 2", "   end"), two, FlowTolerance.IndentUnit);
        // A body written at depth 0 under its header, and one step of the main flow at depth 0.
        Tolerated(Lines("server action U", "in A: Integer", "out B: Integer", "if A > 0:", "  assign B = 1", "  end", "assign B = 2", "end"), two, FlowTolerance.IndentUnit);
        Tolerated(two.Replace("  assign B = 2\n  end\n", "  assign B = 2\nend\n"), two, FlowTolerance.IndentUnit);
        // After a deeper line it could be a step of that branch: refused as written.
        var after = two.Replace("  assign B = 2", "assign B = 2");
        Assert.Equal(after, FlowTextNormalizer.Normalize(after).Text);
        // Inconsistent: a two-space action with one line at three spaces is refused, not read in another unit.
        var odd = two.Replace("    assign B = 1", "     assign B = 1");
        Assert.Equal(odd, FlowTextNormalizer.Normalize(odd).Text);
    }

    [Fact]
    public void ElseAtTheDepthOfItsIfIsTheFalseBranchBelowIt()
    {
        // At the end of the flow: the true branch ends.
        Tolerated(Body("  if A > 0:", "    assign B = 1", "  else:", "    assign B = 2"),
            Body("  if A > 0:", "    assign B = 1", "    end", "  assign B = 2", "  end"), FlowTolerance.Else, FlowTextEdit.FallsThrough);
        // Before a step: the true branch jumps to it (named @j1).
        Tolerated(Body("  if A > 0:", "    assign B = 1", "  else:", "    assign B = 2", "  assign B = B + 1", "  end"),
            Body("  if A > 0:", "    assign B = 1", "    -> @j1", "  assign B = 2", "  assign B = B + 1 @j1", "  end"), FlowTolerance.Else);
        Tolerated(Body("  if A > 0:", "    assign B = 1", "  otherwise:", "    assign B = 2", "  assign B = B + 1", "  end"),
            Body("  if A > 0:", "    assign B = 1", "    -> @j1", "  assign B = 2", "  assign B = B + 1 @j1", "  end"), FlowTolerance.Else);
        // In a loop: next.
        Tolerated(Body("  foreach L:", "    if L.Current > 0:", "      assign B = 1", "    else:", "      assign B = 2", "  end"),
            Body("  foreach L:", "    if L.Current > 0:", "      assign B = 1", "      next", "    assign B = 2", "    next", "  end"), FlowTolerance.Else);
        // A true branch that ends already: the false branch only moves.
        Tolerated(Body("  if A > 0:", "    raise Oops(\"x\")", "  else:", "    assign B = 2", "  end"),
            Body("  if A > 0:", "    raise Oops(\"x\")", "", "  assign B = 2", "  end"), FlowTolerance.Else);
        // An else in an else: both go on at the same step.
        Tolerated(Body("  if A > 0:", "    assign B = 1", "  else:", "    if A < -5:", "      assign B = 2", "    else:", "      assign B = 3", "  end"),
            Body("  if A > 0:", "    assign B = 1", "    -> @j1", "  if A < -5:", "    assign B = 2", "    -> @j1", "  assign B = 3", "  end @j1"), FlowTolerance.Else);
        // Where the if/else goes on is not certain (a case of a switch): refused, with the shape beside the line.
        var unsure = Body("  switch:", "    case A = 1:", "      if A > 0:", "        assign B = 1", "      else:", "        assign B = 2", "    otherwise:", "      assign B = 3", "      end");
        Assert.Equal(unsure, FlowTextNormalizer.Normalize(unsure).Text);
        Assert.Contains(Refused(unsure).Errors, e => e.Contains("write the false branch below the if", StringComparison.Ordinal));
    }

    [Fact]
    public void TheCasesOfASwitchAtItsDepthAreOneLevelIn()
    {
        Tolerated(Body("  switch:", "  case A = 1:", "    assign B = 1", "    end", "  otherwise:", "    assign B = 2", "    end"),
            Body("  switch:", "    case A = 1:", "      assign B = 1", "      end", "    otherwise:", "      assign B = 2", "      end"), FlowTolerance.SwitchIndent);
    }

    [Fact]
    public void ADeclarationAmongTheStepsGoesWithTheDeclarationsAndTheStepsKeepTheirOrder()
    {
        var text = Lines("server action D", "  in A: Integer", "  assign B = A", "  /// the total", "  out B: Integer", "  local T: Integer", "  assign T = B", "  end");
        var normalized = Tolerated(text, Lines("server action D", "  in A: Integer", "  /// the total", "  out B: Integer", "  local T: Integer", "  assign B = A", "  assign T = B", "  end"),
            FlowTolerance.DeclarationOrder);
        var steps = ModuleFlow.Read(normalized.Text).Items.Where(i => i.Role == "node" && i.Kind == "AssignNode").Select(n => n.Items[0].Prop("Variable")).ToList();
        Assert.Equal(["B", "T"], steps);
        Assert.Equal("the total", ModuleFlow.Read(normalized.Text).Items.Single(i => i.Role == "out").Prop("Description"));
    }

    [Fact]
    public void AnAggregateOverSeveralLinesIsOneLineAndASqlStatementIsCode()
    {
        var text = Body("  Rows = aggregate FROM Visita", "    JOIN Local ON Visita.LocalId = Local.Id", "    WHERE (Visita.A = A)", "    ORDER BY Visita.Data DESC", "    MAX 10", "  end");
        var normalized = FlowTextNormalizer.Normalize(text);
        Assert.Contains(normalized.Edits, e => e.Rule == FlowTolerance.LineContinuation);
        var aggregate = ModuleFlow.Read(normalized.Text).Items.Single(i => i.Role == "node" && i.Kind == "AggregateNode");
        Assert.Equal(["Local", "Visita"], aggregate.Items.Where(p => p.Role == "source").Select(p => p.Name).Order());
        Assert.Equal("Inner", aggregate.Items.Single(p => p.Role == "join").Prop("JoinType"));
        Assert.Equal("Descending", aggregate.Items.Single(p => p.Role == "sort").Prop("SortDirection"));
        Assert.Equal("10", aggregate.Prop("MaxRecords"));
        Assert.Contains("  Rows = aggregate FROM Visita, Local JOIN Inner Visita~Local ON Visita.LocalId = Local.Id WHERE (Visita.A = A) SORT Visita.Data desc MAX 10\n", normalized.Text);
        // The name of a column is `Name=value` in AGG and CALC (and GROUP BY).
        var columns = FlowTextNormalizer.Normalize(Body("  Rows = aggregate FROM Visita GROUP BY Visita.A AGG Total = Count(Visita.Id), Late = Sum(Visita.B) MAX 5", "  end"));
        Assert.Contains("  Rows = aggregate FROM Visita GROUP BY Visita.A AGG Total=Count(Visita.Id), Late=Sum(Visita.B) MAX 5\n", columns.Text);
        Assert.Contains(columns.Edits, e => e.Rule == FlowTextEdit.AggregateSqlShape);
        var sql = Tolerated(Body("  Total = sql -> ResumoRow max 1", "    in Id: Integer = A", "    SELECT COUNT(*)", "    FROM {Visita}", "      WHERE {Visita}.[Id] = @Id", "  end"),
            Body("  Total = sql -> ResumoRow max 1", "    in Id: Integer = A", "    | SELECT COUNT(*)", "    | FROM {Visita}", "    |   WHERE {Visita}.[Id] = @Id", "  end"), FlowTolerance.LineContinuation);
        Assert.Equal("SELECT COUNT(*)\nFROM {Visita}\n  WHERE {Visita}.[Id] = @Id", ModuleFlow.Read(sql.Text).Items.Single(i => i.Kind == "SQLNode").Prop("Statement"));
    }

    [Fact]
    public void AJumpByTheNameOfItsStepIsTheJumpToItsId()
    {
        Tolerated(Body("  if A > 0:", "    assign B = 1", "    -> Done", "  assign B = 2", "  Done = Twice(N=B)", "  end"),
            Body("  if A > 0:", "    assign B = 1", "    -> @j1", "  assign B = 2", "  Done = Twice(N=B) @j1", "  end"), FlowTolerance.JumpByName);
        // Two steps of the name: refused, with the shape beside the line.
        var two = Body("  if A > 0:", "    -> Done", "  Done = Twice(N=B)", "  Done = Twice(N=A)", "  end");
        Assert.Equal(two, FlowTextNormalizer.Normalize(two).Text);
        Assert.Contains(Refused(two).Errors, e => e.Contains("a jump names the id of the step it goes to", StringComparison.Ordinal));
    }

    [Fact]
    public void WhatHasNoCertainReadingStaysRefusedWithTheShapeBesideIt()
    {
        foreach (var line in new[] { "  assign B+1=2", "  assign B=", "  Twice(N=1+)" }) {
            var text = Body(line, "  end");
            Assert.Equal(text, FlowTextNormalizer.Normalize(text).Text);
        }
        var shapes = Refused(Body("  return B=1", "  while A > 0:", "    end", "  IEntityActionSignature:UpdateTicket(Source=B)", "  end")).Errors;
        // A return is a form of the general language now (R7, FLOW_GENERAL_RETURN): no shape beside it, and it expands.
        Assert.DoesNotContain(shapes, e => e.Contains("return is no step of ssam-flow/1", StringComparison.Ordinal));
        Assert.Contains(FlowGeneral.Expand(Body("  return B=1")).Edits, e => e.Rule == FlowGeneral.Return);
        Assert.Contains(shapes, e => e.Contains("a loop is foreach", StringComparison.Ordinal));
        Assert.Contains(shapes, e => e.Contains("a call names the action alone (UpdateTicket(...))", StringComparison.Ordinal));
        var more = Refused(Body("  assign B = 1", "    Msg = \"a\"", "  switch:", "    case A = 1:", "      -> @k9", "    otherwise:", "      end",
            "  Twice(N=1) @k9")).Errors;
        Assert.Contains(more, e => e.Contains("an assign of several assignments is `assign` alone", StringComparison.Ordinal));
        Assert.Contains(more, e => e.Contains("nothing follows a switch in its chain", StringComparison.Ordinal));
        Assert.Contains(Refused(Body("  navigate Flow/Search(Id=A)")).Errors, e => e.Contains("a navigate names the screen alone (navigate Search(...))", StringComparison.Ordinal));
    }

    // A tolerated line in a text with another error: the refusal names the line with the accepted form beside it, and the op's
    // patch is the text with that edit (the other error stays).
    [Fact]
    public void ATextWithAnotherErrorBringsTheAcceptedFormAndThePatchOfTheToleratedLine()
    {
        var text = Body("  assign B=1", "  ReadNote(Notes,Label=\"x\")", "  assign Msg = (1", "  end");
        var errors = Refused(text).Errors;
        Assert.Contains(errors, e => e.StartsWith("line 7: ", StringComparison.Ordinal) && e.Contains("; accepted form: `  assign B = 1`", StringComparison.Ordinal));
        Assert.Contains(errors, e => e.StartsWith("line 8: ", StringComparison.Ordinal) && e.Contains("; accepted form: `  ReadNote(Notes, Label=\"x\")`", StringComparison.Ordinal));
        var partial = FlowTextNormalizer.Corrected(text);
        Assert.NotNull(partial);
        Assert.Equal(Body("  assign B = 1", "  ReadNote(Notes, Label=\"x\")", "  assign Msg = (1", "  end"), partial!.Text);
        Assert.Single(Refused(partial.Text).Errors);
    }

    // The corpus of the plan (receipts of 11 to 24/10): one text that has each of the shapes at once reads whole.
    [Fact]
    public void ManyShapesOfOneTextAreNormalizedTogether()
    {
        var text = Lines("server action EnsureBriefs public", " in ProgramId?: Integer", " assign QueuedCount=0", " if ProgramId = 0:",
            "  Saved=Twice(N=QueuedCount,M = 1)", " else:", "  assign QueuedCount=QueuedCount+1 # count it", " out QueuedCount: Integer", " navigate Agenda");
        var normalized = FlowTextNormalizer.Normalize(text);
        Assert.Equal(Lines("server action EnsureBriefs public", "  in ProgramId?: Integer", "  out QueuedCount: Integer", "  assign QueuedCount = 0", "  if ProgramId = 0:",
            "    Saved = Twice(N=QueuedCount, M=1)", "    -> @j1", "  assign QueuedCount = QueuedCount+1  # count it", "  navigate Agenda() @j1"), normalized.Text);
        foreach (var rule in new[] { FlowTolerance.IndentUnit, FlowTolerance.AssignSpacing, FlowTolerance.ResultSpacing, FlowTolerance.ArgumentSpacing, FlowTolerance.Else,
                     FlowTolerance.DeclarationOrder, FlowTolerance.NavigateArguments, FlowTextEdit.LabelSpacing })
            Assert.Contains(normalized.Edits, e => e.Rule == rule);
        var action = ModuleFlow.Read(normalized.Text);
        Assert.Null(ModuleFlow.Check(action, ModuleFlow.Print(action)));
    }
}

// Linked into both test projects: the general language of ssam-flow/1 (R7, FlowGeneral). Each form expands into the lines of
// the grammar, listed as a normalization, and the expanded text is a fixed point (it parses, prints and reads back the same,
// and normalizing it again changes nothing); a form with two readings refuses once, saying what to write, and the other forms
// of the text are the patch.
public sealed class FlowGeneralTextTests
{
    private static string Lines(params string[] lines) => string.Join("\n", lines) + "\n";

    private static FlowTextNormalizer.Normalized Expanded(string text, IFlowSchema? schema = null)
    {
        var normalized = FlowTextNormalizer.Normalize(text, schema);
        Assert.True(normalized.Edits.Count > 0, "nothing expanded:\n" + text + "\n" + string.Join("\n", FlowGeneral.Expand(text, schema).Problems));
        FixedPoint(normalized.Text);
        return normalized;
    }

    // The expanded text parses, its print reads back as the same action and it normalizes to itself.
    internal static void FixedPoint(string text)
    {
        var action = ModuleFlow.Read(text);
        Assert.Null(ModuleFlow.Check(action, ModuleFlow.Print(action)));
        // The printer writes a shared step where it is first reached: the graph is what reads back the same.
        Assert.Empty(FlowTextNormalizer.Normalize(text).Edits);
    }

    // A text without its ids (a line's own and a jump's target) and blank lines.
    internal static string Canonical(string text) => string.Join("\n", text.Replace("\r\n", "\n").Split('\n')
        .Where(l => l.Trim().Length > 0).Select(l => System.Text.RegularExpressions.Regex.Replace(l, @"(?<=-> )@\S+$|(?<!->) @[A-Za-z0-9+/_=-]+$", m => m.Value.StartsWith('@') ? "@" : "")));

    private static readonly IFlowSchema Schema = FlowSchema.Of(new Dictionary<string, IReadOnlyList<(string Name, string Type)>> {
        ["GxOrder"] = [("Id", "GxOrder Identifier"), ("Code", "Text"), ("Total", "Decimal"), ("Status", "Integer")],
        ["GxRow"] = [("Code", "Text"), ("Total", "Decimal")],
    }, new Dictionary<string, IReadOnlyList<(string Name, string Type)>> { ["GxPrice"] = [("Price", "Decimal"), ("Label", "Text")] });

    // ---- FLOW_GENERAL_LET ------------------------------------------------------------------------------------------------

    [Fact]
    public void ALetDeclaresItsLocalOfTheCertainTypeAndIsItsOwnAssign()
    {
        var text = Lines("server action Lets", "  in N: Integer", "  in Rows: GxRow List", "  in Order: GxOrder", "  out R: Decimal",
            "  let Count = 0", "  let Name = \"n\" + IntegerToText(N)", "  let Big = N > 10 and Count = 0", "  let Half = N / 2", "  let When = CurrDateTime()",
            "  let Status = Entities.GxStatus.Open", "  let Size = Rows.Length", "  let First = Rows.Current", "  let Total = Order.Total", "  let Price: Decimal = 1.5",
            "  G = aggregate FROM GxOrder WHERE (GxOrder.Status = N) MAX 1", "  let Found = G.List.Current.GxOrder", "  let Empty = G.List.Empty  # Any order?",
            "  P = GxPrice(Total=1)", "  let Label = P.Label", "  assign R = Half", "  end");
        var normalized = Expanded(text, Schema);
        Assert.Equal(Lines("server action Lets", "  in N: Integer", "  in Rows: GxRow List", "  in Order: GxOrder", "  out R: Decimal",
            "  local Count: Integer", "  local Name: Text", "  local Big: Boolean", "  local Half: Decimal", "  local When: Date Time", "  local Status: GxStatus Identifier",
            "  local Size: Integer", "  local First: GxRow", "  local Total: Decimal", "  local Price: Decimal", "  local Found: GxOrder", "  local Empty: Boolean", "  local Label: Text",
            "  assign Count = 0", "  assign Name = \"n\" + IntegerToText(N)", "  assign Big = N > 10 and Count = 0", "  assign Half = N / 2", "  assign When = CurrDateTime()",
            "  assign Status = Entities.GxStatus.Open", "  assign Size = Rows.Length", "  assign First = Rows.Current", "  assign Total = Order.Total", "  assign Price = 1.5",
            "  G = aggregate FROM GxOrder WHERE (GxOrder.Status = N) MAX 1", "  assign Found = G.List.Current.GxOrder", "  assign Empty = G.List.Empty  # Any order?",
            "  P = GxPrice(Total=1)", "  assign Label = P.Label", "  assign R = Half", "  end"), normalized.Text);
        Assert.All(normalized.Edits, e => Assert.Equal(FlowGeneral.Let, e.Rule));
    }

    [Fact]
    public void ALetWhoseTypeIsNotCertainRefusesSayingTheTypeToDeclareAndTheRestIsThePatch()
    {
        var text = Lines("server action Unsure", "  in Order: GxOrder", "  out R: Integer", "  let Total = Order.Total", "  let Other = Mystery(1)", "  let Taken = R",
            "  let R = 1", "  require Total > 0 else raise GxRejected(\"no\")", "  return R = 1");
        Assert.Empty(FlowTextNormalizer.Normalize(text).Edits);
        var problems = FlowGeneral.Expand(text).Problems;
        Assert.Contains(problems, p => p.StartsWith("line 4: FLOW_GENERAL_LET: the type of Total is not certain from `Order.Total` (the attributes of GxOrder are not in this text): write `let Total: <Type> = Order.Total`", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.StartsWith("line 5: ", StringComparison.Ordinal) && p.Contains("Mystery() is no function of fixed type", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.StartsWith("line 7: ", StringComparison.Ordinal) && p.Contains("R is already the out R: Integer", StringComparison.Ordinal));
        // The refusal says it beside each line; the forms that expand are the patch, verified (only the refused lines stay).
        var errors = Assert.IsType<FlowSyntaxException>(Assert.ThrowsAny<FormatException>(() => ModuleFlow.Read(text))).Errors;
        Assert.Contains(errors, e => e.StartsWith("line 4: ", StringComparison.Ordinal) && e.Contains("write `let Total: <Type> = Order.Total`", StringComparison.Ordinal));
        var partial = FlowTextNormalizer.Corrected(text);
        Assert.NotNull(partial);
        Assert.Contains("  if not (Total > 0):\n    raise GxRejected(\"no\")\n", partial!.Text);
        Assert.Contains("  local Taken: Integer\n", partial.Text);
        Assert.Contains("  let Total = Order.Total\n", partial.Text);
        // With the schema the attribute's type is known.
        Assert.Contains("  local Total: Decimal\n", FlowGeneral.Expand(Lines("server action Sure", "  in Order: GxOrder", "  let Total = Order.Total", "  end"), Schema).Text);
    }

    // ---- FLOW_GENERAL_REQUIRE and FLOW_GENERAL_RETURN --------------------------------------------------------------------

    [Fact]
    public void ARequireIsAnIfOnTheOppositeAndAReturnAssignsTheOutputsThenEnds()
    {
        var text = Lines("server action Guarded", "  in N: Integer", "  out R: Integer", "  out Ok: Boolean",
            "  require N > 0 else raise GxRejected(\"negative\")  # Positive?", "  require N < 100 else GxRejected(\"too big\")",
            "  require N <> 50 else return Ok = False, R = 50", "  require N <> 7 else return", "  require N <> 8 else -> @x1",
            "  if N = 3:", "    return Ok = True", "  assign R = N @x1", "  return Ok = True, R = R * 2");
        var normalized = Expanded(text);
        Assert.Equal(Lines("server action Guarded", "  in N: Integer", "  out R: Integer", "  out Ok: Boolean",
            "  if not (N > 0):  # Positive?", "    raise GxRejected(\"negative\")", "  if not (N < 100):", "    raise GxRejected(\"too big\")",
            "  if not (N <> 50):", "    assign", "      Ok = False", "      R = 50", "    end", "  if not (N <> 7):", "    end", "  if not (N <> 8):", "    -> @x1",
            "  if N = 3:", "    assign Ok = True", "    end", "  assign R = N @x1", "  assign", "    Ok = True", "    R = R * 2", "  end"), normalized.Text);
        Assert.Contains(normalized.Edits, e => e.Rule == FlowGeneral.Require);
        Assert.Contains(normalized.Edits, e => e.Rule == FlowGeneral.Return);
        var refused = FlowGeneral.Expand(Lines("server action Bad", "  out R: Integer", "  require R > 0 else maybe", "  return Nope = 1")).Problems;
        Assert.Contains(refused, p => p.StartsWith("line 3: FLOW_GENERAL_REQUIRE: the else of a require is raise", StringComparison.Ordinal));
        Assert.Contains(refused, p => p.StartsWith("line 4: FLOW_GENERAL_RETURN: Nope is no output of the action (R)", StringComparison.Ordinal));
    }

    // ---- FLOW_GENERAL_JOIN ---------------------------------------------------------------------------------------------

    [Fact]
    public void InAGeneralTextABranchWithoutTerminatorGoesOnAfterItsBlockAndAPlainTextKeepsBothReadings()
    {
        var plain = Lines("server action Plain", "  in N: Integer", "  out R: Integer", "  if N > 5:", "    assign R = 1", "  assign R = R + 2", "  end");
        Assert.Empty(FlowTextNormalizer.Normalize(plain).Edits);
        Assert.Single(FlowTextNormalizer.Ambiguities(plain));
        var general = Lines("server action Joined", "  in N: Integer", "  in Rows: Integer List", "  out R: Integer", "  let Seen = 0", "  if N > 5:", "    if N > 7:", "      assign R = 1",
            "  foreach Rows:", "    if Rows.Current > N:", "      assign Seen = Seen + 1", "  assign R = R + Seen", "  return");
        var normalized = Expanded(general);
        Assert.Equal(Lines("server action Joined", "  in N: Integer", "  in Rows: Integer List", "  out R: Integer", "  local Seen: Integer", "  assign Seen = 0", "  if N > 5:",
            "    if N > 7:", "      assign R = 1", "      -> @j1", "    -> @j1", "  foreach Rows: @j1", "    if Rows.Current > N:", "      assign Seen = Seen + 1", "      next", "    next",
            "  assign R = R + Seen", "  end"), normalized.Text);
        Assert.Contains(normalized.Edits, e => e.Rule == FlowGeneral.Join);
        // The steps after a switch go in its first open case; the other open cases jump to them.
        var switched = Lines("server action Graded", "  in Score: Integer", "  out Grade: Text", "  let Bonus = 5", "  switch:", "    case Score + Bonus >= 90:", "      assign Grade = \"A\"",
            "    case Score + Bonus >= 70:", "      return Grade = \"B\"", "    otherwise:", "      assign Grade = \"C\"", "  assign Grade = Grade + \"!\"", "  return");
        Assert.Equal(string.Join("\n", "server action Graded", "  in Score: Integer", "  out Grade: Text", "  local Bonus: Integer", "  assign Bonus = 5", "  switch:", "    case Score + Bonus >= 90:",
            "      assign Grade = \"A\"", "      assign Grade = Grade + \"!\"", "      end", "    case Score + Bonus >= 70:", "      assign Grade = \"B\"", "      end", "    otherwise:",
            "      assign Grade = \"C\"", "      -> @"), Canonical(Expanded(switched).Text));
    }

    // ---- FLOW_GENERAL_COPY and FLOW_GENERAL_PROJECTION -------------------------------------------------------------------

    [Fact]
    public void ACopyAssignsItsSourceThenTheFieldsItChangesAndAProjectionNamesEveryAttribute()
    {
        var text = Lines("server action Copied", "  in Source: GxRow", "  in Factor: Decimal", "  out Copy: GxRow", "  out Twice: GxRow",
            "  assign Copy = { ...Source, Total: Source.Total * Factor, Code: \"c\" }", "  let Again = { ...Copy, Total: Copy.Total * 2 }", "  assign", "    Twice = { ...Again, Code: \"t\" }", "  end");
        Assert.Equal(Lines("server action Copied", "  in Source: GxRow", "  in Factor: Decimal", "  out Copy: GxRow", "  out Twice: GxRow", "  local Again: GxRow",
            "  assign Copy = Source", "  assign", "    Copy.Total = Source.Total * Factor", "    Copy.Code = \"c\"", "  assign Again = Copy", "  assign", "    Again.Total = Copy.Total * 2",
            "  assign", "    Twice = Again", "    Twice.Code = \"t\"", "  end"), Expanded(text).Text);
        var reading = FlowGeneral.Expand(Lines("server action Self", "  in Source: GxRow", "  out Copy: GxRow", "  assign Copy = { ...Source, Total: Copy.Total }", "  end")).Problems;
        Assert.Contains(reading, p => p.Contains("FLOW_GENERAL_COPY: the value of Total reads Copy, which the copy is writing", StringComparison.Ordinal));
        var projected = Lines("server action Projected", "  in Rows: GxRow List", "  out Orders: GxOrder List", "  out Copies: GxRow List",
            "  G = aggregate FROM GxOrder WHERE (GxOrder.Status = 1)", "  assign Copies = G.List mapTo { *, Total: GxOrder.Total * 2 }", "  assign Orders = Rows mapTo { *, Status: 1 }", "  end");
        Assert.Equal(Lines("server action Projected", "  in Rows: GxRow List", "  out Orders: GxOrder List", "  out Copies: GxRow List",
            "  G = aggregate FROM GxOrder WHERE (GxOrder.Status = 1)", "  assign Copies = G.List mapTo { Code: GxOrder.Code, Total: GxOrder.Total * 2 }",
            "  assign Orders = Rows mapTo { Code: Code, Total: Total, Status: 1 }", "  end"), Expanded(projected, Schema).Text);
        Assert.Contains(FlowGeneral.Expand(projected).Problems, p => p.Contains("FLOW_GENERAL_PROJECTION: the attributes of GxRow are not known here", StringComparison.Ordinal));
        Assert.Contains(FlowGeneral.Expand(projected.Replace("Status: 1", "Missing: 1"), Schema).Problems, p => p.Contains("Missing is no attribute of GxOrder", StringComparison.Ordinal));
    }

    // ---- FLOW_GENERAL_CONTEXT ------------------------------------------------------------------------------------------

    [Fact]
    public void AContextIsAnInputOfTheActionsThatReadItAndOfTheirCallersInTheOp()
    {
        var texts = new[] {
            Lines("context Tenant: Integer", "", "server action Inner", "  in Code: Text", "  out Ok: Boolean", "  return Ok = Tenant > 0 and Code <> \"\""),
            Lines("server action Outer", "  out Ok: Boolean", "  Check = Inner(Code=\"x\")", "  return Ok = Check.Ok"),
            Lines("server action Apart", "  out Ok: Boolean", "  return Ok = True"),
        };
        var normalized = FlowTextNormalizer.NormalizeAll(texts);
        Assert.Equal(Lines("", "", "server action Inner", "  in Code: Text", "  in Tenant: Integer", "  out Ok: Boolean", "  assign Ok = Tenant > 0 and Code <> \"\"", "  end"), normalized[0].Text);
        Assert.Equal(Lines("server action Outer", "  in Tenant: Integer", "  out Ok: Boolean", "  Check = Inner(Code=\"x\", Tenant)", "  assign Ok = Check.Ok", "  end"), normalized[1].Text);
        Assert.Equal(Lines("server action Apart", "  out Ok: Boolean", "  assign Ok = True", "  end"), normalized[2].Text);
        Assert.Contains(normalized[1].Edits, e => e.Rule == FlowGeneral.Context);
        foreach (var n in normalized) FixedPoint(n.Text);
        // One action of the op with the name as another type is a conflict.
        var (_, problems) = FlowGeneral.ExpandAll([texts[0], Lines("server action Clash", "  in Tenant: Text", "  out Ok: Boolean", "  return Ok = Tenant <> \"\"")]);
        Assert.Contains(problems, p => p.Contains("FLOW_GENERAL_CONTEXT: the context Tenant: Integer is also the in Tenant: Text of Clash", StringComparison.Ordinal));
    }

    // ---- FLOW_GENERAL_SQL_BIND -----------------------------------------------------------------------------------------

    [Fact]
    public void TheParametersOfASqlBindToTheVariablesOfTheirNames()
    {
        var text = Lines("server action Queried", "  in Minimum: Decimal", "  in Code: Text", "  out Total: Integer", "  let Since = CurrDate()",
            "  Totals = sql -> GxRow max 1", "    in Code: Text = ToUpper(Code)",
            "    | SELECT {GxOrder}.[Code], {GxOrder}.[Total] FROM {GxOrder} WHERE {GxOrder}.[Total] >= @Minimum AND {GxOrder}.[Code] = @Code",
            "    |   AND {GxOrder}.[Since] >= @Since AND '@NotOne' <> '' -- @NorThis", "    | SELECT @@ROWCOUNT", "  return Total = 1");
        var normalized = Expanded(text);
        Assert.Contains("  Totals = sql -> GxRow max 1\n    in Code: Text = ToUpper(Code)\n    in Minimum: Decimal = Minimum\n    in Since: Date = Since\n    | SELECT", normalized.Text);
        Assert.Contains(normalized.Edits, e => e.Rule == FlowGeneral.SqlBind);
        var unknown = FlowGeneral.Expand(text.Replace("@Since", "@Later").Replace("  in Code: Text\n", "  in Code: Text List\n").Replace("    in Code: Text = ToUpper(Code)\n", "")).Problems;
        Assert.Contains(unknown, p => p.Contains("@Later of the sql has no input, output or local of that name: write `in Later: <Type> = <value>` under the node", StringComparison.Ordinal));
        Assert.Contains(unknown, p => p.Contains("@Code of the sql is the in Code: Text List, which is no scalar", StringComparison.Ordinal));
    }

    // ---- with the tolerated shapes -------------------------------------------------------------------------------------

    [Fact]
    public void TheGeneralFormsExpandAfterTheToleratedShapes()
    {
        var text = Lines("server action Shaped", "    in N: Integer", "    out R: Integer", "    let Twice = N*2", "    if Twice > 4:", "        return R=Twice", "    else:",
            "        assign R=0", "    return");
        var normalized = Expanded(text);
        Assert.Equal(string.Join("\n", "server action Shaped", "  in N: Integer", "  out R: Integer", "  local Twice: Integer", "  assign Twice = N*2", "  if Twice > 4:", "    assign R = Twice",
            "    end", "  assign R = 0", "  end"), Canonical(normalized.Text));
        Assert.Contains(normalized.Edits, e => e.Rule == FlowTolerance.IndentUnit);
        Assert.Contains(normalized.Edits, e => e.Rule == FlowTolerance.Else);
    }

    // ---- FLOW_GENERAL_RECORD (part 2) ------------------------------------------------------------------------------------

    [Fact]
    public void LoadInsertUpdateAndDeleteAreTheEntityActionsOfTheirRecords()
    {
        var text = Lines("server action Records", "  in OrderId: GxOrder Identifier", "  in Amount: Decimal", "  out NewId: GxOrder Identifier",
            "  load O: GxOrder by OrderId locked  # The order", "  require O.Status = 1 else GxRejected(\"closed\")", "  update O {Total=O.Total+Amount, Status=O.Status+1}",
            "  insert N: GxOrder {Code=\"copy\", Total=O.Total, Status=1}", "  load Plain: GxOrder by OrderId", "  delete O", "  return NewId = N.Id");
        var normalized = Expanded(text, Schema);
        Assert.Equal(Lines("server action Records", "  in OrderId: GxOrder Identifier", "  in Amount: Decimal", "  out NewId: GxOrder Identifier",
            "  local O: GxOrder", "  local BeforeO: GxOrder", "  local N: GxOrder", "  local EmptyN: GxOrder", "  local Plain: GxOrder",
            "  LoadO = GetGxOrderForUpdate(Id=OrderId)  # The order", "  assign O = LoadO.Record.GxOrder",
            "  if not (O.Status = 1):", "    raise GxRejected(\"closed\")",
            "  assign BeforeO = O", "  assign", "    O.Total = BeforeO.Total+Amount", "    O.Status = BeforeO.Status+1", "  SaveO = UpdateGxOrder(Source=O)",
            "  assign N = EmptyN", "  assign", "    N.Code = \"copy\"", "    N.Total = O.Total", "    N.Status = 1", "  CreateN = CreateGxOrder(Source=N)", "  assign N.Id = CreateN.Id",
            "  LoadPlain = GetGxOrder(Id=OrderId)", "  assign Plain = LoadPlain.Record.GxOrder", "  DeleteO = DeleteGxOrder(Id=O.Id)", "  assign NewId = N.Id", "  end"),
            Canonical(normalized.Text).Replace("\n", "\n") + "\n");
        Assert.Contains(normalized.Edits, e => e.Rule == FlowGeneral.Record);
        // An update needs the record locked in its branch; a field that is no attribute and a taken name refuse.
        var problems = FlowGeneral.Expand(Lines("server action Bad", "  in Id: GxOrder Identifier", "  local Taken: Integer", "  load A: GxOrder by Id", "  update A {Total=1}",
            "  if Id = NullIdentifier():", "    load B: GxOrder by Id locked", "  delete B", "  insert C: GxOrder {Nope=1}", "  load Taken: GxOrder by Id", "  end"), Schema).Problems;
        Assert.Contains(problems, p => p.StartsWith("line 5: FLOW_GENERAL_RECORD: an update of A needs it loaded locked", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.StartsWith("line 8: FLOW_GENERAL_RECORD: a delete of B needs it loaded locked", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.StartsWith("line 9: FLOW_GENERAL_RECORD: Nope is no attribute of GxOrder", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.StartsWith("line 10: FLOW_GENERAL_RECORD: Taken is already the local Taken: Integer", StringComparison.Ordinal));
        // A name the lowering writes is never one the action already has.
        Assert.Contains("  LoadO2 = GetGxOrder(Id=Id)\n", FlowGeneral.Expand(Lines("server action Named", "  in Id: GxOrder Identifier", "  local LoadO: Integer", "  load O: GxOrder by Id", "  end")).Text);
    }

    // ---- FLOW_GENERAL_CONTRACT (part 2) ----------------------------------------------------------------------------------

    [Fact]
    public void AContractIsTheLinesOfEveryActionThatUsesItAcrossTheTextsOfTheOp()
    {
        var texts = new[] {
            Lines("contract Owned:", "  in OrderId: GxOrder Identifier", "  load Order: GxOrder by OrderId locked", "  require Order.Status > 0 else GxRejected(\"closed\")",
                "contract Paid:", "  use Owned", "  in Amount: Decimal", "  require Amount > 0 else GxRejected(\"amount\")", "",
                "server action Pay", "  use Paid", "  out Total: Decimal", "  update Order {Total=Order.Total+Amount}", "  return Total = Order.Total"),
            Lines("server action Close", "  in Reason: Text", "  use Owned", "  update Order {Status=0}", "  return"),
        };
        var normalized = FlowTextNormalizer.NormalizeAll(texts, Schema);
        Assert.Equal(string.Join("\n", "server action Pay", "  in OrderId: GxOrder Identifier", "  in Amount: Decimal", "  out Total: Decimal", "  local Order: GxOrder", "  local BeforeOrder: GxOrder",
            "  LoadOrder = GetGxOrderForUpdate(Id=OrderId)", "  assign Order = LoadOrder.Record.GxOrder", "  if not (Order.Status > 0):", "    raise GxRejected(\"closed\")",
            "  if not (Amount > 0):", "    raise GxRejected(\"amount\")", "  assign BeforeOrder = Order", "  assign", "    Order.Total = BeforeOrder.Total+Amount",
            "  SaveOrder = UpdateGxOrder(Source=Order)", "  assign Total = Order.Total", "  end"), Canonical(normalized[0].Text));
        // The declarations a contract brings go with the action's, in the order written (the use before the input here).
        Assert.StartsWith("server action Close\n  in Reason: Text\n  in OrderId: GxOrder Identifier\n  local Order: GxOrder\n", Canonical(normalized[1].Text));
        foreach (var n in normalized) { Assert.Contains(n.Edits, e => e.Rule == FlowGeneral.Contract); FixedPoint(n.Text); }
        var (_, problems) = FlowGeneral.ExpandAll([Lines("contract Loop:", "  use Loop", "contract Twice:", "  in OrderId: Integer", "", "server action Clash", "  in OrderId: Integer", "  use Twice",
            "  use Missing", "  end")]);
        Assert.Contains(problems, p => p.Contains("FLOW_GENERAL_CONTRACT: the contract Loop uses itself", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("FLOW_GENERAL_CONTRACT: no contract Missing in this op", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("OrderId is declared twice in the action", StringComparison.Ordinal));
    }

    // ---- bind and binding (FLOW_GENERAL_SQL_BIND, part 2) ------------------------------------------------------------------

    [Fact]
    public void ABindIsTheSqlParameterItNamesAndABindingServesEveryActionOfTheOp()
    {
        var text = Lines("binding Actor: User Identifier = GetUserId()", "", "server action Queried", "  in Order: GxOrder", "  out Total: Integer",
            "  Totals = sql -> GxRow max 1", "    bind Since = CurrDate()", "    bind Limit: Decimal = Order.Total * 2",
            "    | SELECT [Code], [Total] FROM {GxOrder} WHERE [Total] <= @Limit AND [At] >= @Since AND [Actor] = @Actor", "  return Total = 1");
        var normalized = Expanded(text, Schema);
        Assert.Contains("  Totals = sql -> GxRow max 1\n    in Since: Date = CurrDate()\n    in Limit: Decimal = Order.Total * 2\n    in Actor: User Identifier = GetUserId()\n    | SELECT", normalized.Text);
        var problems = FlowGeneral.Expand(text.Replace("bind Since = CurrDate()", "bind Since = Mystery()").Replace("  in Order: GxOrder\n", "  in Order: GxOrder\n  in Actor: Integer\n")).Problems;
        Assert.Contains(problems, p => p.Contains("the type of @Since is not certain from `Mystery()`: write `bind Since: <Type> = Mystery()`", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("@Actor of the sql is both the binding Actor of the op and the in Actor", StringComparison.Ordinal));
    }
}
