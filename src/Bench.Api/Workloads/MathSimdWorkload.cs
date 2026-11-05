using System.Buffers;
using System.Numerics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Bench.Api.Engine;

namespace Bench.Api.Workloads;

/// <summary>
/// CPU-bound numeric work: sieve of Eratosthenes, integer matrix multiply with Vector&lt;T&gt;,
/// SHA-256, CRC32C via BitOperations, popcount, BigInteger and vectorized span/string searches.
/// Everything is integer arithmetic so results are bit-identical on every runtime and CPU.
/// </summary>
public sealed class MathSimdWorkload : Workload
{
    private const int SieveLimit = 2_000_000;
    private const int MatrixSize = 128;
    private const int BufferSize = 1 << 20; // 1 MiB

    public override WorkloadDto Descriptor { get; } = Describe(
        "math-simd", "cpu", "Math, SIMD & hashing",
        "Matematik ve SIMD",
        "Asal elek, vektörel matris çarpımı, SHA-256, CRC32C ve vektörel arama yapar.",
        "🧮", "iterasyon");

    public override int UnitsPerScale => 280;

    public override long OpsPerUnit => 1;

    private byte[] _buffer = [];
    private string _text = "";
    private int[] _numbers = [];

    private static readonly SearchValues<char> Punctuation = SearchValues.Create(".,;:!?");

    protected override void BeginRun()
    {
        var rng = new Rng(0x51AD_0000UL);
        _buffer = new byte[BufferSize];
        for (int i = 0; i < _buffer.Length; i += 8)
            BitConverter.TryWriteBytes(_buffer.AsSpan(i), rng.NextUInt64());

        string[] words = ["kredi", "faiz", "vade", "taksit", "banka", "hesap", "kart", "puan", "limit", "oran"];
        var sb = new System.Text.StringBuilder(1 << 20);
        while (sb.Length < (1 << 20))
        {
            sb.Append(words[rng.Next(words.Length)]);
            sb.Append(rng.Chance(8) ? ". " : " ");
        }
        _text = sb.ToString();

        _numbers = new int[1 << 18];
        for (int i = 0; i < _numbers.Length; i++) _numbers[i] = rng.Next(8_000); // keeps int Sum() within range
    }

    protected override void EndRun()
    {
        _buffer = [];
        _text = "";
        _numbers = [];
    }

    protected override ulong RunUnit(int unit)
    {
        ulong h = Hash.Seed;
        h = Hash.Mix(h, CountPrimes(SieveLimit - unit * 1_000));
        h = Hash.Mix(h, MatrixChecksum(unit));
        h = Hash.Mix(h, HashBuffers(unit));
        h = Hash.Mix(h, SearchText(unit));
        h = Hash.Mix(h, SpanOps(unit));
        h = Hash.Mix(h, BigIntegerWork(unit));
        return h;
    }

    private static int CountPrimes(int limit)
    {
        var composite = new bool[limit + 1];
        int count = 0;
        for (int i = 2; i <= limit; i++)
        {
            if (composite[i]) continue;
            count++;
            for (long j = (long)i * i; j <= limit; j += i) composite[j] = true;
        }
        return count;
    }

    private static long MatrixChecksum(int unit)
    {
        const int n = MatrixSize;
        var a = new int[n * n];
        var bT = new int[n * n]; // B stored transposed so rows are contiguous
        var c = new int[n * n];
        var rng = new Rng(0x3A7_0000UL + (ulong)unit);
        for (int i = 0; i < a.Length; i++) a[i] = rng.Next(-128, 128);
        for (int i = 0; i < bT.Length; i++) bT[i] = rng.Next(-128, 128);

        for (int round = 0; round < 6; round++)
        {
            for (int i = 0; i < n; i++)
            {
                ReadOnlySpan<int> rowA = a.AsSpan(i * n, n);
                for (int j = 0; j < n; j++)
                {
                    c[i * n + j] = Dot(rowA, bT.AsSpan(j * n, n));
                }
            }
            // Feed the result back (quantized) to keep values bounded and every round dependent on the previous one.
            for (int k = 0; k < a.Length; k++) a[k] = (c[k] >> 8) % 128;
        }

        long sum = 0;
        foreach (int v in c) sum += v;
        return sum;
    }

