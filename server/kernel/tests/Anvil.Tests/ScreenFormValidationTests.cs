using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public class ScreenFormValidationTests
{
    private static JsonObject Contract()=>JsonNode.Parse("""
        {
          "screens": [
            {
              "name":"ValidatedEditor","type":"IMobileBlock","flow":"MainFlow",
              "properties":{"Public":true},
              "vars":[{"name":"FullName","type":"Text"},{"name":"Email","type":"Email"},{"name":"Saved","type":"Integer","default":"0"}],
              "widgets":[
                {
                  "name":"Editor","type":"IForm","properties":{"Style":"\"editor\""},
                  "children":[
                    {"name":"NameField","type":"IInput","properties":{"Variable":"FullName","Mandatory":"True","InputType":"Text"}},
                    {"name":"EmailField","type":"IInput","properties":{"Variable":"Email","Mandatory":"True","InputType":"Email"}},
                    {
                      "name":"Submit","type":"IButton","properties":{"IsDefault":true},
                      "children":[{"name":"SubmitLabel","type":"ITextWidget","properties":{"Text":"Save"}}],
                      "events":{"OnClick":{"destination":"IMobileBlock:ValidatedEditor/SaveIfValid","validation":"ValidateAndContinue"}}
                    },
                    {
                      "name":"Cancel","type":"IButton","properties":{"IsDefault":false},
                      "children":[{"name":"CancelLabel","type":"ITextWidget","properties":{"Text":"Cancel"}}],
                      "events":{"OnClick":{"destination":"IMobileBlock:ValidatedEditor/ResetEditor","validation":"None"}}
                    }
                  ]
                },
                {"name":"SavedCount","type":"IExpression","properties":{"Value":"Saved"}}
              ]
            },
            {
              "name":"FormHost","type":"IMobileScreen","flow":"MainFlow","roles":["Registered"],
              "widgets":[
                {"name":"LeftEditor","type":"IMobileBlockInstanceWidget","source":"IMobileBlock:ValidatedEditor"},
                {"name":"RightEditor","type":"IMobileBlockInstanceWidget","source":"IMobileBlock:ValidatedEditor"}
              ]
            }
          ],
          "logic":{"actions":[
            {"name":"SaveIfValid","kind":"screen","owner":"IMobileBlock:ValidatedEditor","steps":[
              {"if":"Editor.Valid","then":[{"assign":{"Saved":"Saved + 1"}}]}
            ]},
            {"name":"ResetEditor","kind":"screen","owner":"IMobileBlock:ValidatedEditor","steps":[
              {"assign":{"FullName":"\"\"","Email":"\"\""}}
            ]}
          ]}
        }
        """)!.AsObject();
    private static JsonObject Button(JsonObject contract,string name)=>contract["screens"]![0]!["widgets"]![0]!["children"]!.AsArray().Single(w=>w!["name"]!.ToString()==name)!.AsObject();
    private static JsonObject Binding(JsonObject contract,string name="Submit")=>Button(contract,name)["events"]!["OnClick"]!.AsObject();

    [Fact] public void SchemaExposesExactlyTheTwoSupportedValidationValues()
    {
        var schema=ScreenSpecification.Schema();
        Assert.Contains(schema["binding"]!.AsArray(),v=>v!.ToString()=="validation");
        Assert.Equal(new[]{"None","ValidateAndContinue"},schema["validation"]!.AsArray().Select(v=>v!.ToString()));
        ModuleSpecification.Validate(Contract());
    }
    [Theory]
    [InlineData("\"none\"")]
    [InlineData("\"ValidateAndStop\"")]
    [InlineData("\"ValidateAndContinue \"")]
    [InlineData("true")]
    [InlineData("1")]
    [InlineData("null")]
    [InlineData("{}")]
    public void ValidationRejectsCoercionUnknownEnumsAndNull(string json)
    {
        var contract=Contract();Binding(contract)["validation"]=JsonNode.Parse(json);
        Assert.Throws<ArgumentException>(()=>ScreenSpecification.Validate(contract["screens"]!.AsArray()));
    }
    [Fact] public void ValidationDoesNotPermitUnknownBindingFields()
    {
        var contract=Contract();Binding(contract)["validate"]=true;
        Assert.Contains("unknown fields validate",Assert.Throws<ArgumentException>(()=>ScreenSpecification.Validate(contract["screens"]!.AsArray())).Message);
    }
    [Fact] public void ValidationIsNotAvailableOnLifecycleCustomBlockOrDataSourceEvents()
    {
        var lifecycle=Contract();
        lifecycle["screens"]![0]!["events"]=new JsonObject {["OnReady"]=Binding(lifecycle).DeepClone()};
        Assert.Contains("does not expose writable built-in validation",Assert.Throws<ArgumentException>(()=>ScreenSpecification.Validate(lifecycle["screens"]!.AsArray())).Message);

        var custom=Contract();
        custom["screens"]![1]!["widgets"]![0]!["events"]=new JsonObject {["Changed"]=Binding(custom).DeepClone()};
        Assert.Contains("does not expose writable built-in validation",Assert.Throws<ArgumentException>(()=>ScreenSpecification.Validate(custom["screens"]!.AsArray())).Message);

        var source=Contract();
        source["screens"]![1]!["sourceEvents"]=new JsonObject {["ReadData"]=Binding(source).DeepClone()};
        Assert.Contains("does not expose writable built-in validation",Assert.Throws<ArgumentException>(()=>ScreenSpecification.Validate(source["screens"]!.AsArray())).Message);
    }
    [Fact] public void TraditionalBuiltinEventsDoNotPretendToExposeMobileValidation()
    {
        var screens=JsonNode.Parse("""
            [{"name":"Legacy","type":"IWebScreen","flow":"MainFlow","roles":["Registered"],
              "widgets":[{"name":"Submit","type":"IButtonWidget","properties":{"Label":"\"Save\""},
                "events":{"OnClick":{"destination":"IWebScreen:Legacy/Save","validation":"ValidateAndContinue"}}}]}]
            """)!.AsArray();
        Assert.Contains("does not expose writable built-in validation",Assert.Throws<ArgumentException>(()=>ScreenSpecification.Validate(screens)).Message);
    }
    [Theory]
    [InlineData("reactive-ui")]
    [InlineData("mobile-ui")]
    public void NativeValidationSurvivesReloadAndMergeAndRejectsAVerifyValidMutation(string fixtureName)
    {
        StudioAssemblies.Bind(null);
        var root=JobRunner.RepoRoot(Path.GetDirectoryName(typeof(ScreenFormValidationTests).Assembly.Location)!)!;
        var lane=Environment.GetEnvironmentVariable("ANVIL_LANE")=="ss5" ? "lane-ss5" : "";
        var work=Path.Combine(root,".local",lane,"proofs/form-validation",Guid.NewGuid().ToString("N"),fixtureName);Directory.CreateDirectory(work);
        var host=new ModelHost(work);var fixture=Path.Combine(root,"tests/fixtures",fixtureName+".oml");
        var contract=Contract();var output=Path.Combine(work,"created.oml");Run(fixture,host.PlanModuleSpecification(fixture,contract),output);
        // Each proof reloads the saved model independently of the operation sequence.
        var proof=host.CheckModuleSpecification(output,contract);Accepted(proof);
        Assert.Contains(proof["assertions"]!.AsArray(),a=>a!["element"]!.ToString()=="screen/ValidatedEditor/Editor/Submit/event/OnClick"
            &&a["property"]!.ToString()=="BuiltInValidations"&&a["expected"]!.ToString()=="ValidateAndContinue");
        Assert.Contains(proof["assertions"]!.AsArray(),a=>a!["element"]!.ToString()=="screen/ValidatedEditor/Editor/Cancel/event/OnClick"
            &&a["property"]!.ToString()=="BuiltInValidations"&&a["expected"]!.ToString()=="None");
        var instances=proof["expectedTypes"]!.AsObject().Where(p=>p.Key.StartsWith("screen/FormHost/",StringComparison.Ordinal)&&p.Key.EndsWith("/reference/SourceBlock",StringComparison.Ordinal)).ToArray();
        Assert.Equal(2,instances.Length);Assert.Equal(instances[0].Value!.ToString(),instances[1].Value!.ToString());

        var merged=Path.Combine(work,"merged.oml");
        var merge=MergeProbe.ThreeWay(host,File.ReadAllBytes(fixture),File.ReadAllBytes(output),merged);
        Assert.True(merge.LocalIsValid,JsonSerializer.Serialize(merge));Assert.False(merge.HasConflicts,JsonSerializer.Serialize(merge));
        var after=host.CheckModuleSpecification(merged,contract,proof["expectedTypes"]!.AsObject());Accepted(after);
        Assert.Empty(host.PlanModuleSpecification(merged,contract));

        var mutated=Path.Combine(work,"mutated.oml");
        var mutation=Run(merged,new JsonArray(new JsonObject {
            ["op"]="set",["target"]="IMobileBlock:ValidatedEditor/Editor/Submit/OnClick",["prop"]="BuiltInValidations",["value"]="None"
        }),mutated);
        Assert.True(mutation["accepted"]!.GetValue<bool>(),"Changing native validation must remain Verify-valid");
        var rejected=host.CheckModuleSpecification(mutated,contract,after["expectedTypes"]!.AsObject());
        Assert.False(rejected["accepted"]!.GetValue<bool>());
        Assert.Contains(rejected["differences"]!.AsArray(),d=>d!["element"]!.ToString()=="screen/ValidatedEditor/Editor/Submit/event/OnClick"
            &&d["property"]!.ToString()=="BuiltInValidations"&&d["actual"]!.ToString()=="None"&&d["expected"]!.ToString()=="ValidateAndContinue");
        var repaired=Path.Combine(work,"repaired.oml");Run(mutated,host.PlanModuleSpecification(mutated,contract),repaired);
        Accepted(host.CheckModuleSpecification(repaired,contract,after["expectedTypes"]!.AsObject()));
        Assert.Empty(host.PlanModuleSpecification(repaired,contract));

        // Omitting validation preserves the existing native setting even when another UI property changes.
        var legacy=contract.DeepClone().AsObject();Binding(legacy).Remove("validation");Binding(legacy,"Cancel").Remove("validation");
        legacy["screens"]![0]!["widgets"]![0]!["properties"]!["Style"]="\"legacy-update\"";
        var legacyOutput=Path.Combine(work,"legacy.oml");Run(repaired,host.PlanModuleSpecification(repaired,legacy),legacyOutput);
        var declaredAgain=legacy.DeepClone().AsObject();Binding(declaredAgain)["validation"]="ValidateAndContinue";Binding(declaredAgain,"Cancel")["validation"]="None";
        var preserved=host.CheckModuleSpecification(legacyOutput,declaredAgain,after["expectedTypes"]!.AsObject());Accepted(preserved);

        File.WriteAllText(Path.Combine(work,"contract.json"),contract.ToJsonString());
        File.WriteAllText(Path.Combine(work,"after-merge.json"),after.ToJsonString());
        File.WriteAllText(Path.Combine(work,"rejected-mutation.json"),rejected.ToJsonString());
        File.WriteAllText(Path.Combine(work,"evidence.json"),new JsonObject {
            ["accepted"]=true,["verify"]=true,["reload"]=true,["nativeMerge"]=true,["idempotent"]=true,
            ["verifyValidMutationRejected"]=true,["omittedValidationPreserved"]=true,["sharedBlockInstances"]=2,
            ["browser"]=false,["fixture"]=fixtureName,["afterMerge"]=after.DeepClone()
        }.ToJsonString());

        JsonObject Run(string source,JsonArray ops,string destination)
        {
            var job=destination+".job.json";File.WriteAllText(job,new JsonObject {["ops"]=ops}.ToJsonString());
            var result=JsonSerializer.SerializeToNode(JobRunner.Run(host,source,job,destination))!.AsObject();
            File.WriteAllText(destination+".result.json",result.ToJsonString());
            Assert.True(result["accepted"]!.GetValue<bool>(),result.ToJsonString());return result;
        }
        static void Accepted(JsonObject result)=>Assert.True(result["accepted"]!.GetValue<bool>(),result["differences"]!.ToJsonString());
    }
}