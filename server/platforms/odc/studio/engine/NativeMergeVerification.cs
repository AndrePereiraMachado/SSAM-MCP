using System.Text.RegularExpressions;
using System.Text.Json;
#if !NATIVE_MERGE_OFFLINE
using OutSystems.Model;
using OutSystems.Model.Logic.Nodes;
using OutSystems.Model.Merge;
using ServiceStudio.Model;
#endif

// Native merge can recreate empty grid metadata and property-owned wrapper identities.
// Only those inert additions are accepted; all other native differences remain errors.
// One more native recreation is accepted: the Studio may re-key the parameters of a JavaScript node. The node keeps
// its JavaScript text, each parameter is removed and added back with the same name and data type, and the consumers
// keep their expression text (they differ only because the referenced key changed). The model proves the data type;
// the comparison dump proves everything else. Any other difference around that node keeps the strict refusal.
// One known class of loss is named instead of refused as unknown: a Default Value the Studio removed (Anvil.Core.MergeOrder:
// it removes a default it marks read-only when a merge sets the element's type). With lostDefaults (parent and element name,
// value) the dump lines of exactly that shape are excused, so a merge that lost only those defaults is proven otherwise equal.
// A second known class: a Delete Rule the Studio set to Ignore when the merge set the attribute's type (AbstractEntityAttribute
// OnTypeChanged: the environment lacks DeleteRuleOnSystemReferences/DeleteRuleOnReferences for that reference), with the
// automatic index it then drops (Escala Viva, lab 02, 2026-10-03). The dump itself names them (ForcedDeleteRules).
// Two more known classes, both deterministic rewrites of the ODC Studio's merge, named by the dump (Normalizations):
// the Max. Records of a Refresh Data node, which the merge sets to the refreshed aggregate's Max. Records (50 for 200 and
// 100 in labs 10 and 61, 2026-10-04/05), and the Public property of a structure, which an app keeps False (labs 31 and 35:
// three structures of QuizLive Web asked Public True). Anything else keeps the strict refusal; Divergences lists it, one
// entry per differing element or property, for an answer without a .NET stack trace.
// Validate is Studio-free (the bridge tests compile it with NATIVE_MERGE_OFFLINE).
internal static class NativeMergeVerification {
 public record LayoutAddition(string Parent,string Name,string? EffectiveValue,string Owner);
 // A default the live module lost: the element (Parent.Name in the dump), the expected default text.
 public record LostDefault(string Parent,string Name,string Value);
 // A Delete Rule the Studio forced to Ignore on Parent.Name; Requested is the candidate's rule.
 public record ForcedDeleteRule(string Parent,string Name,string Requested);
 // A property the Studio rewrote on merge: Kind "Refresh Data" (Max. Records) or "Structure" (Public); Parent is the
 // dump parent's name (the client action of the refresh, the Structures folder), Element the node's name.
 public record Normalization(string Kind,string Parent,string Element,string Property,string Local,string Candidate);
 // One difference of the comparison: the element (names from the module down, folders left out), its kind, the property
 // (null for an element added or removed) and the value on each side (local = the module after the merge).
 public record Divergence(string Element,string Kind,string? Property,string? Local,string? Candidate);
 public record Proof(bool NativeSemanticEquivalent,bool StrictlyEqual,int EmptyLayoutProperties,LayoutAddition[] Additions);
 // A JavaScript node parameter whose key differs between the merged and the expected model while its name does not.
 // Kind is "Input Parameter" or "Output Parameter"; Equivalent means same data type and same node JavaScript text.
 public record ParameterRecreation(string Action,string Node,string Kind,string Name,bool Equivalent);
 static readonly HashSet<string> LayoutNames=new(){"GridColumns","GridRows","ColumnGap","RowGap","ColumnSpan","RowSpan"};
 static void Require(bool pass,string message){if(!pass)throw new InvalidOperationException(message);}
#if !NATIVE_MERGE_OFFLINE
 public static Proof Verify(ESpace live,ESpace expected,IReadOnlySet<string> owners,string output,LostDefault[]? lostDefaults=null,ForcedDeleteRule[]? forcedDeleteRules=null,Normalization[]? normalizations=null,IconChange[]? icons=null){
  string Identity(CustomProperty p)=>p.Parent.Key.ToString()!.Split('/').Last().Split('.').Last()+"/"+p.Name;
  var existing=expected.GetAllChildrenOfType<CustomProperty>().Select(Identity).ToHashSet();
  var added=live.GetAllChildrenOfType<CustomProperty>().Where(p=>!existing.Contains(Identity(p))).Select(p=>new LayoutAddition(p.Parent.Key.ToString()!,p.Name,p.EffectiveValue?.ToString(),OwnerOf(p))).ToArray();
  var recreated=Recreations(live,expected);
  if(recreated.Length>0)File.WriteAllText(output+".recreated-parameters.json",JsonSerializer.Serialize(recreated,new JsonSerializerOptions{WriteIndented=true}));
  using var tree=new MatchTree(live,expected,expected,false,true);var dump=tree.Dump();File.WriteAllText(output,dump);
  Validate(dump,added,owners,recreated,lostDefaults,forcedDeleteRules,normalizations,icons);
  var proof=new Proof(true,tree.HasNoDifferences,added.Length,added);File.WriteAllText(output+".proof.json",JsonSerializer.Serialize(proof,new JsonSerializerOptions{WriteIndented=true}));return proof;
 }
 // The owner is the screen or block that holds the widget, by name. The key segment after NodesShownInESpaceTree names the
 // first tree node, which for a block of another UI flow (Menu in Common) is not the block, so it is only the fallback.
 static string OwnerOf(CustomProperty p){
  static object? Member(object o,string name)=>o.GetType().GetProperties().FirstOrDefault(x=>x.Name==name&&x.GetIndexParameters().Length==0)?.GetValue(o);
  for(object? o=p.Parent;o!=null;o=Member(o,"Parent"))
   if(o.GetType().GetInterfaces().Any(i=>i.Name is "IMobileScreen" or "IMobileBlock"))return Member(o,"Name")?.ToString()??"";
  return Regex.Match(p.Parent.Key.ToString()!,@"NodesShownInESpaceTree\.([^/]+)").Groups[1].Value;
 }
 // JavaScript nodes matched by key; a parameter of the merged node with no same-key counterpart but exactly one
 // same-name, same-kind counterpart that the merged node no longer has is a recreation.
 static ParameterRecreation[] Recreations(ESpace live,ESpace expected){
  static IEnumerable<IModelObject> Walk(IModelObject root){var stack=new Stack<IModelObject>();stack.Push(root);while(stack.Count>0){var n=stack.Pop();yield return n;foreach(var c in n.Children)stack.Push(c);}}
  static string? TypeOf(IModelObject? t){try{return t==null?null:t.Key?.ToString()+"|"+t.DisplayName;}catch{return null;}}
  var before=new Dictionary<string,IJavaScriptNode>();
  foreach(var n in Walk((IESpace)expected).OfType<IJavaScriptNode>())before.TryAdd(n.Key.ToString()!,n);
  var found=new List<ParameterRecreation>();
  foreach(var now in Walk((IESpace)live).OfType<IJavaScriptNode>()){
   if(!before.TryGetValue(now.Key.ToString()!,out var was))continue;
   var action=now.Parent?.DisplayName??"";
   void Compare(string kind,(string Key,string Name,string? Type)[] mine,(string Key,string Name,string? Type)[] theirs){
    foreach(var p in mine.Where(p=>theirs.All(t=>t.Key!=p.Key))){
     var same=theirs.Where(t=>t.Name==p.Name&&mine.All(m=>m.Key!=t.Key)).ToArray();
     if(same.Length==1)found.Add(new ParameterRecreation(action,now.Name,kind,p.Name,p.Type!=null&&p.Type==same[0].Type&&now.JavaScript==was.JavaScript));
    }
   }
   Compare("Input Parameter",now.InputParameters.Select(p=>(p.Key.ToString()!,p.Name,TypeOf(p.DataType))).ToArray(),was.InputParameters.Select(p=>(p.Key.ToString()!,p.Name,TypeOf(p.DataType))).ToArray());
   Compare("Output Parameter",now.OutputParameters.Select(p=>(p.Key.ToString()!,p.Name,TypeOf(p.DataType))).ToArray(),was.OutputParameters.Select(p=>(p.Key.ToString()!,p.Name,TypeOf(p.DataType))).ToArray());
  }
  return found.ToArray();
 }
 // G-1 IconConversion: the icon widgets of a model (CustomProperty children Icon and Weight of one widget) and the ODC
 // Studio's own conversion table, read from the NRWidgets plugin loaded in this process (IconLibraryProvider: the old
 // library FontAwesome4.0 to the default Phosphor2.0, 588 entries in 1.7.27). No table, no proof: the strict refusal stays.
 public static IconChange[] IconConversions(ESpace live,ESpace expected){
  var table=ConversionTable.Value;
  return table.Count==0?Array.Empty<IconChange>():ProveIconConversions(IconFacts(live),IconFacts(expected),table);
 }
 static IEnumerable<IconFact> IconFacts(ESpace model){
  foreach(var widget in model.GetAllChildrenOfType<CustomProperty>().Where(p=>p.Name is "Icon" or "Weight").GroupBy(p=>p.Parent)){
   string? Value(string name){try{return widget.FirstOrDefault(p=>p.Name==name)?.EffectiveValue?.ToString();}catch{return null;}}
   string name;try{name=widget.Key.DisplayName;}catch{continue;}
   var icon=Value("Icon");if(icon==null)continue;
   yield return new IconFact(widget.Key.Key.ToString()!,name,icon,Value("Weight")??"");
  }
 }
 static readonly Lazy<IReadOnlyDictionary<string,(string Icon,string Weight)>> ConversionTable=new(()=>{
  var table=new Dictionary<string,(string,string)>(StringComparer.Ordinal);
  try{
   var type=AppDomain.CurrentDomain.GetAssemblies().Where(a=>a.GetName().Name=="OutSystems.Model.Plugin.NRWidgets")
    .Select(a=>a.GetType("ServiceStudio.Plugin.NRWidgets.IconLibraryProvider")).FirstOrDefault(t=>t!=null);
   var provider=type?.GetProperty("Instance")?.GetValue(null);
   if(type==null||provider==null)return table;
   var from=type.GetProperty("OldIconLibrary")?.GetValue(provider)?.ToString()??"FontAwesome4.0";
   var to=type.GetProperty("DefaultIconLibrary")?.GetValue(provider)?.ToString()??"Phosphor2.0";
   if(type.GetMethod("GetIconConversionMapping")?.Invoke(provider,new object?[]{from,to}) is not System.Collections.IDictionary mapping)return table;
   foreach(System.Collections.DictionaryEntry e in mapping){
    var v=e.Value;if(v==null)continue;
    var icon=v.GetType().GetProperty("IconName")?.GetValue(v)?.ToString();
    if(!string.IsNullOrEmpty(icon))table[e.Key.ToString()!]=(icon,v.GetType().GetProperty("Weight")?.GetValue(v)?.ToString()??"");
   }
  }catch{table.Clear();}
  return table;
 });
#endif
 public static void Validate(string dump,LayoutAddition[] added,IReadOnlySet<string> owners,ParameterRecreation[]? recreated=null,LostDefault[]? lostDefaults=null,ForcedDeleteRule[]? forcedDeleteRules=null,Normalization[]? normalizations=null,IconChange[]? icons=null){
  Require(added.All(p=>LayoutNames.Contains(p.Name)&&p.EffectiveValue==null&&owners.Contains(p.Owner)),"Native merge contains nonempty or out-of-scope layout metadata");
  var lines=dump.Split('\n');
  var excused=RecreatedJavaScriptParameters(lines,recreated??Array.Empty<ParameterRecreation>());
  excused.UnionWith(LostDefaultLines(lines,lostDefaults??Array.Empty<LostDefault>()));
  excused.UnionWith(ForcedDeleteRuleLines(lines,forcedDeleteRules??Array.Empty<ForcedDeleteRule>()));
  excused.UnionWith(NormalizationLines(lines,normalizations??Array.Empty<Normalization>(),icons));
  excused.UnionWith(DerivedReferenceHashLines(lines));
  var count=0;
  for(var i=0;i<lines.Length;i++){
   if(excused.Contains(i))continue;
   var line=lines[i];
   Require(!line.Contains("Removed")&&!line.Contains("AddedToForeign")&&!line.Contains("ChangedInForeign")&&!line.Contains("Conflict"),"Native merge lost or conflicts with candidate content");
   if(line.Contains("AddedToLocal")){Require(Regex.IsMatch(line,@"\(Object CustomProperty\) (GridColumns|GridRows|ColumnGap|RowGap|ColumnSpan|RowSpan) \[AddedToLocal\]\r?$"),"Unexpected native object addition");count++;}
   if(line.Contains(">>"))Require(line.Contains("Content[The ")&&line.Contains("DifferenceInLocalChildren"),"Native property differs from the candidate: "+line.Trim());
   if(line.Contains("[ChangedInLocal")&&!line.Contains(">>"))Require(line.Contains("DifferenceInLocalChildren"),"Native object differs from the candidate: "+line.Trim());
  }
  Require(count==added.Length,"Native layout additions do not match the complete comparison");
 }

