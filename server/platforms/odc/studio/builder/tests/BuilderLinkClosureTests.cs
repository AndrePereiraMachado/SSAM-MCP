using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Xunit;

namespace Builder.Tests;

/// <summary>
/// The kernel sources the ODC builder links (Builder.csproj, Compile Include ... Link="shared\...") are a closure: every kernel
/// type they name is declared in a file the builder compiles too. A kernel source that starts using another kernel type
/// (FlowParse.cs naming MessageExpectations at the 24.1 junction) breaks only the builder, which the CLI and the kernel tests
/// never compile; this test says which file and which type, without building the builder.
/// The kernel is what Anvil.Core.Odc compiles (Kernel, Delivery, Hosting, Adapters.ODC). A use is counted where it can only be
/// a type or a namespace: `Anvil.Core.X`, `X.Member`, `new X`, `typeof(X)`; comments and string literals do not count, and a
/// name the compiled sources also use as a member (`x.Keys`) is left to the build. A cheap guard, not a compiler: what it
/// misses the builder build still says (dotnet build platforms\odc\studio\builder\Builder.csproj).
/// </summary>
public sealed class BuilderLinkClosureTests
{
    private static readonly Regex Namespace = new(@"^\s*namespace\s+([\w.]+)", RegexOptions.Multiline | RegexOptions.CultureInvariant);
    private static readonly Regex TopLevelType = new(@"^(?:(?:public|internal|static|sealed|abstract|partial|readonly|file|unsafe|ref)\s+)*(?:class|struct|interface|enum|record(?:\s+(?:class|struct))?)\s+([A-Za-z_]\w*)", RegexOptions.Multiline | RegexOptions.CultureInvariant);
    private static readonly Regex AnyType = new(@"^\s*(?:(?:public|internal|private|protected|static|sealed|abstract|partial|readonly|file|unsafe|ref|new)\s+)*(?:class|struct|interface|enum|record(?:\s+(?:class|struct))?)\s+([A-Za-z_]\w*)", RegexOptions.Multiline | RegexOptions.CultureInvariant);
    private static readonly Regex UsingKernel = new(@"^\s*using\s+(Anvil\.Core(?:\.[\w.]+)?)\s*;", RegexOptions.Multiline | RegexOptions.CultureInvariant);
    private static readonly Regex Qualified = new(@"\bAnvil\.Core\.([A-Za-z_]\w*)", RegexOptions.CultureInvariant);
    private static readonly Regex TypeUse = new(@"(?<![\w.@])([A-Z]\w*)(?=\s*\.\s*[A-Za-z_])|\bnew\s+([A-Z]\w*)|\btypeof\s*\(\s*([A-Z]\w*)", RegexOptions.CultureInvariant);
    private static readonly Regex MemberUse = new(@"(?<!\bAnvil\.Core)\.\s*([A-Z]\w*)", RegexOptions.CultureInvariant);

    [Fact]
    public void Every_kernel_type_a_linked_source_names_is_compiled_by_the_builder()
    {
        var kernel = StudioRuntime.KernelRoot;
        var repo = Path.GetDirectoryName(kernel)!;
        var compiled = CompileItems(Path.Combine(repo, "platforms", "odc", "studio", "builder", "Builder.csproj"));
        Assert.Contains(compiled, f => f.EndsWith("FlowParse.cs", StringComparison.Ordinal));

        var texts = compiled.ToDictionary(f => f, File.ReadAllText);
        var codes = texts.ToDictionary(p => p.Key, p => CodeOnly(p.Value));
        var declaredHere = texts.Values.SelectMany(t => AnyType.Matches(t)).Select(m => m.Groups[1].Value).ToHashSet(StringComparer.Ordinal);
        var namespacesHere = texts.Values.SelectMany(t => Namespace.Matches(t)).Select(m => m.Groups[1].Value).ToHashSet(StringComparer.Ordinal);
        var members = codes.Values.SelectMany(c => MemberUse.Matches(c)).Select(m => m.Groups[1].Value).ToHashSet(StringComparer.Ordinal);

        // The kernel's top-level types per namespace, and its namespaces under Anvil.Core (Preflight, Delivery, ...).
        var core = Path.Combine(kernel, "src", "Anvil.Core");
        var kernelFiles = new[] { Path.Combine(core, "Kernel"), Path.Combine(core, "Delivery"), Path.Combine(core, "Hosting"), Path.Combine(kernel, "src", "Anvil.Core.Odc", "Adapters.ODC") }
            .Where(Directory.Exists).SelectMany(d => Directory.EnumerateFiles(d, "*.cs", SearchOption.AllDirectories));
        var types = new Dictionary<(string Namespace, string Type), string>();
        var subNamespaces = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var file in kernelFiles)
        {
            var text = File.ReadAllText(file);
            var ns = Namespace.Match(text) is { Success: true } n ? n.Groups[1].Value : "";
            if (ns.StartsWith("Anvil.Core.", StringComparison.Ordinal)) subNamespaces.TryAdd(ns["Anvil.Core.".Length..].Split('.')[0], Path.GetRelativePath(kernel, file));
            foreach (Match m in TopLevelType.Matches(text)) types.TryAdd((ns, m.Groups[1].Value), Path.GetRelativePath(kernel, file));
        }
        bool NamespaceHere(string sub) => namespacesHere.Any(n => n == "Anvil.Core." + sub || n.StartsWith("Anvil.Core." + sub + ".", StringComparison.Ordinal));

