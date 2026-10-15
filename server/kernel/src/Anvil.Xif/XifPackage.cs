using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml;
using System.Xml.Linq;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Anvil.Xif;

/// <summary>
/// The XIF package: a zlib stream of one XML document whose root is Extension (the layout observed in the Integration Studio
/// files and in the GitSSAM reader: Actions/Action/Variables/InputParameter|OutputParameter, Structures/Structure/Attribute,
/// Resources/Resource/Data in base64). Read with limits (compressed size, inflated size, no DTD), never trusting the paths
/// inside it. Pack writes the same shape (tests and synthetic fixtures).
/// </summary>
public static class XifPackage
{
    public const long CompressedLimit = 256L * 1024 * 1024;
    public const long InflatedLimit = 512L * 1024 * 1024;

    private static readonly Dictionary<string, string> RtTypes = new(StringComparer.Ordinal)
    {
        ["rtText"] = "Text", ["rtEmail"] = "Email", ["rtPhoneNumber"] = "PhoneNumber", ["rtInteger"] = "Integer", ["rtLongInteger"] = "LongInteger",
        ["rtDecimal"] = "Decimal", ["rtCurrency"] = "Currency", ["rtBoolean"] = "Boolean", ["rtDate"] = "Date", ["rtDateTime"] = "DateTime",
        ["rtTime"] = "Time", ["rtBinaryData"] = "BinaryData", ["rtObject"] = "Object",
    };

    /// <summary>The rt* name of a canonical type (writer side).</summary>
    public static string RtType(string canonical) => RtTypes.First(p => p.Value == canonical).Key;

    public static XifDocument Read(string path, long inflatedLimit = InflatedLimit)
    {
        if (!System.IO.Path.IsPathFullyQualified(path) || !File.Exists(path))
            throw XifRefusal.Single(XifCodes.PackageInvalid, $"The XIF '{path}' is not an existing absolute file.", "Give the absolute path of the .xif file.");
        var info = new FileInfo(path);
        if (info.Length == 0 || info.Length > CompressedLimit)
            throw XifRefusal.Single(XifCodes.PackageInvalid, $"The XIF has {info.Length} bytes; it must be nonempty and at most {CompressedLimit / (1024 * 1024)} MiB.", "Give a real extension package.");
        return Read(File.ReadAllBytes(path), inflatedLimit);
    }

