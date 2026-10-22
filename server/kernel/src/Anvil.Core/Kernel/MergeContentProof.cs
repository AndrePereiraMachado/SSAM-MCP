using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Globalization;
using System.Collections;
using Anvil.Reading;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>Independent comparison of authored model content after native merge.
/// Derived records are addressed through their owners; omissions remain explicit in the receipt.</summary>
public static class MergeContentProof
{
    private static readonly HashSet<string> OrderedCollections = new(StringComparer.Ordinal) {
        "Widgets", "Rows", "Cells", "Assignments", "InputParameters", "OutputParameters", "Attributes", "Sorts", "Conditions", "IndexAttributes"
    };
    private static readonly HashSet<string> SetCollections = new(StringComparer.Ordinal) { "Roles" };
    public static JsonObject Check(ModelHost host, string expectedPath, string actualPath)
    {
        ESpace? expected = null, actual = null;
        try
        {
            var expectedBytes = File.ReadAllBytes(expectedPath); var actualBytes = File.ReadAllBytes(actualPath);
            expected = host.Load(expectedBytes);
            actual = host.Load(actualBytes);
            var omittedExpected = new JsonArray(); var omittedActual = new JsonArray();
            var expectedLabels = new Dictionary<string, string>(StringComparer.Ordinal); var actualLabels = new Dictionary<string, string>(StringComparer.Ordinal);
            var expectedValues = Read(expected, omittedExpected, expectedLabels); var actualValues = Read(actual, omittedActual, actualLabels);
            var proof = Compare(expectedValues, actualValues, expectedLabels, actualLabels);
            proof["inputs"] = new JsonObject {
                ["expected"] = new JsonObject { ["path"] = Path.GetFullPath(expectedPath), ["sha256"] = Convert.ToHexString(SHA256.HashData(expectedBytes)).ToLowerInvariant() },
                ["actual"] = new JsonObject { ["path"] = Path.GetFullPath(actualPath), ["sha256"] = Convert.ToHexString(SHA256.HashData(actualBytes)).ToLowerInvariant() },
                ["nativeModelVersion"] = typeof(ESpace).Assembly.GetName().Version?.ToString()
            };
            proof["coverage"] = new JsonObject {
                ["complete"] = false,
                ["boundary"] = "Public Model API content, excluding producer implementation and platform metadata. Regenerated owned records use owner and property/parameter/alias/position; derived lists, records, source operations and implicit parameters use their content. Unsupported values and getter failures are listed below. This is not a compiler or runtime proof.",
                ["expectedOmissions"] = omittedExpected, ["actualOmissions"] = omittedActual,
                ["byKind"] = new JsonArray(expectedValues.Where(v => v.Key.Property == "$kind").GroupBy(v => v.Value)
                    .OrderBy(g => g.Key, StringComparer.Ordinal).Select(g => (JsonNode)new JsonObject { ["kind"] = g.Key, ["objects"] = g.Count() }).ToArray())
            };
            return proof;
        }
        finally { ModelHost.Release(expected); ModelHost.Release(actual); }
    }

