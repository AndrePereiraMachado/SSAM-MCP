using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Esprima;
using Esprima.Ast;

namespace Anvil.Core;

/// <summary>Immutable authored files. In-memory app bundles never read the filesystem.</summary>
public sealed class UiSourceBundle
{
    public string Entry { get; }
    public IReadOnlyDictionary<string, string> Files { get; }
    private UiSourceBundle(string entry, Dictionary<string, string> files) { Entry=entry; Files=new System.Collections.ObjectModel.ReadOnlyDictionary<string,string>(files); }

    public static UiSourceBundle From(JsonNode source)
    {
        if(source is JsonValue text && text.TryGetValue<string>(out var html))
            return new("main.html",new(StringComparer.OrdinalIgnoreCase) { ["main.html"]=html });
        if(source is not JsonObject obj || obj.Count!=2 || obj["entry"] is not JsonValue || obj["files"] is not JsonObject files)
            throw new ArgumentException("uiSource requires HTML text or {entry, files: {relativePath: sourceText}}");
        var entry=PathName(obj["entry"]!.GetValue<string>());
        var sources=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        foreach(var file in files)
        {
            if(file.Value is not JsonValue value || !value.TryGetValue<string>(out var content))throw new ArgumentException("UI file contents must be text: "+file.Key);
            if(!sources.TryAdd(PathName(file.Key),content))throw new ArgumentException("Duplicate UI file path: "+file.Key);
        }
        if(!sources.ContainsKey(entry))throw new ArgumentException("UI entry file not supplied: "+entry);
        return new(entry,sources);
    }
    public static UiSourceBundle Read(string entryPath)
    {
        var entry=Path.GetFullPath(entryPath);
        var root=SourceRoot(entry);
        var files=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        var visiting=new List<string>();
        void Visit(string name)
        {
            if(visiting.Contains(name,StringComparer.OrdinalIgnoreCase))throw new ArgumentException("UI import cycle: "+string.Join(" -> ",visiting.Append(name)));
            if(files.ContainsKey(name))return;
            var path=Path.GetFullPath(Path.Combine(root,name));
            if(!File.Exists(path))throw new ArgumentException("UI source file not found: "+name);
            var source=File.ReadAllText(path);files.Add(name,source);visiting.Add(name);
            foreach(var component in UiSourceProgram.ParseFile(name,source))
                foreach(var import in component.Imports)if(!UiNativeImport.IsNative(import.Path))Visit(Resolve(name,import.Path));
            visiting.RemoveAt(visiting.Count-1);
        }
        var logical=PathName(Path.GetRelativePath(root,entry).Replace(Path.DirectorySeparatorChar,'/'));Visit(logical);return new(logical,files);
    }
    public static string SourceRoot(string entryPath)
    {
        var directory=Path.GetDirectoryName(Path.GetFullPath(entryPath))!;
        return JobRunner.RepoRoot(directory)??directory;
    }
    public JsonObject ToJson()=>new() { ["entry"]=Entry,["files"]=new JsonObject(Files.OrderBy(f=>f.Key,StringComparer.Ordinal).Select(f=>KeyValuePair.Create(f.Key,(JsonNode?)JsonValue.Create(f.Value)))) };
    public static string Resolve(string owner,string import)
    {
        if(!import.StartsWith("./",StringComparison.Ordinal)&&!import.StartsWith("../",StringComparison.Ordinal))
            throw new ArgumentException($"{owner}: UI import '{import}' must name a relative HTML source file; native module imports require outsystems:Module/Flow");
        var slash=owner.LastIndexOf('/');return PathName((slash<0?"":owner[..(slash+1)])+import);
    }
    internal static string PathName(string path)
    {
        if(string.IsNullOrWhiteSpace(path)||path.StartsWith('/')||path.Contains('\\')||path.Contains(':')||path.Contains('?')||path.Contains('#'))
            throw new ArgumentException("UI source path must be a relative HTML path: "+path);
        var parts=new List<string>();
        foreach(var part in path.Split('/'))
        {
            if(part is "" or ".")continue;
            if(part=="..") {if(parts.Count==0)throw new ArgumentException("UI import escapes the source bundle: "+path);parts.RemoveAt(parts.Count-1);}
            else parts.Add(part);
        }
        var result=string.Join('/',parts);
        if(!result.EndsWith(".html",StringComparison.OrdinalIgnoreCase))throw new ArgumentException("UI component imports currently require .html files: "+path);
        return result;
    }
}

public sealed record UiImport(string Path,string? Export,string Local,int Line,int Column);
public sealed class UiComponentSource(string path,HtmlNode node,IReadOnlyList<UiImport> imports)
{
    public string Path {get;}=path;
    public HtmlNode Node {get;}=node;
    public string ExportName {get;}=node.Attribute("name")??throw new ArgumentException(path+": component name required");
    public string NativeName {get; internal set;}="";
    public IReadOnlyList<UiImport> Imports {get;}=imports;
    public Dictionary<string,UiComponentSource> Symbols {get;}=new(StringComparer.Ordinal);
    public Dictionary<string,UiNativeImport> NativeSymbols {get;}=new(StringComparer.Ordinal);
}