    private static int Dot(ReadOnlySpan<int> x, ReadOnlySpan<int> y)
    {
        var acc = Vector<int>.Zero;
        int i = 0;
        if (Vector.IsHardwareAccelerated)
        {
            for (; i <= x.Length - Vector<int>.Count; i += Vector<int>.Count)
                acc += new Vector<int>(x.Slice(i)) * new Vector<int>(y.Slice(i));
        }
        int result = Vector.Sum(acc);
        for (; i < x.Length; i++) result += x[i] * y[i];
        return result;
    }

    private long HashBuffers(int unit)
    {
        long h = 0;
        Span<byte> digest = stackalloc byte[32];
        for (int r = 0; r < 4; r++)
        {
            int offset = (unit * 4096 + r * 65536) % (BufferSize / 2);
            SHA256.HashData(_buffer.AsSpan(offset, BufferSize / 2), digest);
            h ^= BitConverter.ToInt64(digest) ^ BitConverter.ToInt64(digest[8..]);
        }

        uint crc = 0xFFFFFFFF;
        foreach (ulong word in MemoryMarshal.Cast<byte, ulong>(_buffer.AsSpan()))
            crc = BitOperations.Crc32C(crc, word);
        h ^= (long)crc << 16;

        long popcount = 0;
        foreach (ulong word in MemoryMarshal.Cast<byte, ulong>(_buffer.AsSpan()))
            popcount += BitOperations.PopCount(word ^ (ulong)unit);
        return h ^ popcount;
    }

    private long SearchText(int unit)
    {
        string text = _text;
        ReadOnlySpan<char> span = text;
        string[] needles = ["taksit oran", "kredi limit", "banka hesap", "puan. vade"];
        long hits = 0;
        foreach (string needle in needles)
        {
            int pos = 0;
            int idx;
            while ((idx = span[pos..].IndexOf(needle, StringComparison.Ordinal)) >= 0)
            {
                hits++;
                pos += idx + needle.Length;
            }
        }
        hits += text.Contains("vade vade vade", StringComparison.Ordinal) ? 1 : 0;
        hits += span.Count('.');
        hits += span.IndexOfAny(Punctuation);
        hits += span.LastIndexOf("faiz", StringComparison.Ordinal);
        hits += MemoryExtensions.Count(span, "kart");
        hits += text.IndexOf("zzz", StringComparison.Ordinal); // absent: scans the whole text
        return hits + unit;
    }

    private long SpanOps(int unit)
    {
        int[] numbers = _numbers;
        long r = 0;
        for (int k = 0; k < 16; k++)
        {
            r += Array.IndexOf(numbers, 1_000_000 + k); // absent value: full vectorized scan
            r += numbers.AsSpan().IndexOf(8_000 - 1 - (unit * 31 + k) % 64);
        }
        r += numbers.Sum();
        r += numbers.Max() - numbers.Min();

        byte[] copy = _buffer.AsSpan(0, BufferSize / 2).ToArray();
        r += copy.AsSpan().SequenceEqual(_buffer.AsSpan(0, BufferSize / 2)) ? 1 : 0;
        copy.AsSpan().Reverse();
        r += copy.AsSpan().SequenceCompareTo(_buffer.AsSpan(0, BufferSize / 2));
        r += copy.AsSpan().IndexOfAnyExcept((byte)0);
        r += copy.AsSpan().Count((byte)(unit & 0xFF));
        return r;
    }

    private static long BigIntegerWork(int unit)
    {
        var modulus = BigInteger.Pow(2, 521) - 1; // Mersenne prime M521
        var b = new BigInteger(0x5DEECE66DL + unit);
        BigInteger x = BigInteger.ModPow(b, BigInteger.Pow(10, 40) + unit, modulus);
        BigInteger f = 1;
        for (int i = 2; i <= 300; i++) f *= i;
        return (long)(x % 1_000_000_007) ^ (long)(f % 998_244_353);
    }
}
