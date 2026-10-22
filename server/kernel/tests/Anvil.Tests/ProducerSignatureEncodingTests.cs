using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using Anvil.Core;
using Anvil.Reading;
using Xunit;
namespace Anvil.Tests;
public sealed class ProducerSignatureEncodingTests {
 public ProducerSignatureEncodingTests(){StudioAssemblies.Bind();}
 static Type N(string n)=>Type.GetType("OutSystems.Model.Implementation."+n+", OutSystems.Model.Implementation",true)!;
 static object Call(Type t,string n,object? instance,params object?[] a)=>t.GetMethods(BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Static|BindingFlags.Instance).First(m=>m.Name==n&&m.GetParameters().Length==a.Length).Invoke(instance,a)!;
 internal static byte[] Payload(int cp,string description,bool mutate,bool old,bool lossy,string? marker=null) {
  StudioAssemblies.Bind();
  var key=OutSystems.ObjectKeys.ObjectKey.NewKey();
  var xml=new XElement("ReferenceAction",new XAttribute("OriginalName","EncodingExport"),new XAttribute("Description",description+"a"));
  var full=N("Oml.Signatures.FullElementSignature");
  var signature=Activator.CreateInstance(full,key,xml,Array.Empty<OutSystems.ObjectKeys.GlobalObjectKey>(),xml,false,null)!;
  var wrapper=(XElement)Call(full,"Save",signature);
  var canonical=new StringBuilder();
  Call(Type.GetType("OutSystems.FrameworkExtensions.XmlExtensions, OutSystems.FrameworkExtensions",true)!,"AppendElement",null,canonical,xml);
  Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
  var enc=lossy?Encoding.GetEncoding(cp):Encoding.GetEncoding(cp,EncoderFallback.ExceptionFallback,DecoderFallback.ExceptionFallback);
  var digest=new Guid(MD5.HashData(enc.GetBytes(canonical.ToString())));
  wrapper.SetAttributeValue("FullSignatureHash",Call(N("Oml.Signatures.ElementSignature"),"SerializeGuid",null,digest));
  if(mutate)wrapper.Elements().Single().SetAttributeValue("Description",description+"b");
  var order=old?(marker??"fa53c5ad-1249-aec9-f6c4-645de330bd52"):N("ModelConstants").GetProperty("CurrentElementsOrderVersion")!.GetValue(null)!.ToString();
  var doc=new XElement("Signature",new XAttribute("ESpaceType","Mobile"),new XAttribute("ElementsOrderVersion",order!),new XElement("AnonymousTypesNames"),new XElement("ElementSignatures",wrapper));
  return (byte[])Call(N("Oml.Oml"),"SerializeSignature",null,doc);
 }
 [Theory][InlineData(65001,"Révision € ā", "en-US")][InlineData(1252,"Coût € déjà", "pt-BR")][InlineData(1250,"Łódź č ž", "pl-PL")][InlineData(932,"東京 日本", "ja-JP")]
 public void ExactCurrentCultureFamily(int cp,string text,string culture){
  var before=CultureInfo.CurrentCulture; try {CultureInfo.CurrentCulture=CultureInfo.GetCultureInfo(culture);
   var bytes=Payload(cp,text,false,false,false);
   var result=NativeDependencyReader.ResolveServerSignature(OutSystems.ObjectKeys.ObjectKey.NewKey().ToString(),"EncodingProducer",bytes,["IServerActionSignature:EncodingExport"]);
   Assert.Single(result.Elements);
  }finally{CultureInfo.CurrentCulture=before;}
 }
 [Theory][InlineData(65001,"en-US")][InlineData(1252,"pt-BR")][InlineData(1250,"pl-PL")][InlineData(932,"ja-JP")]
 public void OneAsciiByteTamperRefused(int cp,string culture){var previous=CultureInfo.CurrentCulture; try { CultureInfo.CurrentCulture=CultureInfo.GetCultureInfo(culture); var bytes=Payload(cp,"ASCII",true,false,false); Assert.Contains("Native element payload hash differs",Assert.Throws<ArgumentException>(()=>NativeDependencyReader.ResolveServerSignature(OutSystems.ObjectKeys.ObjectKey.NewKey().ToString(),"EncodingProducer",bytes,["IServerActionSignature:EncodingExport"])).Message);} finally { CultureInfo.CurrentCulture=previous; }}
 [Fact] public void MacronCannotPassByLossy1252(){var bytes=Payload(1252,"Rate ā",false,false,true);Assert.Contains("Native element payload hash differs",Assert.Throws<ArgumentException>(()=>NativeDependencyReader.ResolveServerSignature(OutSystems.ObjectKeys.ObjectKey.NewKey().ToString(),"EncodingProducer",bytes,["IServerActionSignature:EncodingExport"])).Message);}

}