        var problems = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var (file, code) in codes)
        {
            var where = Path.GetRelativePath(repo, file);
            var visible = UsingKernel.Matches(texts[file]).Select(m => m.Groups[1].Value).Append("Anvil.Core").ToHashSet(StringComparer.Ordinal);
            string? Missing(string name, bool qualified)
            {
                if (subNamespaces.TryGetValue(name, out var nsFile) && !NamespaceHere(name))
                    return $"{where} names the namespace Anvil.Core.{name} (kernel/{nsFile}), of which Builder.csproj links no file";
                if (declaredHere.Contains(name) || (!qualified && members.Contains(name))) return null;
                foreach (var ns in qualified ? new[] { "Anvil.Core" } : visible.ToArray())
                    if (types.TryGetValue((ns, name), out var typeFile))
                        return $"{where} names {name}, declared in kernel/{typeFile}, which Builder.csproj does not link";
                return null;
            }
            foreach (Match m in Qualified.Matches(code)) if (Missing(m.Groups[1].Value, true) is { } p) problems.Add(p);
            foreach (Match m in TypeUse.Matches(code))
            {
                var name = m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value;
                if (Missing(name, false) is { } p) problems.Add(p);
            }
        }
        Assert.True(problems.Count == 0,
            "the ODC builder would not compile: link the file in platforms/odc/studio/builder/Builder.csproj, or keep the shared source free of that type\n" + string.Join("\n", problems));
    }

    /// <summary>The files Builder.csproj compiles (wildcards expanded), full paths.</summary>
    private static List<string> CompileItems(string csproj)
    {
        var dir = Path.GetDirectoryName(csproj)!;
        var result = new List<string>();
        foreach (var include in XDocument.Load(csproj).Descendants().Where(e => e.Name.LocalName == "Compile").Select(e => (string?)e.Attribute("Include")).OfType<string>())
        {
            var path = Path.GetFullPath(Path.Combine(dir, include.Replace('\\', Path.DirectorySeparatorChar).Replace('/', Path.DirectorySeparatorChar)));
            var name = Path.GetFileName(path);
            if (name.Contains('*')) { var folder = Path.GetDirectoryName(path)!; if (Directory.Exists(folder)) result.AddRange(Directory.GetFiles(folder, name)); }
            else { Assert.True(File.Exists(path), "Builder.csproj compiles a file that does not exist: " + include); result.Add(path); }
        }
        return result;
    }

    /// <summary>The source without comments and string or char literals (interpolation holes stay: they are code).</summary>
    internal static string CodeOnly(string s)
    {
        var sb = new StringBuilder(s.Length);
        var i = 0;
        Code(s, ref i, sb, hole: false);
        return sb.ToString();
    }

    private static void Code(string s, ref int i, StringBuilder sb, bool hole)
    {
        var depth = 0;
        while (i < s.Length)
        {
            var c = s[i];
            if (c == '/' && i + 1 < s.Length && s[i + 1] == '/') { while (i < s.Length && s[i] != '\n') i++; continue; }
            if (c == '/' && i + 1 < s.Length && s[i + 1] == '*') { var end = s.IndexOf("*/", i + 2, StringComparison.Ordinal); i = end < 0 ? s.Length : end + 2; sb.Append(' '); continue; }
            if (c == '\'') { i++; while (i < s.Length && s[i] != '\'' && s[i] != '\n') { if (s[i] == '\\') i++; i++; } i++; sb.Append(" '' "); continue; }
            if (c == '"' || ((c == '$' || c == '@') && StringStart(s, i))) { Literal(s, ref i, sb); continue; }
            if (hole)
            {
                if (c == '{') depth++;
                else if (c == '}') { if (depth == 0) { i++; return; } depth--; }
            }
            sb.Append(c);
            i++;
        }
    }

    private static bool StringStart(string s, int i)
    {
        while (i < s.Length && (s[i] == '$' || s[i] == '@')) i++;
        return i < s.Length && s[i] == '"';
    }

    private static void Literal(string s, ref int i, StringBuilder sb)
    {
        bool interpolated = false, verbatim = false;
        while (s[i] == '$' || s[i] == '@') { if (s[i] == '$') interpolated = true; else verbatim = true; i++; }
        var quotes = 0;
        while (i + quotes < s.Length && s[i + quotes] == '"') quotes++;
        if (quotes >= 3)
        {
            var end = s.IndexOf(new string('"', quotes), i + quotes, StringComparison.Ordinal);
            i = end < 0 ? s.Length : end + quotes;
            sb.Append(" \"\" ");
            return;
        }
        i++;
        while (i < s.Length)
        {
            var c = s[i];
            if (verbatim) { if (c == '"') { if (i + 1 < s.Length && s[i + 1] == '"') { i += 2; continue; } i++; break; } }
            else { if (c == '\\') { i += 2; continue; } if (c == '"') { i++; break; } if (c == '\n') break; }
            if (interpolated && c == '{')
            {
                if (i + 1 < s.Length && s[i + 1] == '{') { i += 2; continue; }
                i++;
                sb.Append(' ');
                Code(s, ref i, sb, hole: true);
                sb.Append(' ');
                continue;
            }
            i++;
        }
        sb.Append(" \"\" ");
    }
}
