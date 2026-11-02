using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using ServiceStudio.Model;
using ServiceStudio.Presenter.Commands;
using ServiceStudio.Undo;
using Xunit;

namespace Anvil.Tests.Odc;

public sealed class OdcPreferGapTests {
    public OdcPreferGapTests() => StudioAssembliesOdc.Bind();
    internal static void RecordBaseBehavior(ModelHost host,string scenario,string basis,string person,string candidate,string work) {
        var dll=Environment.GetEnvironmentVariable("GAP_BASE_DLL");
        if(string.IsNullOrEmpty(dll)) return;
        var local=host.Load(person);
        typeof(ESpace).GetMethod("PrepareForSave",BindingFlags.Instance|BindingFlags.Public|BindingFlags.NonPublic,Type.EmptyTypes)?.Invoke(local,null);
        var presenter=new MockAggregatorPresenter(local,null,false,null,null,false);
        try {
            var manifest=new {module=local.Name,moduleKey=local.Key.ToString(),tenant="headless.invalid",author="headless",basePath=basis,baseSha256=Manifest.Hash(File.ReadAllBytes(basis)),baseCapturedAt=DateTimeOffset.UtcNow,candidatePath=candidate,candidateSha256=Manifest.Hash(File.ReadAllBytes(candidate)),evidenceDir=Path.Combine(work,"v107-evidence"),owners=new[]{"PreferA"},preferForeign=true};
            var result=(string)Assembly.LoadFrom(dll).GetType("GapEntry")!.GetMethod("Run")!.Invoke(null,new object[]{JsonSerializer.Serialize(manifest),presenter})!;
            var receipt=JsonNode.Parse(result)!;
            Assert.Contains("differs from the captured base",receipt["error"]!.GetValue<string>());
            Assert.False(receipt["handedOff"]!.GetValue<bool>());
            Assert.Equal(0,UndoManager.GetUndoCount(presenter));
            var expectsDelivery=scenario is not ("rollback" or "unknown" or "unresolved" or "second-pass-conflict");
            var failed=expectsDelivery ? Record.Exception(()=>Assert.True(receipt["ok"]!.GetValue<bool>(),"The delivery must land in one call.")) : null;
            if(expectsDelivery) Assert.NotNull(failed);
            var report=new {scenario,studio=StudioAssembliesOdc.Directory,baseReceipt=receipt,behavioralAssertion=failed?.Message,
                baseRed=expectsDelivery, safetyRefusalPassed=!expectsDelivery,
                scope="Run with authentication/provider and dispatcher-thread entry checks bypassed. Refusal scenarios prove no handoff and zero Undo only; the native fault injection and post-merge corruption are not reached on v107.",work};
            var file=Environment.GetEnvironmentVariable("GAP_MATRIX")!;
            File.AppendAllText(file,JsonSerializer.Serialize(report)+"\n");
        } finally {UndoManager.ClearHistory(presenter);(presenter as IDisposable)?.Dispose();ModelHost.Release(local);}
    }
}
