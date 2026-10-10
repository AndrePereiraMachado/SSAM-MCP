using System.IO.Compression;
using System.Text;
using System.Text.Json.Nodes;

namespace Anvil.Xif;

/// <summary>
/// The stages of `anvil xif build`, local files only (the facade reads the environment through the bridge in between):
///   model: spec (all problems at once) -> the engine applies it to a blank or to the current extension and saves the model
///          XIF (the file GenerateSourceCodeStubs receives);
///   final: the stubs and the platform DLLs the environment returned -> merge of the bodies -> net472 compilation -> the
///          engine adds the sources and the DLL to the model and saves the final XIF -> the final XIF is read again and
///          audited (our DLL, no platform DLL embedded, no local profile path) before anyone may send it.
/// The engine is injectable (tests); by default it is the Anvil.Xif.Engine process.
/// </summary>
public static class XifBuild
{
    public delegate JsonObject EngineRunner(JsonObject request, string work);
    public const long ZipLimit = 256L * 1024 * 1024;

    public static XifSpecContext Context(XifDocument? baseXif, bool requireFiles = true) => new()
    {
        ExistingActions = (baseXif?.Actions.Select(a => a.Name) ?? []).ToHashSet(StringComparer.OrdinalIgnoreCase),
        ExistingStructures = (baseXif?.Structures.Select(s => s.Name) ?? []).ToHashSet(StringComparer.OrdinalIgnoreCase),
        RequireFiles = requireFiles,
    };

    public static JsonObject Check(JsonNode? specNode, string? basePath)
    {
        var baseXif = basePath == null ? null : XifPackage.Read(basePath);
        var spec = XifSpec.Parse(specNode, Context(baseXif));
        if (baseXif != null && !string.Equals(baseXif.Name, spec.Name, StringComparison.Ordinal))
            throw XifRefusal.Single(XifCodes.SpecInvalid, $"The spec names '{spec.Name}' but the extension is '{baseXif.Name}'.", "Keep the name of the extension; renaming an extension is not an edit.", "name");
        var answer = new JsonObject
        {
            ["ok"] = true, ["spec"] = spec.ToJson(),
            ["create"] = baseXif == null,
            ["actions"] = new JsonArray(spec.Actions.Select(a => (JsonNode)new JsonObject
            {
                ["name"] = a.Name, ["new"] = baseXif == null || !baseXif.Actions.Any(b => string.Equals(b.Name, a.Name, StringComparison.OrdinalIgnoreCase)),
                ["body"] = a.Body != null,
            }).ToArray()),
        };
        // K1-f: what was accepted in another shape (one object for a list), for the receipt.
        if (spec.Normalized.Count > 0) answer["specNormalized"] = spec.NormalizedJson();
        return answer;
    }

    public static JsonObject Model(JsonNode? specNode, string? basePath, string work, EngineRunner? engine = null)
    {
        work = Work(work);
        var baseXif = basePath == null ? null : XifPackage.Read(basePath);
        var spec = XifSpec.Parse(specNode, Context(baseXif));
        if (baseXif != null && !string.Equals(baseXif.Name, spec.Name, StringComparison.Ordinal))
            throw XifRefusal.Single(XifCodes.SpecInvalid, $"The spec names '{spec.Name}' but the extension is '{baseXif.Name}'.", "Keep the name of the extension.", "name");
        var output = Path.Combine(work, "model", spec.Name + ".xif");
        if (File.Exists(output)) throw XifRefusal.Single(XifCodes.SpecInvalid, "The model XIF of this work folder already exists.", "Use a new work folder.");
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        var request = new JsonObject
        {
            ["command"] = "model", ["work"] = work, ["spec"] = spec.ToJson(), ["output"] = output,
            ["references"] = new JsonArray(spec.References.Select(r => (JsonNode)JsonValue.Create(r)!).ToArray()),
        };
        if (basePath != null) request["base"] = Path.GetFullPath(basePath);
        var answer = (engine ?? XifEngineClient.Run)(request, work);
        var model = XifPackage.Read(answer["xif"]?.ToString() ?? output);
        return new JsonObject
        {
            ["ok"] = true, ["stage"] = "model", ["xif"] = answer["xif"]?.ToString() ?? output, ["sha256"] = model.Sha256, ["name"] = model.Name, ["key"] = model.Key,
            ["hash"] = model.Hash, ["create"] = baseXif == null, ["engine"] = answer["studio"]?.DeepClone(), ["reports"] = answer["reports"]?.DeepClone(),
        };
    }

