import fs from 'node:fs';
import path from 'node:path';

// Compile the production client source. Only its pinned test-host path and the build's protocol differ.
// Never install or inject into a real Studio to qualify this transport.
// SSAM_E2E_OUTPUT: another folder for the generated projects (default as before).
const output = process.env.SSAM_E2E_OUTPUT ?? 'C:/t/vigia-auto/round2-e2e';
const repository = path.resolve(import.meta.dirname, '../../..');
const original = fs.readFileSync(path.join(repository, 'server/platforms/odc/studio/bridge/client/Program.cs'), 'utf8');
const host = path.join(output, 'host/bin/Release/net10.0/ODCStudio.exe');
function project(name, xml, source) {
  const dir = path.join(output, name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.csproj'), xml); fs.writeFileSync(path.join(dir, 'Program.cs'), source);
}
project('host', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><AssemblyName>ODCStudio</AssemblyName><Version>1.7.30</Version></PropertyGroup></Project>',
  'Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { pid = Environment.ProcessId, startedUtc = System.Diagnostics.Process.GetCurrentProcess().StartTime.ToUniversalTime().ToString("O") })); await Console.In.ReadLineAsync();');
for (const version of ['v98', 'v100']) {
  const source = original.replace('const string Version = "v98";', `const string Version = "${version}";`)
    .replace('C:\\Program Files\\OutSystems\\ODC Studio\\ODC Studio\\ODCStudio.exe', host.replaceAll('/', '\\'));
  if (source.includes('C:\\Program Files\\OutSystems\\ODC Studio')) throw new Error('Test host pin was not substituted');
  project(version, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><AssemblyName>ODC3.Bridge.Client</AssemblyName></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.Diagnostics.NETCore.Client" Version="0.2.731102" /></ItemGroup></Project>', source);
}
project('bridge', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><AssemblyName>ODC3.Bridge.v100</AssemblyName></PropertyGroup></Project>', `
using System.IO.Pipes;
using System.Text.Json.Nodes;
public class StartupHook {
  public static void Initialize() {
    File.WriteAllText(Environment.GetEnvironmentVariable("SSAM_E2E_MARKER")!, "loaded v100");
    _ = Task.Run(async () => { while (true) {
      using var pipe = new NamedPipeServerStream("ODC3-Bridge-v100-" + Environment.ProcessId, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
      await pipe.WaitForConnectionAsync(); using var reader = new StreamReader(pipe); using var writer = new StreamWriter(pipe) { AutoFlush = true };
      var line = await reader.ReadLineAsync(); var data = JsonNode.Parse(line![(line.IndexOf(' ') + 1)..]);
      await writer.WriteLineAsync(new JsonObject { ["ok"] = true, ["protocol"] = 1, ["root"] = Environment.GetEnvironmentVariable("SSAM_E2E_BAD_BIND") == "1" ? JsonValue.Create("wrong-root") : data!["root"]!.DeepClone() }.ToJsonString());
    } });
  }
}`);
fs.writeFileSync(path.join(output, 'settings.json'), JSON.stringify({ output, host }));
for (const [name, agent] of [['native-head', path.join(repository, 'agent/native/Ssam.Agent/Ssam.Agent.csproj')], ['native-base', 'C:/t/vigia-auto/round2-base/agent/native/Ssam.Agent/Ssam.Agent.csproj']]) {
  const dir = path.join(output, name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><AssemblyName>NativeProtocol.Tests</AssemblyName></PropertyGroup><ItemGroup><Compile Include="${path.join(import.meta.dirname, 'NativeChannel.cs')}" Link="Program.cs"/><ProjectReference Include="${agent}"/></ItemGroup></Project>`);
}
// channel-head: the native harness of bridge-lifetime-e2e.test.mjs over this checkout (used with SSAM_E2E_OUTPUT).
{
  const dir = path.join(output, 'channel-head'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'channel-head.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><AssemblyName>NativeProtocol.Tests</AssemblyName></PropertyGroup><ItemGroup><Compile Include="${path.join(import.meta.dirname, '../bridge-lifetime-harness/NativeChannel.cs')}" Link="Program.cs"/><ProjectReference Include="${path.join(repository, 'agent/native/Ssam.Agent/Ssam.Agent.csproj')}"/></ItemGroup></Project>`);
}
console.log(output);
