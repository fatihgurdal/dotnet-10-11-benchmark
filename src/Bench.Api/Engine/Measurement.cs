using System.Diagnostics;
using System.Text.Json;
using System.Threading.Channels;

namespace Bench.Api.Engine;

/// <summary>A server-sent event ready to be written (payload already serialized to UTF-8 JSON).</summary>
public readonly record struct SseMessage(string Event, byte[] Data);

/// <summary>Process-wide counters captured at a point in time.</summary>
public readonly struct Snapshot
{
    public long Timestamp { get; init; }
    public TimeSpan CpuTime { get; init; }
    public long AllocatedBytes { get; init; }
    public int Gc0 { get; init; }
    public int Gc1 { get; init; }
    public int Gc2 { get; init; }
    public TimeSpan GcPause { get; init; }

    public static Snapshot Take(bool preciseAllocations) => new()
    {
        Timestamp = Stopwatch.GetTimestamp(),
        // Environment.CpuUsage == process user+kernel time (same quantity as Process.TotalProcessorTime, without allocating a Process).
        CpuTime = Environment.CpuUsage.TotalTime,
        AllocatedBytes = GC.GetTotalAllocatedBytes(preciseAllocations),
        Gc0 = GC.CollectionCount(0),
        Gc1 = GC.CollectionCount(1),
        Gc2 = GC.CollectionCount(2),
        GcPause = GC.GetTotalPauseDuration(),
    };
}

/// <summary>
/// Background sampler on a dedicated thread: every ~200 ms records a progress sample, tracks peaks,
/// and hands the serialized event to the SSE writer through a channel. It never touches the HTTP response.
/// </summary>
public sealed class Sampler : IDisposable
{
    public const int IntervalMs = 200;

    private readonly ProgressCounter _progress;
    private readonly long _totalOps;
    private readonly ChannelWriter<SseMessage> _output;
    private readonly ManualResetEventSlim _go = new(false);
    private readonly ManualResetEventSlim _stop = new(false);
    private readonly Thread _thread;
    private readonly int _cpuCount = Math.Max(1, Environment.ProcessorCount);
    private Snapshot _baseline;
    private long _prevTimestamp;
    private TimeSpan _prevCpu;

    public List<ProgressSample> Samples { get; } = new(256);
    public long PeakWorkingSet { get; private set; }
    public long PeakGcHeap { get; private set; }

    public Sampler(ProgressCounter progress, long totalOps, ChannelWriter<SseMessage> output)
    {
        _progress = progress;
        _totalOps = Math.Max(1, totalOps);
        _output = output;
        _thread = new Thread(Loop) { IsBackground = true, Name = "bench-sampler" };
        _thread.Start();
    }

    /// <summary>Starts sampling relative to the measured pass baseline.</summary>
    public void Go(in Snapshot baseline)
    {
        _baseline = baseline;
        _prevTimestamp = baseline.Timestamp;
        _prevCpu = baseline.CpuTime;
        _go.Set();
    }

    /// <summary>Stops the sampler thread and waits for it to exit.</summary>
    public void Stop()
    {
        _stop.Set();
        _go.Set();
        _thread.Join();
    }

    private void Loop()
    {
        _go.Wait();
        long next = _baseline.Timestamp;
        while (true)
        {
            next += Stopwatch.Frequency * IntervalMs / 1000;
            long now = Stopwatch.GetTimestamp();
            long waitTicks = next - now;
            int waitMs = 0;
            if (waitTicks > 0) waitMs = (int)(waitTicks * 1000 / Stopwatch.Frequency);
            else next = now; // fell behind (e.g. long GC suspension): don't burst-sample to catch up
            if (_stop.Wait(waitMs)) return;

            var sample = Capture(Stopwatch.GetTimestamp(), Environment.CpuUsage.TotalTime, GC.GetTotalAllocatedBytes(false), _progress.Done);
            _output.TryWrite(new SseMessage("progress", JsonSerializer.SerializeToUtf8Bytes(sample, AppJsonContext.Default.ProgressSample)));
        }
    }

    /// <summary>Records one sample (called by the sampler thread, and once by the runner after Stop()).</summary>
    public ProgressSample Capture(long timestamp, TimeSpan cpuTime, long totalAllocated, long opsDone)
    {
        long workingSet = Environment.WorkingSet;
        long gcHeap = GC.GetTotalMemory(false);

        double wallMs = Stopwatch.GetElapsedTime(_prevTimestamp, timestamp).TotalMilliseconds;
        double cpuMs = (cpuTime - _prevCpu).TotalMilliseconds;
        _prevTimestamp = timestamp;
        _prevCpu = cpuTime;

        var sample = new ProgressSample(
            T: Math.Round(Stopwatch.GetElapsedTime(_baseline.Timestamp, timestamp).TotalMilliseconds, 1),
            Progress: Math.Round(Math.Clamp((double)opsDone / _totalOps, 0, 1), 4),
            CpuPercent: CpuPercent(cpuMs, wallMs, _cpuCount),
            WorkingSetBytes: workingSet,
            GcHeapBytes: gcHeap,
            TotalAllocatedBytes: totalAllocated - _baseline.AllocatedBytes,
            Gc0: GC.CollectionCount(0) - _baseline.Gc0,
            Gc1: GC.CollectionCount(1) - _baseline.Gc1,
            Gc2: GC.CollectionCount(2) - _baseline.Gc2,
            OpsDone: opsDone);

        if (workingSet > PeakWorkingSet) PeakWorkingSet = workingSet;
        if (gcHeap > PeakGcHeap) PeakGcHeap = gcHeap;
        Samples.Add(sample);
        return sample;
    }

    public static double CpuPercent(double cpuMs, double wallMs, int cpuCount)
    {
        if (wallMs <= 0 || double.IsNaN(cpuMs)) return 0;
        double pct = cpuMs / wallMs / cpuCount * 100.0;
        return Math.Round(Math.Clamp(pct, 0, 100), 1);
    }

    public void Dispose()
    {
        if (_thread.IsAlive) Stop();
        _go.Dispose();
        _stop.Dispose();
    }
}
