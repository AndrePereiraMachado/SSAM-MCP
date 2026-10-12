using System.Collections;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;

// Model-only witness provenance. Fakes carry the SDK shapes under test-only contract names; the
// production contract names are checked separately against the installed SDK (no model is opened).
static class NativeWitnessBindingsTests {
    const string M = "MMMMMMMMMMMMMMMMMMMMMM", P = "PPPPPPPPPPPPPPPPPPPPPP", F = "FFFFFFFFFFFFFFFFFFFFFF", R = "RRRRRRRRRRRRRRRRRRRRRR";
    static readonly string Sha = new('a', 64);
    static void Check(bool condition, string message) { if (!condition) throw new Exception("witness bindings: " + message); }
    const string N = "WitnessFakes.";
    static WitnessContracts Fake(bool odc) => new(odc ? "odc-expression-nodes" : "o11-v1-expression-elements", N + "IExpr", N + "IElem", N + "IBin", N + "IUn", N + "IBool", N + "IIdent",
        odc ? N + "ICall" : N + "O11Call", odc ? "Function" : "Reference", odc ? N + "IArg" : N + "O11Arg", odc ? "Value" : "ArgumentExpressionElement",
        N + "IObjBinding", odc ? N + "IBuiltinBinding" : null, odc ? null : N + "INameBinding", odc ? null : N + "O11Constants", odc ? N + "IBuiltinFn" : null,
        odc ? "UsedObjects" : null, N + "IObj", N + "IGKey", N + "IModule", odc ? "BuiltinFunctions" : null, odc ? N + "IBuiltins" : null, N + "IRoleSig",
        odc ? "CheckRoleClientSideAction" : null, odc ? null : N + "O11Expression", odc ? null : "RootExpressionElement", odc ? null : "ReferedObject");

    sealed class World {
        public readonly WitnessFakes.Module Module; public readonly WitnessFakes.Model Function; public readonly WitnessFakes.Model Assignment;
        public readonly WitnessFakes.Role Role; public readonly WitnessFakes.Model Input; readonly bool odc;
        public World(bool odc, string roleModule = M) {
            this.odc = odc;
            Module = new WitnessFakes.Module(M);
            Function = new WitnessFakes.Model(F, Module);
            Assignment = new WitnessFakes.Model("AAAAAAAAAAAAAAAAAAAAAA", Function);
            Input = new WitnessFakes.Model("IIIIIIIIIIIIIIIIIIIIII", Function);
            Role = new WitnessFakes.Role(R, Module, odc ? new WitnessFakes.GKey(roleModule, R) : new WitnessFakes.O11GKey(roleModule, R), "SSAMIdentityRole20261010");
            if (roleModule == M) Module.Roles.Add(Role);
        }
        public object Builtin(string name) => odc ? new WitnessFakes.Call(new WitnessFakes.BuiltinBinding(Module.Builtins.Get(name)), [])
            : new WitnessFakes.O11Call(new WitnessFakes.NameBinding(name), []);
        public object CallObject(object target, params object[] args) => odc
            ? new WitnessFakes.Call(new WitnessFakes.ObjBinding(target), args.Select(a => (object)new WitnessFakes.Arg(a)).ToArray())
            : new WitnessFakes.O11Call(new WitnessFakes.ObjBinding(target), args.Select(a => (object)new WitnessFakes.O11Arg(a)).ToArray());
        public object Ident(object target) => new WitnessFakes.Ident(new WitnessFakes.ObjBinding(target));
        public JsonElement Read(object root, string field = "Value", object? parent = null) {
            var expression = new WitnessFakes.Expression(Assignment.Key + ".#" + field, parent ?? Assignment, root);
            var foreign = new WitnessFakes.Expression("XXXXXXXXXXXXXXXXXXXXXX.#Value", new WitnessFakes.Model("XXXXXXXXXXXXXXXXXXXXXX", Module), new WitnessFakes.Bool(true));
            return Json(NativeWitnessBindings.Read(Module, Function, [expression, foreign, Function, Module], Sha, Fake(odc)));
        }
    }
    static JsonElement Json(object value) => JsonDocument.Parse(JsonSerializer.Serialize(value)).RootElement.Clone();
    static JsonElement Root(JsonElement result) {
        Check(result.GetProperty("available").GetBoolean(), "available: " + result);
        Check(result.GetProperty("runtimeValuesEvaluated").GetBoolean() == false && result.GetProperty("authority").GetString() == "installed-model-expression-tree", "model-only authority");
        var identity = result.GetProperty("identity");
        Check(identity.GetProperty("moduleKey").GetString() == M && identity.GetProperty("functionKey").GetString() == F && identity.GetProperty("sourceSha256").GetString() == Sha, "identity pinned");
        var rows = result.GetProperty("expressions");
        Check(rows.GetArrayLength() == 1, "only the function's expressions are read");
        return rows[0].GetProperty("root");
    }
    static string? Str(JsonElement e, string name) => e.GetProperty(name).ValueKind == JsonValueKind.Null ? null : e.GetProperty(name).GetString();

