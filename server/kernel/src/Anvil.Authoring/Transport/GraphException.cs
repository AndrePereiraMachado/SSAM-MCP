namespace Anvil.Authoring.Transport;

/// <summary>An ABI3 reference to a supported BCL exception, with a declared CLR type.</summary>
public sealed record GraphException(Type Type) : GraphShape;
public sealed record GraphExceptionRecord(string TypeName, string Message, string? ParamName,
    object? ActualValue, int HResult, int InnerRef);
public sealed record GraphReconciliation(IReadOnlyList<object?> Values, Exception? Failure);

// Fixed BCL code only. No source getters, exception runtime fields or assembly loading.
internal static class GraphExceptions
{
    internal const string Arena = "Exceptions";
    private static readonly IReadOnlyDictionary<string, Type> Types = new[] {
        typeof(Exception), typeof(SystemException), typeof(ApplicationException), typeof(ArgumentException),
        typeof(ArgumentNullException), typeof(ArgumentOutOfRangeException), typeof(InvalidOperationException),
        typeof(NullReferenceException), typeof(IndexOutOfRangeException), typeof(OverflowException),
        typeof(DivideByZeroException), typeof(NotSupportedException), typeof(InvalidCastException), typeof(FormatException)
    }.ToDictionary(t => t.FullName!, StringComparer.Ordinal);

    internal static void Version(int version)
    {
        if (version is not (2 or 3 or 4)) throw new ArgumentException("Unsupported reference graph ABI version.");
    }
    internal static Type Resolve(string name) => (string.IsNullOrEmpty(name) ? null : Types.GetValueOrDefault(name))
        ?? throw new InvalidDataException("Unsupported exact BCL exception type: " + name);
    internal static void ValidateType(Type type)
    {
        if (type.FullName == null || Resolve(type.FullName) != type)
            throw new InvalidDataException("Source/custom exception codecs are not supported.");
    }
    internal static GraphExceptionRecord Capture(Exception value, Func<Exception?, int> reference)
    {
        ValidateType(value.GetType());
        var actual = (value as ArgumentOutOfRangeException)?.ActualValue;
        ValidateActual(actual); // Message on ArgumentOutOfRangeException formats ActualValue.
        return new(value.GetType().FullName!, value.Message, (value as ArgumentException)?.ParamName,
            actual, value.HResult, reference(value.InnerException));
    }
    internal static void ValidateActual(object? actual)
    {
        if (actual is not (null or int or long or string or bool))
            throw new InvalidDataException("Exception ActualValue requires an exact Int32, Int64, String or Boolean scalar.");
    }
    internal static void Validate(GraphExceptionRecord record, int count)
    {
        var type = Resolve(record.TypeName);
        ValidateActual(record.ActualValue);
        if (record.Message == null || record.InnerRef < 0 || record.InnerRef > count)
            throw new InvalidDataException("Invalid exception message or inner reference.");
        if (record.ParamName != null && !typeof(ArgumentException).IsAssignableFrom(type)
            || record.ActualValue != null && type != typeof(ArgumentOutOfRangeException))
            throw new InvalidDataException("Exception payload differs from its exact BCL type.");
        if (record.InnerRef != 0 && type != typeof(ArgumentException)
            && (record.ParamName != null || record.ActualValue != null))
            throw new InvalidDataException("No supported BCL constructor preserves this exception payload and inner reference.");
    }
    internal static Exception Create(GraphExceptionRecord record, Exception? inner)
    {
        // Message is the observed text, including BCL parameter/actual-value suffixes.
        // Obtain the exact runtime suffix with an empty base message, strip exactly one,
        // and verify the constructed result. Never guess private _message storage.
        var suffix = Construct(record, "", null).Message;
        if (!record.Message.EndsWith(suffix, StringComparison.Ordinal))
            throw new InvalidDataException("Exception message is inconsistent with its BCL payload suffix.");
        var message = record.Message[..(record.Message.Length - suffix.Length)];
        var result = Construct(record, message, inner);
        var observed = Capture(result, value => value == null ? 0 : record.InnerRef);
        if (observed != record)
            throw new InvalidDataException("Exception payload cannot be preserved by its supported BCL constructor.");
        return result;
    }
    private static Exception Construct(GraphExceptionRecord record, string message, Exception? inner) => record.TypeName switch {
        "System.Exception" => new Exception(message, inner),
        "System.SystemException" => new SystemException(message, inner),
        "System.ApplicationException" => new ApplicationException(message, inner),
        "System.ArgumentException" => new ArgumentException(message, record.ParamName, inner),
        "System.ArgumentNullException" => inner == null ? new ArgumentNullException(record.ParamName, message) : new ArgumentNullException(message, inner),
        "System.ArgumentOutOfRangeException" => inner == null ? new ArgumentOutOfRangeException(record.ParamName, record.ActualValue, message) : new ArgumentOutOfRangeException(message, inner),
        "System.InvalidOperationException" => new InvalidOperationException(message, inner),
        "System.NullReferenceException" => new NullReferenceException(message, inner),
        "System.IndexOutOfRangeException" => new IndexOutOfRangeException(message, inner),
        "System.OverflowException" => new OverflowException(message, inner),
        "System.DivideByZeroException" => new DivideByZeroException(message, inner),
        "System.NotSupportedException" => new NotSupportedException(message, inner),
        "System.InvalidCastException" => new InvalidCastException(message, inner),
        "System.FormatException" => new FormatException(message, inner),
        _ => throw new InvalidDataException("Unsupported exact BCL exception type: " + record.TypeName)
    };

    internal static void Prepare(IReadOnlyList<object> cells, IReadOnlyDictionary<GraphHandle, object> originals,
        IReadOnlyList<object> captured, Dictionary<GraphHandle, object> objects)
    {
        // Iterative postorder supports forward/shared inner references without relying on
        // CLR recursion depth. Inner cycles are impossible through these public constructors.
        var inputRefs = originals.Where(p => p.Key.Type == Arena)
            .ToDictionary(p => p.Value, p => p.Key.Index, ReferenceEqualityComparer.Instance);
        var visited = new byte[cells.Count];
        for (var index = 0; index < cells.Count; index++)
        {
            var path = new Stack<int>(); var current = index;
            while (current >= 0 && visited[current] == 0)
            {
                visited[current] = 1; path.Push(current);
                current = ((GraphExceptionRecord)cells[current]).InnerRef - 1;
            }
            if (current >= 0 && visited[current] == 1)
                throw new InvalidDataException("Cyclic InnerException payload is not supported by BCL constructors.");
            while (path.TryPop(out current))
            {
                var handle = new GraphHandle(Arena, current + 1);
                var record = (GraphExceptionRecord)cells[current];
                if (originals.TryGetValue(handle, out var original))
                {
                    var observed = Capture((Exception)original, inner => inner == null ? 0 : inputRefs.GetValueOrDefault(inner, -1));
                    if (record != (GraphExceptionRecord)captured[current] || record != observed)
                        throw new InvalidDataException("Input exception payload mutation is not supported.");
                }
                else objects.Add(handle, Create(record, record.InnerRef == 0 ? null : (Exception)objects[new(Arena, record.InnerRef)]));
                visited[current] = 2;
            }
        }
    }
}
