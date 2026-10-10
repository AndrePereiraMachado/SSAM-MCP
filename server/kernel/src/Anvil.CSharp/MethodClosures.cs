using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private SourceValue CreateClosure(IDelegateCreationOperation creation, JsonArray steps)
    {
        var symbol = creation.Target switch { IAnonymousFunctionOperation anonymous => anonymous.Symbol,
            IMethodReferenceOperation reference when reference.Instance == null => reference.Method,
            _ => throw Unsupported(creation, "Delegate method groups with instance receivers need a typed receiver capture") };
        var type = Type(creation.Type!); var result = Temp(type);
        var target = model.Control.Closures(type).Single(item => SymbolEqualityComparer.Default.Equals(item.Method.Symbol, symbol));
        foreach (var captured in CapturedLocals(model.Control.Body(symbol)))
        {
            var declaration = captured.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();
            if (declaration?.Ancestors().Any(node => node is Microsoft.CodeAnalysis.CSharp.Syntax.ForEachStatementSyntax
                or Microsoft.CodeAnalysis.CSharp.Syntax.ForStatementSyntax or Microsoft.CodeAnalysis.CSharp.Syntax.WhileStatementSyntax
                or Microsoft.CodeAnalysis.CSharp.Syntax.DoStatementSyntax) == true)
                throw Unsupported(creation, "Delegate capture of a loop/block activation requires a distinct lexical closure frame per activation");
        }
        Assign(steps, result.Text + ".Target", target.Id.ToString());
        Assign(steps, result.Text + ".Frame", symbol.ContainingSymbol is IMethodSymbol parent ? FrameIndex(parent) : "0");
        return result;

        IEnumerable<ILocalSymbol> CapturedLocals(IOperation operation)
        {
            if (operation is ILocalReferenceOperation local && !SymbolEqualityComparer.Default.Equals(local.Local.ContainingSymbol, symbol)) yield return local.Local;
            foreach (var child in operation.ChildOperations) foreach (var nested in CapturedLocals(child)) yield return nested;
        }
    }

    private SourceValue InvokeClosure(IInvocationOperation invocation, JsonArray steps)
    {
        var closure = Snapshot(Value(invocation.Instance!, steps), steps);
        var arguments = invocation.Arguments.Select(argument => Snapshot(Value(argument.Value, steps), steps)).ToArray();
        Guard(steps, closure.Text + ".Target = 0", "NullReferenceException", "Object reference not set to an instance of an object.");
        var targets = model.Control.Closures(closure.Type);
        if (targets.Count == 0) throw Unsupported(invocation, "Delegate invocation has no statically bound source target");
        Guard(steps, string.Join(" and ", targets.Select(target => closure.Text + ".Target <> " + target.Id)),
            "InvalidOperationException", "Delegate target does not belong to this compiled invocation.");
        var result = Temp(invocation.TargetMethod.ReturnsVoid ? Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Boolean)) : Type(invocation.Type!));
        foreach (var target in targets)
        {
            var branch = new JsonArray(); var values = new JsonObject { ["AvContextIn"] = Context };
            if (target.Method.Symbol.ContainingSymbol is IMethodSymbol) values["AvClosureFrame"] = closure.Text + ".Frame";
            for (var i = 0; i < arguments.Length; i++)
                values[target.Method.Parameter(target.Method.Symbol.Parameters[i])] = Coerce(arguments[i], Type(target.Method.Symbol.Parameters[i].Type), false, branch, invocation).Text;
            var name = "AvClosureCall" + ++calls;
            branch.Add(new JsonObject { ["call"] = model.References.MethodName(target.Method), ["as"] = name, ["args"] = values });
            PropagateReferenceCall(name, branch);
            if (!target.Method.Symbol.ReturnsVoid) Store(branch, result, new(name + "." + target.Method.Result, Type(target.Method.Symbol.ReturnType)), invocation);
            steps.Add(new JsonObject { ["if"] = closure.Text + ".Target = " + target.Id, ["then"] = branch });
        }
        return result;
    }
}
