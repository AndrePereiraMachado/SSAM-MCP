// ssam-skia-probe <studio folder>: proves that the Studio's SkiaSharp and HarfBuzzSharp find their native libraries in this
// image (R4, family B of C:\t\r4\CAPTURA-FALHA.md). On 02/11 the hosted O11 kernel aborted mid-apply: Studio code built an
// SKPaint during a headless apply, the P/Invoke failed (no libSkiaSharp.so: the Studio ships only the Windows DLLs), the
// Studio swallowed that, and the GC then ran the SKPaint finalizer, whose TypeInitializationException on the finalizer
// thread is unhandled: SIGABRT and a core dump, no envelope.
// The probe does what that apply did, in the same order: SkiaSharp and HarfBuzzSharp loaded from the Studio folder (the
// native library is looked for next to them, as for the kernels), objects created, some left to their finalizers, then the
// finalizers run. Exit 0 with one JSON line when all of it works. Exit 1 with the errors when a call failed; a missing
// native library may also abort the process from the finalizer thread (exit 134), exactly the production failure.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;

static class Program
{
    static string studio;

    static int Main(string[] args)
    {
        if (args.Length != 1 || !File.Exists(Path.Combine(args[0], "SkiaSharp.dll")))
        {
            Console.Error.WriteLine("usage: ssam-skia-probe <studio folder holding SkiaSharp.dll>");
            return 2;
        }
        studio = Path.GetFullPath(args[0]);
        AssemblyLoadContext.Default.Resolving += (context, name) =>
        {
            var file = Path.Combine(studio, name.Name + ".dll");
            return File.Exists(file) ? context.LoadFromAssemblyPath(file) : null;
        };
        var errors = new List<string>();
        var native = Exercise(errors);
        // The finalizers of what Exercise left behind (the SKPaint of the 02/11 abort among them), twice: a finalizer may
        // free another finalizable object.
        for (var i = 0; i < 2; i++) { GC.Collect(); GC.WaitForPendingFinalizers(); }
        var ok = errors.Count == 0;
        Console.WriteLine("{\"ok\":" + (ok ? "true" : "false") + ",\"studio\":\"" + studio + "\"," + native
            + ",\"errors\":[" + string.Join(",", errors.ConvertAll(e => "\"" + e.Replace("\\", "\\\\").Replace("\"", "'") + "\"")) + "]}");
        return ok ? 0 : 1;
    }

    // No inlining: the objects created here are unreachable once it returns, so the GC above finalizes them.
    [MethodImpl(MethodImplOptions.NoInlining)]
    static string Exercise(List<string> errors)
    {
        string skia = null, harfbuzz = null;
        Try(errors, "SKObject", () => RuntimeHelpers.RunClassConstructor(typeof(SkiaSharp.SKObject).TypeHandle));
        Try(errors, "SKPaint", () => { var paint = new SkiaSharp.SKPaint { IsAntialias = true, TextSize = 12 }; GC.KeepAlive(paint); });
        Try(errors, "SKTypeface", () =>
        {
            var typeface = SkiaSharp.SKTypeface.Default;
            using var font = new SkiaSharp.SKFont(typeface, 12);
            using var bitmap = new SkiaSharp.SKBitmap(64, 16);
            using var canvas = new SkiaSharp.SKCanvas(bitmap);
            using var paint = new SkiaSharp.SKPaint { Typeface = typeface, TextSize = 12 };
            canvas.Clear(SkiaSharp.SKColors.White);
            canvas.DrawText("SSAM", 0, 12, paint);
            paint.MeasureText("SSAM");
        });
        Try(errors, "SkiaSharpVersion", () => skia = SkiaSharp.SkiaSharpVersion.Native.ToString());
        Try(errors, "HarfBuzzBuffer", () =>
        {
            var left = new HarfBuzzSharp.Buffer(); // to its finalizer
            left.AddUtf16("SSAM");
            using var buffer = new HarfBuzzSharp.Buffer();
            buffer.AddUtf16("SSAM");
            buffer.GuessSegmentProperties();
            harfbuzz = buffer.Length.ToString();
        });
        return "\"skiaNative\":\"" + (skia ?? "") + "\",\"harfbuzzGlyphs\":\"" + (harfbuzz ?? "") + "\"";
    }

    static void Try(List<string> errors, string step, Action action)
    {
        try { action(); }
        catch (Exception e)
        {
            var inner = e;
            while (inner.InnerException != null) inner = inner.InnerException;
            errors.Add(step + ": " + e.GetType().FullName + (inner != e ? " -> " + inner.GetType().FullName : "") + ": " + inner.Message.Split('\n')[0]);
        }
    }
}
