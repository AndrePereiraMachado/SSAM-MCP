using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Anvil.CSharp;

internal sealed partial class MethodCompiler
{
    private SourceValue Absent(ValueType type, JsonArray steps, IOperation location)
    {
        if (type.Category == RuntimeCategory.DelegateReference) { var reference = Temp(type); Assign(steps, reference.Text + ".Target", "0"); return reference with { IsNull = true }; }
        if (type.IsArenaReference || type.IsExceptionReference) { var reference = Temp(type); Assign(steps, reference.Text + ".Index", "0"); return reference with { IsNull = true }; }
        if (!type.Nullable) throw Unsupported(location, "Null requires an explicitly nullable source type");
        var value = Temp(type); Assign(steps,value.Text+".HasValue","False"); return value with {IsNull=true};
    }
    private static string Present(SourceValue value) => value.Type.IsArenaReference || value.Type.IsExceptionReference ? value.Text + ".Index <> 0" : value.Type.Nullable ? value.Presence??value.Text+".HasValue" : "True";
    private static SourceValue Payload(SourceValue value) => value.Type.IsArenaReference || value.Type.IsExceptionReference ? value : value.Type.Nullable ? new(value.Presence==null?value.Text+".Value":value.Text,value.Type with { Nullable=false },Storage:value.Storage) : value;
    private SourceValue Dereference(SourceValue value, JsonArray steps)
    {
        if (value.Type.IsExceptionReference) { CheckExceptionReference(value, steps); return value; }
        if (value.Type.IsArenaReference) { CheckReference(value, steps); return value; }
        if (!value.Type.Nullable || !value.Type.Source.IsReferenceType) return value;
        Guard(steps,"not ("+Present(value)+")","NullReferenceException",ExceptionTypes.Builtins["System.NullReferenceException"].Message);
        return Payload(value);
    }
    private SourceValue Coerce(SourceValue value,ValueType target,bool isChecked,JsonArray steps,IOperation location)
    {
        if (target.IsReadOnlyListReference || value.Type.IsReadOnlyListReference)
            return ReadOnlyConversion(value, target, steps, location);
        if (target.IsExceptionReference || value.Type.IsExceptionReference)
        {
            if (target.IsExceptionReference && value.Type.IsExceptionReference && ExceptionTypes.DerivesFrom(value.Type.Source, target.Source))
                return value with { Type = target };
            throw Unsupported(location, "Exception conversion requires a BCL identity/upcast; checked downcasts and unrelated exception conversions are not implemented");
        }
        if (value.Storage && target.IsArenaReference) value = ImportRecord(value, steps, location);
        if (target.IsArenaReference || value.Type.IsArenaReference)
        {
            if (target.IsArenaReference && value.Type.IsArenaReference && target.Native == value.Type.Native) return value with { Type = target };
            throw Unsupported(location, "Reference conversion requires a compatible typed arena; boundary/storage copying is not implicit");
        }
        if(target.Nullable)
        {
            if(value.Type.Nullable&&value.Type.Native==target.Native&&value.Presence==null&&!value.Storage) return value with {Type=target};
            var result=Temp(target); Assign(steps,result.Text+".HasValue",Present(value));
            var payload=new JsonArray(); var converted=Coerce(Payload(value),target with {Nullable=false},isChecked,payload,location);
            Assign(payload,result.Text+".Value",converted.Text);
            if(value.Type.Nullable) steps.Add(new JsonObject {["if"]=Present(value),["then"]=payload});
            else foreach(var step in payload) steps.Add(step!.DeepClone());
            return result;
        }
        if(value.Type.Nullable)
        {
            Guard(steps,"not "+Present(value),"InvalidOperationException","Nullable object must have a value.");
            value=Payload(value);
        }
        if(Range(target.Source) is {} targetRange&&Range(value.Type.Source) is {} valueRange)
        {
            if(targetRange.Minimum<=valueRange.Minimum&&targetRange.Maximum>=valueRange.Maximum) return value with {Type=target};
            return Integral(value.Text,target,isChecked,steps,location);
        }
        if(value.Storage) value=ImportRecord(value,steps,location);
        if(target.Native==value.Type.Native) return value with {Type=target};
        if(target.Temporal == TemporalKind.DateTime || value.Type.Temporal == TemporalKind.DateTime)
            throw Unsupported(location, "An exact DateTime ticks/Kind intermediate cannot cross a legacy native Date Time spill, call or return boundary; its codec is not implemented");
        if(target.Native=="Decimal"&&value.Type.Native is "Integer" or "Long Integer") return new("("+value.Text+" + 0.0)",target);
        if(target.Native is "Integer" or "Long Integer"&&value.Type.Native=="Decimal") return Integral("Trunc("+value.Text+")",target,true,steps,location);
        throw Unsupported(location,"Conversion from "+value.Type.Source+" to "+target.Source+" is not defined");
    }
    private void Store(JsonArray steps,SourceValue target,SourceValue value,IOperation location)
    {
        var converted = Coerce(value, target.Type, false, steps, location);
        if (target.Location != null) WritePlace(target.Location, converted, steps);
        else Assign(steps, target.Text, converted.Text);
    }
    private SourceValue Coalesce(ICoalesceOperation op,JsonArray steps)
    {
        var value=Value(op.Value,steps); var target=Type(op.Type!); var result=Temp(target);
        if(!value.Type.Nullable && !value.Type.IsArenaReference && !value.Type.IsExceptionReference) throw Unsupported(op,"Coalescing requires a nullable source value");
        var yes=new JsonArray(); var no=new JsonArray();
        Store(yes,result,Payload(value),op); Store(no,result,Value(op.WhenNull,no),op);
        steps.Add(new JsonObject {["if"]=Present(value),["then"]=yes,["else"]=no}); return result;
    }
    private SourceValue LiftedBinary(IBinaryOperation op,SourceValue left,SourceValue right,JsonArray steps)
    {
        RequireTemporalComparisonCompatibility(Payload(left), Payload(right), op);
        var target=Type(op.Type!); var a=TemporalScalar(Payload(left)); var b=TemporalScalar(Payload(right));
        if(op.OperatorKind is BinaryOperatorKind.Equals or BinaryOperatorKind.NotEquals)
        {
            if(left.IsNull||right.IsNull)
            {
                var nullComparison=Present(left.IsNull?right:left);
                return new(op.OperatorKind==BinaryOperatorKind.Equals?"not ("+nullComparison+")":nullComparison,target);
            }
            if(a.Type.Declaration is {Kind: not DataKind.Enum}&&!a.Type.IsIdentity||a.Type.IsList) throw Unsupported(op,"Nullable record equality requires a semantic equality translation");
            var equal="(("+Present(left)+" = "+Present(right)+") and (not ("+Present(left)+") or ("+a.Text+" = "+b.Text+")))";
            return new(op.OperatorKind==BinaryOperatorKind.Equals?equal:"not "+equal,target);
        }
        var present="("+Present(left)+" and "+Present(right)+")";
        var comparison=op.OperatorKind switch {BinaryOperatorKind.LessThan=>"<",BinaryOperatorKind.LessThanOrEqual=>"<=",BinaryOperatorKind.GreaterThan=>">",BinaryOperatorKind.GreaterThanOrEqual=>">=",_=>null};
        if(comparison!=null&&!target.Nullable) return new("("+present+" and ("+a.Text+" "+comparison+" "+b.Text+"))",target);
        var result=Temp(target);var branch=new JsonArray();
        if(op.OperatorKind is BinaryOperatorKind.LessThan or BinaryOperatorKind.LessThanOrEqual or BinaryOperatorKind.GreaterThan or BinaryOperatorKind.GreaterThanOrEqual)
        {
            Assign(steps,result.Text+".HasValue",present); Assign(branch,result.Text+".Value","("+a.Text+" "+comparison+" "+b.Text+")");
        }
        else
        {
            if(!target.Nullable) throw Unsupported(op,"Lifted operator result requires a nullable type");
            Assign(steps,result.Text+".HasValue",present);
            var computed=TemporalBinary(op.OperatorKind,Payload(left),Payload(right),branch,op)
                ?? Numeric(op.OperatorKind,a.Text,b.Text,target with {Nullable=false},op.IsChecked,branch,op);
            Store(branch,new(result.Text+".Value",target with {Nullable=false}),computed,op);
        }
        steps.Add(new JsonObject {["if"]=present,["then"]=branch}); return result;
    }
}
