using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Anvil.Core.ExternalLibraries;

/// <summary>
/// The upload package of an External Library: the `dotnet publish` folder as a deterministic zip (entries in ordinal
/// order with '/' separators, one fixed date, the same compression), so the same build gives the same sha256. Gates the
/// platform applies to an upload, checked before anything leaves the machine: exactly one .deps.json, whose runtime
/// target is .NETCoreApp v10.0 (PACKAGE_NOT_NET10), and the size limit of the upload (PACKAGE_TOO_LARGE).
/// </summary>
public static class ExternalLibraryPackage
{
    /// <summary>The upload limit of an External Library zip in ODC (90 MB), to confirm in the live proof.</summary>
    public const long MaxBytes = 90L * 1024 * 1024;
    private const long MaxDepsBytes = 4L * 1024 * 1024;
    private const string Net10 = ".NETCoreApp,Version=v10.0";
    private static readonly DateTimeOffset FixedDate = new(1980, 1, 1, 0, 0, 0, TimeSpan.Zero);

    public sealed record Facts(string Sha256, long Bytes, IReadOnlyList<string> Entries, string DepsJson, string RuntimeTarget, string? MainAssembly)
    {
        public JsonObject ToJson() => new()
        {
            ["sha256"] = Sha256, ["bytes"] = Bytes, ["entries"] = new JsonArray(Entries.Select(e => (JsonNode)JsonValue.Create(e)!).ToArray()),
            ["depsJson"] = DepsJson, ["runtimeTarget"] = RuntimeTarget, ["mainAssembly"] = MainAssembly,
        };
    }

    public static byte[] Zip(string directory)
    {
        var root = Path.GetFullPath(directory);
        var files = Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .Select(f => (Full: f, Name: Path.GetRelativePath(root, f).Replace('\\', '/')))
            .OrderBy(f => f.Name, StringComparer.Ordinal).ToArray();
        using var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (full, name) in files)
            {
                var entry = archive.CreateEntry(name, CompressionLevel.Optimal);
                entry.LastWriteTime = FixedDate;
                using var target = entry.Open();
                using var source = File.OpenRead(full);
                source.CopyTo(target);
            }
        }
        return buffer.ToArray();
    }

    public static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    /// <summary>The facts of a package, or the platform's refusal of it with every problem.</summary>
    public static Facts Inspect(byte[] zip, long maxBytes = MaxBytes, string? expectedAssembly = null)
    {
        var problems = new List<ExternalLibraryProblem>();
        if (zip.LongLength > maxBytes)
            throw new ExternalLibraryException("PACKAGE_TOO_LARGE", "The package has " + zip.LongLength + " bytes; the upload limit is " + maxBytes + ".",
                [new("PACKAGE_TOO_LARGE", "/package", "The package has " + zip.LongLength + " bytes, above the limit of " + maxBytes + ".",
                    "Remove packages the library does not need, or move large resources out of the library.")]);
        List<string> entries; string? depsName = null; string runtimeTarget = "";
        try
        {
            using var archive = new ZipArchive(new MemoryStream(zip), ZipArchiveMode.Read);
            entries = archive.Entries.Where(e => !e.FullName.EndsWith('/')).Select(e => e.FullName).ToList();
            var deps = archive.Entries.Where(e => e.FullName.EndsWith(".deps.json", StringComparison.OrdinalIgnoreCase)).ToArray();
            if (deps.Length != 1)
                problems.Add(new("DEPS_JSON_COUNT", "/package", "The package must hold exactly one .deps.json (it has " + deps.Length + ": "
                    + string.Join(", ", deps.Select(d => d.FullName)) + ").", "Publish one project only, with `dotnet publish` of the library project."));
            else
            {
                depsName = deps[0].FullName;
                if (deps[0].Length > MaxDepsBytes)
                    problems.Add(new("DEPS_JSON_UNREADABLE", "/package/" + depsName, "The .deps.json is too large to read.", "Publish the library project again."));
                else
                {
                    try
                    {
                        using var stream = deps[0].Open();
                        var node = JsonNode.Parse(stream);
                        runtimeTarget = node?["runtimeTarget"]?["name"]?.GetValue<string>() ?? "";
                    }
                    catch (Exception e) when (e is JsonException or InvalidOperationException or FormatException)
                    {
                        problems.Add(new("DEPS_JSON_UNREADABLE", "/package/" + depsName, "The .deps.json is not readable JSON.", "Publish the library project again."));
                    }
                    if (problems.Count == 0 && !(runtimeTarget == Net10 || runtimeTarget.StartsWith(Net10 + "/", StringComparison.Ordinal)))
                        problems.Add(new("NOT_NET10", "/package/" + depsName, "The package targets '" + runtimeTarget + "'; ODC runs External Libraries on .NET 10.",
                            "Target net10.0 (the generated project does) and publish again."));
                }
            }
        }
        catch (InvalidDataException)
        {
            throw new ExternalLibraryException("PACKAGE_NOT_NET10", "The package is not a readable zip.",
                [new("PACKAGE_UNREADABLE", "/package", "The package is not a readable zip.", "Build it again with external-library build.")]);
        }
        if (problems.Count > 0)
            throw new ExternalLibraryException("PACKAGE_NOT_NET10", "The package does not prove a .NET 10 library: " + problems[0].Message, problems);
        var main = expectedAssembly != null && entries.Contains(expectedAssembly + ".dll", StringComparer.Ordinal) ? expectedAssembly + ".dll"
            : depsName != null && entries.Contains(depsName[..^".deps.json".Length] + ".dll", StringComparer.Ordinal) ? depsName[..^".deps.json".Length] + ".dll" : null;
        return new Facts(Sha256(zip), zip.LongLength, entries, depsName!, runtimeTarget, main);
    }
}
