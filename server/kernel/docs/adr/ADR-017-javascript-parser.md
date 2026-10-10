# Esprima 3.0.6 — dependency decision

2026-09-06. Purpose: parse authored JavaScript without executing it in the compiler. Package pinned to 3.0.6;
.NET 8 selects netstandard2.1, whose NuGet dependency group is empty. The package metadata identifies source
commit 5b601a36aa54956768c943a676ae9d6237bed8b0. No JavaScript runtime library is injected into generated apps.

BSD-3-Clause permits source/binary redistribution with retained notices and a non-endorsement condition;
it does not require disclosure of the proprietary Hybrid implementation. Preserve licenses/Esprima-3.0.6.txt
in distribution materials. This is an engineering compatibility assessment for this package/version, not
an assertion about all SDKs, future updates or the complete product dependency inventory.

Sources: https://www.nuget.org/packages/Esprima/3.0.6 and
https://github.com/sebastienros/esprima-dotnet/blob/v3.0.6/LICENSE.txt.
Inspect project.assets.json and publish outputs when packaging; licenses must accompany the compiler.
