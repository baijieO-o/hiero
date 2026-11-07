import { execFile } from 'node:child_process';
import os from 'node:os';

export type SystemStats = {
  cpuPercent: number;
  memPercent: number;
  /** Null when no NVIDIA GPU or nvidia-smi is unavailable. */
  gpuPercent: number | null;
};

type CpuTimes = { idle: number; total: number };

function readCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const { user, nice, sys, idle: cpuIdle, irq } = cpu.times;
    idle += cpuIdle;
    total += user + nice + sys + cpuIdle + irq;
  }
  return { idle, total };
}

/** Reads GPU utilization of the first NVIDIA device. Resolves to null on any failure. */
export function readGpuPercent(timeoutMs = 1500): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null);
        const value = Number.parseFloat(stdout.split(/\r?\n/)[0] ?? '');
        resolve(Number.isFinite(value) ? Math.round(value) : null);
      },
    );
  });
}

/** Samples CPU as the busy share since the previous call. The first call measures since boot. */
export class SystemStatsSampler {
  private previous = readCpuTimes();

  public async sample(): Promise<SystemStats> {
    const current = readCpuTimes();
    const totalDelta = current.total - this.previous.total;
    const idleDelta = current.idle - this.previous.idle;
    this.previous = current;
    const cpuPercent = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0;
    const memoryPercent = (1 - os.freemem() / os.totalmem()) * 100;
    return {
      cpuPercent: Math.round(cpuPercent),
      memPercent: Math.round(memoryPercent),
      gpuPercent: await readGpuPercent(),
    };
  }
}
