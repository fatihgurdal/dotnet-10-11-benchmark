namespace Bench.Api.Engine;

/// <summary>Allows only one benchmark run (or forced GC) at a time per process.</summary>
public sealed class RunGate
{
    private int _busy;

    public bool IsBusy => Volatile.Read(ref _busy) != 0;

    public bool TryEnter() => Interlocked.CompareExchange(ref _busy, 1, 0) == 0;

    public void Exit() => Volatile.Write(ref _busy, 0);
}