    internal static void Run(string? sdkDir = null) {
        foreach (var odc in new[] { false, true }) Lane(odc);
        if (sdkDir != null) InstalledContracts(sdkDir);
        Console.WriteLine("PASS: native witness bindings");
    }
    static void Lane(bool odc) {
        var lane = odc ? "odc" : "o11";
        var w = new World(odc);
        // builtin GetUserId / NullIdentifier, original
        var user = Root(w.Read(w.Builtin("GetUserId")));
        Check(user.GetProperty("kind").GetString() == "FunctionCall" && user.GetProperty("functionCall").GetBoolean() && Str(user, "builtin") == "GetUserId" &&
            user.GetProperty("originalBuiltin").GetBoolean() && user.GetProperty("role").ValueKind == JsonValueKind.Null && user.GetProperty("children").GetArrayLength() == 0, lane + " GetUserId builtin");
        var present = Root(w.Read(new WitnessFakes.Bin("NotEqual", w.Builtin("GetUserId"), w.Builtin("NullIdentifier"))));
        Check(present.GetProperty("kind").GetString() == "BinaryOperation" && Str(present, "operator") == "NotEqual", lane + " comparison operator");
        Check(Str(present.GetProperty("children")[1], "builtin") == "NullIdentifier" && present.GetProperty("children")[1].GetProperty("originalBuiltin").GetBoolean(), lane + " NullIdentifier builtin");
        // comparison operand bound to an input
        var equals = Root(w.Read(new WitnessFakes.Bin("Equal", w.Builtin("GetUserId"), w.Ident(w.Input))));
        var operand = equals.GetProperty("children")[1];
        Check(operand.GetProperty("kind").GetString() == "Identifier" && operand.GetProperty("usedObjects")[0].GetProperty("key").GetString() == w.Input.Key, lane + " identifier operand key");
        // role check binding: role key, owner module, persistent/public flags
        var role = Root(w.Read(w.CallObject(w.Role.Check, w.Builtin("GetUserId"))));
        var row = role.GetProperty("role");
        Check(row.ValueKind == JsonValueKind.Object && Str(row, "roleKey") == R && Str(row, "ownerModuleKey") == M && row.GetProperty("persistent").GetBoolean() &&
            row.GetProperty("public").GetBoolean() && Str(row, "check") == "server" && Str(row, "name") == "SSAMIdentityRole20261010", lane + " role row " + row);
        Check(Str(role, "builtin") == null && role.GetProperty("children").GetArrayLength() == 1 && Str(role.GetProperty("children")[0], "builtin") == "GetUserId", lane + " role argument");
        // a sibling role action that is not the role's check action is a foreign function
        var grant = Root(w.Read(w.CallObject(w.Role.Grant, w.Builtin("GetUserId"))));
        Check(grant.GetProperty("role").ValueKind == JsonValueKind.Null && grant.GetProperty("functionObject").GetProperty("key").GetString() == w.Role.Grant.Key, lane + " grant is not a check");
        // registered system role
        var registered = new World(odc); registered.Module.RegisteredRole = registered.Role;
        Check(Str(Root(registered.Read(registered.CallObject(registered.Role.Check))).GetProperty("role"), "system") == "Registered", lane + " registered system role");
        // literal True: reported as a literal, never as a builtin or role
        var literal = Root(w.Read(new WitnessFakes.Bool(true)));
        Check(literal.GetProperty("kind").GetString() == "BooleanLiteral" && literal.GetProperty("booleanValue").GetBoolean() && !literal.GetProperty("functionCall").GetBoolean() &&
            literal.GetProperty("role").ValueKind == JsonValueKind.Null && Str(literal, "builtin") == null, lane + " literal True");
        // substituted builtin: a user function named GetUserId is an object binding, never the builtin
        var fake = new WitnessFakes.Model("UUUUUUUUUUUUUUUUUUUUUU", w.Module) { Name = "GetUserId" };
        var substituted = Root(w.Read(w.CallObject(fake)));
        Check(Str(substituted, "builtin") == null && !substituted.GetProperty("originalBuiltin").GetBoolean() &&
            substituted.GetProperty("functionObject").GetProperty("key").GetString() == fake.Key, lane + " substituted builtin is an object binding");
        var spoofed = odc ? new WitnessFakes.Call(new WitnessFakes.BuiltinBinding(new WitnessFakes.BuiltinFn("GetUserId")), [])
            : (object)new WitnessFakes.O11Call(new WitnessFakes.NameBinding("GetUserID"), []);
        var spoof = Root(w.Read(spoofed));
        Check(!spoof.GetProperty("originalBuiltin").GetBoolean(), lane + " non-canonical builtin is not original");
        // role of another module: ownership comes from the native global key, not from the name
        var other = new World(odc, "OOOOOOOOOOOOOOOOOOOOOO");
        Check(Str(Root(other.Read(other.CallObject(other.Role.Check, other.Builtin("GetUserId")))).GetProperty("role"), "ownerModuleKey") == "OOOOOOOOOOOOOOOOOOOOOO", lane + " foreign role owner");
        // fail closed: a non-element node, or no expression contract at all
        var broken = w.Read(new WitnessFakes.Bin("Equal", w.Builtin("GetUserId"), new object()));
        Check(!broken.GetProperty("available").GetBoolean() && Str(broken, "reason") == "native_expression_tree_read_failed", lane + " unknown node fails closed");
        var none = Json(NativeWitnessBindings.Read(w.Module, w.Function, [new WitnessFakes.Model(w.Assignment.Key + ".#Value", w.Assignment)], Sha, Fake(odc)));
        Check(!none.GetProperty("available").GetBoolean() && Str(none, "reason") == "native_expression_tree_contract_unavailable", lane + " contract unavailable");
        if (odc) {
            var client = Root(w.Read(w.CallObject(w.Role.ClientCheck)));
            Check(Str(client.GetProperty("role"), "check") == "client", "odc client-side role check");
            Check(equals.GetProperty("usedObjects").ValueKind == JsonValueKind.Array, "odc used objects from the node contract");
        } else {
            // usages path: no IExpression contract on this SDK, the expression class root and the referenced object
            var expression = new WitnessFakes.O11Expression(w.Assignment.Key + ".#Value", w.Assignment,
                new WitnessFakes.O11Call(null, [new WitnessFakes.O11Arg(w.Builtin("GetUserId"))]) { ReferedObject = w.Role.Check });
            var usages = Json(NativeWitnessBindings.Read(w.Module, w.Function, [expression], Sha, Fake(false)));
            Check(Str(usages, "contract") == "o11-v1-expression-elements-referenced-objects", "o11 usages contract " + usages);
            Check(Str(Root(usages).GetProperty("role"), "roleKey") == R, "o11 role via referenced object");
        }
    }

