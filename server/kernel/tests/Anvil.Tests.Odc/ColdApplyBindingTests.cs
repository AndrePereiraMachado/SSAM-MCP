using System.Diagnostics;
using System.Text.Json.Nodes;
using Xunit;

namespace Anvil.Tests.Odc;

public sealed class ColdApplyBindingTests {
    [Fact]
    public void ContentIdentityApplyBindsTheStudioBeforeTheCacheInitializes() {
        var root=new DirectoryInfo(AppContext.BaseDirectory);
        while(root!=null&&!File.Exists(Path.Combine(root.FullName,"MANIFESTO.md")))root=root.Parent;
        Assert.NotNull(root);
        var outputDirectory=new DirectoryInfo(Path.GetDirectoryName(typeof(ColdApplyBindingTests).Assembly.Location)!);
        var tfm=outputDirectory.Name;
        var configuration=outputDirectory.Parent!.Name;
        var exe=Environment.GetEnvironmentVariable("GAP_CLI")??Path.Combine(root.FullName,"src","Anvil.Cli.Odc","bin",configuration,tfm,"anvil-odc.exe");
        Assert.True(File.Exists(exe),exe);
        var work=Path.Combine(Path.GetTempPath(),"cold-apply-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(work);
        var job=Path.Combine(work,"job.json");File.WriteAllText(job,"""{"ops":[{"op":"set","target":"@espace","prop":"Description","value":"Cold content identity"}]}""");
        var start=new ProcessStartInfo(exe){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
        foreach(var a in new[]{"apply","--base",Path.Combine(root.FullName,"tests","fixtures","odc","blank-mobile.oml"),"--job",job,"--out",Path.Combine(work,"candidate.oml"),"--work",work,"--base-content-sha256",new string('a',64),"--developer-id","cold-test"})start.ArgumentList.Add(a);
        start.Environment["ANVIL_WORKER"]="0";start.Environment["ANVIL_ODC_NO_WORKER"]="1";
        using var process=Process.Start(start)!;
        var output=process.StandardOutput.ReadToEndAsync();var errors=process.StandardError.ReadToEndAsync();
        var exited=process.WaitForExit(90000);
        if(!exited) { if(!process.HasExited) process.Kill(entireProcessTree:true); Assert.True(process.WaitForExit(10000),"The owned CLI did not exit after termination"); }
        File.WriteAllText(Path.Combine(work,"stdout.json"),output.Result);File.WriteAllText(Path.Combine(work,"stderr.txt"),errors.Result);
        Assert.True(exited,"Cold apply timed out; the owned CLI process was stopped. Evidence: "+work);
        Assert.True(process.ExitCode==0,exe+"\n"+output.Result+"\n"+errors.Result);
        Assert.True(JsonNode.Parse(output.Result)!["ok"]!.GetValue<bool>());
        Assert.True(File.Exists(Path.Combine(work,"candidate.oml")));
    }
}
