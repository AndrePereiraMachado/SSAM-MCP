using System.Collections;
using System.Reflection;
using System.Text.Json.Nodes;
using Anvil.Core.Preflight;
using OutSystems.Model;

namespace Anvil.Core;

public sealed partial class ModelSession
{
    private static object? OptionalProperty(object? target, string name)
    {
        try { return target == null ? null : ModelHost.Prop(target, name); } catch { return null; }
    }

    private static string? ExpressionValue(object? value) => value is IExpression expression ? expression.Text : value as string;

    private static (IObjectSignature Call, IObjectSignature Callee, IObjectSignature Input, string InputName)? RequiredArgument(IObjectSignature owner)
    {
        for (var call = owner; call != null; call = call.Parent as IObjectSignature) {
            if (OptionalProperty(call, "Action") is not IObjectSignature callee) continue;
            string? inputName = null;
            for (var part = owner; part != null && !ReferenceEquals(part, call); part = part.Parent as IObjectSignature)
                if (OptionalProperty(part, "Parameter") is IObjectSignature parameter) { inputName = TypeResolver.Name(parameter); break; }
            inputName ??= TypeResolver.Name(owner);
            var input = callee.Children.OfType<IObjectSignature>().FirstOrDefault(p => (Implements(p, "IInputParameter") || Implements(p, "IInputParameterSignature"))
                && TypeResolver.Name(p) == inputName);
            if (input != null && inputName != null) return (call, callee, input, inputName);
        }
        return null;
    }

    private static (int Line, string Argument, string Node, string Callee)? RequiredArgumentFocus(IObjectSignature? owner, JsonObject? source)
    {
        try {
            if (owner == null || source == null || source["op"]?.ToString() != "logic" || RequiredArgument(owner) is not { } required) return null;
            var relative = TextOf(owner, source);
            if (relative == null) return null;
            var inner = "/data" + relative;
            var text = Text(source, inner) ?? Text(source, inner + "/text");
            var node = new KernelModelReader().DisplayOf(required.Call);
            var callee = TypeResolver.Name(required.Callee) ?? "";
            if (text == null || VerifySourceEdits.FlowCallLocation(text, node, callee) is not { } located) return null;
            return (located.Line, required.InputName, node, callee);
        } catch { return null; }
    }

    /// <summary>Corrections determined by the constructed model, still returned as edits of the original source.</summary>
    private static (string Fix, JsonArray Patch, string PatchRule)? ModelSourcePatch(MessageInfo message, IObjectSignature? owner, JsonObject? source, string? opPointer)
    {
        try { return ModelSourcePatchCore(message, owner, source, opPointer); }
        catch { return null; } // A best-effort correction never hides the platform's original diagnostic.
    }

