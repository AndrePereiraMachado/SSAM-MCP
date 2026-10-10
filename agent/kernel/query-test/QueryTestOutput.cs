using System.Text;
using System.Text.Json.Nodes;

namespace SSAM.QueryTesting;

public static class QueryTestOutput
{
    public static JsonObject Format(JsonObject description, bool ok, string nativeCode, string? error, string? sql, string[] columns, string[][] rows, int maxRows, bool includeSql)
    {
        var answer = (JsonObject)description.DeepClone(); answer.Remove("parameters");
        answer["ok"] = ok; answer["execution"] = "native-query"; answer["nativeCode"] = Clip(nativeCode, 128);
        if (!ok) { answer["code"] = "QUERY_TEST_DATABASE_ERROR"; answer["error"] = Clip(error ?? "Native test refused the query", 8192); answer["next"] = "Inspect the native error and the published schema/permissions; do not publish automatically."; }
        var clipped = columns.Length > 256; var output = new JsonArray();
        var headers = new JsonArray();
        foreach (var column in columns.Take(256))
        {
            if (column.Length > 512) clipped = true;
            headers.Add(Clip(column,512));
        }
        answer["columns"] = headers; answer["rows"] = output;
        if (includeSql && sql != null) { answer["sql"] = Clip(sql,16384); answer["sqlTruncated"] = sql.Length > 16384; }
        var budget = Encoding.UTF8.GetByteCount(answer.ToJsonString()) + 1024;
        // The shared total budget includes headers, native error and optional SQL, not just row cells.
        // Unusually wide headers may consume it before any rows; trim them deterministically too.
        while (budget > QueryTestContract.MaxBytes && headers.Count > 0)
        {
            budget -= Encoding.UTF8.GetByteCount(headers[^1]!.ToJsonString()) + 1; headers.RemoveAt(headers.Count-1); clipped=true;
        }
        foreach (var row in rows.Take(maxRows))
        {
            var cells = new JsonArray();
            foreach(var cell in row.Take(headers.Count))
            {
                if (cell?.Length > QueryTestContract.MaxCellChars) clipped=true;
                cells.Add(cell == null ? null : Clip(cell,QueryTestContract.MaxCellChars));
            }
            if(row.Length > headers.Count) clipped=true;
            var size = Encoding.UTF8.GetByteCount(cells.ToJsonString()) + 1;
            if (budget + size > QueryTestContract.MaxBytes) { clipped = true; break; }
            budget += size; output.Add(cells);
        }
        answer["count"] = output.Count; answer["limit"] = maxRows;
        answer["truncated"] = clipped || rows.Length > output.Count;
        answer["possiblyMoreRows"] = rows.Length >= maxRows;
        return answer;
    }
    private static string Clip(string value,int size) => value.Length > size ? value[..size] : value;
}
