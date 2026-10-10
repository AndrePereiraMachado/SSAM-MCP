using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private readonly ExceptionControlPart? controlPart;
    private readonly HashSet<ILabelSymbol> localControlLabels = new(SymbolEqualityComparer.Default);
    private ExceptionControlFrame? ControlFrame => model.Control.Frame(method.Symbol);
    private string FramePath => Context + "." + ControlFrame!.Arena + "[AvFrame - 1]";
    private string ReturnPath => ControlFrame == null ? method.Result : FramePath + ".Result";
    internal MethodCompiler(LogicModel model, MethodDeclaration method, ExceptionControlPart part) : this(model, method) => controlPart = part;

    private void InitializeControlFrame(JsonArray steps)
    {
        if (ControlFrame is not { } frame) return;
        var initial = Temp(NativeType(frame.Type));
        variables.Add(Parameter("AvFrame", Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Int32))));
        if (method.HasReceiver) Assign(steps, initial.Text + ".This", method.Receiver);
        if (frame.Method.Symbol.ContainingSymbol is IMethodSymbol) Assign(steps, initial.Text + ".ParentFrame", "AvClosureFrame");
        foreach (var parameter in method.Symbol.Parameters.Where(p => !LogicModel.DataDependency(p.Type)))
            Assign(steps, initial.Text + "." + model.Control.Slot(frame, parameter, parameter.Type), method.Parameter(parameter));
        steps.Add(new JsonObject { ["call"] = "ListAppend", ["as"] = "AvFrameAllocate" + ++calls,
            ["args"] = new JsonObject { ["List"] = Context + "." + frame.Arena, ["Element"] = initial.Text } });
        Assign(steps, "AvFrame", Context + "." + frame.Arena + ".Length");
    }

    internal JsonObject CompileControlPart()
    {
        var part = controlPart!;
        var integer = Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Int32));
        var inputs = new JsonArray(Parameter("AvContextIn", NativeType(model.References.ContextType)), Parameter("AvFrame", integer), Parameter("AvCaught", integer));
        var outputs = new JsonArray(Parameter("AvContextOut", NativeType(model.References.ContextType)), Parameter("AvCompletion", NativeType(model.References.CompletionType)));
        variables.Add(Parameter(Context, NativeType(model.References.ContextType)));
        var steps = new JsonArray();
        Assign(steps, Context, "AvContextIn"); Assign(steps, "AvCompletion.ExceptionRef", "AvCaught");
        Guard(steps, "AvFrame < 1 or AvFrame > " + Context + "." + ControlFrame!.Arena + ".Length", "InvalidOperationException", "Exception region frame does not belong to this invocation.");
        if (part.Catch != null && (part.Filter || part.Catch.Filter == null))
            foreach (var local in part.Catch.Locals.Where(local => ExceptionTypes.IsException(local.Type, model.Program.Compilation)))
                Assign(steps, Local(local) + ".Index", "AvCaught");
        if (part.Filter)
        {
            var boolean = Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Boolean));
            outputs.Add(Parameter("AvFilterResult", boolean));
            Assign(steps, "AvFilterResult", Value(part.Operation, steps).Text);
            FinishReference(steps, 0);
        }
        else if (Statement(part.Operation, steps)) FinishReference(steps, 0);
        NormalizeReferenceRaises(steps);
        for (var index = referencePrelude.Count - 1; index >= 0; index--) steps.Insert(0, referencePrelude[index]!.DeepClone());
        return new() { ["name"] = part.Name, ["kind"] = "server", ["public"] = false, ["inputs"] = inputs,
            ["outputs"] = outputs, ["vars"] = variables, ["steps"] = steps,
            ["description"] = "Statically compiled C# exception region; typed captured frame and structured completion." };
    }

    private void CompileTry(ITryOperation operation, JsonArray steps)
    {
        var region = ControlFrame!.Regions[operation.Syntax.SpanStart];
        var active = Temp(NativeType(model.Control.RegionType));
        var pending = Temp(NativeType(model.References.CompletionType));
        Assign(steps, Context + ".NextRegion", Context + ".NextRegion + 1");
        Assign(steps, active.Text + ".Region", region.Id.ToString());
        Assign(steps, active.Text + ".Frame", "AvFrame");
        Assign(steps, active.Text + ".Activation", Context + ".NextRegion");
        steps.Add(new JsonObject { ["call"] = "ListAppend", ["as"] = "AvRegionPush" + ++calls,
            ["args"] = new JsonObject { ["List"] = Context + ".ActiveRegions", ["Element"] = active.Text } });
        var invoked = CallControl(region.BodyName, controlPart == null ? "0" : "AvCaught", steps);
        Assign(steps, pending.Text, invoked + ".AvCompletion");
        // Search has already run inside the throwing activation. Deactivate this
        // region before its catch/finally, so a replacement throw searches outward.
        steps.Add(new JsonObject { ["call"] = "ListRemove", ["as"] = "AvRegionPop" + ++calls,
            ["args"] = new JsonObject { ["List"] = Context + ".ActiveRegions", ["Position"] = Context + ".ActiveRegions.Length - 1" } });
        for (var i = 0; i < operation.Catches.Length; i++)
        {
            var caught = new JsonArray();
            var handler = CallControl(region.CatchName(i), pending.Text + ".ExceptionRef", caught);
            Assign(caught, pending.Text, handler + ".AvCompletion");
            steps.Add(new JsonObject { ["if"] = pending.Text + ".Kind = 2 and " + pending.Text + ".TargetRegion = " + active.Text + ".Activation and " + pending.Text + ".Handler = " + (i + 1), ["then"] = caught });
        }
        if (operation.Finally != null)
        {
            var cleanup = CallControl(region.FinallyName, controlPart == null ? "0" : "AvCaught", steps);
            steps.Add(new JsonObject { ["if"] = cleanup + ".AvCompletion.Kind <> 0",
                ["then"] = new JsonArray(new JsonObject { ["assign"] = new JsonObject { [pending.Text] = cleanup + ".AvCompletion" } }) });
        }
        foreach (var label in localControlLabels)
        {
            var branchKind = ControlFrame.Labels[label];
            var branch = new JsonArray();
            // Label kind comes from the compiled Roslyn loop inventory, never a source string.
            var isContinue = IsContinueLabel(label);
            if (isContinue) emittedContinuations.Add(label);
            branch.Add(new JsonObject { [isContinue ? "continue" : "break"] = true });
            steps.Add(new JsonObject { ["if"] = pending.Text + ".Kind = " + (isContinue ? 4 : 3) + " and " + pending.Text + ".Target = " + branchKind,
                ["then"] = branch });
        }
        var transfer = new JsonArray();
        Assign(transfer, "AvCompletion", pending.Text);
        if (controlPart == null && !method.Symbol.ReturnsVoid) Assign(transfer, method.Result, ReturnPath);
        Assign(transfer, "AvContextOut", Context);
        transfer.Add(new JsonObject { ["return"] = true });
        steps.Add(new JsonObject { ["if"] = pending.Text + ".Kind <> 0", ["then"] = transfer });
    }

    private bool IsContinueLabel(ILabelSymbol label) => ControlFrame!.ContinueLabels.Contains(label);

    private string FrameIndex(IMethodSymbol owner)
    {
        var current = method.Symbol; var index = "AvFrame";
        while (!SymbolEqualityComparer.Default.Equals(current, owner))
        {
            var frame = model.Control.Frame(current) ?? throw SourceProgram.Error("AVCS348", "Captured frame is unavailable", owner);
            index = Context + "." + frame.Arena + "[" + index + " - 1].ParentFrame";
            current = current.ContainingSymbol as IMethodSymbol ?? throw SourceProgram.Error("AVCS348", "Capture does not belong to an enclosing method", owner);
        }
        return index;
    }

    private string CapturedPath(ISymbol symbol, ITypeSymbol type)
    {
        var owner = symbol.ContainingSymbol as IMethodSymbol ?? method.Symbol;
        var frame = model.Control.Frame(owner) ?? throw SourceProgram.Error("AVCS348", "Capture has no typed frame", symbol);
        return Context + "." + frame.Arena + "[" + FrameIndex(owner) + " - 1]." + model.Control.Slot(frame, symbol, type);
    }

    private string CapturedReceiverPath()
    {
        var owner = method.Symbol;
        while (owner.ContainingSymbol is IMethodSymbol parent) owner = parent;
        var frame = model.Control.Frame(owner)!;
        return Context + "." + frame.Arena + "[" + FrameIndex(owner) + " - 1].This";
    }

    private string CallControl(string target, string caught, JsonArray steps)
    {
        var name = "AvRegionCall" + ++calls;
        steps.Add(new JsonObject { ["call"] = target, ["as"] = name,
            ["args"] = new JsonObject { ["AvContextIn"] = Context, ["AvFrame"] = "AvFrame", ["AvCaught"] = caught } });
        Assign(steps, Context, name + ".AvContextOut");
        return name;
    }

    private void SearchException(JsonArray steps)
    {
        var name = "AvSearch" + ++calls;
        steps.Add(new JsonObject { ["call"] = model.Control.SearchName, ["as"] = name,
            ["args"] = new JsonObject { ["AvContextIn"] = Context, ["AvExceptionRef"] = "AvCompletion.ExceptionRef" } });
        Assign(steps, Context, name + ".AvContextOut");
        Assign(steps, "AvCompletion.TargetRegion", name + ".AvTargetRegion");
        Assign(steps, "AvCompletion.Handler", name + ".AvHandler");
    }
}
