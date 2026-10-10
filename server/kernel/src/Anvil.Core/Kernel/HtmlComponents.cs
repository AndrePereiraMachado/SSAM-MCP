using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Esprima;
using Esprima.Ast;
namespace Anvil.Core;

/// <summary>High-code source frontend. JavaScript is parsed, never evaluated by the compiler.
/// Produces the same typed UI/logic contract used by the controlled module planner.</summary>
public static class HtmlComponents
{
    public static JsonObject Compile(string source) => Compile(UiSourceBundle.From(JsonValue.Create(source)!));
    public static void ValidateSource(UiSourceBundle source)
    {
        var program=UiSourceProgram.Bind(source);
        if(program.Components.All(c=>c.NativeSymbols.Count==0)){Compile(source);return;}
        // Native signatures require the target snapshot; source parsing never invents them.
        foreach(var c in program.Components)_=new Component(c.Node,c.NativeName);
    }
    public static JsonObject Compile(UiSourceBundle source, Func<UiNativeImport,ScreenContract>? nativeResolver=null)
    {
        var program=UiSourceProgram.Bind(source);
        var bySource=program.Components.ToDictionary(c=>c,c=>new Component(c.Node,c.NativeName));
        var components=bySource.Values.ToArray();
        var native=new Dictionary<UiNativeImport,Component>();
        foreach(var import in program.Components.SelectMany(c=>c.NativeSymbols.Values).Distinct())
            native.Add(import,new Component((nativeResolver??throw new ArgumentException("Native UI imports require a target module snapshot: "+import.Reference))(import)));
        var scopes=bySource.ToDictionary(p=>p.Value,p=>(IReadOnlyDictionary<string,Component>)p.Key.Symbols.Where(s=>bySource.ContainsKey(s.Value)).ToDictionary(s=>s.Key,s=>bySource[s.Value],StringComparer.Ordinal).Concat(p.Key.NativeSymbols.Select(s=>KeyValuePair.Create(s.Key,native[s.Value]))).ToDictionary(s=>s.Key,s=>s.Value,StringComparer.Ordinal));
        var screens=new JsonArray();var actions=new JsonArray();var structures=new JsonArray();
        // All signatures are parsed before any consumer is compiled, so source order is irrelevant.
        var ordered=new List<Component>();var visiting=new HashSet<string>(StringComparer.OrdinalIgnoreCase);var done=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void Visit(Component c)
        {
            if(c.NativeReference!=null||done.Contains(c.Name))return;
            if(!visiting.Add(c.Name))throw new ArgumentException("Component composition cycle at "+c.Name);
            foreach(var dependency in c.Dependencies(scopes[c])) {if(dependency.Kind!="block")throw new ArgumentException("Only blocks can be instantiated: "+dependency.Name);Visit(dependency);}
            visiting.Remove(c.Name);done.Add(c.Name);ordered.Add(c);
        }
        foreach(var component in components)Visit(component);
        foreach(var c in ordered) { var owner=c.Compile(scopes[c],actions);screens.Add(owner);foreach(var structure in c.EventStructures())if(!structures.OfType<JsonObject>().Any(x=>x["name"]!.ToString()==structure["name"]!.ToString()))structures.Add(structure); }
        var result=new JsonObject{["screens"]=screens,["logic"]=new JsonObject{["actions"]=actions}};
        if(structures.Count>0)result["data"]=new JsonObject{["structures"]=structures};
        ModuleSpecification.Validate(result);return result;
    }
    private sealed record Field(string Name,string Type,string? Default=null,UiValueShape? Shape=null,JsonNode? Initial=null);
    private sealed class Component
    {
        public string Name {get;} public string Kind {get;}
        public string? NativeReference {get;}
        private readonly HashSet<string> optionalEvents=new(StringComparer.Ordinal);
        private readonly HashSet<string>? nativeSlots;
        public Component(ScreenContract signature)
        {
            NativeReference=signature.Reference;Name=signature.Reference;Kind="block";node=null!;
            Inputs.AddRange(signature.Inputs.Select(p=>new Field(p.Name,p.Type,p.Mandatory?null:p.Default??"")));
            foreach(var ev in signature.Events){Events.Add(ev.Name,ev.Params.Select(p=>new Field(p.Name,p.Type)).ToList());if(!ev.Mandatory)optionalEvents.Add(ev.Name);}
            nativeSlots=signature.Placeholders.Select(p=>p.Name).ToHashSet(StringComparer.Ordinal);
        }
        public List<Field> Inputs {get;}=[];
        public Dictionary<string,List<Field>> Events {get;}=new(StringComparer.Ordinal);
        private readonly List<Field> state=[];
        private readonly HashSet<string> constants=new(StringComparer.Ordinal);
        private readonly Dictionary<string,FunctionDeclaration> functions=new(StringComparer.Ordinal);
        private readonly HtmlNode node;private string script="";
        private JsonArray actions=null!;private IReadOnlyDictionary<string,Component> catalog=null!;
        private readonly Dictionary<string,string> expressions=new();private readonly HashSet<string> names=new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string,string> handlers=new(StringComparer.Ordinal);
        private readonly Dictionary<string,string> labels=new(StringComparer.Ordinal);private readonly List<(JsonObject,string)> labelTargets=[];
        private readonly Dictionary<string,string> idClasses=new(StringComparer.Ordinal);
        private string Owner=> (Kind=="block"?"IMobileBlock:":"IMobileScreen:")+Name;
        private string Scope=>"avc-"+Hash(Name+":"+Kind);
        private string Owned=>Scope+"-owned";
        public Component(HtmlNode node,string nativeName)
        {
            this.node=node;Name=nativeName;Kind=node.Attribute("kind")??"block";
            foreach(var attribute in node.Attributes)if(attribute.Key is not ("name" or "kind" or "roles"))throw Error(node,"unknown component declaration attribute "+attribute.Key);
            if(Kind is not ("block" or "screen"))throw Error(node,"kind must be block or screen");
            ScreenSpecification.Name(JsonValue.Create(Name));
            var scripts=node.Elements.Where(n=>n.Tag=="script").ToArray();if(scripts.Length>1)throw Error(node,"one module script per component");
            if(scripts.Length==0)return;
            if(scripts[0].Attribute("type")!="module")throw Error(scripts[0],"script type must be module");
            foreach(var attribute in scripts[0].Attributes)if(attribute.Key!="type")throw Error(scripts[0],"unsupported script attribute "+attribute.Key);
            script=string.Concat(scripts[0].Children.Select(n=>n.Text));
            var program=new JavaScriptParser().ParseModule(script);
            foreach(var statement in program.Body)
            {
                if(statement is ImportDeclaration)continue; // Already resolved by the source binder.
                var declaration=statement is ExportNamedDeclaration export?export.Declaration:statement;
                if(declaration is FunctionDeclaration fn) {
                    if(fn.Async || fn.Generator)throw Error(node,"component handlers are synchronous; async/generator functions require an explicit asynchronous effect contract");
                    if(fn.Params.Any(p=>p is not Identifier))throw Error(node,"function parameters require plain names");
                    var name=fn.Id!.Name;if(!functions.TryAdd(name,fn))throw Error(node,"duplicate function "+name);continue;}
                if(statement is not ExportNamedDeclaration || declaration is not VariableDeclaration vars)throw Error(node,"module contains only exported declarations and function declarations; imports/runtime top-level code are not compiled");
                foreach(var variable in vars.Declarations)
                {
                    if(variable.Id is not Identifier id)throw Error(node,"declarations require an identifier");
                    if(id.Name is "inputs" or "events")
                    {
                        if(variable.Init is not ObjectExpression obj)throw Error(node,id.Name+" must be a typed object declaration");
                        foreach(var property in obj.Properties.Cast<Property>())
                        {
                            var key=Key(property.Key);
                            if(id.Name=="inputs")Inputs.Add(ReadField(key,property.Value));
                            else {if(property.Value is not ObjectExpression payload)throw Error(node,"event payload requires typed fields");Events.Add(key,payload.Properties.Cast<Property>().Select(p=>ReadField(Key(p.Key),p.Value)).ToList());}
                        }
                    }
                    else
                    {
                        if(variable.Init is ObjectExpression or ArrayExpression)
                        {
                            var value=UiValueShape.Infer(variable.Init);state.Add(new Field(id.Name,value.Shape.NativeType,Shape:value.Shape,Initial:value.Value));
                        }
                        else {var value=LiteralValue(variable.Init);state.Add(new Field(id.Name,value.Type,value.Expression));}
                        if(vars.Kind.ToString().Equals("Const",StringComparison.OrdinalIgnoreCase))constants.Add(id.Name);
                    }
                }
            }
            if(Inputs.Concat(state).Select(f=>f.Name).Distinct(StringComparer.Ordinal).Count()!=Inputs.Count+state.Count)throw Error(node,"duplicate input/state name");
            var symbols=Inputs.Concat(state).Select(f=>f.Name).Concat(functions.Keys).ToArray();
            if(symbols.Distinct(StringComparer.OrdinalIgnoreCase).Count()!=symbols.Length)throw Error(node,"input, state and function names must be distinct in the native model");
            foreach(var symbol in symbols.Concat(functions.Values.SelectMany(f=>f.Params.OfType<Identifier>().Select(p=>p.Name))))
            {
                if(symbol is "emit" or "$parameters" || symbol.StartsWith("__av",StringComparison.Ordinal))throw Error(node,"reserved component runtime name: "+symbol);
                ScreenSpecification.Name(JsonValue.Create(symbol));
            }
            foreach(var fn in functions.Values)
            {
                foreach(var member in Walk(fn.Body).OfType<MemberExpression>().Where(m=>m.Object is Identifier {Name:"emit"}))
                {
                    if(member.Computed || !Events.ContainsKey(Key(member.Property)))throw Error(node,"emit requires a declared event name, such as emit.changed(payload)");
                    if(!Walk(fn.Body).OfType<CallExpression>().Any(c=>ReferenceEquals(c.Callee,member)))throw Error(node,"event emitters must be called directly; aliases cannot preserve native event semantics");
                }
            }
        }
        public IEnumerable<Component> Dependencies(IReadOnlyDictionary<string,Component> all) => node.Descendants().Where(n=>!n.IsText && all.ContainsKey(n.SourceTag)).Select(n=>all[n.SourceTag]).Distinct();
        public JsonObject Compile(IReadOnlyDictionary<string,Component> all,JsonArray targetActions)
        {
            catalog=all;actions=targetActions;
            var body=node.Children.Where(n=>n.Tag is not ("style" or "script")).ToArray();
            var widgets=Widgets(body,"Root");
            var css=string.Join("\n",node.Elements.Where(n=>n.Tag=="style").Select(n=>string.Concat(n.Children.Select(t=>t.Text))));
            var stylesheet=CssStylesheet.Parse(css).MapIds(idClasses).ScopedOwned("."+Scope,"."+Owned);
            // Neutralize framework defaults without outranking the author's scoped selectors.
            stylesheet=":where(."+Scope+" ."+Owned+").ThemeGrid_MarginGutter{margin-left:0}\n:where(."+Scope+" ."+Owned+").OSFillParent{width:auto}\n"+stylesheet;
            var root=Widget("IContainer","Root",new JsonObject{["Style"]=Quote(Scope+" "+Owned)});root["children"]=widgets;
            var owner=new JsonObject{["name"]=Name,["type"]=Kind=="block"?"IMobileBlock":"IMobileScreen",["flow"]="MainFlow",["properties"]=new JsonObject{["StyleSheet"]=stylesheet},["inputs"]=Fields(Inputs),["vars"]=Fields(state),["widgets"]=new JsonArray(root)};
            foreach(var input in owner["inputs"]!.AsArray().OfType<JsonObject>()) input["mandatory"]=!input.ContainsKey("default");
            if(Kind=="block") {owner["properties"]!["Public"]=true;owner["blockEvents"]=new JsonArray(Events.Select(e=>(JsonNode)new JsonObject{["name"]=e.Key,["mandatory"]=true,["inputs"]=Fields(e.Value)}).ToArray());}
            else {owner["roles"]=new JsonArray((node.Attribute("roles")??"Registered").Split(',').Select(s=>(JsonNode)s.Trim()).ToArray());owner["widgets"]=new JsonArray(new JsonObject{["type"]="IMobileBlockInstanceWidget",["name"]="Layout",["source"]="IMobileBlock:LayoutBlank",["properties"]=new JsonObject(),["slots"]=new JsonObject{["Content"]=new JsonArray(root.DeepClone())}});}
            var widgetPaths=new Dictionary<string,string>(StringComparer.Ordinal);
            var actualWidgets=new Dictionary<string,JsonObject>(StringComparer.Ordinal);
            void Paths(JsonArray tree,string parent)
            {
                foreach(var widget in tree.OfType<JsonObject>())
                {
                    var name=widget["name"]!.ToString();var path=parent+"/"+name;widgetPaths[name]=path;actualWidgets[name]=widget;
                    if(widget["children"] is JsonArray children)Paths(children,path);
                    foreach(var slot in widget["slots"] as JsonObject??new JsonObject())Paths(slot.Value!.AsArray(),path+"/"+slot.Key);
                }
            }
            Paths(owner["widgets"]!.AsArray(),Owner);
            foreach(var (label,id) in labelTargets){if(!labels.TryGetValue(id,out var target))throw Error(node,"label target not found: "+id);actualWidgets[label["name"]!.ToString()]["properties"]!["TargetWidget"]=widgetPaths[target];}
            if(owner["roles"] is JsonArray roles && roles.Any(r=>r!.ToString()=="Anonymous") && !roles.Any(r=>r!.ToString()=="Registered")) roles.Add("Registered");
            var lifecycle=new JsonObject();foreach(var (js,native) in new[]{("onInitialize","OnInitialize"),("onReady","OnReady"),("onRender","OnRender"),("onDestroy","OnDestroy"),("onParametersChanged","OnParametersChanged")})if(functions.ContainsKey(js))lifecycle[native]=Handler(js,[]);
            var initialize=new JsonArray();
            foreach(var f in state.Where(f=>f.Shape!=null))
            {
                var decode="Initial_"+f.Name;
                initialize.Add(DecodeValue(decode,Quote(f.Shape!.EncodeInitial(f.Initial!).ToJsonString()),f.Type));
                initialize.Add(new JsonObject{["assign"]=new JsonObject{[f.Name]=decode+".Data"}});
            }
            if(initialize.Count>0)
            {
                if(lifecycle["OnInitialize"] is JsonObject binding)
                {
                    var destination=binding["destination"]!.ToString().Split('/').Last();
                    var steps=actions.OfType<JsonObject>().Single(a=>a["owner"]?.ToString()==Owner&&a["name"]?.ToString()==destination)["steps"]!.AsArray();
                    for(var i=initialize.Count-1;i>=0;i--)steps.Insert(0,initialize[i]!.DeepClone());
                }
                else
                {
                    var actionName=Name+"_InitializeState";
                    actions.Add(new JsonObject{["name"]=actionName,["kind"]="screen",["owner"]=Owner,["description"]="anvil:ui handler "+Name+"/initialize-state",["steps"]=initialize});
                    lifecycle["OnInitialize"]=new JsonObject{["destination"]=Owner+"/"+actionName};
                }
            }
            owner["events"]=lifecycle;return owner;
        }
        private JsonArray Widgets(IEnumerable<HtmlNode> children,string path)
        {
            var result=new JsonArray();var index=0;
            foreach(var child in children)
            {
                var at=path+"_"+(index++);
                if(child.IsText)
                {
                    var text=child.Text;var start=0;
                    while(start<text.Length)
                    {
                        var open=text.IndexOf("{{",start,StringComparison.Ordinal);var literal=open<0?text[start..]:text[start..open];
                        if(!string.IsNullOrWhiteSpace(literal))result.Add(Text(System.Text.RegularExpressions.Regex.Replace(literal,@"\s+"," "),at+"_text"+start));
                        if(open<0)break;var end=text.IndexOf("}}",open+2,StringComparison.Ordinal);if(end<0)throw Error(child,"unclosed interpolation");
                        result.Add(Widget("IExpression",at+"_expr"+open,new JsonObject{["Value"]=Expression(text[(open+2)..end],"Text"),["Style"]=Quote(Owned)}));start=end+2;
                    }
                    continue;
                }
                if(child.Attribute("if") is string condition)
                {
                    var clean=new HtmlNode(child.Tag,child.Attributes.Where(a=>a.Key!="if").ToArray(),child.Text,child.Line,child.Column){SourcePath=child.SourcePath,SourceTag=child.SourceTag};clean.Children.AddRange(child.Children);
                    result.Add(new JsonObject{["type"]="IIfWidget",["name"]=Safe(at+"_condition"),["properties"]=new JsonObject{["Condition"]=Expression(condition,"Boolean")},["slots"]=new JsonObject{["TrueBranch"]=Widgets([clean],at+"_true"),["FalseBranch"]=new JsonArray()}});continue;
                }
                var name=child.Attribute("id")??child.Attribute("name")??at;name=Safe(name);
                if(!names.Add(name))throw Error(child,"duplicate widget identity "+name+"; give distinct id attributes");
                if(catalog.TryGetValue(child.SourceTag,out var component)) {result.Add(Instance(child,name,component));continue;}
                if(child.Tag=="slot") {if(Kind!="block")throw Error(child,"slots belong to blocks");if(child.Children.Any(c=>!c.IsText||!string.IsNullOrWhiteSpace(c.Text)))throw Error(child,"slot fallback is not implemented; supply content in the consumer");result.Add(Widget("IPlaceholderWidget",Required(child,"name"),new JsonObject{["StyleClasses"]=Quote(Owned)}));continue;}
                var type=child.Tag switch {"div"=>"IContainer","button"=>"IButton","input" when child.Attribute("type")=="checkbox"=>"ICheckbox","input"=>"IInput","textarea"=>"ITextArea","label"=>"ILabel",_=>"IAdvancedHtml"};
                if(child.Tag is "script" or "style" or "iframe" or "form" or "select" or "option")throw Error(child,"unsupported element "+child.Tag);
                var control=type is "IInput" or "ITextArea" or "ICheckbox";
                if(child.Attribute("onclick")!=null && type!="IButton")throw Error(child,"onclick currently requires a native button");
                if(child.Attribute("onchange")!=null && !control)throw Error(child,"onchange requires a native control");
                if(!control && (child.Attribute("bind:value")!=null || child.Attribute("bind:checked")!=null))throw Error(child,"state bindings require a native control");
                if(child.Attribute(":id")!=null)throw Error(child,"widget identity must be a static id");
                var properties=new JsonObject();var widget=Widget(type,name,properties);var attrs=new JsonObject();widget["attributes"]=attrs;
                var classes=(child.Attribute("class")??"")+" "+Owned;
                if(child.Attribute("id") is string id){var idClass=Scope+"-id-"+Hash(id);idClasses.Add(id,idClass);classes+=" "+idClass;}
                var classExpression=Quote(classes.Trim());
                if(child.Attribute(":class") is string dynamicClass)classExpression+=" + \" \" + "+Expression(dynamicClass,"Text");
                if(type=="IAdvancedHtml"){properties["Tag"]=child.Tag;attrs["class"]=classExpression;}else properties["Style"]=classExpression;
                foreach(var (key,value) in child.Attributes)
                {
                    if(key is "id" or "name" or "class" or ":class" or "slot" or "onclick" or "onchange" or "bind:value" or "bind:checked")continue;
                    if(type=="ILabel" && key=="for")continue;
                    if((control || type=="IButton") && key is "disabled" or ":disabled")continue;
                    if(control && key is "type" or "placeholder" or ":placeholder" or "required" or ":required" or "maxlength" or "rows")continue;
                    if(key.StartsWith("on",StringComparison.OrdinalIgnoreCase))throw Error(child,"unsupported native event "+key);
                    if(key is "style" or ":style")CssStylesheet.RequireRenderableInline(value);
                    if(key.StartsWith(':'))attrs[key[1..]]=Expression(value,"Text");else attrs[key]=Quote(value);
                }
                if(type=="ILabel")labelTargets.Add((widget,Required(child,"for")));
                if(control || type=="IButton")properties["Enabled"]=child.Attribute(":disabled") is string disabled?"not ("+Expression(disabled,"Boolean")+")":child.Attribute("disabled")!=null?"False":"True";
                if(type=="IButton")
                {
                    widget["events"]=new JsonObject{["OnClick"]=Handler(Required(child,"onclick").Replace("()",""),[])};
                }
                if(control)
                {
                    var variable=Required(child,type=="ICheckbox"?"bind:checked":"bind:value");var field=state.SingleOrDefault(f=>f.Name==variable)??throw Error(child,"binding must name local state");
                    if(constants.Contains(variable))throw Error(child,"control binding cannot write a const declaration: "+variable);
                    properties["Variable"]=variable;labels[child.Attribute("id")??name]=name;
                    if(type=="ICheckbox" && field.Type!="Boolean")throw Error(child,"checkbox requires boolean state");
                    if(type!="ICheckbox")
                    {
                        properties["Mandatory"]=child.Attribute(":required") is string required?Expression(required,"Boolean"):child.Attribute("required")!=null?"True":"False";
                        if(child.Attribute(":placeholder") is string prompt)properties["Prompt"]=Expression(prompt,"Text");else if(child.Attribute("placeholder") is string literal)properties["Prompt"]=Quote(literal);
                        if(child.Attribute("maxlength") is string maximum)properties["MaxLength"]=int.Parse(maximum,System.Globalization.CultureInfo.InvariantCulture);
                        if(type=="ITextArea" && child.Attribute("rows") is string rows)properties["TextLines"]=int.Parse(rows,System.Globalization.CultureInfo.InvariantCulture);
                        if(type=="IInput")properties["InputType"]=(child.Attribute("type")??"text") switch {"text"=>"Text","password"=>"Password","number"=>"Number","time"=>"Time","date"=>"Date","datetime-local"=>"Datetime","tel"=>"Phone","email"=>"Email","search"=>"Search",var other=>throw Error(child,"unsupported input type "+other)};
                    }
                    if(child.Attribute("onchange") is string handler)widget["events"]=new JsonObject{["OnChange"]=Handler(handler.Replace("()",""),[])};
                }
                var inner=Widgets(child.Children,at);
                if(control && inner.Count>0)throw Error(child,"bound controls cannot contain child content; initialize their state in the script");
                if(type=="IAdvancedHtml")widget["slots"]=new JsonObject{["Content"]=inner};else if(!control)widget["children"]=inner;
                result.Add(widget);
            }
            return result;
        }
        private JsonObject Instance(HtmlNode html,string name,Component definition)
        {
            var allowed = new HashSet<string>(definition.Inputs.SelectMany(f=>new[]{f.Name,":"+f.Name}).Concat(definition.Events.Keys.Select(e=>"@"+e)).Concat(new[]{"id","slot"}),StringComparer.OrdinalIgnoreCase);
            foreach(var attribute in html.Attributes)if(!allowed.Contains(attribute.Key))throw Error(html,"unknown component attribute "+attribute.Key);
            var w=Widget("IMobileBlockInstanceWidget",name,new JsonObject());w["source"]=definition.NativeReference??"IMobileBlock:"+definition.Name;
            var args=new JsonObject();foreach(var field in definition.Inputs)
            {
                var dynamic=html.Attribute(":"+field.Name);var literal=html.Attribute(field.Name);
                if(dynamic!=null && literal!=null)throw Error(html,"input supplied twice: "+field.Name);
                if(definition.NativeReference!=null && (dynamic!=null||literal!=null) && !NativePrimitive(field.Type))
                {
                    // An Int64 literal is compiled directly as a native expression, without a JS Number round-trip.
                    if(dynamic==null && field.Type=="Long Integer" && long.TryParse(literal,System.Globalization.NumberStyles.AllowLeadingSign,System.Globalization.CultureInfo.InvariantCulture,out var integer))
                    {args[field.Name]=integer.ToString(System.Globalization.CultureInfo.InvariantCulture);continue;}
                    throw Error(html,"native input "+field.Name+" uses "+field.Type+"; its high-code codec is not implemented");
                }
                if(dynamic!=null)args[field.Name]=Expression(dynamic,field.Type);else if(literal!=null)args[field.Name]=field.Type=="Text"?Quote(literal):literal;
                else if(field.Default==null)throw Error(html,"missing required input "+field.Name);
            }
            w["args"]=args;var events=new JsonObject();foreach(var ev in definition.Events){var handler=html.Attribute("@"+ev.Key);if(handler==null){if(definition.optionalEvents.Contains(ev.Key))continue;throw Error(html,"missing event handler @"+ev.Key);}if(definition.NativeReference!=null&&ev.Value.Any(p=>!NativePrimitive(p.Type)))throw Error(html,"native event "+ev.Key+" requires a high-code codec for its payload");events[ev.Key]=Handler(handler,ev.Value);}w["events"]=events;
            var slots=new JsonObject();foreach(var group in html.Children.Where(n=>!n.IsText||!string.IsNullOrWhiteSpace(n.Text)).GroupBy(n=>n.Attribute("slot")??"Content"))slots[group.Key]=Widgets(group,name+"_"+group.Key);
            var declaredSlots=definition.nativeSlots??definition.node.Descendants().Where(n=>n.Tag=="slot").Select(n=>Required(n,"name")).ToHashSet(StringComparer.Ordinal);
            foreach(var slot in slots)if(!declaredSlots.Contains(slot.Key))throw Error(html,"unknown component slot "+slot.Key);
            w["slots"]=slots;return w;
        }
        private static bool NativePrimitive(string type)=>type is "Text" or "Integer" or "Decimal" or "Boolean";
        public IEnumerable<JsonObject> EventStructures()
        {
            foreach(var field in state.Where(f=>f.Shape!=null))foreach(var structure in field.Shape!.Structures())yield return structure;
            if(Events.Count==0)yield break;
            yield return new JsonObject{["name"]=Name+"_EventEnvelope",["attributes"]=Fields([new Field("EventName","Text"),new Field("Payload","Text")])};
            foreach(var ev in Events.Where(e=>e.Value.Count>0))yield return new JsonObject{["name"]=Name+"_Event_"+ev.Key,["attributes"]=Fields(ev.Value)};
        }
        private IEnumerable<KeyValuePair<string,List<Field>>> UsedEvents(string entry)
        {
            var used=new HashSet<string>(StringComparer.Ordinal);var visited=new HashSet<string>(StringComparer.Ordinal);
            void Visit(string name)
            {
                if(!visited.Add(name) || !functions.TryGetValue(name,out var function))return;
                foreach(var call in Walk(function.Body).OfType<CallExpression>())
                {
                    if(call.Callee is Identifier helper)Visit(helper.Name);
                    if(call.Callee is MemberExpression member && member.Object is Identifier {Name:"emit"})
                    {
                        var ev=Key(member.Property);if(!Events.ContainsKey(ev))throw Error(node,"unknown emitted event "+ev);used.Add(ev);
                    }
                }
            }
            Visit(entry);return Events.Where(e=>used.Contains(e.Key));
        }
        private static IEnumerable<Node> Walk(Node node){yield return node;foreach(var child in node.ChildNodes)foreach(var descendant in Walk(child))yield return descendant;}
        private FunctionDeclaration[] ReferencedFunctions(Node node)
        {
            var found=new Dictionary<string,FunctionDeclaration>(StringComparer.Ordinal);
            void Visit(Node body){foreach(var call in Walk(body).OfType<CallExpression>())if(call.Callee is Identifier id && functions.TryGetValue(id.Name,out var fn) && found.TryAdd(id.Name,fn))Visit(fn.Body);}
            Visit(node);return found.Values.ToArray();
        }
        private string FunctionSource(IEnumerable<FunctionDeclaration> selected)=>string.Join("\n",selected.Distinct().Select(f=>script[f.Range.Start..f.Range.End]));
        private JsonObject Handler(string name,IReadOnlyList<Field> payload)
        {
            if(!functions.TryGetValue(name,out var fn))throw Error(node,"unknown handler "+name);
            if(fn.Params.Count!=payload.Count)throw Error(node,$"handler {name} takes {fn.Params.Count} parameters; event provides {payload.Count}");
            // Event parameters live inside a native screen action. Prefix their native names so a
            // perfectly ordinary JS callback parameter cannot shadow a screen/block local variable.
            var parameters=payload.Select((p,i)=>new Field("arg_"+((Identifier)fn.Params[i]).Name,p.Type)).ToArray();
            var signature=name+":"+string.Join(",",parameters.Select(p=>p.Type));
            var actionName=Name+"_Handler_"+name+(parameters.Length==0?"":"_"+Hash(signature));
            JsonObject Binding()=>new(){["destination"]=Owner+"/"+actionName,["args"]=new JsonObject(payload.Select((f,i)=>KeyValuePair.Create(parameters[i].Name,(JsonNode?)JsonValue.Create(f.Name))))};
            // A source function belongs to the component, not to each button/instance that uses it.
            if(!handlers.TryAdd(signature,actionName))return Binding();
            var usedEvents=UsedEvents(name).ToArray();
            var captures=Inputs.Concat(state).ToArray();var jsInputs=captures.Select(f=>new Field("read_"+f.Name,WireType(f))).Concat(parameters.Select(f=>new Field("event_"+f.Name,f.Type))).ToArray();
            var jsOutputs=state.Select(f=>new Field("write_"+f.Name,WireType(f))).ToList();
            foreach(var f in state.Where(f=>f.Shape!=null))jsOutputs.Add(new Field("changed_"+f.Name,"Boolean"));
            if(usedEvents.Length>0)jsOutputs.Add(new Field("EventQueue","Text"));
            var steps=new JsonArray();var args=new JsonObject();
            foreach(var f in captures)args["read_"+f.Name]=CaptureValue(f,steps);
            foreach(var f in parameters)args["event_"+f.Name]=f.Name;
            var code=new StringBuilder();if(captures.Any(f=>f.Shape!=null))code.AppendLine(UiValueShape.JavaScript);
            foreach(var f in Inputs)code.AppendLine($"const {f.Name} = {ReadValue(f,"$parameters.read_"+f.Name,true)};");
            foreach(var f in state)code.AppendLine($"{(constants.Contains(f.Name)?"const":"let")} {f.Name} = {ReadValue(f,"$parameters.read_"+f.Name)};");
            foreach(var f in state.Where(f=>f.Shape!=null))code.AppendLine($"const __avOriginal_{f.Name}=JSON.stringify({f.Shape!.Encode(f.Name)});");
            code.AppendLine("const __avEvents=[]; const emit = {");
            foreach(var ev in usedEvents)
            {
                code.Append(ev.Key).AppendLine("(value={}){");
                var message=System.Text.Json.JsonSerializer.Serialize(Name+"."+ev.Key+": event payload does not match its declared fields");
                var keys=System.Text.Json.JsonSerializer.Serialize(ev.Value.Select(f=>f.Name));
                code.AppendLine($"if(value===null || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!{keys}.includes(k))) throw new TypeError({message});");
                foreach(var field in ev.Value)
                {
                    var value="value["+System.Text.Json.JsonSerializer.Serialize(field.Name)+"]";
                    var valid=field.Type switch {"Text"=>$"typeof {value}==='string'","Boolean"=>$"typeof {value}==='boolean'","Integer"=>$"Number.isInteger({value}) && {value}>=-2147483648 && {value}<=2147483647","Decimal"=>$"typeof {value}==='number' && Number.isFinite({value})",_=>$"{value}!==undefined && {value}!==null"};
                    code.AppendLine($"if(!({valid})) throw new TypeError({message});");
                }
                code.Append("__avEvents.push({EventName:").Append(System.Text.Json.JsonSerializer.Serialize(ev.Key)).AppendLine(",Payload:JSON.stringify(value)});},");
            }
            code.AppendLine("};").AppendLine(FunctionSource(new[]{fn}.Concat(ReferencedFunctions(fn.Body)))).Append(name).Append('(').Append(string.Join(",",parameters.Select(f=>"$parameters.event_"+f.Name))).AppendLine(");");
            foreach(var f in state)code.AppendLine($"$parameters.write_{f.Name}={(f.Shape==null?f.Name:"JSON.stringify("+f.Shape.Encode(f.Name)+")")};");
            foreach(var f in state.Where(f=>f.Shape!=null))code.AppendLine($"$parameters.changed_{f.Name}=($parameters.write_{f.Name}!==__avOriginal_{f.Name});");
            if(usedEvents.Length>0)code.AppendLine("$parameters.EventQueue=JSON.stringify(__avEvents);");
            steps.Add(new JsonObject{["node"]="IJavaScriptNode",["as"]="Run",["properties"]=new JsonObject{["JavaScript"]=code.ToString()},["inputs"]=Fields(jsInputs),["outputs"]=Fields(jsOutputs),["args"]=args});
            var writes=new JsonObject();
            foreach(var f in state)
            {
                if(f.Shape==null)writes[f.Name]="Run.write_"+f.Name;
                else {var decode="Write_"+f.Name;steps.Add(DecodeValue(decode,"Run.write_"+f.Name,f.Type));writes[f.Name]="If(Run.changed_"+f.Name+", "+decode+".Data, "+f.Name+")";}
            }
            if(writes.Count>0)steps.Add(new JsonObject{["assign"]=writes});
            if(usedEvents.Length>0)
            {
                steps.Add(new JsonObject{["node"]="IJSONDeserializeNode",["as"]="DecodeEvents",["properties"]=new JsonObject{["JSONString"]="Run.EventQueue",["DataType"]=Name+"_EventEnvelope List",["DateFormat"]="ISO"}});
                var dispatch=new JsonArray();
                foreach(var ev in usedEvents)
                {
                    var branch=new JsonArray();var payloadName="Decode_"+ev.Key;
                    if(ev.Value.Count>0)branch.Add(new JsonObject{["node"]="IJSONDeserializeNode",["as"]=payloadName,["properties"]=new JsonObject{["JSONString"]="DecodeEvents.Data.Current.Payload",["DataType"]=Name+"_Event_"+ev.Key,["DateFormat"]="ISO"}});
                    branch.Add(new JsonObject{["node"]="ITriggerNode",["as"]="Emit"+ev.Key,["properties"]=new JsonObject{["Event"]=Owner+"/"+ev.Key},["args"]=new JsonObject(ev.Value.Select(f=>KeyValuePair.Create(f.Name,(JsonNode?)JsonValue.Create(payloadName+".Data."+f.Name))))});
                    dispatch.Add(new JsonObject{["if"]="DecodeEvents.Data.Current.EventName = "+Quote(ev.Key),["then"]=branch});
                }
                steps.Add(new JsonObject{["foreach"]="DecodeEvents.Data",["as"]="DispatchEvents",["do"]=dispatch});
            }
            actions.Add(new JsonObject{["name"]=actionName,["kind"]="screen",["owner"]=Owner,["description"]="anvil:ui handler "+Name+"/"+signature,["inputs"]=Fields(parameters),["steps"]=steps});
            return Binding();
        }
        private string Expression(string expression,string type)
        {
            var parsed=new JavaScriptParser().ParseExpression(expression);
            var helpers=ReferencedFunctions(parsed);
            if(helpers.Any(f=>UsedEvents(f.Id!.Name).Any()))throw Error(node,"template expressions cannot emit events");
            if(Walk(parsed).Any(n=>n is AssignmentExpression or UpdateExpression))throw Error(node,"template expressions cannot assign state");
            var helperSource=FunctionSource(helpers);
            var referenced=Walk(parsed).Concat(helpers.SelectMany(f=>Walk(f.Body))).OfType<Identifier>().Select(i=>i.Name).ToHashSet(StringComparer.Ordinal);
            var capture=Inputs.Concat(state).Where(f=>referenced.Contains(f.Name)).Select(f=>f with { Default=null }).ToArray();
            var key=type+":"+expression+":"+string.Join(",",capture.Select(f=>f.Name+":"+f.Type))+":"+helperSource;
            if(!expressions.TryGetValue(key,out var name))
            {
                name=Name+"_Expr_"+Hash(key);expressions.Add(key,name);var code=new StringBuilder();
                var steps=new JsonArray();var args=new JsonObject();
                if(capture.Any(f=>f.Shape!=null))code.AppendLine(UiValueShape.JavaScript);
                foreach(var f in capture){args[f.Name]=CaptureValue(f,steps);code.AppendLine($"const {f.Name}={ReadValue(f,"$parameters."+f.Name,true)};");}
                code.AppendLine(helperSource).Append("const value=(").Append(expression).AppendLine(");").AppendLine(type=="Text"?"$parameters.Result=value==null?'':String(value);":"$parameters.Result=value;");
                steps.Add(new JsonObject{["node"]="IJavaScriptNode",["as"]="Evaluate",["properties"]=new JsonObject{["JavaScript"]=code.ToString()},["inputs"]=Fields(capture.Select(f=>f with {Type=WireType(f)})),["outputs"]=Fields([new Field("Result",type)]),["args"]=args});
                steps.Add(new JsonObject{["assign"]=new JsonObject{["Result"]="Evaluate.Result"}});
                actions.Add(new JsonObject{["name"]=name,["kind"]="client",["description"]="anvil:ui expression "+Name+"/"+Hash(key),["function"]=true,["inputs"]=Fields(capture),["outputs"]=Fields([new Field("Result",type)]),["steps"]=steps});
            }
            return name+"("+string.Join(",",capture.Select(f=>f.Name))+")";
        }
        private static string WireType(Field field)=>field.Shape==null?field.Type:"Text";
        private static string ReadValue(Field field,string source,bool readOnly=false)=>field.Shape==null?source:field.Shape.Decode("JSON.parse("+source+")",readOnly);
        private static string CaptureValue(Field field,JsonArray steps)
        {
            if(field.Shape==null)return field.Name;
            var name="Read_"+field.Name;
            steps.Add(new JsonObject{["node"]="IJSONSerializeNode",["as"]=name,["properties"]=new JsonObject{["Data"]=field.Name,["DateFormat"]="ISO",["SerializeDefaultValues"]=true}});
            return name+".JSON";
        }
        private static JsonObject DecodeValue(string name,string expression,string type)=>new(){["node"]="IJSONDeserializeNode",["as"]=name,["properties"]=new JsonObject{["JSONString"]=expression,["DataType"]=type,["DateFormat"]="ISO"}};
        private JsonObject Text(string text,string name)=>Widget("ITextWidget",Safe(name),new JsonObject{["Text"]=text,["StyleClasses"]=Quote(Owned)});
        private static JsonObject Widget(string type,string name,JsonObject props)=>new(){["type"]=type,["name"]=name,["properties"]=props};
        private static Field ReadField(string name,Node value)
        {
            if(value is Literal literal && literal.Value is string type)return new Field(name,NativeType(type));
            if(value is ObjectExpression obj){var fields=obj.Properties.Cast<Property>().ToDictionary(p=>Key(p.Key));var typ=(fields["type"].Value as Literal)?.Value as string??throw new ArgumentException("input type must be literal");return new Field(name,NativeType(typ),fields.TryGetValue("default",out var def)?LiteralValue(def.Value).Expression:null);}
            throw new ArgumentException("typed declaration requires a type string or {type,default}");
        }
        private static string NativeType(string type) => type switch { "string"=>"Text", "boolean"=>"Boolean", "integer"=>"Integer", "number"=>"Decimal", "datetime"=>"Date Time", _=>type };
        private static (string Type,string Expression) LiteralValue(Node? value)=>value is Literal literal?literal.Value switch {string s=>("Text",Quote(s)),bool b=>("Boolean",b?"True":"False"),double n when double.IsFinite(n)=>(n==Math.Truncate(n)&&n>=int.MinValue&&n<=int.MaxValue?"Integer":"Decimal",n.ToString(System.Globalization.CultureInfo.InvariantCulture)),int n=>("Integer",n.ToString()),_=>throw new ArgumentException("state/default requires a text, boolean or finite numeric literal")}:throw new ArgumentException("state/default requires a literal");
        private static string Key(Node key)=>key is Identifier id?id.Name:key is Literal {Value:string s}?s:throw new ArgumentException("declaration key must be a name");
    }
    private static JsonArray Fields(IEnumerable<Field> fields)=>new(fields.Select(f=>(JsonNode)new JsonObject{["name"]=f.Name,["type"]=f.Type}.WithDefault(f.Default)).ToArray());
    private static JsonObject WithDefault(this JsonObject field,string? value){if(value!=null)field["default"]=value;return field;}
    private static string Required(HtmlNode node,string key)=>node.Attribute(key)??throw Error(node,"missing "+key);
    private static ArgumentException Error(HtmlNode node,string text)=>new($"{node.SourcePath??"UI"} line {node.Line} col {node.Column}: {text}");
    private static string Quote(string value)=>"\""+value.Replace("\"","\"\"")+"\"";
    private static string Hash(string value)=>Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)))[..10].ToLowerInvariant();
    private static string Safe(string value)=>"N"+string.Concat(value.Select(c=>char.IsLetterOrDigit(c)||c=='_'?c:'_'));
}
