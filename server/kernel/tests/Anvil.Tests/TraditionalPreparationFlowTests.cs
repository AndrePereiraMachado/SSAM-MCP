using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Anvil.Reading;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

public class TraditionalPreparationFlowTests(ITestOutputHelper output)
{
    [Theory]
    [InlineData("Audit", false)]
    [InlineData("Other", true)]
    public void PreflightRecognizesPreparationOnlyUnderItsDeclaredOwner(string owner, bool missing)
    {
        var ops = new JsonArray(
            new JsonObject { ["op"]="html", ["data"]=new JsonObject { ["html"]="<screen name=\"Audit\" actions=\"Preparation\"><var name=\"Message\" type=\"Text\"/></screen>" } },
            new JsonObject { ["op"]="logic", ["data"]=new JsonObject { ["flow"]=$"preparation {owner}.Preparation\n  assign Message = \"Initial\"\n  end" } });
        var basis = new StaticBasis { Lane="o11" };
        var problems = DocumentNameRules.Check(ops, "/ops", "o11", new IndexBaseFacts(basis, ops), basis, []);
        var absent = problems.Any(p => p["code"]?.ToString()=="HTML_NAME_UNKNOWN" && p["message"]!.ToString().Contains("'Preparation' is listed"));
        Assert.Equal(missing, absent);
    }

    [Theory]
    [InlineData("screen")]
    [InlineData("block")]
    public void TextCreatesReadsEditsAndMergesPreparationWithStableIdentity(string ownerKind)
    {
        StudioAssemblies.Bind();
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(TraditionalPreparationFlowTests).Assembly.Location)!)!;
        var work=Path.Combine(root,".local","traditional-preparation-flow",Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work); output.WriteLine(work);
        var host=new ModelHost(work);
        string Run(string basis,string name,params JsonObject[] ops) {
            var job=Path.Combine(work,name+".json"); var path=Path.Combine(work,name+".oml");
            File.WriteAllText(job,new JsonObject{["ops"]=new JsonArray(ops.Select(o=>(JsonNode)o).ToArray())}.ToJsonString());
            var result=JsonSerializer.SerializeToNode(JobRunner.Run(host,basis,job,path))!;
            File.WriteAllText(Path.Combine(work,name+"-result.json"),result.ToJsonString());
            Assert.True(result["accepted"]?.GetValue<bool>()==true,result["details"]?.ToJsonString());
            return path;
        }
        JsonObject Flow(string text,string? basedOn=null) => new(){["op"]="logic",["data"]=new JsonObject{["flow"]=text,["basedOn"]=basedOn}};
        var basis=Path.Combine(root,"tests/fixtures/traditional-ui.oml");
        var created=Run(basis,"create",new JsonObject{["op"]="html",["data"]=new JsonObject{["html"]="""
            <OWNER name="PreparationTextAudit" actions="Refresh">
              <var name="Message" type="Text"/><div id="Result">{{ Message }}</div>
              <button onclick="Refresh" method="Ajax" validation="None">Refresh</button>
            </OWNER>
            """.Replace("OWNER",ownerKind)}},Flow("action PreparationTextAudit.Refresh\n  assign Message = \"Ajax\"\n  node AjaxRefreshNode()\n    @{WidgetOrWebBlock=&\"Result\"}\n  end"),
            Flow("preparation PreparationTextAudit.Preparation\n  assign Message = \"Initial\"\n  end"));
        FlowEntry Read(string path) {
            var bytes=File.ReadAllBytes(path);
            var flow=host.BuildFlow(bytes,Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),"o11");
            File.WriteAllText(Path.Combine(work,Path.GetFileNameWithoutExtension(path)+".flow.txt"),string.Join("\n",flow.Actions.Select(a=>a.Text)));
            var entry=Assert.Single(flow.Actions.Where(a=>a.Name=="MainFlow/PreparationTextAudit/Preparation"));
            Assert.True(entry.FixedPoint,string.Join(";",entry.Problems)); return entry;
        }
        var before=Read(created);
        Assert.StartsWith("preparation PreparationTextAudit.Preparation @",before.Text);
        var edited=Run(created,"edit",Flow(before.Text.Replace("\"Initial\"","\"Edited\""),before.TextSha));
        var after=Read(edited);
        Assert.Equal(before.Key,after.Key);
        Assert.Equal(before.Ids.OrderBy(p=>p.Key),after.Ids.OrderBy(p=>p.Key));
        Assert.Equal(before.Text.Replace("\"Initial\"","\"Edited\""),after.Text);
        var merged=Path.Combine(work,"merged.oml");
        Assert.True(MergeProbe.ThreeWay(host,File.ReadAllBytes(created),File.ReadAllBytes(edited),merged).LocalIsValid);
        var proof=MergeContentProof.Check(host,edited,merged);
        File.WriteAllText(Path.Combine(work,"merge-proof.json"),proof.ToJsonString());
        Assert.True(proof["accepted"]!.GetValue<bool>(),proof.ToJsonString());
        Assert.Equal(after.Text,Read(merged).Text);
        var html=host.HtmlRead(File.ReadAllBytes(merged),"PreparationTextAudit")["documents"]![0]!["html"]!.ToString();
        Assert.Contains("onclick=\"Refresh\"",html);
    }

    [Theory]
    [InlineData("preparation Home.Other\n  end", "FLOW_PREPARATION_NAME")]
    [InlineData("preparation Home.Preparation\n  in Id: Integer\n  end", "FLOW_PREPARATION_PARAMETERS")]
    [InlineData("preparation Preparation\n  end", "FLOW_NEW_ACTION_OWNER")]
    public void InvalidPreparationContractsAreRefusedBeforeNativeWrites(string text,string code)
    {
        var diff=FlowDiff.Compute(null,new Dictionary<string,string>(),ModuleFlow.Read(text));
        Assert.Contains(diff.Problems,p=>p.Code==code);
        Assert.Empty(diff.Ops);
    }
}
