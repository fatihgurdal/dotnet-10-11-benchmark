using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Bench.Api.Engine;

namespace Bench.Api.Workloads;

/// <summary>
/// Log-line style string processing: interpolation, StringBuilder, Split/Join, Replace, source-generated Regex,
/// UTF-8 encode/decode, number parsing/formatting and ordinal searches.
/// </summary>
public sealed partial class StringsWorkload : Workload
{
    private const int LinesPerUnit = 20_000;

    private static readonly string[] Levels = ["INFO", "INFO", "INFO", "WARN", "DEBUG", "ERROR"];
    private static readonly string[] Actions = ["giriş", "çıkış", "ödeme", "sepete_ekle", "arama", "kredi_başvurusu", "profil_güncelle", "şifre_sıfırla"];
    private static readonly string[] Cities = ["İstanbul", "Ankara", "İzmir", "Bursa", "Adana", "Gaziantep"];
    private static readonly DateTime BaseTime = new(2026, 3, 1, 8, 0, 0, DateTimeKind.Utc);

    public override WorkloadDto Descriptor { get; } = Describe(
        "strings", "strings", "String processing",
        "Metin İşleme",
        "Log satırları üretir; Regex, Split, Replace ve UTF-8 dönüşümleriyle ayrıştırır.",
        "🔤", "satır");

    public override int UnitsPerScale => 60;

    public override long OpsPerUnit => LinesPerUnit;

    [GeneratedRegex(@"user=(?<user>\d+)\s+action=(?<action>[\w]+)\s+amount=(?<amount>\d+\.\d{2})", RegexOptions.CultureInvariant)]
    private static partial Regex LogLineRegex();

    [GeneratedRegex(@"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", RegexOptions.CultureInvariant)]
    private static partial Regex IpRegex();

    protected override ulong RunUnit(int unit)
    {
        var rng = new Rng(0x5791_0000UL + (ulong)unit);
        var log = new StringBuilder(LinesPerUnit * 140);
        ulong h = Hash.Seed;
        long parsedUsers = 0;
        decimal parsedAmount = 0m;
        int errors = 0;
        int regexHits = 0;
        int maskedLength = 0;
        var actionCounts = new Dictionary<string, int>(StringComparer.Ordinal);

        for (int i = 0; i < LinesPerUnit; i++)
        {
            DateTime ts = BaseTime.AddMilliseconds(unit * 3_600_000L + i * 357L + rng.Next(300));
            string level = rng.Pick(Levels);
            int userId = rng.Next(1, 2_000_000);
            string action = rng.Pick(Actions);
            decimal amount = rng.Next(0, 5_000_000) / 100m;
            string ip = $"{rng.Next(1, 255)}.{rng.Next(0, 256)}.{rng.Next(0, 256)}.{rng.Next(1, 255)}";
            string city = rng.Pick(Cities);

            string line = $"{ts:yyyy-MM-dd HH:mm:ss.fff} [{level}] user={userId} action={action} amount={amount:F2} ip={ip} city={city} session={rng.NextUInt64():x16}";
            log.AppendLine(line);

            // Tokenize.
            string[] parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts[2] == "[ERROR]") errors++;
            parsedUsers += long.Parse(parts[3].AsSpan(5), CultureInfo.InvariantCulture);

            // Regex extraction (source generated).
            Match m = LogLineRegex().Match(line);
            if (m.Success)
            {
                regexHits++;
                parsedAmount += decimal.Parse(m.Groups["amount"].ValueSpan, NumberStyles.Number, CultureInfo.InvariantCulture);
                string act = m.Groups["action"].Value;
                actionCounts[act] = actionCounts.TryGetValue(act, out int c) ? c + 1 : 1;
            }

            // Masking / normalization.
            string masked = IpRegex().Replace(line, "x.x.x.x").Replace("session=", "sid=", StringComparison.Ordinal);
            maskedLength += masked.Length;
            if (line.Contains("kredi", StringComparison.Ordinal)) h = Hash.Mix(h, line.IndexOf("city=", StringComparison.Ordinal));
            if ((i & 63) == 0) h = Hash.Mix(h, Hash.Str(masked.ToUpperInvariant()));
        }

        string text = log.ToString();

        // UTF-8 round trip.
        byte[] utf8 = Encoding.UTF8.GetBytes(text);
        string decoded = Encoding.UTF8.GetString(utf8);
        h = Hash.Mix(h, utf8.Length);
        h = Hash.Mix(h, decoded.Length);

        // Split the whole log back into lines and build a CSV report.
        string[] lines = decoded.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var csv = new StringBuilder();
        csv.AppendLine("zaman;seviye;kullanıcı;işlem;tutar");
        for (int i = 0; i < lines.Length; i += 4)
        {
            string[] f = lines[i].Split(' ');
            csv.AppendJoin(';', f[1], f[2].Trim('[', ']'), f[3][5..], f[4][7..], f[5][7..]).Append('\n');
        }
        string csvText = csv.ToString();
        h = Hash.Mix(h, csvText.Length);
        h = Hash.Mix(h, Hash.Str(csvText.AsSpan(0, Math.Min(4_096, csvText.Length))));

        // Join + number formatting.
        string joined = string.Join(", ", actionCounts.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => $"{kv.Key}={kv.Value:N0}"));
        h = Hash.Mix(h, Hash.Str(joined));
        Span<char> buffer = stackalloc char[32];
        long formattedLength = 0;
        for (int i = 0; i < 2_000; i++)
        {
            long value = (long)i * 7_919_003 + unit;
            if (value.TryFormat(buffer, out int written, "N0", CultureInfo.InvariantCulture)) formattedLength += written;
            formattedLength += (value % 100_000 / 100m).ToString("C2", CultureInfo.InvariantCulture).Length;
        }

        h = Hash.Mix(h, formattedLength);
        h = Hash.Mix(h, parsedUsers);
        h = Hash.Mix(h, (long)(parsedAmount * 100m));
        h = Hash.Mix(h, errors);
        h = Hash.Mix(h, regexHits);
        return Hash.Mix(h, maskedLength);
    }
}
