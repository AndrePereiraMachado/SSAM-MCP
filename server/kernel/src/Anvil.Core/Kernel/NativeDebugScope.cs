using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Reflection;
using OutSystems.Model;
using ServiceStudio.Model;
using ServiceStudio.Model.Interfaces;
using ServiceStudio.Scope;
using ServiceStudio.Expressions;
using ServiceStudio.Hashes;

namespace Anvil.Core;

// Published model metadata only. The native Scope and IWatchable contracts own
// visibility; this reader never enumerates runtime bags or evaluates expressions.
public static class NativeDebugScope
{
    public static object Read(ModelHost host, string file, string expectedHash, string nodeKey, string functionKey, string? previousNodeKey = null)
    {
        if (!Regex.IsMatch(expectedHash, "^[a-fA-F0-9]{64}$") || !Regex.IsMatch(nodeKey, "^[A-Za-z0-9_+]{22}$") ||
            !Regex.IsMatch(functionKey, "^[A-Za-z0-9_+]{22}(?:\\.\\#(?:FlowExceptionHandler|Preparation))?$") ||
            previousNodeKey != null && !Regex.IsMatch(previousNodeKey, "^[A-Za-z0-9_+]{22}$"))
            throw new ArgumentException("debug_scope_identity_invalid");
        var bytes = File.ReadAllBytes(file);
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        if (!string.Equals(hash, expectedHash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("debug_scope_source_changed");
        var module = host.Load(bytes);
        try {
            var objects = new KernelModelReader().Walk((IObjectSignature)module).OfType<AbstractObject>().ToArray();
            var node = objects.SingleOrDefault(n => n.Key.ToString() == nodeKey)
                ?? throw new ArgumentException("debug_scope_node_not_found");
            var ancestor = node.GetParent();
            while (ancestor != null && ancestor.Key.ToString() != functionKey) ancestor = ancestor.GetParent();
            if (ancestor == null) throw new ArgumentException("debug_scope_function_mismatch");
            var previous = previousNodeKey == null ? null : objects.SingleOrDefault(n => n.Key.ToString() == previousNodeKey)
                ?? throw new ArgumentException("debug_scope_previous_node_not_found");
            // Ask the installed variable-container factory for its path. O11
            // names and ODC GUID paths must not be reconstructed by this reader.
            var containerType = Assembly.Load("ServiceStudio.View").GetType("ServiceStudio.View.Debugger.VariableContainer", true)!;
            var create = containerType.GetMethods(BindingFlags.Public | BindingFlags.Static)
                .Single(m => m.Name == "Create" && m.GetParameters().Length == 6);
            var sourceType = create.GetParameters()[5].ParameterType;
            var pathProperty = containerType.GetProperty("Path")!;
            var variables = new List<object>();
            var seen = new HashSet<(string Module, string Key, string Name)>();
            var client = node.IsInsideClientSide;
            void Add(AbstractObject owner, string name, string source, object? originalContainer = null) {
                var id = (owner.OwnerESpace.Key.ToString(), owner.Key.ToString(), name);
                var interfaces = owner.GetType().GetInterfaces().Select(t => t.Name).ToHashSet();
                var category = owner is Variables.ClientVariable ? "client"
                    : owner is Variables.SessionVariable ? "session"
                    : owner is Variables.SiteProperty ? "site"
                    : owner is ServiceStudio.Model.Timer ? "timer"
                    : interfaces.Contains("IInputParameter") ? "input"
                    : interfaces.Contains("IOutputParameter") ? "output" : "local";
                var nativeSource = category switch { "client" => "ClientVariable", "session" => "SessionVariable",
                    "site" => "SiteProperty", "timer" => "Timer", _ => "Local" };
                var container = originalContainer ?? create.Invoke(null, [null, owner.OwnerESpace, owner.Icon, owner, name, Enum.Parse(sourceType, nativeSource)])!;
                var nativePath = (string?)pathProperty.GetValue(container)
                    ?? throw new InvalidOperationException("debug_scope_native_path_unavailable");
                if (!seen.Add((id.Item1, id.Item2, nativePath))) return;
                variables.Add(new { moduleKey = id.Item1, variableKey = id.Item2, name,
                    category, source, nativePath, modelKind = owner.GetType().FullName });
            }
            foreach (var entry in node.Scope.Children) {
                if (entry.OwnerObject is IWatchable watch && watch.IsIndeedWatchable)
                    Add(entry.OwnerObject, watch.Name, "native-node-scope");
                else if (entry is IWatchableScopeEntry watchEntry)
                    Add(watchEntry.OwnerObject, watchEntry.Name, "native-scope-entry");
            }
            if (node is Nodes.AbstractDataSet && node is IWatchable data && data.IsIndeedWatchable)
                Add(node, data.Name, "native-current-dataset");
            void AddGlobals(IEnumerable<IWatchable> items) {
                foreach (var watch in items.Where(w => w.IsIndeedWatchable))
                    Add((AbstractObject)watch, watch.Name, "native-module-context");
            }
            if (client) AddGlobals(module.ClientVariables);
            else {
                AddGlobals(module.SessionVariables);
                AddGlobals(module.SiteProperties);
                AddGlobals(module.Timers);
            }
            // Reuse the Studio's public visitor. Its containers retain the
            // original expression path and root object; no expression parser
            // or runtime evaluator is introduced in this model-only process.
            var automaticExpressionsEnumerated = false;
            var previousExpressionsEnumerated = previousNodeKey == null;
            var previousExpressionsApplicable = previous != null && previous.GetParent() == node.GetParent();
            var previousExpressionsCount = 0;
            string? automaticExpressionsError = null;
            string? previousExpressionsError = null;
            int Collect(AbstractObject target, Type collectorType, string source) {
                var actionType = typeof(Action<>).MakeGenericType(containerType);
                var containers = new List<object>();
                var parameter = System.Linq.Expressions.Expression.Parameter(containerType, "container");
                var append = System.Linq.Expressions.Expression.Call(
                    System.Linq.Expressions.Expression.Constant(containers), typeof(List<object>).GetMethod("Add")!,
                    System.Linq.Expressions.Expression.Convert(parameter, typeof(object)));
                var callback = System.Linq.Expressions.Expression.Lambda(actionType, append, parameter).Compile();
                var collector = Activator.CreateInstance(collectorType, [null, callback])!;
                var accept = target.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance)
                    .Single(m => m.Name == "Accept" && m.GetParameters().Length == 1 &&
                        m.GetParameters()[0].ParameterType.IsInstanceOfType(collector));
                accept.Invoke(target, [collector]);
                var entries = containers.Select(container => new {
                    Container = container,
                    Owner = (AbstractObject?)(containerType.GetProperty("RootObject")!.GetValue(container)
                        ?? containerType.GetProperty("Object")!.GetValue(container)),
                    Name = (string?)containerType.GetProperty("FullName")!.GetValue(container)
                }).ToArray();
                if (entries.Any(entry => entry.Owner == null || string.IsNullOrEmpty(entry.Name)))
                    throw new InvalidOperationException("debug_scope_auto_container_unavailable");
                foreach (var entry in entries) Add(entry.Owner!, entry.Name!, source, entry.Container);
                return entries.Length;
            }
            try {
                var collectorType = Assembly.Load("ServiceStudio.Presenter")
                    .GetType("ServiceStudio.Presenter.Debugger.CollectAutoVariables", true)!;
                Collect(node, collectorType, "native-current-node-autowatch");
                automaticExpressionsEnumerated = true;
            } catch {
                // Some native visitors require a live presenter (for example
                // exception children). Keep the gap explicit, never invent it.
                automaticExpressionsError = "native_auto_scope_unavailable";
            }
            try {
                // DebuggerManager only visits the previous breakpoint when both
                // nodes have the same parent. The internal visitor is obfuscated;
                // identify its exact override/constructor contract, never its name.
                if (previousExpressionsApplicable) {
                    var actionType = typeof(Action<>).MakeGenericType(containerType);
                    var visitor = Assembly.Load("ServiceStudio.Presenter").GetTypes().Single(t =>
                        !t.IsPublic && t.IsSealed && typeof(Visitor).IsAssignableFrom(t) &&
                        t.GetConstructors().Any(c => c.GetParameters() is var p && p.Length == 2 &&
                            p[0].ParameterType.FullName == "ServiceStudio.Presenter.IAggregatorPresenter" && p[1].ParameterType == actionType) &&
                        t.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)
                            .Where(m => m.Name == "Visit" && m.GetParameters().Length == 1)
                            .Select(m => m.GetParameters()[0].ParameterType).ToHashSet()
                            .SetEquals([typeof(AbstractObject), typeof(Nodes.Assign), typeof(Assignment), typeof(AbstractExpression)]));
                    previousExpressionsCount = Collect(previous!, visitor, "native-previous-node-autowatch");
                }
                previousExpressionsEnumerated = true;
            } catch { previousExpressionsError = "native_previous_scope_unavailable"; }
            return new { schema = "ssam-native-debug-scope/1", sourceSha256 = hash,
                moduleKey = module.Key.ToString(), nodeKey, functionKey, previousNodeKey, runtime = client ? "client" : "server",
                functionDebuggerHash = ancestor.GetHash(HashType.Debugger).ToString(),
                // Lets the reader refuse a frame the platform cannot break in (screen Aggregates).
                functionKind = ancestor.GetType().FullName,
                functionBreakpointable = ancestor.GetType().GetInterfaces().Any(i => i.Name == "IBreakpointable"),
                nativeBuiltins = new { listAppend = OutSystems.Model.Implementation.FixedKeys.ListAppend.ToString() },
                expressionBindings = NativeExpressionBindings.Read(ancestor, objects, hash),
                authority = "installed-model-scope-and-watchability", variables,
                modelScopeEnumerated = true, automaticExpressionsEnumerated, automaticExpressionsError,
                previousExpressionsEnumerated, previousExpressionsError, previousExpressionsApplicable, previousExpressionsCount,
                runtimeValuesEvaluated = false, scopeComplete = false,
                pending = new[] { "runtime-frame-binding", "function-return" }
                    .Concat(previousExpressionsEnumerated ? Array.Empty<string>() : ["previous-node-expression-watches"])
                    .Concat(automaticExpressionsEnumerated ? Array.Empty<string>() : ["current-node-expression-watches"]).ToArray() };
        } finally { ModelHost.Release(module); }
    }
}
