using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using System.Threading.Channels;
using Microsoft.AspNetCore.Http.Features;

namespace Bench.Api.Engine;

public static class BenchmarkRunner
{
    public const int MaxSamples = 120;

    /// <summary>GET /api/run/{workloadId}/stream?scale=1&amp;warmup=1</summary>
    public static async Task<IResult> StreamAsync(HttpContext ctx, string workloadId, RunGate gate)
    {
        if (!WorkloadRegistry.TryGet(workloadId, out var workload))
        {
            return Results.Json(new ErrorDto("not_found", $"Unknown workload '{workloadId}'."), AppJsonContext.Default.ErrorDto, statusCode: StatusCodes.Status404NotFound);
        }

        int scale = int.TryParse(ctx.Request.Query["scale"], out int s) ? Math.Clamp(s, 1, 8) : 1;
        string? warmupRaw = ctx.Request.Query["warmup"];
        bool warmup = warmupRaw is null || !(warmupRaw == "0" || warmupRaw.Equals("false", StringComparison.OrdinalIgnoreCase));

        if (!gate.TryEnter())
        {
            return Results.Json(new ErrorDto("busy"), AppJsonContext.Default.ErrorDto, statusCode: StatusCodes.Status409Conflict);
        }

        try
        {
            await StreamRunAsync(ctx, workload, scale, warmup);
        }
        finally
        {
            gate.Exit();
        }
        return Results.Empty;
    }

