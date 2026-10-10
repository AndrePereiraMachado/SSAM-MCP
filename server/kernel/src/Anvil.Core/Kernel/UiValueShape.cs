using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Esprima.Ast;

namespace Anvil.Core;

/// <summary>Structural types for authored JS values and their native JSON wire representation.</summary>
internal sealed record UiValueShape(string Kind, IReadOnlyDictionary<string,UiValueShape>? Fields=null, UiValueShape? Element=null)
{
    private string Signature=>Kind=="record"?"{"+string.Join(",",Fields!.Select(p=>p.Key+":"+p.Value.Signature))+"}":Kind=="array"?"["+Element!.Signature+"]":Kind;
    private string Name=>"AvUiValue_"+Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Signature)))[..12].ToLowerInvariant();
    private string WrapperName=>"AvUiItem_"+Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Signature)))[..12].ToLowerInvariant();
    public string NativeType=>Kind switch {"record"=>Name,"array"=>(Element!.Kind=="record"?Element.NativeType:WrapperName)+" List",_=>Kind};
    public static (UiValueShape Shape,JsonNode Value) Infer(Node node)
    {
        if(node is ObjectExpression obj)
        {
            var fields=new SortedDictionary<string,UiValueShape>(StringComparer.Ordinal);var value=new JsonObject();var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach(var entry in obj.Properties)
            {
                if(entry is not Property p||p.Computed||p.Method||p.Shorthand)throw new ArgumentException("Initial records require literal named fields");
                var name=p.Key is Identifier id?id.Name:p.Key is Literal {Value:string key}?key:throw new ArgumentException("Record field requires a name");
                ScreenSpecification.Name(JsonValue.Create(name));
                if(name is "__proto__" or "prototype" or "constructor"||!names.Add(name))throw new ArgumentException("Unsupported or duplicate record field: "+name);
                var child=Infer(p.Value);fields.Add(name,child.Shape);value.Add(name,child.Value);
            }
            if(fields.Count==0)throw new ArgumentException("Cannot infer an empty record; a declared type is required");
            return (new("record",fields),value);
        }
        if(node is ArrayExpression array)
        {
            if(array.Elements.Count==0)throw new ArgumentException("Cannot infer an empty array; a declared element type is required");
            var items=array.Elements.Select(n=>n==null?throw new ArgumentException("Sparse arrays are not native lists"):Infer(n)).ToArray();
            if(items.Any(i=>i.Shape.Signature!=items[0].Shape.Signature))throw new ArgumentException("Array elements require one consistent structural type");
            return (new("array",Element:items[0].Shape),new JsonArray(items.Select(i=>i.Value).ToArray()));
        }
        if(node is UnaryExpression {Operator:UnaryOperator.Minus,Argument:Literal {Value:double magnitude}})
            return Number(-magnitude);
        if(node is Literal literal)return literal.Value switch {
            string text=>(new("Text"),JsonValue.Create(text)!),bool boolean=>(new("Boolean"),JsonValue.Create(boolean)!),
            double number=>Number(number),int number=>Number(number),_=>throw new ArgumentException("Null/undefined require a declared nullable type")};
        throw new ArgumentException("Initial records and arrays require literal values; initialization code belongs in onInitialize");
        static (UiValueShape,JsonNode) Number(double value)
        {
            if(!double.IsFinite(value)||(Math.Truncate(value)==value&&Math.Abs(value)>9007199254740991d))throw new ArgumentException("Value exceeds safe JavaScript numeric precision; use text for exact identifiers");
            return (new("Decimal"),JsonValue.Create(value)!);
        }
    }
    public IEnumerable<JsonObject> Structures()
    {
        if(Kind=="record")
        {
            foreach(var shape in Fields!.Values)foreach(var child in shape.Structures())yield return child;
            yield return Structure(Name,Fields.Select(p=>KeyValuePair.Create(p.Key,p.Value.NativeType)));
        }
        else if(Kind=="array")
        {
            foreach(var child in Element!.Structures())yield return child;
            if(Element.Kind!="record")yield return Structure(WrapperName,[KeyValuePair.Create("Value",Element.NativeType)]);
        }
        static JsonObject Structure(string name,IEnumerable<KeyValuePair<string,string>> fields)=>new(){["name"]=name,["description"]="anvil:ui structural value",["attributes"]=new JsonArray(fields.Select(p=>(JsonNode)new JsonObject{["name"]=p.Key,["type"]=p.Value}).ToArray())};
    }
    public JsonNode EncodeInitial(JsonNode value)=>Kind switch {
        "record"=>new JsonObject(Fields!.Select(p=>KeyValuePair.Create(p.Key,(JsonNode?)p.Value.EncodeInitial(value[p.Key]!)))),
        "array"=>new JsonArray(value.AsArray().Select(v=>Element!.Kind=="record"?Element.EncodeInitial(v!):(JsonNode)new JsonObject{["Value"]=Element.EncodeInitial(v!)}).ToArray()),
        _=>value.DeepClone()};
    private JsonObject Schema()=>new(){["kind"]=Kind,["fields"]=Fields==null?null:new JsonObject(Fields.Select(p=>KeyValuePair.Create(p.Key,(JsonNode?)p.Value.Schema()))),["element"]=Element?.Schema()};
    public string Decode(string wire,bool readOnly=false)=>$"{(readOnly?"__avFreeze(":"")}__avValue({wire},{Schema().ToJsonString()},false){(readOnly?")":"")}";
    public string Encode(string value)=>$"__avValue({value},{Schema().ToJsonString()},true)";
    public const string JavaScript="""
        function __avFreeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(__avFreeze);Object.freeze(value);}return value;}
        function __avValue(value,type,encode,path='value'){
          const fail=()=>{throw new TypeError(path+': value does not match its inferred native type');};
          if(type.kind==='array'){
            if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||Object.getOwnPropertySymbols(value).length||Object.getOwnPropertyNames(value).length!==value.length+1)fail();
            return Array.from(value,(item,index)=>{
              const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
              if(!descriptor||!Object.prototype.hasOwnProperty.call(descriptor,'value'))fail();
              if(!encode&&type.element.kind!=='record')item=item.Value;
              const converted=__avValue(item,type.element,encode,path+'['+index+']');
              return encode&&type.element.kind!=='record'?{Value:converted}:converted;
            });
          }
          if(type.kind==='record'){
            if(value===null||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)fail();
            const keys=Object.keys(type.fields);
            if(Object.getOwnPropertySymbols(value).length||Object.getOwnPropertyNames(value).length!==keys.length||keys.some(k=>!Object.prototype.hasOwnProperty.call(value,k)||!Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value,k),'value')))fail();
            return Object.fromEntries(keys.map(k=>[k,__avValue(value[k],type.fields[k],encode,path+'.'+k)]));
          }
          if(type.kind==='Text'&&typeof value!=='string'||type.kind==='Boolean'&&typeof value!=='boolean'||type.kind==='Decimal'&&(typeof value!=='number'||!Number.isFinite(value)||Number.isInteger(value)&&!Number.isSafeInteger(value)))fail();
          return value;
        }
        """;
}
