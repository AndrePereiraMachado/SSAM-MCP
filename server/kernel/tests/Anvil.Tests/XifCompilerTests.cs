using Anvil.Core;
using Anvil.Xif;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Anvil.Tests;

/// <summary>XifCompiler: the synthetic stubs plus a fake platform assembly made here compile for .NET Framework 4.7.2 (C# 7.3)
/// to the same bytes twice; an undefined name is XIF_COMPILE_FAILED with CS0103 on the action; an author DLL named like a
/// platform DLL is XIF_DEPENDENCY_OVERRIDE before anything compiles. No OutSystems DLL is involved.</summary>
public sealed class XifCompilerTests
{
    public static readonly string Kernel = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(XifCompilerTests).Assembly.Location)!)!;
    public static string Fixtures => Path.Combine(Kernel, "tests", "fixtures", "xif");
    public static string ReferenceAssemblies => XifCompiler.DefaultReferenceAssemblies;

    /// <summary>A net472 library compiled from source here (the fake platform DLL, synthetic author DLLs).</summary>
    public static string CompileLibrary(string dir, string name, string source, params string[] references)
    {
        var refs = XifCompiler.ReferenceFiles(ReferenceAssemblies).Concat(references).Select(f => MetadataReference.CreateFromFile(f));
        var compilation = CSharpCompilation.Create(name, [CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.CSharp7_3), name + ".cs")], refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, deterministic: true, assemblyIdentityComparer: DesktopAssemblyIdentityComparer.Default));
        var file = Path.Combine(dir, name + ".dll");
        var result = compilation.Emit(file);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics));
        return file;
    }

    private static (string Dir, string Platform) Setup()
    {
        var dir = Path.Combine(Path.GetTempPath(), "anvil-xif-cc-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var platform = CompileLibrary(dir, "OutSystems.HubEdition.RuntimePlatform", File.ReadAllText(Path.Combine(Fixtures, "fake-platform", "OutSystems.HubEdition.RuntimePlatform.cs")));
        return (dir, platform);
    }

    private static List<XifCompileSource> Stubs(string main) =>
    [
        new("Source\\NET\\Interface.cs", File.ReadAllText(Path.Combine(Fixtures, "stubs", "Interface.cs"))),
        new("Source\\NET\\ZZHybridXifLab.cs", main),
    ];

    [Fact]
    public void TheSameSourcesCompileToTheSameBytesTwice()
    {
        Assert.True(File.Exists(Path.Combine(ReferenceAssemblies, "mscorlib.dll")), "Anvil.Xif copies the net472 reference assemblies to ref/net472: " + ReferenceAssemblies);
        var (dir, platform) = Setup();
        try
        {
            var merged = XifSourceMerge.Merge("ZZHybridXifLab", File.ReadAllText(Path.Combine(Fixtures, "stubs", "ZZHybridXifLab.cs")), null,
                [new XifActionBody("Add", "Result = checked(FakeRuntime.Twice(Left) / 2 + Right);")]);
            var input = new XifCompileInput("ZZHybridXifLab", Stubs(merged.Source), [platform], []);
            var first = XifCompiler.Compile(input);
            var second = XifCompiler.Compile(input with { Sources = Stubs(merged.Source).AsEnumerable().Reverse().ToList() });
            Assert.Equal("OutSystems.NssZZHybridXifLab", first.AssemblyName);
            Assert.Equal(first.Sha256, second.Sha256);
            Assert.Equal(first.Dll, second.Dll);
            // A .NET Framework assembly: it references mscorlib, not System.Runtime, and the fake platform DLL.
            using var pe = new System.Reflection.PortableExecutable.PEReader(new MemoryStream(first.Dll));
            var reader = System.Reflection.Metadata.PEReaderExtensions.GetMetadataReader(pe);
            var references = reader.AssemblyReferences.Select(h => reader.GetString(reader.GetAssemblyReference(h).Name)).ToList();
            Assert.Contains("mscorlib", references);
            Assert.Contains("OutSystems.HubEdition.RuntimePlatform", references);
            Assert.DoesNotContain("System.Runtime", references);
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public void AnUndefinedNameIsACompileFailureOnTheAction()
    {
        var (dir, platform) = Setup();
        try
        {
            var merged = XifSourceMerge.Merge("ZZHybridXifLab", File.ReadAllText(Path.Combine(Fixtures, "stubs", "ZZHybridXifLab.cs")), null,
                [new XifActionBody("Add", "var sum = Left + Right;\nResult = sum + Missing;")]);
            var refusal = Assert.Throws<XifRefusal>(() => XifCompiler.Compile(new XifCompileInput("ZZHybridXifLab",
                [new("Source\\NET\\Interface.cs", File.ReadAllText(Path.Combine(Fixtures, "stubs", "Interface.cs"))), new("Source\\NET\\ZZHybridXifLab.cs", merged.Source, merged.BodyLines)],
                [platform], [])));
            Assert.Equal(XifCodes.CompileFailed, refusal.Code);
            var problem = Assert.Single(refusal.Problems);
            Assert.Equal(XifCodes.CompileFailed, problem.Code);
            Assert.StartsWith("CS0103", problem.Message);
            Assert.Contains("Missing", problem.Message);
            Assert.Equal("CS0103", problem.Detail!["diagnostic"]!.ToString());
            Assert.Equal("Source/NET/ZZHybridXifLab.cs", problem.Detail["file"]!.ToString());
            Assert.Equal("Add", problem.Detail["action"]!.ToString());
            Assert.True(problem.Detail["line"]!.GetValue<int>() > 0 && problem.Detail["col"]!.GetValue<int>() > 0);
            Assert.Contains("line 2 of the body", problem.Fix);
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public void AnAuthorDllNamedLikeAPlatformDllIsRefusedBeforeCompiling()
    {
        var (dir, platform) = Setup();
        try
        {
            var author = Path.Combine(dir, "author");
            Directory.CreateDirectory(author);
            var runtimeCommon = Path.Combine(author, "OutSystems.RuntimeCommon.dll");
            File.WriteAllBytes(runtimeCommon, [0x4D, 0x5A]);
            var shadow = Path.Combine(author, "OutSystems.HubEdition.RuntimePlatform.dll");
            File.WriteAllBytes(shadow, [0x4D, 0x5A]);
            var refusal = Assert.Throws<XifRefusal>(() => XifCompiler.Compile(new XifCompileInput("ZZHybridXifLab",
                Stubs(File.ReadAllText(Path.Combine(Fixtures, "stubs", "ZZHybridXifLab.cs"))), [platform], [runtimeCommon, shadow])));
            Assert.Equal(XifCodes.DependencyOverride, refusal.Code);
            Assert.Equal(2, refusal.Problems.Count);
            Assert.All(refusal.Problems, p => Assert.Equal(XifCodes.DependencyOverride, p.Code));
            Assert.Contains("OutSystems.RuntimeCommon.dll", refusal.Problems[0].Message);
            Assert.True(refusal.Problems[0].SsamRule);      // a platform name by convention
            Assert.False(refusal.Problems[1].SsamRule);     // exactly a platform DLL of this environment
        }
        finally { Directory.Delete(dir, true); }
    }
}
