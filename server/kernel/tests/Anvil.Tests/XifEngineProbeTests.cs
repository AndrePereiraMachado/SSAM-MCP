using System.Reflection;
using System.Reflection.Emit;
using Anvil.Xif;
using Xunit;

namespace Anvil.Tests;

/// <summary>XifEngineProbe: fake types emitted here stand for the Integration Studio assemblies. Without ProjectVerify the
/// probe answers XIF_ENGINE_UNAVAILABLE naming that member; the complete set passes; a constructor of another shape than the
/// one the engine calls is missing (the 11.14 Aggregator has only Aggregator(bool)). No real installation is touched.</summary>
public sealed class XifEngineProbeTests
{
    /// <summary>One dynamic assembly with a public type per expected type name, holding every expected member except the
    /// ones in without ("Type.Member", short type name as the probe reports it). A constructor in without stays private; a
    /// constructor in parameterless is emitted without parameters instead of its expected ones.</summary>
    private static Func<string, Type?> Fakes(string[] without, string[]? parameterless = null)
    {
        var assembly = AssemblyBuilder.DefineDynamicAssembly(new AssemblyName("FakeIntegrationStudio" + Guid.NewGuid().ToString("N")), AssemblyBuilderAccess.Run);
        var module = assembly.DefineDynamicModule("Fake");
        var aggregatorInterface = module.DefineType("OutSystems.IntegrationStudio.Core.Common.IAggregator", TypeAttributes.Public | TypeAttributes.Interface | TypeAttributes.Abstract).CreateType();
        var parameterTypes = new Dictionary<string, Type> { ["Boolean"] = typeof(bool), ["String"] = typeof(string), ["IAggregator"] = aggregatorInterface };
        var types = new Dictionary<string, Type>(StringComparer.Ordinal);
        foreach (var (name, members) in XifEngineProbe.Expected)
        {
            var shortName = name.EndsWith(".Plugin", StringComparison.Ordinal) ? name : name[(name.LastIndexOf('.') + 1)..];
            var type = module.DefineType(name, TypeAttributes.Public | TypeAttributes.Class);
            var constructor = members.FirstOrDefault(m => m.StartsWith(".ctor(", StringComparison.Ordinal));
            if (constructor == null) type.DefineDefaultConstructor(MethodAttributes.Public);
            else
            {
                var attributes = without.Contains(shortName + constructor) ? MethodAttributes.Private : MethodAttributes.Public;
                var parameters = parameterless?.Contains(shortName + constructor) == true ? Type.EmptyTypes
                    : XifEngineProbe.ConstructorParameters(constructor).Select(p => parameterTypes[p]).ToArray();
                var il = type.DefineConstructor(attributes, CallingConventions.Standard, parameters).GetILGenerator();
                il.Emit(OpCodes.Ldarg_0);
                il.Emit(OpCodes.Call, typeof(object).GetConstructor(Type.EmptyTypes)!);
                il.Emit(OpCodes.Ret);
            }
            foreach (var member in members.Where(m => !m.StartsWith(".ctor(", StringComparison.Ordinal) && !without.Contains(shortName + "." + m)))
            {
                var method = type.DefineMethod(member, MethodAttributes.Public, typeof(void), Type.EmptyTypes);
                method.GetILGenerator().Emit(OpCodes.Ret);
            }
            types[name] = type.CreateType();
        }
        foreach (var dataType in XifEngineProbe.DataTypes)
        {
            var name = XifEngineProbe.DataType(dataType);
            if (without.Contains("DataType." + dataType)) continue;
            var type = module.DefineType(name, TypeAttributes.Public | TypeAttributes.Class);
            type.DefineDefaultConstructor(without.Contains("DataType." + dataType + ".ctor()") ? MethodAttributes.Private : MethodAttributes.Public);
            types[name] = type.CreateType();
        }
        return name => types.GetValueOrDefault(name);
    }

    private static Func<string, Type?> Fakes(params string[] without) => Fakes(without, null);

    [Fact]
    public void TheCompleteSetPasses()
    {
        Assert.Empty(XifEngineProbe.Missing(Fakes()));
        XifEngineCheck.Require(Fakes(), ["C:\\fake\\Integration Studio"]);
    }

    [Fact]
    public void AMissingProjectVerifyIsEngineUnavailableNamingIt()
    {
        var missing = XifEngineProbe.Missing(Fakes("Aggregator.ProjectVerify"));
        Assert.Equal(["Aggregator.ProjectVerify"], missing);
        var refusal = Assert.Throws<XifRefusal>(() => XifEngineCheck.Require(Fakes("Aggregator.ProjectVerify"), ["C:\\fake\\Integration Studio"]));
        Assert.Equal(XifCodes.EngineUnavailable, refusal.Code);
        Assert.Contains("Aggregator.ProjectVerify", refusal.Message);
        Assert.Equal("Aggregator.ProjectVerify", Assert.Single(refusal.Problems).Path);
        Assert.Equal("C:\\fake\\Integration Studio", refusal.Extra!["searched"]![0]!.ToString());
    }

    [Fact]
    public void EveryMissingPieceIsListedAtOnce()
    {
        var missing = XifEngineProbe.Missing(Fakes("Upgrader.ctor(String)", "IAction.MoveIParameter", "DataType.RecordList", "DataType.Text.ctor()"));
        Assert.Equal(["Upgrader.ctor(String)", "IAction.MoveIParameter", "DataType.Text.ctor()", "DataType.RecordList"], missing);
        // A resolver that throws (a broken installation) reports the type as missing instead of failing.
        Assert.Contains("Aggregator", XifEngineProbe.Missing(_ => throw new FileLoadException("broken")));
    }

    [Fact]
    public void AConstructorOfAnotherShapeIsMissing()
    {
        // The defect of 2026-10-06: the engine asked the Aggregator for a parameterless constructor, the installed 11.14 has
        // only Aggregator(bool preventUsingTasks). Each side of that mismatch is now named before any call.
        Assert.Equal(["Aggregator.ctor(Boolean)"], XifEngineProbe.Missing(Fakes([], ["Aggregator.ctor(Boolean)"])));
        Assert.Equal(["OutSystems.IntegrationStudio.Plugin.Net.Core.Plugin.ctor(IAggregator)"],
            XifEngineProbe.Missing(Fakes([], ["OutSystems.IntegrationStudio.Plugin.Net.Core.Plugin.ctor(IAggregator)"])));
        Assert.Equal(["Aggregator.ctor(Boolean)"], XifEngineProbe.Missing(Fakes("Aggregator.ctor(Boolean)")));
    }

    [Fact]
    public void TheEngineCreatesObjectsOnlyThroughTheCheckedConstructor()
    {
        // Activator.CreateInstance(type, true) is the nonPublic overload: it silently asks for a parameterless constructor.
        // The engine creates every Integration Studio object through R.New, which matches the constructor to the arguments.
        var engine = Path.Combine(XifCompilerTests.Kernel, "src", "Anvil.Xif.Engine");
        foreach (var file in Directory.GetFiles(engine, "*.cs"))
            Assert.DoesNotContain("Activator.", File.ReadAllText(file));
        var host = File.ReadAllText(Path.Combine(engine, "Host.cs"));
        Assert.Contains("R.New(T(\"OutSystems.IntegrationStudio.Core.Aggregator.Aggregator\"), true)", host);
    }
}
