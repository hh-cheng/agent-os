import { type Subprocess } from 'bun'

type BunSpawnOptions = NonNullable<Parameters<typeof Bun.spawn>[1]>

export type SpawnCliOptions = Omit<BunSpawnOptions, 'cmd'>

export function killCli(child: Subprocess, signal = 15): void {
  if (!child.pid) return void child.kill()
  if (process.platform !== 'win32') return void child.kill(signal)
  // taskkill /T 把 cmd 连同它下面的 claude.exe/codex.exe 整棵进程树一起杀
  Bun.spawn(['taskkill', '/pid', String(child.pid), '/t', '/f'], {
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
    windowsHide: true,
  })
}

export function spawnCli(
  command: string,
  args: string[],
  options?: SpawnCliOptions,
): Subprocess {
  return Bun.spawn({
    cmd: [command, ...args],
    ...options,
    stdout: options?.stdout ?? 'pipe',
    stderr: options?.stderr ?? 'pipe',
    stdin: options?.stdin ?? 'pipe',
    windowsHide: options?.windowsHide ?? true,
  })
}