    internal static Dictionary<(string Key, string Property), string> Read(ESpace model, JsonArray? omissions = null, Dictionary<string, string>? labels = null)
    {
        var values = new Dictionary<(string, string), string>();
        var identities = new Dictionary<IObjectSignature, string>(ReferenceEqualityComparer.Instance);
        var resolving = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
        var identityOwners = new Dictionary<string, IObjectSignature>(StringComparer.Ordinal);
        var moduleKey = ((IObjectSignature)model).ObjectKey?.ToString() ?? "";
        string Kind(IObjectSignature node) => node.GetInterface()?.Name ?? node.GetType().Name;
        // The readable element of an identity, for the refusal: kind:name segments below the module (an argument by its
        // parameter), e.g. ServerAction:ConsumerAction/ExecuteServerActionNode:Save/Argument:Code.
        string Label(IObjectSignature node)
        {
            var segments = new List<string>();
            for (var n = node; n != null && n is not IESpace; n = n.Parent as IObjectSignature) {
                var name = ModelHost.Prop(n, "Name")?.ToString();
                if (string.IsNullOrEmpty(name) && ModelHost.Prop(n, "Parameter") is IObjectSignature parameter) name = ModelHost.Prop(parameter, "Name")?.ToString();
                var kind = Kind(n); if (kind.Length > 1 && kind[0] == 'I' && char.IsUpper(kind[1])) kind = kind[1..];
                segments.Add(string.IsNullOrEmpty(name) ? kind : kind + ":" + name);
            }
            segments.Reverse();
            return string.Join("/", segments);
        }
        // An element of a producer reference (the consumer's copy of a producer element, e.g. a referenced server action and
        // its parameters) is the PRODUCER's element: its GlobalKey, <producer module key>*<producer object key>. The local key
        // of that copy is the platform's: the native merge adds its own copy with new keys, so a call bound
        // to the same producer element is the same content, and a call bound to another producer element still differs.
        string? ProducerIdentity(IObjectSignature node)
        {
            // The reference record itself (IReference) is the consumer's dependency on one producer module: a merge that
            // adds the first reference to that producer creates it with a key of its own. Its producer module key
            // (ReferenceKey) is its identity; its name, hash, kind and the rest are still compared below.
            if (Kind(node) == "IReference")
                return ModelHost.Prop(node, "ReferenceKey")?.ToString() is { Length: > 0 } producerModule ? "producer-module:" + producerModule : null;
            var inReference = false;
            for (var n = node; n != null && !inReference; n = n.Parent as IObjectSignature)
                inReference = n is ServiceStudio.Model.Interfaces.ITopLevelReferenceElement || Kind(n) == "IReference";
            if (!inReference) return null;
            var global = ModelHost.Prop(node, "GlobalKey")?.ToString();
            var star = global?.IndexOf('*') ?? -1;
            // A global key of this module is a local element: its own key stays its identity.
            if (global == null || star <= 0 || star == global.Length - 1 || string.Equals(global[..star], moduleKey, StringComparison.Ordinal)) return null;
            return "producer:" + global;
        }
        bool InAggregate(IObjectSignature node) {
            for (var parent = node.Parent as IObjectSignature; parent != null; parent = parent.Parent as IObjectSignature)
                if (parent is OutSystems.Model.Logic.Nodes.IAggregateNode || Kind(parent) == "IScreenAggregate") return true;
            return false;
        }
        string OwnedRole(IObjectSignature parent, IObjectSignature node)
        {
            var direct = new List<string>(); var collections = new List<string>();
            foreach (var property in ModelApiMetadata.Properties(parent.GetType()).Where(p => p.CanRead && p.GetIndexParameters().Length == 0)
                .DistinctBy(p => p.Name).OrderBy(p => p.Name, StringComparer.Ordinal)) {
                if (ModelReader<IObjectSignature>.IsNoise(property.Name)) continue;
                if (!typeof(IObjectSignature).IsAssignableFrom(property.PropertyType)
                    && (!typeof(IEnumerable).IsAssignableFrom(property.PropertyType) || property.PropertyType == typeof(string))) continue;
                object? value;
                try { value = property.GetValue(parent); } catch { continue; }
                if (ReferenceEquals(value, node)) direct.Add(property.Name);
                else if (value is IEnumerable list) {
                    var items = list.OfType<IObjectSignature>().ToList();
                    var position = items.FindIndex(item => ReferenceEquals(item, node));
                    if (position >= 0) collections.Add(property.Name + "[" + position.ToString(CultureInfo.InvariantCulture) + "]");
                }
            }
            if (direct.Count > 0) return direct[0];
            if (collections.Count > 0) return collections[0];
            var sameKind = parent.Children.OfType<IObjectSignature>().Where(c => Kind(c) == Kind(node)).ToList();
            if (sameKind.Count == 1) return "only:" + Kind(node);
            var name = ModelHost.Prop(node, "Name")?.ToString();
            if (!string.IsNullOrEmpty(name) && sameKind.Count(c => ModelHost.Prop(c, "Name")?.ToString() == name) == 1)
                return "name:" + name;
            // Nothing of the owner names this record: its position among the records of its kind addresses it, and the
            // receipt says so (a reorder reads as a difference there, never as an exception out of the proof).
            var ordinal = sameKind.FindIndex(c => ReferenceEquals(c, node));
            omissions?.Add(new JsonObject { ["object"] = Identity(parent) + "/" + Kind(node), ["property"] = "$identity", ["reason"] = "addressed by position " + ordinal.ToString(CultureInfo.InvariantCulture) });
            return "position:" + ordinal.ToString(CultureInfo.InvariantCulture);
        }
        string Identity(IObjectSignature node)
        {
            if (identities.TryGetValue(node, out var id)) return id;
            if (!resolving.Add(node)) throw new InvalidOperationException("Merge proof: cyclic derived identity in " + Kind(node));
            try { id = IdentityCore(node); identities.Add(node, id); if (labels != null) labels.TryAdd(id, Label(node)); return id; }
            finally { resolving.Remove(node); }
        }
        string IdentityCore(IObjectSignature node)
        {
            string id;
            var kind = Kind(node);
            if (ProducerIdentity(node) is { } producerElement) return producerElement;
            // Role exceptions are read-only derived records (native IsMergeUnit=false).
            // Merge recreates their keys; preserve the actual role binding, not that key.
            if (node is RoleException roleException && roleException.Role is IObjectSignature exceptionRole)
                return Identity((IObjectSignature)node.Parent!) + "/role-exception:" + Identity(exceptionRole);
            if (node is EntityIndex { AutoGenerated: true } generatedIndex)
                return Identity((IObjectSignature)node.Parent!) + "/generated-index:" + Hash(string.Join("\n", generatedIndex.IndexAttributes.Select(a => Identity(a.Attribute))));
            if (kind == "CustomProperty" && node.Parent is IObjectSignature propertyOwner)
                return Identity(propertyOwner) + "/property:" + ModelHost.Prop(node, "Name");
            if (kind is "IInputParameter" or "IOutputParameter" && node.Parent is IObjectSignature signature && Kind(signature) == "IActionSignature")
                return Identity(signature) + "/" + kind + ":" + ModelHost.Prop(node, "Name");
            // Add-source records are derived for each alias. Two aliases of the same entity may
            // use two equivalent records; the alias itself, including its name, remains measured.
            if (kind == "IAddSourceOperation" && ModelHost.Prop(node, "Source") is IObjectSignature dataSource)
                return "source:" + Identity((IObjectSignature)node.Parent!) + ":" + Identity(dataSource);
            if (kind == "DataSetImplicitParameter" && node.Parent is IObjectSignature parameterOwner) {
                var value = ModelHost.Prop(node, "Value") as IExpression;
                var references = (ModelHost.Prop(value!, "ReferedObjects") as IEnumerable)?.OfType<IObjectSignature>()
                    .Select(Identity).OrderBy(k => k, StringComparer.Ordinal) ?? Enumerable.Empty<string>();
                return Identity(parameterOwner) + "/implicit:" + Hash((value?.Text ?? "") + "\n" + string.Join("\n", references));
            }
            if (kind == "DataTable" && node.Parent is IObjectSignature tableOwner) return Identity(tableOwner);
            if (node is OutSystems.Model.Types.IListType list)
                return "list:" + Identity(list.ElementType);
            if (kind == "IAnonymousStructure") {
                // Aggregate record fields are named. Native merge may reorder its sources and hence
                // this derived record; declared structure/SQL output ordering is not normalized here.
                var attributes = ((IEnumerable)ModelHost.Prop(node, "Attributes")!).OfType<IObjectSignature>()
                    .OrderBy(a => ModelHost.Prop(a, "Name")?.ToString(), StringComparer.Ordinal);
                return "record:" + Hash(string.Join("\n", attributes.Select(a => ModelHost.Prop(a, "Name") + ":" + Identity((IObjectSignature)ModelHost.Prop(a, "DataType")!))));
            }
            if (node.Parent is IObjectSignature anonymous && Kind(anonymous) == "IAnonymousStructure")
                return Identity(anonymous) + "/attribute:" + ModelHost.Prop(node, "Name");
            // Native merge recreates these owned records, while retaining their owners and semantics.
            // Preserve their position and content; a new random key is not a lost binding.
            // Reactive/Mobile IContent is the owned slot wrapper, recreated by MatchTree.
            // Its owner/slot, children order, styles and bindings are still compared below.
            // Metadata belongs to a named slot of its owner. In particular the SOAP importer regenerates
            // WsdlServiceMetadata keys during merge; name, owner, kind and every payload byte remain content.
            var namedMetadata = node is IMetadata && !string.IsNullOrEmpty(ModelHost.Prop(node, "Name")?.ToString());
            if ((node is IExpression || namedMetadata || kind is "IArgument" or "IAssignment" or "IPlaceholderContentWidget" or "IContent" or "ISQLOutput" or "IEventHandler" or "IWebWidget" or "IMobileWidget" or "IRecordAttributeValue" or "IExtendedProperty" || InAggregate(node))
                && node.Parent is IObjectSignature parent)
            {
                string? role = null;
                if (node is IExpression) {
                    var raw = node.ObjectKey.ToString();
                    var separator = raw.IndexOf(".#", StringComparison.Ordinal);
                    if (separator >= 0) role = raw[(separator + 2)..];
                }
                else if (kind == "IArgument" && ModelHost.Prop(node, "Parameter") is IObjectSignature parameter)
                    role = Identity(parameter);
                else if (kind == "IPlaceholderContentWidget" && ModelHost.Prop(node, "Placeholder") is IObjectSignature placeholder)
                    role = placeholder.ObjectKey.ToString();
                else if (kind == "IEventHandler" && ModelHost.Prop(node, "Event") is IObjectSignature ev)
                    role = ev.ObjectKey.ToString();
                else if (kind == "IRecordAttributeValue" && ModelHost.Prop(node, "Attribute") is IObjectSignature attribute)
                    role = "attribute:" + Identity(attribute);
                else if (namedMetadata) role = "metadata:" + ModelHost.Prop(node, "Name");
                else if (kind == "IExtendedProperty") role = "property:" + ModelHost.Prop(node, "Property");
                else if (kind == "IAliasedSource") role = "alias:" + ModelHost.Prop(node, "Name");
                if (string.IsNullOrEmpty(role)) {
                    role = OwnedRole(parent, node);
                }
                id = Identity(parent) + "/" + kind + "[" + role + "]";
            }
            else id = node.ObjectKey.ToString();
            if (identityOwners.TryGetValue(id, out var owner) && !ReferenceEquals(owner, node)) {
                // Two records with one canonical identity: the later one is numbered, and the receipt says so.
                var n = 2;
                while (identityOwners.ContainsKey(id + "#" + n.ToString(CultureInfo.InvariantCulture))) n++;
                omissions?.Add(new JsonObject { ["object"] = id, ["property"] = "$identity", ["reason"] = "ambiguous canonical identity, numbered #" + n.ToString(CultureInfo.InvariantCulture) });
                id += "#" + n.ToString(CultureInfo.InvariantCulture);
            }
            identityOwners[id] = node;
            return id;
        }
        var pending = new Stack<IObjectSignature>(); pending.Push((IObjectSignature)model);
        var visited = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
        while (pending.TryPop(out var node))
        {
            if (!visited.Add(node)) continue;
            if (node is ServiceStudio.Model.Interfaces.ITopLevelReferenceElement) continue;
            if (Kind(node) == "DataTable") {
                foreach (var child in node.Children.OfType<IObjectSignature>()) pending.Push(child);
                continue;
            }
            if (node is OutSystems.Model.Types.IListType || Kind(node) == "IAnonymousStructure") continue;
            if (Kind(node) == "IAddSourceOperation") continue;
            if (node is EntityIndexAttribute) continue; // represented, in order, by the index below
            // These are generated edge records, whose order and keys change on load. Their semantics are the
            // owner's Target/TrueTarget/FalseTarget/CycleTarget/OtherwiseTarget properties, compared below.
            if (node is OutSystems.Model.Logic.IActionConnector) continue;
            var key = Identity(node);
            values[(key, "$kind")] = node.GetInterface()?.FullName ?? node.GetType().FullName!;
            values[(key, "$parentKind")] = node.Parent is IObjectSignature owner ? Kind(owner) : "";
            values[(key, "$parent")] = node.Parent is IObjectSignature parent ? Identity(parent) : "";
            if (node is RoleException roleException)
                values[(key, "Role")] = roleException.Role is IObjectSignature exceptionRole ? Identity(exceptionRole) : "";
            if (node is EntityIndex index) {
                values[(key, "index:AutoGenerated")] = index.AutoGenerated.ToString();
                values[(key, "index:Name")] = index.Name;
                values[(key, "index:Unique")] = index.Unique.ToString();
                values[(key, "index:Attributes")] = string.Join("\n", index.IndexAttributes.Select(a => a.Attribute == null ? "" : Identity(a.Attribute)));
            }
            foreach (var property in ModelApiMetadata.Properties(node.GetType())
                .Where(p => p.GetIndexParameters().Length == 0 && p.CanRead && (p.CanWrite || OrderedCollections.Contains(p.Name) || SetCollections.Contains(p.Name)))
                .GroupBy(p => p.Name).Select(g => g.First()))
            {
                if (ModelReader<IObjectSignature>.IsNoise(property.Name)) continue;
                // Index attributes are recreated edge records; the ordered referenced attributes
                // are already compared by index:Attributes, including auto-generated indexes.
                if (node is EntityIndex && property.Name == "IndexAttributes") continue;
                object? value;
                try { value = property.Name == "SourceEntity" && Kind(node) == "IComboBoxWidget"
                    ? ModelSession.UIProperty(node, property.Name) : property.GetValue(node); }
                catch (Exception error) {
                    var reason = error.GetBaseException().GetType().Name;
                    omissions?.Add(new JsonObject { ["object"] = key, ["property"] = property.Name, ["reason"] = reason });
                    values[(key, "$unread:" + property.Name)] = reason; continue;
                }
                if (property.Name == "Conditions" && node is OutSystems.Model.Logic.Nodes.ISwitchNode && value is IEnumerable conditions) {
                    // Switch connectors are recreated by native merge. Their keys are not identity,
                    // but priority, expression bindings and destination are executable content.
                    var branches = new JsonArray();
                    foreach (var branch in conditions.OfType<IObjectSignature>()) {
                        var branchExpression = ModelHost.Prop(branch, "Value") as IExpression
                            ?? throw new InvalidOperationException("Switch condition has no readable Value expression");
                        var target = ModelHost.Prop(branch, "Target") as IObjectSignature;
                        var refs = (ModelHost.Prop(branchExpression, "ReferedObjects") as IEnumerable)?.OfType<IObjectSignature>()
                            .Select(Identity).Distinct().OrderBy(k => k, StringComparer.Ordinal) ?? Enumerable.Empty<string>();
                        branches.Add(new JsonObject { ["value"] = branchExpression.Text, ["target"] = target == null ? null : Identity(target),
                            ["references"] = new JsonArray(refs.Select(r => (JsonNode?)JsonValue.Create(r)).ToArray()) });
                    }
                    values[(key, "ordered:Conditions")] = branches.ToJsonString();
                }
                else if (OrderedCollections.Contains(property.Name) && value is IEnumerable collection)
                    values[(key, "ordered:" + property.Name)] = string.Join("\n", collection.OfType<IObjectSignature>().Select(Identity));
                else if (SetCollections.Contains(property.Name) && value is IEnumerable set)
                    values[(key, "set:" + property.Name)] = string.Join("\n", set.OfType<IObjectSignature>().Select(Identity).OrderBy(v => v, StringComparer.Ordinal));
                else if (ContentValue(value, Identity) is { } content) values[(key, "api:" + property.Name)] = content;
                else omissions?.Add(new JsonObject { ["object"] = key, ["property"] = property.Name, ["reason"] = "unsupported value type", ["type"] = value?.GetType().FullName });
            }
            // Expression.Text alone misses a rebind to a homonymous object.
            if (node is IExpression expression)
            {
                values[(key, "$expression")] = expression.Text ?? "";
                if (ModelHost.Prop(node, "ReferedObjects") is IEnumerable references)
                    values[(key, "$references")] = string.Join("\n", references.OfType<IObjectSignature>()
                        .Select(Identity).Distinct().OrderBy(k => k, StringComparer.Ordinal));
            }
            // DefaultScreen is persisted by the Model API but a native Traditional merge can drop it.
            // Include null too: losing a requested clear is just as much a content mismatch as losing a set.
            if (node is IESpace espace)
                values[(key, "DefaultScreen")] = (espace.DefaultScreen as IObjectSignature)?.ObjectKey?.ToString() ?? "";
            if (node is OutSystems.Model.Logic.Nodes.IRefreshDataNode refresh)
                values[(key, "DataSource")] = (refresh.DataSource as IObjectSignature)?.ObjectKey?.ToString() ?? "";
            if (node is OutSystems.Model.Logic.Nodes.IAjaxRefreshNode ajax)
                values[(key, "WidgetOrWebBlock")] = (ajax.WidgetOrWebBlock as IObjectSignature)?.ObjectKey?.ToString() ?? "";
            if (node is OutSystems.Model.UI.Web.Events.ILinkOnClick click) {
                values[(key, "Method")] = click.Method.ToString();
                values[(key, "Validation")] = click.Validation.ToString();
                values[(key, "Destination")] = click.Destination?.ObjectKey?.ToString() ?? "";
            }
            if (ThemeCss.Of(node) is { } sheet)
            {
                values[(key, "StyleSheet")] = sheet.EffectiveValue ?? "";
                values[(key, "UserStyleSheet")] = sheet.UserEffectiveValue ?? "";
                values[(key, "GeneratedStyleSheet")] = sheet.GeneratedEffectiveValue ?? "";
            }
            foreach (var child in node.Children.OfType<IObjectSignature>().Concat(EntityIndexes.NativeChildren(node))) pending.Push(child);
        }
        return values;
    }

