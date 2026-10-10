using System.Text.Json.Nodes;
using System.Text.Json;
using System.Reflection;
using System.Runtime.Loader;
using System.ComponentModel.DataAnnotations;
using Anvil.Authoring;
using Anvil.CSharp;
using Xunit;

namespace Anvil.CSharp.Tests;

public class DataEffectsTests
{
    private static string Source=>File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Cases","DataActions.cs.txt"));
    [Fact]
    public void LinqAndRecordWritesCompileWithAnInjectedSessionAndTypedNullableValues()
    {
        var result=CSharpCompiler.Compile(new Dictionary<string,string> { ["Inventory.cs"]=Source });
        var actions=result.Specification["logic"]!["actions"]!.AsArray();Assert.Equal(9,actions.Count);
        Assert.All(actions,a=>Assert.DoesNotContain(a!["inputs"]!.AsArray(),p=>p!["name"]!.ToString().Contains("database",StringComparison.Ordinal)));
        Assert.Contains(result.Specification["data"]!["structures"]!.AsArray(),s=>s!["name"]!.ToString().StartsWith("AvRecord_",StringComparison.Ordinal));
        var serialized=result.Specification.ToJsonString();
        Assert.Contains("\"create\":\"Batch\"",serialized);
        Assert.Contains("\"update\":\"Batch\"",serialized);
        Assert.Contains("\"delete\":\"Batch\"",serialized);
        Assert.Contains("AvHas_",serialized);
    }
    [Fact]
    public void NormalCSharpRunsCrudAgainstAnInjectedDetachedRecordStore()
    {
        var context=new AssemblyLoadContext("DataEffectsReference",isCollectible:true);
        try
        {
            using var stream=new MemoryStream();var program=SourceProgram.Parse(new Dictionary<string,string> {["Inventory.cs"]=Source});
            var emitted=program.Compilation.Emit(stream);Assert.True(emitted.Success,string.Join(Environment.NewLine,emitted.Diagnostics));stream.Position=0;
            var assembly=context.LoadFromStream(stream);var inventory=assembly.GetType("Inventory")!;var database=new MemorySession();
            object? Call(string name,params object?[] arguments)
            {
                try{return inventory.GetMethod(name)!.Invoke(null,[database,..arguments]);}
                catch(TargetInvocationException error){System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException!).Throw();throw;}
            }
            var first=Call("Create","V-01",12,null)!;var second=Call("Create","V-02",3,"seed")!;
            JsonNode Row()=>JsonSerializer.SerializeToNode(Call("Read",first))!;
            Assert.Null(Row()["Note"]);Call("ChangeQuantity",first,8);Assert.Equal(8,Row()["Quantity"]!.GetValue<int>());Assert.Null(Row()["Note"]);
            Call("ChangeNote",first,"");Assert.Equal("",Row()["Note"]!.GetValue<string>());
            Call("ChangeNote",first,"ready");Assert.Throws<ArgumentException>(()=>Call("ChangeQuantity",first,-1));
            Assert.Equal("ready",Row()["Note"]!.GetValue<string>());Assert.Equal(8,Row()["Quantity"]!.GetValue<int>());
            Assert.Equal(2,Call("CountAvailable",0));Assert.Equal(1,Call("CountAvailable",4));Assert.Equal(true,Call("Exists","V-01"));
            var list=JsonSerializer.SerializeToNode(Call("ListAvailable",0))!.AsArray();Assert.Equal(new[]{"V-01","V-02"},list.Select(r=>r!["Code"]!.ToString()));
            Call("ChangeNote",first,null);Assert.Null(Row()["Note"]);
            Call("Remove",first);Assert.Null(Call("Read",first));Assert.NotNull(Call("ReadRequired",second));
            Assert.Throws<InvalidOperationException>(()=>Call("ReadRequired",first));
        }
        finally{context.Unload();}
    }
    internal sealed class MemorySession:IDataSession
    {
        private readonly Dictionary<Type,List<object>> rows=[];
        private long next;
        private List<object> Rows<T>()=>rows.TryGetValue(typeof(T),out var list)?list:rows[typeof(T)]=[];
        private static T Clone<T>(T value)=>JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(value))!;
        public IQueryable<T> Query<T>() where T:class=>Rows<T>().Cast<T>().Select(Clone).ToArray().AsQueryable();
        public Id<T> Insert<T>(T record) where T:class
        {
            Validator.ValidateObject(record,new ValidationContext(record),validateAllProperties:true);
            var id=new Id<T>(++next);var copy=Clone(record);typeof(T).GetProperty("Id")!.SetValue(copy,id);Rows<T>().Add(copy);return id;
        }
        public void Update<T>(T record) where T:class
        {
            Validator.ValidateObject(record,new ValidationContext(record),validateAllProperties:true);
            var key=typeof(T).GetProperty("Id")!;var id=key.GetValue(record);var list=Rows<T>();var index=list.FindIndex(r=>Equals(key.GetValue(r),id));
            if(index<0)throw new InvalidOperationException("Record does not exist.");list[index]=Clone(record);
        }
        public void Delete<T>(Id<T> id) where T:class
        {
            var key=typeof(T).GetProperty("Id")!;var list=Rows<T>();var index=list.FindIndex(r=>Equals(key.GetValue(r),id));
            if(index<0)throw new InvalidOperationException("Record does not exist.");list.RemoveAt(index);
        }
    }
}
