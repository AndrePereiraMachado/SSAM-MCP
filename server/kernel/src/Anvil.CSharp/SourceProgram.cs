using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Anvil.CSharp;

public sealed record SourceDiagnostic(string Code, string Message, string File, int Line, int Column)
{
    public override string ToString() => $"{File}({Line},{Column}): {Code}: {Message}";
    internal static SourceDiagnostic At(string code, string message, Location? location)
    {
        var span = location?.GetLineSpan() ?? default;
        return new(code, message, span.Path ?? "source.cs", span.StartLinePosition.Line + 1, span.StartLinePosition.Character + 1);
    }
}

public sealed class SourceCompilationException(IReadOnlyList<SourceDiagnostic> diagnostics)
    : ArgumentException(string.Join(Environment.NewLine, diagnostics))
{
    public IReadOnlyList<SourceDiagnostic> Diagnostics { get; } = diagnostics;
}

/// <summary>One semantic compilation is shared by data and logic. It never loads or executes authored assemblies.</summary>
public sealed class SourceProgram
{
    private static readonly Lazy<ImmutableArray<MetadataReference>> References = new(() =>
    {
        var platform = ((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? throw new InvalidOperationException("Platform references unavailable"))
            .Split(Path.PathSeparator).Append(typeof(Authoring.EntityAttribute).Assembly.Location);
        return platform.Distinct(StringComparer.OrdinalIgnoreCase).Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToImmutableArray();
    });
    public CSharpCompilation Compilation { get; }
    public IReadOnlyDictionary<string, string> Files { get; }
    public IReadOnlyList<INamedTypeSymbol> Types { get; }
    public string Hash { get; }
    private SourceProgram(IReadOnlyDictionary<string, string> files, CSharpCompilation compilation)
    {
        Files = files; Compilation = compilation;
        Types = compilation.SyntaxTrees.SelectMany(tree => tree.GetRoot().DescendantNodes().OfType<BaseTypeDeclarationSyntax>()
            .Select(node => compilation.GetSemanticModel(tree).GetDeclaredSymbol(node)).OfType<INamedTypeSymbol>())
            .Distinct<INamedTypeSymbol>(SymbolEqualityComparer.Default).OrderBy(t => t.ToDisplayString(), StringComparer.Ordinal).ToArray();
        Hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("\n", files.OrderBy(f => f.Key, StringComparer.Ordinal)
            .Select(f => f.Key + "\0" + f.Value))))).ToLowerInvariant();
    }
    public static SourceProgram Parse(IReadOnlyDictionary<string, string> files)
    {
        if (files.Count == 0) throw new ArgumentException("At least one C# source file is required");
        var source = files.ToDictionary(p => p.Key.Replace('\\', '/'), p => p.Value, StringComparer.Ordinal);
        foreach (var path in source.Keys)
            if (!path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) || Path.IsPathRooted(path) || path.Split('/').Any(s => s is ".." or "." or ""))
                throw new ArgumentException("Source paths must be relative C# file names: " + path);
        var options = new CSharpParseOptions(LanguageVersion.CSharp12);
        // Match the ordinary .NET SDK class-library environment without changing authored files.
        var imports = new[] { "System", "System.Collections.Generic", "System.IO", "System.Linq", "System.Net.Http", "System.Threading", "System.Threading.Tasks" };
        var implicitUsings = CSharpSyntaxTree.ParseText(string.Join("\n", imports.Select(name => "global using global::" + name + ";")), options, "/anvil/ImplicitUsings.g.cs");
        var trees = source.OrderBy(f => f.Key, StringComparer.Ordinal).Select(f => CSharpSyntaxTree.ParseText(f.Value, options, f.Key)).Append(implicitUsings);
        var compilation = CSharpCompilation.Create("AnvilAuthoredSource", trees, References.Value,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable, deterministic: true));
        var errors = compilation.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => SourceDiagnostic.At(d.Id, d.GetMessage(System.Globalization.CultureInfo.InvariantCulture), d.Location)).ToArray();
        if (errors.Length != 0) throw new SourceCompilationException(errors);
        return new(source, compilation);
    }
    internal SemanticModel Model(SyntaxNode syntax) => Compilation.GetSemanticModel(syntax.SyntaxTree);
    internal static void CollectDiagnostics<T>(IEnumerable<T> items, Action<T> analyze)
    {
        var diagnostics = new List<SourceDiagnostic>();
        foreach (var item in items)
        {
            try { analyze(item); }
            catch (SourceCompilationException error) { diagnostics.AddRange(error.Diagnostics); }
        }
        if (diagnostics.Count > 0) throw new SourceCompilationException(diagnostics.Distinct()
            .OrderBy(d => d.File, StringComparer.Ordinal).ThenBy(d => d.Line).ThenBy(d => d.Column).ThenBy(d => d.Code, StringComparer.Ordinal).ToArray());
    }
    internal static SourceCompilationException Error(string code, string message, ISymbol symbol)
        => new([SourceDiagnostic.At(code, message, symbol.Locations.FirstOrDefault(l => l.IsInSource))]);
    internal static SourceCompilationException Error(string code, string message, SyntaxNode node)
        => new([SourceDiagnostic.At(code, message, node.GetLocation())]);
    internal static AttributeData? Attribute(ISymbol symbol, string name)
        => symbol.GetAttributes().FirstOrDefault(a => a.AttributeClass?.ToDisplayString() == name);
    internal static string? TextAttribute(ISymbol symbol, string name)
        => Attribute(symbol, name)?.ConstructorArguments.FirstOrDefault().Value as string;
}
