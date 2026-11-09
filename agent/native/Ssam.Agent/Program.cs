using System.Text.Json.Nodes;

namespace Ssam.Agent;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        Console.InputEncoding = new System.Text.UTF8Encoding(false, true);
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        try
        {
            if (args is ["private-helper"]) return await MacPrivateHelperCommand.Run();
            if (args is ["studio-instances"]) { Console.WriteLine(StudioInstance.Snapshot().ToJsonString()); return 0; }
            if (args is ["authenticode", "--file", var signatureFile, "--signer", var signatureClass])
            {
                var result = AuthenticodeTrust.Check(signatureFile, signatureClass); Console.WriteLine(result.ToJsonString()); return result["ok"]!.GetValue<bool>() ? 0 : 1;
            }
            // trust-anchors: the anchors compiled into this core, for the build gate (scripts/bridge-trust-gate.mjs). 0.4.14-native: the
            // SHA-256 of the pinned Ed25519 SPKI and the Microsoft roots; there is no Authenticode thumbprint any more.
            if (args is ["trust-anchors"])
            {
                Console.WriteLine(new JsonObject { ["spkiSha256"] = BridgeTrust.SpkiSha256(BridgeTrust.ManifestPublicKey), ["microsoftRoots"] = new JsonArray(BridgeTrust.MicrosoftRoots.Select(x => (JsonNode?)JsonValue.Create(x)).ToArray()) }.ToJsonString()); return 0;
            }
            if (args is ["windows-directory"]) { Console.WriteLine(Environment.GetFolderPath(Environment.SpecialFolder.Windows)); return 0; }
            if (args is ["bridge-lock", "--root", var lockRoot, "--directory", var lockDirectory])
            {
                using var lease = BridgeFileLease.Acquire(lockRoot, lockDirectory);
                Console.WriteLine("locked"); await Console.In.ReadLineAsync(); return 0;
            }
            if (args is ["mac-inspect"]) { Console.WriteLine((await MacPlatform.InspectHost()).ToJsonString(new() { WriteIndented = true })); return 0; }
            if (args.Length > 0 && args[0] is "run" or "setup" or "doctor") return await NativeHost.Command(args);
            if (args is ["check-credential-request"])
            {
                var requests = JsonNode.Parse(await Console.In.ReadToEndAsync()) as JsonArray ?? throw new ArgumentException("Expected credential requests");
                var answers = new JsonArray();
                foreach (var request in requests)
                {
                    try { CredentialKinds.Validate(request as JsonObject ?? throw new AgentFault("PARAMS_INVALID", "Expected an object.")); answers.Add((JsonNode)new JsonObject { ["ok"] = true }); }
                    catch (AgentFault error) { answers.Add((JsonNode)new JsonObject { ["error"] = error.Code }); }
                }
                Console.WriteLine(answers.ToJsonString()); return 0;
            }
            // roots add --folder <folder> --root <data> | roots remove --folder <folder> --root <data> | roots list --root <data> [--json]:
            // the folders file.upload may read, changed only by the person (UploadRoots.cs).
            if (args is ["roots", var op, ..])
            {
                var options = Options(args[2..], "--json");
                var dataRoot = options.GetValueOrDefault("--root") ?? throw new ArgumentException("roots needs --root <agent folder>");
                if (options.Keys.Except(["--root", "--runtime-root", "--folder", "--json"]).Any() || (options.ContainsKey("--json") && op != "list"))
                    throw new ArgumentException("Use roots add --folder <folder> --root <folder> | roots remove --folder <folder> --root <folder> | roots list --root <folder> [--json]");
                return UploadRoots.Command(op, options.GetValueOrDefault("--folder"), Path.GetFullPath(dataRoot), Path.GetFullPath(options.GetValueOrDefault("--runtime-root") ?? AppContext.BaseDirectory),
                    options.ContainsKey("--json"), Console.Out, Console.Error);
            }
            // check-upload --root <data> [--runtime-root <dir>]: stdin [{path, maxBytes, deadline?, beforeOpen?}] -> [{decision} | {error}],
            // every check of file.upload without the transport (tests/native/upload.test.mjs compares it with the Node agent).
            // beforeOpen {move: [[from, to], ...]} renames links between the checks and the open, as a test hook.
            if (args is ["check-upload", "--root", var uploadRoot, ..])
            {
                var runtimeRoot = args is [_, _, _, "--runtime-root", var given] ? given : AppContext.BaseDirectory;
                var kinds = new UploadKinds(Path.GetFullPath(uploadRoot), Path.GetFullPath(runtimeRoot), null, () => 0);
                var requests = JsonNode.Parse(await Console.In.ReadToEndAsync()) as JsonArray ?? throw new ArgumentException("Expected a JSON array");
                var answers = new JsonArray();
                foreach (var request in requests.OfType<JsonObject>())
                {
                    Action? hook = request["beforeOpen"]?["move"] is JsonArray moves ? () => {
                        foreach (var move in moves.OfType<JsonArray>()) Directory.Move(move[0]!.GetValue<string>(), move[1]!.GetValue<string>());
                    } : null;
                    long? deadline = request["deadline"] is JsonValue due && due.TryGetValue<long>(out var at) ? at : null;
                    try
                    {
                        var prepared = kinds.Prepare(request, deadline, null, hook);
                        answers.Add((JsonNode)new JsonObject { ["decision"] = new JsonObject { ["size"] = prepared.Size, ["sha256"] = prepared.Sha256 } });
                    }
                    catch (AgentFault e) { answers.Add((JsonNode)new JsonObject { ["error"] = e.Code }); }
                    catch (PathRefusal e) { answers.Add((JsonNode)new JsonObject { ["error"] = e.Code }); }
                }
                Console.WriteLine(answers.ToJsonString());
                return 0;
            }
            if (args is ["check-policy", "--root", var policyRoot])
            {
                var policy = new StudioKinds(policyRoot, AppContext.BaseDirectory, new(), () => null);
                var requests = JsonNode.Parse(await Console.In.ReadToEndAsync()) as JsonArray ?? throw new ArgumentException("Expected requests");
                var results = new JsonArray();
                foreach (var request in requests.OfType<JsonObject>())
                {
                    try
                    {
                        JsonNode value = StudioKinds.Text(request["kind"]) == "odc.pipe"
                            ? new JsonArray(policy.MapOdc(request).Select(s => (JsonNode?)JsonValue.Create(s)).ToArray())
                            : policy.MapO11(StudioKinds.Text(request["method"]) ?? "", request["params"] as JsonObject ?? new());
                        results.Add((JsonNode)new JsonObject { ["value"] = value });
                    }
                    catch (AgentFault e) { results.Add((JsonNode)new JsonObject { ["error"] = e.Code }); }
                    catch (PathRefusal e) { results.Add((JsonNode)new JsonObject { ["error"] = e.Code }); }
                }
                Console.WriteLine(results.ToJsonString()); return 0;
            }
            if (args is ["check-paths", "--root", var pathRoot])
            {
                var workspace = new Workspace(pathRoot);
                var requests = JsonNode.Parse(await Console.In.ReadToEndAsync()) as JsonArray
                    ?? throw new ArgumentException("Expected a JSON array");
                var answers = new JsonArray();
                foreach (var request in requests)
                {
                    try
                    {
                        var value = request!["value"]!.GetValue<string>();
                        var write = request["write"]?.GetValue<bool>() == true;
                        var result = request["op"]?.GetValue<string>() switch {
                            "absolute" => workspace.CheckAbsolute(value, write),
                            "toAgent" => workspace.ToAgent(value, write),
                            _ => workspace.Resolve(value, write)
                        };
                        answers.Add((JsonNode)new JsonObject { ["value"] = result });
                    }
                    catch (PathRefusal e) { answers.Add((JsonNode)new JsonObject { ["error"] = e.Code }); }
                }
                Console.WriteLine(answers.ToJsonString());
                return 0;
            }
            // check-render-request: stdin [request] -> [{ok:true} | {error}], the checks of screen.render (tests/native/render.test.mjs
            // compares them with the Node agent's).
            // check-inside: stdin [[child, parent]] -> [bool], the path comparison of LocalPaths.Inside (tests/native/upload.test.mjs
            // compares it with the Node agent's insidePath on every character pair of a table).
            if (args is ["check-inside"])
            {
                var pairs = JsonNode.Parse(await Console.In.ReadToEndAsync()) as JsonArray ?? throw new ArgumentException("Expected a JSON array");
                Console.WriteLine(new JsonArray(pairs.Select(pair => (JsonNode?)JsonValue.Create(LocalPaths.Inside(pair![0]!.GetValue<string>(), pair[1]!.GetValue<string>()))).ToArray()).ToJsonString());
                return 0;
            }
            if (args is ["check-render-request"])
            {
                var requests = JsonNode.Parse(await Console.In.ReadToEndAsync()) as JsonArray ?? throw new ArgumentException("Expected a JSON array");
                var answers = new JsonArray();
                foreach (var request in requests)
                {
                    try { RenderRequest.Validate(request); answers.Add((JsonNode)new JsonObject { ["ok"] = true }); }
                    catch (AgentFault e) { answers.Add((JsonNode)new JsonObject { ["error"] = e.Code }); }
                }
                Console.WriteLine(answers.ToJsonString());
                return 0;
            }
            // check-xif-request <root>: stdin [params] -> [{ok:true} | {error}], the checks of o11.xif (tests/native/xif.test.mjs compares them
            // with the Node agent's table). check-xif-locate: stdin {locations, programFiles, existing} -> the folder or null.
            // check-xif-run <root>: stdin {params, studio, answer?, xml?, profile}: one stage on the real kind with a stand-in engine that
            // writes xml (zlib) at the request's output and answers answer, else ok; prints {request, value} or {error}.
            if (args is ["check-xif-request", var xifRoot])
            {
                var requests = JsonNode.Parse(await Console.In.ReadToEndAsync()) as JsonArray ?? throw new ArgumentException("Expected a JSON array");
                var kind = new XifKinds(xifRoot, null, null);
                var answers = new JsonArray();
                foreach (var request in requests)
                {
                    try { kind.Prepare(request); answers.Add((JsonNode)new JsonObject { ["ok"] = true }); }
                    catch (AgentFault e) { answers.Add((JsonNode)new JsonObject { ["error"] = e.Code }); }
                }
                Console.WriteLine(answers.ToJsonString());
                return 0;
            }
            if (args is ["check-xif-locate"])
            {
                var input = JsonNode.Parse(await Console.In.ReadToEndAsync())!.AsObject();
                var existing = (input["existing"]?.AsArray() ?? []).Select(n => n!.GetValue<string>()).ToHashSet(StringComparer.OrdinalIgnoreCase);
                var found = XifKinds.LocateIn((input["locations"]?.AsArray() ?? []).Select(n => n?.GetValue<string>()), (input["programFiles"]?.AsArray() ?? []).Select(n => n?.GetValue<string>()), existing.Contains);
                Console.WriteLine(found == null ? "null" : JsonValue.Create(found)!.ToJsonString());
                return 0;
            }
            if (args is ["check-xif-run", var runRoot])
            {
                var input = JsonNode.Parse(await Console.In.ReadToEndAsync())!.AsObject();
                JsonNode? seen = null;
                var kind = new XifKinds(runRoot, null, null)
                {
                    Locate = () => input["studio"]?.GetValue<string>(), Profile = input["profile"]?.GetValue<string>() ?? "", NativeRoot = input["nativeRoot"]?.GetValue<string>(),
                    Spawn = (exe, text, env, work, timeout, token) =>
                    {
                        var request = JsonNode.Parse(text)!.AsObject();
                        seen = new JsonObject { ["request"] = request.DeepClone(), ["studio"] = env["ANVIL_INTEGRATION_STUDIO_DIR"], ["temp"] = env["TEMP"], ["work"] = work };
                        if (input["answer"] is JsonObject scripted) return Task.FromResult((false, scripted.ToJsonString()));
                        var output = request["output"]!.GetValue<string>();
                        using (var file = File.Create(output)) using (var z = new System.IO.Compression.ZLibStream(file, System.IO.Compression.CompressionLevel.Optimal))
                            z.Write(System.Text.Encoding.UTF8.GetBytes(input["xml"]?.GetValue<string>() ?? "<Extension/>"));
                        return Task.FromResult((false, "log\n" + new JsonObject { ["ok"] = true, ["xif"] = output, ["studio"] = new JsonObject { ["dir"] = env["ANVIL_INTEGRATION_STUDIO_DIR"], ["version"] = "11.14.25.134", ["lastUpgradeVersion"] = "11.0.0.200" }, ["reports"] = new JsonArray() }.ToJsonString()));
                    },
                };
                try { var value = await kind.Execute(input["params"]!.AsObject(), null, CancellationToken.None); Console.WriteLine(new JsonObject { ["seen"] = seen, ["value"] = value }.ToJsonString()); }
                catch (AgentFault e) { Console.WriteLine(new JsonObject { ["seen"] = seen, ["error"] = e.Code, ["executed"] = e.Executed }.ToJsonString()); }
                return 0;
            }
            // check-users-request: stdin [request] -> [{ok:true} | {error}], the checks of o11.users (tests/native/users.test.mjs compares
            // them with the Node agent's). users-helper-sha256: the embedded vault helper's sha.
            if (args is ["check-users-request"])
            {
                var requests = JsonNode.Parse(await Console.In.ReadToEndAsync()) as JsonArray ?? throw new ArgumentException("Expected a JSON array");
                var answers = new JsonArray();
                foreach (var request in requests)
                {
                    try { UsersKinds.Validate(request); answers.Add((JsonNode)new JsonObject { ["ok"] = true }); }
                    catch (AgentFault e) { answers.Add((JsonNode)new JsonObject { ["error"] = e.Code }); }
                }
                Console.WriteLine(answers.ToJsonString());
                return 0;
            }
            // check-users-address: stdin [address] -> [bool]; check-users-lookalike: stdin [[host, [approved]]] -> [text | null].
            if (args is ["check-users-address"])
            {
                var addresses = JsonNode.Parse(await Console.In.ReadToEndAsync()) as JsonArray ?? throw new ArgumentException("Expected a JSON array");
                Console.WriteLine(new JsonArray(addresses.Select(item => (JsonNode?)JsonValue.Create(UsersKinds.IsPrivateAddress(item!.GetValue<string>()))).ToArray()).ToJsonString());
                return 0;
            }
            if (args is ["check-users-lookalike"])
            {
                var cases = JsonNode.Parse(await Console.In.ReadToEndAsync()) as JsonArray ?? throw new ArgumentException("Expected a JSON array");
                Console.WriteLine(new JsonArray(cases.Select(item => (JsonNode?)JsonValue.Create(UsersKinds.LookalikeOf(item![0]!.GetValue<string>(), item[1]!.AsArray().Select(other => other!.GetValue<string>())))).ToArray()).ToJsonString());
                return 0;
            }
            // users-scope <root> <account>: the vault scope, compared with the Node agent's in tests/native/users.test.mjs.
            if (args is ["users-scope", var scopeRoot, var scopeAccount])
            {
                Console.WriteLine(UsersKinds.Scope(scopeRoot, scopeAccount));
                return 0;
            }
            // check-users-flow: stdin {helper, root, account, statePath, steps}: the steps of the behaviour table on the real kind, with a stand-in
            // for the helper, DNS and the clock (tests/native/users.test.mjs compares the answers with the table and with the Node agent).
            if (args is ["check-users-flow"])
            {
                var flow = JsonNode.Parse(await Console.In.ReadToEndAsync()) as JsonObject ?? throw new ArgumentException("Expected a JSON object");
                long offset = 0;
                string[] addresses = ["93.184.216.34"];
                UsersKinds Make()
                {
                    var made = new UsersKinds(flow["root"]!.GetValue<string>(), flow["account"]!.GetValue<string>()) { HelperCommand = flow["helper"]!.AsArray().Select(item => item!.GetValue<string>()).ToArray(), ForceWindows = true };
                    made.Now = () => DateTimeOffset.UtcNow.AddMilliseconds(offset);
                    made.Lookup = _ => Task.FromResult(addresses);
                    if (flow["permitMs"] is JsonValue permitMs) made.PermitTime = TimeSpan.FromMilliseconds(permitMs.GetValue<int>());
                    return made;
                }
                var kind = Make();
                var answers = new JsonArray();
                foreach (var step in flow["steps"]!.AsArray())
                {
                    if (step?["advanceMs"] is JsonValue advance) { offset += advance.GetValue<long>(); answers.Add((JsonNode?)null); continue; }
                    if (step?["dns"] is JsonArray dns) { addresses = dns.Select(item => item!.GetValue<string>()).ToArray(); answers.Add((JsonNode?)null); continue; }
                    if (step?["settled"] is JsonValue) { await kind.WindowsClosed(); answers.Add((JsonNode?)null); continue; }
                    if (step?["restart"] is JsonValue) { kind = Make(); _ = kind.Startup(); answers.Add((JsonNode?)null); continue; }
                    if (step?["waitFor"] is JsonObject target)
                    {
                        // Until the stand-in's state says so: an event, with a limit only for a flow that is wrong.
                        var watched = flow["statePath"]!.GetValue<string>();
                        for (var waited = 0; ; waited += 20)
                        {
                            JsonObject? seen = null;
                            try { seen = JsonNode.Parse(await File.ReadAllTextAsync(watched)) as JsonObject; } catch (Exception e) when (e is IOException or System.Text.Json.JsonException) { }
                            if (seen != null && target.All(pair => JsonNode.DeepEquals(seen[pair.Key], pair.Value))) break;
                            if (waited > 60000) throw new TimeoutException("never reached " + target.ToJsonString());
                            await Task.Delay(20);
                        }
                        answers.Add((JsonNode?)null);
                        continue;
                    }
                    if (step?["set"] is JsonObject set)
                    {
                        var path = flow["statePath"]!.GetValue<string>();
                        var saved = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
                        foreach (var (key, value) in set) saved[key] = value?.DeepClone();
                        await File.WriteAllTextAsync(path, saved.ToJsonString());
                        answers.Add((JsonNode?)null);
                        continue;
                    }
                    try { answers.Add((JsonNode)new JsonObject { ["value"] = (await kind.Execute(step!["params"]!.AsObject(), CancellationToken.None))?.DeepClone() }); }
                    catch (AgentFault e) { answers.Add((JsonNode)new JsonObject { ["code"] = e.Code, ["executed"] = e.Executed }); }
                }
                Console.WriteLine(answers.ToJsonString());
                return 0;
            }
            if (args is ["users-helper-sha256"])
            {
                Console.WriteLine(Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(UsersKinds.HelperBytes())).ToLowerInvariant());
                return 0;
            }
            if (args is ["version"])
            {
                Console.WriteLine("{\"runtime\":\"native-aot\",\"protocol\":\"ssam-agent/1\",\"productionReady\":false}");
                return 0;
            }
            // Qualification is deliberately loopback-only until all existing kinds are ported.
            // No production credentials or installed Studio session are used by this mode.
            // --runtime-root <folder>: a test installation whose pack.json names a renderer (screen.render); nothing else is read there.
            var renderRuntime = args is [.., "--runtime-root", var testRuntime] && args.Length == 9 ? testRuntime : null;
            if (renderRuntime != null) args = args[..7];
            if (args is not ["qualify", "--root", var root, "--server", var server, "--bridge-port", var portText]
                || !int.TryParse(portText, out var port) || port is < 1 or > 65535)
                throw new ArgumentException("Use qualify --root <empty test directory> --server http://127.0.0.1:<port> --bridge-port <port> [--runtime-root <test installation>]");
            var uri = new Uri(server);
            if (uri.Scheme != "http" || uri.Host != "127.0.0.1" || uri.AbsolutePath != "/" || uri.Query != "" || uri.UserInfo != "")
                throw new ArgumentException("Qualification accepts only an IPv4 loopback HTTP server");
            var state = new StateStore(root);
            var credential = await Console.In.ReadLineAsync();
            if (credential != "ssam_native_qualification") throw new ArgumentException("Qualification credential required on stdin");
            using var lifetime = new CancellationTokenSource();
            Console.CancelKeyPress += (_, e) => { e.Cancel = true; lifetime.Cancel(); };
            var render = new RenderKinds(renderRuntime, renderRuntime == null ? null : O11Connection.Read(Path.Combine(renderRuntime, "pack.json")), state.Root);
            using var transport = new AgentChannel(uri, credential, state, port, render: render);
            var run = transport.RunAsync(lifetime.Token);
            while (!run.IsCompleted && !lifetime.IsCancellationRequested)
            {
                if (File.Exists(Path.Combine(state.Private, "agent.stop"))) { lifetime.Cancel(); break; }
                await Task.WhenAny(run, Task.Delay(100));
            }
            return await run;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e is ArgumentException ? e.Message : e.GetType().Name);
            return 1;
        }
    }

    // --name value pairs (flags: options without a value).
    private static Dictionary<string, string> Options(string[] args, params string[] flags)
    {
        var options = new Dictionary<string, string>();
        for (var i = 0; i < args.Length; i++)
        {
            if (flags.Contains(args[i])) { options[args[i]] = "true"; continue; }
            if (!args[i].StartsWith("--") || i + 1 >= args.Length || !options.TryAdd(args[i], args[++i])) throw new ArgumentException("Invalid command options");
        }
        return options;
    }
}

