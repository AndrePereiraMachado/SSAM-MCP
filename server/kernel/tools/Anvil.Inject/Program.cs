// Anvil.Inject: liga o bridge ao Service Studio por IL (Mono.Cecil).
//   inject   --studio <dir> --bridge <Anvil.Bridge.dll> --port 4516   -> ServiceStudio.WebViewImplementation.dll:
//            App.OnFrameworkInitializationCompleted comeca com `ldc.i4 <port>; call Anvil.Bridge.Server::Start(int32)`
//            (qualquer prologo anterior do mesmo formato, de qualquer bridge, e removido antes)
//   cdp      --studio <dir> --cdp-port 9226                            -> WebViewControl.Avalonia.dll:
//            GetRemoteDebuggingPort devolve a porta dada
// Guarda <dll>.pristine.bak na primeira vez. Nunca roda com o Studio aberto (arquivo bloqueado).
using Mono.Cecil;
using Mono.Cecil.Cil;

static string Arg(string[] a, string name, string? def = null)
{
    var i = Array.IndexOf(a, name);
    return i >= 0 && i + 1 < a.Length ? a[i + 1] : def ?? throw new ArgumentException($"missing {name}");
}

static void Backup(string path)
{
    var bak = path + ".pristine.bak";
    if (!File.Exists(bak)) File.Copy(path, bak);
}

static void WriteInPlace(AssemblyDefinition asm, string path)
{
    var tmp = path + ".tmp";
    asm.Write(tmp);
    asm.Dispose();
    File.Copy(tmp, path, overwrite: true);
    File.Delete(tmp);
}

static ReaderParameters Reader(string studioDir)
{
    var resolver = new DefaultAssemblyResolver();
    resolver.AddSearchDirectory(studioDir);
    return new ReaderParameters { AssemblyResolver = resolver, ReadWrite = false, InMemory = true };
}

if (args.Length == 0) { Console.Error.WriteLine("usage: inject|cdp ..."); return 2; }
var studio = Arg(args, "--studio");
switch (args[0])
{
    case "inject":
    {
        var bridgePath = Arg(args, "--bridge");
        var port = int.Parse(Arg(args, "--port", "4516"));
        var typeName = Arg(args, "--type", "Anvil.Bridge.Server");
        var methodName = Arg(args, "--method", "Start");
        var target = Path.Combine(studio, "ServiceStudio.WebViewImplementation.dll");
        Backup(target);
        using var bridge = AssemblyDefinition.ReadAssembly(bridgePath, Reader(studio));
        var startDef = bridge.MainModule.GetType(typeName)?.Methods.FirstOrDefault(m => m.Name == methodName && m.Parameters.Count == 1)
                       ?? throw new InvalidOperationException($"{typeName}::{methodName}(int) not found in {bridgePath}");
        var asm = AssemblyDefinition.ReadAssembly(target, Reader(studio));
        var app = asm.MainModule.GetType("ServiceStudio.WebViewImplementation.App") ?? throw new InvalidOperationException("App type not found");
        var method = app.Methods.FirstOrDefault(m => m.Name == "OnFrameworkInitializationCompleted") ?? throw new InvalidOperationException("OnFrameworkInitializationCompleted not found");
        var il = method.Body.GetILProcessor();
        var body = method.Body.Instructions;
        // remove qualquer prologo anterior: (ldc.i4*) + call <algo>::Start*(int32)
        var removed = 0;
        while (body.Count >= 2 && body[1].OpCode == OpCodes.Call && body[1].Operand is MethodReference mr && mr.Name.StartsWith("Start") && mr.Parameters.Count == 1)
        {
            il.Remove(body[0]); il.Remove(body[0]); removed++;
        }
        var first = body[0];
        var startRef = asm.MainModule.ImportReference(startDef);
        il.InsertBefore(first, il.Create(OpCodes.Ldc_I4, port));
        il.InsertBefore(first, il.Create(OpCodes.Call, startRef));
        WriteInPlace(asm, target);
        Console.WriteLine($"injected {typeName}::{methodName}({port}) into {Path.GetFileName(target)} (removed {removed} previous prologue(s))");
        return 0;
    }
    case "cdp":
    {
        var cdp = int.Parse(Arg(args, "--cdp-port", "9226"));
        var target = Path.Combine(studio, "WebViewControl.Avalonia.dll");
        Backup(target);
        var asm = AssemblyDefinition.ReadAssembly(target, Reader(studio));
        var m = asm.MainModule.Types.SelectMany(t => t.Methods).FirstOrDefault(x => x.Name == "GetRemoteDebuggingPort")
                ?? throw new InvalidOperationException("GetRemoteDebuggingPort not found");
        var il = m.Body.GetILProcessor();
        m.Body.Instructions.Clear();
        il.Append(il.Create(OpCodes.Ldc_I4, cdp));
        il.Append(il.Create(OpCodes.Ret));
        WriteInPlace(asm, target);
        Console.WriteLine($"GetRemoteDebuggingPort -> {cdp} in {Path.GetFileName(target)}");
        return 0;
    }
    default:
        Console.Error.WriteLine("unknown command " + args[0]);
        return 2;
}
