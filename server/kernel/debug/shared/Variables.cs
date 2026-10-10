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
        return root.Elements().Take(max).Select(e => Project(e, "", 0, full, privateValues)).ToArray();
    }
    static object Project(XElement e, string parent, int depth, bool full, DebugPolicy.PrivateValues? privateValues) {
        var name = e.Attribute("name")?.Value ?? e.Name.LocalName;
        var path = parent.Length == 0 ? name : parent + "." + name;
        var privatePath = privateValues?.Contains(path) == true;
        return new {
            path = privatePath ? DebugPolicy.Redacted : path,
            type = privateValues?.Contains(e.Name.LocalName) == true ? DebugPolicy.Redacted : e.Name.LocalName,
            value = full ? DebugPolicy.FullValue(path, e.Attribute("value")?.Value ?? (e.HasElements ? null : e.Value), privateValues)
                         : DebugPolicy.Value(path, e.Attribute("value")?.Value ?? (e.HasElements ? null : e.Value), privateValues),
            children = depth >= 6 || privatePath || DebugPolicy.Sensitive(path) ? [] : e.Elements().Take(100).Select(c => Project(c, path, depth + 1, full, privateValues)).ToArray()
        };
    }
}