 // ---- Recreated JavaScript parameters, read from the MatchTree dump
 sealed class DumpNode{public int Line;public int Depth;public string Kind="";public string Name="";public HashSet<string> Flags=new();public DumpNode? Parent;public readonly List<DumpNode> Children=new();public readonly List<DumpProperty> Properties=new();}
 // A ">> Name[local] / Name[candidate] [flags]" record; a multi-line value spans lines First..Last.
 sealed record DumpProperty(int First,int Last,string Name,string? Value,bool SameOnBothSides,HashSet<string> Flags,string Body="");
 static readonly Regex NodeLine=new(@"^(?:((?:\|    )*)\+-- )?\((Object [^)]+|Folder)\) (.*?)(?: \[([A-Za-z]+(?:, [A-Za-z]+)*)\])?\r?$");
 static readonly Regex PropertyLine=new(@"^(?:\|    )*\|\s+>> (.*?)\r?$");
 static readonly Regex Connector=new(@"^[| ]*\r?$");
 static readonly Regex Flagged=new(@"^(.*) \[([A-Za-z]+(?:, [A-Za-z]+)*)\](?: \[Not Visible\])?$",RegexOptions.Singleline);
 static HashSet<string> FlagSet(string? flags)=>flags==null?new():flags.Split(", ").ToHashSet();
 static bool Structural(string[] lines,int i)=>i>=lines.Length||NodeLine.IsMatch(lines[i])||PropertyLine.IsMatch(lines[i])||Connector.IsMatch(lines[i]);
 static DumpProperty ReadProperty(string[] lines,int first){
  var text=PropertyLine.Match(lines[first]).Groups[1].Value;
  for(var last=first;last<lines.Length;last++){
   if(last>first)text+="\n"+lines[last].TrimEnd('\r');
   var flagged=Flagged.Match(text);
   if(!flagged.Success||!Structural(lines,last+1))continue;
   var body=flagged.Groups[1].Value;var flags=FlagSet(flagged.Groups[2].Value);
   var name=body.Contains('[')?body[..body.IndexOf('[')]:"";
   var half=(body.Length-3)/2;
   var same=name.Length>0&&body.Length%2==1&&body.Substring(half,3)==" / "&&body[..half]==body[(half+3)..]&&body[..half].StartsWith(name+"[",StringComparison.Ordinal)&&body[..half].EndsWith(']');
   return new DumpProperty(first,last,name,same?body[(name.Length+1)..(half-1)]:null,same,flags,body);
  }
  return new DumpProperty(first,first,"",null,false,new(),PropertyLine.Match(lines[first]).Groups[1].Value);
 }
 static List<DumpNode> ReadTree(string[] lines){
  var nodes=new List<DumpNode>();var path=new List<DumpNode>();
  for(var i=0;i<lines.Length;i++){
   if(PropertyLine.IsMatch(lines[i])){var p=ReadProperty(lines,i);path.LastOrDefault()?.Properties.Add(p);i=p.Last;continue;}
   var m=NodeLine.Match(lines[i]);if(!m.Success)continue;
   var depth=m.Groups[1].Success?m.Groups[1].Value.Length/5+1:0;
   var node=new DumpNode{Line=i,Depth=depth,Kind=m.Groups[2].Value,Name=m.Groups[3].Value,Flags=FlagSet(m.Groups[4].Success?m.Groups[4].Value:null)};
   while(path.Count>0&&path[^1].Depth>=depth)path.RemoveAt(path.Count-1);
   node.Parent=path.LastOrDefault();node.Parent?.Children.Add(node);path.Add(node);nodes.Add(node);
  }
  return nodes;
 }
 // ODC recomputes these derived hashes when it loads an imported AI model connection.
 // Only non-visible GUID hashes on unchanged referenced action/structure nodes qualify.
 // Producer identity, signatures, parameters, types and every other property still pass strict validation.
 static readonly Regex DerivedReferenceHash=new(@"^(?:\|    )*\|\s+>> (CompatibilitySignatureHash|FullSignatureHash)\[([0-9a-fA-F-]{36})\] / \1\[([0-9a-fA-F-]{36})\] \[ChangedInLocal\] \[Not Visible\]\r?$");
 static HashSet<int> DerivedReferenceHashLines(string[] lines){
  var accepted=new HashSet<int>();
  foreach(var node in ReadTree(lines).Where(n=>n.Kind is "Object Server Action" or "Object Structure" && n.Flags.SetEquals(new[]{"None"}))){
   var reference=node.Parent;
   while(reference!=null&&reference.Kind!="Object Reference")reference=reference.Parent;
   if(reference==null||!reference.Flags.SetEquals(new[]{"None"}))continue;
   foreach(var p in node.Properties){
    var match=DerivedReferenceHash.Match(lines[p.First]);
    if(p.First==p.Last&&match.Success&&Guid.TryParse(match.Groups[2].Value,out _)&&Guid.TryParse(match.Groups[3].Value,out _))accepted.Add(p.First);
   }
  }
  return accepted;
 }
 static IEnumerable<DumpNode> Descendants(DumpNode n){foreach(var c in n.Children){yield return c;foreach(var d in Descendants(c))yield return d;}}
 static IEnumerable<int> PropertyLines(DumpNode n)=>n.Properties.SelectMany(p=>Enumerable.Range(p.First,p.Last-p.First+1));
 static bool Within(HashSet<string> flags,params string[] allowed)=>flags.All(allowed.Contains);
 // ---- Lost defaults: "(Object X) Name [ChangedInLocal, DifferenceInLocalChildren]" under its Parent, whose only property is
 // ">> Default Value[] / Default Value[V] [RemovedFromLocal]" and whose only child is "(Object ParsedExpression) V [RemovedFromLocal]".
 static readonly Regex LostDefaultProperty=new(@"^(?:\|    )*\|\s+>> Default Value\[\] / Default Value\[(.*)\] \[RemovedFromLocal\]\r?$");
 static HashSet<int> LostDefaultLines(string[] lines,LostDefault[] lost){
  var excused=new HashSet<int>();
  if(lost.Length==0)return excused;
  foreach(var node in ReadTree(lines).Where(n=>n.Parent!=null&&n.Flags.SetEquals(new[]{"ChangedInLocal","DifferenceInLocalChildren"}))){
   var named=lost.Where(l=>l.Name==node.Name&&l.Parent==node.Parent!.Name).ToArray();
   if(named.Length!=1||node.Properties.Count!=1||node.Properties[0].First!=node.Properties[0].Last||node.Children.Count!=1)continue;
   var property=LostDefaultProperty.Match(lines[node.Properties[0].First]);
   var child=node.Children[0];
   if(!property.Success||property.Groups[1].Value!=named[0].Value)continue;
   if(child.Kind!="Object ParsedExpression"||child.Name!=named[0].Value||!child.Flags.SetEquals(new[]{"RemovedFromLocal"})||child.Children.Count>0||child.Properties.Count>0)continue;
   excused.Add(node.Line);excused.Add(node.Properties[0].First);excused.Add(child.Line);
  }
  return excused;
 }

