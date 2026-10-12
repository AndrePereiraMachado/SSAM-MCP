using System.Collections;
using ServiceStudio.Model;
using ServiceStudio.Expressions;

namespace Anvil.Core;

// Model-only provenance. Reads the installed expression tree; never evaluates it.
// Older SDKs without this public tree contract report unavailable explicitly.
public static class NativeExpressionBindings
{
    private static Type? Contract(object value, string name) => value.GetType().GetInterfaces()
        .SingleOrDefault(t => t.FullName == name);
    private static object? Property(object value, string name) => value.GetType().GetProperty(name)?.GetValue(value)
        ?? value.GetType().GetInterfaces().Select(t => t.GetProperty(name)).FirstOrDefault(p => p != null)?.GetValue(value);

    public static object Read(AbstractObject function, IEnumerable<AbstractObject> objects, string sourceSha256)
    {
        var module = function.OwnerESpace;
        var expressions = objects.OfType<AbstractExpression>().Where(expression => {
            for (var parent = expression.GetParent(); parent != null; parent = parent.GetParent())
                if (parent == function) return true;
            return false;
        }).DistinctBy(expression => expression.Key.ToString()).ToArray();
        var identity = new { sourceSha256, moduleKey = module.Key.ToString(), functionKey = function.Key.ToString() };
        if (expressions.Any(e => Contract(e, "OutSystems.Model.Expressions.IExpression") == null))
            return new { available = false, identity, reason = "native_expression_tree_contract_unavailable" };
        try {
            if (expressions.Length > 1000) throw new InvalidOperationException();
            var builtins = Property(module, "BuiltinFunctions");
            int count = 0;
            object Node(object node, int depth) {
                if (depth > 40 || ++count > 10000 || Contract(node, "OutSystems.Model.Expressions.Nodes.IExpressionNode") == null)
                    throw new InvalidOperationException();
                var functionCall = Contract(node, "OutSystems.Model.Expressions.Nodes.IFunctionCall");
                var binding = functionCall?.GetProperty("Function")?.GetValue(node);
                var builtinContract = binding == null ? null : Contract(binding, "OutSystems.Model.Expressions.IBuiltinFunctionBinding");
                var builtin = builtinContract?.GetProperty("Function")?.GetValue(binding);
                var builtinName = builtin == null ? null : Property(builtin, "Name") as string;
                var canonical = builtins != null && builtinName is "GetUserId" or "NullTextIdentifier"
                    ? Property(builtins, builtinName) : null;
                var originalBuiltin = canonical != null && ReferenceEquals(canonical, builtin);
                var used = ((IEnumerable?)Property(node, "UsedObjects"))?.Cast<object>().Select(o => new {
                    key = Property(o, "Key")?.ToString(), kind = o.GetType().FullName
                }).ToArray() ?? throw new InvalidOperationException();
                var children = ((IEnumerable?)Property(node, "Children"))?.Cast<object>().Select(c => Node(c, depth + 1)).ToArray()
                    ?? throw new InvalidOperationException();
                return new { kind = node.GetType().Name, functionCall = functionCall != null,
                    builtin = builtinName, originalBuiltin, usedObjects = used, children };
            }
            var rows = expressions.Select(expression => {
                var api = Contract(expression, "OutSystems.Model.Expressions.IExpression")!;
                var root = api.GetProperty("Root")!.GetValue(expression) ?? throw new InvalidOperationException();
                return new { key = expression.Key.ToString(), root = Node(root, 0) };
            }).ToArray();
            return new { available = true, identity, authority = "installed-model-expression-tree",
                runtimeValuesEvaluated = false, expressions = rows };
        } catch {
            return new { available = false, identity, reason = "native_expression_tree_read_failed" };
        }
    }
}