    private static (string Fix, JsonArray Patch, string PatchRule)? ModelSourcePatchCore(MessageInfo message, IObjectSignature? owner, JsonObject? source, string? opPointer)
    {
        if (owner == null || source == null || opPointer == null) return null;
        if (message.Id == "ArgumentRequiredExpression" && source["op"]?.ToString() == "logic")
        {
            if (RequiredArgument(owner) is { } required)
            {
                var (call, callee, input, inputName) = required;
                var value = ExpressionValue(OptionalProperty(input, "DefaultValue"));
                var declaredDefault = !string.IsNullOrWhiteSpace(value);
                if (string.IsNullOrWhiteSpace(value))
                    value = VerifySourceEdits.TypeDefault(UiCatalog.TypeName(OptionalProperty(input, "DataType")) ?? "");
                if (value == null) return null;
                var relative = TextOf(owner, source);
                if (relative == null) return null;
                var inner = "/data" + relative;
                var text = Text(source, inner);
                if (text == null) { inner += "/text"; text = Text(source, inner); }
                if (text == null) return null;
                var written = VerifySourceEdits.AddFlowArgument(text, new KernelModelReader().DisplayOf(call), TypeResolver.Name(callee) ?? "", inputName!, value);
                if (written == null) return null;
                return ($"pass {inputName}={value}, " + (declaredDefault ? "the input's declared default" : "a type default to review; this input declares no default"),
                    ReplaceSource(opPointer + inner, written), declaredDefault ? "REQUIRED_ARGUMENT_DEFAULT" : "REQUIRED_ARGUMENT_TYPE_DEFAULT");
            }
        }
        if (message.Id == "ExpressionUnknownObject" && source["op"]?.ToString() == "html" && Unknown(message) is { } unknown)
        {
            for (var list = owner; list != null; list = list.Parent as IObjectSignature)
            {
                if (!Implements(list, "IList") || ExpressionValue(OptionalProperty(list, "Source")) is not { Length: > 0 } listSource) continue;
                // A simple list variable provides an unambiguous record type. Aggregates and expressions need their own rules.
                if (!System.Text.RegularExpressions.Regex.IsMatch(listSource, @"^[A-Za-z_][A-Za-z0-9_]*$")) return null;
                IObjectSignature? variable = null;
                for (var scope = list.Parent as IObjectSignature; scope != null && variable == null; scope = scope.Parent as IObjectSignature)
                    variable = scope.Children.OfType<IObjectSignature>().FirstOrDefault(v => TypeResolver.Name(v) == listSource && OptionalProperty(v, "DataType") != null);
                if (OptionalProperty(variable, "DataType") is not OutSystems.Model.Types.IListType type) return null;
                var attributes = (OptionalProperty(type.ElementType, "Attributes") as IEnumerable)?.Cast<object>().ToList() ?? [];
                var field = attributes.Select(a => TypeResolver.Name(a)).OfType<string>().FirstOrDefault(n => n.Equals(unknown, StringComparison.OrdinalIgnoreCase));
                if (field == null)
                {
                    // An owner-qualified identifier (OrderId inside Orders) reads the current record's Id.
                    var ids = attributes.Select(a => TypeResolver.Name(a)).OfType<string>().Where(n => n.Equals("Id", StringComparison.OrdinalIgnoreCase)).ToList();
                    var stem = unknown.EndsWith("Id", StringComparison.OrdinalIgnoreCase) ? unknown[..^2] : "";
                    var typeName = UiCatalog.TypeName(type.ElementType) ?? "";
                    if (ids.Count == 1 && stem.Length > 0 && (listSource.Contains(stem, StringComparison.OrdinalIgnoreCase) || typeName.Contains(stem, StringComparison.OrdinalIgnoreCase))) field = ids[0];
                }
                if (field == null) return null;
                var inner = source["data"]?["html"] is JsonValue ? "/data/html" : source["html"] is JsonValue ? "/html" : null;
                if (inner == null || Text(source, inner) is not { } html) return null;
                var written = VerifySourceEdits.QualifyListValue(html, listSource, unknown, field);
                if (written == null) return null;
                return ($"use {listSource}.Current.{field}, the attribute of the current list item", ReplaceSource(opPointer + inner, written), "LIST_ITEM_QUALIFIED");
            }
        }
        return null;
    }

    private static JsonArray ReplaceSource(string path, string value) => new(new JsonObject { ["op"] = "replace", ["path"] = path, ["value"] = value });

    // ---- T16: what the base already tells about a create and a delete ------------------------------------------------------