 // ---- Forced delete rules: "(Object Entity Attribute) Name [ChangedInLocal]" whose only property is
 // ">> Delete Rule[Ignore] / Delete Rule[R] [ChangedInLocal]", with or without its sibling automatic index removed:
 // "(Object Index) AutoIndex_Name [RemovedFromLocal, ChangedInLocal, DifferenceInLocalChildren]" holding only
 // "(Object Entity Index Attribute) Name [RemovedFromLocal, ChangedInLocal]".
 static readonly Regex ForcedDeleteRuleProperty=new(@"^(?:\|    )*\|\s+>> Delete Rule\[Ignore\] / Delete Rule\[([A-Za-z]+)\] \[ChangedInLocal\]\r?$");
 static (DumpNode Attribute,string Requested,DumpNode? Index)[] ForcedDeleteRuleNodes(string[] lines){
  var found=new List<(DumpNode,string,DumpNode?)>();
  foreach(var node in ReadTree(lines).Where(n=>n.Kind=="Object Entity Attribute"&&n.Parent!=null&&n.Flags.SetEquals(new[]{"ChangedInLocal"}))){
   if(node.Children.Count>0||node.Properties.Count!=1||node.Properties[0].First!=node.Properties[0].Last)continue;
   var property=ForcedDeleteRuleProperty.Match(lines[node.Properties[0].First]);
   if(!property.Success||property.Groups[1].Value=="Ignore")continue;
   var index=node.Parent!.Children.SingleOrDefault(c=>c.Kind=="Object Index"&&c.Name=="AutoIndex_"+node.Name);
   if(index!=null&&!(index.Flags.SetEquals(new[]{"RemovedFromLocal","ChangedInLocal","DifferenceInLocalChildren"})&&index.Properties.Count==0&&index.Children.Count==1
      &&index.Children[0].Kind=="Object Entity Index Attribute"&&index.Children[0].Name==node.Name&&index.Children[0].Flags.SetEquals(new[]{"RemovedFromLocal","ChangedInLocal"})
      &&index.Children[0].Children.Count==0&&index.Children[0].Properties.Count==0))continue;
   found.Add((node,property.Groups[1].Value,index));
  }
  return found.ToArray();
 }
 public static ForcedDeleteRule[] ForcedDeleteRules(string dump)=>ForcedDeleteRuleNodes(dump.Split('\n')).Select(f=>new ForcedDeleteRule(f.Attribute.Parent!.Name,f.Attribute.Name,f.Requested)).ToArray();
 static HashSet<int> ForcedDeleteRuleLines(string[] lines,ForcedDeleteRule[] forced){
  var excused=new HashSet<int>();
  if(forced.Length==0)return excused;
  foreach(var (attribute,requested,index) in ForcedDeleteRuleNodes(lines)){
   if(!forced.Contains(new ForcedDeleteRule(attribute.Parent!.Name,attribute.Name,requested)))continue;
   excused.Add(attribute.Line);excused.UnionWith(PropertyLines(attribute));
   if(index!=null){excused.Add(index.Line);excused.Add(index.Children[0].Line);}
  }
  return excused;
 }