    // Production contract names exist in the installed SDK with the properties the reader uses.
    static void InstalledContracts(string dir) {
#if ODC
        var c = WitnessContracts.Odc; var files = new[] { "OutSystems.Model.V1.dll", "OutSystems.Model.dll" };
#else
        var c = WitnessContracts.O11; var files = new[] { "OutSystems.Model.V1.dll", "ServiceStudio.Framework.dll" };
#endif
        var assemblies = files.Select(f => Path.Combine(dir, f)).Where(File.Exists).Select(p => AssemblyLoadContext.Default.LoadFromAssemblyPath(p)).ToArray();
        Type Find(string name) { var found = assemblies.Select(a => a.GetType(name)).Where(t => t != null).ToArray(); Check(found.Length == 1, "sdk type " + name); return found[0]!; }
        void Has(string type, params string[] members) {
            var t = Find(type);
            foreach (var m in members) {
                var all = t.IsInterface ? new[] { t }.Concat(t.GetInterfaces()) : Enumerable.Repeat(t, 1).Concat(Bases(t));
                Check(all.Any(x => x.GetProperty(m, BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly) != null ||
                    x.GetField(m, BindingFlags.Public | BindingFlags.Static) != null), "sdk member " + type + "." + m);
            }
        }
        Has(c.Expression, "Root"); Has(c.Element, c.UsedObjects is { } used ? ["Children", used] : ["Children"]);
        Has(c.Binary, "Operator", "LeftOperand", "RightOperand"); Has(c.Unary, "Operator", "Operand"); Has(c.BooleanLiteral, "Value"); Has(c.Identifier, "Binding");
        Has(c.FunctionCall, c.FunctionBinding, "Arguments"); Has(c.ArgumentValueContract, c.ArgumentValue); Has(c.ObjectBinding, "Object");
        Has(c.ObjectSignature, "ObjectKey", "Parent", "GlobalKey"); Has(c.ESpace, "Roles", "RegisteredRole", "AnonymousRole");
        Has(c.Role, c.ClientCheck is { } cc ? ["Name", "IsPersistent", "CheckRoleAction", cc] : ["Name", "IsPersistent", "CheckRoleAction"]);
        if (c.BuiltinBinding != null) Has(c.BuiltinBinding, "Function");
        if (c.BuiltinInfo != null) Has(c.BuiltinInfo, "Name");
        if (c.BuiltinCatalog != null) { Has(c.ESpace, c.BuiltinCatalogProperty!); Has(c.BuiltinCatalog, "GetUserId", "NullIdentifier", "NullTextIdentifier"); Has(c.GlobalKey, "ModuleKey", "ObjectKey"); }
        if (c.RuntimeNameBinding != null) Has(c.RuntimeNameBinding, "Name");
        if (c.BuiltinConstants != null) Has(c.BuiltinConstants, "GetUserId", "NullIdentifier", "NullTextIdentifier");
        if (c.FallbackExpression != null) Has(c.FallbackExpression, c.FallbackRoot!);
        if (c.FallbackReferedObject != null) Has(c.FunctionCall, c.FallbackReferedObject);
        Console.WriteLine("PASS: installed SDK witness contracts (" + c.Name + ")");
    }
    static IEnumerable<Type> Bases(Type t) { for (var b = t.BaseType; b != null; b = b.BaseType) yield return b; }
}