    /// <summary>T16 rule 1: the element a raw create collides with in the base. The direct child of the create's parent (as the
    /// base has it) with the create's name and type (with or without the leading I); never a widget or a flow node (the Studio
    /// names those freely, as the apply keeps its choice: Verbs.Create). Null when the parent is not of the base or none is there.
    /// Its reference is the Type:Name that resolves to that very element, else its @key; <c>Rename</c> is the name the Studio would
    /// give the newcomer (the name's stem followed by the first free number, as the apply observes it).</summary>
    internal (IObjectSignature Existing, string Reference, string Parent, string Rename)? ExistingChild(string parent, string type, string name)
    {
        object owner;
        try { owner = Resolve(parent); } catch { return null; }
        if (owner is not IObjectSignature holder) return null;
        var iface = type.StartsWith('I') ? type : 'I' + type;
        var children = holder.Children.OfType<IObjectSignature>().Where(c => !c.WasDeleted).ToList();
        var existing = children.FirstOrDefault(c => string.Equals(TypeResolver.Name(c), name, StringComparison.OrdinalIgnoreCase)
            && c is not OutSystems.Model.UI.IWidget && c is not IFlowNode && (Implements(c, iface) || Implements(c, type)));
        if (existing == null) return null;
        // The parent as the job names it, then the child by its name (a Type:Name of a member of a screen may name another
        // screen's); a top-level element by Type:Name; the key when neither resolves to this very element.
        var reference = parent == "@espace" ? iface + ":" + TypeResolver.Name(existing) : parent + "/" + TypeResolver.Name(existing);
        try { if (!ReferenceEquals(Resolve(reference), existing)) reference = "@" + existing.ObjectKey; }
        catch { reference = "@" + existing.ObjectKey; }
        var taken = children.Select(c => TypeResolver.Name(c)).OfType<string>().ToHashSet(StringComparer.OrdinalIgnoreCase);
        var stem = System.Text.RegularExpressions.Regex.Replace(name, @"\d+$", "");
        var n = 2;
        while (taken.Contains(stem + n)) n++;
        return (existing, reference, Describe(holder), stem + n);
    }

    // The raw ops of a job: what a base element is to them is read from the op itself (target, parent, name).
    private static readonly HashSet<string> RawOps = new(StringComparer.Ordinal)
        { "create", "set", "link", "move", "delete", "rename", "replace", "duplicate", "get", "find", "dump", "usages", "layout", "reference" };

    /// <summary>T16 rule 1 (review of e10ecacc, R2): whether the job may change what <paramref name="existing"/> is when the create
    /// <paramref name="create"/> runs, so its collision is not certain from the base (the apply decides): an op of the job deletes,
    /// renames, moves, replaces or duplicates the element or one of its ancestors (below the module), or sets the Name of one; a raw
    /// create other than this one makes an element named like one of its ancestors (the parent deleted and made again, then named
    /// by its name); a non-raw op (spec, ddl, logic, html, ...) declares the name of the element or of one of its ancestors (it may
    /// rewrite or replace it). When unsure, never a base collision.</summary>
    internal bool UnsureAfterJob(JsonArray ops, int create, IObjectSignature existing)
    {
        var chain = new List<IObjectSignature>();
        for (var o = existing; o != null && o is not IESpace; o = o.Parent as IObjectSignature) chain.Add(o);
        var names = chain.Select(o => TypeResolver.Name(o)).OfType<string>().Where(n => n.Length > 0).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var ancestors = chain.Skip(1).Select(o => TypeResolver.Name(o)).OfType<string>().Where(n => n.Length > 0).ToHashSet(StringComparer.OrdinalIgnoreCase);
        bool InChain(string? reference)
        {
            if (string.IsNullOrEmpty(reference) || reference.StartsWith('$')) return false;
            try { return Resolve(reference) is { } o && chain.Any(c => ReferenceEquals(c, o)); }
            catch { return false; }   // a name the base has not: nothing of the base element
        }
        var nonRaw = new JsonArray();
        for (var j = 0; j < ops.Count; j++)
        {
            if (j == create || ops[j] is not JsonObject op) continue;
            var kind = op["op"]?.ToString() ?? "";
            if (!RawOps.Contains(kind)) { nonRaw.Add(op.DeepClone()); continue; }
            switch (kind)
            {
                case "delete" or "rename" or "move" or "duplicate" when InChain(op["target"]?.ToString()): return true;
                case "replace" when InChain(op["from"]?.ToString()) || InChain(op["to"]?.ToString()): return true;
                case "set" when string.Equals(op["prop"]?.ToString(), "Name", StringComparison.OrdinalIgnoreCase) && InChain(op["target"]?.ToString()): return true;
                case "create" when op["name"]?.ToString() is { Length: > 0 } made && ancestors.Contains(made): return true;
            }
        }
        if (nonRaw.Count == 0) return false;
        var (words, whole) = JobPreflight.JobWords(Preflight.DocumentNameRules.Declarations(nonRaw));
        return names.Any(n => words.Contains(n) || whole.Contains(n));
    }