 // ---- Normalizations: "(Object Refresh Data) N [ChangedInLocal]" whose only property is
 // ">> Max. Records[L] / Max. Records[C] [ChangedInLocal]" (two different integers), and "(Object Structure) N [ChangedInLocal]"
 // whose only property is ">> Public[False] / Public[True] [ChangedInLocal]". Neither node may have children.
 // G-1 (C16, package 3): three more rewrites the ODC Studio makes on every merge, each a family of exact dump lines (I8 names
 // them by rule; the bridge answers ok:true, merged:true with one note per element when only these remain):
 //  - CustomNameTrio: "(Object Block) N [ChangedInLocal]" with exactly ">> CustomName[] / CustomName[X] [RemovedFromLocal]",
 //    ">> CustomNameIsSuffix[True] / CustomNameIsSuffix[False] [ChangedInLocal]" and ">> Name[N] / Name[X] [ChangedInLocal]"
 //    (a block instance created with a name: the Studio derives it from the block, CustomNameIsSuffix True; labs 18, 21, 22,
 //    30, 38 of 2026-10-06);
 //  - RefreshMaxRecordsRemoved: "(Object Refresh Data) N [None]" with only ">> Max. Records[] / Max. Records[C] [RemovedFromLocal]"
 //    (a Data Action has no Max. Records: the Studio drops it; labs 21, 22, 24);
 //  - IconConversion: "(Object Icon) N [DifferenceInLocalChildren]" whose only children are "(Object CustomProperty) Icon" and/or
 //    "Weight", each [ChangedInLocal] with one ">> Icon[L] / Icon[C]" (">> Weight[L] / Weight[C]"), excused only when the
 //    models prove that exact change of that widget and the Studio's own FontAwesome4.0 -> Phosphor2.0 table maps the
 //    candidate's icon to it (IconChange, ProveIconConversions; labs 22, 24, 30).
 // The " [Not Visible]" suffix of a property line is part of the dump's syntax (Flagged).
 public const string CustomNameTrio="CustomNameTrio",RefreshMaxRecordsRemoved="RefreshMaxRecordsRemoved",IconConversion="IconConversion";
 // The rules whose elements the merge kept as the Studio always writes them (with ForcedDeleteRule): merged and equal but for them.
 public static readonly IReadOnlySet<string> Rewrites=new HashSet<string>(StringComparer.Ordinal){CustomNameTrio,RefreshMaxRecordsRemoved,IconConversion};
 // An icon widget the merge changed as the Studio's conversion table says: its name, the candidate's icon and weight (From)
 // and the module's after the merge (To).
 public record IconChange(string Name,string FromIcon,string FromWeight,string ToIcon,string ToWeight);
 // An icon widget of a model: key, name, icon and weight (its CustomProperty children Icon and Weight).
 public record IconFact(string Key,string Name,string Icon,string Weight);
 // The widgets of the candidate (expected) whose icon or weight the merge changed (live) exactly as the table maps the
 // candidate's icon: table[icon] = (icon, weight), an empty weight keeping the candidate's. Any other change is not proven.
 // A widget is the same on both sides by its own key, the last segment of its key path: the merge re-keys the property-owned
 // wrappers above it (PlaceholderArguments, ChildPlaceholders of a block instance or a button's content), so the full paths
 // differ (offline replay of labs 22 and 24 of 2026-10-06: "cart-plus" in AddToCartButton/content, the same widget key
 // under re-keyed wrappers), as Identity in Verify reads them.
 static string OwnKey(string key)=>key.Split('/').Last().Split('.').Last();
 public static IconChange[] ProveIconConversions(IEnumerable<IconFact> live,IEnumerable<IconFact> expected,IReadOnlyDictionary<string,(string Icon,string Weight)> table){
  var now=live.GroupBy(f=>OwnKey(f.Key)).ToDictionary(g=>g.Key,g=>g.First());
  var proven=new List<IconChange>();
  foreach(var was in expected){
   if(!now.TryGetValue(OwnKey(was.Key),out var after)||after.Icon==was.Icon&&after.Weight==was.Weight)continue;
   if(!table.TryGetValue(was.Icon,out var target))continue;
   var weight=string.IsNullOrEmpty(target.Weight)?was.Weight:target.Weight;
   if(after.Icon==target.Icon&&after.Weight==weight)proven.Add(new IconChange(was.Name,was.Icon,was.Weight,after.Icon,after.Weight));
  }
  return proven.ToArray();
 }
 static readonly Regex MaxRecordsProperty=new(@"^(?:\|    )*\|\s+>> Max\. Records\[(\d+)\] / Max\. Records\[(\d+)\] \[ChangedInLocal\]\r?$");
 static readonly Regex StructurePublicProperty=new(@"^(?:\|    )*\|\s+>> Public\[False\] / Public\[True\] \[ChangedInLocal\]\r?$");
 static readonly Regex MaxRecordsRemovedProperty=new(@"^(?:\|    )*\|\s+>> Max\. Records\[\] / Max\. Records\[(\d+)\] \[RemovedFromLocal\](?: \[Not Visible\])?\r?$");
 static readonly Regex CustomNameRemovedProperty=new(@"^(?:\|    )*\|\s+>> CustomName\[\] / CustomName\[([^\]\r\n]+)\] \[RemovedFromLocal\](?: \[Not Visible\])?\r?$");
 static readonly Regex CustomNameSuffixProperty=new(@"^(?:\|    )*\|\s+>> CustomNameIsSuffix\[True\] / CustomNameIsSuffix\[False\] \[ChangedInLocal\](?: \[Not Visible\])?\r?$");
 static readonly Regex NameChangedProperty=new(@"^(?:\|    )*\|\s+>> Name\[([^\]\r\n]+)\] / Name\[([^\]\r\n]+)\] \[ChangedInLocal\](?: \[Not Visible\])?\r?$");
 static readonly Regex IconOrWeightProperty=new(@"^(?:\|    )*\|\s+>> (Icon|Weight)\[([^\]\r\n]*)\] / \1\[([^\]\r\n]*)\] \[ChangedInLocal\](?: \[Not Visible\])?\r?$");
 static bool SingleLines(DumpNode n)=>n.Properties.All(p=>p.First==p.Last);
 static (DumpNode Node,Normalization Normalization,int[] Lines)[] NormalizationNodes(string[] lines,IconChange[]? icons=null){
  var found=new List<(DumpNode,Normalization,int[])>();
  int[] Own(DumpNode n)=>PropertyLines(n).Append(n.Line).ToArray();
  foreach(var node in ReadTree(lines).Where(n=>n.Parent!=null&&SingleLines(n))){
   if(node.Flags.SetEquals(new[]{"ChangedInLocal"})&&node.Children.Count==0&&node.Properties.Count==1){
    var line=lines[node.Properties[0].First];
    if(node.Kind=="Object Refresh Data"&&MaxRecordsProperty.Match(line) is {Success:true} max&&max.Groups[1].Value!=max.Groups[2].Value)
     found.Add((node,new Normalization("Refresh Data",node.Parent!.Name,node.Name,"Max. Records",max.Groups[1].Value,max.Groups[2].Value),Own(node)));
    else if(node.Kind=="Object Structure"&&StructurePublicProperty.IsMatch(line))
     found.Add((node,new Normalization("Structure",node.Parent!.Name,node.Name,"Public","False","True"),Own(node)));
   }
   else if(node.Kind=="Object Block"&&node.Flags.SetEquals(new[]{"ChangedInLocal"})&&node.Children.Count==0&&node.Properties.Count==3){
    var props=node.Properties.Select(p=>lines[p.First]).ToArray();
    var custom=props.Select(l=>CustomNameRemovedProperty.Match(l)).SingleOrDefault(m=>m.Success);
    var name=props.Select(l=>NameChangedProperty.Match(l)).SingleOrDefault(m=>m.Success);
    if(custom!=null&&name!=null&&props.Count(l=>CustomNameSuffixProperty.IsMatch(l))==1
       &&name.Groups[1].Value==node.Name&&name.Groups[2].Value==custom.Groups[1].Value)
     found.Add((node,new Normalization(CustomNameTrio,node.Parent!.Name,node.Name,"Name",node.Name,custom.Groups[1].Value),Own(node)));
   }
   else if(node.Kind=="Object Refresh Data"&&node.Flags.SetEquals(new[]{"None"})&&node.Children.Count==0&&node.Properties.Count==1
           &&MaxRecordsRemovedProperty.Match(lines[node.Properties[0].First]) is {Success:true} removed)
    found.Add((node,new Normalization(RefreshMaxRecordsRemoved,node.Parent!.Name,node.Name,"Max. Records","",removed.Groups[1].Value),Own(node)));
   else if(node.Kind=="Object Icon"&&icons is {Length:>0}&&node.Flags.SetEquals(new[]{"DifferenceInLocalChildren"})&&node.Properties.Count==0
           &&node.Children.Count is 1 or 2&&node.Children.All(c=>c.Kind=="Object CustomProperty"&&c.Name is "Icon" or "Weight"&&c.Flags.SetEquals(new[]{"ChangedInLocal"})
              &&c.Children.Count==0&&c.Properties.Count==1&&c.Properties[0].First==c.Properties[0].Last)
           &&node.Children.Select(c=>c.Name).Distinct().Count()==node.Children.Count){
    var changes=node.Children.Select(c=>IconOrWeightProperty.Match(lines[c.Properties[0].First])).ToArray();
    if(changes.Any(m=>!m.Success)||changes.Zip(node.Children).Any(x=>x.First.Groups[1].Value!=x.Second.Name))continue;
    var icon=changes.FirstOrDefault(m=>m.Groups[1].Value=="Icon");var weight=changes.FirstOrDefault(m=>m.Groups[1].Value=="Weight");
    var proof=icons.Where(c=>c.Name==node.Name
      &&(icon==null?c.ToIcon==c.FromIcon:c.ToIcon==icon.Groups[2].Value&&c.FromIcon==icon.Groups[3].Value)
      &&(weight==null?c.ToWeight==c.FromWeight:c.ToWeight==weight.Groups[2].Value&&c.FromWeight==weight.Groups[3].Value)).ToArray();
    if(proof.Length==0)continue;
    found.Add((node,new Normalization(IconConversion,node.Parent!.Name,node.Name,"Icon",proof[0].ToIcon+"/"+proof[0].ToWeight,proof[0].FromIcon+"/"+proof[0].FromWeight),
     node.Children.SelectMany(Own).Append(node.Line).ToArray()));
   }
  }
  return found.ToArray();
 }
 public static Normalization[] Normalizations(string dump,IconChange[]? icons=null)=>NormalizationNodes(dump.Split('\n'),icons).Select(n=>n.Normalization).ToArray();
 static HashSet<int> NormalizationLines(string[] lines,Normalization[] named,IconChange[]? icons=null){
  var excused=new HashSet<int>();
  if(named.Length==0)return excused;
  foreach(var (_,normalization,own) in NormalizationNodes(lines,icons))
   if(named.Contains(normalization))excused.UnionWith(own);
  return excused;
 }