    private static async Task StreamRunAsync(HttpContext ctx, IWorkload workload, int scale, bool warmup)
    {
        CancellationToken ct = ctx.RequestAborted;
        var response = ctx.Response;
        response.StatusCode = StatusCodes.Status200OK;
        response.ContentType = "text/event-stream";
        response.Headers.CacheControl = "no-cache";
        response.Headers["X-Accel-Buffering"] = "no";
        ctx.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

        var channel = Channel.CreateUnbounded<SseMessage>(new UnboundedChannelOptions { SingleReader = true, SingleWriter = false });

        var start = new StartEvent(Guid.NewGuid().ToString("D"), workload.Descriptor.Id, RuntimeInfo.Label, scale, warmup, DateTime.UtcNow);
        channel.Writer.TryWrite(Message("start", start, AppJsonContext.Default.StartEvent));

        // The workload runs on its own dedicated thread; this request task only drains the channel to the socket.
        Task runTask = Task.Factory.StartNew(
            () => Execute(workload, scale, warmup, channel.Writer, ct),
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default);

        try
        {
            await response.StartAsync(ct);
            await foreach (var msg in channel.Reader.ReadAllAsync(ct))
            {
                await WriteEventAsync(response, msg, ct);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Client disconnected: the workload observes the same token at its next unit boundary.
        }
        catch (IOException)
        {
            // Connection reset while writing.
        }
        finally
        {
            // Never release the gate while the workload is still running.
            try { await runTask; } catch { /* reported via the error event */ }
        }
    }

    private static readonly byte[] EventPrefix = "event: "u8.ToArray();
    private static readonly byte[] DataPrefix = "\ndata: "u8.ToArray();
    private static readonly byte[] EventSuffix = "\n\n"u8.ToArray();

    private static async Task WriteEventAsync(HttpResponse response, SseMessage msg, CancellationToken ct)
    {
        var body = response.Body;
        await body.WriteAsync(EventPrefix, ct);
        await body.WriteAsync(Encoding.UTF8.GetBytes(msg.Event), ct);
        await body.WriteAsync(DataPrefix, ct);
        await body.WriteAsync(msg.Data, ct);
        await body.WriteAsync(EventSuffix, ct);
        await body.FlushAsync(ct);
    }

    private static SseMessage Message<T>(string name, T payload, JsonTypeInfo<T> typeInfo)
        => new(name, JsonSerializer.SerializeToUtf8Bytes(payload, typeInfo));

    /// <summary>Warm-up + measured pass. Runs on a dedicated thread; communicates only through the channel.</summary>
    private static void Execute(IWorkload workload, int scale, bool warmup, ChannelWriter<SseMessage> output, CancellationToken ct)
    {
        try
        {
            int measuredUnits = workload.UnitsPerScale * scale;

            if (warmup)
            {
                output.TryWrite(Message("phase", new PhaseEvent("warmup"), AppJsonContext.Default.PhaseEvent));
                int warmupUnits = Math.Max(1, (int)Math.Round(measuredUnits / 10.0));
                workload.Run(warmupUnits, new ProgressCounter(), ct);
            }

            ct.ThrowIfCancellationRequested();
            output.TryWrite(Message("phase", new PhaseEvent("measure"), AppJsonContext.Default.PhaseEvent));

            var progress = new ProgressCounter();
            long totalOps = workload.TotalOps(measuredUnits);
            using var sampler = new Sampler(progress, totalOps, output);

            GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
            GC.WaitForPendingFinalizers();
            GC.Collect();

            Snapshot baseline = Snapshot.Take(preciseAllocations: true);
            sampler.Go(baseline);
            var sw = Stopwatch.StartNew();

            ulong checksum = workload.Run(measuredUnits, progress, ct);

            sw.Stop();
            Snapshot end = Snapshot.Take(preciseAllocations: true);
            sampler.Stop();

            // Final sample at t = end of the measured pass.
            sampler.Capture(end.Timestamp, end.CpuTime, end.AllocatedBytes, progress.Done);

            double durationMs = sw.Elapsed.TotalMilliseconds;
            double cpuTimeMs = (end.CpuTime - baseline.CpuTime).TotalMilliseconds;
            long ops = progress.Done;

            var result = new ResultEvent(
                WorkloadId: workload.Descriptor.Id,
                RuntimeLabel: RuntimeInfo.Label,
                Scale: scale,
                Warmup: warmup,
                DurationMs: Math.Round(durationMs, 3),
                CpuTimeMs: Math.Round(cpuTimeMs, 3),
                AvgCpuPercent: Sampler.CpuPercent(cpuTimeMs, durationMs, Math.Max(1, Environment.ProcessorCount)),
                AllocatedBytes: end.AllocatedBytes - baseline.AllocatedBytes,
                Gc0: end.Gc0 - baseline.Gc0,
                Gc1: end.Gc1 - baseline.Gc1,
                Gc2: end.Gc2 - baseline.Gc2,
                GcPauseMs: Math.Round((end.GcPause - baseline.GcPause).TotalMilliseconds, 3),
                PeakWorkingSetBytes: sampler.PeakWorkingSet,
                PeakGcHeapBytes: sampler.PeakGcHeap,
                Ops: ops,
                OpsPerSec: durationMs > 0 ? Math.Round(ops / (durationMs / 1000.0), 1) : 0,
                Checksum: Hash.Format(checksum),
                Samples: Downsample(sampler.Samples, MaxSamples));

            output.TryWrite(Message("result", result, AppJsonContext.Default.ResultEvent));
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Cancelled because the client went away; nobody is listening.
        }
        catch (Exception ex)
        {
            output.TryWrite(Message("error", new ErrorEvent(ex.GetType().Name + ": " + ex.Message), AppJsonContext.Default.ErrorEvent));
        }
        finally
        {
            output.TryComplete();
        }
    }

    /// <summary>Evenly picks at most <paramref name="max"/> samples, always keeping the first and the last.</summary>
    public static List<ProgressSample> Downsample(List<ProgressSample> samples, int max)
    {
        if (samples.Count <= max) return samples;
        var result = new List<ProgressSample>(max);
        int n = samples.Count;
        for (int i = 0; i < max; i++)
        {
            int idx = (int)Math.Round((double)i * (n - 1) / (max - 1));
            result.Add(samples[idx]);
        }
        return result;
    }
}
