using System.Text.Json.Nodes;
using OutSystems.Model;

namespace Anvil.Core;

public sealed partial class ModelSession
{
    public JsonArray PlanModuleSpecification(JsonObject specification, Anvil.Core.Delivery.FrozenFrameworkDependencies? runtime = null)
        => PlanModuleSpecificationCore(specification, runtime, null);
    internal JsonArray PlanFrozenCSharp(JsonObject specification, Anvil.Core.Delivery.FrozenCSharpCompilation compilation, Anvil.Core.Delivery.FrozenFrameworkDependencies? runtime)
        => PlanModuleSpecificationCore(specification, runtime, compilation);
    private JsonArray PlanModuleSpecificationCore(JsonObject specification, Anvil.Core.Delivery.FrozenFrameworkDependencies? runtime, Anvil.Core.Delivery.FrozenCSharpCompilation? compilation)
    {
        var imports=new JsonObject();
        var authored = PrepareCSharpCompilation(specification,runtime,compilation);
        var contract=authored?.Specification ?? ModuleSpecification.Normalize(specification,import=>BindNativeBlock(import,imports));
        ModuleSpecification.Validate(contract);
        var ops = contract["data"] is JsonObject { Count: > 0 } data ? PlanDataSpecification(data) : new JsonArray();
        foreach (var declaration in ModuleSpecification.Declarations(contract))
        {
            var type = declaration["type"]!.ToString(); var name = declaration["name"]!.ToString();
            var matches = ((IObjectSignature)_es).Children.Where(o => Implements(o, type) && TypeResolver.Name(o) == name).ToArray();
            if (matches.Length > 1) throw new InvalidOperationException($"Ambiguous existing {type}:{name}");
            if (matches.Length == 0) ops.Add(new JsonObject { ["op"] = "create", ["parent"] = "@espace", ["type"] = type, ["name"] = name });
            foreach (var (key, property) in new[] { ("public", "Public"), ("description", "Description") })
            {
                if (key == "public" && type != "IRole") continue;
                var value = declaration[key]?.DeepClone() ?? (key == "public" ? JsonValue.Create(false) : null);
                if (value != null)
                {
                    var expected = value is JsonValue scalar && scalar.TryGetValue<bool>(out var flag) ? Normal(flag) : Normal(value.ToString());
                    if (matches.Length == 1 && JsonNode.DeepEquals(Normal(UiCatalog.Prop(matches[0], property)), expected)) continue;
                    ops.Add(new JsonObject { ["op"] = "set", ["target"] = type + ":" + name, ["prop"] = property, ["value"] = value });
                }
            }
        }
        var screens = contract["screens"] as JsonArray ?? new JsonArray();
        ValidatePublicBlockEvolution(screens);
        var screenChanges = screens.Count > 0 && !CheckScreenSpecification(screens)["accepted"]!.GetValue<bool>();
        if (screenChanges) ops.Add(new JsonObject { ["op"] = "screen", ["data"] = new JsonObject { ["owners"] = screens.DeepClone(), ["phase"] = "structure" } });
        var logic = ModuleSpecification.Logic(contract); var changes = new JsonArray();
        // Inspect the action set once; rebuilding the symbol table per action becomes quadratic on large modules.
        var currentProof = CheckLogicSpecification(logic);
        var different = currentProof["differences"]!.AsArray().OfType<JsonObject>()
            .Select(difference => difference["element"]?.ToString().Split('/').ElementAtOrDefault(1) ?? "")
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var action in logic["actions"]!.AsArray().OfType<JsonObject>())
        {
            var existing = OwnedAction(action["name"]!.ToString(), action);
            if (existing != null)
            {
                if (!Implements(existing, LogicOrder.ActionType(action))) throw new ArgumentException("Cannot change action kind in an existing contract target: " + action["name"]);
                if (!different.Contains(action["name"]!.ToString())) continue;
            }
            var changed = action.DeepClone().AsObject(); if (existing != null) changed["replace"] = true; changes.Add(changed);
        }
        if (changes.Count > 0) ops.Add(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["actions"] = changes } });
        if (screenChanges) ops.Add(new JsonObject { ["op"] = "screen", ["data"] = new JsonObject { ["owners"] = screens.DeepClone(), ["phase"] = "bindings" } });
        foreach(var obsolete in ObsoleteUiCode(screens,logic)) ops.Add(obsolete!.DeepClone());
        if (authored != null) foreach (var obsolete in ObsoleteCSharpStructures(contract, changes, authored.RetiredStructures ?? [])) ops.Add(obsolete!.DeepClone());
        if(runtime!=null && !CheckFrameworkDependencies(runtime)["accepted"]!.GetValue<bool>())
            return RememberPlanned(new JsonArray(runtime.ReferenceOperations().Concat(ops).Select(op=>op!.DeepClone()).ToArray()));
        return RememberPlanned(ops);
    }

    public JsonObject CheckModuleSpecification(JsonObject specification, JsonObject? expectedTypes = null, Anvil.Core.Delivery.FrozenFrameworkDependencies? runtime = null)
        => CheckModuleSpecificationCore(specification, expectedTypes, runtime, null);
    internal JsonObject CheckFrozenCSharp(JsonObject specification, JsonObject? expectedTypes, Anvil.Core.Delivery.FrozenCSharpCompilation compilation, Anvil.Core.Delivery.FrozenFrameworkDependencies? runtime)
        => CheckModuleSpecificationCore(specification, expectedTypes, runtime, compilation);
    private JsonObject CheckModuleSpecificationCore(JsonObject specification, JsonObject? expectedTypes, Anvil.Core.Delivery.FrozenFrameworkDependencies? runtime, Anvil.Core.Delivery.FrozenCSharpCompilation? compilation)
    {
        var imports=new JsonObject();var authored=PrepareCSharpCompilation(specification,runtime,compilation);
        var contract=authored?.Specification??ModuleSpecification.Normalize(specification,import=>BindNativeBlock(import,imports));
        ModuleSpecification.Validate(contract);
        var result = contract["data"] is JsonObject { Count: > 0 } data ? CheckDataSpecification(data, expectedTypes)
            : new JsonObject { ["accepted"] = true, ["count"] = 0, ["assertions"] = new JsonArray(), ["differences"] = new JsonArray(),
                ["dataSummary"] = new JsonArray(), ["expectedTypes"] = expectedTypes?.DeepClone() ?? new JsonObject() };
        var declarations = new JsonArray();
        foreach (var declaration in ModuleSpecification.Declarations(contract))
        {
            var path = declaration["type"] + ":" + declaration["name"];
            var count = ((IObjectSignature)_es).Children.Count(o => ReferenceEquals(o.Parent, _espace)
                && Implements(o, declaration["type"]!.ToString()) && TypeResolver.Name(o) == declaration["name"]!.ToString());
            var ownership = new JsonObject { ["element"] = path, ["property"] = "ownedCount", ["expected"] = 1 };
            result["assertions"]!.AsArray().Add(ownership);
            if (count != 1) { var difference = ownership.DeepClone().AsObject(); difference["actual"] = count; result["differences"]!.AsArray().Add(difference); }
            declarations.Add(new JsonObject { ["reference"] = path, ["element"] = path, ["property"] = "$exists", ["expected"] = true });
            declarations.Add(new JsonObject { ["reference"] = path, ["element"] = path, ["property"] = "Name", ["expected"] = declaration["name"]!.DeepClone() });
            if (declaration["type"]!.ToString() == "IRole") declarations.Add(new JsonObject { ["reference"] = path, ["element"] = path, ["property"] = "Public", ["expected"] = Normal(declaration["public"]?.GetValue<bool>() ?? false) });
            if (declaration["description"] != null) declarations.Add(new JsonObject { ["reference"] = path, ["element"] = path, ["property"] = "Description", ["expected"] = declaration["description"]!.DeepClone() });
        }
        Merge(CheckDataContract(declarations));
        var logic = ModuleSpecification.Logic(contract);
        var actions = CheckLogicSpecification(logic, result["expectedTypes"]!.AsObject()); Merge(actions);
        result["expectedTypes"] = actions["expectedTypes"]!.DeepClone(); result["actionSummary"] = actions["actionSummary"]!.DeepClone();
        var screens = CheckScreenSpecification(contract["screens"] as JsonArray ?? new JsonArray(), result["expectedTypes"]!.AsObject()); Merge(screens);
        result["expectedTypes"] = screens["expectedTypes"]!.DeepClone(); result["screenSummary"] = screens["screenSummary"]!.DeepClone();
        foreach(var import in imports)
        {
            var key="uiImport/"+import.Key;var expected=result["expectedTypes"]![key];
            if(expected==null)result["expectedTypes"]![key]=import.Value!.DeepClone();
            var assertion=new JsonObject{["element"]=import.Key,["property"]="nativeImport",["expected"]=(expected??import.Value)!.DeepClone()};
            result["assertions"]!.AsArray().Add(assertion);
            if(expected!=null&&!JsonNode.DeepEquals(expected,import.Value)){var diff=assertion.DeepClone().AsObject();diff["actual"]=import.Value!.DeepClone();result["differences"]!.AsArray().Add(diff);}
        }
        result["nativeImports"]=imports;
        if(runtime!=null)
        {
            var dependencies=CheckFrameworkDependencies(runtime);Merge(dependencies);
            result["runtimeDependencies"]=dependencies;
        }
        result["count"] = result["assertions"]!.AsArray().Count; result["accepted"] = result["differences"]!.AsArray().Count == 0;
        result["scope"] = "Declared module data, roles, exceptions, action signatures/expressions/control flow and UI trees/bindings. Business intent and remote runtime behavior require separate acceptance.";
        return result;
        void Merge(JsonObject proof)
        {
            foreach (var key in new[] { "assertions", "differences" }) foreach (var entry in proof[key]!.AsArray()) result[key]!.AsArray().Add(entry!.DeepClone());
        }
    }
}
