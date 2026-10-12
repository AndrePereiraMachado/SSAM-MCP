using System.Collections;
using System.Reflection;
using System.Text.RegularExpressions;

// Public SDK contracts the witness reader may use. Interface full names, except the O11 CallFunction
// element and its argument, which have no public interface on the 11.55 SDK.
internal sealed record WitnessContracts(string Name, string Expression, string Element, string Binary, string Unary, string BooleanLiteral,
    string Identifier, string FunctionCall, string FunctionBinding, string ArgumentValueContract, string ArgumentValue, string ObjectBinding,
    string? BuiltinBinding, string? RuntimeNameBinding, string? BuiltinConstants, string? BuiltinInfo, string? UsedObjects,
    string ObjectSignature, string GlobalKey, string ESpace, string? BuiltinCatalogProperty, string? BuiltinCatalog, string Role, string? ClientCheck,
    string? FallbackExpression, string? FallbackRoot, string? FallbackReferedObject) {
    const string X = "OutSystems.Model.Expressions.", Nd = X + "Nodes.", El = "ServiceStudio.Expressions.ExpressionElements.";
    internal static readonly WitnessContracts O11 = new("o11-v1-expression-elements", "OutSystems.Model.IExpression", X + "IExpressionElement",
        X + "IBinaryOperation", X + "IUnaryOperation", X + "IBooleanLiteral", X + "IIdentifier", El + "CallFunction", "Reference",
        El + "ArgumentExpression", "ArgumentExpressionElement", X + "IObjectBinding", null, X + "IRuntimePropertyBinding",
        "ServiceStudio.Scope.BuiltinFunctions+Constants", null, null, "OutSystems.Model.IObjectSignature", "OutSystems.Model.IGlobalKey",
        "OutSystems.Model.IESpace", null, null, "OutSystems.Model.Logic.IRoleSignature", null,
        "ServiceStudio.Expressions.AbstractExpression", "RootExpressionElement", "ReferedObject");
    internal static readonly WitnessContracts Odc = new("odc-expression-nodes", X + "IExpression", Nd + "IExpressionNode",
        Nd + "IBinaryOperation", Nd + "IUnaryOperation", Nd + "IBooleanLiteral", Nd + "IIdentifier", Nd + "IFunctionCall", "Function",
        Nd + "IArgument", "Value", X + "IObjectBinding", X + "IBuiltinFunctionBinding", null, null, X + "IBuiltinFunctionInfo", "UsedObjects",
        "OutSystems.Model.IObjectSignature", "OutSystems.Model.IGlobalKey", "OutSystems.Model.IESpace", "BuiltinFunctions", X + "IBuiltinFunctions",
        "OutSystems.Model.Logic.IRoleSignature", "CheckRoleClientSideAction", null, null, null);
}

// Model-only provenance of identity/role witnesses (ssam-native-witness-bindings/1). Reads the installed
// expression tree; never evaluates it and never matches by display name. A builtin is original when it is
// the module's canonical instance (ODC) or an unbound runtime-name reference equal to the installed SDK
// constant (O11, no canonical instance there). A role check is the action its parent role exposes, by
// reference, as Check<Role>Role. Role ownership comes from the native global key.
internal static class NativeWitnessBindings {
    static readonly string[] Identity = ["GetUserId", "NullIdentifier", "NullTextIdentifier"];
    static readonly Regex Global = new(@"^([A-Za-z0-9_+]{22})\*([A-Za-z0-9_+]{22})$");
    const BindingFlags Declared = BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly;

    static Type? Contract(object? value, string? name) {
        if (value == null || name == null) return null;
        for (var t = value.GetType(); t != null; t = t.BaseType) if (t.FullName == name) return t;
        return value.GetType().GetInterfaces().SingleOrDefault(i => i.FullName == name);
    }
    static bool Is(object? value, string? name) => Contract(value, name) != null;
    // Property of a named contract: the interface member (explicit implementations included) or, for a
    // class contract, the most derived declaration. A missing member is a contract break, not a null.
    static object? Get(object value, string contract, string name) {
        var type = Contract(value, contract) ?? throw new InvalidOperationException();
        if (type.IsInterface) return (type.GetProperty(name, Declared) ?? throw new InvalidOperationException()).GetValue(value);
        for (var t = value.GetType(); t != null; t = t.BaseType)
            if (t.GetProperty(name, Declared) is { } p && p.GetIndexParameters().Length == 0) return p.GetValue(value);
        throw new InvalidOperationException();
    }
    static IEnumerable<object> Items(object? value) => value is IEnumerable e && value is not string ? e.Cast<object>() : throw new InvalidOperationException();

