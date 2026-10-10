using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>Native ODC agent authoring, expanded into the same transactional verbs as other model changes.</summary>
public static class AgentExpander
{
    static readonly Dictionary<string,string[]> Shapes = new() {
        ["data"] = ["name","target","as","model","description","messages","maxTokens","temperature","stop","extraBody","callCondition","enableActionCalling","outputFormat","outputFormatDescription","inputs","tools"],
        ["input"] = ["name","target","type","mandatory","default","description"],
        ["tool"] = ["target","action","description","arguments"],
        ["argument"] = ["fromAI","value","description"]
    };
    static readonly Dictionary<string,string> Properties = new() {
        ["model"]="AIModel",["description"]="Description",["messages"]="Messages",["maxTokens"]="MaxTokens",
        ["temperature"]="Temperature",["stop"]="Stop",["extraBody"]="ExtraBody",["callCondition"]="CallCondition",
        ["enableActionCalling"]="EnableActionCalling",["outputFormat"]="OutputFormat",["outputFormatDescription"]="OutputFormatDescription"
    };
    public static JsonObject Schema() => new() {
        ["op"]="agent", ["lane"]="odc", ["shapes"]=System.Text.Json.JsonSerializer.SerializeToNode(Shapes),
        ["rules"]="Create: name and model required; optional as is a $alias. Update: target is an existing IAgent and preserves its key; name renames it. Omitted fields are unchanged. Model/outputFormat/action/type are native references. Other string properties are OutSystems expressions, except descriptions. Messages defaults to the native Messages input. Instructions and session memory belong in the caller's message-building flow. Tools add IActionHandler unless target identifies an existing handler; inputs add parameters unless target identifies one (Messages addresses the native input). Tool and argument descriptions update their shared action/parameter metadata. Tool arguments explicitly choose fromAI:true or value:<expression>, never both. OutputFormat and enabled tool calling cannot coexist. Deletions use the ordinary delete verb. Import model dependencies with reference before this op."
    };
    static void Keys(JsonObject o,string shape) {
        var unknown=o.Select(p=>p.Key).Except(Shapes[shape],StringComparer.Ordinal).ToArray();
        if(unknown.Length>0)throw new InvalidOperationException("agent "+shape+": unknown keys "+string.Join(", ",unknown));
    }
    static string Text(JsonObject o,string key,bool required=false) {
        if(o[key] is JsonValue v && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s))return s;
        if(o.ContainsKey(key)||required)throw new InvalidOperationException("agent: "+key+" must be a non-empty string");
        return "";
    }
    static JsonObject Op(string op, params (string Key,JsonNode? Value)[] fields) {
        var o=new JsonObject{["op"]=op};foreach(var (key,value) in fields)o[key]=value?.DeepClone();return o;
    }
    public static List<JsonObject> Expand(JsonObject data) {
        Keys(data,"data");var result=new List<JsonObject>();
        var target=Text(data,"target");var creating=target.Length==0;
        var name=Text(data,"name",creating);
        var alias=Text(data,"as");
        if(alias.Length>0&&!alias.StartsWith('$'))throw new InvalidOperationException("agent: as must start with $");
        if(!creating&&alias.Length>0)throw new InvalidOperationException("agent: as is only accepted on creation; update addresses target directly");
        if(creating){Text(data,"model",true);target=alias.Length>0?alias:"$agent_"+name;result.Add(Op("create",("parent","@espace"),("type","IAgent"),("name",name),("as",target)));}
        else if(name.Length>0)result.Add(Op("rename",("target",target),("name",name)));
        if(data["enableActionCalling"]!=null&&!(data["enableActionCalling"] is JsonValue b&&b.TryGetValue<bool>(out _)))throw new InvalidOperationException("agent: enableActionCalling must be boolean");
        var tools=data["tools"]?.AsArray()??new JsonArray();
        if(data["outputFormat"]!=null&&(data["enableActionCalling"]?.GetValue<bool>()==true||tools.Count>0))throw new InvalidOperationException("agent: outputFormat cannot be combined with tool calling");
        if(tools.Count>0&&data["enableActionCalling"]?.GetValue<bool>()==false)throw new InvalidOperationException("agent: tools require enableActionCalling");
        foreach(var (field,property) in Properties)if(data.ContainsKey(field)){
            if(field!="enableActionCalling")Text(data,field,true);
            result.Add(Op("set",("target",target),("prop",property),("value",data[field])));
        }
        foreach(var node in data["inputs"]?.AsArray()??new JsonArray()) {
            var input=node!.AsObject();Keys(input,"input");var it=Text(input,"target");var n=Text(input,"name",it.Length==0);
            if(it.Length==0&&n=="Messages")it=target+"/Messages";
            if(it.Length==0){it="$agent_input_"+n;Text(input,"type",true);result.Add(Op("create",("parent",target),("type","IInputParameter"),("name",n),("as",it)));}
            foreach(var (f,p) in new[]{("type","DataType"),("mandatory","IsMandatory"),("default","DefaultValue"),("description","Description")})if(input.ContainsKey(f)){
                if(f=="mandatory")input[f]!.GetValue<bool>();else Text(input,f,true);
                result.Add(Op("set",("target",it),("prop",p),("value",input[f])));
            }
        }
        if(tools.Count>0&&!data.ContainsKey("enableActionCalling"))result.Add(Op("set",("target",target),("prop","EnableActionCalling"),("value",true)));
        for(var i=0;i<tools.Count;i++) {
            var tool=tools[i]!.AsObject();Keys(tool,"tool");var tt=Text(tool,"target");
            if(tt.Length==0){Text(tool,"action",true);tt="$agent_tool_"+i;result.Add(Op("create",("parent",target),("type","IActionHandler"),("as",tt)));}
            foreach(var (f,p) in new[]{("action","Action"),("description","Description")})if(tool.ContainsKey(f)){Text(tool,f,true);result.Add(Op("set",("target",f=="description"?tt+"/Action":tt),("prop",p),("value",tool[f])));}
            foreach(var arg in tool["arguments"]?.AsObject()??new JsonObject()){
                var a=arg.Value!.AsObject();Keys(a,"argument");
                var fromAI=a["fromAI"]?.GetValue<bool>()==true;
                if(fromAI==a.ContainsKey("value"))throw new InvalidOperationException("agent: argument "+arg.Key+" needs exactly one of fromAI:true or value");
                var at=tt+"/arg:"+arg.Key;
                result.Add(Op("set",("target",at),("prop","IsFilledByAI"),("value",fromAI)));
                if(!fromAI){Text(a,"value",true);result.Add(Op("set",("target",at),("prop","Value"),("value",a["value"])));}
                if(a.ContainsKey("description")){Text(a,"description",true);result.Add(Op("set",("target",at+"/Parameter"),("prop","Description"),("value",a["description"])));}
            }
        }
        return result;
    }
}

public sealed partial class ModelSession {
    private JsonNode Agent(JsonObject op) {
        if(MessageExpectations.Lane!="odc")throw new NotSupportedException("agent requires the ODC lane");
        var data=op["data"]?.AsObject()??throw new InvalidOperationException("agent: data is required");
        if(data["target"] is JsonValue t) {
            var existing=Resolve(t.GetValue<string>());
            if(!existing.GetType().GetInterfaces().Any(i=>i.Name=="IAgent"))throw new InvalidOperationException("agent: target must be an IAgent");
            data=data.DeepClone().AsObject();
            data["target"]="@"+((OutSystems.Model.IObjectSignature)existing).ObjectKey;
        }
        var expanded=AgentExpander.Expand(data);
        foreach(var step in expanded)ApplyOne(step);
        return new JsonObject{["expanded"]=expanded.Count,["target"]=data["target"]?.DeepClone()??data["as"]?.DeepClone()??JsonValue.Create("$agent_"+data["name"])};
    }
}