/// <summary>Parsed sources and lexically bound component symbols, independent of native emission.</summary>
public sealed class UiSourceProgram
{
    public IReadOnlyList<UiComponentSource> Components {get;}
    private UiSourceProgram(IReadOnlyList<UiComponentSource> components)=>Components=components;
    public static UiSourceProgram Bind(UiSourceBundle bundle)
    {
        var files=new Dictionary<string,UiComponentSource[]>(StringComparer.OrdinalIgnoreCase);
        var stack=new List<string>();
        void Visit(string path)
        {
            if(stack.Contains(path,StringComparer.OrdinalIgnoreCase))throw new ArgumentException("UI import cycle: "+string.Join(" -> ",stack.Append(path)));
            if(files.ContainsKey(path))return;
            if(!bundle.Files.TryGetValue(path,out var source))throw new ArgumentException("UI source file not supplied: "+path);
            var declarations=ParseFile(path,source);files.Add(path,declarations);stack.Add(path);
            foreach(var c in declarations)foreach(var import in c.Imports)
            {
                try { if(UiNativeImport.IsNative(import.Path))UiNativeImport.Parse(import);else Visit(UiSourceBundle.Resolve(path,import.Path)); }
                catch(ArgumentException error) {throw new ArgumentException($"{path}:{import.Line}:{import.Column}: {error.Message}",error);}
            }
            stack.RemoveAt(stack.Count-1);
        }
        Visit(bundle.Entry);
        var nativeNames=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach(var file in files)foreach(var c in file.Value)
        {
            // Entry names retain compatibility. Imported definitions are stable across aliases and consumers.
            c.NativeName=file.Key.Equals(bundle.Entry,StringComparison.OrdinalIgnoreCase)?c.ExportName:
                c.ExportName+"_U"+Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(file.Key.ToLowerInvariant())))[..10].ToLowerInvariant();
            if(!nativeNames.Add(c.NativeName))throw new ArgumentException(file.Key+": native component identity collision: "+c.NativeName);
            foreach(var local in file.Value)c.Symbols.Add(local.ExportName,local);
            foreach(var import in c.Imports)
            {
                if(UiNativeImport.IsNative(import.Path))
                {
                    if(c.Symbols.ContainsKey(import.Local)||!c.NativeSymbols.TryAdd(import.Local,UiNativeImport.Parse(import)))throw new ArgumentException(file.Key+": duplicate component symbol "+import.Local);
                    continue;
                }
                var target=files[UiSourceBundle.Resolve(file.Key,import.Path)];
                var matches=target.Where(t=>import.Export==null?t.Node.Attribute("kind") is null or "block":t.ExportName==import.Export).ToArray();
                if(matches.Length!=1)throw new ArgumentException($"{file.Key}:{import.Line}:{import.Column}: import {import.Local} requires exactly one matching export in {import.Path}");
                if(matches[0].Node.Attribute("kind")=="screen")throw new ArgumentException(file.Key+": cannot import a screen as a component: "+import.Local);
                if(c.NativeSymbols.ContainsKey(import.Local)||!c.Symbols.TryAdd(import.Local,matches[0]))throw new ArgumentException(file.Key+": duplicate component symbol "+import.Local);
            }
        }
        var reachable=new HashSet<UiComponentSource>();
        void Include(UiComponentSource c)
        {
            if(!reachable.Add(c))return;
            foreach(var node in c.Node.Descendants())if(!node.IsText&&c.Symbols.TryGetValue(node.SourceTag,out var child))Include(child);
        }
        foreach(var c in files[bundle.Entry])Include(c);
        return new(files.Values.SelectMany(c=>c).Where(reachable.Contains).ToArray());
    }
    internal static UiComponentSource[] ParseFile(string path,string source)
    {
        HtmlNode document;
        try { document=HtmlSource.Parse(source); }
        catch(Exception error) when(error is ArgumentException or InvalidOperationException) {throw new ArgumentException(path+": "+error.Message,error);}
        var nodes=document.Elements.ToArray();
        if(nodes.Length==0||nodes.Any(n=>n.Tag!="component")||document.Children.Any(n=>n.IsText&&!string.IsNullOrWhiteSpace(n.Text)))throw new ArgumentException(path+": UI source requires <component name=... kind=screen|block> roots");
        var result=new List<UiComponentSource>();var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach(var node in nodes)
        {
            foreach(var child in node.Descendants().Prepend(node))child.SourcePath=path;
            var imports=new List<UiImport>();
            foreach(var scriptNode in node.Elements.Where(n=>n.Tag=="script"))
            {
                var script=string.Concat(scriptNode.Children.Select(n=>n.Text));
                var origin=scriptNode.Children.FirstOrDefault()??scriptNode;
                Esprima.Ast.Module ast;
                try {ast=new JavaScriptParser().ParseModule(script);}
                catch(ParserException error) {throw new ArgumentException($"{path}:{origin.Line+error.LineNumber-1}:{error.Column+(error.LineNumber==1?origin.Column-1:0)}: {error.Description}",error);}
                foreach(var statement in ast.Body.OfType<ImportDeclaration>())
                {
                    if(statement.Specifiers.Count==0)throw new ArgumentException(path+": side-effect component imports are not supported");
                    foreach(var specifier in statement.Specifiers)
                    {
                        var (export,local)=specifier switch {
                            ImportDefaultSpecifier d=>((string?)null,d.Local.Name),
                            ImportSpecifier s when s.Imported is Identifier i=>(i.Name,s.Local.Name),
                            _=>throw new ArgumentException(path+": use a default or named component import")};
                        imports.Add(new UiImport((string)statement.Source.Value!,export,local,origin.Line+statement.Location.Start.Line-1,statement.Location.Start.Column+(statement.Location.Start.Line==1?origin.Column:1)));
                    }
                }
            }
            var component=new UiComponentSource(path,node,imports);
            if(!names.Add(component.ExportName))throw new ArgumentException(path+": Duplicate component name "+component.ExportName);
            result.Add(component);
        }
        return result.ToArray();
    }
}
