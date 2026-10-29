using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>R1 item 1 (2026-10-28): the reference lookups of the CLI (where-can, recipe, api by name, verify-message) found
/// the kernel by walking up from AppContext.BaseDirectory and fell back to the current directory. After StudioAssemblies.Bind
/// the base directory is the Studio's folder, and a hosted run's working directory is the customer's workspace, so they read
/// &lt;cwd&gt;/catalog and &lt;cwd&gt;/AGENTS.md ("Could not find a part of the path"). The kernel root has one resolver,
/// JobSources.KernelRoot (the folder of the Anvil.Core assembly first), and every reader of the kernel's own files uses it.</summary>
public sealed class KernelRootTests
{
    private static readonly string Kernel = PacoteBPolicyTests.FindRoot();

    [Fact]
    public void OnlyTheOneResolverWalksUpToTheManifestAndNoReaderStartsAtTheCurrentDirectory()
    {
        var src = Path.Combine(Kernel, "src");
        var sources = Directory.EnumerateFiles(src, "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Any(part => part is "bin" or "obj"))
            .ToDictionary(f => Path.GetRelativePath(src, f).Replace('\\', '/'), File.ReadAllText);
        // The walk up to MANIFESTO.md lives in JobRunner.RepoRoot alone; the CLI's own walk from AppContext.BaseDirectory is gone.
        Assert.Equal(["Anvil.Core/Kernel/JobRunner.cs"], sources.Where(s => s.Value.Contains("\"MANIFESTO.md\"", StringComparison.Ordinal)).Select(s => s.Key).Order(StringComparer.Ordinal));
        // A root taken from the current directory first ("RepoRoot(cwd) ?? ..."): the hosted cwd is the customer's workspace.
        var cwdFirst = new Regex(@"RepoRoot\((?:Environment\.CurrentDirectory|Directory\.GetCurrentDirectory\(\))\)\s*\?\?", RegexOptions.CultureInvariant);
        Assert.Empty(sources.Where(s => cwdFirst.IsMatch(s.Value)).Select(s => s.Key));
    }

    [Fact]
    public void TheReferenceLookupsFindTheKernelWithTheBaseDirectoryElsewhereAndAnyWorkingDirectory()
    {
        var scratch = Path.Combine(Path.GetTempPath(), "anvil-kernel-root-" + Guid.NewGuid().ToString("N"));
        var studio = Directory.CreateDirectory(Path.Combine(scratch, "studio")).FullName;   // as after StudioAssemblies.Bind
        var workspace = Directory.CreateDirectory(Path.Combine(scratch, "ws", "o11")).FullName;   // a hosted run's cwd
        // Even a working directory that resembles another kernel must not override the running assembly's root.
        File.WriteAllText(Path.Combine(workspace, "MANIFESTO.md"), "A different workspace");
        Directory.CreateDirectory(Path.Combine(workspace, "catalog"));
        var baseDirectory = AppContext.GetData("APP_CONTEXT_BASE_DIRECTORY");
        var cwd = Directory.GetCurrentDirectory();
        try
        {
            AppContext.SetData("APP_CONTEXT_BASE_DIRECTORY", studio + Path.DirectorySeparatorChar);
            Directory.SetCurrentDirectory(workspace);
            Assert.Equal(studio + Path.DirectorySeparatorChar, AppContext.BaseDirectory);
            var root = JobSources.KernelRoot();
            Assert.Equal(Path.GetFullPath(Kernel), Path.GetFullPath(root!));
            // where-can, api by name, recipe and verify-message read the kernel's own files from it.
            var catalog = Directory.GetFiles(Path.Combine(root!, "catalog"), "model-api-*.json").OrderByDescending(f => f).First();
            var placed = JsonSerializer.SerializeToNode(CommandSurface.WhereCan(root!, catalog, "IServerAction"))!;
            Assert.NotEmpty(placed["possibleParents"]!.AsArray());
            Assert.NotEmpty(JsonSerializer.SerializeToNode(CommandSurface.Recipes(root!, "timer"))!.AsArray());
            Assert.NotEmpty(VerifyHints.Read(root));
            Assert.NotEmpty(VerifyHints.Read());
        }
        finally
        {
            Directory.SetCurrentDirectory(cwd);
            AppContext.SetData("APP_CONTEXT_BASE_DIRECTORY", baseDirectory);
            try { Directory.Delete(scratch, true); } catch (IOException) { }
        }
    }
}
