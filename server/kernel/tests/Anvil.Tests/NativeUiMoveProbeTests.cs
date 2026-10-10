using System.Linq.Expressions;
using System.Reflection;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class NativeUiMoveProbeTests
{
    [Fact]
    public void InstalledNativeMoveRejectsPlaceholderMoveWithoutLosingLocalConsumers()
    {
        StudioAssemblies.Bind(null);
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(NativeUiMoveProbeTests).Assembly.Location)!)!;
        var work=Path.Combine(root,".local/review/native-ui-move");Directory.CreateDirectory(work);
        var host=new ModelHost(work);var fixture=Path.Combine(root,"tests/fixtures/reactive-ui.oml");
        var output=Path.Combine(work,"initial.oml");
        JobRunner.Run(host,fixture,Path.Combine(root,"scripts/probes/highcode/native-block.json"),output);
        var load=typeof(ModelHost).GetMethod("Load",[typeof(string)])!;
        var native=load.Invoke(host,[output])!;
        try
        {
            var session=Activator.CreateInstance(typeof(ModelSession),native)!;
            var resolve=typeof(ModelSession).GetMethod("Resolve",BindingFlags.Instance|BindingFlags.Public)!;
            object Resolve(string reference)=>resolve.Invoke(session,[reference])!;
            string Key(object value)=>Property(value,"GlobalKey")!.ToString()!;
            var slot=Resolve("IMobileBlock:ResearchCard/Footer");var key=Key(slot);
            var consumers=(from screen in Enumerable.Range(1,2) from instance in Enumerable.Range(1,2)
                select $"IMobileScreen:Research{screen}/#IMobileBlockInstanceWidget/Content/Card{instance}/Footer/#ITextWidget").ToArray();
            var captions=consumers.Select(reference=>Property(Resolve(reference),"Text")?.ToString()).ToArray();
            typeof(ModelSession).GetMethod("Apply")!.Invoke(session,[new JsonArray(new JsonObject{["op"]="create",["parent"]="IMobileBlock:ResearchCard",["type"]="IContainer",["name"]="MovedFooterParent"}),null]);
            var action=(Action<object>)(_=>
            {
                var parent=Resolve("IMobileBlock:ResearchCard/MovedFooterParent");
                var cloner=AppDomain.CurrentDomain.GetAssemblies().Select(a=>a.GetType("ServiceStudio.Clone.ObjectCloner")).First(t=>t!=null)!;
                var move=cloner.GetMethod("MoveObject",BindingFlags.Public|BindingFlags.Static)!;
                move.Invoke(null,[slot,parent,null,false]);
            });
            var mutate=typeof(Publisher).GetMethod("Mutate")!;
            var callbackType=mutate.GetParameters()[2].ParameterType;
            var parameter=Expression.Parameter(callbackType.GenericTypeArguments[0]);
            var callback=Expression.Lambda(callbackType,Expression.Call(Expression.Constant(action),typeof(Action<object>).GetMethod("Invoke")!,Expression.Convert(parameter,typeof(object))),parameter).Compile();
            var failure=Assert.Throws<TargetInvocationException>(()=>mutate.Invoke(null,[native,"Native placeholder move proof",callback]));
            Assert.Contains("Clone not allowed",failure.GetBaseException().Message);
            Assert.Equal(key,Key(Resolve("IMobileBlock:ResearchCard/Footer")));
            Assert.Equal(captions,consumers.Select(reference=>Property(Resolve(reference),"Text")?.ToString()).ToArray());
            var bytes=(byte[])typeof(ModelHost).GetMethod("Save")!.Invoke(host,[native])!;
            var saved=Path.Combine(work,"moved.oml");File.WriteAllBytes(saved,bytes);
            var inspected=host.Inspect(bytes);
            Assert.True(inspected.IsValid,System.Text.Json.JsonSerializer.Serialize(inspected.Validation));
            File.WriteAllText(Path.Combine(work,"evidence.json"),new JsonObject{["nativeMoveSupported"]=false,["rejection"]=failure.GetBaseException().Message,["unchangedPlaceholderKey"]=key,["localConsumerCaptionsPreserved"]=true,["isValid"]=inspected.IsValid,["externalConsumerProven"]=false}.ToJsonString());
        }
        finally {typeof(ModelHost).GetMethod("Release")!.Invoke(null,[native]);}
    }

    private static object? Property(object target,string name)
        => target.GetType().GetProperty(name,BindingFlags.Instance|BindingFlags.Public|BindingFlags.NonPublic)?.GetValue(target)
           ?? target.GetType().GetInterfaces().Select(t=>t.GetProperty(name)).FirstOrDefault(p=>p!=null)?.GetValue(target);
}
