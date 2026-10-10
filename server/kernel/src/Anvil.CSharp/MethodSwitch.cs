using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private sealed record SelectionTest(string Condition, JsonArray Effects);
    private sealed record SelectionBranch(List<SelectionTest> Tests, JsonArray Body);

    private bool SwitchStatement(ISwitchOperation selection, JsonArray steps)
    {
        localControlLabels.Add(selection.ExitLabel);
        var needsValue = selection.Cases.Any(c => c.Clauses.Any(label => label is not IDefaultCaseClauseOperation));
        var value = Value(selection.Value, steps, discard: !needsValue);
        if (needsValue) value = Snapshot(value, steps);
        var branches = new List<SelectionBranch>(); JsonArray? otherwise = null;
        foreach (var section in selection.Cases)
        {
            var body = new JsonArray(); var tests = new List<SelectionTest>();
            foreach (var statement in section.Body) if (!Statement(statement, body)) break;
            foreach (var clause in section.Clauses)
            {
                var effects = new JsonArray();
                if (clause is IDefaultCaseClauseOperation) { otherwise = body; continue; }
                var condition = clause switch
                {
                    ISingleValueCaseClauseOperation single => ConstantPattern(value, single.Value, effects),
                    IPatternCaseClauseOperation pattern => GuardedPattern(value, pattern.Pattern, pattern.Guard, effects),
                    _ => throw Unsupported(clause, "Switch label translation is not defined")
                };
                tests.Add(new(condition, effects));
            }
            if (tests.Count > 0) branches.Add(new(tests, body));
        }
        EmitSelection(branches, otherwise ?? [], steps);
        localControlLabels.Remove(selection.ExitLabel);
        // A case ending with break continues after the switch; return does not. Roslyn owns
        // source reachability, while the shared native graph compiler owns lexical destinations.
        return model.Program.Model(selection.Syntax).AnalyzeControlFlow((SwitchStatementSyntax)selection.Syntax)!.EndPointIsReachable;
    }

    private SourceValue SwitchExpression(ISwitchExpressionOperation selection, JsonArray steps)
    {
        var value = Snapshot(Value(selection.Value, steps), steps);
        var result = Temp(Type(selection.Type!)); var branches = new List<SelectionBranch>();
        foreach (var arm in selection.Arms)
        {
            var effects = new JsonArray(); var body = new JsonArray();
            var condition = GuardedPattern(value, arm.Pattern, arm.Guard, effects);
            if (arm.Value is IThrowOperation thrown) Throw(thrown, body);
            else Store(body, result, Value(arm.Value, body), arm);
            branches.Add(new([new(condition, effects)], body));
        }
        var otherwise = new JsonArray(new JsonObject { ["raise"] = model.Exception("SwitchExpressionException"),
            ["message"] = DataModel.Constant("No switch expression arm matched the input.") });
        // A final discard needs no synthetic unreachable exception branch.
        if (selection.Arms.LastOrDefault() is { Pattern: IDiscardPatternOperation, Guard: null })
        { otherwise = branches[^1].Body; branches.RemoveAt(branches.Count - 1); }
        EmitSelection(branches, otherwise, steps); return result;
    }

    private void EmitSelection(List<SelectionBranch> branches, JsonArray otherwise, JsonArray steps)
    {
        var cases = new JsonArray();
        if (branches.Any(b => b.Tests.Any(t => t.Effects.Count != 0)))
        {
            // Guards and variable bindings run in source order, and only until a label matches.
            // The selected body is emitted once, even when several labels share it.
            var selected = Temp(Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Int32)));
            Assign(steps, selected.Text, "0");
            foreach (var (branch, index) in branches.Select((b, i) => (b, i + 1)))
            {
                foreach (var test in branch.Tests)
                {
                    var evaluate = (JsonArray)test.Effects.DeepClone(); var match = new JsonArray();
                    Assign(match, selected.Text, index.ToString(System.Globalization.CultureInfo.InvariantCulture));
                    evaluate.Add(new JsonObject { ["if"] = test.Condition, ["then"] = match });
                    steps.Add(new JsonObject { ["if"] = selected.Text + " = 0", ["then"] = evaluate });
                }
                cases.Add(new JsonObject { ["when"] = selected.Text + " = " + index, ["steps"] = branch.Body.DeepClone() });
            }
        }
        else foreach (var branch in branches)
            cases.Add(new JsonObject { ["when"] = string.Join(" or ", branch.Tests.Select(t => "(" + t.Condition + ")")), ["steps"] = branch.Body.DeepClone() });
        // Keep a lexical switch scope for break in a default-only statement.
        if (cases.Count == 0)
        { cases.Add(new JsonObject { ["when"] = "True", ["steps"] = otherwise.DeepClone() }); otherwise = []; }
        steps.Add(new JsonObject { ["switch"] = cases, ["otherwise"] = otherwise.DeepClone() });
    }

    private string GuardedPattern(SourceValue value, IPatternOperation pattern, IOperation? guard, JsonArray steps)
    {
        var condition = Pattern(value, pattern, steps);
        if (guard == null) return condition;
        var matched = Temp(Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Boolean)));
        Assign(steps, matched.Text, condition);
        var evaluate = new JsonArray(); Assign(evaluate, matched.Text, Value(guard, evaluate).Text);
        steps.Add(new JsonObject { ["if"] = matched.Text, ["then"] = evaluate }); return matched.Text;
    }

    private string ConstantPattern(SourceValue value, IOperation constant, JsonArray steps)
    {
        if (constant.ConstantValue is { HasValue: true, Value: null }) return "not (" + Present(value) + ")";
        var expected = Value(constant, steps); var payload = Payload(value);
        if (payload.Type.IsList || payload.Type.Declaration is { Kind: not DataKind.Enum } && !payload.Type.IsIdentity)
            throw Unsupported(constant, "Constant pattern requires a scalar input");
        return "(" + Present(value) + " and (" + payload.Text + " = " + expected.Text + "))";
    }

    private string Pattern(SourceValue value, IPatternOperation pattern, JsonArray steps)
    {
        switch (pattern)
        {
            case IConstantPatternOperation constant: return ConstantPattern(value, constant.Value, steps);
            case IDiscardPatternOperation: return "True";
            case INegatedPatternOperation negated: return "not (" + Pattern(value, negated.Pattern, steps) + ")";
            case IRelationalPatternOperation relational:
                var symbol = relational.OperatorKind switch { BinaryOperatorKind.LessThan => "<", BinaryOperatorKind.LessThanOrEqual => "<=",
                    BinaryOperatorKind.GreaterThan => ">", BinaryOperatorKind.GreaterThanOrEqual => ">=", _ => throw Unsupported(pattern) };
                return "(" + Present(value) + " and (" + Payload(value).Text + " " + symbol + " " + Value(relational.Value, steps).Text + "))";
            case IBinaryPatternOperation binary:
                var left = Pattern(value, binary.LeftPattern, steps); var rightSteps = new JsonArray();
                var right = Pattern(value, binary.RightPattern, rightSteps);
                if (rightSteps.Count == 0) return "(" + left + (binary.OperatorKind == BinaryOperatorKind.And ? " and " : " or ") + right + ")";
                var combined = Temp(Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Boolean)));
                Assign(steps, combined.Text, left); Assign(rightSteps, combined.Text, right);
                steps.Add(new JsonObject { ["if"] = (binary.OperatorKind == BinaryOperatorKind.And ? "" : "not ") + "(" + left + ")", ["then"] = rightSteps });
                return combined.Text;
            case IDeclarationPatternOperation declaration:
                if (declaration.MatchedType != null && !SymbolEqualityComparer.Default.Equals(declaration.MatchedType, value.Type.Source))
                    throw Unsupported(pattern, "Runtime type patterns need polymorphic value representation");
                var present = declaration.MatchesNull ? "True" : Present(value);
                if (declaration.DeclaredSymbol is ILocalSymbol local)
                {
                    var bind = new JsonArray(); Store(bind, new(Local(local), Type(local.Type)), declaration.MatchesNull ? value : Payload(value), declaration);
                    steps.Add(new JsonObject { ["if"] = present, ["then"] = bind });
                }
                return present;
            default: throw Unsupported(pattern, "Pattern translation is not defined: " + pattern.Kind);
        }
    }
}
