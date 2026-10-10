using System.Runtime.CompilerServices;
using System.Runtime.Loader;

namespace Builder.Tests;

// The builder's Main resolves the ODC Studio assemblies from one folder (ANVIL_ODC_STUDIO_DIR, else the installation);
// the tests do the same before any test touches a Studio type.
internal static class StudioRuntime {
    public const string Installed = @"C:\Program Files\OutSystems\ODC Studio\ODC Studio";
    public static string Directory => Environment.GetEnvironmentVariable("ANVIL_ODC_STUDIO_DIR") is { Length: > 0 } configured ? configured : Installed;
    public static bool Available => File.Exists(Path.Combine(Directory, "OutSystems.ModelAPILoader.dll"));

    [ModuleInitializer]
    internal static void Resolve() {
        var studio = Directory;
        AssemblyLoadContext.Default.Resolving += (context, name) => {
            var path = Path.Combine(studio, name.Name + ".dll");
            return File.Exists(path) ? context.LoadFromAssemblyPath(path) : null;
        };
    }

    // The kernel folder (kernel/MANIFESTO.md), whose tests/fixtures/odc holds the ODC fixtures.
    public static string KernelRoot {
        get {
            for (var dir = Path.GetDirectoryName(typeof(StudioRuntime).Assembly.Location); dir != null; dir = Path.GetDirectoryName(dir)) {
                var kernel = Path.Combine(dir, "kernel");
                if (File.Exists(Path.Combine(kernel, "MANIFESTO.md"))) return kernel;
            }
            throw new DirectoryNotFoundException("kernel/MANIFESTO.md not found above the test assembly");
        }
    }
}