    public static XifDocument Read(byte[] raw, long inflatedLimit = InflatedLimit)
    {
        if (raw.Length == 0 || raw.Length > CompressedLimit)
            throw XifRefusal.Single(XifCodes.PackageInvalid, $"The XIF has {raw.Length} bytes; it must be nonempty and at most {CompressedLimit / (1024 * 1024)} MiB.", "Give a real extension package.");
        var xml = Inflate(raw, inflatedLimit);
        XDocument document;
        try
        {
            var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, IgnoreWhitespace = false };
            using var reader = XmlReader.Create(new MemoryStream(xml), settings);
            document = XDocument.Load(reader, LoadOptions.PreserveWhitespace);
        }
        catch (XmlException error)
        {
            throw XifRefusal.Single(XifCodes.PackageInvalid, "The XIF does not hold valid XML (" + error.Message + ").", "Give a package saved by Integration Studio or by SSAM.");
        }
        if (document.Root is not { } root || root.Name.LocalName != "Extension")
            throw XifRefusal.Single(XifCodes.PackageInvalid, $"The XIF root is '{document.Root?.Name.LocalName}', not Extension.", "Give an O11 extension package (.xif).");
        return new XifDocument(raw, document);
    }

    private static byte[] Inflate(byte[] raw, long limit)
    {
        try
        {
            using var input = new ZLibStream(new MemoryStream(raw), CompressionMode.Decompress);
            using var output = new MemoryStream();
            var buffer = new byte[81920];
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                if (output.Length + read > limit)
                    throw XifRefusal.Single(XifCodes.PackageInvalid, $"The XIF inflates to more than {limit} bytes.", "Give a smaller package (resources included).");
                output.Write(buffer, 0, read);
            }
            if (output.Length == 0) throw new InvalidDataException("empty stream");
            return output.ToArray();
        }
        catch (Exception error) when (error is InvalidDataException or IOException)
        {
            throw XifRefusal.Single(XifCodes.PackageInvalid, "The file is not a zlib-compressed XIF (" + error.Message + ").", "Give a package saved by Integration Studio or by SSAM.");
        }
    }

    /// <summary>The XML as a XIF: UTF-8 without BOM, zlib. Deterministic for the same document.</summary>
    public static byte[] Pack(XDocument document)
    {
        var text = new MemoryStream();
        using (var writer = XmlWriter.Create(text, new XmlWriterSettings { Encoding = new UTF8Encoding(false), Indent = false, OmitXmlDeclaration = false }))
            document.Save(writer);
        var output = new MemoryStream();
        using (var zlib = new ZLibStream(output, CompressionLevel.Optimal, leaveOpen: true)) zlib.Write(text.ToArray());
        return output.ToArray();
    }

    internal static string TypeOf(XElement element, IReadOnlyDictionary<string, string> structureNames)
    {
        var raw = (string?)element.Attribute("Type") ?? "";
        var keys = ((string?)element.Attribute("RecordType") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (raw is "rtRecord" or "rtRecordList" && keys.Length == 1 && structureNames.TryGetValue(keys[0], out var name))
            return raw == "rtRecord" ? name : name + " List";
        return RtTypes.TryGetValue(raw, out var canonical) ? canonical : raw;
    }

    internal static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

public sealed record XifPackageResource(string Key, string Path, string Filename, string CompileAction, bool CodeReference, byte[] Data)
{
    public string Sha256 { get; } = XifPackage.Sha256(Data);
    /// <summary>Path\Filename relative to the extension root, backslash separated, without a leading separator.</summary>
    public string RelativePath => string.Join("\\", Path.Split('/', '\\').Where(s => s.Length > 0).Append(Filename));
}

/// <summary>One read XIF: identity, contract (structures, actions with keys) and resources. ActivationCode is never exposed.</summary>
public sealed class XifDocument
{
    public byte[] Raw { get; }
    public XDocument Xml { get; }
    public string Sha256 { get; }
    public string Name { get; }
    public string Key { get; }
    /// <summary>The model hash Integration Studio stores on the root (the extensionHash of UploadNeeded).</summary>
    public string Hash { get; }
    public string? Version { get; }
    public string? LastUpgradeVersion { get; }
    public string? Description { get; }
    public IReadOnlyList<XifStructure> Structures { get; }
    public IReadOnlyList<XifAction> Actions { get; }
    public IReadOnlyList<XifPackageResource> Resources { get; }

    internal XifDocument(byte[] raw, XDocument xml)
    {
        Raw = raw; Xml = xml; Sha256 = XifPackage.Sha256(raw);
        var root = xml.Root!;
        Name = (string?)root.Attribute("Name") ?? "";
        if (!XifSpec.IsIdentifier(Name))
            throw XifRefusal.Single(XifCodes.PackageInvalid, $"The XIF root has no valid Name ('{Name}').", "Give an O11 extension package (.xif).");
        Key = (string?)root.Attribute("Key") ?? "";
        Hash = (string?)root.Attribute("Hash") ?? "";
        Version = (string?)root.Attribute("Version");
        LastUpgradeVersion = (string?)root.Attribute("LastUpgradeVersion");
        Description = (string?)root.Attribute("Description");
        var structureElements = Section(root, "Structures", "Structure").ToList();
        var names = structureElements.Where(s => !string.IsNullOrEmpty((string?)s.Attribute("Key")))
            .GroupBy(s => (string)s.Attribute("Key")!).ToDictionary(g => g.Key, g => (string?)g.First().Attribute("Name") ?? "", StringComparer.Ordinal);
        Structures = structureElements.Select(s => new XifStructure
        {
            Name = (string?)s.Attribute("Name") ?? "", Key = (string?)s.Attribute("Key"), Description = Empty((string?)s.Attribute("Description")),
            Attributes = s.Elements().Where(e => e.Name.LocalName == "Attribute").Select(a => new XifAttribute
            {
                Name = (string?)a.Attribute("Name") ?? "", Key = (string?)a.Attribute("Key"), Type = XifPackage.TypeOf(a, names),
                Mandatory = YesNo(a, "IsMandatory"), Length = Number(a, "Length"), Decimals = Number(a, "Decimals"),
                Default = Empty((string?)a.Attribute("DefaultValue") ?? (string?)a.Attribute("Default")), Description = Empty((string?)a.Attribute("Description")),
            }).ToList(),
        }).ToList();
        var resources = new List<XifPackageResource>();
        foreach (var r in Section(root, "Resources", "Resource"))
        {
            var filename = (string?)r.Attribute("Filename") ?? "";
            var path = (string?)r.Attribute("Path") ?? "";
            Safe(path, filename);
            var data = r.Elements().FirstOrDefault(e => e.Name.LocalName == "Data")?.Value ?? "";
            byte[] bytes;
            try { bytes = Convert.FromBase64String(string.Concat(data.Where(c => !char.IsWhiteSpace(c)))); }
            catch (FormatException) { throw XifRefusal.Single(XifCodes.PackageInvalid, $"The resource {filename} has invalid base64 data.", "Give a package saved by Integration Studio or by SSAM."); }
            resources.Add(new XifPackageResource((string?)r.Attribute("Key") ?? "", path, filename, (string?)r.Attribute("CompileAction") ?? "", YesNo(r, "CodeReference"), bytes));
        }
        var duplicate = resources.GroupBy(r => r.RelativePath, StringComparer.OrdinalIgnoreCase).FirstOrDefault(g => g.Count() > 1);
        if (duplicate != null)
            throw XifRefusal.Single(XifCodes.PackageInvalid, $"The XIF lists the resource {duplicate.Key} twice.", "Give a package saved by Integration Studio or by SSAM.");
        Resources = resources;
        var bodies = Bodies();
        Actions = Section(root, "Actions", "Action").Select(a =>
        {
            var name = (string?)a.Attribute("Name") ?? "";
            var variables = a.Elements().FirstOrDefault(e => e.Name.LocalName == "Variables")?.Elements().ToList() ?? [];
            XifParameter Param(XElement p, bool input) => new()
            {
                Name = (string?)p.Attribute("Name") ?? "", Key = (string?)p.Attribute("Key"), Type = XifPackage.TypeOf(p, names), IsInput = input,
                Mandatory = input && YesNo(p, "IsMandatory"), Default = Empty((string?)p.Attribute("Default") ?? (string?)p.Attribute("DefaultValue")),
                Description = Empty((string?)p.Attribute("Description")),
            };
            return new XifAction
            {
                Name = name, Key = (string?)a.Attribute("Key"), Description = Empty((string?)a.Attribute("Description")), IsFunction = YesNo(a, "IsFunction"),
                Inputs = variables.Where(v => v.Name.LocalName == "InputParameter").Select(p => Param(p, true)).ToList(),
                Outputs = variables.Where(v => v.Name.LocalName == "OutputParameter").Select(p => Param(p, false)).ToList(),
                Body = bodies.GetValueOrDefault(name),
            };
        }).ToList();
    }

    /// <summary>The main source of the extension: Source\NET\&lt;Name&gt;.cs (or the only &lt;Name&gt;.cs).</summary>
    public XifPackageResource? MainSource =>
        Resources.Where(r => string.Equals(r.Filename, Name + ".cs", StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(r => r.RelativePath.StartsWith("Source\\NET\\", StringComparison.OrdinalIgnoreCase)).FirstOrDefault();

    public static string Text(byte[] bytes) => new UTF8Encoding(false).GetString(bytes).TrimStart('﻿');

    /// <summary>The body of each action method Mss&lt;Action&gt; of the class Css&lt;Name&gt; in the main source, de-indented.</summary>
    private Dictionary<string, string> Bodies()
    {
        var found = new Dictionary<string, string>(StringComparer.Ordinal);
        if (MainSource is not { } source) return found;
        var tree = CSharpSyntaxTree.ParseText(Text(source.Data), new CSharpParseOptions(LanguageVersion.CSharp7_3));
        var owner = tree.GetRoot().DescendantNodes().OfType<ClassDeclarationSyntax>().FirstOrDefault(c => c.Identifier.ValueText == "Css" + Name);
        if (owner == null) return found;
        foreach (var method in owner.Members.OfType<MethodDeclarationSyntax>().Where(m => m.Identifier.ValueText.StartsWith("Mss", StringComparison.Ordinal) && m.Body != null))
            found[method.Identifier.ValueText[3..]] = XifSourceMerge.BodyText(method.Body!);
        return found;
    }

    /// <summary>The spec of this extension (I9 shape, with keys and the current bodies).</summary>
    public JsonObject Spec()
    {
        var o = new JsonObject { ["name"] = Name };
        if (Description != null) o["description"] = Description;
        if (Structures.Count > 0) o["structures"] = new JsonArray(Structures.Select(s => (JsonNode)s.ToJson()).ToArray());
        o["actions"] = new JsonArray(Actions.Select(a => (JsonNode)a.ToJson()).ToArray());
        return o;
    }

    /// <summary>sha256 of the public contract only (names, keys, types, mandatory, function): equal when only bodies changed.</summary>
    public string SignatureHash => XifPackage.Sha256(Encoding.UTF8.GetBytes(XifContractDiff.Canonical(this).ToJsonString()));

    /// <summary>The answer of `xif read`: identity, hashes, the spec and the resources (never their bytes).</summary>
    public JsonObject Describe() => new()
    {
        ["name"] = Name, ["key"] = Key, ["hash"] = Hash, ["sha256"] = Sha256, ["version"] = Version, ["lastUpgradeVersion"] = LastUpgradeVersion,
        ["signatureHash"] = SignatureHash, ["spec"] = Spec(),
        ["resources"] = new JsonArray(Resources.Select(r => (JsonNode)new JsonObject
        {
            ["path"] = r.RelativePath, ["key"] = r.Key, ["deploy"] = r.CompileAction, ["codeReference"] = r.CodeReference, ["bytes"] = r.Data.Length, ["sha256"] = r.Sha256,
        }).ToArray()),
    };

    /// <summary>Export into a fresh private directory. Package paths are metadata, never filesystem destinations.</summary>
    public JsonObject ExportResources(string directory)
    {
        if (!System.IO.Path.IsPathFullyQualified(directory) || Directory.Exists(directory) || File.Exists(directory))
            throw XifRefusal.Single(XifCodes.PackageInvalid, "Resource export needs a new absolute directory.", "Use a new private work directory.");
        // Validate every filename before writing anything; Windows device names and alternate streams are not files.
        foreach (var r in Resources)
            if (r.Filename.IndexOfAny(System.IO.Path.GetInvalidFileNameChars()) >= 0 || r.Filename.EndsWith('.') || r.Filename.EndsWith(' ') ||
                System.Text.RegularExpressions.Regex.IsMatch(r.Filename, @"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                throw XifRefusal.Single(XifCodes.PackageInvalid, "The XIF has an unsafe resource filename.", "Use a package with ordinary resource filenames.");
        var resources = new JsonArray();
        var references = new JsonArray();
        Directory.CreateDirectory(directory);
        for (var i = 0; i < Resources.Count; i++)
        {
            var r = Resources[i];
            // Separate slots preserve same-named resources without collisions or trusting the package's directories.
            var slot = System.IO.Path.Combine(directory, i.ToString("D4"));
            Directory.CreateDirectory(slot);
            var file = System.IO.Path.Combine(slot, r.Filename);
            using (var output = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None)) output.Write(r.Data);
            resources.Add(new JsonObject { ["path"] = r.RelativePath, ["file"] = file, ["sha256"] = r.Sha256,
                ["bytes"] = r.Data.Length, ["deploy"] = r.CompileAction, ["codeReference"] = r.CodeReference });
            if (r.CodeReference && r.Filename.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) &&
                !r.Filename.StartsWith("OutSystems.", StringComparison.OrdinalIgnoreCase)) references.Add(file);
        }
        return new JsonObject { ["directory"] = directory, ["resources"] = resources, ["references"] = references };
    }

    /// <summary>The checks of a final XIF before it is sent: the compiled DLL is the one we built, no platform DLL is embedded,
    /// and no local profile path leaked into it. Every problem at once.</summary>
    public IReadOnlyList<XifProblem> Audit(string? expectedDllSha256, IEnumerable<string> platformDlls, IEnumerable<string> profilePaths)
    {
        var problems = new List<XifProblem>();
        var dllName = "OutSystems.Nss" + Name + ".dll";
        var dll = Resources.FirstOrDefault(r => string.Equals(r.Filename, dllName, StringComparison.OrdinalIgnoreCase));
        if (expectedDllSha256 != null && (dll == null || dll.Sha256 != expectedDllSha256))
            problems.Add(new XifProblem(XifCodes.VerifyFailed, dll?.RelativePath ?? dllName, dll == null ? $"The final XIF has no {dllName}." : $"{dllName} in the final XIF is not the DLL that was compiled.",
                "Build again; nothing was sent."));
        // The platform deploys only Binaries resources: any other mode leaves consumers without the DLL (CS0006 at publish).
        if (expectedDllSha256 != null && dll != null && !string.Equals(dll.CompileAction, "Binaries", StringComparison.OrdinalIgnoreCase))
            problems.Add(new XifProblem(XifCodes.VerifyFailed, dll.RelativePath, $"{dllName} is deployed as '{dll.CompileAction}', not Binaries: consumers would not find it (CS0006).",
                "Build again with the current engine; nothing was sent."));
        var platform = new HashSet<string>(platformDlls.Select(System.IO.Path.GetFileName)!, StringComparer.OrdinalIgnoreCase);
        foreach (var r in Resources.Where(r => platform.Contains(r.Filename) && !string.Equals(r.Filename, dllName, StringComparison.OrdinalIgnoreCase)))
            problems.Add(new XifProblem(XifCodes.DependencyOverride, r.RelativePath, $"The final XIF embeds the platform DLL {r.Filename}.", "Remove it from resources; the platform provides it."));
        var xml = Xml.ToString(SaveOptions.DisableFormatting);
        foreach (var profile in profilePaths.Where(p => !string.IsNullOrWhiteSpace(p)).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (xml.Contains(profile, StringComparison.OrdinalIgnoreCase))
                problems.Add(new XifProblem(XifCodes.VerifyFailed, "Extension", "The final XIF carries a local profile path.", "Build again from a private work folder; nothing was sent."));
            foreach (var r in Resources.Where(r => r.Filename.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase) || r.Filename.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) || r.Filename.EndsWith(".config", StringComparison.OrdinalIgnoreCase)))
                if (Text(r.Data).Contains(profile, StringComparison.OrdinalIgnoreCase))
                    problems.Add(new XifProblem(XifCodes.VerifyFailed, r.RelativePath, $"{r.Filename} carries a local profile path.", "Build again from a private work folder; nothing was sent."));
        }
        return problems;
    }

    private static IEnumerable<XElement> Section(XElement root, string section, string item) =>
        root.Elements().FirstOrDefault(e => e.Name.LocalName == section)?.Elements().Where(e => e.Name.LocalName == item) ?? [];

    private static bool YesNo(XElement e, string name) => string.Equals((string?)e.Attribute(name), "Yes", StringComparison.OrdinalIgnoreCase) ||
        string.Equals((string?)e.Attribute(name), "true", StringComparison.OrdinalIgnoreCase);

    private static int? Number(XElement e, string name) => int.TryParse((string?)e.Attribute(name), out var n) ? n : null;

    private static string? Empty(string? text) => string.IsNullOrEmpty(text) ? null : text;

    private static void Safe(string path, string filename)
    {
        if (filename.Length == 0 || filename is "." or ".." || filename.IndexOfAny(['/', '\\', ':', '\0']) >= 0 ||
            System.Text.RegularExpressions.Regex.IsMatch(path, "^[A-Za-z]:") || path.Contains('\0') ||
            path.Split('/', '\\').Any(s => s == ".." || s.Contains(':')))
            throw XifRefusal.Single(XifCodes.PackageInvalid, $"The XIF has an unsafe resource path '{path}{filename}'.", "Give a package saved by Integration Studio or by SSAM.");
    }
}
