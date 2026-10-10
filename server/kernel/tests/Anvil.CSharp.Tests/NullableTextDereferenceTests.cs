using Xunit;

namespace Anvil.CSharp.Tests;

public class NullableTextDereferenceTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void NativeNullableTextUsesTheClrDereferenceFailureInBothCompilerProfiles(bool staged)
    {
        var source=File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Cases","NullableMembers.cs.txt"));
        var files=new Dictionary<string,string> { ["NullableMembers.cs"]=source };
        var compiled=staged ? CSharpCompiler.CompileReferenceGraph(files) : CSharpCompiler.Compile(files);
        var probe=new ReferenceGraphProbe(compiled.Specification);
        Dictionary<string,object> Inputs(string? value)=>new() { ["Arg_text"]=new Dictionary<string,object> {
            ["HasValue"]=value!=null,["Value"]=value??"" } };
        foreach (var text in new[]{"","abc","\U0001f642"})
            Assert.Equal((decimal)text.Length,probe.Run("TextLength",Inputs(text))["AvResult"]);
        string? missing=null;
        var expected=Assert.Throws<NullReferenceException>(()=>missing!.Length);
        var actual=Assert.Throws<ReferenceGraphProbe.Failure>(()=>probe.Run("TextLength",Inputs(null)));
        Assert.Equal(expected.GetType().Name,actual.Kind);Assert.Equal(expected.Message,actual.Message);
    }
}
