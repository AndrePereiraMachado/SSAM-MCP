using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using Microsoft.CodeAnalysis.Text;

namespace Anvil.Xif;

/// <summary>One source file of the extension: its path inside the extension (Source\NET\...) and its text.</summary>
public sealed record XifCompileSource(string Path, string Text, IReadOnlyDictionary<string, (int First, int Last)>? ActionLines = null);

public sealed record XifCompileInput(string ExtensionName, IReadOnlyList<XifCompileSource> Sources, IReadOnlyList<string> PlatformReferences,
    IReadOnlyList<string> AuthorReferences, string? ReferenceAssembliesDirectory = null);

public sealed record XifCompileOutput(string AssemblyName, byte[] Dll, string Sha256, IReadOnlyList<JsonObject> Warnings);

/// <summary>
/// The extension DLL (OutSystems.Nss&lt;Name&gt;.dll) compiled by Roslyn for .NET Framework 4.7.2 with C# 7.3, the
/// language of the Integration Studio project. Deterministic: the same sources and references give the same bytes
/// (fixed paths, sorted inputs, no PDB, Deterministic=true). The references are the net472 reference assemblies shipped with
/// the kernel (ref/net472), the platform DLLs of GetSourceCodeDependencies and the author's DLLs of the spec. An author DLL
/// with the name of a platform DLL would replace the platform's at run time: XIF_DEPENDENCY_OVERRIDE, before compiling.
/// </summary>
public static class XifCompiler
{
    /// <summary>ref/net472 next to this assembly (not AppContext.BaseDirectory: the CLI and the tests bind the Studio folder
    /// as the application base).</summary>
    public static string DefaultReferenceAssemblies => System.IO.Path.Combine(Home, "ref", "net472");
    public static string Home => System.IO.Path.GetDirectoryName(typeof(XifCompiler).Assembly.Location) ?? AppContext.BaseDirectory;
    private static readonly ConcurrentDictionary<string, IReadOnlySet<string>> Names = new(StringComparer.OrdinalIgnoreCase);

    public static string AssemblyName(string extension) => "OutSystems.Nss" + extension;

    /// <summary>The assembly names of the .NET Framework 4.7.2 reference set (for the closure check of author DLLs).</summary>
    public static IReadOnlySet<string> FrameworkAssemblyNames() => FrameworkAssemblyNames(DefaultReferenceAssemblies);

    public static IReadOnlySet<string> FrameworkAssemblyNames(string directory) => Names.GetOrAdd(directory, d =>
        ReferenceFiles(d).Select(f => System.IO.Path.GetFileNameWithoutExtension(f)).ToHashSet(StringComparer.OrdinalIgnoreCase));

    private static readonly ConcurrentDictionary<string, IReadOnlyList<string>> Files = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The managed assemblies of a reference folder (the pack also carries native helper DLLs without metadata).</summary>
    public static IReadOnlyList<string> ReferenceFiles(string directory) => Files.GetOrAdd(directory, d =>
        Directory.Exists(d) ? Directory.EnumerateFiles(d, "*.dll", SearchOption.AllDirectories).Where(Managed).OrderBy(f => f, StringComparer.OrdinalIgnoreCase).ToList() : []);

    private static bool Managed(string file)
    {
        try
        {
            using var stream = File.OpenRead(file);
            using var pe = new System.Reflection.PortableExecutable.PEReader(stream);
            return pe.HasMetadata && System.Reflection.Metadata.PEReaderExtensions.GetMetadataReader(pe).IsAssembly;
        }
        catch (Exception error) when (error is BadImageFormatException or IOException) { return false; }
    }