    /// <summary>T16 rule 5: the certain patch of a DELETE_HAS_CONSUMERS of a flow node, <c>reconnect:true</c>, when it cannot be
    /// wrong: the target is a flow node with exactly one exit (Target), the op does not already reconnect, force or break, and
    /// every use of the node or of anything inside it (each referer, none folded into another) is a connector of its own flow that
    /// reaches it, which is what reconnect moves to its next node (review of e10ecacc, R3b: the condition of an If that loops back
    /// to the node reads its output; that consumer is no connector). False otherwise: the author chooses.</summary>
    internal bool ReconnectIsCertain(JsonObject delete)
    {
        if (delete["op"]?.ToString() != "delete" || delete["reconnect"] != null || delete["force"] != null || delete["breaks"] != null
            || delete["target"]?.ToString() is not { Length: > 0 } target) return false;
        object node;
        try { node = Resolve(target); } catch { return false; }
        if (node is not IFlowNode || node is not IObjectSignature signature || signature.Parent is not IObjectSignature flow) return false;
        object? Get(PropertyInfo property, object owner) { try { return property.GetValue(owner); } catch { return null; } }
        var exits = FlowTargets(node).Select(p => (p.Name, Value: Get(p, node))).Where(e => e.Value != null).ToArray();
        if (exits.Length != 1 || exits[0].Name != "Target") return false;
        // Every authored use of the node and of what is inside it, none folded into an outer one (DeleteConsumers keeps only the
        // outermost, which hid an expression inside a node whose connector also reaches the target).
        var uses = new List<ServiceStudio.Model.AbstractObject>();
        var visiting = new HashSet<object>(ReferenceEqualityComparer.Instance);
        foreach (var inner in new KernelModelReader().Walk(signature))
        {
            if (inner is not ServiceStudio.Model.AbstractObject ao || !ao.HasReferers) continue;
            foreach (var r in ao.Referers)
                if (r != null && !ReferenceEquals(r, signature) && !IsInside(r, signature))
                    uses.AddRange(AuthoredUses(signature, r, PathOf(r), visiting).Select(u => u.Referer));
        }
        if (uses.Count == 0) return false;
        // A connector of the flow whose own connector property, or that of the node holding it, reaches the deleted node.
        bool Reaches(IObjectSignature o) => FlowTargets(o).Any(p => ReferenceEquals(Get(p, o), node));
        foreach (var use in uses)
        {
            if (use is not IObjectSignature referer || !IsInside(referer, flow) || !Implements(referer, "IActionConnector") && !ShortType(referer).EndsWith("Connector", StringComparison.Ordinal))
                return false;
            if (!Reaches(referer) && !(referer.Parent is IObjectSignature holder && Reaches(holder))) return false;
        }
        return true;
    }

    private static void RememberSourceEdits(JsonObject source, string opPointer, JsonArray edits, Dictionary<string, string> finalText)
    {
        foreach (var edit in edits.OfType<JsonObject>())
        {
            if (edit["path"]?.ToString() is not { } path || !path.StartsWith(opPointer + "/", StringComparison.Ordinal) || edit["value"] is not JsonValue v || !v.TryGetValue<string>(out var text)) continue;
            var pieces = path[(opPointer.Length + 1)..].Split('/');
            JsonNode? node = source;
            for (var k = 0; k < pieces.Length - 1; k++)
                node = node is JsonArray array ? array[int.Parse(pieces[k])] : node?[pieces[k]];
            if (node is JsonArray list) list[int.Parse(pieces[^1])] = text;
            else if (node is JsonObject obj) obj[pieces[^1]] = text;
            else continue;
            finalText[path] = text;
        }
    }
}
