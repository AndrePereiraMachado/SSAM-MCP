using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal enum DataKind { Entity, Structure, Enum, Catalog }
internal sealed record DataType(INamedTypeSymbol Symbol, string Name, DataKind Kind, SymbolNames Properties);
internal sealed record ValueType(string Native, bool Nullable, ITypeSymbol Source, DataType? Declaration = null, ValueType? Element = null, RuntimeCategory Category = RuntimeCategory.Value)
{
    public bool IsList => Element != null;
    public bool IsArenaReference => Category is RuntimeCategory.ObjectReference or RuntimeCategory.ListReference or RuntimeCategory.ReadOnlyListReference;
    public bool IsReadOnlyListReference => Category == RuntimeCategory.ReadOnlyListReference;
    public bool IsExceptionReference => Category == RuntimeCategory.ExceptionReference;
    public bool IsIdentity => Native.EndsWith(" Identifier",StringComparison.Ordinal);
    public TemporalKind Temporal => Native == "Date Time" ? TemporalKind.None : TemporalModel.Kind(Source);
}

/// <summary>The source type map is shared with logic. Nullable values have explicit presence, never sentinel equality.</summary>
internal sealed class DataModel
{
    private const string Sdk = "Anvil.Authoring.";
    private readonly SourceProgram program;
    private readonly Dictionary<INamedTypeSymbol, DataType> declarations = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<string, JsonObject> optionalTypes = new(StringComparer.Ordinal);
    private readonly Dictionary<string, JsonObject> recordTypes = new(StringComparer.Ordinal);
    private readonly List<JsonObject> mapping = [];
    private readonly HashSet<string> graphRepresentations = new(StringComparer.Ordinal);
    internal void RepresentByGraph(DataType type) => graphRepresentations.Add(type.Name);
    internal void ExportRuntimeType(string name)
    {
        if (recordTypes.TryGetValue(name, out var record)) record["public"] = true;
        if (optionalTypes.TryGetValue(name, out var optional)) optional["public"] = true;
    }
    public IReadOnlyCollection<DataType> Types => declarations.Values;
    internal Compilation Compilation => program.Compilation;
    internal bool IsException(ITypeSymbol type) => ExceptionTypes.IsException(type, program.Compilation);
    public JsonArray Mapping => new(mapping.Select(m => (JsonNode)m.DeepClone()).ToArray());