 // ---- Divergences: every element of the dump with a difference of its own, one entry per property (an element added or
 // removed without properties is one entry with its presence on each side). At most max entries, values clipped.
 static readonly string[] OwnFlags={"ChangedInLocal","AddedToLocal","RemovedFromLocal","AddedToForeign","RemovedFromForeign","ChangedInForeign","Conflict","Different"};
 public static Divergence[] Divergences(string dump,int max=50){
  static string Clip(string? s)=>s==null?"":s.Length<=200?s:s[..200]+"...";
  static string Element(DumpNode n){var names=new List<string>();for(var x=n;x!=null&&x.Parent!=null;x=x.Parent)if(x.Kind!="Folder")names.Add(x.Name);names.Reverse();return string.Join("/",names);}
  var result=new List<Divergence>();
  foreach(var node in ReadTree(dump.Split('\n')).Where(n=>n.Flags.Any(f=>OwnFlags.Contains(f)))){
   var kind=node.Kind.StartsWith("Object ",StringComparison.Ordinal)?node.Kind[7..]:node.Kind;
   var element=Element(node);
   var properties=node.Properties.Where(p=>p.Name.Length>0||p.Body.Length>0).ToList();
   if(properties.Count==0){
    var local=node.Flags.Contains("AddedToLocal")||node.Flags.Contains("RemovedFromForeign")?"present":node.Flags.Contains("RemovedFromLocal")||node.Flags.Contains("AddedToForeign")?"absent":string.Join(", ",node.Flags.Order());
    var candidate=local=="present"?"absent":local=="absent"?"present":local;
    result.Add(new Divergence(element,kind,null,local,candidate));
   }
   foreach(var p in properties){
    var (name,left,right)=SplitProperty(p.Body);
    result.Add(new Divergence(element,kind,name,Clip(left),Clip(right)));
   }
   if(result.Count>=max)break;
  }
  return result.Take(max).ToArray();
 }
 // "Name[local] / Name[candidate]" (flags already removed); a body of another shape keeps its text as the local side.
 static (string Name,string? Local,string? Candidate) SplitProperty(string body){
  var open=body.IndexOf('[');
  if(open<=0)return (body.Trim(),null,null);
  var name=body[..open];
  var separator="] / "+name+"[";
  var at=body.IndexOf(separator,open,StringComparison.Ordinal);
  if(at<0||!body.EndsWith(']'))return (name.Trim(),body[(open+1)..].TrimEnd(']'),null);
  return (name.Trim(),body[(open+1)..at],body[(at+separator.Length)..^1]);
 }

