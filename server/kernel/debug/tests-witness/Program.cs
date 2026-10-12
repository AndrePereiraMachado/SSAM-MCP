using System.Runtime.Loader;
// dotnet run -- "<Studio dir>": fakes for both lanes, then the installed SDK contract names of this build's lane.
static class WitnessProgram {
    static void Main(string[] args) {
        var dir = args.Length > 0 ? Path.GetFullPath(args[0]) : null;
        if (dir != null) AssemblyLoadContext.Default.Resolving += (c, n) => File.Exists(Path.Combine(dir, n.Name + ".dll")) ? c.LoadFromAssemblyPath(Path.Combine(dir, n.Name + ".dll")) : null;
        NativeWitnessBindingsTests.Run(dir);
    }
}