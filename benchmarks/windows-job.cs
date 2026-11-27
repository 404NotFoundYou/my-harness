using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.IO;
using Microsoft.Win32.SafeHandles;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

// The supervisor joins its own non-breakaway job before starting any client.
// Its private handle survives the CLI leader and is closed by Windows on cutoff.
internal static class WindowsJob {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
    }
    [DllImport("kernel32", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, int size);
    [DllImport("kernel32", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("msvcrt.dll", CallingConvention = CallingConvention.Cdecl)] static extern IntPtr _get_osfhandle(int fd);
    [DllImport("kernel32", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    static int Main(string[] args) {
        try {
            var job = CreateJobObject(IntPtr.Zero, null);
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)) ||
                !AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle)) throw new Win32Exception();

            // Keep libuv's original Windows quoting for every argument after the two executable names.
            var prefix = Regex.Match(Environment.CommandLine, @"^\s*(?:""[^""]+""|\S+)\s+(?:""[^""]+""|\S+)(?:\s+|$)");
            if (!prefix.Success) throw new ArgumentException("Missing client executable");
            var exitPipe = _get_osfhandle(3);
            if (!SetHandleInformation(exitPipe, 1, 0)) throw new Win32Exception(); // Private supervisor-to-host signal.
            var start = new ProcessStartInfo(args[0], Environment.CommandLine.Substring(prefix.Length)) {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
            };
            using (var signal = new FileStream(new SafeFileHandle(exitPipe, false), FileAccess.Write))
            using (var client = Process.Start(start)) {
                var stdout = client.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                var stderr = client.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                client.WaitForExit();
                signal.WriteByte(1);
                signal.Flush();
                // Pipe-holding children keep the trial open. Detached helpers with closed pipes
                // are reclaimed by job closure without converting a completed trial to a timeout.
                Task.WaitAll(stdout, stderr);
                return client.ExitCode;
            }
        } catch (Exception error) {
            Console.Error.WriteLine("Windows benchmark job: " + error.Message);
            return 1;
        }
    }
}