    public static XifCompileOutput Compile(XifCompileInput input)
    {
        var refs = input.ReferenceAssembliesDirectory ?? DefaultReferenceAssemblies;
        if (!File.Exists(System.IO.Path.Combine(refs, "mscorlib.dll")))
            throw XifRefusal.Single(XifCodes.CompileFailed, $"The .NET Framework 4.7.2 reference assemblies are missing at {refs}.",
                "Rebuild the kernel (scripts\\setup-dev.ps1): Anvil.Xif copies them to ref\\net472.");
        var platform = input.PlatformReferences.ToDictionary(p => System.IO.Path.GetFileName(p), p => p, StringComparer.OrdinalIgnoreCase);
        var overrides = new List<XifProblem>();
        foreach (var author in input.AuthorReferences)
        {
            var file = System.IO.Path.GetFileName(author);
            var platformName = platform.ContainsKey(file);
            if (platformName || file.StartsWith("OutSystems.", StringComparison.OrdinalIgnoreCase))
                overrides.Add(new XifProblem(XifCodes.DependencyOverride, "references", $"{file} has the name of a platform DLL; deployed with the extension it would replace the platform's own.",
                    $"Remove {file} from references; the platform provides it (reference the platform's types directly).", SsamRule: !platformName));
        }
        if (overrides.Count > 0)
            throw new XifRefusal(XifCodes.DependencyOverride, $"{overrides.Count} author DLL(s) would override platform DLLs; nothing was compiled or sent.", overrides);

        var parse = new CSharpParseOptions(LanguageVersion.CSharp7_3, DocumentationMode.None);
        var trees = input.Sources.OrderBy(s => Normalize(s.Path), StringComparer.Ordinal)
            .Select(s => CSharpSyntaxTree.ParseText(SourceText.From(s.Text, System.Text.Encoding.UTF8), parse, Normalize(s.Path))).ToList();
        var references = ReferenceFiles(refs)
            .Where(f => !platform.ContainsKey(System.IO.Path.GetFileName(f)))
            .Concat(platform.Values).Concat(input.AuthorReferences)
            .GroupBy(f => System.IO.Path.GetFileNameWithoutExtension(f), StringComparer.OrdinalIgnoreCase)
            .Select(g => g.Last()).OrderBy(f => System.IO.Path.GetFileName(f), StringComparer.OrdinalIgnoreCase)
            .Select(f => MetadataReference.CreateFromFile(f)).ToList();
        var options = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: OptimizationLevel.Release,
            deterministic: true, platform: Platform.AnyCpu, warningLevel: 4, allowUnsafe: false, concurrentBuild: false,
            assemblyIdentityComparer: DesktopAssemblyIdentityComparer.Default);
        var name = AssemblyName(input.ExtensionName);
        var compilation = CSharpCompilation.Create(name, trees, references, options);
        using var dll = new MemoryStream();
        var emitted = compilation.Emit(dll, options: new EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb, includePrivateMembers: true));
        var lines = input.Sources.ToDictionary(s => Normalize(s.Path), s => s.ActionLines, StringComparer.Ordinal);
        var errors = emitted.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Select(d => Problem(d, lines)).ToList();
        if (!emitted.Success || errors.Count > 0)
            throw new XifRefusal(XifCodes.CompileFailed, $"The extension does not compile ({errors.Count} error(s)); nothing was sent.",
                errors.Count > 0 ? errors : [new XifProblem(XifCodes.CompileFailed, null, "The compiler emitted nothing.", "Check the sources.")]);
        var bytes = dll.ToArray();
        var warnings = emitted.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Warning).Take(40).Select(d => Problem(d, lines).ToJson()).ToList();
        return new XifCompileOutput(name, bytes, XifPackage.Sha256(bytes), warnings);
    }

    private static XifProblem Problem(Diagnostic d, IReadOnlyDictionary<string, IReadOnlyDictionary<string, (int First, int Last)>?> lines)
    {
        var span = d.Location.GetLineSpan();
        var file = span.Path;
        var line = span.StartLinePosition.Line + 1;
        var col = span.StartLinePosition.Character + 1;
        string? action = null;
        if (file != null && lines.TryGetValue(file, out var ranges) && ranges != null)
            action = ranges.FirstOrDefault(r => line >= r.Value.First && line <= r.Value.Last).Key;
        var detail = new JsonObject { ["file"] = file, ["line"] = line, ["col"] = col, ["diagnostic"] = d.Id };
        if (action != null) detail["action"] = action;
        return new XifProblem(d.Severity == DiagnosticSeverity.Error ? XifCodes.CompileFailed : "XIF_COMPILE_WARNING", action != null ? "actions." + action + ".body" : file,
            $"{d.Id}: {d.GetMessage(System.Globalization.CultureInfo.InvariantCulture)}",
            action != null ? $"Fix the body of {action} at line {line - (lines[file!]![action].First)} of the body." : $"Fix {file} at line {line}.", Detail: detail);
    }

    private static string Normalize(string path) => string.Join("/", path.Split('/', '\\').Where(s => s.Length > 0));
}