namespace WitnessFakes {
    public interface IObj { object ObjectKey { get; } object? Parent { get; } object? GlobalKey { get; } }
    public interface IGKey { object ModuleKey { get; } object ObjectKey { get; } }
    public interface IExpr { object? Root { get; } }
    public interface IElem { IEnumerable Children { get; } IEnumerable UsedObjects { get; } }
    public interface IBin : IElem { object Operator { get; } object LeftOperand { get; } object RightOperand { get; } }
    public interface IUn : IElem { object Operator { get; } object Operand { get; } }
    public interface IBool : IElem { bool Value { get; } }
    public interface IIdent : IElem { object Binding { get; } }
    public interface ICall : IElem { object Function { get; } IEnumerable Arguments { get; } }
    public interface IArg : IElem { object Value { get; } }
    public interface IObjBinding { object Object { get; } }
    public interface IBuiltinBinding { object Function { get; } }
    public interface INameBinding { string Name { get; } }
    public interface IBuiltinFn { string Name { get; } }
    public interface IBuiltins { object GetUserId { get; } object NullIdentifier { get; } object NullTextIdentifier { get; } }
    public interface IRoleSig : IObj { string Name { get; } bool IsPersistent { get; } object CheckRoleAction { get; } object CheckRoleClientSideAction { get; } }
    public interface IModule : IObj { IEnumerable Roles { get; } object? RegisteredRole { get; } object? AnonymousRole { get; } object BuiltinFunctions { get; } }
    public static class O11Constants { public const string GetUserId = "GetUserId", NullIdentifier = "NullIdentifier", NullTextIdentifier = "NullTextIdentifier"; }

