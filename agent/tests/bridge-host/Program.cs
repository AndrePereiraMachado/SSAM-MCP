using System.Reflection;
using System.Runtime.Loader;

// Isolated test process, never injected into a Studio. Only bootstrap and stop
// are exercised; no model operation or developer session is initialized.
if (args.Length != 2) return 1;
var bridge = Path.GetFullPath(args[0]);
var dependencies = Path.GetFullPath(args[1]);
AssemblyLoadContext.Default.Resolving += (context, name) => {
    var file = Path.Combine(dependencies, name.Name + ".dll");
    return File.Exists(file) ? context.LoadFromAssemblyPath(file) : null;
};
var assembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(bridge);
assembly.GetType("StartupHook")!.GetMethod("Initialize", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, null);
Console.WriteLine("ready");
await Console.In.ReadLineAsync();
return 0;
