import { expect, test } from 'bun:test'
import { spawnCli } from './spawn-cli'

test('without a CLI proxy, the supplied child environment is preserved', async () => {
  const env = {
    ...process.env,
    CLI_PROXY_URL: '',
    HTTPS_PROXY: 'http://example.test:8080',
  }
  const child = spawnCli(
    process.execPath,
    ['-e', 'console.log(process.env.HTTPS_PROXY)'],
    { env },
  )
  expect(
    (await new Response(child.stdout as ReadableStream).text()).trim(),
  ).toBe(env.HTTPS_PROXY)
  expect(await child.exited).toBe(0)
})

test('CLI proxy overrides stale inherited proxy variables in the child', async () => {
  const env = {
    ...process.env,
    CLI_PROXY_URL: 'http://127.0.0.1:7897',
    HTTP_PROXY: 'http://127.0.0.1:7890',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    ALL_PROXY: 'socks5://127.0.0.1:7890',
    http_proxy: 'http://127.0.0.1:7890',
    https_proxy: 'http://127.0.0.1:7890',
    all_proxy: 'socks5://127.0.0.1:7890',
    NO_PROXY: 'open.feishu.cn',
  }
  const keys = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'NO_PROXY',
  ]
  const child = spawnCli(
    process.execPath,
    [
      '-e',
      `console.log(JSON.stringify(${JSON.stringify(keys)}.map(k => process.env[k])))`,
    ],
    { env },
  )
  const values = await new Response(child.stdout as ReadableStream).json()
  expect(await child.exited).toBe(0)
  expect(values).toEqual([...Array(6).fill(env.CLI_PROXY_URL), env.NO_PROXY])
  expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
})