    private static string? ContentValue(object? value, Func<IObjectSignature, string> identity) => value switch
    {
        null => "null",
        IExpression expression => "expression:" + expression.Text,
        IObjectSignature reference => "reference:" + identity(reference),
        string text => "text:" + text,
        bool boolean => boolean ? "true" : "false",
        Enum enumeration => "enum:" + enumeration.GetType().FullName + ":" + enumeration,
        byte[] bytes => "bytes:" + Convert.ToHexString(SHA256.HashData(bytes)),
        IFormattable scalar when value.GetType().IsPrimitive || value is decimal or DateTime or Guid
            => "scalar:" + scalar.ToString(null, CultureInfo.InvariantCulture),
        _ => null
    };

    internal static JsonObject Compare(Dictionary<(string Key, string Property), string> expected, Dictionary<(string Key, string Property), string> actual,
        IReadOnlyDictionary<string, string>? expectedLabels = null, IReadOnlyDictionary<string, string>? actualLabels = null)
    {
        var differences = new JsonArray();
        // Each difference names its element (the readable path of the candidate's element, else the module's) and, for a
        // reference or an expression, the readable value on each side: a refusal lists what differs, never only hashes.
        string Element(string key) => expectedLabels?.GetValueOrDefault(key) ?? actualLabels?.GetValueOrDefault(key) ?? key;
        string? Readable(string property, string? value, IReadOnlyDictionary<string, string>? labels)
        {
            if (value == null) return null;
            string Name(string id) => labels?.GetValueOrDefault(id) ?? Element(id);
            if (value.StartsWith("reference:", StringComparison.Ordinal)) return "reference:" + Name(value["reference:".Length..]);
            if (property is "$references" or "$parent" || property.StartsWith("ordered:", StringComparison.Ordinal) || property.StartsWith("set:", StringComparison.Ordinal))
                return Clip(string.Join("\n", value.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(Name)));
            if (property is "$expression" || value.StartsWith("expression:", StringComparison.Ordinal) || value.StartsWith("text:", StringComparison.Ordinal)
                || value.StartsWith("scalar:", StringComparison.Ordinal) || value.StartsWith("enum:", StringComparison.Ordinal) || value is "true" or "false" or "null")
                return Clip(value);
            return null;
        }
        foreach (var field in expected.Keys.Union(actual.Keys).OrderBy(x => x.Key, StringComparer.Ordinal).ThenBy(x => x.Property, StringComparer.Ordinal))
        {
            var expectedPresent = expected.TryGetValue(field, out var value);
            var present = actual.TryGetValue(field, out var got);
            if (expectedPresent && present && Normalize(value!) == Normalize(got!)) continue;
            differences.Add(new JsonObject { ["objectKey"] = field.Key.Split('/')[0], ["address"] = field.Key, ["property"] = field.Property,
                ["element"] = Element(field.Key),
                ["kind"] = expected.GetValueOrDefault((field.Key, "$kind")) ?? actual.GetValueOrDefault((field.Key, "$kind")),
                ["parentKind"] = expected.GetValueOrDefault((field.Key, "$parentKind")) ?? actual.GetValueOrDefault((field.Key, "$parentKind")),
                ["missing"] = !present, ["unexpected"] = !expectedPresent,
                ["expectedSha256"] = expectedPresent ? Hash(value!) : null, ["actualSha256"] = present ? Hash(got!) : null,
                ["expected"] = IsBinding(field.Property) ? value : null,
                ["actual"] = IsBinding(field.Property) && present ? got : null,
                ["expectedValue"] = expectedPresent ? Readable(field.Property, value, expectedLabels) : null,
                ["actualValue"] = present ? Readable(field.Property, got, actualLabels) : null });
        }
        return new JsonObject { ["schema"] = "ssam-merge-content-proof/1", ["accepted"] = differences.Count == 0,
            ["scope"] = "Object identity/parent, public writable scalar/reference/expression properties, expression text/references, ESpace.DefaultScreen, refresh targets, Traditional links and all stylesheet values outside producer references; unsupported property value types are not covered",
            ["checked"] = expected.Count, ["differences"] = differences };
    }
    private static bool IsBinding(string property) => property is "DataSource" or "DefaultScreen" or "WidgetOrWebBlock" or "Method" or "Validation" or "Destination"
        or "$references" or "$parent" or "ordered:Widgets";
    private static string Normalize(string text) => text.Replace("\r\n", "\n");
    private static string Clip(string text) => text.Length <= 300 ? text : text[..300] + "...";
    private static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Normalize(text)))).ToLowerInvariant();
}