    public DataModel(SourceProgram program)
    {
        this.program = program;
        var types = program.Types.Where(t => !t.IsStatic && t.TypeKind is TypeKind.Class or TypeKind.Struct or TypeKind.Enum
            && !DerivesFrom(t, "System.Attribute") && !DerivesFrom(t, "System.Exception")).ToArray();
        var names = new SymbolNames(types, s => SourceProgram.TextAttribute(s, "System.ComponentModel.DataAnnotations.Schema.TableAttribute"));
        foreach (var symbol in types)
        {
            if (symbol.IsGenericType || symbol.IsAbstract || symbol.BaseType is {SpecialType: not SpecialType.System_Object} parent && parent.ToDisplayString() is not ("System.ValueType" or "System.Enum"))
                throw SourceProgram.Error("AVCS201", "Data declarations require concrete, non-inherited types", symbol);
            var kind = symbol.TypeKind == TypeKind.Enum ? DataKind.Enum : SourceProgram.Attribute(symbol, Sdk + "StaticEntityAttribute") != null ? DataKind.Catalog
                : SourceProgram.Attribute(symbol, Sdk + "EntityAttribute") != null || SourceProgram.Attribute(symbol, "System.ComponentModel.DataAnnotations.Schema.TableAttribute") != null ? DataKind.Entity : DataKind.Structure;
            var properties = SourceMembers(symbol).Select(m => m.Symbol).ToArray();
            declarations.Add(symbol, new(symbol, names[symbol], kind,
                new SymbolNames(properties, s => SourceProgram.TextAttribute(s, "System.ComponentModel.DataAnnotations.Schema.ColumnAttribute"))));
        }
    }
    internal DataType Declaration(INamedTypeSymbol type) => declarations.TryGetValue(type, out var result) ? result
        : throw SourceProgram.Error("AVCS202", "Type is not declared in this source bundle: " + type.ToDisplayString(), type);
    internal int IdentityBits(ValueType identity)
    {
        if (!identity.IsIdentity || identity.Declaration is not { } target)
            throw new ArgumentException("Native identity width requires a declared identity target.");
        if (target.Kind is DataKind.Enum or DataKind.Catalog) return 32;
        var key = Properties(target.Symbol).FirstOrDefault(Key);
        return key != null && Type(key.Type, key).Native == "Integer" ? 32 : 64;
    }
    internal string EnumMember(IFieldSymbol field)
    {
        var declaration = Declaration(field.ContainingType);
        var names = new SymbolNames(field.ContainingType.GetMembers().OfType<IFieldSymbol>().Where(f => f.HasConstantValue));
        return "Entities." + declaration.Name + "." + names[field];
    }
    internal ValueType Type(ITypeSymbol type, ISymbol location)
    {
        var nullable = type.NullableAnnotation == NullableAnnotation.Annotated;
        if (type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } option)
        { nullable = true; type = option.TypeArguments[0]; }
        var core = type.WithNullableAnnotation(NullableAnnotation.NotAnnotated);
        if (core.TypeKind == TypeKind.Delegate)
        {
            var name = SymbolNames.Allocate("AvClosure_" + SymbolNames.Digest(core.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)),
                candidate => declarations.Values.Any(declaration => declaration.Name.Equals(candidate, StringComparison.OrdinalIgnoreCase)));
            if (!recordTypes.ContainsKey(name)) AddRuntimeStructure(new JsonObject { ["name"] = name, ["public"] = false,
                ["description"] = "Invocation-local statically compiled delegate target and captured activation.",
                ["attributes"] = new JsonArray(new JsonObject { ["name"] = "Target", ["type"] = "Integer" }, new JsonObject { ["name"] = "Frame", ["type"] = "Integer" }) });
            return new(name, false, type, Category: RuntimeCategory.DelegateReference);
        }
        if (ExceptionTypes.IsException(core, program.Compilation))
        {
            if (core.Locations.Any(item => item.IsInSource))
                throw SourceProgram.Error("AVCS346", "Source exception classes require their constructor/member lowering; BCL payloads cannot stand in for them", location);
            return new(ExceptionHandle(), false, type, Category: RuntimeCategory.ExceptionReference);
        }
        if (TemporalModel.Kind(core) is not (TemporalKind.None or TemporalKind.DateTime) and var temporal)
            return TemporalType(type, temporal, nullable);
        if (core.ToDisplayString() == "System.DateTimeKind" && !core.Locations.Any(l => l.IsInSource))
            return new("Integer", nullable, type);
        if (core is IArrayTypeSymbol array)
        {
            if (array.Rank != 1) throw SourceProgram.Error("AVCS203", "Only one-dimensional arrays can be translated", location);
            if (array.ElementType.SpecialType == SpecialType.System_Byte) return new("Binary Data", nullable, type);
            var element = Type(array.ElementType, location);
            return new(Transport(element) + " List", nullable, type, Element: element);
        }
        if (core is INamedTypeSymbol named)
        {
            if(named.IsAnonymousType && !declarations.ContainsKey(named))
            {
                var properties=Properties(named).ToArray();
                var signature=string.Join(";",properties.Select(p=>p.Name+":"+p.Type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)+":"+p.NullableAnnotation));
                declarations.Add(named,new(named,"AvAnonymous_"+SymbolNames.Digest(signature),DataKind.Structure,new SymbolNames(properties)));
                foreach(var property in properties)Transport(Type(property.Type,location));
            }
            if (named.OriginalDefinition.ToDisplayString() == "Anvil.Authoring.Id<T>")
            {
                var target = Declaration((INamedTypeSymbol)named.TypeArguments[0]);
                if (target.Kind == DataKind.Structure) throw SourceProgram.Error("AVCS204", "An identity must refer to persisted data", location);
                return new(target.Name + " Identifier", nullable, type, target);
            }
            if (named.IsGenericType && named.OriginalDefinition.ToDisplayString() is "System.Collections.Generic.List<T>" or "System.Collections.Generic.IReadOnlyList<T>")
            {
                var element = Type(named.TypeArguments[0], location);
                return new(Transport(element) + " List", nullable, type, Element: element);
            }
            if (declarations.TryGetValue(named, out var declaration))
                return new(declaration.Kind == DataKind.Enum ? Type(named.EnumUnderlyingType!, location).Native : declaration.Name, nullable, type, declaration);
        }
        var native = core.SpecialType switch
        {
            SpecialType.System_String => "Text", SpecialType.System_Char => "Text", SpecialType.System_Boolean => "Boolean",
            SpecialType.System_Byte or SpecialType.System_SByte or SpecialType.System_Int16 or SpecialType.System_UInt16 or SpecialType.System_Int32 => "Integer",
            SpecialType.System_Int64 or SpecialType.System_UInt32 => "Long Integer", SpecialType.System_Decimal => "Decimal",
            SpecialType.System_DateTime => "Date Time",
            _ => null
        };
        if (native == null) throw SourceProgram.Error("AVCS205", "No native value translation is defined for " + type.ToDisplayString(), location);
        return new(native, nullable, type);
    }
    internal ValueType TemporalType(ITypeSymbol source, TemporalKind kind, bool nullable = false)
    {
        var name = "AvTemporal_" + kind;
        while (declarations.Values.Any(d => d.Name.Equals(name, StringComparison.OrdinalIgnoreCase))) name += "_";
        recordTypes.TryAdd(name, TemporalModel.Structure(name, kind));
        return new(name, nullable, source);
    }
    internal string Transport(ValueType type)
    {
        if (type.IsArenaReference || type.IsExceptionReference || type.Category == RuntimeCategory.NativeBuffer) return type.Native;
        var payload=type.Native;
        if(type.Declaration is {Kind:DataKind.Entity or DataKind.Catalog} declaration&&!type.IsIdentity)
        {
            payload="AvRecord_"+SymbolNames.Digest(declaration.Symbol.ToDisplayString());
            if(!recordTypes.ContainsKey(payload))
            {
                var attributes=new JsonArray();
                recordTypes.Add(payload,new JsonObject {["name"]=payload,["public"]=true,["attributes"]=attributes});
                foreach(var property in Properties(declaration.Symbol))
                {
                    var member=Type(property.Type,property);
                    if(member.Declaration is {Kind:DataKind.Entity or DataKind.Catalog}&&!member.IsIdentity)
                        throw SourceProgram.Error("AVCS228","Object navigation requires relationship loading; use the typed identity for explicit references until navigation is implemented",property);
                    attributes.Add(new JsonObject {["name"]=declaration.Properties[property],["type"]=Transport(member)});
                }
            }
        }
        if (!type.Nullable) return payload;
        var name = "AvOptional_" + SymbolNames.Digest(payload);
        optionalTypes.TryAdd(name, new JsonObject { ["name"] = name, ["public"] = true, ["attributes"] = new JsonArray(
            new JsonObject { ["name"] = "HasValue", ["type"] = "Boolean" }, new JsonObject { ["name"] = "Value", ["type"] = payload }) });
        return name;
    }
    internal void AddRuntimeStructure(JsonObject structure) => recordTypes.Add(structure["name"]!.ToString(), structure);
    private string? exceptionHandle;
    private string ExceptionHandle()
    {
        if (exceptionHandle != null) return exceptionHandle;
        exceptionHandle = SymbolNames.Allocate("AvExceptionRef", name => declarations.Values.Any(type => type.Name.Equals(name, StringComparison.OrdinalIgnoreCase)) || recordTypes.ContainsKey(name));
        AddRuntimeStructure(new JsonObject { ["name"] = exceptionHandle, ["public"] = false,
            ["description"] = "Invocation-local identity in the shared Exceptions pool; no public source codec is implied.",
            ["attributes"] = new JsonArray(new JsonObject { ["name"] = "Index", ["type"] = "Integer" }) });
        return exceptionHandle;
    }
    public JsonObject Emit(JsonNode? logic = null)
    {
        var entities = new JsonArray(); var structures = new JsonArray(); var statics = new JsonArray();
        foreach (var type in declarations.Values)
        {
            switch (type.Kind)
            {
                case DataKind.Entity: entities.Add(Entity(type)); break;
                case DataKind.Structure: structures.Add(Structure(type)); break;
                case DataKind.Enum: statics.Add(Enum(type)); break;
                case DataKind.Catalog: statics.Add(Catalog(type)); break;
            }
        }
        foreach (var record in recordTypes.Values.OrderBy(t => t["name"]!.ToString(), StringComparer.Ordinal)) structures.Add(record.DeepClone());
        foreach (var optional in optionalTypes.Values.OrderBy(t => t["name"]!.ToString(), StringComparer.Ordinal)) structures.Add(optional.DeepClone());
        var result = new JsonObject();
        if (entities.Count != 0) result["entities"] = entities;
        if (structures.Count != 0) result["structures"] = structures;
        if (statics.Count != 0) result["static"] = statics;
        if (logic != null) RetainReachableRepresentations(result, logic);
        return result;
    }
    private void RetainReachableRepresentations(JsonObject schema, JsonNode logic)
    {
        if (schema["structures"] is not JsonArray structures) return;
        var byName = structures.OfType<JsonObject>().ToDictionary(s => s["name"]!.ToString(), StringComparer.Ordinal);
        // Public authored DTOs are exported contracts. Generated wrappers and private
        // transport shapes exist only when reached from data or executable type slots.
        var live = new HashSet<string>(StringComparer.Ordinal);
        var pending = new Queue<string>();
        void Add(string name)
        {
            while (name.EndsWith(" List", StringComparison.Ordinal)) name = name[..^5];
            if (byName.ContainsKey(name) && live.Add(name)) pending.Enqueue(name);
        }
        void TypesIn(JsonNode? node)
        {
            if (node is JsonObject obj)
            {
                foreach (var pair in obj)
                {
                    // `get` selects the typed output row of a generated SQL query.
                    if (pair.Key is "type" or "get" && pair.Value is JsonValue value && value.TryGetValue<string>(out var name)) Add(name);
                    else TypesIn(pair.Value);
                }
            }
            else if (node is JsonArray array) foreach (var child in array) TypesIn(child);
        }
        foreach (var declaration in declarations.Values.Where(t => t.Kind == DataKind.Structure && t.Symbol.DeclaredAccessibility == Accessibility.Public && !graphRepresentations.Contains(t.Name))) Add(declaration.Name);
        TypesIn(schema["entities"]); TypesIn(schema["static"]); TypesIn(logic);
        while (pending.TryDequeue(out var name)) TypesIn(byName[name]);
        var retired = byName.Keys.Where(name => !live.Contains(name)).ToHashSet(StringComparer.Ordinal);
        for (var index = structures.Count - 1; index >= 0; index--)
            if (retired.Contains(structures[index]!["name"]!.ToString())) structures.RemoveAt(index);
        // Do not advertise data-field locations in transport records that do not exist.
        mapping.RemoveAll(entry => entry["native"] is { } native && retired.Contains(native.ToString().Split('.')[0]));
        if (structures.Count == 0) schema.Remove("structures");
    }
    private JsonObject Entity(DataType type)
    {
        var attributes = new JsonArray(); var properties = Properties(type.Symbol).ToArray();
        var keys = properties.Where(p => p.Name == "Id" || SourceProgram.Attribute(p, "System.ComponentModel.DataAnnotations.KeyAttribute") != null).ToArray();
        if (keys.Length > 1) throw SourceProgram.Error("AVCS206", "One persistent identity is supported; use a unique index for a composite business key", type.Symbol);
        var output = Named(type); output["updateBehavior"] = "Optimized";
        if (keys.FirstOrDefault() is { } key)
        {
            var keyType = Type(key.Type, key);
            if (keyType.Nullable || keyType.Source.TypeKind == TypeKind.Enum || keyType.Native is not ("Integer" or "Long Integer") && keyType.Native != type.Name + " Identifier")
                throw SourceProgram.Error("AVCS207", "Entity identity must be int, long or Id of the same entity", key);
            if (SourceProgram.Attribute(key, "System.ComponentModel.DataAnnotations.Schema.DatabaseGeneratedAttribute") is { } generated && Convert.ToInt32(generated.ConstructorArguments[0].Value) != 1)
                throw SourceProgram.Error("AVCS208", "Manually assigned/computed identities require a native identity strategy that is not implemented", key);
            output["idType"] = keyType.Native == "Integer" ? "Integer" : "Long Integer";
            Map(type, key, "Id", null);
        }
        foreach (var property in properties.Except(keys, SymbolEqualityComparer.Default).OfType<IPropertySymbol>())
        {
            var value = Type(property.Type, property);
            if (value.IsExceptionReference)
                throw SourceProgram.Error("AVCS347", "Exception identities cannot be persisted as entity attributes", property);
            if (value.Temporal != TemporalKind.None)
                throw SourceProgram.Error("AVCS229", "Temporal value transport is defined, but its persistent storage codec is not implemented", property);
            if (value.IsList || value.Declaration is {Kind: DataKind.Structure})
                throw SourceProgram.Error("AVCS209", "Persist collections/value records through an entity relationship; embedded storage is not implicit", property);
            var name = type.Properties[property];
            if (name == "Id" || name.StartsWith("AvHas_", StringComparison.OrdinalIgnoreCase))
                throw SourceProgram.Error("AVCS210", "Property collides with generated storage identity/presence: " + property.Name, property);
            var attribute = Attribute(property, name, value, storage: true);
            if (value.Declaration is {Kind: DataKind.Entity or DataKind.Catalog}) attribute["type"] = value.Declaration.Name + " Identifier";
            attributes.Add(attribute);
            string? presence = null;
            if (value.Nullable)
            {
                presence = "AvHas_" + SymbolNames.Digest(type.Symbol.ToDisplayString() + "." + property.Name);
                attributes.Add(new JsonObject { ["name"] = presence, ["type"] = "Boolean", ["mandatory"] = true,
                    ["default"] = Initial(property) is { } initial && !IsNull(initial) ? "True" : "False",
                    ["description"] = "Generated presence for C# " + property.Name + "; distinguishes null from a default value." });
            }
            Map(type, property, name, presence);
        }
        output["attributes"] = attributes;
        var indexes = new JsonArray();
        foreach (var index in type.Symbol.GetAttributes().Where(a => a.AttributeClass?.ToDisplayString() == Sdk + "IndexAttribute"))
        {
            var members = index.ConstructorArguments[0].Values.Select(v => (string)v.Value!).ToArray();
            if (members.Length == 0 || members.Distinct(StringComparer.Ordinal).Count() != members.Length) throw SourceProgram.Error("AVCS211", "Index needs distinct property names", type.Symbol);
            var columns = members.Select(member => properties.SingleOrDefault(p => p.Name == member) ?? throw SourceProgram.Error("AVCS212", "Index property not found: " + member, type.Symbol))
                .Select(p => keys.Contains(p, SymbolEqualityComparer.Default) ? "Id" : type.Properties[p]).ToArray();
            var explicitName = index.NamedArguments.FirstOrDefault(p => p.Key == "Name").Value.Value as string;
            indexes.Add(new JsonObject { ["name"] = SymbolNames.Normalize(explicitName ?? "IX_" + string.Join("_", columns)),
                ["unique"] = index.NamedArguments.FirstOrDefault(p => p.Key == "Unique").Value.Value is true,
                ["attributes"] = new JsonArray(columns.Select(c => (JsonNode)c).ToArray()) });
        }
        if (indexes.Count != 0) output["indexes"] = indexes;
        return output;
    }
    private JsonObject Structure(DataType type)
    {
        if (ExceptionTypes.Contains(type.Symbol, program.Compilation) && !graphRepresentations.Contains(type.Name))
            throw SourceProgram.Error("AVCS347", "Exception-valued records require an invocation-local representation; public data/source escape has no identity codec", type.Symbol);
        if(type.Symbol.IsAnonymousType)return SqlStructure(type.Name,Properties(type.Symbol).Select(property=>(type.Properties[property],Transport(Type(property.Type,property)))).ToArray());
        var attributes = new JsonArray();
        foreach (var member in SourceMember.Data(type.Symbol))
        {
            var value = Type(member.Type, member.Symbol); var name = type.Properties[member.Symbol];
            attributes.Add(new JsonObject { ["name"] = name, ["type"] = Transport(value) }); Map(type, member.Symbol, name, value.Nullable ? name + ".HasValue" : null);
        }
        if (attributes.Count == 0) throw SourceProgram.Error("AVCS213", "A data record needs at least one public field or property", type.Symbol);
        var result = Named(type); result["attributes"] = attributes; return result;
    }
    private JsonObject Enum(DataType type)
    {
        if (SourceProgram.Attribute(type.Symbol, "System.FlagsAttribute") != null) throw SourceProgram.Error("AVCS214", "A flags combination is not a single catalog entry", type.Symbol);
        var fields = type.Symbol.GetMembers().OfType<IFieldSymbol>().Where(f => f.HasConstantValue).ToArray();
        if (fields.Length == 0) throw SourceProgram.Error("AVCS215", "A fixed catalog needs values", type.Symbol);
        var values = new HashSet<long>(); var names = new SymbolNames(fields); var records = new JsonArray();
        foreach (var field in fields)
        {
            long value;
            try { value = Convert.ToInt64(field.ConstantValue, CultureInfo.InvariantCulture); }
            catch (OverflowException) { throw SourceProgram.Error("AVCS216", "Enum value exceeds a signed 64-bit catalog code", field); }
            if (!values.Add(value)) throw SourceProgram.Error("AVCS217", "Enum aliases need an explicit shared catalog identity; aliases are not duplicated automatically", field);
            records.Add(new JsonObject { ["name"] = names[field], ["label"] = Display(field), ["AvValue"] = Constant(value), ["order"] = records.Count + 1 });
            mapping.Add(new JsonObject { ["source"] = field.ToDisplayString(), ["native"] = "Entities." + type.Name + "." + names[field], ["enumValue"] = value });
        }
        var result = Named(type); result["attributes"] = new JsonArray(new JsonObject { ["name"] = "AvValue", ["type"] = "Long Integer", ["mandatory"] = true }); result["records"] = records; return result;
    }
    private JsonObject Catalog(DataType type)
    {
        if (!type.Symbol.IsRecord) throw SourceProgram.Error("AVCS218", "A rich fixed catalog uses an immutable record and static readonly values", type.Symbol);
        var properties = Properties(type.Symbol).ToArray(); var attributes = new JsonArray();
        foreach (var property in properties)
        {
            var value = Type(property.Type, property);
            if (value.Nullable || value.IsList || value.Declaration != null) throw SourceProgram.Error("AVCS219", "Catalog fields currently require non-null scalar values", property);
            var name = property.Name == "Id" ? "AvValue" : type.Properties[property];
            attributes.Add(Attribute(property, name, value, storage: true)); Map(type, property, name, null);
        }
        var fields = type.Symbol.GetMembers().OfType<IFieldSymbol>().Where(f => f.IsStatic && f.DeclaredAccessibility == Accessibility.Public && SymbolEqualityComparer.Default.Equals(f.Type, type.Symbol)).ToArray();
        var names = new SymbolNames(fields); var records = new JsonArray();
        foreach (var field in fields)
        {
            if (!field.IsReadOnly) throw SourceProgram.Error("AVCS220", "Catalog values must be readonly", field);
            var initializer = field.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).OfType<VariableDeclaratorSyntax>().SingleOrDefault()?.Initializer?.Value;
            if (initializer == null || program.Model(initializer).GetOperation(initializer) is not IObjectCreationOperation create)
                throw SourceProgram.Error("AVCS221", "Catalog values need a record constructor with constant arguments", field);
            var record = new JsonObject { ["name"] = names[field], ["label"] = Display(field), ["order"] = records.Count + 1 };
            foreach (var argument in create.Arguments)
            {
                var property = properties.SingleOrDefault(p => p.Name == argument.Parameter?.Name) ?? throw SourceProgram.Error("AVCS222", "Catalog constructor parameters must correspond to record properties", field);
                if (!argument.Value.ConstantValue.HasValue) throw SourceProgram.Error("AVCS223", "Catalog arguments must be compile-time constants", argument.Syntax);
                var column = property.Name == "Id" ? "AvValue" : type.Properties[property];
                if (column == "Label") record["label"] = argument.Value.ConstantValue.Value?.ToString() ?? "";
                else if (column == "Order") record["order"] = Convert.ToInt32(argument.Value.ConstantValue.Value, CultureInfo.InvariantCulture);
                else record[column] = Constant(argument.Value.ConstantValue.Value);
            }
            if (properties.Any(p => p.Name is not ("Label" or "Order") && !record.ContainsKey(p.Name == "Id" ? "AvValue" : type.Properties[p])))
                throw SourceProgram.Error("AVCS224", "Every catalog property must be initialized by the record constructor", field);
            records.Add(record);
        }
        if (records.Count == 0) throw SourceProgram.Error("AVCS215", "A fixed catalog needs static readonly values", type.Symbol);
        var result = Named(type); result["attributes"] = attributes; result["records"] = records; return result;
    }
    private JsonObject Attribute(IPropertySymbol property, string name, ValueType type, bool storage)
    {
        var output = new JsonObject { ["name"] = name, ["type"] = storage ? StorageType(type) : type.Native, ["mandatory"] = !type.Nullable };
        if (type.Native == "Text" && storage)
        {
            var length = SourceProgram.Attribute(property, "System.ComponentModel.DataAnnotations.MaxLengthAttribute")
                ?? SourceProgram.Attribute(property, "System.ComponentModel.DataAnnotations.StringLengthAttribute");
            var maximum = length?.ConstructorArguments.FirstOrDefault().Value is int size ? size : property.Type.SpecialType == SpecialType.System_Char ? 1 : 2_000_000;
            if (maximum is < 1 or > 2_000_000) throw SourceProgram.Error("AVCS225", "Text storage length must be between 1 and 2000000", property);
            output["length"] = maximum;
        }
        if (SourceProgram.TextAttribute(property, "System.ComponentModel.DescriptionAttribute") is { } description) output["description"] = description;
        if (Initial(property) is { } expression)
        {
            var constant = program.Model(expression).GetConstantValue(expression);
            if (!constant.HasValue) throw SourceProgram.Error("AVCS226", "Persisted defaults must be constant; initialize runtime values in an action", expression);
            if (constant.Value != null)
            {
                if (type.Declaration is {Kind: DataKind.Enum} enumeration)
                {
                    var member = enumeration.Symbol.GetMembers().OfType<IFieldSymbol>().SingleOrDefault(f => f.HasConstantValue && Equals(f.ConstantValue, constant.Value));
                    if (member == null) throw SourceProgram.Error("AVCS227", "Enum default must name a declared catalog value", expression);
                    output["default"] = EnumMember(member);
                }
                else output["default"] = Constant(constant.Value);
            }
        }
        return output;
    }
    private static JsonObject Named(DataType type) => new() { ["name"] = type.Name, ["public"] = type.Symbol.DeclaredAccessibility == Accessibility.Public,
        ["description"] = SourceProgram.TextAttribute(type.Symbol, "System.ComponentModel.DescriptionAttribute") ?? "C# " + type.Symbol.ToDisplayString() };
    internal static IEnumerable<SourceMember> SourceMembers(INamedTypeSymbol type) => SourceMember.Of(type);
    internal static IEnumerable<IPropertySymbol> Properties(INamedTypeSymbol type) => type.GetMembers().OfType<IPropertySymbol>()
        .Where(p => !p.IsStatic && !p.IsIndexer && p.DeclaredAccessibility == Accessibility.Public && SourceProgram.Attribute(p, "System.ComponentModel.DataAnnotations.Schema.NotMappedAttribute") == null)
        .OrderBy(p => p.Locations.FirstOrDefault()?.SourceSpan.Start ?? int.MaxValue);
    private static bool DerivesFrom(INamedTypeSymbol type, string name)
    { for (var current = type.BaseType; current != null; current = current.BaseType) if (current.ToDisplayString() == name) return true; return false; }
    private static ExpressionSyntax? Initial(IPropertySymbol property) => property.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).Select(n => n switch
    { PropertyDeclarationSyntax p => p.Initializer?.Value, ParameterSyntax p => p.Default?.Value, _ => null }).FirstOrDefault(x => x != null);
    private bool IsNull(ExpressionSyntax expression) => program.Model(expression).GetConstantValue(expression) is { HasValue: true, Value: null };
    internal static string Constant(object? value) => value switch
    {
        // The native parser types the positive operand before unary minus. These operands fit
        // their native types, unlike the absolute value of a signed minimum.
        int number when number == int.MinValue => "(-2147483647 - 1)",
        long number when number == long.MinValue => "(-9223372036854775807 - 1)",
        null => throw new ArgumentException("Null requires a presence representation"),
        string s => TextConstant(s),
        char c => TextConstant(c.ToString()),
        bool b => b ? "True" : "False",
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => throw new ArgumentException("Unsupported constant")
    };
    private static string TextConstant(string value)
    {
        static string Quote(string text) => "\"" + text.Replace("\"", "\"\"") + "\"";
        var parts = new List<string>(); var plain = new System.Text.StringBuilder();
        void Flush() { if (plain.Length > 0) { parts.Add(Quote(plain.ToString())); plain.Clear(); } }
        foreach (var character in value)
        {
            // Native expression storage normalizes CR, and server C# generation does not escape
            // every Unicode line separator. Chr preserves those UTF-16 values across both stages.
            if (char.IsControl(character) || char.IsSurrogate(character) || character is '\u2028' or '\u2029')
            { Flush(); parts.Add("Chr(" + (int)character + ")"); }
            else plain.Append(character);
        }
        Flush();
        return parts.Count == 0 ? "\"\"" : parts.Count == 1 ? parts[0] : "(" + string.Join(" + ", parts) + ")";
    }
    private static string Display(ISymbol symbol) => SourceProgram.Attribute(symbol, "System.ComponentModel.DataAnnotations.DisplayAttribute")?.NamedArguments.FirstOrDefault(p => p.Key == "Name").Value.Value as string ?? symbol.Name;
    private void Map(DataType owner, ISymbol property, string target, string? presence)
        => mapping.Add(new JsonObject { ["source"] = property.ToDisplayString(), ["native"] = owner.Name + "." + target, ["presence"] = presence });
    internal static bool Key(IPropertySymbol property) => property.Name=="Id"||SourceProgram.Attribute(property,"System.ComponentModel.DataAnnotations.KeyAttribute")!=null;
    internal static string StorageType(ValueType type) => type.Declaration is { Kind: DataKind.Enum } enumeration && !type.IsIdentity
        ? enumeration.Name + " Identifier" : type.Native;
    internal string StorageName(DataType owner,IPropertySymbol property) => owner.Kind==DataKind.Entity&&Key(property)?"Id"
        :owner.Kind==DataKind.Catalog&&property.Name=="Id"?"AvValue":owner.Properties[property];
    internal static string Presence(DataType owner,IPropertySymbol property) => "AvHas_"+SymbolNames.Digest(owner.Symbol.ToDisplayString()+"."+property.Name);
    internal IReadOnlyList<(string Name,string Type)> StorageColumns(DataType entity)
    {
        var columns=new List<(string,string)> {("Id",entity.Name+" Identifier")};
        if(entity.Kind==DataKind.Catalog) {columns.Add(("Label","Text"));columns.Add(("Order","Integer"));}
        foreach(var property in Properties(entity.Symbol))
        {
            var name=StorageName(entity,property);var type=Type(property.Type,property);
            if(!columns.Any(c=>c.Item1==name)) columns.Add((name,StorageType(type)));
            if(type.Nullable)columns.Add((Presence(entity,property),"Boolean"));
        }
        return columns;
    }
    internal string SqlRow(DataType entity)
    {
        var name="AvSqlRow_"+SymbolNames.Digest(entity.Symbol.ToDisplayString());
        recordTypes.TryAdd(name,new JsonObject {["name"]=name,["attributes"]=new JsonArray(StorageColumns(entity)
            .Select(c=>(JsonNode)new JsonObject {["name"]=c.Name,["type"]=c.Type}).ToArray())});
        return name;
    }
    internal string ScalarSqlRow(string type)
    {
        var name="AvSqlScalar_"+SymbolNames.Digest(type);
        recordTypes.TryAdd(name,SqlStructure(name,[("Value",type)]));return name;
    }
    internal string ProjectionSqlRow(IReadOnlyList<(string Name, string Type)> columns)
    {
        var name = "AvSqlProjection_" + SymbolNames.Digest(string.Join(";", columns.Select(c => c.Name + ":" + c.Type)));
        recordTypes.TryAdd(name, SqlStructure(name,columns));
        return name;
    }
    internal string QueryWorkRow(IReadOnlyList<(string Name, string Type)> columns)
    {
        var name = "AvQueryWork_" + SymbolNames.Digest(string.Join(";",columns.Select(c=>c.Name+":"+c.Type)));
        recordTypes.TryAdd(name,SqlStructure(name,columns)); return name;
    }
    private static JsonObject SqlStructure(string name,IReadOnlyList<(string Name,string Type)> columns)
    {
        var descriptor = new JsonObject { ["name"] = name, ["public"] = false, ["attributes"] = new JsonArray(columns
            .Select(c => (JsonNode)new JsonObject { ["name"] = c.Name, ["type"] = c.Type, ["mandatory"] = false }).ToArray()) };
        descriptor["description"] = "anvil:csharp sql schema\n" + descriptor.ToJsonString(); return descriptor;
    }
    internal JsonArray LegacyQueryRows() => new(Types.Where(t=>t.Kind is DataKind.Entity or DataKind.Catalog).Select(entity =>
    {
        // Exact reconstruction of the retired physical-row emitter, for conservative migration.
        var descriptor = SqlStructure("AvSqlRow_"+SymbolNames.Digest(entity.Symbol.ToDisplayString()),StorageColumns(entity));
        descriptor.Remove("description"); return (JsonNode)descriptor;
    }).ToArray());
}
