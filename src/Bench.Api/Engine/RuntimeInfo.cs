using System.Globalization;
using System.Runtime;
using System.Runtime.InteropServices;

namespace Bench.Api.Engine;

public static class RuntimeInfo
{
    public static readonly string FrameworkDescription = RuntimeInformation.FrameworkDescription;

    /// <summary>"10.0.5" or "11.0.0-rc.3.26522.148" (everything after the ".NET " prefix).</summary>
    public static readonly string Version = ParseVersion(FrameworkDescription);

    public static readonly string Label = ".NET " + Version;

    public static readonly int Major = Environment.Version.Major;

    public static readonly string Tfm = ParseTfm(AppContext.TargetFrameworkName);

    public static InfoDto Get(bool busy)
    {
        var gcInfo = GC.GetGCMemoryInfo();
        return new InfoDto(
            RuntimeLabel: Label,
            FrameworkDescription: FrameworkDescription,
            Version: Version,
            Major: Major,
            Tfm: Tfm,
            Os: RuntimeInformation.OSDescription,
            Arch: RuntimeInformation.ProcessArchitecture.ToString(),
            ProcessorCount: Environment.ProcessorCount,
            MemoryLimitBytes: gcInfo.TotalAvailableMemoryBytes,
            Gc: new GcInfoDto(
                Server: GCSettings.IsServerGC,
                Concurrent: GCSettings.LatencyMode != GCLatencyMode.Batch,
                HeapHardLimit: ExplicitHeapHardLimit()),
            TieredCompilation: IsKnobEnabled("System.Runtime.TieredCompilation", "TieredCompilation"),
            TieredPgo: IsKnobEnabled("System.Runtime.TieredPGO", "TieredPGO"),
            Busy: busy);
    }

    private static string ParseVersion(string description)
    {
        string s = description.Trim();
        if (s.StartsWith(".NET ", StringComparison.Ordinal)) return s[5..].Trim();
        if (s.StartsWith("NET ", StringComparison.Ordinal)) return s[4..].Trim();
        int space = s.LastIndexOf(' ');
        return space >= 0 ? s[(space + 1)..] : s;
    }

    private static string ParseTfm(string? targetFrameworkName)
    {
        // ".NETCoreApp,Version=v10.0" -> "net10.0"
        if (targetFrameworkName is not null)
        {
            int idx = targetFrameworkName.IndexOf("Version=v", StringComparison.Ordinal);
            if (idx >= 0) return "net" + targetFrameworkName[(idx + "Version=v".Length)..];
        }
        return "net" + Environment.Version.Major.ToString(CultureInfo.InvariantCulture) + ".0";
    }

    /// <summary>runtimeconfig switch or DOTNET_/COMPlus_ environment knob; enabled unless explicitly turned off.</summary>
    private static bool IsKnobEnabled(string appContextName, string envName)
    {
        string? env = Environment.GetEnvironmentVariable("DOTNET_" + envName)
                      ?? Environment.GetEnvironmentVariable("COMPlus_" + envName);
        if (env is not null) return env.Trim() != "0";
        if (AppContext.TryGetSwitch(appContextName, out bool enabled)) return enabled;
        return true;
    }

    /// <summary>Explicitly configured GC heap hard limit (runtimeconfig or env); null when not configured.</summary>
    private static long? ExplicitHeapHardLimit()
    {
        string? env = Environment.GetEnvironmentVariable("DOTNET_GCHeapHardLimit")
                      ?? Environment.GetEnvironmentVariable("COMPlus_GCHeapHardLimit");
        if (env is not null && long.TryParse(env.Trim(), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out long hex) && hex > 0)
            return hex;

        object? data = AppContext.GetData("System.GC.HeapHardLimit");
        if (data is not null && long.TryParse(Convert.ToString(data, CultureInfo.InvariantCulture), NumberStyles.Integer, CultureInfo.InvariantCulture, out long cfg) && cfg > 0)
            return cfg;

        return null;
    }
}