    public static JsonObject Final(JsonNode? specNode, string modelPath, string stubsZip, string depsZip, string? basePath, string work, EngineRunner? engine = null)
    {
        work = Work(work);
        var baseXif = basePath == null ? null : XifPackage.Read(basePath);
        var spec = XifSpec.Parse(specNode, Context(baseXif));
        var model = XifPackage.Read(modelPath);
        if (!string.Equals(model.Name, spec.Name, StringComparison.Ordinal))
            throw XifRefusal.Single(XifCodes.SpecInvalid, $"The model XIF is '{model.Name}', not '{spec.Name}'.", "Build the model of this spec first.", "name");
        var stubs = Unzip(stubsZip, Path.Combine(work, "stubs"), name => name.EndsWith(".cs", StringComparison.OrdinalIgnoreCase));
        var deps = Unzip(depsZip, Path.Combine(work, "deps"), name => name.EndsWith(".dll", StringComparison.OrdinalIgnoreCase));
        var mainName = spec.Name + ".cs";
        var main = stubs.Keys.Where(k => string.Equals(Path.GetFileName(k), mainName, StringComparison.OrdinalIgnoreCase)).OrderBy(k => k.Length).FirstOrDefault()
            ?? throw XifRefusal.Single(XifCodes.MergeFailed, $"The generated stubs have no {mainName}.", "Generate the stubs again from the model XIF of this spec; nothing was sent.");
        var current = baseXif?.MainSource is { } source ? XifDocument.Text(source.Data) : null;
        var bodies = spec.Actions.Where(a => a.Body != null).Select(a => new XifActionBody(a.Name, a.Body!)).ToList();
        var merged = XifSourceMerge.Merge(spec.Name, File.ReadAllText(stubs[main]), current, bodies);

        // Sources: the generated files, the merged main source, the author's other files of the current extension, the spec's.
        var sources = new Dictionary<string, XifCompileSource>(StringComparer.OrdinalIgnoreCase);
        foreach (var (relative, file) in stubs)
            sources["Source\\NET\\" + relative] = new XifCompileSource("Source\\NET\\" + relative, File.ReadAllText(file));
        sources["Source\\NET\\" + main] = new XifCompileSource("Source\\NET\\" + main, merged.Source, merged.BodyLines);
        foreach (var r in baseXif?.Resources ?? [])
            if (r.Filename.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) && r.RelativePath.StartsWith("Source\\NET\\", StringComparison.OrdinalIgnoreCase) && !sources.ContainsKey(r.RelativePath))
                sources[r.RelativePath] = new XifCompileSource(r.RelativePath, XifDocument.Text(r.Data));
        foreach (var s in spec.Sources)
            sources["Source\\NET\\" + s.Path] = new XifCompileSource("Source\\NET\\" + s.Path, s.Read());

