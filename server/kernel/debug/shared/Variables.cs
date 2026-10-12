using System.Xml;
using System.Xml.Linq;

internal static class Variables {
    // Wire shape verified against the installed native IDebuggerAdapter with a local fake server.
    internal static string Request(int frame, int depth, string[] paths, int max = 30) {
        Configuration.ValidatePaths(paths, max);
        if (frame is < 0 or > 100 || depth is < 0 or > 4 || paths.Length == 0) throw new DebugFailure("debug_invalid_variables_request");
        return new XElement("vars", paths.Select(path => new XElement("local", new XAttribute("level", frame), new XAttribute("detail", depth), new XAttribute("name", path)))).ToString(SaveOptions.DisableFormatting);
    }
    internal static object[] Read(string xml, bool full = false, int max = 30, DebugPolicy.PrivateValues? privateValues = null) {
        using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 4194304 });
        var root = XElement.Load(reader);
        var values = new Dictionary<string, XElement>(StringComparer.Ordinal);
        foreach (var row in root.Elements()) if (row.Attribute("name") is { } name) values[name.Value] = row;
        return root.Elements().Take(max).Select(e => Project(e, e.Attribute("name")?.Value ?? e.Name.LocalName, 0, full, privateValues, values, true)).ToArray();
    }
    // ServerVariableContainerUtils in both installed SDKs: the response row is
    // an envelope; the first Entity/Structure/Record/List defines its type.
    // Its non-debug.* XML attributes are scalar FIELDS, not transport metadata.
    static bool NativeContainer(XElement e) => e.Name.LocalName is "Structure" or "Entity" or "Record" or "Record.List" or "Execute.Action" or "Widget" or "DeferredEvaluation";
    static bool Flag(XElement e, string name) => e.Attribute(name)?.Value is "true" or "True" or "1";
    static string ChildPath(string parent, string name) => name.StartsWith('[') ? parent + name : parent + "." + name;
    static string? OwnText(XElement e, bool legacy = false) {
        if (legacy && e.Attribute("value") is { } value) return value.Value;
        // Never concatenate descendant text: that would expose a secret-named
        // child's value again under its innocuous parent path.
        var text = string.Concat(e.Nodes().OfType<XText>().Select(node => node.Value));
        return string.IsNullOrWhiteSpace(text) && e.HasElements ? e.Attribute("debug.value")?.Value
            : text.Length > 0 ? text : e.Attribute("debug.value")?.Value;
    }
    static object Value(string path, string type, string? value, object[] children, bool trimmed, bool deferred,
        int childrenOmitted, bool full, DebugPolicy.PrivateValues? privateValues) => new {
        path = privateValues?.Contains(path) == true ? DebugPolicy.Redacted : path,
        type = privateValues?.Contains(type) == true ? DebugPolicy.Redacted : type,
        value = full ? DebugPolicy.FullValue(path, value, privateValues) : DebugPolicy.Value(path, value, privateValues),
        children, trimmed, deferred, childrenOmitted,
        // Server Binary Data renders only its byte count at every native detail: a summary, never the content.
        nativeSummary = children.Length == 0 && System.Text.RegularExpressions.Regex.IsMatch(value ?? "", @"^BinaryData \([0-9]+ bytes\)$")
    };
    static object Project(XElement e, string path, int depth, bool full, DebugPolicy.PrivateValues? privateValues,
        IReadOnlyDictionary<string, XElement> values, bool responseRow = false) {
        if (!responseRow && values.TryGetValue(path, out var expanded)) { e = expanded; responseRow = true; }
        var original = e;
        if (responseRow && e.Elements().FirstOrDefault() is { } content && NativeContainer(content)) e = content;
        var native = NativeContainer(e);
        var scalar = OwnText(original, legacy: !NativeContainer(original)) ?? (original == e ? null : OwnText(e));
        var trimmed = Flag(original, "debug.trimmed") || Flag(e, "debug.trimmed");
        var deferred = e.Name.LocalName == "DeferredEvaluation" || e.Element("DeferredEvaluation") != null;
        var blocked = privateValues?.Contains(path) == true || DebugPolicy.Sensitive(path);
        var fields = new Dictionary<string, Func<object>>(StringComparer.Ordinal);
        // A native scalar attribute called 'value' or 'name' is still a field.
        if (native) foreach (var attribute in e.Attributes().Where(a => !a.IsNamespaceDeclaration && !a.Name.LocalName.StartsWith("debug.", StringComparison.Ordinal))) {
            var fieldPath = ChildPath(path, attribute.Name.LocalName);
            fields[attribute.Name.LocalName] = () => Value(fieldPath, "Scalar", attribute.Value, [], Flag(e, "debug.trimmed." + attribute.Name.LocalName), false, 0, full, privateValues);
        }
        if (!deferred) foreach (var child in e.Elements()) {
            var name = child.Attribute("debug.field")?.Value;
            if (string.IsNullOrEmpty(name)) name = NativeContainer(child) ? child.Name.LocalName : child.Attribute("name")?.Value ?? child.Name.LocalName;
            var fieldPath = ChildPath(path, name);
            fields[name] = () => Project(child, fieldPath, depth + 1, full, privateValues, values);
        }
        var children = blocked || depth >= 6 ? [] : fields.Values.Take(100).Select(project => project()).ToArray();
        return Value(path, e.Name.LocalName, scalar, children, trimmed, deferred, blocked ? 0 : fields.Count - children.Length, full, privateValues);
    }
}
