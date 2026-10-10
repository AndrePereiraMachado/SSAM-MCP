using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed record MethodDeclaration(IMethodSymbol Symbol, string Name, SymbolNames Parameters, IOperation? BoundBody = null)
{
    public string Result => "AvResult";
    public string Receiver => "AvThis";
    public bool HasReceiver => !Symbol.IsStatic && Symbol.MethodKind == MethodKind.Ordinary;
    public bool IsService => SourceProgram.Attribute(Symbol, "Anvil.Authoring.ServiceActionAttribute") != null;
    public bool IsPublicEntry => Symbol.IsStatic && (IsService || Symbol.DeclaredAccessibility == Accessibility.Public);
    public string CallName => IsService ? "AvService_" + SymbolNames.Digest(Symbol.ToDisplayString()) : Name;
    public string Parameter(IParameterSymbol parameter) => SymbolNames.Normalize("Arg_" + Parameters[parameter]);
}

/// <summary>All source methods are bound before any body is lowered, including forward calls and overloads.</summary>
internal sealed class LogicModel
{
    internal SourceProgram Program { get; }
    internal DataModel Data { get; }
    internal ReferenceModel References { get; }
    internal ExceptionControlModel Control { get; }
    private readonly Dictionary<IMethodSymbol, MethodDeclaration> methods = new(SymbolEqualityComparer.Default);
    private readonly SortedSet<string> exceptions = new(StringComparer.Ordinal);
    private readonly SortedSet<string> roles = new(StringComparer.Ordinal);
    private readonly Dictionary<string, JsonObject> intrinsicHelpers = new(StringComparer.Ordinal);
    private readonly SortedDictionary<string,FrameworkIntrinsic> requiredIntrinsics=new(StringComparer.Ordinal);
    internal IReadOnlyList<FrameworkIntrinsic> RequiredIntrinsics=>requiredIntrinsics.Values.ToArray();
    internal string Require(FrameworkIntrinsic intrinsic)
    {
        requiredIntrinsics.TryAdd(intrinsic.Reference,intrinsic);return intrinsic.Reference;
    }
    public JsonArray Mapping { get; } = [];
    internal JsonArray SourceAbis { get; } = [];
    internal LogicModel(SourceProgram program, DataModel data, bool graphBoundaries = false)
    {
        Program = program; Data = data;
        var lambdas = program.Compilation.SyntaxTrees.SelectMany(tree => tree.GetRoot().DescendantNodes().OfType<AnonymousFunctionExpressionSyntax>())
            .Select(syntax => program.Model(syntax).GetOperation(syntax)).OfType<IAnonymousFunctionOperation>()
            .Where(lambda => !InlineQueryLambda(lambda)).ToArray();
        var symbols = program.Types.SelectMany(t => t.GetMembers().OfType<IMethodSymbol>())
            .Where(m => !m.IsImplicitlyDeclared && m.MethodKind == MethodKind.Ordinary)
            .Concat(program.Compilation.SyntaxTrees.SelectMany(tree => tree.GetRoot().DescendantNodes().OfType<LocalFunctionStatementSyntax>()
                .Select(syntax => program.Model(syntax).GetDeclaredSymbol(syntax)).OfType<IMethodSymbol>()))
            .Concat(lambdas.Select(lambda => lambda.Symbol)).ToArray();
        // Instance helpers occupy a separate private namespace; adding one must not
        // rename a previously existing static entry point with the same source name.
        var staticNames = new SymbolNames(symbols.Where(symbol => symbol.IsStatic && symbol.MethodKind == MethodKind.Ordinary));
        var instanceNames = new SymbolNames(symbols.Where(symbol => !symbol.IsStatic && symbol.MethodKind == MethodKind.Ordinary));
        SourceProgram.CollectDiagnostics(symbols, symbol =>
        {
            if (symbol.IsGenericMethod || symbol.IsAbstract || symbol.IsExtern)
                throw SourceProgram.Error("AVCS301", "Actions require concrete non-generic methods", symbol);
            if (!symbol.IsStatic && symbol.MethodKind == MethodKind.Ordinary)
            {
                if (SourceProgram.Attribute(symbol, "Anvil.Authoring.ServiceActionAttribute") != null ||
                    SourceProgram.Attribute(symbol, "Anvil.Authoring.AuthorizeAttribute") != null)
                    throw SourceProgram.Error("AVCS307", "Instance methods are private native helpers; ServiceAction/Authorize require a static entry point", symbol);
                if (symbol.ContainingType.TypeKind != TypeKind.Class || symbol.ContainingType.IsGenericType ||
                    symbol.ContainingType.BaseType?.SpecialType != SpecialType.System_Object || symbol.IsVirtual || symbol.IsOverride)
                    throw SourceProgram.Error("AVCS308", "Instance helpers require a source class receiver without inheritance or virtual dispatch; struct receivers are not copied implicitly", symbol);
            }
            if (symbol.IsAsync) throw SourceProgram.Error("AVCS302", "Async effects require asynchronous action translation", symbol);
            if (symbol.Parameters.Any(p => p.RefKind != RefKind.None) || symbol.ReturnsByRef || symbol.ReturnsByRefReadonly)
                throw SourceProgram.Error("AVCS303", "Reference parameter/return translation is not connected yet", symbol);
            var name = symbol.MethodKind is MethodKind.LocalFunction or MethodKind.AnonymousFunction
                ? "AvLocal_" + SymbolNames.Digest(symbol.ContainingSymbol.ToDisplayString() + ":" + symbol.DeclaringSyntaxReferences.Single().Span.Start) + "_" + SymbolNames.Normalize(symbol.Name)
                : (symbol.IsStatic ? staticNames : instanceNames)[symbol];
            methods.Add(symbol, new(symbol, name, new SymbolNames(symbol.Parameters), lambdas.FirstOrDefault(lambda => SymbolEqualityComparer.Default.Equals(lambda.Symbol, symbol))?.Body));
        });
        References = new ReferenceModel(program, data, methods.Values, graphBoundaries);
        Control = new ExceptionControlModel(this, methods.Values);
    }
    internal MethodDeclaration Method(IMethodSymbol symbol) => methods.TryGetValue(symbol, out var method) ? method
        : throw SourceProgram.Error("AVCS304", "Call has no bound action: " + symbol.ToDisplayString(), symbol);
    internal bool HasMethod(IMethodSymbol symbol) => methods.ContainsKey(symbol);
    internal static bool InlineQueryLambda(IOperation operation)
    {
        for (var parent = operation.Parent; parent != null; parent = parent.Parent)
        {
            if (parent is IInvocationOperation call) return call.TargetMethod.ContainingNamespace.ToDisplayString() == "System.Linq";
            if (parent is IBlockOperation or IAnonymousFunctionOperation) break;
        }
        return false;
    }
    internal static bool DataDependency(ITypeSymbol type) => type.ToDisplayString()=="Anvil.Authoring.IDataSession";
    internal string Exception(string name) { var native = SymbolNames.Normalize(name); exceptions.Add(native); return native; }
    internal string DecimalArithmetic(BinaryOperatorKind operation, bool representedFailure = false)
    {
        var key="System.Decimal."+operation + (representedFailure ? ".Completion" : "");
        if(intrinsicHelpers.TryGetValue(key,out var existing))return existing["name"]!.ToString();
        var symbol=operation switch {BinaryOperatorKind.Add=>"+",BinaryOperatorKind.Subtract=>"-",BinaryOperatorKind.Multiply=>"*",BinaryOperatorKind.Divide=>"/",BinaryOperatorKind.Remainder=>null,_=>throw new ArgumentException("Unsupported decimal operation")};
        var name=SymbolNames.Allocate("AvIntrinsic_"+SymbolNames.Digest(key),candidate=>
            methods.Values.Any(m=>m.Name.Equals(candidate,StringComparison.OrdinalIgnoreCase)||m.CallName.Equals(candidate,StringComparison.OrdinalIgnoreCase))
            || intrinsicHelpers.Values.Any(helper=>helper["name"]!.ToString().Equals(candidate,StringComparison.OrdinalIgnoreCase)));
        JsonObject Parameter(string parameter)=>new(){["name"]=parameter,["type"]="Decimal"};
        var outputs = new JsonArray(Parameter("AvResult"));
        if (representedFailure) outputs.Add(new JsonObject { ["name"] = "AvOverflow", ["type"] = "Boolean" });
        var failed = representedFailure
            ? new JsonArray(new JsonObject { ["assign"] = new JsonObject { ["AvOverflow"] = "True" } })
            : new JsonArray(new JsonObject { ["raise"] = Exception("OverflowException"), ["message"] = DataModel.Constant("Value was either too large or too small for a Decimal.") });
        intrinsicHelpers.Add(key,new JsonObject {
            ["name"]=name,["public"]=false,["description"]="C# decimal arithmetic; isolated native overflow boundary.",
            ["inputs"]=new JsonArray(Parameter("Left"),Parameter("Right")),["outputs"]=outputs,
            ["steps"]=new JsonArray(new JsonObject {["assign"]=new JsonObject {["AvResult"]=symbol==null?"Mod(Left, Right)":"Left "+symbol+" Right"}}),
            ["handlers"]=new JsonArray(new JsonObject {["name"]="ArithmeticOverflow",["exception"]="@espace/AllExceptions",["abortTransaction"]=false,["logError"]=false,
                ["steps"]=failed})});
        return name;
    }
    internal void Apply(JsonObject contract)
    {
        var actions = new JsonArray(); var managedEntries = new List<(MethodDeclaration Method, JsonObject Action)>();
        SourceProgram.CollectDiagnostics(methods.Values, method =>
        {
            var body = Control.Body(method.Symbol);
            var action = new MethodCompiler(this, method).Compile(body);
            var service = method.IsService;
            if (References.UsesContext(method.Symbol))
            {
                action["kind"] = "server"; action["public"] = false;
                action["description"] = "C# typed reference implementation; invocation context and completion are generated, not authored.";
                actions.Add(action);
                var publicEntry = method.IsPublicEntry;
                if (publicEntry) managedEntries.Add((method, action));
                Mapping.Add(new JsonObject { ["source"] = method.Symbol.ToDisplayString(), ["native"] = publicEntry ? method.Name : References.MethodName(method),
                    ["kind"] = service ? "service" : "server", ["implementation"] = References.MethodName(method) });
                return;
            }
            action["kind"] = "server";
            action["public"] = !service && method.Symbol.DeclaredAccessibility == Accessibility.Public;
            if (service || action["public"]!.GetValue<bool>()) action["access"] = new JsonObject { ["authenticated"] = true };
            if (SourceProgram.Attribute(method.Symbol, "Anvil.Authoring.AuthorizeAttribute") is { } authorization)
            {
                var allowed = authorization.ConstructorArguments[0].Values.Select(v => (string)v.Value!).ToArray();
                foreach (var role in allowed)
                {
                    if (SymbolNames.Normalize(role) != role) throw SourceProgram.Error("AVCS306", "Role must have a valid stable identifier: " + role, method.Symbol);
                    roles.Add(role);
                }
                action["access"] = new JsonObject { ["authenticated"] = true, ["roles"] = new JsonArray(allowed.Select(r => (JsonNode)r).ToArray()) };
            }
            actions.Add(action);
            if (service)
            {
                // A native service entry point is remotely callable, but cannot be the target of a local
                // ExecuteServerAction. Keep a single body and let both local C# calls and the endpoint use it.
                var call = new JsonObject { ["call"] = method.CallName, ["as"] = "Implementation", ["args"] = new JsonObject(
                    action["inputs"]!.AsArray().Select(p => KeyValuePair.Create(p!["name"]!.ToString(),(JsonNode?)JsonValue.Create(p["name"]!.ToString())))) };
                var forwarded = new JsonArray(call);
                if (!method.Symbol.ReturnsVoid) forwarded.Add(new JsonObject { ["assign"] = new JsonObject { [method.Result] = "Implementation." + method.Result } });
                actions.Add(new JsonObject { ["name"] = method.Name, ["kind"] = "service", ["public"] = true,
                    ["access"] = action["access"]?.DeepClone(), ["inputs"] = action["inputs"]!.DeepClone(),
                    ["outputs"] = action["outputs"]!.DeepClone(), ["steps"] = forwarded });
            }
            Mapping.Add(new JsonObject { ["source"] = method.Symbol.ToDisplayString(), ["native"] = method.Name, ["kind"] = service ? "service" : "server" });
        });
        foreach (var helper in Control.Compile()) actions.Add(helper);
        if (References.GraphBoundaries && managedEntries.Count > 0) Exception("InvalidOperationException");
        foreach (var (method, implementation) in managedEntries)
        {
            var entry = References.Entry(method, implementation, new MethodCompiler(this, method)); entry["kind"] = method.IsService ? "service" : "server"; entry["public"] = true;
            entry["access"] = new JsonObject { ["authenticated"] = true };
            if (SourceProgram.Attribute(method.Symbol, "Anvil.Authoring.AuthorizeAttribute") is { } authorization)
            {
                var allowed = authorization.ConstructorArguments[0].Values.Select(v => (string)v.Value!).ToArray();
                foreach (var role in allowed)
                {
                    if (SymbolNames.Normalize(role) != role) throw SourceProgram.Error("AVCS306", "Role must have a valid stable identifier: " + role, method.Symbol);
                    roles.Add(role);
                }
                entry["access"] = new JsonObject { ["authenticated"] = true, ["roles"] = new JsonArray(allowed.Select(r => (JsonNode)r).ToArray()) };
            }
            actions.Add(entry);
            if (References.GraphBoundaries && References.Boundary(method.Symbol).RequiresSourceCodec)
                SourceAbis.Add(new JsonObject { ["source"] = method.Symbol.ToDisplayString(), ["native"] = method.Name,
                    ["kind"] = method.IsService ? "service" : "server", ["abi"] = ReferenceSourceAbi.Describe(References.Boundary(method.Symbol), Data) });
        }
        foreach (var helper in intrinsicHelpers.OrderBy(pair => pair.Key, StringComparer.Ordinal)) actions.Add(helper.Value);
        if (actions.Count > 0) contract["logic"] = new JsonObject { ["actions"] = actions };
        if (exceptions.Count > 0) contract["exceptions"] = new JsonArray(exceptions.Select(e => (JsonNode)new JsonObject { ["name"] = e }).ToArray());
        if (roles.Count > 0) contract["roles"] = new JsonArray(roles.Select(r => (JsonNode)new JsonObject { ["name"] = r, ["public"] = true }).ToArray());
    }
}