    public class Model(string key, object? parent = null, object? global = null) : IObj {
        public string Key => key; public string Name { get; set; } = "";
        object IObj.ObjectKey => key; object? IObj.Parent => parent; object? IObj.GlobalKey => global;
        public override string ToString() => key;
    }
    public sealed class GKey(string module, string key) : IGKey { public object ModuleKey => module; public object ObjectKey => key; }
    public sealed class O11GKey(string module, string key) { public override string ToString() => module + "*" + key; }
    public sealed class Expression(string key, object parent, object root) : Model(key, parent), IExpr { public object? Root => root; }
    public sealed class O11Expression(string key, object parent, object root) : Model(key, parent) { public object RootExpressionElement => root; }
    public abstract class Elem : IElem { public virtual IEnumerable Children => Array.Empty<object>(); public virtual IEnumerable UsedObjects => Array.Empty<object>(); }
    public sealed class Bin(string op, object left, object right) : Elem, IBin { public object Operator => op; public object LeftOperand => left; public object RightOperand => right; }
    public sealed class Bool(bool value) : Elem, IBool { public bool Value => value; }
    public sealed class Ident(object binding) : Elem, IIdent { public object Binding => binding; public override IEnumerable UsedObjects => new[] { ((ObjBinding)binding).Object }; }
    public sealed class Call(object binding, object[] args) : Elem, ICall {
        public object Function => binding; public IEnumerable Arguments => args; public override IEnumerable Children => args;
        public override IEnumerable UsedObjects => binding is ObjBinding b ? new[] { b.Object } : Array.Empty<object>();
    }
    public sealed class Arg(object value) : Elem, IArg { public object Value => value; }
    public sealed class O11Call(object? reference, object[] args) : Elem { public object? Reference => reference; public IEnumerable Arguments => args; public object? ReferedObject { get; set; } }
    public class O11Arg(object value) : Elem { public object ArgumentExpressionElement => value; }
    public sealed class ObjBinding(object target) : IObjBinding { public object Object => target; }
    public sealed class BuiltinBinding(object function) : IBuiltinBinding { public object Function => function; }
    public sealed class NameBinding(string name) : INameBinding { public string Name => name; }
    public sealed class BuiltinFn(string name) : IBuiltinFn { public string Name => name; }
    public sealed class Builtins : IBuiltins {
        readonly Dictionary<string, BuiltinFn> all = new[] { "GetUserId", "NullIdentifier", "NullTextIdentifier" }.ToDictionary(n => n, n => new BuiltinFn(n));
        public BuiltinFn Get(string name) => all[name];
        public object GetUserId => all["GetUserId"]; public object NullIdentifier => all["NullIdentifier"]; public object NullTextIdentifier => all["NullTextIdentifier"];
    }
    public sealed class Role : Model, IRoleSig {
        public Role(string key, object parent, object global, string name) : base(key, parent, global) {
            Name = name; Check = new Model("CCCCCCCCCCCCCCCCCCCCCC", this); ClientCheck = new Model("DDDDDDDDDDDDDDDDDDDDDD", this); Grant = new Model("GGGGGGGGGGGGGGGGGGGGGG", this);
        }
        public readonly Model Check, ClientCheck, Grant;
        public bool Public => true;
        string IRoleSig.Name => Name; bool IRoleSig.IsPersistent => true; object IRoleSig.CheckRoleAction => Check; object IRoleSig.CheckRoleClientSideAction => ClientCheck;
    }
    public sealed class Module(string key) : Model(key), IModule {
        public readonly List<object> Roles = []; public object? RegisteredRole { get; set; } public readonly Builtins Builtins = new();
        IEnumerable IModule.Roles => Roles; object? IModule.AnonymousRole => null; object IModule.BuiltinFunctions => Builtins;
    }
}
