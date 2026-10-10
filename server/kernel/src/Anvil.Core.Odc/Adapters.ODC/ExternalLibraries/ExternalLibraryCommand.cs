using System.Globalization;
using System.Text.Json.Nodes;

namespace Anvil.Core.ExternalLibraries;

/// <summary>
/// `anvil-odc external-library build|contents|diff`, one JSON answer per command, with no Studio and no tenant:
///   build --spec &lt;spec.json&gt; --out &lt;new folder&gt; [--max-bytes N] [--timeout-seconds N]
///       generates the project, runs dotnet publish and writes the deterministic zip (&lt;Name&gt;-&lt;sha16&gt;.zip)
///   contents --spec &lt;spec.json&gt; | --package &lt;zip&gt; | --server &lt;contents.json&gt;
///       the plan of a spec, the facts of a package, or a generation contents answer, in one shape
///   diff --base &lt;json&gt; --new &lt;json&gt;     Added/Removed/Updated between two specs or contents documents
/// A refusal is {ok:false, code, error, problems} (contract 1.6), never an exception envelope.
/// </summary>
public static class ExternalLibraryCommand
{
    public static JsonObject Run(string[] args, IProcessRunner? runner = null)
    {
        var verb = args.Length > 1 ? args[1] : "";
        try
        {
            return verb switch
            {
                "build" => ExternalLibraryBuild.Build(ExternalLibrarySpec.Read(Need(args, "--spec")), Need(args, "--out"), runner ?? new SystemProcessRunner(),
                    new ExternalLibraryBuild.Options(
                        MaxPackageBytes: Opt(args, "--max-bytes") is { } max ? long.Parse(max, CultureInfo.InvariantCulture) : ExternalLibraryPackage.MaxBytes,
                        Timeout: Opt(args, "--timeout-seconds") is { } seconds ? TimeSpan.FromSeconds(int.Parse(seconds, CultureInfo.InvariantCulture)) : null)),
                "contents" => Contents(args),
                "diff" => new JsonObject { ["ok"] = true, ["diff"] = ExternalLibraryContents.Diff(ReadJson(Need(args, "--base")), ReadJson(Need(args, "--new"))) },
                _ => Usage("external-library takes build, contents or diff."),
            };
        }
        catch (ExternalLibraryException refusal) { return refusal.ToJson(); }
    }

    private static JsonObject Contents(string[] args)
    {
        if (Opt(args, "--spec") is { } spec) return new JsonObject { ["ok"] = true, ["source"] = "spec", ["contents"] = ExternalLibraryContents.FromSpec(ExternalLibrarySpec.Read(spec)) };
        if (Opt(args, "--package") is { } package) return new JsonObject { ["ok"] = true, ["source"] = "package", ["package"] = ExternalLibraryContents.FromPackage(File.ReadAllBytes(package)) };
        if (Opt(args, "--server") is { } server) return new JsonObject { ["ok"] = true, ["source"] = "server", ["contents"] = ExternalLibraryContents.Normalize(ReadJson(server)) };
        return Usage("contents takes --spec, --package or --server.");
    }
    private static JsonObject Usage(string message) => new ExternalLibraryException("USAGE", message,
        [new("USAGE", "", message, "anvil-odc external-library build --spec <spec.json> --out <folder> | contents --spec|--package|--server <file> | diff --base <json> --new <json>")]).ToJson();
    private static JsonNode? ReadJson(string path) => JsonNode.Parse(File.ReadAllText(path));
    private static string Need(string[] args, string name) => Opt(args, name)
        ?? throw new ExternalLibraryException("USAGE", "missing " + name, [new("USAGE", "", "missing " + name, "Pass " + name + " <value>.")]);
    private static string? Opt(string[] args, string name)
    {
        var i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }
}
