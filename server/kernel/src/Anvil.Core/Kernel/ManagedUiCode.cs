using System.Text;
using System.Text.Json.Nodes;
using System.Security.Cryptography;
using OutSystems.Model;
namespace Anvil.Core;
public sealed partial class ModelSession
{
    /// <summary>Remove superseded expression helpers and handlers only when owned by this source and every real consumer
    /// belongs to owners being rebuilt. Legacy ownership requires an exact reconstruction of our old emitter.</summary>
    private JsonArray ObsoleteUiCode(JsonArray screens,JsonObject logic)
    {
        var result=new JsonArray();var owners=screens.OfType<JsonObject>().Select(s=>(Name:s["name"]!.ToString(),Root:UINamed(ScreenSpecification.Reference(s)))).ToArray();
        var desired=(logic["actions"]?.AsArray().OfType<JsonObject>()??[]).Select(a=>a["name"]!.ToString()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach(var action in ((IObjectSignature)_es).Children.OfType<IObjectSignature>().Where(a=>Implements(a,"IClientAction") && ReferenceEquals(a.Parent,_es)))
        {
            var name=TypeResolver.Name(action)!;if(desired.Contains(name) || UIProperty(action,"Public") is true)continue;
            var owner=owners.FirstOrDefault(o=>name.StartsWith(o.Name+"_Expr_",StringComparison.Ordinal));if(owner.Root==null)continue;
            var marker=UIProperty(action,"Description")?.ToString()??"";
            var legacy=LegacyExpression(action,name,owner.Name);

            if(!marker.StartsWith("anvil:ui expression "+owner.Name+"/",StringComparison.Ordinal) && !legacy)continue;
            var consumers=Consumers(action).Where(c=>!IsDerived(c.Referer,c.Path));
            if(consumers.Any(c=>!owners.Any(o=>o.Root!=null && IsInside(c.Referer,o.Root))))continue;
            result.Add(new JsonObject{["op"]="delete",["target"]="IClientAction:"+name});
        }
        foreach(var owner in owners.Where(o=>o.Root!=null))
        foreach(var action in owner.Root!.Children.OfType<IObjectSignature>().Where(a=>Implements(a,"IScreenAction")))
        {
            var name=TypeResolver.Name(action)!;
            if(desired.Contains(name) || !(UIProperty(action,"Description")?.ToString()??"").StartsWith("anvil:ui handler "+owner.Name+"/",StringComparison.Ordinal))continue;
            if(Consumers(action).Where(c=>!IsDerived(c.Referer,c.Path)).Any(c=>!owners.Any(o=>o.Root!=null && IsInside(c.Referer,o.Root))))continue;
            result.Add(new JsonObject{["op"]="delete",["target"]="@"+action.ObjectKey});
        }
        return result;
    }
    private static bool LegacyExpression(IObjectSignature action,string name,string owner)
    {
        var js=action.Children.Where(c=>Implements(c,"IJavaScriptNode")).ToArray();if(js.Length!=1)return false;
        var code=(UIProperty(js[0],"JavaScript")?.ToString()??"").Replace("\r", "");
        const string start="const value=(";var index=code.IndexOf(start,StringComparison.Ordinal);if(index<0)return false;
        var end=code.LastIndexOf(");\n$parameters.Result=",StringComparison.Ordinal);if(end<index)return false;
        var expression=code[(index+start.Length)..end];
        var outputs=action.Children.Where(c=>Implements(c,"IOutputParameter")).ToArray();if(outputs.Length!=1 || TypeResolver.Name(outputs[0])!="Result")return false;
        var type=UiCatalog.TypeName(UIProperty(outputs[0],"DataType"));
        var hash=System.Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(type+":"+expression)))[..10].ToLowerInvariant();

        if(name!=owner+"_Expr_"+hash)return false;
        var expected=new StringBuilder();foreach(var input in action.Children.Where(c=>Implements(c,"IInputParameter")))expected.Append("const ").Append(TypeResolver.Name(input)).Append("=$parameters.").Append(TypeResolver.Name(input)).Append(";\n");
        expected.Append(start).Append(expression).Append(");\n").Append(type=="Text"?"$parameters.Result=value==null?'':String(value);":"$parameters.Result=value;").Append('\n');
        return expected.ToString()==code;
    }
}