internal sealed class StateStore
{
    private string? previousState;
    public string Root { get; }
    public string Private { get; }
    public StateStore(string root, bool qualification = true)
    {
        if (!Path.IsPathFullyQualified(root)) throw new ArgumentException("Data root must be absolute");
        Root = Path.GetFullPath(root);
        // The qualification harness must own an empty directory; never adopt a user's agent data.
        if (qualification && Directory.Exists(Root) && Directory.EnumerateFileSystemEntries(Root).Any())
            throw new ArgumentException("Qualification needs an empty test directory");
        Private = Path.Combine(Root, "private");
        Directory.CreateDirectory(Private);
        foreach (var folder in new[] { "odc/snapshots", "odc/journal/staging", "odc/lab", "o11/journal/staging", "o11/downloads", "inbox", "private/tmp" })
            Directory.CreateDirectory(Path.Combine(Root, folder));
    }
    public void Write(string state, int? code = null)
    {
        var json = new JsonObject { ["state"] = state, ["pid"] = Environment.ProcessId,
            ["at"] = DateTimeOffset.UtcNow.ToString("O"), ["exitCode"] = code };
        var destination = Path.Combine(Private, "agent.json");
        var temp = destination + ".tmp";
        File.WriteAllText(temp, json.ToJsonString());
        File.Move(temp, destination, true);
        if (previousState != state) {
            File.AppendAllText(Path.Combine(Private, "agent.log"), json.ToJsonString() + Environment.NewLine);
            previousState = state;
        }
    }
}
