import type { Config } from './config';

const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

/** Process-local policy; never reads or changes operating-system proxy settings. */
export function configureNetwork(mode: Config['networkMode'], env: NodeJS.ProcessEnv = process.env) {
  if (mode === 'direct') for (const key of proxyKeys) delete env[key];
  // Local speech and callback traffic must stay on this host, including under a proxy.
  const exclusions = new Set(`${env.NO_PROXY ?? ''},${env.no_proxy ?? ''},localhost,127.0.0.1,::1`.split(',').map(s => s.trim()).filter(Boolean));
  env.NO_PROXY = env.no_proxy = [...exclusions].join(',');
}
