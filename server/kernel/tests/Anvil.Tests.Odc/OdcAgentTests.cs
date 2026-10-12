using Anvil.Core;
using OutSystems.Model;
using OutSystems.ModelAPILoader;
using OutSystems.Model.Enumerations;
using OutSystems.Model.Logic;
using ServiceStudio.Model;
using System.Text.Json.Nodes;
using Xunit;
namespace Anvil.Tests.Odc;
public class OdcAgentTests {
 [Fact]
 public void CommonMessageTypesSupportActionParametersAndNativeReload() {
  StudioAssembliesOdc.Bind(); CommonTypes();
 }
 [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
 static void CommonTypes() {
  using var app=Loader.ModelServicesInstance.CreateESpace(SegmentationKind.AIAgent,"CommonTypesFixture",targetPlatform:PlatformServerVersion.Neo,enableTransactions:true);
  var common=app.GetAllDescendantsOfType<OutSystems.Model.Data.IStructureSignature>().Single(x=>x.Name=="AIMessage");
  Assert.Same(common,TypeResolver.Resolve(app,"aimessage"));
  var list=Assert.IsAssignableFrom<OutSystems.Model.Types.IListType>(TypeResolver.Resolve(app,"AIMessage List"));
  Assert.Same(common,list.ElementType);
  Assert.Throws<KeyNotFoundException>(()=>TypeResolver.Resolve(app,"UnknownCommonType"));
  new ModelSession((ESpace)app).Apply(JsonNode.Parse("""
  [{"op":"logic","data":{"actions":[{"name":"RoundTrip","inputs":[{"name":"Messages","type":"AIMessage List"}],"outputs":[{"name":"Result","type":"AIMessage List"}],"steps":[{"assign":{"Result":"Messages"}}]}]}}]
  """)!.AsArray());
  var host=new ModelHost(Path.Combine(Path.GetTempPath(),"ssam-agent-common-types",Guid.NewGuid().ToString("N")));
  var loaded=host.Load(app.Save());
  try {
   var messages=((IESpace)loaded).GetAllDescendantsOfType<IServerAction>().Single(x=>x.Name=="RoundTrip").InputParameters.Single(x=>x.Name=="Messages");
   Assert.Equal("AIMessage",TypeResolver.Name(((OutSystems.Model.Types.IListType)messages.DataType).ElementType));
   Assert.Equal(0,ModelHost.Messages(loaded).Count(x=>x.IsError));
  } finally {ModelHost.Release(loaded);}
 }
 [Fact]
 public void AgentNativeModelSupportsCreationToolsAndIdentityPreservingUpdates() {
  StudioAssembliesOdc.Bind(); Run();
 }
 [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
 static void Run() {
  var dir=Path.Combine(Path.GetTempPath(),"ssam-agent-tests",Guid.NewGuid().ToString("N"));Directory.CreateDirectory(dir);
  var host=new ModelHost(dir);
  var model=Loader.ModelServicesInstance.CreateAIModelConnection("TestModel",enableTransactions:true);
  model.TransactionsManager.ExecuteTransaction("Create model fixture",(_,_)=>{model.CreateAction("CallTestModel");return true;});
  using var app=Loader.ModelServicesInstance.CreateESpace(SegmentationKind.AIAgent,"AgentFixture",targetPlatform:PlatformServerVersion.Neo,enableTransactions:true);
  app.TransactionsManager.ExecuteTransaction("Import model fixture",(_,_)=>{app.AddDependency(model);return true;});
  var templatePath=Path.Combine(dir,"agent-template.oml");File.WriteAllBytes(templatePath,app.Save());
  var created=OdcAppFactory.Create(host,new OdcAppSpec("agentic","NewAgentApp",TemplateOml:templatePath,Tenant:"lab.test",Author:"test@example.com"),Path.Combine(dir,"created"));
  Assert.Equal("AIAgent",created["reloadedKind"]!.GetValue<string>());
  Assert.Equal(0,created["validation"]!["errors"]!.GetValue<int>());
  var session=new ModelSession((ESpace)app);
  session.Apply(JsonNode.Parse("""
  [
   {"op":"logic","data":{"actions":[{"name":"Lookup","inputs":[{"name":"Query","type":"Text"}],"outputs":[{"name":"Answer","type":"Text"}],"steps":[{"assign":{"Answer":"Query"}}]}]}},
   {"op":"agent","data":{"name":"Assistant","model":"IReference:TestModel/CallTestModel","tools":[{"action":"IServerAction:Lookup","description":"Find an answer","arguments":{"Query":{"fromAI":true,"description":"Question to answer"}}}]}},
   {"op":"agent","data":{"name":"Reviewer","model":"IReference:TestModel/CallTestModel"}}
  ]
  """)!.AsArray());
  Assert.Equal(2,app.Agents.Count());
  var agent=app.Agents.Single(a=>a.Name=="Assistant");var key=agent.Key.ToString();
  Assert.True(agent.EnableActionCalling);Assert.True(agent.ActionHandlers.Single().Arguments.Single().IsFilledByAI);
  Assert.Equal("Find an answer",agent.ActionHandlers.Single().Description);
  session.Apply(JsonNode.Parse("""[{"op":"agent","data":{"target":"IAgent:Assistant","name":"Support","maxTokens":"768"}}]""")!.AsArray());
  Assert.Equal(key,app.Agents.Single(a=>a.Name=="Support").Key.ToString());
  var saved=app.Save();var reloaded=host.Load(saved);
  try {Assert.Equal(2,((IESpace)reloaded).Agents.Count());Assert.Equal(key,((IESpace)reloaded).Agents.Single(a=>a.Name=="Support").Key.ToString());}
  finally {ModelHost.Release(reloaded);}
 }
}