    public static object Read(object module, object function, IEnumerable<object> objects, string sourceSha256, WitnessContracts? contracts = null) {
        string? Key(object? o, WitnessContracts c) => o == null ? null : Is(o, c.ObjectSignature) ? Get(o, c.ObjectSignature, "ObjectKey")?.ToString() : null;
        var guess = contracts ?? (objects.Any(o => Is(o, WitnessContracts.Odc.Expression)) ? WitnessContracts.Odc : WitnessContracts.O11);
        var moduleKey = Key(module, guess); var functionKey = Key(function, guess);
        var identity = new { sourceSha256, moduleKey, functionKey };
        const string schema = "ssam-native-witness-bindings/1";
        try {
            var c = guess;
            bool Under(object o) {
                var parent = Get(o, c.ObjectSignature, "Parent");
                for (var depth = 0; parent != null && depth < 64; depth++, parent = Is(parent, c.ObjectSignature) ? Get(parent, c.ObjectSignature, "Parent") : null)
                    if (ReferenceEquals(parent, function)) return true;
                return false;
            }
            var expressions = objects.Where(o => Is(o, c.ObjectSignature) && (Is(o, c.Expression) || Is(o, c.FallbackExpression) || (Key(o, c) ?? "").Contains(".#")) && Under(o))
                .DistinctBy(o => Key(o, c)).ToArray();
            if (expressions.Any(e => !Is(e, c.Expression) && !Is(e, c.FallbackExpression)))
                return new { schema, available = false, identity, reason = "native_expression_tree_contract_unavailable" };
            if (expressions.Length > 1000 || moduleKey == null || functionKey == null) throw new InvalidOperationException();
            var fallback = expressions.Any(e => !Is(e, c.Expression));
            object? catalog = c.BuiltinCatalogProperty != null ? Get(module, c.ESpace, c.BuiltinCatalogProperty) : null;
            object? registered = Get(module, c.ESpace, "RegisteredRole"), anonymous = Get(module, c.ESpace, "AnonymousRole");
            var localRoles = Items(Get(module, c.ESpace, "Roles")).ToArray();
            int count = 0;
            object Ref(object o) => new { key = Key(o, c) ?? throw new InvalidOperationException(), kind = o.GetType().Name };
            // Native ownership: ODC global key members, O11 '<module>*<object>' rendering; a local role falls back to the module.
            string? Owner(object role, string roleKey) {
                var global = Get(role, c.ObjectSignature, "GlobalKey");
                if (Contract(global, c.GlobalKey) is { } g && g.GetProperty("ModuleKey") is { } mk && g.GetProperty("ObjectKey") is { } ok)
                    return ok.GetValue(global)?.ToString() == roleKey ? mk.GetValue(global)?.ToString() : null;
                if (global != null && Global.Match(global.ToString() ?? "") is { Success: true } m) return m.Groups[2].Value == roleKey ? m.Groups[1].Value : null;
                return localRoles.Any(r => ReferenceEquals(r, role)) ? moduleKey : null;
            }
            object? RoleOf(object target) {
                var role = Is(target, c.ObjectSignature) ? Get(target, c.ObjectSignature, "Parent") : null;
                if (!Is(role, c.Role)) return null;
                var check = ReferenceEquals(Get(role!, c.Role, "CheckRoleAction"), target) ? "server"
                    : c.ClientCheck != null && ReferenceEquals(Get(role!, c.Role, c.ClientCheck), target) ? "client" : null;
                if (check == null) return null;
                var roleKey = Key(role, c) ?? throw new InvalidOperationException();
                bool? pub = null;
                for (var t = role!.GetType(); t != null && pub == null; t = t.BaseType) pub = t.GetProperty("Public", Declared)?.GetValue(role) as bool?;
                return new { roleKey, ownerModuleKey = Owner(role, roleKey), name = Get(role, c.Role, "Name") as string,
                    persistent = Get(role, c.Role, "IsPersistent") as bool?, @public = pub, check,
                    system = ReferenceEquals(role, registered) ? "Registered" : ReferenceEquals(role, anonymous) ? "Anonymous" : null };
            }
            bool Original(object binding, out string? name) {
                name = null;
                if (Is(binding, c.BuiltinBinding)) {
                    var builtin = Get(binding, c.BuiltinBinding!, "Function") ?? throw new InvalidOperationException();
                    name = Get(builtin, c.BuiltinInfo!, "Name") as string;
                    return name != null && Identity.Contains(name) && catalog != null && ReferenceEquals(Get(catalog, c.BuiltinCatalog!, name), builtin);
                }
                if (Is(binding, c.RuntimeNameBinding) && !Is(binding, c.ObjectBinding)) {
                    name = Get(binding, c.RuntimeNameBinding!, "Name") as string;
                    var constants = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(c.BuiltinConstants!)).Where(t => t != null).ToArray();
                    return name != null && Identity.Contains(name) && constants.Length == 1 &&
                        constants[0]!.GetField(name, BindingFlags.Public | BindingFlags.Static) is { IsLiteral: true } f && f.GetRawConstantValue() as string == name;
                }
                return false;
            }
            object Node(object? node, int depth) {
                if (node == null || depth > 40 || ++count > 10000 || !Is(node, c.Element)) throw new InvalidOperationException();
                string kind; bool call = false, original = false; string? builtin = null, op = null; bool? literal = null;
                object? role = null, functionObject = null; var children = new List<object>(); var used = new List<object>();
                if (Is(node, c.FunctionCall)) {
                    kind = "FunctionCall"; call = true;
                    var binding = Get(node, c.FunctionCall, c.FunctionBinding);
                    var target = Is(binding, c.ObjectBinding) ? Get(binding!, c.ObjectBinding, "Object")
                        : binding == null && fallback && c.FallbackReferedObject != null ? Get(node, c.FunctionCall, c.FallbackReferedObject) : null;
                    if (target != null) { role = RoleOf(target); if (role == null) functionObject = Ref(target); used.Add(Ref(target)); }
                    else if (binding != null) original = Original(binding, out builtin);
                    else throw new InvalidOperationException();
                    foreach (var argument in Items(Get(node, c.FunctionCall, "Arguments")))
                        children.Add(Node(Get(argument, c.ArgumentValueContract, c.ArgumentValue), depth + 1));
                } else if (Is(node, c.Binary)) {
                    kind = "BinaryOperation"; op = Get(node, c.Binary, "Operator")?.ToString();
                    children.Add(Node(Get(node, c.Binary, "LeftOperand"), depth + 1)); children.Add(Node(Get(node, c.Binary, "RightOperand"), depth + 1));
                } else if (Is(node, c.Unary)) {
                    kind = "UnaryOperation"; op = Get(node, c.Unary, "Operator")?.ToString(); children.Add(Node(Get(node, c.Unary, "Operand"), depth + 1));
                } else if (Is(node, c.BooleanLiteral)) {
                    kind = "BooleanLiteral"; literal = Get(node, c.BooleanLiteral, "Value") as bool? ?? throw new InvalidOperationException();
                } else if (Is(node, c.Identifier)) {
                    kind = "Identifier"; var binding = Get(node, c.Identifier, "Binding");
                    if (Is(binding, c.ObjectBinding) && Get(binding!, c.ObjectBinding, "Object") is { } target) used.Add(Ref(target));
                } else {
                    kind = node.GetType().Name;
                    foreach (var child in Items(Get(node, c.Element, "Children"))) children.Add(Node(child, depth + 1));
                }
                if (c.UsedObjects != null) used = Items(Get(node, c.Element, c.UsedObjects)).Select(Ref).ToList();
                return new { kind, functionCall = call, builtin, originalBuiltin = original, role, functionObject, @operator = op,
                    booleanValue = literal, usedObjects = used, children };
            }
            var rows = expressions.Select(e => new { key = Key(e, c), root = Node(Is(e, c.Expression) ? Get(e, c.Expression, "Root") : Get(e, c.FallbackExpression!, c.FallbackRoot!), 0) }).ToArray();
            return new { schema, available = true, identity, authority = "installed-model-expression-tree",
                contract = c.Name + (fallback ? "-referenced-objects" : ""), runtimeValuesEvaluated = false, expressions = rows };
        } catch {
            return new { schema, available = false, identity, reason = "native_expression_tree_read_failed" };
        }
    }
}
