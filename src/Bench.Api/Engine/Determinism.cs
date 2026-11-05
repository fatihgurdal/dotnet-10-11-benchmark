namespace Bench.Api.Engine;

/// <summary>
/// Deterministic, runtime-independent hashing used for workload checksums.
/// Never uses string.GetHashCode / HashCode (both are randomized per process).
/// </summary>
public static class Hash
{
    public const ulong Seed = 14695981039346656037UL;
    private const ulong Prime = 1099511628211UL;

    /// <summary>Order-sensitive combine of a value into a running hash.</summary>
    public static ulong Mix(ulong h, ulong v)
    {
        h ^= v + 0x9E3779B97F4A7C15UL + (h << 6) + (h >> 2);
        h *= Prime;
        return h ^ (h >> 31);
    }

    public static ulong Mix(ulong h, long v) => Mix(h, unchecked((ulong)v));

    /// <summary>FNV-1a over UTF-16 code units.</summary>
    public static ulong Str(ReadOnlySpan<char> s)
    {
        ulong h = Seed;
        foreach (char c in s)
        {
            h ^= c;
            h *= Prime;
        }
        return h;
    }

    /// <summary>FNV-1a over bytes.</summary>
    public static ulong Bytes(ReadOnlySpan<byte> s)
    {
        ulong h = Seed;
        foreach (byte b in s)
        {
            h ^= b;
            h *= Prime;
        }
        return h;
    }

    public static string Format(ulong h) => h.ToString("x16");
}

/// <summary>
/// Small fixed-seed PRNG (SplitMix64 seeding + xorshift64*), identical on every runtime and architecture.
/// </summary>
public struct Rng
{
    private ulong _state;

    public Rng(ulong seed)
    {
        // SplitMix64 to spread small seeds (0, 1, 2...) over the state space.
        ulong z = seed + 0x9E3779B97F4A7C15UL;
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9UL;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBUL;
        z ^= z >> 31;
        _state = z == 0 ? 0x2545F4914F6CDD1DUL : z;
    }

    public ulong NextUInt64()
    {
        ulong x = _state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        _state = x;
        return x * 0x2545F4914F6CDD1DUL;
    }

    /// <summary>Uniform-ish integer in [0, maxExclusive).</summary>
    public int Next(int maxExclusive) => (int)((NextUInt64() >> 33) % (ulong)maxExclusive);

    /// <summary>Integer in [minInclusive, maxExclusive).</summary>
    public int Next(int minInclusive, int maxExclusive) => minInclusive + Next(maxExclusive - minInclusive);

    public bool Chance(int percent) => Next(100) < percent;

    public T Pick<T>(T[] items) => items[Next(items.Length)];
}
