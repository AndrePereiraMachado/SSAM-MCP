using Anvil.Core;
using System.Text.Json.Nodes;
using Xunit;
namespace Anvil.Tests.Odc;
public class AgentExpanderTests {
 [Theory]
 [InlineData("{}")]
 [InlineData("{\"name\":\"A\"}")]
 [InlineData("{\"target\":\"IAgent:A\",\"unknown\":1}")]
 [InlineData("{\"name\":\"A\",\"model\":\"Model\",\"outputFormat\":\"Result\",\"enableActionCalling\":true}")]
 [InlineData("{\"target\":\"IAgent:A\",\"tools\":[{\"action\":\"Action\",\"arguments\":{\"Query\":{\"fromAI\":true,\"value\":\"Query\"}}}]}")]
 [InlineData("{\"target\":\"IAgent:A\",\"tools\":[{\"action\":\"Action\",\"arguments\":{\"Query\":{}}}]}")]
 public void InvalidSpecificationsRefuseBeforeExpansion(string json) => Assert.ThrowsAny<Exception>(()=>AgentExpander.Expand(JsonNode.Parse(json)!.AsObject()));
 [Fact]
 public void SameSpecificationSameOperationsWithoutMutatingInput() {
  var data=JsonNode.Parse("""{"name":"Support","model":"IReference:Model/CallModel","tools":[{"action":"IServerAction:Lookup","arguments":{"Query":{"fromAI":true}}}]}""")!.AsObject();
  var original=data.ToJsonString();var first=AgentExpander.Expand(data);var second=AgentExpander.Expand(data);
  Assert.Equal(first.Select(x=>x.ToJsonString()),second.Select(x=>x.ToJsonString()));Assert.Equal(original,data.ToJsonString());
  Assert.Contains(first,x=>x["prop"]?.ToString()=="IsFilledByAI"&&x["value"]!.GetValue<bool>());
  foreach(var op in first)VerbSurface.Check(op);
 }
 [Fact]
 public void UpdateDoesNotCreateOrDeleteTheAgentAndRetainsOmittedFields() {
  var ops=AgentExpander.Expand(JsonNode.Parse("""{"target":"@key","maxTokens":"1024"}""")!.AsObject());
  Assert.Single(ops);Assert.Equal("set",ops[0]["op"]!.ToString());Assert.Equal("MaxTokens",ops[0]["prop"]!.ToString());Assert.Equal("@key",ops[0]["target"]!.ToString());
 }
 [Theory]
 [InlineData("service")]
 [InlineData("client")]
 public void AgentCallRequiresServerAction(string kind) {
  var data=JsonNode.Parse("""{"actions":[{"name":"Ask","kind":"server","steps":[{"node":"ICallAgentNode","as":"Run","properties":{"Agent":"IAgent:Support"}}]}]}""")!.AsObject();
  data["actions"]![0]!["kind"]=kind;
  var error=Assert.Throws<InvalidOperationException>(()=>LogicExpander.Expand(data));
  Assert.Contains("requires a server action",error.Message);
 }
}
