namespace Anvil.Core;

/// <summary>
/// Caminhos passados a bridge tem de ser ABSOLUTOS. A bridge corre dentro do processo do Studio, cujo diretorio de trabalho e a
/// pasta da instalacao (open_studio.ps1 arranca com -WorkingDirectory); um caminho relativo era resolvido la e o ficheiro ia
/// parar a "...\Service Studio\.local\producers\Headless_CS.oml" (incidente de 2026-09-04 15:07, plano item 11). O erro diz o
/// verbo, o parametro, o valor e o cwd do momento; nunca le o conteudo do ficheiro.
/// </summary>
public static class PathArgs
{
    public static string Absolute(string verb, string param, string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            throw new ArgumentException($"{verb}: '{param}' is required and must be an absolute path");
        if (!Path.IsPathFullyQualified(value))
            throw new ArgumentException(
                $"{verb}: '{param}' must be an absolute path, got '{value}'. A relative path would be resolved against the Studio process directory " +
                $"({Environment.CurrentDirectory}), not against your repository: pass the full path (e.g. C:\\...\\{value.Replace('/', '\\')})");
        return Path.GetFullPath(value);
    }
}