        // Author DLLs: the spec's, plus the ones the current extension already carries (never the platform's, never its own DLL).
        var authors = new List<string>(spec.References);
        var ownDll = XifCompiler.AssemblyName(spec.Name) + ".dll";
        var platformNames = deps.Keys.Select(Path.GetFileName).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var kept = Path.Combine(work, "refs");
        foreach (var r in baseXif?.Resources ?? [])
            if (r.Filename.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) && !string.Equals(r.Filename, ownDll, StringComparison.OrdinalIgnoreCase) &&
                !platformNames.Contains(r.Filename) && !authors.Any(a => string.Equals(Path.GetFileName(a), r.Filename, StringComparison.OrdinalIgnoreCase)))
            {
                Directory.CreateDirectory(kept);
                var file = Path.Combine(kept, r.Filename);
                File.WriteAllBytes(file, r.Data);
                authors.Add(file);
            }

        var compiled = XifCompiler.Compile(new XifCompileInput(spec.Name, sources.Values.ToList(), deps.Values.ToList(), authors));
        var outDir = Path.Combine(work, "out");
        Directory.CreateDirectory(outDir);
        var dll = Path.Combine(outDir, ownDll);
        File.WriteAllBytes(dll, compiled.Dll);
        var written = new JsonArray();
        foreach (var s in sources.Values.OrderBy(s => s.Path, StringComparer.OrdinalIgnoreCase))
        {
            var file = Path.Combine(outDir, "source", s.Path);
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, s.Text, new UTF8Encoding(true));
            written.Add(new JsonObject { ["path"] = s.Path, ["file"] = file });
        }
        var output = Path.Combine(work, "final", spec.Name + ".xif");
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        var request = new JsonObject
        {
            ["command"] = "final", ["work"] = work, ["model"] = Path.GetFullPath(modelPath), ["output"] = output, ["name"] = spec.Name,
            ["sources"] = written, ["dll"] = dll,
        };
        var answer = (engine ?? XifEngineClient.Run)(request, work);
        var final = XifPackage.Read(answer["xif"]?.ToString() ?? output);
        var profiles = new[] { Environment.GetEnvironmentVariable("USERPROFILE"), Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) }.Where(p => !string.IsNullOrEmpty(p)).Cast<string>();
        var problems = final.Audit(compiled.Sha256, deps.Values, profiles);
        if (!string.Equals(final.Name, spec.Name, StringComparison.Ordinal) || (baseXif != null && !string.Equals(final.Key, baseXif.Key, StringComparison.OrdinalIgnoreCase)))
            problems = [.. problems, new XifProblem(XifCodes.VerifyFailed, "Extension", "The final XIF does not keep the name and key of the extension.", "Build again from the current extension; nothing was sent.")];
        if (problems.Count > 0)
            throw new XifRefusal(problems[0].Code == XifCodes.DependencyOverride ? XifCodes.DependencyOverride : XifCodes.VerifyFailed,
                "The final XIF failed its checks; nothing was sent.", problems);
        var result = new JsonObject
        {
            ["ok"] = true, ["stage"] = "final", ["xif"] = answer["xif"]?.ToString() ?? output, ["xifSha256"] = final.Sha256, ["dllSha256"] = compiled.Sha256,
            ["hash"] = final.Hash, ["name"] = final.Name, ["key"] = final.Key, ["signatureHash"] = final.SignatureHash,
            ["changedActions"] = new JsonArray(merged.Changed.Select(c => (JsonNode)JsonValue.Create(c)!).ToArray()),
            ["warnings"] = new JsonArray(compiled.Warnings.Select(w => (JsonNode)w).ToArray()),
        };
        if (baseXif != null) result["contractDiff"] = XifContractDiff.Diff(baseXif, final);
        return result;
    }

    /// <summary>The entries of a zip the environment returned, under dir, by their relative path (safe names only).</summary>
    public static Dictionary<string, string> Unzip(string zip, string dir, Func<string, bool> keep)
    {
        if (!Path.IsPathFullyQualified(zip) || !File.Exists(zip))
            throw XifRefusal.Single(XifCodes.PackageInvalid, $"The archive '{zip}' is not an existing absolute file.", "Pass the outFile the bridge wrote.");
        var found = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        long total = 0;
        try
        {
            using var archive = ZipFile.OpenRead(zip);
            foreach (var entry in archive.Entries.Where(e => e.Name.Length > 0))
            {
                var parts = entry.FullName.Split('/', '\\');
                if (parts.Any(p => p is "" or "." or ".." || p.Contains(':')) || Path.IsPathRooted(entry.FullName))
                    throw XifRefusal.Single(XifCodes.PackageInvalid, $"The archive has an unsafe entry '{entry.FullName}'.", "Generate it again; nothing was sent.");
                if (!keep(entry.Name)) continue;
                total += entry.Length;
                if (total > ZipLimit) throw XifRefusal.Single(XifCodes.PackageInvalid, "The archive inflates to more than 256 MiB.", "Generate it again; nothing was sent.");
                var relative = string.Join("\\", parts);
                var target = Path.Combine(dir, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                entry.ExtractToFile(target, overwrite: false);
                found[relative] = target;
            }
        }
        catch (InvalidDataException error)
        {
            throw XifRefusal.Single(XifCodes.PackageInvalid, $"'{Path.GetFileName(zip)}' is not a zip archive ({error.Message}).", "Generate it again; nothing was sent.");
        }
        return found;
    }

    private static string Work(string work)
    {
        if (!Path.IsPathFullyQualified(work))
            throw XifRefusal.Single(XifCodes.SpecInvalid, $"The work folder '{work}' is not an absolute path.", "Pass --work with an absolute folder.");
        Directory.CreateDirectory(work);
        return Path.GetFullPath(work);
    }
}
