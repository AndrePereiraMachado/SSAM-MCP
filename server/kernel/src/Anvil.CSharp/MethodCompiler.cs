using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed record SourceValue(string Text, ValueType Type, string? Presence=null, bool Storage=false, bool IsNull=false, Place? Location=null);

/// <summary>Structured effect lowering. Values stay typed; evaluation order is explicit at native action boundaries.</summary>
internal sealed partial class MethodCompiler(LogicModel model, MethodDeclaration method)
{
    private LogicModel Model=>model;
    private readonly Dictionary<ILocalSymbol, string> locals = new(SymbolEqualityComparer.Default);
    private readonly HashSet<ILabelSymbol> emittedContinuations = new(SymbolEqualityComparer.Default);
    private readonly JsonArray variables = [];
    private bool assignsResult;
    private int temporary, calls;
    private ValueType Type(ITypeSymbol source) => Managed ? model.References.Runtime(model.Data.Type(source, method.Symbol)) : model.Data.Type(source, method.Symbol);
    private SourceCompilationException Unsupported(IOperation op, string? message = null)
        => SourceProgram.Error("AVCS310", message ?? "Logic translation is not defined for " + op.Kind, op.Syntax);
    private string Local(ILocalSymbol symbol)
    {
        if (ControlFrame != null) return CapturedPath(symbol, symbol.Type);
        if (locals.TryGetValue(symbol, out var existing)) return existing;
        var name = SymbolNames.Normalize("Var" + (locals.Count + 1) + "_" + symbol.Name);
        locals.Add(symbol, name); variables.Add(Parameter(name, Type(symbol.Type))); return name;
    }
    private SourceValue Temp(ValueType type)
    {
        var value = new SourceValue("AvTemp" + ++temporary, type);
        variables.Add(Parameter(value.Text, type)); return value;
    }
    private JsonObject Parameter(string name, ValueType type) => new() { ["name"] = name, ["type"] = model.Data.Transport(type) };
    private static void Assign(JsonArray steps, string target, string value)
    {
        if (target != value) steps.Add(new JsonObject { ["assign"] = new JsonObject { [target] = value } });
    }
    private SourceValue Snapshot(SourceValue value, JsonArray steps)
    { var temp = Temp(value.Type); Assign(steps, temp.Text, value.Text); return temp; }
    private void Guard(JsonArray steps, string condition, string exception, string message)
    {
        var branch = new JsonArray();
        if (Managed) EmitFixedReferenceThrow(branch, "System." + exception, exception, DataModel.Constant(message));
        else branch.Add(new JsonObject { ["raise"] = model.Exception(exception), ["message"] = DataModel.Constant(message) });
        steps.Add(new JsonObject { ["if"] = condition, ["then"] = branch });
    }
    internal JsonObject Compile(IOperation body)
    {
        var inputs = new JsonArray(); var outputs = new JsonArray(); var steps = new JsonArray();
        if (Managed)
        {
            if (!model.References.GraphBoundaries && method.IsPublicEntry)
            {
                if (model.References.Boundary(method.Symbol).RequiresIdentityCodec)
                    throw SourceProgram.Error("AVCS310", "External reference arguments/results require a presence/identity boundary codec; ArgumentNullException.ThrowIfNull and reference effects cannot be erased from annotations", method.Symbol);
            }
            inputs.Add(Parameter("AvContextIn", NativeType(model.References.ContextType)));
            outputs.Add(Parameter("AvContextOut", NativeType(model.References.ContextType)));
            outputs.Add(Parameter("AvCompletion", NativeType(model.References.CompletionType)));
            variables.Add(Parameter(Context, NativeType(model.References.ContextType)));
            Assign(steps, Context, "AvContextIn");
        }
        if (ControlFrame?.Method.Symbol.ContainingSymbol is IMethodSymbol)
            inputs.Add(Parameter("AvClosureFrame", Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Int32))));
        if (method.HasReceiver)
        {
            var receiver = new SourceValue(method.Receiver, Type(method.Symbol.ContainingType));
            inputs.Add(Parameter(method.Receiver, receiver.Type));
            // Keep the typed receiver meaningful even for a body that never reads this.
            // Source call sites also check it after argument evaluation, before invoking.
            CheckReference(receiver, steps);
        }
        foreach (var parameter in method.Symbol.Parameters)
        {
            if(LogicModel.DataDependency(parameter.Type)) continue;
            var input = Parameter(method.Parameter(parameter), Type(parameter.Type));
            // Roslyn supplies every source call argument, including bound defaults.
            // Managed implementations receive complete values; omission belongs only
            // to the public call boundary, not to a nullable/reference value.
            if (!Managed) NativeParameterDefault(input, parameter);
            inputs.Add(input);
            var parameterType = Type(parameter.Type);
            if (!parameterType.Nullable && Range(parameterType.Source) is {} range && parameterType.Source.SpecialType is not (SpecialType.System_Int32 or SpecialType.System_Int64))
                Guard(steps,method.Parameter(parameter)+" < "+range.Min+" or "+method.Parameter(parameter)+" > "+range.Max,"ArgumentOutOfRangeException","Value is outside the source integer range.");
        }
        if (!method.Symbol.ReturnsVoid) outputs.Add(Parameter(method.Result, Type(method.Symbol.ReturnType)));
        InitializeControlFrame(steps);
        var continues = Statement(body is IMethodBodyOperation methodBody ? methodBody.BlockBody ?? methodBody.ExpressionBody ?? throw Unsupported(body) : body, steps);
        if (Managed && continues) FinishReference(steps, 0);
        if (Managed) NormalizeReferenceRaises(steps);
        if (!method.Symbol.ReturnsVoid && !continues && !assignsResult)
        {
            // An always-throwing method retains its native result signature. Its unused
            // output still needs an assignment for native validation; copy exact typed
            // default storage without inventing a successful source return/completion.
            var empty = Temp(Type(method.Symbol.ReturnType));
            steps.Insert(0, new JsonObject { ["assign"] = new JsonObject { [method.Result] = empty.Text } });
        }
        for (var index = referencePrelude.Count - 1; index >= 0; index--) steps.Insert(0, referencePrelude[index]!.DeepClone());
        return new JsonObject { ["name"] = model.References.MethodName(method), ["inputs"] = inputs, ["outputs"] = outputs, ["vars"] = variables, ["steps"] = steps };
    }
    internal static void NativeParameterDefault(JsonObject input, IParameterSymbol parameter)
    {
        if (!parameter.HasExplicitDefaultValue) return;
        if (parameter.ExplicitDefaultValue == null) throw SourceProgram.Error("AVCS311", "Optional null arguments require a presence default", parameter);
        input["mandatory"] = false; input["default"] = DataModel.Constant(parameter.ExplicitDefaultValue);
    }
    internal void DefaultArgument(IParameterSymbol parameter, string target, JsonArray steps, JsonArray entryVariables)
    {
        var syntax = parameter.DeclaringSyntaxReferences.Single().GetSyntax() as Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax;
        var initializer = syntax?.Default;
        var operation = initializer == null ? null : model.Program.Model(initializer).GetOperation(initializer) as IParameterInitializerOperation;
        if (operation == null) throw SourceProgram.Error("AVCS311", "Optional parameter requires its bound source initializer", parameter);
        var start = variables.Count;
        // Use exactly the expression/conversion lowering used at source call sites.
        // No duplicate table of scalar, nullable, enum, text or temporal defaults.
        Store(steps, new SourceValue(target, Type(parameter.Type)), Value(operation.Value, steps), operation);
        foreach (var variable in variables.Skip(start)) entryVariables.Add(variable!.DeepClone());
    }
    private bool Statement(IOperation op, JsonArray steps)
    {
        switch (op)
        {
            case IBlockOperation block:
                foreach (var statement in block.Operations) if (!Statement(statement, steps)) return false;
                return true;
            case IVariableDeclarationGroupOperation group:
                foreach (var declaration in group.Declarations) Statement(declaration, steps); return true;
            case IVariableDeclarationOperation declaration:
                foreach (var declarator in declaration.Declarators) Statement(declarator, steps); return true;
            case IVariableDeclaratorOperation declarator:
                var local = Local(declarator.Symbol);
                if (declarator.Initializer != null) Store(steps,new(local,Type(declarator.Symbol.Type)),Value(declarator.Initializer.Value,steps),declarator);
                return true;
            case IExpressionStatementOperation expression:
                Value(expression.Operation, steps, discard: true); return true;
            case IReturnOperation returned:
                if (returned.ReturnedValue != null)
                {
                    Store(steps,new(ReturnPath,Type(method.Symbol.ReturnType)),Value(returned.ReturnedValue,steps),returned);
                    assignsResult = true;
                }
                if (Managed) FinishReference(steps, 1); else steps.Add(new JsonObject { ["return"] = true }); return false;
            case IConditionalOperation conditional when conditional.Type == null:
                var condition = Value(conditional.Condition, steps); var yes = new JsonArray(); var no = new JsonArray();
                var yesContinues = Statement(conditional.WhenTrue, yes);
                var noContinues = conditional.WhenFalse == null || Statement(conditional.WhenFalse, no);
                steps.Add(new JsonObject { ["if"] = condition.Text, ["label"] = conditional.Condition.Syntax.ToString(), ["then"] = yes, ["else"] = no });
                return yesContinues || noContinues;
            case ITryOperation region:
                CompileTry(region, steps); return true;
            case IWhileLoopOperation loop when loop.ConditionIsTop && !loop.ConditionIsUntil:
                Loop(loop, loop.Condition, loop.Body, [], steps); return true;
            case IForLoopOperation loop:
                foreach (var before in loop.Before) Statement(before, steps);
                Loop(loop, loop.Condition, loop.Body, loop.AtLoopBottom, steps); return true;
            case IForEachLoopOperation loop:
                Enumerate(loop, steps); return true;
            case ISwitchOperation selection:
                return SwitchStatement(selection, steps);
            case IBranchOperation branch when branch.BranchKind is BranchKind.Break or BranchKind.Continue:
                if (ControlFrame != null && !localControlLabels.Contains(branch.Target))
                {
                    Assign(steps, "AvCompletion.Target", ControlFrame.Labels[branch.Target].ToString());
                    FinishReference(steps, branch.BranchKind == BranchKind.Break ? 3 : 4); return false;
                }
                if (branch.BranchKind == BranchKind.Continue) emittedContinuations.Add(branch.Target);
                steps.Add(new JsonObject { [branch.BranchKind == BranchKind.Break ? "break" : "continue"] = true }); return false;
            case IThrowOperation thrown:
                Throw(thrown, steps); return false;
            case IEmptyOperation: return true;
            case ILocalFunctionOperation: return true;
            default: throw Unsupported(op);
        }
    }
    private void Loop(ILoopOperation loop, IOperation? condition, IOperation body, IEnumerable<IOperation> increment, JsonArray steps)
    {
        var evaluate = new JsonArray(); var test = condition == null ? "True" : Value(condition, evaluate).Text;
        var repeated = new JsonArray(); var next = new JsonArray();
        if (evaluate.Count > 0)
        {
            foreach (var effect in evaluate) repeated.Add(effect!.DeepClone());
            repeated.Add(new JsonObject { ["if"] = "not (" + test + ")", ["label"] = "!(" + condition!.Syntax.ToString() + ")", ["then"] = new JsonArray(new JsonObject { ["break"] = true }) });
            test = "True";
        }
        localControlLabels.Add(loop.ExitLabel); localControlLabels.Add(loop.ContinueLabel);
        var fallsThrough = Statement(body, repeated);
        localControlLabels.Remove(loop.ExitLabel); localControlLabels.Remove(loop.ContinueLabel);
        if (fallsThrough || emittedContinuations.Contains(loop.ContinueLabel)) foreach (var effect in increment) Statement(effect, next);
        steps.Add(new JsonObject { ["while"] = test, ["label"] = condition?.Syntax.ToString() ?? "Continuous loop", ["do"] = repeated, ["next"] = next });
    }
    private void Enumerate(IForEachLoopOperation loop, JsonArray steps)
    {
        // Roslyn exposes array foreach through its implicit non-generic IEnumerable conversion.
        // The native list represents that same array; no user-defined enumerator is discarded.
        var collection = loop.Collection;
        if (collection is IConversionOperation { IsImplicit: true, Operand.Type: IArrayTypeSymbol } converted
            && converted.Type?.SpecialType == SpecialType.System_Collections_IEnumerable) collection = converted.Operand;
        var list = Dereference(Value(collection, steps), steps);
        if (!list.Type.IsList || list.Type.Nullable) throw Unsupported(loop, "Enumeration requires a non-null typed list");
        list = Snapshot(list, steps);
        var symbol = loop.LoopControlVariable switch { IVariableDeclaratorOperation variable => variable.Symbol, ILocalReferenceOperation local => local.Local, _ => null };
        if (symbol == null) throw Unsupported(loop, "Destructuring enumeration is not connected yet");
        var index = Temp(Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Int32)));
        Assign(steps, index.Text, "0"); var repeated = new JsonArray();
        if (list.Type.IsArenaReference)
        {
            SourceValue? version = null;
            if (list.Type.Source is not IArrayTypeSymbol)
                version = Snapshot(new(ReadCell(list, steps).Text + ".Version", index.Type), steps);
            // A foreach obtains the collection once. Each MoveNext reads the same
            // arena identity, checks its version, then decides whether it is finished.
            var current = ReadCell(list, repeated);
            if (version != null) Guard(repeated, (list.Type.IsReadOnlyListReference ? list.Text + ".Kind = 1 and " : "") + current.Text + ".Version <> " + version.Text,
                "InvalidOperationException", "Collection was modified; enumeration operation may not execute.");
            repeated.Add(new JsonObject { ["if"] = index.Text + " >= " + current.Text + ".Items.Length",
                ["then"] = new JsonArray(new JsonObject { ["break"] = true }) });
            Store(repeated, new(Local(symbol), Type(symbol.Type)), new(current.Text + ".Items[" + index.Text + "]", list.Type.Element!), loop);
            localControlLabels.Add(loop.ExitLabel); localControlLabels.Add(loop.ContinueLabel);
            var fallsThrough = Statement(loop.Body, repeated);
            localControlLabels.Remove(loop.ExitLabel); localControlLabels.Remove(loop.ContinueLabel);
            var advance = new JsonArray();
            if (fallsThrough || emittedContinuations.Contains(loop.ContinueLabel)) Assign(advance, index.Text, index.Text + " + 1");
            steps.Add(new JsonObject { ["while"] = "True", ["do"] = repeated, ["next"] = advance });
            return;
        }
        Store(repeated, new(Local(symbol), Type(symbol.Type)), new(list.Text + "[" + index.Text + "]", list.Type.Element!), loop);
        localControlLabels.Add(loop.ExitLabel); localControlLabels.Add(loop.ContinueLabel);
        var completesBody = Statement(loop.Body, repeated);
        localControlLabels.Remove(loop.ExitLabel); localControlLabels.Remove(loop.ContinueLabel);
        var next = new JsonArray();
        if (completesBody || emittedContinuations.Contains(loop.ContinueLabel)) Assign(next, index.Text, index.Text + " + 1");
        steps.Add(new JsonObject { ["while"] = index.Text + " < " + list.Text + ".Length", ["do"] = repeated, ["next"] = next });
    }
    private void Throw(IThrowOperation op, JsonArray steps)
    {
        var value = op.Exception;
        if (value == null)
        {
            if (controlPart == null) throw Unsupported(op, "Rethrow requires an active translated catch context");
            Assign(steps, "AvCompletion.ExceptionRef", "AvCaught"); FinishReference(steps, 2); return;
        }
        while (value is IConversionOperation conversion) value = conversion.Operand;
        if (Managed)
        {
            if (value is IObjectCreationOperation created) ThrowExceptionReference(ConstructExceptionValue(created, steps), steps, check: false);
            else ThrowExceptionReference(Value(op.Exception!, steps), steps, check: true);
            return;
        }
        if (value is not IObjectCreationOperation exception) throw Unsupported(op, "Throw requires a represented exception identity");
        RequireBuiltinException(exception);
        var message = exception.Arguments.FirstOrDefault(a => a.Parameter?.Name == "message")?.Value;
        if (exception.Arguments.Any(a => a.Parameter?.Name is not ("message" or "paramName"))) throw Unsupported(op, "Exception payload translation is not defined");
        steps.Add(new JsonObject { ["raise"] = model.Exception(exception.Type!.Name), ["message"] = message == null ? DataModel.Constant(exception.Type.Name) : Value(message, steps).Text });
    }
}