 // Line indexes of the dump explained by recreated JavaScript parameters. Nothing is excused for a node unless the
 // whole pattern holds: node flags, equal JavaScript text, paired parameters proven equivalent by the model.
 static HashSet<int> RecreatedJavaScriptParameters(string[] lines,ParameterRecreation[] recreated){
  var excused=new HashSet<int>();
  if(recreated.Length==0)return excused;
  foreach(var js in ReadTree(lines).Where(n=>n.Kind=="Object JavaScript"&&n.Flags.Contains("ChangedInLocal")&&n.Parent!=null)){
   if(!Within(js.Flags,"ChangedInLocal","DifferenceInLocalChildren"))continue;
   if(js.Properties.Any(p=>p.Name!="JavaScript"||!p.SameOnBothSides||!p.Flags.SetEquals(new[]{"ChangedInLocal"})))continue;
   if(js.Children.Any(c=>c.Kind!="Folder"||c.Name!="Parameters"||c.Flags.Count>0||c.Properties.Count>0))continue;
   var parameters=js.Children.SelectMany(c=>c.Children).ToList();
   if(parameters.Any(p=>p.Kind is not ("Object Input Parameter" or "Object Output Parameter")||p.Children.Count>0||p.Properties.Count>0))continue;
   var changed=parameters.Where(p=>p.Flags.Count>0).ToList();
   var pairs=changed.GroupBy(p=>(p.Kind,p.Name)).ToList();
   bool Paired(IGrouping<(string Kind,string Name),DumpNode> g){
    var items=g.ToList();if(items.Count!=2)return false;
    var addedNode=items.SingleOrDefault(p=>p.Flags.Contains("AddedToLocal")&&Within(p.Flags,"AddedToLocal","ChangedInLocal"));
    var removedNode=items.SingleOrDefault(p=>p.Flags.Contains("RemovedFromLocal")&&Within(p.Flags,"RemovedFromLocal","ChangedInLocal"));
    var proofs=recreated.Where(r=>r.Action==js.Parent!.Name&&r.Node==js.Name&&"Object "+r.Kind==g.Key.Kind&&r.Name==g.Key.Name).ToList();
    return addedNode!=null&&removedNode!=null&&proofs.Count>0&&proofs.All(r=>r.Equivalent);
   }
   if(pairs.Count==0||!pairs.All(Paired))continue;
   var references=pairs.Select(g=>new Regex(@"(?<![\w.])"+Regex.Escape(js.Name+"."+g.Key.Name)+@"(?!\w)")).ToList();
   excused.Add(js.Line);excused.UnionWith(PropertyLines(js));excused.UnionWith(changed.Select(p=>p.Line));
   // Consumers in the same action: their own difference is only the re-keyed reference, so their text is unchanged.
   var inside=Descendants(js).ToHashSet();
   foreach(var consumer in Descendants(js.Parent!).Where(n=>!inside.Contains(n)&&n!=js&&n.Flags.Contains("ChangedInLocal"))){
    if(!Within(consumer.Flags,"ChangedInLocal","DifferenceInLocalChildren")||consumer.Properties.Count==0)continue;
    if(!consumer.Properties.All(p=>p.SameOnBothSides&&p.Flags.SetEquals(new[]{"ChangedInLocal"})))continue;
    if(!consumer.Properties.Any(p=>references.Any(r=>r.IsMatch(p.Value!))))continue;
    excused.Add(consumer.Line);excused.UnionWith(PropertyLines(consumer));
   }
  }
  return excused;
 }
}
