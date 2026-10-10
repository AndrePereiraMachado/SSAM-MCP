using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private readonly Dictionary<IParameterSymbol,SourceValue> boundValues=new(SymbolEqualityComparer.Default);
    private readonly Dictionary<string,SourceValue> storageDefaults=new(StringComparer.Ordinal);
    private bool ShortIdentity(ValueType type)=>model.Data.IdentityBits(type)==32;
    private string StorageDefault(ValueType type)
    {
        if (type.Declaration is { Kind: DataKind.Enum } && !type.IsIdentity) return "NullIdentifier()";
        var scalar=type with {Nullable=false};var key=model.Data.Transport(scalar);
        if(!storageDefaults.TryGetValue(key,out var value)) storageDefaults.Add(key,value=Temp(scalar));
        return value.Text;
    }
    private string StorageTemp(DataType entity)
    {
        var name="AvStorage"+(++temporary);
        variables.Add(new JsonObject {["name"]=name,["type"]=entity.Name}); return name;
    }
    private SourceValue StorageMember(SourceValue owner,IPropertySymbol property,JsonArray steps)
    {
        var entity=owner.Type.Declaration!; var type=model.Data.Type(property.Type, property);
        var field=owner.Text+"."+model.Data.StorageName(entity,property);
        if(entity.Kind==DataKind.Entity&&DataModel.Key(property)&&!type.IsIdentity)
            field=(property.Type.SpecialType==SpecialType.System_Int32?"IdentifierToInteger(":"IdentifierToLongInteger(")+field+")";
        var presence=type.Nullable?owner.Text+"."+DataModel.Presence(entity,property):null;
        if (type.Declaration is { Kind: DataKind.Enum } && !type.IsIdentity)
            field = EnumStorage(field, type, presence ?? "True", toStorage: false, steps);
        return new(field,type,presence);
    }
    private SourceValue ImportRecord(SourceValue source,JsonArray steps,IOperation location)
    {
        if(source.Type.Declaration is not {Kind:DataKind.Entity or DataKind.Catalog} entity) throw Unsupported(location,"Storage record type is not bound");
        var type = Type(source.Type.Source);
        var result = type.IsArenaReference ? AllocateReference(type, steps) : Temp(type with {Nullable=false});
        foreach(var property in DataModel.Properties(entity.Symbol))
            Store(steps,RecordMemberTarget(result, property),StorageMember(source,property,steps),location);
        return result;
    }
    private SourceValue RecordMemberTarget(SourceValue record, IPropertySymbol property)
        => record.Type.IsArenaReference
            ? new("", Type(property.Type), Location: new ObjectFieldPlace(record, property, Type(property.Type)))
            : new(record.Text + "." + record.Type.Declaration!.Properties[property], Type(property.Type));
    private string ExportRecord(SourceValue source,JsonArray steps,IOperation location)
    {
        if(source.Type.Declaration is not {Kind:DataKind.Entity} entity||source.Type.IsIdentity) throw Unsupported(location,"A write requires a persisted entity record");
        source=Dereference(Coerce(source,source.Type with {Nullable=false},false,steps,location), steps);
        var target=StorageTemp(entity);
        foreach(var property in DataModel.Properties(entity.Symbol))
        {
            var type=Type(property.Type); var field=LoadTarget(RecordMemberTarget(source, property), steps);
            var value=Payload(field).Text;
            if (type.Declaration is { Kind: DataKind.Enum } && !type.IsIdentity)
                value = EnumStorage(value, type, Present(field), toStorage: true, steps);
            if(DataModel.Key(property)&&!type.IsIdentity)
                value=(property.Type.SpecialType==SpecialType.System_Int32?"IntegerToIdentifier(":"LongIntegerToIdentifier(")+value+")";
            var storageType = model.Data.Type(property.Type, property);
            if (storageType.Native == "Binary Data" && type.IsArenaReference)
                throw Unsupported(location, "Binary Data persistence requires a byte-array value codec; an array identity cannot be written as a native binary value");
            if(storageType.Nullable)
            {
                Assign(steps,target+"."+DataModel.Presence(entity,property),Present(field));
                var column=target+"."+model.Data.StorageName(entity,property);
                steps.Add(new JsonObject {["if"]=Present(field),["then"]=new JsonArray(new JsonObject {["assign"]=new JsonObject {[column]=value}}),
                    ["else"]=new JsonArray(new JsonObject {["assign"]=new JsonObject {[column]=StorageDefault(type)}})});
            }
            else
            {
                if (type.Nullable) Guard(steps, "not (" + Present(field) + ")", "ArgumentException", property.Name + " cannot be null in persisted storage.");
                Assign(steps,target+"."+model.Data.StorageName(entity,property),value);
            }
        }
        ValidateRecord(source,steps,location); return target;
    }
    private string EnumStorage(string value, ValueType type, string presence, bool toStorage, JsonArray steps)
    {
        // Source enum values are numeric, including undefined values. A stored enum column is
        // a native catalog FK, so only declared values are admitted at this persistence boundary.
        var entries = type.Declaration!.Symbol.GetMembers().OfType<IFieldSymbol>().Where(f => f.HasConstantValue)
            .Select(f => (Code: DataModel.Constant(f.ConstantValue), Id: model.Data.EnumMember(f))).ToArray();
        var tests = entries.Select(e => value + " = " + (toStorage ? e.Code : e.Id)).ToArray();
        Guard(steps, "(" + presence + ") and not (" + string.Join(" or ", tests) + ")", "ArgumentException",
            "Enum value is not a declared member of " + type.Declaration.Symbol.Name + ".");
        var result = toStorage ? "NullIdentifier()" : "0";
        for (var i = entries.Length - 1; i >= 0; i--)
            result = "If(" + tests[i] + ", " + (toStorage ? entries[i].Id : entries[i].Code) + ", " + result + ")";
        return result;
    }
    private void ValidateRecord(SourceValue value,JsonArray steps,IOperation location)
    {
        var entity=value.Type.Declaration!;
        foreach(var property in DataModel.Properties(entity.Symbol))
        {
            var type=Type(property.Type); var field=LoadTarget(RecordMemberTarget(value, property), steps);
            var present=Present(field); var payload=Payload(field).Text;
            if(type.Native=="Text")
            {
                var attribute=SourceProgram.Attribute(property,"System.ComponentModel.DataAnnotations.MaxLengthAttribute")??SourceProgram.Attribute(property,"System.ComponentModel.DataAnnotations.StringLengthAttribute");
                var length=attribute?.ConstructorArguments.FirstOrDefault().Value is int maximum?maximum:2_000_000;
                var codeUnits = Utf16Length(Payload(field), steps);
                Guard(steps,"("+present+") and "+codeUnits.Text+" > "+length,"ArgumentException",property.Name+" exceeds its maximum length.");
            }
            if(type.IsIdentity&&!DataModel.Key(property))
                Guard(steps,"("+present+") and "+payload+" = NullIdentifier()","ArgumentException",property.Name+" requires a valid identity.");
        }
    }
    private SourceValue DataCall(IInvocationOperation op,JsonArray steps)
    {
        if(op.Instance is not IParameterReferenceOperation dependency||!LogicModel.DataDependency(dependency.Parameter.Type))
            throw Unsupported(op,"Data access must use the injected request session");
        var type=op.TargetMethod.TypeArguments.Single() as INamedTypeSymbol??throw Unsupported(op);
        var entity=model.Data.Declaration(type);
        if(entity.Kind!=DataKind.Entity) throw Unsupported(op,"Fixed catalogs cannot be mutated");
        var name="AvData"+(++calls); var form=op.TargetMethod.Name;
        if(form=="Delete")
        {
            var id=Value(op.Arguments[0].Value,steps); EnsureExists(entity,id.Text,steps);
            steps.Add(new JsonObject {["delete"]=entity.Name,["id"]=id.Text,["as"]=name});
        }
        else if(form is "Insert" or "Update")
        {
            var value=Value(op.Arguments[0].Value,steps); var storage=ExportRecord(value,steps,op);
            if(form=="Update") EnsureExists(entity,storage+".Id",steps);
            else Guard(steps,storage+".Id <> NullIdentifier()","ArgumentException","New records require an empty generated identity.");
            steps.Add(new JsonObject {[form=="Insert"?"create":"update"]=entity.Name,["record"]=storage,["as"]=name});
        }
        else throw Unsupported(op,"Unknown data effect: "+form);
        return form=="Insert"?new(name+".Id",Type(op.Type!)):new("False",Type(model.Program.Compilation.GetSpecialType(SpecialType.System_Boolean)));
    }
    private void EnsureExists(DataType entity,string identity,JsonArray steps)
    {
        var query="AvExists"+(++calls);
        steps.Add(new JsonObject {["get"]=entity.Name,["as"]=query,["where"]=entity.Name+".Id = "+identity,["max"]=1});
        Guard(steps,query+".List.Empty","InvalidOperationException","The record does not exist.");
    }
}
